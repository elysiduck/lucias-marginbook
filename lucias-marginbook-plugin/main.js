/*
 * ============================================================================
 * Lucia's MarginBook (lmb) v0.11.0
 * ----------------------------------------------------------------------------
 * 独立运行的 PDF 摘录工作流插件：不依赖任何第三方 PDF 插件，不修改其他插件文件。
 * 与 PDF++ 等其他 pdf 链接处理插件可共存（本插件在 DOM 捕获层拥有更高优先级）。
 *
 * 功能：
 *   1. 文字选区 → 手柄 → md 引用块 / canvas 文本卡
 *   2. 图片框选（二选一）：
 *      a) 侧边栏 ribbon 按钮「图片框选」→ 点击后下一次拖拽即框选（一次性）
 *      b) Alt + 拖拽
 *      松手后直接裁剪页面渲染画布，存为 webp 附件 → 拖拽生成 ![[xxx.webp]]
 *   3. 回跳链接 selection=文本层索引（沿用 PDF++ 的 URL 参数约定以兼容存量笔记，
 *      解析/生成本插件自理），点击高亮定位
 *   4. Canvas 摘录卡自动适配内容大小（图片卡按截图真实宽高比；尊重手动调整）
 *   5. Canvas 变更 → 自动创建/同步「<PDF名>-摘录.md」（canvas 主本 → md）
 *
 * v0.11.0 变更（首连锁定 / 改挂侧 / 乱放根因修复 / 独立评论体系）：
 *   - R1 乱放根因修复：instantAttach 用落下时的默认小尺寸组居中 → fitNode 随后撑大卡片
 *     → 高度变了 y 不变 → 中心偏出父卡轴线。新增 lmbRecenterNode：fitNode/补充描述/
 *     评论改变尺寸后按自动父边做组内重新居中
 *   - R3 首连锁定（lmbPlanAutoLink）：一张卡只自动建一条连线；已有自动边后压中其他卡
 *     不再换父、不再新建（换父已移除，想换父手动删线重拖）；手动边不参与锁定
 *   - R4 改挂侧（lmbApplyReside）：拖回已连线的卡上 → 按落点方位改边端点（上下左右）
 *     + 新旧两侧组重排；同侧重拖 = 重新对齐
 *   - R2 独立评论体系（lmb-comment callout，仿 PDF Flow 批注底栏）：新卡自动挂评论栏
 *     （可关）、canvas 里点评论栏直接弹编辑框、ribbon/命令/批量入口齐全；
 *     与补充描述是两套独立数据，摘录 md 同步时两者都剥离
 *
 * v0.10.0 变更（与 PDF++ 彻底解耦）：
 *   - 删除「借 PDF++ 选框出 chip」的跟踪层（_ppBox/seenBoxes/onDocMouseMove/
 *     mouseup 路径①②）；图片框选只走自带 Alt+拖拽 / 侧栏按钮，文字选区走
 *     原生 getSelection —— 零 PDF++ DOM 读取、零插件对象访问
 *   - 品牌 / id / 类名 / 命令 id 全量更名：lucias-marginbook / lmb-*
 *   - 数据格式不变：ppd-note callout、<!-- ppd-note-start/end --> 旧锚点、
 *     selection=/rect= 链接参数原样保留（存量笔记零迁移）
 *
 * v0.3.0 变更（MarginNote 4 借鉴改造，三路补丁合入）：
 *   - P0-1 内容寻址 exId：同一选区重复拖拽 → 同一 ^ex id → 引用计数正确、
 *     canvas 卡按 id 去重（卡片轴心架构的地基）
 *   - P1-3 摘录文档按页分组（## P.N 标题）：Obsidian 核心大纲插件自动获得
 *     摘录大纲视图（P2-7 免费达成）；frontmatter 增加 updated 时间戳
 *   - P1-4 相关笔记检索（MN4「标题链接」平替）：新摘录自动查全库元数据，
 *     命中 ≥2 个分词的 top3 写入「> 相关：」行，纯本地零 AI
 *   - P1-5 颜色语义：设置页映射表 + annotationLayer 高亮色探测（best-effort，
 *     探不到静默跳过），命中映射时摘录卡自动附 #标签
 *   - P2-6 Recall 回忆模式：阅读模式模糊含【*-P.N】的引用块，点击揭示 3 秒
 *   - 新增命令：recall-toggle / open-excerpt-doc
 *
 * 已知边界：
 *   - 截图分辨率 = 当前缩放下的屏幕像素（放大后再框选更清晰）
 *   - md 落点需为编辑模式；canvas 尺寸估算近似
 *
 * 调试：console 前缀 [lmb]；Notice 调试链可在设置里关闭。
 * ============================================================================
 */

"use strict";

const { Plugin, Notice, TFile, PluginSettingTab, Setting, normalizePath, Modal, FuzzySuggestModal } = require("obsidian");

const EX_ID_RE = /\^ex-[0-9a-z]{4,8}/;

/* ==================== P1：摘录索引层 ====================
 * 动机：现有链路是 canvas → 摘录 md 的单向同步，打开 PDF 时无法知道「哪些段落
 *   已经摘录过」。本层建立反向索引（摘录 md → PDF/页/选区），为 P2 回绘与
 *   P3 跳转提供数据。
 *
 * 设计原则（与全插件一致）：
 *   - 唯一真相源是摘录 md 本身，索引只是**可随时重建的缓存**，不写进 data.json
 *   - 解析器写成纯函数 lmbParseExcerptDoc，挂 __test 供 node 冒烟离线验证
 *   - 候选文件用 metadataCache.resolvedLinks 预筛，避免读全库 md 正文
 * ===================================================================== */
// 摘录回跳链接：[[x.pdf#page=21&selection=0,0,655,478|显示名]]
//             或 [[x.pdf#page=21&rect=12.5,3.2,45,8|显示名]]（截图摘录，页面百分比，P3.5 新增）
const LMB_LINK_RE = /\[\[([^#|\]]+\.pdf)#page=(\d+)(?:&selection=([\d,]+))?(?:&rect=([\d.,]+))?[^\]]*\]\]/g;
// selection 参数：a,b,c,d（textLayer 直接子元素序号 + 字符偏移）
const LMB_SEL_RE = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/;
// rect 参数：l,t,w,h（相对 .page 的百分比，浮点）—— 截图摘录用，不依赖 textLayer
const LMB_RECT_RE = /^\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*$/;

/* ==================== v0.8.0+：卡片补充描述（note） ====================
 * v0.8.0 最初设计：HTML 注释锚点 + callout 解析。v0.8.3 改成**完全可见**：
 *   - 砍掉 `<!-- ppd-note-start/end -->`（可疑失败点：要么被字面渲染破坏 callout，
 *     要么破坏解析；用户"啥也看不到"的根因之一）
 *   - callout 自身作为唯一标记（Obsidian 原生一定可见，原生一定渲染成框）
 *   - 空 callout 用「💬 添加评论」标题 + 占位提示行，看起来就是一个按钮，
 *     用户一眼能看到「卡片底部可以加评论」
 *
 * 落盘结构（v0.8.3）：
 *   原文内容
 *   ^ex-abc123
 *   > [!ppd-note] 💬 添加评论              ← 空时标题（按钮样式）
 *   > 点击此处写下你的想法...               ← 空时占位；用户写内容后被替换
 *
 * 向后兼容：旧 v0.8.0-v0.8.2 用 `<!-- ppd-note-start/end -->` 包围 callout，
 *   解析时仍能识别（不丢用户已写内容）；但 emit 永远用新格式。
 * ===================================================================== */
const LMB_NOTE_START = "<!-- ppd-note-start -->";   // 保留旧锚点用于回退解析
const LMB_NOTE_END = "<!-- ppd-note-end -->";
const LMB_NOTE_PLACEHOLDER_TITLE = "💬 添加评论";   // 空 callout 的标题（看起来像按钮）
const LMB_NOTE_PLACEHOLDER_HINT = "点击此处写下你的想法...";
const NOTE_START_LINE_RE = /^\s*<!--\s*ppd-note-start\s*-->\s*$/;
const NOTE_END_LINE_RE = /^\s*<!--\s*ppd-note-end\s*-->\s*$/;
// callout 首行：> [!类型][+-]? 标题
const NOTE_CALLOUT_RE = /^\s*>\s*\[!([^\]]+)\]\s*([+-]?)\s*(.*)$/;

/* ==================== v0.11.0：独立评论体系（lmb-comment） ====================
 * 与「补充描述」（ppd-note）并存的第二套数据，仿 PDF Flow 的批注评论底栏：
 *   空：> [!lmb-comment]- 添加评论     ← 折叠单行，渲染成底栏按钮
 *   有：> [!lmb-comment] 评论          ← 展开显示内容
 * 位置：永远在卡片文本最末（补充描述 callout 之后），渲染成卡片底栏。
 * lmb-comment 是保留类型字面量（不做成设置项），解析器按字面量识别。 */
const LMB_COMMENT_TYPE = "lmb-comment";
const LMB_COMMENT_EMPTY_TITLE = "添加评论";
const LMB_COMMENT_TITLE = "评论";
const LMB_COMMENT_CALLOUT_RE = /^\s*>\s*\[!lmb-comment\]\s*([+-]?)\s*(.*)$/;

/**
 * 拆分 text → { body, note, fold, hasNote, type, tail }
 *   v0.8.3：先按新格式（callout 自身）解析，找不到再回退旧 HTML 锚点格式（v0.8.0-0.8.2 兼容）。
 *   v0.11.0：感知独立评论块（lmb-comment）——note 块在评论块首行处截断，评论块及其后
 *   的内容原样放进 tail（join 时原样接回，不再像旧版那样把 note 之后的散行弄丢）。
 */
function lmbSplitNote(text) {
  if (typeof text !== "string" || !text) return { body: text || "", note: "", fold: false, hasNote: false, type: "", tail: "" };
  const lines = text.split("\n");

  // body 末尾：callout 块前面那部分。新格式=第一个 callout 首行；旧格式=HTML 起始行之前。
  let bodyEndIdx = lines.length;
  // callout 块范围：[blockStart, blockEnd)
  let blockStart = -1, blockEnd = lines.length;

  // 新格式优先：找第一个 note callout 首行（跳过 lmb-comment——那是独立评论体系，不是 note）
  for (let i = 0; i < lines.length; i++) {
    if (LMB_COMMENT_CALLOUT_RE.test(lines[i])) continue;  // 评论块不是 note
    if (NOTE_CALLOUT_RE.test(lines[i])) {
      bodyEndIdx = i;                                  // 默认 body 在 callout 行前结束
      // 关键：v0.8.3 兼容旧 v0.8.0-v0.8.2 格式——如果该 callout 上面紧跟着 HTML 起始锚点，
      // body 应该到 HTML 起始行（不能让 HTML 注释行混进 body，否则 N 边界 bug 复发）
      for (let j = i - 1; j >= 0; j--) {
        if (NOTE_END_LINE_RE.test(lines[j])) break;    // 中间隔着结束锚点 → 新格式独立块，不调整
        if (NOTE_START_LINE_RE.test(lines[j])) { bodyEndIdx = j; break; }
      }
      blockStart = i;
      blockEnd = lines.length;
      break;
    }
  }
  // 没有 note callout：可能只有独立评论块 → body 截到评论块前，评论块进 tail
  if (blockStart < 0) {
    for (let i = 0; i < lines.length; i++) {
      if (LMB_COMMENT_CALLOUT_RE.test(lines[i])) {
        return {
          body: lines.slice(0, i).join("\n").replace(/\s+$/, ""),
          note: "", fold: false, hasNote: false, type: "",
          tail: lines.slice(i).join("\n").replace(/^\s+|\s+$/g, "")
        };
      }
    }
    // 旧格式回退：HTML 注释锚点包围的 callout
    for (let i = 0; i < lines.length; i++) {
      if (NOTE_START_LINE_RE.test(lines[i])) { bodyEndIdx = i; break; }
    }
    for (let i = 0; i < lines.length; i++) {
      if (NOTE_START_LINE_RE.test(lines[i])) { blockStart = i + 1; break; }
    }
    for (let i = 0; i < lines.length; i++) {
      if (NOTE_END_LINE_RE.test(lines[i])) { blockEnd = i; break; }
    }
    if (blockStart < 0) return { body: text, note: "", fold: false, hasNote: false, type: "", tail: "" };
    const lbody = lines.slice(0, bodyEndIdx).join("\n").replace(/\s+$/, "");
    const lblock = lines.slice(blockStart, blockEnd);
    const lm = lblock[0] && lblock[0].match(NOTE_CALLOUT_RE);
    if (!lm) return { body: text, note: "", fold: false, hasNote: false, type: "", tail: "" };
    const lnoteLines = [];
    for (let i = 1; i < lblock.length; i++) {
      const l = lblock[i];
      if (/^\s*>\s?/.test(l)) lnoteLines.push(l.replace(/^\s*>\s?/, ""));
      else break; // callout 结束（遇到非 > 行）
    }
    return { body: lbody, note: lnoteLines.join("\n").replace(/\s+$/, ""), fold: lm[2] === "-", hasNote: true, type: lm[1], tail: "" };
  }
  const body = lines.slice(0, bodyEndIdx).join("\n").replace(/\s+$/, "");
  const block = lines.slice(blockStart, blockEnd);
  const m = block[0] && block[0].match(NOTE_CALLOUT_RE);
  if (!m) return { body: text, note: "", fold: false, hasNote: false, type: "", tail: "" };
  const type = m[1];
  const fold = m[2] === "-";
  const noteLines = [];
  let tailStart = block.length;
  for (let i = 1; i < block.length; i++) {
    const l = block[i];
    if (LMB_COMMENT_CALLOUT_RE.test(l)) { tailStart = i; break; } // v0.11.0：评论块开始 → note 块结束
    if (/^\s*>\s?/.test(l)) noteLines.push(l.replace(/^\s*>\s?/, ""));
    else { tailStart = i; break; } // callout 结束（遇到非 > 行）；其余行（含评论块）进 tail
  }
  const note = noteLines.join("\n").replace(/\s+$/, "");
  const tail = block.slice(tailStart).join("\n").replace(/^\s+|\s+$/g, "");
  return { body, note, fold, hasNote: true, type, tail };
}

/**
 * 合并 body + note → text。v0.8.3：emit 永远用新格式（无 HTML 注释锚点）。
 *   空内容 + allowEmpty=true → 输出「💬 添加评论」标题 + 占位提示行的可见按钮样式空框。
 *   空内容 + allowEmpty=false → 移除整个 callout（不输出任何块）。
 *   v0.11.0：opts.tail（评论块等 note 之后的原样内容）永远接回最末，编辑 note 不再弄丢评论块。
 */
function lmbJoinNote(body, note, opts) {
  const o = opts || {};
  const type = o.type || "ppd-note";
  const userTitle = o.title || "补充描述";
  const fold = !!o.fold;
  const base = (body || "").replace(/\s+$/, "");
  const tail = (o.tail && String(o.tail).trim()) ? "\n\n" + String(o.tail).trim() : "";
  const isEmpty = !note || !String(note).trim();
  // v0.8.3：空 callout 用「💬 添加评论」标题（非空才用用户配置的标题）—— 看起来像按钮
  const title = (isEmpty && o.allowEmpty === true) ? LMB_NOTE_PLACEHOLDER_TITLE : userTitle;
  const head = "> [!" + type + "]" + (fold ? "-" : "") + (title ? " " + title : "");

  if (isEmpty) {
    if (o.allowEmpty !== true) return base + tail;
    // 空框带可见占位：标题（按钮样）+ 提示行
    // v0.8.4：占位默认折叠（编辑模式只看到「> [!ppd-note] 💬 添加评论」一行标题，
    // 不展开占位提示文字，编辑模式视觉更干净；阅读/canvas 模式下点折叠箭头展开再写）
    const emptyHead = "> [!" + type + "]- " + title;
    return base + "\n\n" + emptyHead + "\n> " + LMB_NOTE_PLACEHOLDER_HINT + tail;
  }
  const callout = [head].concat(String(note).split("\n").map((l) => (l.trim() ? "> " + l : ">")));
  // v0.8.4：^ex-id 与 callout 之间留一行空行（callout 是块级元素，
  // 紧贴段落 ID 行可能被某些 markdown 渲染器当作同一段，触发渲染错误）
  return base + "\n\n" + callout.join("\n") + tail;
}

/** 剥离整个补充描述块（callout），用于摘录 md 同步，避免污染摘录文档。
 *  v0.11.0：评论块（tail）一并剥掉——摘录文档保持「原文镜像」。 */
function lmbStripNote(text) {
  const r = lmbSplitNote(text);
  return (r.hasNote || r.tail) ? r.body : text;
}

/* ==================== v0.11.0：独立评论（comment）解析/合并 ==================== */

/**
 * 拆分 text → { body, comment, fold, hasComment }。
 *   body = 评论块之前的全部内容（含补充描述 callout）；评论永远取第一个 lmb-comment 块。
 */
function lmbSplitComment(text) {
  if (typeof text !== "string" || !text) return { body: text || "", comment: "", fold: false, hasComment: false };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LMB_COMMENT_CALLOUT_RE);
    if (!m) continue;
    const body = lines.slice(0, i).join("\n").replace(/\s+$/, "");
    const cLines = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*>\s?/.test(l)) cLines.push(l.replace(/^\s*>\s?/, ""));
      else break;
    }
    return { body, comment: cLines.join("\n").replace(/\s+$/, ""), fold: m[1] === "-", hasComment: true };
  }
  return { body: text, comment: "", fold: false, hasComment: false };
}

/**
 * 合并 body + 评论 → text。
 *   空 + allowEmpty=true → 折叠单行「> [!lmb-comment]- 添加评论」（渲染成底栏按钮）。
 *   空 + allowEmpty=false → 移除评论块（注释栏可被用户删掉）。
 *   非空 → 展开块「> [!lmb-comment] 评论」+ 内容行（内容可见，同 PDF Flow）。
 */
function lmbJoinComment(body, commentText, opts) {
  const o = opts || {};
  const base = (body || "").replace(/\s+$/, "");
  const isEmpty = !commentText || !String(commentText).trim();
  if (isEmpty) {
    if (o.allowEmpty !== true) return base;
    return base + "\n\n> [!" + LMB_COMMENT_TYPE + "]- " + LMB_COMMENT_EMPTY_TITLE;
  }
  const head = "> [!" + LMB_COMMENT_TYPE + "] " + LMB_COMMENT_TITLE;
  const callout = [head].concat(String(commentText).split("\n").map((l) => (l.trim() ? "> " + l : ">")));
  return base + "\n\n" + callout.join("\n");
}

/**
 * v0.8.3：把 text 转成「实际会被渲染」的形态供尺寸估算用。
 *   旧版本要去掉 HTML 注释锚点（不可见）；v0.8.3 没有不可见锚点，原样返回。
 *   callout 内的占位行算高度（用户能看到，要占空间）。
 */
function lmbRenderedText(text) { return text; }

/**
 * 纯决策函数（可单测）：mouseup 检测到文字选区时，是否应重建摘录 chip。
 * 背景 bug（v0.3.1 修）：拖放完成后 PDF 选区仍在，每次点击都被当成「新的摘录意图」，
 * chip 反复重建 + Notice 刷屏；点在 chip 上也会触发重建。
 * @param {Object} o
 * @param {boolean} o.hasSelection  extractSelection 成功（选区确实可摘录）
 * @param {boolean} o.targetOnChip  本次点击落在 chip 元素上（chip 交互，不是新意图）
 * @param {boolean} o.chipVisible   当前 chip 还在屏幕上
 * @param {boolean} o.sameSelection 本次选区与 chip 已承载的选区相同（text@page 一致）
 * @param {boolean} o.mouseOnPdf    鼠标释放点位于 PDF 页面内（新摘录意图只在 PDF 内产生）
 * @returns {boolean} true = 重建 chip；false = 静默吞掉本次 mouseup
 */
function lmbShouldReshowSelection(o) {
  if (!o.hasSelection) return false;      // 无有效选区 → 走原有「无选区」节流提示
  if (o.targetOnChip) return false;       // 点在 chip 上：不重建
  if (o.chipVisible && o.sameSelection) return false; // 同选区且 chip 还在：不重复弹
  if (!o.mouseOnPdf) return false;        // 释放点不在 PDF 内：不是新摘录意图
  return true;
}

/* ==================== v0.4.0：MN4 式「拖到节点上自动成为子节点」纯函数 ==================== */

/** 两矩形相交面积 / a 的面积（canvas 坐标：x,y 左上，y 向下） */
function lmbRectsOverlapRatio(a, b) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return 0;
  const areaA = a.w * a.h;
  return areaA > 0 ? (ox * oy) / areaA : 0;
}

/**
 * 从候选节点里挑出「新卡落下时压住」的父节点 —— v0.4.3 多信号判定（修复识别率低）：
 *   ① 落点角命中：新卡左上角（≈鼠标松手点，Obsidian drop 的锚点）落在目标矩形内；
 *   ② 中心命中：新卡中心落在目标矩形内；
 *   ③ 面积命中：相交面积 ≥ 两卡中**较小者**面积的 threshold
 *      （旧版只算新卡面积——大新卡压小目标时占比天然很小 → 漏判的主因）。
 * 任一信号命中即候选，多候选取相交面积比最大者。group 是容器语义，不劫持。
 */
function lmbPickDropParent(newNode, otherNodes, threshold = 0.2) {
  let best = null, bestRatio = 0;
  const nw = newNode.width, nh = newNode.height;
  const ncx = newNode.x + nw / 2, ncy = newNode.y + nh / 2;
  for (const n of otherNodes || []) {
    if (!n || n.id === newNode.id || n.type === "group") continue;
    const ox = Math.min(newNode.x + nw, n.x + n.width) - Math.max(newNode.x, n.x);
    const oy = Math.min(newNode.y + nh, n.y + n.height) - Math.max(newNode.y, n.y);
    const ratio = (ox > 0 && oy > 0)
      ? (ox * oy) / Math.max(1, Math.min(nw * nh, n.width * n.height))
      : 0;
    const cornerIn = newNode.x >= n.x && newNode.x <= n.x + n.width &&
                     newNode.y >= n.y && newNode.y <= n.y + n.height;
    const centerIn = ncx >= n.x && ncx <= n.x + n.width &&
                     ncy >= n.y && ncy <= n.y + n.height;
    if ((cornerIn || centerIn || ratio >= threshold) && ratio > bestRatio) {
      bestRatio = ratio; best = n;
    }
  }
  return best ? { node: best, ratio: bestRatio } : null;
}

/**
 * 子卡吸附到父卡旁边 —— v0.4.4 四方向择位（修复「长龙」问题）：
 *   按落点相对方位选首选面；首选面被已占位节点（含先吸附的兄弟卡）占据时，
 *   依次换面（下 → 右 → 上 → 左，首选优先），四面全占才沿父卡右侧级联兜底。
 *   效果：往中间卡上拖子卡 → 子卡贴在该卡的空面上（通常是正下方），
 *   不再被「一路向右推」甩到队尾形成长龙。越出画布负区的面自动翻转到对侧。
 */
function lmbSnapChildPosition(parent, child, gap = 30, occupied = []) {
  const pcx = parent.x + parent.width / 2, pcy = parent.y + parent.height / 2;
  const ccx = child.x + child.width / 2, ccy = child.y + child.height / 2;
  const dx = ccx - pcx, dy = ccy - pcy;
  const midY = Math.max(0, parent.y + (parent.height - child.height) / 2);
  const midX = Math.max(0, parent.x + (parent.width - child.width) / 2);
  // 四方向候选；负区一面翻转到对侧
  const cand = {
    right:  { fromSide: "right",  toSide: "left",   x: parent.x + parent.width + gap, y: midY },
    bottom: { fromSide: "bottom", toSide: "top",    x: midX, y: parent.y + parent.height + gap },
    left:   { fromSide: "left",   toSide: "right",  x: parent.x - child.width - gap, y: midY },
    top:    { fromSide: "top",    toSide: "bottom", x: midX, y: parent.y - child.height - gap }
  };
  if (cand.left.x < 0) cand.left = { ...cand.right };
  if (cand.top.y < 0) cand.top = { ...cand.bottom };

  // 择面顺序：首选方位优先，其后 下 → 右 → 上 → 左（去重）
  const horiz = Math.abs(dx) >= Math.abs(dy);
  const pref = horiz ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top");
  const order = [];
  for (const s of [pref, "bottom", "right", "top", "left"]) {
    if (!order.includes(s)) order.push(s);
  }

  const hits = (c) => {
    const m = gap * 0.5;
    for (const o of occupied) {
      if (!o || o.id === child.id) continue;
      if (c.x < o.x + o.width + m && c.x + child.width + m > o.x &&
          c.y < o.y + o.height + m && c.y + child.height + m > o.y) return o;
    }
    return null;
  };
  for (const s of order) {
    if (!hits(cand[s])) return cand[s];
  }

  // 四面全占 → 兜底：沿父卡右侧向右级联（旧行为，guard 防死循环）
  let x = cand.right.x, guard = 0, blocker = hits(cand.right);
  while (blocker && guard++ < 24) {
    x = blocker.x + blocker.width + gap;
    if (x < 0) break;
    blocker = hits({ ...cand.right, x });
  }
  return { fromSide: "right", toSide: "left", x: Math.round(x), y: Math.round(cand.right.y) };
}

/**
 * v0.7.3：自动边的存活判定（纯函数，便于测试）。
 *   ⚠️ 绝不能按「端点是否重叠」判定 —— lmbLayoutGroup 排布的目的就是让子卡不再遮挡父卡，
 *   正常排布后父子必然不重叠；按重叠判定会把刚建的边自己删掉（v0.7.1「连线自动消失」回归）。
 *   当前规则：只有端点节点仍存在才保留；换父由调用方在新建边前显式移除旧的自动父边。
 */
function lmbAutoEdgeAlive(edge, byId) {
  if (!edge || !edge.fromNode || !edge.toNode) return false;
  return !!(byId.get(edge.fromNode) && byId.get(edge.toNode));
}

/**
 * v0.7.3：找出某张子卡当前的自动父边（用于「换父」时先摘掉旧的，避免同一张卡挂两条自动父子线）。
 */
function lmbAutoParentEdgeOf(childId, edges, sidecar) {
  for (const ed of edges || []) {
    if (!sidecar || !sidecar.has(ed.id)) continue;
    if (ed.toNode === childId) return ed;
  }
  return null;
}

/**
 * v0.6.0：由 child 当前中心相对 parent 中心，判定 child 在 parent 的哪一侧。
 *   主轴优先（横向 |dx| ≥ |dy| → right/left，否则 top/bottom），与 snapChild 选面规则一致。
 */
function lmbSideOf(child, parent) {
  const dx = (child.x + (child.width || 0) / 2) - (parent.x + parent.width / 2);
  const dy = (child.y + (child.height || 0) / 2) - (parent.y + parent.height / 2);
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top");
}

/**
 * v0.6.0：父→子 edge 的两端 side 标识（用于 SVG 连线端点）。
 */
function lmbSideEnds(side) {
  if (side === "right") return { fromSide: "right", toSide: "left" };
  if (side === "left") return { fromSide: "left", toSide: "right" };
  if (side === "top") return { fromSide: "top", toSide: "bottom" };
  return { fromSide: "bottom", toSide: "top" }; // bottom
}

/**
 * v0.6.0：从 edges 中导出指定父卡的所有子卡，按它们相对父卡的位置分组（right/left/top/bottom）。
 *   用法：拿到 kidsBySide.get(side) 后加上新子卡，整组调用 lmbLayoutGroup。
 */
function lmbGroupBySide(parent, nodes, edges) {
  const m = new Map();
  for (const e of edges || []) {
    let childId = null;
    if (e.fromNode === parent.id) childId = e.toNode;
    else if (e.toNode === parent.id) childId = e.fromNode;
    if (!childId) continue;
    const child = nodes.find((n) => n.id === childId);
    if (!child) continue;
    const side = lmbSideOf(child, parent);
    if (!m.has(side)) m.set(side, []);
    m.get(side).push(child);
  }
  return m;
}

/**
 * v0.6.0：同侧多子卡组居中布局 —— 修复「不同高度/宽度导致互相压住」的 bug。
 * v0.9.3：不再拉伸子卡尺寸（用户要求：把所有卡片拉成一样高/宽没有必要），
 *   改为「贴边对齐 + 组居中」：
 *   - 竖列（right/left）：保留各自宽高，左边贴齐（right）/右边贴齐（left），
 *     整列以父卡竖直中心为对称轴依次堆叠；
 *   - 横排（bottom/top）：保留各自宽高，顶边贴齐（bottom）/底边贴齐（top），
 *     整行以父卡水平中心为对称轴依次排开。
 *   效果：新增下方/右侧的卡时，整组自动重新居中，不会因尺寸不齐互相压住，
 *   且每张卡保持自己的自然大小。
 */
function lmbLayoutGroup(parent, kids, side, gap = 30) {
  if (!kids || !kids.length) return;
  const vertical = (side === "right" || side === "left");
  // ① 组居中：竖列同贴边 x + 整列竖直居中父卡；横排同贴边 y + 整行水平居中父卡
  if (vertical) {
    const totalH = kids.reduce((s, k) => s + (k.height || 0), 0) + gap * (kids.length - 1);
    const axisY = parent.y + parent.height / 2;
    let y = axisY - totalH / 2;
    for (const k of kids) {
      // right：各卡左边贴齐同一条 x；left：各卡右边贴齐（x 随卡宽各自退让）
      const x = side === "right"
        ? parent.x + parent.width + gap
        : parent.x - gap - (k.width || 0);
      k.x = Math.round(x);
      k.y = Math.round(y);
      y += (k.height || 0) + gap;
    }
  } else {
    const totalW = kids.reduce((s, k) => s + (k.width || 0), 0) + gap * (kids.length - 1);
    const axisX = parent.x + parent.width / 2;
    let x = axisX - totalW / 2;
    for (const k of kids) {
      // bottom：各卡顶边贴齐同一条 y；top：各卡底边贴齐（y 随卡高各自退让）
      const y = side === "bottom"
        ? parent.y + parent.height + gap
        : parent.y - gap - (k.height || 0);
      k.x = Math.round(x);
      k.y = Math.round(y);
      x += (k.width || 0) + gap;
    }
  }
}

/* ==================== v0.11.0：首连锁定 / 改挂侧 / 尺寸重居中 ==================== */

/**
 * v0.11.0（纯函数）：决定 nn 落到 parent 上时的自动连线动作。
 *   R3 首连锁定：一张卡最多一条「自动」边——已有自动父边且父不是 parent → skip，
 *   不再换父、不再自动新建（换父已移除；想换父请手动删线后重拖，手动边不参与锁定）。
 *   R4 改挂侧：nn 与 parent 之间已有边（自动或手动）→ reside：按落点方位改边端点 + 两侧组重排。
 *   create：nn 还没有任何自动边 → 首次自动建线（此后即锁定）。
 * 返回：
 *   { op: "skip" }                             — 不动作
 *   { op: "reside", edge, oldSide, newSide }   — 已有连线，改挂侧
 *   { op: "create", side }                     — 首次自动建线
 */
function lmbPlanAutoLink(nn, parent, edges, sidecar) {
  if (!nn || !parent || nn.id === parent.id) return { op: "skip" };
  const eds = Array.isArray(edges) ? edges : [];
  const auto = lmbAutoParentEdgeOf(nn.id, eds, sidecar);
  if (auto && auto.fromNode !== parent.id) return { op: "skip" }; // R3：首连锁定
  let linkEdge = null;
  for (const ed of eds) {
    if (!ed || !ed.fromNode || !ed.toNode) continue;
    if ((ed.fromNode === parent.id && ed.toNode === nn.id) ||
        (ed.fromNode === nn.id && ed.toNode === parent.id)) { linkEdge = ed; break; }
  }
  if (linkEdge) {
    const oldSide = (linkEdge.fromNode === parent.id) ? linkEdge.fromSide : linkEdge.toSide;
    return { op: "reside", edge: linkEdge, oldSide: oldSide, newSide: lmbSideOf(nn, parent) };
  }
  if (auto) return { op: "skip" }; // 理论不可达（自动边本身即 linkEdge），防御
  return { op: "create", side: lmbSideOf(nn, parent) };
}

/**
 * v0.11.0（纯函数，原地改 edge + 坐标）：执行「改挂侧」。
 *   ① edge 两端 side 改为新侧（保持 from/to 方向属性不变，只换端点标识）；
 *   ② 旧侧组（不含 nn）整组重排 —— nn 离开后该侧重新居中；
 *   ③ 新侧组（含 nn）整组 lmbLayoutGroup —— 组居中保证单子卡必在父卡横/纵轴上；
 *      oldSide === newSide 时只做③，等价「拖回原位重新对齐」，顺带修复手动拖歪。
 */
function lmbApplyReside(parent, nn, plan, nodes, edges) {
  const side = plan.newSide;
  const ends = lmbSideEnds(side);
  const ed = plan.edge;
  if (ed.fromNode === parent.id) { ed.fromSide = ends.fromSide; ed.toSide = ends.toSide; }
  else { ed.fromSide = ends.toSide; ed.toSide = ends.fromSide; }
  const others = (edges || []).filter((e) => e !== ed);
  const kidsBySide = lmbGroupBySide(parent, nodes, others);
  const strip = (arr) => (arr || []).filter((k) => k && k.id !== nn.id);
  if (plan.oldSide !== side) {
    const oldGroup = strip(kidsBySide.get(plan.oldSide));
    if (oldGroup.length) lmbLayoutGroup(parent, oldGroup, plan.oldSide, 30);
  }
  const newGroup = [...strip(kidsBySide.get(side)), nn];
  lmbLayoutGroup(parent, newGroup, side, 30);
  return { side, ends };
}

/**
 * v0.11.0（纯函数，原地改坐标）：尺寸变化后的组内重新居中 —— R1「乱放」的根因修复。
 *   根因链：instantAttach 用卡片落下时的默认小尺寸做组居中 → fitNode 随后把卡撑到
 *   真实内容尺寸 → 高度变了但 y 不变 → 中心偏出父卡横/纵轴（截图里的乱放）。
 *   本函数在 fitNode 之后调用：找 nn 的【自动】父边 → 定侧 → 该侧组（含 nn）整组重排，
 *   用新尺寸重新居中。只认自动边：手动连线的卡是用户亲手摆的，不自动挪。
 * 返回 true = 找到自动父边且至少移动了一个坐标。
 */
function lmbRecenterNode(nn, nodes, edges, sidecar) {
  if (!nn || !nodes || !edges) return false;
  const auto = lmbAutoParentEdgeOf(nn.id, edges, sidecar || new Set());
  if (!auto) return false;
  const parentId = auto.fromNode;
  const parent = nodes.find((n) => n && n.id === parentId);
  if (!parent || parent.type === "group") return false;
  const side = auto.fromSide || lmbSideOf(nn, parent);
  const group = [];
  for (const e of edges) {
    if (!e || e === auto) continue;
    let cid = null;
    if (e.fromNode === parentId) cid = e.toNode;
    else if (e.toNode === parentId) cid = e.fromNode;
    if (!cid || cid === nn.id) continue;
    const child = nodes.find((n) => n && n.id === cid);
    if (child && child.type !== "group" && lmbSideOf(child, parent) === side) group.push(child);
  }
  group.push(nn);
  const before = group.map((k) => k.x + ":" + k.y).join("|");
  lmbLayoutGroup(parent, group, side, 30);
  const after = group.map((k) => k.x + ":" + k.y).join("|");
  return before !== after;
}

/**
 * 由 entries（已按页/画布序排好）+ parentOf（canvas 边导出的 childExId→parentExId）建树。
 * 父不在本组 / 自环 → 当根；环由渲染端 rendered 集合兜底，绝不死循环。
 */
function lmbBuildTree(entries, parentOf) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const children = new Map();
  const roots = [];
  for (const en of entries) {
    const p = (en.parentId && en.parentId !== en.id && byId.has(en.parentId)) ? en.parentId : null;
    if (p) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(en);
    } else {
      roots.push(en);
    }
  }
  return { roots, children };
}

/**
 * canvas 新卡识别（纯函数）：prevIds=null 表示该画布从未见过（插件加载后首扫或全新画布）
 * → 只建档不动作；否则 diff 出新落下的 ^ex 卡。
 * 注意：canvasSeen 已持久化到 data.json（v0.4.1 修复），重载后 prevIds 仍在，
 * 「重载后拖第一张卡」不再被 firstRun 吞掉——这是 v0.4.0「完全没效果」的必现根因。
 */
function lmbDiffCanvasNodes(prevIds, exNodes) {
  if (!prevIds) return { firstRun: true, newNodes: [] };
  return { firstRun: false, newNodes: exNodes.filter((n) => !prevIds.has(n.id)) };
}

/**
 * P1：解析摘录文档正文 → 条目数组。**纯函数**（不碰 this / 不碰 DOM），
 * 挂 __test 供 node 冒烟离线验证。
 *
 * 摘录文档实际形态（writeExcerptMd 产出，支持任意层嵌套引用块）：
 *   ## P.21
 *
 *   > ([[x.pdf#page=21&selection=0,0,655,478|【x-P.21】]])
 *   > 这是摘录正文
 *   > #核心观点
 *   ^ex-1a2b3c
 *   > [!ppd-note] 💬 添加评论        ← 补充描述 callout，不算摘录正文
 *   > 点击此处写下你的想法...
 *
 *   > > ([[x.pdf#page=21&selection=9,0,9,42|【x-P.21】]])   ← 嵌套子条目
 *   > > 子摘录正文
 *   > ^ex-4d5e6f
 *
 * 返回条目：{ pdfPath, page, selection:[a,b,c,d]|null, exId, tags:[], text, sourceMd, line }
 * 注意：^ex- 是块尾锚点——遇到它就给当前条目定稿。没有 ^ex- 的悬空条目也会保留
 *       （exId 为 null），遵循全插件「宁可画得不准也不丢数据」的原则。
 */
function lmbParseExcerptDoc(content, sourcePath) {
  const entries = [];
  if (!content || typeof content !== "string") return entries;
  const lines = content.split(/\r?\n/);
  let pending = null;
  const flush = () => { if (pending) { entries.push(pending); pending = null; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] || "";

    // 1) 回跳链接行 → 开新条目
    LMB_LINK_RE.lastIndex = 0;
    const lm = LMB_LINK_RE.exec(raw);
    if (lm) {
      flush();
      const sm = LMB_SEL_RE.exec((lm[3] || "").trim());
      const rm = LMB_RECT_RE.exec((lm[4] || "").trim());
      pending = {
        pdfPath: lm[1],
        page: parseInt(lm[2], 10),
        selection: sm ? [+sm[1], +sm[2], +sm[3], +sm[4]] : null,
        rect: rm ? [+rm[1], +rm[2], +rm[3], +rm[4]] : null,
        exId: null,
        tags: [],
        text: "",
        sourceMd: sourcePath || null,
        line: i
      };
      continue;
    }
    if (!pending) continue;

    // 2) ^ex- 锚点 → 定稿
    const ex = EX_ID_RE.exec(raw);
    if (ex) {
      pending.exId = ex[0].replace(/^\^/, "");
      entries.push(pending);
      pending = null;
      continue;
    }
    // 3) 补充描述 callout 不属于摘录正文
    //    （不能用 NOTE_CALLOUT_RE：它锚定单个 >，嵌套层级的 "> > [!xx]" 匹配不到）
    if (/^\s*(?:>\s*)+\[!/.test(raw)) continue;

    // 4) 剥掉【所有】层 > 前缀后再判定
    //    （"> > 正文" 必须剥成 "正文"，只剥一个 > 会留下残留的 "> "）
    const stripped = raw.replace(/^\s*(?:>\s*)+/, "").trim();
    if (!stripped) continue;
    if (stripped.charAt(0) === "#") {
      const tm = stripped.match(/#([\w\u4e00-\u9fa5\/]+)/g);
      if (tm) for (const t of tm) pending.tags.push(t.slice(1));
      continue;
    }
    // 5) 正文累积（跨行用空格连接，与 cleanPdfText 的语义一致）
    pending.text += (pending.text ? " " : "") + stripped;
  }
  flush();
  return entries;
}

class LuciasMarginBookPlugin extends Plugin {

  async onload() {
    this.syncTimers = new Map();
    this.selfWritten = new Map();
    this.autoSize = new Map();
    this.imgDims = new Map();        // webp 全名 -> {w,h}
    this.chipEl = null;
    this._saveTimer = null;
    this._chipSig = null;            // 当前 chip 承载的选区签名（text@page），防重复重建
    this.canvasPositions = new Map(); // v0.7.0：canvas 路径 -> 节点 id -> {x,y,width,height}（位置 diff 识别「刚被拖动」的卡）
    this.autoEdges = new Map();      // v0.7.1：canvas 路径 -> 自动建边的 id 集合（用于清理不再重叠的瞬时孤儿边，防重复连线）
    this._lastNoSelNotice = 0;
    this.rectMode = false;           // ribbon 按钮的一次性框选模式
    this._ribbonEl = null;
    this._dragArm = null;            // 我们的 chip 拖拽进行中（drop 捕获用）
    this._instantSkip = 0;           // 即时通道成功后短暂抑制文件层自动父子（防双写）
    this._dropFlush = null;          // v0.7.2：canvas 内松手后的快速通道 {path, t, timer}

    // P1：摘录索引层（反向索引：摘录 md → PDF/页/选区）
    this.excerptIndex = new Map();   // pdf 路径 -> 条目数组
    this.indexMtime = new Map();     // 摘录文档路径 -> mtime（增量判定用）
    this._isIndexing = false;        // 全量重建进行中标记（防重入）
    // P3.5：exId -> canvas 卡片位置（反向跳转优先进画布，而非 md）
    this.excerptCanvasIndex = new Map();

    // 补丁 B：相关笔记缓存 + 颜色归一化上下文（须在 settings 与 canvas 监听之前就绪）
    this.relatedCache = new Map();   // 摘录 id -> 相关笔记 wikilink 数组（每 id 只检索一次）
    this._colorCtx = null;           // 颜色归一化用的离屏 canvas 2d context（惰性创建）
    this.settings = Object.assign({
      debug: true, colorMap: "",
      // v0.8.0：卡片补充描述
      noteCalloutType: "ppd-note",  // callout 类型名（渲染成框）
      noteTitle: "补充描述",         // callout 标题
      noteFoldByDefault: false,     // 新建时是否默认折叠
      noteIntoSync: false,          // 补充描述是否同步进摘录 md（默认否，保持摘录文档干净）
      noteAutoBoxOnNew: true,       // v0.8.2：新摘录卡自动挂一个空的补充描述框（一眼能看见）
      commentAutoBoxOnNew: true     // v0.11.0：新摘录卡自动挂评论栏（PDF Flow 式底栏按钮）
    }, await this.loadData());
    // 补丁 C：Recall 回忆模式状态（settings.recallDefault = 是否默认开启）
    this.recallMode = !!this.settings.recallDefault;
    try {
      if (this.settings.autoSizes) {
        for (const [path, entries] of Object.entries(this.settings.autoSizes)) {
          this.autoSize.set(path, new Map(entries));
        }
      }
      if (this.settings.imgDims) {
        for (const [k, v] of Object.entries(this.settings.imgDims)) this.imgDims.set(k, v);
      }
      // v0.7.0：恢复持久化的画布节点位置档案（用于位置 diff 识别「刚被拖动」的卡）
      if (this.settings.canvasPositions) {
        for (const [p, entries] of Object.entries(this.settings.canvasPositions)) {
          this.canvasPositions.set(p, new Map(entries));
        }
      }
      // v0.7.1：恢复持久化的「自动建边 id」档案（跨重载识别哪些边是插件自动建的，可清理）
      if (this.settings.autoEdges) {
        for (const [p, ids] of Object.entries(this.settings.autoEdges)) {
          this.autoEdges.set(p, new Set(ids));
        }
      }
    } catch (_) { /* noop */ }

    this.registerDomEvent(document, "mousedown", (e) => this.onDocMouseDown(e), true);
    this.registerDomEvent(document, "mouseup", (e) => this.onDocMouseUp(e), true);
    this.registerDomEvent(document, "scroll", () => this.hideChip(), true);

    // v0.7.2 松手快速通道：canvas 内 mouseup → 武装 flush，让下一个 modify 走 80ms 极短防抖
    // （原本要干等 400ms 才重排）。capture 阶段注册，早于 Obsidian 自己的 canvas mouseup。
    // v0.9.3：再加内存级即时通道 —— mouseup 后不等 Obsidian 落盘，直接在 canvas 内存数据上
    // 做父子判定 + 组排布（setData 毫秒级生效），落盘管线退为兜底。
    this.registerDomEvent(document, "mouseup", (e) => {
      try {
        const f = this.canvasFileFromEvent(e);
        if (f) this.armDropFlush(f);
        if (e.button === 0) {
          const canvasObj = this.canvasObjFromEvent(e);
          if (canvasObj) {
            this.instantMoveAttach(canvasObj).catch((err) =>
              console.warn("[lmb] instant move error:", err));
          }
        }
      } catch (_) { /* noop */ }
    }, true);

    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f instanceof TFile && f.extension === "canvas") {
        if (this.selfWritten.get(f.path)) { this.selfWritten.delete(f.path); return; }
        // v0.7.2 快速通道：刚在 canvas 松手 → 用 80ms 而非 400ms（省 ~320ms 延迟）
        const flush = this._dropFlush;
        if (flush && flush.path === f.path && Date.now() - flush.t < 1500) {
          if (flush.timer) clearTimeout(flush.timer);
          this._dropFlush = null;
          const old = this.syncTimers.get(f.path);
          if (old) clearTimeout(old);
          this.syncTimers.set(f.path, setTimeout(() => {
            this.syncTimers.delete(f.path);
            this.processCanvas(f).catch((err) =>
              console.error("[lmb] canvas process failed:", err));
          }, 80));
          return;
        }
        this.scheduleCanvasSync(f);
      }
    }));

    // v0.5.0 即时通道：捕获我们的 chip 落进 canvas 的 drop 事件，走 canvas 内部 API
    // （getData/setData/requestSave）直接改内存数据，毫秒级生效；
    // 内部 API 缺失/超时/没压中卡 → 静默退回文件层管线（250ms + 出生重试）。
    this.registerDomEvent(document, "drop", (e) => {
      try {
        if (!this._dragArm) return;
        const target = e.target && e.target.nodeType === 1 ? e.target : null;
        if (!target) return;
        const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.containerEl.contains(target));
        const canvasObj = leaf && leaf.view && leaf.view.canvas;
        if (!canvasObj || typeof canvasObj.getData !== "function" ||
            typeof canvasObj.setData !== "function" || typeof canvasObj.requestSave !== "function") {
          console.log("[lmb] canvas 内部 API 不可用 → 文件层兜底（250ms）");
          return;
        }
        this.instantAttach(canvasObj).catch((err) => console.warn("[lmb] instant attach error:", err));
      } catch (err) {
        console.warn("[lmb] drop capture error:", err);
      }
    }, true);

    // 侧边栏按钮：一次性图片框选模式
    this._ribbonEl = this.addRibbonIcon("scan-search", "MarginBook: 图片框选（点击后在 PDF 上直接拖拽）", () => {
      this.rectMode = !this.rectMode;
      this.updateRibbonState();
      new Notice(this.rectMode
        ? "MarginBook: 图片框选模式已开启 —— 在 PDF 上直接拖拽即可（一次性）"
        : "MarginBook: 图片框选模式已关闭", 3000);
    });
    if (this._ribbonEl) this._ribbonEl.addClass("lmb-btn");

    /* v0.8.1：侧边栏按钮 —— 给（画布里选中的）卡片添加/编辑补充描述。
     *   用户偏好 GUI 胜过 CLI（记命令费劲），所以把 edit-card-note 命令也挂到侧边栏。
     *   按钮状态跟随「当前是否在 canvas 视图」：在画布里高亮，不在则灰（点了会提示）。 */
    this._noteRibbonEl = this.addRibbonIcon("message-square",
      "MarginBook: 给卡片添加 / 编辑补充描述（需在画布里选中一张卡）", () => {
        this.runCardNoteCommand("edit").catch((err) => {
          console.error("[lmb] note command failed:", err);
          new Notice("补充描述操作失败，详情见控制台");
        });
      });
    if (this._noteRibbonEl) this._noteRibbonEl.addClass("lmb-btn");
    this.updateNoteRibbonState();
    // 切换视图时刷新按钮可用性（灰/亮）
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.updateNoteRibbonState();
    }));

    /* v0.11.0：侧边栏按钮 —— 给（画布里选中的）卡片添加/编辑评论（独立评论体系）。 */
    this._commentRibbonEl = this.addRibbonIcon("message-square-plus",
      "MarginBook: 给卡片添加 / 编辑评论（需在画布里选中一张卡）", () => {
        this.runCardCommentCommand("edit").catch((err) => {
          console.error("[lmb] comment command failed:", err);
          new Notice("评论操作失败，详情见控制台");
        });
      });
    if (this._commentRibbonEl) this._commentRibbonEl.addClass("lmb-btn");

    // v0.11.0：canvas 里点「评论栏」直接弹编辑框（capture 层，折叠箭头/非 canvas 不拦截）
    this.registerDomEvent(document, "click", (e) => this.onCanvasCalloutClick(e), true);

    /* ---- P1：摘录索引的增量维护 ----
     * modify 会在每次敲键触发，所以 reindexFile 内有两道廉价闸门
     * （不链 pdf 且不在索引中 → 跳过；mtime 未变 → 跳过），不会读盘。
     */
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f && f.extension === "canvas") this.lmbIndexCanvasFile(f);   // P3.5：canvas 索引
      else this.reindexFile(f);
    }));
    this.registerEvent(this.app.vault.on("create", (f) => {
      if (f && f.extension === "canvas") this.lmbIndexCanvasFile(f);
      else this.reindexFile(f);
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      if (!f) return;
      if (f.extension === "canvas") {
        for (const [k, v] of Array.from(this.excerptCanvasIndex.entries())) {
          if (v && v.canvasPath === f.path) this.excerptCanvasIndex.delete(k);
        }
      } else this.dropFileFromIndex(f.path);
    }));
    this.app.workspace.onLayoutReady(() => { this.buildExcerptIndex(); });

    /* ---- P2：回绘标记的触发时机 ----
     * 注意 pdf.js 虚拟化：不能假设"打开 PDF 就能画"。
     * ① file-open：打开文件后等 300ms 让 pdf.js 渲出首页
     * ② layout-change / active-leaf-change：切标签页、改布局时重画
     * ③ MutationObserver（lmbSetupObserver）：滚动虚拟化增删页面时重画
     */
    this.registerEvent(this.app.workspace.on("file-open", (f) => {
      if (f && f.extension === "pdf") this.lmbScheduleMarksRefresh(300);
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.lmbScheduleMarksRefresh(250);
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.lmbScheduleMarksRefresh(250);
    }));

    // P3：接管 pdf 链接（主力 = DOM 捕获层拦截，优先级高于一切其他插件；openLinkText 劫持作兜底）
    this.lmbSetupLinkInterception();

    this.addCommand({
      id: "rect-select-mode",
      name: "图片框选模式（下一次拖拽生效）",
      callback: () => {
        this.rectMode = true;
        this.updateRibbonState();
        new Notice("MarginBook: 图片框选模式已开启 —— 在 PDF 上直接拖拽即可（一次性）", 3000);
      }
    });

    // 补丁 C：Recall 回忆模式开关：模糊摘录 blockquote，点击揭示（借鉴 MarginNote 4.4）
    this.addCommand({
      id: "recall-toggle",
      name: "回忆模式：开关（模糊摘录，点击揭示）",
      callback: () => {
        try {
          this.recallMode = !this.recallMode;
          if (!this.recallMode) {
            // 关闭时立即清除页面上已模糊的元素（无需等重新渲染）
            document.querySelectorAll(".lmb-recall-blur").forEach((n) => {
              n.classList.remove("lmb-recall-blur", "lmb-recall-reveal");
              if (n._ppdReblurTimer) clearTimeout(n._ppdReblurTimer);
            });
          }
          new Notice(this.recallMode
            ? "回忆模式已开启：摘录已模糊，点击揭示（3 秒后重新模糊）"
            : "回忆模式已关闭", 3000);
        } catch (err) {
          console.warn("[lmb] recall toggle error:", err);
        }
      }
    });

    // 补丁 C：直达当前 PDF 的摘录文档（<PDF名>-摘录.md）
    this.addCommand({
      id: "open-excerpt-doc",
      name: "打开当前 PDF 的摘录文档",
      checkCallback: (checking) => {
        try {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "pdf") return false; // 非活动 PDF 时置灰
          if (checking) return true;
          // v0.9.1：同名摘录 md 可能撞名（命名按 basename，跨目录会重）。
          //   优先取与 PDF 同目录的；仍有多个 → 弹选择器让用户挑，不再静默取第一个。
          const all = this.app.vault.getMarkdownFiles()
            .filter((f) => f.basename === file.basename + "-摘录");
          if (!all.length) {
            new Notice("尚未生成摘录文档（先拖一条摘录到画布）");
            return true;
          }
          const pdfDir = file.parent && file.parent.path ? file.parent.path : "/";
          const sameFolder = all.find((f) => f.parent && f.parent.path === pdfDir);
          const picks = sameFolder ? [sameFolder] : all;
          if (picks.length === 1) {
            this.app.workspace.openLinkText(picks[0].path, "", false);
          } else {
            new LMBNodeSuggester(this.app,
              picks.map((f) => ({ label: f.path, path: f.path })),
              (it) => this.app.workspace.openLinkText(it.path, "", false));
          }
          return true;
        } catch (err) {
          console.warn("[lmb] open-excerpt-doc error:", err);
          return false;
        }
      }
    });

    this.addCommand({
      id: "copy-selection-as-quote",
      name: "复制当前 PDF 选区为引用块（含回跳链接）",
      checkCallback: (checking) => {
        const sel = window.getSelection();
        const info = sel && !sel.isCollapsed ? this.extractSelection(sel) : null;
        if (checking) return !!info;
        if (info) {
          navigator.clipboard.writeText(this.buildDropText(info));
          new Notice("已复制引用块到剪贴板");
        }
        return true;
      }
    });

    // v0.6.0：规范化当前画布上已有的重叠摘录卡片。
    //   扫描当前打开的 canvas（或全 vault），对每对重叠的 ^ex 卡建父子边，
    //   按 (parent, side) 全组重排（v0.9.3 起为贴边对齐 + 以父卡中心对称轴组居中，
    //   不再拉伸子卡尺寸），写回画布文件。重复运行幂等。
    this.addCommand({
      id: "normalize-existing-excerpts",
      name: "规范化画布上已有的重叠摘录卡片（贴边对齐+组居中）",
      callback: async () => {
        await this.normalizeOverlappingExcerpts();
      }
    });

    /* ---- v0.8.0：卡片补充描述（note）三条命令 ---- */
    this.addCommand({
      id: "edit-card-note",
      name: "给卡片添加 / 编辑补充描述",
      callback: async () => { await this.runCardNoteCommand("edit"); }
    });
    this.addCommand({
      id: "remove-card-note",
      name: "移除卡片的补充描述",
      callback: async () => { await this.runCardNoteCommand("remove"); }
    });
    this.addCommand({
      id: "toggle-card-note-fold",
      name: "折叠 / 展开卡片的补充描述",
      callback: async () => { await this.runCardNoteCommand("fold"); }
    });
    // v0.8.2：批量入口 —— 一条命令给当前画布所有摘录卡挂上空的补充描述框，
    // 让用户不依赖侧边栏按钮也能立刻看到效果（ribbon 在某些环境不出现）。
    this.addCommand({
      id: "add-note-box-to-all",
      name: "给画布上所有摘录卡添加补充描述框",
      callback: async () => { await this.addNoteBoxToAllCards(); }
    });

    /* ---- v0.11.0：独立评论（批注评论底栏）命令 ---- */
    this.addCommand({
      id: "edit-card-comment",
      name: "给卡片添加 / 编辑评论",
      callback: async () => { await this.runCardCommentCommand("edit"); }
    });
    this.addCommand({
      id: "remove-card-comment",
      name: "移除卡片的评论",
      callback: async () => { await this.runCardCommentCommand("remove"); }
    });
    this.addCommand({
      id: "add-comment-box-to-all",
      name: "给画布上所有摘录卡添加评论栏",
      callback: async () => { await this.addCommentBoxToAllCards(); }
    });

    /* ---- P1：摘录索引 ---- */
    this.addCommand({
      id: "lmb-rebuild-index",
      name: "重建摘录索引",
      callback: async () => {
        const s = await this.buildExcerptIndex();
        new Notice("MarginBook: 索引已重建 —— PDF " + s.pdfs
          + " 个 / 摘录 " + s.excerpts + " 条 / 文件 " + s.files + " 个");
      }
    });
    this.addCommand({
      id: "lmb-index-stats",
      name: "显示摘录索引统计",
      callback: () => {
        const s = this.getIndexStats();
        new Notice("MarginBook: PDF " + s.pdfs
          + " 个 / 摘录 " + s.excerpts + " 条 / 已索引文件 " + s.files + " 个");
      }
    });

    // P2：强制刷新摘录标记（解决标记消失 / 没画出来的兜底入口）
    this.addCommand({
      id: "lmb-refresh-marks",
      name: "强制刷新摘录标记",
      callback: () => { this.lmbRefreshAllMarks(); }
    });

    this.addSettingTab(new LMBSettingTab(this.app, this));
    this.injectStyles();

    // 补丁 C：Recall——阅读模式下把含「【文件名-P.数字】」回跳链接的 blockquote 模糊化。
    // 揭示策略 = 点击后展示 3 秒自动重新模糊：
    //   ① 单向流程，无"再点一次是隐藏还是保持"的歧义，不易误触；
    //   ② 更贴 Recall 训练节奏（回忆 → 自动再藏）；定时器挂在元素上，重复点击只续期不叠加。
    this.registerMarkdownPostProcessor((el, ctx) => {
      try {
        if (!this.recallMode) return;
        let quotes = el.querySelectorAll ? Array.from(el.querySelectorAll("blockquote")) : [];
        if (el.matches && el.matches("blockquote")) quotes.unshift(el); // 片段本身即 blockquote
        for (const bq of quotes) {
          if (bq.dataset.lmbRecall === "1") continue;                    // 防重复处理
          if (!/【[^】]+-P\.\d+】/.test(bq.textContent || "")) continue;  // 仅命中摘录回跳块
          bq.dataset.lmbRecall = "1";
          bq.classList.add("lmb-recall-blur");
          bq.addEventListener("click", (ev) => {
            ev.stopPropagation();
            bq.classList.add("lmb-recall-reveal");
            clearTimeout(bq._ppdReblurTimer);
            bq._ppdReblurTimer = setTimeout(() => {
              bq.classList.remove("lmb-recall-reveal");
            }, 3000);
          });
        }
      } catch (err) {
        console.warn("[lmb] recall postProcessor error:", err);
      }
    });

    this.debugNotice("已加载 ✓（v0.8.1：拖拽摘录 / 自动父子组居中 / 卡片补充描述）");
    console.log("[lmb] loaded (v0.11.0)");
  }

  onunload() {
    this.hideChip();
    this.syncTimers.forEach((t) => clearTimeout(t));
    this.syncTimers.clear();

    // P3.5：先拆 DOM 层链接拦截（越早越好，避免卸载过程中还拦截点击）
    this.lmbTeardownLinkInterception();

    // v0.9.2：撤掉重叠自愈定时器
    try { if (this._ppdHealTimer) { clearTimeout(this._ppdHealTimer); this._ppdHealTimer = null; } }
    catch (_) { /* noop */ }

    // P2：拆掉所有 MutationObserver、清掉所有回绘标记、撤掉防抖定时器
    try {
      if (this._ppdMarksTimer) { clearTimeout(this._ppdMarksTimer); this._ppdMarksTimer = null; }
      const leaves = this.app.workspace.getLeavesOfType("pdf");
      for (const l of leaves) {
        const v = l && l.view;
        if (!v) continue;
        this.lmbDisconnectObserver(v);
        if (v.containerEl) this.lmbClearMarks(v.containerEl);
      }
      document.querySelectorAll(".lmb-mark").forEach((m) => { if (m.parentNode) m.parentNode.removeChild(m); });

      // P3：拆掉双击监听（openLinkText 的还原走 this.register，无需在此处理）
      for (const t of (this._ppdDblClickTargets || [])) {
        try {
          if (t && t._ppdMarkDblClick) {
            t.removeEventListener("dblclick", t._ppdMarkDblClick);
            t._ppdMarkDblClick = null;
          }
        } catch (_) { /* noop */ }
      }
      this._ppdDblClickTargets = [];
    } catch (err) {
      console.warn("[lmb] onunload cleanup error:", err);
    }

    const st = document.getElementById("lmb-styles");
    if (st) st.remove();
  }

  updateRibbonState() {
    if (!this._ribbonEl) return;
    this._ribbonEl.toggleClass("is-active", !!this.rectMode);
  }

  /**
   * v0.8.1：补充描述按钮的可用性状态。
   *   这是「动作按钮」不是「模式开关」，所以不用 is-active（那是"已开启"的高亮语义，会误导）。
   *   改为：不在 canvas 视图 → 加 is-idle 灰显（表示当前点了也没用）；在 canvas → 恢复正常。
   *   仅视觉提示，点击时仍走 runCardNoteCommand 的上下文检查（双重保险）。
   */
  updateNoteRibbonState() {
    if (!this._noteRibbonEl) return;
    let inCanvas = false;
    try { inCanvas = !!this.activeCanvasContext(); } catch (_) { inCanvas = false; }
    this._noteRibbonEl.toggleClass("is-idle", !inCanvas);
  }

  debugNotice(msg) {
    console.log("[lmb]", msg);
    if (this.settings && this.settings.debug) new Notice("MarginBook: " + msg, 4000);
  }

  /* ==================== 设置 ==================== */

  async saveSettings() {
    const obj = { debug: this.settings.debug };
    obj.recallDefault = !!this.settings.recallDefault; // 补丁 C：回忆模式默认值
    obj.colorMap = this.settings.colorMap;             // 补丁 B：颜色语义映射
    // v0.8.0：卡片补充描述设置
    obj.noteCalloutType = this.settings.noteCalloutType;
    obj.noteTitle = this.settings.noteTitle;
    obj.noteFoldByDefault = !!this.settings.noteFoldByDefault;
    obj.noteIntoSync = !!this.settings.noteIntoSync;
    obj.noteAutoBoxOnNew = this.settings.noteAutoBoxOnNew !== false;
    obj.commentAutoBoxOnNew = this.settings.commentAutoBoxOnNew !== false; // v0.11.0
    if (this.autoSize.size) {
      const autoSizes = {};
      for (const [path, store] of this.autoSize) autoSizes[path] = Array.from(store.entries());
      obj.autoSizes = autoSizes;
    }
    if (this.imgDims.size) obj.imgDims = Object.fromEntries(this.imgDims);
    // v0.7.0：持久化画布节点位置（用于位置 diff 识别「刚被拖动」的卡）
    if (this.canvasPositions && this.canvasPositions.size) {
      const pos = {};
      for (const [p, m] of this.canvasPositions) {
        if (m.size) pos[p] = Array.from(m.entries());
      }
      if (Object.keys(pos).length) obj.canvasPositions = pos;
    }
    // v0.7.1：持久化「自动建边 id」档案（用于清理瞬时重叠产生的孤儿边）
    if (this.autoEdges && this.autoEdges.size) {
      const ae = {};
      for (const [p, s] of this.autoEdges) {
        if (s.size) ae[p] = Array.from(s);
      }
      if (Object.keys(ae).length) obj.autoEdges = ae;
    }
    await this.saveData(obj);
  }

  /* ==================== 框选启动（按钮模式 / Alt） ==================== */

  onDocMouseDown(e) {
    if (this.chipEl && !this.chipEl.contains(e.target)) this.hideChip();

    const el = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
    if (!el || !el.closest) return;
    const leafEl = el.closest(".workspace-leaf");
    const leaf = leafEl && this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl);

    // Alt 或 按钮模式 → 启动自带框选
    if ((e.altKey || this.rectMode) && e.button === 0 && leaf && leaf.view && leaf.view.file) {
      if (!e.altKey) e.preventDefault(); // 按钮模式拦截文字选择（Alt 亦然）
      e.stopPropagation();
      this.startRectDrag(leaf, e);
      return;
    }
  }

  startRectDrag(leaf, e) {
    const doc = typeof activeDocument !== "undefined" ? activeDocument : document;
    const box = doc.createElement("div");
    box.className = "lmb-rect";
    doc.body.appendChild(box);
    this.debugNotice("框选中…");

    const sx = e.clientX, sy = e.clientY;
    const mv = (ev) => {
      ev.preventDefault();
      box.style.left = Math.min(sx, ev.clientX) + "px";
      box.style.top = Math.min(sy, ev.clientY) + "px";
      box.style.width = Math.abs(ev.clientX - sx) + "px";
      box.style.height = Math.abs(ev.clientY - sy) + "px";
    };
    const up = async (ev) => {
      document.removeEventListener("mousemove", mv, true);
      document.removeEventListener("mouseup", up, true);
      box.remove();
      const w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy);
      if (w < 8 || h < 8) return; // 误触，按钮模式保持

      const pageEl = this.pageAtPoint(doc, ev.clientX, ev.clientY) || this.pageAtPoint(doc, sx, sy);
      if (!pageEl) { this.debugNotice("✗ 框选区域不在 PDF 页面内"); return; }
      const pageNum = parseInt(pageEl.dataset.pageNumber, 10) || 1;

      const screenRect = {
        left: Math.min(sx, ev.clientX), top: Math.min(sy, ev.clientY),
        right: Math.max(sx, ev.clientX), bottom: Math.max(sy, ev.clientY)
      };
      const ctx = await this.captureRectImage(leaf.view, pageEl, screenRect, pageNum);
      if (ctx) {
        if (this.rectMode) { this.rectMode = false; this.updateRibbonState(); } // 一次性消费
        this.debugNotice("✓ 截图已保存 " + ctx.attachmentName + "（" + ctx.imgW + "×" + ctx.imgH + "）");
        this.showChip(ev.clientX, ev.clientY, "🖼 图片已截图 · 按住拖到 md 或画布", ctx);
      } else {
        this.debugNotice("✗ 截图失败（页面画布不可用）");
      }
    };
    document.addEventListener("mousemove", mv, true);
    document.addEventListener("mouseup", up, true);
  }

  pageAtPoint(doc, x, y) {
    const hit = doc.elementFromPoint(x, y);
    return hit && hit.closest ? hit.closest(".page[data-page-number]") : null;
  }

  /* ==================== mouseup：出示手柄 ==================== */

  onDocMouseUp(e) {
    const doc = typeof activeDocument !== "undefined" ? activeDocument : document;

    // ① 文字选区（v0.3.1：经 lmbShouldReshowSelection 把关，杜绝拖放后旧选区反复重建 chip）
    const win = typeof activeWindow !== "undefined" ? activeWindow : window;
    const sel = win.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const info = this.extractSelection(sel);
      if (info) {
        const sig = info.text + "@" + info.pageNum;
        const hit = doc.elementFromPoint(e.clientX, e.clientY);
        const show = lmbShouldReshowSelection({
          hasSelection: true,
          targetOnChip: !!(this.chipEl && this.chipEl.contains(e.target)),
          chipVisible: !!this.chipEl,
          sameSelection: this._chipSig === sig,
          mouseOnPdf: !!(hit && hit.closest && hit.closest(".page[data-page-number]"))
        });
        if (show) {
          this._chipSig = sig; // 记录 chip 当前承载的选区签名（dragend 时清除）
          this.debugNotice("✓ 文字选区 " + info.display + "（" + info.text.length + " 字）");
          this.showChip(e.clientX, e.clientY, "📑 " + info.text.length + " 字 · 按住拖到 md 或画布", info);
          return;
        }
        // 被把关拦下（点在 chip 上 / 同选区重复 / 释放点不在 PDF 内）→ 静默，不再刷屏
        return;
      }
    }

    // ② v0.7.2：兜底提示只在「点的是 PDF 视图」时才可能弹。
    //    根因：onDocMouseUp 是 document 级全局监听（capture），点 canvas / md / 侧栏
    //    同样会跑到这里 —— 用户「还没选 PDF」就被提示，纯噪音。
    //    注意：debugNotice 里有 console.log 是无条件的，所以这里 return 前不调用即可彻底静默。
    if (!this.eventInPdfLeaf(e)) return;
    const now = Date.now();
    if (now - this._lastNoSelNotice > 5000) {
      this._lastNoSelNotice = now;
      this.debugNotice("mouseup：无文字选区（图片框选 = 侧栏按钮 或 Alt+拖）");
    }
  }

  /**
   * v0.7.2：判定鼠标事件是否发生在 PDF 视图（leaf）内。
   *   复用 onDocMouseDown 同款解析：事件目标 → 最近 .workspace-leaf → 在 getLeavesOfType("pdf") 里匹配。
   *   用于在「非 PDF 上下文」（canvas / md / 侧栏）彻底静默本插件的调试提示。
   */
  eventInPdfLeaf(e) {
    const t = e && e.target;
    const el = t && t.nodeType === 1 ? t : (t && t.parentElement);
    if (!el || !el.closest) return false;
    const leafEl = el.closest(".workspace-leaf");
    if (!leafEl) return false;
    try {
      return !!this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl);
    } catch (_) {
      return false;
    }
  }

  /**
   * v0.7.2：判定鼠标事件是否发生在 canvas 视图（leaf）内，返回其文件。
   */
  canvasFileFromEvent(e) {
    const t = e && e.target;
    const el = t && t.nodeType === 1 ? t : (t && t.parentElement);
    if (!el || !el.closest) return null;
    const leafEl = el.closest(".workspace-leaf");
    if (!leafEl) return null;
    try {
      const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.containerEl === leafEl);
      const f = leaf && leaf.view && leaf.view.file;
      return f && f.extension === "canvas" ? f : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * v0.9.3：由鼠标事件找到所在 canvas 视图的内部 canvas 对象（API 齐全才返回），
   * 供 instantMoveAttach 在内存数据上直接做父子判定（不等落盘）。
   */
  canvasObjFromEvent(e) {
    const t = e && e.target;
    const el = t && t.nodeType === 1 ? t : (t && t.parentElement);
    if (!el || !el.closest) return null;
    const leafEl = el.closest(".workspace-leaf");
    if (!leafEl) return null;
    try {
      const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.containerEl === leafEl);
      const c = leaf && leaf.view && leaf.view.canvas;
      return (c && typeof c.getData === "function" &&
        typeof c.setData === "function" && typeof c.requestSave === "function") ? c : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * v0.7.2：松手快速通道（drop flush）。
   *   拖拽期间 Obsidian canvas 连续触发 modify，400ms 防抖不断被重置 → 松手后还要干等 400ms。
   *   这里在 canvas 内 mouseup 时「武装」一次 flush：下一个 modify（= Obsidian 落盘）到达时
   *   改用 80ms 极短防抖立即处理，而不是 400ms。
   *   稳妥性：若 600ms 内没等到 save（说明落盘早于 mouseup），兜底定时器直接跑一次，
   *   最坏也只是按当前磁盘内容处理，随后的常规 400ms 通道会再纠正。
   */
  armDropFlush(file) {
    if (!file || file.extension !== "canvas") return;
    if (this._dropFlush && this._dropFlush.timer) clearTimeout(this._dropFlush.timer);
    const path = file.path;
    this._dropFlush = {
      path,
      t: Date.now(),
      timer: setTimeout(() => {
        this._dropFlush = null;
        this.processCanvas(file).catch((err) =>
          console.error("[lmb] drop flush failed:", err));
      }, 600)
    };
  }

  /* ==================== 图片：裁剪页面画布 → webp 附件 ==================== */

  /**
   * 屏幕矩形 → 裁剪页面画布 → 保存 webp 附件。
   * 零 pdfjs 内部 API：直接 drawImage 页面上已渲染的 <canvas>。
   */
  async captureRectImage(view, pageEl, screenRect, pageNum) {
    try {
      const src = pageEl.querySelector("canvas");
      if (!src || !src.width || !src.height) {
        console.warn("[lmb] page canvas not found");
        return null;
      }
      const base = src.getBoundingClientRect();
      if (!base.width || !base.height) return null;
      const kx = src.width / base.width, ky = src.height / base.height;
      let sx = (screenRect.left - base.left) * kx;
      let sy = (screenRect.top - base.top) * ky;
      let sw = (screenRect.right - screenRect.left) * kx;
      let sh = (screenRect.bottom - screenRect.top) * ky;
      sx = Math.max(0, Math.min(src.width - 1, sx));
      sy = Math.max(0, Math.min(src.height - 1, sy));
      sw = Math.max(1, Math.min(src.width - sx, sw));
      sh = Math.max(1, Math.min(src.height - sy, sh));

      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(sw));
      out.height = Math.max(1, Math.round(sh));
      out.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
      const blob = await new Promise((res) => out.toBlob(res, "image/webp", 0.92));
      if (!blob) return null;
      const buf = await blob.arrayBuffer();

      const stamp = Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 36 * 36).toString(36);
      const name = view.file.basename + "-P" + pageNum + "-" + stamp + ".webp";
      const folder = view.file.parent && view.file.parent.path ? view.file.parent.path : "/";
      const path = normalizePath(folder === "/" ? name : folder + "/" + name);
      await this.app.vault.createBinary(path, buf);

      this.imgDims.set(name, { w: out.width, h: out.height });
      this.persistAutoSizeSoon();

      const display = "【" + view.file.basename + "-P." + pageNum + "】";
      // P3.5：把框选区域编码成相对 .page 的百分比（rect=l,t,w,h）。
      //   这样截图摘录在回绘和跳转时都【不依赖 textLayer】——比文字选区更稳
      //   （pdf.js 虚拟化页没有文本层；百分比也与缩放无关）。
      let rectParam = null;
      try {
        const pr = pageEl.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) {
          const rl = 100 * (screenRect.left - pr.left) / pr.width;
          const rt = 100 * (screenRect.top - pr.top) / pr.height;
          const rw = 100 * (screenRect.right - screenRect.left) / pr.width;
          const rh = 100 * (screenRect.bottom - screenRect.top) / pr.height;
          rectParam = [rl, rt, rw, rh].map((v) => Math.round(v * 100) / 100).join(",");
        }
      } catch (_) { /* 算不出就不写 rect，回退到只画页顶条 */ }
      const link = "[[" + view.file.path + "#page=" + pageNum
        + (rectParam ? "&rect=" + rectParam : "") + "|" + display + "]]";
      return {
        file: view.file, pageNum, display,
        link, embed: "![[" + name + "]]",
        attachmentName: name, imgW: out.width, imgH: out.height,
        rectParam,
        text: "（矩形图像选区）", isImage: true
      };
    } catch (err) {
      console.error("[lmb] captureRectImage error:", err);
      return null;
    }
  }

  /* ==================== 文字选区 ==================== */

  resolvePdfContext(el) {
    const pageEl = el && el.closest && el.closest(".page[data-page-number]");
    if (!pageEl) return null;
    const leafEl = pageEl.closest(".workspace-leaf");
    if (!leafEl) return null;
    const leaf = this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl);
    const view = leaf && leaf.view;
    if (!view || !view.file) return null;
    return { view, pageEl, pageNum: parseInt(pageEl.dataset.pageNumber, 10) || 1 };
  }

  /**
   * 文字选区 → {file, pageNum, text, link, display}
   * selection 参数 = beginIndex,beginOffset,endIndex,endOffset（文本层索引）
   */
  extractSelection(sel) {
    try {
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const node = sel.anchorNode;
      if (!node) return null;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el || !el.closest) return null;
      const pageEl = el.closest(".page[data-page-number]");
      if (!pageEl) return null;
      const ctx = this.resolvePdfContext(el);
      if (!ctx || ctx.pageEl !== pageEl) return null;
      const file = ctx.view.file;
      const pageNum = ctx.pageNum;
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (!text) return null;
      const display = "【" + file.basename + "-P." + pageNum + "】";

      // 补丁 B：P1-5 颜色语义——best-effort 探测选区命中的高亮注释背景色 → 映射标签名。
      // 探测不到 / 未命中映射 / 未配置 colorMap 时恒为 null，行为与现状一致。
      let colorTag = null;
      try { colorTag = this.detectColorTag(el, pageEl); }
      catch (err) { console.warn("[lmb] detectColorTag error:", err); }

      let link;
      let selectionParams = null; // Bugfix: 必须随 info 返回，contentExId 才能区分「同页同文本不同位置」的选区
      try {
        const params = this.buildSelectionParams(sel, pageEl);
        if (!params) throw new Error("no selection params");
        selectionParams = params;
        link = "[[" + file.path + "#page=" + pageNum + "&selection=" + params + "|" + display + "]]";
      } catch (_) {
        link = "[[" + file.path + "#page=" + pageNum + "|" + display + "]]";
      }
      return { file, pageNum, text, link, display, isImage: false, colorTag, selectionParams };
    } catch (err) {
      console.warn("[lmb] extractSelection error:", err);
      return null;
    }
  }

  /** DOM 选区边界 → selection= 链接参数（textLayer 子 div 序号 + 字符偏移） */
  buildSelectionParams(sel, pageEl) {
    const doc = pageEl.ownerDocument;
    const layer = pageEl.querySelector(".textLayer");
    if (!layer) return null;
    const divs = Array.prototype.slice.call(layer.children);
    if (!divs.length) return null;

    const toIdxOff = (node, offset) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el || !layer.contains(el)) return null;
      let div = el;
      while (div && div.parentElement !== layer) div = div.parentElement;
      if (!div) return null;
      const idx = divs.indexOf(div);
      if (idx < 0) return null;
      const r = doc.createRange();
      r.selectNodeContents(div);
      try { r.setEnd(node, offset); } catch (_) { return null; }
      return { idx, off: r.toString().length };
    };

    const begin = toIdxOff(sel.anchorNode, sel.anchorOffset);
    const end = toIdxOff(sel.focusNode, sel.focusOffset);
    if (!begin || !end) return null;
    const a = (begin.idx < end.idx) || (begin.idx === end.idx && begin.off <= end.off) ? begin : end;
    const b = a === begin ? end : begin;
    return a.idx + "," + a.off + "," + b.idx + "," + b.off;
  }

  /**
   * 补丁 A：内容寻址 exId（P0-1）——同一选区重复拖拽 → 同一 ^ex id → 引用计数正确、天然去重。
   * 哈希基底：
   *   - 图片选区（isImage）：attachmentName（内含时间戳+随机戳，每张截图天然唯一）
   *   - 文字选区：file.path | pageNum | selectionParams（未注入时回退 text）
   * 复用 simpleHash（带符号 int32）：>>>0 转无符号后对 36^6 取模，保证恰好 6 位
   * base36 小写字母数字，稳定匹配 EX_ID_RE = /\^ex-[0-9a-z]{4,8}/。
   */
  contentExId(info) {
    try {
      const MOD36_6 = 2176782336; // 36^6
      const key = (info && info.isImage && info.attachmentName)
        ? "img|" + String(info.attachmentName)
        : [
            (info && info.file && info.file.path) ? info.file.path : "?",
            (info && info.pageNum != null) ? String(info.pageNum) : "?",
            String((info && (info.selectionParams || info.text)) || "")
          ].join("|");
      const signed = parseInt(this.simpleHash(key), 10) | 0;
      const u = (signed >>> 0) % MOD36_6;
      return "ex-" + u.toString(36).padStart(6, "0");
    } catch (err) {
      // 优雅降级：任何异常回退随机 id（仅损失去重能力，不影响功能）
      console.warn("[lmb] contentExId 降级为随机 id:", err);
      return "ex-" + Math.random().toString(36).slice(2, 8);
    }
  }

  buildDropText(info) {
    try {
      const exId = this.contentExId(info);
      // 补丁 B 颜色语义标签行（extractSelection 注入 info.colorTag，非空才输出），
      // 位于 ^ex 行之前；info.colorTag 不存在/为空时行为与旧版完全一致。
      const tagLine = (info && info.colorTag) ? "\n> #" + info.colorTag : "";
      if (info.isImage) {
        return info.embed + "\n> (" + info.link + ")" + tagLine + "\n^" + exId;
      }
      return "> (" + info.link + ")\n> " + info.text + tagLine + "\n^" + exId;
    } catch (err) {
      console.error("[lmb] buildDropText error:", err);
      // 降级：恢复旧版随机 id 行为
      const exId = "ex-" + Math.random().toString(36).slice(2, 8);
      if (info.isImage) {
        return info.embed + "\n> (" + info.link + ")\n^" + exId;
      }
      return "> (" + info.link + ")\n> " + info.text + "\n^" + exId;
    }
  }

  /* ==================== 拖拽手柄（纯原生 HTML5 drag） ==================== */

  showChip(x, y, label, info) {
    this.hideChip();
    const doc = typeof activeDocument !== "undefined" ? activeDocument : document;
    const chip = doc.createElement("div");
    chip.className = "lmb-chip";
    chip.textContent = label;
    chip.setAttribute("draggable", "true");
    chip.style.left = Math.min(x + 12, doc.defaultView.innerWidth - 240) + "px";
    chip.style.top = (y + 16) + "px";
    doc.body.appendChild(chip);
    this.chipEl = chip;

    chip.addEventListener("dragstart", (e) => {
      // Bugfix(严重回归)：守卫必须限定图片路径。文字选区的 info 没有 attachmentName 字段，
      // 无条件判断把所有文字拖拽在 dragstart 就 preventDefault 掐死（v0.2.0 引入图片截图时误伤，
      // 图片两条路径都是 await 截图完成后才 showChip，此守卫对图片仅剩"未完成"兜底意义）。
      if (info.isImage && !info.attachmentName) {
        e.preventDefault();
        this.debugNotice("截图尚未完成，请重新框选");
        return;
      }
      const dropText = this.buildDropText(info);
      e.dataTransfer.setData("text/plain", dropText);
      e.dataTransfer.effectAllowed = "copy";
      this._dragArm = { t: Date.now() }; // v0.5.0：武装即时通道（dragend 解除）
      console.log("[lmb] dragstart (" + (info.isImage ? "image" : "text") + "), len=" + dropText.length);
    });
    chip.addEventListener("dragend", () => {
      this._dragArm = null;
      this.hideChip();
      // v0.3.1：拖拽完成后，清除已被消费的 PDF 选区（防止同一选区被再次当成新摘录意图，
      // 导致 chip 复活 + Notice 刷屏）。仅当当前选区就是刚拖的那条时才清，不动用户其它选区。
      try {
        const win2 = typeof activeWindow !== "undefined" ? activeWindow : window;
        const s = win2.getSelection();
        if (s && s.rangeCount > 0 && info.text &&
            s.toString().replace(/\s+/g, " ").trim() === info.text) {
          s.removeAllRanges();
        }
      } catch (_) { /* noop */ }
      this._chipSig = null;
    });
  }

  hideChip() {
    if (this.chipEl) {
      this.chipEl.remove();
      this.chipEl = null;
    }
  }

  /* ==================== Canvas：尺寸适配 + 摘录文档同步 ==================== */

  /**
   * v0.5.0 即时通道：drop 后轮询内存 canvas 数据（60ms 间隔，最多 1.2s），
   * 新 ^ex 卡一出现立即做父子判定，命中则 setData + requestSave（毫秒级，绕过磁盘往返）。
   * 失败/超时/没压中卡 → 什么都不做，文件层管线（250ms + 出生重试）自然兜底。
   */
  async instantAttach(canvasObj) {
    const before = new Set(((canvasObj.getData() || {}).nodes || []).map((n) => n.id));
    const t0 = Date.now();
    while (Date.now() - t0 < 1200) {
      await new Promise((r) => setTimeout(r, 60));
      let data;
      try { data = canvasObj.getData(); } catch (_) { return; }
      const nodes = (data && data.nodes) || [];
      const nn = nodes.find((n) => !before.has(n.id) && n.type === "text" && n.text && EX_ID_RE.test(n.text));
      if (!nn) continue;
      const others = nodes.filter((n) => n.id !== nn.id && n.type !== "group");
      const hit = lmbPickDropParent(nn, others);
      if (!hit) return; // 没压到卡 → 交给文件层（含出生重试）
      const parent = hit.node;
      if (!Array.isArray(data.edges)) data.edges = [];
      const path2 = canvasObj.view && canvasObj.view.file ? canvasObj.view.file.path : null;
      const sidecar0 = (path2 && this.autoEdges.get(path2)) || new Set();
      const plan = lmbPlanAutoLink(nn, parent, data.edges, sidecar0);
      if (plan.op === "create") {
        const kidsBySide = lmbGroupBySide(parent, nodes, data.edges);
        const group = [...(kidsBySide.get(plan.side) || []), nn];
        lmbLayoutGroup(parent, group, plan.side, 30);
        const ends = lmbSideEnds(plan.side);
        const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        data.edges.push({
          id: eid, fromNode: parent.id, toNode: nn.id,
          fromSide: ends.fromSide, toSide: ends.toSide
        });
        // v0.11.0 修复：即时通道建的边此前漏登记 sidecar → 文件层不认账（当作手动边），
        //   首连锁定 / 自动边清理全都失明。现在建边即登记。
        if (path2) {
          const ae = this.autoEdges.get(path2) || new Set();
          ae.add(eid);
          this.autoEdges.set(path2, ae);
        }
        canvasObj.setData(data);
        canvasObj.requestSave();
        this._instantSkip = Date.now() + 4000; // 抑制文件层自动父子，防双写
        this.debugNotice("✓ 已自动挂到父卡（组居中，" + group.length + "卡）");
      }
      // reside/skip：新落下的卡不该有旧连线；万一出现，交给文件层兜底
      return;
    }
    // 1.2s 内没等到新卡 → 文件层兜底
  }

  /**
   * v0.9.3 即时通道（移动已有卡）：canvas 内 mouseup 后直接在「内存 canvas 数据」上做
   * 移动检测 + 父子判定 + 组排布，不再等 Obsidian 把画布落盘（save 防抖可达 1s+）
   * → 文件层 80/400ms。修复「拖到另一张卡上好一会才连线对齐」。
   *   - 只处理「档案里已见过 + 位置变了」的卡；新落下的 ^ex 卡归 instantAttach / 文件层管（防双写）；
   *   - 命中父卡 → 换父摘旧自动边 → lmbLayoutGroup → setData + requestSave（毫秒级生效），
   *     并同步位置档案，防文件层把同一批移动再处理一遍；
   *   - 没压到卡 / API 不可用 → 静默返回，文件层管线自然兜底。
   */
  async instantMoveAttach(canvasObj) {
    const file = canvasObj && canvasObj.view && canvasObj.view.file;
    const path = file && file.path;
    if (!path) return;
    const lastPos = this.canvasPositions && this.canvasPositions.get(path);
    if (!lastPos || !lastPos.size) return; // 首见画布 → 交给文件层建档
    const t0 = Date.now();
    while (Date.now() - t0 < 500) {
      let data;
      try { data = canvasObj.getData(); } catch (_) { return; }
      const nodes = (data && data.nodes) || [];
      // 只认「见过 + 位置变了」的卡（新卡不在档案里 → 跳过）
      const moved = [];
      for (const n of nodes) {
        if (n.type === "group") continue;
        const prev = lastPos.get(n.id);
        if (prev && (prev.x !== n.x || prev.y !== n.y)) moved.push(n);
      }
      if (!moved.length) {
        await new Promise((r) => setTimeout(r, 80)); // 拖拽终态可能还没提交进 canvas 内存数据
        continue;
      }
      let changed = false;
      for (const nn of moved) {
        const others = nodes.filter((n) => n.id !== nn.id && n.type !== "group");
        const hit = lmbPickDropParent(nn, others);
        if (!hit) continue;
        const parent = hit.node;
        if (!Array.isArray(data.edges)) data.edges = [];
        const sidecar = this.autoEdges.get(path) || new Set();
        // v0.11.0：首连锁定 + 改挂侧（取代 v0.7.3 换父）
        const plan = lmbPlanAutoLink(nn, parent, data.edges, sidecar);
        if (plan.op === "skip") continue;
        if (plan.op === "reside") {
          // R4：拖回已连线的卡上 → 按落点方位改挂侧 + 两侧组重排（同侧 = 重新对齐）
          const r = lmbApplyReside(parent, nn, plan, nodes, data.edges);
          changed = true;
          console.log("[lmb] 即时通道（改挂侧）: ", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
            "(" + plan.oldSide + "→" + r.side + ")");
          continue;
        }
        const kidsBySide = lmbGroupBySide(parent, nodes, data.edges);
        const group = [...(kidsBySide.get(plan.side) || []), nn];
        lmbLayoutGroup(parent, group, plan.side, 30);
        const ends = lmbSideEnds(plan.side);
        const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        data.edges.push({
          id: eid, fromNode: parent.id, toNode: nn.id,
          fromSide: ends.fromSide, toSide: ends.toSide
        });
        sidecar.add(eid);
        this.autoEdges.set(path, sidecar);
        changed = true;
        console.log("[lmb] 即时通道（移动）: ", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
          "(" + ends.fromSide + "→" + ends.toSide + ", 组" + group.length + ")");
      }
      if (changed) {
        try {
          canvasObj.setData(data);
          canvasObj.requestSave();
        } catch (_) { return; }
        // 同步位置档案：文件层下一次 sync 看到的就是「已排布后」的位置 → 不再重复处理
        const cur = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, width: n.width || 0, height: n.height || 0 }]));
        this.canvasPositions.set(path, cur);
        this._instantSkip = Date.now() + 4000;
        if (typeof this.persistAutoSizeSoon === "function") this.persistAutoSizeSoon();
        this.debugNotice("✓ 已自动挂到父卡（组居中）");
      }
      return;
    }
    // 500ms 内没检测到移动 → 文件层兜底
  }

  scheduleCanvasSync(file) {
    const old = this.syncTimers.get(file.path);
    if (old) clearTimeout(old);
    // v0.4.5：防抖 800→250ms；v0.7.1：再→400ms 减少拖拽期 processCanvas 频率。
    // 拖拽时 Obsidian canvas 连续触发 modify，debounce 不断重置；400ms 让本插件不再打断拖拽手感。
    this.syncTimers.set(file.path, setTimeout(() => {
      this.syncTimers.delete(file.path);
      this.processCanvas(file).catch((err) => console.error("[lmb] canvas process failed:", err));
    }, 400));
  }

  async processCanvas(cf) {
    const raw = await this.app.vault.read(cf);
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    const nodes = data.nodes || [];

    let changed = false;
    let store = this.autoSize.get(cf.path);
    if (!store) { store = new Map(); this.autoSize.set(cf.path, store); }

    /* v0.8.2：新出现的摘录卡自动挂一个「空的补充描述框」。
     *   放在 fitNode 之前，这样尺寸估算会基于「已加框」的文本一次算准，不用二次修正。
     *   判定「新出现」= canvasPositions 档案里没有这个节点 id（插件见过的卡一律不动，
     *   避免把存量卡批量改造）。已有描述的卡也跳过。设置项 noteAutoBoxOnNew 可关。
     *   注意：插件首次扫描某画布时 lastPos 为空 → 所有卡都算「新」→ 会给存量卡也加框，
     *   这是有意为之（用户要的就是「能看到框」）；不想要就在设置里关掉自动。 */
    const attachNote = this.settings.noteAutoBoxOnNew !== false;
    const attachComment = this.settings.commentAutoBoxOnNew !== false; // v0.11.0：评论栏
    if (attachNote || attachComment) {
      const lastPos0 = this.canvasPositions.get(cf.path) || new Map();
      const fold0 = !!this.settings.noteFoldByDefault;
      for (const node of nodes) {
        if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
        if (lastPos0.has(node.id)) continue;              // 见过的卡 → 不动
        let touched = false;
        if (attachNote && !lmbSplitNote(node.text).hasNote) {   // 已有描述 → 不动
          node.text = lmbJoinNote(node.text, "", {
            type: this.settings.noteCalloutType || "ppd-note",
            title: this.settings.noteTitle || "补充描述",
            fold: fold0,
            allowEmpty: true
          });
          touched = true;
          console.log("[lmb] 新摘录卡自动挂补充描述框:", node.id.slice(0, 8));
        }
        // v0.11.0：新摘录卡自动挂「评论栏」（PDF Flow 式底栏按钮，点它直接弹编辑框）
        if (attachComment && !lmbSplitComment(node.text).hasComment) {
          node.text = lmbJoinComment(node.text, "", { allowEmpty: true });
          touched = true;
          console.log("[lmb] 新摘录卡自动挂评论栏:", node.id.slice(0, 8));
        }
        if (touched) changed = true;
      }
    }

    if (!Array.isArray(data.edges)) data.edges = []; // v0.11.0：fit 重居中要用，提前归一
    const fittedNodes = [];
    for (const node of nodes) {
      if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
      const fitted = this.fitNode(node, store);
      if (fitted) {
        node.width = Math.round(fitted.w);
        node.height = Math.round(fitted.h);
        fittedNodes.push(node);
        changed = true;
        console.log("[lmb] node resized:", node.id, node.width + "x" + node.height);
      }
    }
    // v0.11.0 R1「乱放」根因修复：fitNode 在排布之后把卡撑大 → 高度变了 y 不变 →
    //   中心偏出父卡横/纵轴。尺寸修正过的卡按自动父边做组内重新居中。
    if (fittedNodes.length && data.edges.length) {
      const sidecarFit = this.autoEdges.get(cf.path) || new Set();
      let recentered = 0;
      for (const node of fittedNodes) {
        if (lmbRecenterNode(node, nodes, data.edges, sidecarFit)) recentered++;
      }
      if (recentered) {
        changed = true;
        console.log("[lmb] 尺寸修正后组内重新居中:", recentered, "卡");
      }
    }
    if (changed) {
      const indent = /\n\t"/.test(raw) ? "\t" : "  ";
      this.selfWritten.set(cf.path, true);
      try {
        await this.app.vault.adapter.write(cf.path, JSON.stringify(data, null, indent));
      } catch (err) {
        this.selfWritten.delete(cf.path);
        console.error("[lmb] canvas resize write failed:", err);
      }
    }

    /* ---- v0.7.0：通用自动父子 + 组居中（任意画布卡片，拖动即生效） ----
     * 触发：任意文本/图片卡（不再限 ^ex）位置变更（movedOrNew，含新卡），与其余卡重叠即建父→子连线 + 组居中排布。
     * 判定：lmbPickDropParent 多信号（落点角/中心/相交 ≥ 较小卡 20%）。
     * v0.7.1：① 边去重 by (parent,child) 对，防止瞬时重复连线；② 自动建的边用 sidecar 跟踪，
     *         端点不再重叠即清理（用户手动连线不会被破坏：不在 sidecar 里）。 */
    if (!Array.isArray(data.edges)) data.edges = [];
    if (!this.canvasPositions) this.canvasPositions = new Map();
    if (!this.autoEdges) this.autoEdges = new Map();

    // v0.7.1：边去重 —— 同一 (parent, child) 对仅保留第一条，避免「同一对父子多根线」
    {
      const seenPair = new Set();
      const before = data.edges.length;
      data.edges = data.edges.filter((ed) => {
        if (!ed.fromNode || !ed.toNode || ed.fromNode === ed.toNode) return false;
        const k = ed.fromNode < ed.toNode ? ed.fromNode + "|" + ed.toNode : ed.toNode + "|" + ed.fromNode;
        if (seenPair.has(k)) return false;
        seenPair.add(k); return true;
      });
      if (data.edges.length !== before) console.log("[lmb] 边去重：移除", before - data.edges.length, "条重复边");
    }

    /* v0.7.3：清理端点已被删除的自动边（这是唯一安全的清理条件）。
     *   ⚠️ 历史教训（v0.7.1 回归，用户报「连线自动消失」）：
     *   这里【绝不能】按「端点是否还重叠」来清理 —— lmbLayoutGroup 排布的目的恰恰是
     *   让子卡不再遮挡父卡，所以正常排布后父子必然不重叠。按重叠清理 = 把刚建的边自己删掉。
     *   时序：①拖 B 压 A → 建边 A→B → 排布把 B 挪到 A 右侧 gap=30（不再重叠）→ 写盘
     *        ②下一次 sync → 清理看到重叠率 0 → 删边 → 线消失。
     *   孤儿边（瞬时拖动压到别的卡）改由「换父时移除旧的自动父边」处理，见下方 movedOrNew 循环。 */
    {
      const sidecar = this.autoEdges.get(cf.path) || new Set();
      const byId = new Map(nodes.map((n) => [n.id, n]));
      let removed = 0;
      const survivingAuto = new Set();
      data.edges = data.edges.filter((ed) => {
        if (!sidecar.has(ed.id)) return true; // 手动边不动
        if (!lmbAutoEdgeAlive(ed, byId)) { removed++; return false; } // 仅端点被删才移除
        survivingAuto.add(ed.id);
        return true;
      });
      this.autoEdges.set(cf.path, survivingAuto);
      if (removed) {
        changed = true;
        console.log("[lmb] 自动边清理：移除", removed, "条端点已删除的孤儿边");
      }
    }

    const lastPos = this.canvasPositions.get(cf.path) || new Map();
    const currentPos = new Map();
    const movedOrNew = [];
    for (const n of nodes) {
      if (n.type === "group") continue;
      const cur = { x: n.x, y: n.y, width: n.width || 0, height: n.height || 0 };
      currentPos.set(n.id, cur);
      const prev = lastPos.get(n.id);
      if (!prev || prev.x !== cur.x || prev.y !== cur.y ||
          prev.width !== cur.width || prev.height !== cur.height) {
        movedOrNew.push(n);
      }
    }
    this.canvasPositions.set(cf.path, currentPos);
    this.persistAutoSizeSoon(); // 落盘档案（canvasPositions + autoEdges + autoSize 共用防抖）

    if (movedOrNew.length) {
      for (const nn of movedOrNew) {
        const others = nodes.filter((n) => n.id !== nn.id && n.type !== "group");
        const hit = lmbPickDropParent(nn, others);
        if (!hit) continue;
        const parent = hit.node;
        if (parent.id === nn.id) continue;

        /* v0.11.0 首连锁定 + 改挂侧（取代 v0.7.3 换父）：
         *   每张卡只自动建一条连线——已有自动父边且父不是本次压中的卡 → skip，
         *   不再自动换父（想换父请手动删线重拖）；压中已连线的卡 → reside 改挂侧；
         *   手动边不参与锁定。副作用：旧版「排布紧密顺带碰到别的卡就换父」的误触发
         *   也被一并消除（这正是锁定规则的收益）。 */
        const sidecar2 = this.autoEdges.get(cf.path) || new Set();
        const plan = lmbPlanAutoLink(nn, parent, data.edges, sidecar2);
        if (plan.op === "skip") continue;
        if (plan.op === "reside") {
          const r = lmbApplyReside(parent, nn, plan, nodes, data.edges);
          changed = true;
          console.log("[lmb] 自动父子（改挂侧）:", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
            "(" + plan.oldSide + "→" + r.side + ", 相交" + Math.round(hit.ratio * 100) + "%)");
          continue;
        }

        // 取父卡现有子卡按侧分组；把新卡 nn 加进同侧组，整组贴边对齐+组居中排布（v0.9.3 不再拉伸尺寸）
        const kidsBySide = lmbGroupBySide(parent, nodes, data.edges);
        const group = [...(kidsBySide.get(plan.side) || []), nn];
        lmbLayoutGroup(parent, group, plan.side, 30);
        const ends = lmbSideEnds(plan.side);
        const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        data.edges.push({
          id: eid, fromNode: parent.id, toNode: nn.id,
          fromSide: ends.fromSide, toSide: ends.toSide
        });
        // 标记为自动边（用于后续清理）
        sidecar2.add(eid);
        this.autoEdges.set(cf.path, sidecar2);
        changed = true;
        console.log("[lmb] 自动父子（首连锁定 v0.11.0）:", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
          "(" + ends.fromSide + "→" + ends.toSide + ", 相交" + Math.round(hit.ratio * 100) + "%, 组" + group.length + ")");
      }

      if (changed) {
        const indent2 = /\n\t"/.test(raw) ? "\t" : "  ";
        this.selfWritten.set(cf.path, true);
        try {
          await this.app.vault.adapter.write(cf.path, JSON.stringify(data, null, indent2));
        } catch (err) {
          this.selfWritten.delete(cf.path);
          console.error("[lmb] hierarchy write failed:", err);
        }
      }
    }

    const byPdf = new Map();
    const seenIds = new Set(); // 补丁 A：卡片级去重——同一 ^ex id 只保留 canvas 顺序中的第一个节点
    for (const node of nodes) {
      if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
      const pm = node.text.match(/\[\[([^\]#|]+\.pdf)/i);
      if (!pm) continue;
      const pdfPath = pm[1].trim();
      const id = node.text.match(EX_ID_RE)[0].slice(1);
      if (seenIds.has(id)) {
        // 同一选区重复拖拽产生的内容寻址重复卡：md 只收一条，canvas 原卡保留不动
        console.log("[lmb] canvas 卡按 id 去重:", id, "（重复卡片，仅保留首个）");
        continue;
      }
      seenIds.add(id);
      // v0.8.0：除非设置里明确要同步，否则补充描述不进摘录文档（保持摘录文档是「原文」的镜像）
      const srcText = this.settings.noteIntoSync ? node.text : lmbStripNote(node.text);
      const body = srcText
        .split("\n")
        .filter((l) => !/^\s*\^ex-[0-9a-z]{4,8}\s*$/.test(l))
        .join("\n")
        .trim();
      // 补丁 A（P1-3）：回跳链接页码 #page=12 → entry.page；提取失败为 null（归入「未定位」）
      // 仅匹配 ASCII 数字，对中文文件名 / 中文摘录文本无副作用
      const pgm = node.text.match(/#page=(\d+)/);
      const page = pgm ? parseInt(pgm[1], 10) : null;
      if (!byPdf.has(pdfPath)) byPdf.set(pdfPath, []);
      byPdf.get(pdfPath).push({ id, body, page });
    }

    // v0.4.0：canvas 连线 → 摘录层级（child ^ex id -> parent ^ex id）。
    // 手动在 canvas 上连的两张 ^ex 卡同样生效；父是普通文本卡/图片卡则不进 md 层级。
    const exNodes = nodes.filter((n) => n.type === "text" && n.text && EX_ID_RE.test(n.text));
    const exIdByNodeId = new Map();
    for (const n of exNodes) exIdByNodeId.set(n.id, n.text.match(EX_ID_RE)[0].slice(1));
    const parentOf = new Map();
    for (const e of (data.edges || [])) {
      const p = exIdByNodeId.get(e.fromNode), c = exIdByNodeId.get(e.toNode);
      if (p && c && p !== c && !parentOf.has(c)) parentOf.set(c, p);
    }

    for (const [pdfPath, entries] of byPdf) {
      try {
        await this.writeExcerptMd(cf, pdfPath, entries, parentOf);
      } catch (err) {
        // 单个 PDF 的摘录文档写入失败不阻断其它 PDF 的同步
        console.error("[lmb] excerpt sync failed for", pdfPath, err);
      }
    }
  }

  /**
   * v0.6.0：规范化已有重叠摘录（命令入口）。
   *   遍历当前打开的 canvas（若无则扫 vault 顶层 *.canvas），对每张 ^ex 卡
   *   找它最重叠的另一张 ^ex 卡作为父卡；按 (parent, side) 分组整组重排
   *   （v0.9.3 起为贴边对齐 + 以父卡中心对称轴组居中，保留各卡自身尺寸），新增父子边；写回文件。
   *   幂等：重复执行不重复改位置（get后无重叠卡），不重复建边（dup 检查）。
   */
  /**
   * v0.6.0：重叠规范化。v0.9.2 起支持传入 targetFile（只处理这一张画布），
   *   供「跳转落地后的重叠自愈」定点调用；不传参时行为与旧版完全一致。
   */
  async normalizeOverlappingExcerpts(targetFile) {
    let targets;
    if (targetFile) {
      targets = [targetFile];                       // 定点：只处理这一张画布
    } else {
      targets = this.app.workspace.getLeavesOfType("canvas")
        .map((l) => l.view && l.view.file).filter(Boolean);
      if (!targets.length) {
        targets = this.app.vault.getFiles().filter((f) => f.extension === "canvas");
      }
    }
    if (!targets.length) { new Notice("未找到 canvas 文件"); return; }

    let totalEdges = 0, totalMoves = 0;
    for (const cf of targets) {
      try {
        const raw = await this.app.vault.read(cf);
        let data; try { data = JSON.parse(raw); } catch (_) { continue; }
        const nodes = data.nodes || [];
        if (!Array.isArray(data.edges)) data.edges = [];

        const ex = nodes.filter((n) => n.type === "text" && n.text && EX_ID_RE.test(n.text));
        // 每张 ^ex 卡：选相交面积最大的另一张 ^ex 作父；阈值与 processCanvas 一致
        const parentOfCard = new Map(); // childId -> parentId
        for (const nn of ex) {
          const others = ex.filter((o) => o.id !== nn.id);
          const hit = lmbPickDropParent(nn, others, 0.2);
          if (hit) parentOfCard.set(nn.id, hit.node.id);
        }

        // 分组：按 (parentId, side) 收集
        const groups = new Map();
        for (const nn of ex) {
          const pid = parentOfCard.get(nn.id);
          if (!pid) continue;
          const parent = nodes.find((n) => n.id === pid);
          if (!parent) continue;
          const side = lmbSideOf(nn, parent);
          const key = pid + "|" + side;
          if (!groups.has(key)) groups.set(key, { parent, side, kids: [] });
          groups.get(key).kids.push(nn);
        }

        let changed = false;
        for (const g of groups.values()) {
          // 1) 全组贴边对齐 + 组居中（v0.9.3 不再拉伸子卡尺寸）
          lmbLayoutGroup(g.parent, g.kids, g.side, 30);
          for (const k of g.kids) { k.x = Math.round(k.x); k.y = Math.round(k.y); }
          totalMoves += g.kids.length;
          // 2) 建父子边（dup 检查，幂等）
          const ends = lmbSideEnds(g.side);
          for (const k of g.kids) {
            const exists = data.edges.some((ed) =>
              (ed.fromNode === g.parent.id && ed.toNode === k.id) ||
              (ed.fromNode === k.id && ed.toNode === g.parent.id));
            if (!exists) {
              data.edges.push({
                id: "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                fromNode: g.parent.id, toNode: k.id,
                fromSide: ends.fromSide, toSide: ends.toSide
              });
              totalEdges++;
            }
          }
          changed = true;
        }

        if (changed) {
          const indent = /\n\t"/.test(raw) ? "\t" : "  ";
          this.selfWritten.set(cf.path, true);
          await this.app.vault.adapter.write(cf.path, JSON.stringify(data, null, indent));
          console.log("[lmb] 规范化画布:", cf.path,
            "组数=" + groups.size + " 移动=" + groups.size + "组 新边=" + totalEdges);
        }
      } catch (err) {
        console.error("[lmb] normalize failed for", cf.path, err);
      }
    }
    new Notice(`已规范化：新建 ${totalEdges} 条边，整组移动 ${totalMoves} 张卡（${targets.length} 个画布）`);
  }

  /* ==================== v0.8.0：卡片补充描述（note） ==================== */

  /**
   * v0.8.2：给当前画布所有摘录卡批量添加「空的补充描述框」。
   *   存在的意义：ribbon 按钮在某些环境不出现，命令面板又不好找 —— 给一条能立刻
   *   看到效果的入口。跑完每张摘录卡下方都会多出一个 callout 框（点开即可写）。
   *   已有补充描述的卡跳过，绝不覆盖用户已写的内容。
   */
  async addNoteBoxToAllCards() {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    const raw = await this.app.vault.adapter.read(ctx.file.path);
    let data;
    try { data = JSON.parse(raw); } catch (_) { new Notice("画布解析失败"); return; }
    const nodes = data.nodes || [];
    const fold = !!this.settings.noteFoldByDefault;   // 跟随设置（默认 false = 展开，一眼能看见）
    let n = 0;
    for (const node of nodes) {
      if (node.type !== "text" || !node.text) continue;
      if (!EX_ID_RE.test(node.text)) continue;             // 只处理摘录卡
      if (lmbSplitNote(node.text).hasNote) continue;       // 已有描述 → 跳过，不覆盖
      node.text = lmbJoinNote(node.text, "", {
        type: this.settings.noteCalloutType || "ppd-note",
        title: this.settings.noteTitle || "补充描述",
        fold,
        allowEmpty: true
      });
      const size = this.estimateSizeFor(node.text);
      node.width = Math.round(size.w);
      node.height = Math.round(size.h);
      let store = this.autoSize.get(ctx.file.path);
      if (!store) { store = new Map(); this.autoSize.set(ctx.file.path, store); }
      store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });
      n++;
    }
    if (!n) { new Notice("这个画布里没有需要添加描述框的摘录卡（可能都已经有了）"); return; }
    const indent = /\n\t"/.test(raw) ? "\t" : "  ";
    this.selfWritten.set(ctx.file.path, true);
    await this.app.vault.adapter.write(ctx.file.path, JSON.stringify(data, null, indent));
    this.persistAutoSizeSoon();
    new Notice(`已给 ${n} 张摘录卡添加补充描述框（${fold ? "已折叠" : "已展开"}，点开即可写）`);
  }

  /**
   * v0.11.0：给画布里所有还没有评论栏的摘录卡批量挂「添加评论」底栏（存量卡入口）。
   *   已有评论的卡跳过，绝不覆盖用户已写内容。
   */
  async addCommentBoxToAllCards() {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    const raw = await this.app.vault.adapter.read(ctx.file.path);
    let data;
    try { data = JSON.parse(raw); } catch (_) { new Notice("画布解析失败"); return; }
    const nodes = data.nodes || [];
    let n = 0;
    for (const node of nodes) {
      if (node.type !== "text" || !node.text) continue;
      if (!EX_ID_RE.test(node.text)) continue;                 // 只处理摘录卡
      if (lmbSplitComment(node.text).hasComment) continue;     // 已有评论 → 跳过
      node.text = lmbJoinComment(node.text, "", { allowEmpty: true });
      const size = this.estimateSizeFor(node.text);
      node.width = Math.round(size.w);
      node.height = Math.round(size.h);
      let store = this.autoSize.get(ctx.file.path);
      if (!store) { store = new Map(); this.autoSize.set(ctx.file.path, store); }
      store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });
      n++;
    }
    if (!n) { new Notice("这个画布里的摘录卡都已经有评论栏了"); return; }
    const indent = /\n\t"/.test(raw) ? "\t" : "  ";
    this.selfWritten.set(ctx.file.path, true);
    await this.app.vault.adapter.write(ctx.file.path, JSON.stringify(data, null, indent));
    this.persistAutoSizeSoon();
    new Notice(`已给 ${n} 张摘录卡添加评论栏（点评论栏直接写）`);
  }

  /* ==================== v0.11.0：独立评论（批注评论底栏） ==================== */

  /**
   * 把评论写进指定节点。commentText 为空串 = 移除评论栏。
   * 结构：评论 callout 永远追加在卡片文本最末（补充描述之后），渲染成底栏。
   * 写完同步 autoSize 档案 + 组内重新居中（高度变化不再产生「乱放」）。
   */
  async applyCardComment(file, nodeId, commentText) {
    const raw = await this.app.vault.adapter.read(file.path);
    let data;
    try { data = JSON.parse(raw); } catch (_) { return { ok: false, msg: "画布解析失败" }; }
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (!node) return { ok: false, msg: "找不到该卡片（可能已被删除）" };
    if (node.type !== "text") return { ok: false, msg: "只有文本卡片支持评论" };

    const cur = lmbSplitComment(node.text || "");
    node.text = lmbJoinComment(cur.body, commentText, { allowEmpty: false });

    const size = this.estimateSizeFor(node.text);
    node.width = Math.round(size.w);
    node.height = Math.round(size.h);
    if (Array.isArray(data.edges) && data.edges.length) {
      lmbRecenterNode(node, data.nodes || [], data.edges, this.autoEdges.get(file.path) || new Set());
    }
    let store = this.autoSize.get(file.path);
    if (!store) { store = new Map(); this.autoSize.set(file.path, store); }
    store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });

    const indent = /\n\t"/.test(raw) ? "\t" : "  ";
    this.selfWritten.set(file.path, true);
    await this.app.vault.adapter.write(file.path, JSON.stringify(data, null, indent));
    this.persistAutoSizeSoon();
    return { ok: true, msg: "" };
  }

  /** 评论命令统一入口（mode = "edit" 弹窗编辑 / "remove" 移除） */
  async runCardCommentCommand(mode) {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    const pick = await this.pickCanvasNode(ctx);
    if (!pick || !pick.node) return;
    const cur = lmbSplitComment(pick.node.text || "");
    if (mode === "remove") {
      if (!cur.hasComment) { new Notice("该卡片还没有评论"); return; }
      const r = await this.applyCardComment(ctx.file, pick.node.id, "");
      new Notice(r.ok ? "已移除评论" : r.msg);
      return;
    }
    new LMBNoteModal(this.app, {
      title: cur.hasComment ? "编辑评论" : "添加评论",
      value: cur.comment,
      onSubmit: async (v) => {
        const r = await this.applyCardComment(ctx.file, pick.node.id, v);
        new Notice(r.ok ? (String(v).trim() ? "已保存评论" : "已移除评论") : r.msg);
      }
    }).open();
  }

  /**
   * v0.11.0：canvas 里点击「评论栏」直接弹编辑框（PDF Flow 式交互）。
   *   document 捕获层 click：callout[data-callout="lmb-comment"] 且在 canvas 内 →
   *   通过 canvas.nodes 的 contentEl 反查节点 id → 弹 LMBNoteModal。
   *   点折叠箭头（.callout-fold）不拦截 → 保留原生展开/折叠；md 阅读视图不拦截。
   */
  onCanvasCalloutClick(e) {
    try {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(".callout-fold")) return; // 折叠箭头 → 原生折叠/展开
      const callout = t.closest('.callout[data-callout="lmb-comment"]');
      if (!callout) return;
      const leafEl = callout.closest(".workspace-leaf");
      const leaf = leafEl && this.app.workspace.getLeavesOfType("canvas").find((l) => l.containerEl === leafEl);
      if (!leaf || !leaf.view || !leaf.view.canvas) return; // 非 canvas（md 视图）→ 原生行为
      const canvas = leaf.view.canvas;
      const nodeMap = canvas.nodes || new Map();
      const entries = (typeof nodeMap.entries === "function") ? nodeMap.entries() : Object.entries(nodeMap);
      let nodeId = null;
      for (const [id, cnode] of entries) {
        const el = cnode && (cnode.contentEl || cnode.nodeEl);
        if (el && el.contains && el.contains(callout)) { nodeId = id; break; }
      }
      if (!nodeId) return; // 内部 API 失配 → 静默（可走侧栏按钮/命令）
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const file = leaf.view.file;
      this.editCommentForNode(file, nodeId).catch((err) => {
        console.warn("[lmb] comment click edit error:", err);
      });
    } catch (_) { /* noop：点击拦截绝不能抛错破坏 canvas */ }
  }

  /** 按节点 id 直开评论编辑弹窗（点击评论栏的入口，无需选择器） */
  async editCommentForNode(file, nodeId) {
    if (!file) return;
    const raw = await this.app.vault.adapter.read(file.path);
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (!node || node.type !== "text") { new Notice("找不到该卡片（可能已被删除）"); return; }
    const cur = lmbSplitComment(node.text || "");
    new LMBNoteModal(this.app, {
      title: cur.hasComment ? "编辑评论" : "添加评论",
      value: cur.comment,
      onSubmit: async (v) => {
        const r = await this.applyCardComment(file, nodeId, v);
        new Notice(r.ok ? (String(v).trim() ? "已保存评论" : "已移除评论") : r.msg);
      }
    }).open();
  }

  /** 拿到当前 canvas 上下文 { file, leaf }；不在 canvas 里则返回 null */
  activeCanvasContext() {
    const leaves = this.app.workspace.getLeavesOfType("canvas") || [];
    if (!leaves.length) return null;
    let leaf = null;
    try { leaf = this.app.workspace.activeLeaf; } catch (_) { leaf = null; }
    const isCanvas = (l) => l && l.view && (!l.view.getViewType || l.view.getViewType() === "canvas");
    if (!isCanvas(leaf)) leaf = leaves.find(isCanvas) || leaves[0];
    const f = leaf && leaf.view && leaf.view.file;
    if (!f || f.extension !== "canvas") return null;
    return { file: f, leaf };
  }

  /**
   * 取目标卡片节点：
   *   ① canvas 内部 API getSelection()（便捷；非官方但社区通用，失败静默）
   *   ② 退回模糊搜索列出画布里的文本卡片让用户挑（纯公开 API，永远可用）
   */
  pickCanvasNode(ctx) {
    try {
      const canvas = ctx.leaf.view.canvas;
      const sel = canvas && typeof canvas.getSelection === "function" ? canvas.getSelection() : null;
      const arr = sel ? Array.from(sel) : [];
      const node = arr.find((n) => n && typeof n.text === "string");
      if (node) return Promise.resolve({ node, via: "selection" });
    } catch (_) { /* 内部 API 不可用 → 走 ② */ }

    return new Promise((resolve) => {
      this.app.vault.adapter.read(ctx.file.path).then((raw) => {
        let data = null;
        try { data = JSON.parse(raw); } catch (_) { /* noop */ }
        const nodes = (data && data.nodes) || [];
        const items = nodes.filter((n) => n.type === "text" && n.text).map((n) => {
          const first = String(n.text).split("\n").find((l) => l.trim()) || "(空卡片)";
          const has = lmbSplitNote(n.text).hasNote;
          return { id: n.id, label: (has ? "📝 " : "") + first.slice(0, 60), node: n };
        });
        if (!items.length) { new Notice("这个画布里没有文本卡片"); resolve(null); return; }
        new LMBNodeSuggester(this.app, items,
          (it) => resolve({ node: it.node, via: "picker" }),
          () => resolve(null)).open();
      }).catch(() => resolve(null));
    });
  }

  /**
   * 把补充描述写进指定节点。noteText 为空串 = 移除补充描述。
   *   opts.fold 为 boolean 时显式设置折叠态；为 null/undefined 时沿用当前折叠态。
   *   写完同步 autoSize 档案（hash + 尺寸），防止后续 sync 把卡片尺寸回退。
   */
  async applyCardNote(file, nodeId, noteText, opts) {
    const o = opts || {};
    const raw = await this.app.vault.adapter.read(file.path);
    let data;
    try { data = JSON.parse(raw); } catch (_) { return { ok: false, msg: "画布解析失败" }; }
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (!node) return { ok: false, msg: "找不到该卡片（可能已被删除）" };
    if (node.type !== "text") return { ok: false, msg: "只有文本卡片支持补充描述" };

    const cur = lmbSplitNote(node.text || "");
    // 折叠态优先级：显式传入 > 沿用原有 > 新建时用设置里的默认值
    const fold = (typeof o.fold === "boolean")
      ? o.fold
      : (cur.hasNote ? cur.fold : !!this.settings.noteFoldByDefault);
    node.text = lmbJoinNote(cur.body, noteText, {
      type: this.settings.noteCalloutType || "ppd-note",
      title: this.settings.noteTitle || "补充描述",
      fold,
      tail: cur.tail // v0.11.0：评论块原样接回，编辑描述不再弄丢评论
    });

    // 补充描述会改变卡片高度 → 重算并同步档案
    const size = this.estimateSizeFor(node.text);
    node.width = Math.round(size.w);
    node.height = Math.round(size.h);
    // v0.11.0：高度变了 → 组内重新居中（中心保持在父卡横/纵轴上）
    if (Array.isArray(data.edges) && data.edges.length) {
      lmbRecenterNode(node, data.nodes || [], data.edges, this.autoEdges.get(file.path) || new Set());
    }
    let store = this.autoSize.get(file.path);
    if (!store) { store = new Map(); this.autoSize.set(file.path, store); }
    store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });

    const indent = /\n\t"/.test(raw) ? "\t" : "  ";
    this.selfWritten.set(file.path, true);
    await this.app.vault.adapter.write(file.path, JSON.stringify(data, null, indent));
    this.persistAutoSizeSoon();
    return { ok: true, msg: "" };
  }

  /** 三条命令的统一入口：edit（弹窗编辑）/ remove（清空）/ fold（切换折叠） */
  async runCardNoteCommand(mode) {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    const pick = await this.pickCanvasNode(ctx);
    if (!pick || !pick.node) return;
    const cur = lmbSplitNote(pick.node.text || "");

    if (mode === "fold") {
      if (!cur.hasNote) { new Notice("该卡片还没有补充描述"); return; }
      const r = await this.applyCardNote(ctx.file, pick.node.id, cur.note, { fold: !cur.fold });
      new Notice(r.ok ? (cur.fold ? "已展开补充描述" : "已折叠补充描述") : r.msg);
      return;
    }
    if (mode === "remove") {
      if (!cur.hasNote) { new Notice("该卡片本来就没有补充描述"); return; }
      const r = await this.applyCardNote(ctx.file, pick.node.id, "");
      new Notice(r.ok ? "已移除补充描述" : r.msg);
      return;
    }
    // edit
    new LMBNoteModal(this.app, {
      title: cur.hasNote ? "编辑补充描述" : "添加补充描述",
      value: cur.note,
      onSubmit: async (v) => {
        const r = await this.applyCardNote(ctx.file, pick.node.id, v);
        new Notice(r.ok ? (String(v).trim() ? "已保存补充描述" : "已移除补充描述") : r.msg);
      }
    }).open();
  }

  fitNode(node, store) {
    const hash = this.simpleHash(node.text);
    const prev = store.get(node.id);
    if (prev && prev.hash === hash) return null;  // 已适配或用户手动调整过
    const size = this.estimateSizeFor(node.text);
    store.set(node.id, { hash, w: size.w, h: size.h });
    this.persistAutoSizeSoon();
    if (prev && Math.abs(prev.w - size.w) < 2 && Math.abs(prev.h - size.h) < 2) return null;
    return size;
  }

  /** 图片卡：按截图真实宽高比；文本卡：按行宽/行数估算 */
  estimateSizeFor(text) {
    const em = text.match(/!\[\[([^\]|]+?)\]\]/);   // em[1] = 完整附件名（含 .webp）
    if (em) {
      const dims = this.imgDims.get(em[1]);
      const w = 380;
      if (dims && dims.w > 0) {
        // 图片高（按卡片宽等比）+ 回跳引用行（约 2 行）+ 内边距
        const imgH = Math.round(w * dims.h / dims.w);
        return this.addNoteChrome({ w, h: imgH + 78 }, text);
      }
      return this.addNoteChrome({ w, h: 460 }, text);
    }
    // v0.8.0：不可见的注释锚点行不计入高度，按「实际渲染的文本」估算，再补 callout 框高
    return this.addNoteChrome(this.estimateTextSize(lmbRenderedText(text)), text);
  }

  /**
   * v0.8.0：给尺寸补上 callout（补充描述框）的额外高度。
   *   callout 渲染出来会有背景框 + 标题行 + 上下内边距，这部分不在纯文本行高里。
   *   估约 46px（标题行 25 + 上下 padding 约 21），近似值，够用。
   */
  addNoteChrome(size, text) {
    if (!lmbSplitNote(text).hasNote) return size;
    return { w: size.w, h: Math.ceil(Math.min(900, size.h + 46)) };
  }

  estimateTextSize(text) {
    const doc = typeof activeDocument !== "undefined" ? activeDocument : document;
    const meas = doc.createElement("span");
    meas.style.cssText = "position:fixed;left:-9999px;top:0;white-space:pre;visibility:hidden;" +
      "font-size:16px;line-height:1.5;font-family:var(--font-text,-apple-system,'Microsoft YaHei',sans-serif);";
    doc.body.appendChild(meas);
    const lines = text.split("\n").map((l) => {
      let s = l.replace(/\[\[[^\]]*\|([^\]]+)\]\]/g, "$1").replace(/\[\[[^\]]*\]\]/g, "……");
      const quote = /^>/.test(s);
      s = s.replace(/^>\s?/, "");
      meas.textContent = s || " ";
      return { w: meas.getBoundingClientRect().width, quote };
    });
    meas.remove();

    const padX = 28, padY = 40, lineH = 25, quoteIndent = 22;
    const natural = Math.max.apply(null, lines.map((l) => l.w + (l.quote ? quoteIndent : 0)));
    const w = Math.ceil(Math.min(560, Math.max(260, natural + padX)));
    const innerW = Math.max(80, w - padX - quoteIndent);
    let h = padY;
    for (const l of lines) {
      h += Math.max(1, Math.ceil(l.w / innerW)) * lineH + (l.quote ? 4 : 0);
    }
    return { w, h: Math.ceil(Math.min(900, Math.max(80, h))) };
  }

  simpleHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return String(h);
  }

  persistAutoSizeSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.saveSettings().catch(() => {});
    }, 2000);
  }

  /* ==================== 摘录文档（<PDF名>-摘录.md） ==================== */

  /**
   * 摘录文档写入（<PDF名>-摘录.md）—— v0.4.0 树形版。
   * 已知边界（保留，不解决）：整文件重写，用户对摘录 md 的手工修改会被覆盖。
   * 结构：frontmatter（PDF / canvas / updated）+ 树形摘录：
   *   - canvas 连线（含自动父子 + 用户手连）导出 parentOf → 子摘录以嵌套引用块
     *   （"> > 正文"）缩进在父摘录之下，大纲/阅读视图直接呈现层级；
   *   - ## P.<N> 标题跟随各根条目自身页码（子条目跟随父所在分组，树语义优先于页语义）；
   *   - 环 / 跨 PDF 父 / 父是普通卡 → 该条目当根平铺，rendered 集合兜底绝不丢条目、不死循环；
   *   - 「> 相关：」行跟随所在层级深度。
   * updated 仅在内容实际变化时刷新：比较时剔除时间戳行，避免无意义全量重写。
   */
  async writeExcerptMd(cf, pdfPath, entries, parentOf) {
    try {
      const pdfBase = pdfPath.split("/").pop().replace(/\.pdf$/i, "");
      const folder = cf.parent && cf.parent.path ? cf.parent.path : "/";
      const mdPath = normalizePath(folder === "/" ? pdfBase + "-摘录.md" : folder + "/" + pdfBase + "-摘录.md");

      // —— 补丁 B：P1-4 相关笔记预取（只算缓存中没有的 id；单个失败不阻断写入）——
      for (const en of entries) {
        if (this.relatedCache && this.relatedCache.has(en.id)) continue;
        try {
          await this.findRelatedNotes(en.id, en.body);
        } catch (err) {
          console.warn("[lmb] related prefetch failed:", en.id, err);
          if (this.relatedCache && !this.relatedCache.has(en.id)) this.relatedCache.set(en.id, []);
        }
      }

      // —— 补丁 A（P1-3）：按页排序（稳定，同页保持 canvas 顺序），无页码排最后
      const withPage = [];
      const noPage = [];
      for (const en of entries) {
        (en.page != null ? withPage : noPage).push(en);
      }
      withPage.sort((a, b) => a.page - b.page);
      const ordered = withPage.concat(noPage);

      // —— v0.4.0：树形渲染（嵌套引用块；环/遗漏由 rendered + 兜底平铺保证不丢）
      const { roots, children } = lmbBuildTree(ordered, parentOf || new Map());
      const rendered = new Set();
      let body = "";
      let lastKey = null;
      const emitEntry = (en, depth) => {
        const q = depth > 0 ? "> ".repeat(depth) : "";
        for (const line of en.body.split("\n")) body += (q + line) + "\n";
        body += q + "^" + en.id + "\n";
        const rel = this.relatedCache ? this.relatedCache.get(en.id) : null;
        if (rel && rel.length) body += q + "> 相关：" + rel.join(" · ") + "\n";
        body += "\n";
      };
      const dfs = (en, depth) => {
        if (rendered.has(en.id)) return;
        rendered.add(en.id);
        if (depth === 0) {
          const key = en.page != null ? "P." + en.page : "未定位";
          if (key !== lastKey) { body += "## " + key + "\n\n"; lastKey = key; }
        }
        emitEntry(en, depth);
        for (const c of children.get(en.id) || []) dfs(c, depth + 1);
      };
      for (const en of roots) dfs(en, 0);
      // 兜底：纯环中不可达的条目按原顺序平铺（保证零丢失）
      for (const en of ordered) {
        if (!rendered.has(en.id)) {
          const key = en.page != null ? "P." + en.page : "未定位";
          if (key !== lastKey) { body += "## " + key + "\n\n"; lastKey = key; }
          emitEntry(en, 0);
        }
      }

      const head = "---\nPDF: \"[[" + pdfPath + "]]\"\ncanvas: \"[[" + cf.basename + "]]\"\n";
      // 不含 updated 时间戳的基准内容（用于变化检测）
      const bodyNoStamp = head + "---\n\n" + body;

      const existing = this.app.vault.getAbstractFileByPath(mdPath);
      if (existing instanceof TFile) {
        const cur = await this.app.vault.read(existing);
        const curNoStamp = cur.replace(/^updated: "[^"]*"\r?\n/m, "");
        if (curNoStamp !== bodyNoStamp) {
          const content = head + "updated: \"" + new Date().toISOString() + "\"\n---\n\n" + body;
          await this.app.vault.process(existing, () => content);
          console.log("[lmb] excerpt doc updated:", mdPath);
        }
      } else {
        const content = head + "updated: \"" + new Date().toISOString() + "\"\n---\n\n" + body;
        await this.app.vault.create(mdPath, content);
        new Notice("MarginBook: 已创建摘录文档 " + mdPath);
        console.log("[lmb] excerpt doc created:", mdPath);
      }
    } catch (err) {
      console.error("[lmb] writeExcerptMd error:", err);
    }
  }

  /* ==================== P1：摘录索引层 ====================
   * 反向索引：摘录 md → (PDF, 页, 选区)。为 P2 回绘 / P3 跳转供数。
   * 真相源始终是摘录 md，索引是可重建缓存，不写进 data.json。
   * ===================================================================== */

  /**
   * 候选文件预筛：只保留「链接到 .pdf」的 md。
   * 走 metadataCache.resolvedLinks（内存索引），不读文件正文 —— 比 PDF Flow
   * 「读全库所有 md」省得多。metadataCache 不可用时退化为全量（保守，不漏）。
   */
  lmbIndexCandidates() {
    const all = this.app.vault.getMarkdownFiles();
    const rl = this.app.metadataCache && this.app.metadataCache.resolvedLinks;
    if (!rl) return all;
    return all.filter((f) => {
      const links = rl[f.path];
      return links && Object.keys(links).some((p) => p.toLowerCase().endsWith(".pdf"));
    });
  }

  /** 单个文件是否链接到 pdf（用于 modify 事件的廉价预筛，避免每次敲键都读文件） */
  lmbFileLinksPdf(f) {
    try {
      const links = this.app.metadataCache && this.app.metadataCache.resolvedLinks
        && this.app.metadataCache.resolvedLinks[f.path];
      return !!(links && Object.keys(links).some((p) => p.toLowerCase().endsWith(".pdf")));
    } catch (_) { return false; }
  }

  /** 全量重建。分批 20 个 + 批间 sleep 10ms，避免大库卡 UI。 */
  async buildExcerptIndex() {
    if (this._isIndexing) return;
    this._isIndexing = true;
    const t0 = Date.now();
    try {
      this.excerptIndex.clear();
      this.indexMtime.clear();
      const cands = this.lmbIndexCandidates();
      for (let i = 0; i < cands.length; i += 20) {
        for (const f of cands.slice(i, i + 20)) await this.reindexFile(f);
        if (i + 20 < cands.length) await new Promise((r) => setTimeout(r, 10));
      }
      // P3.5：canvas 索引（exId → canvas 卡片），供反向跳转优先进画布
      const canvases = this.app.vault.getFiles().filter((f) => f.extension === "canvas");
      for (let i = 0; i < canvases.length; i += 10) {
        for (const cf of canvases.slice(i, i + 10)) await this.lmbIndexCanvasFile(cf);
        if (i + 10 < canvases.length) await new Promise((r) => setTimeout(r, 10));
      }
      const s = this.getIndexStats();
      if (this.settings && this.settings.debug) {
        console.log("[lmb] 摘录索引构建完成:", s, (Date.now() - t0) + "ms");
      }
      // P2：索引变了 → 重画标记
      this.lmbRefreshAllMarks();
      return s;
    } catch (err) {
      console.error("[lmb] buildExcerptIndex error:", err);
    } finally {
      this._isIndexing = false;
    }
  }

  /**
   * 增量重索引单个文件。
   * 两道闸门避免无谓读盘：① 不链 pdf 且不在索引中 → 直接跳过
   *                    ② mtime 未变化 → 直接跳过
   */
  async reindexFile(f) {
    try {
      if (!f || f.extension !== "md") return;
      if (!this.lmbFileLinksPdf(f) && !this.indexMtime.has(f.path)) return;
      const prev = this.indexMtime.get(f.path);
      if (prev != null && f.stat && f.stat.mtime <= prev) return;

      this.dropFileFromIndex(f.path);
      const content = await this.app.vault.cachedRead(f);
      const entries = lmbParseExcerptDoc(content, f.path);
      for (const e of entries) {
        if (!e || !e.pdfPath) continue;
        // 链接可能是相对名，解析成真实路径作为 key
        let key = e.pdfPath;
        try {
          const dest = this.app.metadataCache.getFirstLinkpathDest(e.pdfPath, f.path);
          if (dest && dest.path) key = dest.path;
        } catch (_) { /* 解析失败就用原样，不丢条目 */ }
        if (!this.excerptIndex.has(key)) this.excerptIndex.set(key, []);
        this.excerptIndex.get(key).push(e);
      }
      this.indexMtime.set(f.path, f.stat ? f.stat.mtime : Date.now());
      // P2：索引变了 → 防抖重画（modify 会在每次敲键触发，所以必须防抖）
      this.lmbScheduleMarksRefresh(300);
    } catch (err) {
      console.warn("[lmb] reindexFile error:", f && f.path, err);
    }
  }

  /** 摘掉某个摘录文档贡献的全部条目（文件删除 or 重索引前调用） */
  dropFileFromIndex(mdPath) {
    if (!mdPath || !this.excerptIndex) return;
    for (const [k, arr] of Array.from(this.excerptIndex.entries())) {
      const kept = arr.filter((e) => e.sourceMd !== mdPath);
      if (kept.length !== arr.length) this.excerptIndex.set(k, kept);
    }
    this.indexMtime.delete(mdPath);
  }

  /**
   * P3.5：canvas 索引 —— 扫一个 .canvas，登记 text 节点里的 ^ex-id。
   * 反向跳转用它优先进画布（用户要求：跳到摘录的 canvas 卡片，不是 md）。
   */
  async lmbIndexCanvasFile(cf) {
    try {
      if (!cf || cf.extension !== "canvas") return;
      // 先摘掉该 canvas 之前贡献的条目（增量重扫）
      for (const [k, v] of Array.from(this.excerptCanvasIndex.entries())) {
        if (v && v.canvasPath === cf.path) this.excerptCanvasIndex.delete(k);
      }
      const raw = await this.app.vault.cachedRead(cf);
      let data;
      try { data = JSON.parse(raw); } catch (_) { return; }
      const nodes = data && Array.isArray(data.nodes) ? data.nodes : [];
      for (const n of nodes) {
        if (!n || n.type !== "text" || !n.text) continue;
        const ids = n.text.match(/\^ex-[0-9a-z]{4,8}/g);
        if (!ids) continue;
        for (const id of ids) {
          this.excerptCanvasIndex.set(id.slice(1), { canvasPath: cf.path, nodeId: n.id });
        }
      }
    } catch (err) {
      console.warn("[lmb] lmbIndexCanvasFile error:", cf && cf.path, err);
    }
  }

  /**
   * 打开 canvas 并聚焦到指定节点（选中 + 缩放到选区）。
   * canvas 视图懒加载节点，必须轮询等 nodes 里出现目标 id。
   * 聚焦失败不算失败（画布已打开），返回 true。
   */
  async lmbFocusCanvasNode(cf, nodeId) {
    try {
      /* v0.9.2：【已打开的画布直接复用，绝不重开】。
       * 之前每次都 getLeaf("tab") + openFile —— 同一个 canvas 开出第二个视图：
       *   ① 用户烦（标签页越积越多）；
       *   ② 同一文件两个视图 → canvasPositions 等以"视图对象"为键的
       *      状态全部失效 → 重开即重跑 processCanvas → 已排好的卡被再次
       *      fitNode/挂框 → 这正是「先排布再放大 → 卡片重叠」反复出现的推手。 */
      let leaf = null;
      const leaves = this.app.workspace.getLeavesOfType("canvas");
      for (const l of leaves) {
        const v = l && l.view;
        if (v && v.file && v.file.path === cf.path) { leaf = l; break; }
      }
      if (!leaf) {
        leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(cf);
      } else {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }
      const view = leaf.view;
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        const canvas = view && view.canvas;
        const node = canvas && canvas.nodes && canvas.nodes.get
          ? canvas.nodes.get(nodeId) : null;
        if (node) {
          try {
            if (typeof canvas.deselectAll === "function") canvas.deselectAll();
            if (typeof canvas.select === "function") canvas.select(node);
            if (typeof canvas.zoomToSelection === "function") canvas.zoomToSelection();
          } catch (_) { /* 选中/缩放失败不影响"已打开画布"这个结果 */ }
          // v0.9.2：跳转落地后做一次重叠自愈（见 lmbScheduleOverlapHeal）
          this.lmbScheduleOverlapHeal(cf);
          return true;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;   // 节点一直没出现 → 让调用方回退 md
    } catch (err) {
      console.warn("[lmb] lmbFocusCanvasNode error:", err);
      return false;
    }
  }

  /**
   * v0.9.2：跳转落地后的「重叠自愈」。
   * 背景：lmbLayoutGroup 排布用的是当时的卡片高度，之后卡片"放大"
   *   （补充描述框挂上 / fitNode 估算修正）时，下方/右侧的卡不会跟着让位 → 重叠。
   * 修法：落地 900ms 后（等 processCanvas 的写入和视图重载都结束），
   *   对这张画布跑一次 v0.6.0 的重叠规范化 —— 幂等、只动 ^ex 卡、
   *   没有重叠时是空操作（分组条件就是"两卡相交 ≥ 较小卡 20%"）。
   */
  lmbScheduleOverlapHeal(cf) {
    try {
      if (this._ppdHealTimer) clearTimeout(this._ppdHealTimer);
      this._ppdHealTimer = setTimeout(() => {
        this._ppdHealTimer = null;
        try {
          this.normalizeOverlappingExcerpts(cf).catch(() => {});
        } catch (_) { /* noop */ }
      }, 900);
    } catch (_) { /* noop */ }
  }

  /** 供 P2 回绘使用：某 PDF 的全部摘录条目 */
  getExcerptsForPdf(pdfPath) {
    return this.excerptIndex ? (this.excerptIndex.get(pdfPath) || []) : [];
  }

  getIndexStats() {
    let excerpts = 0;
    if (this.excerptIndex) for (const arr of this.excerptIndex.values()) excerpts += arr.length;
    return {
      pdfs: this.excerptIndex ? this.excerptIndex.size : 0,
      excerpts: excerpts,
      files: this.indexMtime ? this.indexMtime.size : 0
    };
  }

  /* ==================== P2：回绘层 ====================
   * 在 PDF 页面上把「已摘录」的段落标出来，让"哪里摘过"一眼可见。
   *
   * P0 的三条实测结论直接决定了这里的写法：
   *   ① span 索引与缩放无关、textLayer 重建后不变 → 可以放心用索引定位
   *   ② 25 页里只有 3 页有 textLayer（pdf.js 虚拟化）→ 必须靠 MutationObserver 驱动重画
   *   ③ resolveSelectionRects 往返误差 < 6px → 逆运算可用
   *
   * 定位方式：百分比 + .page 相对定位。覆盖层随页面缩放自动跟随，
   *           完全不需要监听 zoom 事件重算。
   *
   * 降级原则（比 PDF Flow 好）：宁可画得不准，也绝不什么都不画。
   *   PDF Flow 在 span 对不上时静默返回 null，高亮直接消失；
   *   我们改画页顶灰色细条并打 data-fallback="1"。
   * ===================================================================== */

  /** 页面矩形 → 相对 .page 的百分比（随缩放自动跟随） */
  lmbRectsToPercents(rects, pageEl) {
    const pr = pageEl.getBoundingClientRect();
    if (!pr.width || !pr.height) return null;
    return rects.map((cr) => ({
      left: 100 * (cr.left - pr.left) / pr.width,
      top: 100 * (cr.top - pr.top) / pr.height,
      width: 100 * cr.width / pr.width,
      height: 100 * cr.height / pr.height
    }));
  }

  /**
   * 选区参数 → 页面内矩形数组。这是 buildSelectionParams 的**逆运算**。
   * 口径必须与正向一致：divs = .textLayer 的**直接子元素**。
   * 失败返回 null（由调用方走降级）。
   */
  lmbResolveSelectionRects(pageEl, selection) {
    try {
      if (!pageEl || !selection || selection.length !== 4) return null;
      const layer = pageEl.querySelector(".textLayer");
      if (!layer) return null;
      const divs = Array.from(layer.children);
      if (!divs.length) return null;

      const locate = (idx, off) => {
        const div = divs[idx];
        if (!div) return null;
        const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
        let acc = 0, n;
        while ((n = w.nextNode())) {
          const len = n.textContent ? n.textContent.length : 0;
          if (acc + len >= off) return { node: n, offset: off - acc };
          acc += len;
        }
        // 偏移超出该 span 长度 → 退到 span 末尾（不返回 null，尽量画出来）
        const last = div.lastChild && div.lastChild.nodeType === 3 ? div.lastChild : div;
        return { node: last, offset: (last.textContent || "").length };
      };

      const s = locate(selection[0], selection[1]);
      const e = locate(selection[2], selection[3]);
      if (!s || !e) return null;
      const r = document.createRange();
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
      const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0.5 && x.height > 0.5);
      return rects.length ? rects : null;
    } catch (_) { return null; }
  }

  /** #rrggbb → rgba()，失败返回 null */
  lmbHexToRgba(hex, alpha) {
    const h = String(hex || "").replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  /**
   * 标记颜色：优先用 colorMap 反查（tag → hex）。
   * parseColorMap 给的是 hex → tag，这里倒过来查。
   * 没映射就用默认柔和黄。
   */
  lmbMarkColor(entry) {
    try {
      const raw = this.settings && this.settings.colorMap;
      if (raw && entry && entry.tags && entry.tags.length) {
        const map = this.parseColorMap(raw);
        for (const [hex, tag] of map.entries()) {
          if (entry.tags.indexOf(tag) >= 0) {
            const c = this.lmbHexToRgba("#" + hex, 0.42);
            if (c) return c;
          }
        }
      }
    } catch (_) { /* 解析失败 → 默认色 */ }
    return "rgba(255, 226, 120, 0.40)";
  }

  /** 画单条摘录的标记（跨行会有多个矩形，每个矩形一个 div） */
  lmbDrawEntryMark(pageEl, entry) {
    try {
      let pcts = null;
      if (entry && entry.selection) {
        const rects = this.lmbResolveSelectionRects(pageEl, entry.selection);
        if (rects) pcts = this.lmbRectsToPercents(rects, pageEl);
      } else if (entry && entry.rect && entry.rect.length === 4) {
        // 截图摘录：rect 就是页面百分比，直接用——不需要 textLayer，
        // 虚拟化（未渲染）的页也能画。这是"截图摘录在 PDF 里没标记"的修复。
        const [l, t, w, h] = entry.rect;
        if (w > 0 && h > 0) pcts = [{ left: l, top: t, width: w, height: h }];
      }

      const frag = document.createDocumentFragment();
      if (pcts && pcts.length) {
        const bg = this.lmbMarkColor(entry);
        for (const p of pcts) {
          const d = document.createElement("div");
          d.className = "lmb-mark";
          if (entry.exId) d.setAttribute("data-ex", entry.exId);
          // 反向跳转（P3 双击）需要知道来源摘录文档
          if (entry.sourceMd) d.setAttribute("data-src", entry.sourceMd);
          if (entry.tags && entry.tags.length) d.setAttribute("data-tag", entry.tags.join(" "));
          d.style.left = p.left + "%";
          d.style.top = p.top + "%";
          d.style.width = p.width + "%";
          d.style.height = p.height + "%";
          d.style.background = bg;
          frag.appendChild(d);
        }
      } else {
        // 降级：缺坐标或 span 对不上 → 页顶细条（绝不静默消失）
        const bar = document.createElement("div");
        bar.className = "lmb-mark";
        bar.setAttribute("data-fallback", "1");
        if (entry && entry.exId) bar.setAttribute("data-ex", entry.exId);
        if (entry && entry.sourceMd) bar.setAttribute("data-src", entry.sourceMd);
        bar.style.background = "rgba(140,140,140,0.55)";
        bar.title = "此处有摘录，但无法精确定位（缺 selection 或文本层对不上）";
        frag.appendChild(bar);
      }
      pageEl.appendChild(frag);
    } catch (_) { /* 单条失败不影响其他条 */ }
  }

  /** 性能守卫：摘录很多时只画视口附近的页 */
  lmbPageNearViewport(pageEl) {
    try {
      const r = pageEl.getBoundingClientRect();
      const h = window.innerHeight || 800;
      return r.bottom > -2 * h && r.top < 3 * h;
    } catch (_) { return true; }
  }

  /** 清掉一个容器内的全部标记 */
  lmbClearMarks(containerEl) {
    try {
      if (!containerEl) return;
      const marks = containerEl.querySelectorAll(".lmb-mark");
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        if (m.parentNode) m.parentNode.removeChild(m);
      }
    } catch (_) { /* noop */ }
  }

  /** 画一个 PDF 视图的全部标记 */
  lmbDrawMarksForView(view) {
    try {
      if (!view || !view.containerEl) return;
      const container = view.containerEl;
      this.lmbClearMarks(container);

      const file = view.file;
      if (!file) return;
      const entries = this.getExcerptsForPdf(file.path);
      if (!entries || !entries.length) { this.lmbDisconnectObserver(view); return; }

      const pages = container.querySelectorAll("div.page");
      if (!pages.length) return;   // 还没渲染（僵尸 leaf / 刚打开）→ 等 observer 触发

      const guard = entries.length > 200;   // 性能守卫

      for (let i = 0; i < pages.length; i++) {
        const pageEl = pages[i];
        const num = parseInt(pageEl.getAttribute("data-page-number") || "", 10);
        if (!num) continue;
        // 虚拟化的页没有文本层，等它进入视口后 observer 会重画
        if (!pageEl.querySelector(".textLayer")) continue;
        if (guard && !this.lmbPageNearViewport(pageEl)) continue;
        const list = entries.filter((e) => e.page === num);
        for (const e of list) this.lmbDrawEntryMark(pageEl, e);
      }
      this.lmbSetupObserver(view);
    } catch (err) {
      console.warn("[lmb] lmbDrawMarksForView error:", err);
    }
  }

  /**
   * 挂 MutationObserver 驱动重画。
   * pdf.js 虚拟化会不断增删 .page / .textLayer，所以必须盯着。
   * **关键**：要过滤掉我们自己造成的变动（append .lmb-mark），否则无限重画。
   */
  lmbSetupObserver(view) {
    try {
      if (!view || !view.containerEl || view._ppdMarkObserver) return;
      const target = view.containerEl.querySelector(".pdfViewer") || view.containerEl;
      if (!target) return;
      const isOwn = (n) => n && n.nodeType === 1 && n.classList && n.classList.contains("lmb-mark");
      let timer = null;
      const ob = new MutationObserver((records) => {
        let relevant = false;
        for (const rec of records) {
          const scan = (list) => {
            for (let i = 0; i < list.length; i++) {
              const n = list[i];
              if (n.nodeType === 3) return true;                 // 文本节点（textLayer 填字）
              if (n.nodeType === 1 && !isOwn(n)) return true;    // 非我们自己的元素
            }
            return false;
          };
          if (scan(rec.addedNodes) || scan(rec.removedNodes)) { relevant = true; break; }
        }
        if (!relevant) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          try {
            if (view && view.containerEl && view.containerEl.isConnected) {
              this.lmbDrawMarksForView(view);
            }
          } catch (_) { /* noop */ }
        }, 150);
      });
      ob.observe(target, { childList: true, subtree: true });
      view._ppdMarkObserver = ob;

      // P3：双击标记区域 → 跳回摘录（单击/划选完全不受影响，标记仍是 pointer-events:none）
      if (!target._ppdMarkDblClick) {
        const handler = (ev) => {
          try {
            const t = ev.target;
            if (!t || !t.closest) return;
            const pageEl = t.closest("div.page");
            if (!pageEl) return;
            const x = ev.clientX, y = ev.clientY;
            const marks = pageEl.querySelectorAll(".lmb-mark");
            for (let i = marks.length - 1; i >= 0; i--) {   // 从最上层往下找
              const m = marks[i];
              const r = m.getBoundingClientRect();
              if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                const exId = m.getAttribute("data-ex");
                const src = m.getAttribute("data-src");
                if (exId) { ev.preventDefault(); this.lmbOpenExcerptAt(exId, src); }
                return;
              }
            }
          } catch (err) {
            console.warn("[lmb] 双击标记跳转出错:", err);
          }
        };
        target.addEventListener("dblclick", handler);
        target._ppdMarkDblClick = handler;
        this._ppdDblClickTargets = this._ppdDblClickTargets || [];
        this._ppdDblClickTargets.push(target);
      }
    } catch (_) { /* noop */ }
  }

  lmbDisconnectObserver(view) {
    try {
      if (view && view._ppdMarkObserver) {
        view._ppdMarkObserver.disconnect();
        view._ppdMarkObserver = null;
      }
      if (view && view._ppdMarkTimer) {
        clearTimeout(view._ppdMarkTimer);
        view._ppdMarkTimer = null;
      }
    } catch (_) { /* noop */ }
  }

  /** 全量刷新所有 PDF 视图的标记 */
  lmbRefreshAllMarks() {
    try {
      const leaves = this.app.workspace.getLeavesOfType("pdf");
      for (const l of leaves) {
        const v = l && l.view;
        if (v && v.containerEl) this.lmbDrawMarksForView(v);
      }
    } catch (err) {
      console.warn("[lmb] lmbRefreshAllMarks error:", err);
    }
  }

  /** 防抖刷新（布局变化 / 切标签 / 索引更新都走这里） */
  lmbScheduleMarksRefresh(delay) {
    try {
      if (this._ppdMarksTimer) clearTimeout(this._ppdMarksTimer);
      this._ppdMarksTimer = setTimeout(() => {
        this._ppdMarksTimer = null;
        this.lmbRefreshAllMarks();
      }, delay == null ? 200 : delay);
    } catch (_) { /* noop */ }
  }

  /* ==================== P3：双向跳转 ====================
   * 正向：摘录文档里的 [[x.pdf#page=N&selection=a,b,c,d]] → 滚到页 + 精确定位 + 闪 3 次
   * 反向：PDF 上双击标记区域 → 打开摘录文档并定位到 ^ex- 块
   *
   * 为什么必须接管 openLinkText：`selection=` 是本插件链路使用的非标准参数
   * （URL 约定沿用 PDF++ 以兼容存量笔记），Obsidian 内核只认 `#page=N` ——
   * 不接管的话点回跳链接只能跳到页，精确定位失效。本层把解析权拿回来，
   * selection= 的生成与解析全部自理，不依赖任何第三方插件。
   *
   * 为什么只接管「带 selection= 的链接」：不带 selection 的 `#page=N` Obsidian
   * 自己就能处理，透传给原生可以少踩坑（这是刻意的最小干预）。
   * ===================================================================== */

  /**
   * 解析 pdf 回跳链接。**不依赖 this**（只读模块常量），可离线测。
   * 输入：`x.pdf#page=21&selection=0,0,655,478` 或 `x.pdf#page=21&rect=1,2,3,4`
   * 返回：{ filePath, page, selection, rect }；非 pdf#page= 链接返回 null。
   *
   * v0.9.1 起【接管所有 pdf#page= 链接】（不再要求必须带 selection=）：
   *   原因是用户启用了 PDF++ 后，PDF++ 也劫持 openLinkText 并尝试解析"该 PDF
   *   关联的 md"，同名摘录 md 撞名时直接报错中止。在 DOM 捕获层把链接拦下，
   *   PDF++ 无论加载顺序如何都碰不到 —— 这是与 PDF++ 剥离的关键。
   */
  lmbParsePdfLink(linktext) {
    try {
      if (!linktext || typeof linktext !== "string") return null;
      const bar = linktext.indexOf("|");
      if (bar >= 0) linktext = linktext.slice(0, bar);   // 保险：剥掉别名
      const hash = linktext.indexOf("#");
      if (hash < 0) return null;
      const path = linktext.slice(0, hash).trim();
      const sub = linktext.slice(hash + 1);
      if (!/\.pdf$/i.test(path)) return null;
      if (!/(^|&)page=/.test(sub)) return null;          // 必须有 page=
      const params = new URLSearchParams(sub);
      const page = parseInt(params.get("page"), 10);
      if (!page || isNaN(page)) return null;
      const sm = LMB_SEL_RE.exec((params.get("selection") || "").trim());
      const rm = LMB_RECT_RE.exec((params.get("rect") || "").trim());
      return {
        filePath: path,
        page: page,
        selection: sm ? [+sm[1], +sm[2], +sm[3], +sm[4]] : null,
        rect: rm ? [+rm[1], +rm[2], +rm[3], +rm[4]] : null
      };
    } catch (_) { return null; }
  }

  /**
   * 【v0.9.1 主力】DOM 捕获层拦截 pdf 链接点击。
   * 为什么不用 openLinkText 劫持当主力：其他插件（如 PDF++）也可能劫持
   * openLinkText，劫持顺序 = 插件加载顺序，不可控 —— PDF++ 若同时启用，
   * 会尝试解析"该 PDF 关联的 md"，同名摘录 md 撞名时直接报错中止
   * （"Multiple markdown files are associated" → Aborting）。
   * document 捕获阶段的 click 事件【先于一切】冒泡/委托处理，
   * stopImmediatePropagation 之后 Obsidian / 其他插件都收不到 —— 稳赢。
   */
  lmbSetupLinkInterception() {
    try {
      if (this._ppdLinkHandler) return;
      const handler = (ev) => {
        try {
          if (ev.defaultPrevented) return;
          if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
          const t = ev.target;
          const a = t && t.closest && t.closest("a.internal-link, a.cm-underline, .internal-link");
          if (!a) return;
          const href = a.getAttribute("href") || a.getAttribute("data-href") || "";
          const hit = this.lmbParsePdfLink(href);
          if (!hit) return;                                  // 非 pdf#page= 链接不碰
          ev.preventDefault();
          ev.stopPropagation();
          ev.stopImmediatePropagation();                     // Obsidian / 其他插件都别想碰
          this.lmbJumpToSelection(hit.filePath, hit.page, hit.selection, hit.rect);
        } catch (err) {
          console.warn("[lmb] pdf 链接拦截出错:", err);
        }
      };
      document.addEventListener("click", handler, true);
      this._ppdLinkHandler = handler;
      // openLinkText 兜底保留（覆盖程序化调用；点击路径已被上面拦截）
      this.lmbPatchOpenLinkText();
    } catch (err) {
      console.warn("[lmb] lmbSetupLinkInterception error:", err);
    }
  }

  /** 拆除 DOM 层链接拦截（onunload 调用） */
  lmbTeardownLinkInterception() {
    try {
      if (this._ppdLinkHandler) {
        document.removeEventListener("click", this._ppdLinkHandler, true);
        this._ppdLinkHandler = null;
      }
    } catch (_) { /* noop */ }
  }

  /**
   * 劫持 workspace.openLinkText（兜底，主力是 DOM 捕获拦截）。
   * 卸载时用 this.register 还原，保证禁用插件后行为完全恢复。
   */
  lmbPatchOpenLinkText() {
    try {
      const ws = this.app.workspace;
      if (ws._ppdPatched) return;
      const orig = ws.openLinkText.bind(ws);
      this._ppdOrigOpenLinkText = orig;
      ws.openLinkText = (linktext, sourcePath, newLeaf, options) => {
        try {
          const hit = this.lmbParsePdfLink(linktext);
          if (hit) {
            this.lmbJumpToSelection(hit.filePath, hit.page, hit.selection, hit.rect);
            return;                                       // 接管
          }
        } catch (err) {
          console.warn("[lmb] openLinkText 拦截出错，回退原生:", err);
        }
        return orig(linktext, sourcePath, newLeaf, options);
      };
      ws._ppdPatched = true;
      this.register(() => {
        try {
          if (this._ppdOrigOpenLinkText) this.app.workspace.openLinkText = this._ppdOrigOpenLinkText;
          this._ppdOrigOpenLinkText = null;
          if (ws) ws._ppdPatched = false;
        } catch (_) { /* noop */ }
      });
    } catch (err) {
      console.warn("[lmb] lmbPatchOpenLinkText error:", err);
    }
  }

  /** 等 .page 元素出现（pdf.js 会给所有页建 .page，只是 textLayer 虚拟化） */
  async lmbWaitPageEl(container, pageNum, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 6000)) {
      const el = container.querySelector('.page[data-page-number="' + pageNum + '"]');
      if (el) return el;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  /** 轮询直到选区能解出矩形（= textLayer 已就绪）；超时返回 null */
  async lmbWaitSelectionRects(pageEl, selection, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 8000)) {
      const rects = this.lmbResolveSelectionRects(pageEl, selection);
      if (rects) return rects;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  /**
   * 正向跳转：滚到页 → 按可用坐标定位 → 闪烁。
   *   selection（文字选区）→ 等 textLayer 后解矩形
   *   rect（截图摘录）→ 直接用页面百分比，【不需要 textLayer】
   *   两者都没有 → 只滚到页
   * 只匹配「真正渲染了」的 leaf（view.file 有值）——僵尸 leaf 一律绕开重开。
   */
  async lmbJumpToSelection(filePath, pageNum, selection, rect) {
    try {
      if (!filePath || !pageNum) return;
      let leaf = null;
      const leaves = this.app.workspace.getLeavesOfType("pdf");
      for (const l of leaves) {
        const v = l && l.view;
        if (v && v.file && v.file.path === filePath) { leaf = l; break; }
      }
      if (!leaf) {
        const f = this.app.vault.getAbstractFileByPath(filePath);
        if (!f) { new Notice("MarginBook: 找不到 PDF " + filePath); return; }
        leaf = this.app.workspace.getLeaf("tab");        // 新标签页，不打乱现有布局
        await leaf.openFile(f);
      } else {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }
      const view = leaf.view;
      const container = view && view.containerEl;
      if (!container) return;

      const pageEl = await this.lmbWaitPageEl(container, pageNum, 6000);
      if (!pageEl) { new Notice("MarginBook: 找不到第 " + pageNum + " 页"); return; }
      pageEl.scrollIntoView({ block: "center" });

      // 截图摘录：rect 是页面百分比，直接闪（不需要 textLayer，最稳）
      if (rect && rect.length === 4 && rect[2] > 0 && rect[3] > 0) {
        await new Promise((r) => setTimeout(r, 350));     // 给滚动/渲染一点时间
        this.lmbFlashRects(pageEl, null, rect);
        return;
      }

      // 文字选区：pdf.js 虚拟化，刚滚到的页可能还没渲染文本层，必须等
      if (selection) {
        const rects = await this.lmbWaitSelectionRects(pageEl, selection, 8000);
        if (!rects) {
          new Notice("MarginBook: 已到第 " + pageNum
            + " 页，但选区无法精确定位（文本层未就绪或索引漂移）。可跑「重建摘录索引」重试。");
          return;
        }
        this.lmbFlashRects(pageEl, rects, null);
      }
    } catch (err) {
      console.warn("[lmb] lmbJumpToSelection error:", err);
    }
  }

  /** 闪烁定位：覆盖 accent 色矩形，闪 3 次后自清理。
   *  二参一给 rects（页面客户坐标）一给 rectPcts（页面百分比），二选一。 */
  lmbFlashRects(pageEl, rects, rectPcts) {
    try {
      let pcts = rectPcts || null;
      if (!pcts && rects) pcts = this.lmbRectsToPercents(rects, pageEl);
      if (!pcts || !pcts.length) return;
      const frag = document.createDocumentFragment();
      for (const p of pcts) {
        const d = document.createElement("div");
        d.className = "lmb-flash";
        d.style.left = p.left + "%";
        d.style.top = p.top + "%";
        d.style.width = p.width + "%";
        d.style.height = p.height + "%";
        frag.appendChild(d);
      }
      pageEl.appendChild(frag);
      window.setTimeout(() => {
        try {
          const old = pageEl.querySelectorAll(".lmb-flash");
          for (let i = 0; i < old.length; i++) {
            const n = old[i];
            if (n.parentNode) n.parentNode.removeChild(n);
          }
        } catch (_) { /* noop */ }
      }, 2200);
    } catch (_) { /* noop */ }
  }

  /**
   * 反向跳转：双击标记区域 → 跳到摘录所在处。
   * **优先 canvas 卡片**（v0.9.1 起按用户要求改的：跳到摘录的画布，不是 md），
   * 找不到 canvas 位置 / 节点没等到时才回退 md 的 ^ex- 块。
   */
  async lmbOpenExcerptAt(exId, sourceMd) {
    try {
      if (!exId) return;
      // ① 优先 canvas 卡片
      const loc = this.excerptCanvasIndex ? this.excerptCanvasIndex.get(exId) : null;
      if (loc && loc.canvasPath && loc.nodeId) {
        const cf = this.app.vault.getAbstractFileByPath(loc.canvasPath);
        if (cf && (await this.lmbFocusCanvasNode(cf, loc.nodeId))) return;
      }
      // ② 回退 md
      let path = sourceMd || null;
      if (!path && this.excerptIndex) {
        for (const arr of this.excerptIndex.values()) {
          const hit = arr.find((e) => e.exId === exId);
          if (hit && hit.sourceMd) { path = hit.sourceMd; break; }
        }
      }
      if (!path) { new Notice("MarginBook: 找不到该摘录的来源（canvas 和 md 都没查到）"); return; }
      await this.app.workspace.openLinkText(path + "#^" + exId, "", false);
    } catch (err) {
      console.warn("[lmb] lmbOpenExcerptAt error:", err);
    }
  }

  /* ==================== 旧知识自动浮现（补丁 B：P1-4 相关笔记 + P1-5 颜色语义） ==================== */

  /**
   * P1-4：相关笔记检索（MarginNote 4「标题链接」平替，纯本地零 AI）。
   * 只查 metadataCache 元数据（basename / headings / tags / frontmatter 别名），
   * 不读任何文件正文（性能红线）。同一 entryId 用 relatedCache 只检索一次。
   * 返回 wikilink 字符串数组（如 ["[[路径|显示名]]"]），无结果返回 []。
   */
  async findRelatedNotes(entryId, bodyText) {
    try {
      if (this.relatedCache && this.relatedCache.has(entryId)) {
        return this.relatedCache.get(entryId);
      }
      const result = [];
      const tokens = this.tokenizeForSearch(bodyText);
      if (tokens.length) {
        const scored = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
          try {
            // 排除：路径含 .obsidian、摘录文档自身（basename 以 -摘录 结尾）。
            // canvas / .pdf 不会出现在 getMarkdownFiles() 里，天然排除。
            if (file.path.includes(".obsidian")) continue;
            if (file.basename.endsWith("-摘录")) continue;
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache) continue;

            // 只读元数据拼成一个「索引袋」：basename + headings + tags + 别名等
            const bag = [file.basename.toLowerCase()];
            if (cache.headings) {
              for (const h of cache.headings) if (h.heading) bag.push(h.heading.toLowerCase());
            }
            if (cache.tags) {
              for (const t of cache.tags) if (t.tag) bag.push(t.tag.toLowerCase());
            }
            const fm = cache.frontmatter;
            if (fm) {
              for (const [k, v] of Object.entries(fm)) {
                if (k === "position") continue;
                if (Array.isArray(v)) {
                  for (const item of v) if (typeof item === "string") bag.push(item.toLowerCase());
                } else if (typeof v === "string") {
                  bag.push(v.toLowerCase());
                }
              }
            }
            const haystack = bag.join("\n");
            let score = 0;
            for (const tk of tokens) if (haystack.includes(tk)) score++;
            if (score >= 2) scored.push({ file, score });
          } catch (_) { /* 单个文件元数据异常不影响整体 */ }
        }
        scored.sort((a, b) => b.score - a.score || a.file.basename.localeCompare(b.file.basename));
        for (const s of scored.slice(0, 3)) {
          result.push("[[" + s.file.path.replace(/\.md$/i, "") + "|" + s.file.basename + "]]");
        }
      }
      if (!this.relatedCache) this.relatedCache = new Map();
      this.relatedCache.set(entryId, result);
      if (result.length) console.log("[lmb] related for", entryId + ":", result.length);
      return result;
    } catch (err) {
      console.warn("[lmb] findRelatedNotes error:", err);
      const empty = [];
      if (this.relatedCache) this.relatedCache.set(entryId, empty);
      return empty;
    }
  }

  /**
   * 分词：CJK 连续段切 2-gram（「注意力机制」→ 注意/意力/力机/机制）；
   * 拉丁/数字段按单词（≥2 字符）；去停用词；总量上限 40 token。
   * 输入前先剥掉 wikilink 与 ^ex-id，防止链接文件名/编号污染分词。
   */
  tokenizeForSearch(text) {
    try {
      const STOP = new Set([
        "的", "了", "在", "是", "和", "与", "也", "这", "那", "之", "中", "对", "把",
        "被", "为", "等", "及", "或", "个", "不", "有", "人", "上", "下", "其", "一",
        "and", "the", "for", "with", "from", "this", "that", "are", "was", "not",
        "into", "have", "has", "will", "can", "but", "all", "you", "your"
      ]);
      const src = String(text || "")
        .replace(/\[\[[^\]]*\]\]/g, " ")
        .replace(/\^ex-[0-9a-z]{4,8}/g, " ")
        .toLowerCase();
      const out = [];
      const seen = new Set();
      const push = (t) => {
        if (t && !seen.has(t) && !STOP.has(t)) { seen.add(t); out.push(t); }
      };
      // 拉丁/数字单词
      const latin = src.match(/[a-z0-9][a-z0-9'-]*/g) || [];
      for (const w of latin) if (w.length >= 2) push(w);
      // CJK 连续段 → 2-gram（单字段保留单字）
      const cjkRuns = src.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || [];
      for (const run of cjkRuns) {
        if (run.length === 1) { push(run); continue; }
        for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2));
      }
      return out.slice(0, 40);
    } catch (err) {
      console.warn("[lmb] tokenizeForSearch error:", err);
      return [];
    }
  }

  /**
   * P1-5：探测选区命中的高亮背景色 → 按 settings.colorMap 映射为标签名。
   * 探测不到 / 未配置 / 未命中一律返回 null（与现状行为一致，静默跳过）。
   */
  detectColorTag(anchorEl, pageEl) {
    try {
      const rawMap = this.settings && this.settings.colorMap;
      if (!rawMap) return null;
      const map = this.parseColorMap(rawMap);
      if (!map.size) return null;
      const colors = this.collectHighlightColors(anchorEl, pageEl);
      for (const hex of colors) {
        const tag = map.get(hex);
        if (tag) {
          console.log("[lmb] colorTag hit:", hex, "->", tag);
          return tag;
        }
      }
      return null;
    } catch (err) {
      console.warn("[lmb] detectColorTag error:", err);
      return null;
    }
  }

  /** 解析「颜色语义映射」textarea：每行 rrgggbb=标签名，忽略空行/错行/#前缀/大小写 */
  parseColorMap(raw) {
    const map = new Map();
    try {
      for (const lineRaw of String(raw || "").split("\n")) {
        const line = lineRaw.trim();
        if (!line) continue; // Bugfix: 不再把 # 开头当注释——key 侧本就允许 # 前缀（如 "#fff3a3=核心观点"），两者曾自相矛盾
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim().replace(/^#/, "").toLowerCase();
        const tag = line.slice(eq + 1).trim();
        if (!/^[0-9a-f]{6}$/.test(key) || !tag) continue;
        map.set(key, tag);
      }
    } catch (_) { /* noop：解析失败按空映射 */ }
    return map;
  }

  /**
   * 收集选区可能命中的高亮背景色（归一化 #rrggbb，小写，按优先顺序）：
   * ① anchorEl 向上到 pageEl 的祖先链（万一某些版本把高亮画在 textLayer DOM 内）；
   * ② 主路径：同页 .annotationLayer 里与选区矩形相交的注释 section
   *    （及其内部 quad div），pdf.js 用内联 background-color 渲染高亮注释
   *    （PDF++ 高亮走的就是 pdf.js 标准 annotationLayer：
   *    .annotationLayer > section:not(.linkAnnotation)——高亮不在 textLayer。）
   */
  collectHighlightColors(anchorEl, pageEl) {
    const out = [];
    const seen = new Set();
    const add = (el) => {
      try {
        if (!el || el.nodeType !== 1) return;
        const win = el.ownerDocument && el.ownerDocument.defaultView;
        if (!win || !win.getComputedStyle) return;
        const hex = this.normalizeColor(win.getComputedStyle(el).backgroundColor);
        if (hex && !seen.has(hex)) { seen.add(hex); out.push(hex); }
      } catch (_) { /* noop */ }
    };
    try {
      let cur = anchorEl;
      while (cur && cur !== pageEl) { add(cur); cur = cur.parentElement; }
    } catch (_) { /* noop */ }
    try {
      const rect = anchorEl.getBoundingClientRect();
      if (rect.width || rect.height) {
        const sections = pageEl.querySelectorAll(".annotationLayer section");
        for (const sec of sections) {
          try {
            const r = sec.getBoundingClientRect();
            const ox = Math.min(rect.right, r.right) - Math.max(rect.left, r.left);
            const oy = Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top);
            if (ox > 2 && oy > 2) {
              add(sec);
              const quads = sec.querySelectorAll("div");
              for (const q of quads) add(q);
            }
          } catch (_) { /* noop */ }
        }
      }
    } catch (_) { /* noop */ }
    return out;
  }

  /**
   * 任意 CSS 颜色字符串 → 6 位 hex（小写）；透明/非法返回 null。
   * 借离屏 canvas 的 fillStyle 归一化能力（rgb/rgba/#hex/颜色名通吃），零依赖。
   */
  normalizeColor(str) {
    try {
      if (!str || str === "transparent") return null;
      if (!this._colorCtx) this._colorCtx = document.createElement("canvas").getContext("2d");
      if (!this._colorCtx) return null;
      this._colorCtx.fillStyle = "#000000";      // 先垫底色，非法值不会覆盖
      this._colorCtx.fillStyle = str;
      const v = this._colorCtx.fillStyle;
      if (typeof v !== "string") return null;
      const m = v.match(/^rgba?\(([^)]+)\)$/i);
      if (m) {
        const p = m[1].split(",").map((s) => parseFloat(s));
        if (p.length < 3) return null;
        if (p.length >= 4 && p[3] <= 0.05) return null;   // 近全透明视为无高亮
        return p.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(n)))
          .toString(16).padStart(2, "0")).join("");
      }
      const m2 = v.match(/^#([0-9a-f]{6})$/i);
      return m2 ? m2[1].toLowerCase() : null;
    } catch (_) {
      return null;
    }
  }

  /* ==================== 样式 ==================== */

  injectStyles() {
    if (document.getElementById("lmb-styles")) return;
    const st = document.createElement("style");
    st.id = "lmb-styles";
    st.textContent = [
      ".lmb-chip{position:fixed;z-index:1000;",
      "background:var(--interactive-accent,#7c6cf0);color:var(--text-on-accent,#fff);",
      "font-size:12px;padding:6px 12px;border-radius:16px;cursor:grab;",
      "box-shadow:0 4px 14px rgba(0,0,0,.5);user-select:none;white-space:nowrap;}",
      ".lmb-chip:active{cursor:grabbing}",
      ".lmb-rect{position:fixed;z-index:999;",
      "border:2px dashed var(--interactive-accent,#7c6cf0);",
      "background:rgba(124,108,240,.15);pointer-events:none;}",
      ".lmb-btn.is-active{color:var(--text-on-accent);background:var(--interactive-accent);}",
      // v0.8.1：动作按钮（补充描述）在不可用上下文里灰显，区别于「模式已开启」的 is-active
      ".lmb-btn.is-idle{opacity:.35;}",
      ".lmb-btn{cursor:pointer;}",
      // ===== 补丁 C：Recall 回忆模式 =====
      ".lmb-recall-blur{position:relative;cursor:pointer;}",
      ".lmb-recall-blur>*{filter:blur(6px);transition:filter .25s;}",
      ".lmb-recall-blur.lmb-recall-reveal>*{filter:none;}",
      // ::after 挂在容器上（blur 只作用于子元素 > *，提示本身不会被糊掉）
      ".lmb-recall-blur::after{content:'\\1F50D  点击回忆';position:absolute;top:6px;right:10px;", // Bugfix: 转义后首空格被 CSS 吃掉，补一个
      "font-size:11px;line-height:1.4;color:var(--text-muted);",
      "background:var(--background-secondary);border:1px solid var(--background-modifier-border);",
      "border-radius:10px;padding:1px 8px;opacity:.85;pointer-events:none;}",
      ".lmb-recall-blur.lmb-recall-reveal::after{display:none;}",
      // ===== P2：摘录回绘标记 =====
      // 关键：百分比定位 + .page 相对定位 → 覆盖层随页面缩放自动跟随，
      //       完全不需要监听 zoom 事件重算（P0 实测 span 索引与缩放无关）。
      'div[data-type="pdf"] .page{position:relative !important;}',
      // 标记保持 pointer-events:none（见下）：单击/划选穿透，双击才跳转（P3）。
      // 原因：标记覆盖在已摘录文字上，若单击可交互，会吃掉划选的起笔事件，
      //       而"在 PDF 上划选拖拽"是本插件的主工作流，不能破坏。
      ".lmb-mark{position:absolute;pointer-events:none;border-radius:2px;",
      "mix-blend-mode:multiply;box-sizing:border-box;}",
      // 降级标记：selection 缺失或 span 对不上时画页顶细条，宁可不准也不消失
      '.lmb-mark[data-fallback="1"]{left:0 !important;right:0 !important;',
      "top:0 !important;height:3px !important;width:auto !important;opacity:.75;}",
      // ===== P3：跳转闪烁 =====
      // 跳到目标选区后闪 3 次（0.5s × 3 = 1.5s），动画结束 opacity 回 0，2.2s 后 JS 移除节点
      ".lmb-flash{position:absolute;pointer-events:none;border-radius:2px;",
      "background:var(--interactive-accent,#7c6cf0);mix-blend-mode:multiply;",
      "animation:lmb-flash-anim .5s ease-in-out 3;}",
      "@keyframes lmb-flash-anim{0%,100%{opacity:0}45%,55%{opacity:.6}}",
      // ===== v0.11.0：评论栏（仿 PDF Flow 批注底栏） =====
      // 未知 callout 类型 Obsidian 默认给铅笔图标（✎）——正合底栏视觉；
      // 折叠态 = 单行按钮条，展开态 = 标题 + 评论内容
      '.callout[data-callout="lmb-comment"]{background:var(--background-secondary,transparent);',
      "border:none !important;border-top:1px solid var(--background-modifier-border) !important;",
      "border-radius:0 !important;box-shadow:none !important;padding:6px 10px !important;margin-top:10px;}",
      '.callout[data-callout="lmb-comment"] .callout-title{gap:6px;}',
      '.callout[data-callout="lmb-comment"] .callout-title-inner{color:var(--text-muted);font-weight:400;font-size:12.5px;}',
      '.callout[data-callout="lmb-comment"] .callout-icon{color:var(--text-faint);}',
      // 折叠箭头推到最右（PDF Flow 的「›」位置）；lmb-comment-clickable 供 JS/测试识别
      '.callout[data-callout="lmb-comment"] .callout-fold{margin-left:auto;}'
    ].join("");
    document.head.appendChild(st);
  }
}

/* ==================== v0.8.0：补充描述输入弹窗 ==================== */

/**
 * 补充描述输入弹窗。多行文本域，Enter 换行、Ctrl/Cmd+Enter 提交。
 * 说明文字里点明「存储方式」，让用户知道这段内容会以 callout 形式内联进卡片。
 */
class LMBNoteModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts || {};
    this.value = this.opts.value || "";
    this.onSubmit = this.opts.onSubmit || (() => {});
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.opts.title || "卡片补充描述" });
    const tip = contentEl.createEl("p", {
      text: "补充描述会以 callout 形式显示在卡片下方（Obsidian 原生可折叠）。内容内联存进卡片本身，复制/导出卡片不会丢。"
    });
    tip.style.cssText = "font-size:12px;color:var(--text-muted);margin:0 0 10px;line-height:1.6;";

    const ta = contentEl.createEl("textarea");
    ta.style.cssText = "width:100%;min-height:160px;resize:vertical;font-size:14px;line-height:1.6;" +
      "background:var(--background-primary);color:var(--text-normal);" +
      "border:1px solid var(--background-modifier-border);border-radius:6px;padding:8px;";
    ta.value = this.value;
    ta.placeholder = "写下你对这段摘录的想法、疑问、联想…";
    this.ta = ta;

    const hint = contentEl.createEl("div", { text: "Ctrl/Cmd + Enter 保存 · Esc 取消 · 清空内容并保存 = 移除补充描述" });
    hint.style.cssText = "font-size:11px;color:var(--text-faint);margin-top:6px;";

    const bar = contentEl.createEl("div");
    bar.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;";
    const cancel = bar.createEl("button", { text: "取消" });
    const ok = bar.createEl("button", { text: "保存" });
    ok.style.cssText = "background:var(--interactive-accent);color:var(--text-on-accent);border:none;border-radius:6px;padding:6px 14px;cursor:pointer;";
    cancel.onclick = () => this.close();
    ok.onclick = () => this.submit();
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.submit(); }
    });
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
  }
  submit() {
    const v = this.ta ? this.ta.value : "";
    this.close();
    this.onSubmit(v);
  }
  onClose() { this.contentEl.empty(); }
}

/**
 * v0.8.0：卡片选择器（内部 API 不可用时的兜底，纯公开 API）。
 * 列出当前画布所有文本卡片，已带补充描述的加 📝 前缀。
 */
class LMBNodeSuggester extends FuzzySuggestModal {
  constructor(app, items, onChoose, onCancel) {
    super(app);
    this.items = items;
    this.onChoose = onChoose;
    this.onCancel = onCancel;
    this.done = false;
  }
  getItems() { return this.items; }
  getItemText(it) { return it.label; }
  onChooseItem(it) { this.done = true; this.onChoose(it); }
  onClose() { if (!this.done && this.onCancel) this.onCancel(); }
}

/* ==================== 设置页 ==================== */

class LMBSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("调试提示（Notice）")
      .setDesc("在屏幕上显示每一步检测结果，用于定位问题。稳定后可关闭。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.debug)
        .onChange(async (v) => { this.plugin.settings.debug = v; await this.plugin.saveSettings(); }));
    // 补丁 B：颜色语义映射
    new Setting(containerEl)
      .setName("颜色语义映射")
      .setDesc("每行一条：rrggbb=标签名（如 fff3a3=核心观点）。PDF 高亮注释的背景色命中映射时，"
        + "拖出的摘录卡会自动附带 #标签名。留空 = 禁用（行为与旧版一致）。")
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.colorMap || "")
          .setPlaceholder("fff3a3=核心观点\na3f3ff=待验证\ncffcfc=反例");
        t.inputEl.setAttribute("rows", "4");
        t.inputEl.style.width = "320px";
        t.inputEl.style.fontFamily = "var(--font-monospace, monospace)";
        t.inputEl.style.fontSize = "12px";
        t.onChange(async (v) => {
          this.plugin.settings.colorMap = v;
          await this.plugin.saveSettings();
        });
      });
    // 补丁 C：回忆模式默认开启
    new Setting(containerEl)
      .setName("回忆模式默认开启")
      .setDesc("插件加载时自动开启回忆模式（阅读模式中模糊摘录，点击揭示）。")
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.recallDefault)
        .onChange(async (v) => { this.plugin.settings.recallDefault = v; await this.plugin.saveSettings(); }));

    /* ---- v0.8.0：卡片补充描述 ---- */
    containerEl.createEl("h2", { text: "卡片补充描述（v0.8.0）" });
    const noteIntro = containerEl.createEl("p", {
      text: "给摘录卡片补一段自己的想法，以 callout 形式显示在卡片下方（Obsidian 原生可折叠）。"
        + "内容内联存在卡片里，复制/导出卡片不会丢。"
    });
    noteIntro.style.cssText = "font-size:12px;color:var(--text-muted);line-height:1.6;margin:0 0 12px;";

    new Setting(containerEl)
      .setName("Callout 类型名")
      .setDesc("补充描述渲染成哪种 callout。改了类型名只影响之后新建的描述，已有的不受影响。")
      .addText((t) => t
        .setValue(this.plugin.settings.noteCalloutType || "ppd-note")
        .setPlaceholder("ppd-note")
        .onChange(async (v) => {
          this.plugin.settings.noteCalloutType = (v || "").trim() || "ppd-note";
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("Callout 标题")
      .setDesc("补充描述框顶部显示的标题。")
      .addText((t) => t
        .setValue(this.plugin.settings.noteTitle || "补充描述")
        .setPlaceholder("补充描述")
        .onChange(async (v) => {
          this.plugin.settings.noteTitle = v;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("新建时默认折叠")
      .setDesc("开启后，新加的补充描述默认是折叠状态（只显示标题行），点开才展开。")
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.noteFoldByDefault)
        .onChange(async (v) => { this.plugin.settings.noteFoldByDefault = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("同步进摘录文档")
      .setDesc("关闭（默认）：补充描述只留在画布卡片上，<PDF名>-摘录.md 保持「原文镜像」不被污染。"
        + "开启：补充描述也会写进摘录文档。")
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.noteIntoSync)
        .onChange(async (v) => { this.plugin.settings.noteIntoSync = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("新摘录卡自动挂空描述框")
      .setDesc("开启（默认）：新拖出的摘录卡下方自动带一个空的补充描述框，点开即可写。"
        + "插件首次扫描某画布时会给已有摘录卡也补上（不覆盖已写过的内容）。"
        + "嫌占位或不想改造存量卡就关掉。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.noteAutoBoxOnNew !== false)
        .onChange(async (v) => { this.plugin.settings.noteAutoBoxOnNew = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("新摘录卡自动挂评论栏")
      .setDesc("开启（默认）：新拖出的摘录卡底部自动带一条「添加评论」栏（仿 PDF Flow 批注样式），"
        + "点评论栏直接弹编辑框；插件首次扫描某画布时也会给存量卡补上（不覆盖已写内容）。"
        + "与「补充描述」是两套独立数据，嫌重复可只留其一。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.commentAutoBoxOnNew !== false)
        .onChange(async (v) => { this.plugin.settings.commentAutoBoxOnNew = v; await this.plugin.saveSettings(); }));
  }
}

module.exports = LuciasMarginBookPlugin;
module.exports.__test = {
  lmbShouldReshowSelection, EX_ID_RE,
  lmbRectsOverlapRatio, lmbPickDropParent, lmbSnapChildPosition, lmbBuildTree,
  lmbDiffCanvasNodes, lmbSideOf, lmbSideEnds, lmbLayoutGroup, lmbGroupBySide,
  lmbAutoEdgeAlive, lmbAutoParentEdgeOf,
  // v0.8.0：卡片补充描述
  lmbSplitNote, lmbJoinNote, lmbStripNote, lmbRenderedText,
  LMB_NOTE_START, LMB_NOTE_END,
  // P1：摘录索引层
  lmbParseExcerptDoc, LMB_LINK_RE, LMB_SEL_RE,
  // v0.11.0：首连锁定 / 改挂侧 / 尺寸重居中 + 独立评论
  lmbPlanAutoLink, lmbApplyReside, lmbRecenterNode,
  lmbSplitComment, lmbJoinComment, LMB_COMMENT_TYPE, LMB_COMMENT_CALLOUT_RE
}; // 测试钩子（node 冒烟脚本用）
// 注：lmbParsePdfLink 是类方法（不依赖 this），测试走 PluginClass.prototype.lmbParsePdfLink
