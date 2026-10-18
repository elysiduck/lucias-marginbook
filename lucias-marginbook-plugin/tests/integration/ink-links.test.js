"use strict";
const assert = require("node:assert/strict"), Module = require("node:module");
class TFile { constructor(path) { this.path = path; this.name = path.split("/").pop(); this.basename = this.name.replace(/\.[^.]+$/, ""); this.extension = path.split(".").pop(); } }
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === "obsidian") return { Plugin: class {}, TFile, Notice: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, FuzzySuggestModal: class {}, normalizePath: x => x, setIcon() {} };
  return original.call(this, name, ...args);
};
const P = require("../../main.js"); Module._load = original;
const pure = P.__test, clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const p = new P(), pdf = new TFile("Books/pdf书籍/Course/book.pdf"), files = new Map([[pdf.path, pdf]]), raws = new Map();
  p.settings = { storageLayout: "central", storageRoot: "Lucia's Marginbook", pdfSourceRoot: "Books/pdf书籍", quickExcerpts: {}, inkExcerptLinks: {} };
  const excerpt = { exId: "ex-existing", pdfPath: pdf.path, page: 1, text: "Original English excerpt", sourceMd: "notes.md", note: "Do not change" };
  p.excerptIndex = new Map([[pdf.path, [excerpt]]]); p.getExcerptsForPdf = () => [excerpt];
  p._lmbInkDocs = { [pdf.path]: { "1": { objects: [{ id: "stroke-a", type: "pen", color: "#222", width: .003, widthUnit: "page", points: [{ x: .1, y: .2, p: .3, t: 0 }, { x: .9, y: .2, p: .7, t: 100 }] }] } } };
  p.settingsStore = { serialize: clone }; p._lmbPrunePersistedCaches = () => {};
  p.saveData = async value => { p.disk = clone(value); };
  p.lmbFlushInkStorage = async () => { p.inkDisk = clone(p._lmbInkDocs); return true; };
  p.lmbSchedulePdfSidebarRefresh = p.lmbScheduleInkReferenceRefresh = () => {};
  p.app = { workspace: { getLeavesOfType: () => [] }, vault: {
    getAbstractFileByPath: path => files.get(path), createFolder: async path => { files.set(path, { path }); },
    create: async (path, raw) => { assert(!files.has(path), "duplicate file creation"); const f = new TFile(path); files.set(path, f); raws.set(path, raw); return f; },
    adapter: { read: async path => raws.get(path), write: async (path, raw) => { raws.set(path, raw); } }
  } };
  p.selfWritten = new Map(); p.lmbFocusCanvasNode = async () => true;
  return { p, pdf, files, raws, excerpt, snapshot: { path: pdf.path, page: 1, objectIds: ["stroke-a"], pageAspect: 1.2 } };
}
async function main() {
  const { p, pdf, files, raws, excerpt, snapshot } = fixture(), originalInk = clone(p._lmbInkDocs), originalExcerpt = clone(excerpt);
  const associated = await p.lmbLinkInkSelection(snapshot, excerpt);
  assert.deepEqual(p._lmbInkDocs, originalInk); assert.deepEqual(excerpt, originalExcerpt);
  assert.equal(p.settings.quickExcerpts[pdf.path], undefined, "linking existing excerpts never duplicates their note records");
  assert.equal(p.disk.inkExcerptLinks[pdf.path][excerpt.exId].id, associated.link.id);
  assert.deepEqual(p.inkDisk, originalInk, "original ink is durable before its reference");
  await p.lmbLinkInkSelection({ ...snapshot, objectIds: ["stroke-a", "stroke-a"] }, excerpt);
  assert.equal(p.lmbInkLinks(pdf.path)[excerpt.exId].groups.length, 1, "repeated association is idempotent");
  const created = await p.lmbLinkInkSelection(snapshot, null, "我的公式推导");
  assert.equal(p.settings.quickExcerpts[pdf.path].length, 1); assert.equal(created.entry.inkNote, true);
  assert.equal(created.entry.note, ""); assert.equal(created.entry.text, "我的公式推导");
  await p.lmbSaveTextBlockNote({ ...created.entry, pdfPath: pdf.path, quick: true }, "**保留 Markdown 备注**");
  assert.equal(p.disk.quickExcerpts[pdf.path][0].note, "**保留 Markdown 备注**");
  const ref = created.link.id, paths = p.lmbStoragePaths(pdf);
  await p.lmbEnsureStorageParent(paths.canvas);
  const existing = { nodes: [{ id: "user-card", type: "text", text: "User content", x: -400, y: 720, width: 400, height: 850 }], edges: [{ id: "user-edge", fromNode: "user-card", toNode: "user-card" }], metadata: { keep: true } };
  await p.app.vault.create(paths.canvas, JSON.stringify(existing));
  const [one, duplicate] = await Promise.all([p.lmbPutInkReferenceInCanvas(pdf.path, created.exId), p.lmbPutInkReferenceInCanvas(pdf.path, created.exId)]);
  assert.equal(one.nodeId, duplicate.nodeId);
  let canvas = JSON.parse(raws.get(paths.canvas));
  assert.deepEqual(canvas.nodes[0], existing.nodes[0]); assert.deepEqual(canvas.edges, existing.edges); assert.deepEqual(canvas.metadata, existing.metadata);
  assert.equal(canvas.nodes.length, 2); assert.equal(pure.lmbInkCanvasReference(canvas.nodes[1].text), ref);
  assert(!canvas.nodes[1].text.includes('"points"'), "Canvas stores only a stable reference, never a flattened or duplicated stroke payload");
  assert.equal(p.lmbParsePdfLink(canvas.nodes[1].text.split("\n")[0].slice(2, -2)).inkRef, ref);
  await p.lmbPutInkReferenceInCanvas(pdf.path, created.exId); assert.equal(JSON.parse(raws.get(paths.canvas)).nodes.length, 2);
  const secondCreated = await p.lmbLinkInkSelection(snapshot, null, "第二组");
  await Promise.all([p.lmbPutInkReferenceInCanvas(pdf.path, excerpt.exId), p.lmbPutInkReferenceInCanvas(pdf.path, secondCreated.exId)]);
  canvas = JSON.parse(raws.get(paths.canvas)); assert.equal(canvas.nodes.length, 4, "concurrent exports of different references cannot overwrite each other");
  assert.deepEqual(canvas.nodes[0], existing.nodes[0]);
  const bad = fixture(); bad.p.saveData = async () => { throw Error("disk full"); };
  await assert.rejects(bad.p.lmbLinkInkSelection(bad.snapshot, null, "草稿"), /disk full/);
  assert.equal(bad.p.settings.quickExcerpts[bad.pdf.path].length, 0); assert.deepEqual(bad.p.lmbInkLinks(bad.pdf.path), {});
  assert.deepEqual(bad.p._lmbInkDocs, { [bad.pdf.path]: originalInk[pdf.path] });
  bad.p.saveData = async value => { bad.p.disk = clone(value); }; await bad.p.lmbLinkInkSelection(bad.snapshot, null, "重试后的标题");
  assert.equal(bad.p.settings.quickExcerpts[bad.pdf.path].length, 1);
  const failInk = fixture(); failInk.p.lmbFlushInkStorage = async () => { throw Error("ink not durable"); };
  await assert.rejects(failInk.p.lmbLinkInkSelection(failInk.snapshot, null, "未保存笔迹"), /not durable/);
  assert.equal(failInk.p.settings.quickExcerpts[failInk.pdf.path], undefined);
  await assert.rejects(p.lmbLinkInkSelection(snapshot, { ...excerpt, pdfPath: "other.pdf" }), /同一 PDF/);
  const stroke = p._lmbInkDocs[pdf.path]["1"].objects[0], fragments = pure.lmbInkEraseFragments(stroke, { x: .5, y: .2 }, { x: .5, y: .2 }, 18, 1000, 1200);
  const pieces = fragments.map((points, i) => ({ ...stroke, id: i ? "fragment-b" : stroke.id, points, inkSourceIds: [stroke.id] }));
  p._lmbInkDocs[pdf.path]["1"].objects = pieces;
  assert.equal(pure.lmbInkGroupObjects(p._lmbInkDocs[pdf.path], created.link.groups[0]).length, 2, "reference follows every partial-eraser descendant");
  await p.lmbLinkInkSelection({ ...snapshot, objectIds: pieces.map(o => o.id) }, { ...created.entry, pdfPath: pdf.path, quick: true });
  assert.equal(p.lmbInkLinks(pdf.path)[created.exId].groups.length, 1, "reassociating eraser fragments cannot duplicate an already-covered group");
  p._lmbInkDocs[pdf.path]["1"].objects = [{ ...pieces[1], points: pieces[1].points.map(point => ({ ...point, y: point.y + .2 })) }];
  assert(pure.lmbInkGroupBounds(pure.lmbInkGroupObjects(p._lmbInkDocs[pdf.path], created.link.groups[0])).y > .3, "navigation bounds follow moved surviving fragments");
  p._lmbInkDocs[pdf.path]["1"].objects = []; assert.deepEqual(pure.lmbInkGroupObjects(p._lmbInkDocs[pdf.path], created.link.groups[0]), []);
  assert.equal(p.settings.quickExcerpts[pdf.path][0].note, "**保留 Markdown 备注**", "erasing all ink never deletes commentary");
  p._lmbInkDocs[pdf.path]["1"].objects = [stroke]; assert.equal(pure.lmbInkGroupObjects(p._lmbInkDocs[pdf.path], created.link.groups[0]).length, 1, "undo restores the original reference");
  const live = fixture(), liveLink = await live.p.lmbLinkInkSelection(live.snapshot, null, "活动画布");
  await live.p.lmbEnsureStorageParent(live.p.lmbStoragePaths(live.pdf).canvas);
  await live.p.app.vault.create(live.p.lmbStoragePaths(live.pdf).canvas, JSON.stringify(existing));
  const memory = clone(existing); memory.nodes[0].x = 999; let committed;
  live.p._lmbMemCanvasData = () => ({ data: memory, canvas: { setData: data => { committed = data; }, requestSave: () => {} } });
  await live.p.lmbPutInkReferenceInCanvas(live.pdf.path, liveLink.exId);
  assert.equal(committed.nodes[0].x, 999, "unsaved Canvas positions remain authoritative"); assert.equal(memory.nodes.length, 1, "export does not mutate the uncommitted source snapshot");
  const failure = fixture(), failureLink = await failure.p.lmbLinkInkSelection(failure.snapshot, null, "不能覆盖的布局");
  const beforeFailure = clone(existing); failure.p._lmbReadCanvasData = async () => ({ data: beforeFailure }); failure.p._lmbWriteCanvasData = async () => false;
  await assert.rejects(failure.p.lmbPutInkReferenceInCanvas(failure.pdf.path, failureLink.exId), /保存失败/); assert.deepEqual(beforeFailure, existing);
  const renamed = "Books/pdf书籍/Course/renamed.pdf";
  files.set(renamed, new TFile(renamed)); p.lmbMarkInkDirty = p.lmbScheduleInkRefresh = () => {}; p._lmbInkDocs[pdf.path] = originalInk[pdf.path];
  assert.equal(await p.lmbHandleInkPdfRename(files.get(renamed), pdf.path), true);
  assert.equal(p.lmbFindInkReference(ref).path, renamed, "Canvas references survive PDF rename without rewriting their payload");
  assert.equal(pure.lmbInkCanvasReference('```marginbook-ink\n{"ref":"javascript:bad"}\n```'), null);
  // Async PDF rendering must not scroll a reused leaf after its file changed.
  const stale = fixture(), staleLink = await stale.p.lmbLinkInkSelection(stale.snapshot, null, "stale location");
  const docEvents = new Map(), doc = { addEventListener: (name, fn) => docEvents.set(name, fn), removeEventListener: name => docEvents.delete(name) };
  const container = { ownerDocument: doc }, leaf = { containerEl: container, view: { file: stale.pdf, containerEl: container } };
  stale.p.app.workspace.activeLeaf = leaf; stale.p.app.workspace.getLeavesOfType = () => [leaf]; stale.p.app.workspace.setActiveLeaf = next => { stale.p.app.workspace.activeLeaf = next; };
  let releasePage, didScroll = false; const page = { isConnected: true, scrollIntoView: () => { didScroll = true; } };
  stale.p.lmbWaitPageEl = () => new Promise(resolve => { releasePage = resolve; });
  const locating = stale.p.lmbLocateInkReference(staleLink.link.id);
  while (!releasePage) await new Promise(r => setTimeout(r, 0));
  leaf.view.file = new TFile("different.pdf"); releasePage(page);
  assert.equal(await locating, false); assert.equal(didScroll, false, "late ink navigation cannot scroll a different PDF in the same tab");
  leaf.view.file = stale.pdf; releasePage = null;
  const interrupted = stale.p.lmbLocateInkReference(staleLink.link.id);
  while (!releasePage) await new Promise(r => setTimeout(r, 0));
  docEvents.get("wheel")(); releasePage(page); assert.equal(await interrupted, false); assert.equal(didScroll, false);
  stale.p.lmbSaveEditorsBeforeInkNavigation = async () => false;
  assert.equal(await stale.p.lmbLocateInkReference(staleLink.link.id), false, "failed commentary save prevents navigation");
  stale.p._unloaded = true; assert.equal(await stale.p.lmbLocateInkReference(staleLink.link.id), false);
  for (const reason of ["unload", "erase"]) {
    const pending = fixture(); let release, announce;
    const started = new Promise(resolve => { announce = resolve; });
    pending.p.lmbFlushInkStorage = async () => { announce(); await new Promise(resolve => { release = resolve; }); };
    const operation = pending.p.lmbLinkInkSelection(pending.snapshot, null, "pending " + reason);
    const caught = operation.catch(error => error); await started;
    if (reason === "unload") pending.p._unloaded = true; else pending.p._lmbInkDocs[pending.pdf.path]["1"].objects = [];
    release(); assert((await caught) instanceof Error); assert.equal(pending.p.settings.quickExcerpts[pending.pdf.path], undefined, "interrupted pending linking creates no ghost note");
  }
  // Fixed per-PDF numbers survive reorder, deletion, reload and rename.
  const numbered = fixture();
  numbered.p.settings.inkExcerptLinks[numbered.pdf.path] = {
    old: { id: "inkref-old", groups: [], number: 7 },
    legacy: { id: "inkref-legacy", groups: [] },
    duplicate: { id: "inkref-duplicate", groups: [], number: 7 }
  };
  assert.equal(numbered.p.lmbInitializeInkLinkNumbers(), true);
  const numbers = Object.values(numbered.p.lmbInkLinks(numbered.pdf.path)).map(link => link.number);
  assert.deepEqual(numbers, [7, 8, 9]);
  assert.equal(numbered.p.lmbInitializeInkLinkNumbers(), false);
  delete numbered.p.settings.inkExcerptLinks[numbered.pdf.path].duplicate;
  const nextNumber = await numbered.p.lmbLinkInkSelection(numbered.snapshot, null, "next number");
  assert.equal(nextNumber.link.number, 10, "deleted numbers are never reused");
  assert.equal(numbered.p.lmbInkLinkLabel(numbered.pdf.path, 'legacy'), "手写 H8");
  const restarted = fixture(); restarted.p.settings = clone(numbered.p.disk);
  assert.equal(restarted.p.lmbInkLinkLabel(numbered.pdf.path, 'legacy'), "手写 H8");

  // Natural-height commits merge only height into the CURRENT live snapshot.
  const fit = fixture(), fitLink = await fit.p.lmbLinkInkSelection(fit.snapshot, null, "fit reference");
  const card = { id: 'ink-card', type: 'text', text: '```marginbook-ink\n' + JSON.stringify({ ref: fitLink.link.id }) + '\n```', x: 125, y: 245, width: 420, height: 900 };
  const fitData = { nodes: [clone(existing.nodes[0]), card], edges: clone(existing.edges) };
  const host = { isConnected: true, dataset: { lmbInkRef: fitLink.link.id } };
  const wrapper = { contains: h => h === host, querySelector: () => null };
  let currentFitData = fitData, writes = 0;
  const fitCanvas = { nodes: new Map([['ink-card', { id: 'ink-card', nodeEl: wrapper }]]), getData: () => currentFitData };
  fit.p.app.workspace.getLeavesOfType = () => [{ containerEl: { contains: h => h === host }, view: { file: new TFile('fit.canvas'), canvas: fitCanvas } }];
  fit.p.lmbMeasureInkCardHeight = () => 240;
  fit.p._lmbWriteCanvasData = async (file, data) => { writes++; currentFitData = data; return true; };
  await fit.p.lmbFitInkReferenceCards(host);
  assert.equal(currentFitData.nodes[1].height, 240, 'oversized cards shrink');
  assert.deepEqual(currentFitData.nodes[0], existing.nodes[0]); assert.deepEqual(currentFitData.edges, existing.edges);
  assert.deepEqual({ ...currentFitData.nodes[1], height: 900 }, card, 'all geometry except height and all text remain unchanged');
  assert.equal(fitData.nodes[1].height, 900, 'live source object is never mutated in place');
  await fit.p.lmbFitInkReferenceCards(host); assert.equal(writes, 1, 'equal heights produce no save loop');
  currentFitData.nodes[1].x = 999; fit.p.lmbMeasureInkCardHeight = () => 500;
  await fit.p.lmbFitInkReferenceCards(host); assert.equal(currentFitData.nodes[1].height, 500, 'cards can grow again');
  assert.equal(currentFitData.nodes[1].x, 999, 'recent live positions are preserved');
  wrapper.querySelector = () => ({}); fit.p.lmbMeasureInkCardHeight = () => 800;
  await fit.p.lmbFitInkReferenceCards(host); assert.equal(writes, 2, 'never resize a card while Markdown is being edited');
  wrapper.querySelector = () => null; host.isConnected = false;
  await fit.p.lmbFitInkReferenceCards(host); assert.equal(writes, 2, 'detached cards cannot overwrite a current Canvas');
  console.log("Ink associations: durable references, notes, eraser lineage, current bounds, Canvas layout/idempotence/concurrency, rollback and rename passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
