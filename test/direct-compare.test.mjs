import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseDirectCompareArgs, runDirectCompare } from '../lib/direct-compare.mjs';

test('external diff accepts the CLI --compare form and options', () => {
  const parsed = parseDirectCompareArgs([
    '--sheet', '2',
    '--ignore-empty',
    '--no-open',
    '--output', 'result.html',
    '--compare', 'old.xlsx', 'new.xlsx',
  ]);

  assert.equal(parsed.localFile, 'old.xlsx');
  assert.equal(parsed.remoteFile, 'new.xlsx');
  assert.equal(parsed.options.sheetMode, 'single');
  assert.equal(parsed.options.sheet, 2);
  assert.equal(parsed.options.ignoreEmpty, true);
  assert.equal(parsed.autoOpen, false);
  assert.equal(parsed.outputPath, 'result.html');
});

test('external diff accepts the bare LOCAL REMOTE form used by Git clients', () => {
  const parsed = parseDirectCompareArgs(['old.xlsx', 'new.xlsx']);
  assert.equal(parsed.localFile, 'old.xlsx');
  assert.equal(parsed.remoteFile, 'new.xlsx');
});

test('direct compare writes the same self-contained side-by-side HTML used by CLI', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xlsx-direct-test-'));
  try {
    const oldPath = path.join(dir, 'old.xlsx');
    const newPath = path.join(dir, 'new.xlsx');
    const outputPath = path.join(dir, 'result.html');

    const oldBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(oldBook, XLSX.utils.aoa_to_sheet([['id', 'value'], [1, 'old']]), 'Sheet1');
    const newBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newBook, XLSX.utils.aoa_to_sheet([['id', 'value'], [1, 'new']]), 'Sheet1');
    await fsp.writeFile(oldPath, XLSX.write(oldBook, { type: 'buffer', bookType: 'xlsx' }));
    await fsp.writeFile(newPath, XLSX.write(newBook, { type: 'buffer', bookType: 'xlsx' }));

    const result = await runDirectCompare({
      localFile: oldPath,
      remoteFile: newPath,
      outputPath,
      options: {
        sheetMode: 'all',
        sheet: 1,
        ignoreEmpty: false,
        skipHidden: false,
        raw: false,
        dateFormat: 'yyyy-mm-dd',
      },
    });

    assert.equal(result.htmlPath, outputPath);
    assert.equal(result.noTableDiff, false);
    const html = await fsp.readFile(outputPath, 'utf8');
    assert.match(html, /XLSX Side-by-Side Diff/);
    assert.match(html, /old\.xlsx/);
    assert.match(html, /new\.xlsx/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
