"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");

class Plugin {}
class TFile {}
class Notice {}
class Empty {}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Plugin, TFile, Notice,
      PluginSettingTab: Empty, Setting: Empty, Modal: Empty, FuzzySuggestModal: Empty,
      normalizePath: (p) => p.replace(/\\/g, "/"), setIcon: () => {}
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const PluginClass = require("../../main.js");
Module._load = originalLoad;
const pure = PluginClass.__test;
const proto = PluginClass.prototype;

async function main() {
  const textNodeA = { textContent: "a) is an interdisciplinary field" };
  const textNodeB = { textContent: "Functional Magnetic Resonance Imaging" };
  const fakeTextLayer = {
    children: [{ nodes: [textNodeA] }, { nodes: [textNodeB] }],
    ownerDocument: { createTreeWalker: (div) => {
      let index = 0;
      return { nextNode: () => div.nodes[index++] || null };
    } }
  };
  const insideSpanMatch = proto._lmbFindPdfTextMatch(fakeTextLayer, "interdisciplinary field");
  assert.equal(insideSpanMatch.start.offset, 9);
  assert.equal(insideSpanMatch.end.offset, 32);
  const acrossSpanMatch = proto._lmbFindPdfTextMatch(fakeTextLayer, "field Functional");
  assert.equal(acrossSpanMatch.start.node, textNodeA);
  assert.equal(acrossSpanMatch.end.node, textNodeB);
  const repeatedTop = { textContent: "False", y: 10 }, repeatedBottom = { textContent: "False", y: 80 };
  const repeatedDoc = {
    createTreeWalker: (div) => { let index = 0; return { nextNode: () => div.nodes[index++] || null }; },
    createRange: () => { let startNode = null; return {
      setStart: (node) => { startNode = node; }, setEnd: () => {},
      getBoundingClientRect: () => ({ left: 10, right: 20, top: startNode.y, bottom: startNode.y + 5 })
    }; }
  };
  const repeatedLayer = { children: [{ nodes: [repeatedTop] }, { nodes: [repeatedBottom] }], ownerDocument: repeatedDoc };
  const nearestRepeated = proto._lmbFindPdfTextMatch(repeatedLayer, "False", [8, 78, 15, 8], {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 })
  });
  assert.equal(nearestRepeated.start.node, repeatedBottom);

  // Large Canvas parent lookup must stay local instead of returning every node.
  const gridNodes = Array.from({ length: 2000 }, (_, i) => ({
    id: "n" + i, type: "text", x: (i % 100) * 700, y: Math.floor(i / 100) * 700,
    width: 300, height: 180
  }));
  const moving = { id: "moving", type: "text", x: 10, y: 10, width: 80, height: 80 };
  const nearby = pure.lmbBuildSpatialIndex(gridNodes).query(moving);
  assert(nearby.length < 10);
  assert.equal(pure.lmbPickDropParent(moving, nearby).node.id, "n0");

  // Related-note corpus reads each Markdown body once and is shared by queries.
  const relatedFiles = ["alpha.md", "beta.md", "gamma.md"].map((path) => ({
    path, extension: "md", basename: path.slice(0, -3)
  }));
  let relatedReads = 0;
  const relatedCtx = Object.create(proto);
  Object.assign(relatedCtx, {
    relatedCache: new Map(),
    app: { vault: {
      getMarkdownFiles: () => relatedFiles,
      cachedRead: async (file) => { relatedReads++; return file.basename + " body"; }
    }, metadataCache: { getFileCache: () => ({ headings: [], tags: [] }) } }
  });
  await relatedCtx.findRelatedNotes("ex-related-a", "alpha");
  await relatedCtx.findRelatedNotes("ex-related-b", "beta");
  assert.equal(relatedReads, relatedFiles.length);

  const noteMap = proto._lmbBuildExcerptNoteMap.call({},
    "> [!lmb-note]\n> > <!-- LMB-NOTE:BEGIN -->\n> > hello\n> > <!-- LMB-NOTE:END -->\n> ^ex-note01");
  assert.equal(noteMap.get("ex-note01"), "hello");

  // PDF 边页靠 padding 改变可用宽度；必须显式唤醒 PDF.js 的 resize
  // 监听器，并在异步布局稳定后补发一次，避免沿用旧的 viewer 宽度。
  const sidebarFrames = [], sidebarTimers = [];
  let sidebarWindowResizes = 0, sidebarWorkspaceResizes = 0, sidebarWidthReads = 0;
  class SidebarEvent { constructor(type) { this.type = type; } }
  const sidebarWindow = {
    Event: SidebarEvent,
    requestAnimationFrame: (fn) => { sidebarFrames.push(fn); return sidebarFrames.length; },
    cancelAnimationFrame: () => {},
    setTimeout: (fn) => { sidebarTimers.push(fn); return sidebarTimers.length; },
    clearTimeout: () => {},
    dispatchEvent: (event) => { if (event.type === "resize") sidebarWindowResizes++; }
  };
  const sidebarHost = {
    ownerDocument: { defaultView: sidebarWindow },
    get clientWidth() { sidebarWidthReads++; return 900; }
  };
  const sidebarLeaf = { containerEl: { querySelector: () => sidebarHost } };
  proto._lmbNotifyPdfSidebarLayout.call({ app: { workspace: {
    trigger: (name) => { if (name === "resize") sidebarWorkspaceResizes++; }
  } } }, sidebarLeaf);
  assert.equal(sidebarWindowResizes, 0);
  sidebarFrames.shift()();
  assert.equal(sidebarWindowResizes, 1);
  assert.equal(sidebarWorkspaceResizes, 1);
  sidebarTimers.shift()();
  assert.equal(sidebarWindowResizes, 2);
  assert.equal(sidebarWorkspaceResizes, 2);
  assert.equal(sidebarWidthReads, 2);

  assert.deepEqual(
    pure.lmbCalcBarPos(
      { left: 200, top: 50, width: 100, height: 100 },
      { left: 0, top: 0, width: 500, height: 400 },
      { width: 80, height: 120 }
    ),
    { left: 112, top: 50, placement: "left" }
  );
  assert.deepEqual(
    pure.lmbCalcBarPos(
      { left: 20, top: 50, width: 100, height: 100 },
      { left: 0, top: 0, width: 500, height: 400 },
      { width: 80, height: 120 }
    ),
    { left: 128, top: 50, placement: "right" }
  );
  assert.deepEqual(
    pure.lmbCalcBarPos(
      { left: 200, top: 100, width: 300, height: 160 },
      { left: 0, top: 0, width: 800, height: 600 },
      { width: 260, height: 76 }, { mobile: true }
    ),
    { left: 220, top: 268, placement: "bottom" }
  );
  assert.equal(
    pure.lmbBarSignature(["card"], { x: 0, y: 0, zoom: 1 }),
    pure.lmbBarSignature(["card"], { x: 900, y: -400, zoom: 3 })
  );

  const parsed = pure.lmbParseExcerptDoc([
    "> ([[book.pdf#page=2&selection=1,0,2,3|【book-P.2】]])",
    "> 原始摘录",
    "> [!ppd-note] 补充描述",
    "> 不能进入索引",
    "> [[ghost.pdf#page=9|幽灵链接]]",
    "> #幽灵标签",
    "> ^ex-abcd"
  ].join("\n"), "book-摘录.md");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, "原始摘录");
  assert.deepEqual(parsed[0].tags, []);
  assert.equal(parsed[0].exId, "ex-abcd");

  const regionParsed = pure.lmbParseExcerptDoc([
    "<!-- LMB:BEGIN -->",
    "> ([[book.pdf#page=2|【book-P.2】]])",
    "> 受控摘录",
    "^ex-region01",
    "<!-- LMB:END -->",
    "",
    "## 我的补充",
    "[[ghost.pdf#page=9|不应索引]]"
  ].join("\n"), "book-摘录.md");
  assert.equal(regionParsed.length, 1);
  assert.equal(regionParsed[0].exId, "ex-region01");
  const cardParsed = pure.lmbParseExcerptDoc([
    "<!-- LMB:BEGIN -->",
    "> [!lmb-excerpt]+ ① P.14 · 图像",
    "> > ([[book.pdf#page=14&rect=1,2,30,20|【book-P.14】]])",
    "> > 卡片正文",
    "> ^ex-card0001",
    "<!-- LMB:END -->"
  ].join("\n"), "book-摘录.md");
  assert.equal(cardParsed.length, 1);
  assert.equal(cardParsed[0].page, 14);
  assert.equal(cardParsed[0].exId, "ex-card0001");
  const canonicalNoteParsed = pure.lmbParseExcerptDoc([
    "> [!lmb-excerpt]+ P.17 · 原文",
    "> > ([[book.pdf#page=17|【book-P.17】]])",
    "> > 摘录正文",
    "> > [!lmb-note]",
    "> > <!-- LMB-NOTE:BEGIN -->",
    "> > > **三方同步**",
    "> > <!-- LMB-NOTE:END -->",
    "> ^ex-note0001"
  ].join("\n"), "book-摘录.md");
  assert.equal(canonicalNoteParsed.length, 1);
  assert.equal(canonicalNoteParsed[0].exId, "ex-note0001");
  assert.equal(canonicalNoteParsed[0].text, "摘录正文");
  const pollutedCommentParsed = pure.lmbParseExcerptDoc([
    "> [!lmb-excerpt]+ P.9 · 原文",
    "> > [[book.pdf#page=9|【book-P.9】]]",
    "> > 正确摘录正文",
    "> [!lmb-comment]",
    "> - 不得混入正文",
    "> > [!lmb-note]",
    "> > <!-- LMB-NOTE:BEGIN -->",
    "> > > - Markdown 准值",
    "> > <!-- LMB-NOTE:END -->",
    "> ^ex-polluted1"
  ].join("\n"), "book-摘录.md");
  assert.equal(pollutedCommentParsed[0].text, "正确摘录正文");
  assert.equal(pollutedCommentParsed[0].exId, "ex-polluted1");
  const noteState = proto._lmbExcerptNoteState([
    "> [!lmb-excerpt]+ P.17 · 原文",
    "> > 摘录",
    "> <!-- LMB-NOTE:BEGIN -->",
    "> [!lmb-note]+ 我的笔记",
    "> > **实时**笔记",
    "> <!-- LMB-NOTE:END -->",
    "> ^ex-1234567890"
  ].join("\n"), "ex-1234567890");
  assert.equal(noteState.value, "**实时**笔记");

  const hashLink = proto.lmbParsePdfLink("报告#2.pdf#page=3&selection=1,2,3,4");
  assert.equal(hashLink.filePath, "报告#2.pdf");
  assert.equal(hashLink.page, 3);

  const canvasFile = { path: "safe.canvas" };
  const emptyCtx = {
    app: { workspace: { getLeavesOfType: () => [{
      view: { file: canvasFile, canvas: { getData: () => ({ nodes: [] }) } }
    }] } },
    nodeMeta: new Map([[canvasFile.path, new Map([["old", {}]])]])
  };
  assert.equal(proto._lmbMemCanvasData.call(emptyCtx, canvasFile), null);

  const source = { path: "safe.canvas", extension: "canvas" };
  const refsCtx = { app: { vault: {
    getFiles: () => [source, { path: "other.md", extension: "md" }],
    cachedRead: async (f) => f === source ? "![[shot.webp]]" : "unrelated"
  } } };
  assert.equal(await proto._lmbCountAttachmentRefs.call(refsCtx, "shot.webp", source), 0);

  // 连续的手动摘录之间没有空行；删除其中一条绝不能吞掉相邻条目或区域标记。
  const manualSource = "docs/book-摘录.md";
  let manualRaw = [
    "<!-- LMB:MANUAL-EXCERPTS:BEGIN -->",
    "> [!lmb-excerpt]+ P.3 · 图像",
    "> [[book.pdf#page=3|📖]]",
    "> ^ex-keep0001",
    "> [!lmb-excerpt]+ P.3 · 图像",
    "> [[book.pdf#page=3|📖]]",
    "> ^ex-delete01",
    "<!-- LMB:MANUAL-EXCERPTS:END -->"
  ].join("\n");
  const manualWrites = new Map();
  const manualCtx = { app: { vault: { adapter: {
    read: async () => manualRaw,
    write: async (path, value) => { manualWrites.set(path, value); if (path === manualSource) manualRaw = value; }
  } } } };
  assert.equal(await proto._lmbRemoveExcerptFromMd.call(manualCtx, { parent: { path: "docs" } },
    { exId: "ex-delete01", pdf: "book.pdf", sourceMd: manualSource }, { dir: ".lmb-trash/test" }), true);
  assert(manualRaw.includes("^ex-keep0001"));
  assert(!manualRaw.includes("^ex-delete01"));
  assert(manualRaw.includes("LMB:MANUAL-EXCERPTS:BEGIN"));
  assert(manualRaw.includes("LMB:MANUAL-EXCERPTS:END"));

  let deleted = 0;
  const cleanupCtx = { app: { vault: {
    adapter: { read: async () => "", write: async () => {} },
    delete: async () => { deleted++; }
  } } };
  const gone = Array.from({ length: 4 }, (_, i) => ({ id: `node-${i}`, meta: { attach: `x-P1-${i}a.webp` } }));
  await proto._lmbCleanupDeletedNodes.call(cleanupCtx, { basename: "safe" }, gone);
  assert.equal(deleted, 0);

  const pruneCtx = {
    _lmbCachePruneDirty: true,
    app: { vault: { getFiles: () => [
      { path: "keep.canvas", name: "keep.canvas", extension: "canvas" },
      { path: "shot.webp", name: "shot.webp", extension: "webp" }
    ] } },
    autoSize: new Map([["keep.canvas", new Map()], ["gone.canvas", new Map()]]),
    canvasPositions: new Map([["gone.canvas", new Map()]]),
    autoEdges: new Map([["gone.canvas", new Set()]]),
    nodeMeta: new Map([["gone.canvas", new Map()]]),
    imgDims: new Map([["shot.webp", { w: 1, h: 1 }], ["gone.webp", { w: 1, h: 1 }]])
  };
  proto._lmbPrunePersistedCaches.call(pruneCtx);
  assert.deepEqual(Array.from(pruneCtx.autoSize.keys()), ["keep.canvas"]);
  assert.deepEqual(Array.from(pruneCtx.imgDims.keys()), ["shot.webp"]);

  const raceFile = { path: "race.canvas" };
  const oldData = { nodes: [{ id: "card", type: "text", text: "摘录 ^ex-abcd", x: 10, y: 20, width: 100, height: 100 }] };
  const freshData = { nodes: [{ id: "card", type: "text", text: "摘录 ^ex-abcd", x: 900, y: 800, width: 100, height: 100 }] };
  let getDataCalls = 0;
  let committed = null;
  const raceCanvas = {
    nodes: new Map([["card", { id: "card", text: "摘录 ^ex-abcd" }]]),
    getData: () => (++getDataCalls === 1 ? oldData : freshData),
    setData: (d) => { committed = d; },
    requestSave: () => {}
  };
  let measureCalls = 0;
  const raceCtx = {
    _unloaded: false,
    app: { workspace: { getLeavesOfType: () => [{ view: { file: raceFile, canvas: raceCanvas } }] }, vault: {} },
    autoSize: new Map([[raceFile.path, new Map()]]),
    selfWritten: new Map(),
    simpleHash: proto.simpleHash,
    lmbFitNodeActual: () => (++measureCalls === 1 ? null : { w: 410, h: 230 }),
    persistAutoSizeSoon: () => {}
  };
  await proto._actualFitRetryForFile.call(raceCtx, raceFile);
  assert.equal(committed.nodes[0].x, 900);
  assert.equal(committed.nodes[0].y, 800);
  assert.equal(committed.nodes[0].width, 410);
  assert.equal(committed.nodes[0].height, 230);

  let directWrites = 0, requests = 0;
  const writeCtx = {
    selfWritten: new Map(),
    app: { vault: { adapter: { write: async () => { directWrites++; } } } }
  };
  await proto._lmbWriteCanvasData.call(writeCtx, raceFile, freshData, {
    setData: () => {}, requestSave: () => { requests++; }
  }, "");
  assert.equal(requests, 1);
  assert.equal(directWrites, 0);
  await proto._lmbWriteCanvasData.call(writeCtx, raceFile, freshData, null, "");
  assert.equal(directWrites, 1);

  // 相同文本的移动/手动调高不得再次触发 DOM 高度测量。
  const stableNode = { id: "stable", text: "不变内容 ^ex-efgh", height: 300 };
  const stableHash = proto.simpleHash.call({}, stableNode.text);
  const stableStore = new Map([[stableNode.id, { hash: stableHash, w: 380, h: 180 }]]);
  let automaticMeasures = 0;
  const stableCtx = {
    simpleHash: proto.simpleHash,
    lmbFitNodeActual: () => { automaticMeasures++; return { w: 380, h: stableNode.height + 8 }; },
    estimateSizeFor: () => ({ w: 380, h: 180 }),
    persistAutoSizeSoon: () => {}
  };
  for (let i = 0; i < 20; i++) assert.equal(proto.fitNode.call(stableCtx, stableNode, stableStore), null);
  assert.equal(automaticMeasures, 0);
  assert.equal(stableNode.height, 300);

  // 估算路径只产生一个待重测标记，实际高度稳定后标记会被清除。
  const pendingNode = { id: "pending", text: "待渲染 ^ex-ijkl", width: 380 };
  const pendingStore = new Map();
  proto.fitNode.call({
    simpleHash: proto.simpleHash,
    lmbFitNodeActual: () => null,
    estimateSizeFor: () => ({ w: 380, h: 108 }),
    persistAutoSizeSoon: () => {}
  }, pendingNode, pendingStore);
  assert.equal(pendingStore.get("pending").pendingActual, true);
  const leafEl = { children: [], getBoundingClientRect: () => ({ top: 0, bottom: 100, width: 380, height: 100 }) };
  const contentEl = {
    children: [leafEl], scrollTop: 0, scrollHeight: 100, clientWidth: 380, offsetWidth: 380,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, width: 380, height: 100 }),
    querySelectorAll: () => []
  };
  pendingNode.nodeEl = { querySelector: () => contentEl };
  proto.lmbFitNodeActual.call({ simpleHash: proto.simpleHash, persistAutoSizeSoon: () => {} }, pendingNode, pendingStore);
  assert.equal(pendingStore.get("pending").pendingActual, undefined);

  const measuredContent = contentEl;
  const measuredWrapper = { querySelector: () => measuredContent };
  const normalMeasured = proto.lmbFitNodeActual.call(
    { simpleHash: proto.simpleHash, persistAutoSizeSoon: () => {} },
    { id: "normal-pad", text: "正文 ^ex-mnop", nodeEl: measuredWrapper }, new Map());
  const commentMeasured = proto.lmbFitNodeActual.call(
    { simpleHash: proto.simpleHash, persistAutoSizeSoon: () => {} },
    { id: "comment-pad", text: "正文 ^ex-qrst\n> [!lmb-comment] 评论", nodeEl: measuredWrapper }, new Map());
  assert.equal(normalMeasured.h, 120);
  assert.equal(commentMeasured.h, 140);

  const oldComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (el) => Object.assign({
    display: "block", visibility: "visible", marginBottom: "0",
    paddingBottom: "0", borderBottomWidth: "0"
  }, el._style || {});
  const makeScrolledContent = (scrollTop, leafBottom) => {
    const leaf = {
      children: [], _style: { marginBottom: "5" },
      getBoundingClientRect: () => ({ top: leafBottom - 20, bottom: leafBottom, width: 100, height: 20 })
    };
    const parent = {
      children: [leaf], _style: { paddingBottom: "100", marginBottom: "100" },
      getBoundingClientRect: () => ({ top: 0, bottom: leafBottom, width: 100, height: leafBottom })
    };
    return {
      children: [parent], scrollTop, _style: { paddingBottom: "10" },
      getBoundingClientRect: () => ({ top: 0, bottom: 200, width: 100, height: 200 })
    };
  };
  assert.equal(pure.lmbMeasureRenderedContent(makeScrolledContent(100, 300), 1), 415);
  assert.equal(pure.lmbMeasureRenderedContent(makeScrolledContent(0, 400), 1), 415);
  for (let i = 0; i < 20; i++) {
    assert.equal(pure.lmbMeasureRenderedContent(makeScrolledContent(100, 300), 1), 415);
  }
  assert.equal(pure.lmbFinalizeCardHeight(100, 0, false, false), 120);
  assert.equal(pure.lmbFinalizeCardHeight(100, 0, true, false), 140);
  assert.equal(pure.lmbFinalizeCardHeight(220, 35, true, true), 220);

  // 离屏副本按外框最终宽度自然展开：高度与当前受限高度/滚动条无关，并只留 4px 舍入余量。
  const makeStyle = () => ({ setProperty(name, value) { this[name] = value; } });
  const cloneContent = {
    children: [], style: makeStyle(), scrollHeight: 160, offsetHeight: 160,
    querySelectorAll: () => []
  };
  const cloneWrapper = {
    children: [cloneContent], style: makeStyle(), scrollHeight: 180, offsetHeight: 100,
    removeAttribute: () => {}, setAttribute: () => {}, querySelectorAll: () => []
  };
  cloneContent.parentElement = cloneWrapper;
  const measureHost = {
    appendChild(el) { el.parentElement = this; },
    removeChild(el) { el.parentElement = null; }
  };
  const liveContent = { clientHeight: 90 };
  const liveWrapper = {
    children: [liveContent], offsetWidth: 250, offsetHeight: 100,
    ownerDocument: {}, parentElement: measureHost,
    cloneNode: () => cloneWrapper
  };
  liveContent.parentElement = liveWrapper;
  assert.equal(pure.lmbMeasureNaturalCard(liveWrapper, liveContent, 1), 184);
  assert.equal(cloneWrapper.style.width, "250px");

  // 最终验收不是“写回了某个高度”，而是实际滚动宿主不再溢出。
  const scrollHost = {
    scrollHeight: 190, clientHeight: 178,
    querySelectorAll: () => []
  };
  assert.equal(pure.lmbVerticalOverflow(scrollHost), 12);
  const correctedHeight = pure.lmbHeightAfterOverflow(178, pure.lmbVerticalOverflow(scrollHost));
  assert.equal(correctedHeight, 198);
  scrollHost.clientHeight += correctedHeight - 178;
  assert.equal(pure.lmbVerticalOverflow(scrollHost), 0);
  const nestedScroller = { scrollHeight: 224, clientHeight: 200 };
  assert.equal(pure.lmbVerticalOverflow({
    scrollHeight: 100, clientHeight: 100,
    querySelectorAll: () => [nestedScroller]
  }), 24);
  assert.equal(pure.lmbHeightAfterOverflow(220, 0), 220);
  globalThis.getComputedStyle = oldComputedStyle;

  // 手动“高度”按钮闭环集成：第一次写入 178 后仍溢出 12px，必须二次写到 198，
  // 并以无滚动条的最终值写入锁定缓存，而不是把首次预测值当作成功。
  const fitFile = { path: "overflow.canvas" };
  let fitData = {
    nodes: [{ id: "overflow-card", type: "text", text: "随便输入的长文字", x: 10, y: 20, width: 250, height: 100 }],
    edges: []
  };
  const fitContent = {
    children: [], scrollHeight: 190, clientHeight: 100,
    querySelectorAll: () => []
  };
  const fitWrapper = {
    querySelector: () => fitContent,
    getBoundingClientRect: () => ({ height: fitData.nodes[0].height, width: 250 })
  };
  const fitLiveNode = Object.assign({}, fitData.nodes[0], { nodeEl: fitWrapper });
  const committedHeights = [];
  const fitCanvas = {
    scale: 1,
    nodes: new Map([[fitLiveNode.id, fitLiveNode]]),
    getData: () => fitData,
    setData: (next) => {
      fitData = next;
      const h = next.nodes[0].height;
      committedHeights.push(h);
      fitLiveNode.height = h;
      fitContent.clientHeight = h;
    },
    requestFrame: () => {}, requestSave: () => {}
  };
  const fitStore = new Map();
  const fitCtx = {
    activeCanvasContext: () => ({ file: fitFile, leaf: { view: { canvas: fitCanvas } } }),
    _lmbWaitForNodeEl: async () => fitWrapper,
    _lmbCloneCanvasForHeight: proto._lmbCloneCanvasForHeight,
    estimateSizeFor: () => ({ w: 250, h: 178 }),
    simpleHash: proto.simpleHash,
    app: { vault: {
      read: async () => JSON.stringify(fitData),
      adapter: { write: async (_path, raw) => { fitData = JSON.parse(raw); } }
    } },
    autoSize: new Map([[fitFile.path, fitStore]]), autoEdges: new Map(), selfWritten: new Map(),
    persistAutoSizeSoon: () => {}
  };
  await proto.lmbFitNodeById.call(fitCtx, fitFile, fitLiveNode.id, fitLiveNode);
  assert.deepEqual(committedHeights, [178, 198]);
  assert.equal(fitData.nodes[0].height, 198);
  assert.equal(pure.lmbVerticalOverflow(fitContent), 0);
  assert.equal(fitStore.get(fitLiveNode.id).h, 198);

  // 断线规划：自动父边优先；普通单边直删；多条普通边进入选择；无边不操作。
  const disconnectEdges = [
    { id: "parent-edge", fromNode: "parent", toNode: "card" },
    { id: "child-edge", fromNode: "card", toNode: "child" }
  ];
  assert.equal(pure.lmbPlanDisconnect("card", disconnectEdges, new Set(["parent-edge"])).edgeId, "parent-edge");
  assert.equal(pure.lmbPlanDisconnect("card", [disconnectEdges[1]], new Set()).kind, "direct");
  assert.equal(pure.lmbPlanDisconnect("card", disconnectEdges, new Set()).kind, "choose");
  assert.equal(pure.lmbPlanDisconnect("missing", disconnectEdges, new Set()).kind, "none");

  // 父卡联动移动：递归带走全部后代；有环也不会重复；显式多选的子卡不被叠加位移。
  const followNodes = [
    { id: "root", x: 0, y: 0 }, { id: "child", x: 100, y: 20 },
    { id: "grandchild", x: 220, y: 40 }, { id: "other", x: 900, y: 900 }
  ];
  const followEdges = [
    { fromNode: "root", toNode: "child" },
    { fromNode: "child", toNode: "grandchild" },
    { fromNode: "grandchild", toNode: "root" }
  ];
  assert.equal(pure.lmbMoveDescendants(followNodes, followEdges, [{ id: "root", dx: 30, dy: -10 }]), 2);
  assert.deepEqual(followNodes.slice(1, 3).map((n) => [n.x, n.y]), [[130, 10], [250, 30]]);
  assert.deepEqual([followNodes[3].x, followNodes[3].y], [900, 900]);
  assert.equal(pure.lmbMoveDescendants(followNodes, followEdges, [
    { id: "root", dx: 10, dy: 10 }, { id: "child", dx: 10, dy: 10 }
  ]), 1);
  assert.deepEqual([followNodes[1].x, followNodes[1].y], [130, 10]);
  assert.deepEqual([followNodes[2].x, followNodes[2].y], [260, 40]);

  const treeNodes = [{ id: "r", x: 0, y: 0, width: 100, height: 50 }, { id: "c", x: 0, y: 0, width: 100, height: 50 }];
  assert.equal(pure.lmbLayoutTree(treeNodes, [{ fromNode: "r", toNode: "c" }], "right"), 1);
  assert(treeNodes[1].x > treeNodes[0].x);

  // 删除/撤销集成：节点位置和其他线保持原样，autoEdges 账本与 Canvas 数据同步变化。
  const disconnectFile = { path: "disconnect.canvas" };
  let disconnectData = {
    nodes: [
      { id: "parent", x: 10, y: 20, width: 200, height: 100 },
      { id: "card", x: 400, y: 500, width: 250, height: 180 },
      { id: "child", x: 800, y: 900, width: 200, height: 100 }
    ],
    edges: disconnectEdges.map((e) => Object.assign({}, e))
  };
  const disconnectCanvas = {
    getData: () => disconnectData,
    setData: (d) => { disconnectData = d; },
    requestFrame: () => {}, requestSave: () => {}
  };
  const disconnectSidecar = new Set(["parent-edge"]);
  const disconnectCtx = {
    autoEdges: new Map([[disconnectFile.path, disconnectSidecar]]),
    persistAutoSizeSoon: () => {}, _barSig: "old"
  };
  assert.equal(await proto._lmbDeleteCanvasEdge.call(
    disconnectCtx, disconnectFile, disconnectCanvas, "parent-edge"), true);
  assert.deepEqual(disconnectData.edges.map((e) => e.id), ["child-edge"]);
  assert.equal(disconnectData.nodes[1].x, 400);
  assert.equal(disconnectSidecar.has("parent-edge"), false);
  assert.equal(await proto._lmbUndoDisconnectedEdge.call(disconnectCtx), true);
  assert.deepEqual(disconnectData.edges.map((e) => e.id), ["child-edge", "parent-edge"]);
  assert.equal(disconnectSidecar.has("parent-edge"), true);
  assert.equal(disconnectData.nodes[1].y, 500);

  let chooseCandidates = null;
  const chooseCtx = {
    activeCanvasContext: () => ({
      file: disconnectFile,
      leaf: { view: { canvas: disconnectCanvas } }
    }),
    autoEdges: new Map([[disconnectFile.path, new Set()]]),
    _lmbEnterDisconnectMode: (_file, _canvas, _nodeId, candidates) => { chooseCandidates = candidates; }
  };
  assert.equal(await proto.lmbDisconnectCard.call(chooseCtx, {
    file: disconnectFile, nodeId: "card"
  }), true);
  assert.deepEqual(chooseCandidates.map((e) => e.id).sort(), ["child-edge", "parent-edge"]);

  // Canvas setData 失败时不能先删 autoEdges 账本，避免形成不可恢复的半状态。
  const transactionalSidecar = new Set(["parent-edge"]);
  await assert.rejects(() => proto._lmbDeleteCanvasEdge.call({
    autoEdges: new Map([[disconnectFile.path, transactionalSidecar]])
  }, disconnectFile, {
    getData: () => disconnectData,
    setData: () => { throw new Error("write failed"); }
  }, "parent-edge"));
  assert.equal(transactionalSidecar.has("parent-edge"), true);

  const originalCanvas = {
    nodes: [{ id: "fit-me", x: 33, y: 44, height: 90 }, { id: "other", x: 1, y: 2, height: 50 }],
    edges: [{ id: "edge-1", fromNode: "other", toNode: "fit-me" }]
  };
  const heightClone = proto._lmbCloneCanvasForHeight(originalCanvas, "fit-me", 240);
  assert.equal(originalCanvas.nodes[0].height, 90);
  assert.equal(heightClone.node.height, 240);
  assert.equal(heightClone.node.x, 33);
  assert.notEqual(heightClone.data, originalCanvas);
  assert.notEqual(heightClone.data.nodes[0], originalCanvas.nodes[0]);
  assert.notEqual(heightClone.data.edges[0], originalCanvas.edges[0]);

  assert.equal(proto._lmbKeepCardWidth.call({ settings: { excerptCardWidth: 560 } }, { width: 473 }), 473);
  assert.equal(proto._lmbKeepCardWidth.call({ settings: { excerptCardWidth: 560 } }, {}), 560);
  assert.equal(proto._lmbExcerptImageFolder.call({ settings: { excerptImageFolder: "附件/{pdf}" } },
    { basename: "Lecture 5" }), "附件/Lecture 5");

  // Mobile does not expose the desktop HTML5 drop workflow. The direct Canvas
  // action must create one card, persist it, and deduplicate a repeated tap.
  const mobilePdf = Object.assign(new TFile(), { path: "books/mobile.pdf", basename: "mobile" });
  const mobileCanvas = Object.assign(new TFile(), { path: "books/mobile.canvas", extension: "canvas" });
  let mobileData = { nodes: [], edges: [] };
  let mobileWrites = 0, mobileFocus = null;
  const mobileCtx = {
    settings: { excerptCardWidth: 480, autoAttachScreenshot: false },
    _lmbCaptureDirectExcerptImage: async (info) => info,
    lmbOpenOrCreatePdfCanvas: async () => mobileCanvas,
    _lmbReadCanvasData: async () => ({ data: mobileData, memCanvas: null, raw: "" }),
    buildDropText: () => "> excerpt\n> ^ex-mobile01",
    contentExId: () => "ex-mobile01",
    estimateSizeFor: () => ({ w: 480, h: 180 }),
    _lmbWriteCanvasData: async (_file, data) => { mobileData = data; mobileWrites++; return true; },
    processCanvas: async () => {}, lmbIndexCanvasFile: async () => {},
    lmbFocusCanvasNode: async (_file, id) => { mobileFocus = id; return true; }
  };
  await proto.lmbCreateDirectCanvasExcerpt.call(mobileCtx, { file: mobilePdf, text: "excerpt" });
  assert.equal(mobileData.nodes.length, 1);
  assert.equal(mobileData.nodes[0].width, 480);
  assert.equal(mobileWrites, 1);
  await proto.lmbCreateDirectCanvasExcerpt.call(mobileCtx, { file: mobilePdf, text: "excerpt" });
  assert.equal(mobileData.nodes.length, 1);
  assert.equal(mobileFocus, mobileData.nodes[0].id);

  const sourceText = fs.readFileSync("./main.js", "utf8");
  assert(!sourceText.includes("[VERIFY-DISABLED]"));
  assert(!sourceText.includes("if (false)"));
  assert(sourceText.includes("if (settingsMigrated) await this.saveSettings();"));
  assert(!sourceText.includes("\n        node.height = finalH;"));
  assert(sourceText.includes("lmbMeasureNaturalCard(wrapperEl, contentEl, measureScale)"));
  assert(sourceText.includes("Number(node.width) || Number(wrapperEl.offsetWidth)"));
  assert(sourceText.includes("naturalHeightV2Migrated"));
  assert(sourceText.includes("for (let pass = 0; pass < 3; pass++)"));
  assert(sourceText.includes("overflowHeightVerifiedMigrated"));
  assert(sourceText.includes('mk("lmb-bar-disconnect", "unlink"'));
  assert(sourceText.includes('mk("lmb-bar-follow", "git-branch"'));
  assert(sourceText.includes("_lmbExitDisconnectMode(true)"));
  assert(sourceText.includes('excerptImageFolder: "附件/{pdf}"'));
  assert(sourceText.includes('this._lmbAutoFitCard(c.file, c.nodeId, c.node, { allowViewShrink: true })'));
  assert(sourceText.includes("allowViewShrink"));
  assert(sourceText.includes("ignoreLiveHeight"));
  assert(sourceText.includes("const imageOnly = !!(entry && entry.imagePath"));
  assert(sourceText.includes("this.isMobile ? null : setInterval"));
  assert(sourceText.includes('document.body.toggleClass("lmb-mobile", !!this.isMobile)'));
  assert(sourceText.includes("const entries = this._lmbGetPdfSidebarEntries(file);"));
  assert(sourceText.includes("touch-action:none!important"));
  assert(sourceText.includes('event.pointerType === "touch"'));
  assert(sourceText.includes('inputSurface.addEventListener("touchstart"'));
  assert(sourceText.includes("lmbInkIsStylusInput(touch)"));
  assert(sourceText.includes('const inputSurface = live || pageEl'));
  assert(sourceText.includes('live.style.setProperty("pointer-events", "auto", "important")'));
  assert(sourceText.includes('applyIcon(button, icon, fallback)'));
  assert(sourceText.includes('color.className = "lmb-ink-color-input"'));
  assert(sourceText.includes('widthControl.className = "lmb-ink-width-control"'));
  assert(!sourceText.includes('text: `目标: ${target.length'));
  assert(!sourceText.includes('${e.quick ? "简洁" : kind}'));
  const manifestVersion = JSON.parse(fs.readFileSync("./manifest.json", "utf8")).version;
  assert(sourceText.includes('st.dataset.lmbVersion = "' + manifestVersion + '"'));
  assert.equal(JSON.parse(fs.readFileSync("./package.json", "utf8")).version, manifestVersion);

  // 删除安全：引用扫描任一文件失败时必须 fail closed，不能把异常当作 0 引用。
  await assert.rejects(() => proto._lmbCountAttachmentRefs.call({ app: { vault: {
    getFiles: () => [{ path: "broken.md", extension: "md" }],
    cachedRead: async () => { throw new Error("read failed"); }
  } } }, "book-P1-abc.webp", { path: "source.canvas" }), /已保留附件/);

  // 回收目录先完整建立并写 metadata，供 Markdown 原块和附件共同落入。
  const madeFolders = new Set();
  const trashWrites = new Map();
  const trashCtx = { app: { vault: { adapter: {
    exists: async (p) => madeFolders.has(p),
    mkdir: async (p) => { madeFolders.add(p); },
    write: async (p, body) => { trashWrites.set(p, body); }
  } } } };
  const trash = await proto._lmbCreateTrashBundle.call(trashCtx,
    { path: "notes/book.canvas" },
    { id: "node-12345678", meta: { exId: "ex-safe", pdf: "book.pdf", attach: "book-P1-abc.webp" } });
  assert(trash.dir.startsWith(".lmb-trash/"));
  assert(madeFolders.has(trash.dir));
  assert(Array.from(trashWrites.keys()).some((p) => p.endsWith("/metadata.json")));
  assert.equal(JSON.parse(Array.from(trashWrites.values())[0]).excerptId, "ex-safe");

  console.log("MarginBook verification: 163 assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
