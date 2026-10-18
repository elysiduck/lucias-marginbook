/* Source ranges for paragraph-level live editing. Gaps stay in the source, so
 * switching blocks never rewrites whitespace, tables, fences or list markers. */
function lmbLiveMarkdownBlocks(value) {
  const text = String(value || ""), lines = [];
  let offset = 0;
  for (const raw of text.split("\n")) { lines.push({ text: raw, start: offset, end: offset + raw.length }); offset += raw.length + 1; }
  const blank = (i) => i >= lines.length || !lines[i].text.trim();
  const heading = (s) => /^ {0,3}#{1,6}(?:\s|$)/.test(s);
  const list = (s) => /^\s*(?:[-+*]|\d+[.)])\s+/.test(s);
  const quote = (s) => /^ {0,3}>/.test(s);
  const fence = (s) => /^ {0,3}(`{3,}|~{3,})/.exec(s);
  const rule = (s) => /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(s);
  const tableRule = (s) => /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(s);
  const table = (i) => i + 1 < lines.length && lines[i].text.includes("|") && tableRule(lines[i + 1].text);
  const math = (s) => /^\s*\$\$/.test(s);
  const special = (i) => heading(lines[i].text) || fence(lines[i].text) || list(lines[i].text) || quote(lines[i].text) || math(lines[i].text) || rule(lines[i].text) || table(i);
  const result = [];
  const add = (start, end, kind) => result.push({ start: lines[start].start, end: lines[end].end, kind, source: text.slice(lines[start].start, lines[end].end) });
  for (let i = 0; i < lines.length;) {
    if (blank(i)) { i++; continue; }
    const first = i, s = lines[i].text, match = fence(s);
    if (match) {
      const marker = match[1][0], count = match[1].length;
      for (i++; i < lines.length; i++) {
        const close = /^ {0,3}(`+|~+)\s*$/.exec(lines[i].text);
        if (close && close[1][0] === marker && close[1].length >= count) { i++; break; }
      }
      add(first, Math.min(i, lines.length) - 1, "code"); continue;
    }
    if (math(s)) {
      if (!/^\s*\$\$.+\$\$\s*$/.test(s)) {
        for (i++; i < lines.length && !/^\s*\$\$\s*$/.test(lines[i].text); i++) {}
        if (i < lines.length) i++;
      } else i++;
      add(first, Math.min(i, lines.length) - 1, "math"); continue;
    }
    if (table(i)) { for (i += 2; i < lines.length && !blank(i) && lines[i].text.includes("|"); i++) {} add(first, i - 1, "table"); continue; }
    if (heading(s) || rule(s)) { add(i, i, heading(s) ? "heading" : "rule"); i++; continue; }
    if (i + 1 < lines.length && /^\s*(?:=+|-+)\s*$/.test(lines[i + 1].text)) { add(i, i + 1, "heading"); i += 2; continue; }
    if (quote(s)) {
      for (i++; i < lines.length; i++) {
        if (quote(lines[i].text)) continue;
        if (blank(i) && i + 1 < lines.length && quote(lines[i + 1].text)) continue;
        break;
      }
      add(first, i - 1, "quote"); continue;
    }
    if (list(s) || /^(?: {4}|\t)/.test(s)) {
      const kind = list(s) ? "list" : "code";
      for (i++; i < lines.length; i++) {
        if (blank(i)) {
          let next = i + 1; while (next < lines.length && blank(next)) next++;
          if (next < lines.length && (list(lines[next].text) || /^(?: {2,}|\t)/.test(lines[next].text))) { i = next - 1; continue; }
          break;
        }
        if (heading(lines[i].text) || fence(lines[i].text) || quote(lines[i].text)) break;
      }
      add(first, i - 1, kind); continue;
    }
    for (i++; i < lines.length && !blank(i) && !special(i); i++) {}
    add(first, i - 1, "paragraph");
  }
  if (!result.length || /\n\s*$/.test(text)) result.push({ start: text.length, end: text.length, kind: "paragraph", source: "" });
  return result;
}

function lmbLiveBlockAt(parts, offset) {
  const containing = parts.findIndex((part) => part.start <= offset && offset <= part.end);
  if (containing >= 0) return containing;
  const next = parts.findIndex((part) => part.start > offset);
  return next >= 0 ? next : parts.length - 1;
}

function lmbLiveCaretOffset(source, nodeText, nodeOffset, precedingLength) {
  // A clicked text node normally occurs verbatim in the Markdown source. Pick
  // its closest occurrence, accounting for hidden heading/emphasis prefixes.
  const visible = (s) => s.replace(/^ {0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s*/gm, "").replace(/[*_`~]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  let best = -1, distance = Infinity;
  if (nodeText) for (let at = source.indexOf(nodeText); at >= 0; at = source.indexOf(nodeText, at + 1)) {
    const delta = Math.abs(visible(source.slice(0, at)).length - precedingLength);
    if (delta < distance) { best = at; distance = delta; }
  }
  return Math.max(0, Math.min(source.length, best < 0 ? precedingLength + nodeOffset : best + nodeOffset));
}
