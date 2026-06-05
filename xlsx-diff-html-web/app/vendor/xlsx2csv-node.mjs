#!/usr/bin/env node
import fs from 'node:fs';
import * as XLSX from 'xlsx';

const VERSION = `${XLSX.version}-sheetjs`;

function usage() {
  process.stdout.write(
    'usage: xlsx2csv [-h] [-v] [-a] [-s SHEETID] [-p SHEETDELIMITER]\n' +
    '               [-i] [--include-hidden-rows] [--raw] [-f DATEFORMAT]\n' +
    '               xlsxfile [outfile]\n' +
    '\n' +
    'Backed by SheetJS. Cells render as their displayed (formatted) text,\n' +
    'matching what Excel shows. -f takes an Excel number-format code such as\n' +
    '"yyyy-mm-dd" (not a strftime pattern).\n',
  );
}

function die(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    all: false,
    sheet: 1,
    ignoreEmpty: false,
    includeHidden: false,
    raw: false,
    dateFormat: '',
    sheetDelimiter: '--------',
    positional: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '-h':
      case '--help':
        usage();
        process.exit(0);
        break;
      case '-v':
      case '--version':
        process.stdout.write(`${VERSION}\n`);
        process.exit(0);
        break;
      case '-a':
      case '--all':
        options.all = true;
        break;
      case '-i':
      case '--ignoreempty':
      case '--ignore-empty':
        options.ignoreEmpty = true;
        break;
      case '--include-hidden-rows':
        options.includeHidden = true;
        break;
      case '--raw':
        options.raw = true;
        break;
      case '-f':
      case '--dateformat':
      case '--date-format':
        index += 1;
        if (index >= argv.length) die(`${arg} requires a format string`);
        options.dateFormat = argv[index];
        break;
      case '-p':
      case '--sheetdelimiter':
      case '--sheet-delimiter':
        index += 1;
        if (index >= argv.length) die(`${arg} requires a delimiter`);
        options.sheetDelimiter = argv[index];
        break;
      case '-s':
      case '--sheet':
        index += 1;
        if (index >= argv.length) die(`${arg} requires a sheet number`);
        options.sheet = Number(argv[index]);
        if (!Number.isInteger(options.sheet) || options.sheet < 1) die('sheet must be a positive integer');
        break;
      // Accepted for xlsx2csv compatibility; consume the following value.
      case '-c':
      case '-d':
      case '-t':
      case '--timeformat':
      case '--floatformat':
      case '-l':
      case '-q':
      case '-n':
      case '--sheetname':
        index += 1;
        if (index >= argv.length) die(`${arg} requires a value`);
        break;
      // Accepted for xlsx2csv compatibility; no effect.
      case '-e':
      case '--escape':
      case '--hyperlinks':
      case '--no-line-breaks':
      case '--exclude_hidden_sheets':
      case '--skipemptycolumns':
      case '--continue-on-error':
      case '-m':
      case '--merge-cells':
      case '--sci-float':
        break;
      default:
        if (arg.startsWith('-')) die(`unsupported option: ${arg}`);
        options.positional.push(arg);
    }
  }

  if (options.positional.length < 1 || options.positional.length > 2) {
    usage();
    process.exit(1);
  }

  return options;
}

// SheetJS resolves a date cell's displayed text from its cached `w` string or
// its own number format `z`. A global `dateNF` is only a fallback, so to honor
// an explicit --date-format we strip both and let `dateNF` take over.
function applyDateFormat(worksheet) {
  if (!worksheet || !worksheet['!ref']) return;
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: col })];
      if (cell && cell.t === 'd') {
        delete cell.z;
        delete cell.w;
      }
    }
  }
}

function sheetToCsv(worksheet, options) {
  if (options.dateFormat) applyDateFormat(worksheet);
  return XLSX.utils.sheet_to_csv(worksheet, {
    FS: ',',
    RS: '\n',
    blankrows: !options.ignoreEmpty,
    skipHidden: !options.includeHidden,
    rawNumbers: options.raw,
    dateNF: options.dateFormat || undefined,
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = options.positional[0];
  const output = options.positional[1] || '';

  const workbook = XLSX.read(fs.readFileSync(input), {
    type: 'buffer',
    cellDates: true,
    cellNF: true,
    // Needed to populate row/column `hidden` flags so --include-hidden-rows
    // (skipHidden) has something to act on.
    cellStyles: true,
  });

  const sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) die('workbook has no sheets');

  const chunks = [];
  if (options.all) {
    for (let index = 0; index < sheetNames.length; index += 1) {
      if (index > 0 && options.sheetDelimiter !== '') chunks.push(options.sheetDelimiter);
      chunks.push(sheetToCsv(workbook.Sheets[sheetNames[index]], options));
    }
  } else {
    if (options.sheet > sheetNames.length) die(`sheet ${options.sheet} was not found`);
    chunks.push(sheetToCsv(workbook.Sheets[sheetNames[options.sheet - 1]], options));
  }

  const csv = chunks.join('\n');
  if (output) fs.writeFileSync(output, csv);
  else process.stdout.write(csv);
}

try {
  main();
} catch (error) {
  die(error?.message || String(error));
}
