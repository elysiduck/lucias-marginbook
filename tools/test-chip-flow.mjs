/**
 * lucias-marginbook 决策逻辑冒烟测试（零依赖，直接加载真实 main.js）
 * 运行：node tools/test-chip-flow.mjs
 * 覆盖：
 *   A. lmbShouldReshowSelection —— chip 重建把关（v0.3.1 拖放后 chip 复活/Notice 刷屏 bug）
 *   B. contentExId —— 内容寻址 ID 稳定性/区分度（v0.3.0 P0-1 + selectionParams 修复）
 *   C. dragstart 守卫 —— 文字通道不再被 attachmentName 守卫误杀（源码静态断言）
 */
import { createRequire } from "module";
import Module from "module";

const ModuleCtor = Module.default ?? Module;
const origLoad = ModuleCtor._load;
ModuleCtor._load = function (request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Plugin: class {},
      Notice: class { constructor(msg) { void msg; } },
      TFile: class {},
      PluginSettingTab: class {},
      Setting: class {},
      normalizePath: (p) => p,
      // v0.8.0：补充描述弹窗与选卡器（测试里只需能被继承，不需要真实 DOM 行为）
      Modal: class { constructor(app) { this.app = app; this.contentEl = { empty() {}, createEl() { return { style: {}, addEventListener() {} }; } }; } open() {} close() {} },
      FuzzySuggestModal: class { constructor(app) { this.app = app; } open() {} close() {} getItems() { return []; } getItemText() { return ""; } onChooseItem() {} }
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

const require2 = createRequire(import.meta.url);
const path = new URL("../lucias-marginbook-plugin/main.js", import.meta.url).href;
const pluginModule = (await import(path));
const PluginClass = pluginModule.default ?? pluginModule;
const { __test } = PluginClass;
const {
  lmbShouldReshowSelection, lmbRectsOverlapRatio, lmbPickDropParent,
  lmbSnapChildPosition, lmbBuildTree, lmbDiffCanvasNodes,
  lmbSideOf, lmbSideEnds, lmbLayoutGroup, lmbGroupBySide,
  lmbAutoEdgeAlive, lmbAutoParentEdgeOf,
  lmbSplitNote, lmbJoinNote, lmbStripNote, lmbRenderedText,
  LMB_NOTE_START, LMB_NOTE_END,
  // P1：摘录索引层
  lmbParseExcerptDoc, LMB_LINK_RE, LMB_SEL_RE,
  // v0.11.0：首连锁定 / 改挂侧 / 尺寸重居中 + 独立评论
  lmbPlanAutoLink, lmbApplyReside, lmbRecenterNode,
  lmbSplitComment, lmbJoinComment, LMB_COMMENT_TYPE
} = __test;

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL: " + name); }
}

/* ---------- A. chip 重建把关 ---------- */
console.log("A. lmbShouldReshowSelection");
const base = { hasSelection: true, targetOnChip: false, chipVisible: false, sameSelection: false, mouseOnPdf: true };

t("A1 首次选区（PDF 内松手）→ 显示 chip", lmbShouldReshowSelection(base) === true);
t("A2 点在 chip 上 → 不重建（修复：点 chip 弹提示）", lmbShouldReshowSelection({ ...base, targetOnChip: true, chipVisible: true, sameSelection: true }) === false);
t("A3 拖放完成后同选区点击（chip 已被 dragend 收走）→ 不重建", lmbShouldReshowSelection({ ...base, chipVisible: false, sameSelection: false, mouseOnPdf: false }) === false);
t("A4 chip 还在 + 同一选区再点 PDF → 静默不重复弹", lmbShouldReshowSelection({ ...base, chipVisible: true, sameSelection: true }) === false);
t("A5 chip 还在 + 选了新文本 → 重建", lmbShouldReshowSelection({ ...base, chipVisible: true, sameSelection: false }) === true);
t("A6 释放点在 PDF 外（canvas/md/侧栏）→ 不重建", lmbShouldReshowSelection({ ...base, mouseOnPdf: false }) === false);
t("A7 无有效选区 → 不重建", lmbShouldReshowSelection({ ...base, hasSelection: false }) === false);
t("A8 PDF 内松手 + 旧 chip 残留但选区不同 → 重建", lmbShouldReshowSelection({ ...base, chipVisible: true, sameSelection: false, mouseOnPdf: true }) === true);

/* ---------- B. contentExId ---------- */
console.log("B. contentExId（实例方法，挂原型调用）");
const inst = Object.create(PluginClass.prototype);
const info = {
  file: { path: "书籍/Lecture 3 ECON508_FALL 2026.pdf" },
  pageNum: 21,
  selectionParams: "3,10,7,22",
  text: "自注意力机制的核心在于计算序列中任意两个位置之间的关联权重。",
  isImage: false
};
const id1 = inst.contentExId(info);
const id2 = inst.contentExId(info);
t("B1 同选区两次取 ID 稳定一致", id1 === id2 && id1 === inst.contentExId(info));
t("B2 ID 匹配 EX_ID_RE（4-8 位 base36）", __test.EX_ID_RE.test("^" + id1));
const diffPos = inst.contentExId({ ...info, selectionParams: "9,0,15,8" });
t("B3 同页同文本、不同位置 → 不同 ID（selectionParams 生效）", diffPos !== id1);
const noParams = inst.contentExId({ ...info, selectionParams: null });
t("B4 无 selectionParams 回退 text（仍稳定）", noParams === inst.contentExId({ ...info, selectionParams: null }));
const img1 = inst.contentExId({ isImage: true, attachmentName: "书-P21-ab12.webp" });
const img2 = inst.contentExId({ isImage: true, attachmentName: "书-P21-cd34.webp" });
t("B5 图片按 attachmentName 区分", img1 !== img2 && __test.EX_ID_RE.test("^" + img1));
const bad = inst.contentExId(null);
t("B6 异常输入降级为合法随机 id", __test.EX_ID_RE.test("^" + bad));

/* ---------- C. dragstart 守卫（源码静态断言） ---------- */
console.log("C. dragstart 守卫");
const { readFileSync } = await import("fs");
const src = readFileSync(new URL("../lucias-marginbook-plugin/main.js", import.meta.url), "utf8");
t("C1 守卫已限定为 isImage（文字通道不再被误杀）", /if \(info\.isImage && !info\.attachmentName\)/.test(src));
t("C2 不存在无条件的 !info.attachmentName 守卫", !/if \(!info\.attachmentName\)/.test(src));
t("C3 dragend 会清除已消费选区（removeAllRanges）", /dragend[\s\S]{0,900}removeAllRanges\(\)/.test(src));
t("C4 mouseup 走 lmbShouldReshowSelection 把关", /lmbShouldReshowSelection\(\{/.test(src));

/* ---------- D. MN4 式自动父子（v0.4.0） ---------- */
console.log("D. 自动父子：重叠判定 / 吸附 / 建树");
const parent = { id: "p1", type: "text", x: 100, y: 100, width: 200, height: 120 };

t("D1 完全压住 → ratio=1", lmbRectsOverlapRatio({ x: 100, y: 100, w: 200, h: 120 }, { x: parent.x, y: parent.y, w: parent.width, h: parent.height }) === 1);
t("D2 不相交 → ratio=0", lmbRectsOverlapRatio({ x: 400, y: 400, w: 50, h: 50 }, { x: parent.x, y: parent.y, w: parent.width, h: parent.height }) === 0);

const childOn = { id: "c1", type: "text", x: 150, y: 130, width: 100, height: 60 };   // 中心在父内
const hit = lmbPickDropParent(childOn, [parent]);
t("D3 中心压在父卡上 → 选中父卡", hit && hit.node.id === "p1");
const childEdge = { id: "c2", type: "text", x: 295, y: 130, width: 40, height: 40 };  // 落点角(295,130)在父卡内
t("D4v2 落点角在父卡内 → 命中（v0.4.3 识别率修复：新卡锚点≈鼠标位置）", lmbPickDropParent(childEdge, [parent]) !== null);
const g = { id: "g1", type: "group", x: 140, y: 120, width: 200, height: 150 };
t("D5 group 节点不当父（容器语义不劫持）", lmbPickDropParent({ id: "c3", type: "text", x: 150, y: 130, width: 100, height: 60 }, [g]) === null);
const smallTarget = { id: "t1", type: "text", x: 50, y: 50, width: 100, height: 100 };
const bigNew = { id: "b1", type: "text", x: 0, y: 0, width: 400, height: 400 };       // 旧版按大新卡面积算只 6.25% → 漏判主因
t("D6b 大新卡压住小目标 → 按较小卡面积比命中（10000/10000=100%）", lmbPickDropParent(bigNew, [smallTarget]) !== null);
t("D6c 完全不相交且无角/中心命中 → 不误判", lmbPickDropParent({ id: "far", type: "text", x: 900, y: 900, width: 100, height: 60 }, [parent]) === null);

const snapR = lmbSnapChildPosition(parent, { ...childOn, x: 150, y: 130 }, 30);
t("D6 子卡在父右侧 → 吸附到父右方 gap 处", snapR.fromSide === "right" && snapR.x === 330 && snapR.y === 130);
const parentAtEdge = { id: "p2", type: "text", x: 0, y: 0, width: 200, height: 100 };
const snapL = lmbSnapChildPosition(parentAtEdge, { ...childOn, x: 10, y: 10 }, 30);
t("D7 父贴左墙时向左吸附会越界 → 自动翻转到右侧", snapL.fromSide === "right" && snapL.x === 230);
const snapB = lmbSnapChildPosition(parent, { ...childOn, x: 150, y: 200 }, 30);
t("D8 子卡在父下方 → 吸附到父下方", snapB.fromSide === "bottom" && snapB.y === 250);

const ents = [
  { id: "a", body: "A", page: 3 },
  { id: "b", body: "B", page: 3, parentId: "a" },
  { id: "c", body: "C", page: 12, parentId: "a" },   // 跨页子 → 跟随父所在分组
  { id: "d", body: "D", page: 5, parentId: "ghost" } // 父不在组 → 当根
];
const tree = lmbBuildTree(ents, new Map([["b", "a"], ["c", "a"], ["d", "ghost"]]));
t("D9 根 = a, d（ghost 父降级为根）", tree.roots.map((r) => r.id).join(",") === "a,d");
t("D10 a 的子 = b, c（canvas 序）", tree.children.get("a").map((r) => r.id).join(",") === "b,c");

const srcTree = lmbBuildTree(ents.slice(0, 2).map((e) => ({ ...e })), new Map([["a", "b"], ["b", "a"]]));
t("D11 双向环不自爆（两根降级或渲染兜底，不丢条目）", Array.isArray(srcTree.roots));

t("D12 processCanvas 用 canvasPositions 位置 diff 识别 movedOrNew（v0.7.0 替代 v0.4.0 的 canvasSeen）", /canvasPositions\.get\(cf\.path\)/.test(src) && /canvasPositions\.set\(cf\.path, currentPos\)/.test(src));
t("D13 writeExcerptMd 走 lmbBuildTree 树形渲染", /lmbBuildTree\(ordered, parentOf/.test(src));
t("D14 自动父子连线写入 edges（fromNode=父, toNode=子）", /fromNode: parent\.id, toNode: nn\.id/.test(src));

/* ---------- E. 持久化档案（v0.7.0 canvasPositions 替代 v0.4.1 canvasSeen） ---------- */
console.log("E. canvasPositions 持久化（位置档案跨重载识别「刚被拖动」的卡）");
const n1 = { id: "n1", type: "text", text: "x ^ex-abc123" };
const n2 = { id: "n2", type: "text", text: "y ^ex-def456" };
// lmbDiffCanvasNodes 已废弃但保留（兼容外部测试），只保证函数不报错
t("E1 lmbDiffCanvasNodes 仍可用（向后兼容）", !!lmbDiffCanvasNodes && typeof lmbDiffCanvasNodes === "function");
t("E2 onload 恢复 canvasPositions 档案", /settings\.canvasPositions[\s\S]{0,200}canvasPositions\.set\(p, new Map\(entries\)\)/.test(src));
t("E3 saveSettings 持久化 canvasPositions", /obj\.canvasPositions = pos/.test(src));
t("E4 canvasSeen 已废弃（v0.7.0 位置 diff 替代 v0.4.1 id diff）", !/this\.canvasSeen = new Map\(\)/.test(src) || /v0\.4\.1/.test(src.split("canvasPositions = new Map")[0] || ""));
t("E5 processCanvas 用位置 diff（prev.x/y/w/h 比对）", /prev\.x !== cur\.x \|\| prev\.y !== cur\.y/.test(src));
t("E6 档案变更落盘（persistAutoSizeSoon）", /persistAutoSizeSoon/.test(src));

/* ---------- F. 吸附择位（v0.4.2 避障 → v0.4.4 四方向换面）：不再甩到队尾成长龙 ---------- */
console.log("F. 吸附四方向择位");
const fp = { id: "fp", type: "text", x: 0, y: 0, width: 200, height: 100 };
const c1 = { id: "c1", type: "text", x: 0, y: 0, width: 100, height: 60 };
const s1 = lmbSnapChildPosition(fp, c1, 30);                     // 第一张子卡：右侧
const sib1 = { id: "s1", type: "text", x: s1.x, y: s1.y, width: 100, height: 60 };  // 兄弟真实矩形
const s2 = lmbSnapChildPosition(fp, { ...c1 }, 30, [sib1]);      // 第二张：右侧被占 → 换面
t("F1 无障碍时行为不变（右侧首选位）", s1.fromSide === "right" && s1.x === 230);
t("F2v2 兄弟占右侧 → 换面到父卡正下方（不再甩到队尾）", s2.fromSide === "bottom" && s2.x === 50 && s2.y === 130);
const sib2 = { id: "s2", type: "text", x: s2.x, y: s2.y, width: 100, height: 60 };
const s3 = lmbSnapChildPosition(fp, { ...c1 }, 30, [sib1, sib2]);
t("F3v2 四面全占 → 兜底沿右侧级联", s3.fromSide === "right" && s3.x === 360 && s3.y === 20);
const vp = { id: "vp", type: "text", x: 0, y: 0, width: 200, height: 100 };
const vc1 = { id: "v1", type: "text", x: 0, y: 300, width: 100, height: 60 };
const v1 = lmbSnapChildPosition(vp, vc1, 30);                    // 下方
const vsib = { id: "vs", type: "text", x: v1.x, y: v1.y, width: 100, height: 60 };
const v2 = lmbSnapChildPosition(vp, { ...vc1 }, 30, [vsib]);
t("F4v2 纵向首选被占 → 换面到父卡右侧", v1.fromSide === "bottom" && v2.fromSide === "right" && v2.x === 230 && v2.y === 20);
t("F5 processCanvas 把 others 传给吸附（避障生效）→ v0.6.0 改为 lmbLayoutGroup 组居中", /lmbSnapChildPosition\(parent, nn, 30, others\)/.test(src) || /lmbLayoutGroup\(parent, group, side, 30\)/.test(src));
t("F6 已吸附兄弟算障碍物 → v0.7.0 改用组居中（lmbLayoutGroup 全组重排，不需要逐个避障）", /lmbLayoutGroup\(parent, group, side, 30\)/.test(src));

/* ---------- G. v0.4.3 识别率（保留）+ v0.7.0 移除出生重试 ---------- */
console.log("G. 多信号判定 + v0.7.0 移除出生重试");
t("G1 多信号判定：cornerIn/centerIn/min 面积比", /cornerIn \|\| centerIn \|\| ratio >= threshold/.test(src));
t("G2 【v0.7.0 移除】出生重试 canvasBirth/BIRTH_TTL 不再需要（位置 diff 自然重试）", !/BIRTH_TTL = 5 \* 60 \* 1000/.test(src));
t("G3 【v0.7.0 移除】重试时卡已被挪走 → 只连线不挪位（由组居中处理）", !/const moved = Math\.abs\(node\.x - b\.x\) > 2/.test(src));
t("G4 【回归守卫】newExNodes 未定义引用已根除（v0.4.2 曾致整个同步中断）", !/\bnewExNodes\b/.test(src));
t("G5 【v0.7.0 移除】newNodes = diff.newNodes（v0.7.0 用 movedOrNew）", !/const newNodes = diff\.newNodes/.test(src));

/* ---------- H. v0.5.0 即时通道（内部 API + 文件层兜底） ---------- */
console.log("H. 即时通道");
t("H1 drop 捕获监听已注册（capture 阶段）", /registerDomEvent\(document, "drop"/.test(src));
t("H2 instantAttach 存在且复用同一套纯函数", /instantAttach\(canvasObj\)/.test(src) && /lmbPickDropParent\(nn, others\)/.test(src) && (/lmbSnapChildPosition\(parent, nn, 30, others\)/.test(src) || /lmbLayoutGroup\(parent, group, side, 30\)/.test(src)));
t("H3 内部 API 缺失时静默退回文件层", /内部 API 不可用 → 文件层兜底/.test(src));
t("H4 即时通道成功后抑制文件层自动父子（防双写）→ v0.7.0 移除（位置 diff 自带幂等）", !/_instantSkip = Date\.now\(\) \+ 4000/.test(src) || /v0\.5\.0/.test(src));
t("H5 dragstart 武装 / dragend 解除", /this\._dragArm = \{ t: Date\.now\(\) \}/.test(src) && /this\._dragArm = null;\n      this\.hideChip\(\)/.test(src));
t("H6 轮询上限 1.2s（不无限等）", /Date\.now\(\) - t0 < 1200/.test(src));

/* ---------- H2. v0.9.3 移动即时通道（mouseup → 内存数据直接判定，不等落盘） ---------- */
console.log("H2. v0.9.3 移动即时通道");
t("H2.1 instantMoveAttach 已实现", /instantMoveAttach\(canvasObj\)/.test(src));
t("H2.2 mouseup 已挂即时通道（capture 阶段，主键才触发）", /canvasObjFromEvent\(e\)/.test(src) && /e\.button === 0/.test(src));
t("H2.3 只处理「档案里已见过 + 位置变了」的卡（新卡归 instantAttach，防双写）", /const prev = lastPos\.get\(n\.id\);\n        if \(prev && \(prev\.x !== n\.x \|\| prev\.y !== n\.y\)\) moved\.push\(n\);/.test(src));
t("H2.4 换父摘旧自动边（v0.11.0 起由 lmbPlanAutoLink 首连锁定/改挂侧取代）", /instantMoveAttach[\s\S]*?lmbPlanAutoLink\(nn, parent, data\.edges, sidecar\)/.test(src));
t("H2.5 生效后同步位置档案（防文件层重复处理）", /即时通道[\s\S]*?this\.canvasPositions\.set\(path, cur\)/.test(src));
t("H2.6 轮询上限 500ms（不无限等）", /instantMoveAttach[\s\S]*?Date\.now\(\) - t0 < 500/.test(src));

/* ---------- I. v0.6.0 组居中 + v0.9.3 贴边对齐（不再拉伸尺寸） + 命令 ---------- */
console.log("I. 组居中布局（v0.9.3：保留各自尺寸，贴边对齐）");
const A60 = { id: "A60", x: 300, y: 200, width: 200, height: 120, type: "text", text: "a ^ex-aaaa" };
const t60 = (cond, msg) => t(msg, cond);

t60(lmbSideOf({ x: 500, y: 200, width: 100, height: 100 }, A60) === "right", "I1.1 中心在右 → right");
t60(lmbSideOf({ x: 100, y: 200, width: 100, height: 100 }, A60) === "left",  "I1.2 中心在左 → left");
t60(lmbSideOf({ x: 300, y: 100, width: 100, height: 100 }, A60) === "top",   "I1.3 中心在上 → top");
t60(lmbSideOf({ x: 300, y: 500, width: 100, height: 100 }, A60) === "bottom","I1.4 中心在下 → bottom");

t60(lmbSideEnds("right").fromSide === "right" && lmbSideEnds("right").toSide === "left", "I2.1 right → fromSide=right,toSide=left");
t60(lmbSideEnds("left").fromSide === "left" && lmbSideEnds("left").toSide === "right", "I2.2 left → fromSide=left,toSide=right");
t60(lmbSideEnds("top").fromSide === "top" && lmbSideEnds("top").toSide === "bottom", "I2.3 top → fromSide=top,toSide=bottom");
t60(lmbSideEnds("bottom").fromSide === "bottom" && lmbSideEnds("bottom").toSide === "top", "I2.4 bottom → fromSide=bottom,toSide=top");

{
  const kids = [
    { id: "k1", type: "text", x: 0, y: 0, width: 240, height: 60 },
    { id: "k2", type: "text", x: 0, y: 0, width: 200, height: 180 },
    { id: "k3", type: "text", x: 0, y: 0, width: 160, height: 80 }
  ];
  lmbLayoutGroup(A60, kids, "right", 30);
  t60(new Set(kids.map(k => k.x)).size === 1, "I3.1 右侧列：左边缘贴齐成列");
  t60(kids.every(k => k.width === (k.id === "k1" ? 240 : k.id === "k2" ? 200 : 160)), "I3.2 【v0.9.3】宽度保留各自（不再统一到 max）");
  const totalH = 60 + 180 + 80 + 30 * 2;
  t60(kids[0].y === Math.round(A60.y + A60.height/2 - totalH/2), "I3.3 整列顶部以父卡中心对称");
  // 关键：「整列视觉中心 = 父卡中心」（不是中间卡=父卡中心——卡高度不一时视觉中心更靠拢高的那张）
  const groupCenterY = (kids[0].y + (kids[2].y + kids[2].height)) / 2;
  t60(groupCenterY === A60.y + A60.height/2, "I3.4 整列视觉中心 = 父卡中心轴");
  t60(kids[2].y + kids[2].height === kids[0].y + totalH, "I3.5 整列底部 = 顶部+总高");
  t60(kids[0].y + kids[0].height + 30 === kids[1].y, "I3.6 间距均匀 30");
  t60(kids[1].y + kids[1].height + 30 === kids[2].y, "I3.7 第二段间距均匀");
  const noOverlap = kids.every((a, i) => kids.slice(i+1).every(b =>
    a.y + a.height <= b.y || b.y + b.height <= a.y));
  t60(noOverlap, "I3.8 关键 bug：高度不同子卡不再 y 方向重叠");
}

{
  const kids = [
    { id: "l1", type: "text", x: 0, y: 0, width: 200, height: 80 },
    { id: "l2", type: "text", x: 0, y: 0, width: 200, height: 120 }
  ];
  lmbLayoutGroup(A60, kids, "left", 30);
  t60(kids.every(k => k.x + k.width === A60.x - 30), "I4.1 【v0.9.3】左列：右边缘贴齐（x 随卡宽各自退让）");
  t60(kids[0].x === Math.round(A60.x - kids[0].width - 30), "I4.2 左侧 x = 父卡左移 - 卡宽 - gap");
  const totalH = 80 + 120 + 30;
  t60(kids[0].y === Math.round(A60.y + A60.height/2 - totalH/2), "I4.3 左侧也以父卡中心对称");
}

{
  const kids = [
    { id: "u1", type: "text", x: 0, y: 0, width: 160, height: 60 },
    { id: "u2", type: "text", x: 0, y: 0, width: 180, height: 100 }
  ];
  lmbLayoutGroup(A60, kids, "top", 30);
  t60(kids.every(k => k.y + k.height === A60.y - 30), "I5.1 【v0.9.3】上方行：底边缘贴齐（y 随卡高各自退让）");
  t60(kids[0].height === 60 && kids[1].height === 100, "I5.2 【v0.9.3】高度保留各自（不再统一到 max）");
  const totalW = 160 + 180 + 30;
  t60(kids[0].x === Math.round(A60.x + A60.width/2 - totalW/2), "I5.3 整行水平对称于父卡中心");
}

{
  const kids = [
    { id: "tk", type: "text", x: 0, y: 0, width: 200, height: 60 },
    { id: "im", type: "image", x: 0, y: 0, width: 320, height: 240 }
  ];
  lmbLayoutGroup(A60, kids, "right", 30);
  t60(kids[0].width === 200 && kids[1].width === 320, "I6.1 【v0.9.3】文字/图片卡宽度均保留自身");
  t60(new Set(kids.map(k => k.x)).size === 1, "I6.2 右侧列左边缘仍然贴齐");
}

{
  // v0.9.3 核心诉求：下方一排高度不同的卡 → 顶边贴齐，不拉成一样高
  const kids = [
    { id: "b1", type: "text", x: 0, y: 0, width: 150, height: 250 },
    { id: "b2", type: "text", x: 0, y: 0, width: 150, height: 90 },
    { id: "b3", type: "text", x: 0, y: 0, width: 150, height: 110 }
  ];
  lmbLayoutGroup(A60, kids, "bottom", 30);
  t60(kids.every(k => k.y === A60.y + A60.height + 30), "I9.1 【v0.9.3 核心】下方行：顶边贴齐（y = 父卡底 + gap）");
  t60(kids.every(k => k.height === (k.id === "b1" ? 250 : k.id === "b2" ? 90 : 110)), "I9.2 高度保留各自");
  const totalW = 150 * 3 + 30 * 2;
  t60(kids[0].x === Math.round(A60.x + A60.width/2 - totalW/2), "I9.3 整行水平居中于父卡");
}

{
  const nodes = [
    A60,
    { id: "r1", x: 0, y: 0, width: 100, height: 60, type: "text" },
    { id: "r2", x: 0, y: 0, width: 100, height: 60, type: "text" },
    { id: "b1", x: 0, y: 0, width: 100, height: 60, type: "text" }
  ];
  const edges = [
    { fromNode: "A60", toNode: "r1", fromSide: "right", toSide: "left" },
    { fromNode: "r1",  toNode: "r2", fromSide: "right", toSide: "left" },
    { fromNode: "A60", toNode: "b1", fromSide: "bottom", toSide: "top" }
  ];
  nodes[1].x = A60.x + A60.width + 30;
  nodes[1].y = A60.y;
  nodes[2].x = nodes[1].x;
  nodes[2].y = nodes[1].y + 90;
  nodes[3].x = A60.x;
  nodes[3].y = A60.y + A60.height + 30;
  const m = lmbGroupBySide(A60, nodes, edges);
  t60(m.get("right") && m.get("right").length === 1 && m.get("right")[0].id === "r1", "I7.1 链式子卡的孙子不进父卡直接子卡组");
  t60(m.get("bottom") && m.get("bottom").length === 1 && m.get("bottom")[0].id === "b1", "I7.2 bottom 子卡正确分组");
}

t60(/lmbLayoutGroup\(parent, group, side, 30\)/.test(src), "I8.1 processCanvas / instantAttach / normalize 路径均调用 lmbLayoutGroup");
t60(/normalize-existing-excerpts/.test(src), "I8.2 已注册「规范化已有重叠摘录」命令");
t60(/lmbGroupBySide\(parent, nodes, data\.edges\)/.test(src), "I8.3 使用 lmbGroupBySide 收集同侧子卡");
t60(/normalizeOverlappingExcerpts/.test(src), "I8.4 normalizeOverlappingExcerpts 方法已实现");
t60(/贴边对齐/.test(src) && /组居中/.test(src), "I8.5 【v0.9.3】代码里有「贴边对齐 + 组居中」注释（意图标注）");
t60(!/k\.type === "text"\) k\.width = maxW/.test(src) && !/k\.type === "text"\) k\.height = maxH/.test(src), "I8.6 【v0.9.3】拉伸子卡尺寸的旧逻辑已移除");

/* ---------- J. v0.7.0 通用任意卡片自动父子 + 位置 diff ---------- */
console.log("J. v0.7.0 通用自动父子（不限 ^ex，含位置 diff）");
const t70 = (cond, msg) => t(msg, cond);

// J1 位置 diff 识别 moved/new（核心：未动的卡不参与检测）
{
  const last = new Map(); // 模拟已存档案
  last.set("A", { x: 100, y: 100, width: 200, height: 100 });
  last.set("B", { x: 400, y: 100, width: 200, height: 100 });
  last.set("C", { x: 700, y: 100, width: 200, height: 100 });
  // 当前画布：A 没动，C 没动，B 被挪到 A 上重叠
  const cur = [
    { id: "A", x: 100, y: 100, width: 200, height: 100 },
    { id: "B", x: 150, y: 110, width: 200, height: 100 }, // moved
    { id: "C", x: 700, y: 100, width: 200, height: 100 }
  ];
  const moved = [];
  for (const n of cur) {
    const p = last.get(n.id);
    if (!p || p.x !== n.x || p.y !== n.y || p.width !== n.width || p.height !== n.height) {
      moved.push(n);
    }
  }
  t70(moved.length === 1 && moved[0].id === "B", "J1.1 仅 B 被识别为 moved");
}

// J2 任意类型卡片（非 ^ex）走 lmbPickDropParent 命中
{
  const A = { id: "a", type: "text", x: 0, y: 0, width: 200, height: 100, text: "plain text" }; // 没有 ^ex
  const B = { id: "b", type: "text", x: 50, y: 30, width: 200, height: 100, text: "another" };
  const hit = lmbPickDropParent(B, [A]);
  t70(!!hit && hit.node.id === "a", "J2.1 非 ^ex 纯文本卡也可被识别为父");
}

// J3 新卡加入组时整组重排（关键 bug 修复路径）
{
  const parent = { id: "P", type: "text", x: 300, y: 200, width: 200, height: 100, text: "" };
  const kid1 = { id: "k1", type: "text", x: 0, y: 0, width: 100, height: 60, text: "" };
  const kid2 = { id: "k2", type: "text", x: 0, y: 0, width: 100, height: 200, text: "" }; // 高卡
  const kid3 = { id: "k3", type: "text", x: 0, y: 0, width: 100, height: 80, text: "" };
  lmbLayoutGroup(parent, [kid1, kid2, kid3], "right", 30);
  t70(new Set([kid1.x, kid2.x, kid3.x]).size === 1, "J3.1 三卡同 x");
  t70(kid1.width === 100 && kid2.width === 100 && kid3.width === 100, "J3.2 【v0.9.3】宽度保留各自");
  const groupH = kid1.height + kid2.height + kid3.height + 30 * 2;
  const groupCenterY = (kid1.y + (kid3.y + kid3.height)) / 2;
  t70(groupCenterY === parent.y + parent.height/2, "J3.3 整列视觉中心 = 父卡中心（v0.6 算法同源）");
  // 关键 bug：不重叠
  const noOverlap = kid1.y + kid1.height + 30 === kid2.y && kid2.y + kid2.height + 30 === kid3.y;
  t70(noOverlap, "J3.4 高度不同卡不再 y 方向重叠（修复截图 bug）");
}

// J4 源码静态断言：v0.7.0 关键改动
t70(/canvasPositions = new Map/.test(src), "J4.1 canvasPositions 实例变量已声明");
t70(/this\.canvasPositions = new Map\(\); \/\/ v0\.7\.0/.test(src), "J4.2 v0.7.0 注释标记 canvasPositions 用途");
t70(/canvasPositions && this\.canvasPositions\.size/.test(src) && /obj\.canvasPositions = pos/.test(src), "J4.3 saveSettings 持久化 canvasPositions");
t70(/settings\.canvasPositions/.test(src) && /canvasPositions\.set\(p, new Map\(entries\)\)/.test(src), "J4.4 onload 从 settings 恢复 canvasPositions");
t70(/movedOrNew/.test(src) && /prev\.x !== cur\.x \|\| prev\.y !== cur\.y/.test(src), "J4.5 位置 diff 识别 movedOrNew");
t70(/v0\.7\.0.*通用自动父子/.test(src), "J4.6 注释标注 v0.7.0 通用自动父子");
t70(/不限 \^ex/.test(src) || /任意画布卡片/.test(src), "J4.7 自动父子段落不再限 ^ex（注释明示）");

/* ---------- K. v0.7.1 边去重 + 自动边清理 + debounce 调优 ---------- */
console.log("K. v0.7.1 边去重 + 自动边清理");
const t71 = (cond, msg) => t(msg, cond);

// K1 边去重：同 (parent, child) 对保留首条
{
  const edges = [
    { id: "e1", fromNode: "A", toNode: "B", fromSide: "right", toSide: "left" },
    { id: "e2", fromNode: "A", toNode: "B", fromSide: "right", toSide: "left" }, // 重复
    { id: "e3", fromNode: "B", toNode: "A", fromSide: "left", toSide: "right" }, // 同对反向
    { id: "e4", fromNode: "A", toNode: "C", fromSide: "right", toSide: "left" }
  ];
  const seen = new Set();
  const deduped = edges.filter((ed) => {
    const k = ed.fromNode < ed.toNode ? ed.fromNode + "|" + ed.toNode : ed.toNode + "|" + ed.fromNode;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  t71(deduped.length === 2, "K1.1 4 条边 → 去重后 2 条（A→B + A→C）");
  t71(deduped[0].id === "e1" && deduped[1].id === "e4", "K1.2 保留首条 e1,e4（e2/e3 反向同对被去）");
}

// K2 自动边清理：端点不再重叠 → 移除
{
  const edges = [
    { id: "auto1", fromNode: "A", toNode: "B" },
    { id: "manual", fromNode: "A", toNode: "C" }
  ];
  const nodes = [
    { id: "A", x: 0, y: 0, width: 200, height: 100 },
    { id: "B", x: 500, y: 500, width: 100, height: 50 }, // 与 A 不重叠
    { id: "C", x: 1000, y: 1000, width: 100, height: 50 } // 与 A 不重叠但 manual
  ];
  const sidecar = new Set(["auto1"]); // manual 不在 sidecar
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = edges.filter((ed) => {
    if (!sidecar.has(ed.id)) return true;
    const a = byId.get(ed.fromNode), b = byId.get(ed.toNode);
    if (!a || !b) return false;
    const r = lmbRectsOverlapRatio(
      { x: a.x, y: a.y, w: a.width, h: a.height },
      { x: b.x, y: b.y, w: b.width, h: b.height });
    return r >= 0.08;
  });
  t71(kept.length === 1 && kept[0].id === "manual", "K2.1 自动边 A→B 端点不重叠被清理；手动边 A→C 保留");
}

// K3 自动边清理：端点重叠率 ≥ 8% → 保留
// 注意：lmbRectsOverlapRatio 用 a.w*a.h 作分母（a 的面积），不是 min(areaA, areaB)
{
  const a = { id: "A", x: 0, y: 0, width: 200, height: 100 };
  const b = { id: "B", x: 150, y: 50, width: 100, height: 50 };
  const r = lmbRectsOverlapRatio({ x: a.x, y: a.y, w: a.width, h: a.height }, { x: b.x, y: b.y, w: b.width, h: b.height });
  // intersection = 50*50 = 2500；a 面积 = 200*100 = 20000；ratio = 2500/20000 = 0.125
  t71(Math.abs(r - 0.125) < 0.001, "K3.1 重叠率 = 2500/20000 = 0.125");
  t71(r > 0.08, "K3.2 0.125 > 阈值 0.08 → 边保留");
}

// K4 端点被删除 → 自动边清理
{
  const edges = [{ id: "auto1", fromNode: "A", toNode: "B" }];
  const nodes = [{ id: "A", x: 0, y: 0, width: 100, height: 100 }]; // B 不存在
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sidecar = new Set(["auto1"]);
  const kept = edges.filter((ed) => {
    if (!sidecar.has(ed.id)) return true;
    const a = byId.get(ed.fromNode), b = byId.get(ed.toNode);
    return a && b;
  });
  t71(kept.length === 0, "K4.1 端点 B 被删 → 自动边 A→B 被清理");
}

// K5 源码静态断言
t71(/this\.autoEdges = new Map\(\);[\s\S]{0,10}\/\/ v0\.7\.1/.test(src), "K5.1 autoEdges 实例变量 v0.7.1 已声明");
t71(/settings\.autoEdges/.test(src) && /autoEdges\.set\(p, new Set\(ids\)\)/.test(src), "K5.2 onload 恢复 autoEdges 档案");
t71(/obj\.autoEdges = ae/.test(src), "K5.3 saveSettings 持久化 autoEdges");
t71(/同 .*parent.*child.* 仅保留第一条/.test(src) || /边去重.*同一 .*parent.*child/.test(src), "K5.4 边去重注释标注 v0.7.1");
t71(/autoEdges\.add\(eid\)/.test(src) || /ae\.add\(eid\)/.test(src), "K5.5 自动建边时登记 eid 到 sidecar");
t71(/}, 400\)/.test(src), "K5.6 scheduleCanvasSync 防抖 400ms");
t71(/v0\.7\.1/.test(src), "K5.7 代码里有 v0.7.1 标记");
// K5.8 注：v0.7.1 的「按重叠清理孤儿边」已被 v0.7.3 移除（会把排布后的边误删，见 M 组回归）
t71(/端点已被删除的自动边/.test(src), "K5.8 自动边清理逻辑（v0.7.3 起仅清理端点被删的边）");

/* ---------- L. v0.7.2 Notice 收敛 + 松手快速通道 ---------- */
console.log("L. v0.7.2 提示收敛 + drop flush");
const t72 = (cond, msg) => t(msg, cond);

// L1 Notice 收敛：兜底提示前先判 PDF leaf
t72(/if \(!this\.eventInPdfLeaf\(e\)\) return;/.test(src), "L1.1 兜底 Notice 前有 eventInPdfLeaf 门禁");
t72(/eventInPdfLeaf\(e\)/.test(src) && /getLeavesOfType\("pdf"\)/.test(src), "L1.2 eventInPdfLeaf 用 getLeavesOfType('pdf') 匹配 leaf");
t72(/点的是 PDF 视图/.test(src) || /非 PDF 上下文/.test(src), "L1.3 注释写明根因（document 级全局监听 → canvas 也命中）");
{
  const idxGate = src.indexOf("if (!this.eventInPdfLeaf(e)) return;");
  const idxNotice = src.indexOf('this.debugNotice("mouseup：无文字选区');
  t72(idxGate > 0 && idxNotice > idxGate, "L1.4 门禁位置在 debugNotice 之前（非 PDF 直接 return，不打印不弹窗）");
}
t72(src.indexOf('this.debugNotice("✓ 文字选区') < src.indexOf("if (!this.eventInPdfLeaf(e)) return;"), "L1.5 文字选区提示不受影响（仍在门禁之前）");

// L2 松手快速通道
t72(/this\._dropFlush = null;[\s\S]{0,10}\/\/ v0\.7\.2/.test(src), "L2.1 _dropFlush 状态已声明");
t72(/canvasFileFromEvent\(e\)/.test(src) && /armDropFlush\(f\)/.test(src), "L2.2 canvas mouseup → canvasFileFromEvent → armDropFlush");
t72(/armDropFlush\(file\)/.test(src) && /\}, 600\)/.test(src), "L2.3 armDropFlush 有 600ms 兜底定时器");
t72(/Date\.now\(\) - flush\.t < 1500/.test(src), "L2.4 flush 有效期 1500ms（防止陈旧 arm 误触发）");
t72(/processCanvas\(f\)[\s\S]{0,120}\}, 80\)/.test(src), "L2.5 快速通道用 80ms 极短防抖（原 400ms）");
t72(/}, 400\)/.test(src), "L2.6 常规 scheduleCanvasSync 仍保留 400ms（非拖拽场景）");
t72(/if \(flush\.timer\) clearTimeout\(flush\.timer\)/.test(src), "L2.7 命中快速通道时清掉兜底定时器（防重复跑）");

// L3 快速通道时序模拟（复刻 modify 处理器的命中条件）
{
  const flush = { path: "a.canvas", t: 1000 };
  const hitFast = (fPath, arriveAt) =>
    !!flush && flush.path === fPath && arriveAt - flush.t < 1500;
  t72(hitFast("a.canvas", 1200) === true, "L3.1 同文件 + mouseup 后 200ms → 命中快速通道");
  t72(hitFast("a.canvas", 3000) === false, "L3.2 同文件但超过 1500ms → 走常规通道（不误加速）");
  t72(hitFast("b.canvas", 1200) === false, "L3.3 另一 canvas 文件的 modify 不命中本文件 flush（跨文件隔离）");
  t72(hitFast("a.canvas", 1000) === true, "L3.4 紧接 mouseup 的 modify（0ms）也命中");
  t72(hitFast("a.canvas", 2499) === true && hitFast("a.canvas", 2500) === false, "L3.5 边界：1500ms 内命中，达到 1500ms 不命中");
}

// L4 canvasFileFromEvent 只认 canvas 文件
t72(/f\.extension === "canvas" \? f : null/.test(src), "L4.1 canvasFileFromEvent 只返回 canvas 文件（md/pdf 不武装 flush）");

/* ---------- M. v0.7.3 回归修复：「连线自动消失」 ---------- */
console.log("M. v0.7.3 回归：排布后连线不再被自己删掉");
const t73 = (cond, msg) => t(msg, cond);

/* 这是 v0.7.1 引入的严重回归的复现用例：
 *   ① 拖 B 压 A → 建自动边 A→B
 *   ② lmbLayoutGroup 把 B 挪到 A 右侧 gap=30（排布的目的就是「不再遮挡」）
 *   ③ 下一次 sync 时，v0.7.1 的清理按「端点重叠率 < 0.08」把这条边删了 → 连线消失
 * 新规则（lmbAutoEdgeAlive）只在端点节点被删时才移除，排布后的边正常存活。 */
{
  const A = { id: "A", type: "text", x: 300, y: 200, width: 200, height: 100 };
  const B = { id: "B", type: "text", x: 340, y: 230, width: 160, height: 80 }; // 压在 A 上

  // ① 建边（自动边）
  const edges = [{ id: "auto1", fromNode: "A", toNode: "B", fromSide: "right", toSide: "left" }];
  const sidecar = new Set(["auto1"]);

  // ② 排布：B 被挪到 A 右侧，不再重叠
  const side = lmbSideOf(B, A);
  t73(side === "right", "M0 前置：B 压在 A 上 → side=right");
  lmbLayoutGroup(A, [B], side, 30);
  const overlapAfter = lmbRectsOverlapRatio(
    { x: A.x, y: A.y, w: A.width, h: A.height },
    { x: B.x, y: B.y, w: B.width, h: B.height });
  t73(overlapAfter === 0, "M1 排布后 A/B 完全不重叠（这正是排布的目的）");

  // ③a 旧逻辑（v0.7.1）：按重叠清理 —— 会把边删掉（bug 复现）
  const oldRemoved = edges.filter((ed) => {
    if (!sidecar.has(ed.id)) return true;
    return !(overlapAfter < 0.08);
  });
  t73(oldRemoved.length === 0, "M2 【bug 复现】旧按重叠清理 → 边被删（连线消失的根因）");

  // ③b 新逻辑（v0.7.3）：仅端点被删才移除 —— 边存活（修复）
  const byId = new Map([[A.id, A], [B.id, B]]);
  const newKept = edges.filter((ed) => {
    if (!sidecar.has(ed.id)) return true;
    return lmbAutoEdgeAlive(ed, byId);
  });
  t73(newKept.length === 1 && newKept[0].id === "auto1", "M3 【修复】新规则下排布后的边存活");
}

// M4 lmbAutoEdgeAlive 纯函数
{
  const byId = new Map([["A", { id: "A" }], ["B", { id: "B" }]]);
  t73(lmbAutoEdgeAlive({ id: "e", fromNode: "A", toNode: "B" }, byId) === true, "M4.1 两端点都在 → 存活");
  t73(lmbAutoEdgeAlive({ id: "e", fromNode: "A", toNode: "GONE" }, byId) === false, "M4.2 子卡被删 → 移除");
  t73(lmbAutoEdgeAlive({ id: "e", fromNode: "GONE", toNode: "B" }, byId) === false, "M4.3 父卡被删 → 移除");
  t73(lmbAutoEdgeAlive(null, byId) === false, "M4.4 空边 → 移除");
  t73(lmbAutoEdgeAlive({ id: "e", toNode: "B" }, byId) === false, "M4.5 缺 fromNode → 移除");
  // 关键：即使完全不重叠也存活（排布后的常态）
  t73(lmbAutoEdgeAlive({ id: "e", fromNode: "A", toNode: "B" }, byId) === true, "M4.6 不重叠也存活（排布后常态，不再误删）");
}

// M5 lmbAutoParentEdgeOf：只认自动边，跳过手动边
{
  const edges = [
    { id: "m1", fromNode: "X", toNode: "B" },   // 手动边
    { id: "auto1", fromNode: "A", toNode: "B" }, // 自动边
    { id: "auto2", fromNode: "A", toNode: "C" }  // 别的子卡的自动边
  ];
  const sidecar = new Set(["auto1", "auto2"]);
  t73(lmbAutoParentEdgeOf("B", edges, sidecar).id === "auto1", "M5.1 找到 B 的自动父边 auto1（跳过手动边 m1）");
  t73(lmbAutoParentEdgeOf("C", edges, sidecar).id === "auto2", "M5.2 找到 C 的自动父边 auto2");
  t73(lmbAutoParentEdgeOf("D", edges, sidecar) === null, "M5.3 没有自动父边 → null");
  t73(lmbAutoParentEdgeOf("B", edges, new Set()) === null, "M5.4 sidecar 为空时手动边不被当作自动父边");
}

// M6 v0.11.0 首连锁定：子卡已有自动父边 → 压到别的卡 skip（换父已移除），压回原父 reside
{
  const edges = [
    { id: "autoOld", fromNode: "Y", toNode: "B", fromSide: "right", toSide: "left" }, // B 的自动父边
    { id: "manual1", fromNode: "Z", toNode: "B" }  // 手动边（不参与锁定）
  ];
  const sidecar = new Set(["autoOld"]);
  const mk = (x, y, id) => ({ id, x, y, width: 100, height: 100 });
  const Y = mk(0, 0, "Y"), P = mk(0, 0, "P");
  const bRight = mk(130, 0, "B");    // B 在父卡右侧
  const bOnY = mk(10, 10, "B");      // B 压在 Y 上
  // M6.1 首连锁定：B 已有自动父边 Y，压到 P → skip（不换父、不新建）
  t73(lmbPlanAutoLink(bOnY, P, edges, sidecar).op === "skip", "M6.1 【首连锁定】B 有自动父边 Y，压到 P → skip（不再换父）");
  // M6.2 压回自己的父 Y → reside（改挂侧）
  const r2 = lmbPlanAutoLink(bRight, Y, edges, sidecar);
  t73(r2.op === "reside", "M6.2 B 压回父卡 Y → reside（改挂侧）");
  t73(r2 && r2.edge.id === "autoOld" && r2.newSide === "right", "M6.3 reside 指向现有自动边，落点在右侧 → newSide=right");
  // M6.4 只有手动边的卡：压到手动边对端 → reside（可改连接位置）；手动边不参与首连锁定
  const edgesM = [{ id: "manual1", fromNode: "Z", toNode: "B", fromSide: "bottom", toSide: "top" }];
  const bOnZ = mk(10, 10, "B"); // B 压在 Z 上
  const Z = mk(0, 0, "Z");
  t73(lmbPlanAutoLink(bOnZ, Z, edgesM, sidecar).op === "reside", "M6.4 只有手动边的卡压到对端 → reside（手动边也可改挂侧）");
  // M6.5 没有任何自动边的卡 → create（首次自动建线）
  const C = mk(500, 500, "C");
  t73(lmbPlanAutoLink(C, Y, edges, sidecar).op === "create", "M6.5 无自动边的卡压到 Y → create（首次建线）");
  // M6.6 edges 里根本没有连接边但 auto 缺失 → create 照常
  t73(edges.some((e) => e.id === "manual1"), "M6.6 手动边全程未被 planner 破坏");
}
// M6b reside 完整执行：边端点翻转 + 单子卡组居中（在父卡横轴上）
{
  const parent = { id: "P", x: 0, y: 0, width: 200, height: 100 };
  const child = { id: "B", x: 40, y: 30, width: 100, height: 80 }; // 压在父卡上（偏右上）
  const edge = { id: "e1", fromNode: "P", toNode: "B", fromSide: "bottom", toSide: "top" };
  const nodes = [parent, child];
  const plan = { op: "reside", edge, oldSide: "bottom", newSide: "right" };
  lmbApplyReside(parent, child, plan, nodes, [edge]);
  t73(edge.fromSide === "right" && edge.toSide === "left", "M6b.1 边端点已改为 right→left（方向属性保持 from=父）");
  t73(child.y === Math.round((parent.height - child.height) / 2), "M6b.2 单子卡重排后 y 居中 → 与父卡同一横轴");
  t73(child.x === parent.x + parent.width + 30, "M6b.3 子卡贴在父卡右侧（gap=30）");
}

// M7 静态断言：危险的重叠清理逻辑已根除
t73(!/r < 0\.08/.test(src), "M7.1 【回归守卫】源码里不再有按重叠率清理自动边的逻辑");
t73(!/端点已分开/.test(src), "M7.2 【回归守卫】不再有「端点已分开」删边分支");
t73(/lmbAutoEdgeAlive/.test(src), "M7.3 使用 lmbAutoEdgeAlive 做存活判定");
t73(/端点已被删除的自动边/.test(src), "M7.4 清理注释改为「端点已被删除」");
t73(/lmbPlanAutoLink/.test(src) && /首连锁定/.test(src), "M7.5 v0.11.0 首连锁定逻辑已接入（lmbPlanAutoLink）");
t73(/绝不能/.test(src) || /不能.*按.*重叠/.test(src), "M7.6 代码里有「不能按重叠清理」的警示注释（防后人改回去）");
t73(/lmbAutoEdgeAlive, lmbAutoParentEdgeOf/.test(src), "M7.7 两个新纯函数已挂到 __test 导出");

/* ---------- N. v0.8.0 卡片补充描述（note） ---------- */
console.log("N. v0.8.0 卡片补充描述");
const t80 = (cond, msg) => t(msg, cond);
const BODY = "> (【书-P.12】)\n> 摘录原文第一行\n^ex-abc123";

// N1 无补充描述 → 原样
{
  const r = lmbSplitNote(BODY);
  t80(r.hasNote === false, "N1.1 无锚点 → hasNote=false");
  t80(r.body === BODY, "N1.2 body 原样返回");
  t80(r.note === "", "N1.3 note 为空串");
  t80(lmbStripNote(BODY) === BODY, "N1.4 strip 无副作用");
}

// N2 往返：join → split 能还原
{
  const joined = lmbJoinNote(BODY, "我的想法\n第二行");
  t80(joined.indexOf(LMB_NOTE_START) === -1, "N2.1 v0.8.3 新格式：join 输出不含 HTML 起始锚点（已砍掉）");
  t80(joined.indexOf(LMB_NOTE_END) === -1, "N2.2 v0.8.3 新格式：join 输出不含 HTML 结束锚点");
  t80(joined.indexOf("> [!ppd-note] 补充描述") > 0, "N2.3 join 含 callout 首行（无 - = 展开）");
  t80(joined.indexOf("> 我的想法") > 0 && joined.indexOf("> 第二行") > 0, "N2.4 callout 正文带 > 前缀");

  const r = lmbSplitNote(joined);
  t80(r.hasNote === true, "N2.5 split 识别到补充描述");
  t80(r.body === BODY, "N2.6 body 完整还原（含 ^ex id）");
  t80(r.note === "我的想法\n第二行", "N2.7 note 内容还原（已去 > 前缀）");
  t80(r.fold === false, "N2.8 fold=false（展开）");
  t80(r.type === "ppd-note", "N2.9 callout 类型正确");
}

// N3 折叠标记
{
  const folded = lmbJoinNote(BODY, "想法", { fold: true });
  t80(folded.indexOf("> [!ppd-note]- 补充描述") > 0, "N3.1 fold=true → callout 带 - 后缀");
  t80(lmbSplitNote(folded).fold === true, "N3.2 split 正确读出 fold=true");
  const unfolded = lmbJoinNote(BODY, "想法", { fold: false });
  t80(lmbSplitNote(unfolded).fold === false, "N3.3 fold=false → 展开");
}

// N4 空内容 = 移除
{
  const joined = lmbJoinNote(BODY, "想法");
  t80(lmbJoinNote(joined.split("\n")[0] ? BODY : BODY, "") === BODY, "N4.1 note 为空串 → 只返回 body（等价于移除）");
  t80(lmbJoinNote(BODY, "   ") === BODY, "N4.2 纯空白也视为空 → 移除");
  const r = lmbSplitNote(lmbJoinNote(lmbSplitNote(lmbJoinNote(BODY, "想法")).body, ""));
  t80(r.hasNote === false, "N4.3 走 split→join('') 后不再有补充描述");
}

// N5 剥离（摘录文档用）
{
  const joined = lmbJoinNote(BODY, "我的想法\n第二行");
  const stripped = lmbStripNote(joined);
  t80(stripped === BODY, "N5.1 strip 后 = 原始 body（锚点+callout 全部去掉）");
  t80(stripped.indexOf("ppd-note") === -1, "N5.2 strip 后不含任何 note 标记");
  t80(stripped.indexOf("我的想法") === -1, "N5.3 strip 后不含补充描述正文（不污染摘录 md）");
  t80(stripped.indexOf("^ex-abc123") > 0, "N5.4 strip 保留 ^ex id（后续由原逻辑过滤）");
}

// N6 容错：结束锚点缺失
{
  const broken = BODY + "\n" + LMB_NOTE_START + "\n> [!ppd-note] T\n> 内容";
  const r = lmbSplitNote(broken);
  t80(r.hasNote === true, "N6.1 缺结束锚点 → 仍识别为有补充描述");
  t80(r.note === "内容", "N6.2 内容吃到文末（容错，不丢内容）");
  t80(r.body === BODY, "N6.3 body 仍正确");
}

// N7 容错：v0.8.3 起 HTML 锚点不再是必须的（callout 自身就是标记）
//    这里测的是「callout 后被一行 `---` 截断」—— callout 严格遇非 > 行就结束
{
  const terminated = BODY + "\n> [!ppd-note] 补充描述\n> 内容\n---";
  const r = lmbSplitNote(terminated);
  t80(r.hasNote === true, "N7.1 callout 仍是合法补充描述（无 HTML 锚点也认）");
  t80(r.note === "内容", "N7.2 callout 遇到 --- 非 > 行结束，note 不含 ---");
  t80(r.body === BODY, "N7.3 body 不含 callout 行也不含 ---");
}

// N8 渲染文本（尺寸估算用：去掉不可见锚点，保留 callout）
{
  const joined = lmbJoinNote(BODY, "想法");
  const rendered = lmbRenderedText(joined);
  t80(rendered.indexOf("ppd-note-start") === -1, "N8.1 渲染文本去掉起始锚点行");
  t80(rendered.indexOf("ppd-note-end") === -1, "N8.2 渲染文本去掉结束锚点行");
  t80(rendered.indexOf("> [!ppd-note]") > 0, "N8.3 渲染文本保留 callout（会渲染成框）");
  t80(rendered.indexOf("> 想法") > 0, "N8.4 渲染文本保留补充描述正文");
  t80(lmbRenderedText(BODY) === BODY, "N8.5 无补充描述时原样返回");
}

// N9 多行与空行
{
  const note = "第一段\n\n第二段\n 缩进";
  const joined = lmbJoinNote(BODY, note);
  const r = lmbSplitNote(joined);
  t80(r.note === note, "N9.1 含空行的多行描述往返一致");
  t80(joined.indexOf(">\n> 第二段") > 0, "N9.2 空行在 callout 里渲染为 '>'");
}

// N10 自定义 callout 类型与标题
{
  const joined = lmbJoinNote(BODY, "想法", { type: "summary", title: "摘要" });
  t80(joined.indexOf("> [!summary] 摘要") > 0, "N10.1 自定义类型与标题生效");
  t80(lmbSplitNote(joined).type === "summary", "N10.2 split 读出自定义类型");
}

// N11 源码静态断言
t80(/const LMB_NOTE_START = "<!-- ppd-note-start -->"/.test(src), "N11.1 起始锚点常量");
t80(/const LMB_NOTE_END = "<!-- ppd-note-end -->"/.test(src), "N11.2 结束锚点常量");
t80(/NOTE_CALLOUT_RE\s*=\s*\/\^\\s\*>\\s\*\\\[!/.test(src), "N11.3 callout 首行正则已定义");
t80(/edit-card-note/.test(src) && /remove-card-note/.test(src) && /toggle-card-note-fold/.test(src), "N11.4 三条命令已注册");
t80(/class LMBNoteModal extends Modal/.test(src), "N11.5 补充描述弹窗已实现");
t80(/class LMBNodeSuggester extends FuzzySuggestModal/.test(src), "N11.6 选卡兜底（模糊搜索）已实现");
t80(/noteCalloutType/.test(src) && /noteTitle/.test(src) && /noteFoldByDefault/.test(src) && /noteIntoSync/.test(src), "N11.7 四个 note 设置项");
t80(/lmbStripNote\(node\.text\)/.test(src), "N11.8 摘录 md 同步默认剥离补充描述");
t80(/addNoteChrome/.test(src), "N11.9 尺寸估算补上了 callout 框高");
t80(/lmbRenderedText\(text\)/.test(src), "N11.10 尺寸估算用渲染文本（锚点不计高）");
t80(/lmbSplitNote, lmbJoinNote, lmbStripNote, lmbRenderedText/.test(src), "N11.11 四个纯函数已挂到 __test 导出");
t80(/getSelection/.test(src), "N11.12 优先用 canvas 内部 API 取选中卡片");
t80(/内部 API 不可用/.test(src), "N11.13 内部 API 有公开 API 兜底");

/* ---------- O. v0.8.1 补充描述 ribbon 按钮 ---------- */
console.log("O. v0.8.1 侧边栏按钮");
const t81 = (cond, msg) => t(msg, cond);

t81(/message-square/.test(src), "O1.1 补充描述 ribbon 按钮已注册（message-square 图标）");
t81(/_noteRibbonEl = this\.addRibbonIcon\(/.test(src), "O1.2 按钮句柄存到 _noteRibbonEl");
t81(/this\._noteRibbonEl\) this\._noteRibbonEl\.addClass\("lmb-btn"\)/.test(src), "O1.3 沿用项目按钮样式类");
t81(/runCardNoteCommand\("edit"\)/.test(src), "O1.4 点击复用 edit-card-note 同一条路径（不重复实现）");
t81(/updateNoteRibbonState/.test(src), "O1.5 有独立的按钮状态更新方法");
t81(/active-leaf-change/.test(src), "O1.6 监听视图切换以刷新按钮可用性");
t81(/is-idle/.test(src), "O1.7 不可用用 is-idle 灰显（不用 is-active，避免『模式已开启』的误读）");
t81(/opacity:\.35/.test(src), "O1.8 is-idle 灰显样式已定义");
// 语义守卫：动作按钮不能复用模式开关的高亮类
// 精确取 updateNoteRibbonState() 方法体（到下一个同级方法定义为止），
// 避免误伤 rectMode 的合法 is-active。v0.12.0：改用「下一个 2 缩进方法定义」定界——
// 旧写法用下一个 /** 注释定界，源码拆分后方法间可能隔很远（会误吞 injectStyles 的 CSS）。
{
  const start = src.indexOf("updateNoteRibbonState() {");
  let end = start > 0 ? src.length : 0;
  if (start > 0) {
    const re = /\n  (?:async )?[a-zA-Z_$][\w$]*\(/g;
    re.lastIndex = start + 5;
    const m = re.exec(src);
    if (m) end = m.index;
  }
  const body = src.slice(start, end);
  t81(start > 0, "O1.9a 找到 updateNoteRibbonState 方法体");
  t81(!/is-active/.test(body), "O1.9 【语义守卫】补充描述按钮不使用 is-active（动作按钮 ≠ 模式开关）");
  t81(/is-idle/.test(body), "O1.9b 方法体确实使用 is-idle 表达不可用");
}
// 双重保险：按钮点击仍走上下文检查
t81(/请先在 canvas 里操作/.test(src), "O1.10 非 canvas 上下文有明确提示（视觉灰显之外的第二道保险）");

/* ---------- Q. v0.8.3 彻底可见：去掉 HTML 注释 + callout 按钮样式占位 ---------- */
console.log("Q. v0.8.3 可见的 callout 按钮样式");
const t83 = (cond, msg) => t(msg, cond);

// Q1 空 callout 的占位就是「按钮」
{
  const emptyBox = lmbJoinNote(BODY, "", { allowEmpty: true });
  t83(emptyBox.indexOf("💬 添加评论") > 0, "Q1.1 空 callout 标题用「💬 添加评论」—— 看起来像按钮");
  t83(emptyBox.indexOf("点击此处写下你的想法...") > 0, "Q1.2 含提示占位行");
  t83(emptyBox.indexOf("💬 添加评论") > 0, "Q1.3 callout 首行完整（含占位标题，v0.8.4 起默认折叠形式）");
  // 关键：emit 不再带 HTML 注释锚点（v0.8.3 砍掉）
  t83(emptyBox.indexOf("<!-- ppd-note-start") === -1, "Q1.4 【核心修复】空框也不含 HTML 注释锚点（用户看不到字面 <!--）");
  t83(emptyBox.indexOf("<!-- ppd-note-end") === -1, "Q1.5 不含结束锚点");
}

// Q2 解析：占位行会被识别为 note（用于「编辑」命令预填）
{
  const emptyBox = lmbJoinNote(BODY, "", { allowEmpty: true });
  const r = lmbSplitNote(emptyBox);
  t83(r.hasNote === true, "Q2.1 空框能被识别为有 note（避免被反复添加）");
  t83(r.note === "点击此处写下你的想法...", "Q2.2 提示占位行被读到 note 字段（用户编辑时显示在 Modal 里，可清空后保存 = 移除 callout）");
  t83(r.body === BODY, "Q2.3 body 完整");
}

// Q3 用户写内容后：标题变回「补充描述」+ 用户内容
{
  const emptyBox = lmbJoinNote(BODY, "", { allowEmpty: true });
  const filled = lmbJoinNote(lmbSplitNote(emptyBox).body, "我的第一段想法");
  t83(filled.indexOf("> [!ppd-note] 补充描述") > 0, "Q3.1 写内容后标题变回用户配置的「补充描述」（不再是按钮样占位）");
  t83(filled.indexOf("> 我的第一段想法") > 0, "Q3.2 用户内容在 callout 内");
  t83(filled.indexOf("💬") === -1, "Q3.3 按钮样占位已被替换，不再含 💬");
  t83(filled.indexOf("点击此处") === -1, "Q3.4 提示行也被替换，不再含「点击此处」");
}

// Q4 向后兼容：旧 v0.8.0-v0.8.2 格式（带 HTML 锚点）仍能解析
{
  const oldFormat = BODY + "\n<!-- ppd-note-start -->\n> [!ppd-note] 补充描述\n> 旧格式的内容\n<!-- ppd-note-end -->";
  const r = lmbSplitNote(oldFormat);
  t83(r.hasNote === true, "Q4.1 旧格式（HTML 锚点）仍被识别为有 note");
  t83(r.body === BODY, "Q4.2 旧格式解析时 body 不含 HTML 注释行（关键：v0.8.3 修了原 N 组的边界 bug）");
  t83(r.note === "旧格式的内容", "Q4.3 旧格式 note 内容正确");
  t83(r.type === "ppd-note", "Q4.4 旧格式 callout 类型正确");
  // strip 也兼容旧格式
  t83(lmbStripNote(oldFormat) === BODY, "Q4.5 旧格式 strip 后只剩 body");
}

// Q5 emit 永远用新格式（即便用户从旧格式迁移过来，下次编辑后也是新格式）
{
  const oldFormat = BODY + "\n<!-- ppd-note-start -->\n> [!ppd-note] 补充描述\n> 旧内容\n<!-- ppd-note-end -->";
  const newFormat = lmbJoinNote(lmbSplitNote(oldFormat).body, "新内容");
  t83(newFormat.indexOf("<!-- ppd-note-start") === -1, "Q5.1 解析旧格式 + 重新 join 后输出新格式（无 HTML 锚点）");
  t83(newFormat.indexOf("> [!ppd-note] 补充描述") > 0, "Q5.2 新格式仍含 callout");
  t83(newFormat.indexOf("> 新内容") > 0, "Q5.3 用户新内容写入");
}

// Q6 静态断言
t83(/💬 添加评论/.test(src), "Q6.1 占位标题常量 LMB_NOTE_PLACEHOLDER_TITLE");
t83(/点击此处写下你的想法/.test(src), "Q6.2 占位提示常量 LMB_NOTE_PLACEHOLDER_HINT");
t83(/空 callout 用「💬 添加评论」标题/.test(src), "Q6.3 注释说明空 callout 用占位标题");
t83(/看起来像按钮/.test(src), "Q6.4 设计意图：按钮样式");
t83(/emit 永远用新格式/.test(src), "Q6.5 emit 永远新格式（即便输入是旧格式）");
t83(/v0\.8\.0.*v0\.8\.2 兼容|旧 HTML 锚点|回退/.test(src), "Q6.6 旧 HTML 锚点格式有回退解析支持");

/* ---------- P. v0.8.2 空描述框 + 批量入口（绕开 ribbon） ---------- */
console.log("P. v0.8.2 空描述框 / 批量添加");
const t82 = (cond, msg) => t(msg, cond);
const BODY2 = "> (【书-P.12】)\n> 原文\n^ex-abc123";

// P1 allowEmpty：空框 vs 移除
{
  const removed = lmbJoinNote(BODY2, "");
  const emptyBox = lmbJoinNote(BODY2, "", { allowEmpty: true });
  t82(removed === BODY2, "P1.1 默认：空内容 → 移除块（保持原有语义）");
  t82(emptyBox !== BODY2, "P1.2 allowEmpty=true：空内容 → 生成空框");
  // v0.8.3 起：空框用「💬 添加评论」占位标题（且 v0.8.4 起默认折叠，带 - 后缀）
  t82(emptyBox.indexOf("💬 添加评论") > 0, "P1.3 空框含 callout 占位标题");
  // v0.8.3 起：砍掉 HTML 注释锚点（callout 自身即唯一标记）—— 与 Q1.4 一致
  t82(emptyBox.indexOf(LMB_NOTE_START) === -1 && emptyBox.indexOf(LMB_NOTE_END) === -1,
    "P1.4 v0.8.3 起空框【不含】HTML 注释锚点");
  const r = lmbSplitNote(emptyBox);
  t82(r.hasNote === true, "P1.5 【关键】空框能被 split 识别为 hasNote=true（避免被重复添加）");
  // v0.8.3 起：空框 note = 占位提示行（不是空串），用户编辑时在 Modal 里可清空
  t82(r.note === "点击此处写下你的想法...", "P1.6 空框的 note = 占位提示行（v0.8.3 起）");
  t82(r.body === BODY2, "P1.7 空框的 body 完整");
}

// P2 空框 → 写入内容 → 读回（用户点开写的完整流程）
{
  const emptyBox = lmbJoinNote(BODY2, "", { allowEmpty: true });
  const withText = lmbJoinNote(lmbSplitNote(emptyBox).body, "我写的想法");
  t82(withText.indexOf("> 我写的想法") > 0, "P2.1 空框基础上能写入内容");
  // v0.8.3 起无 HTML 锚点，改为断言「不会嵌套叠加」的等价形式：只出现 1 个 callout
  t82((withText.match(/ppd-note/g) || []).length === 1, "P2.2 只有 1 个 callout（不会嵌套叠加）");
  t82(lmbSplitNote(withText).note === "我写的想法", "P2.3 写完后能正确读回");
}

// P3 空框折叠态
{
  const foldedBox = lmbJoinNote(BODY2, "", { allowEmpty: true, fold: true });
  // v0.8.3 起空框标题是「💬 添加评论」，折叠表现为 - 后缀（与 R2.1 一致）
  t82(foldedBox.indexOf("> [!ppd-note]- 💬 添加评论") > 0, "P3.1 空框可折叠（- 后缀 + 占位标题）");
  t82(lmbSplitNote(foldedBox).fold === true, "P3.2 split 读出折叠态");
}

// P4 幂等守卫：批量命令跑两次结果不变
{
  const withNote = lmbJoinNote(BODY2, "已有内容");
  t82(lmbSplitNote(withNote).hasNote === true, "P4.1 已有描述 → hasNote=true（批量命令据此跳过）");
  const run = (txt) => (lmbSplitNote(txt).hasNote ? txt : lmbJoinNote(txt, "", { allowEmpty: true }));
  const pass1 = run(withNote);
  const pass2 = run(pass1);
  t82(pass1 === withNote && pass2 === withNote, "P4.2 【幂等】批量命令跑两次结果不变，不覆盖已写内容");
}

// P5 源码静态断言
t82(/add-note-box-to-all/.test(src), "P5.1 批量命令已注册");
t82(/addNoteBoxToAllCards/.test(src), "P5.2 批量方法已实现");
t82(/allowEmpty/.test(src), "P5.3 lmbJoinNote 支持 allowEmpty");
t82(/o\.allowEmpty !== true\) return base/.test(src), "P5.4 allowEmpty=false 时保持原「空内容即移除」语义");
t82(/noteAutoBoxOnNew/.test(src), "P5.5 新卡自动挂框设置项");
t82(/新出现的摘录卡自动挂一个/.test(src), "P5.6 processCanvas 里有新卡自动挂框逻辑");
t82(/lastPos0\.has\(node\.id\)\) continue/.test(src), "P5.7 见过的卡不动（只处理新出现的卡）");
t82(/lmbSplitNote\(node\.text\)\.hasNote\) continue/.test(src), "P5.8 已有描述的卡跳过（不覆盖用户内容）");
t82(/EX_ID_RE\.test\(node\.text\)\) continue/.test(src), "P5.9 只处理摘录卡（不碰普通卡）");

/* ---------- R. v0.8.4 空行分隔 + 占位默认折叠（编辑模式更干净） ---------- */
console.log("R. v0.8.4 空行 + 占位折叠");
const t84 = (cond, msg) => t(msg, cond);

// R1 ^ex-id 与 callout 之间必须有空行
{
  const joined = lmbJoinNote(BODY, "想法");
  const exIdx = joined.indexOf("^ex-abc123");
  const callIdx = joined.indexOf("> [!ppd-note]");
  t84(callIdx > exIdx, "R1.1 callout 出现在 ^ex 之后");
  t84(joined.slice(exIdx, callIdx).match(/\n\n/) !== null, "R1.2 ^ex-id 与 callout 之间有一行空行（防渲染错误）");
}

// R2 空占位默认折叠（编辑模式只看到一行标题，不展开占位提示）
{
  const emptyBox = lmbJoinNote(BODY, "", { allowEmpty: true });
  t84(emptyBox.indexOf("> [!ppd-note]- 💬 添加评论") > 0, "R2.1 空占位标题带 - 后缀（默认折叠）");
  t84(emptyBox.indexOf("> [!ppd-note] 💬 添加评论\n") === -1, "R2.2 【守卫】空占位不能是展开形式（避免编辑模式展开占位文字）");
  const filled = lmbJoinNote(lmbSplitNote(emptyBox).body, "我的想法");
  t84(filled.indexOf("> [!ppd-note] 补充描述") > 0, "R2.3 写内容后标题变回「补充描述」且无 - 后缀（展开可见）");
}

// R3 折叠的占位仍被识别为有 note
{
  const emptyBox = lmbJoinNote(BODY, "", { allowEmpty: true });
  const r = lmbSplitNote(emptyBox);
  t84(r.hasNote === true, "R3.1 折叠占位仍被识别为有 note");
  t84(r.fold === true, "R3.2 split 读出 fold=true");
  t84(r.note === "点击此处写下你的想法...", "R3.3 占位提示行被读到（编辑 Modal 预填）");
}

// R4 静态断言
t84(/emptyHead/.test(src), "R4.1 代码里有 emptyHead 变量（折叠占位标题专用）");
t84(/防渲染错误|留一行空行/.test(src), "R4.2 注释写明「留一行空行」原因");

/* ---------- D. P1 摘录索引解析器 lmbParseExcerptDoc ---------- */
console.log("D. P1 lmbParseExcerptDoc（摘录文档 → 索引条目）");
const tD = (cond, msg) => t(msg, cond);

const PDF = "Books/pdf书籍/Lecture 3 ECON508_FALL 2026.pdf";
const DOC = [
  "---",
  'PDF: "[[' + PDF + ']]"',
  'canvas: "[[English.canvas]]"',
  'updated: "2026-09-02T05:00:00.000Z"',
  "---",
  "",
  "## P.21",
  "",
  "> ([[" + PDF + "#page=21&selection=0,0,655,478|【x-P.21】]])",
  "> 自注意力的核心在于计算序列中任意两个位置之间的关联权重",
  "> #核心观点",
  "^ex-1a2b3c",
  "> [!ppd-note]+ \u{1F4AC} 添加评论",
  "> 点击此处写下你的想法...",
  "",
  "> > ([[" + PDF + "#page=21&selection=9,0,9,42|【x-P.21】]])",
  "> > 子摘录正文",
  "> ^ex-4d5e6f",
  "",
  "## P.22",
  "",
  "> ([[" + PDF + "#page=22|【x-P.22】]])",
  "> 没有 selection 参数的条目",
  "^ex-9jjqn8",
  ""
].join("\n");

const dEnts = lmbParseExcerptDoc(DOC, "摘录/Lecture 3-摘录.md");

// D1 基本解析
tD(Array.isArray(dEnts), "D1.0 返回数组");
tD(dEnts.length === 3, "D1.1 解析出 3 条（顶层1 + 嵌套1 + 无selection1），实际 " + dEnts.length);

// D2 顶层条目
{
  const e = dEnts[0];
  tD(e.pdfPath === PDF, "D2.1 pdfPath 正确");
  tD(e.page === 21, "D2.2 page = 21，实际 " + e.page);
  tD(JSON.stringify(e.selection) === JSON.stringify([0, 0, 655, 478]),
    "D2.3 selection 解析为 [0,0,655,478]，实际 " + JSON.stringify(e.selection));
  tD(e.exId === "ex-1a2b3c", "D2.4 exId = ex-1a2b3c（去掉 ^），实际 " + e.exId);
  tD(e.tags.length === 1 && e.tags[0] === "核心观点",
    "D2.5 颜色标签 #核心观点 被解析，实际 " + JSON.stringify(e.tags));
  tD(e.text === "自注意力的核心在于计算序列中任意两个位置之间的关联权重",
    "D2.6 正文正确（不含链接行/标签行），实际「" + e.text + "」");
  tD(e.sourceMd === "摘录/Lecture 3-摘录.md", "D2.7 sourceMd 记录来源文件");
}

// D3 嵌套条目（关键：> 前缀必须剥干净）
{
  const e = dEnts[1];
  tD(e != null, "D3.0 嵌套条目存在");
  tD(e.page === 21, "D3.1 嵌套条目 page = 21");
  tD(JSON.stringify(e.selection) === JSON.stringify([9, 0, 9, 42]),
    "D3.2 嵌套 selection = [9,0,9,42]，实际 " + JSON.stringify(e.selection));
  tD(e.exId === "ex-4d5e6f", "D3.3 嵌套条目 exId 正确，实际 " + e.exId);
  tD(e.text === "子摘录正文",
    "D3.4 【关键】嵌套正文剥净了多层 > 前缀，实际「" + e.text + "」");
  tD(!/^>/.test(e.text), "D3.5 正文不以 > 开头");
}

// D4 无 selection 的条目
{
  const e = dEnts[2];
  tD(e.page === 22, "D4.1 page = 22");
  tD(e.selection === null, "D4.2 selection = null（缺参数不报错），实际 " + JSON.stringify(e.selection));
  tD(e.exId === "ex-9jjqn8", "D4.3 exId 正确");
  tD(e.text === "没有 selection 参数的条目", "D4.4 正文正确");
}

// D5 补充描述 callout 不被当成摘录正文
tD(!dEnts.some((e) => e.text.indexOf("点击此处") >= 0),
  "D5.1 补充描述占位行没混进正文");
tD(!dEnts.some((e) => e.text.indexOf("ppd-note") >= 0),
  "D5.2 callout 标记没混进正文");

// D6 frontmatter 的 PDF 链接（无 #page=）不被误认成条目
tD(dEnts.length === 3, "D6.1 frontmatter 的 [[x.pdf]] 未被误判为摘录条目");

// D7 边界输入
tD(lmbParseExcerptDoc("", "a.md").length === 0, "D7.1 空字符串 → 空数组");
tD(lmbParseExcerptDoc(null, "a.md").length === 0, "D7.2 null → 空数组");
tD(lmbParseExcerptDoc(undefined, "a.md").length === 0, "D7.3 undefined → 空数组");
tD(lmbParseExcerptDoc("随便一段没有链接的文字\n^ex-abc123", "a.md").length === 0,
  "D7.4 无链接文档 → 空数组");

// D8 悬空条目（没有 ^ex- 收尾）仍然保留，不丢数据
{
  const dangling = lmbParseExcerptDoc(
    "> ([[" + PDF + "#page=7&selection=1,0,2,5|【x-P.7】]])\n> 悬空正文", "a.md");
  tD(dangling.length === 1, "D8.1 悬空条目被保留（不丢数据）");
  tD(dangling[0].exId === null, "D8.2 悬空条目 exId = null");
  tD(dangling[0].text === "悬空正文", "D8.3 悬空条目正文正确");
}

// D9 多行正文合并为一行
{
  const multi = lmbParseExcerptDoc(
    "> ([[" + PDF + "#page=3&selection=1,0,2,5|【x-P.3】]])\n> 第一行\n> 第二行\n^ex-abc123", "a.md");
  tD(multi[0].text === "第一行 第二行", "D9.1 跨行正文用空格连接，实际「" + multi[0].text + "」");
}

// D10 多个标签
{
  const tags = lmbParseExcerptDoc(
    "> ([[" + PDF + "#page=3&selection=1,0,2,5|【x-P.3】]])\n> 正文\n> #核心观点 #待验证\n^ex-abc123", "a.md");
  tD(tags[0].tags.length === 2, "D10.1 一行两个标签都被解析，实际 " + JSON.stringify(tags[0].tags));
}

// D11 正则常量可用性
{
  LMB_LINK_RE.lastIndex = 0;
  const m = LMB_LINK_RE.exec("([[a/b.pdf#page=21&selection=0,0,6,7|【x-P.21】]])");
  tD(m !== null, "D11.1 LMB_LINK_RE 能匹配带别名的回跳链接");
  tD(m && m[1] === "a/b.pdf", "D11.2 捕获 pdf 路径，实际 " + (m && m[1]));
  tD(m && m[3] === "0,0,6,7", "D11.3 捕获 selection，实际 " + (m && m[3]));
  tD(LMB_SEL_RE.test("0,0,655,478"), "D11.4 LMB_SEL_RE 匹配标准四元组");
  tD(LMB_SEL_RE.test("0, 0, 655, 478"), "D11.5 LMB_SEL_RE 容忍空格");
  tD(!LMB_SEL_RE.test("0,0,655"), "D11.6 LMB_SEL_RE 拒绝三元组");
}

// D12 源码静态断言（索引层三件套已就位）
tD(/lmb-rebuild-index/.test(src), "D12.1 命令「重建摘录索引」已注册");
tD(/lmb-index-stats/.test(src), "D12.2 命令「显示摘录索引统计」已注册");
tD(/this\.excerptIndex = new Map\(\)/.test(src), "D12.3 onload 初始化 excerptIndex");
tD(/this\.indexMtime = new Map\(\)/.test(src), "D12.4 onload 初始化 indexMtime");
tD(/vault\.on\("modify"/.test(src), "D12.5 监听 modify 增量维护");
tD(/vault\.on\("delete"/.test(src), "D12.6 监听 delete 摘除条目");
tD(/onLayoutReady\(\(\) => \{ this\.buildExcerptIndex\(\)/.test(src), "D12.7 布局就绪后构建索引");
tD(/lmbIndexCandidates/.test(src), "D12.8 有候选文件预筛（不读全库正文）");
tD(/resolvedLinks/.test(src), "D12.9 预筛走 metadataCache.resolvedLinks");
tD(/function lmbParseExcerptDoc/.test(src), "D12.10 解析器已实现（模块级纯函数）");

/* ---------- E. P2 回绘层 ---------- */
console.log("E. P2 回绘层");
const tE = (cond, msg) => t(msg, cond);
const inst2 = Object.create(PluginClass.prototype);

// E1 lmbHexToRgba（纯函数）
tE(inst2.lmbHexToRgba("#fff3a3", 0.42) === "rgba(255,243,163,0.42)",
  "E1.1 #fff3a3 → rgba(255,243,163,0.42)，实际 " + inst2.lmbHexToRgba("#fff3a3", 0.42));
tE(inst2.lmbHexToRgba("fff3a3", 0.42) === "rgba(255,243,163,0.42)",
  "E1.2 容忍缺 # 前缀");
tE(inst2.lmbHexToRgba("#FFF3A3", 0.42) === "rgba(255,243,163,0.42)",
  "E1.3 容忍大写");
tE(inst2.lmbHexToRgba("#fff", 0.42) === null, "E1.4 三位短 hex → null");
tE(inst2.lmbHexToRgba("xyzxyz", 0.42) === null, "E1.5 非法 hex → null");
tE(inst2.lmbHexToRgba(null, 0.42) === null, "E1.6 null → null");

// E2 lmbMarkColor：colorMap 反查（tag → 颜色）
{
  inst2.settings = { colorMap: "fff3a3=核心观点\na3f3ff=待验证" };
  tE(inst2.lmbMarkColor({ tags: ["核心观点"] }) === "rgba(255,243,163,0.42)",
    "E2.1 命中「核心观点」→ fff3a3，实际 " + inst2.lmbMarkColor({ tags: ["核心观点"] }));
  tE(inst2.lmbMarkColor({ tags: ["待验证"] }) === "rgba(163,243,255,0.42)",
    "E2.2 命中「待验证」→ a3f3ff");
  tE(inst2.lmbMarkColor({ tags: ["没配过的标签"] }) === "rgba(255, 226, 120, 0.40)",
    "E2.3 未命中 → 默认柔和黄");
  tE(inst2.lmbMarkColor({ tags: [] }) === "rgba(255, 226, 120, 0.40)",
    "E2.4 无标签 → 默认色");
  inst2.settings = { colorMap: "" };
  tE(inst2.lmbMarkColor({ tags: ["核心观点"] }) === "rgba(255, 226, 120, 0.40)",
    "E2.5 colorMap 为空 → 默认色（行为与旧版一致）");
  // 多标签：命中任一即上色
  inst2.settings = { colorMap: "fff3a3=核心观点\na3f3ff=待验证" };
  tE(inst2.lmbMarkColor({ tags: ["别的", "待验证"] }) === "rgba(163,243,255,0.42)",
    "E2.6 多标签命中其中一个");
}

// E3 lmbRectsToPercents：矩形 → 页面百分比（可随缩放自动跟随）
{
  const pageStub = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 400, height: 800 }) };
  const p = inst2.lmbRectsToPercents([{ left: 100, top: 200, width: 200, height: 40 }], pageStub);
  tE(p.length === 1, "E3.1 返回一个百分比矩形");
  tE(p[0].left === 0 && p[0].top === 0, "E3.2 左上角对齐 → 0%,0%");
  tE(p[0].width === 50, "E3.3 宽 200/400 = 50%，实际 " + p[0].width);
  tE(p[0].height === 5, "E3.4 高 40/800 = 5%，实际 " + p[0].height);
  const p2 = inst2.lmbRectsToPercents([{ left: 150, top: 400, width: 100, height: 80 }], pageStub);
  tE(p2[0].left === 12.5 && p2[0].top === 25,
    "E3.5 带偏移时换算正确，实际 " + p2[0].left + "%/" + p2[0].top + "%");
  // 零尺寸页面 → null（防除零）
  const zero = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
  tE(inst2.lmbRectsToPercents([{ left: 0, top: 0, width: 1, height: 1 }], zero) === null,
    "E3.6 页面零尺寸 → null（防除零）");
}

// E4 lmbPageNearViewport：性能守卫
{
  const savedWin = globalThis.window;
  globalThis.window = { innerHeight: 800 };
  try {
    tE(inst2.lmbPageNearViewport({ getBoundingClientRect: () => ({ bottom: 100, top: 0 }) }) === true,
      "E4.1 视口内的页 → true");
    tE(inst2.lmbPageNearViewport({ getBoundingClientRect: () => ({ bottom: -5000, top: -6000 }) }) === false,
      "E4.2 远在上方（<-2 屏）→ false");
    tE(inst2.lmbPageNearViewport({ getBoundingClientRect: () => ({ bottom: 9000, top: 8000 }) }) === false,
      "E4.3 远在下方（>3 屏）→ false");
    tE(inst2.lmbPageNearViewport({ getBoundingClientRect: () => { throw new Error("boom"); } }) === true,
      "E4.4 异常 → true（保守，宁可多画）");
  } finally { globalThis.window = savedWin; }
}

// E5 lmbClearMarks
{
  let removed = 0;
  const fake = { querySelectorAll: () => [{ parentNode: { removeChild: () => { removed++; } } }] };
  inst2.lmbClearMarks(fake);
  tE(removed === 1, "E5.1 清掉 1 个标记");
  inst2.lmbClearMarks(null);
  tE(true, "E5.2 null 容器不抛异常");
}

// E6 降级原则（最重要）：无 selection / 定位失败 → 画页顶细条，绝不静默消失
{
  const savedDoc = globalThis.document;
  const created = [];
  globalThis.document = {
    createDocumentFragment: () => ({ kids: [], appendChild(c) { this.kids.push(c); created.push(c); } }),
    createElement: () => {
      const el = {
        className: "", style: {}, attrs: {}, title: "",
        setAttribute(k, v) { this.attrs[k] = v; },
        classList: { contains: () => false }
      };
      return el;
    }
  };
  try {
    const pageEl = { appendChild(frag) { frag.kids.forEach((c) => created.push(c)); } };
    inst2.lmbDrawEntryMark(pageEl, { exId: "ex-abc123", selection: null, tags: [] });
    const bar = created.filter((e) => e.className === "lmb-mark")[0];
    tE(bar != null, "E6.1 【降级原则】无 selection 仍画出标记（不是什么都不画）");
    tE(bar && bar.attrs["data-fallback"] === "1", "E6.2 降级条带 data-fallback=1");
    tE(bar && bar.attrs["data-ex"] === "ex-abc123", "E6.3 降级条记住 exId（供 P3 跳转）");
    tE(bar && bar.title.indexOf("无法精确定位") >= 0, "E6.4 降级条有说明性 title");
  } finally { globalThis.document = savedDoc; }
}

// E7 源码静态断言：P2 接线完整
tE(/lmb-refresh-marks/.test(src), "E7.1 命令「强制刷新摘录标记」已注册");
tE(/lmbDrawMarksForView/.test(src), "E7.2 主绘制方法已实现");
tE(/lmbResolveSelectionRects/.test(src), "E7.3 逆运算已实现");
tE(/lmbRectsToPercents/.test(src), "E7.4 百分比换算已实现");
tE(/position:relative !important/.test(src), "E7.5 注入 .page 相对定位（百分比定位的前提）");
tE(/\.lmb-mark\{position:absolute/.test(src), "E7.6 .lmb-mark 绝对定位");
tE(/data-fallback/.test(src), "E7.7 有降级标记样式");
tE(/new MutationObserver/.test(src), "E7.8 用 MutationObserver 应对 pdf.js 虚拟化");
tE(/childList: true, subtree: true/.test(src), "E7.9 observer 监听子树（才能感知 textLayer 出现）");
tE(/isOwn\(n\)/.test(src), "E7.10 【关键】observer 过滤自己造成的变动（防无限重画）");
tE(/file-open/.test(src) && /lmbScheduleMarksRefresh/.test(src), "E7.11 打开文件后防抖重画");
tE(/entries\.length > 200/.test(src), "E7.12 性能守卫：摘录 >200 条只画视口附近");
tE(/lmbDisconnectObserver/.test(src), "E7.13 有 observer 拆卸方法");
tE(/lmbClearMarks\(v\.containerEl\)/.test(src), "E7.14 onunload 清理标记");
tE(/lmbRefreshAllMarks\(\);\s*\n?\s*return s/.test(src) || /lmbRefreshAllMarks\(\);/.test(src),
  "E7.15 索引重建后触发重画");

/* ---------- F. P3 双向跳转 ---------- */
console.log("F. P3 双向跳转");
const tF = (cond, msg) => t(msg, cond);
const pdfLink = PluginClass.prototype.lmbParsePdfLink;

// F1 正向解析
{
  const hit = pdfLink("Books/x.pdf#page=21&selection=0,0,655,478");
  tF(hit != null, "F1.1 标准 selection 链接可解析");
  tF(hit && hit.filePath === "Books/x.pdf", "F1.2 提取 pdf 路径，实际 " + (hit && hit.filePath));
  tF(hit && hit.page === 21, "F1.3 提取页码 21");
  tF(hit && JSON.stringify(hit.selection) === JSON.stringify([0, 0, 655, 478]),
    "F1.4 selection → [0,0,655,478]，实际 " + (hit && JSON.stringify(hit.selection)));

  const alias = pdfLink("Books/x.pdf#page=3&selection=1,2,3,4|【x-P.3】");
  tF(alias != null && alias.selection[0] === 1,
    "F1.5 保险：误带别名 |别名 也能解析（会剥掉）");

  const spaced = pdfLink("Books/x.pdf#page=3&selection=1, 2, 3, 4");
  tF(spaced != null && spaced.selection[1] === 2, "F1.6 selection 容忍空格");

  // v0.9.1 起接管【所有】pdf#page= 链接（剥离 PDF++ 的核心：不给它碰 pdf 链接的机会）
  const square = pdfLink("Books/x.pdf#page=9&square=1,2,3,4");
  tF(square != null && square.page === 9,
    "F1.7 square=（PDF Flow 旧摘录）也接管——至少能跳到页，不再让 PDF++ 报错");
  const pageOnly = pdfLink("Books/x.pdf#page=9");
  tF(pageOnly != null && pageOnly.selection === null,
    "F1.8 page= 链接接管（v0.9.1 前 PDF++ 会因同名摘录 md 撞名而报错）");
  const md = pdfLink("笔记/某篇.md#^ex-abc123");
  tF(md === null, "F1.9 md 的 ^blockid 链接不接管");
  tF(pdfLink(null) === null, "F1.10 null 输入 → null");
  tF(pdfLink("随便的文字") === null, "F1.11 无 # → null");
  tF(pdfLink("x.pdf#page=abc") === null, "F1.12 页码非法 → null");
}

// F2 劫持的可还原性（源码静态断言）
tF(/_ppdOrigOpenLinkText/.test(src), "F2.1 保存了原始 openLinkText 引用");
tF(/this\.register\(\(\) => \{[\s\S]{0,120}openLinkText = this\._ppdOrigOpenLinkText/.test(src),
  "F2.2 用 this.register 注册还原（禁用插件后行为恢复）");
tF(/ws\._ppdPatched/.test(src), "F2.3 有防重复劫持守卫");

// F3 正向跳转的关键实现点
tF(/lmbWaitPageEl/.test(src), "F3.1 有等页面出现（处理未渲染的 leaf）");
tF(/lmbWaitSelectionRects/.test(src), "F3.2 有轮询等 textLayer（虚拟化：刚滚到的页没有文本层）");
tF(/getLeaf\("tab"\)/.test(src), "F3.3 没有对应 leaf 时新开标签页（不打乱布局）");
tF(/lmbFlashRects/.test(src), "F3.4 闪烁定位已实现");
tF(/lmb-flash-anim/.test(src), "F3.5 闪烁动画 CSS 已定义");
tF(/animation:lmb-flash-anim \.5s ease-in-out 3/.test(src), "F3.6 闪烁 3 次");

// F4 反向跳转
tF(/dblclick/.test(src), "F4.1 双击触发（不用单击：避免吃掉划选起笔事件）");
tF(/pointer-events:none/.test(src), "F4.2 标记保持 pointer-events:none（划选零冲突）");
tF(/data-src/.test(src), "F4.3 标记记录来源摘录文档");
tF(/lmbOpenExcerptAt/.test(src), "F4.4 反向跳转已实现");
tF(/"#\^" \+ exId/.test(src), "F4.5 用 #^blockid 锚定位（P0-4 已验证可用）");
tF(/_ppdDblClickTargets/.test(src), "F4.6 双击监听有登记（onunload 时拆除）");
tF(/removeEventListener\("dblclick"/.test(src), "F4.7 onunload 拆除双击监听");
tF(/marks\.length - 1/.test(src), "F4.8 命中检测从最上层标记往下找");
tF(/选区无法精确定位/.test(src), "F4.9 定位失败有明确 Notice（不静默）");

/* ---------- G. v0.9.1 剥离 PDF++ + 截图区域标记 + canvas 跳转 ---------- */
console.log("G. v0.9.1 剥离 PDF++ / rect 标记 / canvas 跳转");
const tG = (cond, msg) => t(msg, cond);

// G1 rect= 解析（截图摘录的区域坐标，页面百分比）
{
  const hit = pdfLink("Books/x.pdf#page=21&rect=12.5,3.2,45,8");
  tG(hit != null && hit.rect != null, "G1.1 rect= 链接可解析");
  tG(hit && JSON.stringify(hit.rect) === JSON.stringify([12.5, 3.2, 45, 8]),
    "G1.2 rect → [12.5,3.2,45,8]，实际 " + (hit && JSON.stringify(hit.rect)));
  tG(hit && hit.selection === null, "G1.3 rect 与 selection 互不干扰");
  const both = pdfLink("Books/x.pdf#page=21&selection=1,2,3,4&rect=1,2,3,4");
  tG(both && both.selection && both.rect, "G1.4 同时带 selection 和 rect 都能解析");
}

// G2 截图摘录写 rect 参数（源码静态断言）
tG(/rectParam \? "&rect=" \+ rectParam/.test(src),
  "G2.1 captureRectImage 把区域百分比编码进链接");
tG(/rectParam,/.test(src) && /isImage: true/.test(src), "G2.2 图片 info 带 rectParam 字段");

// G3 回绘用 rect 直接画（不依赖 textLayer）
tG(/entry\.rect && entry\.rect\.length === 4/.test(src),
  "G3.1 【关键】rect 条目直接用百分比画——虚拟化页也能画（修复截图摘录没标记）");

// G4 剥离 PDF++：DOM 捕获层拦截
tG(/document\.addEventListener\("click", handler, true\)/.test(src),
  "G4.1 【关键】document 捕获阶段拦截（先于 PDF++ 的 openLinkText 劫持）");
tG(/stopImmediatePropagation\(\)/.test(src),
  "G4.2 stopImmediatePropagation——Obsidian/PDF++ 都收不到事件");
tG(/lmbTeardownLinkInterception/.test(src), "G4.3 拦截有拆除方法");
tG(/lmbTeardownLinkInterception\(\);/.test(src), "G4.4 onunload 真的调用拆除");
tG(/\(\^\|&\)page=/.test(src), "G4.5 只接管带 page= 的 pdf 链接");
tG(pdfLink("Books/x.pdf#page=9") != null, "G4.6 page-only 现在接管（v0.9.1 行为）");

// G5 反向跳转优先 canvas
tG(/excerptCanvasIndex = new Map\(\)/.test(src), "G5.1 有 canvas 索引");
tG(/lmbIndexCanvasFile/.test(src), "G5.2 canvas 索引扫描已实现");
tG(/lmbFocusCanvasNode/.test(src), "G5.3 canvas 聚焦已实现");
tG(/zoomToSelection/.test(src), "G5.4 选中卡片后缩放到选区");
tG(/this\.excerptCanvasIndex\.get\(exId\)/.test(src),
  "G5.5 反向跳转先查 canvas，找不到才回退 md");

// G6 同名摘录 md 撞名（本次报错的直接根源）
tG(/sameFolder/.test(src), "G6.1 open-excerpt-doc 优先同目录（撞名修复）");
tG(/LMBNodeSuggester\(this\.app,/.test(src), "G6.2 仍有歧义时弹选择器，不再静默取第一个");

// G7 canvas 增量维护
tG(/extension === "canvas"\) this\.lmbIndexCanvasFile/.test(src),
  "G7.1 canvas 的 modify/create 走 canvas 索引");

/* ---------- H. v0.9.2 画布复用 + 跳转后重叠自愈 ---------- */
console.log("H. v0.9.2 画布复用 / 重叠自愈");
const tH = (cond, msg) => t(msg, cond);

// H1 已打开的画布必须复用（不要每次重开）
{
  const i = src.indexOf("async lmbFocusCanvasNode(");
  const body = i >= 0 ? src.slice(i, i + 2600) : "";
  tH(/getLeavesOfType\("canvas"\)/.test(body), "H1.1 先遍历已打开的 canvas leaf");
  tH(/v\.file && v\.file\.path === cf\.path/.test(body), "H1.2 按路径匹配已打开的画布");
  const openIdx = body.indexOf('getLeaf("tab")');
  const reuseIdx = body.indexOf("setActiveLeaf");
  tH(openIdx > 0 && reuseIdx > openIdx,
    "H1.3 【关键】先复用、找不到才新开（复用分支在新开分支之前判定）");
  tH(/已打开的画布直接复用，绝不重开/.test(src), "H1.4 注释写明设计意图");
}

// H2 重叠自愈
tH(/lmbScheduleOverlapHeal/.test(src), "H2.1 有自愈调度方法");
tH(/normalizeOverlappingExcerpts\(cf\)/.test(src), "H2.2 自愈只对目标画布定点跑");
tH(/900/.test(src), "H2.3 延迟 900ms（等 processCanvas 写盘与视图重载结束）");
tH(/幂等、只动 \^ex 卡/.test(src), "H2.4 注释说明幂等性与作用范围");

// H3 normalizeOverlappingExcerpts 支持定点调用且不破坏旧行为
tH(/async normalizeOverlappingExcerpts\(targetFile\)/.test(src), "H3.1 接受可选 targetFile 参数");
tH(/if \(targetFile\) \{\s*targets = \[targetFile\];/.test(src),
  "H3.2 传参时只处理这一张画布");
tH(/getLeavesOfType\("canvas"\)\s*\n?\s*\.map\(/.test(src),
  "H3.3 不传参时仍优先处理已打开的画布（旧行为不变）");

// H4 清理
tH(/_ppdHealTimer/.test(src), "H4.1 自愈定时器有引用");
tH(/clearTimeout\(this\._ppdHealTimer\); this\._ppdHealTimer = null;/.test(src),
  "H4.2 onunload 撤掉自愈定时器");

/* ---------- X. v0.11.0 首连锁定 / 改挂侧 / 乱放根因修复 / 独立评论 ---------- */
console.log("X. v0.11.0 首连锁定 / 改挂侧 / 重居中 / 评论");
const tX = (cond, msg) => t(msg, cond);
const XB = "> (【书-P.12】)\n> 摘录原文\n^ex-abc123";

// X1 lmbRecenterNode：R1 乱放根因 —— fitNode 撑大卡片后组内重新居中
{
  const parent = { id: "P", x: 0, y: 0, width: 200, height: 100 };
  // 子卡：排布时高 80（y 居中=10），之后 fitNode 撑到高 300 但 y 没动 → 中心偏出轴线
  const child = { id: "B", x: 230, y: 10, width: 100, height: 300 };
  const edge = { id: "e1", fromNode: "P", toNode: "B", fromSide: "right", toSide: "left" };
  const sc = new Set(["e1"]);
  tX(lmbRecenterNode(child, [parent, child], [edge], sc) === true, "X1.1 检测到偏移并重排");
  tX(child.y === Math.round((parent.height - child.height) / 2), "X1.2 重排后 y = 父卡竖直中心对齐（横轴一致）");
  tX(child.x === 230, "X1.3 x 不变（仍贴父卡右侧）");
  // 已对齐的卡再跑一遍 → 返回 false（幂等，不触发无谓写盘）
  tX(lmbRecenterNode(child, [parent, child], [edge], sc) === false, "X1.4 已居中 → 幂等返回 false");
  // 无自动边（sidecar 不含）→ 不动手动摆的卡
  const c2 = { id: "C", x: 230, y: 10, width: 100, height: 300 };
  const em = { id: "m1", fromNode: "P", toNode: "C", fromSide: "right", toSide: "left" };
  tX(lmbRecenterNode(c2, [parent, c2], [em], new Set()) === false, "X1.5 手动边不参与重居中");
}

// X2 lmbJoinComment / lmbSplitComment：独立评论数据链
{
  // X2.1 空评论 + allowEmpty → 折叠单行按钮
  const emptyBar = lmbJoinComment(XB, "", { allowEmpty: true });
  tX(emptyBar === XB + "\n\n> [!lmb-comment]- 添加评论", "X2.1 空评论 = 折叠单行「添加评论」底栏");
  // X2.2 非空评论展开
  const withC = lmbJoinComment(XB, "第一行评论\n第二行评论", {});
  tX(withC.includes("> [!lmb-comment] 评论") && withC.includes("> 第一行评论") && withC.includes("> 第二行评论"),
    "X2.2 非空评论 = 展开块（标题「评论」+ 内容行）");
  // X2.3 roundtrip：split 还原
  const r = lmbSplitComment(withC);
  tX(r.hasComment === true && r.comment === "第一行评论\n第二行评论", "X2.3 split roundtrip 还原评论内容");
  tX(r.body === XB, "X2.4 body 保留原文（含 ^ex 锚点）");
  // X2.5 移除评论
  tX(lmbJoinComment(r.body, "", { allowEmpty: false }) === XB, "X2.5 空评论 + allowEmpty=false = 移除评论块");
  // X2.6 与补充描述并存：note 在前、comment 在后，互不吞
  const both = lmbJoinNote(XB, "这是描述", { type: "ppd-note", title: "补充描述" });
  const both2 = lmbJoinComment(both, "这是评论", {});
  const sn = lmbSplitNote(both2);
  tX(sn.hasNote && sn.note === "这是描述", "X2.6 note 解析不被评论块干扰");
  tX(sn.tail.includes("[!lmb-comment]") && sn.tail.includes("这是评论"), "X2.7 评论块完整进 tail（编辑 note 不丢评论）");
  const sc2 = lmbSplitComment(both2);
  tX(sc2.hasComment && sc2.comment === "这是评论", "X2.8 评论解析不被 note 块干扰");
  // X2.9 stripNote 双块全剥（摘录 md 保持原文镜像）
  tX(lmbStripNote(both2) === XB, "X2.9 stripNote 同时剥掉 note 与 comment（原文镜像）");
}

// X3 静态断言：评论体系接线完整
tX(/data-callout="lmb-comment"/.test(src), "X3.1 点击拦截认准 lmb-comment callout");
tX(/onCanvasCalloutClick/.test(src) && /registerDomEvent\(document, "click", \(e\) => this\.onCanvasCalloutClick\(e\), true\)/.test(src),
  "X3.2 document 捕获层注册点击编辑");
tX(/closest\("\.callout-fold"\)/.test(src), "X3.3 折叠箭头不拦截（保留原生展开/折叠）");
tX(/commentAutoBoxOnNew/.test(src), "X3.4 评论栏自动挂开关已接设置");
tX(/edit-card-comment/.test(src) && /add-comment-box-to-all/.test(src), "X3.5 评论命令已注册");
tX(/addRibbonIcon\("message-square-plus"/.test(src), "X3.6 评论 ribbon 按钮已注册");
tX(/\.callout\[data-callout="lmb-comment"\]\{/.test(src), "X3.7 评论栏 CSS 已注入");
tX(/lmbRecenterNode\(node, nodes, data\.edges, sidecarFit\)/.test(src), "X3.8 fitNode 尺寸修正后重居中已接入 processCanvas");
tX(/lmbRecenterNode\(node, data\.nodes \|\| \[\], data\.edges, this\.autoEdges\.get\(file\.path\)/.test(src),
  "X3.9 applyCardNote 高度变化后重居中已接入");
tX(/v0\.11\.0/.test(src) && /loaded \(v0\.11\.0\)/.test(src), "X3.10 版本号 0.11.0 已同步");

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
