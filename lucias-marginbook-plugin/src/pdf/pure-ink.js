/* PDF ink geometry and sampling helpers. Kept DOM-free for deterministic tests. */

const LMB_INK_SCHEMA_VERSION = 2;
const LMB_INK_HISTORY_LIMIT = 100;

function lmbInkClamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function lmbInkClone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function lmbInkDistance(a, b) {
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
}

/**
 * iPad WKWebView does not always expose Apple Pencil through the same event
 * shape. Modern builds use PointerEvent(pointerType="pen"), while the iOS
 * compatibility path exposes Touch.touchType plus Pencil angle data.
 */
function lmbInkIsStylusInput(input) {
  if (!input) return false;
  const pointerType = String(input.pointerType || "").toLowerCase();
  const touchType = String(input.touchType || "").toLowerCase();
  if (pointerType === "pen" || touchType === "stylus" || touchType === "pencil") return true;
  if (pointerType === "mouse" || touchType === "direct") return false;
  // PointerEvent.altitudeAngle defaults to PI/2 even for ordinary fingers and
  // mice. Only legacy Touch without an explicit direct-touch type may use it.
  const altitude = Number(input.altitudeAngle);
  if (!pointerType && Number.isFinite(altitude) && altitude > 0) return true;
  const tiltX = Number(input.tiltX), tiltY = Number(input.tiltY);
  return pointerType === "touch" && ((Number.isFinite(tiltX) && tiltX !== 0) || (Number.isFinite(tiltY) && tiltY !== 0));
}

function lmbInkTouchPointEvent(touch, sourceEvent, ended) {
  return {
    pointerType: "pen", pointerId: `stylus-touch-${touch.identifier}`,
    button: 0, buttons: ended ? 0 : 1,
    clientX: touch.clientX, clientY: touch.clientY,
    pressure: Number.isFinite(touch.force) ? touch.force : .5,
    timeStamp: sourceEvent && sourceEvent.timeStamp,
    preventDefault: () => { if (sourceEvent && sourceEvent.cancelable !== false) sourceEvent.preventDefault(); },
    stopPropagation: () => { if (sourceEvent) sourceEvent.stopPropagation(); }
  };
}

function lmbInkDistanceToSegment(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const length2 = dx * dx + dy * dy;
  if (!length2) return lmbInkDistance(point, start);
  const t = lmbInkClamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length2, 0, 1);
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function lmbInkBounds(object) {
  if (!object) return { x: 0, y: 0, w: 0, h: 0 };
  if (object.type === "pen" || object.type === "highlighter") {
    const points = Array.isArray(object.points) ? object.points : [];
    if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = points[0].x, maxX = minX, minY = points[0].y, maxY = minY;
    for (let i = 1; i < points.length; i++) {
      minX = Math.min(minX, points[i].x); maxX = Math.max(maxX, points[i].x);
      minY = Math.min(minY, points[i].y); maxY = Math.max(maxY, points[i].y);
    }
    const pad = object.widthUnit === "page" ? Math.max(0, Number(object.width) || 0) / 2 : 0;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  if (object.type === "text") return { x: object.x || 0, y: object.y || 0, w: object.w || .2, h: object.h || .05 };
  const pad = object.widthUnit === "page" ? Math.max(0, Number(object.width) || 0) / 2 : 0;
  return {
    x: Math.min(object.x1 || 0, object.x2 || 0) - pad, y: Math.min(object.y1 || 0, object.y2 || 0) - pad,
    w: Math.abs((object.x2 || 0) - (object.x1 || 0)) + pad * 2, h: Math.abs((object.y2 || 0) - (object.y1 || 0)) + pad * 2
  };
}

function lmbInkPointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    const crosses = ((a.y > point.y) !== (b.y > point.y))
      && point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-9) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function lmbInkObjectHit(object, point, tolerance) {
  if (!object) return false;
  const t = Math.max(.001, Number(tolerance) || .01)
    + (object.widthUnit === "page" ? Math.max(0, Number(object.width) || 0) / 2 : 0);
  if (object.type === "pen" || object.type === "highlighter") {
    const points = object.points || [];
    if (points.length === 1) return lmbInkDistance(point, points[0]) <= t;
    for (let i = 1; i < points.length; i++) {
      if (lmbInkDistanceToSegment(point, points[i - 1], points[i]) <= t) return true;
    }
    return false;
  }
  if (object.type === "line") return lmbInkDistanceToSegment(point,
    { x: object.x1, y: object.y1 }, { x: object.x2, y: object.y2 }) <= t;
  const bounds = lmbInkBounds(object);
  if (object.type === "rect") {
    const edges = [
      [{ x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y }],
      [{ x: bounds.x + bounds.w, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }],
      [{ x: bounds.x + bounds.w, y: bounds.y + bounds.h }, { x: bounds.x, y: bounds.y + bounds.h }],
      [{ x: bounds.x, y: bounds.y + bounds.h }, { x: bounds.x, y: bounds.y }]
    ];
    return edges.some((edge) => lmbInkDistanceToSegment(point, edge[0], edge[1]) <= t);
  }
  return point.x >= bounds.x - t && point.x <= bounds.x + bounds.w + t
    && point.y >= bounds.y - t && point.y <= bounds.y + bounds.h + t;
}

function lmbInkObjectsInLasso(objects, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return [];
  const polygonEdges = polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length]]);
  const intersects = (a, b, c, d) => {
    const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const onSegment = (p, q, r) => q.x >= Math.min(p.x, r.x) - 1e-9 && q.x <= Math.max(p.x, r.x) + 1e-9 && q.y >= Math.min(p.y, r.y) - 1e-9 && q.y <= Math.max(p.y, r.y) + 1e-9;
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    if (Math.abs(abC) < 1e-9 && onSegment(a, c, b)) return true;
    if (Math.abs(abD) < 1e-9 && onSegment(a, d, b)) return true;
    if (Math.abs(cdA) < 1e-9 && onSegment(c, a, d)) return true;
    if (Math.abs(cdB) < 1e-9 && onSegment(c, b, d)) return true;
    return Math.sign(abC) !== Math.sign(abD) && Math.sign(cdA) !== Math.sign(cdB);
  };
  return (objects || []).filter((object) => {
    const bounds = lmbInkBounds(object);
    const probes = [
      { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
      { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }
    ];
    if (probes.some((point) => lmbInkPointInPolygon(point, polygon))) return true;
    if (polygon.some((point) => point.x >= bounds.x && point.x <= bounds.x + bounds.w && point.y >= bounds.y && point.y <= bounds.y + bounds.h)) return true;
    let segments = [];
    if (object.type === "pen" || object.type === "highlighter") {
      const points = object.points || []; segments = points.slice(1).map((point, index) => [points[index], point]);
    } else if (object.type === "line") segments = [[{ x: object.x1, y: object.y1 }, { x: object.x2, y: object.y2 }]];
    else if (object.type === "rect") {
      const a = { x: bounds.x, y: bounds.y }, b = { x: bounds.x + bounds.w, y: bounds.y }, c = { x: bounds.x + bounds.w, y: bounds.y + bounds.h }, d = { x: bounds.x, y: bounds.y + bounds.h };
      segments = [[a, b], [b, c], [c, d], [d, a]];
    }
    return segments.some((segment) => polygonEdges.some((edge) => intersects(segment[0], segment[1], edge[0], edge[1])));
  });
}

function lmbInkNormalizePoint(point, previous) {
  const rawTime = Number(point.t), time = Number.isFinite(rawTime) ? rawTime : Date.now();
  const pressure = Number(point.p);
  return {
    x: lmbInkClamp(point.x, 0, 1), y: lmbInkClamp(point.y, 0, 1),
    p: pressure > 0 ? lmbInkClamp(pressure, .02, 1) : .5,
    t: previous && time <= previous.t ? previous.t + 1 : time
  };
}

function lmbInkAppendSamples(target, samples, minDistance) {
  const result = target || [];
  const threshold = Math.max(.00005, Number(minDistance) || .00035);
  for (const raw of samples || []) {
    const prior = result[result.length - 1];
    const point = lmbInkNormalizePoint(raw, prior);
    if (!prior || lmbInkDistance(prior, point) >= threshold || point.t - prior.t >= 12) result.push(point);
    else prior.p = (prior.p * 2 + point.p) / 3;
  }
  return result;
}

// Inspect raw contact values BEFORE normalization supplies fallback pressure.
// Coalesced events may omit pointerType, so inherit the parent event's type.
function lmbInkIsContactSample(sample, parent) {
  if (!lmbInkIsStylusInput(sample) && !lmbInkIsStylusInput(parent)) return true;
  return sample.buttons !== 0 && sample.pressure !== 0 && sample.force !== 0;
}

function lmbInkStabilityLevel(value) {
  return [0, 1, 2, 3].includes(Number(value)) && value != null ? Number(value) : 2;
}

// A bounded trailing nib acts on contact samples, not on saved strokes. Its
// radius is in CSS pixels so zoom and event frequency cannot change the feel.
function lmbInkStabilizeSamples(target, samples, state) {
  const level = lmbInkStabilityLevel(state.level), width = Math.max(1, state.width), height = Math.max(1, state.height);
  const lag = [0, 1.8, 3.2, 5.5][level], friction = [0, .45, .9, 1.5][level], tau = [0, 7, 14, 24][level];
  for (const raw of samples || []) {
    const prior = state.tip || target[target.length - 1], previousRaw = state.raw || prior;
    const point = lmbInkNormalizePoint(raw, previousRaw); state.raw = point;
    if (!prior || !level) { lmbInkAppendSamples(target, [point], .00005); state.tip = point; continue; }
    const dt = Math.max(1, point.t - previousRaw.t), speed = Math.hypot((point.x - previousRaw.x) * width, (point.y - previousRaw.y) * height) / dt;
    const dx = (point.x - prior.x) * width, dy = (point.y - prior.y) * height, distance = Math.hypot(dx, dy);
    const alpha = dt / (dt + tau / (1 + speed * 1.8));
    const travel = Math.max(0, distance - lag, (distance - friction) * alpha), fraction = distance ? travel / distance : 0;
    const tip = { ...point, x: prior.x + dx * fraction / width, y: prior.y + dy * fraction / height };
    state.tip = tip; lmbInkAppendSamples(target, [tip], .00005);
  }
  return target;
}

function lmbInkFinishStabilization(points, state) {
  // Never turn a deliberate short dash into a dot. Only flush the last known
  // CONTACT sample, never the release/hover coordinate.
  if (state?.raw && points.length && points.every(p => Math.hypot((p.x - points[0].x) * state.width, (p.y - points[0].y) * state.height) < .5)
    && Math.hypot((state.raw.x - points[0].x) * state.width, (state.raw.y - points[0].y) * state.height) >= .5) {
    lmbInkAppendSamples(points, [state.raw], .00005);
  }
  return points;
}

// Rendering-only stabilization. Persist original contact samples so hit tests,
// erasing, undo and linked references retain their original geometry. Preserve
// corners and endpoints; bound displacement in page-width units at every zoom.
function lmbInkDisplayPoints(points, aspect = 1) {
  return (points || []).map((point, i) => {
    const previous = points[i - 1], next = points[i + 1];
    if (!previous || !next) return { ...point };
    const ax = point.x - previous.x, ay = (point.y - previous.y) * aspect;
    const bx = next.x - point.x, by = (next.y - point.y) * aspect;
    const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (!lengths || (ax * bx + ay * by) / lengths < .5) return { ...point };
    const dx = (previous.x + next.x - 2 * point.x) / 4;
    const dy = (previous.y + next.y - 2 * point.y) / 4;
    const offset = Math.hypot(dx, dy * aspect), weight = offset > .0007 ? .0007 / offset : 1;
    return { ...point, x: point.x + dx * weight, y: point.y + dy * weight,
      p: ((previous.p ?? .5) + 2 * (point.p ?? .5) + (next.p ?? .5)) / 4 };
  });
}

function lmbInkRibbon(object, width, height) {
  const points = lmbInkDisplayPoints(object.points, height / Math.max(1, width));
  const centers = points.map(point => ({ x: point.x * width, y: point.y * height }));
  const left = [], right = [];
  for (let i = 0; i < centers.length; i++) {
    const a = centers[Math.max(0, i - 1)], b = centers[Math.min(centers.length - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (!length) { dx = 1; dy = 0; length = 1; }
    const radius = lmbInkSegmentWidth(object, points[i], points[i - 1], width) / 2;
    const nx = -dy / length * radius, ny = dx / length * radius;
    left.push({ x: centers[i].x + nx, y: centers[i].y + ny });
    right.push({ x: centers[i].x - nx, y: centers[i].y - ny });
  }
  return { centers, left, right };
}

function lmbInkRibbonPath(object, width, height) {
  const { centers, left, right } = lmbInkRibbon(object, width, height);
  if (centers.length < 2) return '';
  const xy = point => `${point.x},${point.y}`;
  const trace = side => {
    let d = '';
    for (let i = 1; i < side.length - 1; i++) d += ` Q${xy(side[i])} ${(side[i].x + side[i + 1].x) / 2},${(side[i].y + side[i + 1].y) / 2}`;
    return d + ` L${xy(side[side.length - 1])}`;
  };
  const end = centers.length - 1;
  const endRadius = Math.hypot(left[end].x - centers[end].x, left[end].y - centers[end].y);
  const startRadius = Math.hypot(left[0].x - centers[0].x, left[0].y - centers[0].y);
  return `M${xy(left[0])}${trace(left)} A${endRadius},${endRadius} 0 0 0 ${xy(right[end])}${trace(right.slice().reverse())} A${startRadius},${startRadius} 0 0 0 ${xy(left[0])} Z`;
}

function lmbInkPerpendicularDistance(point, start, end) {
  return lmbInkDistanceToSegment(point, start, end);
}

function lmbInkSimplifyPoints(points, epsilon, pressureEpsilon) {
  if (!Array.isArray(points) || points.length <= 2) return (points || []).slice();
  let maxScore = 0, index = 0;
  const spatialLimit = Number(epsilon) || .00025, pressureLimit = Number(pressureEpsilon) || .06;
  const start = points[0], end = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const distance = lmbInkPerpendicularDistance(points[i], points[0], points[points.length - 1]);
    const ratio = i / (points.length - 1);
    const expectedPressure = (start.p == null ? .5 : start.p) + ((end.p == null ? .5 : end.p) - (start.p == null ? .5 : start.p)) * ratio;
    const pressureDelta = Math.abs((points[i].p == null ? .5 : points[i].p) - expectedPressure);
    const score = Math.max(distance / spatialLimit, pressureDelta / pressureLimit);
    if (score > maxScore) { index = i; maxScore = score; }
  }
  if (maxScore <= 1) return [points[0], points[points.length - 1]];
  const left = lmbInkSimplifyPoints(points.slice(0, index + 1), spatialLimit, pressureLimit);
  const right = lmbInkSimplifyPoints(points.slice(index), spatialLimit, pressureLimit);
  return left.slice(0, -1).concat(right);
}

function lmbInkBuildPatch(before, after) {
  const left = Array.isArray(before) ? before : [], right = Array.isArray(after) ? after : [];
  const beforeMap = new Map(left.map((object, index) => [object.id, { object, index }]));
  const afterMap = new Map(right.map((object, index) => [object.id, { object, index }]));
  const added = [], removed = [], modified = [];
  for (const [id, entry] of afterMap) {
    if (!beforeMap.has(id)) added.push({ index: entry.index, object: lmbInkClone(entry.object) });
    else if (JSON.stringify(beforeMap.get(id).object) !== JSON.stringify(entry.object)) {
      modified.push({ id, before: lmbInkClone(beforeMap.get(id).object), after: lmbInkClone(entry.object) });
    }
  }
  for (const [id, entry] of beforeMap) if (!afterMap.has(id)) removed.push({ index: entry.index, object: lmbInkClone(entry.object) });
  return { added, removed, modified };
}

function lmbInkApplyPatch(objects, patch, direction) {
  const result = lmbInkClone(objects || []), undo = direction === "undo";
  const removeEntries = undo ? patch.added : patch.removed;
  const insertEntries = undo ? patch.removed : patch.added;
  const removeIds = new Set((removeEntries || []).map((entry) => entry.object.id));
  for (let i = result.length - 1; i >= 0; i--) if (removeIds.has(result[i].id)) result.splice(i, 1);
  for (const change of patch.modified || []) {
    const index = result.findIndex((object) => object.id === change.id);
    if (index >= 0) result[index] = lmbInkClone(undo ? change.before : change.after);
  }
  for (const entry of (insertEntries || []).slice().sort((a, b) => a.index - b.index)) {
    const existing = result.findIndex((object) => object.id === entry.object.id);
    if (existing >= 0) result.splice(existing, 1);
    result.splice(Math.max(0, Math.min(result.length, entry.index)), 0, lmbInkClone(entry.object));
  }
  return result;
}

function lmbInkMergePages(older, newer) {
  const result = lmbInkClone(older && typeof older === "object" ? older : {});
  for (const [page, value] of Object.entries(newer && typeof newer === "object" ? newer : {})) {
    const newObjects = Array.isArray(value) ? value : value && Array.isArray(value.objects) ? value.objects : [];
    const oldValue = result[page], oldObjects = Array.isArray(oldValue) ? oldValue : oldValue && Array.isArray(oldValue.objects) ? oldValue.objects : [];
    const merged = oldObjects.map((object) => lmbInkClone(object));
    const positions = new Map(merged.map((object, index) => [object.id, index]));
    for (const object of newObjects) {
      if (object && object.id && positions.has(object.id)) merged[positions.get(object.id)] = lmbInkClone(object);
      else { if (object && object.id) positions.set(object.id, merged.length); merged.push(lmbInkClone(object)); }
    }
    result[page] = { objects: merged };
  }
  return result;
}

function lmbInkSegmentWidth(object, point, previous, pageWidth) {
  const base = object.widthUnit === "page"
    ? Math.max(.5, (Number(object.width) || .003) * pageWidth)
    : Math.max(.5, Number(object.width) || 3);
  if (object.pressureMode === "fixed" || object.type === "highlighter") return base;
  const pressure = lmbInkClamp(point && point.p || .5, .05, 1);
  const distance = previous ? lmbInkDistance(point, previous) * pageWidth : 0;
  const elapsed = previous ? Math.max(1, (point.t || 0) - (previous.t || 0)) : 16;
  const velocity = distance / elapsed;
  const speedFactor = lmbInkClamp(1.08 - velocity * .9, .72, 1.08);
  const pressureFactor = object.pressureMode === "fountain" ? .72 + pressure * .48 : .34 + pressure * 1.08;
  return Math.max(.45, base * pressureFactor * speedFactor);
}

function lmbInkFileKey(path) {
  let hash = 2166136261, hash2 = 2246822507;
  const value = String(path || "");
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
    hash2 ^= value.charCodeAt(i);
    hash2 = Math.imul(hash2, 3266489909);
  }
  const slug = value.split(/[\\/]/).pop().replace(/[^a-z0-9._-]+/gi, "-").slice(0, 48) || "document";
  return `${slug}-${(hash >>> 0).toString(36)}${(hash2 >>> 0).toString(36)}.json`;
}

// Clip each ink segment against a swept circular eraser in screen space. This
// handles sparse/fast strokes, non-square PDF pages and interpolated pressure.
function lmbInkEraseFragments(object, from, to, radius, width, height) {
  let points = object.points;
  if (object.type === "line") points = [{ x: object.x1, y: object.y1 }, { x: object.x2, y: object.y2 }];
  if (object.type === "rect") points = [
    { x: object.x1, y: object.y1 }, { x: object.x2, y: object.y1 },
    { x: object.x2, y: object.y2 }, { x: object.x1, y: object.y2 }, { x: object.x1, y: object.y1 }
  ];
  if (!points || !points.length) return null;
  const pixel = p => ({ x: p.x * width, y: p.y * height });
  const a = pixel(from), b = pixel(to), vx = b.x - a.x, vy = b.y - a.y, length = Math.hypot(vx, vy);
  const r = radius + (object.widthUnit === "page" ? (Number(object.width) || 0) * width : Number(object.width) || 0) * .75;
  const mix = (p, q, t) => {
    const result = { ...p, x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    for (const key of ["p", "t"]) if (Number.isFinite(p[key]) && Number.isFinite(q[key])) result[key] = p[key] + (q[key] - p[key]) * t;
    return result;
  };
  if (points.length === 1) return lmbInkDistanceToSegment(pixel(points[0]), a, b) <= r ? [] : null;
  const fragments = []; let run = [], changed = false;
  const flush = () => { if (run.length) fragments.push(run); run = []; };
  for (let i = 1; i < points.length; i++) {
    const p = pixel(points[i - 1]), q = pixel(points[i]), dx = q.x - p.x, dy = q.y - p.y, intervals = [];
    const circle = center => {
      const ox = p.x - center.x, oy = p.y - center.y, aa = dx * dx + dy * dy;
      if (aa < 1e-12) { if (ox * ox + oy * oy <= r * r) intervals.push([0, 1]); return; }
      const bb = 2 * (ox * dx + oy * dy), cc = ox * ox + oy * oy - r * r, disc = bb * bb - 4 * aa * cc;
      if (disc < 0) return;
      const lo = Math.max(0, (-bb - Math.sqrt(disc)) / (2 * aa)), hi = Math.min(1, (-bb + Math.sqrt(disc)) / (2 * aa));
      if (hi > lo + 1e-10) intervals.push([lo, hi]);
    };
    circle(a); circle(b);
    if (length > 1e-8) {
      let lo = 0, hi = 1;
      const clip = (value, delta, min, max) => {
        if (Math.abs(delta) < 1e-12) return value >= min && value <= max;
        const u = (min - value) / delta, v = (max - value) / delta;
        lo = Math.max(lo, Math.min(u, v)); hi = Math.min(hi, Math.max(u, v)); return hi > lo + 1e-10;
      };
      if (clip(((p.x - a.x) * vx + (p.y - a.y) * vy) / length, (dx * vx + dy * vy) / length, 0, length)
        && clip((-(p.x - a.x) * vy + (p.y - a.y) * vx) / length, (-dx * vy + dy * vx) / length, -r, r)) intervals.push([lo, hi]);
    }
    if (!intervals.length) { if (!run.length) run.push(points[i - 1]); run.push(points[i]); continue; }
    changed = true;
    intervals.sort((x, y) => x[0] - y[0]);
    let cursor = 0;
    for (const [lo, hi] of intervals) {
      if (lo > cursor + 1e-9) {
        if (!run.length) run.push(mix(points[i - 1], points[i], cursor));
        run.push(mix(points[i - 1], points[i], lo)); flush();
      } else flush();
      cursor = Math.max(cursor, hi);
    }
    if (cursor < 1 - 1e-9) run = [mix(points[i - 1], points[i], cursor), points[i]];
  }
  flush(); return changed ? fragments : null;
}

function lmbInkIsTextInput(target) {
  return !!(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "")
    || target.closest && target.closest('[contenteditable="true"],.cm-editor,.lmb-inline-note-editor')));
}
