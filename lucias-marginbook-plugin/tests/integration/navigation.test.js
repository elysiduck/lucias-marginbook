"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class TFile { constructor(filePath) { this.path = filePath; } }
class Notice { constructor(message) { Notice.messages.push(message); } }
Notice.messages = [];
class Plugin {}
for (const source of ["pdf/navigation-service.js", "excerpt/index-service.js", "pdf/sidebar-controller.js"])
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../src/", source), "utf8"), {
  LuciasMarginBookPlugin: Plugin, TFile, Notice, console,
  setTimeout: (fn) => { queueMicrotask(fn); return 1; }
});

function fixture({ opened = false, mode = "source", cache = true, deferred = false } = {}) {
  const file = new TFile("book-excerpts.md"), other = new TFile("currently-reading.md");
  const calls = { opens: [], cursors: [], scrolls: [], previews: [], reveals: [], newTabs: 0, synced: 0 };
  const view = {
    file, getMode: () => mode,
    syncScroll: () => { calls.synced++; },
    editor: {
      setCursor: (pos) => calls.cursors.push(pos),
      lineCount: () => 11,
      scrollIntoView: (range) => {
        assert(range.to.line < 11, "scroll range must stay inside the document");
        calls.scrolls.push(range);
      }
    },
    previewMode: { renderer: { applyScroll: (line) => { calls.previews.push(line); return true; } } }
  };
  function leaf(id, current) {
    return {
      id, view: current, containerEl: { getBoundingClientRect: () => ({ left: id === "pdf" ? 0 : 800, right: 1000 }) },
      getViewState: () => ({ type: "markdown", state: { file: id === "target" ? file.path : current.file?.path } }),
      openFile: async function (next, options) {
        calls.opens.push({ leaf: this, file: next, options });
        this.view = view;
        this.view.file = next;
      }
    };
  }
  const victim = leaf("victim", { file: other }), pdf = leaf("pdf", { file: new TFile("book.pdf") });
  const target = leaf("target", deferred ? {} : view);
  const leaves = [victim, pdf];
  if (opened) leaves.push(target);
  const listeners = new Set();
  const workspace = {
    on: (_, callback) => { listeners.add(callback); return callback; },
    offref: callback => listeners.delete(callback),
    activeLeaf: victim,
    getLeavesOfType: () => leaves.filter((entry) => entry !== pdf),
    iterateAllLeaves: (fn) => leaves.forEach(fn),
    getLeaf: (kind) => {
      assert.equal(kind, "tab"); calls.newTabs++;
      const created = leaf("new", {}); leaves.push(created); return created;
    },
    setActiveLeaf: (entry) => { workspace.activeLeaf = entry; for (const fn of listeners) fn(entry); },
    revealLeaf: async (entry) => {
      calls.reveals.push(entry);
      if (entry === target && deferred) entry.view = view;
      workspace.activeLeaf = entry;
    }
  };
  const plugin = Object.assign(Object.create(Plugin.prototype), { app: {
    workspace,
    vault: { getAbstractFileByPath: () => file, cachedRead: async () => "intro\n\nparagraph\n\n\n\n\n\n\n\nlast paragraph ^ex-target" },
    metadataCache: { getFileCache: () => cache ? { blocks: { "ex-target": { position: { start: { line: 5 } } } } } : null }
  } });
  return { plugin, file, other, calls, view, target, victim, pdf, workspace };
}

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

test("unopened excerpt gets a new tab and preserves the current document", async () => {
  const f = fixture();
  assert.equal(await f.plugin.lmbOpenExcerptInMd("ex-target", f.file.path, f.pdf), true);
  assert.equal(f.victim.view.file, f.other);
  assert.equal(f.calls.newTabs, 1);
  assert.equal(f.calls.opens.length, 1);
  assert.equal(f.calls.opens[0].options.eState, undefined);
});

test("existing source tab is reused and its end-of-file scroll range is valid", async () => {
  const f = fixture({ opened: true });
  f.plugin.app.metadataCache.getFileCache = () => ({ blocks: { "ex-target": { position: { start: { line: 10 } } } } });
  assert.equal(await f.plugin.lmbOpenExcerptInMd("ex-target", f.file.path, f.pdf), true);
  assert.equal(f.calls.newTabs, 0);
  assert.equal(f.calls.opens.length, 0);
  assert.equal(f.calls.synced, 1, "the stored viewport must match the visible editor");
  assert.equal(f.calls.cursors[0].line, 10);
});

test("reading mode scrolls the visible preview even though an editor exists", async () => {
  const f = fixture({ opened: true, mode: "preview" });
  assert.equal(await f.plugin.lmbOpenExcerptInMd("ex-target", f.file.path, f.pdf), true);
  assert.equal(f.calls.cursors.length, 0);
  assert.deepEqual(f.calls.previews, [5]);
  assert.equal(f.calls.synced, 1, "the stored viewport must match the visible preview");
  assert.equal(f.view.getMode(), "preview");
  assert.equal(f.calls.opens.length, 0);
});

test("missing metadata uses the literal block marker without reopening the file", async () => {
  const f = fixture({ opened: true, cache: false });
  assert.equal(await f.plugin.lmbOpenExcerptInMd("ex-target", f.file.path, f.pdf), true);
  assert.equal(f.calls.cursors[0].line, 10);
  assert.equal(f.calls.opens.length, 0);
});

test("missing block reports failure instead of claiming a successful jump", async () => {
  const f = fixture({ opened: true, cache: false });
  assert.equal(await f.plugin.lmbOpenExcerptInMd("ex-missing", f.file.path, f.pdf), false);
  assert.equal(f.calls.cursors.length, 0);
  assert.equal(f.calls.opens.length, 0);
  assert(Notice.messages.some((message) => message.includes("ex-missing")));
});

test("deferred target tab is recognized from view state and revealed before use", async () => {
  const f = fixture({ opened: true, deferred: true });
  assert.equal(await f.plugin.lmbOpenExcerptInMd("ex-target", f.file.path, f.pdf), true);
  assert.equal(f.calls.newTabs, 0);
  assert.equal(f.calls.opens.length, 0);
  assert.equal(f.calls.reveals[0], f.target);
});

test("concurrent reverse jumps open only one target tab", async () => {
  const f = fixture();
  const result = await Promise.all([
    f.plugin.lmbOpenExcerptInMd("ex-target", f.file.path, f.pdf),
    f.plugin.lmbOpenExcerptInMd("ex-target", f.file.path, f.pdf)
  ]);
  assert.deepEqual(result, [false, true], "only the latest request should position the document");
  assert.equal(f.calls.newTabs, 1);
  assert.equal(f.calls.opens.length, 1);
});

test("preview rendering is allowed to become ready before positioning", async () => {
  const f = fixture({ opened: true, mode: "preview" });
  let attempts = 0;
  f.view.previewMode.renderer.applyScroll = () => ++attempts >= 3;
  assert.equal(await f.plugin.lmbOpenExcerptInMd("ex-target", f.file.path, f.pdf), true);
  assert.equal(attempts, 3);
  assert.equal(f.calls.cursors.length, 0);
});

test("a document switched during rendering is never scrolled by a stale jump", async () => {
  const f = fixture({ opened: true, mode: "preview" });
  f.view.previewMode.renderer.applyScroll = () => { f.target.view = { file: f.other }; return false; };
  assert.equal(await f.plugin.lmbOpenExcerptInMd("ex-target", f.file.path, f.pdf), false);
  assert.equal(f.calls.cursors.length, 0);
});

test("queued Markdown navigation cannot steal focus after switching tabs", async () => {
  const f = fixture({opened:true}); let release;
  f.plugin._lmbPositionMdExcerpt = () => new Promise(r=>{release=r;});
  const first=f.plugin.lmbOpenExcerptInMd("ex-target",f.file.path);
  while (!release) await Promise.resolve();
  const second=f.plugin.lmbOpenExcerptInMd("ex-target",f.file.path);
  f.workspace.setActiveLeaf(f.victim); release(false);
  assert.deepEqual(await Promise.all([first,second]),[false,false]);
  assert.equal(f.workspace.activeLeaf,f.victim);
});

test("switching away and back permanently cancels a delayed PDF jump", async () => {
  const f=fixture(); let release,scrolls=0;
  f.pdf.view.containerEl={}; f.pdf.view.file=f.file;
  f.workspace.getLeavesOfType=()=>[f.pdf];
  f.plugin.lmbWaitPageEl=()=>new Promise(r=>release=r);
  const pending=f.plugin.lmbJumpToSelection(f.file.path,1);
  while(!release) await Promise.resolve();
  f.workspace.setActiveLeaf(f.victim); f.workspace.setActiveLeaf(f.pdf);
  release({scrollIntoView:()=>scrolls++});await pending;
  assert.equal(scrolls,0);
});

test("unloading cancels pending PDF positioning", async () => {
  const f=fixture();let release,scrolls=0;
  f.pdf.view.containerEl={};f.pdf.view.file=f.file;f.workspace.getLeavesOfType=()=>[f.pdf];
  f.plugin.lmbWaitPageEl=()=>new Promise(r=>release=r);
  const pending=f.plugin.lmbJumpToSelection(f.file.path,1);
  while(!release) await Promise.resolve();
  f.plugin._unloaded=true;release({scrollIntoView:()=>scrolls++});await pending;
  assert.equal(scrolls,0);
});

test("loading a Markdown leaf cannot reactivate it after the user leaves", async () => {
  const f=fixture({opened:true});let release;
  f.target.loadIfDeferred=()=>new Promise(r=>release=r);
  const pending=f.plugin.lmbOpenExcerptInMd("ex-target",f.file.path);
  while(!release) await Promise.resolve();
  f.workspace.setActiveLeaf(f.pdf);release();
  assert.equal(await pending,false);assert.equal(f.workspace.activeLeaf,f.pdf);
});

test("cancelled Canvas lookup cannot fall back into Markdown", async () => {
  const f=fixture();f.plugin.excerptCanvasIndex=new Map([["ex-target",{canvasPath:"a.canvas",nodeId:"node"}]]);
  let fallback=0;
  f.plugin.lmbFocusCanvasNode=async()=>{f.workspace.setActiveLeaf(f.pdf);return false;};
  f.plugin.lmbOpenExcerptInMd=async()=>{fallback++;};
  await f.plugin.lmbOpenExcerptAt("ex-target",f.file.path);
  assert.equal(fallback,0);
});

test("switching mode while preview renders cancels the old positioning", async()=>{
  const f=fixture({opened:true,mode:"preview"});
  f.view.previewMode.renderer.applyScroll=()=>{f.view.getMode=()=>"source";return false;};
  assert.equal(await f.plugin.lmbOpenExcerptInMd("ex-target",f.file.path),false);
  assert.equal(f.calls.cursors.length,0);
});

test("a subsequent wheel gesture cancels pending navigation and removes listeners", async()=>{
  const f=fixture();const events=new Map();
  f.victim.containerEl.ownerDocument={addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  const request=f.plugin._lmbBeginNavigation();events.get("wheel")();
  assert.equal(f.plugin._lmbNavigationCurrent(request),false);
  f.plugin._lmbEndNavigation(request);assert.equal(events.size,0);
});

test("unchanged sidebar visibility sends no repeated layout notifications", async()=>{
  const f=fixture();let notifications=0;const host={toggleClass(){}};
  f.pdf.containerEl.querySelector=s=>s===".lmb-pdf-sidebar-host"?host:null;
  f.plugin._lmbNotifyPdfSidebarLayout=()=>notifications++;
  f.plugin.lmbSetPdfSidebarVisible(f.pdf,true);f.plugin.lmbSetPdfSidebarVisible(f.pdf,true);
  assert.equal(notifications,1);
  f.plugin.lmbSetPdfSidebarVisible(f.pdf,false);f.plugin.lmbSetPdfSidebarVisible(f.pdf,false);
  assert.equal(notifications,2);
});

test("sidebar resize only reaches its PDF viewer", async()=>{
  const f=fixture();let pdfResizes=0,globalResizes=0;
  const win={cancelAnimationFrame(){},clearTimeout(){},setTimeout(fn){fn();return 1;},dispatchEvent(){globalResizes++;}};
  const host={clientWidth:600,ownerDocument:{defaultView:win}};
  f.pdf.containerEl.querySelector=()=>host;
  f.pdf.view.viewer={child:{onResize(){pdfResizes++;}}};
  f.workspace.trigger=()=>globalResizes++;
  f.plugin._lmbNotifyPdfSidebarLayout(f.pdf,true);
  assert.equal(pdfResizes,2);assert.equal(globalResizes,0);
});

test("public preview API remains usable if the internal renderer is absent", async () => {
  const f = fixture({ opened: true, mode: "preview" });
  f.view.previewMode = { applyScroll: (line) => f.calls.previews.push(line) };
  assert.equal(await f.plugin.lmbOpenExcerptInMd("ex-target", f.file.path, f.pdf), true);
  assert.deepEqual(f.calls.previews, [5]);
  assert.equal(f.calls.cursors.length, 0);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name + "\n" + error.message); }
  }
  console.log(`Navigation regression cases: ${cases.length - failed}/${cases.length} passed`);
  if (failed) process.exitCode = 1;
})();
