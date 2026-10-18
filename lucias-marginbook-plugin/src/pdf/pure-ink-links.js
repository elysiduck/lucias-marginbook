/* Stable references to editable ink; no copied stroke payloads in Canvas. */
function lmbInkGroupObjects(pages, group) {
  if (!group || !Array.isArray(group.objectIds)) return [];
  const value = pages && pages[String(group.page)], objects = Array.isArray(value) ? value : value && value.objects || [];
  const ids = new Set(group.objectIds);
  return objects.filter(object => ids.has(object.id) || (object.inkSourceIds || []).some(id => ids.has(id))
    || group.id && Array.isArray(object.inkGroupIds) && object.inkGroupIds.includes(group.id));
}

function lmbInkGroupBounds(objects) {
  if (!objects || !objects.length) return null;
  const boxes = objects.map(lmbInkBounds);
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(.006, Math.max(...boxes.map(b => b.x + b.w)) - x), h: Math.max(.006, Math.max(...boxes.map(b => b.y + b.h)) - y) };
}

function lmbInkCanvasReference(text) {
  try {
    const match = /(?:^|\n)```marginbook-ink\s*\n([^]*?)\n```/.exec(String(text || ""));
    const value = match && JSON.parse(match[1]);
    return value && typeof value.ref === "string" && /^inkref-[a-z0-9-]+$/.test(value.ref) ? value.ref : null;
  } catch (_) { return null; }
}
