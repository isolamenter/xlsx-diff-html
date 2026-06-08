import daff from 'daff';

export function csvDiffToHtml(oldCsv, newCsv) {
  const ta = new daff.Csv().makeTable(oldCsv);
  const tb = new daff.Csv().makeTable(newCsv);
  const flags = new daff.CompareFlags();
  const diffTable = daff.Coopy.diff(ta, tb, flags);
  const render = new daff.DiffRender();
  render.render(diffTable);
  render.completeHtml();
  return render.html();
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getCell(table, x, y) {
  const v = table.getCell(x, y);
  return v == null ? '' : String(v);
}

export function csvDiffToHtmlSideBySide(oldCsv, newCsv) {
  const ta = new daff.Csv().makeTable(oldCsv);
  const tb = new daff.Csv().makeTable(newCsv);
  const flags = new daff.CompareFlags();
  flags.unchanged_context = 100000; // show all rows
  const diffTable = daff.Coopy.diff(ta, tb, flags);

  const h = diffTable.get_height();
  let ia = 0; // row index in ta
  let ib = 0; // row index in tb

  const leftRows = [];
  const rightRows = [];

  for (let y = 0; y < h; y++) {
    const action = diffTable.getCell(0, y);

    if (action === '@@') {
      // Header row
      const w = ta.get_width();
      const cells = [];
      for (let x = 0; x < w; x++) cells.push(getCell(ta, x, ia));
      leftRows.push({ type: 'header', cells });
      rightRows.push({ type: 'header', cells: cells.slice() });
      ia++;
      ib++;
    } else if (action === '+++') {
      // Row added in new file
      const w = tb.get_width();
      const cells = [];
      for (let x = 0; x < w; x++) cells.push(getCell(tb, x, ib));
      leftRows.push({ type: 'empty', cells: [] });
      rightRows.push({ type: 'add', cells });
      ib++;
    } else if (action === '---') {
      // Row removed from old file
      const w = ta.get_width();
      const cells = [];
      for (let x = 0; x < w; x++) cells.push(getCell(ta, x, ia));
      leftRows.push({ type: 'remove', cells });
      rightRows.push({ type: 'empty', cells: [] });
      ia++;
    } else if (action === '->' || action === '!') {
      // Modified row: get old from ta, new from tb
      const wa = ta.get_width();
      const wb = tb.get_width();
      const oldCells = [];
      const newCells = [];
      for (let x = 0; x < wa; x++) oldCells.push(getCell(ta, x, ia));
      for (let x = 0; x < wb; x++) newCells.push(getCell(tb, x, ib));
      leftRows.push({ type: 'modify', cells: oldCells });
      rightRows.push({ type: 'modify', cells: newCells });
      ia++;
      ib++;
    } else if (action === '...') {
      // Omitted context (should not occur with large unchanged_context)
      leftRows.push({ type: 'ellipsis', cells: ['…'] });
      rightRows.push({ type: 'ellipsis', cells: ['…'] });
    } else {
      // Unchanged row (action === '' or null)
      const w = ta.get_width();
      const cells = [];
      for (let x = 0; x < w; x++) cells.push(getCell(ta, x, ia));
      leftRows.push({ type: 'same', cells });
      rightRows.push({ type: 'same', cells: cells.slice() });
      ia++;
      ib++;
    }
  }

  // Find the maximum column count across all rows
  let maxCols = 0;
  for (const row of leftRows) if (row.cells.length > maxCols) maxCols = row.cells.length;
  for (const row of rightRows) if (row.cells.length > maxCols) maxCols = row.cells.length;
  if (maxCols === 0) maxCols = 1;

  function renderRows(rows, otherRows, isLeft) {
    return rows.map((row, i) => {
      const other = otherRows[i];
      const isHeader = row.type === 'header';
      const tag = isHeader ? 'th' : 'td';
      const cls = row.type;

      const cells = [];
      for (let c = 0; c < maxCols; c++) {
        const val = row.cells[c] ?? '';
        let cellCls = '';
        if (row.type === 'modify' && other && other.type === 'modify') {
          const otherVal = other.cells[c] ?? '';
          if (val !== otherVal) cellCls = isLeft ? ' class="chg-l"' : ' class="chg-r"';
        }
        cells.push(`<${tag}${cellCls}>${esc(val)}</${tag}>`);
      }

      return `<tr class="${cls}">${cells.join('')}</tr>`;
    }).join('\n');
  }

  const leftHtml = renderRows(leftRows, rightRows, true);
  const rightHtml = renderRows(rightRows, leftRows, false);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>xlsx diff — side by side</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; display: flex; flex-direction: column; background: #fff; }
.wrap { display: flex; flex: 1; overflow: hidden; min-height: 0; }
.pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid #c8c8c8; }
.pane:last-child { border-right: none; }
.pane-label { padding: 4px 10px; background: #e8e8e8; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #555; flex-shrink: 0; border-bottom: 1px solid #ccc; }
.scroll { overflow: auto; flex: 1; }
table { border-collapse: collapse; width: max-content; min-width: 100%; }
th, td { padding: 2px 10px; border: 1px solid #e0e0e0; white-space: pre; vertical-align: top; }
th { position: sticky; top: 0; z-index: 1; background: #eaeaea; font-weight: 600; color: #333; border-color: #ccc; }
tr.same > td { background: #fff; }
tr.add > td { background: #e6ffe6; }
tr.remove > td { background: #ffe6e6; }
tr.modify > td { background: #fff8dc; }
tr.empty > td { background: #f5f5f5; }
tr.ellipsis > td { background: #f0f0f0; color: #999; font-style: italic; text-align: center; }
td.chg-l { background: #ffd966 !important; }
td.chg-r { background: #96e59e !important; }
</style>
</head>
<body>
<div class="wrap">
  <div class="pane">
    <div class="pane-label">Before</div>
    <div class="scroll" id="sl">
      <table>
${leftHtml}
      </table>
    </div>
  </div>
  <div class="pane">
    <div class="pane-label">After</div>
    <div class="scroll" id="sr">
      <table>
${rightHtml}
      </table>
    </div>
  </div>
</div>
<script>
(function () {
  var l = document.getElementById('sl');
  var r = document.getElementById('sr');
  var busy = false;
  function sync(a, b) {
    a.addEventListener('scroll', function () {
      if (busy) return;
      busy = true;
      b.scrollTop = a.scrollTop;
      b.scrollLeft = a.scrollLeft;
      busy = false;
    });
  }
  sync(l, r);
  sync(r, l);
}());
</script>
</body>
</html>`;
}
