import assert from 'node:assert/strict';
import test from 'node:test';

import { csvDiffToHtmlSideBySide } from '../lib/daff.mjs';

function rowsByPane(html) {
  const panes = [...html.matchAll(/<div class="scroll" id="s[lr]">([\s\S]*?)<\/table>/g)];
  return panes.map(([, pane]) =>
    [...pane.matchAll(/<tr class="([^"]+)">([\s\S]*?)<\/tr>/g)].map(([, type, body]) => ({
      type,
      body,
    })),
  );
}

test('side-by-side keeps a full-height placeholder when the last row is deleted', () => {
  const oldCsv = ['id,value', '1,kept', '2,deleted'].join('\n');
  const newCsv = ['id,value', '1,kept'].join('\n');

  const [leftRows, rightRows] = rowsByPane(csvDiffToHtmlSideBySide(oldCsv, newCsv));
  const leftLast = leftRows.at(-1);
  const rightLast = rightRows.at(-1);

  assert.equal(leftLast.type, 'remove');
  assert.equal(rightLast.type, 'empty');
  assert.match(rightLast.body, /<td class="row-num">&#160;<\/td>/);
  assert.match(rightLast.body, /<td>&#160;<\/td>/);
});

test('side-by-side keeps a full-height placeholder when the last row is added', () => {
  const oldCsv = ['id,value', '1,kept'].join('\n');
  const newCsv = ['id,value', '1,kept', '2,added'].join('\n');

  const [leftRows, rightRows] = rowsByPane(csvDiffToHtmlSideBySide(oldCsv, newCsv));
  const leftLast = leftRows.at(-1);
  const rightLast = rightRows.at(-1);

  assert.equal(leftLast.type, 'empty');
  assert.equal(rightLast.type, 'add');
  assert.match(leftLast.body, /<td class="row-num">&#160;<\/td>/);
  assert.match(leftLast.body, /<td>&#160;<\/td>/);
});
