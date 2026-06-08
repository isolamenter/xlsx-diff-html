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
