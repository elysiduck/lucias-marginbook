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

  global.requestAnimationFrame = (callback) => { callback(); return 0; };
  global.window = { devicePixelRatio: 1 };
  const listeners = new Map();
  const pageEl = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1400 }),
    setPointerCapture: () => {}
  };
  const context2d = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
  const canvas = { dataset: { lmbInkPath: "flow.pdf", lmbInkPage: "1" }, clientWidth: 1000, clientHeight: 1400, getContext: () => context2d };
  const live = { dataset: canvas.dataset, clientWidth: 1000, clientHeight: 1400, getContext: () => context2d };
  const flowCtx = Object.create(proto);
  Object.assign(flowCtx, {
    inkMode: true, inkTool: "pen", inkColor: "#e05252", inkWidth: 3,
    settings: { inkInputMode: "pen-only", inkPressureMode: "natural", inkEraserSize: 18, inkAnnotations: {} },
    _lmbInkDocs: {}, lmbMarkInkDirty: () => {}, lmbRenderInkTools: () => {}, lmbUpdateInkSaveStatus: () => {},
    lmbActiveInkCanvas: () => canvas
  });
  flowCtx.lmbBindInkPage(pageEl, canvas, live);
  let touchPrevented = false;
  listeners.get("pointerdown")({ pointerType: "touch", button: 0, clientX: 100, clientY: 100, preventDefault: () => { touchPrevented = true; }, stopPropagation: () => {} });
  assert.equal(touchPrevented, false, "finger input must pass through to PDF navigation");
  const event = (x, y, pressure, extra) => Object.assign({
    pointerType: "pen", pointerId: 7, button: 0, buttons: 1, clientX: x, clientY: y, pressure,
    timeStamp: x, preventDefault: () => {}, stopPropagation: () => {}, getCoalescedEvents: () => []
  }, extra || {});
  listeners.get("pointerdown")(event(100, 100, .2));
  let palmPrevented = false;
  listeners.get("pointermove")({ pointerType: "touch", pointerId: 9, clientX: 800, clientY: 900, pressure: .5, timeStamp: 150, preventDefault: () => { palmPrevented = true; }, stopPropagation: () => {} });
  listeners.get("pointerup")({ pointerType: "touch", pointerId: 9, clientX: 800, clientY: 900, pressure: .5, timeStamp: 151, preventDefault: () => { palmPrevented = true; }, stopPropagation: () => {} });
  assert.equal(palmPrevented, false, "a second touch pointer must not alter or finish the pen stroke");
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
  Object.assign(identityCtx, { lmbDrawInkLayer: () => { staticRedraws++; }, lmbDrawInkLiveLayer: () => { liveClears++; } });
  identityCtx.lmbEnsureInkLayer(identityPage, "new.pdf", 1);
  assert.equal(staticRedraws, 1); assert.equal(liveClears, 1);

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
    saveSettings: async () => {}, lmbUpdateInkSaveStatus: () => {}
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
  await recoveryCtx.lmbInitializeInkStorage(); await recoveryCtx.lmbEnsureInkDocument("recover.pdf");
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
