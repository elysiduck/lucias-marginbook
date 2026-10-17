"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
class Element {
  constructor(cls = "", tag = "div") {
    this.cls = new Set(cls.split(" ")); this.tag = tag; this.children = []; this.childNodes = this.children;
    this.dataset = {}; this.style = { setProperty(key, value) { this[key] = value; } }; this.events = {}; this.isConnected = true;
    this.scrollTop = 0;
    this.classList = { contains: (x) => this.cls.has(x), add: (x) => this.cls.add(x), remove: (x) => this.cls.delete(x), toggle: (x, on) => {
      const value = on === undefined ? !this.cls.has(x) : on; value ? this.cls.add(x) : this.cls.delete(x); return value;
    } };
    this.ownerDocument = { createElement: (tag) => new Element("", tag) };
    this.rect = { left: 0, top: 0, width: 1000, height: 1400 };
  }
  createDiv(opts) { return this.createEl("div", opts); }
  createSpan(opts) { return this.createEl("span", opts); }
  createEl(tag, opts = {}) {
    const el = new Element(opts.cls || "", tag); el.textContent = opts.text || "";
    el.parent = this; el.ownerDocument = this.ownerDocument; this.children.push(el); return el;
  }
  querySelectorAll(selector) {
    const direct = selector.startsWith(":scope > "); selector = selector.replace(":scope > ", "");
    const found = [];
    for (const el of this.children) {
      if (selector.startsWith(".") ? el.cls.has(selector.slice(1)) : el.tag === selector) found.push(el);
      if (!direct) found.push(...el.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { ...this.rect, bottom: this.rect.top + this.rect.height, right: this.rect.left + this.rect.width }; }
  contains(el) { return !!el && (el === this || this.children.some((child) => child.contains(el))); }
  setAttribute(name, value) { (this.attributes || (this.attributes = {}))[name] = value; }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  get textContent() { return (this._text || "") + this.children.map((child) => child.textContent).join(""); }
  set textContent(text) { this._text = text; }
  addEventListener(type, fn) { (this.events[type] || (this.events[type] = new Set())).add(fn); }
  removeEventListener(type, fn) { if (this.events[type]) this.events[type].delete(fn); }
  async emit(type, value) { for (const fn of Array.from(this.events[type] || [])) await fn(value); }
  setPointerCapture() {}
  addClass(cls) { this.cls.add(cls); }
  toggleClass(cls, value) { this.classList.toggle(cls, value); }
  setText(text) { this.textContent = text; }
  empty() { this.children.length = 0; }
  replaceChildren(...elements) { this.empty(); this.children.push(...elements); elements.forEach((el) => { el.parent = this; }); }
  remove() { this.isConnected = false; if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
}
class Plugin {}
const context = vm.createContext({ LuciasMarginBookPlugin: Plugin, Notice: class { hide() {} },
  MarkdownRenderer: { render: async (_app, text, el) => { el.textContent = text; } }, console, setTimeout, clearTimeout });
for (const file of ["src/pdf/sidebar-controller.js", "src/pdf/text-block-controller.js", "src/pdf/mark-service.js", "src/core/settings-store.js"])
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
const proto = Plugin.prototype;
async function main() {
  assert.equal(proto._lmbSidebarSummary("## **前景理论**\n长篇内容", "题干"), "前景理论");
  assert.equal(proto._lmbSidebarSummary("\n<!-- marker -->\n> [!note]\n> **我的理解**", "题干"), "我的理解");
  assert.equal(proto._lmbSidebarSummary("", "1. **Prospect Theory**"), "Prospect Theory");
  assert.equal(proto._lmbSidebarSummary("2026 年的知识脉络", ""), "2026 年的知识脉络");
  assert.equal(proto._lmbSidebarSummary("[理论笔记](notes.md) 与 [[原文|作业]]", ""), "理论笔记 与 作业");
  assert.equal(proto._lmbSidebarSummary("", ""), "无文字批注");
  // Slow Markdown must never expose unfiltered page-one rows or an empty counter.
  const rendering = new Plugin(), sidebar = new Element();
  const pdfFile = { path: "async.pdf", extension: "pdf", name: "async.pdf" };
  const renderingLeaf = { view: { file: pdfFile }, containerEl: { querySelector: () => sidebar, querySelectorAll: () => [] } };
  const oldHead = sidebar.createDiv({ cls: "lmb-pdf-sidebar-title" });
  const oldCounter = oldHead.createDiv({ cls: "lmb-pdf-sidebar-title-sub", text: "当前第 3 页 · 1 条" });
  const oldSearch = oldHead.createEl("input", { cls: "lmb-pdf-sidebar-search" }); oldSearch.value = "current";
  const oldList = sidebar.createDiv({ cls: "lmb-pdf-sidebar-list" });
  const oldRow = oldList.createDiv({ cls: "lmb-pdf-sidebar-item" }); oldRow.dataset = { page: "3", exId: "current" };
  sidebar.dataset.page = "3"; sidebar.scrollTop = 180;
  rendering.settings = {};
  rendering.app = { workspace: { getLeavesOfType: () => [renderingLeaf] }, vault: {} };
  rendering.lmbEnsurePdfSidebarEl = () => sidebar; rendering.lmbSetPdfSidebarVisible = () => {};
  rendering.lmbRefreshTextBlocks = async () => {}; rendering.saveSettings = async () => {};
  rendering._lmbCurrentPdfPage = () => 3;
  rendering._lmbGetPdfSidebarEntries = () => [
    { quick: true, exId: "first", page: 1, text: "first page", note: "first note" },
    { quick: true, exId: "current", page: 3, text: "current page", note: "current note" }
  ];
  const originalRender = context.MarkdownRenderer.render, releases = [];
  context.MarkdownRenderer.render = async (_app, text, el) => { await new Promise((resolve) => releases.push(resolve)); el.textContent = text; };
  const pendingSidebar = rendering.lmbRenderPdfSidebarForLeaf(renderingLeaf);
  assert.equal(sidebar.children[0], oldHead); assert.equal(oldCounter.textContent, "当前第 3 页 · 1 条");
  assert.equal(sidebar.querySelectorAll(".lmb-pdf-sidebar-item").length, 1, "page one must remain offscreen until filtered");
  const renderCount = releases.length;
  await rendering.lmbSetTextBlockCollapsed({ exId: "current" }, "async.pdf", true);
  assert(oldRow.cls.has("is-compact")); assert.equal(sidebar.children[0], oldHead);
  assert.equal(sidebar.scrollTop, 180); assert.equal(releases.length, renderCount, "collapse must not start a full rebuild");
  releases.forEach((resolve) => resolve()); await pendingSidebar;
  assert.equal(sidebar.querySelector(".lmb-pdf-sidebar-title-sub").textContent, "当前第 3 页 · 1 条");
  const renderedRows = sidebar.querySelectorAll(".lmb-pdf-sidebar-item");
  assert(renderedRows[0].cls.has("is-page-hidden")); assert(renderedRows[1].cls.has("is-compact"), "reconcile clicks made during asynchronous rendering");
  assert.equal(sidebar.querySelector(".lmb-pdf-sidebar-search").value, "current"); assert.equal(sidebar.scrollTop, 180);
  const stableHead = sidebar.children[0];
  await rendering.lmbSetTextBlockCollapsed({ exId: "current" }, "async.pdf", false);
  await rendering.lmbRenderPdfSidebarForLeaf(renderingLeaf);
  assert.equal(sidebar.children[0], stableHead); assert.equal(releases.length, renderCount);
  rendering.lmbHandlePdfSidebarScroll({ target: { nodeType: 1, closest: (selector) => selector === ".lmb-pdf-excerpt-sidebar" ? sidebar : null } });
  assert.equal(rendering._lmbPdfSidebarPageTimer, undefined, "sidebar scrolling must not drive PDF page-follow");
  rendering._lmbPdfSidebarFollow = false; rendering._lmbCurrentPdfPage = () => 1;
  rendering._lmbApplySidebarPageFilter(renderingLeaf);
  assert.equal(sidebar.dataset.page, "3", "unfollowed sidebar retains the selected page during refresh");
  context.MarkdownRenderer.render = originalRender;
  const pageNotes = new Plugin(), pageFile = { path: "page-notes.pdf", extension: "pdf", name: "page-notes.pdf" };
  const pageLeaf = { view: { file: pageFile } };
  pageNotes.settings = {}; pageNotes.excerptIndex = new Map(); pageNotes.getExcerptsForPdf = () => [];
  pageNotes.app = { workspace: { getLeavesOfType: () => [] } };
  let pageNoteSaves = 0;
  pageNotes.saveSettings = async () => { pageNoteSaves++; };
  pageNotes.lmbRefreshTextBlocks = async () => {}; pageNotes.lmbRenderPdfSidebarForLeaf = async () => {};
  const pageNote = await pageNotes.lmbCreatePageNote(pageLeaf, pageFile, 3, { x: .2, y: .4 }, "## 独立知识脉络\n| A | B |\n| - | - |\n| 1 | 2 |");
  assert.equal(pageNote.pageNote, true); assert.equal(pageNote.page, 3);
  assert.equal(pageNote.selection, undefined); assert.equal(pageNote.rect, undefined); assert.equal(pageNote.text, "");
  assert.equal(proto.lmbDrawEntryMark({}, pageNote), undefined, "page notes must not create excerpt fallback marks");
  assert.equal(pageNotes._lmbGetPdfSidebarEntries(pageFile)[0].exId, pageNote.exId);
  assert.equal(pageNotes.lmbTextBlockViews(pageFile.path)[pageNote.exId].page, 3);
  assert.equal(await pageNotes.lmbTextBlockNote({ ...pageNote, quick: true, pdfPath: pageFile.path }), pageNote.note);
  assert.equal(await pageNotes.lmbCreatePageNote(pageLeaf, pageFile, 3, { x: 0, y: 0 }, "  "), null); assert.equal(pageNoteSaves, 1);
  await assert.rejects(() => pageNotes.lmbCreatePageNote({ view: { file: {} } }, pageFile, 1, {}, "stale PDF"));
  pageNotes.saveSettings = async () => { throw new Error("disk full"); };
  await assert.rejects(() => pageNotes.lmbCreatePageNote(pageLeaf, pageFile, 3, {}, "must roll back"));
  assert.equal(pageNotes.settings.quickExcerpts[pageFile.path].length, 1);
  assert.equal(Object.keys(pageNotes.lmbTextBlockViews(pageFile.path)).length, 1);
  let saves = 0, refreshes = 0;
  const plugin = new Plugin();
  plugin.settings = { quickExcerpts: { "a.pdf": [{ exId: "ex-a", note: "**原备注**" }] } };
  plugin.saveSettings = async () => { saves++; };
  plugin.lmbRefreshTextBlocks = async () => { refreshes++; };
  plugin.lmbSchedulePdfSidebarRefresh = () => {};
  const entry = { quick: true, exId: "ex-a", pdfPath: "a.pdf", note: "过时的副本" };
  assert.equal(await plugin.lmbTextBlockNote(entry), "**原备注**");
  await plugin.lmbSaveTextBlockNote(entry, "## 同步\n新内容");
  assert.equal(await plugin.lmbTextBlockNote(entry), "## 同步\n新内容");
  assert.equal(entry.note, "过时的副本", "do not create a second content store");
  await assert.rejects(() => plugin.lmbSaveTextBlockNote({ ...entry, exId: "deleted" }, "x"));

  const source = { path: "notes.md" }; let sourceValue;
  plugin.app = { vault: { getAbstractFileByPath: () => source }, workspace: { getLeavesOfType: () => [] } };
  plugin.lmbSaveExcerptNote = async (file, id, value) => { assert.equal(file, source); assert.equal(id, "ex-full"); sourceValue = value; return true; };
  plugin.reindexFile = async (file) => assert.equal(file, source);
  await plugin.lmbSaveTextBlockNote({ exId: "ex-full", sourceMd: "notes.md" }, "公式 $x^2$");
  assert.equal(sourceValue, "公式 $x^2$");

  const view = { page: 1, x: .2, y: .3, w: .5, fontSize: 20 };
  plugin.lmbTextBlockViews("a.pdf")[entry.exId] = view;
  view.hidden = true;
  assert.equal(plugin.lmbIsTextBlockCollapsed(view), true, "previously hidden notes become compact entries");
  await plugin.lmbSetTextBlockCollapsed(entry, "a.pdf", true);
  assert.equal(plugin.lmbTextBlockViews("a.pdf")[entry.exId], view, "live controls retain their view reference");
  assert.equal(view.page, 1); assert.equal(view.collapsed, true); assert.equal(view.hidden, undefined); assert.equal(refreshes, 0, "collapse must not rerender Markdown or rebuild the sidebar");

  const serialized = vm.runInContext("new LmbSettingsStore({ _lmbSerializedRuntimeCaches: {} })", context).serialize(plugin.settings, {});
  const restored = JSON.parse(JSON.stringify(serialized));
  assert.equal(restored.pdfTextBlocks["a.pdf"]["ex-a"].fontSize, 20);
  assert.equal(restored.pdfTextBlocks["a.pdf"]["ex-a"].collapsed, true);
  assert.equal(restored.quickExcerpts["a.pdf"][0].note, "## 同步\n新内容");

  const page = new Element("page"); page.dataset.pageNumber = "1";
  const block = plugin.lmbCreateTextBlock(page, entry, view);
  plugin.lmbStyleTextBlock(block, page, view);
  assert.equal(block.style.fontSize, "20px"); assert.equal(block.style.width, "50%");
  assert.equal(block.style["--lmb-pdf-text-size"], "20px");
  const grow = block.querySelectorAll("button").find((b) => b.attributes && b.attributes["aria-label"] === "增大字号");
  const shrink = block.querySelectorAll("button").find((b) => b.attributes && b.attributes["aria-label"] === "减小字号");
  await grow.onclick({ stopPropagation() {} }); assert.equal(view.fontSize, 21);
  await shrink.onclick({ stopPropagation() {} }); assert.equal(view.fontSize, 20);
  view.fontSize = 72; await grow.onclick({ stopPropagation() {} }); assert.equal(view.fontSize, 72);
  view.fontSize = 8; await shrink.onclick({ stopPropagation() {} }); assert.equal(view.fontSize, 8);
  view.fontSize = 20;
  page.rect.width = 500; plugin.lmbStyleTextBlock(block, page, view);
  assert.equal(block.style.fontSize, "10px"); assert.equal(block.style.left, "20%");
  page.rect.width = 1000;
  const resize = block.querySelector(".lmb-pdf-text-resize");
  const pointer = (target, x, y) => ({ button: 0, currentTarget: target, pointerId: 1, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
  resize.onpointerdown(pointer(resize, 0, 0));
  await resize.emit("pointermove", pointer(resize, 900, 0));
  assert.equal(view.w, .8, "width stays within page"); assert.equal(view.fontSize, 20, "resizing reflows without changing type");
  await resize.emit("pointercancel", {}); assert.equal(view.w, .5, "cancel restores geometry");
  const grip = block.querySelector("button");
  grip.onpointerdown(pointer(grip, 0, 0)); await grip.emit("pointermove", pointer(grip, -900, -900));
  assert.equal(view.x, 0); assert.equal(view.y, 0); await grip.emit("pointerup", {});
  assert(saves >= 4);

  const row = new Element(); row.dataset = { page: "1", sidebarHidden: "true" };
  const sub = new Element();
  const bar = { dataset: {}, querySelectorAll: () => [row], querySelector: () => sub };
  const leaf = { containerEl: { querySelector: () => bar } };
  plugin._lmbPdfSidebarView = "all";
  plugin._lmbCurrentPdfPage = () => 1;
  plugin._lmbApplySidebarPageFilter(leaf); assert(!row.cls.has("is-page-hidden"), "even legacy hidden rows stay visible");
  plugin._lmbPdfSidebarView = "current";
  row.dataset.page = "2";
  plugin._lmbApplySidebarPageFilter(leaf); assert(row.cls.has("is-page-hidden"), "current-page filtering still applies");
  row.dataset.page = "1";
  plugin._lmbApplySidebarPageFilter(leaf); assert(!row.cls.has("is-page-hidden"));

  // A placement is committed only after an explicit click in the chosen PDF.
  const doc = new Element(), root = new Element(); root.ownerDocument = doc; root.contains = (node) => node === page;
  page.closest = (selector) => selector.startsWith(".page") ? page : null;
  await plugin.lmbStartTextBlockPlacement(entry, { containerEl: root, view: { file: { path: "a.pdf" } } });
  await doc.emit("pointerdown", { target: page, button: 0, clientX: 250, clientY: 700, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(view.x, .25); assert.equal(view.y, .5); assert.equal(view.collapsed, true);
  assert.equal(plugin._lmbCancelTextPlacement, null);

  // Saved text on otherwise blank pages must scale without creating an ink canvas.
  let resizeObserver;
  context.ResizeObserver = class {
    constructor(callback) { this.callback = callback; resizeObserver = this; }
    observe() {} disconnect() { this.disconnected = true; }
  };
  plugin.excerptIndex = new Map(); plugin.getExcerptsForPdf = () => [];
  plugin.app.vault.getAbstractFileByPath = () => ({ path: "a.pdf", name: "a.pdf" });
  await plugin.lmbRenderTextBlocksOnPage(page, "a.pdf");
  assert.equal(block.querySelector(".lmb-pdf-text-body").children[0].textContent, "## 同步\n新内容");
  assert(resizeObserver, "text-only pages have an independent zoom observer");
  page.rect.width = 500; resizeObserver.callback(); await new Promise(setImmediate);
  assert.equal(block.style.fontSize, "10px");

  // Removing a placement leaves the same note available in the sidebar.
  await block.querySelectorAll("button").find((b) => b.textContent === "移除").onclick({ stopPropagation() {} });
  assert.equal(view.page, undefined);
  assert.equal(await plugin.lmbTextBlockNote(entry), "## 同步\n新内容");
  await plugin.lmbRenderTextBlocksOnPage(page, "a.pdf");
  assert.equal(resizeObserver.disconnected, true);
  await plugin.lmbSetTextBlockCollapsed(entry, "a.pdf", false);
  assert.equal(plugin.lmbIsTextBlockCollapsed(view), false);
  assert.equal(await plugin.lmbTextBlockNote(entry), "## 同步\n新内容", "expanding preserves content");

  let latestModal;
  context.Modal = class { open() { latestModal = this; } }; context.FuzzySuggestModal = class {};
  vm.runInContext(fs.readFileSync("src/ui/modals.js", "utf8"), context);
  const newDoc = new Element(), newRoot = new Element(), newPage = new Element();
  newRoot.ownerDocument = newDoc; newRoot.contains = (el) => el === newPage;
  newPage.dataset.pageNumber = "3"; newPage.closest = (selector) => selector.startsWith(".page") ? newPage : null;
  pageLeaf.containerEl = newRoot;
  pageNotes.lmbStartPageNote(pageLeaf);
  await newDoc.emit("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(pageNotes._lmbCancelTextPlacement, null); assert.equal(latestModal, undefined);
  assert.equal(pageNotes.settings.quickExcerpts[pageFile.path].length, 1, "cancelling placement must not create a draft");
  pageNotes.lmbStartPageNote(pageLeaf);
  await newDoc.emit("pointerdown", { target: newPage, button: 0, clientX: 100, clientY: 280, preventDefault() {}, stopImmediatePropagation() {} });
  assert(latestModal.opts.title.includes("P.3"));
  assert.equal(pageNotes.settings.quickExcerpts[pageFile.path].length, 1, "opening/cancelling the editor must not create a draft");
  pageNotes.saveSettings = async () => {};
  await latestModal.opts.onSubmit("独立页注，不依赖选区");
  assert.equal(pageNotes.settings.quickExcerpts[pageFile.path].length, 2);
  const modal = vm.runInContext("new LMBExcerptNoteModal({}, {})", context);
  let closed = false;
  modal.ta = { value: "必须保留的草稿" }; modal.close = () => { closed = true; };
  modal.opts.onSubmit = async () => { throw new Error("disk full"); };
  await modal.submit(); assert.equal(closed, false); assert.equal(modal.ta.value, "必须保留的草稿");
  console.log("Markdown text block persistence, shared editing, zoom, gestures, visibility and placement passed");
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
