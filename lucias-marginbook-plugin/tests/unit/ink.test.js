"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");

class Plugin {}
class Notice {}
class Empty {}
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return {
    Plugin, Notice, TFile: Empty, PluginSettingTab: Empty, Setting: Empty, Modal: Empty, FuzzySuggestModal: Empty,
    normalizePath: (path) => path.replace(/\\/g, "/"), setIcon: () => {}, Platform: {}
  };
  return originalLoad.call(this, request, parent, isMain);
};
const PluginClass = require("../../main.js");
Module._load = originalLoad;
const pure = PluginClass.__test, proto = PluginClass.prototype;

async function main() {
  const samples = [];
  for (let i = 0; i < 5000; i++) samples.push({ x: i / 100000, y: .2 + Math.sin(i / 20) / 1000, p: i % 10 / 10, t: i });
  const collected = pure.lmbInkAppendSamples([], samples, .00035);
  assert(collected.length < samples.length, "dense stylus samples should be coalesced");
  assert(collected.length > 100, "coalescing must retain the written shape");
  assert(collected.every((point) => point.p >= .02 && point.p <= 1));

  const simplified = pure.lmbInkSimplifyPoints(collected, .0002);
  assert(simplified.length <= collected.length);
  assert.deepEqual(simplified[0], collected[0]);
  assert.deepEqual(simplified.at(-1), collected.at(-1));
  const pressureLine = pure.lmbInkSimplifyPoints([
    { x: 0, y: 0, p: .1 }, { x: .5, y: 0, p: 1 }, { x: 1, y: 0, p: .1 }
  ], .001, .05);
  assert.equal(pressureLine.length, 3, "pressure extrema on a straight stroke must survive simplification");

  const stroke = { type: "pen", points: [{ x: .1, y: .1 }, { x: .5, y: .5 }, { x: .9, y: .1 }] };
  assert.equal(pure.lmbInkObjectHit(stroke, { x: .5, y: .505 }, .01), true);
  assert.equal(pure.lmbInkObjectHit(stroke, { x: .5, y: .8 }, .01), false);
  const lasso = [{ x: .05, y: .05 }, { x: .6, y: .05 }, { x: .6, y: .6 }, { x: .05, y: .6 }];
  assert.deepEqual(pure.lmbInkObjectsInLasso([stroke, { type: "text", id: "out", x: .8, y: .8, w: .1, h: .1 }], lasso), [stroke]);
  const crossingLine = { type: "line", id: "crossing", x1: .1, y1: .5, x2: .7, y2: .5 };
  const narrowLasso = [{ x: .65, y: .4 }, { x: .75, y: .4 }, { x: .75, y: .6 }, { x: .65, y: .6 }];
  assert.deepEqual(pure.lmbInkObjectsInLasso([crossingLine], narrowLasso), [crossingLine], "lasso must catch an edge crossing even when no endpoint is inside");

  const thin = pure.lmbInkSegmentWidth({ type: "pen", width: .004, widthUnit: "page", pressureMode: "natural" }, { x: .2, y: .2, p: .1, t: 16 }, { x: .1, y: .1, p: .1, t: 0 }, 1000);
  const thick = pure.lmbInkSegmentWidth({ type: "pen", width: .004, widthUnit: "page", pressureMode: "natural" }, { x: .2, y: .2, p: .9, t: 16 }, { x: .1, y: .1, p: .9, t: 0 }, 1000);
  assert(thick > thin, "pressure must affect rendered width");
  assert.equal(pure.lmbInkSegmentWidth({ type: "pen", width: .004, widthUnit: "page", pressureMode: "fixed" }, { p: .1 }, null, 1000), 4);
  assert.equal(pure.lmbInkFileKey("books/a.pdf"), pure.lmbInkFileKey("books/a.pdf"));
  assert.notEqual(pure.lmbInkFileKey("books/a.pdf"), pure.lmbInkFileKey("books/b.pdf"));
  assert.equal(pure.lmbInkIsStylusInput({ pointerType: "pen" }), true);
  assert.equal(pure.lmbInkIsStylusInput({ pointerType: "touch", touchType: "stylus" }), true);
  assert.equal(pure.lmbInkIsStylusInput({ altitudeAngle: .8 }), true);
  assert.equal(pure.lmbInkIsStylusInput({ touchType: "direct", altitudeAngle: .8 }), false);
  assert.equal(pure.lmbInkIsStylusInput({ pointerType: "touch", altitudeAngle: Math.PI / 2, tiltX: 0, tiltY: 0 }), false, "default browser altitude is not evidence of a Pencil");
  assert.equal(pure.lmbInkIsStylusInput({ pointerType: "mouse", altitudeAngle: Math.PI / 2 }), false);
  assert.equal(pure.lmbInkIsStylusInput({ pointerType: "touch", touchType: "direct", altitudeAngle: 0 }), false);

  const historyCtx = Object.create(proto);
  Object.assign(historyCtx, {
    settings: { inkAnnotations: {} }, _lmbInkDocs: { "book.pdf": { "1": { objects: [] } } },
    lmbMarkInkDirty: () => {}, lmbRenderInkTools: () => {}
  });
  const before = [];
  historyCtx.lmbInkObjects("book.pdf", "1", true).push({ id: "one", type: "line", x1: 0, y1: 0, x2: 1, y2: 1 });
  assert.equal(historyCtx.lmbCommitInkChange("book.pdf", "1", before, "draw"), true);
  const history = historyCtx.lmbHistoryFor("book.pdf", "1");
  assert.equal(history.undo.length, 1); assert.equal(history.redo.length, 0);
  assert.equal(history.undo[0].patch.added[0].object.id, "one");
  historyCtx.lmbReplaceInkObjects("book.pdf", "1", pure.lmbInkApplyPatch(historyCtx.lmbInkObjects("book.pdf", "1"), history.undo[0].patch, "undo"));
  assert.equal(historyCtx.lmbInkObjects("book.pdf", "1").length, 0);
  const merged = pure.lmbInkMergePages({ "1": { objects: [{ id: "same", text: "old" }, { id: "old-only" }] } }, { "1": { objects: [{ id: "same", text: "new" }, { id: "new-only" }] } });
  assert.deepEqual(merged["1"].objects.map((object) => object.id), ["same", "old-only", "new-only"]);
  assert.equal(merged["1"].objects[0].text, "new");
  historyCtx._lmbInkDocs["old.pdf"] = { "1": { objects: [{ points: [] }, { id: "duplicate", points: [] }, { id: "duplicate", points: [] }] } };
  const normalized = historyCtx.lmbInkObjects("old.pdf", "1");
  assert.equal(new Set(normalized.map((object) => object.id)).size, 3, "legacy and duplicate IDs must be normalized");
  assert(normalized.every((object) => object.type === "pen"));

  assert.equal(proto.lmbInkShouldDraw.call({ inkMode: true, inkTool: "pen", settings: { inkInputMode: "pen-mouse" } }, { pointerType: "touch", button: 0 }), false);
  assert.equal(proto.lmbInkShouldDraw.call({ inkMode: true, inkTool: "pen", settings: { inkInputMode: "pen-only" } }, { pointerType: "mouse", button: 0 }), false);
  assert.equal(proto.lmbInkShouldDraw.call({ inkMode: true, inkTool: "pen", settings: { inkInputMode: "pen-only" } }, { pointerType: "pen", button: 0 }), true);
  assert.equal(proto.lmbInkShouldDraw.call({ inkMode: true, inkTool: "pen", settings: { inkInputMode: "pen-only" } }, { pointerType: "touch", touchType: "stylus", button: 0 }), true);

  const styleState = () => {
    const values = new Map(), priorities = new Map();
    return {
      setProperty: (name, value, priority) => { values.set(name, value); priorities.set(name, priority || ""); },
      getPropertyValue: (name) => values.get(name) || "", getPropertyPriority: (name) => priorities.get(name) || "",
      removeProperty: (name) => { values.delete(name); priorities.delete(name); }, values
    };
  };
  const captureLiveStyle = styleState(), capturePageStyle = styleState();
  const captureLive = { style: captureLiveStyle, dataset: {} };
  const capturePage = { style: capturePageStyle, querySelector: () => captureLive };
  const captureCtx = Object.assign(Object.create(proto), { inkMode: true, inkTool: "pen" });
  captureCtx.lmbUpdateInkPageCapture(capturePage);
  assert.equal(capturePageStyle.values.get("touch-action"), "none");
  assert.equal(captureLiveStyle.values.get("pointer-events"), "auto", "the live ink canvas must be the Pencil hit-test surface");
  captureCtx.inkTool = "hand"; captureCtx.lmbUpdateInkPageCapture(capturePage);
  assert.equal(captureLiveStyle.values.get("pointer-events"), "none");

  global.requestAnimationFrame = (callback) => { callback(); return 0; };
  global.window = { devicePixelRatio: 1 };
  const listeners = new Map();
  const pdfScroller = { scrollLeft: 20, scrollTop: 100 };
  const pageEl = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1400 }),
    setPointerCapture: () => {},
    closest: (selector) => selector === ".pdf-viewer-container" ? pdfScroller : null
  };
  const context2d = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
  const canvas = { dataset: { lmbInkPath: "flow.pdf", lmbInkPage: "1" }, clientWidth: 1000, clientHeight: 1400, getContext: () => context2d };
  const live = {
    dataset: canvas.dataset, clientWidth: 1000, clientHeight: 1400,
    getContext: () => context2d, addEventListener: (name, callback) => listeners.set(name, callback), setPointerCapture: () => {}
  };
  const flowCtx = Object.create(proto);
  Object.assign(flowCtx, {
    inkMode: true, inkTool: "pen", inkColor: "#e05252", inkWidth: 3,
    settings: { inkInputMode: "pen-only", inkPressureMode: "natural", inkEraserSize: 18, inkEraserMode: "stroke", inkEraserAutoReturn: false, inkAnnotations: {} },
    _lmbInkDocs: {}, lmbMarkInkDirty: () => {}, lmbRenderInkTools: () => {}, lmbUpdateInkSaveStatus: () => {},
    lmbActiveInkCanvas: () => canvas
  });
  flowCtx.lmbBindInkPage(pageEl, canvas, live);
  let touchPrevented = false;
  const touchEvent = (name, x, y) => ({ pointerType: "touch", pointerId: 1, button: 0, clientX: x, clientY: y, preventDefault: () => { touchPrevented = true; }, stopPropagation: () => {} });
  listeners.get("pointerdown")(touchEvent("down", 100, 100));
  assert.equal(touchPrevented, true, "custom pan/pinch must own touch input instead of also triggering PDF selection");
  listeners.get("pointermove")(touchEvent("move", 120, 140));
  assert.equal(touchPrevented, true, "one-finger movement must be handled as PDF panning while ink capture is active");
  assert.equal(pdfScroller.scrollLeft, 0); assert.equal(pdfScroller.scrollTop, 60);
  listeners.get("pointerup")(touchEvent("up", 120, 140));
  const event = (x, y, pressure, extra) => Object.assign({
    pointerType: "pen", pointerId: 7, button: 0, buttons: 1, clientX: x, clientY: y, pressure,
    timeStamp: x, preventDefault: () => {}, stopPropagation: () => {}, getCoalescedEvents: () => []
  }, extra || {});
  listeners.get("pointerdown")(event(100, 100, .2));
  let palmPrevented = false;
  listeners.get("pointermove")({ pointerType: "touch", pointerId: 9, clientX: 800, clientY: 900, pressure: .5, timeStamp: 150, preventDefault: () => { palmPrevented = true; }, stopPropagation: () => {} });
  listeners.get("pointerup")({ pointerType: "touch", pointerId: 9, clientX: 800, clientY: 900, pressure: .5, timeStamp: 151, preventDefault: () => { palmPrevented = true; }, stopPropagation: () => {} });
  assert.equal(palmPrevented, true, "a palm touch must be consumed while the pen stroke is active");
  listeners.get("pointermove")(event(300, 250, .8, { getCoalescedEvents: undefined }));
  listeners.get("pointerup")(event(300, 250, .8));
  assert.equal(flowCtx.lmbInkObjects("flow.pdf", "1").length, 1);
  assert.equal(flowCtx.lmbHistoryFor("flow.pdf", "1").undo.length, 1);
  flowCtx.inkTool = "eraser";
  listeners.get("pointerdown")(event(100, 100, .5));
  listeners.get("pointerup")(event(100, 100, .5));
  assert.equal(flowCtx.lmbInkObjects("flow.pdf", "1").length, 0);
  assert.equal(flowCtx.lmbUndoInk(), true);
  assert.equal(flowCtx.lmbInkObjects("flow.pdf", "1").length, 1);
  assert.equal(flowCtx.lmbRedoInk(), true);
  assert.equal(flowCtx.lmbInkObjects("flow.pdf", "1").length, 0);
  flowCtx.inkTool = "pen";
  listeners.get("pointerdown")(event(400, 400, .4)); listeners.get("pointerup")(event(400, 400, .4));
  assert.equal(flowCtx.lmbInkObjects("flow.pdf", "1").length, 1, "a tap must persist as a dot");
  flowCtx.inkTool = "line";
  listeners.get("pointerdown")(event(500, 500, .4)); listeners.get("pointerup")(event(500, 500, .4));
  assert.equal(flowCtx.lmbInkObjects("flow.pdf", "1").length, 1, "a zero-size shape must not be stored");
  flowCtx.inkTool = "pen";
  listeners.get("pointerdown")(event(600, 600, .4)); listeners.get("pointermove")(event(700, 700, .6)); listeners.get("pointercancel")(event(700, 700, .6));
  assert.equal(flowCtx.lmbInkObjects("flow.pdf", "1").length, 2, "a sampled Pencil stroke must survive an iOS pointer cancellation");
  let stylusTouchPrevented = false;
  const iosTouch = (type, x, y, force) => ({
    changedTouches: [{ identifier: 42, touchType: "stylus", altitudeAngle: .9, clientX: x, clientY: y, force }],
    timeStamp: x, cancelable: true, preventDefault: () => { stylusTouchPrevented = true; }, stopPropagation: () => {}
  });
  listeners.get("touchstart")(iosTouch("start", 200, 300, .2));
  listeners.get("touchmove")(iosTouch("move", 280, 390, .8));
  listeners.get("touchend")(iosTouch("end", 280, 390, 0));
  assert.equal(stylusTouchPrevented, true, "the iOS stylus touch path must cancel WKWebView scrolling synchronously");
  assert.equal(flowCtx.lmbInkObjects("flow.pdf", "1").length, 3, "Touch.touchType=stylus must feed the handwriting pipeline");

  // Sparse strokes and fast eraser sweeps must be clipped geometrically, not
  // just by deleting sampled vertices. Preserve pressure and reversible IDs.
  const sparse = { id: "sparse", type: "pen", width: .002, widthUnit: "page", color: "#123456", points: [{ x: .1, y: .5, p: .2, t: 0 }, { x: .9, y: .5, p: .8, t: 100 }] };
  const parts = pure.lmbInkEraseFragments(sparse, { x: .5, y: .2 }, { x: .5, y: .8 }, 10, 1000, 1400);
  assert.equal(parts.length, 2, "a fast sweep splits a sparsely sampled stroke");
  assert(parts[0].at(-1).x < .5 && parts[1][0].x > .5);
  assert(parts[0].at(-1).p > .2 && parts[0].at(-1).p < .8, "cut points interpolate pressure");
  assert.equal(pure.lmbInkEraseFragments(sparse, { x: .5, y: .6 }, { x: .5, y: .6 }, 10, 1000, 1400), null, "page aspect ratio must not stretch eraser hit geometry");
  assert.deepEqual(pure.lmbInkEraseFragments({ type: "pen", points: [{ x: .5, y: .5 }] }, { x: .5, y: .5 }, { x: .5, y: .5 }, 10, 1000, 1400), []);
  const polyline = { ...sparse, points: [{ x: .1, y: .5 }, { x: .4, y: .5 }, { x: .5, y: .5 }, { x: .6, y: .5 }, { x: .9, y: .5 }] };
  assert.equal(pure.lmbInkEraseFragments(polyline, { x: .5, y: .5 }, { x: .5, y: .5 }, 10, 1000, 1400).length, 2, "adjacent clipped segments join only across unerased endpoints");
  assert.equal(pure.lmbInkEraseFragments({ ...sparse, type: "line", x1: .1, y1: .5, x2: .9, y2: .5 }, { x: .5, y: .5 }, { x: .5, y: .5 }, 10, 1000, 1400).length, 2);
  assert(pure.lmbInkEraseFragments({ type: "rect", x1: .2, y1: .2, x2: .8, y2: .8 }, { x: .5, y: .2 }, { x: .5, y: .2 }, 10, 1000, 1400).length >= 2);
  assert.equal(pure.lmbInkIsTextInput({ tagName: "TEXTAREA" }), true);
  assert.equal(pure.lmbInkIsTextInput({ isContentEditable: true }), true);

  flowCtx.lmbReplaceInkObjects("flow.pdf", "1", [sparse]);
  flowCtx.inkTool = "eraser"; flowCtx.settings.inkEraserMode = "partial";
  listeners.get("pointerdown")(event(500, 700, .5)); listeners.get("pointerup")(event(500, 700, .5));
  const fragmented = flowCtx.lmbInkObjects("flow.pdf", "1");
  assert.equal(fragmented.length, 2); assert.equal(new Set(fragmented.map(o => o.id)).size, 2);
  assert.equal(fragmented[0].color, sparse.color);
  assert.equal(flowCtx.lmbUndoInk(), true); assert.deepEqual(flowCtx.lmbInkObjects("flow.pdf", "1"), [sparse]);
  assert.equal(flowCtx.lmbRedoInk(), true); assert.deepEqual(flowCtx.lmbInkObjects("flow.pdf", "1"), fragmented);
  listeners.get("pointerdown")(event(200, 700, .5)); listeners.get("pointercancel")(event(200, 700, .5));
  assert.deepEqual(flowCtx.lmbInkObjects("flow.pdf", "1"), fragmented, "cancelled erasing rolls back its fragments");
  const returns = []; flowCtx.lmbSetInkTool = tool => { returns.push(tool); flowCtx.inkTool = tool; };
  flowCtx.settings.inkEraserAutoReturn = true; flowCtx._lmbInkLastDrawTool = "highlighter";
  listeners.get("pointerdown")(event(100, 700, .5)); listeners.get("pointerup")(event(100, 700, .5));
  assert.deepEqual(returns, ["highlighter"], "normal eraser completion restores the previous drawing tool");
  flowCtx.inkTool = "pen";
  listeners.get("pointerdown")(event(900, 900, .5, { button: 5, buttons: 32 })); listeners.get("pointerup")(event(900, 900, .5));
  assert.equal(flowCtx.inkTool, "pen", "hardware eraser never replaces the selected pen");

  // A palm which lands first cannot resume scrolling after the pen lifts.
  flowCtx.inkTool = "pen"; pdfScroller.scrollTop = 100;
  const finger = (id, x, y) => ({ ...touchEvent("", x, y), pointerId: id });
  listeners.get("pointerdown")(finger(81, 200, 200));
  listeners.get("pointerdown")(event(200, 300, .5));
  listeners.get("pointermove")(finger(81, 200, 500));
  listeners.get("pointerup")(event(240, 350, .5));
  listeners.get("pointermove")(finger(81, 200, 700));
  assert.equal(pdfScroller.scrollTop, 100, "palm-first contacts remain quarantined until lifted");
  listeners.get("pointerup")(finger(81, 200, 700));
  // Pinch uses the host PDF scale, never CSS-transforms only the ink layer.
  pageEl.closest = selector => selector === ".pdf-viewer-container" ? pdfScroller : null;
  pdfScroller.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const zoom = { currentScale: 1 }; flowCtx.lmbInkZoomViewer = () => zoom;
  pdfScroller._lmbInkNavigation.penUntil = 0;
  listeners.get("pointerdown")(finger(82, 100, 100)); listeners.get("pointerdown")(finger(83, 300, 100));
  listeners.get("pointermove")(finger(83, 400, 100));
  assert.equal(zoom.currentScale, 1.5);
  listeners.get("pointerup")(finger(82, 100, 100)); listeners.get("pointerup")(finger(83, 400, 100));
  const countBeforeRecycle = flowCtx.lmbInkObjects("flow.pdf", "1").length;
  listeners.get("pointerdown")(event(200, 200, .5)); listeners.get("pointermove")(event(220, 230, .6)); pageEl._lmbFinishInk();
  assert.equal(flowCtx.lmbInkObjects("flow.pdf", "1").length, countBeforeRecycle + 1, "page recycling preserves sampled ink before changing identity");
  assert.equal(live._lmbInkPendingActive, null, "queued frame cannot resurrect a finished stroke");

  const reverseRect = { id: "reverse", type: "rect", x1: .8, y1: .8, x2: .2, y2: .2, width: .003, widthUnit: "page" };
  flowCtx._lmbInkSelection = [];
  const resize = flowCtx.lmbStartInkSelection(canvas, { x: .8, y: .8 }, [reverseRect], false);
  assert.deepEqual(resize.resizeKeys, { x: "x1", y: "y1" });
  flowCtx.lmbMoveInkSelection(resize, { x: .9, y: .9 });
  assert.equal(reverseRect.x1 > .8, true); assert.equal(reverseRect.x2, .2);
  flowCtx._lmbInkSelection = [reverseRect.id];
  const deselect = flowCtx.lmbStartInkSelection(canvas, { x: reverseRect.x1, y: reverseRect.y1 }, [reverseRect], true);
  assert.equal(deselect.kind, "selectionOnly"); assert.deepEqual(flowCtx._lmbInkSelection, []);

  let staticRedraws = 0, liveClears = 0;
  const identityCanvas = { dataset: { lmbInkIdentity: "old.pdf\n1", lmbInkDrawn: "1" }, clientWidth: 1000, clientHeight: 1400, width: 1000, height: 1400, style: {} };
  const identityLive = { dataset: {}, clientWidth: 1000, clientHeight: 1400, width: 1000, height: 1400, style: {} };
  const identityPage = { dataset: { pageNumber: "2", lmbInkBound: "1" }, clientWidth: 1000, clientHeight: 1400, querySelector: (selector) => selector.includes("live") ? identityLive : identityCanvas };
  const identityCtx = Object.create(proto);
  Object.assign(identityCtx, { inkMode: true, settings: {}, lmbDrawInkLayer: () => { staticRedraws++; }, lmbDrawInkLiveLayer: () => { liveClears++; } });
  identityCtx.lmbEnsureInkLayer(identityPage, "new.pdf", 1);
  assert.equal(staticRedraws, 1); assert.equal(liveClears, 1);
  identityCtx._lmbInkVisibilityObserver = {};
  identityPage._lmbInkNearViewport = false;
  identityPage.clientWidth = 2000;
  identityCtx.lmbEnsureInkLayer(identityPage, "new.pdf", 1);
  assert.equal(identityCanvas.width, 1000, "offscreen zoom must not resize the backing canvas");
  identityPage.getBoundingClientRect = () => ({ top: 100, bottom: 1500 });
  identityPage.closest = () => ({ getBoundingClientRect: () => ({ top: 0, bottom: 1600 }) });
  identityCtx.lmbEnsureInkLayer(identityPage, "new.pdf", 1);
  assert.equal(identityCanvas.width, 2000, "a visibly active page must not wait for an asynchronous visibility callback");
  identityCtx.inkMode = false;
  identityPage.querySelectorAll = () => [identityCanvas, identityLive];
  identityCtx.lmbEnsureInkLayer(identityPage, "new.pdf", 1);
  assert.equal(identityCanvas.width, 1, "unused canvases must release their backing storage");
  assert.equal(identityLive.style.display, "none");
  const emptyPage = { dataset: { pageNumber: "1" }, _lmbInkNearViewport: true, querySelectorAll: () => [] };
  identityCtx.lmbEnsureInkLayer(emptyPage, "empty.pdf", 0);
  assert.equal(emptyPage.dataset.lmbInkBound, undefined, "blank reading pages must not create or bind canvases");
  identityCtx._lmbInkDocs = { "new.pdf": { "2": { objects: [{ id: "saved", type: "line" }] } } };
  identityCtx.lmbEnsureInkLayer(identityPage, "new.pdf", 1);
  assert.equal(identityCanvas.width, 2000, "saved ink must display even when handwriting mode is off");
  assert.equal(identityCanvas.style.display, "block");
  let resizeCallback;
  global.ResizeObserver = class { constructor(callback) { resizeCallback = callback; } observe() {} };
  identityCtx.lmbEnsureInkLayer(identityPage, "new.pdf", 1);
  identityPage.isConnected = true;
  identityPage._lmbInkPageContext = { path: "new.pdf", index: 1 };
  const refreshedPages = [];
  identityCtx.lmbEnsureInkLayer = (page) => refreshedPages.push(page);
  resizeCallback(); resizeCallback(); resizeCallback();
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.deepEqual(refreshedPages, [identityPage], "a burst of resize events must refresh only its page once");
  delete global.ResizeObserver;

  const selectedCanvas = Object.assign({}, canvas, { isConnected: true });
  const otherCanvas = Object.assign({}, canvas, { isConnected: true });
  flowCtx._lmbInkSelectionContext = { canvas: selectedCanvas, path: "flow.pdf", page: "1" }; flowCtx._lmbInkSelection = ["does-not-matter"];
  assert.equal(flowCtx.lmbDeleteInkSelection(otherCanvas), false, "delete must not cross PDF panes");

  global.document = { querySelectorAll: () => [] };
  const files = new Map(), directories = new Set();
  const adapter = {
    exists: async (path) => files.has(path) || directories.has(path),
    mkdir: async (path) => { directories.add(path); },
    list: async (dir) => ({ files: Array.from(files.keys()).filter((path) => path.startsWith(dir + "/") && path.endsWith(".json")), folders: [] }),
    write: async (path, body) => { files.set(path, body); }, read: async (path) => files.get(path)
  };
  const storageCtx = Object.create(proto);
  Object.assign(storageCtx, {
    manifest: { id: "lucias-marginbook" }, app: { vault: { adapter } },
    settings: { inkAnnotations: { "legacy.pdf": { "2": { objects: [{ id: "safe", type: "pen", points: [{ x: .2, y: .3 }] }] } } }, inkSidecarV2Migrated: false },
    saveSettings: async () => {}, lmbUpdateInkSaveStatus: () => {}, lmbScheduleInkRefresh: () => {}
  });
  assert.equal(await storageCtx.lmbInitializeInkStorage(), true);
  assert.equal(storageCtx._lmbInkSidecarReady, true);
  assert.deepEqual(storageCtx.settings.inkAnnotations, {});
  const sidecar = Array.from(files.entries()).find(([path]) => path.endsWith(".json"));
  assert(sidecar); assert.equal(JSON.parse(sidecar[1]).pdfPath, "legacy.pdf");
  assert.equal(JSON.parse(sidecar[1]).pages["2"].objects[0].id, "safe");

  const recoveryFiles = new Map(), recoveryDir = ".obsidian/plugins/lucias-marginbook/ink-data";
  const recoveryPath = `${recoveryDir}/${pure.lmbInkFileKey("recover.pdf")}`;
  recoveryFiles.set(recoveryPath, "{broken");
  recoveryFiles.set(recoveryPath + ".bak", JSON.stringify({ version: 2, pdfPath: "recover.pdf", pages: { "1": { objects: [{ id: "backup", type: "pen", points: [] }] } } }));
  const recoveryAdapter = { exists: async (path) => recoveryFiles.has(path) || path === recoveryDir, read: async (path) => recoveryFiles.get(path), write: async (path, body) => recoveryFiles.set(path, body), mkdir: async () => {} };
  const recoveryCtx = Object.create(proto);
  Object.assign(recoveryCtx, { manifest: { id: "lucias-marginbook" }, app: { vault: { adapter: recoveryAdapter } }, settings: { inkAnnotations: {}, inkSidecarV2Migrated: true }, lmbUpdateInkSaveStatus: () => {} });
  let loadedRefreshes = 0;
  recoveryCtx.lmbScheduleInkRefresh = () => { loadedRefreshes++; };
  await recoveryCtx.lmbInitializeInkStorage(); await recoveryCtx.lmbEnsureInkDocument("recover.pdf");
  assert.equal(loadedRefreshes, 1, "async sidecar loading must request creation of visible saved-ink layers");
  assert.equal(recoveryCtx.lmbInkObjects("recover.pdf", "1")[0].id, "backup");

  const newestFiles = new Map(), newestPath = `${recoveryDir}/${pure.lmbInkFileKey("newest.pdf")}`;
  newestFiles.set(newestPath, JSON.stringify({ version: 2, pdfPath: "newest.pdf", revision: 1, savedAt: 100, pages: { "1": { objects: [{ id: "old-target", type: "pen", points: [] }] } } }));
  newestFiles.set(newestPath + ".tmp", JSON.stringify({ version: 2, pdfPath: "newest.pdf", revision: 2, savedAt: 200, pages: { "1": { objects: [{ id: "new-temp", type: "pen", points: [] }] } } }));
  const newestAdapter = { exists: async (path) => newestFiles.has(path), read: async (path) => newestFiles.get(path) };
  const newestCtx = Object.create(proto);
  Object.assign(newestCtx, { manifest: { id: "lucias-marginbook" } });
  const newestDoc = await newestCtx.lmbReadInkSidecar("newest.pdf", newestAdapter, recoveryDir);
  assert.equal(newestDoc.pages["1"].objects[0].id, "new-temp", "newer recoverable temp data must win over an older target");

  const corruptFiles = new Map(), corruptPath = `${recoveryDir}/${pure.lmbInkFileKey("corrupt.pdf")}`;
  corruptFiles.set(corruptPath, "{definitely-broken");
  const corruptAdapter = { exists: async (path) => corruptFiles.has(path) || path === recoveryDir, read: async (path) => corruptFiles.get(path), write: async (path, body) => corruptFiles.set(path, body), mkdir: async () => {} };
  const corruptCtx = Object.create(proto);
  Object.assign(corruptCtx, { manifest: { id: "lucias-marginbook" }, app: { vault: { adapter: corruptAdapter } }, settings: { inkAnnotations: {}, inkSidecarV2Migrated: true }, lmbUpdateInkSaveStatus: () => {} });
  await corruptCtx.lmbInitializeInkStorage();
  assert.equal(await corruptCtx.lmbEnsureInkDocument("corrupt.pdf"), false, "unrecoverable sidecars must fail closed");
  assert.equal(corruptCtx._lmbInkLoadErrors.has("corrupt.pdf"), true);
  assert.equal(corruptFiles.get(corruptPath), "{definitely-broken", "a corrupt original must never be overwritten during load");

  const staleFiles = new Map(), stalePath = `${recoveryDir}/${pure.lmbInkFileKey("merge.pdf")}`;
  staleFiles.set(stalePath, JSON.stringify({ version: 2, pdfPath: "merge.pdf", pages: { "1": { objects: [{ id: "old", type: "pen", points: [] }] } } }));
  const staleAdapter = { exists: async (path) => staleFiles.has(path) || path === recoveryDir, read: async (path) => staleFiles.get(path), write: async (path, body) => staleFiles.set(path, body), mkdir: async () => {} };
  const staleCtx = Object.create(proto);
  Object.assign(staleCtx, { manifest: { id: "lucias-marginbook" }, app: { vault: { adapter: staleAdapter } }, settings: { inkAnnotations: { "merge.pdf": { "1": { objects: [{ id: "new", type: "pen", points: [] }] } } }, inkSidecarV2Migrated: false }, saveSettings: async () => {}, lmbUpdateInkSaveStatus: () => {} });
  await staleCtx.lmbInitializeInkStorage();
  assert.deepEqual(staleCtx.lmbInkObjects("merge.pdf", "1").map((object) => object.id), ["old", "new"]);

  const renameCtx = Object.create(proto);
  Object.assign(renameCtx, {
    manifest: { id: "lucias-marginbook" }, app: { vault: { adapter: staleAdapter } }, settings: { inkAnnotations: {} },
    _lmbInkDocs: {
      "before.pdf": { "1": { objects: [{ id: "moved", type: "pen", points: [] }] } },
      "after.pdf": { "1": { objects: [{ id: "existing", type: "pen", points: [] }] } }
    },
    _lmbInkSidecarReady: true, _lmbInkLoadedPaths: new Set(["before.pdf", "after.pdf"]),
    _lmbInkDirtyPaths: new Set(), _lmbInkDirtyRevisions: new Map(), _lmbInkHistory: new Map([["before.pdf\n1", { undo: [], redo: [] }]]),
    lmbUpdateInkSaveStatus: () => {}, lmbScheduleInkRefresh: () => {}
  });
  assert.equal(await renameCtx.lmbHandleInkPdfRename({ path: "after.pdf", extension: "pdf" }, "before.pdf"), true);
  clearTimeout(renameCtx._lmbInkSaveTimer);
  assert.deepEqual(renameCtx.lmbInkObjects("after.pdf", "1").map((object) => object.id), ["existing", "moved"]);
  assert.equal(renameCtx._lmbInkDocs["before.pdf"], undefined);
  assert.equal(renameCtx._lmbInkHistory.has("after.pdf\n1"), true);

  let releaseWrite, announceWrite;
  const writeStarted = new Promise((resolve) => { announceWrite = resolve; });
  const concurrentFiles = new Map(); let blockFirstTemp = true;
  const concurrentAdapter = {
    exists: async (path) => concurrentFiles.has(path) || path.endsWith("ink-data"),
    write: async (path, body) => {
      if (blockFirstTemp && path.endsWith(".tmp")) {
        blockFirstTemp = false; announceWrite(); await new Promise((resolve) => { releaseWrite = resolve; });
      }
      concurrentFiles.set(path, body);
    },
    read: async (path) => concurrentFiles.get(path)
  };
  const concurrentCtx = Object.create(proto);
  Object.assign(concurrentCtx, {
    manifest: { id: "lucias-marginbook" }, app: { vault: { adapter: concurrentAdapter } },
    settings: { inkAnnotations: {} }, _lmbInkDocs: { "busy.pdf": { "1": { objects: [{ id: "first" }] } } },
    _lmbInkSidecarReady: true, _lmbInkDirtyPaths: new Set(), _lmbInkDirtyRevisions: new Map(),
    lmbUpdateInkSaveStatus: () => {}
  });
  concurrentCtx.lmbMarkInkDirty("busy.pdf");
  clearTimeout(concurrentCtx._lmbInkSaveTimer);
  const firstFlush = concurrentCtx.lmbFlushInkStorage();
  await writeStarted;
  concurrentCtx._lmbInkDocs["busy.pdf"]["1"].objects.push({ id: "second" });
  concurrentCtx.lmbMarkInkDirty("busy.pdf");
  clearTimeout(concurrentCtx._lmbInkSaveTimer); releaseWrite(); await firstFlush;
  assert.equal(concurrentCtx._lmbInkDirtyPaths.has("busy.pdf"), true, "a write made during flush must remain dirty");
  clearTimeout(concurrentCtx._lmbInkSaveTimer); await concurrentCtx.lmbFlushInkStorage(); clearTimeout(concurrentCtx._lmbInkSaveTimer);
  const concurrentTarget = Array.from(concurrentFiles.entries()).find(([path]) => path.endsWith(".json"));
  assert.equal(JSON.parse(concurrentTarget[1]).pages["1"].objects.length, 2);

  // An explicit flush after autosave has no pending data. It must not lock
  // the promise cache and silently suppress the user's subsequent handwriting.
  await concurrentCtx.lmbFlushInkStorage(); await concurrentCtx.lmbFlushInkStorage();
  assert.equal(concurrentCtx._lmbInkFlushPromise, null);
  concurrentCtx._lmbInkDocs["busy.pdf"]["1"].objects.push({ id:"after-empty-flush", inkGroupIds:["group-resume"] });
  concurrentCtx.lmbMarkInkDirty("busy.pdf"); clearTimeout(concurrentCtx._lmbInkSaveTimer);
  await concurrentCtx.lmbFlushInkStorage(); clearTimeout(concurrentCtx._lmbInkSaveTimer);
  const afterEmptyFlush = JSON.parse(concurrentFiles.get(concurrentTarget[0]));
  assert.equal(afterEmptyFlush.pages["1"].objects.length,3,'writing after an empty flush still reaches the durable sidecar');
  assert.deepEqual(afterEmptyFlush.pages["1"].objects[2].inkGroupIds,["group-resume"]);

  const failedCtx = Object.create(proto);
  Object.assign(failedCtx, {
    manifest: { id: "lucias-marginbook" }, app: { vault: { adapter: { write: async () => { throw new Error("disk full"); }, read: async () => "", exists: async () => false } } },
    settings: { inkAnnotations: {} }, _lmbInkDocs: { "fail.pdf": {} }, _lmbInkSidecarReady: true,
    _lmbInkDirtyPaths: new Set(["fail.pdf"]), _lmbInkDirtyRevisions: new Map([["fail.pdf", 1]]), _unloaded: true, lmbUpdateInkSaveStatus: () => {}
  });
  await assert.rejects(() => failedCtx.lmbFlushInkStorage());
  assert.equal(failedCtx._lmbInkSaveTimer == null, true, "unloaded plugins must not schedule save retries");

  const fallbackCtx = Object.create(proto);
  Object.assign(fallbackCtx, {
    manifest: { id: "lucias-marginbook" },
    app: { vault: { adapter: { exists: async () => false, mkdir: async () => { throw new Error("read only"); } } } },
    settings: { inkAnnotations: { "kept.pdf": { "1": { objects: [{ id: "kept", type: "pen", points: [] }] } } } }
  });
  assert.equal(await fallbackCtx.lmbInitializeInkStorage(), false);
  assert.equal(fallbackCtx._lmbInkSidecarReady, false);
  assert.equal(fallbackCtx.lmbInkObjects("kept.pdf", "1")[0].id, "kept");

  console.log("Ink simulation verification passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
