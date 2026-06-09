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

  const dh = diffTable.get_height();
  const dw = diffTable.get_width();

  // daff emits an extra column-action row before @@ when columns are added/deleted.
  // Its action value is '!' but it encodes column markers ('+++' / '---') not cell data.
  let colActions = null; // null = no column-level changes
  let startY = 0;
  if (dh > 0 && diffTable.getCell(0, 0) !== '@@') {
    colActions = [];
    for (let x = 1; x < dw; x++) colActions.push(diffTable.getCell(x, 0) || '');
    startY = 1; // @@ is at row 1
  }

  // Map each diff-table column (excluding action col 0) to ta/tb column indices.
  const numDiffCols = dw - 1;
  const colMap = []; // { action: ''|'---'|'+++', taCol: number|null, tbCol: number|null }
  let taColIdx = 0, tbColIdx = 0;
  for (let i = 0; i < numDiffCols; i++) {
    const ca = colActions ? colActions[i] : '';
    if (ca === '---') {
      colMap.push({ action: '---', taCol: taColIdx++, tbCol: null });
    } else if (ca === '+++') {
      colMap.push({ action: '+++', taCol: null, tbCol: tbColIdx++ });
    } else {
      colMap.push({ action: '', taCol: taColIdx++, tbCol: tbColIdx++ });
    }
  }

  let ia = 0, ib = 0;
  const leftRows = [], rightRows = [];
  const empty = () => new Array(numDiffCols).fill('');

  for (let y = startY; y < dh; y++) {
    const action = diffTable.getCell(0, y);
    const fromTa = () => colMap.map(cm => cm.taCol !== null ? getCell(ta, cm.taCol, ia) : '');
    const fromTb = () => colMap.map(cm => cm.tbCol !== null ? getCell(tb, cm.tbCol, ib) : '');

    if (action === '@@') {
      leftRows.push({ type: 'header', cells: fromTa() });
      rightRows.push({ type: 'header', cells: fromTb() });
      ia++; ib++;
    } else if (action === '+++') {
      leftRows.push({ type: 'empty', cells: empty() });
      rightRows.push({ type: 'add', cells: fromTb() });
      ib++;
    } else if (action === '---') {
      leftRows.push({ type: 'remove', cells: fromTa() });
      rightRows.push({ type: 'empty', cells: empty() });
      ia++;
    } else if (action === '->' || action === '!') {
      leftRows.push({ type: 'modify', cells: fromTa() });
      rightRows.push({ type: 'modify', cells: fromTb() });
      ia++; ib++;
    } else if (action === '...') {
      const ell = new Array(numDiffCols).fill('…');
      leftRows.push({ type: 'ellipsis', cells: ell });
      rightRows.push({ type: 'ellipsis', cells: ell.slice() });
    } else {
      const cells = fromTa();
      leftRows.push({ type: 'same', cells });
      rightRows.push({ type: 'same', cells: cells.slice() });
      ia++; ib++;
    }
  }

  // When only columns change, daff omits all data rows from the diff output.
  // Manually append remaining ta/tb rows as unchanged.
  const taH = ta.get_height();
  const tbH = tb.get_height();
  while (ia < taH && ib < tbH) {
    const lCells = colMap.map(cm => cm.taCol !== null ? getCell(ta, cm.taCol, ia) : '');
    const rCells = colMap.map(cm => cm.tbCol !== null ? getCell(tb, cm.tbCol, ib) : '');
    leftRows.push({ type: 'same', cells: lCells });
    rightRows.push({ type: 'same', cells: rCells });
    ia++; ib++;
  }

  function renderRows(rows, otherRows, isLeft) {
    return rows.map((row, i) => {
      const other = otherRows[i];
      const isHeader = row.type === 'header';
      const tag = isHeader ? 'th' : 'td';
      const cls = row.type;

      const cells = [];
      for (let c = 0; c < numDiffCols; c++) {
        const val = row.cells[c] ?? '';
        const cm = colMap[c];
        let cellCls = '';
        if (row.type === 'modify' && other?.type === 'modify') {
          const otherVal = other.cells[c] ?? '';
          if (val !== otherVal) cellCls = isLeft ? ' class="chg-l"' : ' class="chg-r"';
        }
        if (!cellCls && cm) {
          if (cm.action === '---') cellCls = isLeft ? ' class="col-del"' : ' class="col-gone"';
          else if (cm.action === '+++') cellCls = isLeft ? ' class="col-gone"' : ' class="col-add"';
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
tr.empty > td { background: #f0f0f0; }
tr.ellipsis > td { background: #f0f0f0; color: #999; font-style: italic; text-align: center; }
td.chg-l { background: #ffd966 !important; }
td.chg-r { background: #96e59e !important; }
td.col-del, th.col-del { background: #ffe6e6 !important; }
td.col-add, th.col-add { background: #e6ffe6 !important; }
td.col-gone, th.col-gone { background: #f0f0f0 !important; }
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
