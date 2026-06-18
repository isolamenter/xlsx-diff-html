import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { xlsxBufferToCsv } from './engine.mjs';
import { csvDiffToHtmlSideBySide } from './daff.mjs';

export function parseDirectCompareArgs(argv) {
  let sheetMode = 'all';
  let sheet = 1;
  let compareMode = false;
  let localFile = '';
  let remoteFile = '';
  let ignoreEmpty = false;
  let skipHidden = false;
  let raw = false;
  let dateFormat = 'yyyy-mm-dd';
  let autoOpen = true;
  let outputPath = '';
  const inputFiles = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--all': sheetMode = 'all'; break;
      case '--sheet': {
        i += 1;
        const n = Number(argv[i]);
        if (!Number.isInteger(n) || n < 1) throw new Error('--sheet must be a positive integer');
        sheet = n;
        sheetMode = 'single';
        break;
      }
      case '--staged':
      case '--changed':
        break;
      case '--compare':
        compareMode = true;
        i += 1;
        if (i >= argv.length) throw new Error('--compare requires two paths: LOCAL REMOTE');
        localFile = argv[i];
        i += 1;
        if (i >= argv.length) throw new Error('--compare requires two paths: LOCAL REMOTE');
        remoteFile = argv[i];
        break;
      case '--ignore-empty': ignoreEmpty = true; break;
      case '--skip-hidden': skipHidden = true; break;
      case '--raw': raw = true; break;
      case '--date-format':
        i += 1;
        if (i >= argv.length) throw new Error('--date-format requires a format string');
        dateFormat = argv[i];
        break;
      case '--open': autoOpen = true; break;
      case '--no-open': autoOpen = false; break;
      case '--output':
        i += 1;
        if (i >= argv.length) throw new Error('--output requires a path');
        outputPath = argv[i];
        break;
      case '--':
        for (i += 1; i < argv.length; i += 1) inputFiles.push(argv[i]);
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        inputFiles.push(arg);
    }
  }

  if (!compareMode) {
    if (inputFiles.length !== 2) {
      throw new Error('external diff requires two paths: LOCAL REMOTE');
    }
    [localFile, remoteFile] = inputFiles;
  }

  return {
    localFile,
    remoteFile,
    options: { sheetMode, sheet, ignoreEmpty, skipHidden, raw, dateFormat },
    autoOpen,
    outputPath,
  };
}

export async function runDirectCompare({
  localFile,
  remoteFile,
  options,
  outputPath = '',
  invocationCwd = process.cwd(),
}) {
  const localAbs = path.isAbsolute(localFile) ? localFile : path.join(invocationCwd, localFile);
  const remoteAbs = path.isAbsolute(remoteFile) ? remoteFile : path.join(invocationCwd, remoteFile);

  const htmlPath = outputPath
    ? (path.isAbsolute(outputPath) ? outputPath : path.join(invocationCwd, outputPath))
    : path.join(os.tmpdir(), 'xlsx-diff-html', `compare_${Date.now()}_${process.pid}.sbs.html`);

  let oldBuffer;
  let newBuffer;
  try { oldBuffer = await fsp.readFile(localAbs); } catch { oldBuffer = Buffer.alloc(0); }
  try { newBuffer = await fsp.readFile(remoteAbs); } catch { newBuffer = Buffer.alloc(0); }

  let oldCsv;
  let newCsv;
  try {
    oldCsv = xlsxBufferToCsv(oldBuffer, options);
  } catch (error) {
    throw new Error(`cannot parse LOCAL as xlsx (${localAbs}): ${error.message}`);
  }
  try {
    newCsv = xlsxBufferToCsv(newBuffer, options);
  } catch (error) {
    throw new Error(`cannot parse REMOTE as xlsx (${remoteAbs}): ${error.message}`);
  }

  const noTableDiff = oldCsv === newCsv;
  const sheetLabel = options.sheetMode === 'all' ? 'all' : String(options.sheet ?? 1);
  const html = csvDiffToHtmlSideBySide(
    oldCsv,
    newCsv,
    localFile,
    remoteFile,
    sheetLabel,
  );

  await fsp.mkdir(path.dirname(htmlPath), { recursive: true });
  await fsp.writeFile(htmlPath, html);

  return {
    htmlPath,
    noTableDiff,
    stdout: [
      `Comparing: ${localAbs}  vs  ${remoteAbs}`,
      `Sheet: ${sheetLabel}`,
      `HTML: ${htmlPath}`,
      ...(noTableDiff ? ['Diff: no table diff'] : []),
    ].join('\n'),
  };
}
