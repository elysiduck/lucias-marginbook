"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
class Element {
  constructor(cls = "", tag = "div") {
    this.cls = new Set(cls.split(" ")); this.tag = tag; this.children = []; this.childNodes = this.children;
    this.dataset = {}; this.style = {}; this.events = {}; this.isConnected = true;
    this.classList = { add: (x) => this.cls.add(x), remove: (x) => this.cls.delete(x), toggle: (x, on) => {
      const value = on === undefined ? !this.cls.has(x) : on; value ? this.cls.add(x) : this.cls.delete(x); return value;
    } };
    this.ownerDocument = { createElement: (tag) => new Element("", tag) };
    this.rect = { left: 0, top: 0, width: 1000, height: 1400 };
  }
  createDiv(opts) { return this.createEl("div", opts); }
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
  getBoundingClientRect() { return this.rect; }
  addEventListener(type, fn) { (this.events[type] || (this.events[type] = new Set())).add(fn); }
  removeEventListener(type, fn) { if (this.events[type]) this.events[type].delete(fn); }
  async emit(type, value) { for (const fn of Array.from(this.events[type] || [])) await fn(value); }
  setPointerCapture() {}
  addClass(cls) { this.cls.add(cls); }
  toggleClass(cls, value) { this.classList.toggle(cls, value); }
  setText(text) { this.textContent = text; }
  empty() { this.children.length = 0; }
  replaceChildren(el) { this.empty(); this.children.push(el); }
  remove() { this.isConnected = false; if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
}
class Plugin {}
const context = vm.createContext({ LuciasMarginBookPlugin: Plugin, Notice: class { hide() {} },
  MarkdownRenderer: { render: async (_app, text, el) => { el.textContent = text; } }, console, setTimeout, clearTimeout });
for (const file of ["src/pdf/sidebar-controller.js", "src/pdf/text-block-controller.js", "src/core/settings-store.js"])
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
const proto = Plugin.prototype;
async function main() {
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
  await plugin.lmbSetTextBlockHidden(entry, "a.pdf", true);
  assert.equal(plugin.lmbTextBlockViews("a.pdf")[entry.exId], view, "live controls retain their view reference");
  assert.equal(view.page, 1); assert.equal(view.hidden, true); assert.equal(refreshes, 1);

  const serialized = vm.runInContext("new LmbSettingsStore({ _lmbSerializedRuntimeCaches: {} })", context).serialize(plugin.settings, {});
  const restored = JSON.parse(JSON.stringify(serialized));
  assert.equal(restored.pdfTextBlocks["a.pdf"]["ex-a"].fontSize, 20);
  assert.equal(restored.pdfTextBlocks["a.pdf"]["ex-a"].hidden, true);
  assert.equal(restored.quickExcerpts["a.pdf"][0].note, "## 同步\n新内容");

  const page = new Element("page"); page.dataset.pageNumber = "1";
  const block = plugin.lmbCreateTextBlock(page, entry, view);
  plugin.lmbStyleTextBlock(block, page, view);
  assert.equal(block.style.fontSize, "20px"); assert.equal(block.style.width, "50%");
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
  plugin._lmbApplySidebarPageFilter(leaf); assert(row.cls.has("is-page-hidden"));
  leaf._lmbShowHiddenTextBlocks = true;
  plugin._lmbApplySidebarPageFilter(leaf); assert(!row.cls.has("is-page-hidden"));

  // A placement is committed only after an explicit click in the chosen PDF.
  const doc = new Element(), root = new Element(); root.ownerDocument = doc; root.contains = (node) => node === page;
  page.closest = (selector) => selector.startsWith(".page") ? page : null;
  await plugin.lmbStartTextBlockPlacement(entry, { containerEl: root, view: { file: { path: "a.pdf" } } });
  await doc.emit("pointerdown", { target: page, button: 0, clientX: 250, clientY: 700, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(view.x, .25); assert.equal(view.y, .5); assert.equal(view.hidden, true);
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

  context.Modal = class {}; context.FuzzySuggestModal = class {};
  vm.runInContext(fs.readFileSync("src/ui/modals.js", "utf8"), context);
  const modal = vm.runInContext("new LMBExcerptNoteModal({}, {})", context);
  let closed = false;
  modal.ta = { value: "必须保留的草稿" }; modal.close = () => { closed = true; };
  modal.opts.onSubmit = async () => { throw new Error("disk full"); };
  await modal.submit(); assert.equal(closed, false); assert.equal(modal.ta.value, "必须保留的草稿");
  console.log("Markdown text block persistence, shared editing, zoom, gestures, visibility and placement passed");
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
