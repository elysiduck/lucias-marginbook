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
  get parentElement() { return this.parent || null; }
  insertBefore(el, reference) { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); this.children.splice(this.children.indexOf(reference), 0, el); el.parent = this; }
  appendChild(el) { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); this.children.push(el); el.parent = this; el.isConnected = true; return el; }
  getBoundingClientRect() { return { ...this.rect, bottom: this.rect.top + this.rect.height, right: this.rect.left + this.rect.width }; }
  contains(el) { return !!el && (el === this || this.children.some((child) => child.contains(el))); }
  setAttribute(name, value) { (this.attributes || (this.attributes = {}))[name] = value; }
  getAttribute(name) { return this.attributes && this.attributes[name]; }
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
const context = vm.createContext({ LuciasMarginBookPlugin: Plugin, Modal: class {}, Notice: class { hide() {} },
  MarkdownRenderer: { render: async (_app, text, el) => { el.textContent = text; } }, console, setTimeout, clearTimeout });
for (const file of ["src/pdf/pure-ink.js", "src/pdf/pure-ink-links.js", "src/pdf/ink-links-controller.js", "src/pdf/pure-live-markdown.js", "src/pdf/sidebar-controller.js", "src/pdf/text-block-controller.js", "src/pdf/live-editor-controller.js", "src/pdf/sidebar-note-editor.js", "src/pdf/mark-service.js", "src/core/settings-store.js"])
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
const proto = Plugin.prototype;
async function main() {
  const structured = "## 标题\n无空行的段落 **加粗**。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nfirst\n\nsecond\n```\n\n$$\nx + y\n\n= z\n$$\n\n- one\n  continuation\n\n- two\n\n> quote\n>\n> next\n\n";
  const split = context.lmbLiveMarkdownBlocks(structured);
  assert.deepEqual(Array.from(split, part => part.kind), ["heading", "paragraph", "table", "code", "math", "list", "quote", "paragraph"]);
  for (const part of split) assert.equal(structured.slice(part.start, part.end), part.source);
  assert(split[3].source.includes("first\n\nsecond")); assert(split[4].source.includes("x + y\n\n= z"));
  assert.equal(context.lmbLiveCaretOffset("## **标题** 后文", "标题", 1, 0), 6);
  assert.equal(context.lmbLiveMarkdownBlocks("")[0].source, "");
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
  const normalSave = plugin.saveSettings;
  plugin.saveSettings = async () => { throw new Error("disk full"); };
  await assert.rejects(() => plugin.lmbSaveTextBlockNote(entry, "不能留在内容源里的失败草稿"));
  assert.equal(await plugin.lmbTextBlockNote(entry), "## 同步\n新内容");
  plugin.saveSettings = normalSave;
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
  assert.equal(newPage.querySelector(".lmb-pdf-text-block"), null, "pointerdown must not create an editor before the placement click finishes");
  await newDoc.emit("pointerup", { target: newPage, button: 0 });
  await newDoc.emit("click", { target: newPage, button: 0, clientX: 100, clientY: 280, preventDefault() {}, stopImmediatePropagation() {} });
  const draftBlock = newPage.querySelector(".lmb-pdf-text-block");
  assert(draftBlock._lmbInlineEditor); assert.equal(latestModal, undefined, "page-note creation must not open a modal");
  assert.equal(pageNotes.settings.quickExcerpts[pageFile.path].length, 1, "opening/cancelling the editor must not create a draft");
  pageNotes.saveSettings = async () => {};
  draftBlock._lmbInlineEditor.input.value = "独立页注，不依赖选区";
  await draftBlock._lmbInlineEditor.save();
  assert.equal(pageNotes.settings.quickExcerpts[pageFile.path].length, 2);
  assert.equal(newPage.querySelector(".lmb-pdf-text-block"), null, "successful creation closes the temporary draft");
  const waitingBar = newRoot.createDiv({ cls: "lmb-pdf-excerpt-sidebar" });
  let releasePlacement, flushes = 0;
  waitingBar._lmbSidebarEditor = { save: () => { flushes++; return new Promise(resolve => { releasePlacement = resolve; }); } };
  const placementClick = { target: newPage, button: 0, clientX: 100, clientY: 280, preventDefault() {}, stopImmediatePropagation() {} };
  pageNotes.lmbStartPageNote(pageLeaf);
  const cancelledPlacement = newDoc.emit("click", placementClick);
  await newDoc.emit("keydown", { key: "Escape", preventDefault() {} });
  releasePlacement(true); await cancelledPlacement;
  assert.equal(newPage.querySelector(".lmb-pdf-text-block"), null, "Escape during pending save must cancel delayed creation");
  pageNotes.lmbStartPageNote(pageLeaf); const firstPlacement = newDoc.emit("click", placementClick);
  await newDoc.emit("click", placementClick);
  assert.equal(flushes, 2, "a second click during the same pending placement must not queue another editor");
  releasePlacement(true); await firstPlacement;
  assert.equal(newPage.querySelectorAll(".lmb-pdf-text-block").length, 1);
  newPage.querySelector(".lmb-pdf-text-block")._lmbInlineEditor.cancel(); waitingBar.remove();

  const editingPage = new Element(), editingView = { page: 1, x: 0, y: 0, w: .5, fontSize: 16 };
  editingPage.dataset.pageNumber = "1";
  plugin.lmbTextBlockViews("a.pdf")[entry.exId] = editingView;
  const editingBlock = plugin.lmbCreateTextBlock(editingPage, entry, editingView);
  let inlineSaved = "", inlineClosed;
  const editor = plugin.lmbOpenInlineNoteEditor(editingBlock, { value: "原文", onSubmit: async (text) => { inlineSaved = text; }, onClose: (saved) => { inlineClosed = saved; } });
  editingView.y = .94; plugin.lmbStyleTextBlock(editingBlock, editingPage, editingView);
  assert.equal(editingBlock.style.top, "94%", "entering edit must keep the saved page anchor near the bottom");
  assert(Math.abs(parseFloat(editingBlock.querySelector(".lmb-pdf-text-body").style.maxHeight) - (1400 * .06 - 8)) < .001);
  editingView.y = 0;
  editor.input.value = "## 实时预览"; await editor.render();
  assert.equal(editor.getText(), "## 实时预览"); assert.equal(editingBlock.querySelectorAll("textarea").length, 1); assert.equal(inlineSaved, "");
  await editor.save(); assert.equal(inlineSaved, "## 实时预览"); assert.equal(inlineClosed, true); assert.equal(editingBlock._lmbInlineEditor, undefined);
  const failingEditor = plugin.lmbOpenInlineNoteEditor(editingBlock, { value: "草稿", onSubmit: async () => { throw new Error("disk full"); }, onClose: (saved) => { inlineClosed = saved; } });
  await failingEditor.save(); assert.equal(editingBlock._lmbInlineEditor, failingEditor); assert.equal(failingEditor.input.value, "草稿");
  await failingEditor.render(); await plugin.lmbRenderTextBlocksOnPage(editingPage, "a.pdf");
  assert.equal(editingBlock._lmbInlineEditor.input.value, "草稿", "background refresh must not overwrite an unsaved paragraph");
  editingBlock.remove();
  const recycledPage = new Element(); recycledPage.dataset.pageNumber = "1";
  await plugin.lmbRenderTextBlocksOnPage(recycledPage, "a.pdf");
  assert.equal(recycledPage.querySelector(".lmb-pdf-text-block"), editingBlock); assert.equal(editingBlock._lmbInlineEditor.input.value, "草稿");
  failingEditor.cancel(); assert.equal(inlineClosed, false); assert.equal(editingBlock._lmbInlineEditor, undefined);
  const rendererBeforeRace = context.MarkdownRenderer.render, pendingPreviews = [];
  context.MarkdownRenderer.render = async (_app, text, el) => { await new Promise(resolve => pendingPreviews.push({ text, el, resolve })); el.textContent = text; };
  const raceEditor = plugin.lmbOpenInlineNoteEditor(editingBlock, { value: "active\n\nold inactive", onSubmit: async () => {} });
  raceEditor.input.value = "new active"; await raceEditor.render();
  const oldActivation = raceEditor.activate(1);
  raceEditor.input.value = "latest paragraph"; await raceEditor.render();
  const latestActivation = raceEditor.activate(0);
  pendingPreviews[2].resolve(); await latestActivation;
  pendingPreviews[1].resolve(); pendingPreviews[0].resolve(); await oldActivation;
  assert.equal(editingBlock.querySelector(".lmb-pdf-text-body").textContent, "latest paragraph");
  assert.equal(raceEditor.getText(), "new active\n\nlatest paragraph");
  raceEditor.cancel(); context.MarkdownRenderer.render = rendererBeforeRace;
  const multiSource = "## 标题\n\n第一段 **加粗**。\n\n第二段。";
  const live = plugin.lmbOpenInlineNoteEditor(editingBlock, { value: multiSource, onSubmit: async () => {} });
  await live.activate(1, 3);
  assert.equal(live.input.value, "第一段 **加粗**。");
  assert.equal(editingBlock.querySelectorAll("textarea").length, 1);
  assert(editingBlock.querySelector(".lmb-pdf-text-body").textContent.includes("第二段。"));
  assert(!editingBlock.querySelector(".lmb-pdf-text-body").textContent.includes("第一段"), "active text is never duplicated in a preview");
  live.input.value = "第一段已修改。"; await live.render();
  assert.equal(live.getText(), "## 标题\n\n第一段已修改。\n\n第二段。");
  live.undo(); assert.equal(live.getText(), multiSource);
  live.undo(true); assert(live.getText().includes("第一段已修改。"));
  await live.activate(1);
  await live.input.emit("compositionstart", {}); live.input.value = "中文输入中";
  await live.input.emit("input", { isComposing: true }); await live.save(); assert.equal(live.closed, false);
  await live.input.emit("compositionend", {}); assert(live.getText().includes("中文输入中"));
  live.input.value = "粘贴首段\n\n## 粘贴标题\n\n粘贴末段"; live.input.setSelectionRange(live.input.value.length, live.input.value.length); await live.render();
  assert.equal(live.input.value, "粘贴末段"); assert(live.getText().includes("## 粘贴标题"));
  live.cancel();
  const between = plugin.lmbOpenInlineNoteEditor(editingBlock, { value: "前段\n\n后段", onSubmit: async () => {} });
  between.input.value = "前段\n\n"; between.input.setSelectionRange(4, 4); await between.render();
  assert.equal(between.input.value, "", "Enter between paragraphs keeps an editable blank at the caret");
  between.input.value = "新段"; between.input.setSelectionRange(2, 2); await between.render();
  assert.equal(between.getText(), "前段\n\n新段\n\n后段");
  between.cancel();
  // Sidebar edits share the source and paragraph engine without opening a modal
  // or letting asynchronous full-sidebar refreshes replace a live draft.
  const side = new Plugin(), sideRoot = new Element(), sideBar = sideRoot.createDiv({ cls: "lmb-pdf-excerpt-sidebar" });
  const sideFile = { path: "sidebar.pdf", extension: "pdf" }, sideLeaf = { view: { file: sideFile }, containerEl: sideRoot };
  const sideItem = { exId: "quick-side", page: 2, text: "Excerpt", note: "## Heading\n\nOriginal paragraph." };
  side.settings = { quickExcerpts: { "sidebar.pdf": [sideItem] }, pdfTextBlocks: {} };
  side.app = { workspace: { getLeavesOfType: () => [sideLeaf] }, vault: {} };
  side.lmbEnsurePdfSidebarEl = () => sideBar; side.lmbSetPdfSidebarVisible = () => {};
  let sidebarRefreshes = 0; side.lmbRenderPdfSidebarForLeaf = async () => { sidebarRefreshes++; };
  side.lmbRefreshTextBlocks = async () => {}; side.saveSettings = async () => {};
  const sideRow = sideBar.createDiv({ cls: "lmb-pdf-sidebar-item" }); sideRow.dataset = { exId: sideItem.exId, page: "2", ordinal: "1" };
  sideRow.createDiv({ cls: "lmb-pdf-sidebar-item-actions" });
  const entrySide = { ...sideItem, pdfPath: sideFile.path, quick: true };
  await side.lmbOpenSidebarNoteEditor(entrySide, sideLeaf, sideRow);
  const sideEditor = sideBar._lmbSidebarEditor;
  assert(sideEditor && sideRow.contains(sideEditor.input));
  assert.equal((side._lmbActiveInlineBlocks || new Set()).size, 0, "sidebar hosts are not PDF page overlays");
  await sideEditor.activate(1); sideEditor.input.value = "Draft **bold**."; await sideEditor.render();
  assert.equal(await side.lmbTextBlockNote(entrySide), "## Heading\n\nDraft **bold**.");
  assert.equal(sideItem.note, "## Heading\n\nOriginal paragraph.", "typing previews but does not persist");
  await proto.lmbRenderPdfSidebarForLeaf.call(side, sideLeaf);
  assert.equal(sideBar._lmbSidebarEditor, sideEditor); assert(sideRow.contains(sideEditor.input));
  side.saveSettings = async () => { throw new Error("disk full"); };
  await sideEditor.save(); assert.equal(sideEditor.closed, false); assert.equal(sideBar._lmbSidebarEditor, sideEditor);
  assert.equal(sideItem.note, "## Heading\n\nOriginal paragraph.");
  await side.lmbOpenSidebarNoteEditor({ ...entrySide, exId: "other" }, sideLeaf, sideRow);
  assert.equal(sideBar._lmbSidebarEditor, sideEditor, "opening another note never discards a draft");
  side.saveSettings = async () => {}; await sideEditor.save();
  assert.equal(sideItem.note, "## Heading\n\nDraft **bold**."); assert.equal(side._lmbSidebarNoteDrafts.size, 0);
  // Debounced persistence stays open; cancelling later retains that baseline.
  await side.lmbOpenSidebarNoteEditor(entrySide, sideLeaf, sideRow);
  const auto = sideBar._lmbSidebarEditor;
  auto.input.value = "Autosaved heading"; await auto.render();
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(sideItem.note, "Autosaved heading\n\nDraft **bold**."); assert.equal(auto.closed, false);
  auto.input.value = "Not committed"; await auto.render(); auto.cancel();
  assert.equal(sideItem.note, "Autosaved heading\n\nDraft **bold**.");
  const secondItem = { exId: "quick-second", page: 2, note: "Second" };
  side.settings.quickExcerpts[sideFile.path].push(secondItem);
  const secondEntry = { ...secondItem, pdfPath: sideFile.path, quick: true };
  const secondRow = sideBar.createDiv({ cls: "lmb-pdf-sidebar-item" }); secondRow.dataset = { exId: secondItem.exId, page: "2" };
  secondRow.createDiv({ cls: "lmb-pdf-sidebar-item-actions" });
  await side.lmbOpenSidebarNoteEditor(entrySide, sideLeaf, sideRow);
  const switchingEditor = sideBar._lmbSidebarEditor;
  switchingEditor.input.value = "Saved on switch"; await switchingEditor.render();
  assert.equal(await side.lmbOpenSidebarNoteEditor(secondEntry, sideLeaf, secondRow), true);
  assert(switchingEditor.closed); assert.equal(sideItem.note, "Saved on switch\n\nDraft **bold**.");
  const draining = sideBar._lmbSidebarEditor;
  let releaseWrite, writeCount = 0;
  side.saveSettings = async () => { if (++writeCount === 1) await new Promise(resolve => { releaseWrite = resolve; }); };
  draining.input.value = "First snapshot"; await draining.render();
  const writing = draining.persist();
  draining.input.value = "Newest snapshot"; await draining.render();
  const switching = side.lmbOpenSidebarNoteEditor(entrySide, sideLeaf, sideRow);
  releaseWrite(); await writing; await switching;
  assert.equal(secondItem.note, "Newest snapshot"); assert.equal(writeCount, 2, "new input during write drains in order");
  assert.equal(sideBar._lmbSidebarEditingId, sideItem.exId);
  sideBar._lmbSidebarEditor.cancel();
  assert.equal(sideBar._lmbSidebarEditor, undefined); assert(sidebarRefreshes > 0);
  await side.lmbOpenSidebarNoteEditor(entrySide, sideLeaf, sideRow);
  const cancelSide = sideBar._lmbSidebarEditor; cancelSide.input.value = "Do not save"; await cancelSide.render(); cancelSide.cancel();
  assert.equal(sideItem.note, "Saved on switch\n\nDraft **bold**."); assert.equal(side._lmbSidebarNoteDrafts.size, 0);
  const selectedBlock = sideRoot.createDiv({ cls: "lmb-pdf-text-block" }); selectedBlock.dataset.exId = sideItem.exId;
  const otherBlock = sideRoot.createDiv({ cls: "lmb-pdf-text-block" }); otherBlock.dataset.exId = "other";
  side.lmbSelectPdfSidebarEntry(sideLeaf, entrySide);
  assert(selectedBlock.classList.contains("lmb-note-selected")); assert(!otherBlock.classList.contains("lmb-note-selected"));
  assert.equal(selectedBlock.dataset.lmbBadge, "P.2 · 1");
  side._lmbHighlightPdfSidebarTarget(sideItem.exId, false, sideLeaf);
  assert(selectedBlock.classList.contains("lmb-note-selected"), "pointer leave cannot clear persistent association");
  const isolatedRoot = new Element(), isolatedBlock = isolatedRoot.createDiv({ cls: "lmb-pdf-text-block" }); isolatedBlock.dataset.exId = sideItem.exId;
  const isolatedLeaf = { containerEl: isolatedRoot, view: { file: { path: "other.pdf" } } };
  side.lmbSyncPdfNoteSelection(isolatedLeaf); assert(!isolatedBlock.classList.contains("lmb-note-selected"));
  const modal = vm.runInContext("new LMBExcerptNoteModal({}, {})", context);
  let closed = false;
  modal.ta = { value: "必须保留的草稿" }; modal.close = () => { closed = true; };
  modal.opts.onSubmit = async () => { throw new Error("disk full"); };
  await modal.submit(); assert.equal(closed, false); assert.equal(modal.ta.value, "必须保留的草稿");
  console.log("Markdown text block persistence, shared editing, zoom, gestures, visibility and placement passed");
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
