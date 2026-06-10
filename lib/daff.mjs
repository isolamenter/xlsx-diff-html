import daff from 'daff';

function autoDetectPrimaryKey(ta, flags) {
  const potentialKeys = ['id', 'key'];
  let foundKey = null;
  for (const k of potentialKeys) {
    for (let x = 0; x < ta.get_width(); x++) {
      const header = String(ta.getCell(x, 0) || '').trim();
      const normalizedHeader = header.toLowerCase().replace(/^#+/, '');
      if (normalizedHeader === k) {
        foundKey = header;
        break;
      }
    }
    if (foundKey) break;
  }
  if (foundKey) {
    flags.addPrimaryKey(foundKey);
  }
}

export function csvDiffToHtml(oldCsv, newCsv, beforeLabel = 'Before', afterLabel = 'After', sheetName = 'Sheet') {
  const ta = new daff.Csv().makeTable(oldCsv);
  const tb = new daff.Csv().makeTable(newCsv);
  const flags = new daff.CompareFlags();
  flags.show_unchanged_columns = true;
  autoDetectPrimaryKey(ta, flags);
  const diffTable = daff.Coopy.diff(ta, tb, flags);

  // Render daff table
  const render = new daff.DiffRender();
  render.render(diffTable);
  const tableHtml = render.html();

  // Compute change statistics
  let addedRowsCount = 0;
  let removedRowsCount = 0;
  let modifiedRowsCount = 0;
  let modifiedCellsCount = 0;

  const dh = diffTable.get_height();
  const dw = diffTable.get_width();
  let startY = 0;
  if (dh > 0 && diffTable.getCell(0, 0) !== '@@') {
    startY = 1;
  }

  for (let y = startY; y < dh; y++) {
    const action = String(diffTable.getCell(0, y) || '');
    if (action === '+++') {
      addedRowsCount++;
    } else if (action === '---') {
      removedRowsCount++;
    } else if (action === '->' || action === '!') {
      modifiedRowsCount++;
      for (let x = 1; x < dw; x++) {
        const val = String(diffTable.getCell(x, y) || '');
        if (val.includes('→')) {
          modifiedCellsCount++;
        }
      }
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>xlsx diff — ${esc(sheetName)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; width: 100%; overflow: hidden; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: #1e293b;
  background-color: #f8fafc;
  display: flex;
  flex-direction: column;
}
.header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #0f172a;
  color: #f8fafc;
  padding: 10px 20px;
  border-bottom: 1px solid #1e293b;
  flex-shrink: 0;
  box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  z-index: 20;
}
.header-title {
  display: flex;
  align-items: center;
  gap: 12px;
}
.header-title .icon {
  font-size: 24px;
}
.title-text h1 {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.title-text p {
  font-size: 11px;
  color: #94a3b8;
}
.title-text .highlight {
  color: #38bdf8;
  font-weight: 500;
}
.stats-panel {
  display: flex;
  gap: 10px;
}
.stat-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
}
.stat-icon {
  font-size: 13px;
  font-family: monospace;
}
.stat-add {
  background-color: #065f46;
  color: #a7f3d0;
  border: 1px solid #047857;
}
.stat-remove {
  background-color: #7f1d1d;
  color: #fecaca;
  border: 1px solid #991b1b;
}
.stat-modify {
  background-color: #78350f;
  color: #fde68a;
  border: 1px solid #92400e;
}
.stat-cells {
  background-color: #1e3a8a;
  color: #bfdbfe;
  border: 1px solid #1d4ed8;
}
.jump-panel {
  display: flex;
  align-items: center;
  gap: 8px;
}
.jump-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background-color: #1e293b;
  color: #f1f5f9;
  border: 1px solid #334155;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  user-select: none;
}
.jump-btn:hover {
  background-color: #334155;
  border-color: #475569;
  color: #ffffff;
}
.jump-btn:active {
  background-color: #0f172a;
}
.jump-count {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  color: #94a3b8;
  background-color: #0f172a;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid #1e293b;
  min-width: 42px;
  text-align: center;
}
.wrap {
  display: flex;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}
.scroll {
  overflow: auto;
  flex: 1;
  background-color: #fff;
}
table {
  border-collapse: separate;
  border-spacing: 0;
  width: max-content;
  min-width: 100%;
}
th, td {
  padding: 6px 12px;
  border-right: 1px solid #cbd5e1;
  border-bottom: 1px solid #cbd5e1;
  white-space: pre;
  vertical-align: top;
}
th {
  position: sticky;
  top: 0;
  z-index: 5;
  background-color: #f1f5f9;
  font-weight: 600;
  color: #1e293b;
  border-bottom: 2px solid #cbd5e1;
  text-align: left;
}
tr.same > td {
  background-color: #ffffff;
}
tr.same:hover > td {
  background-color: #f8fafc;
}
tr.add > td {
  background-color: #e6ffec;
}
tr.add:hover > td {
  background-color: #d2f9d8;
}
tr.remove > td {
  background-color: #ffebe9;
}
tr.remove:hover > td {
  background-color: #ffdfe0;
}
tr.modify > td {
  background-color: #fffdf5;
}
tr.modify:hover > td {
  background-color: #fffbe6;
}
td.modify {
  background-color: #fde68a !important;
  color: #92400e;
  font-weight: 500;
}
@keyframes focus-flash-anim {
  0% { background-color: #38bdf8 !important; color: #0f172a !important; }
}
tr.focus-flash > td {
  animation: focus-flash-anim 1s ease-out;
}
tr.empty > td {
  background: repeating-linear-gradient(45deg, #fafafa, #fafafa 8px, #f3f4f6 8px, #f3f4f6 16px) !important;
}
tr.ellipsis > td {
  background-color: #fafafa;
  color: #94a3b8;
  font-style: italic;
  text-align: center;
}
tr > td:first-child {
  position: sticky;
  left: 0;
  z-index: 10;
  background-color: #f8fafc !important;
  color: #64748b;
  text-align: center;
  font-weight: 600;
  border-right: 2px solid #cbd5e1;
  width: 45px;
  min-width: 45px;
  user-select: none;
}
tr > th:first-child {
  position: sticky;
  top: 0;
  left: 0;
  z-index: 15;
  background-color: #e2e8f0 !important;
  color: #475569;
  text-align: center;
  font-weight: 600;
  border-right: 2px solid #cbd5e1;
  width: 45px;
  min-width: 45px;
  user-select: none;
}
</style>
</head>
<body>
<div class="header-bar">
  <div class="header-title">
    <span class="icon">📊</span>
    <div class="title-text">
      <h1>XLSX Single-Page Diff</h1>
      <p class="subtitle">Comparing sheet: <span class="highlight">${esc(sheetName)}</span></p>
    </div>
  </div>
  <div style="display: flex; align-items: center; gap: 16px;">
    <div class="jump-panel">
      <button class="jump-btn" id="jumpBtn" title="Jump to next change">
        <span>➔</span> Next Change
      </button>
      <div class="jump-count" id="jumpCount">0/0</div>
    </div>
    <div class="stats-panel">
      <div class="stat-badge stat-add" title="Added rows">
        <span class="stat-icon">+</span>
        <span class="stat-count">${addedRowsCount}</span>
        <span class="stat-label">Added</span>
      </div>
      <div class="stat-badge stat-remove" title="Removed rows">
        <span class="stat-icon">-</span>
        <span class="stat-count">${removedRowsCount}</span>
        <span class="stat-label">Removed</span>
      </div>
      <div class="stat-badge stat-modify" title="Modified rows">
        <span class="stat-icon">~</span>
        <span class="stat-count">${modifiedRowsCount}</span>
        <span class="stat-label">Modified</span>
      </div>
      <div class="stat-badge stat-cells" title="Modified cells">
        <span class="stat-icon">✎</span>
        <span class="stat-count">${modifiedCellsCount}</span>
        <span class="stat-label">Cells Changed</span>
      </div>
    </div>
  </div>
</div>
<div class="wrap">
  <div class="scroll">
    ${tableHtml}
  </div>
</div>
<script>
(function () {
  var rows = Array.from(document.querySelectorAll('.scroll tr'));
  var changedIndices = [];
  for (var i = 0; i < rows.length; i++) {
    var tr = rows[i];
    if (tr.classList.contains('add') || tr.classList.contains('remove') || tr.classList.contains('modify')) {
      changedIndices.push(i);
    }
  }

  var container = document.querySelector('.scroll');
  var jumpBtn = document.getElementById('jumpBtn');
  var jumpCount = document.getElementById('jumpCount');
  var currentChangeIdx = -1;

  if (changedIndices.length === 0) {
    if (jumpBtn) {
      jumpBtn.style.display = 'none';
    }
  } else {
    if (jumpCount) {
      jumpCount.textContent = '0/' + changedIndices.length;
    }
    if (jumpBtn) {
      jumpBtn.addEventListener('click', function () {
        currentChangeIdx = (currentChangeIdx + 1) % changedIndices.length;
        if (jumpCount) {
          jumpCount.textContent = (currentChangeIdx + 1) + '/' + changedIndices.length;
        }
        var rowIdx = changedIndices[currentChangeIdx];
        var targetRow = rows[rowIdx];

        // Trigger pulse/flash animation
        rows.forEach(function (r) { r.classList.remove('focus-flash'); });
        if (targetRow) {
          // Force element reflow to reset keyframe animation
          targetRow.offsetWidth;
          targetRow.classList.add('focus-flash');
        }

        if (targetRow && container) {
          var targetScrollTop = targetRow.offsetTop - (container.clientHeight / 2) + (targetRow.offsetHeight / 2);
          container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
        }
      });
    }
  }
}());
</script>
</body>
</html>`;
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

export function csvDiffToHtmlSideBySide(oldCsv, newCsv, beforeLabel = 'Before', afterLabel = 'After', sheetName = 'Sheet') {
  const ta = new daff.Csv().makeTable(oldCsv);
  const tb = new daff.Csv().makeTable(newCsv);
  const flags = new daff.CompareFlags();
  flags.unchanged_context = 100000; // show all rows
  flags.show_unchanged_columns = true;
  autoDetectPrimaryKey(ta, flags);
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

  // Calculate change statistics
  let addedRowsCount = 0;
  let removedRowsCount = 0;
  let modifiedRowsCount = 0;
  let modifiedCellsCount = 0;

  for (let i = 0; i < leftRows.length; i++) {
    const l = leftRows[i];
    const r = rightRows[i];
    if (r.type === 'add') {
      addedRowsCount++;
    } else if (l.type === 'remove') {
      removedRowsCount++;
    } else if (l.type === 'modify' && r.type === 'modify') {
      modifiedRowsCount++;
      for (let c = 0; c < numDiffCols; c++) {
        const valL = l.cells[c] ?? '';
        const valR = r.cells[c] ?? '';
        if (valL !== valR) {
          modifiedCellsCount++;
        }
      }
    }
  }

  // Generate spreadsheet row numbers
  let leftRowNum = 0;
  const leftRowNums = leftRows.map(row => {
    if (row.type === 'header') return '';
    if (row.type === 'empty') return '';
    if (row.type === 'ellipsis') return '…';
    leftRowNum++;
    return leftRowNum;
  });

  let rightRowNum = 0;
  const rightRowNums = rightRows.map(row => {
    if (row.type === 'header') return '';
    if (row.type === 'empty') return '';
    if (row.type === 'ellipsis') return '…';
    rightRowNum++;
    return rightRowNum;
  });

  function renderRows(rows, otherRows, rowNums, isLeft) {
    return rows.map((row, i) => {
      const other = otherRows[i];
      const isHeader = row.type === 'header';
      const tag = isHeader ? 'th' : 'td';
      const cls = row.type;
      const rowNum = rowNums[i];

      const cells = [];
      
      // Leftmost row number cell (Excel style, sticky)
      if (isHeader) {
        cells.push(`<th class="row-num-header">${rowNum}</th>`);
      } else {
        cells.push(`<td class="row-num">${rowNum}</td>`);
      }

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

  const leftHtml = renderRows(leftRows, rightRows, leftRowNums, true);
  const rightHtml = renderRows(rightRows, leftRows, rightRowNums, false);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>xlsx diff — ${esc(sheetName)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; width: 100%; overflow: hidden; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: #1e293b;
  background-color: #f8fafc;
  display: flex;
  flex-direction: column;
}
.header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #0f172a;
  color: #f8fafc;
  padding: 10px 20px;
  border-bottom: 1px solid #1e293b;
  flex-shrink: 0;
  box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  z-index: 20;
}
.header-title {
  display: flex;
  align-items: center;
  gap: 12px;
}
.header-title .icon {
  font-size: 24px;
}
.title-text h1 {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.title-text p {
  font-size: 11px;
  color: #94a3b8;
}
.title-text .highlight {
  color: #38bdf8;
  font-weight: 500;
}
.stats-panel {
  display: flex;
  gap: 10px;
}
.stat-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
}
.stat-icon {
  font-size: 13px;
  font-family: monospace;
}
.stat-add {
  background-color: #065f46;
  color: #a7f3d0;
  border: 1px solid #047857;
}
.stat-remove {
  background-color: #7f1d1d;
  color: #fecaca;
  border: 1px solid #991b1b;
}
.stat-modify {
  background-color: #78350f;
  color: #fde68a;
  border: 1px solid #92400e;
}
.stat-cells {
  background-color: #1e3a8a;
  color: #bfdbfe;
  border: 1px solid #1d4ed8;
}
.jump-panel {
  display: flex;
  align-items: center;
  gap: 8px;
}
.jump-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background-color: #1e293b;
  color: #f1f5f9;
  border: 1px solid #334155;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  user-select: none;
}
.jump-btn:hover {
  background-color: #334155;
  border-color: #475569;
  color: #ffffff;
}
.jump-btn:active {
  background-color: #0f172a;
}
.jump-count {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  color: #94a3b8;
  background-color: #0f172a;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid #1e293b;
  min-width: 42px;
  text-align: center;
}
.wrap {
  display: flex;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}
.pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid #cbd5e1;
}
.pane:last-child {
  border-right: none;
}
.pane-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px;
  background-color: #f1f5f9;
  border-bottom: 1px solid #cbd5e1;
  flex-shrink: 0;
}
.version-tag {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 0.05em;
  user-select: none;
}
.left-tag {
  background-color: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
}
.right-tag {
  background-color: #d1fae5;
  color: #065f46;
  border: 1px solid #6ee7b7;
}
.file-path {
  font-size: 11px;
  color: #475569;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.scroll {
  overflow: auto;
  flex: 1;
  background-color: #fff;
}
table {
  border-collapse: separate;
  border-spacing: 0;
  width: max-content;
  min-width: 100%;
}
th, td {
  padding: 6px 12px;
  border-right: 1px solid #cbd5e1;
  border-bottom: 1px solid #cbd5e1;
  white-space: pre;
  vertical-align: top;
}
th {
  position: sticky;
  top: 0;
  z-index: 5;
  background-color: #f1f5f9;
  font-weight: 600;
  color: #1e293b;
  border-bottom: 2px solid #cbd5e1;
  text-align: left;
}
tr.same > td {
  background-color: #ffffff;
}
tr.same:hover > td {
  background-color: #f8fafc;
}
tr.add > td {
  background-color: #e6ffec;
}
tr.add:hover > td {
  background-color: #d2f9d8;
}
tr.remove > td {
  background-color: #ffebe9;
}
tr.remove:hover > td {
  background-color: #ffdfe0;
}
tr.modify > td {
  background-color: #fffdf5;
}
tr.modify:hover > td {
  background-color: #fffbe6;
}
@keyframes focus-flash-anim {
  0% { background-color: #38bdf8 !important; color: #0f172a !important; }
}
tr.focus-flash > td {
  animation: focus-flash-anim 1s ease-out;
}
tr.empty > td {
  background: repeating-linear-gradient(45deg, #fafafa, #fafafa 8px, #f3f4f6 8px, #f3f4f6 16px) !important;
}
tr.ellipsis > td {
  background-color: #fafafa;
  color: #94a3b8;
  font-style: italic;
  text-align: center;
}
td.chg-l {
  background-color: #ffccd5 !important;
  color: #991b1b;
  font-weight: 500;
}
td.chg-r {
  background-color: #acf2bd !important;
  color: #065f46;
  font-weight: 500;
}
td.col-del, th.col-del {
  background-color: #ffebe9 !important;
}
td.col-add, th.col-add {
  background-color: #e6ffec !important;
}
td.col-gone, th.col-gone {
  background: repeating-linear-gradient(45deg, #fafafa, #fafafa 8px, #f3f4f6 8px, #f3f4f6 16px) !important;
}
.row-num {
  position: sticky;
  left: 0;
  z-index: 10;
  background-color: #f8fafc !important;
  color: #64748b;
  text-align: center;
  font-weight: 500;
  border-right: 2px solid #cbd5e1;
  width: 45px;
  min-width: 45px;
  user-select: none;
}
.row-num-header {
  position: sticky;
  top: 0;
  left: 0;
  z-index: 15;
  background-color: #e2e8f0 !important;
  color: #475569;
  text-align: center;
  font-weight: 600;
  border-right: 2px solid #cbd5e1;
  width: 45px;
  min-width: 45px;
  user-select: none;
}
</style>
</head>
<body>
<div class="header-bar">
  <div class="header-title">
    <span class="icon">📊</span>
    <div class="title-text">
      <h1>XLSX Side-by-Side Diff</h1>
      <p class="subtitle">Comparing sheet: <span class="highlight">${esc(sheetName)}</span></p>
    </div>
  </div>
  <div style="display: flex; align-items: center; gap: 16px;">
    <div class="jump-panel">
      <button class="jump-btn" id="jumpBtn" title="Jump to next change">
        <span>➔</span> Next Change
      </button>
      <div class="jump-count" id="jumpCount">0/0</div>
    </div>
    <div class="stats-panel">
      <div class="stat-badge stat-add" title="Added rows">
        <span class="stat-icon">+</span>
        <span class="stat-count">${addedRowsCount}</span>
        <span class="stat-label">Added</span>
      </div>
      <div class="stat-badge stat-remove" title="Removed rows">
        <span class="stat-icon">-</span>
        <span class="stat-count">${removedRowsCount}</span>
        <span class="stat-label">Removed</span>
      </div>
      <div class="stat-badge stat-modify" title="Modified rows">
        <span class="stat-icon">~</span>
        <span class="stat-count">${modifiedRowsCount}</span>
        <span class="stat-label">Modified</span>
      </div>
      <div class="stat-badge stat-cells" title="Modified cells">
        <span class="stat-icon">✎</span>
        <span class="stat-count">${modifiedCellsCount}</span>
        <span class="stat-label">Cells Changed</span>
      </div>
    </div>
  </div>
</div>
<div class="wrap">
  <div class="pane">
    <div class="pane-header">
      <span class="version-tag left-tag">Before</span>
      <span class="file-path" title="${esc(beforeLabel)}">${esc(beforeLabel)}</span>
    </div>
    <div class="scroll" id="sl">
      <table>
${leftHtml}
      </table>
    </div>
  </div>
  <div class="pane">
    <div class="pane-header">
      <span class="version-tag right-tag">After</span>
      <span class="file-path" title="${esc(afterLabel)}">${esc(afterLabel)}</span>
    </div>
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
  var jumpTimeout = null;

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

  // Jump to next change logic
  var rowsL = Array.from(document.querySelectorAll('#sl tr'));
  var rowsR = Array.from(document.querySelectorAll('#sr tr'));
  var changedIndices = [];
  for (var i = 0; i < rowsL.length; i++) {
    var trL = rowsL[i];
    var trR = rowsR[i];
    if (!trL || !trR) continue;
    var isChanged = trL.classList.contains('add') || trL.classList.contains('remove') || trL.classList.contains('modify') ||
                      trR.classList.contains('add') || trR.classList.contains('remove') || trR.classList.contains('modify');
    if (isChanged) {
      changedIndices.push(i);
    }
  }

  var jumpBtn = document.getElementById('jumpBtn');
  var jumpCount = document.getElementById('jumpCount');
  var currentChangeIdx = -1;

  if (changedIndices.length === 0) {
    if (jumpBtn) {
      jumpBtn.style.display = 'none';
    }
  } else {
    if (jumpCount) {
      jumpCount.textContent = '0/' + changedIndices.length;
    }
    if (jumpBtn) {
      jumpBtn.addEventListener('click', function () {
        currentChangeIdx = (currentChangeIdx + 1) % changedIndices.length;
        if (jumpCount) {
          jumpCount.textContent = (currentChangeIdx + 1) + '/' + changedIndices.length;
        }
        var rowIdx = changedIndices[currentChangeIdx];
        var trL = rowsL[rowIdx];
        var trR = rowsR[rowIdx];

        // Trigger pulse/flash animation
        rowsL.forEach(function (r) { r.classList.remove('focus-flash'); });
        rowsR.forEach(function (r) { r.classList.remove('focus-flash'); });
        if (trL) {
          trL.offsetWidth; // Force reflow
          trL.classList.add('focus-flash');
        }
        if (trR) {
          trR.offsetWidth; // Force reflow
          trR.classList.add('focus-flash');
        }

        if (trL && l && r) {
          var targetScrollTop = trL.offsetTop - (l.clientHeight / 2) + (trL.offsetHeight / 2);
          
          // Lock sync-scrolling during smooth scroll animation to prevent interruptions
          if (jumpTimeout) clearTimeout(jumpTimeout);
          busy = true;
          
          l.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
          r.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
          
          // Re-enable sync scroll after the animation finishes (500ms)
          jumpTimeout = setTimeout(function () {
            busy = false;
          }, 500);
        }
      });
    }
  }
}());
</script>
</body>
</html>`;
}
