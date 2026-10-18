/* Page insertion uses one-based page numbers in every plugin record. */
function lmbPageAfterInsert(page, inserted) { return Number(page) >= inserted ? Number(page) + 1 : page; }
function lmbShiftInkPages(pages, inserted) {
  return Object.fromEntries(Object.entries(pages || {}).map(([key, value]) => [String(lmbPageAfterInsert(key, inserted)), value]));
}
function lmbShiftPageSettings(settings, path, inserted) {
  const clone = JSON.parse(JSON.stringify(settings));
  for (const item of clone.quickExcerpts?.[path] || []) if (item.page != null) item.page = lmbPageAfterInsert(item.page, inserted);
  for (const item of Object.values(clone.pdfTextBlocks?.[path] || {})) if (item.page != null) item.page = lmbPageAfterInsert(item.page, inserted);
  for (const link of Object.values(clone.inkExcerptLinks?.[path] || {})) for (const group of link.groups || []) group.page = lmbPageAfterInsert(group.page, inserted);
  if (clone.inkAnnotations?.[path]) clone.inkAnnotations[path] = lmbShiftInkPages(clone.inkAnnotations[path], inserted);
  return clone;
}
function lmbShiftPdfTextLinks(text, inserted, matches) {
  // Leave prose, selections, rectangles, note markers and attachment names intact.
  const shift = (dest, hash, label = '') => {
    if (!matches(dest)) return null;
    let oldPage;
    const next = hash.replace(/(^|&)page=(\d+)(?=&|$)/, (all, prefix, n) => { oldPage = Number(n); return prefix + 'page=' + lmbPageAfterInsert(oldPage, inserted); });
    if (!oldPage || oldPage < inserted) return null;
    label = label.replace(/(-P\.)(\d+)(?=】)/g, (all, prefix, n) => Number(n) === oldPage ? prefix + (oldPage + 1) : all);
    return { hash: next, label };
  };
  let result = String(text).replace(/\[\[([^\]#|]+\.pdf)#([^\]|]+)(\|[^\]]*)?\]\]/gi, (all, dest, hash, label) => {
    const change = shift(dest, hash, label); return change ? `[[${dest}#${change.hash}${change.label}]]` : all;
  });
  result = result.replace(/(\]\(<?)([^\s<>]*?\.pdf)#([^\s<>)]*)(>?\))/gi, (all, prefix, dest, hash, suffix) => {
    const change = shift(dest, hash); return change ? prefix + dest + '#' + change.hash + suffix : all;
  });
  // Managed callout captions accompany their source link on the next few lines.
  const before = String(text).split('\n'), after = result.split('\n');
  for (let i = 0; i < before.length; i++) {
    const match = /\[!lmb-excerpt\][+-]?[^\n]*?\bP\.(\d+)/.exec(before[i]);
    if (!match || Number(match[1]) < inserted) continue;
    const nearby = before.slice(i + 1, i + 5).join('\n');
    let linked = false;
    nearby.replace(/\[\[([^#|\]]+\.pdf)#page=(\d+)/gi, (_, dest, page) => { if (matches(dest) && Number(page) === Number(match[1])) linked = true; return _; });
    if (linked) after[i] = after[i].replace(/(\[!lmb-excerpt\][+-]?[^\n]*?\bP\.)(\d+)/, (_, prefix, n) => prefix + (Number(n) + 1));
  }
  let managed = false;
  for (let i = 0; i < before.length; i++) {
    if (before[i].includes('<!-- LMB:BEGIN -->')) managed = true;
    if (before[i].includes('<!-- LMB:END -->')) managed = false;
    const heading = /^## P\.(\d+)\s*$/.exec(before[i]);
    if (!managed || !heading || Number(heading[1]) < inserted) continue;
    const next = before.slice(i + 1).findIndex(line => /^## /.test(line) || line.includes('<!-- LMB:END -->'));
    const section = before.slice(i + 1, next < 0 ? undefined : i + 1 + next).join('\n');
    const firstLink = /\[\[([^#|\]]+\.pdf)#page=(\d+)/i.exec(section);
    if (firstLink && matches(firstLink[1]) && Number(firstLink[2]) === Number(heading[1])) after[i] = '## P.' + (Number(heading[1]) + 1);
  }
  return after.join('\n');
}
function lmbShiftCanvasPdfPages(data, path, inserted, matches) {
  const clone = JSON.parse(JSON.stringify(data));
  for (const node of clone.nodes || []) {
    if (typeof node.text === 'string') node.text = lmbShiftPdfTextLinks(node.text, inserted, matches);
    if (node.type === 'file' && matches(node.file || '') && typeof node.subpath === 'string') node.subpath = node.subpath.replace(/(^#|&)page=(\d+)(?=&|$)/, (_, prefix, n) => prefix + 'page=' + lmbPageAfterInsert(Number(n), inserted));
  }
  return clone;
}
