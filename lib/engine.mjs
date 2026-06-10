import { spawnGit, parseGitStatus } from './git.mjs';
import { csvDiffToHtml } from './daff.mjs';
import * as XLSX from 'xlsx';
import fsp from 'node:fs/promises';
import path from 'node:path';

function applyDateFormat(worksheet) {
  if (!worksheet?.['!ref']) return;
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r, c })];
      if (cell?.t === 'd') { delete cell.z; delete cell.w; }
    }
  }
}

function preprocessWorksheet(ws) {
  if (!ws || !ws['!ref']) return;

  const range = XLSX.utils.decode_range(ws['!ref']);

  // 1. Identify if we have a "##var" or "#var" row in the first few rows (usually row index 0)
  let varRowIdx = -1;
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 5); r++) {
    const firstCellRef = XLSX.utils.encode_cell({ r, c: range.s.c });
    const val = ws[firstCellRef]?.v;
    if (typeof val === 'string' && (val === '##var' || val === '#var' || val.startsWith('##var') || val.startsWith('#var'))) {
      varRowIdx = r;
      break;
    }
  }

  if (varRowIdx === -1 && range.e.c > range.s.c) {
    // Also support checking the second column if the first column is empty or contains row status indicators
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 5); r++) {
      const secondCellRef = XLSX.utils.encode_cell({ r, c: range.s.c + 1 });
      const val = ws[secondCellRef]?.v;
      if (typeof val === 'string' && (val === '##var' || val === '#var' || val.startsWith('##var') || val.startsWith('#var'))) {
        varRowIdx = r;
        break;
      }
    }
  }

  // Propagate merged cells
  if (ws['!merges']) {
    for (const merge of ws['!merges']) {
      const r_start = Math.max(range.s.r, merge.s.r);
      const r_end = Math.min(range.e.r, merge.e.r);
      const c_start = Math.max(range.s.c, merge.s.c);
      const c_end = Math.min(range.e.c, merge.e.c);

      const startCellRef = XLSX.utils.encode_cell({ r: r_start, c: c_start });
      const startCell = ws[startCellRef];
      if (startCell && startCell.v !== undefined) {
        for (let r = r_start; r <= r_end; r++) {
          for (let c = c_start; c <= c_end; c++) {
            if (r === r_start && c === c_start) continue;
            const cellRef = XLSX.utils.encode_cell({ r, c });
            ws[cellRef] = { ...startCell };
          }
        }
      }
    }
  }

  // 2. If varRowIdx was found, let's locate all other header/metadata rows.
  if (varRowIdx !== -1) {
    let keyCol = range.s.c;
    const firstCellRef = XLSX.utils.encode_cell({ r: varRowIdx, c: range.s.c });
    const val = ws[firstCellRef]?.v;
    if (typeof val === 'string' && (val.startsWith('##var') || val.startsWith('#var'))) {
      keyCol = range.s.c;
    } else {
      keyCol = range.s.c + 1;
    }

    const headerRowIndices = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cellRef = XLSX.utils.encode_cell({ r, c: keyCol });
      const cellVal = ws[cellRef]?.v;
      if (typeof cellVal === 'string' && cellVal.startsWith('#')) {
        headerRowIndices.push(r);
      }
    }

    if (headerRowIndices.length > 1) {
      const maxHeaderRowIdx = Math.max(...headerRowIndices);

      for (let c = range.s.c; c <= range.e.c; c++) {
        if (c === keyCol) continue;

        const parentCellRef = XLSX.utils.encode_cell({ r: varRowIdx, c });
        const parentVal = ws[parentCellRef]?.v;

        if (parentVal !== undefined && parentVal !== '') {
          const subCellRef = XLSX.utils.encode_cell({ r: maxHeaderRowIdx, c });
          const subVal = ws[subCellRef]?.v;

          if (subVal !== undefined && subVal !== '' && String(subVal) !== String(parentVal) && !String(subVal).startsWith('#')) {
            ws[parentCellRef].v = `${parentVal}.${subVal}`;
            if (ws[parentCellRef].w !== undefined) {
              ws[parentCellRef].w = `${parentVal}.${subVal}`;
            }
          }
        }
      }
    }
  }
}

// Shared XLSX.read options — preserve dates, number formats, and styles.
export const XLSX_READ_OPTIONS = { type: 'buffer', cellDates: true, cellNF: true, cellStyles: true };

function worksheetToCsv(ws, options) {
  if (options.dateFormat) applyDateFormat(ws);
  preprocessWorksheet(ws);
  return XLSX.utils.sheet_to_csv(ws, {
    FS: ',',
    RS: '\n',
    blankrows: !options.ignoreEmpty,
    skipHidden: options.skipHidden,
    rawNumbers: options.raw,
    dateNF: options.dateFormat || undefined,
  });
}

export function xlsxSheetToCsv(workbook, sheetName, options) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return '';
  return worksheetToCsv(ws, options);
}

export function xlsxBufferToCsv(buffer, options) {
  if (!buffer.length) return '';
  const workbook = XLSX.read(buffer, XLSX_READ_OPTIONS);
  const { SheetNames: names } = workbook;
  if (!names.length) return '';

  if (options.sheetMode === 'all') {
    return names.map((n) => worksheetToCsv(workbook.Sheets[n], options)).join('\n');
  }

  const idx = (options.sheet ?? 1) - 1;
  if (idx >= names.length) throw new Error(`sheet ${options.sheet} was not found`);
  return worksheetToCsv(workbook.Sheets[names[idx]], options);
}

export async function normalizeFilePath(input, invocationCwd, repoRoot) {
  // Try tracked files first
  let r = await spawnGit(['ls-files', '--full-name', '--', input], invocationCwd);
  if (r.code === 0 && r.stdout.length) {
    return r.stdout.toString('utf8').trim().split('\n')[0];
  }
  // Try untracked files
  r = await spawnGit(['ls-files', '--others', '--exclude-standard', '--full-name', '--', input], invocationCwd);
  if (r.code === 0 && r.stdout.length) {
    return r.stdout.toString('utf8').trim().split('\n')[0];
  }
  // Absolute path fallback
  if (path.isAbsolute(input)) {
    const rel = path.relative(repoRoot, input);
    if (rel.startsWith('..')) throw new Error(`file is outside Git repo: ${input}`);
    return rel.split(path.sep).join('/');
  }
  // Last resort: prefix + input
  const pr = await spawnGit(['rev-parse', '--show-prefix'], invocationCwd);
  const prefix = pr.code === 0 ? pr.stdout.toString('utf8').trim() : '';
  const rel = (prefix + input).replace(/^\.\//, '');
  if (!rel) throw new Error(`empty file path: ${input}`);
  return rel.replace(/\\/g, '/');
}

export async function collectChangedXlsx(repoRoot, mode) {
  const r = await spawnGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '*.xlsx'],
    repoRoot,
  );
  if (r.code !== 0) throw new Error(`git status failed: ${r.stderr.toString('utf8')}`);
  return parseGitStatus(r.stdout, mode).map((f) => f.path);
}

export async function runDiff({ repoRoot, file, mode, options, htmlPath }) {
  if (!file.toLowerCase().endsWith('.xlsx')) throw new Error(`not an .xlsx file: ${file}`);

  await fsp.mkdir(path.dirname(htmlPath), { recursive: true });

  // Get old xlsx from HEAD
  const headResult = await spawnGit(['show', `HEAD:${file}`], repoRoot);
  const oldBuffer = headResult.code === 0 ? headResult.stdout : Buffer.alloc(0);

  // Get new xlsx from working tree or staged index
  let newBuffer;
  if (mode === 'staged') {
    const indexResult = await spawnGit(['show', `:${file}`], repoRoot);
    newBuffer = indexResult.code === 0 ? indexResult.stdout : Buffer.alloc(0);
  } else {
    try {
      newBuffer = await fsp.readFile(path.join(repoRoot, file));
    } catch {
      newBuffer = Buffer.alloc(0);
    }
  }

  const oldCsv = xlsxBufferToCsv(oldBuffer, options);
  const newCsv = xlsxBufferToCsv(newBuffer, options);
  const noTableDiff = oldCsv === newCsv;

  const beforeLabel = `HEAD:${file}`;
  const afterLabel = mode === 'staged' ? `Index:${file}` : file;
  const sheetLabel = options.sheetMode === 'all' ? 'all' : String(options.sheet ?? 1);

  const html = csvDiffToHtml(oldCsv, newCsv, beforeLabel, afterLabel, sheetLabel);
  await fsp.writeFile(htmlPath, html);

  const modeLabel = mode === 'staged' ? 'HEAD vs staged index' : 'HEAD vs working tree';
  const displayHtml = (() => {
    const rel = path.relative(repoRoot, htmlPath);
    return rel.startsWith('..') ? htmlPath : rel;
  })();

  const lines = [
    `Comparing: ${file}`,
    `Mode: ${modeLabel}`,
    `Sheet: ${sheetLabel}`,
    `HTML: ${displayHtml}`,
  ];
  if (noTableDiff) lines.push('Diff: no table diff');

  return { htmlPath, noTableDiff, stdout: lines.join('\n'), stderr: '' };
}
