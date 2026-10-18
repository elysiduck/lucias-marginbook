/*
 * Lucia's MarginBook v0.16.14
 * Independent PDF excerpt workflow for Obsidian.
 *
 * This file starts the generated CommonJS bundle. Release history lives in
 * CHANGELOG.md and docs/historical-bootstrap.md.
 */
"use strict";

const {
  Plugin, Notice, TFile, PluginSettingTab, Setting, normalizePath, Modal,
  FuzzySuggestModal, MarkdownRenderer, setIcon, Platform
} = require("obsidian");

// Platform is part of Obsidian's public API and is available on desktop and mobile.
// Keep the fallback for older test stubs that do not expose it.
const LMB_IS_MOBILE = !!(Platform && (Platform.isMobileApp || Platform.isMobile));

// Stable excerpt identifier embedded in Markdown blocks.
const EX_ID_RE = /\^ex-[0-9a-z]{4,16}/;

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
// 高度测量的固定安全余量。用于吸收字体行高、margin 折叠和 CSS 像素取整误差。
// 文本哈希闸门保证它只应用一次，不会因移动/resize 的 modify 事件反复累加。
const LMB_HEIGHT_PAD = 20;
const LMB_HEIGHT_PAD_COMMENT = 40;

/**
 * 测量渲染内容的固有高度，不受卡片当前高度与内部滚动位置影响。
 * 叶节点 rect 已经包含祖先的顶部间距，因此这里只补叶节点 margin-bottom 和根容器底部间距；
 * 不再逐层累加祖先 margin/padding，避免同一间距重复计算成大片留白。
 */
function lmbMeasureRenderedContent(contentEl, scale) {
  try {
    if (!contentEl || typeof contentEl.getBoundingClientRect !== "function") return 0;
    scale = isFinite(scale) && scale > 0 ? scale : 1;
    const rootRect = contentEl.getBoundingClientRect();
    const scrollTop = Number(contentEl.scrollTop) || 0;
    let maxBottom = 0;
    const visibleKids = (el) => {
      const kids = el && el.children ? Array.from(el.children) : [];
      return kids.filter((kid) => {
        try {
          const cs = getComputedStyle(kid);
          if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
          const r = kid.getBoundingClientRect();
          return !!r && r.height > 0;
        } catch (_) {
          try { return kid.getBoundingClientRect().height > 0; } catch (_) { return false; }
        }
      });
    };
    const walk = (el) => {
      const kids = visibleKids(el);
      if (kids.length) {
        for (const kid of kids) walk(kid);
        return;
      }
      let r; try { r = el.getBoundingClientRect(); } catch (_) { return; }
      if (!r || r.height <= 0) return;
      let marginBottom = 0;
      try { marginBottom = parseFloat(getComputedStyle(el).marginBottom) || 0; } catch (_) {}
      const bottom = (r.bottom - rootRect.top) / scale + scrollTop + marginBottom;
      if (bottom > maxBottom) maxBottom = bottom;
    };
    for (const kid of visibleKids(contentEl)) walk(kid);
    if (maxBottom <= 0) return 0;
    let rootBottom = 0;
    try {
      const cs = getComputedStyle(contentEl);
      rootBottom = (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    } catch (_) {}
    return Math.ceil(maxBottom + rootBottom);
  } catch (_) { return 0; }
}

function lmbFinalizeCardHeight(contentHeight, chromePad, hasComment, alreadyEstimated) {
  const base = Number(contentHeight) || 0;
  if (base <= 0) return 0;
  const total = alreadyEstimated ? base : base + (Number(chromePad) || 0)
    + (hasComment ? LMB_HEIGHT_PAD_COMMENT : LMB_HEIGHT_PAD);
  return Math.max(60, Math.min(4000, Math.ceil(total)));
}

/** 返回实际产生纵向滚动条的像素差；只检查滚动宿主，不拿普通后代的 scrollHeight 误判。 */
function lmbVerticalOverflow(contentEl) {
  try {
    if (!contentEl) return 0;
    const candidates = [contentEl];
    if (typeof contentEl.querySelectorAll === "function") {
      for (const el of Array.from(contentEl.querySelectorAll(
        ".markdown-preview-view, .markdown-rendered"
      ))) candidates.push(el);
    }
    let overflow = 0;
    for (const el of candidates) {
      const scrollH = Number(el && el.scrollHeight) || 0;
      const clientH = Number(el && el.clientHeight) || 0;
      if (scrollH > 0 && clientH > 0) overflow = Math.max(overflow, scrollH - clientH);
    }
    return overflow > 0.5 ? Math.ceil(overflow) : 0;
  } catch (_) { return 0; }
}

function lmbHeightAfterOverflow(currentHeight, overflow) {
  const h = Number(currentHeight) || 0;
  const extra = Number(overflow) || 0;
  // 8px 用于去掉滚动条后文字宽度变化及 Canvas 小数像素舍入；只在确认溢出时增加。
  return extra > 0 ? Math.max(60, Math.min(4000, Math.ceil(h + extra + 8))) : h;
}

// v0.16.12：在 Canvas 中直接读取当前节点会受到固定 height、overflow 和竖向滚动条影响。
// 第一次 fit 后滚动条消失、可用宽度变化，文字会重新换行，于是相同内容第二次测出不同高度。
// 这里克隆整张卡片到同一个 Canvas 容器中，保留主题/祖先选择器和最终外框宽度，但解除
// 高度与 overflow 约束，让浏览器按“无滚动条的自然布局”计算整卡高度。
function lmbMeasureNaturalCard(wrapperEl, contentEl, scale, opts) {
  let clone = null;
  try {
    if (!wrapperEl || !contentEl || typeof wrapperEl.cloneNode !== "function") return 0;
    const doc = wrapperEl.ownerDocument || (typeof document !== "undefined" ? document : null);
    const parent = wrapperEl.parentElement || (doc && doc.body);
    if (!doc || !parent || typeof parent.appendChild !== "function") return 0;

    // 用子节点索引定位 clone 中对应的 contentEl，比依赖某个 Obsidian 版本的 class 稳定。
    const path = [];
    let cursor = contentEl;
    while (cursor && cursor !== wrapperEl) {
      const p = cursor.parentElement;
      if (!p || !p.children) return 0;
      const index = Array.prototype.indexOf.call(p.children, cursor);
      if (index < 0) return 0;
      path.unshift(index);
      cursor = p;
    }
    if (cursor !== wrapperEl) return 0;

    scale = isFinite(scale) && scale > 0 ? scale : 1;
    let outerWidth = Number(wrapperEl.offsetWidth) || 0;
    if (outerWidth <= 0 && typeof wrapperEl.getBoundingClientRect === "function") {
      const r = wrapperEl.getBoundingClientRect();
      if (r && r.width > 0) outerWidth = r.width / scale;
    }
    if (outerWidth <= 0) return 0;

    clone = wrapperEl.cloneNode(true);
    try { clone.removeAttribute("id"); } catch (_) {}
    try { clone.setAttribute("aria-hidden", "true"); } catch (_) {}
    try { clone.inert = true; } catch (_) {}
    const cs = clone.style;
    cs.setProperty("position", "absolute", "important");
    cs.setProperty("left", "-100000px", "important");
    cs.setProperty("top", "0", "important");
    cs.setProperty("transform", "none", "important");
    cs.setProperty("width", `${outerWidth}px`, "important");
    cs.setProperty("height", "auto", "important");
    cs.setProperty("min-height", "0", "important");
    cs.setProperty("max-height", "none", "important");
    cs.setProperty("overflow", "visible", "important");
    cs.setProperty("visibility", "hidden", "important");
    cs.setProperty("pointer-events", "none", "important");
    cs.setProperty("contain", "none", "important");

    let cloneContent = clone;
    const unlock = [clone];
    for (const index of path) {
      cloneContent = cloneContent && cloneContent.children ? cloneContent.children[index] : null;
      if (!cloneContent) return 0;
      unlock.push(cloneContent);
    }
    // 只解除 wrapper→content 这条布局链，不能把图片等内容元素的固有高度也改成 auto。
    for (const el of unlock) {
      if (!el || !el.style) continue;
      el.style.setProperty("height", "auto", "important");
      el.style.setProperty("min-height", "0", "important");
      el.style.setProperty("max-height", "none", "important");
      el.style.setProperty("overflow", "visible", "important");
    }
    // Obsidian Markdown 预览层有时自己承担滚动；一并解除这些纯容器的约束。
    if (cloneContent.querySelectorAll) {
      const layoutLayers = cloneContent.querySelectorAll(
        ".canvas-node-content, .canvas-node-container, .markdown-preview-view, .markdown-preview-sizer, .markdown-preview-section, .markdown-rendered"
      );
      for (const el of Array.from(layoutLayers)) {
        if (!el || !el.style) continue;
        el.style.setProperty("height", "auto", "important");
        el.style.setProperty("min-height", "0", "important");
        el.style.setProperty("max-height", "none", "important");
        el.style.setProperty("overflow", "visible", "important");
        // 窄卡片最容易触发 Obsidian 的 flex 拉伸：旧节点高度会被写进中间容器的
        // flex-basis/min-block-size，单清 height 仍会把离屏副本撑到旧高度。
        el.style.setProperty("flex", "none", "important");
        el.style.setProperty("block-size", "auto", "important");
        el.style.setProperty("min-block-size", "0", "important");
      }
    }

    parent.appendChild(clone);
    // 读取 layout 属性会同步触发布局。scrollHeight 包含完整溢出内容和容器 padding；
    // 整卡 clone 的 scrollHeight 同时包含 content 外部的真实 chrome，不再靠 20/40px 猜测。
    const contentHeight = Math.max(Number(cloneContent.scrollHeight) || 0,
      Number(cloneContent.offsetHeight) || 0);
    const cloneHeight = Math.max(Number(clone.scrollHeight) || 0, Number(clone.offsetHeight) || 0);
    // The live outer/content difference can be hundreds of pixels of empty
    // space, not chrome. Only the unconstrained clone describes natural height.
    // Actual overflow is checked after applying the new size by the fit caller.
    const natural = Math.max(cloneHeight, contentHeight);
    // 仅保留 4px 给小数像素取整/边框抗锯齿，不再按内容类型叠加大块经验余量。
    return natural > 0 ? Math.max(60, Math.min(4000, Math.ceil(natural + 4))) : 0;
  } catch (_) {
    return 0;
  } finally {
    try { if (clone && clone.parentElement) clone.parentElement.removeChild(clone); } catch (_) {}
  }
}
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
/* v0.16.6 P1-4：note 类型白名单的**历史默认值**。
 *   背景：NOTE_CALLOUT_RE 的捕获组是 [^\]]+，匹配**任意** callout 类型 —— 旧版
 *   lmbSplitNote 只排除 lmb-comment / lmb-view，于是用户自己写的 [!warning]、[!quote]、
 *   [!tip] 全被当成「补充描述」，后果是 lmbStripNote 把它们**整段删掉**、lmbJoinNote
 *   把类型改写成 noteCalloutType 并覆盖原文（真实内容丢失）。
 *   修法：只认插件自有的 note 类型 = 历史默认 ppd-note + 用户当前配置的
 *   settings.noteCalloutType（由调用方通过 lmbSplitNote 第二参传入）。
 *   注意：白名单是「识别」范围，不是「渲染」范围 —— 用户自有 callout 现在原样留在 body 里。 */
const LMB_NOTE_TYPE_DEFAULT = "ppd-note";
/* ==================== v0.11.0：独立评论体系（lmb-comment） ====================
 * 与「补充描述」（ppd-note）并存的第二套数据，仿 PDF Flow 的批注评论底栏：
 *   空：> [!lmb-comment]- 添加评论     ← 折叠单行，渲染成底栏按钮
 *   有：> [!lmb-comment] 评论          ← 展开显示内容
 * 位置：永远在卡片文本最末（补充描述 callout 之后），渲染成卡片底栏。
 * lmb-comment 是保留类型字面量（不做成设置项），解析器按字面量识别。 */
const LMB_COMMENT_TYPE = "lmb-comment";
const LMB_COMMENT_EMPTY_TITLE = "添加评论";
const LMB_COMMENT_CALLOUT_RE = /^\s*>\s*\[!lmb-comment\]\s*([+-]?)\s*(.*)$/;
/* ==================== v0.11.3：双重摘录（文字+截图）卡片视图切换 ====================
 * 双重摘录卡 = 引用块（文字）+ 截图 embed 同时在卡里，卡上挂一个 lmb-view callout
 * 作为「切换按钮」：点击在 文字视图 / 图片视图 之间切换（CSS 显隐，宽度不变）。
 * 默认 = 文字视图（有文字则以文字摘录为主）。
 * lmb-view 是 UI 开关不是内容，摘录 md 同步时会剥掉这一行。 */
const LMB_VIEW_TYPE = "lmb-view";
const LMB_VIEW_TITLE_TEXT = "📄 文字 · 点击切换";
const LMB_VIEW_TITLE_IMG = "🖼 图片 · 点击切换";
const LMB_VIEW_CALLOUT_RE = /^\s*>\s*\[!lmb-view\]\s*([+-]?)\s*(.*)$/;

/* ============================================================
 * 11-styles —— 全部注入式 CSS（v0.12.1 从 30-plugin-core.js 的 injectStyles() 抽出）
 * 修改注意：
 *   1. 本文件是**纯字符串数组**，不含任何逻辑；injectStyles() 只做 LMB_STYLES.join("")。
 *      拼接后就是一整段 CSS，元素顺序 == 注入顺序 == 层叠顺序，别随意搬家。
 *   2. 大量片段是「一条 CSS 规则被拆成多个数组元素」的产物（原样搬运，没有合并）。
 *      改某一条规则时必须把上下相邻的几个元素一起看，只改一半会留下不配对的花括号，
 *      从而吃掉后面所有规则。
 *   3. 带反斜杠转义的片段（如 "\\1F50D"）必须保持转义原样，少一个反斜杠就变成乱码字符。
 *   4. 分组注释（// ===== xxx =====）保留且顺序不变，它是人肉索引，也是版本演进记录。
 *   5. per-view-type 的适配统一放本文件末尾的「per-view-type 适配层」，加新视图类型
 *      只加一段 CSS，不改 JS（借鉴 editing-toolbar v4.1.1 的经验）。
 *   6. 只有 CSS 能定的东西放这里；任何需要 JS 新增 / 移除 class 才生效的规则都不要写进来。
 * ============================================================ */

const LMB_STYLES = [
  ".lmb-chip{position:fixed;z-index:1000;",
  "background:var(--interactive-accent,#7c6cf0);color:var(--text-on-accent,#fff);",
  "font-size:12px;padding:5px 7px 5px 12px;border-radius:16px;cursor:grab;display:flex;align-items:center;gap:8px;",
  "box-shadow:0 4px 14px rgba(0,0,0,.5);user-select:none;white-space:nowrap;}",
  ".lmb-chip:active{cursor:grabbing}",
  ".lmb-chip-action{border:0;border-radius:9px;width:27px;height:27px;padding:5px;background:rgba(255,255,255,.16);color:inherit;cursor:pointer;display:grid;place-items:center;}",
  ".lmb-chip-action:hover{background:rgba(255,255,255,.34)}",
  "body.lmb-mobile .lmb-chip{max-width:calc(100vw - 20px);white-space:normal;font-size:13px;padding:7px 8px 7px 12px;gap:6px;}",
  "body.lmb-mobile .lmb-chip-action{width:40px;height:40px;min-width:40px;border-radius:12px;touch-action:manipulation;}",
  "body.lmb-mobile.lmb-rect-mode .pdf-viewer-container,body.lmb-mobile.lmb-rect-mode .page{touch-action:none!important;}",
  "body.lmb-mobile .lmb-pdf-sidebar-host{padding-right:var(--lmb-pdf-sidebar-width,340px)!important;}",
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
  '.lmb-mark.lmb-mark-image{border:2px dashed currentColor;outline:1px solid rgba(255,255,255,.5);outline-offset:-4px;mix-blend-mode:normal;background:transparent!important;}',
  '.lmb-color-palette{position:fixed;z-index:10001;display:flex!important;flex-flow:row nowrap!important;align-items:center!important;gap:6px;padding:7px;border:1px solid var(--background-modifier-border);border-radius:12px;background:var(--background-primary);box-shadow:0 5px 18px rgba(0,0,0,.32);}',
  '.lmb-color-palette button{appearance:none!important;display:block!important;flex:0 0 26px!important;width:26px!important;min-width:26px!important;max-width:26px!important;height:26px!important;min-height:26px!important;max-height:26px!important;padding:0!important;margin:0!important;border:2px solid rgba(255,255,255,.72)!important;border-radius:50%!important;line-height:0!important;cursor:pointer;box-shadow:0 0 0 1px rgba(0,0,0,.18);}.lmb-color-palette button:hover{transform:scale(1.08);}',
  '.lmb-mark[data-no]::after{content:attr(data-no);position:absolute;left:-9px;top:-9px;',
  'min-width:18px;height:18px;padding:0 3px;border-radius:9px;background:var(--interactive-accent);',
  'color:var(--text-on-accent);font:700 11px/18px sans-serif;text-align:center;mix-blend-mode:normal;box-sizing:border-box;}',
  '.lmb-focus-mode .lmb-mark{opacity:.12;transition:opacity .18s ease;}',
  '.lmb-focus-mode .lmb-flash{opacity:1!important;z-index:30;}',
  '.callout[data-callout="lmb-excerpt"]{--callout-color:91,155,213;border-left-width:3px;',
  'background:color-mix(in srgb,var(--background-secondary) 92%,rgb(var(--callout-color)));margin:12px 0;}',
  '.callout[data-callout="lmb-excerpt"]>.callout-title{font-size:12px;letter-spacing:.02em;color:var(--text-muted);}',
  '.callout[data-callout="lmb-excerpt"]>.callout-content{padding-top:6px!important;padding-bottom:6px!important;}',
  // 只隐藏稳定 ID 本身，不能隐藏它所在的整个 p。直接写入摘录文档的条目会把
  // ID、PDF 链接、原文和截图渲染进同一个段落；隐藏父段落会让整条摘录看似为空。
  '.callout[data-callout="lmb-excerpt"]>.callout-content>p:empty,.callout[data-callout="lmb-excerpt"]>.callout-content>blockquote:empty{display:none!important;}',
  '.callout[data-callout="lmb-excerpt"]>.callout-content>blockquote{margin-top:4px!important;margin-bottom:6px!important;}',
  '.callout[data-callout="lmb-excerpt"]>.callout-content>p{margin-top:6px;margin-bottom:6px;}',
  '.lmb-excerpt-note-action{display:flex;justify-content:flex-end;gap:12px;border-top:1px solid var(--background-modifier-border);margin-top:10px;padding-top:8px;}',
  '.lmb-excerpt-note-action button{font-size:12px;color:var(--text-accent);background:transparent;border:0;cursor:pointer;}',
  '.lmb-excerpt-note-action .lmb-excerpt-view-toggle{margin-right:auto;}',
  '.lmb-md-dual-excerpt:not(.lmb-show-image) .lmb-excerpt-image-view{display:none!important;}',
  '.lmb-md-dual-excerpt.lmb-show-image .lmb-excerpt-text-view{display:none!important;}',
  '.lmb-md-dual-excerpt.lmb-show-image .lmb-excerpt-image-view{display:block!important;}',
  '.lmb-excerpt-note-live{margin-top:6px;padding:10px 12px;border-left:4px solid rgb(112,196,157);border-radius:7px;background:var(--background-secondary);}',
  '.lmb-excerpt-note-live-title{font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:6px;}',
  '.lmb-excerpt-note-live-body>:first-child{margin-top:0;}.lmb-excerpt-note-live-body>:last-child{margin-bottom:0;}',
  '.lmb-excerpt-id{display:none!important;}',
  '.modal:has(.lmb-note-editor){width:min(900px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:hidden;}.modal:has(.lmb-note-editor) .modal-content{display:flex;flex-direction:column;min-height:0;max-width:none;overflow:hidden;}',
  '.lmb-note-editor{width:100%;max-width:none;box-sizing:border-box;min-width:0;}.lmb-note-editor-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;height:min(420px,calc(100vh - 240px));min-height:240px;}',
  '.lmb-note-editor-input,.lmb-note-editor-preview{min-width:0;min-height:0;height:100%;box-sizing:border-box;padding:12px;border:1px solid var(--background-modifier-border);border-radius:8px;background:var(--background-primary);color:var(--text-normal);overflow:auto;}',
  '.lmb-note-editor-input{resize:vertical;font:14px/1.6 var(--font-text);}.lmb-note-preview-empty{color:var(--text-faint);}',
  '.lmb-note-editor-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;}',
  '@media(max-width:700px){.modal:has(.lmb-note-editor){max-height:calc(100vh - 16px);}.lmb-note-editor-grid{grid-template-columns:1fr;height:auto;min-height:0;}.lmb-note-editor-input,.lmb-note-editor-preview{height:190px;}.lmb-note-editor-actions{flex-wrap:wrap;}}',
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
  // v0.12.0：图标改冒泡 message-square（用户要求与原 ppd-note 的 💬 视觉一致，
  //          替换 Obsidian 给未知 callout 的默认铅笔 ✎）；
  //          padding/margin 压紧（用户要求排布更紧凑）
  '.callout[data-callout="lmb-comment"]{--callout-icon:message-square;',
  "background:var(--background-secondary,transparent);",
  "border:none !important;border-top:1px solid var(--background-modifier-border) !important;",
  "border-radius:0 !important;box-shadow:none !important;padding:4px 8px !important;margin-top:2px;}",
  '.callout[data-callout="lmb-comment"] .callout-title{gap:6px;}',
  '.callout[data-callout="lmb-comment"] .callout-title-inner{color:var(--text-muted);font-weight:400;font-size:12.5px;}',
  // v0.21.5：Canvas 评论与 Markdown 摘录笔记统一视觉语言。只改渲染，不改评论数据，
  // 已有卡片无需迁移；仍可点击整个评论框打开原来的编辑窗口。
  '.canvas-node .callout[data-callout="lmb-comment"]{--callout-icon:pencil;',
  'margin:10px 8px 4px!important;padding:8px 10px!important;border:0!important;',
  'border-left:4px solid rgb(112,196,157)!important;border-radius:7px!important;',
  'background:var(--background-secondary)!important;box-shadow:none!important;}',
  '.canvas-node .callout[data-callout="lmb-comment"] .callout-title{display:none!important;}',
  '.canvas-node .callout[data-callout="lmb-comment"] .callout-content{padding-top:0;}',
  '.canvas-node .callout[data-callout="lmb-comment"] .callout-content>:first-child{margin-top:0;}',
  '.canvas-node .callout[data-callout="lmb-comment"] .callout-content>:last-child{margin-bottom:0;}',
  '.canvas-node .callout[data-callout="lmb-excerpt"]{margin-top:4px!important;margin-bottom:4px!important;}',
  '.canvas-node .callout[data-callout="lmb-excerpt"]>.callout-content{padding-top:2px!important;padding-bottom:2px!important;}',
  '.canvas-node .callout[data-callout="lmb-comment"]{margin-top:6px!important;}',
  '.callout[data-callout="lmb-comment"] .callout-icon{color:var(--text-faint);}',
  // 折叠箭头推到最右（PDF Flow 的「›」位置）；lmb-comment-clickable 供 JS/测试识别
  '.callout[data-callout="lmb-comment"] .callout-fold{margin-left:auto;}',
  // ===== v0.11.2：PDF 工具栏收紧 + 框选按钮 =====
  // 用户反馈顶部工具栏元素间距过大：把原生 .pdf-toolbar 的 gap / 按钮边距压紧
  // （只作用于完整 PDF 视图，不动 md 里的 .pdf-embed 迷你工具栏）
  '.workspace-leaf-content[data-type="pdf"] .pdf-toolbar{gap:2px !important;',
  "padding:2px 8px !important;}",
  '.workspace-leaf-content[data-type="pdf"] .pdf-toolbar .clickable-icon{',
  "margin:0 1px !important;padding:3px 5px !important;}",
  '.workspace-leaf-content[data-type="pdf"] .pdf-toolbar .lmb-toolbar-group{display:flex;align-items:center;',
  'justify-content:flex-end;gap:1px;margin-left:auto!important;padding:0!important;flex:0 0 auto;}',
  '.lmb-toolbar-ink.is-active{color:var(--text-on-accent)!important;background:var(--interactive-accent)!important;}',
  '.lmb-ink-layer,.lmb-ink-live-layer{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;z-index:50!important;display:block;pointer-events:none!important;}',
  '.lmb-ink-live-layer{z-index:51!important;}body.lmb-ink-capture .lmb-ink-live-layer{z-index:80!important;}body.lmb-ink-capture .lmb-pdf-text-block.is-editing{z-index:85;}',
  '.lmb-ink-selection-actions{display:flex;align-items:center;flex-wrap:wrap;gap:5px;width:100%;padding:4px 2px 0;border-top:1px solid var(--background-modifier-border);}.lmb-ink-selection-actions>span{font-size:11px;color:var(--text-muted);}.lmb-ink-tools button.lmb-ink-link-action{width:auto;flex:0 0 auto;min-width:90px;gap:5px;padding:4px 8px;font-size:12px;}.lmb-ink-tools.is-collapsed .lmb-ink-selection-actions{display:none;}',
  '.lmb-ink-reference{display:flex;flex-direction:column;gap:5px;min-width:0;}.lmb-ink-ref-caption{font-size:11px;color:var(--text-muted);}.lmb-ink-ref-preview{display:block!important;width:100%;height:auto!important;min-height:44px;max-height:180px;padding:8px!important;background:#fff!important;border:1px solid var(--background-modifier-border)!important;border-radius:6px;cursor:pointer;overflow:hidden;}.lmb-ink-ref-preview svg{display:block;width:100%;height:110px;max-height:160px;pointer-events:none;}.lmb-ink-ref-preview:hover,.lmb-ink-ref-preview:focus-visible{outline:2px solid var(--interactive-accent);outline-offset:-2px;}.lmb-ink-ref-edit{align-self:flex-end;font-size:11px;min-height:30px;}.lmb-ink-sidebar-reference{margin:4px 0 8px;}.lmb-ink-location{position:absolute;z-index:90;pointer-events:none;outline:2px solid var(--interactive-accent,#70bd94);outline-offset:5px;background:#70bd9414;font-size:0;}.lmb-ink-location::before{content:attr(data-lmb-ink-label);position:absolute;left:-6px;bottom:calc(100% + 7px);font:600 11px/1.5 sans-serif;color:var(--text-on-accent,#fff);background:var(--interactive-accent,#43875d);padding:1px 6px;border-radius:4px;white-space:nowrap;}.lmb-ink-link-badge{font-size:11px;white-space:nowrap;border:1px solid var(--interactive-accent);border-radius:4px;padding:1px 5px;color:var(--text-accent);}.lmb-ink-ref-actions{display:flex;flex-wrap:wrap;gap:6px;}.lmb-ink-ref-actions button{height:30px;min-height:30px;font-size:12px;border:1px solid var(--background-modifier-border);}.lmb-ink-ref-actions button:hover{border-color:var(--interactive-accent);background:var(--background-modifier-hover);}.lmb-ink-ref-back{font-weight:600;}body.lmb-mobile .lmb-ink-ref-actions button{min-height:40px;}@keyframes lmb-ink-pulse{50%{opacity:.25;}}.lmb-ink-create-status{color:var(--text-error);font-size:12px;}body.lmb-mobile .lmb-ink-ref-edit{min-height:40px;}',
  'body.lmb-ink-mode.lmb-ink-capture .lmb-ink-live-layer{pointer-events:auto!important;touch-action:none!important;-webkit-touch-callout:none!important;}',
  'body.lmb-ink-mode .workspace-leaf-content[data-type="pdf"] .page{cursor:crosshair;}',
  'body.lmb-ink-mode.lmb-ink-capture .workspace-leaf-content[data-type="pdf"] .page{touch-action:none!important;overscroll-behavior:contain;-webkit-touch-callout:none!important;}',
  '.workspace-leaf-content[data-type="pdf"]{position:relative;}',
  '.lmb-ink-tools{position:absolute;z-index:1000;top:44px;left:12px;right:calc(var(--lmb-pdf-sidebar-width,0px) + 12px);box-sizing:border-box;display:flex;align-items:flex-start;gap:4px;max-width:none;padding:6px;border:1px solid var(--background-modifier-border);border-radius:11px;background:color-mix(in srgb,var(--background-primary) 94%,transparent);backdrop-filter:blur(8px);box-shadow:var(--shadow-s,0 4px 16px rgba(0,0,0,.25));overflow:hidden;}',
  '.lmb-pdf-sidebar-host.lmb-pdf-sidebar-closed>.lmb-ink-tools{right:12px;}.lmb-ink-tools-content{display:flex;align-items:center;justify-content:flex-end;gap:4px;min-width:0;width:100%;}.lmb-ink-tools.is-collapsed{left:auto;}.lmb-ink-tools.is-collapsed .lmb-ink-tools-content{display:none;}',
  '.lmb-ink-tool-buttons,.lmb-ink-actions,.lmb-ink-swatches{display:flex;align-items:center;gap:3px;flex:0 0 auto;}.lmb-ink-tools button{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:30px;width:30px;height:30px;flex:0 0 30px;border:0;border-radius:7px;background:transparent;color:var(--text-muted);padding:5px;cursor:pointer;line-height:1;}.lmb-ink-tools button svg{display:block;width:17px;height:17px;stroke:currentColor;}.lmb-ink-tools button:hover{background:var(--background-modifier-hover);}.lmb-ink-tools button.is-active{background:var(--interactive-accent);color:var(--text-on-accent);}',
  '.lmb-ink-tools .lmb-ink-collapse{min-width:24px;width:24px;height:30px;flex:0 0 24px;padding:4px;}.lmb-ink-swatches{padding:0 2px;}.lmb-ink-tools .lmb-ink-swatch{min-width:18px;width:18px;height:18px;flex:0 0 18px;padding:0;border:2px solid var(--background-primary);box-shadow:0 0 0 1px var(--background-modifier-border);border-radius:50%;}.lmb-ink-tools .lmb-ink-swatch.is-active{box-shadow:0 0 0 2px var(--interactive-accent);}',
  '.lmb-ink-color-picker{position:relative;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:34px;height:30px;flex:0 0 34px;border-radius:7px;color:var(--text-muted);overflow:hidden;cursor:pointer;}.lmb-ink-color-picker:hover{background:var(--background-modifier-hover);}.lmb-ink-color-icon svg{display:block;width:17px;height:17px;}.lmb-ink-color-preview{position:absolute;right:3px;bottom:3px;width:9px;height:9px;border:1px solid var(--background-primary);border-radius:50%;}.lmb-ink-color-input{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important;opacity:0!important;cursor:pointer!important;}',
  '.lmb-ink-width-control{display:flex;align-items:center;gap:3px;height:30px;min-width:94px;flex:0 1 112px;padding:0 4px;border-radius:7px;color:var(--text-muted);}.lmb-ink-width-icon svg{display:block;width:14px;height:14px;}.lmb-ink-tools input[type="range"]{-webkit-appearance:none;appearance:none;width:72px;min-width:48px;height:24px;margin:0;padding:0;background:transparent;cursor:pointer;}.lmb-ink-tools input[type="range"]::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:var(--background-modifier-border);}.lmb-ink-tools input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:-6px;border:2px solid var(--background-primary);border-radius:50%;background:var(--interactive-accent);box-shadow:0 0 0 1px var(--background-modifier-border);}.lmb-ink-width-value{min-width:16px;font-size:10px;text-align:right;color:var(--text-faint);}.lmb-ink-save-status{min-width:42px;color:var(--text-faint);font-size:10px;white-space:nowrap;}.lmb-ink-save-status[data-state="error"]{color:var(--text-error);}',
  'body.lmb-mobile .lmb-ink-tools{top:48px;left:6px;right:calc(var(--lmb-pdf-sidebar-width,0px) + 6px);padding:5px;gap:3px;border-radius:10px;}body.lmb-mobile .lmb-pdf-sidebar-host.lmb-pdf-sidebar-closed>.lmb-ink-tools{right:6px;}body.lmb-mobile .lmb-ink-tools-content{justify-content:flex-start;flex-wrap:wrap;row-gap:4px;}body.lmb-mobile .lmb-ink-tools button{min-width:36px;width:36px;height:36px;flex-basis:36px;padding:7px;}body.lmb-mobile .lmb-ink-tools button svg{width:19px;height:19px;}body.lmb-mobile .lmb-ink-tools .lmb-ink-collapse{min-width:32px;width:32px;height:36px;flex-basis:32px;}body.lmb-mobile .lmb-ink-color-picker{width:36px;height:36px;flex-basis:36px;}body.lmb-mobile .lmb-ink-width-control{height:36px;flex-basis:106px;}body.lmb-mobile .lmb-ink-save-status{display:none;}',
  '@media(max-width:700px){body.lmb-mobile .lmb-ink-tools{right:6px;}body.lmb-mobile .lmb-pdf-sidebar-host:not(.lmb-pdf-sidebar-closed)>.lmb-ink-tools{right:calc(min(46vw,320px) + 6px);}}',
  '.lmb-ink-tools{flex-wrap:wrap;padding:4px;gap:2px;align-items:center;}.lmb-ink-tools-content{flex:1;justify-content:flex-start;overflow-x:auto;flex-wrap:nowrap!important;scrollbar-width:thin;}.lmb-ink-tools button{border:1px solid var(--background-modifier-border);transition:background .12s,box-shadow .12s;}.lmb-ink-tools button:active{box-shadow:inset 0 1px 4px #0004;}.lmb-ink-tools button:focus-visible{outline:2px solid var(--interactive-accent);outline-offset:-2px;}.lmb-ink-advanced{display:flex;align-items:center;flex-wrap:wrap;gap:4px;width:100%;padding:4px 2px 0;border-top:1px solid var(--background-modifier-border);}.lmb-ink-advanced[hidden],.lmb-ink-tools.is-collapsed .lmb-ink-advanced{display:none;}.lmb-ink-eraser-mode{height:30px;max-width:120px;}.lmb-ink-auto-return{display:flex;align-items:center;gap:4px;white-space:nowrap;font-size:12px;min-height:30px;}.lmb-ink-auto-return input{margin:0;}.lmb-ink-save-status{margin-left:auto;}.lmb-ink-tools .lmb-ink-swatch{width:28px;height:30px;min-width:28px;flex-basis:28px;padding:5px;border:3px solid transparent;border-radius:7px;background-clip:content-box;box-shadow:none;}.lmb-ink-tools .lmb-ink-swatch.is-active{border-color:var(--interactive-accent);box-shadow:none;}',
  '@media(pointer:coarse){.lmb-ink-tools button,body.lmb-mobile .lmb-ink-tools button{width:40px;height:40px;min-width:40px;flex-basis:40px;padding:8px;}.lmb-ink-advanced select,.lmb-ink-auto-return{min-height:40px;}.lmb-ink-tools .lmb-ink-collapse{min-height:40px;}.lmb-ink-tools .lmb-ink-swatch{padding:8px;}}',
  '.lmb-ink-text-editor{position:absolute;z-index:60;min-width:130px;min-height:44px;resize:both;padding:5px 7px;border:1px solid var(--interactive-accent);border-radius:4px;background:var(--background-primary);font:16px/1.35 var(--font-text);box-shadow:var(--shadow-s,0 2px 8px rgba(0,0,0,.18));}',
  '.workspace-leaf-content[data-type="pdf"] .lmb-toolbar-group .clickable-icon{margin:0!important;',
  'padding:3px!important;width:28px!important;height:28px!important;min-width:28px!important;max-width:28px!important;display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px!important;}',
  '.workspace-leaf-content[data-type="pdf"] .lmb-toolbar-group svg{display:block!important;width:17px!important;height:17px!important;min-width:17px!important;max-width:17px!important;stroke:currentColor!important;flex:0 0 17px!important;}',
  // 注入的框选按钮：激活态高亮（与 ribbon is-active 同一套主题色语义）
  ".lmb-toolbar-crop.is-active{color:var(--text-on-accent)!important;",
  "background:var(--interactive-accent)!important;}",
  '.lmb-toolbar-sidebar.is-active{color:var(--text-on-accent)!important;background:var(--interactive-accent)!important;}',
  // 框选模式开启时，PDF 页面光标换十字，给「正在框选」的即时视觉反馈
  'body.lmb-rect-mode .workspace-leaf-content[data-type="pdf"] .page{cursor:crosshair !important;}',
  // ===== v0.11.3：双重摘录卡（文字+截图）视图切换 =====
  // v0.12.0：切换按钮图标化——文字视图=文档图标 / 图片视图=图片图标（CSS 变量随
  //   host 的 lmb-view-img 切换），标题文字/折叠箭头整个隐藏；
  //   float:right 让它与下方的评论栏共享同一行（用户要求「小工具同一行」），
  //   容器 ::after 清浮动防止图标条溢出卡片底边。
  '.callout[data-callout="lmb-view"]{--callout-icon:file-text;',
  "background:var(--background-secondary,transparent);",
  "border:none !important;border-radius:0 !important;box-shadow:none !important;",
  "float:right;margin:0 0 2px 8px;padding:2px 6px !important;cursor:pointer;}",
  '.lmb-view-img .callout[data-callout="lmb-view"]{--callout-icon:image;}',
  '.callout[data-callout="lmb-view"] .callout-title{gap:4px;}',
  '.callout[data-callout="lmb-view"] .callout-title-inner{display:none;}',
  '.callout[data-callout="lmb-view"] .callout-fold{display:none;}',
  '.callout[data-callout="lmb-view"] .callout-icon{color:var(--text-faint);}',
  '.canvas-node-content:has(.callout[data-callout="lmb-view"])::after,',
  '.markdown-rendered:has(.callout[data-callout="lmb-view"])::after{',
  'content:"";display:block;clear:both;}',
  // 双重卡默认 = 文字视图：藏截图 embed。
  //   v0.16.1 判据再改版：**判定权完全收回 JS**（37-plugin-canvasbar.js lmbMarkDualCards）。
  //   历史：v0.11.3~v0.15.0 靠卡里那行 `> [!lmb-view]` callout 当判据 → 有效；
  //   v0.16.0 换成 `:has(a[href*=".pdf#page="]):has(img)` → **实测不命中**（用户 Bug5：
  //   双重卡文字视图下图文并存）。根因：canvas 里指向 .pdf 的 internal-link 是**非 md 文件**，
  //   Obsidian 渲染时很可能丢弃 #page= 子路径（href/data-href 只剩 "xxx.pdf"）→
  //   属性选择器匹配不上。猜 DOM 结构不如不让 CSS 猜。
  //   现行方案：JS 用 lmbPickBarActions().view（markdown 层：pdf 引用行 + 截图 embed）
  //   判双重卡，把 lmb-dual 打在 **nodeEl** 上（contentEl 会被 markdown 重渲染重建，
  //   class 会丢；nodeEl 生命周期 = 节点生命周期，稳定）。
  //   同源的好处：JS 给「视图」按钮的判据 = CSS 藏图的判据 → 藏了就一定有按钮能切回来。
  //   切到图片视图时 host（.canvas-node-content）带 lmb-view-img → :not() 不命中 → 图片显示。
  '.lmb-dual .canvas-node-content:not(.lmb-view-img) img,',
  '.lmb-dual .markdown-rendered:not(.lmb-view-img) img{display:none;}',
  // md 阅读视图**保持旧判据**（只认 lmb-view callout），刻意不同步改版：
  //   摘录 md 同步时会剥掉 lmb-view 行（v0.11.3 起），所以这条在摘录文档里本来就不命中
  //   → 摘录 md 里的截图正常显示（图文并存，这是设计）。
  //   若这里也换成「pdf 链接 + img」判据，摘录 md 的每条摘录都有 pdf 回跳链接，
  //   只要文里出现任何图片就会被整篇藏掉 —— 那是明显的回归，不能这么改。
  '.markdown-rendered:has(.callout[data-callout="lmb-view"]) img{display:none;}',
  // 图片视图：显示截图、藏文字引用块（藏的是裸 blockquote，不动 ppd-note/lmb-comment 等 callout）
  '.lmb-view-img img{display:block !important;}',
  '.lmb-view-img blockquote:not(.callout){display:none;}',

  /* ==================== v0.12.1 新增：per-view-type 适配层 ====================
   * 设计意图（借鉴 editing-toolbar v4.1.1）：把「按视图类型做适配」从 JS 挪到 CSS。
   *   以前每多支持一种视图类型，就要在注入逻辑里加一层 if 判断；现在加新视图只需要在
   *   本区块追加一条 CSS 规则，逻辑层零改动。
   *
   * 三条硬约束（改动前先确认自己没违反）：
   *   1. 只用**已经存在的** class，不引入任何需要 JS 配合的新 class —— 改 JS 的
   *      那边不知道这里加了什么，两边会脱节。
   *   2. 只做显隐 / 光标 / 过渡这类「不影响现有外观」的覆写，不改颜色、尺寸、间距。
   *   3. 顺序上放在数组**最末尾**，保证它是最后注入的、能覆盖前面的同名属性。
   *
   * 放最后还有一个副作用是好事：万一某条写错了，只会影响最末几条规则，
   *   不会像花括号不配对那样吃掉上面 59 条搬运规则。
   * ===================================================================== */

  // ---- 1. PDF 嵌入视图（md 里内嵌的迷你 PDF）里不显示注入的按钮 ----
  // 理由：.pdf-embed 的迷你工具栏空间极小，多一个按钮就会被撑破、把原生控件挤出去。
  //   JS 侧本来就只在完整 PDF 视图注入，这里再兜一道保险：万一将来注入逻辑变动
  //   （比如缓存命中后按钮被挂到了错误的宿主），至少视觉上不会炸。
  '.pdf-embed .lmb-toolbar-crop,',
  '.pdf-embed .lmb-toolbar-md,',
  '.pdf-embed .lmb-toolbar-canvas,',
  '.pdf-embed .lmb-toolbar-sidebar{display:none !important;}',

  // ---- 2. 非 PDF 视图里不显示注入的按钮 ----
  // 理由：用 :not() 白名单式限定，而不是黑名单式排除 —— 默认「任何非 PDF 的 leaf 都隐藏」，
  //   这样即使 JS 因为兜底逻辑把按钮挂到 .view-content 等别的容器，视觉上也不会串台。
  //   （这条是对并行改动 30-plugin-core.js 的防御：那边正在调整注入宿主的选择策略。）
  '.workspace-leaf-content:not([data-type="pdf"]) .lmb-toolbar-crop,',
  '.workspace-leaf-content:not([data-type="pdf"]) .lmb-toolbar-md,',
  '.workspace-leaf-content:not([data-type="pdf"]) .lmb-toolbar-canvas,',
  '.workspace-leaf-content:not([data-type="pdf"]) .lmb-toolbar-sidebar{display:none !important;}',

  // ---- 3. 三个注入按钮的通用视觉基线 ----
  // 理由：给后续所有 per-view-type 覆写提供一个稳定的基类（cursor + opacity 过渡），
  //   将来针对某视图做 hover / 显隐动画时，从这个基线继承即可，不用每个视图重抄一遍。
  //   刻意**只加不影响现有外观的属性**：cursor 是交互语义、transition 只声明过渡曲线，
  //   不指定初始 opacity，所以当前渲染结果与加这条之前完全一致。
  ".lmb-toolbar-crop,.lmb-toolbar-md,.lmb-toolbar-canvas,.lmb-toolbar-sidebar{cursor:pointer;transition:opacity .15s ease;}",

  // ===== v0.13.0 / v0.13.2：canvas 卡片悬浮操作栏（.lmb-canvas-bar）=====
  // 定位逻辑全在 JS（lmbCalcBarPos 每轮写内联 left/top），CSS 只管呈现，别在这儿改定位。
  //   1. 浮层挂在 .canvas-wrapper（canvas.wrapperEl）而非卡片上 —— canvas 的
  //      transform:scale() 加在 .canvas 上，wrapper 是其父级、不参与缩放，
  //      所以按钮在屏幕上恒定 26px，不会随画布缩小而缩小到看不清。
  //   2. 显隐由 lmbSetToolbarVisibility() 控制：show 是 visibility:visible + display:""
  //      hideRemove 是 display:none。所以下面 display 必须写成 flex（display:"" 的回落值）。
  //      【绝不能写 display:none】——否则 show 时 display:"" 会回落到 none，浮层永远出不来。
  //      默认 visibility:hidden 只是防首帧闪现（JS 第一次 tick 才会 show）。
  //   3. v0.13.2：改竖排（flex-direction:column）+ z-index:9999 防御被 canvas 节点遮挡。
  //      按钮尺寸 26px 方形保持不变，只换排列方向和图标尺寸（14px）。
  '.lmb-canvas-bar{position:absolute;display:flex;flex-direction:column;visibility:hidden;z-index:9999;align-items:stretch;gap:2px;padding:2px;border-radius:8px;background:var(--background-primary);border:1px solid var(--background-modifier-border);box-shadow:var(--shadow-s,0 2px 8px rgba(0,0,0,.15));}',

  // v0.14.8：4 个按钮统一带两个字文字（"评论"/"跳转"/"视图"/"高度"），width:auto 横排对齐。
  //   刻意不用 Obsidian 的 .clickable-icon —— 那是给固定工具栏设计的，尺寸边距在浮层上偏大。
  '.lmb-canvas-bar .lmb-bar-comment,',
  '.lmb-canvas-bar .lmb-bar-jump,',
  '.lmb-canvas-bar .lmb-bar-view,',
  '.lmb-canvas-bar .lmb-bar-color,',
  '.lmb-canvas-bar .lmb-bar-fit,',
  '.lmb-canvas-bar .lmb-bar-follow,',
  '.lmb-canvas-bar .lmb-bar-disconnect{display:inline-flex;align-items:center;justify-content:center;gap:4px;width:auto;height:26px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--text-muted);cursor:pointer;transition:background .12s ease,color .12s ease;}',
  '.lmb-canvas-bar .lmb-bar-text{font-size:11px;line-height:1;letter-spacing:0.5px;font-weight:500;}',
  '.lmb-canvas-bar .lmb-bar-comment:hover,',
  '.lmb-canvas-bar .lmb-bar-jump:hover,',
  '.lmb-canvas-bar .lmb-bar-view:hover,',
  '.lmb-canvas-bar .lmb-bar-color:hover,',
  '.lmb-canvas-bar .lmb-bar-fit:hover,',
  '.lmb-canvas-bar .lmb-bar-follow:hover,',
  '.lmb-canvas-bar .lmb-bar-disconnect:hover{background:var(--background-modifier-hover);color:var(--text-normal);}',
  '.lmb-canvas-bar .lmb-bar-follow.is-active{background:var(--interactive-accent);color:var(--text-on-accent);}',

  '.lmb-disconnect-candidate{cursor:pointer!important;filter:drop-shadow(0 0 3px var(--interactive-accent));}',
  '.lmb-disconnect-candidate path{stroke:var(--interactive-accent)!important;stroke-width:6px!important;pointer-events:stroke!important;cursor:pointer!important;}',

  // setIcon 注入的 svg 默认会撑成 100% 把按钮顶变形，这里统一尺寸
  '.lmb-canvas-bar svg{width:14px!important;height:14px!important;min-width:14px!important;max-width:14px!important;display:block!important;flex:0 0 14px!important;}',
  'body.lmb-mobile .lmb-canvas-bar{display:grid!important;grid-template-columns:repeat(4,max-content);align-items:center!important;gap:3px;padding:4px;max-width:calc(100% - 8px);}',
  'body.lmb-mobile .lmb-canvas-bar>div{height:34px!important;min-height:34px!important;padding:0 9px!important;white-space:nowrap;touch-action:manipulation;}',

  // 不适用的按钮由 JS 走 hideRemove（display:none），这里不给额外样式，避免和 JS 打架

  // ---- 4. v0.13.2：canvas 卡片只露摘录内容，折叠态评论按钮与 lmb-view 全藏 ----
  // 理由（v0.13.1 反思）：上一版用 `.callout[data-callout="lmb-comment"]` 选了所有
  //   评论 callout，结果**展开态的评论内容**也被藏了 —— 用户加完评论在卡片里看不到，
  //   只能进编辑界面。这是 bug，不是有意设计。
  // 修正：v0.13.2 只藏**折叠态**（按钮形态）。判断标准 = 没有 .callout-content 子元素
  //   （折叠态不会渲染 content 容器）。展开态（评论内容）正常显示。
  //   :has() 是 CSS 4 现代选择器，Obsidian 自带 Chromium 完整支持。
  //   lmb-view callout 是切换按钮（无论折叠/展开内容都是固定按钮文字），入口已搬到
  //   悬浮栏，全藏合理。toggleCardView() 仍靠 querySelector 反查宿主（display:none
  //   不移除元素，querySelector 找得到）。卡片 markdown 文本一字未改。
  //   只作用于 canvas 节点内；md 阅读视图保持原样。
  '.canvas-node-content .callout[data-callout="lmb-comment"]:not(:has(.callout-content)),',
  '.canvas-node-content .callout[data-callout="lmb-view"]{display:none !important;}',

  // ===== PDF 批注边页：与 PDF 并排占位，不覆盖阅读区 =====
  // 保留 PDF.js 原生 block/absolute 布局；用 padding 划出边页空间，绝不能把宿主改成 flex。
  '.lmb-pdf-sidebar-host{position:relative!important;padding-right:var(--lmb-pdf-sidebar-width,340px)!important;',
  'box-sizing:border-box!important;overflow:hidden!important;}',
  '.lmb-pdf-sidebar-host.lmb-pdf-sidebar-closed{padding-right:0!important;}',
  '.lmb-pdf-sidebar-host.lmb-pdf-sidebar-closed>.lmb-pdf-excerpt-sidebar{display:none!important;}',
  '.lmb-pdf-excerpt-sidebar{position:absolute;z-index:15;right:0;top:var(--lmb-pdf-sidebar-top,0px);bottom:0;min-width:260px;max-width:min(50vw,560px);height:auto;',
  'padding:0 10px 28px 13px;overflow:auto;box-sizing:border-box;background:var(--background-primary);',
  'border-left:1px solid var(--background-modifier-border);scroll-behavior:auto;overflow-anchor:none;}',
  '.lmb-pdf-sidebar-resizer{position:absolute;z-index:5;left:-3px;top:0;bottom:0;width:7px;cursor:col-resize;}',
  '.lmb-pdf-sidebar-resizer:hover,.lmb-pdf-sidebar-resizer.is-dragging{background:var(--interactive-accent);opacity:.75;}',
  '.lmb-pdf-sidebar-title{position:sticky;top:0;padding:12px 3px 10px;margin-bottom:9px;',
  'background:var(--background-primary);border-bottom:1px solid var(--background-modifier-border);z-index:2;}',
  '.lmb-pdf-sidebar-title-row{display:flex;align-items:center;gap:7px;padding-right:38px;}',
  '.lmb-sidebar-state-toggle{position:absolute;z-index:20;right:12px;top:calc(var(--lmb-pdf-sidebar-top,0px) + 8px);display:flex;align-items:center;justify-content:center;width:30px;height:30px;min-height:30px;padding:0;border:1px solid var(--background-modifier-border);border-radius:7px;background:var(--background-secondary);color:var(--text-muted);font:24px/1 var(--font-interface);cursor:pointer;transition:background .15s,box-shadow .15s,transform .1s;}.lmb-sidebar-state-toggle:hover{background:var(--background-modifier-hover);color:var(--text-normal);box-shadow:0 2px 7px #0003;}.lmb-sidebar-state-toggle:active{transform:scale(.94);}.lmb-sidebar-state-toggle:focus-visible{outline:2px solid var(--interactive-accent);outline-offset:2px;}@media(any-pointer:coarse){.lmb-sidebar-state-toggle{width:40px;height:40px;min-height:40px;}.lmb-pdf-sidebar-title-row{padding-right:46px;}}',
  '.lmb-pdf-sidebar-title-main{font-size:14px;font-weight:700;line-height:1.4;}',
  '.lmb-pdf-sidebar-count{font-size:10px;color:var(--text-on-accent);background:var(--interactive-accent);padding:1px 6px;border-radius:99px;}',
  '.lmb-pdf-sidebar-file{font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;}',
  '.lmb-pdf-sidebar-title-sub{font-size:11px;color:var(--text-muted);margin-top:2px;}',
  '.lmb-pdf-sidebar-controls{display:flex;align-items:center;gap:6px;margin-top:8px;height:34px;}',
  '.lmb-pdf-sidebar-controls button,.lmb-pdf-sidebar-item-actions button{border:1px solid var(--background-modifier-border);',
  'appearance:none!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;flex:0 0 auto!important;height:30px!important;min-height:30px!important;max-height:30px!important;line-height:1!important;border-radius:7px;background:var(--background-secondary);color:var(--text-muted);font-size:11px;padding:0 10px!important;margin:0!important;cursor:pointer;}',
  '.lmb-pdf-sidebar-controls button.is-active{background:var(--interactive-accent);color:var(--text-on-accent);border-color:transparent;}',
  '.lmb-pdf-sidebar-follow{margin-left:auto!important;}',
  '.lmb-pdf-sidebar-search{width:100%;box-sizing:border-box;margin-top:8px;padding:6px 8px;border-radius:7px;',
  'border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);}',
  '.lmb-pdf-sidebar-list{display:flex;flex-direction:column;gap:8px;}',
  '.lmb-pdf-sidebar-item{border:1px solid var(--background-modifier-border);border-radius:9px;padding:9px;',
  'background:var(--background-secondary);box-sizing:border-box;cursor:pointer;transition:border-color .15s,background .15s;}',
  '.lmb-pdf-sidebar-item:hover{border-color:var(--background-modifier-border-hover);}',
  '.lmb-pdf-sidebar-item.is-active{border-color:var(--interactive-accent);background:color-mix(in srgb,var(--background-secondary) 82%,var(--interactive-accent));}',
  '.lmb-pdf-sidebar-item.is-page-hidden,.lmb-pdf-sidebar-item.is-search-hidden{display:none;}',
  '.lmb-pdf-sidebar-item-header{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:5px;}',
  '.lmb-pdf-sidebar-item-title{font-size:11px;font-weight:700;color:var(--text-accent);}',
  '.lmb-pdf-sidebar-item-tags{font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.lmb-pdf-sidebar-item-text{font-size:12px;line-height:1.5;white-space:normal;word-break:break-word;}',
  '.lmb-pdf-sidebar-item-text>p:first-child{margin-top:0;}.lmb-pdf-sidebar-item-text>p:last-child{margin-bottom:0;}',
  '.lmb-pdf-sidebar-item-image{margin-top:6px;}.lmb-pdf-sidebar-item-image img{display:block;width:100%;height:auto;',
  'max-height:360px;object-fit:contain;border-radius:6px;background:var(--background-primary);}',
  '.lmb-pdf-sidebar-item-text.is-hidden,.lmb-pdf-sidebar-item-image.is-hidden{display:none!important;}',
  '.lmb-pdf-sidebar-item-note{font-size:12px;line-height:1.4;margin-top:6px;padding:6px 8px;border-left:3px solid rgb(112,196,157);',
  'background:var(--background-primary);border-radius:5px;}',
  '.lmb-pdf-sidebar-item-note-title{font-weight:600;font-size:10px;color:var(--text-muted);margin-bottom:2px;}',
  '.lmb-pdf-sidebar-item-note-body{white-space:normal;word-break:break-word;line-height:1.4;}',
  '.lmb-pdf-sidebar-item-note-body table{font-size:12px!important;line-height:1.35!important;width:100%;table-layout:fixed;}',
  '.lmb-pdf-sidebar-item-note-body th,.lmb-pdf-sidebar-item-note-body td{font-size:inherit!important;line-height:inherit!important;padding:4px 6px!important;min-width:0!important;overflow-wrap:anywhere;vertical-align:top;}',
  '.lmb-pdf-sidebar-item-note-body p{margin:2px 0!important;min-height:0!important;}',
  '.lmb-pdf-sidebar-item-note-body>p:first-child{margin-top:0!important;}',
  '.lmb-pdf-sidebar-item-note-body>p:last-child{margin-bottom:0!important;}',
  '.lmb-pdf-sidebar-item-note-body ul,.lmb-pdf-sidebar-item-note-body ol{margin:2px 0!important;padding-left:18px!important;}',
  '.lmb-pdf-sidebar-item-note-body li{margin:0!important;padding:0!important;line-height:1.4!important;}',
  '.lmb-pdf-sidebar-item-note-body li>p{display:inline;margin:0!important;padding:0!important;}',
  '.lmb-pdf-sidebar-item-note-body li+li{margin-top:1px!important;}',
  '.lmb-pdf-sidebar-item-actions{display:flex;flex-wrap:wrap;align-items:center;gap:5px;justify-content:flex-end;margin-top:8px;}',
  '.lmb-pdf-sidebar-item-actions.is-empty{display:none;}',
  '.lmb-pdf-sidebar-item-text-excerpt{font-weight:700;letter-spacing:.01em;}',
  '.lmb-pdf-sidebar-item-actions .lmb-pdf-sidebar-icon-button{display:inline-flex;align-items:center;justify-content:center;',
  'width:30px;height:30px;min-width:30px;padding:0;color:var(--text-muted);}',
  '.lmb-pdf-sidebar-item-actions .lmb-pdf-sidebar-icon-button:hover{color:var(--text-accent);border-color:var(--interactive-accent);}',
  '.lmb-pdf-sidebar-icon-button{color:var(--text-normal)!important;opacity:1!important;}',
  '.lmb-pdf-sidebar-icon-button svg{display:block!important;width:16px!important;height:16px!important;min-width:16px!important;max-width:16px!important;flex:0 0 16px!important;stroke:currentColor!important;stroke-width:2!important;opacity:1!important;}',
  '.lmb-pdf-sidebar-empty{text-align:center;color:var(--text-muted);padding:42px 10px;}',
  '.lmb-mark-sidebar-active{outline:2px solid var(--interactive-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--interactive-accent) 25%,transparent);}',
  'body.lmb-mobile .lmb-pdf-excerpt-sidebar{min-width:280px!important;max-width:min(38vw,420px)!important;box-shadow:none!important;}',
  'body.lmb-mobile .lmb-pdf-sidebar-resizer{display:none;}',
  '@media(max-width:700px){body.lmb-mobile .lmb-pdf-sidebar-host{padding-right:min(46vw,320px)!important;}body.lmb-mobile .lmb-pdf-excerpt-sidebar{width:min(46vw,320px)!important;min-width:240px!important;max-width:min(46vw,320px)!important;}}',
  '.lmb-text-placing .page{cursor:crosshair!important;}',
  '.lmb-pdf-text-block{position:absolute!important;z-index:65;box-sizing:border-box;color:#222;font-family:var(--font-text);line-height:1.5;border:1px solid transparent;border-radius:4px;background:transparent;user-select:text!important;-webkit-user-select:text!important;}',
  '.lmb-pdf-text-block:hover,.lmb-pdf-text-block:focus-within{border-color:var(--interactive-accent,#6a9);}',
  '.lmb-pdf-text-block.is-note-style{background:#fff6d8;box-shadow:0 2px 6px #0002;}',
  '.lmb-pdf-text-tools{position:absolute;bottom:100%;left:0;display:flex;flex-wrap:wrap;gap:3px;min-width:260px;max-width:100%;padding:4px;background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:5px;opacity:0;pointer-events:none;z-index:2;color:var(--text-normal);font:12px/1.3 var(--font-interface);}',
  '.lmb-pdf-text-block:hover>.lmb-pdf-text-tools,.lmb-pdf-text-block:focus-within>.lmb-pdf-text-tools{opacity:1;pointer-events:auto;}',
  '.lmb-pdf-text-tools button{font-size:12px;padding:3px 6px;height:26px;}.lmb-pdf-text-tools button:first-child{cursor:move;touch-action:none;}',
  '.lmb-pdf-text-tools input{width:52px;height:26px;font-size:12px;padding:2px;}',
  '.lmb-pdf-text-body{padding:.45em .6em;overflow:auto;overflow-wrap:anywhere;font-size:inherit!important;color:inherit;line-height:inherit;}',
  '.lmb-pdf-text-body :is(p,li,blockquote,table){font-size:1em;line-height:1.5;color:inherit;}.lmb-pdf-text-body :is(p,ul,ol,blockquote){margin-block:.5em;}',
  '.lmb-pdf-text-body h1{font-size:1.7em;}.lmb-pdf-text-body h2{font-size:1.4em;}.lmb-pdf-text-body h3{font-size:1.2em;}.lmb-pdf-text-body h4,.lmb-pdf-text-body h5,.lmb-pdf-text-body h6{font-size:1em;}.lmb-pdf-text-body :is(h1,h2,h3,h4,h5,h6){color:inherit;margin:.6em 0 .35em;}',
  '.lmb-pdf-text-body blockquote{border-left:3px solid #74b490;padding-left:.7em;}.lmb-pdf-text-body img{max-width:100%;}.lmb-pdf-text-body pre{overflow:auto;}.lmb-pdf-text-body a{color:#1765a3;}',
  '.lmb-pdf-text-resize{position:absolute;right:-7px;top:0;bottom:0;width:14px;cursor:ew-resize;touch-action:none;}.lmb-pdf-text-block:hover>.lmb-pdf-text-resize,.lmb-pdf-text-block:focus-within>.lmb-pdf-text-resize{border-right:3px solid var(--interactive-accent,#6a9);}',
  '.lmb-pdf-sidebar-item-note.is-foldable{position:relative;padding-bottom:28px;}.lmb-pdf-sidebar-item-note.is-foldable.is-collapsed{padding-bottom:6px;}.lmb-pdf-sidebar-item-note.is-collapsed .lmb-pdf-sidebar-item-note-body{max-height:160px;overflow:hidden;}',
  '.lmb-pdf-sidebar-item-note.is-collapsed:after{content:"";position:absolute;bottom:0;left:0;right:0;height:30px;background:linear-gradient(transparent,var(--background-primary));pointer-events:none;border-radius:0 0 5px 5px;}.lmb-pdf-sidebar-note-expand{position:absolute;right:6px;bottom:5px;z-index:1;height:23px;padding:1px 7px;font-size:11px;line-height:1.2;border-radius:5px;background:var(--background-primary);color:var(--text-muted);border:1px solid var(--background-modifier-border);}',
  '.lmb-pdf-sidebar-item-summary{display:none;}.lmb-pdf-sidebar-item-title{flex-shrink:0;}.lmb-pdf-sidebar-header-actions{display:flex;align-items:center;gap:4px;flex-shrink:0;margin-left:auto;}.lmb-pdf-sidebar-header-actions .lmb-pdf-sidebar-icon-button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;min-width:26px;padding:0;background:transparent;border:0;box-shadow:none;color:var(--text-muted);}.lmb-pdf-sidebar-header-actions .lmb-pdf-sidebar-delete:hover{background:var(--background-modifier-error);color:var(--text-error)!important;}',
  '.lmb-pdf-sidebar-item.is-compact .lmb-pdf-sidebar-item-summary{display:block;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text-muted);}.lmb-pdf-sidebar-item.is-compact .lmb-pdf-sidebar-header-actions{display:none;}.lmb-pdf-sidebar-item.is-compact .lmb-pdf-sidebar-expand-entry{flex-shrink:0;}',
  '.lmb-pdf-sidebar-expand-entry{display:none;}.lmb-pdf-sidebar-item.is-compact{padding:6px 10px;}.lmb-pdf-sidebar-item.is-compact>:not(.lmb-pdf-sidebar-item-header){display:none!important;}.lmb-pdf-sidebar-item.is-compact .lmb-pdf-sidebar-item-tags{display:none;}.lmb-pdf-sidebar-item.is-compact .lmb-pdf-sidebar-item-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0;}.lmb-pdf-sidebar-item.is-compact .lmb-pdf-sidebar-expand-entry{display:inline-flex;font-size:12px;height:26px;padding:3px 8px;white-space:nowrap;}',
  '.lmb-pdf-sidebar-header-actions .lmb-pdf-sidebar-icon-button,.lmb-pdf-sidebar-expand-entry,.lmb-pdf-sidebar-note-expand{border:1px solid var(--background-modifier-border);border-radius:6px;background:var(--background-secondary);box-shadow:0 1px 2px #0001;cursor:pointer;}',
  '.lmb-pdf-sidebar-header-actions button,.lmb-pdf-sidebar-expand-entry,.lmb-pdf-sidebar-note-expand,.lmb-pdf-sidebar-item-actions button{transition:background-color .15s,border-color .15s,box-shadow .15s,transform .1s;}',
  '.lmb-pdf-sidebar-header-actions button:hover,.lmb-pdf-sidebar-expand-entry:hover,.lmb-pdf-sidebar-note-expand:hover,.lmb-pdf-sidebar-item-actions button:hover{border-color:var(--interactive-accent);background:color-mix(in srgb,var(--interactive-accent) 12%,var(--background-secondary));box-shadow:0 3px 7px #0002;transform:translateY(-1px);}',
  '.lmb-pdf-sidebar-header-actions .lmb-pdf-sidebar-delete:hover{border-color:var(--text-error);background:color-mix(in srgb,var(--text-error) 14%,var(--background-secondary));color:var(--text-error)!important;}',
  '.lmb-pdf-sidebar-header-actions button:active,.lmb-pdf-sidebar-expand-entry:active,.lmb-pdf-sidebar-note-expand:active,.lmb-pdf-sidebar-item-actions button:active{transform:translateY(1px);box-shadow:inset 0 1px 3px #0003;}',
  '.lmb-pdf-sidebar-header-actions button:focus-visible,.lmb-pdf-sidebar-expand-entry:focus-visible,.lmb-pdf-sidebar-note-expand:focus-visible,.lmb-pdf-sidebar-item-actions button:focus-visible{outline:2px solid var(--interactive-accent);outline-offset:2px;}',
  '@media(prefers-reduced-motion:reduce){.lmb-pdf-sidebar-header-actions button,.lmb-pdf-sidebar-expand-entry,.lmb-pdf-sidebar-note-expand,.lmb-pdf-sidebar-item-actions button{transition:none!important;transform:none!important;}}',
  '.lmb-pdf-text-body{--table-text-size:var(--lmb-pdf-text-size);--table-header-size:var(--lmb-pdf-text-size);}.lmb-pdf-text-body :is(.table-wrapper,table,thead,tbody,tfoot,tr,th,td){font-size:var(--lmb-pdf-text-size)!important;line-height:1.5!important;color:inherit!important;}.lmb-pdf-text-body :is(th,td)>:is(p,ul,ol,div){font-size:inherit!important;}.lmb-pdf-text-body table{border-collapse:collapse;max-width:100%;}.lmb-pdf-text-body :is(th,td){padding:.3em .5em;overflow-wrap:anywhere;}',
  '.lmb-pdf-text-tools .lmb-text-size-step{min-width:34px;min-height:32px;padding:4px 7px;}.lmb-pdf-text-tools{min-width:min(360px,calc(100vw - 40px));}.pdf-embed .lmb-toolbar-page-note,.workspace-leaf-content:not([data-type="pdf"]) .lmb-toolbar-page-note{display:none!important;}.lmb-toolbar-group .lmb-toolbar-page-note{cursor:pointer;border:0;background:transparent;box-shadow:none;}',
  '@media(pointer:coarse){.lmb-pdf-text-tools button,.lmb-pdf-text-tools input{min-height:44px;height:44px;}.lmb-pdf-text-tools .lmb-text-size-step{min-width:44px;}.lmb-toolbar-page-note{min-width:40px;min-height:40px;}}',
  '.lmb-pdf-text-block.is-editing{z-index:75;border-color:var(--interactive-accent);}.lmb-pdf-text-block.is-editing>.lmb-pdf-text-tools,.lmb-pdf-text-block.is-editing>.lmb-pdf-text-resize{display:none;}.lmb-inline-note-editor{padding:7px;background:var(--background-primary);color:var(--text-normal);border:1px solid var(--interactive-accent);border-radius:5px;box-shadow:0 3px 10px #0002;}',
  '.lmb-inline-note-controls{display:flex;align-items:center;gap:5px;font:12px/1.3 var(--font-interface);margin-bottom:5px;}.lmb-inline-note-controls>span:first-child{white-space:nowrap;}.lmb-inline-note-status{flex:1;min-width:0;font-size:11px;color:var(--text-muted);}.lmb-inline-note-controls button{height:28px;min-width:40px;padding:2px 7px;font-size:12px;}.lmb-inline-note-input{display:block;width:100%;box-sizing:border-box;min-height:60px;max-height:180px;padding:6px 8px;resize:vertical;overflow:auto;font:15px/1.5 var(--font-text);color:var(--text-normal);background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:4px;}',
  '.lmb-pdf-text-block.is-editing>.lmb-pdf-text-body{background:color-mix(in srgb,white 97%,transparent);color:#222;}.lmb-pdf-text-block.is-draft>.lmb-pdf-text-tools{display:none;}.modal:has(.lmb-note-editor-compact){width:min(620px,calc(100vw - 32px));max-height:80vh;}.lmb-note-editor-compact .lmb-note-editor-grid{grid-template-columns:1fr;min-height:0;height:auto;gap:8px;}.lmb-note-editor-compact .lmb-note-editor-input{min-height:72px;max-height:180px;height:72px;padding:8px;}.lmb-note-editor-compact .lmb-note-editor-preview{height:auto;max-height:220px;min-height:40px;padding:8px;}',
  '.lmb-inline-note-controls>span:first-child{min-width:0;max-width:50%;overflow:hidden;text-overflow:ellipsis;}.lmb-inline-note-status{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.lmb-inline-note-controls button{flex-shrink:0;}',
  '@media(any-pointer:coarse){.lmb-inline-note-controls button{min-height:40px;min-width:44px;}.lmb-inline-note-controls{flex-wrap:wrap;}.lmb-inline-note-input{font-size:16px;}}',
  '.is-live-editing>.lmb-inline-note-editor{position:absolute;bottom:100%;left:0;right:0;z-index:3;padding:4px 6px;border:1px solid var(--background-modifier-border);border-radius:4px;box-shadow:0 2px 6px #0002;}.is-live-editing .lmb-inline-note-controls{margin:0;}.lmb-live-markdown-block{display:flow-root;min-width:0;overflow-wrap:anywhere;border-radius:3px;}.lmb-live-markdown-block:not(.is-active){cursor:text;}.lmb-live-markdown-block:not(.is-active):hover{background:#70bd9410;}.lmb-live-markdown-block:focus-visible{outline:1px solid var(--interactive-accent);}.lmb-live-markdown-block.is-active{margin:.5em 0;background:#70bd9410;box-shadow:inset 2px 0 0 #70bd9480;}',
  '.lmb-live-markdown-input{display:block;box-sizing:border-box;width:100%;min-height:1.5em;max-height:none;margin:0;padding:0;border:0!important;border-radius:0;box-shadow:none!important;resize:none!important;overflow:hidden;background:transparent!important;color:inherit!important;font:inherit;line-height:1.5;outline:none!important;}.lmb-live-markdown-block[data-kind="heading"]{margin:.6em 0 .35em;}.lmb-live-markdown-block[data-kind="heading"]>.lmb-live-markdown-input{font-size:var(--lmb-live-heading-size,1.4em);font-weight:600;}.lmb-live-markdown-block[data-kind="code"]>.lmb-live-markdown-input{font-family:var(--font-monospace,monospace);}',
  '.lmb-live-markdown-block:not(.is-active)[data-kind="heading"]{margin:0;}',
  '@media(any-pointer:coarse){.lmb-live-markdown-input{font-size:max(16px,var(--lmb-pdf-text-size,16px));}}',
  '.lmb-pdf-text-tools,.lmb-inline-note-controls,.lmb-pdf-text-resize,.lmb-mark{user-select:none!important;-webkit-user-select:none!important;}',
  '.lmb-pdf-text-tools{width:max-content;min-width:0;max-width:calc(100vw - 24px);align-items:center;gap:3px;padding:4px;}.lmb-pdf-text-tools button,.lmb-pdf-text-tools input{box-sizing:border-box;height:30px!important;min-height:30px!important;margin:0!important;line-height:1!important;font:12px/1 var(--font-interface);border:1px solid var(--background-modifier-border);border-radius:5px;box-shadow:none;padding:3px 6px;}.lmb-pdf-text-tools .lmb-text-size-step,.lmb-pdf-text-tools button:first-child{min-width:28px;padding:3px 5px;}.lmb-pdf-text-tools input{width:38px!important;min-width:38px;max-width:38px;padding:2px 3px;text-align:center;appearance:textfield;}.lmb-pdf-text-tools input::-webkit-inner-spin-button,.lmb-pdf-text-tools input::-webkit-outer-spin-button{appearance:none;margin:0;}',
  '.lmb-pdf-text-block.lmb-note-hover{outline:1px solid var(--interactive-accent,#70bd94);outline-offset:2px;}.lmb-pdf-text-block.lmb-note-selected{border-color:var(--interactive-accent,#70bd94);outline:2px solid var(--interactive-accent,#70bd94);outline-offset:2px;box-shadow:0 0 0 5px #70bd941c;}.lmb-pdf-text-block.lmb-note-selected:before{content:attr(data-lmb-badge);position:absolute;right:0;bottom:calc(100% + 5px);z-index:1;padding:2px 6px;background:var(--interactive-accent,#70bd94);color:var(--text-on-accent,#132f22);font:11px/1.4 var(--font-interface);border-radius:4px;pointer-events:none;user-select:none;}.lmb-mark.lmb-note-selected{outline:2px solid var(--interactive-accent,#70bd94);outline-offset:1px;}.lmb-pdf-sidebar-item.is-active{border-color:var(--interactive-accent,#70bd94);box-shadow:inset 3px 0 var(--interactive-accent,#70bd94);}',
  '.lmb-pdf-sidebar-item-note.is-sidebar-editing{position:relative;max-height:none;padding:0 0 4px;overflow:visible;}.is-sidebar-editing>.lmb-inline-note-editor{position:static;inset:auto;margin-bottom:4px;box-shadow:none;border:1px solid var(--background-modifier-border);}.is-sidebar-editing>.lmb-pdf-sidebar-item-note-body{max-height:none!important;overflow:visible;background:transparent;color:var(--text-normal);padding:0 4px;}.is-sidebar-editing>.lmb-pdf-sidebar-note-expand,.lmb-pdf-sidebar-item.is-note-editing>.lmb-pdf-sidebar-item-actions{display:none;}.lmb-pdf-sidebar-item.is-note-editing{display:block!important;}.lmb-pdf-sidebar-item.is-note-editing>.lmb-pdf-sidebar-item-note{display:block!important;}',
  '@media(any-pointer:coarse){.lmb-pdf-text-tools button,.lmb-pdf-text-tools input{height:40px!important;min-height:40px!important;font-size:13px;}.lmb-pdf-text-tools button:first-child,.lmb-pdf-text-tools .lmb-text-size-step{min-width:36px;}.lmb-pdf-text-tools input{width:44px!important;min-width:44px;max-width:44px;}}'
];

if (typeof module !== "undefined" && module.exports) {
  module.exports.__lmbStyles = { LMB_STYLES };
}

/* compat/obsidian-adapters — Obsidian 私有 Canvas / PDF API 的单一边界。
 * 业务模块应优先通过这里读取或提交内部对象；宿主升级时集中在本文件适配。 */
const LmbCanvasAdapter = Object.freeze({
  data(canvas) {
    try { return canvas && typeof canvas.getData === "function" ? canvas.getData() : null; }
    catch (_) { return null; }
  },
  selection(canvas) {
    try { return canvas ? Array.from(typeof canvas.getSelection === "function" ? canvas.getSelection() : (canvas.selection || [])) : []; }
    catch (_) { return []; }
  },
  commit(canvas, data) {
    try {
      if (!canvas || typeof canvas.setData !== "function" || typeof canvas.requestSave !== "function") return false;
      canvas.setData(data); canvas.requestSave(); return true;
    } catch (_) { return false; }
  }
});

const LmbPdfAdapter = Object.freeze({
  zoomViewer(view) {
    try {
      const child = view && view.viewer && view.viewer.child;
      const viewer = child && child.pdfViewer;
      return viewer && Number(viewer.currentScale) > 0 ? viewer : null;
    } catch (_) { return null; }
  },
  viewer(view) {
    try { return view && view.containerEl && (view.containerEl.querySelector(".pdfViewer") || view.containerEl); }
    catch (_) { return null; }
  },
  isRelevantMutation(node) {
    try {
      if (!node) return false;
      if (node.nodeType === 3) return !!(node.parentElement && node.parentElement.closest(".textLayer"));
      return node.nodeType === 1 && !node.classList.contains("lmb-mark")
        && !!node.closest(".page, .textLayer, .annotationLayer");
    } catch (_) { return false; }
  }
});

/* 23-pure-note —— 补充描述(ppd-note) + 独立评论(lmb-comment) 解析/合并（纯函数，可单测） */

/**
 * 拆分 text → { body, note, fold, hasNote, type, tail }
 *   v0.8.3：先按新格式（callout 自身）解析，找不到再回退旧 HTML 锚点格式（v0.8.0-0.8.2 兼容）。
 *   v0.11.0：感知独立评论块（lmb-comment）——note 块在评论块首行处截断，评论块及其后
 *   的内容原样放进 tail（join 时原样接回，不再像旧版那样把 note 之后的散行弄丢）。
 */
/* v0.16.6 P1-4：把「允许的 note 调用类型」收成一个 Set（纯函数，可单测）。
 *   allowTypes 可传字符串或数组；不传 / 传空 → 只含历史默认类型 ppd-note。
 *   全部转小写去空白比较（callout 类型名大小写不敏感）。 */
function lmbNoteTypeSet(allowTypes) {
  const s = new Set();
  const push = (v) => {
    if (typeof v !== "string") return;
    const t = v.trim().toLowerCase();
    if (t) s.add(t);
  };
  push(typeof LMB_NOTE_TYPE_DEFAULT === "string" ? LMB_NOTE_TYPE_DEFAULT : "ppd-note");
  if (Array.isArray(allowTypes)) { for (const t of allowTypes) push(t); }
  else push(allowTypes);
  return s;
}

function lmbSplitNote(text, allowTypes) {
  if (typeof text !== "string" || !text) return { body: text || "", note: "", fold: false, hasNote: false, type: "", tail: "" };
  const lines = text.split("\n");
  // v0.16.6 P1-4：只认插件自有的 note 类型（默认 ppd-note + 调用方传入的
  // settings.noteCalloutType）。用户自有的 [!warning]/[!quote] 等不再被误判为补充描述。
  const allow = lmbNoteTypeSet(allowTypes);

  // body 末尾：callout 块前面那部分。新格式=第一个 callout 首行；旧格式=HTML 起始行之前。
  let bodyEndIdx = lines.length;
  // callout 块范围：[blockStart, blockEnd)
  let blockStart = -1, blockEnd = lines.length;

  // 新格式优先：找第一个 note callout 首行（跳过 lmb-comment——那是独立评论体系，不是 note；
  // v0.11.3：同样跳过 lmb-view——那是双重摘录卡的视图切换按钮，也不是 note）
  for (let i = 0; i < lines.length; i++) {
    if (LMB_COMMENT_CALLOUT_RE.test(lines[i])) continue;  // 评论块不是 note
    if (LMB_VIEW_CALLOUT_RE.test(lines[i])) continue;     // 视图切换按钮不是 note（v0.11.3）
    // v0.16.6 P1-4：类型白名单 —— 不在白名单里的 callout 是用户自己的内容，不是 note
    const nm0 = NOTE_CALLOUT_RE.exec(lines[i]);
    if (!nm0) continue;
    if (!allow.has(String(nm0[1] || "").trim().toLowerCase())) continue;
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
function lmbStripNote(text, allowTypes) {
  const r = lmbSplitNote(text, allowTypes);
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
  const head = "> [!" + LMB_COMMENT_TYPE + "]";
  const callout = [head].concat(String(commentText).split("\n").map((l) => (l.trim() ? "> " + l : ">")));
  return base + "\n\n" + callout.join("\n");
}
/**
 * v0.13.3：把 text 转成「**真正**会被渲染的文本行」给尺寸估算用。
 *
 *   旧版本（v0.8.3 注释说"原样返回"）的实现是个隐患：折叠态的 lmb-comment 按钮
 *   实际渲染只占 30px 左右，但被 estimateTextSize 按字符行高（25px/行）算高度，
 *   展开态的 callout 内容行也按普通行算 —— 与实际渲染对不上，卡片底部留白。
 *
 *   修复：复用 lmbSplitNote + lmbSplitComment 把 ppd-note / lmb-view / lmb-comment
 *   三种插件辅助 callout 全剥掉，让 estimateTextSize 只算**纯文本行**高度；
 *   callout 自己的占位由 estimateSizeFor 的 addNoteChrome / addCommentChrome
 *   单独按实测平均高度加。
 *
 *   这两个函数（lmbSplitNote / lmbSplitComment）在 v0.11.0 / v0.11.3 已经感知这
 *   三种 callout 的存在与结构，直接 chain 一下就能拿到纯内容。
 *
 *   ⚠ v0.13.3 的**漏网之鱼**（v0.16.0 实测发现并修）：上面那句"三种全剥掉"其实没做到 ——
 *   lmbSplitNote 对 lmb-view 是 `continue`（**跳过不算 note**），不等于**剥离**。
 *   当卡里没有 ppd-note 时它会走 `return { body: text }` 原样返回 → lmb-view 行留在 body 里：
 *       lmbRenderedText("引用\n> [!lmb-view] …")  →  "引用\n> [!lmb-view] …"   ← 没剥掉
 *   后果：双重摘录卡的切换按钮行被 estimateTextSize 当普通文本行算进高度（~25-29px），
 *   但该行在 canvas 里被 CSS `display:none` 藏着、**根本不占渲染空间**
 *   → 双重卡底部一直多出约一行的留白（正是 v0.13.3 想修的那个问题，只修好两种）。
 *   修法：chain 完再按行过滤一道 lmb-view（最后一道，成本可忽略，只在有 callout 时生效）。
 *   v0.16.0 起新卡不再写 lmb-view 行，这一刀主要治**存量双重卡**的高度。
 *
 *   ⚠ 踩坑记录：这里**必须逐行 test**，不能拿整段文本去 `LMB_VIEW_CALLOUT_RE.test(整段)`。
 *     该正则没有 `m` flag，`^` 只锚定**字符串开头** —— 整段以「引用」开头时匹配必然失败
 *     （`>` 对上了汉字），会静默漏掉所有 lmb-view 行。lmbSplitNote 里能用是因为它本来就
 *     是 `LMB_VIEW_CALLOUT_RE.test(lines[i])` 逐行调用。写这段代码时第一版就栽在这里，
 *     加过一句 `if (!RE.test(out)) return out;` 的"快路径"，结果快路径永远判定为
 *     "没有 lmb-view" → 修复形同虚设，测试 BC14 立刻抓出来了。
 */
function lmbRenderedText(text, allowTypes) {
  if (typeof text !== "string" || !text) return text || "";
  const a = lmbSplitNote(text, allowTypes);
  const b = lmbSplitComment(a.body);
  // v0.16.0：补最后一道 —— 剥掉 lmbSplitNote 只跳过没剥离的 lmb-view 行。
  //   逐行 filter（判据与 lmbSplitNote 的跳过同源，不会漂）；卡片文本最多几十行，开销可忽略。
  return b.body.split("\n").filter((l) => !LMB_VIEW_CALLOUT_RE.test(l)).join("\n");
}

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

/* 20-pure-interaction —— chip 重建把关（纯函数，可单测） */

/* ==================== v0.4.0：MN4 式「拖到节点上自动成为子节点」纯函数 ==================== */

/** 两矩形相交面积 / a 的面积（canvas 坐标：x,y 左上，y 向下） */
function lmbRectsOverlapRatio(a, b) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return 0;
  const areaA = a.w * a.h;
  return areaA > 0 ? (ox * oy) / areaA : 0;
}

/* 21-pure-layout —— 父子吸附/组居中/首连锁定/改挂侧/重居中（纯函数，可单测） */

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
 * Build a lightweight grid index for overlap/containment lookups.
 * Canvas auto-linking only needs nodes whose rectangles share at least one grid
 * cell with the moved node; checking every node made bulk imports quadratic.
 */
function lmbBuildSpatialIndex(nodes, cellSize = 512) {
  const size = Math.max(64, Number(cellSize) || 512);
  const buckets = new Map();
  const overflow = [];
  const key = (x, y) => x + "," + y;
  const cellsFor = (node) => {
    const x = Number(node && node.x) || 0, y = Number(node && node.y) || 0;
    const w = Math.max(0, Number(node && node.width) || 0);
    const h = Math.max(0, Number(node && node.height) || 0);
    const x0 = Math.floor(x / size), y0 = Math.floor(y / size);
    const x1 = Math.floor((x + Math.max(1, w) - 0.001) / size);
    const y1 = Math.floor((y + Math.max(1, h) - 0.001) / size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) return null;
    const out = [];
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) out.push(key(cx, cy));
    return out;
  };
  for (const node of nodes || []) {
    if (!node || node.type === "group") continue;
    const cells = cellsFor(node);
    if (!cells) { overflow.push(node); continue; }
    for (const cell of cells) {
      if (!buckets.has(cell)) buckets.set(cell, []);
      buckets.get(cell).push(node);
    }
  }
  return {
    query(node) {
      const cells = cellsFor(node);
      if (!cells) return (nodes || []).filter((n) => n && n.type !== "group" && n.id !== node.id);
      const seen = new Set(), out = [];
      const add = (candidate) => {
        if (!candidate || candidate.id === node.id || seen.has(candidate.id)) return;
        seen.add(candidate.id); out.push(candidate);
      };
      for (const cell of cells) for (const candidate of buckets.get(cell) || []) add(candidate);
      for (const candidate of overflow) add(candidate);
      return out;
    }
  };
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
 *   v0.11.1 兜底：当 sidecar 缺记录时（典型场景：instantAttach 早期 path2 还没拿到，
 *   sidecar 漏登记；或在持久化档加载失败时），从 edges 里按 id 命名规范「e<base36>」
 *   直接兜底识别 —— 这是一贯的自动边命名规则，绝不与 Obsidian 自动边或用户手动边
 *   冲突（Obsidian 自动边通常是 16/32 位 hex，按 /e[0-9a-f]{8,}/ 排除）。
 *   返回 null = 都不是（手动边或孤儿边）。
 *   返回 { edge, reversed }：reversed=true 表示边方向是 child→parent（少见，但写法上要兜底）；
 *   .fromNode/.fromSide 取自 edge.reversed ? toNode 与 toSide : fromNode 与 fromSide。
 */
function lmbAutoParentEdgeOf(childId, edges, sidecar) {
  for (const ed of edges || []) {
    if (!ed || !ed.fromNode || !ed.toNode) continue;
    if (ed.toNode !== childId && ed.fromNode !== childId) continue;
    const reversed = ed.fromNode === childId;
    if (sidecar && sidecar.has(ed.id)) return { edge: ed, reversed };
    // v0.11.1 兜底：sidecar 没记录但 id 形如本插件自动边命名也认
    if (typeof ed.id === "string" && /^e[0-9a-z]+$/.test(ed.id)
        && !/^e[0-9a-f]{8,}$/i.test(ed.id)) {
      return { edge: ed, reversed };
    }
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
 * v0.11.1：side 取反。edge.fromSide 是「from 节点」视角的连出方向，
 *   当 from 是子不是父时（reversed 边方向），需要翻一次得到父视角。
 *   未知 side 原样返回（防御：旧数据可能缺字段）。
 */
function lmbSideFlip(side) {
  if (side === "top") return "bottom";
  if (side === "bottom") return "top";
  if (side === "left") return "right";
  if (side === "right") return "left";
  return side;
}
/**
 * v0.6.0：从 edges 中导出指定父卡的所有子卡，按它们相对父卡的位置分组（right/left/top/bottom）。
 *   用法：拿到 kidsBySide.get(side) 后加上新子卡，整组调用 lmbLayoutGroup。
 */
function lmbGroupBySide(parent, nodes, edges, nodeById) {
  const m = new Map();
  const byId = nodeById || new Map((nodes || []).filter((n) => n && n.id).map((n) => [n.id, n]));
  for (const e of edges || []) {
    let childId = null;
    if (e.fromNode === parent.id) childId = e.toNode;
    else if (e.toNode === parent.id) childId = e.fromNode;
    if (!childId) continue;
    const child = byId.get(childId);
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

/**
 * 按有向连线（fromNode=父，toNode=子）平移一组被拖动卡片的全部后代。
 * 多选拖动时，显式移动的卡片不再被祖先重复平移；环形连线也只访问一次。
 * @returns {number} 实际被联动平移的卡片数
 */
function lmbMoveDescendants(nodes, edges, movements) {
  const byId = new Map((nodes || []).filter((n) => n && n.id).map((n) => [n.id, n]));
  const children = new Map();
  for (const edge of edges || []) {
    if (!edge || !byId.has(edge.fromNode) || !byId.has(edge.toNode) || edge.fromNode === edge.toNode) continue;
    if (!children.has(edge.fromNode)) children.set(edge.fromNode, []);
    children.get(edge.fromNode).push(edge.toNode);
  }
  const roots = (movements || []).filter((m) => m && byId.has(m.id)
    && Number.isFinite(m.dx) && Number.isFinite(m.dy) && (m.dx !== 0 || m.dy !== 0));
  const explicit = new Set(roots.map((m) => m.id));
  const shifted = new Set();
  for (const move of roots) {
    const seen = new Set([move.id]);
    const queue = [...(children.get(move.id) || [])];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const childId of children.get(id) || []) queue.push(childId);
      if (explicit.has(id) || shifted.has(id)) continue;
      const node = byId.get(id);
      if (!node || node.type === "group") continue;
      node.x = Math.round((Number(node.x) || 0) + move.dx);
      node.y = Math.round((Number(node.y) || 0) + move.dy);
      shifted.add(id);
    }
  }
  return shifted.size;
}

/** v0.19：按父子边把一棵树排成左→右或上→下的阅读树；无环保护。 */
function lmbLayoutTree(nodes, edges, direction = "right", gap = 60) {
  const byId = new Map((nodes || []).filter((n) => n && n.id && n.type !== "group").map((n) => [n.id, n]));
  const kids = new Map(), childIds = new Set();
  for (const e of edges || []) if (byId.has(e.fromNode) && byId.has(e.toNode)) {
    if (!kids.has(e.fromNode)) kids.set(e.fromNode, []);
    kids.get(e.fromNode).push(e.toNode); childIds.add(e.toNode);
  }
  const roots = [...byId.keys()].filter((id) => !childIds.has(id));
  let cursor = 0;
  const walk = (id, depth, seen) => {
    if (seen.has(id)) return 0; seen.add(id);
    const node = byId.get(id), children = kids.get(id) || [];
    let span = 0;
    for (const child of children) span += walk(child, depth + 1, seen) + gap;
    span = Math.max(span - (children.length ? gap : 0), direction === "down" ? (node.width || 200) : (node.height || 120));
    if (direction === "down") { node.x = Math.round(cursor + (span - (node.width || 200)) / 2); node.y = Math.round(depth * ((node.height || 120) + gap)); }
    else { node.x = Math.round(depth * ((node.width || 240) + gap)); node.y = Math.round(cursor + (span - (node.height || 120)) / 2); }
    cursor += span + gap; return span;
  };
  for (const id of roots) walk(id, 0, new Set());
  return roots.length;
}
/* ==================== v0.11.0：首连锁定 / 改挂侧 / 尺寸重居中 ==================== */

/**
 * v0.11.0（纯函数）：决定 nn 落到 parent 上时的自动连线动作。
 *   R3 首连锁定：一张卡最多一条「自动」边——已有自动父边且父不是 parent → skip，
 *   不再换父、不再自动新建（换父已移除；想换父请手动删线后重拖，手动边不参与锁定）。
 *   R4 改挂侧：nn 与 parent 之间已有边（自动或手动）→ reside：按落点方位改边端点 + 两侧组重排。
 *   create：nn 还没有任何自动边 → 首次自动建线（此后即锁定）。
 *   v0.11.1 新增 recenter：sizeOnly=true（由调用方标识「只是尺寸变化、位置没动」）
 *   → 保留原侧不翻转，专门修复 fitNode 把卡撑大后 lmbSideOf CURRENT 算出相反侧、
 *   导致 lmbApplyReside 把「下」翻成「右」的对齐 bug。
 * 返回：
 *   { op: "skip" }                                — 不动作
 *   { op: "reside", edge, oldSide, newSide }      — 已有连线，按当前落点改挂侧
 *   { op: "recenter", edge, side }                — 尺寸变化，保留原侧重新居中（v0.11.1）
 *   { op: "create", side }                        — 首次自动建线
 */
function lmbPlanAutoLink(nn, parent, edges, sidecar, opts) {
  if (!nn || !parent || nn.id === parent.id) return { op: "skip" };
  const eds = Array.isArray(edges) ? edges : [];
  const auto = lmbAutoParentEdgeOf(nn.id, eds, sidecar);
  if (auto) {
    // R3：首连锁定——已有自动父边且父不是本次压中的卡 → skip
    // 「父」就是「非 nn 那端」：reversed 时 nn=fromNode 父=toNode，否则父=fromNode
    const parentEnd = auto.reversed ? auto.edge.toNode : auto.edge.fromNode;
    if (parentEnd !== parent.id) return { op: "skip" };
  }
  let linkEdge = null;
  let linkEdgeReversed = false;
  for (const ed of eds) {
    if (!ed || !ed.fromNode || !ed.toNode) continue;
    if (ed.fromNode === parent.id && ed.toNode === nn.id) { linkEdge = ed; linkEdgeReversed = false; break; }
    if (ed.fromNode === nn.id && ed.toNode === parent.id) { linkEdge = ed; linkEdgeReversed = true; break; }
  }
  if (linkEdge) {
    const parentFacingSide = linkEdgeReversed
      ? lmbSideFlip(linkEdge.toSide)
      : linkEdge.fromSide;
    const oldSide = parentFacingSide || (linkEdgeReversed ? linkEdge.toSide : linkEdge.fromSide);

    const sizeOnly = !!(opts && opts.sizeOnly);
    // v0.11.1 sizeOnly：nn 是 fitNode 撑大的（位置没动），保留原侧避免翻转
    if (sizeOnly) {
      return { op: "recenter", edge: linkEdge, side: oldSide, oldSide };
    }
    return { op: "reside", edge: linkEdge, oldSide: oldSide, newSide: lmbSideOf(nn, parent) };
  }
  if (auto) return { op: "skip" }; // 防御：auto 必然对应 linkEdge
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
  // v0.11.1：lmbAutoParentEdgeOf 返回 { edge, reversed }；兜底识别 e<base36> 命名
  const find = lmbAutoParentEdgeOf(nn.id, edges, sidecar || new Set());
  if (!find) return false;
  const auto = find.edge;
  // 父 id：
  //   reversed=true  ⇒ 边方向是 nn→parent（auto.fromNode===nn.id，auto.toNode 是 parent）
  //   reversed=false ⇒ 边方向是 parent→nn（auto.fromNode 是 parent，auto.toNode===nn.id）
  // 一言以蔽之：parentId = find.reversed ? auto.toNode : auto.fromNode
  const parentId = find.reversed ? auto.toNode : auto.fromNode;
  const parent = nodes.find((n) => n && n.id === parentId);
  if (!parent || parent.type === "group") return false;
  // side：fromSide 是「父端」对子方向的标识。原始代码假设 fromNode=parent，读 auto.fromSide；
  //   reversed 时 fromNode=nn（即「子」端），所以 fromSide 不再是父视角，需要翻一次。
  const side = find.reversed ? lmbSideFlip(auto.fromSide) : (auto.fromSide || lmbSideOf(nn, parent));
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

/* 22-pure-tree —— 摘录树构建 / canvas 新卡 diff（纯函数） */

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

/* 24-pure-excerpt —— 摘录文档解析（纯函数，可单测） */

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
function lmbUnwrapExcerptCard(content) {
  if (typeof content !== "string" || !/\[!lmb-excerpt\]/i.test(content)) return content || "";
  return content.split(/\r?\n/).filter((line) => !/\[!lmb-excerpt\]/i.test(line) && !/class=["']lmb-excerpt-id["']/i.test(line))
    .map((line) => line.replace(/^(\s*)>\s?/, "$1")).join("\n");
}

function lmbParsePdfLinkTarget(linkText) {
  try {
    const bar = String(linkText || "").indexOf("|");
    const href = bar >= 0 ? String(linkText).slice(0, bar) : String(linkText || "");
    const hash = href.lastIndexOf("#");
    if (hash < 0) return null;
    const query = href.slice(hash + 1);
    const tm = new URLSearchParams(query);
    return tm.get("target") || null;
  } catch (_) {
    return null;
  }
}

function lmbParseExcerptDoc(content, sourcePath) {
  const entries = [];
  if (!content || typeof content !== "string") return entries;
  // v0.18：只把插件受控生成区编入索引，用户补充区里的 PDF 链接不会制造幽灵摘录。
  const generated = content.match(/<!--\s*LMB:BEGIN\s*-->([\s\S]*?)<!--\s*LMB:END\s*-->/i);
  // 词语备注是用户主动建立的独立条目，不能随 Canvas 同步重写的受控区一起被覆盖。
  // 因此它单独保存在文档尾部；索引时把两个区域合并读取。
  const wordNotes = content.match(/<!--\s*LMB:WORD-NOTES:BEGIN\s*-->([\s\S]*?)<!--\s*LMB:WORD-NOTES:END\s*-->/i);
  const manual = content.match(/<!--\s*LMB:MANUAL-EXCERPTS:BEGIN\s*-->([\s\S]*?)<!--\s*LMB:MANUAL-EXCERPTS:END\s*-->/i);
  if (generated) content = generated[1] + (manual ? "\n" + manual[1] : "") + (wordNotes ? "\n" + wordNotes[1] : "");
  // v0.20：摘录卡使用外层 lmb-excerpt callout。解析前只剥掉这一层视觉包装，
  // 内部原文、图片、评论和 ^ex 锚点仍按旧格式解析，存量文档完全兼容。
  content = lmbUnwrapExcerptCard(content);
  const lines = content.split(/\r?\n/);
  let pending = null;
  const flush = () => { if (pending) { entries.push(pending); pending = null; } };
  /* v0.16.6 P1-8：callout 区块内**整段**跳过，不只是首行。
   *   旧版只有 `if (/^\s*(?:>\s*)+\[!/.test(raw)) continue;` —— 只挡 `> [!xxx]` 标题行，
   *   于是「> 我的批注」这类 note 正文行会落进 5) 被收成摘录正文（索引里变成
   *   「原文 我的批注」），「> #误当标签」被收成假标签，note 里若含 [[y.pdf#page=3]]
   *   还会凭空开出一条幽灵摘录。
   *   状态位：遇 `[!` 首行置 true，遇非 `>` 行（空行 / 新块）复位。 */
  let inCalloutDepth = 0;
  let inLooseMirrorComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] || "";
    // 兼容已被旧同步逻辑污染的文档：外层摘录 Callout 解包后，原本与外层
    // 同级的 lmb-comment 会失去 `>`，变成普通 `[!lmb-comment]` 文本。
    if (/^\s*\[!lmb-comment\]/i.test(raw)) { inLooseMirrorComment = true; continue; }
    if (inLooseMirrorComment) {
      if (!/^\s*>/.test(raw)) continue;
      inLooseMirrorComment = false;
    }
    const quoteDepth = ((raw.match(/^\s*((?:>\s*)*)/) || ["", ""])[1].match(/>/g) || []).length;
    // 嵌套备注比摘录正文深一层；回到较浅的 ^ex 锚点时退出备注块。
    if (!/^\s*>/.test(raw) || (inCalloutDepth && quoteDepth < inCalloutDepth)) inCalloutDepth = 0;

    // Callout 必须先于链接解析处理，否则其正文中的 PDF 链接会生成幽灵摘录。
    if (/^\s*(?:>\s*)+\[!/.test(raw)) { inCalloutDepth = quoteDepth || 1; continue; }
    if (inCalloutDepth && EX_ID_RE.test(raw) && quoteDepth <= inCalloutDepth) inCalloutDepth = 0;
    if (inCalloutDepth && quoteDepth >= inCalloutDepth) continue;

    // 1) 回跳链接行 → 开新条目
    LMB_LINK_RE.lastIndex = 0;
    const lm = LMB_LINK_RE.exec(raw);
    if (lm) {
      flush();
      inCalloutDepth = 0;
      const sm = LMB_SEL_RE.exec((lm[3] || "").trim());
      const rm = LMB_RECT_RE.exec((lm[4] || "").trim());
      pending = {
        pdfPath: lm[1],
        page: parseInt(lm[2], 10),
        selection: sm ? [+sm[1], +sm[2], +sm[3], +sm[4]] : null,
        rect: rm ? [+rm[1], +rm[2], +rm[3], +rm[4]] : null,
        target: lmbParsePdfLinkTarget(raw),
        exId: null,
        tags: [],
        text: "",
        imagePath: null,
        sourceMd: sourcePath || null,
        line: i
      };
      continue;
    }
    if (!pending) continue;

    // 图片是摘录的媒体内容，不应作为 `![[附件.webp]]` 原样混进侧栏正文。
    const image = raw.match(/!\[\[([^\]|]+\.(?:webp|png|jpe?g))(?:\|[^\]]*)?\]\]/i);
    if (image) { pending.imagePath = image[1]; continue; }

    // 2) ^ex- 锚点 → 定稿
    const ex = EX_ID_RE.exec(raw);
    if (ex) {
      pending.exId = ex[0].replace(/^\^/, "");
      entries.push(pending);
      pending = null;
      continue;
    }
    // 3) 剥掉【所有】层 > 前缀后再判定
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

/* ==================== v0.12.0：引用行 📖 化（纯函数，可单测） ====================
 * 用户要求：卡片顶部引用/跳转行只显示一个 📖 符号，点击直接跳转；
 * 但摘录 md 镜像里保留完整【文件名-P.N】字样（md 要能独立阅读）。
 * 两头各一个纯函数：落卡时收拢、导出时还原。解析器（lmbParseExcerptDoc）
 * 只认 [[x.pdf#page=..]] 本体，不认显示名 → 两种形态都能解析，向后兼容旧卡。 */

/**
 * 把摘录回跳链接的显示名收拢成 📖：
 *   [[x.pdf#page=4&selection=0,0,6,7|【x-P.4】]] → [[x.pdf#page=4&selection=0,0,6,7|📖]]
 * 不是「以 | 显示名 ]] 结尾」的链接原样返回（防御：别把 embed/普通链接弄坏）。
 */
function lmbBookLink(link) {
  const s = String(link || "");
  const out = s.replace(/\|[^[\]]*\]\]$/, "|📖]]");
  return out === s ? s : out;   // 没匹配到就原样返回
}

/**
 * 导出摘录 md 时还原完整显示名：
 *   [[x.pdf#page=4&selection=..|📖]] → [[x.pdf#page=4&selection=..|【base-P.4】]]
 * page 为 null（未定位条目）时不还原（保留 📖，别写错页码）。
 * 整行处理（body 按行替换），没有 📖 的行零开销原样返回。
 */
function lmbRestoreRefDisplayName(line, base, page) {
  if (page == null || !line || line.indexOf("|📖]]") < 0) return line;
  const full = "【" + String(base || "") + "-P." + page + "】";
  return line.replace(/\|\s*📖\s*\]\]/g, "|" + full + "]]");
}

/* PDF ink geometry and sampling helpers. Kept DOM-free for deterministic tests. */

const LMB_INK_SCHEMA_VERSION = 2;
const LMB_INK_HISTORY_LIMIT = 100;

function lmbInkClamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function lmbInkClone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function lmbInkDistance(a, b) {
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
}

/**
 * iPad WKWebView does not always expose Apple Pencil through the same event
 * shape. Modern builds use PointerEvent(pointerType="pen"), while the iOS
 * compatibility path exposes Touch.touchType plus Pencil angle data.
 */
function lmbInkIsStylusInput(input) {
  if (!input) return false;
  const pointerType = String(input.pointerType || "").toLowerCase();
  const touchType = String(input.touchType || "").toLowerCase();
  if (pointerType === "pen" || touchType === "stylus" || touchType === "pencil") return true;
  if (pointerType === "mouse" || touchType === "direct") return false;
  // PointerEvent.altitudeAngle defaults to PI/2 even for ordinary fingers and
  // mice. Only legacy Touch without an explicit direct-touch type may use it.
  const altitude = Number(input.altitudeAngle);
  if (!pointerType && Number.isFinite(altitude) && altitude > 0) return true;
  const tiltX = Number(input.tiltX), tiltY = Number(input.tiltY);
  return pointerType === "touch" && ((Number.isFinite(tiltX) && tiltX !== 0) || (Number.isFinite(tiltY) && tiltY !== 0));
}

function lmbInkTouchPointEvent(touch, sourceEvent, ended) {
  return {
    pointerType: "pen", pointerId: `stylus-touch-${touch.identifier}`,
    button: 0, buttons: ended ? 0 : 1,
    clientX: touch.clientX, clientY: touch.clientY,
    pressure: Number(touch.force) > 0 ? Number(touch.force) : .5,
    timeStamp: sourceEvent && sourceEvent.timeStamp,
    preventDefault: () => { if (sourceEvent && sourceEvent.cancelable !== false) sourceEvent.preventDefault(); },
    stopPropagation: () => { if (sourceEvent) sourceEvent.stopPropagation(); }
  };
}

function lmbInkDistanceToSegment(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const length2 = dx * dx + dy * dy;
  if (!length2) return lmbInkDistance(point, start);
  const t = lmbInkClamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length2, 0, 1);
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function lmbInkBounds(object) {
  if (!object) return { x: 0, y: 0, w: 0, h: 0 };
  if (object.type === "pen" || object.type === "highlighter") {
    const points = Array.isArray(object.points) ? object.points : [];
    if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = points[0].x, maxX = minX, minY = points[0].y, maxY = minY;
    for (let i = 1; i < points.length; i++) {
      minX = Math.min(minX, points[i].x); maxX = Math.max(maxX, points[i].x);
      minY = Math.min(minY, points[i].y); maxY = Math.max(maxY, points[i].y);
    }
    const pad = object.widthUnit === "page" ? Math.max(0, Number(object.width) || 0) / 2 : 0;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  if (object.type === "text") return { x: object.x || 0, y: object.y || 0, w: object.w || .2, h: object.h || .05 };
  const pad = object.widthUnit === "page" ? Math.max(0, Number(object.width) || 0) / 2 : 0;
  return {
    x: Math.min(object.x1 || 0, object.x2 || 0) - pad, y: Math.min(object.y1 || 0, object.y2 || 0) - pad,
    w: Math.abs((object.x2 || 0) - (object.x1 || 0)) + pad * 2, h: Math.abs((object.y2 || 0) - (object.y1 || 0)) + pad * 2
  };
}

function lmbInkPointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    const crosses = ((a.y > point.y) !== (b.y > point.y))
      && point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-9) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function lmbInkObjectHit(object, point, tolerance) {
  if (!object) return false;
  const t = Math.max(.001, Number(tolerance) || .01)
    + (object.widthUnit === "page" ? Math.max(0, Number(object.width) || 0) / 2 : 0);
  if (object.type === "pen" || object.type === "highlighter") {
    const points = object.points || [];
    if (points.length === 1) return lmbInkDistance(point, points[0]) <= t;
    for (let i = 1; i < points.length; i++) {
      if (lmbInkDistanceToSegment(point, points[i - 1], points[i]) <= t) return true;
    }
    return false;
  }
  if (object.type === "line") return lmbInkDistanceToSegment(point,
    { x: object.x1, y: object.y1 }, { x: object.x2, y: object.y2 }) <= t;
  const bounds = lmbInkBounds(object);
  if (object.type === "rect") {
    const edges = [
      [{ x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y }],
      [{ x: bounds.x + bounds.w, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }],
      [{ x: bounds.x + bounds.w, y: bounds.y + bounds.h }, { x: bounds.x, y: bounds.y + bounds.h }],
      [{ x: bounds.x, y: bounds.y + bounds.h }, { x: bounds.x, y: bounds.y }]
    ];
    return edges.some((edge) => lmbInkDistanceToSegment(point, edge[0], edge[1]) <= t);
  }
  return point.x >= bounds.x - t && point.x <= bounds.x + bounds.w + t
    && point.y >= bounds.y - t && point.y <= bounds.y + bounds.h + t;
}

function lmbInkObjectsInLasso(objects, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return [];
  const polygonEdges = polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length]]);
  const intersects = (a, b, c, d) => {
    const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const onSegment = (p, q, r) => q.x >= Math.min(p.x, r.x) - 1e-9 && q.x <= Math.max(p.x, r.x) + 1e-9 && q.y >= Math.min(p.y, r.y) - 1e-9 && q.y <= Math.max(p.y, r.y) + 1e-9;
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    if (Math.abs(abC) < 1e-9 && onSegment(a, c, b)) return true;
    if (Math.abs(abD) < 1e-9 && onSegment(a, d, b)) return true;
    if (Math.abs(cdA) < 1e-9 && onSegment(c, a, d)) return true;
    if (Math.abs(cdB) < 1e-9 && onSegment(c, b, d)) return true;
    return Math.sign(abC) !== Math.sign(abD) && Math.sign(cdA) !== Math.sign(cdB);
  };
  return (objects || []).filter((object) => {
    const bounds = lmbInkBounds(object);
    const probes = [
      { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
      { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }
    ];
    if (probes.some((point) => lmbInkPointInPolygon(point, polygon))) return true;
    if (polygon.some((point) => point.x >= bounds.x && point.x <= bounds.x + bounds.w && point.y >= bounds.y && point.y <= bounds.y + bounds.h)) return true;
    let segments = [];
    if (object.type === "pen" || object.type === "highlighter") {
      const points = object.points || []; segments = points.slice(1).map((point, index) => [points[index], point]);
    } else if (object.type === "line") segments = [[{ x: object.x1, y: object.y1 }, { x: object.x2, y: object.y2 }]];
    else if (object.type === "rect") {
      const a = { x: bounds.x, y: bounds.y }, b = { x: bounds.x + bounds.w, y: bounds.y }, c = { x: bounds.x + bounds.w, y: bounds.y + bounds.h }, d = { x: bounds.x, y: bounds.y + bounds.h };
      segments = [[a, b], [b, c], [c, d], [d, a]];
    }
    return segments.some((segment) => polygonEdges.some((edge) => intersects(segment[0], segment[1], edge[0], edge[1])));
  });
}

function lmbInkNormalizePoint(point, previous) {
  const rawTime = Number(point.t), time = Number.isFinite(rawTime) ? rawTime : Date.now();
  const pressure = Number(point.p);
  return {
    x: lmbInkClamp(point.x, 0, 1), y: lmbInkClamp(point.y, 0, 1),
    p: pressure > 0 ? lmbInkClamp(pressure, .02, 1) : .5,
    t: previous && time <= previous.t ? previous.t + 1 : time
  };
}

function lmbInkAppendSamples(target, samples, minDistance) {
  const result = target || [];
  const threshold = Math.max(.00005, Number(minDistance) || .00035);
  for (const raw of samples || []) {
    const prior = result[result.length - 1];
    const point = lmbInkNormalizePoint(raw, prior);
    if (!prior || lmbInkDistance(prior, point) >= threshold || point.t - prior.t >= 12) result.push(point);
    else prior.p = (prior.p * 2 + point.p) / 3;
  }
  return result;
}

function lmbInkPerpendicularDistance(point, start, end) {
  return lmbInkDistanceToSegment(point, start, end);
}

function lmbInkSimplifyPoints(points, epsilon, pressureEpsilon) {
  if (!Array.isArray(points) || points.length <= 2) return (points || []).slice();
  let maxScore = 0, index = 0;
  const spatialLimit = Number(epsilon) || .00025, pressureLimit = Number(pressureEpsilon) || .06;
  const start = points[0], end = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const distance = lmbInkPerpendicularDistance(points[i], points[0], points[points.length - 1]);
    const ratio = i / (points.length - 1);
    const expectedPressure = (start.p == null ? .5 : start.p) + ((end.p == null ? .5 : end.p) - (start.p == null ? .5 : start.p)) * ratio;
    const pressureDelta = Math.abs((points[i].p == null ? .5 : points[i].p) - expectedPressure);
    const score = Math.max(distance / spatialLimit, pressureDelta / pressureLimit);
    if (score > maxScore) { index = i; maxScore = score; }
  }
  if (maxScore <= 1) return [points[0], points[points.length - 1]];
  const left = lmbInkSimplifyPoints(points.slice(0, index + 1), spatialLimit, pressureLimit);
  const right = lmbInkSimplifyPoints(points.slice(index), spatialLimit, pressureLimit);
  return left.slice(0, -1).concat(right);
}

function lmbInkBuildPatch(before, after) {
  const left = Array.isArray(before) ? before : [], right = Array.isArray(after) ? after : [];
  const beforeMap = new Map(left.map((object, index) => [object.id, { object, index }]));
  const afterMap = new Map(right.map((object, index) => [object.id, { object, index }]));
  const added = [], removed = [], modified = [];
  for (const [id, entry] of afterMap) {
    if (!beforeMap.has(id)) added.push({ index: entry.index, object: lmbInkClone(entry.object) });
    else if (JSON.stringify(beforeMap.get(id).object) !== JSON.stringify(entry.object)) {
      modified.push({ id, before: lmbInkClone(beforeMap.get(id).object), after: lmbInkClone(entry.object) });
    }
  }
  for (const [id, entry] of beforeMap) if (!afterMap.has(id)) removed.push({ index: entry.index, object: lmbInkClone(entry.object) });
  return { added, removed, modified };
}

function lmbInkApplyPatch(objects, patch, direction) {
  const result = lmbInkClone(objects || []), undo = direction === "undo";
  const removeEntries = undo ? patch.added : patch.removed;
  const insertEntries = undo ? patch.removed : patch.added;
  const removeIds = new Set((removeEntries || []).map((entry) => entry.object.id));
  for (let i = result.length - 1; i >= 0; i--) if (removeIds.has(result[i].id)) result.splice(i, 1);
  for (const change of patch.modified || []) {
    const index = result.findIndex((object) => object.id === change.id);
    if (index >= 0) result[index] = lmbInkClone(undo ? change.before : change.after);
  }
  for (const entry of (insertEntries || []).slice().sort((a, b) => a.index - b.index)) {
    const existing = result.findIndex((object) => object.id === entry.object.id);
    if (existing >= 0) result.splice(existing, 1);
    result.splice(Math.max(0, Math.min(result.length, entry.index)), 0, lmbInkClone(entry.object));
  }
  return result;
}

function lmbInkMergePages(older, newer) {
  const result = lmbInkClone(older && typeof older === "object" ? older : {});
  for (const [page, value] of Object.entries(newer && typeof newer === "object" ? newer : {})) {
    const newObjects = Array.isArray(value) ? value : value && Array.isArray(value.objects) ? value.objects : [];
    const oldValue = result[page], oldObjects = Array.isArray(oldValue) ? oldValue : oldValue && Array.isArray(oldValue.objects) ? oldValue.objects : [];
    const merged = oldObjects.map((object) => lmbInkClone(object));
    const positions = new Map(merged.map((object, index) => [object.id, index]));
    for (const object of newObjects) {
      if (object && object.id && positions.has(object.id)) merged[positions.get(object.id)] = lmbInkClone(object);
      else { if (object && object.id) positions.set(object.id, merged.length); merged.push(lmbInkClone(object)); }
    }
    result[page] = { objects: merged };
  }
  return result;
}

function lmbInkSegmentWidth(object, point, previous, pageWidth) {
  const base = object.widthUnit === "page"
    ? Math.max(.5, (Number(object.width) || .003) * pageWidth)
    : Math.max(.5, Number(object.width) || 3);
  if (object.pressureMode === "fixed" || object.type === "highlighter") return base;
  const pressure = lmbInkClamp(point && point.p || .5, .05, 1);
  const distance = previous ? lmbInkDistance(point, previous) * pageWidth : 0;
  const elapsed = previous ? Math.max(1, (point.t || 0) - (previous.t || 0)) : 16;
  const velocity = distance / elapsed;
  const speedFactor = lmbInkClamp(1.08 - velocity * .9, .72, 1.08);
  const pressureFactor = object.pressureMode === "fountain" ? .72 + pressure * .48 : .34 + pressure * 1.08;
  return Math.max(.45, base * pressureFactor * speedFactor);
}

function lmbInkFileKey(path) {
  let hash = 2166136261, hash2 = 2246822507;
  const value = String(path || "");
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
    hash2 ^= value.charCodeAt(i);
    hash2 = Math.imul(hash2, 3266489909);
  }
  const slug = value.split(/[\\/]/).pop().replace(/[^a-z0-9._-]+/gi, "-").slice(0, 48) || "document";
  return `${slug}-${(hash >>> 0).toString(36)}${(hash2 >>> 0).toString(36)}.json`;
}

// Clip each ink segment against a swept circular eraser in screen space. This
// handles sparse/fast strokes, non-square PDF pages and interpolated pressure.
function lmbInkEraseFragments(object, from, to, radius, width, height) {
  let points = object.points;
  if (object.type === "line") points = [{ x: object.x1, y: object.y1 }, { x: object.x2, y: object.y2 }];
  if (object.type === "rect") points = [
    { x: object.x1, y: object.y1 }, { x: object.x2, y: object.y1 },
    { x: object.x2, y: object.y2 }, { x: object.x1, y: object.y2 }, { x: object.x1, y: object.y1 }
  ];
  if (!points || !points.length) return null;
  const pixel = p => ({ x: p.x * width, y: p.y * height });
  const a = pixel(from), b = pixel(to), vx = b.x - a.x, vy = b.y - a.y, length = Math.hypot(vx, vy);
  const r = radius + (object.widthUnit === "page" ? (Number(object.width) || 0) * width : Number(object.width) || 0) * .75;
  const mix = (p, q, t) => {
    const result = { ...p, x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    for (const key of ["p", "t"]) if (Number.isFinite(p[key]) && Number.isFinite(q[key])) result[key] = p[key] + (q[key] - p[key]) * t;
    return result;
  };
  if (points.length === 1) return lmbInkDistanceToSegment(pixel(points[0]), a, b) <= r ? [] : null;
  const fragments = []; let run = [], changed = false;
  const flush = () => { if (run.length) fragments.push(run); run = []; };
  for (let i = 1; i < points.length; i++) {
    const p = pixel(points[i - 1]), q = pixel(points[i]), dx = q.x - p.x, dy = q.y - p.y, intervals = [];
    const circle = center => {
      const ox = p.x - center.x, oy = p.y - center.y, aa = dx * dx + dy * dy;
      if (aa < 1e-12) { if (ox * ox + oy * oy <= r * r) intervals.push([0, 1]); return; }
      const bb = 2 * (ox * dx + oy * dy), cc = ox * ox + oy * oy - r * r, disc = bb * bb - 4 * aa * cc;
      if (disc < 0) return;
      const lo = Math.max(0, (-bb - Math.sqrt(disc)) / (2 * aa)), hi = Math.min(1, (-bb + Math.sqrt(disc)) / (2 * aa));
      if (hi > lo + 1e-10) intervals.push([lo, hi]);
    };
    circle(a); circle(b);
    if (length > 1e-8) {
      let lo = 0, hi = 1;
      const clip = (value, delta, min, max) => {
        if (Math.abs(delta) < 1e-12) return value >= min && value <= max;
        const u = (min - value) / delta, v = (max - value) / delta;
        lo = Math.max(lo, Math.min(u, v)); hi = Math.min(hi, Math.max(u, v)); return hi > lo + 1e-10;
      };
      if (clip(((p.x - a.x) * vx + (p.y - a.y) * vy) / length, (dx * vx + dy * vy) / length, 0, length)
        && clip((-(p.x - a.x) * vy + (p.y - a.y) * vx) / length, (-dx * vy + dy * vx) / length, -r, r)) intervals.push([lo, hi]);
    }
    if (!intervals.length) { if (!run.length) run.push(points[i - 1]); run.push(points[i]); continue; }
    changed = true;
    intervals.sort((x, y) => x[0] - y[0]);
    let cursor = 0;
    for (const [lo, hi] of intervals) {
      if (lo > cursor + 1e-9) {
        if (!run.length) run.push(mix(points[i - 1], points[i], cursor));
        run.push(mix(points[i - 1], points[i], lo)); flush();
      } else flush();
      cursor = Math.max(cursor, hi);
    }
    if (cursor < 1 - 1e-9) run = [mix(points[i - 1], points[i], cursor), points[i]];
  }
  flush(); return changed ? fragments : null;
}

function lmbInkIsTextInput(target) {
  return !!(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "")
    || target.closest && target.closest('[contenteditable="true"],.cm-editor,.lmb-inline-note-editor')));
}

/* Stable references to editable ink; no copied stroke payloads in Canvas. */
function lmbInkGroupObjects(pages, group) {
  if (!group || !Array.isArray(group.objectIds)) return [];
  const value = pages && pages[String(group.page)], objects = Array.isArray(value) ? value : value && value.objects || [];
  const ids = new Set(group.objectIds);
  return objects.filter(object => ids.has(object.id) || (object.inkSourceIds || []).some(id => ids.has(id)));
}

function lmbInkGroupBounds(objects) {
  if (!objects || !objects.length) return null;
  const boxes = objects.map(lmbInkBounds);
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(.006, Math.max(...boxes.map(b => b.x + b.w)) - x), h: Math.max(.006, Math.max(...boxes.map(b => b.y + b.h)) - y) };
}

function lmbInkCanvasReference(text) {
  try {
    const match = /(?:^|\n)```marginbook-ink\s*\n([^]*?)\n```/.exec(String(text || ""));
    const value = match && JSON.parse(match[1]);
    return value && typeof value.ref === "string" && /^inkref-[a-z0-9-]+$/.test(value.ref) ? value.ref : null;
  } catch (_) { return null; }
}

/* Source ranges for paragraph-level live editing. Gaps stay in the source, so
 * switching blocks never rewrites whitespace, tables, fences or list markers. */
function lmbLiveMarkdownBlocks(value) {
  const text = String(value || ""), lines = [];
  let offset = 0;
  for (const raw of text.split("\n")) { lines.push({ text: raw, start: offset, end: offset + raw.length }); offset += raw.length + 1; }
  const blank = (i) => i >= lines.length || !lines[i].text.trim();
  const heading = (s) => /^ {0,3}#{1,6}(?:\s|$)/.test(s);
  const list = (s) => /^\s*(?:[-+*]|\d+[.)])\s+/.test(s);
  const quote = (s) => /^ {0,3}>/.test(s);
  const fence = (s) => /^ {0,3}(`{3,}|~{3,})/.exec(s);
  const rule = (s) => /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(s);
  const tableRule = (s) => /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(s);
  const table = (i) => i + 1 < lines.length && lines[i].text.includes("|") && tableRule(lines[i + 1].text);
  const math = (s) => /^\s*\$\$/.test(s);
  const special = (i) => heading(lines[i].text) || fence(lines[i].text) || list(lines[i].text) || quote(lines[i].text) || math(lines[i].text) || rule(lines[i].text) || table(i);
  const result = [];
  const add = (start, end, kind) => result.push({ start: lines[start].start, end: lines[end].end, kind, source: text.slice(lines[start].start, lines[end].end) });
  for (let i = 0; i < lines.length;) {
    if (blank(i)) { i++; continue; }
    const first = i, s = lines[i].text, match = fence(s);
    if (match) {
      const marker = match[1][0], count = match[1].length;
      for (i++; i < lines.length; i++) {
        const close = /^ {0,3}(`+|~+)\s*$/.exec(lines[i].text);
        if (close && close[1][0] === marker && close[1].length >= count) { i++; break; }
      }
      add(first, Math.min(i, lines.length) - 1, "code"); continue;
    }
    if (math(s)) {
      if (!/^\s*\$\$.+\$\$\s*$/.test(s)) {
        for (i++; i < lines.length && !/^\s*\$\$\s*$/.test(lines[i].text); i++) {}
        if (i < lines.length) i++;
      } else i++;
      add(first, Math.min(i, lines.length) - 1, "math"); continue;
    }
    if (table(i)) { for (i += 2; i < lines.length && !blank(i) && lines[i].text.includes("|"); i++) {} add(first, i - 1, "table"); continue; }
    if (heading(s) || rule(s)) { add(i, i, heading(s) ? "heading" : "rule"); i++; continue; }
    if (i + 1 < lines.length && /^\s*(?:=+|-+)\s*$/.test(lines[i + 1].text)) { add(i, i + 1, "heading"); i += 2; continue; }
    if (quote(s)) {
      for (i++; i < lines.length; i++) {
        if (quote(lines[i].text)) continue;
        if (blank(i) && i + 1 < lines.length && quote(lines[i + 1].text)) continue;
        break;
      }
      add(first, i - 1, "quote"); continue;
    }
    if (list(s) || /^(?: {4}|\t)/.test(s)) {
      const kind = list(s) ? "list" : "code";
      for (i++; i < lines.length; i++) {
        if (blank(i)) {
          let next = i + 1; while (next < lines.length && blank(next)) next++;
          if (next < lines.length && (list(lines[next].text) || /^(?: {2,}|\t)/.test(lines[next].text))) { i = next - 1; continue; }
          break;
        }
        if (heading(lines[i].text) || fence(lines[i].text) || quote(lines[i].text)) break;
      }
      add(first, i - 1, kind); continue;
    }
    for (i++; i < lines.length && !blank(i) && !special(i); i++) {}
    add(first, i - 1, "paragraph");
  }
  if (!result.length || /\n\s*$/.test(text)) result.push({ start: text.length, end: text.length, kind: "paragraph", source: "" });
  return result;
}

function lmbLiveBlockAt(parts, offset) {
  const containing = parts.findIndex((part) => part.start <= offset && offset <= part.end);
  if (containing >= 0) return containing;
  const next = parts.findIndex((part) => part.start > offset);
  return next >= 0 ? next : parts.length - 1;
}

function lmbLiveCaretOffset(source, nodeText, nodeOffset, precedingLength) {
  // A clicked text node normally occurs verbatim in the Markdown source. Pick
  // its closest occurrence, accounting for hidden heading/emphasis prefixes.
  const visible = (s) => s.replace(/^ {0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s*/gm, "").replace(/[*_`~]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  let best = -1, distance = Infinity;
  if (nodeText) for (let at = source.indexOf(nodeText); at >= 0; at = source.indexOf(nodeText, at + 1)) {
    const delta = Math.abs(visible(source.slice(0, at)).length - precedingLength);
    if (delta < distance) { best = at; distance = delta; }
  }
  return Math.max(0, Math.min(source.length, best < 0 ? precedingLength + nodeOffset : best + nodeOffset));
}

/* ============================================================
 * 25-pure-toolbar —— 工具栏注入的宿主解析 / DOM 缓存 / 显隐分级（纯函数层）
 * 修改注意：
 *   1. 本文件**不依赖 Obsidian API**（没有 require("obsidian")），DOM 一律从参数传入，
 *      只在参数上假设 querySelector / querySelectorAll / isConnected / style 四个鸭子类型成员，
 *      目的是能被 node 离线单测直接用 mock 调。
 *   2. 构建顺序由 build.config.js 显式声明，**顶层 const/function/class 共享同一 bundle 作用域**，
 *      所以所有导出名统一 lmb / LMB_ / Lmb 前缀，避免和别的片段撞名。
 *   3. LMB_VIEW_SPECS 是「判定 + 选择器」的**单一真相源**，禁止再拆出第二张判定表。
 * ============================================================ */

/* ==================== 视图规格表：判定与选择器同源 ====================
 * 背景：在 .pdf-toolbar（原生的 PDF 视图工具栏）里注入 3 个自定义按钮
 *       （图片框选 / 打开摘录 md / 打开专属 canvas）。
 *
 * 为什么要这张表：
 *   - 旧实现把 `.pdf-toolbar` 硬编码在注入函数里，将来支持别的视图只能加 if-else；
 *     现在改成「viewType → 宿主选择器」的映射，加新视图 = 加一行，注入函数不动。
 *   - viewType 就是 leaf.view.getViewType() 返回的那个字符串，拿它直接查表，
 *     **判定（这个视图要不要注入）和选择器（往哪儿注入）读的是同一条记录**。
 *
 * 教训（逆向 editing-toolbar v4.1.1 得来）：
 *   它把「判定表」和「选择器表」写成了两份数据，结果字符串不一致
 *   （一份写 meld-encrypted-view，另一份写 meld_encrypted_view），
 *   选择器表那条从此成了永远走不到的死代码。
 *   → **判定和选择器必须同源**：不要另建 VIEW_TYPES / ENABLED_VIEWS 之类的第二张表，
 *     也不要在别处写 `.pdf-toolbar` 字面量，要改就改这里。
 *
 * 字段：
 *   selector —— 工具栏宿主容器的 CSS 选择器（相对 leaf.containerEl 做 querySelector）
 *   enabled  —— 该视图类型是否默认允许注入（false = 查得到 spec 也直接拒绝）
 *   note     —— 一句话说明，给人看，不参与逻辑
 *
 * 扩展示例（将来加新视图只加一行，注入层零改动）：
 *   // image: { selector: ".image-container", enabled: false, note: "图片视图" },
 *   // canvas: { selector: ".canvas-wrapper", enabled: false, note: "白板视图" },
 *   （enabled: false 表示「已登记但先关着」，等注入逻辑验证通过再打开）
 */
const LMB_VIEW_SPECS = {
  pdf: { selector: ".pdf-toolbar", enabled: true, note: "完整 PDF 视图" },
  // image: { selector: ".image-container", enabled: false, note: "图片视图" },
  // canvas: { selector: ".canvas-wrapper", enabled: false, note: "白板视图" },
};

/**
 * 解析工具栏宿主锚点（三级判定，纯函数，绝不抛异常）。
 *
 * 调用点：workspace 的 layout-change / active-leaf-change 回调里。
 * 异常策略：**任何异常都吞掉**并返回 { el: null, source: null, spec: null }。
 * 因为在 Obsidian 的事件链里抛异常会打断后续回调，宁可这一帧不注入按钮，
 * 也不能把别人的事件处理拖挂（与全插件「宁可画得不准也不崩」的原则一致）。
 *
 * 三级判定顺序（**顺序不能改**）：
 *   1. 查表 LMB_VIEW_SPECS[viewType]
 *      - 查不到 spec，或 spec.enabled === false → 直接拒绝，返回 { el: null, source: null, spec: spec || null }
 *        （注意：查不到时 spec 为 null，查到但被禁用时仍要把 spec 带回去，方便调用方区分
 *         「未知视图」和「已登记但关闭」这两种情况）
 *      - 命中且 enabled → root.querySelector(spec.selector)，命中返回 { el, source: "spec", spec }
 *   2. 兜底：spec 存在但选择器没命中（Obsidian 换版本改了 DOM 结构 / 视图还没渲染完）
 *      → 找 .view-content，取它第一个直接子 div（:scope > div），有就用第一个，没有就用 .view-content 本身
 *      → 命中返回 { el, source: "fallback", spec }
 *   3. 都找不到 → { el: null, source: null, spec }
 *
 * @param {Object} root     容器元素（leaf.containerEl），鸭子类型：只需 querySelector / querySelectorAll
 * @param {string} viewType 视图类型（如 "pdf"）
 * @returns {{el: Object|null, source: "spec"|"fallback"|null, spec: Object|null}}
 */
function lmbResolveToolbarAnchor(root, viewType) {
  try {
    if (!root || typeof root.querySelector !== "function") {
      return { el: null, source: null, spec: null };
    }
    const spec = (viewType && Object.prototype.hasOwnProperty.call(LMB_VIEW_SPECS, viewType))
      ? LMB_VIEW_SPECS[viewType]
      : null;

    // 一级：未知视图 / 已登记但禁用 → 不注入
    if (!spec || spec.enabled === false) {
      return { el: null, source: null, spec: spec || null };
    }

    // 一级（续）：spec 选择器命中
    if (spec.selector) {
      const hit = root.querySelector(spec.selector);
      if (hit) return { el: hit, source: "spec", spec: spec };
    }

    // 二级：兜底 —— .view-content 的第一个直接子 div，否则 .view-content 本身
    const content = root.querySelector(".view-content");
    if (content) {
      let first = null;
      try {
        // :scope > div 在部分极简 mock 上可能不支持，单独兜一层
        if (typeof content.querySelectorAll === "function") {
          first = content.querySelectorAll(":scope > div")[0] || null;
        }
      } catch (e) {
        first = null;
      }
      if (first) return { el: first, source: "fallback", spec: spec };
      return { el: content, source: "fallback", spec: spec };
    }

    // 三级：都没有
    return { el: null, source: null, spec: spec };
  } catch (e) {
    return { el: null, source: null, spec: null };
  }
}

/* ==================== LmbDomCache：DOM 引用缓存 ====================
 * 动机：旧实现每次 layout-change / active-leaf-change 都对所有 PDF leaf 做全量
 *       querySelector，事件密集时是白白的重复开销。缓存住解析结果，命中就跳过查询。
 *
 * ⚠⚠ 关键警告：key 必须带 leaf 标识（leaf.id、或直接用 leaf.containerEl 本身），
 *    **每个 leaf 有自己独立的一份工具栏**，绝不能用 "pdfToolbar" 这种全局单例 key ——
 *    否则切到第二个 PDF leaf 时会拿到第一个 leaf 的节点，按钮注入到错误的窗口里。
 *    （这条是抄 editing-toolbar 时的连带教训：它自己就注明「top 样式不缓存，
 *      因为每个 leaf 都有独立的工具栏」，说明它踩过单例 key 的坑。）
 *
 * ⚠⚠ 第二个关键：get 必须用 el.isConnected 校验。
 *    元素被 Obsidian 从文档里移除后，引用还在、isConnected 变成 false，
 *    不校验就会拿到游离节点（往里塞按钮 = 用户永远看不到，且不报错，极难排查）。
 *    命中但已游离时：删掉该条缓存并返回 null，让调用方重新解析。
 */
class LmbDomCache {
  constructor() {
    this._map = new Map();
  }

  /**
   * 取缓存。命中且 el.isConnected 为真才返回；否则删掉该条返回 null。
   * @param {*} key
   * @returns {Object|null}
   */
  get(key) {
    const el = this._map.get(key);
    if (el == null) return null;
    // 游离节点（已被 Obsidian 移除）视为缓存失效
    if (el.isConnected === false) {
      this._map.delete(key);
      return null;
    }
    return el;
  }

  /**
   * 写缓存。el 为空时不写（顺手删掉旧值，避免残留脏条目）。
   * @param {*} key
   * @param {Object} el
   */
  set(key, el) {
    if (el == null) {
      this._map.delete(key);
      return;
    }
    this._map.set(key, el);
  }

  /** 删单条 */
  delete(key) {
    this._map.delete(key);
  }

  /** 清空全部 */
  clear() {
    this._map.clear();
  }

  /**
   * 遍历清理所有已游离（isConnected === false）的条目。
   * 建议在 leaf 关闭 / 批量注入前调一次，防止 Map 无限增长。
   * @returns {number} 清理掉的条数
   */
  prune() {
    let n = 0;
    for (const [key, el] of Array.from(this._map.entries())) {
      if (!el || el.isConnected === false) {
        this._map.delete(key);
        n++;
      }
    }
    return n;
  }

  /** 当前条目数 */
  get size() {
    return this._map.size;
  }
}

/**
 * 工具栏显隐分级（纯函数，绝不抛异常）。
 *
 * 为什么分两级隐藏（这是本函数存在的全部理由）：
 *   - display:none  → 元素彻底离开渲染树、**不再占空间**，
 *     重新显示时周围原生按钮会重排，肉眼可见地跳动一下。
 *     适合「持久态」：比如用户在设置里把本插件全局关了，短期不会再开。
 *   - visibility:hidden → 元素保留占位、只是看不见，
 *     来回切换零抖动。适合「临时态」：比如当前视图类型不允许注入、
 *     切回来马上又要显示，用这个就不会跳。
 *
 * 对应关系（调用方按语义选，别混用）：
 *   "show"          → 可见（visibility:visible + display 清空）
 *   "hideKeepSpace" → 隐藏但保留占位（临时态：视图类型不允许等）
 *   "hideRemove"    → 隐藏且彻底移出渲染树（持久态：全局关闭）
 *
 * @param {Object} el
 * @param {"show"|"hideKeepSpace"|"hideRemove"} mode
 * @returns {boolean} 是否成功（el 为空 / mode 未知 / 抛异常 → false，且尽量不动 DOM）
 */
function lmbSetToolbarVisibility(el, mode) {
  if (!el) return false;
  try {
    const st = el.style;
    if (!st) return false;
    if (mode === "show") {
      st.visibility = "visible";
      st.display = "";
      return true;
    }
    if (mode === "hideKeepSpace") {
      st.visibility = "hidden";
      st.display = "";
      return true;
    }
    if (mode === "hideRemove") {
      st.display = "none";
      return true;
    }
    // 未知 mode：不动 DOM
    return false;
  } catch (e) {
    return false;
  }
}

/* ---- 测试钩子：node 离线单测直接 require 本文件即可拿到；
 *      拼接进 main.js 后 module 依然存在于 CommonJS 作用域，钩子同样有效。 ---- */
if (typeof module !== "undefined" && module.exports) {
  module.exports.__lmbToolbar = {
    LMB_VIEW_SPECS, lmbResolveToolbarAnchor, LmbDomCache, lmbSetToolbarVisibility,
  };
}

/* ============================================================
 * 26-pure-canvasbar —— canvas 卡片悬浮操作栏的纯计算层
 *   （坐标换算 / 按钮可用性判定 / 轮询指纹）
 * 修改注意：
 *   1. 本文件**不依赖 Obsidian API**（没有 require("obsidian")）。坐标一律是视口坐标
 *      （就是 getBoundingClientRect() 返回的那种），入参只用 plain object / string /
 *      number，**不要期待传进来的是真 DOM 元素**（离线单测传的是 mock）。
 *   2. 构建顺序由 build.config.js 显式声明，**顶层 const/function/class 共享同一 bundle
 *      作用域**，所以所有导出名统一 lmb / LMB_ 前缀，避免和别的片段撞名。
 *   3. 本层只出「算什么、往哪放、哪些按钮能点」的结论，**不碰 DOM、不读 canvas 实例**。
 *      真正的 DOM 挂载与事件绑定在 37-plugin-canvasbar.js（并行开发中）。
 *   4. 三个函数**一律吞异常、绝不 throw**：它们跑在低频 setInterval 里，
 *      抛一次就会打断整个轮询链（后续帧全没了），宁可这一帧画错位置也不能崩。
 * ============================================================ */

/* ==================== 悬浮栏基础常量 ====================
 * 三个功能（评论 / 跳转 / 切换视图）在 v0.11.0 ~ v0.11.3 都已实现，
 * 本文件只是把入口从「卡内」搬到「卡片上方的悬浮栏」，不新增业务逻辑。
 */
const LMB_BAR_POLL_MS = 800;      // 事件驱动后的低频兜底轮询（ms）
const LMB_BAR_GAP = 8;            // 悬浮栏与卡片边缘的间距（px）
const LMB_BAR_MARGIN = 4;         // 贴边时的安全留白（px）
const LMB_BAR_SEL = ".lmb-canvas-bar";  // 悬浮栏容器 class

// v0.13.8：悬浮栏**结构版本**。改浮动栏的按钮组成 / 事件绑定方式时**必须 +1**。
//   为什么需要它：重载插件时 Obsidian 只重新执行插件 JS，**workspace layout 与 canvas
//   leaf 的 DOM 不会重建**。而 lmbEnsureCanvasBarEl 是靠 className 幂等复用浮层的 ——
//   于是"旧版本创建的那颗浮层"会被新代码一直复用，它的按钮绑的是**旧版 click 回调**
//   （例如 v0.13.4 的 fit 按钮绑的是 `if (!c) return` 静默版）。
//   表现极其迷惑：代码明明改了、也重载了，行为却是老样子。
//   加版本号后，版本不匹配的浮层会被移除重建，保证用户手上的永远是"当前代码造的"浮层。
const LMB_BAR_VERSION = "v0.25.5";

/* LMB_BAR_POLL_MS 为什么是 800ms：
 *   - canvas **没有原生「选中变化」事件**。advanced-canvas 插件那个 `selection-changed`
 *     不是 Obsidian 原生 API，是它自己 monkey-patch canvas 内部方法造出来的；
 *     我们不依赖 advanced-canvas，所以只能轮询。
 *   - pointerup、active-leaf-change 已负责立即刷新；800ms 只兜底宿主未暴露的选中、平移与缩放变动，
 *     将常驻检查从每秒约 8 次降到约 1 次。
 *   - **一次轮询同时解决两件事**，这是选轮询而非监听的额外收益：
 *       ① 选中变化 → 要**重建按钮**（不同卡片能点的按钮不一样，见 lmbPickBarActions）
 *       ② 视口平移/缩放 → 要**重算位置**（卡片在屏幕上的位置变了，浮层要跟着走）
 *     监听方案得同时挂 selection-changed + 平移 + 缩放三套事件，还容易漏；
 *     轮询一个定时器全包，逻辑只有一条路径。
 */

/* ---- 内部小工具：取有限数，非数字/NaN/Infinity 一律退回默认值 ----
 * 名字带 lmb 前缀（拼接作用域要求），不导出到 __test。 */
function lmbBarNum(v, dflt) {
  const n = (typeof v === "number") ? v : parseFloat(v);
  return (typeof n === "number" && isFinite(n)) ? n : dflt;
}

/* ---- 内部小工具：格式化指纹里的浮点数，固定 2 位小数 ---- */
function lmbBarFix2(v) {
  return lmbBarNum(v, 0).toFixed(2);
}

/**
 * 计算悬浮栏在挂载容器内的位置（纯函数，绝不抛异常）。
 *
 * ==================== 为什么浮层要挂在 wrapper 上，而不是卡片上 ====================
 * 实测 Obsidian canvas typings + 翻 DOM 得出的结论（写下来免得后人再踩一遍）：
 *   - canvas 的缩放 `transform: scale(...)` 是加在 **`.canvas`** 元素上的；
 *   - 而 `canvas.wrapperEl`（即 **`.canvas-wrapper`**）是 `.canvas` 的**父级**，
 *     它自己**不参与**这个 scale 变换。
 * 所以浮层挂到卡片（`.canvas-node`）里的话，按钮会跟着画布一起被缩放：
 * 用户把画布缩到 30%，按钮就变成蚂蚁大小点不中；放大到 300%，按钮又蠢大。
 * 挂在 wrapperEl 上，浮层的 px 尺寸恒定，**按钮大小永远不变**，
 * 代价只是每帧要把卡片 rect 换算成 wrapper 内相对坐标（本函数干的就是这件事）。
 * ===============================================================================
 *
 * 算法（顺序不能改）：
 *   1. 坐标系换算：nodeRect / wrapperRect 都在视口坐标系，
 *      浮层要定位在 wrapper 内部（position:absolute 相对 wrapper），故：
 *          relLeft = nodeRect.left  - wrapperRect.left
 *          relTop  = nodeRect.top   - wrapperRect.top
 *   2. 默认放卡片正上方、水平居中：
 *          left = relLeft + (nodeRect.width - barSize.width) / 2
 *          top  = relTop - barSize.height - gap
 *          placement = "top"
 *   3. 上方空间不够（top < margin，说明卡片已经贴着 wrapper 顶边，
 *      浮层会被裁掉看不见）→ 翻到卡片下方：
 *          top = relTop + nodeRect.height + gap
 *          placement = "bottom"
 *      （只翻一次，不做二次钳制：翻下去还溢出说明 wrapper 本身矮得离谱，
 *        这时让用户自己滚动画布更合理，硬塞反而更怪。）
 *   4. 左右钳制到 [margin, wrapperRect.width - barSize.width - margin]。
 *      ⚠ 边界：当 `wrapperRect.width - barSize.width - margin < margin`
 *      （浮层比容器还宽的极端情况），区间左右端点是**颠倒**的，
 *      直接 Math.min/Math.max 会算出负数上界。此时**直接取 margin**，
 *      宁可右边溢出一点，也不要给出负 left（负 left 在视觉上等于"凭空消失"，极难查）。
 *   5. 返回值 Math.round 取整：亚像素坐标会让文字渲染走灰度抗锯齿，看着发虚。
 *
 * 异常策略：nodeRect / wrapperRect / barSize 任一为 null、字段缺失、值为 NaN
 *   → 一律返回 { left: 0, top: 0, placement: "top" }，绝不抛异常。
 *
 * @param {{left:number, top:number, width:number, height:number}} nodeRect     卡片元素的视口 rect
 * @param {{left:number, top:number, width:number, height:number}} wrapperRect  挂载容器（canvas.wrapperEl 或 .canvas-wrapper）的视口 rect
 * @param {{width:number, height:number}} barSize  悬浮栏自身尺寸
 * @param {{gap?:number, margin?:number}} [opts]   可选；不传用 LMB_BAR_GAP / LMB_BAR_MARGIN
 * @returns {{left:number, top:number, placement:"left"|"right"}} placement：
 *   "left" = 卡片左边缘外侧（默认）、"right" = 左边不足时放到右边缘外侧
 */
function lmbCalcBarPos(nodeRect, wrapperRect, barSize, opts) {
  try {
    const gap = lmbBarNum(opts && opts.gap, LMB_BAR_GAP);
    const margin = lmbBarNum(opts && opts.margin, LMB_BAR_MARGIN);

    const nodeLeft = lmbBarNum(nodeRect && nodeRect.left, NaN);
    const nodeTop = lmbBarNum(nodeRect && nodeRect.top, NaN);
    const nodeW = lmbBarNum(nodeRect && nodeRect.width, NaN);
    const nodeH = lmbBarNum(nodeRect && nodeRect.height, NaN);
    const wrapLeft = lmbBarNum(wrapperRect && wrapperRect.left, NaN);
    const wrapTop = lmbBarNum(wrapperRect && wrapperRect.top, NaN);
    const wrapW = lmbBarNum(wrapperRect && wrapperRect.width, NaN);
    const wrapH = lmbBarNum(wrapperRect && wrapperRect.height, NaN);   // v0.13.2：竖排后浮层变高，需要 top 钳制
    const barW = lmbBarNum(barSize && barSize.width, NaN);
    const barH = lmbBarNum(barSize && barSize.height, NaN);

    // 缺字段 / NaN 一律走兜底（NaN 会让下面的比较全为 false，静默算出错误坐标）
    if (!isFinite(nodeLeft) || !isFinite(nodeTop) || !isFinite(nodeW) || !isFinite(nodeH)
      || !isFinite(wrapLeft) || !isFinite(wrapTop) || !isFinite(wrapW) || !isFinite(wrapH)
      || !isFinite(barW) || !isFinite(barH)) {
      return { left: 0, top: 0, placement: "left" };
    }

    // 1. 视口坐标 → wrapper 内相对坐标
    const relLeft = nodeLeft - wrapLeft;
    const relTop = nodeTop - wrapTop;

    // iPad 使用横向工具栏，放在卡片下方；桌面继续使用左侧竖排。
    if (opts && opts.mobile) {
      let mobileLeft = relLeft + (nodeW - barW) / 2;
      let mobileTop = relTop + nodeH + gap;
      let mobilePlacement = "bottom";
      if (mobileTop + barH > wrapH - margin) {
        mobileTop = relTop - barH - gap;
        mobilePlacement = "top";
      }
      const mobileMaxLeft = wrapW - barW - margin;
      mobileLeft = mobileMaxLeft < margin ? margin : Math.max(margin, Math.min(mobileMaxLeft, mobileLeft));
      mobileTop = Math.max(margin, Math.min(Math.max(margin, wrapH - barH - margin), mobileTop));
      return { left: Math.round(mobileLeft), top: Math.round(mobileTop), placement: mobilePlacement };
    }

    // 2. v0.13.2：默认贴在卡片**左侧**（竖排，顶端对齐卡片顶端）
    //    上一版是「卡片上边缘外侧」，用户反馈贴左更顺手、视觉上更像"卡片的"工具栏。
    let left = relLeft - barW - gap;
    let top = relTop;
    let placement = "left";

    // 3. 左侧放不下 → 翻到卡片**右侧外边**。绝不先塞进卡片内部，避免首次
    //    测量与下一帧测量之间出现“栏从卡片里跳出去”的闪动。
    if (left < margin) {
      left = relLeft + nodeW + gap;
      placement = "right";
    }

    // 4. 左右钳制（含「浮层比容器还宽」的颠倒区间边界）
    const maxLeft = wrapW - barW - margin;
    if (maxLeft < margin) {
      left = margin;              // 区间无效，贴左留白，不要算出负数
    } else if (left < margin) {
      left = margin;
    } else if (left > maxLeft) {
      left = maxLeft;
    }

    // 5. 上下钳制（v0.13.2 竖排后浮层高度可达 86px，wrapper 可能放不下）
    const maxTop = wrapH - barH - margin;
    if (maxTop < margin) {
      top = margin;
    } else if (top < margin) {
      top = margin;
    } else if (top > maxTop) {
      top = maxTop;
    }

    // 6. 取整
    return { left: Math.round(left), top: Math.round(top), placement: placement };
  } catch (e) {
    return { left: 0, top: 0, placement: "left" };
  }
}

/* ==================== 按钮可用性判定用的两条正则 ====================
 * 为什么要自己写、不直接复用 LMB_LINK_RE（10-constants.js）：
 *   LMB_LINK_RE 是给「解析出 page=/selection=/rect= 参数」用的，捕获组只抓了文件名，
 *   而本函数要的正好相反 —— **只要链接正文的壳，不要里面的参数**。
 *   另外它是 /g 正则、共享模块作用域，复用要手动管 lastIndex，容易出事故
 *   （32-plugin-canvas.js 就为此写过 lastIndex = 0 的补丁注释）。
 *   所以这里另写一条**只做「找出来 + 剥壳」**的正则，判定标准仍与 LMB_LINK_RE
 *   保持一致（必须 .pdf#page=数字），避免两处对「什么算 pdf 链接」的理解漂移。
 *
 * ⚠⚠ 明确职责边界：本函数**只剥壳、绝不解析 page=/selection= 参数**。
 *   参数解析是 lmbParsePdfLink() 的活（src/36-plugin-jump.js）。
 *   在这里重复实现一次，等于把同一份规则抄成两份，将来改格式必漂。
 *   调用方拿到 lmbPickBarActions().jump 后，直接丢给 lmbParsePdfLink() 即可。
 */
// 扫描用：抓出所有 [[...]] 的完整内层；match(/g) 内部会自重置 lastIndex，可安全复用
const LMB_BAR_WIKILINK_RE = /\[\[([^\]\n]*)\]\]/g;
// 判定用：这一段算不算「pdf 链接」（宽松版，与 LMB_LINK_RE 的核心特征对齐）
const LMB_BAR_PDF_HINT_RE = /\.pdf#page=\d+/i;
// 截图 embed：![[xxx.webp]] / ![[xxx.webp|400]]（v0.16.0：双重卡判定的「有图」半边）
const LMB_BAR_EMBED_RE = /!\[\[[^\]\n]+\]\]/;
// 双重摘录卡的视图切换标记：> [!lmb-view] 或 > [!lmb-view]-（宽松容忍多个空格 / 折叠符 / 行尾）
//   v0.16.0：lmbPickBarActions 的 view 判定**已不再使用它**（新卡不写这行了，见下）。
//   保留正则只为存量卡 / 兼容期排查，新代码不要依赖它。
const LMB_BAR_VIEW_RE = /^[ \t]*>[ \t]*\[!lmb-view\][ \t]*(?:[+-][ \t]*)?(?:$|\s)/m;

/**
 * 按卡片内容决定悬浮栏显示哪些按钮（纯函数，绝不抛异常）。
 *
 * 为什么要按内容动态判定：
 *   三个按钮**不是每张卡都适用**。无脑全显示的话，会出现点了没反应的死按钮
 *   （比如纯截图卡没有文字引用块，点「跳转」根本无处可跳），
 *   用户会以为插件坏了。宁可少显示，也不要死按钮。
 *
 * 判定规则：
 *   comment —— 卡片是**文本节点**就能加评论。判据：nodeText 是非空字符串（trim 后非空）。
 *   jump    —— 卡片里有 pdf 引用行才能跳回 PDF。引用行形如
 *              `> [[某文件.pdf#page=12&selection=1,2,3,4|📖]]`
 *              （`|` 后是显示别名，v0.12.0 起收拢成一个 📖 图标；也可能是别的别名，
 *                也可能干脆没有别名 —— 三种都要认）。
 *              取**第一个**命中的 pdf 链接（同一张卡可能有多个 = 多重摘录），
 *              返回**不含 [[]] 包裹、且剥掉 |别名 的链接正文**，如
 *              `"某文件.pdf#page=12&selection=1,2,3,4"`；找不到返回 null。
 *              链接不会跨行（canvas text 节点里一行就是一个引用块），故逐行扫描足够。
 *   view    —— 只有「双重摘录卡」（文字引用块 + 截图同时在卡里）才有切换视图按钮。
 *              v0.16.0 判定改版：= **同时含「PDF 引用行」+「截图 embed」**。
 *              旧版（v0.13.0~v0.15.0）靠卡里那行 `> [!lmb-view]` callout 当标记；
 *              v0.16.0 起新卡不再写这行（卡片精简 v2：用户要求卡内不放控件），
 *              若判定仍依赖它 → 新双重卡的「视图」按钮永远不显示 = 功能静默消失。
 *              所以改为按**内容**判定：有 pdf 引用行（jump 命中）+ 有 ![[xxx.webp]] embed。
 *              副作用是好的：老卡（markdown 里还留着 lmb-view 行）同样满足这两个条件，
 *              判定结果一致 → **新老卡零迁移、行为统一**。
 *
 * @param {string} nodeText  卡片的 markdown 文本（canvas text 节点的 text 字段）
 * @returns {{comment:boolean, jump:string|null, view:boolean, fit:boolean}}
 */
function lmbPickBarActions(nodeText) {
  try {
    const hasText = (typeof nodeText === "string") && nodeText.trim() !== "";
    // comment：文本节点就能加评论（与卡片有没有 pdf 链接无关）
    const comment = hasText;
    // v0.16.0：截图 embed（双重卡的「有图」半边；判据与 callout 无关）
    const hasEmbed = hasText && LMB_BAR_EMBED_RE.test(nodeText);

    let jump = null;
    if (hasText) {
      const hits = nodeText.match(LMB_BAR_WIKILINK_RE);   // /g 的 match 返回全部匹配，不污染 lastIndex
      if (hits && hits.length) {
        for (let i = 0; i < hits.length; i++) {
          const raw = hits[i];
          // 剥掉外层 [[ ]]
          const inner = raw.slice(2, raw.length - 2);
          // 剥掉 |别名（只按第一个 | 切；链接正文里不会出现 |）
          const pipe = inner.indexOf("|");
          const body = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
          if (body !== "" && LMB_BAR_PDF_HINT_RE.test(body)) {
            jump = body;
            break;                                        // 多重摘录取第一个
          }
        }
      }
    }

    // v0.16.0：view = 有截图 embed **且** 有 pdf 引用行（两者同时满足才算双重摘录卡）
    const view = hasEmbed && (jump !== null);
    // v0.13.3：fit = 自适应高度。文本节点都能调（lmbFitNodeById 内部判断 node.type）
    const fit = hasText;
    return { comment: comment, jump: jump, view: view, fit: fit, color: hasText && EX_ID_RE.test(nodeText), disconnect: false };
  } catch (e) {
    return { comment: false, jump: null, view: false, fit: false, color: false, disconnect: false };
  }
}

/** 决定断线行为：优先父边；否则单边直删，多边选择。 */
function lmbPlanDisconnect(nodeId, edges, autoEdgeIds) {
  try {
    const all = Array.isArray(edges) ? edges : [];
    const auto = autoEdgeIds instanceof Set ? autoEdgeIds : new Set(autoEdgeIds || []);
    const incident = all.filter((e) => e && e.id
      && (e.fromNode === nodeId || e.toNode === nodeId));
    if (!incident.length) return { kind: "none", candidates: [] };
    const parentEdges = incident.filter((e) => e.toNode === nodeId && auto.has(e.id));
    if (parentEdges.length) {
      return { kind: "direct", edgeId: parentEdges[0].id, candidates: incident, reason: "parent" };
    }
    if (incident.length === 1) {
      return { kind: "direct", edgeId: incident[0].id, candidates: incident, reason: "only" };
    }
    return { kind: "choose", candidates: incident };
  } catch (_) { return { kind: "none", candidates: [] }; }
}

/**
 * 生成轮询指纹（纯函数，绝不抛异常）。
 *
 * 用途：兜底轮询执行时，**绝大多数轮次什么都没变**（用户只是盯着看 / 在打字）。
 * 用指纹比对决定这一轮要不要**重建按钮**。
 *
 * 为什么「位置每轮都重算」而「按钮只在指纹变化时才重建」：
 *   - 位置：拖动卡片 / 平移画布时位置一直在变，而且 getBoundingClientRect()
 *     本身很便宜（一次布局读取），每轮算一遍完全扛得住，还能保证浮层严丝合缝跟手。
 *   - 按钮：重建是要**动 DOM** 的（清掉旧按钮、新建、绑事件、setIcon），
 *     比算坐标贵一两个数量级；而且选中没变时重建出来的一模一样，纯属白干
 *     （还会把正在 hover / 按下的按钮状态打断）。所以只在指纹变了才重建。
 *
 * 两个必须注意的细节：
 *   - nodeIds **先排序再拼接**：选中的遍历顺序（Map/Set 的插入顺序）不保证稳定，
 *     不排序的话「同一组选中」会因为顺序不同算出不同指纹，白重建一整轮。
 *   - viewport 的 x/y/zoom **保留 2 位小数**：平移缩放会产生 -20.000000000000004
 *     这种浮点毛刺，不截断的话指纹每帧都变，等于指纹机制完全失效。
 *
 * 格式：`"id1,id2|100.50,-20.00,0.80"`（节点段 + "|" + 视口段）
 *   空数组 → 节点段为空串，视口段照常输出，如 `"|100.50,-20.00,0.80"`
 *
 * @param {string[]} nodeIds   当前选中的节点 id 数组（顺序无关）
 * @param {{x:number, y:number, zoom:number}} viewport  canvas 视口状态
 * @returns {string}  指纹字符串；与本轮指纹相同则可跳过重建
 */
function lmbBarSignature(nodeIds, viewport) {
  try {
    // 节点段：排序后拼接（顺序无关）
    const ids = (nodeIds && typeof nodeIds.length === "number")
      ? Array.prototype.slice.call(nodeIds, 0)
      : [];
    const sorted = ids
      .map(function (id) { return (id == null) ? "" : String(id); })
      .sort();

    // 视口段：非数字一律按 0 处理（viewport 传 null 不该让指纹机制整个废掉）
    // 工具栏动作只由选中节点决定；平移/缩放只影响位置，不能触发按钮状态重建。
    // 保留 viewport 参数以兼容旧调用方，但故意不再写进指纹。
    return sorted.join(",");
  } catch (e) {
    return "";
  }
}

/* ---- 测试钩子：node 离线单测直接 require 本文件即可拿到；
 *      拼接进 main.js 后 module 依然存在于 CommonJS 作用域，钩子同样有效。 ---- */
if (typeof module !== "undefined" && module.exports) {
  module.exports.__lmbCanvasBar = {
    LMB_BAR_POLL_MS, LMB_BAR_GAP, LMB_BAR_MARGIN, LMB_BAR_SEL,
    lmbCalcBarPos, lmbPickBarActions, lmbBarSignature,
  };
}

/* core/runtime-state — owns mutable, session-scoped plugin state */

class LmbRuntimeState {
  constructor() {
    this.syncTimers = new Map();
    this.selfWritten = new Map();
    this.autoSize = new Map();
    this.imgDims = new Map();
    this.canvasPositions = new Map();
    this.autoEdges = new Map();
    this.nodeMeta = new Map();
    this.excerptIndex = new Map();
    this.indexMtime = new Map();
    this.excerptCanvasIndex = new Map();
    this.relatedCache = new Map();
  }

  /**
   * Expose stable compatibility aliases while controllers are incrementally
   * migrated away from direct fields on the Obsidian Plugin instance.
   */
  attach(plugin) {
    for (const key of Object.keys(this)) plugin[key] = this[key];
    return this;
  }
}

/* core/settings-store — defaults, migrations, and persistence shape */

const LMB_DEFAULT_SETTINGS = Object.freeze({
  debug: false,
  colorMap: "",
  noteCalloutType: "ppd-note",
  noteTitle: "补充描述",
  noteFoldByDefault: false,
  noteIntoSync: false,
  noteAutoBoxOnNew: false,
  commentAutoBoxOnNew: false,
  excerptCardWidth: 560,
  autoAttachScreenshot: true,
  excerptImageFolder: "附件/{pdf}",
  storageLayout: "central",
  storageRoot: "Lucia's Marginbook",
  pdfSourceRoot: "Books/pdf书籍",
  storageBindings: {},
  imageExcerptMarkStyle: "dashed",
  autoCleanOnDelete: true,
  moveDescendantsWithParent: false,
  nodeViews: {},
  excerptViews: {},
  quickExcerpts: {},
  pdfTextBlocks: {},
  excerptColors: {},
  notePlaceholderOffMigrated: false,
  commentBoxOffMigrated: false,
  naturalHeightV2Migrated: false,
  overflowHeightVerifiedMigrated: false,
  managedExcerptAssetsV1Migrated: false,
  inkSidecarV2Migrated: false,
  inkInputMode: "pen-mouse",
  inkPressureMode: "natural",
  inkLastTool: "pen",
  inkPenColor: "#e05252",
  inkPenWidth: 3,
  inkHighlighterColor: "#ffd84d",
  inkHighlighterWidth: 12,
  inkEraserSize: 18,
  inkEraserMode: "partial",
  inkEraserAutoReturn: true,
  inkToolbarCollapsed: false,
  inkAnnotations: {},
  inkExcerptLinks: {},
  inkLinkCounters: {}
});

class LmbSettingsStore {
  constructor(plugin) {
    this.plugin = plugin;
  }

  async load() {
    const saved = await this.plugin.loadData();
    const settings = Object.assign({}, LMB_DEFAULT_SETTINGS, saved);
    // Existing vaults retain their paths until an explicit, backed-up migration.
    if (saved && Object.keys(saved).length && !saved.storageLayout) settings.storageLayout = "legacy";
    let migrated = false;
    if (!settings.notePlaceholderOffMigrated) {
      settings.noteAutoBoxOnNew = false;
      settings.notePlaceholderOffMigrated = true;
      migrated = true;
    }
    if (!settings.commentBoxOffMigrated) {
      settings.commentAutoBoxOnNew = false;
      settings.commentBoxOffMigrated = true;
      migrated = true;
    }
    if (!settings.managedExcerptAssetsV1Migrated) {
      settings.excerptImageFolder = settings.excerptImageFolder || "附件/{pdf}";
      settings.autoCleanOnDelete = true;
      settings.managedExcerptAssetsV1Migrated = true;
      migrated = true;
    }
    return { settings, migrated };
  }

  serialize(settings, state) {
    const obj = {
      debug: !!settings.debug,
      recallDefault: !!settings.recallDefault,
      colorMap: settings.colorMap,
      noteCalloutType: settings.noteCalloutType,
      noteTitle: settings.noteTitle,
      noteFoldByDefault: !!settings.noteFoldByDefault,
      noteIntoSync: !!settings.noteIntoSync,
      noteAutoBoxOnNew: settings.noteAutoBoxOnNew !== false,
      commentAutoBoxOnNew: settings.commentAutoBoxOnNew === true,
      excerptCardWidth: Math.max(320, Math.min(800, Number(settings.excerptCardWidth) || 560)),
      autoAttachScreenshot: settings.autoAttachScreenshot !== false,
      excerptImageFolder: String(settings.excerptImageFolder || "附件/{pdf}"),
      storageLayout: settings.storageLayout === "central" ? "central" : "legacy",
      storageRoot: String(settings.storageRoot || "Lucia's Marginbook"),
      pdfSourceRoot: String(settings.pdfSourceRoot || "Books/pdf书籍"),
      storageBindings: settings.storageBindings || {},
      imageExcerptMarkStyle: settings.imageExcerptMarkStyle === "highlight" ? "highlight" : "dashed",
      autoCleanOnDelete: settings.autoCleanOnDelete === true,
      moveDescendantsWithParent: settings.moveDescendantsWithParent === true,
      nodeViews: settings.nodeViews && typeof settings.nodeViews === "object" ? settings.nodeViews : {},
      excerptViews: settings.excerptViews && typeof settings.excerptViews === "object" ? settings.excerptViews : {},
      quickExcerpts: settings.quickExcerpts && typeof settings.quickExcerpts === "object" ? settings.quickExcerpts : {},
      inkExcerptLinks: settings.inkExcerptLinks && typeof settings.inkExcerptLinks === "object" ? settings.inkExcerptLinks : {},
      inkLinkCounters: settings.inkLinkCounters && typeof settings.inkLinkCounters === "object" ? settings.inkLinkCounters : {},
      pdfTextBlocks: settings.pdfTextBlocks && typeof settings.pdfTextBlocks === "object" ? settings.pdfTextBlocks : {},
      excerptColors: settings.excerptColors && typeof settings.excerptColors === "object" ? settings.excerptColors : {},
      notePlaceholderOffMigrated: !!settings.notePlaceholderOffMigrated,
      commentBoxOffMigrated: !!settings.commentBoxOffMigrated,
      naturalHeightV2Migrated: !!settings.naturalHeightV2Migrated,
      overflowHeightVerifiedMigrated: !!settings.overflowHeightVerifiedMigrated,
      managedExcerptAssetsV1Migrated: !!settings.managedExcerptAssetsV1Migrated,
      inkSidecarV2Migrated: !!settings.inkSidecarV2Migrated,
      inkInputMode: settings.inkInputMode === "pen-only" ? "pen-only" : "pen-mouse",
      inkPressureMode: ["fixed", "natural", "fountain"].includes(settings.inkPressureMode) ? settings.inkPressureMode : "natural",
      inkLastTool: typeof settings.inkLastTool === "string" ? settings.inkLastTool : "pen",
      inkPenColor: String(settings.inkPenColor || "#e05252"),
      inkPenWidth: Math.max(1, Math.min(14, Number(settings.inkPenWidth) || 3)),
      inkHighlighterColor: String(settings.inkHighlighterColor || "#ffd84d"),
      inkHighlighterWidth: Math.max(4, Math.min(30, Number(settings.inkHighlighterWidth) || 12)),
      inkEraserSize: Math.max(8, Math.min(48, Number(settings.inkEraserSize) || 18)),
      inkEraserMode: settings.inkEraserMode === "stroke" ? "stroke" : "partial",
      inkEraserAutoReturn: settings.inkEraserAutoReturn !== false,
      inkToolbarCollapsed: !!settings.inkToolbarCollapsed,
      inkAnnotations: this.plugin._lmbInkSidecarReady ? {} :
        (this.plugin._lmbInkDocs && typeof this.plugin._lmbInkDocs === "object" ? this.plugin._lmbInkDocs :
          (settings.inkAnnotations && typeof settings.inkAnnotations === "object" ? settings.inkAnnotations : {}))
    };
    let runtime = this.plugin._lmbSerializedRuntimeCaches;
    if (!runtime || this.plugin._lmbRuntimeStateDirty) {
      runtime = {};
      if (state.autoSize.size) {
        runtime.autoSizes = Object.fromEntries(Array.from(state.autoSize, ([path, store]) => [path, Array.from(store)]));
      }
      if (state.imgDims.size) runtime.imgDims = Object.fromEntries(state.imgDims);
      const positions = this._nonEmptyEntries(state.canvasPositions);
      if (positions) runtime.canvasPositions = positions;
      const edges = this._nonEmptyEntries(state.autoEdges);
      if (edges) runtime.autoEdges = edges;
      this.plugin._lmbSerializedRuntimeCaches = runtime;
      this.plugin._lmbRuntimeStateDirty = false;
    }
    Object.assign(obj, runtime);
    return obj;
  }

  _nonEmptyEntries(source) {
    const result = {};
    for (const [path, values] of source || []) {
      if (values.size) result[path] = Array.from(values);
    }
    return Object.keys(result).length ? result : null;
  }
}

/* 30-plugin-core —— 插件类核心：构造器/生命周期/设置/样式注入 */

class LuciasMarginBookPlugin extends Plugin {

  async onload() {
    this._unloaded = false;          // v0.16.5 R8：卸载后异步链的退出标记
    this.runtimeState = new LmbRuntimeState();
    this.runtimeState.attach(this);
    this.chipEl = null;
    this._saveTimer = null;
    this._chipSig = null;            // 当前 chip 承载的选区签名（text@page），防重复重建
    this._lastNoSelNotice = 0;
    this.rectMode = false;           // 框选模式（v0.11.2 起为常驻开关：ribbon/工具栏按钮/命令共用）
    this.inkMode = false;            // PDF 手写批注模式（非破坏式，数据保存在插件 data.json）
    this.isMobile = LMB_IS_MOBILE;
    this._mobileSelectionTimer = null;
    this._ribbonEl = null;
    this._toolbarBtnTimer = null;    // v0.11.2：PDF 工具栏按钮注入的重试定时器
    // v0.12.1：工具栏宿主 DOM 缓存（LmbDomCache，见 25-pure-toolbar.js）
    //   key = leaf 对象本身（一个 leaf 一份工具栏，绝不能用 "pdf" 这种全局单例 key）
    //   value = 该 leaf 解析出来的工具栏宿主 el（get() 内部用 isConnected 自动判失效）
    this._toolbarCache = new LmbDomCache();
    this._dragArm = null;            // 我们的 chip 拖拽进行中（drop 捕获用）
    this._instantSkip = 0;           // 即时通道成功后短暂抑制文件层自动父子（防双写）
    this._dropFlush = null;          // v0.7.2：canvas 内松手后的快速通道 {path, t, timer}
    this._lmbPdfSidebarTimer = null; // PDF 右侧批注侧栏防抖定时器
    this._lmbCachePruneDirty = false;
    this._lmbRuntimeStateDirty = true;

    // P1：摘录索引层（反向索引：摘录 md → PDF/页/选区）
    this._isIndexing = false;        // 全量重建进行中标记（防重入）
    // P3.5：exId -> canvas 卡片位置（反向跳转优先进画布，而非 md）

    // 补丁 B：相关笔记缓存 + 颜色归一化上下文（须在 settings 与 canvas 监听之前就绪）
    this._colorCtx = null;           // 颜色归一化用的离屏 canvas 2d context（惰性创建）
    this.settingsStore = new LmbSettingsStore(this);
    const loadedSettings = await this.settingsStore.load();
    this.settings = loadedSettings.settings;
    const inkStorageMigrated = await this.lmbInitializeInkStorage();
    this.lmbSetupInk();
    const inkLinkNumbersMigrated = this.lmbInitializeInkLinkNumbers();
    this.lmbSetupInkReferences();
    this.lmbSetupTextBlocks();
    // v0.12.0 一次性迁移：老配置里 noteAutoBoxOnNew 已被持久化成 true，
    //   只改默认值不生效。用标记保证只强制关这一次，之后用户在设置里改回 true 不再被覆盖。
    let settingsMigrated = loadedSettings.migrated || inkStorageMigrated || inkLinkNumbersMigrated;
    // v0.16.0 一次性迁移（与上面同一套机制）：老配置里 commentAutoBoxOnNew 已被持久化成 true，
    //   只改默认值对存量用户不生效。强制关这一次，之后用户在设置里改回 true 不再被覆盖。
    // 两项迁移合并成一次有序写入，避免并发 saveData 互相覆盖。
    if (settingsMigrated) await this.saveSettings();
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
    // Loaded persisted maps need one cleanup pass; subsequent saves only prune
    // after a vault delete/rename instead of scanning the whole vault every time.
    this._lmbCachePruneDirty = true;
    this._lmbRuntimeStateDirty = true;

    // v0.16.12：旧缓存中的 hash 与文本仍相同；若不失效，新算法永远没有机会运行。
    // 保留 locked（用户明确手动锁定）的卡片，其余只标成 pendingActual，等待对应画布
    // 渲染后定点实测，不在启动时直接改文件，也不会触碰卡片坐标。
    if (!this.settings.naturalHeightV2Migrated) {
      for (const store of this.autoSize.values()) {
        for (const [id, entry] of store.entries()) {
          if (!entry || entry.locked) continue;
          store.set(id, Object.assign({}, entry, { pendingActual: true }));
        }
      }
      this.settings.naturalHeightV2Migrated = true;
      await this.saveSettings();
    }
    if (!this.settings.overflowHeightVerifiedMigrated) {
      for (const store of this.autoSize.values()) {
        for (const [id, entry] of store.entries()) {
          if (!entry || entry.locked) continue;
          store.set(id, Object.assign({}, entry, { pendingActual: true }));
        }
      }
      this.settings.overflowHeightVerifiedMigrated = true;
      await this.saveSettings();
    }

    if (this.isMobile) {
      this.registerDomEvent(document, "pointerdown", (e) => this.onDocPointerDown(e), true);
      this.registerDomEvent(document, "pointerup", (e) => this.onDocPointerUp(e), true);
      // iOS selection handles can change the selection without another pointerup.
      this.registerDomEvent(document, "selectionchange", () => this.onMobileSelectionChange(), true);
    } else {
      this.registerDomEvent(document, "mousedown", (e) => this.onDocMouseDown(e), true);
      this.registerDomEvent(document, "mouseup", (e) => this.onDocMouseUp(e), true);
    }
    this.registerDomEvent(document, "scroll", (e) => {
      this.hideChip();
      this.lmbHandlePdfSidebarScroll(e);
    }, true);
    // PDF 标记本身不抢占文字选择；在捕获层按坐标命中标记，实现 PDF → 边页定位。
    this.registerDomEvent(document, "click", (e) => this.lmbHandlePdfSidebarClick(e), true);

    // v0.7.2 松手快速通道：canvas 内 mouseup → 武装 flush，让下一个 modify 走 80ms 极短防抖
    // （原本要干等 400ms 才重排）。capture 阶段注册，早于 Obsidian 自己的 canvas mouseup。
    // v0.9.3：再加内存级即时通道 —— mouseup 后不等 Obsidian 落盘，直接在 canvas 内存数据上
    // 做父子判定 + 组排布（setData 毫秒级生效），落盘管线退为兜底。
    this.registerDomEvent(document, "mouseup", (e) => {
      try {
        const f = this.canvasFileFromEvent(e);
        if (f) this.armDropFlush(f);
        if (e.button === 0) {
          // v0.11.1：canvasCtxFromEvent 同时拿 file 与 canvasObj（避开 canvasObj.view 的填值时机坑）
          const ctx = this.canvasCtxFromEvent(e);
          if (ctx && ctx.canvasObj) {
            this.instantMoveAttach(ctx.canvasObj, ctx.file).catch((err) =>
              console.warn("[lmb] instant move error:", err));
          }
        }
      } catch (_) { /* noop */ }
      try { this.lmbCanvasBarTick(); } catch (_) { /* event-driven bar refresh */ }
    }, true);

    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f instanceof TFile && f.extension === "canvas") {
        // v0.16.4 修复 P2-4：selfWritten 的值改为写入时刻的时间戳。
        //   旧版存 true 且靠下一次 modify 清除——若该 modify 未触发，残留标志会吞掉
        //   用户的下一次真实修改。现在超过 5s 的旧标志不再吞。
        const selfT = this.selfWritten.get(f.path);
        if (selfT) {
          this.selfWritten.delete(f.path);
          if (Date.now() - selfT < 5000) return;
        }
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
    // v0.11.1：canvasCtxFromEvent 同时拿 file → 即时通道建边时直接登记 sidecar，
    //   不再依赖 canvasObj.view 是否已挂 .file（polling 早期可能为 null）
    this.registerDomEvent(document, "drop", (e) => {
      try {
        if (!this._dragArm) return;
        const target = e.target && e.target.nodeType === 1 ? e.target : null;
        if (!target) return;
        const ctx = this.canvasCtxFromEvent(e);
        if (!ctx || !ctx.canvasObj) {
          console.log("[lmb] canvas 内部 API 不可用 → 文件层兜底（250ms）");
          return;
        }
        this.instantAttach(ctx.canvasObj, ctx.file).catch((err) => console.warn("[lmb] instant attach error:", err));
      } catch (err) {
        console.warn("[lmb] drop capture error:", err);
      }
    }, true);

    // v0.11.2：PDF 原生工具栏注入「图片框选」按钮（PDF++ 式 crop 按钮，摆脱 Alt）。
    //   工具栏由 pdf.js 异步渲染，所以在布局事件后做有限次重试（lmbScheduleToolbarButtons）。
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.lmbScheduleToolbarButtons();
      this.lmbSchedulePdfSidebarRefresh(220);
      this.lmbScheduleInkRefresh(220);
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.lmbScheduleToolbarButtons();
      this.lmbSchedulePdfSidebarRefresh(120);
      this.lmbScheduleInkRefresh(120);
      this.lmbRenderActivePdfSidebar().catch(() => {});
      this.lmbScheduleVisibleCanvasFits();
    }));
    this.registerEvent(this.app.workspace.on("file-open", (f) => {
      if (f && f.extension === "canvas") this._scheduleActualFitRetry(f);
      if (f && f.extension === "pdf") {
        this.lmbScheduleToolbarButtons();
        this.lmbSchedulePdfSidebarRefresh(180);
        this.lmbScheduleInkRefresh(180);
      }
    }));

    // v0.11.2：Esc 退出框选模式（与按钮开关对称；Alt 临时拖拽不受影响）
    this.registerDomEvent(document, "keydown", (e) => {
      if (e.key === "Escape" && this.rectMode) {
        this.setRectMode(false);
        new Notice("MarginBook: 图片框选模式已关闭", 2000);
      }
    }, true);

    // 侧边栏按钮：图片框选模式（v0.11.2 起为常驻开关：再点一次/Esc 关闭，截图后不自动关）
    this._ribbonEl = this.addRibbonIcon("scan-search", "MarginBook: 图片框选（点击开启，直接在 PDF 上拖拽截图；再点一次/Esc 关闭）", () => {
      this.setRectMode(!this.rectMode);
      new Notice(this.rectMode
        ? "MarginBook: 图片框选模式已开启 —— 在 PDF 上直接拖拽即可（再点一次/Esc 关闭）"
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
      try { this.lmbCanvasBarTick(); } catch (_) { /* noop */ }
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
    this.registerMarkdownPostProcessor((el, ctx) => {
      this.lmbEnhanceExcerptCallouts(el, ctx).catch((err) => console.warn("[lmb] excerpt note action failed:", err));
    });

    /* ---- P1：摘录索引的增量维护 ----
     * modify 会在每次敲键触发，所以 reindexFile 内有两道廉价闸门
     * （不链 pdf 且不在索引中 → 跳过；mtime 未变 → 跳过），不会读盘。
     */
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f && f.extension === "md") this.lmbInvalidateRelatedFile(f);
      if (f && f.extension === "canvas") this.lmbScheduleCanvasIndex(f); // P3.5 canvas 索引（v0.16.5 R7 防抖）
      else this.reindexFile(f);
    }));
    this.registerEvent(this.app.vault.on("create", (f) => {
      if (f && f.extension === "md") this.lmbInvalidateRelatedFile(f);
      if (f && f.extension === "canvas") this.lmbIndexCanvasFile(f);
      else this.reindexFile(f);
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      if (!f) return;
      this._lmbCachePruneDirty = true;
      if (f.extension === "md") this.lmbInvalidateRelatedFile(f);
      if (f.extension === "canvas") {
        for (const [k, v] of Array.from(this.excerptCanvasIndex.entries())) {
          if (v && v.canvasPath === f.path) this.excerptCanvasIndex.delete(k);
        }
      } else this.dropFileFromIndex(f.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
      this._lmbCachePruneDirty = true;
      if ((f && f.extension === "md") || /\.md$/i.test(oldPath || "")) {
        this.lmbInvalidateRelatedFile(f, oldPath);
      }
      if (f && f.extension === "pdf") this.lmbHandleInkPdfRename(f, oldPath).catch((err) => console.warn("[lmb] PDF ink rename failed", err));
    }));
    if (this.app.metadataCache && this.app.metadataCache.on) {
      this.registerEvent(this.app.metadataCache.on("changed", (f) => {
        if (f && f.extension === "md") this.lmbInvalidateRelatedFile(f);
      }));
    }
    this.app.workspace.onLayoutReady(() => {
      this.buildExcerptIndex();
      // v0.11.2：启动时若 PDF 已打开（layout-change/file-open 不会补发），也要注入工具栏按钮
      this.lmbScheduleToolbarButtons();
      this.lmbScheduleInkRefresh(250);
      // v0.17.0：启动时即使用户在恢复的工作区里已经停留在 PDF，也要补一次侧栏渲染。
      this.lmbSchedulePdfSidebarRefresh(250);
      // v0.13.0：启动 canvas 卡片悬浮栏轮询（每 120ms 比对选中集合与视口状态）
      if (typeof this.lmbStartCanvasBarWatch === "function") this.lmbStartCanvasBarWatch();
      this.lmbScheduleVisibleCanvasFits();
    });

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
      name: "图片框选模式（开关，开启后直接拖拽截图）",
      callback: () => {
        this.setRectMode(!this.rectMode);
        new Notice(this.rectMode
          ? "MarginBook: 图片框选模式已开启 —— 在 PDF 上直接拖拽即可（再点一次/Esc 关闭）"
          : "MarginBook: 图片框选模式已关闭", 3000);
      }
    });
    this.addCommand({
      id: "pdf-ink-mode",
      name: "PDF 手写批注模式（开关）",
      callback: () => this.lmbSetInkMode(!this.inkMode)
    });
    this.addCommand({ id: "pdf-ink-undo", name: "PDF 手写批注：撤销当前页上一笔", callback: () => this.lmbUndoInk() });
    this.addCommand({ id: "pdf-ink-redo", name: "PDF 手写批注：重做当前页操作", callback: () => this.lmbRedoInk() });
    this.addCommand({ id: "pdf-ink-clear-page", name: "PDF 手写批注：清除当前页", callback: () => this.lmbClearInk() });

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
          } else {
            // v0.16.5 修复 R4：开启侧此前什么都没做 —— MarkdownPostProcessor 只在
            //   **渲染时**跑一次，已打开的阅读视图不会重渲染 → 用户开了 Recall 却
            //   看不到任何模糊，必须手动切走再切回才生效。现在主动触发一次重渲染。
            this.lmbRerenderRecallViews();
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
          if (this.settings.storageLayout === "central") {
            this.lmbOpenOrCreateExcerptMd(file).catch(err => new Notice("无法打开摘录文档：" + err.message));
            return true;
          }
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
    this.addCommand({ id: "layout-tree-right", name: "将当前 Canvas 排为从左到右知识树", callback: () => this.lmbApplyTreeLayout("right") });
    this.addCommand({ id: "layout-tree-down", name: "将当前 Canvas 排为自上而下知识树", callback: () => this.lmbApplyTreeLayout("down") });

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

    /* ---- v0.13.9：卡片高度自适应命令（悬浮栏之外的独立入口）----
     * 为什么单独加命令：悬浮栏按钮链路排查了 5 版（v0.13.4→v0.13.8）用户仍反馈
     * "完全没反应、Notice 也不弹"，无法定位是按钮 DOM 的问题还是 fit 逻辑的问题。
     * 命令面板是 Obsidian 最稳的入口（不依赖任何自建 DOM）——
     *   命令能用  → fit 逻辑没问题，问题锁定在悬浮栏链路
     *   命令也坏  → fit 逻辑本身有问题，换方向修
     * 无论哪种结果都能立刻收敛，而且命令本身就是一个永久可用的备选入口。 */
    this.addCommand({
      id: "fit-card-height",
      name: "调整选中卡片高度（按内容自适应）",
      callback: () => { this.lmbFitSelectedCard(); }
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
    try { document.body.toggleClass("lmb-mobile", !!this.isMobile); } catch (_) {}

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

    if (this.isMobile) new Notice("MarginBook 0.25.6 已加载（视图跳转修复版）", 5000);
    this.debugNotice("已加载 ✓（v0.25.6）");
    console.log("[lmb] loaded (v0.25.6)");
  }

  onunload() {
    this._unloaded = true;
    if (this._lmbNavigation) {
      this._lmbNavigation.cancelled = true;
      this._lmbEndNavigation(this._lmbNavigation);
    }
    this.hideChip();
    this.syncTimers.forEach((t) => clearTimeout(t));
    this.syncTimers.clear();

    // v0.11.2：拆掉 PDF 工具栏注入的框选按钮 + 重试定时器 + body 模式类
    try {
      if (this._toolbarBtnTimer) { clearTimeout(this._toolbarBtnTimer); this._toolbarBtnTimer = null; }
      // v0.16.4 修复 P2-1：此前只删 crop，md / canvas 两颗按钮残留成死按钮
      document.querySelectorAll(".lmb-toolbar-group")
        .forEach((b) => { if (b.parentNode) b.remove(); });
      document.querySelectorAll(".lmb-ink-layer,.lmb-ink-live-layer,.lmb-ink-tools").forEach((layer) => layer.remove());
      // v0.17.0（实验）：清理 PDF 批注侧栏，防止卸载后残留
      this._lmbClearPdfSidebars();
      document.body.removeClass("lmb-rect-mode");
      document.body.removeClass("lmb-ink-mode");
      document.body.removeClass("lmb-ink-capture");
      document.body.removeClass("lmb-mobile");
      // v0.12.1：清掉工具栏宿主的 DOM 缓存（不清的话 Map 里会残留整棵已卸载的 leaf 引用）
      if (this._toolbarCache) this._toolbarCache.clear();
      // v0.13.0：停掉 canvas 悬浮栏轮询 + 移除浮层 DOM
      //   （不清 interval 的话插件卸载后它还会每 120ms 继续跑，且持有已销毁 leaf 的引用）
      if (typeof this.lmbStopCanvasBarWatch === "function") this.lmbStopCanvasBarWatch();
      // v0.16.5 修复 R8：清掉所有自建定时器 + 置卸载标记（异步链入口自行退出）
      this._unloaded = true;
      this._lmbClearTimers();
    } catch (_) { /* noop */ }

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

  /* ==================== v0.11.2：框选模式（常驻开关）+ PDF 工具栏按钮 ==================== */

  /**
   * 框选模式统一开关入口：ribbon / 命令 / PDF 工具栏按钮 / Esc 全走这里，
   * 保证三处 UI（ribbon、所有 PDF 工具栏按钮、body 模式类）同步刷新。
   */
  setRectMode(on) {
    this.rectMode = !!on;
    this.updateRibbonState();
  }

  /**
   * v0.11.2：同步所有框选模式 UI。
   *   ribbon 图标 + 每个 PDF 工具栏里注入的 .lmb-toolbar-crop + body.lmb-rect-mode
   *   （body 类供 CSS 把 PDF 页面光标换成 crosshair，给「正在框选」的视觉反馈）。
   */
  updateRibbonState() {
    if (this._ribbonEl) this._ribbonEl.toggleClass("is-active", !!this.rectMode);
    try {
      document.querySelectorAll(".lmb-toolbar-crop").forEach((b) => b.toggleClass("is-active", !!this.rectMode));
      document.body.toggleClass("lmb-rect-mode", !!this.rectMode);
    } catch (_) { /* noop */ }
  }

  /**
   * v0.11.2：工具栏按钮注入的有限重试调度。
   *   pdf.js 的 .pdf-toolbar 在视图打开后异步渲染，单次注入大概率扑空；
   *   这里 250ms × 最多 8 次（2 秒），全部就绪后提前停。
   *
   * v0.12.1：每轮 tick 开头先 prune 工具栏宿主缓存，清掉已被 Obsidian 摘掉的游离节点，
   *   避免关掉分屏后缓存里残留死引用、也保证下一轮对失效 leaf 重新解析。
   *   重试节奏**故意保持不变**：120ms 首延 + 250ms × 最多 8 次（有次数上限 + 有节流），
   *   比 editing-toolbar v4.1.1 那种「裸 setTimeout(200) 无节流重建」更稳 —— 它每个
   *   事件都全量重建一遍按钮，事件密集时会反复 remove/append 抖动，我们不会。
   *
   * v0.12.1（修订）：allowFallback 只在**最后一次** tick 才放行。
   *   tries 自增时机是「先 setTimeout、后 tries++」，所以进入第 N 次 tick 时 tries === N-1：
   *     tick1(tries=0) … tick8(tries=7) → false；tick9(tries=8) → true，且 8 < 8 不成立、
   *     不再排下一轮，所以 tick9 就是最后一轮。共 9 轮（120ms + 250ms × 8 ≈ 2.12s）。
   */
  lmbScheduleToolbarButtons() {
    if (this._toolbarBtnTimer) clearTimeout(this._toolbarBtnTimer);
    let tries = 0;
    const tick = () => {
      this._toolbarBtnTimer = null;
      // v0.12.1：先清游离缓存，再解析（不清的话命中旧节点就永远跳过 querySelector）
      try { if (this._toolbarCache) this._toolbarCache.prune(); } catch (_) { /* noop */ }
      // v0.12.1（修订）：除最后一轮外都不准用兜底宿主（详见 lmbEnsureToolbarButtons 注释）
      const missing = this.lmbEnsureToolbarButtons(tries >= 8);
      if (missing && tries < 8) {
        tries++;
        this._toolbarBtnTimer = setTimeout(tick, 250);
      }
    };
    this._toolbarBtnTimer = setTimeout(tick, 120);
  }

  /**
   * v0.11.2：给所有打开的 PDF 视图的 .pdf-toolbar 补挂按钮（幂等）。
   * 返回是否仍有视图的工具栏未就绪（true = 需要重试）。
   * DOM 参照（与 PDF++ 同款挂法）：.pdf-toolbar 内 .clickable-icon 按钮；
   * PDF 嵌入（.pdf-embed）的迷你工具栏不注入（空间小、框选主战场是完整视图）。
   *
   * v0.12.0：按钮从 1 个扩到 3 个，各自独立判定是否已挂（不能再按 crop 存在与否
   * 提前 continue，否则旧版本升级后 crop 在、新按钮永远挂不上）：
   *   ① .lmb-toolbar-crop   图片框选（v0.11.2）
   *   ② .lmb-toolbar-md     打开/创建该 PDF 的摘录文档（<PDF名>-摘录.md）
   *   ③ .lmb-toolbar-canvas 打开/创建该 PDF 的专属画布（<PDF名>.canvas）
   * 文件一律在点击时从按钮所在 leaf 反查（注入时闭包存 file 会在切文件后失效）。
   *
   * v0.12.1：宿主不再硬编码 `.pdf-toolbar`，改走 lmbResolveToolbarAnchor 查
   *   LMB_VIEW_SPECS（判定 + 选择器 + enabled 三合一的单一真相源，见 25-pure-toolbar.js），
   *   并加了一层 per-leaf 缓存（key = leaf 对象）避免每次事件都全量 querySelector。
   *   三个按钮自身的判定结构（各自独立判存在 / 幂等追加）**保持原样不动**。
   *
   * v0.12.1（修订）：**fallback 只在重试用尽后才允许**（allowFallback，默认 false）。
   *   为什么必须分：`.pdf-toolbar` 是 pdf.js **异步渲染**的，在它出现之前的那一两帧，
   *   lmbResolveToolbarAnchor 的兜底会命中 PDF 视图里一直存在的 `.view-content`，
   *   于是：① 三个按钮被 append 进内容区而不是顶部工具栏 → 按钮跑到 PDF 正文上面、
   *   破坏布局；② 这个错误宿主被写进 per-leaf 缓存 → 等真正的 `.pdf-toolbar` 渲出来时
   *   缓存命中、不再重新解析，**按钮永远迁移不回真正的工具栏**。
   *   重试机制本来就是为「等 `.pdf-toolbar` 渲染」而设计的，fallback 的语义是
   *   「这个视图类型确实没有我们期望的宿主容器」，不是「异步还没准备好」——两者不能混。
   *   所以 allowFallback === false 时遇到 fallback：**不注入、不写缓存、算 missing**。
   *
   * @param {boolean} [allowFallback=false] 是否允许用兜底宿主（由调度层按重试进度给，
   *   只在最后一轮为 true）
   * @returns {boolean} missing（true = 还有视图未就绪，需要重试）
   */
  lmbEnsureToolbarButtons(allowFallback = false) {
    let missing = false;
    const cache = this._toolbarCache;
    let leaves = [];
    try { leaves = this.app.workspace.getLeavesOfType("pdf"); } catch (_) { return true; }
    for (const leaf of leaves) {
      // v0.11.2：从 leaf.containerEl 找（比 view.containerEl 更宽，工具栏挂在任何子层级都能命中）
      const root = leaf && leaf.containerEl;
      if (!root || !root.querySelector) continue;

      // v0.12.1：viewType 从 leaf.view 上取（查规格表用），取不到回落 "pdf"
      //   （Obsidian 的 PDF 视图 getViewType() 返回的就是 "pdf"）
      let viewType = "pdf";
      try {
        const v = leaf.view;
        if (v && typeof v.getViewType === "function") viewType = v.getViewType() || "pdf";
      } catch (_) { viewType = "pdf"; }

      // v0.12.1：先查缓存。key 用 leaf 对象本身 —— 每个 leaf 有自己独立的一份工具栏，
      //   绝不能用 "pdf" 这种全局单例 key（多 PDF 分屏时会把按钮注到第一个 leaf 里）。
      //   缓存命中且 isConnected 为真（LmbDomCache.get 内部已判）→ 直接复用，跳过 querySelector。
      let el = null;
      try { el = cache ? cache.get(leaf) : null; } catch (_) { el = null; }
      if (!el) {
        let resolved = null;
        try { resolved = lmbResolveToolbarAnchor(root, viewType); } catch (_) { resolved = null; }
        const spec = resolved && resolved.spec;
        const source = resolved ? resolved.source : null;

        // v0.12.1（修订）：按 source 分三路。**写缓存只有两条路径**：
        //   ① source === "spec"；② source === "fallback" 且 allowFallback 为 true。
        //   其余一律不写缓存（否则错误宿主被缓存住就再也纠正不回来）。
        if (source === "fallback" && allowFallback !== true) {
          // 「还没渲染出来」不是「没有宿主」→ 不注入、不写缓存，留给外层继续等真正的
          // .pdf-toolbar（下一轮这里会重新解析，因为缓存里根本没有条目）
          missing = true;
          continue;
        }
        if (source === null) {
          // 情况一：spec 登记了但 enabled === false（用户/规格有意关掉）→ 不是「未就绪」，
          //   静默跳过，不让外层白重试；顺手清掉该 leaf 的旧缓存条目。
          // 情况二：未知视图 / 连兜底都没找到 → 算 missing，交给外层重试。
          if (spec && spec.enabled === false) {
            try { if (cache) cache.delete(leaf); } catch (_) { /* noop */ }
            continue;
          }
          missing = true;
          continue;
        }
        el = resolved.el;
        try { if (cache) cache.set(leaf, el); } catch (_) { /* noop */ }
      }

      // MarginBook 按钮统一收进一个靠右的紧凑组，避免被 PDF 原生 toolbar
      // 的 justify-content 分散到整行。
      let group = el.querySelector(".lmb-toolbar-group");
      if (!group) {
        group = document.createElement("div");
        group.className = "lmb-toolbar-group";
        el.appendChild(group);
      }
      for (const old of Array.from(el.querySelectorAll(":scope > .lmb-toolbar-crop, :scope > .lmb-toolbar-md, :scope > .lmb-toolbar-canvas, :scope > .lmb-toolbar-sidebar"))) {
        group.appendChild(old);
      }

      // ⓪ 手写批注（保留原 PDF，按页存为归一化笔划）
      if (!group.querySelector(".lmb-toolbar-ink")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon lmb-toolbar-ink";
        btn.setAttribute("aria-label", "MarginBook: PDF 手写批注（开启后用触控笔或鼠标书写；Esc 退出）");
        try { setIcon(btn, "pen-tool"); } catch (_) { btn.setText("✎"); }
        btn.addEventListener("click", (e) => { e.stopPropagation(); this.lmbSetInkMode(!this.inkMode); });
        group.appendChild(btn);
        btn.toggleClass("is-active", !!this.inkMode);
      }

      if (!group.querySelector(".lmb-toolbar-page-note")) {
        const btn = document.createElement("button");
        btn.className = "clickable-icon lmb-toolbar-page-note";
        btn.setAttribute("aria-label", "新建 Markdown 页注");
        btn.setAttribute("title", "新建 Markdown 页注（无需选中文字）");
        try { setIcon(btn, "square-pen"); } catch (_) { btn.setText("T+"); }
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          const currentLeaf = this.app.workspace.getLeavesOfType("pdf").find((candidate) => candidate.containerEl && candidate.containerEl.contains(btn));
          this.lmbStartPageNote(currentLeaf);
        });
        group.appendChild(btn);
      }

      // ① 图片框选
      if (!group.querySelector(".lmb-toolbar-crop")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon lmb-toolbar-crop";
        btn.setAttribute("aria-label",
          "MarginBook: 图片框选（开启后直接在 PDF 上拖拽截图；Esc 或再点一次关闭）");
        try { setIcon(btn, "box-select"); }
        catch (_) { btn.setText("▦"); } // 图标缺失时兜底一个字形，按钮功能不受影响
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.setRectMode(!this.rectMode);
          new Notice(this.rectMode
            ? "MarginBook: 图片框选模式已开启 —— 直接拖拽截图，Esc 或再点一次关闭"
            : "MarginBook: 图片框选模式已关闭", 2500);
        });
        group.appendChild(btn);
        btn.toggleClass("is-active", !!this.rectMode);
      }

      // ② 打开/创建摘录文档
      if (!group.querySelector(".lmb-toolbar-md")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon lmb-toolbar-md";
        btn.setAttribute("aria-label",
          "MarginBook: 打开 / 创建该 PDF 的摘录文档（使用 MarginBook 存储规则）");
        try { setIcon(btn, "file-text"); }
        catch (_) { btn.setText("📄"); }
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          // v0.12.1：宿主在点击时从按钮自身反查（parentElement），而不是直接用闭包里的 el。
          //   理由：el 现在可能来自缓存，「缓存命中」与「按钮当初被挂进去的那个节点」不是
          //   一回事（Obsidian 重排/搬家工具栏时按钮和 el 可能一起换地方）。从按钮反查拿到
          //   的永远是它当时真正所在的宿主，最稳；反查不到再退回闭包 el 兜底。
          //   fallback 路径下按钮挂在 .view-content（或其首个子 div）里，parentElement 拿到的
          //   就不是 .pdf-toolbar —— 但没关系：lmbPdfFileFromToolbar 只做 closest(
          //   ".workspace-leaf")，兜底宿主和 .pdf-toolbar 同属一个 .workspace-leaf，照样反查得到。
          const host = (e.currentTarget && e.currentTarget.parentElement) || el;
          const f = this.lmbPdfFileFromToolbar(host);
          if (!f) { new Notice("MarginBook: 该工具栏没有对应的 PDF 文件"); return; }
          this.lmbOpenOrCreateExcerptMd(f).catch((err) => {
            console.error("[lmb] open excerpt md failed:", err);
            new Notice("MarginBook: 打开摘录文档失败，详情见控制台");
          });
        });
        group.appendChild(btn);
      }

      // ③ 打开/创建专属画布
      if (!group.querySelector(".lmb-toolbar-canvas")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon lmb-toolbar-canvas";
        btn.setAttribute("aria-label",
          "MarginBook: 打开 / 创建该 PDF 的专属画布（使用 MarginBook 存储规则）");
        try { setIcon(btn, "layout-dashboard"); }
        catch (_) { btn.setText("▦"); }
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          // v0.12.1：同 ② —— 点击时从按钮反查宿主，闭包 el 仅作兜底
          const host = (e.currentTarget && e.currentTarget.parentElement) || el;
          const f = this.lmbPdfFileFromToolbar(host);
          if (!f) { new Notice("MarginBook: 该工具栏没有对应的 PDF 文件"); return; }
          this.lmbOpenOrCreatePdfCanvas(f).catch((err) => {
            console.error("[lmb] open pdf canvas failed:", err);
            new Notice("MarginBook: 打开专属画布失败，详情见控制台");
          });
        });
        group.appendChild(btn);
      }

      // ④ 打开 / 关闭 PDF 批注边栏
      if (!group.querySelector(".lmb-toolbar-sidebar")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon lmb-toolbar-sidebar";
        btn.setAttribute("aria-label", "MarginBook: 打开 / 关闭 PDF 批注边栏");
        try { setIcon(btn, "panel-right"); } catch (_) { btn.setText("▥"); }
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const leafEl = btn.closest(".workspace-leaf");
          const currentLeaf = leafEl ? this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl) : leaf;
          if (!currentLeaf) return;
          this.lmbSetPdfSidebarVisible(currentLeaf, currentLeaf._lmbPdfSidebarOpen === false);
        });
        group.appendChild(btn);
        btn.toggleClass("is-active", leaf._lmbPdfSidebarOpen !== false);
      }
    }
    return missing;
  }

  /**
   * v0.12.0：从按钮所在的 .pdf-toolbar 反查当前 PDF 文件。
   * 点击时实时解析（不在注入时闭包存 file）：同一 leaf 换了文件后按钮依然正确。
   *
   * v0.12.1：入参只要求是「按钮所在的宿主容器内/本身」的任意元素 —— 可能是 .pdf-toolbar，
   *   也可能是重试用尽后走兜底时的 .view-content（或其首个子 div）。本函数只关心
   *   closest(".workspace-leaf")，两者同属一个 leaf，结果一致。
   */
  lmbPdfFileFromToolbar(toolbar) {
    try {
      const leafEl = toolbar.closest(".workspace-leaf");
      const leaf = leafEl
        ? this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl)
        : null;
      const view = leaf && leaf.view;
      return (view && view.file) ? view.file : null;
    } catch (_) { return null; }
  }

  /**
   * v0.12.1：对所有已注入的工具栏按钮做显隐分级。
   *
   * ⚠️ 目前**没有调用方**，这是预留能力，别当死代码删掉：
   *   下一步要做「切到非 PDF 视图时用 hideKeepSpace 保留占位，而不是把按钮 DOM 移除」
   *   （移除 = 切回来要重新注入 + 原生按钮重排抖动），接线点在 workspace 的
   *   active-leaf-change 里，到时候本方法就是那个调用入口。
   *   显隐分级的实现在 25-pure-toolbar.js 的 lmbSetToolbarVisibility。
   *
   * @param {"show"|"hideKeepSpace"|"hideRemove"} mode
   */
  lmbApplyToolbarVisibility(mode) {
    try {
      // LmbDomCache 没有对外暴露遍历接口（那是别人的文件，不为遍历去改它），
      // 所以退化成全局选择器：这三个类名是本插件独占的，命中集合 == 已注入的按钮集合。
      const sels = ".lmb-toolbar-ink, .lmb-toolbar-crop, .lmb-toolbar-md, .lmb-toolbar-canvas, .lmb-toolbar-sidebar";
      document.querySelectorAll(sels).forEach((b) => lmbSetToolbarVisibility(b, mode));
    } catch (_) { /* noop：绝不让异常打断调用方的事件链 */ }
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

  /**
   * v0.16.5 修复 R4：回忆模式开启后主动重渲染已打开的阅读视图。
   *   registerMarkdownPostProcessor 只在**渲染时**触发一次，开关切换不会重跑它 ——
   *   旧版开启侧什么都没做，用户开了 Recall 却看不到模糊，要手动切页才生效。
   *   previewMode 是内部对象，故全部能力检测，拿不到就静默跳过（只慢一拍）。
   */
  lmbRerenderRecallViews() {
    try {
      const leaves = this.app.workspace.getLeavesOfType("markdown") || [];
      for (const l of leaves) {
        try {
          const v = l && l.view;
          const pm = v && v.previewMode;
          if (pm && typeof pm.rerender === "function") pm.rerender(true);
        } catch (_) { /* 单个视图失败不影响其它 */ }
      }
    } catch (_) { /* noop */ }
  }

  /**
   * v0.16.5 修复 R7：canvas 索引的防抖入口。
   *   canvas 的 modify 在拖拽期连续触发（Obsidian 频繁落盘），旧版每次都全量
   *   cachedRead + JSON.parse 整张画布。按文件防抖 400ms，与 processCanvas 同节奏。
   */
  lmbScheduleCanvasIndex(f) {
    try {
      if (!this._canvasIndexTimers) this._canvasIndexTimers = new Map();
      const old = this._canvasIndexTimers.get(f.path);
      if (old) clearTimeout(old);
      this._canvasIndexTimers.set(f.path, setTimeout(() => {
        this._canvasIndexTimers.delete(f.path);
        this.lmbIndexCanvasFile(f).catch(() => {});
      }, 400));
    } catch (_) {
      try { this.lmbIndexCanvasFile(f).catch(() => {}); } catch (_2) { /* noop */ }
    }
  }

  /**
   * v0.16.5 修复 R8：集中清掉所有自建定时器。
   *   图片等待重试链（_actualFitRetryForFile）的 setTimeout 没有保留句柄，靠
   *   _unloaded 标记在入口处自行退出兜底。
   */
  _lmbClearTimers() {
    try {
      if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
      if (this._dropFlush && this._dropFlush.timer) clearTimeout(this._dropFlush.timer);
      this._dropFlush = null;
      if (this._lmbPdfSidebarTimer) {
        clearTimeout(this._lmbPdfSidebarTimer);
        this._lmbPdfSidebarTimer = null;
      }
      if (this._mobileSelectionTimer) {
        clearTimeout(this._mobileSelectionTimer);
        this._mobileSelectionTimer = null;
      }
      if (this._lmbInkSaveTimer) {
        clearTimeout(this._lmbInkSaveTimer);
        this._lmbInkSaveTimer = null;
      }
      if (this._lmbInkRefreshTimer) {
        clearTimeout(this._lmbInkRefreshTimer);
        this._lmbInkRefreshTimer = null;
      }
      if (this._fitRetry) {
        for (const k of Object.keys(this._fitRetry)) {
          const r = this._fitRetry[k];
          if (r && r.timer) clearTimeout(r.timer);
        }
        this._fitRetry = {};
      }
      this._fitRetryImg = {};
      this._fitRetryActual = {};
      if (this._canvasIndexTimers) {
        this._canvasIndexTimers.forEach((t) => clearTimeout(t));
        this._canvasIndexTimers.clear();
      }
    } catch (_) { /* noop */ }
  }

  debugNotice(msg) {
    console.log("[lmb]", msg);
    if (this.settings && this.settings.debug) new Notice("MarginBook: " + msg, 4000);
  }

  /* ==================== 设置 ==================== */

  saveSettings() {
    // One writer for data.json: overlapping editor/preferences saves must not
    // finish out of order. Snapshot when this job starts, after prior failures
    // have reached their callers and rolled back the affected note.
    const previous = this._lmbSettingsWriteQueue || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => {
      this._lmbPrunePersistedCaches();
      const obj = this.settingsStore.serialize(this.settings, this.runtimeState);
      return this.saveData(obj);
    });
    this._lmbSettingsWriteQueue = pending.catch(() => {});
    return pending;
  }

  /** 清除已删除画布和附件留下的持久化缓存，避免 data.json 无限制增长。 */
  _lmbPrunePersistedCaches() {
    try {
      if (!this._lmbCachePruneDirty) return;
      const files = this.app && this.app.vault && typeof this.app.vault.getFiles === "function"
        ? this.app.vault.getFiles() : [];
      const canvasPaths = new Set(files.filter((f) => f && f.extension === "canvas").map((f) => f.path));
      const imageNames = new Set(files
        .filter((f) => f && /^(?:webp|png|jpe?g)$/i.test(f.extension || ""))
        .map((f) => f.name));
      for (const map of [this.autoSize, this.canvasPositions, this.autoEdges, this.nodeMeta]) {
        if (!map || typeof map.keys !== "function") continue;
        for (const path of Array.from(map.keys())) if (!canvasPaths.has(path)) map.delete(path);
      }
      if (this.imgDims && typeof this.imgDims.keys === "function") {
        for (const name of Array.from(this.imgDims.keys())) {
          const base = String(name).split("/").pop();
          if (!imageNames.has(base)) this.imgDims.delete(name);
        }
      }
      this._lmbCachePruneDirty = false;
      this._lmbRuntimeStateDirty = true;
    } catch (err) {
      console.warn("[lmb] cache prune failed:", err);
    }
  }

  /* ==================== 样式 ==================== */

  injectStyles() {
    let st = document.getElementById("lmb-styles");
    if (!st) {
      st = document.createElement("style");
      st.id = "lmb-styles";
      document.head.appendChild(st);
    }
    // v0.12.1：CSS 全部抽到 src/11-styles.js 的 LMB_STYLES，
    //   per-view-type 适配规则也集中在那边（借鉴 editing-toolbar：视图差异交给 CSS，不动 JS）。
    st.textContent = LMB_STYLES.join("");
    st.dataset.lmbVersion = "0.37.0";
  }

}

/* PDF ink controller: pen-first input, cached rendering, history and sidecar persistence. */
const LMB_INK_TOOLS = ["hand", "select", "pen", "highlighter", "eraser", "text", "line", "rect"];

LuciasMarginBookPlugin.prototype.lmbInkStore = function () {
  if (!this._lmbInkDocs || typeof this._lmbInkDocs !== "object") {
    this._lmbInkDocs = this.settings.inkAnnotations && typeof this.settings.inkAnnotations === "object"
      ? this.settings.inkAnnotations : {};
  }
  return this._lmbInkDocs;
};

LuciasMarginBookPlugin.prototype.lmbInkStorageDir = function () {
  const id = this.manifest && this.manifest.id || "lucias-marginbook";
  return normalizePath(`.obsidian/plugins/${id}/ink-data`);
};

LuciasMarginBookPlugin.prototype.lmbInitializeInkStorage = async function () {
  const migrationWasComplete = this.settings.inkSidecarV2Migrated === true;
  const legacy = this.settings.inkAnnotations && typeof this.settings.inkAnnotations === "object"
    ? this.settings.inkAnnotations : {};
  this._lmbInkDocs = {};
  this._lmbInkDirtyPaths = new Set();
  this._lmbInkDirtyRevisions = new Map();
  this._lmbInkLoadedPaths = new Set();
  this._lmbInkLoadPromises = new Map();
  this._lmbInkLoadErrors = new Set();
  this._lmbInkRetryCount = 0;
  this._lmbInkLastBackup = new Map();
  this._lmbInkSaveState = "saved";
  try {
    const adapter = this.app.vault.adapter, dir = this.lmbInkStorageDir();
    if (!adapter || typeof adapter.read !== "function" || typeof adapter.write !== "function") throw new Error("adapter unavailable");
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    const legacyPaths = Object.keys(legacy);
    for (const path of legacyPaths) {
      const sidecar = await this.lmbReadInkSidecar(path, adapter, dir);
      this._lmbInkDocs[path] = lmbInkMergePages(sidecar && sidecar.pages, legacy[path]);
      this._lmbInkLoadedPaths.add(path);
      this._lmbInkDirtyPaths.add(path);
      this._lmbInkDirtyRevisions.set(path, 1);
    }
    this._lmbInkSidecarReady = true;
    if (legacyPaths.length) {
      await this.lmbFlushInkStorage();
      this.settings.inkAnnotations = {};
      this.settings.inkSidecarV2Migrated = true;
      return true;
    }
    this.settings.inkSidecarV2Migrated = true;
    return !migrationWasComplete;
  } catch (error) {
    console.warn("[lmb] ink sidecar unavailable; retaining data.json fallback", error);
    this._lmbInkDocs = legacy;
    this._lmbInkSidecarReady = false;
    this._lmbInkSaveState = "error";
    return false;
  }
};

LuciasMarginBookPlugin.prototype.lmbReadInkSidecar = async function (path, adapter, dir) {
  const target = normalizePath(`${dir || this.lmbInkStorageDir()}/${lmbInkFileKey(path)}`);
  let sawExisting = false, best = null;
  for (const candidate of [target, target + ".tmp", target + ".bak"]) {
    try {
      if (!(await adapter.exists(candidate))) continue;
      sawExisting = true;
      const doc = JSON.parse(await adapter.read(candidate));
      if (doc && doc.version === LMB_INK_SCHEMA_VERSION && doc.pdfPath === path && doc.pages && typeof doc.pages === "object") {
        const rank = Math.max(Number(doc.revision) || 0, Number(doc.savedAt) || 0);
        if (!best || rank > best.rank) best = { doc, rank };
        continue;
      }
      console.warn("[lmb] incompatible ink sidecar", candidate);
    } catch (error) { console.warn("[lmb] failed to read ink sidecar", candidate, error); }
  }
  if (best) return best.doc;
  if (sawExisting) throw new Error(`No valid ink sidecar copy for ${path}`);
  return null;
};

LuciasMarginBookPlugin.prototype.lmbEnsureInkDocument = function (path) {
  if (!path || !this._lmbInkSidecarReady || this._lmbInkLoadedPaths && this._lmbInkLoadedPaths.has(path)) return Promise.resolve(true);
  if (this._lmbInkLoadErrors && this._lmbInkLoadErrors.has(path)) return Promise.resolve(false);
  if (this._lmbInkLoadPromises.has(path)) return this._lmbInkLoadPromises.get(path);
  const promise = (async () => {
    try {
      const doc = await this.lmbReadInkSidecar(path, this.app.vault.adapter, this.lmbInkStorageDir());
      this._lmbInkDocs[path] = doc ? doc.pages : {};
      this._lmbInkLoadedPaths.add(path);
      document.querySelectorAll(".lmb-ink-layer").forEach((canvas) => {
        if (canvas.dataset.lmbInkPath === path) canvas.dataset.lmbInkDrawn = "0";
      });
      this.lmbScheduleInkRefresh(0);
      return true;
    } catch (error) {
      console.warn("[lmb] lazy ink load failed", path, error);
      if (this._lmbInkLoadErrors) this._lmbInkLoadErrors.add(path);
      this._lmbInkSaveState = "error"; this.lmbUpdateInkSaveStatus(); return false;
    } finally { this._lmbInkLoadPromises.delete(path); }
  })();
  this._lmbInkLoadPromises.set(path, promise);
  return promise;
};

LuciasMarginBookPlugin.prototype.lmbInkDocumentReady = function (path) {
  return !this._lmbInkSidecarReady || !this._lmbInkLoadedPaths || this._lmbInkLoadedPaths.has(path);
};

LuciasMarginBookPlugin.prototype.lmbHandleInkPdfRename = async function (file, oldPath) {
  if (!file || file.extension !== "pdf" || !oldPath || oldPath === file.path) return false;
  try {
    let oldPages = this._lmbInkDocs && this._lmbInkDocs[oldPath];
    if (!oldPages && this._lmbInkSidecarReady) {
      const oldDoc = await this.lmbReadInkSidecar(oldPath, this.app.vault.adapter, this.lmbInkStorageDir());
      oldPages = oldDoc && oldDoc.pages;
    }
    if (!oldPages) return false;
    let newPages = this._lmbInkDocs && this._lmbInkDocs[file.path];
    if (!newPages && this._lmbInkSidecarReady) {
      const newDoc = await this.lmbReadInkSidecar(file.path, this.app.vault.adapter, this.lmbInkStorageDir());
      newPages = newDoc && newDoc.pages;
    }
    this._lmbInkDocs[file.path] = lmbInkMergePages(newPages, oldPages);
    delete this._lmbInkDocs[oldPath];
    if (this._lmbInkDirtyPaths) this._lmbInkDirtyPaths.delete(oldPath);
    if (this._lmbInkDirtyRevisions) this._lmbInkDirtyRevisions.delete(oldPath);
    if (this._lmbInkLoadedPaths) { this._lmbInkLoadedPaths.delete(oldPath); this._lmbInkLoadedPaths.add(file.path); }
    if (this._lmbInkHistory) {
      for (const [key, history] of Array.from(this._lmbInkHistory.entries())) if (key.startsWith(oldPath + "\n")) {
        this._lmbInkHistory.delete(key); this._lmbInkHistory.set(file.path + key.slice(oldPath.length), history);
      }
    }
    this.lmbMarkInkDirty(file.path);
    await this.lmbFlushInkStorage();
    if (this.settings.inkExcerptLinks && this.settings.inkExcerptLinks[oldPath]) {
      const oldLinks = this.settings.inkExcerptLinks[oldPath];
      this.settings.inkExcerptLinks[file.path] = { ...oldLinks, ...(this.settings.inkExcerptLinks[file.path] || {}) };
      delete this.settings.inkExcerptLinks[oldPath];
      if (this.settings.inkLinkCounters && this.settings.inkLinkCounters[oldPath]) {
        this.settings.inkLinkCounters[file.path] = Math.max(this.settings.inkLinkCounters[file.path] || 1, this.settings.inkLinkCounters[oldPath]);
        delete this.settings.inkLinkCounters[oldPath];
      }
      await this.saveSettings(); this.lmbScheduleInkReferenceRefresh();
    }
    this.lmbScheduleInkRefresh(0); return true;
  } catch (error) { console.warn("[lmb] PDF ink rename migration failed", oldPath, file.path, error); return false; }
};

LuciasMarginBookPlugin.prototype.lmbInkId = function () {
  return "ink-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
};

LuciasMarginBookPlugin.prototype.lmbInkObjects = function (path, page, create) {
  const store = this.lmbInkStore();
  if (!store[path] && create) store[path] = {};
  if (!store[path]) return [];
  const key = String(page), value = store[path][key];
  if (Array.isArray(value)) store[path][key] = { objects: value.map((stroke) => Object.assign({ type: "pen", id: this.lmbInkId() }, stroke)) };
  if (!store[path][key] && create) store[path][key] = { objects: [] };
  const pageData = store[path][key];
  if (!pageData || !Array.isArray(pageData.objects)) return [];
  let normalized = false;
  const seenIds = new Set();
  for (const object of pageData.objects) {
    if (!object.id || seenIds.has(object.id)) { object.id = this.lmbInkId(); normalized = true; }
    seenIds.add(object.id);
    if (!object.type) { object.type = "pen"; normalized = true; }
  }
  if (normalized && this.lmbInkDocumentReady(path)) this.lmbMarkInkDirty(path);
  return pageData.objects;
};

LuciasMarginBookPlugin.prototype.lmbReplaceInkObjects = function (path, page, objects) {
  const store = this.lmbInkStore();
  if (!store[path]) store[path] = {};
  store[path][String(page)] = { objects: lmbInkClone(objects || []) };
  this.lmbInvalidateInkSpatial(path, page);
};

LuciasMarginBookPlugin.prototype.lmbMarkInkDirty = function (path) {
  if (!path) return;
  if (!this._lmbInkDirtyPaths) this._lmbInkDirtyPaths = new Set();
  if (!this._lmbInkDirtyRevisions) this._lmbInkDirtyRevisions = new Map();
  this._lmbInkDirtyPaths.add(path);
  this._lmbInkDirtyRevisions.set(path, (this._lmbInkDirtyRevisions.get(path) || 0) + 1);
  this._lmbInkRetryCount = 0;
  this._lmbInkSaveState = "saving";
  if (typeof document !== "undefined" && this.settings.inkExcerptLinks && this.settings.inkExcerptLinks[path]) this.lmbScheduleInkReferenceRefresh();
  this.lmbUpdateInkSaveStatus();
  clearTimeout(this._lmbInkSaveTimer);
  // Coalesce short pen lifts into one durable snapshot. 350ms caused a full
  // sidecar rewrite between normal handwriting strokes.
  this._lmbInkSaveTimer = setTimeout(() => this.lmbFlushInkStorage().catch(() => {}), 800);
};

LuciasMarginBookPlugin.prototype.lmbFlushInkStorage = async function () {
  if (this._lmbInkFlushPromise) return this._lmbInkFlushPromise;
  if (!this._lmbInkLastBackup) this._lmbInkLastBackup = new Map();
  this._lmbInkFlushPromise = (async () => {
    const paths = Array.from(this._lmbInkDirtyPaths || []).map((path) => [path, this._lmbInkDirtyRevisions && this._lmbInkDirtyRevisions.get(path) || 0]);
    if (!paths.length) { this._lmbInkSaveState = "saved"; this.lmbUpdateInkSaveStatus(); return true; }
    try {
      if (!this._lmbInkSidecarReady) {
        this.settings.inkAnnotations = this.lmbInkStore();
        await this.saveSettings();
      } else {
        const adapter = this.app.vault.adapter, dir = this.lmbInkStorageDir();
        for (const [path] of paths) {
          const target = normalizePath(`${dir}/${lmbInkFileKey(path)}`), temp = target + ".tmp", backup = target + ".bak";
          const body = JSON.stringify({ version: LMB_INK_SCHEMA_VERSION, pdfPath: path, revision: this._lmbInkDirtyRevisions.get(path) || 0, savedAt: Date.now(), pages: this.lmbInkStore()[path] || {} });
          await adapter.write(temp, body);
          // Keep recovery guarantees without six I/O operations per stroke:
          // the temp file is already a complete recoverable copy, and the
          // older target only needs refreshing into .bak occasionally.
          const lastBackup = this._lmbInkLastBackup && this._lmbInkLastBackup.get(path) || 0;
          if (Date.now() - lastBackup > 30000 && await adapter.exists(target)) {
            try {
              await adapter.write(backup, await adapter.read(target));
              this._lmbInkLastBackup.set(path, Date.now());
            } catch (_) {}
          }
          await adapter.write(target, body);
          const written = await adapter.read(target);
          const verified = JSON.parse(written);
          if (verified.pdfPath !== path || verified.version !== LMB_INK_SCHEMA_VERSION) throw new Error("ink sidecar verification failed");
          if (written !== body) throw new Error("ink sidecar content verification failed");
        }
      }
      for (const [path, revision] of paths) if ((this._lmbInkDirtyRevisions.get(path) || 0) === revision) this._lmbInkDirtyPaths.delete(path);
      this._lmbInkRetryCount = 0;
      this._lmbInkSaveState = this._lmbInkDirtyPaths.size ? "saving" : "saved";
      this.lmbUpdateInkSaveStatus();
      return true;
    } catch (error) {
      this._lmbInkSaveState = "error";
      this.lmbUpdateInkSaveStatus();
      console.warn("[lmb] ink save failed", error);
      this._lmbInkRetryCount = (this._lmbInkRetryCount || 0) + 1;
      if (this._lmbInkRetryCount === 1) new Notice("MarginBook：手写批注保存失败，原数据仍保留，将稍后重试", 5000);
      throw error;
    } finally {
      this._lmbInkFlushPromise = null;
      if (!this._unloaded && this._lmbInkDirtyPaths && this._lmbInkDirtyPaths.size && this._lmbInkRetryCount <= 5) {
        clearTimeout(this._lmbInkSaveTimer);
        const delays = [1000, 2000, 5000, 15000, 60000];
        this._lmbInkSaveTimer = setTimeout(() => this.lmbFlushInkStorage().catch(() => {}), delays[Math.max(0, this._lmbInkRetryCount - 1)] || 60000);
      }
    }
  })();
  return this._lmbInkFlushPromise;
};

LuciasMarginBookPlugin.prototype.lmbSaveInkSoon = function (path) {
  const canvas = this.lmbActiveInkCanvas();
  this.lmbMarkInkDirty(path || canvas && canvas.dataset.lmbInkPath);
};

LuciasMarginBookPlugin.prototype.lmbSetInkMode = async function (on) {
  const request = this._lmbInkModeRequest = (this._lmbInkModeRequest || 0) + 1;
  if (on) {
    // Finish notes through their existing save queue, including IME/failure
    // guards. Never cover an unsaved Markdown editor with the ink surface.
    const editors = new Set(Array.from(this._lmbActiveInlineBlocks || [], block => block._lmbInlineEditor).filter(Boolean));
    for (const bar of document.querySelectorAll(".lmb-pdf-excerpt-sidebar")) if (bar._lmbSidebarEditor) editors.add(bar._lmbSidebarEditor);
    for (const editor of editors) if (!await editor.save()) return false;
    if (request !== this._lmbInkModeRequest) return false;
  }
  document.querySelectorAll(".page[data-lmb-ink-bound]").forEach(page => { if (page._lmbFinishInk) page._lmbFinishInk(); });
  this.inkMode = !!on;
  if (!this.inkTool || !LMB_INK_TOOLS.includes(this.inkTool)) this.inkTool = this.settings.inkLastTool || "pen";
  this.inkColor = this.inkColor || this.settings.inkPenColor || "#e05252";
  this.inkWidth = Number(this.inkWidth || this.settings.inkPenWidth) || 3;
  if (this.inkMode && this.rectMode && typeof this.setRectMode === "function") this.setRectMode(false);
  try {
    document.body.toggleClass("lmb-ink-mode", this.inkMode);
    document.body.toggleClass("lmb-ink-capture", this.inkMode && this.inkTool !== "hand");
    document.querySelectorAll(".lmb-toolbar-ink").forEach((el) => el.toggleClass("is-active", this.inkMode));
  } catch (_) {}
  this.lmbRefreshInkLayers();
  this.lmbRenderInkTools();
  new Notice(this.inkMode ? "MarginBook：手写批注已开启；笔书写，手指滚动和缩放" : "MarginBook：手写批注已关闭", 1800);
};

LuciasMarginBookPlugin.prototype.lmbScheduleInkRefresh = function (delay) {
  clearTimeout(this._lmbInkRefreshTimer);
  this._lmbInkRefreshTimer = setTimeout(() => this.lmbRefreshInkLayers(), Number(delay) || 0);
};

LuciasMarginBookPlugin.prototype.lmbRefreshInkLayers = function () {
  try {
    const leaves = this.app.workspace.getLeavesOfType("pdf") || [];
    for (const leaf of leaves) {
      const file = leaf && leaf.view && leaf.view.file, root = leaf && leaf.containerEl;
      if (!file || !root) continue;
      this.lmbEnsureInkDocument(file.path).catch(() => {});
      root.querySelectorAll(".page").forEach((pageEl, index) => {
        pageEl._lmbInkPageContext = { path: file.path, index };
        if (this._lmbInkVisibilityObserver && !this._lmbInkObservedPages.has(pageEl)) {
          this._lmbInkObservedPages.add(pageEl);
          this._lmbInkVisibilityObserver.observe(pageEl);
        }
        this.lmbEnsureInkLayer(pageEl, file.path, index);
      });
    }
    if (this.inkMode && document.querySelectorAll(".lmb-ink-tools").length !== leaves.length) this.lmbRenderInkTools();
  } catch (error) { console.warn("[lmb] ink refresh failed", error); }
};

LuciasMarginBookPlugin.prototype.lmbEnsureInkLayer = function (pageEl, pdfPath, fallbackIndex) {
  if (!pageEl || !pdfPath) return;
  const pageNumber = Number(pageEl.dataset.pageNumber) || fallbackIndex + 1;
  if (this.settings.pdfTextBlocks && this.settings.pdfTextBlocks[pdfPath] || this._lmbActiveInlineBlocks && this._lmbActiveInlineBlocks.size)
    this.lmbRenderTextBlocksOnPage(pageEl, pdfPath).catch((err) => console.warn("[lmb] text block render failed", err));
  // Capture policy must update synchronously when ink mode toggles; waiting for
  // IntersectionObserver leaves PDF.js in control of the first Pencil stroke.
  this.lmbUpdateInkPageCapture(pageEl);
  // IntersectionObserver includes the PDF scroller's clipping, not just the window.
  if (this._lmbInkVisibilityObserver && pageEl._lmbInkNearViewport !== true) {
    let visiblyNear = false;
    if (this.inkMode && typeof pageEl.getBoundingClientRect === "function") {
      try {
        const rect = pageEl.getBoundingClientRect();
        const viewer = pageEl.closest && pageEl.closest(".pdf-viewer-container");
        const clip = viewer && viewer.getBoundingClientRect ? viewer.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        visiblyNear = rect.bottom >= clip.top - 300 && rect.top <= clip.bottom + 300;
      } catch (_) {}
    }
    if (!visiblyNear) return;
    pageEl._lmbInkNearViewport = true;
  }
  if (!this.inkMode && !this.lmbInkObjects(pdfPath, pageNumber).length) {
    for (const layer of pageEl.querySelectorAll(":scope > .lmb-ink-layer, :scope > .lmb-ink-live-layer")) {
      layer.style.display = "none";
      if (layer.width !== 1 || layer.height !== 1) { layer.width = 1; layer.height = 1; }
      layer.dataset.lmbInkDrawn = "0";
    }
    return;
  }
  let canvas = pageEl.querySelector(":scope > .lmb-ink-layer");
  let live = pageEl.querySelector(":scope > .lmb-ink-live-layer");
  if (!canvas) { canvas = document.createElement("canvas"); canvas.className = "lmb-ink-layer"; pageEl.appendChild(canvas); }
  if (!live) { live = document.createElement("canvas"); live.className = "lmb-ink-live-layer"; pageEl.appendChild(live); }
  const identity = `${pdfPath}\n${pageNumber}`, identityChanged = canvas.dataset.lmbInkIdentity !== identity;
  if (identityChanged && pageEl._lmbFinishInk) pageEl._lmbFinishInk();
  for (const layer of [canvas, live]) {
    layer.dataset.lmbInkPath = pdfPath; layer.dataset.lmbInkPage = String(pageNumber);
    layer.dataset.lmbInkIdentity = identity;
    layer.style.display = "block";
  }
  this.lmbUpdateInkPageCapture(pageEl);
  const width = Math.max(1, Math.round(pageEl.clientWidth)), height = Math.max(1, Math.round(pageEl.clientHeight));
  const ratio = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
  let resized = false;
  for (const layer of [canvas, live]) {
    if (layer.width !== Math.round(width * ratio) || layer.height !== Math.round(height * ratio)) {
      layer.width = Math.round(width * ratio); layer.height = Math.round(height * ratio);
      layer.style.width = width + "px"; layer.style.height = height + "px"; resized = true;
    }
  }
  if (!pageEl.dataset.lmbInkBound || pageEl._lmbInkInputSurface && pageEl._lmbInkInputSurface !== live) {
    if (pageEl._lmbFinishInk) pageEl._lmbFinishInk();
    pageEl.dataset.lmbInkBound = "1";
    pageEl._lmbInkInputSurface = live;
    this.lmbBindInkPage(pageEl, canvas, live);
  }
    if (!pageEl._lmbInkResizeObserver && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        clearTimeout(pageEl._lmbInkResizeTimer);
        pageEl._lmbInkResizeTimer = setTimeout(() => {
          const context = pageEl._lmbInkPageContext;
          if (!this._unloaded && pageEl.isConnected && context) this.lmbEnsureInkLayer(pageEl, context.path, context.index);
        }, 100);
      });
      observer.observe(pageEl); pageEl._lmbInkResizeObserver = observer;
    }
  if (identityChanged) { canvas.dataset.lmbInkDrawn = "0"; this.lmbDrawInkLiveLayer(live, null); }
  if (identityChanged || resized || canvas.dataset.lmbInkDrawn !== "1") this.lmbDrawInkLayer(canvas);
};

LuciasMarginBookPlugin.prototype.lmbUpdateInkPageCapture = function (pageEl, forceOff) {
  if (!pageEl || !pageEl.style) return;
  const capture = !forceOff && this.inkMode && this.inkTool !== "hand" && !this._lmbInkSpacePan;
  if (capture) {
    if (!pageEl._lmbInkTouchActionBefore) pageEl._lmbInkTouchActionBefore = {
      value: pageEl.style.getPropertyValue("touch-action"),
      priority: pageEl.style.getPropertyPriority("touch-action"),
      callout: pageEl.style.getPropertyValue("-webkit-touch-callout")
    };
    pageEl.style.setProperty("touch-action", "none", "important");
    pageEl.style.setProperty("-webkit-touch-callout", "none", "important");
    const live = pageEl.querySelector && pageEl.querySelector(":scope > .lmb-ink-live-layer");
    if (live && live.style) {
      live.style.setProperty("pointer-events", "auto", "important");
      live.style.setProperty("touch-action", "none", "important");
      live.style.setProperty("-webkit-touch-callout", "none", "important");
      live.dataset.lmbInkInputSurface = "active";
    }
    return;
  }
  const live = pageEl.querySelector && pageEl.querySelector(":scope > .lmb-ink-live-layer");
  if (live && live.style) {
    live.style.setProperty("pointer-events", "none", "important");
    live.style.removeProperty("touch-action");
    live.style.removeProperty("-webkit-touch-callout");
    delete live.dataset.lmbInkInputSurface;
  }
  const before = pageEl._lmbInkTouchActionBefore;
  if (!before) return;
  if (before.value) pageEl.style.setProperty("touch-action", before.value, before.priority || "");
  else pageEl.style.removeProperty("touch-action");
  if (before.callout) pageEl.style.setProperty("-webkit-touch-callout", before.callout);
  else pageEl.style.removeProperty("-webkit-touch-callout");
  pageEl._lmbInkTouchActionBefore = null;
};

LuciasMarginBookPlugin.prototype.lmbInkPoint = function (pageEl, event) {
  const rect = pageEl.getBoundingClientRect();
  const rawTime = Number(event.timeStamp);
  const pressure = Number(event.pressure) > 0 ? Number(event.pressure) : Number(event.force) > 0 ? Number(event.force) : .5;
  return lmbInkNormalizePoint({ x: (event.clientX - rect.left) / Math.max(1, rect.width), y: (event.clientY - rect.top) / Math.max(1, rect.height), p: pressure, t: Number.isFinite(rawTime) ? rawTime : Date.now() });
};

LuciasMarginBookPlugin.prototype.lmbInkEventPoints = function (pageEl, event) {
  let events = [event];
  try {
    if (typeof event.getCoalescedEvents === "function") {
      const coalesced = event.getCoalescedEvents();
      if (Array.isArray(coalesced) && coalesced.length) {
        events = coalesced.slice();
        const last = events[events.length - 1];
        if (last.clientX !== event.clientX || last.clientY !== event.clientY || last.timeStamp !== event.timeStamp) events.push(event);
      }
    }
  } catch (_) {}
  return events.map((sample) => this.lmbInkPoint(pageEl, sample));
};

LuciasMarginBookPlugin.prototype.lmbInkShouldDraw = function (event) {
  if (!this.inkMode || this._lmbInkSpacePan || this.inkTool === "hand") return false;
  if (event.pointerType === "touch" && !lmbInkIsStylusInput(event)) return false;
  if (event.pointerType === "mouse" && this.settings.inkInputMode === "pen-only") return false;
  return event.pointerType !== "mouse" || event.button === 0;
};

LuciasMarginBookPlugin.prototype.lmbBindInkPage = function (pageEl, canvas, live) {
  let active = null;
  const inputSurface = live || pageEl;
  // Share navigation contacts across pages in the same PDF (two fingers may
  // land on different pages). A pen takes ownership until its contacts lift.
  const host = pageEl.closest && (pageEl.closest(".pdf-viewer-container") || pageEl.closest(".view-content"));
  const navigation = host ? (host._lmbInkNavigation || (host._lmbInkNavigation = { points: new Map() })) : { points: new Map() };
  const touchPoints = navigation.points;
  const stylusTouchIds = new Set();
  const path = () => canvas.dataset.lmbInkPath, page = () => canvas.dataset.lmbInkPage;
  const scrollHost = () => pageEl.closest && (pageEl.closest(".pdf-viewer-container") || pageEl.closest(".view-content"));
  const resetTouchPan = () => {
    navigation.pan = null; navigation.pinch = null;
    if (Array.from(touchPoints.values()).some(p => p.blocked)) return;
    const entry = touchPoints.values().next().value, host = scrollHost();
    if (touchPoints.size === 1) navigation.pan = entry && host ? { id: entry.id, x: entry.x, y: entry.y, left: host.scrollLeft, top: host.scrollTop, host } : null;
    else if (touchPoints.size === 2 && host) {
      const pair = Array.from(touchPoints.values()), viewer = this.lmbInkZoomViewer && this.lmbInkZoomViewer(pageEl);
      navigation.pinch = { distance: Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y), viewer };
    }
  };
  const redrawLive = () => this.lmbRequestInkLiveDraw(live, active);
  const down = (event) => {
    if (!this.inkMode || this.inkTool === "hand" || this._lmbInkSpacePan || lmbInkIsTextInput(event.target)) return;
    const stylus = lmbInkIsStylusInput(event);
    if (stylus && stylusTouchIds.size && !String(event.pointerId || "").startsWith("stylus-touch-")) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (event.pointerType === "touch" && !stylus) {
      const blocked = !!navigation.pen || Date.now() < (navigation.penUntil || 0) || Number(event.width) > 45 || Number(event.height) > 45;
      touchPoints.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY, blocked });
      try { inputSurface.setPointerCapture(event.pointerId); } catch (_) {}
      resetTouchPan();
      event.preventDefault(); event.stopPropagation();
      return;
    }
    if (active || navigation.pen || this._lmbInkPenActive) return;
    if (!this.lmbInkShouldDraw(event)) return;
    if (!this.lmbInkDocumentReady(path())) {
      this.lmbEnsureInkDocument(path()).catch(() => {});
      new Notice(this._lmbInkLoadErrors && this._lmbInkLoadErrors.has(path()) ? "MarginBook：此 PDF 的批注文件无法读取，已停止写入以保护数据" : "MarginBook：正在加载此 PDF 的批注，请稍后再写", 2600); return;
    }
    const objects = this.lmbInkObjects(path(), page(), true), point = this.lmbInkPoint(pageEl, event);
    let tool = this.inkTool;
    if (stylus && (event.button === 5 || event.button === 2 || (event.buttons & 32))) tool = "eraser";
    event.preventDefault(); event.stopPropagation();
    navigation.pen = event.pointerId; navigation.penUntil = Date.now() + 300;
    this._lmbInkPenActive = true;
    for (const p of touchPoints.values()) p.blocked = true;
    navigation.pan = null; navigation.pinch = null;
    try { inputSurface.setPointerCapture(event.pointerId); } catch (_) {}
    const before = lmbInkClone(objects);
    if (tool === "text") { navigation.pen = null; this._lmbInkPenActive = false; this.lmbStartInkText(canvas, point); return; }
    if (tool === "select") {
      if (this._lmbInkSelectionContext && this._lmbInkSelectionContext.canvas !== canvas) {
        const oldLive = this._lmbInkSelectionContext.canvas && this._lmbInkSelectionContext.canvas.parentElement && this._lmbInkSelectionContext.canvas.parentElement.querySelector(":scope > .lmb-ink-live-layer");
        this._lmbInkSelection = []; this._lmbInkSelectionContext = null; if (oldLive) this.lmbDrawInkLiveLayer(oldLive, null);
      }
      active = this.lmbStartInkSelection(canvas, point, objects, event.shiftKey);
      if (!active) active = { kind: "lasso", points: [point], before, additive: !!event.shiftKey, priorSelection: (this._lmbInkSelection || []).slice() };
      else active.beforePage = before;
      active.pointerId = event.pointerId;
      this._lmbInkHiddenIds = new Set(active.kind === "moveMulti" ? active.entries.map((entry) => entry.object.id) : active.object ? [active.object.id] : []);
      this.lmbDrawInkLayer(canvas); redrawLive(); return;
    }
    if (tool === "eraser") { active = { kind: "erase", before, removed: new Set(), point, pointerId: event.pointerId, eraserMode: this.settings.inkEraserMode || "partial", returnTool: this.inkTool === "eraser" && this.settings.inkEraserAutoReturn !== false ? this._lmbInkLastDrawTool || "pen" : null }; this.lmbEraseAt(canvas, point, active); redrawLive(); return; }
    const preset = tool === "highlighter"
      ? { color: this.settings.inkHighlighterColor || "#ffd84d", width: Number(this.settings.inkHighlighterWidth) || 12, opacity: .3 }
      : { color: this.inkColor, width: this.inkWidth, opacity: 1 };
    const object = { id: this.lmbInkId(), type: tool, color: preset.color, opacity: preset.opacity, width: preset.width / 1000, widthUnit: "page", pressureMode: this.settings.inkPressureMode || "natural", x1: point.x, y1: point.y, x2: point.x, y2: point.y, points: [point] };
    active = { kind: "draw", object, before, pointerId: event.pointerId }; redrawLive();
  };
  const move = (event) => {
    if (event.pointerType === "touch" && !lmbInkIsStylusInput(event)) {
      const point = touchPoints.get(event.pointerId);
      if (!point) return;
      event.preventDefault(); event.stopPropagation();
      if (navigation.pen || point.blocked) return;
      point.x = event.clientX; point.y = event.clientY;
      const touchPan = navigation.pan, pinch = navigation.pinch;
      if (touchPoints.size === 1 && touchPan && touchPan.id === event.pointerId && Math.hypot(event.clientX - touchPan.x, event.clientY - touchPan.y) >= 6) {
        touchPan.host.scrollLeft = touchPan.left - (event.clientX - touchPan.x);
        touchPan.host.scrollTop = touchPan.top - (event.clientY - touchPan.y);
      } else if (touchPoints.size === 2 && pinch && pinch.viewer) {
        const pair = Array.from(touchPoints.values()), distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (pinch.distance > 10 && distance > 10) {
          const host = scrollHost(), rect = host.getBoundingClientRect(), cx = (pair[0].x + pair[1].x) / 2 - rect.left, cy = (pair[0].y + pair[1].y) / 2 - rect.top;
          const before = Number(pinch.viewer.currentScale), next = lmbInkClamp(before * distance / pinch.distance, .25, 5);
          if (before > 0 && Math.abs(next - before) > .001) {
            const left = host.scrollLeft, top = host.scrollTop;
            pinch.viewer.currentScale = next;
            host.scrollLeft = (left + cx) * next / before - cx; host.scrollTop = (top + cy) * next / before - cy;
          }
        }
        pinch.distance = distance;
      }
      return;
    }
    if (!active || active.pointerId != null && event.pointerId !== active.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const points = this.lmbInkEventPoints(pageEl, event), point = points[points.length - 1];
    if (active.kind === "draw") {
      const object = active.object;
      if (object.type === "pen" || object.type === "highlighter") lmbInkAppendSamples(object.points, points, .0003);
      else { object.x2 = point.x; object.y2 = point.y; }
    } else if (active.kind === "erase") for (const sample of points) this.lmbEraseAt(canvas, sample, active);
    else if (active.kind === "lasso") lmbInkAppendSamples(active.points, points, .0015);
    else this.lmbMoveInkSelection(active, point);
    redrawLive();
  };
  const finish = (event, cancelled) => {
    if (event && event.pointerType === "touch" && !lmbInkIsStylusInput(event)) {
      touchPoints.delete(event.pointerId);
      event.preventDefault(); event.stopPropagation();
      resetTouchPan();
      return;
    }
    if (!active || event && active.pointerId != null && event.pointerId !== active.pointerId) return;
    if (event) { event.preventDefault(); event.stopPropagation(); }
    if (!cancelled && event) {
      const finalPoints = this.lmbInkEventPoints(pageEl, event), finalPoint = finalPoints[finalPoints.length - 1];
      if (active.kind === "draw") {
        if (active.object.type === "pen" || active.object.type === "highlighter") lmbInkAppendSamples(active.object.points, finalPoints, .00005);
        else { active.object.x2 = finalPoint.x; active.object.y2 = finalPoint.y; }
      } else if (active.kind === "erase") for (const sample of finalPoints) this.lmbEraseAt(canvas, sample, active);
      else if (active.kind === "lasso") lmbInkAppendSamples(active.points, finalPoints, .0005);
      else if (!["selectionOnly"].includes(active.kind)) this.lmbMoveInkSelection(active, finalPoint);
    }
    const current = active; active = null;
    live._lmbInkPendingActive = null;
    navigation.pen = null; navigation.penUntil = Date.now() + 300;
    this._lmbInkPenActive = false; this._lmbInkPalmUntil = Date.now() + 300;
    const objects = this.lmbInkObjects(path(), page(), true);
    const salvageCancelledStroke = cancelled && current.kind === "draw"
      && (current.object.type === "pen" || current.object.type === "highlighter")
      && Array.isArray(current.object.points) && current.object.points.length > 1;
    if (cancelled && !salvageCancelledStroke) this.lmbReplaceInkObjects(path(), page(), current.beforePage || current.before || objects);
    else if (current.kind === "draw") {
      const object = current.object;
      if (object.type === "pen" || object.type === "highlighter") object.points = lmbInkSimplifyPoints(object.points, .00018, .055);
      const isStroke = object.type === "pen" || object.type === "highlighter";
      const longEnough = Math.hypot((object.x2 || 0) - (object.x1 || 0), (object.y2 || 0) - (object.y1 || 0)) > .001;
      if (isStroke || longEnough) objects.push(object);
      this.lmbCommitInkChange(path(), page(), current.before, "draw");
    } else if (current.kind === "lasso") {
      const selected = lmbInkObjectsInLasso(objects, current.points);
      const selectedIds = selected.map((object) => object.id);
      this._lmbInkSelection = current.additive ? Array.from(new Set((current.priorSelection || []).concat(selectedIds))) : selectedIds;
      this._lmbInkSelectionContext = { canvas, path: path(), page: page() };
    } else if (current.kind === "erase") this.lmbCommitInkChange(path(), page(), current.before, "erase");
    else this.lmbCommitInkChange(path(), page(), current.beforePage, current.kind);
    this._lmbInkHiddenIds = null;
    this.lmbDrawInkLayer(canvas); this.lmbDrawInkLiveLayer(live, null);
    if (this.inkTool === "select") this.lmbRenderInkTools();
    if (current.kind === "erase" && current.returnTool && !cancelled && this.inkTool === "eraser") this.lmbSetInkTool(current.returnTool);
  };
  const captureActive = { capture: true, passive: false };
  inputSurface.addEventListener("pointerdown", down, captureActive);
  inputSurface.addEventListener("pointermove", move, captureActive);
  inputSurface.addEventListener("pointerup", (event) => finish(event, false), captureActive);
  inputSurface.addEventListener("pointercancel", (event) => finish(event, true), captureActive);
  inputSurface.addEventListener("lostpointercapture", (event) => finish(event, true), captureActive);
  // Flush an in-flight stroke before page recycling/tool switching. Clear a
  // queued animation as well, otherwise it can repaint a finished ghost stroke.
  pageEl._lmbFinishInk = () => {
    finish(null, true); touchPoints.clear(); navigation.pan = null; navigation.pinch = null; navigation.pen = null;
    live._lmbInkPendingActive = null;
  };
  const stylusTouches = (event) => Array.from(event.changedTouches || []).filter((touch) => lmbInkIsStylusInput(touch));
  inputSurface.addEventListener("touchstart", (event) => {
    const touches = stylusTouches(event); if (!touches.length) return;
    event.preventDefault(); event.stopPropagation();
    if (active) return;
    const touch = touches[0]; stylusTouchIds.add(touch.identifier);
    down(lmbInkTouchPointEvent(touch, event, false));
  }, captureActive);
  inputSurface.addEventListener("touchmove", (event) => {
    const touches = stylusTouches(event).filter((touch) => stylusTouchIds.has(touch.identifier)); if (!touches.length) return;
    event.preventDefault(); event.stopPropagation(); move(lmbInkTouchPointEvent(touches[0], event, false));
  }, captureActive);
  const finishStylusTouch = (event, cancelled) => {
    const touches = stylusTouches(event).filter((touch) => stylusTouchIds.has(touch.identifier)); if (!touches.length) return;
    event.preventDefault(); event.stopPropagation();
    const touch = touches[0]; finish(lmbInkTouchPointEvent(touch, event, true), cancelled); stylusTouchIds.delete(touch.identifier);
  };
  inputSurface.addEventListener("touchend", (event) => finishStylusTouch(event, false), captureActive);
  inputSurface.addEventListener("touchcancel", (event) => finishStylusTouch(event, true), captureActive);
  inputSurface.addEventListener("contextmenu", (event) => { if (this.inkMode && event.pointerType === "pen") event.preventDefault(); }, true);
};

LuciasMarginBookPlugin.prototype.lmbInkZoomViewer = function (pageEl) {
  const leaf = (this.app.workspace.getLeavesOfType("pdf") || []).find(leaf => leaf.containerEl && leaf.containerEl.contains(pageEl));
  return LmbPdfAdapter.zoomViewer(leaf && leaf.view);
};

LuciasMarginBookPlugin.prototype.lmbRequestInkLiveDraw = function (live, active) {
  live._lmbInkPendingActive = active;
  if (live._lmbInkFrame) return;
  live._lmbInkFrame = requestAnimationFrame(() => { live._lmbInkFrame = 0; this.lmbDrawInkLiveLayer(live, live._lmbInkPendingActive); });
};

LuciasMarginBookPlugin.prototype.lmbCanvasContext = function (canvas) {
  const ctx = canvas.getContext("2d"), ratio = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: canvas.clientWidth, height: canvas.clientHeight };
};

LuciasMarginBookPlugin.prototype.lmbDrawInkObject = function (ctx, object, width, height) {
  if (!object) return;
  const color = object.color || "#e05252", type = object.type;
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = object.opacity == null ? 1 : object.opacity;
  if (type === "pen" || type === "highlighter") {
    const points = object.points || [];
    if (!points.length) { ctx.restore(); return; }
    if (type === "highlighter") ctx.globalCompositeOperation = "multiply";
    if (points.length === 1) {
      const radius = lmbInkSegmentWidth(object, points[0], null, width) / 2;
      ctx.beginPath(); ctx.arc(points[0].x * width, points[0].y * height, radius, 0, Math.PI * 2); ctx.fill();
    } else if (type === "highlighter") {
      ctx.lineWidth = lmbInkSegmentWidth(object, points[0], null, width);
      ctx.beginPath(); ctx.moveTo(points[0].x * width, points[0].y * height);
      for (let i = 1; i < points.length - 1; i++) {
        const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
        ctx.quadraticCurveTo(points[i].x * width, points[i].y * height, mid.x * width, mid.y * height);
      }
      ctx.lineTo(points[points.length - 1].x * width, points[points.length - 1].y * height); ctx.stroke();
    } else {
      let previous = points[0], cursor = previous;
      for (let i = 1; i < points.length; i++) {
        const point = points[i], priorWidth = lmbInkSegmentWidth(object, previous, i > 1 ? points[i - 2] : null, width);
        ctx.lineWidth = (priorWidth + lmbInkSegmentWidth(object, point, previous, width)) / 2;
        const mid = { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
        ctx.beginPath(); ctx.moveTo(cursor.x * width, cursor.y * height); ctx.quadraticCurveTo(previous.x * width, previous.y * height, mid.x * width, mid.y * height); ctx.stroke(); cursor = mid;
        previous = point;
      }
      ctx.beginPath(); ctx.moveTo(cursor.x * width, cursor.y * height); ctx.lineTo(previous.x * width, previous.y * height); ctx.stroke();
    }
  } else {
    ctx.lineWidth = object.widthUnit === "page" ? Math.max(.5, object.width * width) : Number(object.width) || 3;
    if (type === "line") { ctx.beginPath(); ctx.moveTo(object.x1 * width, object.y1 * height); ctx.lineTo(object.x2 * width, object.y2 * height); ctx.stroke(); }
    else if (type === "rect") ctx.strokeRect(Math.min(object.x1, object.x2) * width, Math.min(object.y1, object.y2) * height, Math.abs(object.x2 - object.x1) * width, Math.abs(object.y2 - object.y1) * height);
    else if (type === "text") {
      const size = object.fontUnit === "page" ? Math.max(9, object.fontSize * width) : object.fontSize || 16;
      ctx.font = `${size}px sans-serif`; ctx.textBaseline = "top";
      String(object.text || "").split("\n").forEach((line, index) => ctx.fillText(line, object.x * width, object.y * height + index * size * 1.25, (object.w || .24) * width));
    }
  }
  ctx.restore();
};

LuciasMarginBookPlugin.prototype.lmbDrawInkLayer = function (canvas) {
  const info = this.lmbCanvasContext(canvas); if (!info) return;
  info.ctx.clearRect(0, 0, info.width, info.height);
  const hidden = this._lmbInkHiddenIds || new Set();
  for (const object of this.lmbInkObjects(canvas.dataset.lmbInkPath, canvas.dataset.lmbInkPage)) if (!hidden.has(object.id)) this.lmbDrawInkObject(info.ctx, object, info.width, info.height);
  canvas.dataset.lmbInkDrawn = "1";
};

LuciasMarginBookPlugin.prototype.lmbDrawInkLiveLayer = function (canvas, active) {
  this.lmbUpdateInkLocation(canvas);
  const info = this.lmbCanvasContext(canvas); if (!info) return;
  const { ctx, width, height } = info; ctx.clearRect(0, 0, width, height);
  if (active && active.kind === "draw") this.lmbDrawInkObject(ctx, active.object, width, height);
  if (active && active.kind === "erase" && active.point) {
    ctx.save(); ctx.strokeStyle = "#64748b"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(active.point.x * width, active.point.y * height, Number(this.settings.inkEraserSize) || 18, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  if (active && ["move", "resize"].includes(active.kind)) this.lmbDrawInkObject(ctx, active.object, width, height);
  if (active && active.kind === "moveMulti") for (const entry of active.entries) this.lmbDrawInkObject(ctx, entry.object, width, height);
  if (active && active.kind === "lasso") {
    ctx.save(); ctx.strokeStyle = "#2d8cff"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.beginPath();
    active.points.forEach((point, index) => index ? ctx.lineTo(point.x * width, point.y * height) : ctx.moveTo(point.x * width, point.y * height)); ctx.stroke(); ctx.restore();
  }
  const selection = this._lmbInkSelectionContext;
  const editing = this.inkMode && this.inkTool === "select" && selection && selection.path === canvas.dataset.lmbInkPath && Number(selection.page) === Number(canvas.dataset.lmbInkPage);
  // Read-only location uses the persistent labelled outline. Resize handles
  // belong only to an active edit selection on this particular PDF page.
  const selected = new Set(editing && Array.isArray(this._lmbInkSelection) ? this._lmbInkSelection : []);
  const objects = this.lmbInkObjects(canvas.dataset.lmbInkPath, canvas.dataset.lmbInkPage);
  for (const object of objects.filter((item) => selected.has(item.id))) {
    const bounds = lmbInkBounds(object);
    ctx.save(); ctx.strokeStyle = "#2d8cff"; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
    ctx.strokeRect(bounds.x * width - 4, bounds.y * height - 4, Math.max(8, bounds.w * width + 8), Math.max(8, bounds.h * height + 8));
    ctx.setLineDash([]); ctx.fillStyle = "#2d8cff";
    if (object.type === "line") {
      ctx.fillRect(object.x1 * width - 6, object.y1 * height - 6, 12, 12);
      ctx.fillRect(object.x2 * width - 6, object.y2 * height - 6, 12, 12);
    } else ctx.fillRect((bounds.x + bounds.w) * width - 6, (bounds.y + bounds.h) * height - 6, 12, 12);
    ctx.restore();
  }
};

LuciasMarginBookPlugin.prototype.lmbObjectBounds = function (object) { return lmbInkBounds(object); };

LuciasMarginBookPlugin.prototype.lmbInvalidateInkSpatial = function (path, page) {
  if (this._lmbInkSpatialCache) this._lmbInkSpatialCache.delete(`${path}\n${page}`);
};

LuciasMarginBookPlugin.prototype.lmbBuildInkSpatial = function (objects) {
  const cellSize = .05, cells = new Map(), byId = new Map();
  for (const object of objects || []) {
    if (!object || !object.id) continue; byId.set(object.id, object);
    const bounds = lmbInkBounds(object), minX = Math.floor(bounds.x / cellSize), maxX = Math.floor((bounds.x + bounds.w) / cellSize), minY = Math.floor(bounds.y / cellSize), maxY = Math.floor((bounds.y + bounds.h) / cellSize);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const key = `${x},${y}`; if (!cells.has(key)) cells.set(key, new Set()); cells.get(key).add(object.id);
    }
  }
  return { cellSize, cells, byId };
};

LuciasMarginBookPlugin.prototype.lmbInkSpatialCandidates = function (spatial, point, tolerance) {
  const ids = new Set(), size = spatial.cellSize, minX = Math.floor((point.x - tolerance) / size), maxX = Math.floor((point.x + tolerance) / size), minY = Math.floor((point.y - tolerance) / size), maxY = Math.floor((point.y + tolerance) / size);
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (const id of spatial.cells.get(`${x},${y}`) || []) ids.add(id);
  return Array.from(ids, (id) => spatial.byId.get(id)).filter(Boolean);
};

LuciasMarginBookPlugin.prototype.lmbStartInkSelection = function (canvas, point, objects, additive) {
  const tolerance = Math.max(.006, 9 / Math.max(1, canvas.clientWidth));
  const hit = objects.slice().reverse().find((object) => lmbInkObjectHit(object, point, tolerance));
  const prior = Array.isArray(this._lmbInkSelection) ? this._lmbInkSelection : [];
  if (!hit) { if (!additive) this._lmbInkSelection = []; return null; }
  const ids = additive ? (prior.includes(hit.id) ? prior.filter((id) => id !== hit.id) : prior.concat(hit.id))
    : prior.includes(hit.id) && prior.length > 1 ? prior.slice() : [hit.id];
  this._lmbInkSelection = ids; this._lmbInkSelectionContext = { canvas, path: canvas.dataset.lmbInkPath, page: canvas.dataset.lmbInkPage };
  if (!ids.includes(hit.id)) return { kind: "selectionOnly", start: point };
  if (ids.length > 1) return { kind: "moveMulti", start: point, entries: objects.filter((object) => ids.includes(object.id)).map((object) => ({ object, before: lmbInkClone(object), bounds: lmbInkBounds(object) })) };
  const bounds = lmbInkBounds(hit);
  if (hit.type === "line") {
    const d1 = lmbInkDistance(point, { x: hit.x1, y: hit.y1 }), d2 = lmbInkDistance(point, { x: hit.x2, y: hit.y2 });
    if (Math.min(d1, d2) <= tolerance * 2) return { kind: "resize", endpoint: d1 <= d2 ? 1 : 2, object: hit, start: point, before: lmbInkClone(hit), bounds };
  }
  const resize = point.x > bounds.x + bounds.w - tolerance * 2 && point.y > bounds.y + bounds.h - tolerance * 2;
  const resizeKeys = hit.type === "rect" ? { x: hit.x1 > hit.x2 ? "x1" : "x2", y: hit.y1 > hit.y2 ? "y1" : "y2" } : null;
  return { kind: resize ? "resize" : "move", resizeKeys, object: hit, start: point, before: lmbInkClone(hit), bounds };
};

LuciasMarginBookPlugin.prototype.lmbMoveInkSelection = function (selection, point) {
  if (!selection) return;
  if (selection.kind === "moveMulti") { for (const entry of selection.entries) this.lmbMoveInkSelection({ kind: "move", object: entry.object, before: entry.before, bounds: entry.bounds, start: selection.start }, point); return; }
  const object = selection.object, before = selection.before, dx = point.x - selection.start.x, dy = point.y - selection.start.y;
  if (!object) return;
  if (selection.kind === "resize") {
    if (object.type === "text") {
      const newWidth = Math.max(.04, (selection.bounds.w || .2) + dx);
      object.fontSize = Math.max(.009, Math.min(.09, (before.fontUnit === "page" ? before.fontSize : (before.fontSize || 16) / 1000) * newWidth / (selection.bounds.w || .2)));
      object.fontUnit = "page"; object.w = newWidth; object.h = Math.max(.025, (selection.bounds.h || .05) + dy);
    } else if (object.type === "pen" || object.type === "highlighter") {
      const sx = Math.max(.08, ((selection.bounds.w || .02) + dx) / (selection.bounds.w || .02)), sy = Math.max(.08, ((selection.bounds.h || .02) + dy) / (selection.bounds.h || .02));
      object.points = before.points.map((p) => Object.assign({}, p, { x: selection.bounds.x + (p.x - selection.bounds.x) * sx, y: selection.bounds.y + (p.y - selection.bounds.y) * sy }));
    } else if (object.type === "line") {
      const suffix = selection.endpoint === 1 ? "1" : "2"; object[`x${suffix}`] = before[`x${suffix}`] + dx; object[`y${suffix}`] = before[`y${suffix}`] + dy;
    } else {
      const keys = selection.resizeKeys || { x: "x2", y: "y2" }; object[keys.x] = before[keys.x] + dx; object[keys.y] = before[keys.y] + dy;
    }
  } else if (object.type === "pen" || object.type === "highlighter") object.points = before.points.map((p) => Object.assign({}, p, { x: p.x + dx, y: p.y + dy }));
  else if (object.type === "text") { object.x = before.x + dx; object.y = before.y + dy; }
  else { object.x1 = before.x1 + dx; object.y1 = before.y1 + dy; object.x2 = before.x2 + dx; object.y2 = before.y2 + dy; }
};

LuciasMarginBookPlugin.prototype.lmbEraseAt = function (canvas, point, active) {
  const objects = this.lmbInkObjects(canvas.dataset.lmbInkPath, canvas.dataset.lmbInkPage, true);
  const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
  const radius = Number(this.settings.inkEraserSize) || 18, from = active.erasePrevious || point;
  active.erasePrevious = point; active.point = point;
  let changed = false;
  for (let index = objects.length - 1; index >= 0; index--) {
    const object = objects[index], bounds = lmbInkBounds(object), pad = radius / width + (Number(object.width) || 0);
    if (bounds.x > Math.max(from.x, point.x) + pad || bounds.x + bounds.w < Math.min(from.x, point.x) - pad
      || bounds.y > Math.max(from.y, point.y) + radius / height + pad || bounds.y + bounds.h < Math.min(from.y, point.y) - radius / height - pad) continue;
    const fragments = lmbInkEraseFragments(object, from, point, radius, width, height);
    if (fragments === null && !(object.type === "text" && lmbInkObjectHit(object, point, radius / width))) continue;
    changed = true;
    if (active.eraserMode === "stroke" || fragments === null || !fragments.length) objects.splice(index, 1);
    else {
      const pieces = fragments.map((points, part) => ({ ...object,
        id: part === 0 ? object.id : this.lmbInkId(), type: object.type === "highlighter" ? "highlighter" : "pen", points,
        inkSourceIds: Array.from(new Set([...(object.inkSourceIds || []), object.id])),
        x1: points[0].x, y1: points[0].y, x2: points[points.length - 1].x, y2: points[points.length - 1].y,
        pressureMode: object.type === "line" || object.type === "rect" ? "fixed" : object.pressureMode || "natural"
      }));
      objects.splice(index, 1, ...pieces);
    }
  }
  if (changed) { this.lmbInvalidateInkSpatial(canvas.dataset.lmbInkPath, canvas.dataset.lmbInkPage); this.lmbRequestInkStaticDraw(canvas); }
};

LuciasMarginBookPlugin.prototype.lmbRequestInkStaticDraw = function (canvas) {
  if (canvas._lmbInkStaticFrame) return;
  canvas._lmbInkStaticFrame = requestAnimationFrame(() => { canvas._lmbInkStaticFrame = 0; this.lmbDrawInkLayer(canvas); });
};

LuciasMarginBookPlugin.prototype.lmbStartInkText = function (canvas, point) {
  const pageEl = canvas.parentElement, box = document.createElement("textarea");
  box.className = "lmb-ink-text-editor"; box.placeholder = "输入备注…"; box.style.left = point.x * 100 + "%"; box.style.top = point.y * 100 + "%"; box.style.color = this.inkColor;
  pageEl.appendChild(box); box.focus(); let finished = false;
  const finish = (save) => {
    if (finished) return; finished = true;
    const text = box.value.trim();
    if (save && text) {
      const path = canvas.dataset.lmbInkPath, page = canvas.dataset.lmbInkPage, objects = this.lmbInkObjects(path, page, true), before = lmbInkClone(objects);
      const measuredWidth = Math.max(40, Number(box.offsetWidth) || 190), measuredHeight = Math.max(28, Number(box.offsetHeight) || 54);
      objects.push({ id: this.lmbInkId(), type: "text", text, x: point.x, y: point.y, w: measuredWidth / Math.max(1, canvas.clientWidth), h: measuredHeight / Math.max(1, canvas.clientHeight), color: this.inkColor, width: this.inkWidth / 1000, widthUnit: "page", fontSize: .016, fontUnit: "page" });
      this.lmbCommitInkChange(path, page, before, "text"); this.lmbDrawInkLayer(canvas);
    }
    box.remove();
  };
  box.addEventListener("blur", () => finish(true), { once: true });
  box.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(false); else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") box.blur(); });
};

LuciasMarginBookPlugin.prototype.lmbHistoryFor = function (path, page) {
  if (!this._lmbInkHistory) this._lmbInkHistory = new Map();
  const key = `${path}\n${page}`;
  if (!this._lmbInkHistory.has(key)) this._lmbInkHistory.set(key, { undo: [], redo: [] });
  return this._lmbInkHistory.get(key);
};

LuciasMarginBookPlugin.prototype.lmbCommitInkChange = function (path, page, before, label) {
  const after = lmbInkClone(this.lmbInkObjects(path, page, true));
  const patch = lmbInkBuildPatch(before, after);
  if (!patch.added.length && !patch.removed.length && !patch.modified.length) return false;
  const history = this.lmbHistoryFor(path, page);
  history.undo.push({ patch, label });
  if (history.undo.length > LMB_INK_HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0; this.lmbInvalidateInkSpatial(path, page); this.lmbMarkInkDirty(path); return true;
};

LuciasMarginBookPlugin.prototype.lmbActiveInkCanvas = function () {
  const activeRoot = this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.containerEl;
  const root = arguments[0] && typeof arguments[0].querySelectorAll === "function" ? arguments[0] : activeRoot || document;
  const explicitPath = arguments[1];
  const file = this.app.workspace.getActiveFile(), filePath = explicitPath || file && file.path; if (!filePath) return null;
  const candidates = Array.from(root.querySelectorAll(".lmb-ink-layer")).filter((canvas) => canvas.dataset.lmbInkPath === filePath);
  let best = null, bestArea = -1;
  for (const canvas of candidates) {
    const rect = canvas.getBoundingClientRect(), visible = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
    if (visible > bestArea) { best = canvas; bestArea = visible; }
  }
  return best;
};

LuciasMarginBookPlugin.prototype.lmbUndoInk = function (canvas) { return this.lmbApplyInkHistory("undo", canvas); };
LuciasMarginBookPlugin.prototype.lmbRedoInk = function (canvas) { return this.lmbApplyInkHistory("redo", canvas); };
LuciasMarginBookPlugin.prototype.lmbApplyInkHistory = function (direction, preferredCanvas) {
  const canvas = preferredCanvas || this.lmbActiveInkCanvas(); if (!canvas) return false;
  const path = canvas.dataset.lmbInkPath, page = canvas.dataset.lmbInkPage, history = this.lmbHistoryFor(path, page), entry = history[direction].pop(); if (!entry) return false;
  this.lmbReplaceInkObjects(path, page, lmbInkApplyPatch(this.lmbInkObjects(path, page), entry.patch, direction));
  if (direction === "undo") history.redo.push(entry); else history.undo.push(entry);
  this._lmbInkSelection = []; this._lmbInkSelectionContext = null; this.lmbRedrawInkPage(canvas); this.lmbMarkInkDirty(path); return true;
};

LuciasMarginBookPlugin.prototype.lmbClearInk = function () {
  const canvas = this.lmbActiveInkCanvas(); if (!canvas) return false;
  const path = canvas.dataset.lmbInkPath, page = canvas.dataset.lmbInkPage, objects = this.lmbInkObjects(path, page);
  if (!objects.length) return false;
  const before = lmbInkClone(objects); objects.length = 0; this._lmbInkSelection = []; this._lmbInkSelectionContext = null;
  this.lmbCommitInkChange(path, page, before, "clear"); this.lmbRedrawInkPage(canvas); new Notice("MarginBook：已清空当前页，可用撤销恢复", 2200); return true;
};

LuciasMarginBookPlugin.prototype.lmbDeleteInkSelection = function (preferredCanvas) {
  const context = this._lmbInkSelectionContext;
  if (preferredCanvas && (!context || context.canvas !== preferredCanvas)) return false;
  const canvas = context && context.canvas && context.canvas.isConnected ? context.canvas : preferredCanvas || this.lmbActiveInkCanvas();
  const ids = new Set(Array.isArray(this._lmbInkSelection) ? this._lmbInkSelection : []); if (!canvas || !ids.size) return false;
  const path = canvas.dataset.lmbInkPath, page = canvas.dataset.lmbInkPage, objects = this.lmbInkObjects(path, page), before = lmbInkClone(objects);
  for (let i = objects.length - 1; i >= 0; i--) if (ids.has(objects[i].id)) objects.splice(i, 1);
  if (before.length === objects.length) return false;
  this._lmbInkSelection = []; this._lmbInkSelectionContext = null;
  this.lmbCommitInkChange(path, page, before, "delete"); this.lmbRedrawInkPage(canvas); return true;
};

LuciasMarginBookPlugin.prototype.lmbRedrawInkPage = function (canvas) {
  if (!canvas) return;
  this.lmbDrawInkLayer(canvas);
  const live = canvas.parentElement && canvas.parentElement.querySelector(":scope > .lmb-ink-live-layer");
  if (live) this.lmbDrawInkLiveLayer(live, null);
};

LuciasMarginBookPlugin.prototype.lmbApplyInkStyleToSelection = function (property, value, scopeHost) {
  const context = this._lmbInkSelectionContext, ids = new Set(this._lmbInkSelection || []);
  if (!context || !ids.size) return false;
  if (scopeHost && typeof scopeHost.contains === "function" && !scopeHost.contains(context.canvas)) return false;
  const objects = this.lmbInkObjects(context.path, context.page), before = lmbInkClone(objects);
  for (const object of objects) if (ids.has(object.id)) {
    if (property === "color") object.color = value;
    if (property === "width") { object.width = Number(value) / 1000; object.widthUnit = "page"; }
  }
  if (!this.lmbCommitInkChange(context.path, context.page, before, "style")) return false;
  this.lmbRedrawInkPage(context.canvas); return true;
};

LuciasMarginBookPlugin.prototype.lmbSetInkTool = function (tool) {
  if (!LMB_INK_TOOLS.includes(tool)) return;
  if (["pen", "highlighter", "line", "rect"].includes(this.inkTool)) this._lmbInkLastDrawTool = this.inkTool;
  if (typeof document !== "undefined") document.querySelectorAll(".page[data-lmb-ink-bound]").forEach(page => { if (page._lmbFinishInk) page._lmbFinishInk(); });
  this.inkTool = tool; this.settings.inkLastTool = tool;
  try { document.body.toggleClass("lmb-ink-capture", this.inkMode && tool !== "hand"); } catch (_) {}
  if (tool === "highlighter") { this.inkColor = this.settings.inkHighlighterColor || "#ffd84d"; this.inkWidth = Number(this.settings.inkHighlighterWidth) || 12; }
  else if (["pen", "text", "line", "rect"].includes(tool)) { this.inkColor = this.settings.inkPenColor || "#e05252"; this.inkWidth = Number(this.settings.inkPenWidth) || 3; }
  this.lmbPersistInkPreferences(); this.lmbRefreshInkLayers(); this.lmbRenderInkTools();
};

LuciasMarginBookPlugin.prototype.lmbPersistInkPreferences = function () {
  clearTimeout(this._lmbInkPrefsTimer);
  this._lmbInkPrefsTimer = setTimeout(() => this.saveSettings().catch((error) => console.warn("[lmb] ink preferences save failed", error)), 300);
};

LuciasMarginBookPlugin.prototype.lmbUpdateInkSaveStatus = function () {
  const label = this._lmbInkSaveState === "saving" ? "保存中…" : this._lmbInkSaveState === "error" ? "保存失败" : "已保存";
  document.querySelectorAll(".lmb-ink-save-status").forEach((element) => { element.textContent = label; element.dataset.state = this._lmbInkSaveState || "saved"; });
};

LuciasMarginBookPlugin.prototype.lmbRenderInkTools = function () {
  document.querySelectorAll(".lmb-ink-tools").forEach((bar) => bar.remove());
  if (!this.inkMode) return;
  const specs = [["hand", "hand", "抓手（空格临时启用）", "手"], ["select", "mouse-pointer-2", "选择 / 套索", "选"], ["pen", "pencil", "画笔", "笔"], ["highlighter", "highlighter", "荧光笔", "荧"], ["eraser", "eraser", this.settings.inkEraserMode === "stroke" ? "整笔橡皮" : "局部橡皮", "擦"], ["text", "type", "文字", "字"], ["line", "minus", "直线", "线"], ["rect", "square", "矩形", "框"]];
  const applyIcon = (element, icon, fallback) => { try { setIcon(element, icon); } catch (_) { element.textContent = fallback || "•"; } };
  for (const leaf of this.app.workspace.getLeavesOfType("pdf") || []) {
    const leafRoot = leaf && leaf.containerEl; if (!leafRoot) continue;
    const host = leafRoot.querySelector(":scope > .view-content") || leafRoot.querySelector(".view-content") || leafRoot;
    const bar = document.createElement("div"); bar.className = "lmb-ink-tools"; if (this.settings.inkToolbarCollapsed) bar.classList.add("is-collapsed");
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "lmb-ink-collapse"; toggle.title = "收起 / 展开手写工具栏"; toggle.setAttribute("aria-label", toggle.title); applyIcon(toggle, this.settings.inkToolbarCollapsed ? "pencil" : "chevron-left", this.settings.inkToolbarCollapsed ? "笔" : "‹");
    toggle.addEventListener("click", () => { this.settings.inkToolbarCollapsed = !this.settings.inkToolbarCollapsed; this.lmbPersistInkPreferences(); this.lmbRenderInkTools(); }); bar.appendChild(toggle);
    const content = document.createElement("div"); content.className = "lmb-ink-tools-content"; bar.appendChild(content);
    const toolButtons = document.createElement("div"); toolButtons.className = "lmb-ink-tool-buttons"; content.appendChild(toolButtons);
    const advanced = document.createElement("div"); advanced.className = "lmb-ink-advanced"; advanced.hidden = !this._lmbInkToolsExpanded;
    for (const [tool, icon, title, fallback] of specs) {
      const button = document.createElement("button"); button.type = "button"; button.title = title; button.setAttribute("aria-label", title); button.dataset.tool = tool; button.classList.toggle("is-active", this.inkTool === tool); applyIcon(button, icon, fallback);
      button.setAttribute("aria-pressed", String(this.inkTool === tool));
      button.addEventListener("click", () => this.lmbSetInkTool(tool)); (["text", "line", "rect"].includes(tool) ? advanced : toolButtons).appendChild(button);
    }
    const colors = this.inkTool === "highlighter" ? ["#ffd84d", "#7ee787", "#70b7ff"] : ["#e05252", "#222222", "#2d8cff"];
    const swatches = document.createElement("div"); swatches.className = "lmb-ink-swatches";
    for (const value of colors) {
      const swatch = document.createElement("button"); swatch.type = "button"; swatch.className = "lmb-ink-swatch"; swatch.style.backgroundColor = value; swatch.title = value; swatch.setAttribute("aria-label", `颜色 ${value}`); swatch.classList.toggle("is-active", (this.inkColor || "").toLowerCase() === value);
      swatch.addEventListener("click", () => { this.inkColor = value; if (this.inkTool === "highlighter") this.settings.inkHighlighterColor = value; else this.settings.inkPenColor = value; this.lmbApplyInkStyleToSelection("color", value, host); this.lmbPersistInkPreferences(); this.lmbRenderInkTools(); }); swatches.appendChild(swatch);
    }
    content.appendChild(swatches);
    const colorPicker = document.createElement("label"); colorPicker.className = "lmb-ink-color-picker"; colorPicker.title = "自定义颜色";
    const colorIcon = document.createElement("span"); colorIcon.className = "lmb-ink-color-icon"; applyIcon(colorIcon, "palette", "色"); colorPicker.appendChild(colorIcon);
    const colorPreview = document.createElement("span"); colorPreview.className = "lmb-ink-color-preview"; colorPreview.style.backgroundColor = this.inkColor || "#e05252"; colorPicker.appendChild(colorPreview);
    const color = document.createElement("input"); color.type = "color"; color.className = "lmb-ink-color-input"; color.value = this.inkColor || "#e05252"; color.setAttribute("aria-label", "自定义颜色");
    color.addEventListener("change", () => { this.inkColor = color.value; colorPreview.style.backgroundColor = color.value; if (this.inkTool === "highlighter") this.settings.inkHighlighterColor = color.value; else this.settings.inkPenColor = color.value; this.lmbApplyInkStyleToSelection("color", color.value, host); this.lmbPersistInkPreferences(); }); colorPicker.appendChild(color); advanced.appendChild(colorPicker);
    const widthControl = document.createElement("div"); widthControl.className = "lmb-ink-width-control";
    const widthIcon = document.createElement("span"); widthIcon.className = "lmb-ink-width-icon"; applyIcon(widthIcon, "minus", "—"); widthControl.appendChild(widthIcon);
    const isEraser = this.inkTool === "eraser", widthLabel = isEraser ? "橡皮半径" : "粗细";
    const width = document.createElement("input"); width.type = "range"; width.min = isEraser ? "8" : "1"; width.max = isEraser ? "48" : this.inkTool === "highlighter" ? "30" : "14"; width.step = isEraser ? "2" : "1"; width.value = String(isEraser ? Number(this.settings.inkEraserSize) || 18 : this.inkWidth || 3); width.title = `${widthLabel} ${width.value}`; width.setAttribute("aria-label", width.title);
    const widthValue = document.createElement("span"); widthValue.className = "lmb-ink-width-value"; widthValue.textContent = width.value;
    width.addEventListener("input", () => { width.title = `${widthLabel} ${width.value}`; width.setAttribute("aria-label", width.title); widthValue.textContent = width.value; if (isEraser) this.settings.inkEraserSize = Number(width.value); else { this.inkWidth = Number(width.value); if (this.inkTool === "highlighter") this.settings.inkHighlighterWidth = this.inkWidth; else this.settings.inkPenWidth = this.inkWidth; } });
    width.addEventListener("change", () => { if (!isEraser) this.lmbApplyInkStyleToSelection("width", this.inkWidth, host); this.lmbPersistInkPreferences(); }); widthControl.appendChild(width); widthControl.appendChild(widthValue); advanced.appendChild(widthControl);
    const eraseMode = document.createElement("select"); eraseMode.className = "lmb-ink-eraser-mode"; eraseMode.setAttribute("aria-label", "橡皮模式");
    for (const [value, label] of [["partial", "局部橡皮"], ["stroke", "整笔橡皮"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; eraseMode.appendChild(option); }
    eraseMode.value = this.settings.inkEraserMode || "partial";
    eraseMode.addEventListener("change", () => { this.settings.inkEraserMode = eraseMode.value; this.lmbPersistInkPreferences(); this.lmbRenderInkTools(); }); advanced.appendChild(eraseMode);
    const autoReturn = document.createElement("label"); autoReturn.className = "lmb-ink-auto-return";
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = this.settings.inkEraserAutoReturn !== false;
    check.addEventListener("change", () => { this.settings.inkEraserAutoReturn = check.checked; this.lmbPersistInkPreferences(); }); autoReturn.appendChild(check); autoReturn.appendChild(document.createTextNode("擦完回笔")); advanced.appendChild(autoReturn);
    const leafCanvas = () => this.lmbActiveInkCanvas(host, leaf.view && leaf.view.file && leaf.view.file.path);
    const actions = document.createElement("div"); actions.className = "lmb-ink-actions"; content.appendChild(actions);
    const action = (icon, title, handler, fallback) => { const button = document.createElement("button"); button.type = "button"; button.title = title; button.setAttribute("aria-label", title); applyIcon(button, icon, fallback); button.addEventListener("click", handler); actions.appendChild(button); };
    action("undo-2", "撤销", () => this.lmbUndoInk(leafCanvas()), "↶");
    action("redo-2", "重做", () => this.lmbRedoInk(leafCanvas()), "↷");
    if (this.inkTool === "select" && this._lmbInkSelection && this._lmbInkSelection.length) {
      const selectionTools = document.createElement("div"); selectionTools.className = "lmb-ink-selection-actions";
      const count = document.createElement("span"); count.textContent = `已选 ${this._lmbInkSelection.length} 笔`; selectionTools.appendChild(count);
      const selection = this._lmbInkSelectionContext;
      if (selection) {
        const ids = new Set(this._lmbInkSelection);
        const labels = Object.entries(this.lmbInkLinks(selection.path)).filter(([, link]) => (link.groups || []).some(group => Number(group.page) === Number(selection.page) && lmbInkGroupObjects(this.lmbInkStore()[selection.path], group).some(object => ids.has(object.id)))).map(([exId]) => this.lmbInkLinkLabel(selection.path, exId));
        if (labels.length) { const badge = document.createElement("span"); badge.className = "lmb-ink-link-badge"; badge.textContent = labels.join(" / "); selectionTools.appendChild(badge); }
      }
      action("link", "将所选笔迹关联已有摘录", () => this.lmbChooseInkExcerpt(), "关联");
      const associate = actions.lastElementChild; associate.className = "lmb-ink-link-action"; associate.appendChild(document.createTextNode("关联摘录")); selectionTools.appendChild(associate);
      action("sticky-note", "用所选笔迹新建手写备注", () => this.lmbCreateInkNoteFromSelection(), "新建");
      const create = actions.lastElementChild; create.className = "lmb-ink-link-action"; create.appendChild(document.createTextNode("新建手写")); selectionTools.appendChild(create);
      bar.appendChild(selectionTools);
    }
    const more = document.createElement("button"); more.type = "button"; more.title = "更多工具与笔迹设置"; more.setAttribute("aria-label", more.title); more.setAttribute("aria-expanded", String(!!this._lmbInkToolsExpanded)); applyIcon(more, "ellipsis", "…");
    more.addEventListener("click", () => { this._lmbInkToolsExpanded = !this._lmbInkToolsExpanded; this.lmbRenderInkTools(); }); actions.appendChild(more);
    action("trash-2", "删除所选", () => this.lmbDeleteInkSelection(leafCanvas()), "删");
    advanced.appendChild(actions.lastElementChild);
    bar.appendChild(advanced);
    const status = document.createElement("span"); status.className = "lmb-ink-save-status"; content.appendChild(status); host.appendChild(bar);
  }
  this.lmbUpdateInkSaveStatus();
};

LuciasMarginBookPlugin.prototype.lmbSetupInk = function () {
  this._lmbInkObservedPages = new Set();
  if (typeof IntersectionObserver !== "undefined") {
    this._lmbInkVisibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pageEl = entry.target, context = pageEl._lmbInkPageContext;
        pageEl._lmbInkNearViewport = entry.isIntersecting;
        if (!this._unloaded && entry.isIntersecting && pageEl.isConnected && context) this.lmbEnsureInkLayer(pageEl, context.path, context.index);
      }
    }, { rootMargin: "300px" });
  }
  this.inkTool = this.settings.inkLastTool || "pen"; this.inkColor = this.settings.inkPenColor || "#e05252"; this.inkWidth = Number(this.settings.inkPenWidth) || 3; this._lmbInkSelection = [];
  this._lmbInkLastDrawTool = ["pen", "highlighter", "line", "rect"].includes(this.inkTool) ? this.inkTool : "pen";
  const palms = new Set();
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "click"]) this.registerDomEvent(document, type, event => {
    if (!this.inkMode || event.pointerType !== "touch" || lmbInkIsStylusInput(event)) return;
    if (type === "pointerdown") {
      palms.delete(event.pointerId);
      if (this._lmbInkPenActive || Date.now() < (this._lmbInkPalmUntil || 0) || Number(event.width) > 45 || Number(event.height) > 45) palms.add(event.pointerId);
    }
    if (!palms.has(event.pointerId)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (type === "click" || type === "pointercancel") palms.delete(event.pointerId);
  }, { capture: true, passive: false });
  // Synthetic clicks after a stroke must not open a Markdown editor or trigger
  // its outside-click exit. Existing text editors keep their own event path.
  this.registerDomEvent(document, "click", event => {
    const target = event.target;
    if (!this.inkMode || this.inkTool === "hand" || this._lmbInkSpacePan || !target || !target.closest) return;
    if (target.closest(".page") && !target.closest(".is-editing,.lmb-pdf-text-tools,.lmb-ink-text-editor")) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  try { document.body.toggleClass("lmb-ink-capture", this.inkMode && this.inkTool !== "hand"); } catch (_) {}
  this.registerDomEvent(document, "keydown", (event) => {
    if (lmbInkIsTextInput(event.target) || event.isComposing) return;
    if (event.code === "Space" && this.inkMode && !/INPUT|TEXTAREA/.test(event.target && event.target.tagName || "")) {
      this._lmbInkSpacePan = true;
      try { document.body.removeClass("lmb-ink-capture"); } catch (_) {}
      this.lmbRefreshInkLayers();
    }
    if (event.target && event.target.classList && event.target.classList.contains("lmb-ink-text-editor")) return;
    if (event.key === "Escape" && this.inkMode) { this.lmbSetInkMode(false); return; }
    if (!this.inkMode) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { const changed = event.shiftKey ? this.lmbRedoInk() : this.lmbUndoInk(); if (changed) event.preventDefault(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y" && this.lmbRedoInk()) event.preventDefault();
    else if ((event.key === "Delete" || event.key === "Backspace") && this.lmbDeleteInkSelection(this.lmbActiveInkCanvas())) event.preventDefault();
  }, true);
  this.registerDomEvent(document, "keyup", (event) => { if (event.code === "Space") { this._lmbInkSpacePan = false; try { document.body.toggleClass("lmb-ink-capture", this.inkMode && this.inkTool !== "hand"); } catch (_) {} this.lmbRefreshInkLayers(); } }, true);
  const finishInterruptedInk = () => document.querySelectorAll(".page[data-lmb-ink-bound]").forEach(page => { if (page._lmbFinishInk) page._lmbFinishInk(); });
  this.registerDomEvent(window, "blur", () => { finishInterruptedInk(); this._lmbInkSpacePan = false; try { document.body.toggleClass("lmb-ink-capture", this.inkMode && this.inkTool !== "hand"); } catch (_) {} this.lmbRefreshInkLayers(); }, true);
  this.registerDomEvent(document, "visibilitychange", () => { if (document.hidden) finishInterruptedInk(); });
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of Array.from(record.removedNodes || [])) {
      if (!node || node.nodeType !== 1) continue;
      const pages = [];
      if (node.matches && node.matches(".page")) pages.push(node);
      if (node.querySelectorAll) pages.push(...node.querySelectorAll(".page"));
      for (const pageEl of pages) {
        if (pageEl.isConnected) continue;
        if (pageEl._lmbFinishInk) pageEl._lmbFinishInk();
        this.lmbReleaseTextBlockPage(pageEl);
        clearTimeout(pageEl._lmbInkResizeTimer);
        if (this._lmbInkVisibilityObserver) this._lmbInkVisibilityObserver.unobserve(pageEl);
        this._lmbInkObservedPages.delete(pageEl);
        delete pageEl._lmbInkNearViewport;
        if (pageEl._lmbInkResizeObserver) { pageEl._lmbInkResizeObserver.disconnect(); pageEl._lmbInkResizeObserver = null; }
        if (this._lmbInkSelectionContext && pageEl.contains && pageEl.contains(this._lmbInkSelectionContext.canvas)) { this._lmbInkSelection = []; this._lmbInkSelectionContext = null; }
      }
    }
    const relevant = records.some((record) => Array.from(record.addedNodes || []).some((node) => node.nodeType === 1 && (node.matches && node.matches(".page,.pdf-viewer-container") || node.querySelector && node.querySelector(".page"))));
    if (relevant) this.lmbScheduleInkRefresh(60);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  this.register(() => {
    document.querySelectorAll(".page[data-lmb-ink-bound]").forEach(page => { if (page._lmbFinishInk) page._lmbFinishInk(); });
    if (this._lmbInkVisibilityObserver) this._lmbInkVisibilityObserver.disconnect();
    for (const pageEl of this._lmbInkObservedPages) clearTimeout(pageEl._lmbInkResizeTimer);
    this._lmbInkObservedPages.clear();
    observer.disconnect(); clearTimeout(this._lmbInkSaveTimer); clearTimeout(this._lmbInkPrefsTimer); this.lmbFlushInkStorage().catch(() => {});
    document.querySelectorAll(".lmb-ink-tools").forEach((element) => element.remove());
    document.querySelectorAll(".page[data-lmb-ink-bound]").forEach((pageEl) => {
      this.lmbUpdateInkPageCapture(pageEl, true);
      if (pageEl._lmbInkResizeObserver) pageEl._lmbInkResizeObserver.disconnect();
      pageEl._lmbInkResizeObserver = null;
      pageEl.querySelectorAll(":scope > .lmb-ink-layer,:scope > .lmb-ink-live-layer").forEach(layer => { if (layer._lmbInkFrame) cancelAnimationFrame(layer._lmbInkFrame); if (layer._lmbInkStaticFrame) cancelAnimationFrame(layer._lmbInkStaticFrame); layer.remove(); });
      delete pageEl.dataset.lmbInkBound; delete pageEl._lmbInkInputSurface; delete pageEl._lmbFinishInk;
    });
  });
};

/* Excerpts, sidebar and Canvas reference original, editable PDF ink by ID. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  lmbInkLinks(path) { return this.settings.inkExcerptLinks && this.settings.inkExcerptLinks[path] || {}; },

  lmbInitializeInkLinkNumbers() {
    let changed = false;
    const counters = this.settings.inkLinkCounters || (this.settings.inkLinkCounters = {});
    for (const [path, records] of Object.entries(this.settings.inkExcerptLinks || {})) {
      const links = Object.values(records || {}).filter(link => link && link.id);
      let next = Math.max(Number(counters[path]) || 1, ...links.map(link => (Number(link.number) || 0) + 1));
      const used = new Set();
      for (const link of links) {
        if (!Number.isSafeInteger(link.number) || link.number < 1 || used.has(link.number)) { link.number = next++; changed = true; }
        used.add(link.number);
      }
      if (counters[path] !== next) { counters[path] = next; changed = true; }
    }
    return changed;
  },

  lmbInkLinkLabel(path, exId) {
    const records = this.lmbInkLinks(path), link = records[exId];
    return link ? `手写 H${link.number || Object.keys(records).indexOf(exId) + 1}` : "";
  },

  lmbFindInkReference(ref) {
    for (const [path, entries] of Object.entries(this.settings.inkExcerptLinks || {}))
      for (const [exId, link] of Object.entries(entries || {})) if (link && link.id === ref) return { path, exId, link };
    return null;
  },

  lmbInkSelectionSnapshot() {
    const context = this._lmbInkSelectionContext;
    if (!context || !context.path || !this._lmbInkSelection || !this._lmbInkSelection.length) throw Error("请先用套索选择笔迹");
    const group = { page: Number(context.page), objectIds: Array.from(new Set(this._lmbInkSelection)) };
    if (!lmbInkGroupObjects(this.lmbInkStore()[context.path], group).length) throw Error("所选笔迹已不存在，请重新选择");
    return { path: context.path, ...group, pageAspect: context.canvas && context.canvas.clientHeight / context.canvas.clientWidth || 1.4 };
  },

  async lmbLinkInkSelection(snapshot, entry, title) {
    // Serialize only association edits. Roll back only our own record on error,
    // leaving concurrent Markdown edits and their existing save queue untouched.
    const previous = this._lmbInkLinkQueue || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (this._unloaded) throw Error("插件已卸载，请重新打开手写工具");
      const path = snapshot.path;
      if (!await this.lmbEnsureInkDocument(path)) throw Error("笔迹尚未加载，未创建关联");
      if (!lmbInkGroupObjects(this.lmbInkStore()[path], snapshot).length) throw Error("所选笔迹已被删除，未创建关联");
      if (entry && entry.pdfPath !== path) throw Error("请选择同一 PDF 的摘录");
      // Durable strokes must exist before saving references to them.
      await this.lmbFlushInkStorage();
      if (this._unloaded) throw Error("插件已卸载，未创建关联");
      if (!lmbInkGroupObjects(this.lmbInkStore()[path], snapshot).length) throw Error("所选笔迹已被删除，未创建关联");
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) throw Error("PDF 已移动或不存在，请重新选择");
      if (entry && !this._lmbGetPdfSidebarEntries(file).some(e => e.exId === entry.exId)) throw Error("摘录已删除，请重新选择");
      const exId = entry ? entry.exId : "ink-note-" + this.lmbInkId().slice(4);
      const links = this.settings.inkExcerptLinks || (this.settings.inkExcerptLinks = {});
      const records = links[path] || (links[path] = {}), before = records[exId];
      this.lmbInitializeInkLinkNumbers();
      const record = lmbInkClone(before || { id: "inkref-" + this.lmbInkId().slice(4), groups: [] });
      if (!record.number) {
        const counters = this.settings.inkLinkCounters;
        record.number = counters[path] || 1; counters[path] = record.number + 1;
      }
      const ids = Array.from(new Set(snapshot.objectIds)).sort();
      const selectedIds = lmbInkGroupObjects(this.lmbInkStore()[path], snapshot).map(o => o.id);
      if (!record.groups.some(g => {
        if (g.page !== Number(snapshot.page)) return false;
        const covered = new Set(lmbInkGroupObjects(this.lmbInkStore()[path], g).map(o => o.id));
        return selectedIds.every(id => covered.has(id));
      }))
        record.groups.push({ id: this.lmbInkId(), page: Number(snapshot.page), objectIds: ids, pageAspect: Math.max(.2, Math.min(5, Number(snapshot.pageAspect) || 1.4)) });
      let created;
      if (!entry) {
        created = { exId, inkNote: true, page: Number(snapshot.page), text: String(title || "手写备注").trim().slice(0, 160) || "手写备注", note: "" };
        const quick = this.settings.quickExcerpts || (this.settings.quickExcerpts = {});
        (quick[path] || (quick[path] = [])).push(created);
      }
      records[exId] = record;
      try { await this.saveSettings(); }
      catch (error) {
        if (before) records[exId] = before; else delete records[exId];
        if (created) { const list = this.settings.quickExcerpts[path]; const index = list.indexOf(created); if (index >= 0) list.splice(index, 1); }
        throw error;
      }
      this.lmbSchedulePdfSidebarRefresh(0); this.lmbScheduleInkReferenceRefresh();
      if (typeof document !== "undefined") this.lmbRenderInkTools();
      return { path, exId, link: record, entry: created || entry };
    });
    this._lmbInkLinkQueue = task;
    try { return await task; } finally { if (this._lmbInkLinkQueue === task) this._lmbInkLinkQueue = null; }
  },

  lmbChooseInkExcerpt() {
    try {
      const snapshot = this.lmbInkSelectionSnapshot(), file = this.app.vault.getAbstractFileByPath(snapshot.path);
      const items = this._lmbGetPdfSidebarEntries(file).filter(e => e.exId).map(entry => ({ entry,
        label: `P.${entry.page || "?"} · ${String(entry.text || entry.note || "未命名备注").replace(/\s+/g, " ").slice(0, 120)}` }));
      if (!items.length) { new Notice("此 PDF 尚无摘录，可先新建手写备注"); return; }
      new LMBNodeSuggester(this.app, items, item => {
        this.lmbLinkInkSelection(snapshot, { ...item.entry, pdfPath: snapshot.path }).then(() => new Notice("已关联摘录，原笔迹仍可编辑"))
          .catch(error => new Notice("关联失败，笔迹和选择已保留：" + error.message, 5000));
      }).open();
    } catch (error) { new Notice(error.message); }
  },

  lmbCreateInkNoteFromSelection() {
    try {
      const snapshot = this.lmbInkSelectionSnapshot();
      new LMBInkNoteTitleModal(this.app, `手写备注 · P.${snapshot.page}`, async title => {
        await this.lmbLinkInkSelection(snapshot, null, title); new Notice("已创建手写备注，可在侧栏查看或放入 Canvas");
      }).open();
    } catch (error) { new Notice(error.message); }
  },

  async lmbSaveEditorsBeforeInkNavigation() {
    const states = new Set();
    for (const block of [...(this._lmbActiveInlineBlocks || []), ...(this._lmbActiveSidebarNoteBlocks || [])]) if (block._lmbInlineEditor) states.add(block._lmbInlineEditor);
    for (const state of states) if (!await state.save()) return false;
    return true;
  },

  async lmbLocateInkReference(ref, options = {}) {
    if (this._unloaded) return false;
    const token = this._lmbInkLocateToken = {};
    if (!await this.lmbSaveEditorsBeforeInkNavigation() || token !== this._lmbInkLocateToken) return false;
    const found = this.lmbFindInkReference(ref);
    if (!found) { new Notice("手写关联不存在，原卡片已保留"); return false; }
    const request = this._lmbBeginNavigation();
    try {
      if (!await this.lmbEnsureInkDocument(found.path) || !this._lmbNavigationCurrent(request)) return false;
      const groups = found.link.groups || [], group = groups.find(g => g.id === options.groupId)
        || groups.find(g => lmbInkGroupObjects(this.lmbInkStore()[found.path], g).length) || groups[0];
      const objects = lmbInkGroupObjects(this.lmbInkStore()[found.path], group), bounds = lmbInkGroupBounds(objects);
      if (!bounds) { new Notice("这组笔迹已被擦除；备注和卡片仍保留，可撤销擦除后再定位"); return false; }
      const file = this.app.vault.getAbstractFileByPath(found.path);
      if (!file) { new Notice("找不到关联的 PDF，未修改备注"); return false; }
      const existing = (this.app.workspace.getLeavesOfType("pdf") || []).find(l => l.view && l.view.file && l.view.file.path === found.path);
      const leaf = await this._lmbActivateNavigationLeaf(request, existing, file);
      if (!leaf) return false;
      const view = leaf.view;
      const pageEl = await this.lmbWaitPageEl(view.containerEl || leaf.containerEl, group.page, 6000);
      const current = () => this._lmbNavigationCurrent(request) && token === this._lmbInkLocateToken && leaf.view === view && view.file?.path === found.path && pageEl && pageEl.isConnected !== false;
      if (!current()) return false;
      pageEl.scrollIntoView({ block: "center" }); pageEl._lmbInkNearViewport = true;
      if (options.edit) {
        if (await this.lmbSetInkMode(true) === false || !current()) return false;
        this.lmbSetInkTool("select");
      }
      this.lmbEnsureInkLayer(pageEl, found.path, Number(group.page) - 1);
      this.lmbSelectPdfSidebarEntry(leaf, { exId: found.exId, page: group.page });
      const canvas = pageEl.querySelector(":scope > .lmb-ink-layer");
      if (options.edit && canvas) {
        this._lmbInkSelection = objects.map(o => o.id); this._lmbInkSelectionContext = { canvas, path: found.path, page: group.page };
        this.lmbRenderInkTools(); this.lmbRedrawInkPage(canvas);
      }
      this.lmbUpdateInkLocation(canvas);
      const marker = pageEl.querySelector(":scope > .lmb-ink-location");
      if (marker) marker.scrollIntoView({ block: "center", inline: "nearest" });
      return true;
    } catch (error) { new Notice("定位手写备注失败：" + error.message); return false; }
    finally { this._lmbEndNavigation(request); }
  },

  lmbFocusLinkedInk(leaf, exId) {
    const path = leaf.view && leaf.view.file && leaf.view.file.path;
    const before = this._lmbInkLinkedFocus;
    if (before && before.path === path && before.exId === exId) return;
    this._lmbInkLinkedFocus = { path, exId };
    const leaves = new Set([leaf, ...(this.app.workspace.getLeavesOfType("pdf") || [])]);
    for (const pdfLeaf of leaves) for (const canvas of pdfLeaf.containerEl.querySelectorAll(".lmb-ink-layer")) this.lmbRedrawInkPage(canvas);
  },

  lmbInkFocusIds(path, page) {
    const focus = this._lmbInkLinkedFocus;
    if (!focus || focus.path !== path) return [];
    const link = this.lmbInkLinks(path)[focus.exId];
    return link ? (link.groups || []).filter(g => Number(g.page) === Number(page)).flatMap(g => lmbInkGroupObjects(this.lmbInkStore()[path], g).map(o => o.id)) : [];
  },

  lmbUpdateInkLocation(canvas) {
    if (!canvas || !canvas.parentElement) return;
    const pageEl = canvas.parentElement, path = canvas.dataset.lmbInkPath, page = Number(canvas.dataset.lmbInkPage);
    const focus = this._lmbInkLinkedFocus, link = focus && focus.path === path && this.lmbInkLinks(path)[focus.exId];
    const objects = link ? (link.groups || []).filter(g => Number(g.page) === page).flatMap(g => lmbInkGroupObjects(this.lmbInkStore()[path], g)) : [];
    const bounds = lmbInkGroupBounds(objects);
    let marker = pageEl.querySelector(":scope > .lmb-ink-location");
    if (!bounds) { if (marker) marker.remove(); return; }
    if (!marker) { marker = pageEl.ownerDocument.createElement("div"); marker.className = "lmb-ink-location"; pageEl.appendChild(marker); }
    marker.textContent = this.lmbInkLinkLabel(path, focus.exId);
    marker.dataset.lmbInkLabel = marker.textContent;
    Object.assign(marker.style, { left: bounds.x * 100 + "%", top: bounds.y * 100 + "%", width: bounds.w * 100 + "%", height: bounds.h * 100 + "%" });
  },

  async lmbRenderInkReference(host, ref, groupId) {
    if (this._unloaded) return;
    const renderToken = host._lmbInkRefToken = {};
    host.dataset.lmbInkRef = ref; if (groupId) host.dataset.lmbInkGroup = groupId;
    const found = this.lmbFindInkReference(ref);
    if (!found) { host.textContent = "手写关联不可用（原卡片保留）"; return; }
    const ready = await this.lmbEnsureInkDocument(found.path);
    if (host._lmbInkRefToken !== renderToken || this._unloaded) return;
    if (!ready) { host.textContent = "笔迹加载失败，备注与原卡片已保留"; return; }
    const groups = (found.link.groups || []).filter(g => !groupId || g.id === groupId);
    const items = groups.map(g => ({ group: g, objects: lmbInkGroupObjects(this.lmbInkStore()[found.path], g) }));
    host.replaceChildren(); host.classList.add("lmb-ink-reference");
    const title = host.ownerDocument.createElement("div"); title.className = "lmb-ink-ref-caption";
    title.textContent = this.lmbInkLinkLabel(found.path, found.exId) + " · " + items.map(i => `P.${i.group.page} · ${i.objects.length} 笔`).join(" / "); host.appendChild(title);
    const actions = host.ownerDocument.createElement("div"); actions.className = "lmb-ink-ref-actions";
    const back = host.ownerDocument.createElement("button"); back.type = "button"; back.className = "lmb-ink-ref-back"; back.textContent = "返回原笔迹";
    back._lmbInkAction = () => this.lmbLocateInkReference(ref, { groupId });
    back.onclick = event => { event.stopPropagation(); back._lmbInkAction(); }; actions.appendChild(back);
    const edit = host.ownerDocument.createElement("button"); edit.type = "button"; edit.textContent = "编辑原笔迹"; edit.className = "lmb-ink-ref-edit";
    edit._lmbInkAction = () => this.lmbLocateInkReference(ref, { groupId, edit: true });
    edit.onclick = event => { event.stopPropagation(); edit._lmbInkAction(); }; actions.appendChild(edit); host.appendChild(actions);
    // Canvas consumes pointerdown to select/drag a card. Explicit controls must
    // receive the first tap; the preview remains draggable as before.
    actions.addEventListener("pointerdown", event => event.stopPropagation());
    actions.addEventListener("mousedown", event => event.stopPropagation());
    actions.addEventListener("touchstart", event => event.stopPropagation(), { passive: true });
    for (const item of items) {
      const bounds = lmbInkGroupBounds(item.objects);
      if (!bounds) { const empty = host.ownerDocument.createElement("div"); empty.textContent = "笔迹已擦除，备注保留"; host.appendChild(empty); continue; }
      const height = 1000 * (Number(item.group.pageAspect) || 1.4);
      const ns = "http://www.w3.org/2000/svg", svg = host.ownerDocument.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", `${bounds.x * 1000 - 10} ${bounds.y * height - 10} ${bounds.w * 1000 + 20} ${bounds.h * height + 20}`);
      svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `P.${item.group.page} 手写笔迹预览`);
      const add = (tag, attrs, text) => { const el = host.ownerDocument.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value)); if (text != null) el.textContent = text; svg.appendChild(el); };
      for (const o of item.objects) {
        const style = { fill: "none", stroke: o.color || "#e05252", "stroke-width": o.widthUnit === "page" ? Math.max(.5, (Number(o.width) || .003) * 1000) : Number(o.width) || 3, opacity: o.opacity == null ? 1 : o.opacity, "stroke-linecap": "round", "stroke-linejoin": "round" };
        if (o.type === "pen" || o.type === "highlighter") {
          const points = o.points || [];
          if (points.length === 1) add("circle", { cx: points[0].x * 1000, cy: points[0].y * height, r: Number(style["stroke-width"]) / 2, fill: style.stroke, opacity: style.opacity });
          else if (points.length) add("path", { ...style, d: points.map((p, i) => `${i ? "L" : "M"}${p.x * 1000},${p.y * height}`).join(" ") });
        } else if (o.type === "line") add("line", { ...style, x1: o.x1 * 1000, y1: o.y1 * height, x2: o.x2 * 1000, y2: o.y2 * height });
        else if (o.type === "rect") add("rect", { ...style, x: Math.min(o.x1, o.x2) * 1000, y: Math.min(o.y1, o.y2) * height, width: Math.abs(o.x2 - o.x1) * 1000, height: Math.abs(o.y2 - o.y1) * height });
        else if (o.type === "text") add("text", { x: o.x * 1000, y: o.y * height + 16, fill: o.color || "#222", "font-size": o.fontUnit === "page" ? o.fontSize * 1000 : o.fontSize || 16 }, o.text);
      }
      const button = host.ownerDocument.createElement("button"); button.type = "button"; button.className = "lmb-ink-ref-preview"; button.title = `定位 P.${item.group.page} 的原笔迹`;
      let pointerStart = null, dragged = false;
      button.addEventListener("pointerdown", event => { pointerStart = { x: event.clientX, y: event.clientY }; dragged = false; });
      button.addEventListener("pointermove", event => { if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6) dragged = true; });
      button.addEventListener("pointercancel", () => { dragged = true; pointerStart = null; });
      button.appendChild(svg); button.addEventListener("click", event => { event.stopPropagation(); const moved = dragged || event.detail > 0 && pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6; if (!moved && !event.ctrlKey && !event.metaKey && event.button === 0) this.lmbLocateInkReference(ref, { groupId: item.group.id }); }); host.appendChild(button);
    }
    this.lmbWatchInkCardSize(host);
  },

  lmbWatchInkCardSize(host) {
    if (!host.closest || !host.closest(".canvas-node")) return;
    if (typeof ResizeObserver !== "undefined" && !host._lmbInkSizeObserver) {
      const observer = new ResizeObserver(() => this.lmbScheduleInkCardFit(host));
      observer.observe(host); observer.observe(host.closest(".canvas-node")); host._lmbInkSizeObserver = observer;
      (this._lmbInkCardObservers || (this._lmbInkCardObservers = new Set())).add(host);
    }
    this.lmbScheduleInkCardFit(host);
  },

  lmbScheduleInkCardFit(host) {
    clearTimeout(host._lmbInkFitTimer);
    host._lmbInkFitTimer = setTimeout(() => {
      if (this._unloaded || !host.isConnected) return;
      this.lmbFitInkReferenceCards(host).catch(error => console.warn("[lmb] ink card fit", error));
    }, 180);
  },

  async lmbFitInkReferenceCards(host) {
    if (this._unloaded || host.isConnected === false) return;
    // Synchronous live snapshot + height-only merge: never move neighbours,
    // rewrite Markdown, or restore disk positions over an unsaved Canvas drag.
    for (const leaf of this.app.workspace.getLeavesOfType("canvas") || []) {
      if (!leaf.containerEl || !leaf.containerEl.contains(host)) continue;
      const file = leaf.view.file, canvas = leaf.view.canvas;
      if (!file || !canvas || !canvas.nodes || typeof canvas.getData !== "function") continue;
      const live = Array.from(typeof canvas.nodes.values === "function" ? canvas.nodes.values() : Object.values(canvas.nodes));
      const instance = live.find(node => (node.nodeEl || node.contentEl)?.contains(host));
      const data = canvas.getData(), node = instance && data.nodes.find(n => n.id === instance.id);
      if (!node || lmbInkCanvasReference(node.text) !== host.dataset.lmbInkRef) continue;
      const wrapper = instance.nodeEl || instance.contentEl;
      if (wrapper.querySelector("textarea, .cm-editor, [contenteditable=true]")) continue;
      const content = wrapper.querySelector(".canvas-node-content") || wrapper;
      const height = this.lmbMeasureInkCardHeight(wrapper, content);
      if (!(height > 0) || Math.abs(height - node.height) < 3) continue;
      const next = this._lmbCloneCanvasForHeight(data, node.id, height);
      if (next && !await this._lmbWriteCanvasData(file, next.data, canvas)) new Notice("手写卡片高度保存失败，原内容仍保留");
    }
  },

  lmbMeasureInkCardHeight(wrapper, content) { return lmbMeasureNaturalCard(wrapper, content, 1); },

  lmbScheduleInkReferenceRefresh() {
    if (typeof document === "undefined") return;
    clearTimeout(this._lmbInkRefRefreshTimer);
    this._lmbInkRefRefreshTimer = setTimeout(() => {
      for (const host of this._lmbInkCardObservers || []) if (!host.isConnected) {
        host._lmbInkSizeObserver.disconnect(); clearTimeout(host._lmbInkFitTimer); this._lmbInkCardObservers.delete(host);
      }
      document.querySelectorAll("[data-lmb-ink-ref]").forEach(host => this.lmbRenderInkReference(host, host.dataset.lmbInkRef, host.dataset.lmbInkGroup).catch(error => console.warn("[lmb] ink preview", error)));
    }, 80);
  },

  async lmbPutInkReferenceInCanvas(path, exId) {
    const queueKey = path + "\n" + exId;
    const pending = this._lmbInkCanvasQueue || (this._lmbInkCanvasQueue = new Map());
    if (pending.has(queueKey)) return pending.get(queueKey);
    const navigation = this._lmbBeginNavigation();
    const previousWrite = this._lmbInkCanvasWriteQueue || Promise.resolve();
    const task = previousWrite.catch(() => {}).then(async () => {
      if (this._unloaded) throw Error("插件已卸载，未修改画布");
      const link = this.lmbInkLinks(path)[exId]; if (!link) throw Error("此摘录没有手写关联");
      const pdf = this.app.vault.getAbstractFileByPath(path); if (!pdf) throw Error("找不到 PDF");
      const target = this.lmbStoragePaths(pdf).canvas;
      let file = this.app.vault.getAbstractFileByPath(target);
      if (!file) { await this.lmbEnsureStorageParent(target); file = await this.app.vault.create(target, JSON.stringify({ nodes: [], edges: [] })); }
      const rd = await this._lmbReadCanvasData(file); if (!rd || !Array.isArray(rd.data.nodes)) throw Error("画布无法读取，未覆盖原文件");
      if (this._unloaded) throw Error("插件已卸载，未修改画布内容");
      const data = lmbInkClone(rd.data);
      let node = data.nodes.find(n => lmbInkCanvasReference(n.text) === link.id);
      if (!node) {
        const entry = this._lmbGetPdfSidebarEntries(pdf).find(e => e.exId === exId), group = link.groups[0];
        const caption = String(entry && entry.text || "手写备注").replace(/[\r\n\[\]|]/g, " ").slice(0, 120);
        const text = `[[${path}#page=${group.page}&ink=${encodeURIComponent(link.id)}|${caption}]]\n\n\`\`\`marginbook-ink\n${JSON.stringify({ ref: link.id })}\n\`\`\``;
        const x = data.nodes.length ? Math.max(...data.nodes.map(n => (Number(n.x) || 0) + (Number(n.width) || 0))) + 60 : 0;
        node = { id: this.lmbInkId(), type: "text", text, x, y: 0, width: 420, height: Math.min(1600, 260 + link.groups.length * 150) }; data.nodes.push(node);
        if (!await this._lmbWriteCanvasData(file, data, rd.memCanvas, rd.raw)) throw Error("画布保存失败，关联和原笔迹已保留");
      }
      if (this.lmbFocusCanvasNode && this._lmbNavigationCurrent(navigation)) await this.lmbFocusCanvasNode(file, node.id, navigation);
      return { file, nodeId: node.id };
    });
    this._lmbInkCanvasWriteQueue = task.catch(() => {});
    pending.set(queueKey, task); try { return await task; } finally { pending.delete(queueKey); this._lmbEndNavigation(navigation); }
  },

  lmbSetupInkReferences() {
    // Native Canvas selects a previously inactive node in its capture handler,
    // swallowing the first click before a button's handler can run. Reserve
    // only explicit controls; leave preview/card drags to the Canvas host.
    if (this.registerDomEvent) {
      const control = event => {
        const direct = event.target?.closest?.(".canvas-node .lmb-ink-ref-actions button");
        if (direct) return direct;
        // Unselected native Canvas cards have a transparent interaction cover.
        // Hit-test only this card's visible explicit buttons beneath that cover.
        const node = event.target?.closest?.(".canvas-node");
        return node && Array.from(node.querySelectorAll(".lmb-ink-ref-actions button")).find(button => {
          const r = button.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
        });
      };
      this.registerDomEvent(document, "pointerdown", event => {
        const button = control(event);
        if (!button || event.button !== 0 || event.isPrimary === false) return;
        this._lmbInkActionPress = { button, id: event.pointerId, x: event.clientX, y: event.clientY };
        event.stopImmediatePropagation(); event.preventDefault();
      }, true);
      this.registerDomEvent(document, "pointermove", event => {
        const press = this._lmbInkActionPress;
        if (!press || press.id !== event.pointerId) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) press.cancelled = true;
        event.stopImmediatePropagation(); event.preventDefault();
      }, true);
      this.registerDomEvent(document, "pointerup", event => {
        const press = this._lmbInkActionPress;
        if (!press || press.id !== event.pointerId) return;
        this._lmbInkActionPress = null;
        event.stopImmediatePropagation(); event.preventDefault();
        this._lmbInkActionClick = { button: press.button, until: Date.now() + 800 };
        if (!press.cancelled && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 8 && press.button.isConnected) press.button._lmbInkAction?.();
      }, true);
      this.registerDomEvent(document, "pointercancel", () => { this._lmbInkActionPress = null; }, true);
      this.registerDomEvent(document, "click", event => {
        const suppress = this._lmbInkActionClick;
        if (event.isTrusted && suppress && suppress.until > Date.now() && control(event) === suppress.button) { event.stopImmediatePropagation(); event.preventDefault(); }
      }, true);
    }
    if (this.registerMarkdownCodeBlockProcessor) this.registerMarkdownCodeBlockProcessor("marginbook-ink", async (source, host) => {
      try { const data = JSON.parse(source); if (!data || !/^inkref-[a-z0-9-]+$/.test(data.ref)) throw Error("关联标识无效"); await this.lmbRenderInkReference(host, data.ref); }
      catch (error) { host.textContent = "手写预览不可用：" + error.message; }
    });
    // Canvas DOM can outlive a plugin reload; replace old preview callbacks.
    this.lmbScheduleInkReferenceRefresh();
    this.register(() => { clearTimeout(this._lmbInkRefRefreshTimer); document.querySelectorAll(".lmb-ink-location").forEach(el => el.remove());
      for (const host of this._lmbInkCardObservers || []) { host._lmbInkSizeObserver.disconnect(); delete host._lmbInkSizeObserver; clearTimeout(host._lmbInkFitTimer); }
      this._lmbInkCardObservers?.clear();
      this._lmbInkActionPress = this._lmbInkActionClick = null;
    });
  }
});

class LMBInkNoteTitleModal extends Modal {
  constructor(app, title, submit) { super(app); this.title = title; this.submitNote = submit; }
  onOpen() {
    this.contentEl.createEl("h3", { text: "新建手写备注" });
    const input = this.contentEl.createEl("input", { attr: { type: "text", "aria-label": "手写备注标题", maxlength: "160" } }); input.value = this.title; input.style.width = "100%";
    this.contentEl.createEl("p", { text: "保留原始笔迹；创建后可在侧栏补充 Markdown，或放入 Canvas。" });
    const status = this.contentEl.createDiv({ cls: "lmb-ink-create-status" });
    const save = this.contentEl.createEl("button", { text: "创建" });
    save.onclick = async () => { if (save.disabled) return; save.disabled = true; try { await this.submitNote(input.value); this.close(); } catch (error) { status.textContent = "创建失败，标题与笔迹已保留：" + error.message; save.disabled = false; } };
    input.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) save.click(); };
    input.focus(); input.select();
  }
  onClose() { this.contentEl.empty(); }
}

/* 31-plugin-selection —— 选区/拖拽/chip/即时通道（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

  /* ==================== 框选启动（按钮模式 / Alt） ==================== */

  onDocMouseDown(e) {
    if (this.chipEl && !this.chipEl.contains(e.target)) this.hideChip();

    const el = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
    if (!el || !el.closest) return;
    const leafEl = el.closest(".workspace-leaf");
    const leaf = leafEl && this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl);

    // Alt 或 按钮模式 → 启动自带框选
    if ((e.altKey || this.rectMode) && e.button === 0 && leaf && leaf.view && leaf.view.file) {
      // v0.16.4 修复 P2-6：按钮模式与 Alt 模式都拦截原生文字选择
      //   （旧注释声称"Alt 亦然"，代码却 if (!e.altKey) 跳过 → Alt 框选时选区同时发生）
      e.preventDefault();
      e.stopPropagation();
      this.startRectDrag(leaf, e);
      return;
    }
  },

  /** Mobile entry point. Pointer events cover Apple Pencil and touch with one path. */
  onDocPointerDown(e) {
    if (!e || (e.pointerType !== "touch" && e.pointerType !== "pen")) return;
    if (this.chipEl && !this.chipEl.contains(e.target)) this.hideChip();
    if (!this.rectMode) return;
    const el = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
    const leafEl = el && el.closest && el.closest(".workspace-leaf");
    const leaf = leafEl && this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl);
    if (!leaf || !leaf.view || !leaf.view.file) return;
    e.preventDefault();
    e.stopPropagation();
    this.startRectDrag(leaf, e, "pointer");
  },

  startRectDrag(leaf, e, eventFamily) {
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
    const moveEvent = eventFamily === "pointer" ? "pointermove" : "mousemove";
    const upEvent = eventFamily === "pointer" ? "pointerup" : "mouseup";
    const cancelEvent = eventFamily === "pointer" ? "pointercancel" : null;
    const cleanup = () => {
      document.removeEventListener(moveEvent, mv, true);
      document.removeEventListener(upEvent, up, true);
      if (cancelEvent) document.removeEventListener(cancelEvent, cancel, true);
    };
    const cancel = () => { cleanup(); box.remove(); };
    const up = async (ev) => {
      cleanup();
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
      // v0.14.8：settings.autoAttachScreenshot 关掉时不生成 webp 附件 —— 用户嫌附件占空间，
  // 关掉后摘录更紧凑，且不影响自动 fit（fit 测的是 markdown 文字本身的高度）。
  const autoAttach = !(this.settings && this.settings.autoAttachScreenshot === false);
  const ctx = autoAttach ? await this.captureRectImage(leaf.view, pageEl, screenRect, pageNum) : null;
      if (ctx) {
        // v0.11.3：框选模式一次性复原（用户定版行为）—— 截完一次自动关闭，
        //   不再能直接拖拽选区，再截需再点按钮；Esc 关闭路径不变
        if (this.rectMode) {
          this.setRectMode(false);
          new Notice("MarginBook: 框选完成 —— 模式已自动关闭（再点一次按钮继续框选）", 2500);
        }
        // v0.11.4 双重识别（框选路径）：框到的区域里有文字 → 也出双重卡
        //   （文字引用块 + 截图 + lmb-view 切换按钮，默认文字视图）；
        //   没提不到文字（纯图/公式/图表）→ 维持纯截图卡。
        const rectText = this.extractRectText(pageEl, screenRect);
        if (rectText) {
          const info = {
            file: ctx.file, pageNum: ctx.pageNum, display: ctx.display,
            link: ctx.link,          // 框选路径回跳链接仍是 rect=（精确回到截取区域）
            text: rectText, isImage: false,
            img: {
              attachmentName: ctx.attachmentName, embed: ctx.embed,
              imgW: ctx.imgW, imgH: ctx.imgH, rectParam: ctx.rectParam
            }
          };
          this.debugNotice("✓ 框选双重摘录：文字 " + rectText.length
            + " 字 + 截图 " + ctx.attachmentName);
          this.showChip(ev.clientX, ev.clientY,
            "📝 " + rectText.length + " 字 + 🖼 截图" + (this.isMobile ? " · 点按钮保存" : " · 按住拖到 md 或画布"), info);
        } else {
          this.debugNotice("✓ 截图已保存 " + ctx.attachmentName + "（" + ctx.imgW + "×" + ctx.imgH + "）");
          this.showChip(ev.clientX, ev.clientY, "🖼 图片已截图" + (this.isMobile ? " · 点按钮保存" : " · 按住拖到 md 或画布"), ctx);
        }
      } else {
        // v0.16.4 修复 P1-1：关闭「自动附截图」（或截图失败）时框选不再整链路报废——
        //   降级为纯文字摘录（rect= 回跳链接照常生成，无 webp 附件）。
        //   旧版 ctx=null 直接走「✗ 截图失败」，与设置文案"关闭后新摘录只有文字"矛盾。
        const view = leaf.view;
        const file = view && view.file;
        if (!file) { this.debugNotice("✗ 框选失败：拿不到 PDF 文件"); return; }
        const display = "【" + file.basename + "-P." + pageNum + "】";
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
        } catch (_) { /* 算不出就不写 rect */ }
        const link = "[[" + file.path + "#page=" + pageNum
          + (rectParam ? "&rect=" + rectParam : "") + "|" + display + "]]";
        const rectText = this.extractRectText(pageEl, screenRect);
        if (!rectText) {
          this.debugNotice("✗ 框选区域没有文字，且截图不可用（自动附截图已关闭或截图失败）");
          return;
        }
        if (this.rectMode) {
          this.setRectMode(false);
          new Notice("MarginBook: 框选完成 —— 模式已自动关闭（再点一次按钮继续框选）", 2500);
        }
        const info = { file, pageNum, display, link, text: rectText, isImage: false };
        this.debugNotice("✓ 框选摘录（无截图）：文字 " + rectText.length + " 字");
        this.showChip(ev.clientX, ev.clientY,
            "📝 " + rectText.length + " 字" + (this.isMobile ? " · 点按钮保存" : " · 按住拖到 md 或画布"), info);
      }
    };
    document.addEventListener(moveEvent, mv, true);
    document.addEventListener(upEvent, up, true);
    if (cancelEvent) document.addEventListener(cancelEvent, cancel, true);
  },

  pageAtPoint(doc, x, y) {
    const hit = doc.elementFromPoint(x, y);
    return hit && hit.closest ? hit.closest(".page[data-page-number]") : null;
  },

  /**
   * v0.11.4 框选路径的文字提取：屏幕矩形 → 与页面 textLayer 的 span 求交集 → 拼文字。
   *   零 OCR / 零 pdfjs 内部 API：pdf.js 已把文字渲染成 textLayer 的 span（按行分块），
   *   只做几何求交 + 按行聚合一版阅读顺序文本。
   *   提不到（无 textLayer / 纯图区域 / 虚拟化页未渲染文本层）→ 返回 null → 纯截图卡。
   * 聚合规则：span 按 top 分行（行距超过 span 高度一半算换行），行内按 left 排序，
   *   行间以空格连接（与 extractSelection 的空白归一语义一致）。
   */
  extractRectText(pageEl, screenRect) {
    try {
      const layer = pageEl.querySelector(".textLayer");
      if (!layer) return null;
      const spans = layer.querySelectorAll("span");
      if (!spans.length) return null;
      const hits = [];
      for (const sp of spans) {
        const t = sp.textContent || "";
        if (!t.trim()) continue;
        const r = sp.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        // 矩形相交测试（边缘相切不算命中）
        if (r.right <= screenRect.left || r.left >= screenRect.right) continue;
        if (r.bottom <= screenRect.top || r.top >= screenRect.bottom) continue;
        hits.push({ r, text: t });
      }
      if (!hits.length) return null;
      hits.sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
      // 按行聚类：与上一个 span 的 top 差超过其高度一半 → 新行
      const lines = [];
      let lastTop = null;
      for (const h of hits) {
        const newLine = lastTop === null
          || Math.abs(h.r.top - lastTop) > Math.max(6, h.r.height * 0.5);
        if (newLine) lines.push([h]);
        else lines[lines.length - 1].push(h);
        lastTop = h.r.top;
      }
      const text = lines
        .map((l) => l.sort((a, b) => a.r.left - b.r.left)
          .map((h) => h.text.trim()).join(" ").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return text || null;
    } catch (err) {
      console.warn("[lmb] extractRectText error:", err);
      return null;
    }
  },

  /**
   * v0.11.3 双重识别：文字选区 → 同时截一张选区外接矩形的区域图。
   *   复用 captureRectImage（零 pdfjs 内部 API，直接裁页面画布）；
   *   截图失败 / 选区不在 PDF 页内 → 返回 null，降级为纯文字摘录（与旧行为一致）。
   * 返回 { attachmentName, embed, imgW, imgH, rectParam } 或 null（挂到 info.img）。
   * 已知边界：跨页选区只按起始页画布截图（超出部分被裁掉）——跨页文字本就罕见，
   *   不为此引入跨页拼接的复杂度。
   */
  async captureSelectionImage(sel, info) {
    try {
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el || !el.closest) return null;
      const pageEl = el.closest(".page[data-page-number]");
      if (!pageEl) return null;
      const ctx = this.resolvePdfContext(pageEl);
      if (!ctx || !ctx.view || !ctx.view.file) return null;
      // 选区建立时已经保存了相对页面坐标。拖拽开始时 PDF 可能因侧栏/缩放重排，
      // 不能再用旧 Range 的 getBoundingClientRect（它可能膨胀到整页）。
      const pr = pageEl.getBoundingClientRect();
      const pct = info && info.selectionRect;
      let screenRect = null;
      if (pct && pct.length === 4 && pr.width > 0 && pr.height > 0) {
        screenRect = {
          left: pr.left + pr.width * pct[0] / 100,
          top: pr.top + pr.height * pct[1] / 100,
          right: pr.left + pr.width * (pct[0] + pct[2]) / 100,
          bottom: pr.top + pr.height * (pct[1] + pct[3]) / 100
        };
      }
      // 无可靠百分比矩形时宁可降级为纯文字，也不能再冒险截取整页。
      if (!screenRect) return null;
      // v0.14.8：settings.autoAttachScreenshot 关掉时不生成 webp
      const autoAttach = !(this.settings && this.settings.autoAttachScreenshot === false);
      const cap = autoAttach ? await this.captureRectImage(ctx.view, pageEl, screenRect, info.pageNum || ctx.pageNum) : null;
      if (!cap) return null;
      return {
        attachmentName: cap.attachmentName, embed: cap.embed,
        imgW: cap.imgW, imgH: cap.imgH, rectParam: cap.rectParam
      };
    } catch (err) {
      console.warn("[lmb] captureSelectionImage error:", err);
      return null;
    }
  },

  /* ==================== mouseup：出示手柄 ==================== */

  onDocMouseUp(e) {
    const eventEl = e.target && (e.target.nodeType === 1 ? e.target : e.target.parentElement);
    if (eventEl && eventEl.closest && eventEl.closest(".lmb-pdf-text-block")) return;
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
          /* v0.16.6 P1-1：截图从「mouseup 无条件生成」改为「用户真的开始拖才生成」。
           *   旧版 mouseup 里直接 captureSelectionImage → captureRectImage → vault.createBinary，
           *   **与用户是否拖拽无关** —— 只是双击选个词，vault 里就多一个永不清理的 webp
           *   孤儿；同时 imgDims 每多一项就写进 data.json，配置无限膨胀、启动 loadData 变慢。
           *   难点：dataTransfer.setData 必须同步调用，dragstart 里不能 await 截图。
           *   解法 = 分两步：
           *     ① mouseup 只把选区 Range **克隆**下来（克隆 Range 不随 live selection 变化，
           *        用户后续点 chip / 拖动都不会让它失效）；
           *     ② chip 的 mousedown/touchstart（= 用户明确要拖了）才启动截图，
           *        dragstart 通常晚于 mousedown 几十~几百毫秒，截图基本已就绪；
           *        万一没赶上 → info.img 为 undefined，自动降级为纯文字摘录（成熟降级路径）。
           *   降级是安全的：与「关掉自动附截图」走同一条分支，不会报错也不会写坏卡。 */
          // extractSelection owns the sanitized PDF-only range.
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
      this.debugNotice("mouseup：无文字选区（图片框选 = PDF 工具栏按钮 / Alt+拖）");
    }
  },

  onDocPointerUp(e) {
    if (!e || (e.pointerType !== "touch" && e.pointerType !== "pen") || this.rectMode) return;
    // WebKit finalizes its native text selection after pointerup.
    if (this._mobileSelectionTimer) clearTimeout(this._mobileSelectionTimer);
    this._mobileSelectionTimer = setTimeout(() => {
      this._mobileSelectionTimer = null;
      this.showMobileSelectionChip(e.clientX, e.clientY);
    }, 120);
  },

  onMobileSelectionChange() {
    if (!this.isMobile || this.rectMode) return;
    if (this._mobileSelectionTimer) clearTimeout(this._mobileSelectionTimer);
    this._mobileSelectionTimer = setTimeout(() => {
      this._mobileSelectionTimer = null;
      this.showMobileSelectionChip();
    }, 320);
  },

  showMobileSelectionChip(x, y) {
    try {
      const win = typeof activeWindow !== "undefined" ? activeWindow : window;
      const sel = win.getSelection();
      const info = sel && !sel.isCollapsed && sel.rangeCount ? this.extractSelection(sel) : null;
      if (!info) return false;
      const sig = info.text + "@" + info.pageNum;
      if (this.chipEl && this._chipSig === sig) return true;
      const range = info._range;
      const rect = range.getBoundingClientRect();
      const px = Number.isFinite(x) && x > 0 ? x : rect.left + Math.min(rect.width, 48);
      const py = Number.isFinite(y) && y > 0 ? y : rect.bottom;
      this._chipSig = sig;
      this.showChip(px, py, "📑 " + info.text.length + " 字 · 点按钮保存", info);
      return true;
    } catch (_) { return false; }
  },

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
  },

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
  },

  /**
   * v0.9.3 + v0.11.1：由鼠标事件同时拿到 canvas 视图的内部 canvas 对象 **和** 所属 file/path，
   *   避免老版「canvasObj.view.file.path」在 polling 早期偶发为 null 的陷阱
   *   （canvas 渲染引擎的 back-reference 在 canvas 还没完全加载时可能没填充 .view.file）。
   *   返回 { canvasObj, leaf, file } 或 null。供 instantAttach 与 instantMoveAttach 使用。
   */
  canvasCtxFromEvent(e) {
    const t = e && e.target;
    const el = t && t.nodeType === 1 ? t : (t && t.parentElement);
    if (!el || !el.closest) return null;
    const leafEl = el.closest(".workspace-leaf");
    if (!leafEl) return null;
    try {
      const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.containerEl === leafEl);
      if (!leaf || !leaf.view) return null;
      const c = leaf.view.canvas;
      const f = leaf.view.file;
      if (!c || typeof c.getData !== "function" ||
          typeof c.setData !== "function" || typeof c.requestSave !== "function") return null;
      return f && f.extension === "canvas" ? { canvasObj: c, leaf, file: f } : { canvasObj: c, leaf, file: null };
    } catch (_) {
      return null;
    }
  },

  /**
   * v0.9.3 兼容垫层：保留旧名返回 canvasObj（drop/mouseup 老调用方不传 file 才用得上），
   *   新代码优先用 canvasCtxFromEvent 同时拿 file。
   */
  canvasObjFromEvent(e) {
    const ctx = this.canvasCtxFromEvent(e);
    return ctx ? ctx.canvasObj : null;
  },

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
  },

  /* ==================== 图片：裁剪页面画布 → webp 附件 ==================== */

  _lmbExcerptImageFolder(pdfFile) {
    if (this.settings && this.settings.storageLayout === "central") return this.lmbStoragePaths(pdfFile).attachments;
    const safe = (value) => String(value || "").replace(/[\\:*?"<>|]/g, "-").replace(/[. ]+$/g, "").trim();
    const pdfName = safe(pdfFile && pdfFile.basename) || "未命名PDF";
    const template = String((this.settings && this.settings.excerptImageFolder) || "附件/{pdf}")
      .replace(/\{pdf\}/gi, pdfName).replace(/\\/g, "/");
    const parts = template.split("/").map((part) => safe(part))
      .filter((part) => part && part !== "." && part !== "..");
    return normalizePath(parts.join("/") || ("附件/" + pdfName));
  },

  async _lmbEnsureVaultFolder(folder) {
    const adapter = this.app.vault.adapter;
    let current = "";
    for (const part of String(folder || "").split("/").filter(Boolean)) {
      current = normalizePath(current ? current + "/" + part : part);
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  },

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
      const folder = this._lmbExcerptImageFolder(view.file);
      await this._lmbEnsureVaultFolder(folder);
      const path = normalizePath(folder + "/" + name);
      await this.app.vault.createBinary(path, buf);

      this.imgDims.set(path, { w: out.width, h: out.height });
      this.imgDims.set(name, { w: out.width, h: out.height }); // 存量短路径兼容
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
        link, embed: "![[" + path + "]]",
        attachmentName: path, imgW: out.width, imgH: out.height,
        rectParam,
        text: "（矩形图像选区）", isImage: true
      };
    } catch (err) {
      console.error("[lmb] captureRectImage error:", err);
      return null;
    }
  },

  /* ==================== 文字选区 ==================== */

  lmbPdfSelectionRange(sel, pageEl) {
    const layer = pageEl.querySelector(".textLayer");
    if (!layer || !sel || sel.rangeCount !== 1) return null;
    const anchor = sel.anchorNode;
    const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    // A page is also home to our editor, toolbar and marks. Only PDF text may
    // originate an excerpt; never trust the page ancestor alone.
    if (!el || !layer.contains(el) || el.closest(".lmb-pdf-text-block")) return null;
    const bounds = pageEl.ownerDocument.createRange(); bounds.selectNodeContents(layer);
    const range = sel.getRangeAt(0).cloneRange();
    if (bounds.comparePoint(range.startContainer, range.startOffset) > 0
      || bounds.comparePoint(range.endContainer, range.endOffset) < 0) return null;
    if (bounds.comparePoint(range.startContainer, range.startOffset) < 0) range.setStart(bounds.startContainer, bounds.startOffset);
    if (bounds.comparePoint(range.endContainer, range.endOffset) > 0) range.setEnd(bounds.endContainer, bounds.endOffset);
    return range.collapsed ? null : range;
  },

  resolvePdfContext(el) {
    const pageEl = el && el.closest && el.closest(".page[data-page-number]");
    if (!pageEl) return null;
    const leafEl = pageEl.closest(".workspace-leaf");
    if (!leafEl) return null;
    const leaf = this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl);
    const view = leaf && leaf.view;
    if (!view || !view.file) return null;
    return { view, pageEl, pageNum: parseInt(pageEl.dataset.pageNumber, 10) || 1 };
  },

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
      if (el.closest(".lmb-pdf-text-block")) return null;
      const pageEl = el.closest(".page[data-page-number]");
      if (!pageEl) return null;
      const ctx = this.resolvePdfContext(el);
      if (!ctx || ctx.pageEl !== pageEl) return null;
      const file = ctx.view.file;
      const pageNum = ctx.pageNum;
      const pdfRange = this.lmbPdfSelectionRange(sel, pageEl);
      if (!pdfRange) return null;
      const text = pdfRange.toString().replace(/\s+/g, " ").trim();
      if (!text) return null;
      const display = "【" + file.basename + "-P." + pageNum + "】";

      // 同时保存选区的页面百分比矩形：selection 索引漂移时用它精确回绘，
      // 自动附图也复用它，避免延迟截图把整页裁进去。
      let selectionRect = null;
      try {
        const range = pdfRange, pr = pageEl.getBoundingClientRect();
        const rects = Array.from(range.getClientRects()).filter((r) => {
          if (!r || r.width < .5 || r.height < .5) return false;
          if (r.right <= pr.left || r.left >= pr.right || r.bottom <= pr.top || r.top >= pr.bottom) return false;
          return !(r.width > pr.width * .97 && r.height > pr.height * .18);
        });
        if (rects.length && pr.width > 0 && pr.height > 0) {
          const left = Math.max(pr.left, Math.min(...rects.map((r) => r.left)));
          const top = Math.max(pr.top, Math.min(...rects.map((r) => r.top)));
          const right = Math.min(pr.right, Math.max(...rects.map((r) => r.right)));
          const bottom = Math.min(pr.bottom, Math.max(...rects.map((r) => r.bottom)));
          if (right > left && bottom > top) selectionRect = [
            100 * (left - pr.left) / pr.width, 100 * (top - pr.top) / pr.height,
            100 * (right - left) / pr.width, 100 * (bottom - top) / pr.height
          ].map((v) => Math.round(v * 100) / 100);
        }
      } catch (_) {}

      // 补丁 B：P1-5 颜色语义——best-effort 探测选区命中的高亮注释背景色 → 映射标签名。
      // 探测不到 / 未命中映射 / 未配置 colorMap 时恒为 null，行为与现状一致。
      let colorTag = null;
      try { colorTag = this.detectColorTag(el, pageEl); }
      catch (err) { console.warn("[lmb] detectColorTag error:", err); }

      let link;
      let selectionParams = null; // Bugfix: 必须随 info 返回，contentExId 才能区分「同页同文本不同位置」的选区
      const targetText = text;
      try {
        const params = this.buildSelectionParams({ anchorNode: pdfRange.startContainer, anchorOffset: pdfRange.startOffset,
          focusNode: pdfRange.endContainer, focusOffset: pdfRange.endOffset }, pageEl);
        if (!params) throw new Error("no selection params");
        selectionParams = params;
        link = "[[" + file.path + "#page=" + pageNum + "&selection=" + params
          + (selectionRect ? "&rect=" + selectionRect.join(",") : "")
          + "&target=" + encodeURIComponent(targetText)
          + "|" + display + "]]";
      } catch (_) {
        // 回退路径（极端场景：buildSelectionParams 失败），也保留目标文本，便于后续定位与审计。
        link = "[[" + file.path + "#page=" + pageNum
          + "&target=" + encodeURIComponent(targetText)
          + "|" + display + "]]";
      }
      return {
        file,
        pageNum,
        text,
        link,
        display,
        isImage: false,
        colorTag,
        selectionParams,
        selectionRect,
        targetText,
        _range: pdfRange
      };
    } catch (err) {
      console.warn("[lmb] extractSelection error:", err);
      return null;
    }
  },

  /** DOM 选区边界 → selection= 链接参数（textLayer 子 div 序号 + 字符偏移） */
  buildSelectionParams(sel, pageEl) {
    const doc = pageEl.ownerDocument;
    const layer = pageEl.querySelector(".textLayer");
    if (!layer) return null;
    const divs = Array.prototype.slice.call(layer.children);
    if (!divs.length) return null;

    const toIdxOff = (node, offset) => {
      if (node === layer) {
        const atEnd = offset >= divs.length;
        const idx = atEnd ? divs.length - 1 : Math.max(0, offset);
        return { idx, off: atEnd ? (divs[idx].textContent || "").length : 0 };
      }
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
  },

  /**
   * 补丁 A：内容寻址 exId（P0-1）——同一选区重复拖拽 → 同一 ^ex id → 引用计数正确、天然去重。
   * 哈希基底：
   *   - 图片选区（isImage）：attachmentName（内含时间戳+随机戳，每张截图天然唯一）
   *   - 文字选区：file.path | pageNum | selectionParams（未注入时回退 text）
   * 使用两个独立 32-bit hash 拼成 10 位 base36，显著降低主键碰撞概率；旧短 ID 继续兼容。
   */
  contentExId(info) {
    try {
      const key = (info && info.isImage && info.attachmentName)
        ? "img|" + String(info.attachmentName)
        : [
            (info && info.file && info.file.path) ? info.file.path : "?",
            (info && info.pageNum != null) ? String(info.pageNum) : "?",
            String((info && (info.selectionParams || info.text)) || "")
          ].join("|");
      const a = parseInt(this.simpleHash(key), 10) >>> 0;
      const b = parseInt(this.simpleHash(key.split("").reverse().join("") + "|lmb"), 10) >>> 0;
      return "ex-" + a.toString(36).padStart(7, "0").slice(-7)
        + b.toString(36).padStart(7, "0").slice(-3);
    } catch (err) {
      // 优雅降级：任何异常回退随机 id（仅损失去重能力，不影响功能）
      console.warn("[lmb] contentExId 降级为随机 id:", err);
      return "ex-" + Math.random().toString(36).slice(2, 8);
    }
  },

  buildDropText(info) {
    try {
      const exId = this.contentExId(info);
      // 补丁 B 颜色语义标签行（extractSelection 注入 info.colorTag，非空才输出），
      // 位于 ^ex 行之前；info.colorTag 不存在/为空时行为与旧版完全一致。
      const tagLine = (info && info.colorTag) ? "\n> #" + info.colorTag : "";
      // v0.12.0：引用行只显示 📖（点击跳转不变，lmbBookLink 只改显示名不改链接本体）；
      //   导出摘录 md 时由 lmbRestoreRefDisplayName 还原【文件名-P.N】全名。
      //   旧版「> ([[..|【x-P.4】]])」外层括号一并去掉（📖 后括号纯占宽度）。
      const refLine = "> " + lmbBookLink(info.link);
      let raw = "";
      if (info.isImage) raw = info.embed + "\n" + refLine + tagLine + "\n^" + exId;
// v0.11.3 双重摘录：文字选区同时截了图（info.img）→ 引用块 + 截图 embed 一起进卡。
    //   v0.16.0：**不再写 `> [!lmb-view]` 切换按钮行**（卡片精简 v2 —— 用户要求卡内不放控件）。
    //   视图切换改由悬浮栏「视图」按钮接管：判定「双重卡」= 同时含 PDF 引用行 + 截图 embed
    //   （26-pure-canvasbar.js lmbPickBarActions），切换走 toggleCardViewByHost 直接给 host
    //   加/去 lmb-view-img class —— **不再依赖 lmb-view callout 存在**（详见 33-plugin-note-comment.js）。
    //   副作用：老版本建的双重卡（markdown 里已带 lmb-view 行）仍然能被识别与切换，零迁移。
    //   纯文字路径（无 img）输出与旧版完全一致。
    // v0.14.8：settings.autoAttachScreenshot 关掉时不挂 img.embed（防御性双保险）。
      if (!raw) {
        let s = refLine + "\n> " + info.text + tagLine;
        const autoAttach = !(this.settings && this.settings.autoAttachScreenshot === false);
        if (autoAttach && info.img && info.img.embed) s += "\n\n" + info.img.embed;
        raw = s + "\n^" + exId;
      }
      // v0.20.1：无论直接拖进 Markdown 还是 Canvas，先生成统一视觉卡；Canvas 同步时会
      // 用 lmbUnwrapExcerptCard 还原内容，避免摘录文档出现嵌套卡片。
      const kind = (info.isImage || (info.img && info.img.embed)) ? "图像" : "原文";
      const title = "P." + ((info && info.pageNum != null) ? info.pageNum : "?") + " · " + kind;
      return "> [!lmb-excerpt]+ " + title + "\n> <span class=\"lmb-excerpt-id\" data-lmb-ex=\"" + exId + "\"></span>\n" + raw.split("\n").map((line) => "> " + line).join("\n");
    } catch (err) {
      console.error("[lmb] buildDropText error:", err);
      // 降级：恢复旧版随机 id 行为
      const exId = "ex-" + Math.random().toString(36).slice(2, 8);
      const raw = info.isImage
        ? info.embed + "\n> (" + info.link + ")\n^" + exId
        : "> (" + info.link + ")\n> " + info.text + "\n^" + exId;
      return "> [!lmb-excerpt]+ 摘录\n" + raw.split("\n").map((line) => "> " + line).join("\n");
    }
  },

  /**
   * 词语备注不是普通摘录的缩写：它直接写入摘录 MD 的独立持久化区域，
   * 不创建 Canvas 卡片、不附截图，也不会因 Canvas 同步而被重写。
   */
  async lmbCreateWordNote(info) {
    try {
      if (!info || !info.file || !String(info.text || "").trim()) return;
      const word = String(info.text).replace(/\s+/g, " ").trim();
      const wordInfo = Object.assign({}, info, { selectionParams: "word-note|" + String(info.selectionParams || word) });
      const exId = this.contentExId(wordInfo);
      const source = await this.lmbEnsureExcerptMdFile(info.file);
      if (!(source instanceof TFile)) { new Notice("MarginBook: 无法创建词语备注文档"); return; }
      const raw = await this.app.vault.cachedRead(source);
      const previous = this._lmbFindSidebarNote(raw, exId) || "";
      new LMBExcerptNoteModal(this.app, {
        title: "词语备注 · " + word,
        value: previous,
        sourcePath: source.path,
        onSubmit: async (value) => {
          const text = String(value || "").trim();
          if (!text && !raw.includes("^" + exId)) return;
          await this.app.vault.process(source, (current) => {
            if (current.includes("^" + exId)) return current;
            const entry = "> [!lmb-excerpt]+ 词语 · P." + (info.pageNum || "?") + "\n"
              + "> <span class=\"lmb-excerpt-id\" data-lmb-ex=\"" + exId + "\"></span>\n"
              + "> " + info.link + "\n"
              + "> **" + word + "**\n"
              + "> ^" + exId + "\n";
            const begin = /<!--\s*LMB:WORD-NOTES:BEGIN\s*-->/i;
            const end = /<!--\s*LMB:WORD-NOTES:END\s*-->/i;
            if (begin.test(current) && end.test(current)) return current.replace(end, entry + "<!-- LMB:WORD-NOTES:END -->");
            return current.replace(/\s*$/, "\n\n") + "<!-- LMB:WORD-NOTES:BEGIN -->\n" + entry + "<!-- LMB:WORD-NOTES:END -->\n";
          });
          // 新条目先落盘，再以同一套保存逻辑写入备注，保证三端的唯一真相源仍是 MD。
          if (text) await this.lmbSaveExcerptNote(source, exId, text);
          await this.reindexFile(source, true);
          this.lmbRefreshAllMarks();
          this.lmbSchedulePdfSidebarRefresh(0);
          new Notice("MarginBook: 已保存“" + word + "”的词语备注");
        }
      }).open();
    } catch (err) {
      console.warn("[lmb] create word note failed:", err);
      new Notice("MarginBook: 保存词语备注失败，详情见控制台");
    }
  },

  async _lmbCaptureDirectExcerptImage(info) {
    if (!info || info.isImage || info.img || (this.settings && this.settings.autoAttachScreenshot === false) || !info._range) return info;
    const fakeSelection = { rangeCount: 1, getRangeAt: () => info._range };
    const image = await this.captureSelectionImage(fakeSelection, info);
    if (image) info.img = image;
    return info;
  },

  async lmbCreateDirectMdExcerpt(info) {
    try {
      await this._lmbCaptureDirectExcerptImage(info);
      const source = await this.lmbEnsureExcerptMdFile(info.file);
      if (!(source instanceof TFile)) throw new Error("excerpt document unavailable");
      const exId = this.contentExId(info);
      await this.app.vault.process(source, (raw) => {
        if (raw.includes("^" + exId)) return raw;
        const isImage = !!info.isImage;
        let entry = "> [!lmb-excerpt]+ P." + (info.pageNum || "?") + " · " + (isImage ? "图像" : "原文") + "\n"
          + "> <span class=\"lmb-excerpt-id\" data-lmb-ex=\"" + exId + "\"></span>\n"
          + "> " + lmbBookLink(info.link) + "\n";
        if (isImage && info.embed) entry += "> " + info.embed + "\n";
        else entry += "> " + String(info.text || "") + "\n";
        if (!isImage && info.img && info.img.embed) entry += "> " + info.img.embed + "\n";
        entry += "> ^" + exId + "\n";
        const end = /<!--\s*LMB:MANUAL-EXCERPTS:END\s*-->/i;
        return end.test(raw) ? raw.replace(end, entry + "<!-- LMB:MANUAL-EXCERPTS:END -->")
          : raw.replace(/\s*$/, "\n\n") + "<!-- LMB:MANUAL-EXCERPTS:BEGIN -->\n" + entry + "<!-- LMB:MANUAL-EXCERPTS:END -->\n";
      });
      await this.reindexFile(source, true); this.lmbRefreshAllMarks(); this.lmbSchedulePdfSidebarRefresh(0);
      new Notice("MarginBook: 已创建摘录并写入摘录文档");
    } catch (err) { console.warn("[lmb] direct md excerpt failed:", err); new Notice("MarginBook: 创建摘录失败"); }
  },

  /** Mobile-safe replacement for HTML5 drag-and-drop: append directly to the PDF canvas. */
  async lmbCreateDirectCanvasExcerpt(info) {
    try {
      await this._lmbCaptureDirectExcerptImage(info);
      const cf = await this.lmbOpenOrCreatePdfCanvas(info.file);
      if (!(cf instanceof TFile)) throw new Error("canvas unavailable");
      const rd = await this._lmbReadCanvasData(cf);
      if (!rd || !rd.data) throw new Error("canvas data unavailable");
      const data = rd.data;
      if (!Array.isArray(data.nodes)) data.nodes = [];
      if (!Array.isArray(data.edges)) data.edges = [];
      const text = this.buildDropText(info);
      const exId = this.contentExId(info);
      const duplicate = data.nodes.find((n) => n && n.type === "text" && String(n.text || "").includes("^" + exId));
      if (duplicate) {
        await this.lmbFocusCanvasNode(cf, duplicate.id);
        new Notice("MarginBook: 该摘录已在专属画布中");
        return;
      }
      const width = Math.max(320, Math.min(800, Number(this.settings.excerptCardWidth) || 560));
      const size = this.estimateSizeFor(text, { width });
      const right = data.nodes.reduce((m, n) => Math.max(m, (Number(n.x) || 0) + (Number(n.width) || 0)), -80);
      const top = data.nodes.length ? Math.min(...data.nodes.map((n) => Number(n.y) || 0)) : 0;
      const node = {
        id: "lmb" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        type: "text", text, x: right + 80, y: top,
        width, height: Math.max(120, Math.round(Number(size && size.h) || 220))
      };
      data.nodes.push(node);
      const ok = await this._lmbWriteCanvasData(cf, data, rd.memCanvas, rd.raw);
      if (!ok) throw new Error("canvas write failed");
      await this.processCanvas(cf);
      await this.lmbIndexCanvasFile(cf);
      await this.lmbFocusCanvasNode(cf, node.id);
      new Notice("MarginBook: 已加入 PDF 专属画布");
    } catch (err) {
      console.warn("[lmb] direct canvas excerpt failed:", err);
      new Notice("MarginBook: 加入画布失败");
    }
  },

  async lmbCreateQuickExcerpt(info) {
    try {
      await this._lmbCaptureDirectExcerptImage(info);
      const path = String(info.file && info.file.path || "").replace(/\\/g, "/");
      if (!path) throw new Error("pdf unavailable");
      this.settings.quickExcerpts = this.settings.quickExcerpts || {};
      const list = this.settings.quickExcerpts[path] || (this.settings.quickExcerpts[path] = []);
      const signature = String(info.selectionParams || info.text || "");
      if (!list.some((e) => e.signature === signature && e.page === info.pageNum)) list.push({
        exId: "quick-" + Date.now().toString(36), signature, page: info.pageNum, selection: info.selectionParams ? info.selectionParams.split(",").map(Number) : null,
        rect: info.selectionRect || ((info.rectParam || (info.img && info.img.rectParam)) ? String(info.rectParam || info.img.rectParam).split(",").map(Number) : null),
        target: info.targetText || info.text || "", text: info.text || (info.isImage ? "（图片摘录）" : ""),
        imagePath: info.attachmentName || (info.img && info.img.attachmentName) || null
      });
      await this.saveSettings(); this.lmbRefreshAllMarks(); this.lmbSchedulePdfSidebarRefresh(0);
      new Notice("MarginBook: 已创建简洁摘录（仅 PDF 侧栏）");
    } catch (err) { console.warn("[lmb] quick excerpt failed:", err); new Notice("MarginBook: 创建简洁摘录失败"); }
  },

  /* ==================== 拖拽手柄（纯原生 HTML5 drag） ==================== */

  /**
   * v0.16.6 P1-1：按需截图的触发入口 —— 只在用户按下 chip（明确要拖）时才真正生成 webp。
   *   背景与取舍见 onDocMouseUp 的同名注释：旧版 mouseup 无条件落盘，产生大量孤儿附件。
   * @param {Object} info extractSelection 的返回（需带克隆出来的 _range）
   */
  _armPendingImage(info) {
    try {
      if (!info || info.isImage || info.img || info._imgPending) return;
      const range = info._range;
      if (!range) return;
      // 关掉「自动附截图」时连生成都不用做（与 buildDropText 里的判据同源）
      if (this.settings && this.settings.autoAttachScreenshot === false) return;
      // 已卸载 / chip 已消失 → 不再生成（避免异步链在插件停止后写文件）
      if (this._unloaded) return;
      info._imgPending = true;
      // captureSelectionImage 只用到 rangeCount 与 getRangeAt(0)，用克隆 Range 造一个最小 sel。
      // 克隆 Range 不随 live selection 变化 —— 用户点 chip 导致原生选区被清也照样能截。
      const fakeSel = { rangeCount: 1, getRangeAt: () => range };
      this.captureSelectionImage(fakeSel, info).then((img) => {
        info._imgPending = false;
        if (!img) return;
        info.img = img;
        // 截到了就把 chip 文案补上「+ 🖼 截图」，让用户看得见这次拖拽会带图
        try {
          if (this.chipEl) {
            this.chipEl.textContent = "📑 " + String(info.text || "").length + " 字 + 🖼 截图 · 拖到 md 或画布";
          }
        } catch (_) {}
      }).catch((err) => {
        info._imgPending = false;
        console.warn("[lmb] 按需截图失败，本次拖拽降级为纯文字摘录:", err);
      });
    } catch (_) { /* 预取失败不影响拖拽本身 */ }
  },

  showChip(x, y, label, info) {
    this.hideChip();
    const doc = typeof activeDocument !== "undefined" ? activeDocument : document;
    const chip = doc.createElement("div");
    chip.className = "lmb-chip";
    const chipLabel = doc.createElement("span");
    chipLabel.className = "lmb-chip-label";
    chipLabel.textContent = label;
    chip.appendChild(chipLabel);
    // 两个独立入口：完整摘录写入 MD；简洁摘录只留在 PDF 侧栏。
    if (info && info.file && (info.isImage || String(info.text || "").trim())) {
      const makeAction = (icon, title, action) => {
        const btn = doc.createElement("button"); btn.className = "lmb-chip-action"; btn.type = "button"; btn.title = title; btn.setAttribute("aria-label", title);
        try { setIcon(btn, icon); } catch (_) { btn.setText(icon === "file-plus-2" ? "▣" : "⌁"); }
        btn.addEventListener("mousedown", (ev) => { ev.stopPropagation(); ev.preventDefault(); });
        btn.addEventListener("click", (ev) => { ev.stopPropagation(); ev.preventDefault(); action.call(this, info).finally(() => this.hideChip()); });
        chip.appendChild(btn);
      };
      makeAction("file-plus-2", "创建完整摘录到摘录文档", this.lmbCreateDirectMdExcerpt);
      if (this.isMobile) makeAction("layout-dashboard", "加入 PDF 专属画布", this.lmbCreateDirectCanvasExcerpt);
      makeAction("panel-right-open", "创建简洁摘录到 PDF 侧栏", this.lmbCreateQuickExcerpt);
    }
    chip.setAttribute("draggable", this.isMobile ? "false" : "true");
    chip.style.left = Math.min(x + 12, doc.defaultView.innerWidth - 240) + "px";
    chip.style.top = (y + 16) + "px";
    doc.body.appendChild(chip);
    this.chipEl = chip;

    /* v0.16.6 P1-1：按下 chip = 用户明确要拖 → 这一刻才启动截图（详见 onDocMouseUp 的注释）。
     *   只挂监听不干活，成本可忽略；截图失败则 info.img 保持 undefined → 降级纯文字摘录。 */
    // Desktop drag needs the image prepared before dragstart. Mobile actions await
    // capture themselves, so prefetching on touchstart would create duplicate files.
    if (!this.isMobile) {
      const armImage = () => this._armPendingImage(info);
      chip.addEventListener("mousedown", armImage);
    }

    chip.addEventListener("dragstart", (e) => {
      if (this.isMobile) { e.preventDefault(); return; }
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
  },

  hideChip() {
    if (this.chipEl) {
      this.chipEl.remove();
      this.chipEl = null;
    }
  },

  /* ==================== Canvas：尺寸适配 + 摘录文档同步 ==================== */

  /**
   * v0.5.0 即时通道：drop 后轮询内存 canvas 数据（60ms 间隔，最多 1.2s），
   * 新 ^ex 卡一出现立即做父子判定，命中则 setData + requestSave（毫秒级，绕过磁盘往返）。
   * 失败/超时/没压中卡 → 什么都不做，文件层管线（250ms + 出生重试）自然兜底。
   * v0.11.1：file 参数由 caller 从 canvasCtxFromEvent 传入（不再依赖 canvasObj.view，
   *   后者在 polling 早期可能没填充 .file → 漏 sidecar → processCanvas lmbRecenterNode 失效 → 侧翻）。
   */
  async instantAttach(canvasObj, file) {
    const filePath = (file && file.path) || (canvasObj.view && canvasObj.view.file && canvasObj.view.file.path) || null;
    const before = new Set(((canvasObj.getData() || {}).nodes || []).map((n) => n.id));
    const t0 = Date.now();
    while (Date.now() - t0 < 1200) {
      await new Promise((r) => setTimeout(r, 60));
      let data;
      try { data = canvasObj.getData(); } catch (_) { return; }
      const nodes = (data && data.nodes) || [];
      const nn = nodes.find((n) => !before.has(n.id) && n.type === "text" && n.text && EX_ID_RE.test(n.text));
      if (!nn) continue;
      const others = lmbBuildSpatialIndex(nodes).query(nn);
      const hit = lmbPickDropParent(nn, others);
      if (!hit) return; // 没压到卡 → 交给文件层（含出生重试）
      const parent = hit.node;
      if (!Array.isArray(data.edges)) data.edges = [];
      // v0.11.1：caller 给的 file.path 优先（更稳定）；fallback 到 canvasObj.view 旧路径
      const sidecar0 = (filePath && this.autoEdges.get(filePath)) || new Set();
      const plan = lmbPlanAutoLink(nn, parent, data.edges, sidecar0);
      if (plan.op === "create") {
        const byId = new Map(nodes.filter((n) => n && n.id).map((n) => [n.id, n]));
        const kidsBySide = lmbGroupBySide(parent, nodes, data.edges, byId);
        const group = [...(kidsBySide.get(plan.side) || []), nn];
        lmbLayoutGroup(parent, group, plan.side, 30);
        const ends = lmbSideEnds(plan.side);
        const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        data.edges.push({
          id: eid, fromNode: parent.id, toNode: nn.id,
          fromSide: ends.fromSide, toSide: ends.toSide
        });
        // v0.11.0 修复 + v0.11.1 强化：拿不到 file 时落到 caller 传进来的；
        //   setData 后 processCanvas 端 movedOrNew 还有一次性兜底补登（见 32-plugin-canvas.js）
        if (filePath) {
          const ae = this.autoEdges.get(filePath) || new Set();
          ae.add(eid);
          this.autoEdges.set(filePath, ae);
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
  },

  /**
   * v0.9.3 即时通道（移动已有卡）：canvas 内 mouseup 后直接在「内存 canvas 数据」上做
   * 移动检测 + 父子判定 + 组排布，不再等 Obsidian 把画布落盘（save 防抖可达 1s+）
   * → 文件层 80/400ms。修复「拖到另一张卡上好一会才连线对齐」。
   *   - 只处理「档案里已见过 + 位置变了」的卡；新落下的 ^ex 卡归 instantAttach / 文件层管（防双写）；
   *   - 命中父卡 → 换父摘旧自动边 → lmbLayoutGroup → setData + requestSave（毫秒级生效），
   *     并同步位置档案，防文件层把同一批移动再处理一遍；
   *   - 没压到卡 / API 不可用 → 静默返回，文件层管线自然兜底。
   * v0.11.1：file 参数由 caller 传入（参上 instantAttach 注释）。
   */
  async instantMoveAttach(canvasObj, file) {
    const path = (file && file.path) || (canvasObj.view && canvasObj.view.file && canvasObj.view.file.path) || null;
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
      const spatialIndex = lmbBuildSpatialIndex(nodes);
      const nodeById = new Map(nodes.filter((n) => n && n.id).map((n) => [n.id, n]));
      const movedRoots = moved.map((n) => {
        const prev = lastPos.get(n.id);
        return { id: n.id, dx: n.x - prev.x, dy: n.y - prev.y };
      });
      for (const nn of moved) {
        const others = spatialIndex.query(nn);
        const hit = lmbPickDropParent(nn, others);
        if (!hit) continue;
        const parent = hit.node;
        if (!Array.isArray(data.edges)) data.edges = [];
        const sidecar = this.autoEdges.get(path) || new Set();
        // v0.11.0：首连锁定 + 改挂侧（取代 v0.7.3 换父）。
        // v0.11.1：明确传 sizeOnly=false（这里是用户主动拖动，不是尺寸变化）
        const plan = lmbPlanAutoLink(nn, parent, data.edges, sidecar, { sizeOnly: false });
        if (plan.op === "skip") continue;
        if (plan.op === "recenter") {
          // v0.11.1：防御性同样过滤 nn 自身（auto edge 可能在 data.edges 里导致重复）
          const kidsBySideR = lmbGroupBySide(parent, nodes, data.edges, nodeById);
          const groupR = [...(kidsBySideR.get(plan.side) || []).filter((k) => k.id !== nn.id), nn];
          lmbLayoutGroup(parent, groupR, plan.side, 30);
          if (!sidecar.has(plan.edge.id)) sidecar.add(plan.edge.id);
          changed = true;
          continue;
        }
        if (plan.op === "reside") {
          // R4：拖回已连线的卡上 → 按落点方位改挂侧 + 两侧组重排（同侧 = 重新对齐）
          const r = lmbApplyReside(parent, nn, plan, nodes, data.edges);
          if (!sidecar.has(plan.edge.id)) sidecar.add(plan.edge.id);
          changed = true;
          console.log("[lmb] 即时通道（改挂侧）: ", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
            "(" + plan.oldSide + "→" + r.side + ")");
          continue;
        }
        // 取父卡现有子卡按侧分组；把新卡 nn 加进同侧组，整组贴边对齐+组居中排布
        // v0.11.1 防御：lmbGroupBySide 会通过已存在的 edge 把 nn 也算进来（虽然这里是 create
        //   路径理论上不会有，但若 nn 是从别处拖过来并且已经存在连线就可能），filter 防御
        const kidsBySide = lmbGroupBySide(parent, nodes, data.edges, nodeById);
        const group = [...(kidsBySide.get(plan.side) || []).filter((k) => k.id !== nn.id), nn];
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
      if (this.settings && this.settings.moveDescendantsWithParent === true) {
        // 父卡可能在上面的自动挂靠中再次被排布；按最终位置重算 delta，后代保持原相对位置。
        for (const move of movedRoots) {
          const root = nodes.find((n) => n && n.id === move.id);
          const prev = lastPos.get(move.id);
          if (root && prev) { move.dx = root.x - prev.x; move.dy = root.y - prev.y; }
        }
        const count = lmbMoveDescendants(nodes, data.edges, movedRoots);
        if (count) { changed = true; console.log("[lmb] 子卡联动移动:", count, "张"); }
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
  },

});

/* 32-plugin-canvas —— 画布处理/尺寸自适应/自愈（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

  lmbScheduleVisibleCanvasFits() {
    if (this._unloaded) return;
    const leaves = this.app.workspace.getLeavesOfType("canvas") || [];
    for (const leaf of leaves) {
      const file = leaf && leaf.view && leaf.view.file;
      if (file && file.extension === "canvas") this._scheduleActualFitRetry(file);
    }
  },

  async lmbApplyTreeLayout(direction) {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先打开一个 Canvas"); return; }
    const rd = await this._lmbReadCanvasData(ctx.file);
    if (!rd || !rd.data) return;
    const moved = lmbLayoutTree(rd.data.nodes || [], rd.data.edges || [], direction);
    if (!moved) { new Notice("没有可布局的卡片"); return; }
    await this._lmbWriteCanvasData(ctx.file, rd.data, rd.memCanvas, rd.raw);
    new Notice(`已按${direction === "down" ? "自上而下" : "从左到右"}树形布局 ${moved} 个根节点`);
  },

  scheduleCanvasSync(file) {
    const old = this.syncTimers.get(file.path);
    if (old) clearTimeout(old);
    // v0.4.5：防抖 800→250ms；v0.7.1：再→400ms 减少拖拽期 processCanvas 频率。
    // 拖拽时 Obsidian canvas 连续触发 modify，debounce 不断重置；400ms 让本插件不再打断拖拽手感。
    this.syncTimers.set(file.path, setTimeout(() => {
      this.syncTimers.delete(file.path);
      this.processCanvas(file).catch((err) => console.error("[lmb] canvas process failed:", err));
    }, 400));
  },

  /**
   * v0.16.1：拿目标画布的**内存最新数据**（canvas.getData()）。
   *   Bug6 的根因与修法说明见 processCanvas 顶部注释。找不到打开着的这个画布 → null
   *   （后台文件 / 未打开），调用方回退读文件。
   */
  _lmbMemCanvasData(cf) {
    try {
      const leaves = this.app.workspace.getLeavesOfType("canvas") || [];
      const leaf = leaves.find((l) => l && l.view && l.view.file && l.view.file.path === cf.path);
      if (!leaf) return null;
      const canvas = leaf.view.canvas;
      if (!canvas || typeof canvas.getData !== "function") return null;
      const data = canvas.getData();
      if (!data || !Array.isArray(data.nodes)) return null;
      /* v0.16.6 P0-1：nodes 为空 + 档案非空 = 画布正在加载（onOpenFile → setData 之间）
       *   的瞬时脏数据。旧版照常返回 → _lmbUpdateNodeMeta 的 alive 集合为空 →
       *   档案里**全部**条目被判成「已删除」→ 开启级联清理时该画布的 webp 被全删、
       *   摘录 md 的条目被整片删除（不可逆）。
       *   宁可这一次不处理（返回 null → 走文件读取 / 直接跳过），也绝不误删。 */
      if (data.nodes.length === 0) {
        const meta = this.nodeMeta && this.nodeMeta.get(cf.path);
        if (meta && meta.size > 0) return null;
      }
      return { canvas, data };
    } catch (_) { return null; }
  },

  /**
   * v0.16.1：processCanvas 的统一写回 —— **setData + requestSave + 同一份数据写盘**。
   *   关键纪律：写盘用的 data 必须就是刚 setData 的那份内存数据。
   *   旧版「改完再 adapter.write(改过的 data)」看似等价，但如果 data 的来源是**文件**
   *   （而不是内存），写盘等于把「文件里的陈旧位置」钉回去 —— 用户刚拖未落盘的移动丢失，
   *   表现为卡片弹回原位 / 在几个位置间瞬移（Bug6）。
   *   内存优先写（setData 毫秒级刷新渲染 + requestSave 让 Obsidian 自己落盘），
   *   文件写是同一份数据的持久化，不是「再改一次」。
   * @returns {boolean} 是否写盘成功
   */
  async _lmbWriteCanvasData(cf, data, memCanvas, rawForIndent) {
    let indent = "  ";
    try { indent = /\n\t"/.test(rawForIndent || "") ? "\t" : "  "; } catch (_) {}
    if (memCanvas && typeof memCanvas.setData === "function"
        && typeof memCanvas.requestSave === "function") {
      try {
        // 活动画布只保留一个写入者，避免 requestSave 与 adapter.write 竞态重载旧坐标。
        this.selfWritten.set(cf.path, Date.now());
        memCanvas.setData(data);
        memCanvas.requestSave();
        return true;
      } catch (_) {
        this.selfWritten.delete(cf.path);
        // 内部 API 失败时才回退文件写。
      }
    }
    this.selfWritten.set(cf.path, Date.now()); // v0.16.4 P2-4：存时间戳（过期不吞真实 modify）
    try {
      await this.app.vault.adapter.write(cf.path, JSON.stringify(data, null, indent));
      return true;
    } catch (err) {
      this.selfWritten.delete(cf.path);
      console.error("[lmb] canvas write failed:", err);
      return false;
    }
  },

  /**
   * v0.16.4（修复 P1-3）：评论/补充描述/批量挂框等单卡编辑链路的统一读取入口。
   *   与 processCanvas 同纪律：画布正打开 → 用 getData() 的内存数据（含未落盘改动）；
   *   拿不到 → 回退读文件。raw 一并返回（供 _lmbWriteCanvasData 探测缩进）。
   * @returns {{data:object, memCanvas:object|null, raw:string|null}|null}
   */
  async _lmbReadCanvasData(cf) {
    let raw = null;
    try { raw = await this.app.vault.adapter.read(cf.path); } catch (_) { raw = null; }
    const mem = this._lmbMemCanvasData(cf);
    if (mem) return { data: mem.data, memCanvas: mem.canvas, raw };
    if (!raw) return null;
    try { return { data: JSON.parse(raw), memCanvas: null, raw }; } catch (_) { return null; }
  },

  async processCanvas(cf) {
    // v0.16.1【Bug6 根因修复】：数据源从「文件」改为「canvas 内存」优先。
    //   旧版第 17 行 vault.read(cf) 读到的是**磁盘内容**：用户刚拖动 / 删除卡片后
    //   Obsidian 未必已落盘（modify 防抖 400ms + Obsidian 自身落盘时机不定），此时
    //   本函数若做了任何改动（fit 高度 / 自动挂框 / 自动父子）并写回，等于把**拖动前
    //   的旧位置**钉回文件 → Obsidian 重载画布 → 卡片弹回原位 / 在几个位置间瞬移。
    //   这与 v0.14.9 修 lmbFitNodeById 的是同一个坑 —— 那条链路修了，本函数漏了。
    //   修法：_lmbMemCanvasData(cf) 能拿到（画布正打开）就用 getData() 的内存数据
    //   （必然含用户未落盘的改动）；拿不到才回退读文件。raw 仍要读一次 —— 只为探测
    //   缩进风格（写入格式与用户文件保持一致），内容本身以内存为准。
    let raw = null;
    try { raw = await this.app.vault.read(cf); } catch (_) { raw = null; }
    let data = null;
    let memCanvas = null;
    const mem = this._lmbMemCanvasData(cf);
    if (mem) { data = mem.data; memCanvas = mem.canvas; }
    if (!data) {
      if (!raw) return;
      try { data = JSON.parse(raw); } catch (_) { return; }
    }
    const nodes = data.nodes || [];

    let changed = false;
    let store = this.autoSize.get(cf.path);
    if (!store) { store = new Map(); this.autoSize.set(cf.path, store); }

    // 新拖入的摘录卡统一宽度。canvasPositions 是持久化的“已见节点”账本，因此不会
    // 覆盖用户后来手动调整过的存量卡宽度。
    const lastPosForWidth = this.canvasPositions.get(cf.path) || new Map();
    const excerptWidth = Math.max(320, Math.min(800, Number(this.settings.excerptCardWidth) || 560));
    for (const node of nodes) {
      if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
      if (lastPosForWidth.has(node.id)) continue;
      if (Math.abs((Number(node.width) || 0) - excerptWidth) >= 1) {
        node.width = excerptWidth;
        changed = true;
      }
    }

    /* v0.8.2：新出现的摘录卡自动挂一个「空的补充描述框」。
     *   放在 fitNode 之前，这样尺寸估算会基于「已加框」的文本一次算准，不用二次修正。
     *   判定「新出现」= canvasPositions 档案里没有这个节点 id（插件见过的卡一律不动，
     *   避免把存量卡批量改造）。已有描述的卡也跳过。设置项 noteAutoBoxOnNew 可关。
     *   注意：插件首次扫描某画布时 lastPos 为空 → 所有卡都算「新」→ 会给存量卡也加框，
     *   这是有意为之（用户要的就是「能看到框」）；不想要就在设置里关掉自动。 */
    const attachNote = this.settings.noteAutoBoxOnNew !== false;
    // v0.16.0：默认 false（卡片精简 v2 —— 卡内不再自动出现「💬 添加评论」栏）。
    //   评论能力本身保留，入口 = 悬浮栏「评论」按钮 / 命令面板 / ribbon；存量卡与已写评论不受影响。
    //   用户在设置里手动开回 true 时行为与旧版完全一致。
    const attachComment = this.settings.commentAutoBoxOnNew === true; // v0.11.0：评论栏
    if (attachNote || attachComment) {
      const lastPos0 = this.canvasPositions.get(cf.path) || new Map();
      const fold0 = !!this.settings.noteFoldByDefault;
      for (const node of nodes) {
        if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
        if (lastPos0.has(node.id)) continue;              // 见过的卡 → 不动
        let touched = false;
        // v0.16.6：note 类型白名单随设置走（旧版任意 callout 都会被当成补充描述）
        const noteTypes0 = this.settings.noteCalloutType || "ppd-note";
        if (attachNote && !lmbSplitNote(node.text, noteTypes0).hasNote) {   // 已有描述 → 不动
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
      // v0.16.1：统一写回（setData + requestSave + 同一份内存数据写盘，防覆盖用户拖动）
      await this._lmbWriteCanvasData(cf, data, memCanvas, raw);
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
    // v0.11.1：拆分「尺寸变化」与「位置变化」——fitNode 撑大是尺寸变化（位置没动），
    //   由 lmbRecenterNode 在前面已居中过；这里若再走 lmbPlanAutoLink 会因
    //   lmbSideOf CURRENT（中心偏移）算出相反侧 → 触发 lmbApplyReside 把侧翻转
    //   （用户截图的"下变右"bug 根因）。sizeOnly 让 lmbPlanAutoLink 走 recenter op
    //   保留原侧。user-truly-moved 的 nn 则 sizeOnly=false，照常 detect。
    const sizeOnlyIds = new Set();
    for (const n of nodes) {
      if (n.type === "group") continue;
      const cur = { x: n.x, y: n.y, width: n.width || 0, height: n.height || 0 };
      currentPos.set(n.id, cur);
      const prev = lastPos.get(n.id);
      if (!prev) {
        movedOrNew.push(n);
      } else if (prev.x !== cur.x || prev.y !== cur.y) {
        movedOrNew.push(n);
      } else if (prev.width !== cur.width || prev.height !== cur.height) {
        // 仅尺寸变化——lmbRecenterNode 已经基于原 side 居中过，跳过本循环（防侧翻）
        sizeOnlyIds.add(n.id);
      }
    }
    // 当前画布已经成功解析，可安全清除已不存在节点的尺寸缓存。
    const aliveNodeIds = new Set(nodes.filter((n) => n && n.id).map((n) => n.id));
    for (const id of Array.from(store.keys())) if (!aliveNodeIds.has(id)) store.delete(id);
    this.canvasPositions.set(cf.path, currentPos);
    this.persistAutoSizeSoon(); // 落盘档案（canvasPositions + autoEdges + autoSize 共用防抖）

    // ---- v0.15.0：删除级联（实时检测）----
    //   canvasPositions 只存位置，不存 text；而节点一旦删除，data.nodes 里就没了，
    //   拿不到 text 就无法知道它引用了哪个附件/哪条摘录。所以另存一份**轻量元数据**
    //   （只存附件名 + exId，不存全文，避免内存膨胀），删除时靠它定位清理目标。
    const gone = this._lmbUpdateNodeMeta(cf, nodes);   // 顺带返回本次消失的节点
    if (gone.length && this.settings && this.settings.autoCleanOnDelete === true) {
      // 不 await：清理是异步的，不能拖慢 processCanvas 主流程
      this._lmbCleanupDeletedNodes(cf, gone).catch((err) => {
        console.warn("[lmb] cascade cleanup failed:", err);
      });
    }

    if (movedOrNew.length) {
      // hoisted：所有迭代共用同一个 sidecar 引用，统一在末尾持久化
      const sidecar2 = this.autoEdges.get(cf.path) || new Set();
      // Bulk imports used to scan/copy every node for every new card.  The grid
      // reduces parent candidates to nearby rectangles, while nodeById removes
      // the edges × nodes.find hot path in group reconstruction.
      const nodeByIdForLayout = new Map(nodes.filter((n) => n && n.id).map((n) => [n.id, n]));
      const spatialIndex = lmbBuildSpatialIndex(nodes);
      for (const nn of movedOrNew) {
        // v0.11.1：新卡（drop 下的 ^ex 卡）走 instantAttach 设了位置，
        //   再被 fitNode 撑大——x/y 与 instantAttach 之后一致但 size 已变。
        //   用 sizeOnly 标记，让 lmbPlanAutoLink 保留原侧不翻转。
        // 真正的 user drag（canvas 内移动）会有 lastPos 与当前 x/y 不同，sizeOnly=false 照常 detect。
        const prevForNew = sizeOnlyIds.has(nn.id);
        // 新卡（不在 sizeOnlyIds）lastPos 里没记录：它的「位置变化」是 instantAttach 写入的，
        //   后续 fitNode 改尺寸由 lmbRecenterNode 处理，不属于 user-truly-moved。
        //   标记为 sizeOnly 让 lmbPlanAutoLink 走 recenter 而不是 reside。
        const isNewCard = !lastPos.has(nn.id);
        const sizeOnly = prevForNew || isNewCard;
        const others = spatialIndex.query(nn);
        const hit = lmbPickDropParent(nn, others);
        if (!hit) continue;
        const parent = hit.node;
        if (parent.id === nn.id) continue;

        /* v0.11.0 首连锁定 + 改挂侧（取代 v0.7.3 换父）：
         *   每张卡只自动建一条连线——已有自动父边且父不是本次压中的卡 → skip，
         *   不再自动换父（想换父请手动删线重拖）；压中已连线的卡 → reside 改挂侧；
         *   手动边不参与锁定。副作用：旧版「排布紧密顺带碰到别的卡就换父」的误触发
         *   也被一并消除（这正是锁定规则的收益）。 */
        const plan = lmbPlanAutoLink(nn, parent, data.edges, sidecar2, { sizeOnly });
        if (plan.op === "skip") continue;
        if (plan.op === "recenter") {
          // v0.11.1：尺寸变化触发的 recenter——只整组重排，不动 edge side。
          // ⚠️ 必须从 kidsBySide 过滤掉 nn 自身（lmbGroupBySide 通过 edge 找子卡，会把 nn 也算进来），
          //   否则 group = [nn, nn] → lmbLayoutGroup 当成两卡分组排布，x 算错。
          const kidsBySideRecenter = lmbGroupBySide(parent, nodes, data.edges, nodeByIdForLayout);
          const groupRecenter = [...(kidsBySideRecenter.get(plan.side) || []).filter((k) => k.id !== nn.id), nn];
          lmbLayoutGroup(parent, groupRecenter, plan.side, 30);
          // 顺便把 instantAttach 漏登记的边补进 sidecar（一次性兜底）
          if (!sidecar2.has(plan.edge.id)) sidecar2.add(plan.edge.id);
          changed = true;
          console.log("[lmb] 自动父子（尺寸变化 + recenter v0.11.1）:", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
            "(保留" + plan.side + ")" + (isNewCard ? " [新卡 fitNode]" : ""));
          continue;
        }
        if (plan.op === "reside") {
          const r = lmbApplyReside(parent, nn, plan, nodes, data.edges);
          // 顺便把 instantAttach 漏登记的边补进 sidecar
          if (!sidecar2.has(plan.edge.id)) sidecar2.add(plan.edge.id);
          changed = true;
          console.log("[lmb] 自动父子（改挂侧）:", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
            "(" + plan.oldSide + "→" + r.side + ", 相交" + Math.round(hit.ratio * 100) + "%)");
          continue;
        }

        // 取父卡现有子卡按侧分组；把新卡 nn 加进同侧组，整组贴边对齐+组居中排布（v0.9.3 不再拉伸尺寸）
        // v0.11.1 防御：lmbGroupBySide 会通过任何 edge 把 nn 算进来（理论上 create 路径不会，
        //   但若 instantAttach 已建边 + 文件层兜底未删干净，这里会重复。仍然 filter 一遍）
        const kidsBySide = lmbGroupBySide(parent, nodes, data.edges, nodeByIdForLayout);
        const group = [...(kidsBySide.get(plan.side) || []).filter((k) => k.id !== nn.id), nn];
        lmbLayoutGroup(parent, group, plan.side, 30);
        const ends = lmbSideEnds(plan.side);
        const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        data.edges.push({
          id: eid, fromNode: parent.id, toNode: nn.id,
          fromSide: ends.fromSide, toSide: ends.toSide
        });
        // 标记为自动边（用于后续清理）
        sidecar2.add(eid);
        changed = true;
        console.log("[lmb] 自动父子（首连锁定 v0.11.0）:", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
          "(" + ends.fromSide + "→" + ends.toSide + ", 相交" + Math.round(hit.ratio * 100) + "%, 组" + group.length + ")");
      }

      if (this.settings && this.settings.moveDescendantsWithParent === true) {
        const movements = movedOrNew.filter((n) => lastPos.has(n.id)).map((n) => {
          const prev = lastPos.get(n.id);
          return { id: n.id, dx: n.x - prev.x, dy: n.y - prev.y };
        });
        const count = lmbMoveDescendants(nodes, data.edges, movements);
        if (count) {
          changed = true;
          this.canvasPositions.set(cf.path, new Map(nodes.filter((n) => n && n.type !== "group")
            .map((n) => [n.id, { x: n.x, y: n.y, width: n.width || 0, height: n.height || 0 }])));
          console.log("[lmb] 文件通道子卡联动移动:", count, "张");
        }
      }

      if (changed) {
        // 持续持久化 sidecar 的兜底补登条目（含本次循环内所有 recenter/reside 补的）
        this.autoEdges.set(cf.path, sidecar2);
        // v0.16.1：统一写回（与上方 fit 写入同一条纪律 —— 以内存数据为准，防瞬移）
        await this._lmbWriteCanvasData(cf, data, memCanvas, raw);
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
      // v0.16.6 P1-4：传 note 类型白名单 —— 旧版会把用户自有的 [!warning]/[!quote] 整段删掉
      // Canvas 的 lmb-comment 只是 Markdown 真相备注的显示镜像，绝不能再写回
      // 摘录正文，否则会形成 `[!lmb-comment]` 源码 + lmb-note 备注的双份污染。
      const withoutMirrorComment = lmbSplitComment(node.text).body;
      const srcText = this.settings.noteIntoSync
        ? withoutMirrorComment
        : lmbStripNote(withoutMirrorComment, this.settings.noteCalloutType || "ppd-note");
      const body = lmbUnwrapExcerptCard(srcText)
        .split("\n")
        .filter((l) => !/^\s*\^ex-[0-9a-z]{4,16}\s*$/.test(l))
        // v0.11.3：lmb-view 是卡片上的视图切换按钮（UI 开关），不属于摘录内容，剥掉
        .filter((l) => !LMB_VIEW_CALLOUT_RE.test(l))
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

    // v0.13.4：节点刚挂载时 canvas DOM 未填充，fitNode 走估算（可能偏大）；
    //   延迟 250ms 再 actual 重测一次（详见 _scheduleActualFitRetry）—— 用户反馈
    //   "直接摘录的卡片高度还是太高"，根因是 processCanvas 跑时新节点 nodeEl 还没
    //   填充（canvas reactive 异步渲染），fitNode 走估算 + 写文件，导致估算值被永久化。
    // 只有 DOM 未就绪、曾走估算路径的卡才需要延迟重测。普通移动/手动拉伸不触发全卡扫描。
    if (Array.from(store.values()).some((v) => v && v.pendingActual)) {
      this._scheduleActualFitRetry(cf);
    }
  },

  /**
   * v0.13.4：节点刚挂载时 canvas DOM 未填充，fitNode 走估算（可能偏大），
   *   延迟一次 actual 测量重试，等渲染完成用 DOM 真值修正高度。
   *   setTimeout 250ms：Obsidian canvas reactive 渲染通常在状态变更后 100-200ms 内完成。
   *   每文件独立 timer（防抖），processCanvas 可能连续跑（比如 drop flush + 后续 modify）。
   */
  _scheduleActualFitRetry(cf) {
    try {
      const k = cf.path;
      if (!this._fitRetry) this._fitRetry = {};
      const prev = this._fitRetry[k];
      if (prev && prev.timer) clearTimeout(prev.timer);
      this._fitRetry[k] = { timer: setTimeout(() => {
        try { delete this._fitRetry[k]; } catch (_) {}
        this._actualFitRetryForFile(cf).catch(() => {});
      }, 250) };
    } catch (_) {}
  },

  /**
   * v0.13.4：actual 测量重试 + 写回 canvas json。
   *   为什么不复用 processCanvas：那个流程还要做自动连线/组居中/摘录同步，
   *   这里只要"按 DOM 真值重 fit"，多跑一遍主流程代价大且可能引入 side 翻转。
   */
  async _actualFitRetryForFile(cf) {
    try {
      // v0.16.5 R8：插件已卸载 → 退出（本函数的图片等待重试链没有保留 setTimeout
      //   句柄，无法从 onunload 直接取消，只能靠入口标记兜底）
      if (this._unloaded) return;
      const leaves = this.app.workspace.getLeavesOfType("canvas") || [];
      const leaf = leaves.find((l) => l && l.view && l.view.file && l.view.file.path === cf.path);
      if (!leaf) return;
      const canvas = leaf.view.canvas;
      if (!canvas || !canvas.nodes) return;
      if (this.lmbMarkDualCards) this.lmbMarkDualCards(canvas);
      // v0.16.3【图片等待重试链】：卡内有 img 未加载完时，lmbFitNodeActual 会返回 null
      //   （v0.16.3 起）→ fitNode 回退估算 → 估算值被写进档案。若没有这轮补测，图片加载
      //   完成后就**没人再量一次**，偏小的估算值被固化 —— 「自动高度依旧偏小」的主根因。
      //   递增间隔追加最多 3 轮（800ms / 1600ms / 2400ms），测到真值那轮写回后自然收敛；
      //   计数表独立于 _fitRetry（那是 250ms 主调度的防抖位，语义不同）。
      try {
        let pendingImg = false;
        const entries = (typeof canvas.nodes.entries === "function")
          ? Array.from(canvas.nodes.entries())
          : Object.entries(canvas.nodes);
        for (const [, n] of entries) {
          const el = n && (n.nodeEl || n.contentEl);
          const imgs = el && el.querySelectorAll ? el.querySelectorAll("img") : null;
          if (!imgs) continue;
          for (let i = 0; i < imgs.length; i++) {
            if (!imgs[i].complete && (!imgs[i].getClientRects || imgs[i].getClientRects().length)) { pendingImg = true; break; }
          }
          if (pendingImg) break;
        }
        if (pendingImg) {
          if (!this._fitRetryImg) this._fitRetryImg = {};
          const k = cf.path;
          const cnt = (this._fitRetryImg[k] || 0) + 1;
          if (cnt <= 6) {
            this._fitRetryImg[k] = cnt;
            setTimeout(() => {
              try { this._actualFitRetryForFile(cf).catch(() => {}); } catch (_) {}
            }, Math.min(2400, 500 * cnt));
            return;                       // 本轮不测（测了也是偏小值）
          }
          try { delete this._fitRetryImg[k]; } catch (_) {}   // 放弃：按现状测
        } else {
          if (this._fitRetryImg) { try { delete this._fitRetryImg[cf.path]; } catch (_) {} }
        }
      } catch (_) { /* 重试链自身异常不阻断本轮测量 */ }
      const store = this.autoSize ? this.autoSize.get(cf.path) : null;
      if (!store) return;
      // v0.13.6：优先 canvas 内部 API（getData / setData / requestSave），毫秒级生效。
      //   磁盘写最终也会让 canvas view reload（Obsidian 原生监听），但改 live node 后
      //   不调 requestSave 的话 canvas 内部 state 不刷新 —— 用户看到"没反应"。
      const canInternal = typeof canvas.getData === "function"
        && typeof canvas.setData === "function"
        && typeof canvas.requestSave === "function";
      let data = null;
      if (canInternal) { try { data = canvas.getData(); } catch (_) { data = null; } }
      if (!data) {
        let raw; try { raw = await this.app.vault.read(cf); } catch (_) { return; }
        try { data = JSON.parse(raw); } catch (_) { return; }
      }
      if (!data || !Array.isArray(data.nodes)) return;
      const sizeUpdates = new Map();
      let unresolvedActual = false;
      for (const n of data.nodes) {
        if (n.type !== "text" || !n.text || !EX_ID_RE.test(n.text)) continue;
        const cached = store.get(n.id);
        const textHash = this.simpleHash(n.text);
        const outerWidth = Number(n.width) || 0;
        if (cached && cached.naturalHeightVersion === 3 && cached.hash === textHash && !cached.pendingActual
          && (outerWidth <= 0 || Math.abs((Number(cached.w) || 0) - outerWidth) < 2)) continue;
        const live = canvas.nodes.get ? canvas.nodes.get(n.id) : canvas.nodes[n.id];
        if (!live) { unresolvedActual = true; continue; }
        // v0.13.5：actual 可能拿不到（markdown 异步渲染还没 layout）—— 200ms 后多试一次
        //   仍拿不到就用 estimate（保证至少有值可写，否则 retry 永远静默失败）
        let actual = this.lmbFitNodeActual(live, store);
        if (!actual) {
          await new Promise((r) => setTimeout(r, 200));
          actual = this.lmbFitNodeActual(live, store);
        }
        if (!actual) unresolvedActual = true;
        if (actual && !actual.unchanged) {
          sizeUpdates.set(n.id, { width: Math.round(actual.w), height: Math.round(actual.h) });
        }
      }
      if (sizeUpdates.size) {
        let done = false;
        if (canInternal) {
          try {
            // 测量期间用户可能移动卡片；提交前重读最新状态，只合并宽高。
            const fresh = canvas.getData();
            if (fresh && Array.isArray(fresh.nodes)) {
              for (const n of fresh.nodes) {
                const next = sizeUpdates.get(n.id);
                if (!next) continue;
                n.width = next.width;
                n.height = next.height;
              }
              this.selfWritten.set(cf.path, Date.now());
              canvas.setData(fresh);
              canvas.requestSave();
              done = true;
            }
          } catch (_) { /* 回退文件写 */ }
        }
        if (!done) {
          let raw; try { raw = await this.app.vault.read(cf); } catch (_) { return; }
          let fresh; try { fresh = JSON.parse(raw); } catch (_) { return; }
          if (!fresh || !Array.isArray(fresh.nodes)) return;
          for (const n of fresh.nodes) {
            const next = sizeUpdates.get(n.id);
            if (!next) continue;
            n.width = next.width;
            n.height = next.height;
          }
          const indent = /\n\t"/.test(raw) ? "\t" : "  ";
          this.selfWritten.set(cf.path, Date.now()); // v0.16.4 P2-4：存时间戳（过期不吞真实 modify）
          await this.app.vault.adapter.write(cf.path, JSON.stringify(fresh, null, indent));
        }
        this.persistAutoSizeSoon();
      }
      // iPad 的 Markdown/图片布局可能晚于首轮 250+200ms。只要仍有待实测卡，继续
      // 低频重试，成功后 pendingActual 会被清掉并自然停止，不再出现“时好时坏”。
      if (unresolvedActual && !this._unloaded) {
        if (!this._fitRetryActual) this._fitRetryActual = {};
        const key = cf.path;
        const count = (this._fitRetryActual[key] || 0) + 1;
        if (count <= 6) {
          this._fitRetryActual[key] = count;
          setTimeout(() => {
            try { this._actualFitRetryForFile(cf).catch(() => {}); } catch (_) {}
          }, Math.min(2400, 400 * count));
        } else delete this._fitRetryActual[key];
      } else if (this._fitRetryActual) {
        delete this._fitRetryActual[cf.path];
      }
    } catch (_) {}
  },

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
  async normalizeOverlappingExcerpts(targetFile, opts) {
    // v0.16.5 修复 R1：opts.healOnly = true 时只「重排已有父子关系且当前仍重叠」的组，
    //   **不新建任何边** —— 自动自愈不该替用户决定父子关系。
    //   命令路径沿用 v0.6.0 的重叠建边语义，但加两道约束：
    //     ① 已有自动父边的卡跳过 —— 不许绕过 v0.11.0「首连锁定（一卡一线）」；
    //     ② 新建的边必须登记进 sidecar（autoEdges）—— 否则会出现「recenter 认它
    //        （e<base36> 命名兜底）但清理按 sidecar 过滤不认它」的账本矛盾 → 孤儿边残留。
    const healOnly = !!(opts && opts.healOnly);
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
        // v0.16.1：数据源与 processCanvas 同纪律 —— 内存优先（防覆盖用户未落盘的拖动）
        let raw = null;
        try { raw = await this.app.vault.read(cf); } catch (_) { raw = null; }
        let data = null;
        let memCanvas = null;
        const mem = this._lmbMemCanvasData(cf);
        if (mem) { data = mem.data; memCanvas = mem.canvas; }
        if (!data) {
          if (!raw) continue;
          try { data = JSON.parse(raw); } catch (_) { continue; }
        }
        const nodes = data.nodes || [];
        if (!Array.isArray(data.edges)) data.edges = [];
        let sidecarDirty = false;   // v0.16.5 R1：是否有新建边需要写回 sidecar 账本

        const ex = nodes.filter((n) => n.type === "text" && n.text && EX_ID_RE.test(n.text));
        const sidecarN = this.autoEdges.get(cf.path) || new Set();
        // 每张 ^ex 卡：选相交面积最大的另一张 ^ex 作父；阈值与 processCanvas 一致
        const parentOfCard = new Map(); // childId -> parentId
        if (healOnly) {
          // v0.16.5 R1：自愈模式 —— 只用「现有边 + 当前仍重叠」的父子对，不新建关系。
          //   边的方向可能是 child→parent（用户手连），两端都试，以带 ^ex 的那端为子。
          for (const ed of data.edges) {
            if (!ed || !ed.fromNode || !ed.toNode || ed.fromNode === ed.toNode) continue;
            let p = nodes.find((n) => n.id === ed.fromNode);
            let c = nodes.find((n) => n.id === ed.toNode);
            const isEx = (n) => n && n.type === "text" && n.text && EX_ID_RE.test(n.text);
            if (!isEx(c)) { const t = p; p = c; c = t; }
            if (!isEx(c) || !p || p.type === "group") continue;
            if (!lmbPickDropParent(c, [p], 0.2)) continue;      // 不重叠 → 无需自愈
            if (!parentOfCard.has(c.id)) parentOfCard.set(c.id, p.id);
          }
        } else {
          for (const nn of ex) {
            // ① 已有自动父边 → 跳过（首连锁定：想换父请手动删线重拖）
            if (lmbAutoParentEdgeOf(nn.id, data.edges, sidecarN)) continue;
            const others = ex.filter((o) => o.id !== nn.id);
            const hit = lmbPickDropParent(nn, others, 0.2);
            if (hit) parentOfCard.set(nn.id, hit.node.id);
          }
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
              const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
              data.edges.push({
                id: eid, fromNode: g.parent.id, toNode: k.id,
                fromSide: ends.fromSide, toSide: ends.toSide
              });
              // ② 新建的边登记进 sidecar（自动边账本）—— 自愈模式不建边，故不受影响
              if (!sidecarN.has(eid)) { sidecarN.add(eid); sidecarDirty = true; }
              totalEdges++;
            }
          }
          changed = true;
        }
        if (sidecarDirty) this.autoEdges.set(cf.path, sidecarN);

        if (changed) {
          // v0.16.1：统一写回（setData + requestSave + 同一份数据写盘，防瞬移）
          await this._lmbWriteCanvasData(cf, data, memCanvas, raw);
          console.log("[lmb] 规范化画布:", cf.path,
            "组数=" + groups.size + " 移动=" + groups.size + "组 新边=" + totalEdges);
        }
      } catch (err) {
        console.error("[lmb] normalize failed for", cf.path, err);
      }
    }
    new Notice(`已规范化：新建 ${totalEdges} 条边，整组移动 ${totalMoves} 张卡（${targets.length} 个画布）`);
  },

  /**
   * v0.13.3：自动适配卡片尺寸到内容高度。
   *   优先用**实际 DOM 测量**（lmbFitNodeActual）—— canvas 节点已渲染时这是真相。
   *   节点未渲染（首次扫描 / 节点在视口外）回退到 estimateSizeFor 的估算。
   *   返回 null 表示不需要变（hash 没变或尺寸差 < 2px）。
   */
  fitNode(node, store) {
    // v0.14.8：手动 fit 过的卡片「锁定」，自动 fit 不再覆盖（避免子节点 fit 后被 processCanvas
    //   的 estimateSizeFor 误差覆盖回错的尺寸 —— 用户反馈「子节点调整高度失效」）。
    const prev0 = store.get(node.id);
    const hash = this.simpleHash(node.text);
    // 文本没变说明这次 modify 只是移动、连线或手动调尺寸；绝不能再次测量高度。
    const currentWidth = Number(node.width) || 0;
    const oldMeasurement = prev0 && prev0.naturalHeightVersion !== 3;
    if (oldMeasurement && !prev0.pendingActual) {
      store.set(node.id, Object.assign({}, prev0, { pendingActual: true }));
      this.persistAutoSizeSoon();
    }
    if (!oldMeasurement && prev0 && prev0.hash === hash && !prev0.pendingActual
      && (currentWidth <= 0 || Math.abs((Number(prev0.w) || 0) - currentWidth) < 2)) return null;
    const actual = this.lmbFitNodeActual(node, store);
    if (actual) return actual.unchanged ? null : { w: actual.w, h: actual.h };
    // Old (including locked) measurements are rechecked only once DOM is ready;
    // keep the saved geometry until then instead of replacing it with an estimate.
    if (oldMeasurement) return null;
    // 估算回退（节点未渲染或 DOM 拿不到）
    const prev = store.get(node.id);
    if (prev && prev.hash === hash) return null;
    const size = this.estimateSizeFor(node.text, { width: currentWidth });
    size.w = currentWidth > 0 ? currentWidth : Math.max(320, Math.min(800,
      Number(this.settings && this.settings.excerptCardWidth) || 560));
    // DOM/图片尚未就绪时只估算一次，并明确标记供延迟重测定点处理。
    store.set(node.id, { hash, w: size.w, h: size.h, pendingActual: true });
    this.persistAutoSizeSoon();
    if (prev && Math.abs(prev.w - size.w) < 2 && Math.abs(prev.h - size.h) < 2) return null;
    return size;
  },

  /**
   * v0.13.3：实际测量 canvas 节点**已渲染**的内容高度，设回 node.height。
   *   比 estimateSizeFor 精确 —— DOM 是真相。前提：节点已渲染（nodeEl / contentEl
   *   可查）。否则返回 null 让调用者回退估算。
   *   scrollHeight 是内容刚好需要的最小高度（包含 contentEl 自身 padding，**不含**
   *   margin，也不含 contentEl 之外的节点 padding）。
   *
   *   v0.16.3【自动路径与手动路径对齐】：此前这里还是 `scrollHeight + 24` 老逻辑，
   *   而 v0.16.1/v0.16.2 的三项增强全改在了手动路径（lmbFitNodeById）—— 自动 fit
   *   （新卡拖入 / processCanvas / 250ms 重测）走的就是本函数，结果：
   *     ① 节点 chrome 靠 +24 经验值 → 评论 callout 余量不足 → 裁底；
   *     ② **没有图片等待** —— 自动 fit 几乎总发生在卡片刚创建、webp 还没加载完时，
   *        scrollHeight 偏小 → 高度偏小**且被写进档案**（hash 没变就不再重测），
   *        偏小值被固化 —— 这就是「自动高度调整依旧小于实际所需」的主根因。
   *   修法（本函数是同步的，不能 await 图片）：
   *     - h = scrollHeight + chromePad(nodeEl 上下 padding+border 实测) + buffer(28/8)
   *     - **卡内有 img 未加载完 → 返回 null**（调用方 fitNode 回退估算），配合
   *       _actualFitRetryForFile 的图片等待重试链（v0.16.3）在加载完后测出真值写回。
   *   用途：自动 fit / 250ms 重测 / 评论区保存后刷新。
   */
  lmbFitNodeActual(node, store) {
    try {
      if (!node) return null;
      const wrapperEl = node.nodeEl || node.contentEl;
      if (!wrapperEl || typeof wrapperEl.querySelector !== "function") return null;
      const contentEl = wrapperEl.querySelector(".canvas-node-content")
        || wrapperEl.querySelector(".markdown-rendered")
        || wrapperEl;
      if (!contentEl || typeof contentEl.scrollHeight !== "number") return null;
      // scrollHeight === 0：元素不可见（display:none / 刚挂载未布局）
      if (contentEl.scrollHeight <= 0) return null;
      // v0.16.3：卡内有图片未加载完 → 高度必然偏小，宁可用估算+重试链，不固化错值
      try {
        const imgs = contentEl.querySelectorAll("img");
        for (let i = 0; i < imgs.length; i++) {
          if (!imgs[i].complete && (!imgs[i].getClientRects || imgs[i].getClientRects().length)) return null;
        }
      } catch (_) { /* 查不了就照旧测（最坏情况回到旧行为） */ }
      // v0.16.3：节点 chrome 精确测量（上下 padding + border），不再用 +24 经验值。
      //   buffer 与手动路径同源：有评论 28（末尾 callout 的 padding+border+余量）、无 8。
      let chromePad = 0;
      try {
        const ncs = getComputedStyle(wrapperEl);
        if (ncs) {
          chromePad = (parseFloat(ncs.paddingTop) || 0) + (parseFloat(ncs.borderTopWidth) || 0)
            + (parseFloat(ncs.paddingBottom) || 0) + (parseFloat(ncs.borderBottomWidth) || 0);
        }
      } catch (_) { chromePad = 0; }
      const hasComment = (function () {
        try {
          const t = node && node.text;
          if (typeof t !== "string" || !LMB_COMMENT_CALLOUT_RE) return false;
          return t.split(/\r?\n/).some((line) => LMB_COMMENT_CALLOUT_RE.test(line));
        } catch (_) { return false; }
      })();
      // 缓存和写回都使用 Canvas JSON 的外框宽度。clientWidth 是内部宽度，若把它写回
      // node.width 会让卡片每次 fit 变窄、文本重新换行，随后高度自然又变了。
      const w = Math.max(80, Number(node.width) || Number(wrapperEl.offsetWidth)
        || Number(contentEl.offsetWidth) || 280);
      let measureScale = 1;
      try {
        const rr = contentEl.getBoundingClientRect();
        const layoutW = contentEl.offsetWidth || contentEl.clientWidth;
        if (rr && rr.width > 0 && layoutW > 0) measureScale = rr.width / layoutW;
      } catch (_) {}
      const naturalCardH = lmbMeasureNaturalCard(wrapperEl, contentEl, measureScale);
      const contentH = naturalCardH > 0
        ? naturalCardH
        : lmbMeasureRenderedContent(contentEl, measureScale);
      if (contentH <= 0) return null;
      // 无 DOM 克隆能力（测试桩或旧环境）才回退叶节点算法和旧安全余量。
      const h = naturalCardH > 0
        ? naturalCardH
        : lmbFinalizeCardHeight(contentH, chromePad, hasComment, false);
      const prev = store && store.get(node.id);
      const hash = this.simpleHash(node.text);
      if (prev && prev.hash === hash
        && Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2) {
        // pendingActual 是一次性任务；实际尺寸已稳定时必须清除，否则每次 modify 都会重试。
        if ((prev.pendingActual || prev.naturalHeightVersion !== 3) && store) {
          store.set(node.id, { hash, w, h, locked: !!prev.locked, naturalHeightVersion: 3 });
          this.persistAutoSizeSoon();
        }
        return { w, h, unchanged: true };
      }
      if (store) {
        store.set(node.id, { hash, w, h, locked: !!(prev && prev.locked), naturalHeightVersion: 3 });
        this.persistAutoSizeSoon();
      }
      return { w, h };
    } catch (_) { return null; }
  },

  /** 图片卡：按截图真实宽高比；文本卡：按行宽/行数估算；v0.11.3 双重卡：取文字/图片布局的较大高 */
  estimateSizeFor(text, opts) {
    opts = opts || {};
    const em = text.match(/!\[\[([^\]|]+?)\]\]/);   // em[1] = 完整附件名（含 .webp）
    if (em) {
      const dims = this.imgDims.get(em[1]);
      const requestedWidth = Number(opts.width) || 0;
      const w = requestedWidth > 0 ? Math.max(80, requestedWidth)
        : Math.max(320, Math.min(800, Number(this.settings && this.settings.excerptCardWidth) || 560));
      // v0.11.3 双重卡判定：卡里同时有 embed 和 PDF 引用块行（文字+截图并存，
      //   靠 lmb-view 切换视图）。两种视图共用同一张卡 → 高取两者较大值，
      //   宽度固定不随切换变化（用户要求：切换内容显示方式时固定卡片宽度）。
      const hasQuote = LMB_LINK_RE.test(text);
      LMB_LINK_RE.lastIndex = 0; // 全局正则复用后必须重置（否则下一次 test 从旧 lastIndex 开始漏匹配）
      if (hasQuote) {
        const imgH = (dims && dims.w > 0)
          ? Math.round(w * dims.h / dims.w) + 78   // 图片高（等比）+ 回跳引用行 + 内边距
          : 460;                                    // 尺寸档案缺失时的兜底
        // v0.16.6：note 类型白名单随设置走（estimateSizeFor 里的两处调用同源）
        const nt = (this.settings && this.settings.noteCalloutType) || "ppd-note";
        const textH = this.estimateTextSize(lmbRenderedText(text, nt), w).h;
        // 同一时刻只显示一种视图，不能再取二者最大值，否则短文字视图会永久
        // 保留图片高度。未指定时按默认文字视图估算。
        const visibleH = opts.view === "image" ? imgH : textH;
        return this.addCommentChrome(this.addNoteChrome({ w, h: visibleH }, text), text);
      }
      if (dims && dims.w > 0) {
        // 图片高（按卡片宽等比）+ 回跳引用行（约 2 行）+ 内边距
        const imgH = Math.round(w * dims.h / dims.w);
        return this.addNoteChrome({ w, h: imgH + 78 }, text);
      }
      return this.addNoteChrome({ w, h: 460 }, text);
    }
    // v0.13.3：lmbRenderedText 现在真正剥离 callout，纯文字行高度更准；
    //   addNoteChrome 加 ppd-note 高度，新增 addCommentChrome 加 lmb-comment 展开态高度
    return this.addCommentChrome(
      this.addNoteChrome(
        this.estimateTextSize(lmbRenderedText(text, (this.settings && this.settings.noteCalloutType) || "ppd-note"), opts.width),
        text
      ),
      text
    );
  },

  /**
   * v0.8.0：给尺寸补上 callout（补充描述框）的额外高度。
   *   callout 渲染出来会有背景框 + 标题行 + 上下内边距，这部分不在纯文本行高里。
   *   估约 46px（标题行 25 + 上下 padding 约 21），近似值，够用。
   */
  addNoteChrome(size, text) {
    // v0.16.6：只认插件自有的 note 类型（用户自有 callout 不该被算成补充描述高度）
    const types = (this.settings && this.settings.noteCalloutType) || "ppd-note";
    if (!lmbSplitNote(text, types).hasNote) return size;
    return { w: size.w, h: Math.ceil(Math.min(2000, size.h + 46)) };
  },
  /**
   * v0.13.3：给尺寸补上 lmb-comment callout 的额外高度。
   *   - 折叠态（标题行 + 单行「添加评论」）：约 30px（标题 25 + 上下 padding + 边框）
   *   - 展开态：v0.16.1 改为**按评论内容行数**算 —— 旧版固定 +50 是 Bug1 的主根因：
   *     estimateTextSize 的输入 lmbRenderedText 已把评论内容剥掉，内容行全靠这里补，
   *     而展开态评论一超过一行（50 - 标题25 - padding ≈ 只够 0 行内容！）就必然
   *     把卡片算矮 → 自动 fit 后评论底部被裁（用户实测「有评论的卡片自动高度
   *     裁掉评论底部」）。修法：标题 25 + 内容行数×25 + callout 自身 padding/边框 24。
   *     多行评论按行数线性增长，与实际渲染趋势一致。
   */
  addCommentChrome(size, text) {
    if (!lmbSplitComment(text).hasComment) return size;
    const c = lmbSplitComment(text);
    if (!c.comment || c.fold) {
      // 折叠态 / 空占位：单行按钮，30 不变
      return { w: size.w, h: Math.ceil(Math.min(2000, size.h + 30)) };
    }
    const lines = Math.max(1, String(c.comment).split("\n").length);
    const extra = 25 + lines * 25 + 24;   // 标题行 + 内容行 + callout padding/边框
    return { w: size.w, h: Math.ceil(Math.min(2000, size.h + extra)) };
  },

  estimateTextSize(text, widthOverride) {
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
    const forced = Number(widthOverride) || 0;
    const w = forced > 0 ? Math.max(80, forced)
      : Math.ceil(Math.min(560, Math.max(260, natural + padX)));
    const innerW = Math.max(80, w - padX - quoteIndent);
    let h = padY;
    for (const l of lines) {
      h += Math.max(1, Math.ceil(l.w / innerW)) * lineH + (l.quote ? 4 : 0);
    }
    return { w, h: Math.ceil(Math.min(2000, Math.max(80, h))) };
  },

  simpleHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return String(h);
  },

  persistAutoSizeSoon() {
    this._lmbRuntimeStateDirty = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.saveSettings().catch(() => {});
    }, 2000);
  },

});

/* 33-plugin-note-comment —— 补充描述 + 独立评论（命令/点击编辑/批量）（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

  /** Unified color source: every surface reads the same per-excerpt setting. */
  lmbChooseExcerptColor(exId, anchorEl) {
    if (!exId) return;
    document.querySelectorAll(".lmb-color-palette").forEach((el) => el.remove());
    const palette = document.createElement("div");
    palette.className = "lmb-color-palette";
    const colors = [
      ["红", "#e85d5d"], ["橙", "#ec9338"], ["黄", "#d9b72c"], ["绿", "#65c692"],
      ["蓝", "#5794e8"], ["靛", "#6e78d9"], ["紫", "#ae70d3"]
    ];
    const apply = async (hex) => {
      this.settings.excerptColors = this.settings.excerptColors || {};
      this.settings.excerptColors[exId] = hex;
      await this.saveSettings(); palette.remove();
      this.lmbRefreshAllMarks(); this.lmbSchedulePdfSidebarRefresh(0);
      document.querySelectorAll('.lmb-excerpt-id[data-lmb-ex="' + exId + '"]').forEach((marker) => this.lmbApplyExcerptColorDom(marker.closest('.callout')));
    };
    for (const [name, hex] of colors) {
      const b = document.createElement("button"); b.type = "button"; b.title = name; b.setAttribute("aria-label", name);
      b.style.background = hex; b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); apply(hex); };
      palette.appendChild(b);
    }
    document.body.appendChild(palette);
    const r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    const pr = palette.getBoundingClientRect();
    const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    let left = r ? r.right + 6 : (vw - pr.width) / 2;
    // 右侧放不下时改放锚点左侧；仍放不下才钳制，避免 iPad 侧栏里的色板飞出屏幕。
    if (left + pr.width > vw - 8 && r) left = r.left - pr.width - 6;
    left = Math.max(8, Math.min(vw - pr.width - 8, left));
    const top = Math.max(8, Math.min(vh - pr.height - 8, r ? r.top - 2 : (vh - pr.height) / 2));
    palette.style.left = Math.round(left) + "px";
    palette.style.top = Math.round(top) + "px";
    setTimeout(() => document.addEventListener("pointerdown", function close(ev) {
      if (!palette.contains(ev.target) && ev.target !== anchorEl) { palette.remove(); document.removeEventListener("pointerdown", close, true); }
    }, true), 0);
  },

  lmbApplyExcerptColorDom(card) {
    try {
      if (!card || !card.querySelector) return;
      const marker = card.querySelector('.lmb-excerpt-id[data-lmb-ex]');
      const exId = marker && marker.getAttribute("data-lmb-ex");
      const hex = exId && this.settings && this.settings.excerptColors && this.settings.excerptColors[exId];
      if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return;
      const n = hex.slice(1); card.style.setProperty("--callout-color", parseInt(n.slice(0,2),16) + "," + parseInt(n.slice(2,4),16) + "," + parseInt(n.slice(4,6),16));
    } catch (_) {}
  },

  _lmbKeepCardWidth(node) {
    return Math.max(80, Number(node && node.width)
      || Math.max(320, Math.min(800, Number(this.settings && this.settings.excerptCardWidth) || 560)));
  },

  async _lmbAutoFitCard(file, nodeId, fallbackNode, fitOpts) {
    if (!(fitOpts && fitOpts.skipDelay)) await new Promise((resolve) => setTimeout(resolve, 80));
    let live = null;
    try {
      const leaf = (this.app.workspace.getLeavesOfType("canvas") || [])
        .find((l) => l && l.view && l.view.file && file && l.view.file.path === file.path);
      const canvas = leaf && leaf.view && leaf.view.canvas;
      live = canvas && canvas.nodes
        ? (typeof canvas.nodes.get === "function" ? canvas.nodes.get(nodeId) : canvas.nodes[nodeId]) : null;
    } catch (_) {}
    const key = file && file.path ? file.path + "::" + nodeId : "";
    const ex = String((live || fallbackNode) && (live || fallbackNode).text || "").match(EX_ID_RE);
    const exId = ex ? ex[0].slice(1) : "";
    const savedView = (exId && this.settings && this.settings.excerptViews
      && this.settings.excerptViews[exId])
      || (key && this.settings && this.settings.nodeViews ? this.settings.nodeViews[key] : null);
    return this.lmbFitNodeById(file, nodeId, live || fallbackNode,
      Object.assign({ quiet: true, allowViewShrink: true, view: savedView || "text" }, fitOpts || {}));
  },

  _lmbExcerptNoteState(raw, exId) {
    const lines = String(raw || "").split(/\r?\n/);
    const anchor = lines.findIndex((line) => line.includes("^" + exId));
    if (anchor < 0) return null;
    let begin = -1, end = -1;
    for (let i = anchor - 1; i >= 0; i--) {
      if (lines[i].includes("LMB-NOTE:END")) { end = i; continue; }
      if (lines[i].includes("LMB-NOTE:BEGIN")) { begin = i; break; }
      if (/\[!lmb-excerpt\]/i.test(lines[i])) break;
    }
    let value = "";
    if (begin >= 0 && end > begin) {
      value = lines.slice(begin + 1, end)
        .filter((line) => !/\[!lmb-note\]/i.test(line))
        .map((line) => line.replace(/^\s*(?:>\s*){2}/, "")).join("\n").trim();
    }
    return { lines, anchor, begin, end, value };
  },

  /** Parse every excerpt note in one linear pass for list/index rendering. */
  _lmbBuildExcerptNoteMap(raw) {
    const result = new Map(), lines = String(raw || "").split(/\r?\n/);
    let pending = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("LMB-NOTE:BEGIN")) {
        const body = [];
        for (i = i + 1; i < lines.length && !lines[i].includes("LMB-NOTE:END"); i++) {
          if (!/\[!lmb-note\]/i.test(lines[i])) body.push(lines[i].replace(/^\s*(?:>\s*){2}/, ""));
        }
        pending = body.join("\n").trim();
        continue;
      }
      const anchor = lines[i].match(/\^(ex-[0-9a-z]{4,16})/i);
      if (anchor) { result.set(anchor[1], pending); pending = ""; }
      else if (/\[!lmb-excerpt\]/i.test(lines[i])) pending = "";
    }
    return result;
  },

  async lmbSaveExcerptNote(file, exId, value) {
    if (!(file instanceof TFile) || !exId) return false;
    let changed = false;
    await this.app.vault.process(file, (raw) => {
      const state = this._lmbExcerptNoteState(raw, exId);
      if (!state) return raw;
      const anchorLine = state.lines[state.anchor];
      const prefix = (anchorLine.match(/^(\s*(?:>\s*)*)\^/) || ["", "> "])[1] || "> ";
      const note = [];
      if (String(value || "").trim()) {
        // 摘录本身已经是一层引用块；内部的 note callout 必须再嵌套一层 `> `。
        // 少这一层时 Obsidian 会把 `[!lmb-note]` 当普通文本显示。
        // Callout 标题必须是区块第一行；隐藏标记放在标题之后，否则部分 Obsidian
        // 版本会把 `[!lmb-note]` 当作普通文字。
        note.push(prefix + "> [!lmb-note]", prefix + "> <!-- LMB-NOTE:BEGIN -->");
        for (const line of String(value).replace(/\r\n/g, "\n").split("\n")) note.push(prefix + "> " + line);
        note.push(prefix + "> <!-- LMB-NOTE:END -->");
      }
      const from = state.begin >= 0
        ? (state.begin > 0 && /\[!lmb-note\]/i.test(state.lines[state.begin - 1]) ? state.begin - 1 : state.begin)
        : state.anchor;
      const to = state.end >= 0 ? state.end + 1 : state.anchor;
      state.lines.splice(from, to - from, ...note);
      changed = true; return state.lines.join("\n");
    });
    return changed;
  },

  async lmbEnhanceExcerptCallouts(el, ctx) {
    const cards = [];
    if (el.matches && el.matches('.callout[data-callout="lmb-excerpt"]')) cards.push(el);
    if (el.querySelectorAll) cards.push(...el.querySelectorAll('.callout[data-callout="lmb-excerpt"]'));
    for (const card of cards) {
      if (card.querySelector(".lmb-excerpt-note-action")) continue;
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath || "");
      if (!(file instanceof TFile)) continue;
      // 新卡直接带稳定 ID；存量卡则从 postprocessor 的区块信息兼容识别。
      // getSectionInfo(card) 在部分 Live Preview 版本会返回 null，因此也检查宿主 el。
      const marker = card.querySelector(".lmb-excerpt-id[data-lmb-ex]");
      let exId = marker && marker.getAttribute("data-lmb-ex");
      let raw = "";
      if (!exId && ctx.getSectionInfo) {
        for (const target of [card, el, card.parentElement]) {
          if (!target) continue;
          const info = ctx.getSectionInfo(target);
          if (info && info.text) { raw = String(info.text); const ex = EX_ID_RE.exec(raw); if (ex) { exId = ex[0].slice(1); break; } }
        }
      }
      if (!exId) continue;
      this.lmbApplyExcerptColorDom(card);
      if (!raw) raw = await this.app.vault.cachedRead(file);
      const state = this._lmbExcerptNoteState(raw, exId);
      const content = card.querySelector(":scope > .callout-content") || card;

      // 不同 Obsidian 版本对嵌套自定义 Callout 的解析略有差异。若它被降级成
      // 普通 blockquote，移除错误的 DOM，并用 MarkdownRenderer 提供稳定兜底。
      for (const nativeNote of Array.from(content.querySelectorAll('.callout[data-callout="lmb-note"]'))) nativeNote.remove();
      for (const quote of Array.from(content.querySelectorAll("blockquote"))) {
        if (/^\s*\[!lmb-note\]/i.test(quote.textContent || "")) quote.remove();
      }
      // 隐藏 span、被移除的嵌套 callout 以及空 Markdown 行可能留下有 margin 的空 p/
      // blockquote。它们没有可见内容，却正是卡片顶部和区块之间大段留白的来源。
      for (const child of Array.from(content.children)) {
        if (child.classList && child.classList.contains("lmb-excerpt-note-live")) continue;
        const hasVisibleMedia = !!child.querySelector("img,video,audio,canvas,svg,.callout");
        const visibleText = String(child.textContent || "").trim();
        const markerOnly = !!child.querySelector(".lmb-excerpt-id") && !visibleText;
        if (markerOnly || (!visibleText && !hasVisibleMedia)) child.remove();
      }
      if (state && state.value) {
        const live = content.createDiv({ cls: "lmb-excerpt-note-live" });
        const body = live.createDiv({ cls: "lmb-excerpt-note-live-body markdown-rendered" });
        try { await MarkdownRenderer.render(this.app, state.value, body, file.path, this); }
        catch (_) { body.setText(state.value); }
      }

      // Markdown 双重摘录：默认显示文字，可在同一卡片中切换为截图。
      const image = Array.from(content.querySelectorAll("img"))
        .find((img) => !img.closest(".lmb-excerpt-note-live"));
      const textQuote = Array.from(content.querySelectorAll("blockquote"))
        .find((quote) => !quote.closest(".lmb-excerpt-note-live"));
      let imageView = image && (image.closest("p") || image.closest(".internal-embed") || image.parentElement);
      const isDual = !!(imageView && textQuote);
      if (isDual) {
        card.addClass("lmb-md-dual-excerpt");
        textQuote.addClass("lmb-excerpt-text-view");
        imageView.addClass("lmb-excerpt-image-view");
        card.toggleClass("lmb-show-image", !!(this.settings.excerptViews
          && this.settings.excerptViews[exId] === "image"));
      }
      const action = card.createDiv({ cls: "lmb-excerpt-note-action" });
      const colorBtn = action.createEl("button", { text: "● 颜色", cls: "lmb-excerpt-color-action" });
      colorBtn.onclick = () => this.lmbChooseExcerptColor(exId, colorBtn);
      if (isDual) {
        const showingImage = card.hasClass("lmb-show-image");
        const viewBtn = action.createEl("button", {
          text: showingImage ? "¶ 显示文字" : "▧ 显示图片", cls: "lmb-excerpt-view-toggle"
        });
        viewBtn.onclick = () => {
          const showImage = !card.hasClass("lmb-show-image");
          card.toggleClass("lmb-show-image", showImage);
          viewBtn.setText(showImage ? "¶ 显示文字" : "▧ 显示图片");
          this.settings.excerptViews = this.settings.excerptViews || {};
          this.settings.excerptViews[exId] = showImage ? "image" : "text";
          this.saveSettings().catch(() => {});
        };
      }
      const btn = action.createEl("button", { text: state && state.value ? "✎ 编辑备注" : "＋ 追加备注" });
      btn.onclick = () => new LMBExcerptNoteModal(this.app, {
        title: "PDF 摘录备注", value: state ? state.value : "", sourcePath: file.path,
        onSubmit: async (value) => {
          const ok = await this.lmbSaveExcerptNote(file, exId, value);
          new Notice(ok ? "摘录笔记已保存" : "未找到对应摘录，未修改文档");
        }
      }).open();
    }
  },

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
    // v0.16.4 修复 P1-3：读改写迁移到内存优先（与 processCanvas v0.16.1 同纪律），
    //   不再把「磁盘上的旧位置」钉回去（Bug6 同款坑：用户刚拖动未落盘时被覆盖）。
    const rd = await this._lmbReadCanvasData(ctx.file);
    if (!rd) { new Notice("画布读取失败"); return; }
    const data = rd.data;
    const nodes = data.nodes || [];
    const fold = !!this.settings.noteFoldByDefault;   // 跟随设置（默认 false = 展开，一眼能看见）
    let n = 0;
    for (const node of nodes) {
      if (node.type !== "text" || !node.text) continue;
      if (!EX_ID_RE.test(node.text)) continue;             // 只处理摘录卡
      // v0.16.6 P1-4：只认插件自有的 note 类型，用户自有 callout 不再被当「已有描述」
      if (lmbSplitNote(node.text, this.settings.noteCalloutType || "ppd-note").hasNote) continue;
      node.text = lmbJoinNote(node.text, "", {
        type: this.settings.noteCalloutType || "ppd-note",
        title: this.settings.noteTitle || "补充描述",
        fold,
        allowEmpty: true
      });
      const size = this.estimateSizeFor(node.text);
      node.width = Math.round(this._lmbKeepCardWidth(node));
      node.height = Math.round(size.h);
      let store = this.autoSize.get(ctx.file.path);
      if (!store) { store = new Map(); this.autoSize.set(ctx.file.path, store); }
      store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });
      n++;
    }
    if (!n) { new Notice("这个画布里没有需要添加描述框的摘录卡（可能都已经有了）"); return; }
    // v0.16.4 P1-3：统一写回（setData + requestSave + 同一份内存数据写盘）
    await this._lmbWriteCanvasData(ctx.file, data, rd.memCanvas, rd.raw);
    this.persistAutoSizeSoon();
    new Notice(`已给 ${n} 张摘录卡添加补充描述框（${fold ? "已折叠" : "已展开"}，点开即可写）`);
  },

  /**
   * v0.11.0：给画布里所有还没有评论栏的摘录卡批量挂「添加评论」底栏（存量卡入口）。
   *   已有评论的卡跳过，绝不覆盖用户已写内容。
   */
  async addCommentBoxToAllCards() {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    // v0.16.4 修复 P1-3：读改写迁移到内存优先（同 addNoteBoxToAllCards）
    const rd = await this._lmbReadCanvasData(ctx.file);
    if (!rd) { new Notice("画布读取失败"); return; }
    const data = rd.data;
    const nodes = data.nodes || [];
    let n = 0;
    for (const node of nodes) {
      if (node.type !== "text" || !node.text) continue;
      if (!EX_ID_RE.test(node.text)) continue;                 // 只处理摘录卡
      if (lmbSplitComment(node.text).hasComment) continue;     // 已有评论 → 跳过
      node.text = lmbJoinComment(node.text, "", { allowEmpty: true });
      const size = this.estimateSizeFor(node.text);
      node.width = Math.round(this._lmbKeepCardWidth(node));
      node.height = Math.round(size.h);
      let store = this.autoSize.get(ctx.file.path);
      if (!store) { store = new Map(); this.autoSize.set(ctx.file.path, store); }
      store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });
      n++;
    }
    if (!n) { new Notice("这个画布里的摘录卡都已经有评论栏了"); return; }
    // v0.16.4 P1-3：统一写回（setData + requestSave + 同一份内存数据写盘）
    await this._lmbWriteCanvasData(ctx.file, data, rd.memCanvas, rd.raw);
    this.persistAutoSizeSoon();
    new Notice(`已给 ${n} 张摘录卡添加评论栏（点评论栏直接写）`);
  },

  /* ==================== v0.11.0：独立评论（批注评论底栏） ==================== */

  _lmbCanonicalEntryForExcerpt(exId, canvasPath) {
    if (!exId || !this.excerptIndex) return null;
    let fallback = null;
    for (const [pdfPath, entries] of this.excerptIndex) {
      const hits = (entries || []).filter(entry => entry && entry.exId === exId && entry.sourceMd);
      if (!hits.length) continue;
      if (this.settings && this.settings.storageLayout === "central") {
        const expected = this.lmbStoragePaths(pdfPath, canvasPath).md;
        const hit = hits.find(entry => entry.sourceMd === expected);
        if (hit) return hit;
        const explicit = canvasPath && this.settings.storageBindings && this.settings.storageBindings[pdfPath]
          && this.settings.storageBindings[pdfPath].canvasDocuments && this.settings.storageBindings[pdfPath].canvasDocuments[canvasPath];
        // User-authored notes outside the managed directory remain valid sources
        // when there is no conflicting Canvas binding or duplicate source.
        if (!fallback && (!canvasPath || (!explicit && new Set(hits.map(entry => entry.sourceMd)).size === 1))) fallback = hits[0];
      } else return hits[0];
    }
    return fallback;
  },

  /** 把某个摘录 Markdown 中的备注镜像到已关联的 Canvas 卡片。Markdown 永远是准值。 */
  async lmbMirrorMdNotesToCanvas(mdFile, raw, entries) {
    if (!mdFile || !Array.isArray(entries) || !this.excerptCanvasIndex) return;
    const grouped = new Map();
    const noteMap = this._lmbBuildExcerptNoteMap(raw);
    for (const entry of entries) {
      if (!entry || !entry.exId || entry.sourceMd !== mdFile.path) continue;
      const loc = this.excerptCanvasIndex.get(entry.exId);
      if (!loc || !loc.canvasPath || !loc.nodeId) continue;
      if (this.settings && this.settings.storageLayout === "central") {
        const binding = this.settings.storageBindings && this.settings.storageBindings[entry.pdfPath];
        const expected = this.lmbStoragePaths(entry.pdfPath, loc.canvasPath).md;
        const explicit = binding && binding.canvasDocuments && binding.canvasDocuments[loc.canvasPath];
        const competing = (this.excerptIndex && this.excerptIndex.get(entry.pdfPath) || [])
          .some(other => other.exId === entry.exId && other.sourceMd === expected);
        if (expected !== mdFile.path && (explicit || competing)) continue;
      }
      if (!grouped.has(loc.canvasPath)) grouped.set(loc.canvasPath, []);
      grouped.get(loc.canvasPath).push({ nodeId: loc.nodeId, exId: entry.exId,
        note: noteMap.get(entry.exId) || "" });
    }
    if (!grouped.size) return;
    if (!this._lmbCanvasNoteMirrorBusy) this._lmbCanvasNoteMirrorBusy = new Set();
    for (const [canvasPath, updates] of grouped) {
      if (this._lmbCanvasNoteMirrorBusy.has(canvasPath)) continue;
      const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
      if (!(canvasFile instanceof TFile)) continue;
      this._lmbCanvasNoteMirrorBusy.add(canvasPath);
      try {
        const rd = await this._lmbReadCanvasData(canvasFile);
        if (!rd) continue;
        const changed = [];
        for (const update of updates) {
          const node = (rd.data.nodes || []).find((n) => n.id === update.nodeId && n.type === "text");
          if (!node) continue;
          const cur = lmbSplitComment(node.text || "");
          if (String(cur.comment || "").trim() === String(update.note || "").trim()
            && cur.hasComment === !!String(update.note || "").trim()) continue;
          node.text = lmbJoinComment(cur.body, update.note, { allowEmpty: false });
          const size = this.estimateSizeFor(node.text, { width: this._lmbKeepCardWidth(node),
            view: (this.settings.nodeViews || {})[canvasFile.path + "::" + node.id] || "text" });
          node.width = Math.round(this._lmbKeepCardWidth(node)); node.height = Math.round(size.h);
          changed.push(node);
        }
        if (!changed.length) continue;
        await this._lmbWriteCanvasData(canvasFile, rd.data, rd.memCanvas, rd.raw);
        // Allow Canvas rendering to settle once per batch rather than imposing
        // an unconditional 80ms delay for every changed card.
        await new Promise((resolve) => setTimeout(resolve, 80));
        for (const node of changed) await this._lmbAutoFitCard(canvasFile, node.id, node, { skipDelay: true });
      } catch (err) { console.warn("[lmb] mirror md note to canvas failed:", canvasPath, err); }
      finally { this._lmbCanvasNoteMirrorBusy.delete(canvasPath); }
    }
  },

  /**
   * 把评论写进指定节点。commentText 为空串 = 移除评论栏。
   * 结构：评论 callout 永远追加在卡片文本最末（补充描述之后），渲染成底栏。
   * 写完同步 autoSize 档案 + 组内重新居中（高度变化不再产生「乱放」）。
   */
  async applyCardComment(file, nodeId, commentText) {
    // v0.16.4 修复 P1-3：内存优先读取 + 统一写回（防覆盖用户未落盘的拖动，Bug6 同款坑）
    const rd = await this._lmbReadCanvasData(file);
    if (!rd) return { ok: false, msg: "画布读取失败" };
    const data = rd.data;
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (!node) return { ok: false, msg: "找不到该卡片（可能已被删除）" };
    if (node.type !== "text") return { ok: false, msg: "只有文本卡片支持评论" };

    // 摘录卡的评论就是统一“备注”。必须先写 Markdown 真相源；写入失败时拒绝
    // 只改 Canvas，以免三端产生两个不同版本。
    const exMatch = String(node.text || "").match(EX_ID_RE);
    if (exMatch) {
      const exId = exMatch[0].slice(1), entry = this._lmbCanonicalEntryForExcerpt(exId, file.path);
      const mdFile = entry && this.app.vault.getAbstractFileByPath(entry.sourceMd);
      if (!(mdFile instanceof TFile)) return { ok: false, msg: "找不到该摘录的 Markdown 文档，未保存备注" };
      const saved = await this.lmbSaveExcerptNote(mdFile, exId, commentText);
      if (!saved) return { ok: false, msg: "无法写入 Markdown 摘录备注，未修改 Canvas" };
    }

    const cur = lmbSplitComment(node.text || "");
    node.text = lmbJoinComment(cur.body, commentText, { allowEmpty: false });

    const size = this.estimateSizeFor(node.text, { width: this._lmbKeepCardWidth(node),
      view: (this.settings.nodeViews || {})[file.path + "::" + node.id] || "text" });
    node.width = Math.round(this._lmbKeepCardWidth(node));
    node.height = Math.round(size.h);
    if (Array.isArray(data.edges) && data.edges.length) {
      lmbRecenterNode(node, data.nodes || [], data.edges, this.autoEdges.get(file.path) || new Set());
    }
    let store = this.autoSize.get(file.path);
    if (!store) { store = new Map(); this.autoSize.set(file.path, store); }
    store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });

    await this._lmbWriteCanvasData(file, data, rd.memCanvas, rd.raw);
    this.persistAutoSizeSoon();
    await this._lmbAutoFitCard(file, node.id, node);
    this.lmbSchedulePdfSidebarRefresh(100);
    return { ok: true, msg: "" };
  },

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
  },

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
      // v0.11.3：双重摘录卡的「视图切换按钮」——点击在 文字/图片 显示间切换。
      //   不拦截事件（不 preventDefault/stopPropagation），保留 canvas 原生的
      //   选中卡片等交互；切换纯靠 DOM class + CSS 显隐，不改卡片文本 → 宽度不变。
      const viewCallout = t.closest('.callout[data-callout="lmb-view"]');
      if (viewCallout) { this.toggleCardView(viewCallout); return; }
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
  },

  /**
   * v0.16.0：视图切换的**核心实现** —— 只认渲染容器（host），**不依赖任何 callout 存在**。
   *
   * 为什么要拆出来：v0.11.3 ~ v0.15.0 的双重卡靠卡里那行 `> [!lmb-view]` callout 当「切换按钮」，
   *   toggleCardView(callout) 用 callout.closest() 反查 host 再切 class。v0.16.0 起新建的卡
   *   不再写这行（卡片精简 v2：用户要求卡内不放控件）→ 那条反查路径对**新卡**永远找不到 callout
   *   → 悬浮栏「视图」按钮会变成点了没反应的死按钮（v0.13.1 踩过同款坑）。
   *   所以把「切 class」这步抽成独立函数，悬浮栏直接把 host 传进来。
   *
   * @param {HTMLElement} host  canvas 的 .canvas-node-content / md 的 .markdown-rendered
   * @returns {boolean|null} 切换后的状态：true=图片视图 / false=文字视图；host 无效返回 null
   */
  toggleCardViewByHost(host) {
    try {
      if (!host || !host.classList) return null;
      const toImg = !host.classList.contains("lmb-view-img");
      host.classList.toggle("lmb-view-img", toImg);
      return toImg;
    } catch (_) { return null; }
  },

  /**
   * v0.11.3：切换双重摘录卡的显示视图（文字 ↔ 图片）。
   *   实现 = 给渲染容器（canvas 的 .canvas-node-content / md 的 .markdown-rendered）
   *   切换 lmb-view-img class，CSS 负责显隐（默认文字视图隐藏图片；图片视图隐藏引用块）。
   *   不改节点 markdown 文本 → fitNode hash 不变 → 卡片宽度（和高度）保持不变。
   *
   *   v0.16.0：切 class 的活委托给 toggleCardViewByHost。**本函数保留是为存量卡兼容** ——
   *   老版本建的双重卡 markdown 里仍然有 `> [!lmb-view]` 行，点它照样能切、标题文字也跟着变。
   *   新建的卡走 37-plugin-canvasbar.js 悬浮栏 → 直接调 toggleCardViewByHost。
   *
   *   已知边界：切换态存 DOM，不落盘 —— 重载/重渲染后回到默认文字视图。
   * @param {HTMLElement} callout  lmb-view callout 元素（仅存量卡才有）
   */
  toggleCardView(callout) {
    try {
      const host = callout.closest(".canvas-node-content")
        || callout.closest(".markdown-rendered")
        || callout.parentElement;
      const toImg = this.toggleCardViewByHost(host);
      if (toImg === null) return;
      // 按钮标题即时反馈（重渲染后会回到落盘的默认标题，无碍——显隐以 class 为准）
      const inner = callout.querySelector(".callout-title-inner");
      if (inner) {
        const next = toImg ? LMB_VIEW_TITLE_IMG : LMB_VIEW_TITLE_TEXT;
        if (typeof inner.setText === "function") inner.setText(next);
        else inner.textContent = next;
      }
    } catch (_) { /* noop：切换失败绝不能抛错破坏 canvas */ }
  },

  /** 按节点 id 直开评论编辑弹窗（点击评论栏的入口，无需选择器） */
  async editCommentForNode(file, nodeId) {
    if (!file) return;
    // v0.16.4 P1-3：弹窗初值也走内存优先（旧版读文件，刚拖动未落盘时可能显示旧值）
    const rd = await this._lmbReadCanvasData(file);
    if (!rd) return;
    const node = (rd.data.nodes || []).find((n) => n.id === nodeId);
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
  },

  /** 拿到当前 canvas 上下文 { file, leaf }；当前活动视图不是 canvas 则返回 null */
  activeCanvasContext() {
    // v0.16.4 修复 P2-5：不再静默回退到「任意一个打开的 canvas leaf」——
    //   旧行为会让用户在 md/PDF 视图触发命令时，操作悄悄落到某个后台画布上。
    //   现在只认当前活动 leaf 是 canvas，否则返回 null（调用方各自提示/灰显）。
    try {
      // v0.16.5 修复 R6：activeLeaf 是 deprecated API，一旦被移除，所有 canvas 命令
      //   会全部失效。加 getMostRecentLeaf() 兜底（返回最近使用过的 leaf；用户不在
      //   canvas 视图时它同样不是 canvas → 与严格判定的语义一致）。
      let leaf = null;
      try { leaf = this.app.workspace.activeLeaf || null; } catch (_) { leaf = null; }
      if (!leaf) {
        try {
          leaf = typeof this.app.workspace.getMostRecentLeaf === "function"
            ? this.app.workspace.getMostRecentLeaf() : null;
        } catch (_) { leaf = null; }
      }
      if (!leaf || !leaf.view) return null;
      let vt = null;
      try { vt = typeof leaf.view.getViewType === "function" ? leaf.view.getViewType() : null; } catch (_) { vt = null; }
      if (vt !== "canvas") return null;
      const f = leaf.view.file;
      if (!f || f.extension !== "canvas") return null;
      return { file: f, leaf };
    } catch (_) { return null; }
  },

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
          const has = lmbSplitNote(n.text, this.settings.noteCalloutType || "ppd-note").hasNote;
          return { id: n.id, label: (has ? "📝 " : "") + first.slice(0, 60), node: n };
        });
        if (!items.length) { new Notice("这个画布里没有文本卡片"); resolve(null); return; }
        new LMBNodeSuggester(this.app, items,
          (it) => resolve({ node: it.node, via: "picker" }),
          () => resolve(null)).open();
      }).catch(() => resolve(null));
    });
  },

  /**
   * 把补充描述写进指定节点。noteText 为空串 = 移除补充描述。
   *   opts.fold 为 boolean 时显式设置折叠态；为 null/undefined 时沿用当前折叠态。
   *   写完同步 autoSize 档案（hash + 尺寸），防止后续 sync 把卡片尺寸回退。
   */
  async applyCardNote(file, nodeId, noteText, opts) {
    const o = opts || {};
    // v0.16.4 修复 P1-3：内存优先读取 + 统一写回（同 applyCardComment）
    const rd = await this._lmbReadCanvasData(file);
    if (!rd) return { ok: false, msg: "画布读取失败" };
    const data = rd.data;
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (!node) return { ok: false, msg: "找不到该卡片（可能已被删除）" };
    if (node.type !== "text") return { ok: false, msg: "只有文本卡片支持补充描述" };

    // v0.16.6 P1-4：只认插件自有的 note 类型（用户自有 callout 不再被改写覆盖）
    const cur = lmbSplitNote(node.text || "", this.settings.noteCalloutType || "ppd-note");
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
    node.width = Math.round(this._lmbKeepCardWidth(node));
    node.height = Math.round(size.h);
    // v0.11.0：高度变了 → 组内重新居中（中心保持在父卡横/纵轴上）
    if (Array.isArray(data.edges) && data.edges.length) {
      lmbRecenterNode(node, data.nodes || [], data.edges, this.autoEdges.get(file.path) || new Set());
    }
    let store = this.autoSize.get(file.path);
    if (!store) { store = new Map(); this.autoSize.set(file.path, store); }
    store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });

    await this._lmbWriteCanvasData(file, data, rd.memCanvas, rd.raw);
    this.persistAutoSizeSoon();
    return { ok: true, msg: "" };
  },

  /** 三条命令的统一入口：edit（弹窗编辑）/ remove（清空）/ fold（切换折叠） */
  async runCardNoteCommand(mode) {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    const pick = await this.pickCanvasNode(ctx);
    if (!pick || !pick.node) return;
    const cur = lmbSplitNote(pick.node.text || "", this.settings.noteCalloutType || "ppd-note");

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
  },

});

/* 34-plugin-excerpt-index —— 摘录索引/文档同步/画布聚焦（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

  /* ==================== 摘录文档（<PDF名>-摘录.md） ==================== */

  /**
   * 摘录文档写入（<PDF名>-摘录.md）—— v0.4.0 树形版。
   * v0.18：仅更新 LMB:BEGIN/END 受控区域；区域外的用户补充永不覆盖。
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
      const mdPath = this.settings && this.settings.storageLayout === "central"
        ? this.lmbStoragePaths(pdfPath, cf.path).md
        : normalizePath(folder === "/" ? pdfBase + "-摘录.md" : folder + "/" + pdfBase + "-摘录.md");
      if (this.settings && this.settings.storageLayout === "central") await this.lmbEnsureStorageParent(mdPath);
      // Markdown 是备注真相源。重建受控摘录区之前先读取现有备注，稍后按 exId
      // 原样嵌回，避免 Canvas 同步正文时把用户在 MD/PDF 侧栏写的备注覆盖掉。
      const existing = this.app.vault.getAbstractFileByPath(mdPath);
      let existingRaw = "";
      if (existing instanceof TFile) {
        try { existingRaw = await this.app.vault.read(existing); } catch (_) { existingRaw = ""; }
      }
      const existingNotes = this._lmbBuildExcerptNoteMap(existingRaw);

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
      const pageOrdinals = new Map();
      const pageCounts = new Map();
      for (const en of ordered) {
        const key = en.page == null ? "none" : String(en.page);
        const next = (pageCounts.get(key) || 0) + 1;
        pageCounts.set(key, next); pageOrdinals.set(en.id, next);
      }
      const emitEntry = (en, depth) => {
        const q = depth > 0 ? "> ".repeat(depth) : "";
        const cardQ = q + "> ";
        const ordinal = pageOrdinals.get(en.id) || 1;
        const badge = ordinal <= 20
          ? ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"][ordinal]
          : "#" + ordinal;
        const kind = /!\[\[[^\]]+\.(?:webp|png|jpe?g)/i.test(en.body) ? "图像" : "原文";
        body += q + `> [!lmb-excerpt]+ ${badge} P.${en.page != null ? en.page : "?"} · ${kind}\n`;
        body += cardQ + `<span class="lmb-excerpt-id" data-lmb-ex="${en.id}"></span>\n`;
        // v0.12.0：卡片引用行是 📖 收拢形态（lmbBookLink），导出到摘录 md 时
        //   还原成完整【文件名-P.N】——md 要能独立阅读、Recall 模糊也靠全名命中。
        for (const line of en.body.split("\n")) {
          body += (cardQ + lmbRestoreRefDisplayName(line, pdfBase, en.page)) + "\n";
        }
        const canonicalNote = existingNotes.get(en.id) || "";
        if (canonicalNote) {
          body += cardQ + "> [!lmb-note]\n";
          body += cardQ + "> <!-- LMB-NOTE:BEGIN -->\n";
          for (const line of canonicalNote.replace(/\r\n/g, "\n").split("\n")) body += cardQ + "> " + line + "\n";
          body += cardQ + "> <!-- LMB-NOTE:END -->\n";
        }
        body += cardQ + "^" + en.id + "\n";
        const rel = this.relatedCache ? this.relatedCache.get(en.id) : null;
        if (rel && rel.length) body += cardQ + "> 相关：" + rel.join(" · ") + "\n";
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

      const head = "---\nPDF: \"[[" + pdfPath + "]]\"\ncanvas: \"[[" + cf.path + "]]\"\n";
      const generated = "<!-- LMB:BEGIN -->\n" + body + "<!-- LMB:END -->";

      if (existing instanceof TFile) {
        const cur = existingRaw || await this.app.vault.read(existing);
        const oldRegion = cur.match(/<!--\s*LMB:BEGIN\s*-->[\s\S]*?<!--\s*LMB:END\s*-->/i);
        // 首次迁移旧文档时完整保留旧正文；宁可暂时重复，也绝不吞掉用户手写内容。
        const preserved = oldRegion
          ? cur.slice((oldRegion.index || 0) + oldRegion[0].length).replace(/^\s+/, "")
          : "## 我的补充\n\n<!-- LMB: 已保留迁移前文档内容，请按需整理。 -->\n\n"
            + cur.replace(/^---[\s\S]*?---\s*/m, "").trim();
        const content = head + "updated: \"" + new Date().toISOString() + "\"\n---\n\n"
          + generated + "\n\n" + (preserved || "## 我的补充\n");
        const curNoStamp = cur.replace(/^updated: "[^"]*"\r?\n/m, "");
        const nextNoStamp = content.replace(/^updated: "[^"]*"\r?\n/m, "");
        if (curNoStamp !== nextNoStamp) {
          await this.app.vault.process(existing, () => content);
          console.log("[lmb] excerpt doc updated:", mdPath);
        }
      } else {
        const content = head + "updated: \"" + new Date().toISOString() + "\"\n---\n\n"
          + generated + "\n\n## 我的补充\n";
        await this.app.vault.create(mdPath, content);
        new Notice("MarginBook: 已创建摘录文档 " + mdPath);
        console.log("[lmb] excerpt doc created:", mdPath);
      }
      // v0.16.4 P3-5：文档刚创建/更新后立即强制入索引（不等 resolvedLinks 异步解析 +
      //   下一次 modify）——否则回绘标记要等很久才出现。
      try {
        const nf = this.app.vault.getAbstractFileByPath(mdPath);
        if (nf instanceof TFile) this.reindexFile(nf, true).catch(() => {});
      } catch (_) { /* 索引失败不影响写入结果 */ }
    } catch (err) {
      console.error("[lmb] writeExcerptMd error:", err);
    }
  },

  /* ==================== v0.12.0：PDF 工具栏「打开摘录 md / 打开专属 canvas」 ==================== */

  /**
   * 打开（必要时创建）PDF 专属摘录文档：<PDF名>-摘录.md（由统一存储规则决定路径）。
   * 存在 → 直接打开；已打开的 md 视图复用（绝不重开第二个标签）。
   * 不存在 → 写入 frontmatter 模板（PDF/canvas 指回本 PDF），与 writeExcerptMd 的头格式一致。
   */
  /** Ensure the canonical excerpt document exists without stealing focus from a PDF. */
  async lmbEnsureExcerptMdFile(pdfFile) {
    if (!pdfFile) return null;
    const name = pdfFile.basename + "-摘录.md";
    const paths = this.lmbStoragePaths(pdfFile), path = paths.md;
    let f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) {
      await this.lmbEnsureStorageParent(path);
      const canvasName = paths.canvas;
      const head = "---\nPDF: \"[[" + pdfFile.path + "]]\"\ncanvas: \"[[" + canvasName + "]]\"\n";
      const content = head + "updated: \"" + new Date().toISOString() + "\"\n---\n\n";
      f = await this.app.vault.create(path, content);
      new Notice("MarginBook: 已创建摘录文档 " + name);
    }
    return f;
  },

  async lmbOpenOrCreateExcerptMd(pdfFile) {
    const f = await this.lmbEnsureExcerptMdFile(pdfFile);
    if (!(f instanceof TFile)) return null;
    // 已打开 → 复用该标签
    try {
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      for (const l of leaves) {
        const v = l && l.view;
        if (v && v.file && v.file.path === f.path) {
          this.app.workspace.setActiveLeaf(l, { focus: true });
          return f;
        }
      }
    } catch (_) { /* 复用失败就走正常打开 */ }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(f);
    return f;
  },

  /**
   * 打开（必要时创建）PDF 专属画布：<PDF名>.canvas（由统一存储规则决定路径）。
   * 复用约定与 lmbFocusCanvasNode 一致：已打开的画布直接激活，绝不重开第二视图
   * （同一文件两个视图会让 canvasPositions 等按视图对象为键的状态全部失效）。
   */
  async lmbOpenOrCreatePdfCanvas(pdfFile) {
    if (!pdfFile) return null;
    const name = pdfFile.basename + ".canvas";
    const path = this.lmbStoragePaths(pdfFile).canvas;
    let f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) {
      await this.lmbEnsureStorageParent(path);
      f = await this.app.vault.create(path, JSON.stringify({ nodes: [], edges: [] }));
      new Notice("MarginBook: 已创建专属画布 " + name);
      // 新画布顺手登记进 canvas 索引（空画布无摘录卡，索引一次成本极低，保持一致性）
      this.lmbIndexCanvasFile(f).catch(() => {});
    }
    const leaves = this.app.workspace.getLeavesOfType("canvas");
    for (const l of leaves) {
      const v = l && l.view;
      if (v && v.file && v.file.path === f.path) {
        this.app.workspace.setActiveLeaf(l, { focus: true });
        return f;
      }
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(f);
    return f;
  },

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
  },

  /** 单个文件是否链接到 pdf（用于 modify 事件的廉价预筛，避免每次敲键都读文件） */
  lmbFileLinksPdf(f) {
    try {
      const links = this.app.metadataCache && this.app.metadataCache.resolvedLinks
        && this.app.metadataCache.resolvedLinks[f.path];
      return !!(links && Object.keys(links).some((p) => p.toLowerCase().endsWith(".pdf")));
    } catch (_) { return false; }
  },

  /** 全量重建。分批 20 个 + 批间 sleep 10ms，避免大库卡 UI。 */
  async buildExcerptIndex() {
    if (this._isIndexing) return;
    this._isIndexing = true;
    const t0 = Date.now();
    try {
      this.excerptIndex.clear();
      this.indexMtime.clear();
      const cands = this.lmbIndexCandidates();
      // Build the Canvas reverse index first.  reindexFile also mirrors notes,
      // so doing Markdown first forced every candidate to be read and parsed a
      // second time after Canvas indexing completed.
      const canvases = this.app.vault.getFiles().filter((f) => f.extension === "canvas");
      for (let i = 0; i < canvases.length; i += 10) {
        for (const cf of canvases.slice(i, i + 10)) await this.lmbIndexCanvasFile(cf);
        if (i + 10 < canvases.length) await new Promise((r) => setTimeout(r, 10));
      }
      for (let i = 0; i < cands.length; i += 20) {
        for (const f of cands.slice(i, i + 20)) await this.reindexFile(f);
        if (i + 20 < cands.length) await new Promise((r) => setTimeout(r, 10));
      }
      const s = this.getIndexStats();
      if (this.settings && this.settings.debug) {
        console.log("[lmb] 摘录索引构建完成:", s, (Date.now() - t0) + "ms");
      }
      // P2：索引变了 → 重画标记
      this.lmbRefreshAllMarks();
      // P2：索引变了 → 刷新 PDF 侧栏（若当前打开的是对应 PDF）
      this.lmbSchedulePdfSidebarRefresh(120);
      return s;
    } catch (err) {
      console.error("[lmb] buildExcerptIndex error:", err);
    } finally {
      this._isIndexing = false;
    }
  },

  /**
   * 增量重索引单个文件。
   * 两道闸门避免无谓读盘：① 不链 pdf 且不在索引中 → 直接跳过
   *                    ② mtime 未变化 → 直接跳过
   */
  async reindexFile(f, force) {
    try {
      if (!f || f.extension !== "md") return;
      // v0.16.4 P3-5：force=true 跳过 resolvedLinks 闸门（新建摘录 md 的瞬间
      //   metadataCache 往往还没解析出 pdf 链接，旧闸门会把首次索引跳掉）
      if (!force && !this.lmbFileLinksPdf(f) && !this.indexMtime.has(f.path)) return;
      const prev = this.indexMtime.get(f.path);
      if (!force && prev != null && f.stat && f.stat.mtime <= prev) return;

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
      // v0.16.5 修复 R3：旧版在 f.stat 缺失时写入 Date.now()，该值 ≥ 之后任何真实
      //   mtime → 上面的「mtime 未变则跳过」闸门会从此永久拦住这个文件（索引冻结）。
      //   现在拿不到 mtime 就不记，等 stat 可用后自然补上（宁可多扫一次，也不能不扫）。
      if (f.stat && f.stat.mtime != null) this.indexMtime.set(f.path, f.stat.mtime);
      // P2：索引变了 → 防抖重画（modify 会在每次敲键触发，所以必须防抖）
      this.lmbScheduleMarksRefresh(300);
      this.lmbSchedulePdfSidebarRefresh(220);
      // 用户直接在摘录 MD 中编辑备注时，立即反向镜像到关联 Canvas。
      await this.lmbMirrorMdNotesToCanvas(f, content, entries);
    } catch (err) {
      console.warn("[lmb] reindexFile error:", f && f.path, err);
    }
  },

  /** 摘掉某个摘录文档贡献的全部条目（文件删除 or 重索引前调用） */
  dropFileFromIndex(mdPath) {
    if (!mdPath || !this.excerptIndex) return;
    for (const [k, arr] of Array.from(this.excerptIndex.entries())) {
      const kept = arr.filter((e) => e.sourceMd !== mdPath);
      if (kept.length !== arr.length) this.excerptIndex.set(k, kept);
    }
    this.indexMtime.delete(mdPath);
    this.lmbSchedulePdfSidebarRefresh(120);
  },

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
        const ids = n.text.match(/\^ex-[0-9a-z]{4,16}/g);
        if (!ids) continue;
        for (const id of ids) {
          this.excerptCanvasIndex.set(id.slice(1), { canvasPath: cf.path, nodeId: n.id });
        }
      }
    } catch (err) {
      console.warn("[lmb] lmbIndexCanvasFile error:", cf && cf.path, err);
    }
  },

  /**
   * 打开 canvas 并聚焦到指定节点（选中 + 缩放到选区）。
   * canvas 视图懒加载节点，必须轮询等 nodes 里出现目标 id。
   * 聚焦失败不算失败（画布已打开），返回 true。
   */
  async lmbFocusCanvasNode(cf, nodeId, navigation) {
    const ownsNavigation = !navigation;
    navigation = navigation || this._lmbBeginNavigation();
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
      leaf = await this._lmbActivateNavigationLeaf(navigation, leaf, cf);
      if (!leaf) return false;
      const view = leaf.view;
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        if (!this._lmbNavigationCurrent(navigation) || leaf.view !== view || view.file?.path !== cf.path) return false;
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
    } finally { if (ownsNavigation) this._lmbEndNavigation(navigation); }
  },

  /**
   * v0.9.2：跳转落地后的「重叠自愈」。
   * 背景：lmbLayoutGroup 排布用的是当时的卡片高度，之后卡片"放大"
   *   （补充描述框挂上 / fitNode 估算修正）时，下方/右侧的卡不会跟着让位 → 重叠。
   * 修法：落地 900ms 后（等 processCanvas 的写入和视图重载都结束），
   *   对这张画布跑一次 v0.6.0 的重叠规范化 —— 幂等、只动 ^ex 卡、
   *   没有重叠时是空操作（分组条件就是"两卡相交 ≥ 较小卡 20%"）。
   *
   * v0.16.5 修复 R1：自愈改走 healOnly 模式 —— 只重排「已有父子关系 + 当前仍重叠」
   *   的组，**不新建任何边**。旧版每次反向跳转都会对新重叠的卡再建一条父边：
   *   ① 绕过 v0.11.0 的「首连锁定（一卡一线）」→ 一卡双父；
   *   ② 新建边不进 sidecar 却因 e<base36> 命名被当自动边 → 账本矛盾（残留孤儿边）；
   *   ③ 整组重排会挪动用户摆好的卡。
   */
  lmbScheduleOverlapHeal(cf) {
    try {
      if (this._ppdHealTimer) clearTimeout(this._ppdHealTimer);
      this._ppdHealTimer = setTimeout(() => {
        this._ppdHealTimer = null;
        try {
          this.normalizeOverlappingExcerpts(cf, { healOnly: true }).catch(() => {});
        } catch (_) { /* noop */ }
      }, 900);
    } catch (_) { /* noop */ }
  },

  /** 供 P2 回绘使用：某 PDF 的全部摘录条目 */
  getExcerptsForPdf(pdfPath) {
    return this.excerptIndex ? (this.excerptIndex.get(pdfPath) || []) : [];
  },

  getIndexStats() {
    let excerpts = 0;
    if (this.excerptIndex) for (const arr of this.excerptIndex.values()) excerpts += arr.length;
    return {
      pdfs: this.excerptIndex ? this.excerptIndex.size : 0,
      excerpts: excerpts,
      files: this.indexMtime ? this.indexMtime.size : 0
    };
  },

  /* ==================== v0.15.0：删除级联 ====================
   * 用户确认方案：**实时检测 + 默认关闭**（settings.autoCleanOnDelete，需用户主动开启）。
   *
   * 触发点：processCanvas（vault modify + 400ms 防抖）里比对「本次节点 id 集」与
   *   元数据档案，差集 = 消失的节点 → 走清理。
   *
   * 为什么另存元数据档案：canvasPositions 只存位置不存 text，而节点删除后 data.nodes
   *   里就没了，拿不到 text 就不知道它引用了哪个附件 / 哪条摘录。元数据只存
   *   { 附件名, exId }（不存全文），内存开销极小。
   *
   * 清理三目标：
   *   ① canvas 档案（autoSize / sidecar 自动边）—— 顺带清，无害
   *   ② webp 截图附件 —— **格式白名单** + **全 vault 引用计数**，不误删
   *   ③ md 摘录文档条目 —— 按 ^ex-xxx 锚点定位块，只删该块
   *
   * 安全网（缺一不可）：
   *   默认关闭开关 / 删除前写入 .lmb-trash 可恢复副本 / 格式白名单 /
   *   引用计数（检查失败即保留）/ Notice 汇总 / 全程 try-catch 不中断
   */

  /**
   * 更新节点元数据档案（每次 processCanvas 调用），**顺带返回本次消失的节点**。
   *
   * 为什么合并：档案更新和"谁消失了"都需要遍历当前 nodes，一次遍历同时得到两个结果，
   *   不需要额外的二次确认 —— nodes 本身就是刚从画布文件解析出来的当前状态，
   *   「档案里有、nodes 里没有」即已确认该节点不在了。
   *
   * @returns {Array<{id:string, meta:object}>} 本次检测到消失的节点（含元数据）
   */
  _lmbUpdateNodeMeta(cf, nodes) {
    const gone = [];
    try {
      if (!this.nodeMeta) this.nodeMeta = new Map();
      let metaMap = this.nodeMeta.get(cf.path);
      if (!metaMap) { metaMap = new Map(); this.nodeMeta.set(cf.path, metaMap); }
      const alive = new Set();
      for (const n of nodes || []) {
        if (!n || !n.id) continue;
        alive.add(n.id);
        if (n.type !== "text" || typeof n.text !== "string") continue;
        const attachM = n.text.match(/!\[\[([^\]|]+?\.(?:webp|png|jpe?g))(?:\|[^\]]*)?\]\]/i);
        const exM = n.text.match(EX_ID_RE);
        metaMap.set(n.id, {
          attach: attachM ? attachM[1] : null,
          exId: exM ? exM[0].slice(1) : null,
          pdf: (n.text.match(/\[\[([^\]#|]+\.pdf)/i) || [])[1] || null
        });
      }
      // 档案里有、但本次不在了 → 判定为删除
      for (const id of Array.from(metaMap.keys())) {
        if (alive.has(id)) continue;
        const meta = metaMap.get(id);
        // 只上报「有附件或有 exId」的（普通卡片删了没东西可清，直接清档案即可）
        if (meta && (meta.attach || meta.exId)) gone.push({ id, meta });
        metaMap.delete(id);
      }
    } catch (_) { /* noop：元数据更新失败不影响主流程 */ }
    return gone;
  },

  /**
   * 执行级联清理。
   * @param {TFile} cf 画布文件
   * @param {Array<{id:string, meta:object}>} gone 被删除的节点（含元数据）
   */
  async _lmbCleanupDeletedNodes(cf, gone) {
    /* v0.16.6 P0-1：批量删除安全闸。
     *   一次消失 >3 张摘录卡，几乎不可能是用户手动连删的结果 —— 更可能是画布重载、
     *   脏数据、Sync 冲突或 nodes 短暂为空（见 32:_lmbMemCanvasData 的同批修复）。
     *   级联清理会删 webp + 删 md 条目，属于**不可逆**操作，所以宁可漏清一次：
     *   超阈值时只写日志 + Notice，不执行任何删除。用户确认后可分小批重删。 */
    if (gone.length > 3) {
      try {
        new Notice(
          `MarginBook：检测到 ${gone.length} 张摘录卡同时消失（超过 3 张阈值），已跳过自动清理以防误删。` +
          `如确认要清理，请分批删除卡片（每次 ≤3 张）。`,
          8000
        );
      } catch (_) {}
      console.warn("[lmb] 批量删除超过阈值，已跳过级联清理:", gone.length, gone.map((g) => g.id.slice(0, 8)));
      // 日志内联写入（与函数末尾的备份日志同源；本文件没有可复用的独立写入入口）
      try {
        const logPath = ".lmb-trash-log.md";
        const stamp0 = new Date().toISOString();
        const lines0 = [`\n## ${stamp0} · 批量跳过（${gone.length} 张，超阈值未清理）`, `- canvas: [[${cf.basename}]]`];
        for (const g of gone) {
          const m0 = g.meta || {};
          lines0.push(`- ${String(g.id).slice(0, 8)}｜exId: ${m0.exId ? "^" + m0.exId : "-"}｜附件: ${m0.attach || "-"}`);
        }
        let prev0 = "";
        try { prev0 = await this.app.vault.adapter.read(logPath); } catch (_) { prev0 = ""; }
        if (!prev0) prev0 = "# MarginBook 删除日志\n\n> 删除级联（settings.autoCleanOnDelete）开启期间的操作记录，可供追溯恢复。\n";
        await this.app.vault.adapter.write(logPath, prev0 + lines0.join("\n") + "\n");
      } catch (_) {}
      return;
    }
    let removedAttach = 0, removedMd = 0, skipped = 0;
    const logLines = [];
    const stamp = new Date().toISOString();
    for (const g of gone) {
      const meta = g.meta || {};
      try {
        const trash = await this._lmbCreateTrashBundle(cf, g);
        logLines.push(`\n## ${stamp} · 卡片 ${String(g.id).slice(0, 8)}`);
        logLines.push(`- canvas: [[${cf.basename}]]`);
        if (meta.pdf) logLines.push(`- PDF: ${meta.pdf}`);
        if (meta.exId) logLines.push(`- exId: ^${meta.exId}`);
        if (meta.attach) logLines.push(`- 附件: ${meta.attach}`);

        // ① 清 canvas 档案（autoSize / sidecar 自动边）—— 顺带，无害
        try {
          const store = this.autoSize && this.autoSize.get(cf.path);
          if (store) store.delete(g.id);
        } catch (_) {}

        // v0.16.4 修复 P1-2：先删 md 条目（③ 提前），再对附件做引用计数（②）。
        //   旧顺序里摘录 md 自身还含 ![[xxx.webp]] embed 行，引用计数必然 ≥1
        //   → 附件永远「还有 1 处其它引用」→ 清理功能整体死锁（静默失效）。
        // ③ 清 md 摘录文档里的对应条目
        if (meta.exId && meta.pdf) {
          const ok = await this._lmbRemoveExcerptFromMd(cf, meta, trash);
          if (ok) { removedMd++; logLines.push(`- ✅ 摘录 md 条目已移除`); }
          else { skipped++; logLines.push(`- md 条目未找到，跳过（无妨）`); }
        }

        // ② 清 webp 附件（格式白名单 + 引用计数；md 条目已移除，不再自数）
        if (meta.attach) {
          const name = meta.attach;
          // 格式白名单：只删插件自己命名的 <PDF名>-P<页>-<戳>.webp
          const isPluginNamed = /^.+?-P\d+-[a-z0-9]+\.webp$/i.test(name);
          if (!isPluginNamed) {
            logLines.push(`- 附件跳过：文件名不符合插件命名格式（可能是用户自己的图）`);
            skipped++;
          } else {
            const f = this.app.vault.getAbstractFileByPath(name)
              || this._lmbFindAttachmentByName(name);
            if (!f) {
              logLines.push(`- 附件已不存在，跳过`);
              skipped++;
            } else {
              // v0.16.6 P1-5：传 cf 让统计排除源画布（旧版把源画布自己数进去 → 永远 ≥1 → 清理失效）
              const refs = await this._lmbCountAttachmentRefs(name, cf);
              if (refs > 0) {
                logLines.push(`- 附件跳过：vault 内还有 ${refs} 处其它引用（删了会导致 broken image）`);
                skipped++;
              } else {
                const target = normalizePath(trash.dir + "/" + f.name);
                await this.app.vault.rename(f, target);
                removedAttach++;
                logLines.push(`- ✅ 附件已移入 [[${target}]]`);
              }
            }
          }
        }

        // （v0.16.4：原 ③ md 条目清理已提前到 ② 附件清理之前，见上——修 P1-2 顺序死锁）
      } catch (err) {
        skipped++;
        logLines.push(`- ⚠ 清理异常：${err && err.message ? err.message : err}`);
        console.warn("[lmb] cleanup item failed:", err);
      }
    }

    // 写备份日志（可追溯恢复）
    if (logLines.length) {
      try {
        const logPath = ".lmb-trash-log.md";
        let prev = "";
        try { prev = await this.app.vault.adapter.read(logPath); } catch (_) { prev = ""; }
        if (!prev) prev = "# MarginBook 删除日志\n\n> 删除级联（settings.autoCleanOnDelete）开启期间的操作记录，可供追溯恢复。\n";
        await this.app.vault.adapter.write(logPath, prev + logLines.join("\n") + "\n");
      } catch (_) { /* 日志写失败不影响清理结果 */ }
      // Notice 汇总：让用户看得见清理了什么
      try {
        new Notice(`已清理 ${gone.length} 张已删除卡片：附件 ${removedAttach} 个 · md 条目 ${removedMd} 条${skipped ? ` · 跳过 ${skipped} 项` : ""}（可从 .lmb-trash 恢复）`, 4000);
      } catch (_) {}
    }
    return { removedAttach, removedMd, skipped };
  },

  /** 按文件名在 vault 里找附件（兼容只有文件名的场景） */
  _lmbFindAttachmentByName(name) {
    try {
      const files = this.app.vault.getFiles ? this.app.vault.getFiles() : [];
      const base = name.split("/").pop();
      return files.find((f) => f.name === base) || null;
    } catch (_) { return null; }
  },

  /** 为一次卡片级联清理建立独立、不会覆盖旧备份的回收目录。 */
  async _lmbCreateTrashBundle(cf, gone) {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const clock = now.toISOString().slice(11, 19).replace(/:/g, "");
    const safeId = String((gone.meta && gone.meta.exId) || gone.id || "excerpt").replace(/[^a-z0-9_-]/gi, "-");
    const baseDir = normalizePath(`.lmb-trash/${day}/${safeId}-${clock}-${String(gone.id || "").slice(0, 8)}`);
    const adapter = this.app.vault.adapter;
    for (const folder of [".lmb-trash", `.lmb-trash/${day}`]) {
      if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
    }
    let dir = baseDir;
    for (let suffix = 2; await adapter.exists(dir); suffix++) dir = baseDir + "-" + suffix;
    await adapter.mkdir(dir);
    const record = {
      deletedAt: now.toISOString(),
      canvasPath: cf.path,
      canvasNodeId: gone.id,
      excerptId: (gone.meta && gone.meta.exId) || null,
      pdfPath: (gone.meta && gone.meta.pdf) || null,
      attachmentPath: (gone.meta && gone.meta.attach) || null
    };
    await adapter.write(normalizePath(dir + "/metadata.json"), JSON.stringify(record, null, 2));
    return { dir, record };
  },

  /** 统计 vault 内除目标画布外，还有多少处引用了这个附件
   *  @param {string} name 附件路径
   *  @param {TFile} [cf] 源画布文件 —— v0.16.6 P1-5：必须传入并在统计时排除。
   *    旧版注释写着「除目标画布外」但代码没排除（函数签名里连 cf 都没有），于是
   *    刚从卡片删除、Obsidian 尚未落盘时，源画布的磁盘缓存里仍含该 embed →
   *    refs ≥ 1 → 走「跳过」分支 → 清理静默失效（卡片删了，截图永远留着）。 */
  async _lmbCountAttachmentRefs(name, cf) {
    let count = 0;
    const base = name.split("/").pop().replace(/\.(webp|png|jpe?g)$/i, "");
    const srcPath = cf && cf.path ? cf.path : null;
    if (!this.app.vault.getFiles || !this.app.vault.cachedRead) {
      throw new Error("附件引用检查不可用；为安全起见已保留附件");
    }
    const mdFiles = this.app.vault.getFiles()
      .filter((f) => f.extension === "md" || f.extension === "canvas");
    for (const f of mdFiles) {
      if (srcPath && f.path === srcPath) continue;
      if (f.path === ".lmb-trash-log.md" || f.path.startsWith(".lmb-trash/")) continue;
      let txt;
      try { txt = await this.app.vault.cachedRead(f); }
      catch (err) {
        throw new Error(`无法检查 ${f.path} 的附件引用；为安全起见已保留附件`, { cause: err });
      }
      if (txt && txt.indexOf(base) >= 0) count++;
    }
    return count;
  },

  /**
   * 从 md 摘录文档移除某个 ^ex-xxx 条目块。
   * 策略：按空行切块，找到含锚点行的块删掉；找不到锚点就不动（保守，防误删手写内容）。
   * @returns {Promise<boolean>} 是否真的删了
   */
  async _lmbRemoveExcerptFromMd(cf, meta, trash) {
    try {
      const pdfBase = (meta.pdf || "").split("/").pop().replace(/\.pdf$/i, "");
      if (!pdfBase && !meta.sourceMd) return false;
      const folder = cf && cf.parent && cf.parent.path ? cf.parent.path : "/";
      const mdPath = meta.sourceMd
        ? normalizePath(meta.sourceMd)
        : this.settings && this.settings.storageLayout === "central"
          ? this.lmbStoragePaths(meta.pdf, cf && cf.path).md
          : normalizePath(folder === "/" ? pdfBase + "-摘录.md" : folder + "/" + pdfBase + "-摘录.md");
      let raw = null;
      try { raw = await this.app.vault.adapter.read(mdPath); } catch (_) { return false; }
      if (!raw) return false;

      // 按「锚点属于哪个条目」定位。不能再用空行分块：MANUAL-EXCERPTS
      // 中的相邻摘录允许没有空行，按空行会把整段手动摘录一并删掉。
      const anchor = "^" + meta.exId;
      const lines = raw.split("\n");
      // 找锚点行下标
      // v0.16.4 修复 P2-3：嵌套子条目的锚点行是 "> > ^ex-xxx"，旧实现只剥一层 "> "
      //   永远匹配不上 → 子摘录删除后 md 条目残留。现剥掉所有层级的 "> " 前缀再比对。
      const normLine = (s) => s.trim().replace(/(?:^>\s*)+/g, "");
      let aIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (normLine(lines[i]) === anchor) { aIdx = i; break; }
      }
      if (aIdx < 0) return false;

      const unwrap = (line) => String(line || "").replace(/^\s*(?:>\s*)+/, "").trim();
      const isEntryStart = (line) => {
        const text = unwrap(line);
        return /^\[!lmb-excerpt\]/i.test(text) || /^\[\[[^\]]+\.pdf#page=/i.test(text);
      };
      const isRegionBoundary = (line) => /<!--\s*LMB:(?:BEGIN|END|MANUAL-EXCERPTS:BEGIN|MANUAL-EXCERPTS:END)\s*-->/i.test(line || "");

      // 优先取外层 lmb-excerpt callout；旧格式没有外层时才回退到 PDF 链接行。
      let start = aIdx;
      let fallbackStart = -1;
      for (let i = aIdx; i >= 0; i--) {
        if (isRegionBoundary(lines[i])) break;
        if (!isEntryStart(lines[i])) continue;
        if (/^\[!lmb-excerpt\]/i.test(unwrap(lines[i]))) { start = i; break; }
        if (fallbackStart < 0) fallbackStart = i;
      }
      if (start === aIdx && fallbackStart >= 0) start = fallbackStart;

      // 下一条摘录的开头就是当前条目的硬边界；不存在则止于受控区域边界。
      let end = lines.length;
      for (let i = aIdx + 1; i < lines.length; i++) {
        if (isEntryStart(lines[i]) || isRegionBoundary(lines[i])) { end = i; break; }
      }
      // 只顺带移除条目后的空行，绝不跨越下一条摘录或区域标记。
      while (end > start && lines[end - 1].trim() === "") end--;

      const removed = lines.slice(start, end);
      if (!removed.length) return false;
      if (!trash || !trash.dir) throw new Error("未建立可恢复回收目录，拒绝修改摘录文档");
      await this.app.vault.adapter.write(
        normalizePath(trash.dir + "/excerpt.md"),
        removed.join("\n") + "\n"
      );
      const next = lines.slice(0, start).concat(lines.slice(end)).join("\n");
      // 原子写（v0.9.1 起的标准做法）
      await this.app.vault.adapter.write(mdPath, next);
      return true;
    } catch (err) {
      console.warn("[lmb] removeExcerptFromMd failed:", err);
      return false;
    }
  },

});

/* One resolver for toolbar creation, Canvas synchronization and screenshots. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  lmbStoragePaths(pdfFile, canvasPath) {
    const settings = this.settings || {};
    const path = String(typeof pdfFile === "string" ? pdfFile : pdfFile && pdfFile.path || "").replace(/\\/g, "/");
    const base = path.split("/").pop().replace(/\.pdf$/i, "") || pdfFile && pdfFile.basename;
    if (!base) throw new Error("缺少 PDF 文件路径");
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const central = settings.storageLayout === "central";
    if (!central) return { folder: dir, md: normalizePath((dir ? dir + "/" : "") + base + "-摘录.md"),
      canvas: normalizePath((dir ? dir + "/" : "") + base + ".canvas"), central: false };
    const clean = value => {
      const parts = String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      if (parts.some(part => part === "." || part === ".." || part.startsWith(".") || /[:*?"<>|]/.test(part))) throw new Error("MarginBook 目录无效");
      return parts.join("/");
    };
    const root = clean(settings.storageRoot || "Lucia's Marginbook");
    const source = clean(settings.pdfSourceRoot || "Books/pdf书籍");
    const relative = dir === source ? "" : dir.startsWith(source + "/") ? dir.slice(source.length + 1) : dir;
    const folder = normalizePath([root, relative, base].filter(Boolean).join("/"));
    const binding = settings.storageBindings && settings.storageBindings[path] || {};
    const bound = (candidate, fallback) => {
      if (!candidate) return fallback;
      const value = clean(candidate);
      if (!value.startsWith(root + "/")) throw new Error("MarginBook 文件关联超出工作区");
      return value;
    };
    const canvasMd = canvasPath && binding.canvasDocuments && binding.canvasDocuments[canvasPath];
    return { folder, md: bound(canvasMd || binding.md, folder + "/" + base + "-摘录.md"),
      canvas: bound(binding.canvas, folder + "/" + base + ".canvas"), attachments: folder + "/附件", central: true };
  },

  async lmbEnsureStorageParent(path) {
    const parts = String(path || "").split("/"); parts.pop();
    let current = "";
    for (const part of parts.filter(Boolean)) {
      current = current ? current + "/" + part : part;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try { await this.app.vault.createFolder(current); }
      catch (err) { if (!this.app.vault.getAbstractFileByPath(current)) throw err; }
    }
  }
});

/* 35-plugin-marks —— PDF 回绘标记/颜色语义（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

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
  },

  /**
   * 选区参数 → 页面内矩形数组。这是 buildSelectionParams 的**逆运算**。
   * 口径必须与正向一致：divs = .textLayer 的**直接子元素**。
   * 失败返回 null（由调用方走降级）。
   */
  lmbResolveSelectionRects(pageEl, selection, expectedText, expectedRect) {
    try {
      if (!pageEl || !selection || selection.length !== 4) return null;
      const layer = pageEl.querySelector(".textLayer");
      if (!layer) return null;
      const divs = Array.from(layer.children);
      if (!divs.length) return null;

      const locate = (idx, off) => {
        const div = divs[idx];
        if (!div) return null;
        const w = pageEl.ownerDocument.createTreeWalker(div, 4);
        let acc = 0, n;
        while ((n = w.nextNode())) {
          const len = n.textContent ? n.textContent.length : 0;
          if (acc + len >= off) return { node: n, offset: off - acc };
          acc += len;
        }
        return null; // Invalid offsets must use text lookup, never clamp to another location.
      };

      const s = locate(selection[0], selection[1]);
      const e = locate(selection[2], selection[3]);
      if (!s || !e) return null;
      const r = pageEl.ownerDocument.createRange();
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
      // textLayer 的子元素序号会随 PDF.js 版本、字体解析或文档重载发生漂移。
      // 漂移后的 selection 仍可能构造出合法 Range，但会落在完全无关的文字上；
      // 有 target 时必须核对内容，错误坐标交给文字搜索兜底，不能将错就错。
      const expected = this._lmbNormalizePdfMatchText(expectedText);
      const actual = this._lmbNormalizePdfMatchText(r.toString());
      if (expected && actual !== expected
        && !(expected.length >= 160 && actual.startsWith(expected))) return null;
      const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0.5 && x.height > 0.5);
      if (rects.length && expectedRect && expectedRect.length === 4) {
        const pr = pageEl.getBoundingClientRect();
        const left = Math.min(...rects.map((x) => x.left));
        const top = Math.min(...rects.map((x) => x.top));
        const right = Math.max(...rects.map((x) => x.right));
        const bottom = Math.max(...rects.map((x) => x.bottom));
        const actualX = 100 * ((left + right) / 2 - pr.left) / pr.width;
        const actualY = 100 * ((top + bottom) / 2 - pr.top) / pr.height;
        const savedX = Number(expectedRect[0]) + Number(expectedRect[2]) / 2;
        const savedY = Number(expectedRect[1]) + Number(expectedRect[3]) / 2;
        // 同一短语可能在一页出现多次，仅文字一致仍不足以证明身份；
        // 保存时的页面百分比位置相差过大，也必须判定 selection 已漂移。
        if (pr.width && pr.height && (Math.abs(actualX - savedX) > 8 || Math.abs(actualY - savedY) > 8)) return null;
      }
      return rects.length ? rects : null;
    } catch (_) { return null; }
  },

  _lmbNormalizePdfMatchText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  },

  /** 在 textLayer 中查找文字，并保留归一化字符到真实文本节点偏移的映射。 */
  _lmbFindPdfTextMatch(layer, text, hintRect, pageEl) {
    try {
      let needle = this._lmbNormalizePdfMatchText(text);
      if (!layer || !needle) return null;
      const doc = layer.ownerDocument;
      let haystack = "";
      let positions = [];
      const appendSpace = (node, offset) => {
        if (haystack && haystack.charAt(haystack.length - 1) !== " ") {
          haystack += " "; positions.push({ node, offset });
        }
      };
      for (const div of Array.from(layer.children || [])) {
        const walker = doc.createTreeWalker(div, 4); // NodeFilter.SHOW_TEXT
        const nodes = []; let node;
        while ((node = walker.nextNode())) nodes.push(node);
        if (!nodes.length) continue;
        appendSpace(nodes[0], 0);
        for (const textNode of nodes) {
          const raw = String(textNode.textContent || "");
          for (let i = 0; i < raw.length; i++) {
            if (/\s/.test(raw.charAt(i))) appendSpace(textNode, i);
            else { haystack += raw.charAt(i).toLowerCase(); positions.push({ node: textNode, offset: i }); }
          }
        }
      }
      let index = haystack.indexOf(needle);
      if (index < 0) {
        // Some PDF.js versions split words into individual text-layer spans.
        // The separator above must not turn “models” into “m o d e l s”.
        let compact = ""; const mapped = [];
        for (let i = 0; i < haystack.length; i++) {
          if (!/\s/.test(haystack[i])) { compact += haystack[i]; mapped.push(positions[i]); }
        }
        haystack = compact; positions = mapped; needle = needle.replace(/\s/g, "");
        index = haystack.indexOf(needle);
        if (index < 0) return null;
      }
      let best = null, bestDistance = Infinity;
      while (index >= 0) {
        const start = positions[index], last = positions[index + needle.length - 1];
        const candidate = start && last ? { start, end: { node: last.node, offset: last.offset + 1 } } : null;
        if (candidate && hintRect && hintRect.length === 4 && pageEl && doc.createRange) {
          const range = doc.createRange();
          range.setStart(candidate.start.node, candidate.start.offset);
          range.setEnd(candidate.end.node, candidate.end.offset);
          const rr = range.getBoundingClientRect();
          const pr = pageEl.getBoundingClientRect();
          const x = pr.width ? 100 * ((rr.left + rr.right) / 2 - pr.left) / pr.width : 0;
          const y = pr.height ? 100 * ((rr.top + rr.bottom) / 2 - pr.top) / pr.height : 0;
          const hx = Number(hintRect[0]) + Number(hintRect[2]) / 2;
          const hy = Number(hintRect[1]) + Number(hintRect[3]) / 2;
          const distance = (x - hx) * (x - hx) + (y - hy) * (y - hy);
          if (distance < bestDistance) { best = candidate; bestDistance = distance; }
        } else if (candidate) return candidate;
        index = haystack.indexOf(needle, index + 1);
      }
      return best;
    } catch (_) { return null; }
  },

  /** 旧摘录没有 rect 或 selection 已漂移时，按摘录文字在当前文本层中兜底定位。 */
  lmbResolveEntryTextRects(pageEl, text, hintRect) {
    try {
      const layer = pageEl && pageEl.querySelector(".textLayer");
      const target = String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
      if (!layer || target.length < 2) return null;
      const match = this._lmbFindPdfTextMatch(layer, target, hintRect, pageEl);
      if (!match) return null;
      const range = pageEl.ownerDocument.createRange();
      range.setStart(match.start.node, match.start.offset);
      range.setEnd(match.end.node, match.end.offset);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > .5 && r.height > .5);
      return rects.length ? rects : null;
    } catch (_) {}
    return null;
  },

  /** #rrggbb → rgba()，失败返回 null */
  lmbHexToRgba(hex, alpha) {
    const h = String(hex || "").replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  },

  /**
   * 标记颜色：优先用 colorMap 反查（tag → hex）。
   * parseColorMap 给的是 hex → tag，这里倒过来查。
   * 没映射就用默认柔和黄。
   */
  lmbMarkColor(entry) {
    try {
      const explicit = entry && entry.exId && this.settings && this.settings.excerptColors && this.settings.excerptColors[entry.exId];
      const direct = this.lmbHexToRgba(explicit, 0.42);
      if (direct) return direct;
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
  },

  /** 画单条摘录的标记（跨行会有多个矩形，每个矩形一个 div） */
  lmbDrawEntryMark(pageEl, entry, destination) {
    if (entry && (entry.pageNote || entry.inkNote)) return;
    try {
      let pcts = null;
      if (entry && entry.selection) {
        const rects = this.lmbResolveSelectionRects(pageEl, entry.selection, entry.target || "", entry.rect);
        if (rects) pcts = this.lmbRectsToPercents(rects, pageEl);
      }
      if (!pcts && entry && (entry.target || entry.text)) {
        const textRects = this.lmbResolveEntryTextRects(pageEl, entry.target || entry.text, entry.rect);
        if (textRects) pcts = this.lmbRectsToPercents(textRects, pageEl);
      }
      // 文字 selection 索引因 PDF 文本层版本变化失效时，优先使用摘录时保存的
      // 页面百分比矩形，不再画到页面左上角的降级细条。
      if (!pcts && entry && entry.rect && entry.rect.length === 4) {
        // 截图摘录：rect 就是页面百分比，直接用——不需要 textLayer，
        // 虚拟化（未渲染）的页也能画。这是"截图摘录在 PDF 里没标记"的修复。
        const [l, t, w, h] = entry.rect;
        if (w > 0 && h > 0) pcts = [{ left: l, top: t, width: w, height: h }];
      }

      const frag = document.createDocumentFragment();
      if (pcts && pcts.length) {
        const bg = this.lmbMarkColor(entry);
        for (let pi = 0; pi < pcts.length; pi++) {
          const p = pcts[pi];
          const d = document.createElement("div");
          d.className = "lmb-mark";
          // 只有“纯图片摘录”才允许使用区域边框。文字摘录即使自动附带了截图，
          // 仍必须按文字语义显示为荧光笔底色，不能误判成图片后画虚线框。
          const entryText = String(entry && entry.text || "").trim();
          const imageOnly = !!(entry && entry.imagePath
            && (!entryText || /^（(?:矩形图像选区|图片摘录|图片)）$/.test(entryText)));
          const imageMark = !!(imageOnly && (!this.settings || this.settings.imageExcerptMarkStyle !== "highlight"));
          if (imageMark) d.classList.add("lmb-mark-image");
          if (pi === 0 && entry.pageOrdinal) d.setAttribute("data-no", String(entry.pageOrdinal));
          if (entry.exId) d.setAttribute("data-ex", entry.exId);
          // 反向跳转（P3 双击）需要知道来源摘录文档
          if (entry.sourceMd) d.setAttribute("data-src", entry.sourceMd);
          if (entry.tags && entry.tags.length) d.setAttribute("data-tag", entry.tags.join(" "));
          d.style.left = p.left + "%";
          d.style.top = p.top + "%";
          d.style.width = p.width + "%";
          d.style.height = p.height + "%";
          d.style.background = imageMark ? "transparent" : bg;
          if (imageMark) d.style.borderColor = this.lmbHexToRgba((this.settings && this.settings.excerptColors && this.settings.excerptColors[entry.exId]) || "#65c692", 0.95) || "rgba(101,198,146,.95)";
          frag.appendChild(d);
        }
      } else {
        // 降级：缺坐标或 span 对不上 → 页顶细条（绝不静默消失）
        const bar = document.createElement("div");
        bar.className = "lmb-mark";
        bar.setAttribute("data-fallback", "1");
        if (entry && entry.exId) bar.setAttribute("data-ex", entry.exId);
        if (entry && entry.pageOrdinal) bar.setAttribute("data-no", String(entry.pageOrdinal));
        if (entry && entry.sourceMd) bar.setAttribute("data-src", entry.sourceMd);
        bar.style.background = "rgba(140,140,140,0.55)";
        bar.title = "此处有摘录，但无法精确定位（缺 selection 或文本层对不上）";
        frag.appendChild(bar);
      }
      (destination || pageEl).appendChild(frag);
    } catch (_) { /* 单条失败不影响其他条 */ }
  },

  /** 性能守卫：摘录很多时只画视口附近的页 */
  lmbPageNearViewport(pageEl) {
    try {
      const r = pageEl.getBoundingClientRect();
      const h = window.innerHeight || 800;
      return r.bottom > -2 * h && r.top < 3 * h;
    } catch (_) { return true; }
  },

  /** 清掉一个容器内的全部标记 */
  lmbClearMarks(containerEl) {
    try {
      if (!containerEl) return;
      const marks = containerEl.querySelectorAll(".lmb-mark");
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        if (m.parentNode) m.parentNode.removeChild(m);
      }
      const pages = containerEl.querySelectorAll("div.page");
      for (let i = 0; i < pages.length; i++) delete pages[i]._lmbMarkSignature;
    } catch (_) { /* noop */ }
  },

  /** 画一个 PDF 视图的全部标记 */
  lmbDrawMarksForView(view) {
    try {
      if (!view || !view.containerEl) return;
      const container = view.containerEl;

      const file = view.file;
      if (!file) return;
      // v0.12.0 根因修复：「有时显示/不显示/延迟显示」的根子在这里——
      //   旧版把 lmbSetupObserver 放在函数最末，而「页面还没渲染」（pages.length===0）
      //   会提前 return → Observer 从未挂上 → 之后 pdf.js 渲染出页面也没人触发重画，
      //   只能等下一次 layout-change / 切标签碰运气补画。
      //   现在只要有文件就先挂 Observer（幂等），页面渲染/虚拟化的瞬间都会自动重画。
      this.lmbSetupObserver(view);
      const entries = this._lmbGetPdfSidebarEntries ? this._lmbGetPdfSidebarEntries(file) : this.getExcerptsForPdf(file.path);
      if (!entries || !entries.length) { this.lmbClearMarks(container); this.lmbDisconnectObserver(view); return; }

      const pages = container.querySelectorAll("div.page");
      if (!pages.length) return;   // 还没渲染（僵尸 leaf / 刚打开）→ Observer 已挂，渲染瞬间自动重画

      const guard = entries.length > 200;   // 性能守卫
      const byPage = new Map();
      for (const entry of entries) {
        const page = Number(entry && entry.page);
        if (!page) continue;
        if (!byPage.has(page)) byPage.set(page, []);
        byPage.get(page).push(entry);
      }

      for (let i = 0; i < pages.length; i++) {
        const pageEl = pages[i];
        const num = parseInt(pageEl.getAttribute("data-page-number") || "", 10);
        if (!num) continue;
        if (guard && !this.lmbPageNearViewport(pageEl)) continue;
        const list = byPage.get(num) || [];
        // v0.16.5 修复 R2：旧版在循环开头无条件要求 .textLayer，把**不依赖文本层**
        //   的截图摘录（rect 条目）一起挡掉了 —— 与 lmbDrawEntryMark「rect 是页面
        //   百分比，虚拟化（未渲染文本层）的页也能画」的实现承诺自相矛盾。
        //   现在按条目类型分流：rect 条目只要 .page 在就画；selection 条目才要求文本层
        //   （虚拟化页没有文本层时跳过，等它进入视口、observer 触发后自然重画）。
        const textLayer = pageEl.querySelector(".textLayer"), hasLayer = !!textLayer;
        const signature = JSON.stringify([
          pageEl.clientWidth || 0, pageEl.clientHeight || 0,
          textLayer && textLayer.childElementCount || 0,
          this.settings && this.settings.imageExcerptMarkStyle,
          list.map((e) => [e.exId, e.selection, e.rect, e.target, e.color,
            this.settings && this.settings.excerptColors && this.settings.excerptColors[e.exId]])
        ]);
        if (pageEl._lmbMarkSignature === signature
          && (!list.length || pageEl.querySelector(".lmb-mark"))) continue;
        const oldMarks = pageEl.querySelectorAll(".lmb-mark");
        // Measure all excerpts before changing the page DOM to avoid repeated layouts.
        const nextMarks = pageEl.ownerDocument.createDocumentFragment();
        for (let ei = 0; ei < list.length; ei++) {
          const e = Object.assign({}, list[ei], { pageOrdinal: ei + 1 });
          if (e.pageNote) continue; // Page notes have their own text block, no excerpt highlight/fallback mark.
          const rectOnly = !!(e.rect && e.rect.length === 4 && e.rect[2] > 0 && e.rect[3] > 0);
          if (!hasLayer && !rectOnly) continue;
          this.lmbDrawEntryMark(pageEl, e, nextMarks);
        }
        for (let mi = 0; mi < oldMarks.length; mi++) oldMarks[mi].remove();
        pageEl.appendChild(nextMarks);
        pageEl._lmbMarkSignature = signature;
      }
      // v0.12.0：Observer 已在函数开头挂过（幂等），这里不再重复
      for (const leaf of this.app.workspace.getLeavesOfType("pdf") || []) {
        if (leaf._lmbSelectedExcerpt && leaf.view === view) this.lmbSyncPdfNoteSelection(leaf);
      }
    } catch (err) {
      console.warn("[lmb] lmbDrawMarksForView error:", err);
    }
  },

  /**
   * 挂 MutationObserver 驱动重画。
   * pdf.js 虚拟化会不断增删 .page / .textLayer，所以必须盯着。
   * **关键**：要过滤掉我们自己造成的变动（append .lmb-mark），否则无限重画。
   */
  lmbSetupObserver(view) {
    try {
      if (!view || !view.containerEl || view._ppdMarkObserver) return;
      const target = LmbPdfAdapter.viewer(view);
      if (!target) return;
      /* v0.16.6 P1-6：防抖 timer 必须挂在 view 上，**不能**用闭包局部变量。
       *   lmbDisconnectObserver 清的是 view._ppdMarkTimer —— 若 timer 只是闭包变量，
       *   那段清理就是永远够不到的死代码：disconnect 之后 pending 的回调照样落地，
       *   调 lmbDrawMarksForView → 184 行又把 observer 挂回来（自我复活）；
       *   插件已卸载时同样会复活一个没人能回收的 observer。 */
      view._ppdMarkTimer = null;
      const ob = new MutationObserver((records) => {
        let relevant = false;
        for (const rec of records) {
          const scan = (list) => {
            for (let i = 0; i < list.length; i++) {
              const n = list[i];
              if (LmbPdfAdapter.isRelevantMutation(n)) return true;
            }
            return false;
          };
          if (scan(rec.addedNodes) || scan(rec.removedNodes)) { relevant = true; break; }
        }
        if (!relevant) return;
        if (view._ppdMarkTimer) clearTimeout(view._ppdMarkTimer);
        view._ppdMarkTimer = setTimeout(() => {
          view._ppdMarkTimer = null;
          // v0.16.6：已被 disconnect（无摘录的 PDF / 插件卸载）→ 不再自我复活
          if (!view._ppdMarkObserver) return;
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
  },

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
  },

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
  },

  /** 防抖刷新（布局变化 / 切标签 / 索引更新都走这里） */
  lmbScheduleMarksRefresh(delay) {
    try {
      if (this._ppdMarksTimer) clearTimeout(this._ppdMarksTimer);
      this._ppdMarksTimer = setTimeout(() => {
        this._ppdMarksTimer = null;
        this.lmbRefreshAllMarks();
      }, delay == null ? 200 : delay);
    } catch (_) { /* noop */ }
  },

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
  },

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
  },

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
  },

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
  },

});

/* 38-plugin-pdf-sidebar —— PDF 独立占位批注边页（原型混入） */
Object.assign(LuciasMarginBookPlugin.prototype, {
  _lmbSidebarSummary(note, excerpt) {
    // Plain text only: the compact label must never render Markdown/HTML markup.
    const firstLine = (value) => String(value || "").replace(/<!--[\s\S]*?-->/g, "")
      .split(/\r?\n/).map((line) => line.trim())
      .find((line) => line && !/^(?:[-*_]\s*){3,}$/.test(line) && !/^>*\s*\[![^\]]+\]/.test(line));
    const clean = (value) => String(value || "")
      .replace(/!?(?:\[([^\]]*)\]\([^)]*\))/g, "$1")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
      .replace(/<[^>]+>/g, "").replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)?/, "")
      .replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
    return clean(firstLine(note)) || clean(firstLine(excerpt)) || "无文字批注";
  },

  _lmbGetActivePdfLeaf() {
    try {
      const active = this.app.workspace.activeLeaf || null;
      const leaves = this.app.workspace.getLeavesOfType ? this.app.workspace.getLeavesOfType("pdf") : [];
      if (active && active.view && active.view.getViewType && active.view.getViewType() === "pdf") return active;
      const file = this.app.workspace.getActiveFile ? this.app.workspace.getActiveFile() : null;
      if (file && file.extension === "pdf") {
        const hit = leaves.find((l) => l && l.view && l.view.file && l.view.file.path === file.path);
        if (hit) return hit;
      }
      return leaves.find((l) => l && l.containerEl && l.containerEl.closest(".is-active")) || (leaves.length === 1 ? leaves[0] : null);
    } catch (_) { return null; }
  },

  lmbSchedulePdfSidebarRefresh(delay) {
    if (this._lmbPdfSidebarTimer) clearTimeout(this._lmbPdfSidebarTimer);
    this._lmbPdfSidebarTimer = setTimeout(() => {
      this._lmbPdfSidebarTimer = null;
      this.lmbRenderActivePdfSidebar().catch((err) => console.warn("[lmb] pdf sidebar refresh failed:", err));
    }, typeof delay === "number" ? delay : 180);
  },

  /**
   * Padding changes do not reliably reach Obsidian's PDF.js resize handler.
   * Notify it after the browser has committed the new content width, then once
   * more after PDF.js' asynchronous toolbar/viewer layout has settled.
   */
  _lmbNotifyPdfSidebarLayout(leaf, immediate) {
    try {
      const host = leaf && leaf.containerEl && leaf.containerEl.querySelector(".lmb-pdf-sidebar-host");
      if (!host) return;
      const win = host.ownerDocument && host.ownerDocument.defaultView
        ? host.ownerDocument.defaultView : (typeof window !== "undefined" ? window : null);
      if (!win) return;
      if (host._lmbSidebarLayoutFrame) win.cancelAnimationFrame(host._lmbSidebarLayoutFrame);
      if (host._lmbSidebarLayoutTimer) win.clearTimeout(host._lmbSidebarLayoutTimer);
      const notify = () => {
        // Reading clientWidth commits the padding/class change before PDF.js
        // measures .pdf-viewer-container in its resize listener.
        void host.clientWidth;
        // A sidebar only changes this PDF's width. A global resize also asks
        // every Markdown preview to reapply its saved scroll position.
        const child = leaf.view && leaf.view.viewer && leaf.view.viewer.child;
        try {
          if (child && typeof child.onResize === "function") child.onResize();
          else if (child && child.pdfViewer && child.pdfViewer.eventBus)
            child.pdfViewer.eventBus.dispatch("resize", { source: child });
        } catch (_) {}
      };
      const afterFrame = () => {
        host._lmbSidebarLayoutFrame = 0;
        notify();
        host._lmbSidebarLayoutTimer = win.setTimeout(() => {
          host._lmbSidebarLayoutTimer = 0;
          notify();
        }, 120);
      };
      if (immediate) afterFrame();
      else host._lmbSidebarLayoutFrame = win.requestAnimationFrame(afterFrame);
    } catch (_) {}
  },

  _lmbClearPdfSidebars() {
    try {
      document.querySelectorAll(".lmb-pdf-excerpt-sidebar").forEach((bar) => bar.remove());
      document.querySelectorAll(".lmb-sidebar-state-toggle").forEach((button) => button.remove());
      document.querySelectorAll(".lmb-pdf-sidebar-host").forEach((host) => {
        if (host._lmbSidebarToolbarObserver) host._lmbSidebarToolbarObserver.disconnect();
        const win = host.ownerDocument && host.ownerDocument.defaultView;
        if (win && host._lmbSidebarLayoutFrame) win.cancelAnimationFrame(host._lmbSidebarLayoutFrame);
        if (win && host._lmbSidebarLayoutTimer) win.clearTimeout(host._lmbSidebarLayoutTimer);
        host._lmbSidebarToolbarObserver = null;
        host._lmbSidebarLayoutFrame = 0;
        host._lmbSidebarLayoutTimer = 0;
        delete host._lmbSidebarVisible;
        host.removeClass("lmb-pdf-sidebar-host");
        host.style.removeProperty("--lmb-pdf-sidebar-width");
        host.style.removeProperty("--lmb-pdf-sidebar-top");
      });
    } catch (_) {}
  },

  lmbEnsurePdfSidebarEl(leaf) {
    try {
      if (!leaf || !leaf.containerEl) return null;
      const host = leaf.containerEl.querySelector(":scope > .view-content") || leaf.containerEl.querySelector(".view-content") || leaf.containerEl;
      host.addClass("lmb-pdf-sidebar-host");
      let stateToggle = host.querySelector(":scope > .lmb-sidebar-state-toggle");
      if (!stateToggle) {
        stateToggle = host.createEl("button", { cls: "lmb-sidebar-state-toggle", attr: { type: "button" } });
        stateToggle.onclick = event => { event.preventDefault(); event.stopPropagation(); this.lmbSetPdfSidebarVisible(leaf, leaf._lmbPdfSidebarOpen === false); };
      }
      this.lmbSyncSidebarToggle(leaf, stateToggle);
      const initialWidth = Math.max(260, Math.min(560, Number(this._lmbPdfSidebarWidth) || 340));
      host.style.setProperty("--lmb-pdf-sidebar-width", initialWidth + "px");
      const toolbar = leaf.containerEl.querySelector(".pdf-toolbar");
      const updateTop = () => {
        const hostTop = host.getBoundingClientRect().top;
        const toolbarBottom = toolbar ? toolbar.getBoundingClientRect().bottom : hostTop;
        host.style.setProperty("--lmb-pdf-sidebar-top", Math.max(0, toolbarBottom - hostTop) + "px");
      };
      if (host._lmbSidebarToolbarObserver) host._lmbSidebarToolbarObserver.disconnect();
      updateTop();
      if (toolbar && typeof ResizeObserver !== "undefined") {
        host._lmbSidebarToolbarObserver = new ResizeObserver(updateTop);
        host._lmbSidebarToolbarObserver.observe(toolbar);
      }
      let bar = host.querySelector(":scope > .lmb-pdf-excerpt-sidebar");
      if (bar) return bar;
      bar = host.createDiv({ cls: "lmb-pdf-excerpt-sidebar" });
      bar.style.width = initialWidth + "px";
      const grip = bar.createDiv({ cls: "lmb-pdf-sidebar-resizer", attr: { title: "拖动调整批注边页宽度" } });
      grip.onpointerdown = (ev) => {
        ev.preventDefault(); grip.addClass("is-dragging");
        const startX = ev.clientX, startWidth = bar.getBoundingClientRect().width;
        const move = (e) => {
          const width = Math.max(260, Math.min(560, startWidth + startX - e.clientX));
          this._lmbPdfSidebarWidth = width;
          host.style.setProperty("--lmb-pdf-sidebar-width", width + "px");
          bar.style.width = width + "px";
          this._lmbNotifyPdfSidebarLayout(leaf);
        };
        const up = () => {
          grip.removeClass("is-dragging");
          document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", up, true);
          this._lmbNotifyPdfSidebarLayout(leaf, true);
        };
        document.addEventListener("pointermove", move, true); document.addEventListener("pointerup", up, true);
      };
      return bar;
    } catch (_) { return null; }
  },

  lmbSetPdfSidebarVisible(leaf, visible) {
    try {
      if (!leaf || !leaf.containerEl) return false;
      leaf._lmbPdfSidebarOpen = visible !== false;
      const host = leaf.containerEl.querySelector(".lmb-pdf-sidebar-host");
      if (host) host.toggleClass("lmb-pdf-sidebar-closed", !leaf._lmbPdfSidebarOpen);
      if (host) this.lmbSyncSidebarToggle(leaf, host.querySelector(".lmb-sidebar-state-toggle"));
      const toggle = leaf.containerEl.querySelector(".lmb-toolbar-sidebar");
      if (toggle) toggle.toggleClass("is-active", leaf._lmbPdfSidebarOpen);
      if (leaf._lmbPdfSidebarOpen && !host) this.lmbRenderPdfSidebarForLeaf(leaf).catch(() => {});
      else if (host && host._lmbSidebarVisible !== leaf._lmbPdfSidebarOpen) {
        host._lmbSidebarVisible = leaf._lmbPdfSidebarOpen;
        this._lmbNotifyPdfSidebarLayout(leaf);
      }
      return leaf._lmbPdfSidebarOpen;
    } catch (_) { return false; }
  },

  lmbSyncSidebarToggle(leaf, button) {
    if (!button) return;
    const open = leaf._lmbPdfSidebarOpen !== false, label = open ? "收起批注侧栏" : "打开批注侧栏";
    button.setText(open ? "›" : "‹");
    button.setAttribute("aria-label", label); button.setAttribute("title", label);
    button.setAttribute("aria-expanded", String(open));
  },

  _lmbSidebarEntryKey(e) {
    return e && e.exId ? "id:" + e.exId : [e && e.pdfPath, e && e.page, e && e.selection, e && e.rect,
      String(e && e.text || "").replace(/\s+/g, " ").trim()].join("|");
  },

  _lmbGetPdfSidebarEntries(file) {
    try {
      if (!file) return [];
      const path = String(file.path || "").replace(/\\/g, "/"), candidates = [];
      if (this.excerptIndex) {
        candidates.push(...(this.getExcerptsForPdf(path) || []));
        try { if (!candidates.length) candidates.push(...(this.getExcerptsForPdf(decodeURIComponent(path)) || [])); } catch (_) {}
      }
      // 完整路径未命中才按同名兼容旧数据，避免不同目录的同名 PDF 串批注。
      if (!candidates.length) {
        const name = String(file.name || "").toLowerCase();
        for (const [p, entries] of this.excerptIndex.entries()) {
          if (String(p || "").replace(/\\/g, "/").split("/").pop().toLowerCase() === name) candidates.push(...(entries || []));
        }
      }
      const quick = this.settings && this.settings.quickExcerpts && this.settings.quickExcerpts[path];
      if (Array.isArray(quick)) candidates.push(...quick.map((e) => Object.assign({ quick: true, pdfPath: path }, e)));
      const seen = new Set();
      return candidates.filter((e) => { const key = this._lmbSidebarEntryKey(e || {}); if (seen.has(key)) return false; seen.add(key); return true; });
    } catch (_) { return []; }
  },

  async _lmbReadSidebarNotes(path) {
    try { const f = path && this.app.vault.getAbstractFileByPath(path); return f ? await this.app.vault.cachedRead(f) : ""; } catch (_) { return ""; }
  },
  _lmbFindSidebarNote(raw, exId) {
    try { const state = raw && exId ? this._lmbExcerptNoteState(raw, exId) : null; return state && state.value ? state.value : ""; } catch (_) { return ""; }
  },

  _lmbCurrentPdfPage(leaf) {
    try {
      const pages = Array.from(leaf.containerEl.querySelectorAll("div.page[data-page-number]"));
      if (!pages.length) return null;
      const viewer = leaf.containerEl.querySelector(".pdf-viewer-container") || leaf.containerEl;
      const vr = viewer.getBoundingClientRect(), y = vr.top + Math.min(vr.height, window.innerHeight) * .42;
      let best = null, dist = Infinity;
      for (const page of pages) {
        const r = page.getBoundingClientRect(), d = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
        if (d < dist) { dist = d; best = page; }
      }
      return best ? parseInt(best.getAttribute("data-page-number"), 10) || null : null;
    } catch (_) { return null; }
  },

  _lmbApplySidebarPageFilter(leaf, forcedPage, preparedBar) {
    try {
      const bar = preparedBar || (leaf && leaf.containerEl && leaf.containerEl.querySelector(".lmb-pdf-excerpt-sidebar"));
      if (!bar) return;
      if (!preparedBar && (bar._lmbSidebarEditor || bar._lmbSidebarOpening)) return;
      const page = forcedPage || (this._lmbPdfSidebarFollow === false ? null : this._lmbCurrentPdfPage(leaf)) || Number(bar.dataset.page) || this._lmbCurrentPdfPage(leaf) || 1;
      bar.dataset.page = String(page);
      const current = this._lmbPdfSidebarView !== "all"; let shown = 0;
      bar.querySelectorAll(".lmb-pdf-sidebar-item").forEach((row) => {
        const visible = !current || Number(row.dataset.page) === page;
        row.toggleClass("is-page-hidden", !visible); if (visible) shown++;
      });
      const sub = bar.querySelector(".lmb-pdf-sidebar-title-sub");
      if (sub) sub.setText(current ? `当前第 ${page} 页 · ${shown} 条` : `全部批注 · ${bar.dataset.total || 0} 条`);
    } catch (_) {}
  },

  lmbApplySidebarCollapsedState(path, exId, collapsed) {
    for (const leaf of this.app.workspace.getLeavesOfType("pdf") || []) {
      if (!leaf.view || !leaf.view.file || leaf.view.file.path !== path) continue;
      const bar = leaf.containerEl.querySelector(".lmb-pdf-excerpt-sidebar");
      if (bar) {
        const row = Array.from(bar.querySelectorAll(".lmb-pdf-sidebar-item")).find((el) => el.dataset.exId === exId);
        if (row) {
          const oldScroll = bar.scrollTop, rect = row.getBoundingClientRect();
          const heading = bar.querySelector(".lmb-pdf-sidebar-title");
          const aboveViewport = rect.bottom <= (heading ? heading.getBoundingClientRect().bottom : bar.getBoundingClientRect().top);
          const hadFocus = row.contains(row.ownerDocument.activeElement);
          row.toggleClass("is-compact", collapsed);
          const shift = aboveViewport ? row.getBoundingClientRect().height - rect.height : 0;
          bar.scrollTop = oldScroll + shift;
          if (hadFocus) {
            const focusTarget = row.querySelector(collapsed ? ".lmb-pdf-sidebar-expand-entry" : ".lmb-pdf-sidebar-header-actions button");
            if (focusTarget) focusTarget.focus({ preventScroll: true });
          }
        }
      }
      leaf.containerEl.querySelectorAll(".lmb-pdf-text-block").forEach((block) => {
        if (block.dataset.exId !== exId) return;
        const toggle = block.querySelector(".lmb-text-sidebar-toggle");
        if (toggle) toggle.setText(collapsed ? "侧栏展开" : "侧栏收起");
      });
    }
  },

  lmbHandlePdfSidebarScroll(ev) {
    if (this._lmbPdfSidebarFollow === false) return;
    const target = ev && ev.target && ev.target.nodeType === 1 ? ev.target : null;
    if (target && target.closest(".lmb-pdf-excerpt-sidebar")) return;
    if (target && !target.closest(".workspace-leaf-content[data-type='pdf']")) return;
    if (this._lmbPdfSidebarPageTimer) clearTimeout(this._lmbPdfSidebarPageTimer);
    this._lmbPdfSidebarPageTimer = setTimeout(() => {
      this._lmbPdfSidebarPageTimer = null; const leaf = this._lmbGetActivePdfLeaf(); if (leaf) this._lmbApplySidebarPageFilter(leaf);
    }, 90);
  },

  _lmbHitPdfMark(ev) {
    try {
      const target = ev.target && ev.target.nodeType === 1 ? ev.target : null;
      const direct = target && target.closest ? target.closest(".lmb-mark[data-ex]") : null;
      if (direct) return direct;
      const page = target && target.closest ? target.closest("div.page") : null;
      if (!page) return null;
      const marks = Array.from(page.querySelectorAll(".lmb-mark[data-ex]"));
      for (let i = marks.length - 1; i >= 0; i--) {
        const r = marks[i].getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) return marks[i];
      }
    } catch (_) {}
    return null;
  },

  lmbHandlePdfSidebarClick(ev) {
    const mark = this._lmbHitPdfMark(ev); if (!mark) return;
    const pageEl = mark.closest("div.page[data-page-number]");
    this.lmbRevealPdfSidebarEntry(mark.getAttribute("data-ex"), pageEl ? parseInt(pageEl.getAttribute("data-page-number"), 10) : null);
  },

  lmbRevealPdfSidebarEntry(exId, page) {
    try {
      const leaf = this._lmbGetActivePdfLeaf(), bar = leaf && leaf.containerEl.querySelector(".lmb-pdf-excerpt-sidebar");
      if (!bar || !exId) return false;
      if (page) this._lmbApplySidebarPageFilter(leaf, page);
      const row = Array.from(bar.querySelectorAll(".lmb-pdf-sidebar-item")).find((el) => el.dataset.exId === exId);
      if (!row) return false;
      this.lmbSelectPdfSidebarEntry(leaf, { exId, page: page || Number(row.dataset.page), _lmbSidebarOrdinal: Number(row.dataset.ordinal) });
      row.scrollIntoView({ behavior: "smooth", block: "center" }); return true;
    } catch (_) { return false; }
  },

  lmbSelectPdfSidebarEntry(leaf, entry) {
    if (!leaf || !entry) return;
    leaf._lmbSelectedExcerpt = { exId: entry.exId, pdfPath: leaf.view.file.path, page: entry.page, ordinal: entry._lmbSidebarOrdinal };
    this.lmbSyncPdfNoteSelection(leaf);
  },

  lmbSyncPdfNoteSelection(leaf) {
    if (!leaf || !leaf.containerEl) return;
    const selected = leaf._lmbSelectedExcerpt;
    const id = selected && leaf.view && leaf.view.file && selected.pdfPath === leaf.view.file.path ? selected.exId : null;
    leaf.containerEl.querySelectorAll(".lmb-pdf-sidebar-item").forEach(row => {
      row.classList.toggle("is-active", !!id && row.dataset.exId === id);
      if (id && row.dataset.exId === id) selected.ordinal = Number(row.dataset.ordinal) || selected.ordinal;
    });
    leaf.containerEl.querySelectorAll(".lmb-mark").forEach(mark => mark.classList.toggle("lmb-note-selected", !!id && mark.getAttribute("data-ex") === id));
    leaf.containerEl.querySelectorAll(".lmb-pdf-text-block").forEach(block => {
      const on = !!id && block.dataset.exId === id;
      block.classList.toggle("lmb-note-selected", on);
      if (on) block.dataset.lmbBadge = this.lmbInkLinkLabel(leaf.view.file.path, id) || `P.${selected.page || "?"} · ${selected.ordinal || "批注"}`;
    });
    this.lmbFocusLinkedInk(leaf, id);
  },

  _lmbHighlightPdfSidebarTarget(exId, on, leaf) {
    try {
      const root = leaf ? leaf.containerEl : document;
      root.querySelectorAll(".lmb-mark").forEach(m => m.classList.toggle("lmb-mark-sidebar-active", !!on && m.getAttribute("data-ex") === exId));
      root.querySelectorAll(".lmb-pdf-text-block").forEach(b => b.classList.toggle("lmb-note-hover", !!on && b.dataset.exId === exId));
    } catch (_) {}
  },

  async lmbOpenExcerptInCanvas(exId) {
    const navigation = this._lmbBeginNavigation();
    try {
      if (!exId) return false;
      let loc = this.excerptCanvasIndex && this.excerptCanvasIndex.get(exId);
      // 索引可能刚好晚于 Canvas 落盘；未命中时定点补扫一次所有 Canvas。
      if (!loc && this.app.vault.getFiles) {
        const files = this.app.vault.getFiles().filter((f) => f.extension === "canvas");
        for (const file of files) {
          await this.lmbIndexCanvasFile(file);
          if (!this._lmbNavigationCurrent(navigation)) return false;
          loc = this.excerptCanvasIndex && this.excerptCanvasIndex.get(exId);
          if (loc) break;
        }
      }
      if (!loc || !loc.canvasPath || !loc.nodeId) {
        new Notice("MarginBook: 没有找到包含该摘录的 Canvas 卡片"); return false;
      }
      const file = this.app.vault.getAbstractFileByPath(loc.canvasPath);
      if (!(file instanceof TFile)) { new Notice("MarginBook: Canvas 文件已不存在"); return false; }
      const ok = await this.lmbFocusCanvasNode(file, loc.nodeId, navigation);
      if (!ok && this._lmbNavigationCurrent(navigation)) new Notice("MarginBook: 已打开 Canvas，但没有找到对应卡片");
      return ok;
    } catch (err) { console.warn("[lmb] canvas excerpt locate failed:", err); return false; }
    finally { this._lmbEndNavigation(navigation); }
  },

  async lmbDeleteSidebarExcerpt(entry, leaf) {
    const e = entry || {};
    if (!e.exId) { new Notice("该摘录缺少稳定标识，未执行删除"); return false; }
    const pdfFile = leaf && leaf.view && leaf.view.file;
    if (e.quick) {
      const path = String((pdfFile && pdfFile.path) || e.pdfPath || "").replace(/\\/g, "/");
      const list = this.settings.quickExcerpts && this.settings.quickExcerpts[path];
      const index = Array.isArray(list) ? list.findIndex((item) => item && item.exId === e.exId) : -1;
      if (index < 0) { new Notice("未找到这条简洁摘录"); return false; }
      list.splice(index, 1);
      if (e.pageNote && this.settings.pdfTextBlocks && this.settings.pdfTextBlocks[path]) delete this.settings.pdfTextBlocks[path][e.exId];
      await this.saveSettings();
      this.lmbRefreshAllMarks();
      await this.lmbRenderPdfSidebarForLeaf(leaf);
      new Notice("已删除简洁摘录");
      return true;
    }

    let loc = this.excerptCanvasIndex && this.excerptCanvasIndex.get(e.exId);
    if (!loc && this.app.vault.getFiles) {
      for (const candidate of this.app.vault.getFiles().filter((f) => f.extension === "canvas")) {
        await this.lmbIndexCanvasFile(candidate);
        loc = this.excerptCanvasIndex && this.excerptCanvasIndex.get(e.exId);
        if (loc) break;
      }
    }
    const canvasFile = loc && this.app.vault.getAbstractFileByPath(loc.canvasPath);
    const sourceFile = e.sourceMd && this.app.vault.getAbstractFileByPath(e.sourceMd);
    const owner = canvasFile instanceof TFile ? canvasFile : (sourceFile instanceof TFile ? sourceFile : null);
    if (!owner) { new Notice("找不到该摘录的 Canvas 或 Markdown 来源，未执行删除"); return false; }
    const meta = { exId: e.exId, pdf: e.pdfPath || (pdfFile && pdfFile.path) || "", attach: e.imagePath || null, sourceMd: e.sourceMd || null };

    if (canvasFile instanceof TFile && loc && loc.nodeId) {
      const rd = await this._lmbReadCanvasData(canvasFile);
      if (!rd || !rd.data || !Array.isArray(rd.data.nodes)) { new Notice("无法读取关联 Canvas，未执行删除"); return false; }
      const before = rd.data.nodes.length;
      rd.data.nodes = rd.data.nodes.filter((node) => node && node.id !== loc.nodeId);
      if (rd.data.nodes.length === before) { new Notice("关联 Canvas 卡片已不存在，继续清理摘录记录"); }
      if (Array.isArray(rd.data.edges)) rd.data.edges = rd.data.edges.filter((edge) => edge && edge.fromNode !== loc.nodeId && edge.toNode !== loc.nodeId);
      if (!(await this._lmbWriteCanvasData(canvasFile, rd.data, rd.memCanvas, rd.raw))) { new Notice("无法写入 Canvas，未执行删除"); return false; }
      const nodeMeta = this.nodeMeta && this.nodeMeta.get(canvasFile.path);
      if (nodeMeta) nodeMeta.delete(loc.nodeId); // Prevent the observer from running the same cleanup again.
      if (this.excerptCanvasIndex) this.excerptCanvasIndex.delete(e.exId);
    }

    // A sidebar deletion is an explicit user action, so it always uses the recoverable cascade path.
    await this._lmbCleanupDeletedNodes(owner, [{ id: (loc && loc.nodeId) || e.exId, meta }]);
    if (sourceFile instanceof TFile) await this.reindexFile(sourceFile, true);
    this.lmbRefreshAllMarks();
    await this.lmbRenderPdfSidebarForLeaf(leaf);
    return true;
  },

  async lmbRenderActivePdfSidebar() {
    const leaf = this._lmbGetActivePdfLeaf();
    // 焦点切到 Markdown/Canvas 时保留 PDF 边页；只有插件卸载时才统一清理。
    if (!leaf || !leaf.view || !leaf.view.file) return;
    await this.lmbRenderPdfSidebarForLeaf(leaf);
  },

  async lmbRenderPdfSidebarForLeaf(leaf) {
    try {
      const file = leaf && leaf.view && leaf.view.file; if (!file || file.extension !== "pdf") return;
      const bar = this.lmbEnsurePdfSidebarEl(leaf); if (!bar) return;
      this.lmbSetPdfSidebarVisible(leaf, leaf._lmbPdfSidebarOpen !== false);
      if (bar._lmbSidebarEditor && bar._lmbSidebarEditor._pdfPath !== file.path) {
        delete bar._lmbSidebarEditor; delete bar._lmbSidebarEditingId;
      }
      if (bar._lmbSidebarEditor || bar._lmbSidebarOpening) return;
      const entries = this._lmbGetPdfSidebarEntries(file);
      this.lmbRefreshTextBlocks().catch((err) => console.warn("[lmb] text block refresh failed", err));
      const sourceVersions = new Map();
      for (const e of entries) if (e && e.sourceMd && !sourceVersions.has(e.sourceMd)) {
        const source = this.app.vault.getAbstractFileByPath(e.sourceMd);
        sourceVersions.set(e.sourceMd, source && source.stat ? source.stat.mtime : 0);
      }
      const renderSig = JSON.stringify({
        file: file.path,
        entries: entries.map((e) => [e.exId, e.page, e.text, e.note, e.imagePath, e.tags, e.pageNote, e.inkNote]),
        inkLinks: this.settings.inkExcerptLinks && this.settings.inkExcerptLinks[file.path],
        sources: Array.from(sourceVersions),
        views: this.settings && this.settings.excerptViews,
        // Geometry, font size and compact state do not change sidebar content.
        textPlacements: entries.map((e) => [e.exId, !!(this.settings.pdfTextBlocks && this.settings.pdfTextBlocks[file.path] && this.settings.pdfTextBlocks[file.path][e.exId] && this.settings.pdfTextBlocks[file.path][e.exId].page)]),
        colors: this.settings && this.settings.excerptColors
      });
      const renderToken = {};
      bar._lmbRenderToken = renderToken;
      if (bar._lmbRenderSig === renderSig && bar.querySelector(".lmb-pdf-sidebar-list")) {
        this._lmbApplySidebarPageFilter(leaf);
        this.lmbSyncPdfNoteSelection(leaf);
        return;
      }
      // Build offscreen: never expose unfiltered rows or a blank page counter
      // while source notes and Markdown are still rendering.
      const prepared = bar.ownerDocument.createElement("div");
      prepared.dataset.page = bar.dataset.page || "";
      const grip = bar.querySelector(".lmb-pdf-sidebar-resizer");
      // 保持索引原始顺序，与 PDF 回绘的既有编号一致。不能按来源文档的
      // line 字段重排：不同 Markdown 文件的行号彼此不可比较，会让 PDF
      // 上已经稳定的序号整体洗牌。
      prepared.dataset.total = String(entries.length);
      const pageOrdinals = new Map();
      for (const e of entries) {
        const key = String(e.page || "?");
        const ordinal = (pageOrdinals.get(key) || 0) + 1;
        pageOrdinals.set(key, ordinal); e._lmbSidebarOrdinal = ordinal;
      }
      const head = prepared.createDiv({ cls: "lmb-pdf-sidebar-title" }), titleRow = head.createDiv({ cls: "lmb-pdf-sidebar-title-row" });
      titleRow.createDiv({ cls: "lmb-pdf-sidebar-title-main", text: "PDF 批注" });
      titleRow.createSpan({ cls: "lmb-pdf-sidebar-count", text: String(entries.length) });
      head.createDiv({ cls: "lmb-pdf-sidebar-file", text: file.name });
      head.createDiv({ cls: "lmb-pdf-sidebar-title-sub", text: "" });
      const controls = head.createDiv({ cls: "lmb-pdf-sidebar-controls" });
      const currentBtn = controls.createEl("button", { text: "当前页" }), allBtn = controls.createEl("button", { text: "全部" });
      const followBtn = controls.createEl("button", { cls: "lmb-pdf-sidebar-follow", text: "● 跟随" });
      const sync = () => {
        currentBtn.toggleClass("is-active", this._lmbPdfSidebarView !== "all"); allBtn.toggleClass("is-active", this._lmbPdfSidebarView === "all");
        followBtn.toggleClass("is-active", this._lmbPdfSidebarFollow !== false);
      };
      currentBtn.onclick = () => { this._lmbPdfSidebarView = "current"; sync(); this._lmbApplySidebarPageFilter(leaf, this._lmbCurrentPdfPage(leaf)); };
      allBtn.onclick = () => { this._lmbPdfSidebarView = "all"; sync(); this._lmbApplySidebarPageFilter(leaf); };
      followBtn.onclick = () => { this._lmbPdfSidebarFollow = this._lmbPdfSidebarFollow === false; sync(); };
      sync();
      const search = head.createEl("input", { cls: "lmb-pdf-sidebar-search", attr: { type: "search", placeholder: "搜索摘录或备注…" } });
      const list = prepared.createDiv({ cls: "lmb-pdf-sidebar-list" }), mdCache = new Map(), renderJobs = [];
      for (const e of entries) {
        const row = list.createDiv({ cls: "lmb-pdf-sidebar-item" }); row.dataset.page = String(e.page || ""); row.dataset.exId = e.exId || ""; row.dataset.ordinal = String(e._lmbSidebarOrdinal);
        const textView = this.lmbTextBlockViews(file.path)[e.exId] || {};
        const compact = this.lmbIsTextBlockCollapsed(textView);
        row.toggleClass("is-compact", compact);
        const header = row.createDiv({ cls: "lmb-pdf-sidebar-item-header" });
        header.createDiv({ cls: "lmb-pdf-sidebar-item-title", text: `P.${e.page || "?"} · ${e._lmbSidebarOrdinal}${e.inkNote ? " · 手写" : e.pageNote ? " · 页注" : ""}` });
        const summary = header.createDiv({ cls: "lmb-pdf-sidebar-item-summary" });
        const expandEntry = header.createEl("button", { cls: "lmb-pdf-sidebar-expand-entry", text: "展开", attr: { "aria-label": `在侧栏展开 P.${e.page || "?"} · ${e._lmbSidebarOrdinal}` } });
        expandEntry.onclick = (ev) => { ev.stopPropagation(); this.lmbSetTextBlockCollapsed(e, file.path, false).catch((err) => new Notice("设置保存失败：" + err.message)); };
        if (e.tags && e.tags.length) header.createDiv({ cls: "lmb-pdf-sidebar-item-tags", text: e.tags.map((t) => "#" + t).join(" ") });
        const headerActions = header.createDiv({ cls: "lmb-pdf-sidebar-header-actions" });
        const body = row.createDiv({ cls: "lmb-pdf-sidebar-item-body" });
        const inkLink = this.lmbInkLinks(file.path)[e.exId];
        if (inkLink) {
          const badge = header.createSpan({ cls: "lmb-ink-link-badge", text: this.lmbInkLinkLabel(file.path, e.exId) });
          header.insertBefore(badge, headerActions);
          const preview = body.createDiv({ cls: "lmb-ink-reference lmb-ink-sidebar-reference" });
          renderJobs.push(() => this.lmbRenderInkReference(preview, inkLink.id));
        }
        const cleanText = String(e.text || "").trim();
        let textEl = null;
        if (cleanText) {
          textEl = body.createDiv({ cls: "lmb-pdf-sidebar-item-text lmb-pdf-sidebar-item-text-excerpt markdown-rendered" });
          renderJobs.push(async () => {
            try { await MarkdownRenderer.render(this.app, cleanText, textEl, e.sourceMd || "", this); }
            catch (_) { textEl.setText(cleanText); }
          });
        }
        let imageEl = null;
        if (e.imagePath) {
          const imageFile = this.app.vault.getAbstractFileByPath(e.imagePath)
            || (this._lmbFindAttachmentByName ? this._lmbFindAttachmentByName(e.imagePath) : null);
          if (imageFile instanceof TFile) {
            imageEl = body.createDiv({ cls: "lmb-pdf-sidebar-item-image" });
            imageEl.createEl("img", { attr: { src: this.app.vault.getResourcePath(imageFile), alt: "摘录图片" } });
            imageEl.toggleClass("is-hidden", !!cleanText);
          }
        }
        let note = e.quick ? String(e.note || "") : "";
        if (!e.quick && e.sourceMd) {
          if (!mdCache.has(e.sourceMd)) {
            const raw = await this._lmbReadSidebarNotes(e.sourceMd);
            mdCache.set(e.sourceMd, this._lmbBuildExcerptNoteMap(raw));
          }
          note = mdCache.get(e.sourceMd).get(e.exId) || "";
        }
        const summaryText = this._lmbSidebarSummary(note, cleanText);
        summary.setText(summaryText); summary.setAttribute("title", summaryText);
        if (note) {
          const noteEl = row.createDiv({ cls: "lmb-pdf-sidebar-item-note" });
          const noteBody = noteEl.createDiv({ cls: "lmb-pdf-sidebar-item-note-body markdown-rendered" });
          if (note.length > 300 || note.split("\n").length > 8) {
            noteEl.addClass("is-collapsed"); noteEl.addClass("is-foldable");
            const expand = noteEl.createEl("button", { cls: "lmb-pdf-sidebar-note-expand", text: "展开", attr: { title: "展开备注", "aria-label": "展开备注", "aria-expanded": "false" } });
            expand.onclick = (ev) => {
              ev.stopPropagation(); const collapsed = noteEl.classList.toggle("is-collapsed");
              expand.setText(collapsed ? "展开" : "收起");
              expand.setAttribute("title", collapsed ? "展开备注" : "收起备注");
              expand.setAttribute("aria-label", collapsed ? "展开备注" : "收起备注");
              expand.setAttribute("aria-expanded", String(!collapsed));
            };
          }
          renderJobs.push(async () => {
            try { await MarkdownRenderer.render(this.app, note, noteBody, e.sourceMd || "", this); }
            catch (_) { noteBody.setText(note); }
          });
        }
        const actions = row.createDiv({ cls: "lmb-pdf-sidebar-item-actions" });
        const iconButton = (icon, label, parent = actions) => {
          const button = parent.createEl("button", { cls: "lmb-pdf-sidebar-icon-button", attr: { title: label, "aria-label": label } });
          try { setIcon(button, icon); } catch (_) { button.setText(label.slice(0, 1)); }
          return button;
        };
        const color = iconButton("palette", "修改摘录颜色");
        const place = iconButton("text-cursor-input", textView.page ? "重新放置 Markdown 文本块" : "将 Markdown 备注放到 PDF 页面");
        place.onclick = (ev) => { ev.stopPropagation(); this.lmbStartTextBlockPlacement(Object.assign({}, e, { pdfPath: file.path }), leaf).catch((err) => new Notice("无法放置：" + err.message)); };
        const visibility = iconButton("chevrons-up", "收起为侧栏入口", headerActions);
        visibility.onclick = (ev) => { ev.stopPropagation(); this.lmbSetTextBlockCollapsed(e, file.path, true).catch((err) => new Notice("设置保存失败：" + err.message)); };
        color.onclick = (ev) => { ev.stopPropagation(); this.lmbChooseExcerptColor(e.exId, color); };
        if (inkLink) {
          const canvasInk = iconButton("waypoints", "将手写引用放入 Canvas");
          canvasInk.onclick = ev => { ev.stopPropagation(); this.lmbPutInkReferenceInCanvas(file.path, e.exId).catch(error => new Notice("Canvas 操作失败：" + error.message)); };
        }
        if (imageEl && cleanText) {
          const persistedImage = !!(e.exId && this.settings.excerptViews
            && this.settings.excerptViews[e.exId] === "image");
          imageEl.toggleClass("is-hidden", !persistedImage);
          textEl.toggleClass("is-hidden", persistedImage);
          const view = iconButton(persistedImage ? "file-text" : "image",
            persistedImage ? "显示文字" : "显示图片");
          view.onclick = (ev) => {
            ev.stopPropagation(); const showImage = imageEl.hasClass("is-hidden");
            imageEl.toggleClass("is-hidden", !showImage); textEl.toggleClass("is-hidden", showImage);
            view.empty(); setIcon(view, showImage ? "file-text" : "image");
            view.setAttribute("title", showImage ? "显示文字" : "显示图片");
            view.setAttribute("aria-label", showImage ? "显示文字" : "显示图片");
            if (e.exId) {
              this.settings.excerptViews = this.settings.excerptViews || {};
              this.settings.excerptViews[e.exId] = showImage ? "image" : "text";
              this.saveSettings().catch(() => {});
            }
          };
        }
        if (!e.quick) {
        const openMd = iconButton("notebook-pen", "在摘录文档中定位");
        const openCanvas = iconButton("waypoints", "在 Canvas 中定位");
        const edit = iconButton(note ? "pencil" : "message-square-plus", note ? "编辑备注" : "添加备注");
        openMd.onclick = (ev) => { ev.stopPropagation(); this.lmbOpenExcerptInMd(e.exId, e.sourceMd, leaf); };
        openCanvas.onclick = (ev) => { ev.stopPropagation(); this.lmbOpenExcerptInCanvas(e.exId); };
        edit.onclick = (ev) => {
          ev.stopPropagation(); this.lmbOpenSidebarNoteEditor(Object.assign({}, e, { pdfPath: file.path }), leaf, row);
        };
        }
        if (e.quick) {
          const editQuick = iconButton(note ? "pencil" : "message-square-plus", note ? "编辑备注" : "添加备注");
          editQuick.onclick = (ev) => {
            ev.stopPropagation();
            this.lmbOpenSidebarNoteEditor(Object.assign({}, e, { pdfPath: file.path }), leaf, row);
          };
        }
        const remove = iconButton("trash-2", "删除摘录", headerActions);
        remove.addClass("lmb-pdf-sidebar-delete");
        remove.onclick = (ev) => {
          ev.stopPropagation();
          const message = e.inkNote ? "将删除侧栏中的手写备注记录。原笔迹及已有 Canvas 引用会保留。" : e.pageNote ? "将删除这条页注及其页面文本块。"
            : e.quick
            ? "将删除这条仅保存在 PDF 侧栏的简洁摘录。"
            : "将删除关联的 Canvas 卡片及连线、Markdown 摘录记录和插件管理的截图。它们会先移入 .lmb-trash，方便恢复。";
          new LMBConfirmModal(this.app, {
            title: "删除摘录？", message, confirmText: "删除摘录",
            onConfirm: () => this.lmbDeleteSidebarExcerpt(e, leaf).catch((err) => {
              console.warn("[lmb] sidebar excerpt deletion failed:", err);
              new Notice("删除摘录失败，详情见控制台");
            })
          }).open();
        };
        row.onmouseenter = () => this._lmbHighlightPdfSidebarTarget(e.exId, true, leaf);
        row.onmouseleave = () => this._lmbHighlightPdfSidebarTarget(e.exId, false, leaf);
        const pageEditing = () => Array.from(this._lmbActiveInlineBlocks || []).some(block => leaf.containerEl.contains(block) && block._lmbInlineEditor);
        row.onpointerdown = () => { if (!bar._lmbSidebarEditor && !bar._lmbSidebarSwitch && !pageEditing()) this.lmbSelectPdfSidebarEntry(leaf, e); };
        row.onclick = async () => {
          if (bar._lmbSidebarEditor || bar._lmbSidebarSwitch || pageEditing()) {
            if (!await this.lmbOpenSidebarNoteEditor({ ...e, pdfPath: file.path }, leaf, row)) return;
          }
          this.lmbSelectPdfSidebarEntry(leaf, e);
          if (e.inkNote && inkLink) { await this.lmbLocateInkReference(inkLink.id); return; }
          this.lmbJumpToSelection(e.pdfPath || file.path, e.page, e.selection, e.rect, leaf, e.text);
        };
      }
      for (let i = 0; i < renderJobs.length; i += 8) {
        await Promise.all(renderJobs.slice(i, i + 8).map((job) => job()));
        if (bar._lmbRenderToken !== renderToken) return;
        if (i + 8 < renderJobs.length) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      search.oninput = () => {
        const query = String(search.value || "").trim().toLowerCase();
        list.querySelectorAll(".lmb-pdf-sidebar-item").forEach((row) => row.toggleClass("is-search-hidden", !!query && !row.textContent.toLowerCase().includes(query)));
      };
      if (!entries.length) list.createDiv({ cls: "lmb-pdf-sidebar-empty", text: "当前 PDF 暂无可用批注" });
      if (bar._lmbRenderToken !== renderToken || this._unloaded || leaf.view.file !== file || bar._lmbSidebarEditor || bar._lmbSidebarOpening) return;
      // A collapse click/search/PDF scroll may have happened during preparation.
      list.querySelectorAll(".lmb-pdf-sidebar-item").forEach((row) => {
        row.toggleClass("is-compact", this.lmbIsTextBlockCollapsed(this.lmbTextBlockViews(file.path)[row.dataset.exId]));
      });
      const oldSearch = bar.querySelector(".lmb-pdf-sidebar-search");
      search.value = oldSearch ? oldSearch.value : "";
      search.oninput();
      this._lmbApplySidebarPageFilter(leaf, this._lmbPdfSidebarFollow === false ? Number(bar.dataset.page) || null : null, prepared);
      const oldScroll = bar.scrollTop;
      const oldRows = Array.from(bar.querySelectorAll(".lmb-pdf-sidebar-item"));
      const visibleHeading = bar.querySelector(".lmb-pdf-sidebar-title");
      const barTop = visibleHeading ? visibleHeading.getBoundingClientRect().bottom : bar.getBoundingClientRect().top;
      const anchor = oldRows.find((row) => !row.classList.contains("is-page-hidden") && !row.classList.contains("is-search-hidden") && row.getBoundingClientRect().bottom > barTop);
      const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
      const searchFocused = oldSearch && oldSearch === bar.ownerDocument.activeElement;
      const selection = searchFocused ? [oldSearch.selectionStart, oldSearch.selectionEnd] : null;
      bar.dataset.total = prepared.dataset.total; bar.dataset.page = prepared.dataset.page;
      bar.replaceChildren(...(grip ? [grip] : []), ...Array.from(prepared.children));
      for (const draft of (this._lmbSidebarNoteDrafts || new Map()).values()) {
        if (draft.closed || draft._sidebarBar !== bar || draft._pdfPath !== file.path) continue;
        const freshRow = Array.from(list.querySelectorAll(".lmb-pdf-sidebar-item")).find(row => row.dataset.exId === draft._entry.exId);
        if (freshRow) { freshRow.parentElement.insertBefore(draft._row, freshRow); freshRow.remove(); }
        else list.appendChild(draft._row);
        bar._lmbSidebarEditor = draft; bar._lmbSidebarEditingId = draft._entry.exId;
      }
      bar.scrollTop = oldScroll;
      if (anchor) {
        const replacement = Array.from(list.querySelectorAll(".lmb-pdf-sidebar-item")).find((row) => row.dataset.exId === anchor.dataset.exId);
        if (replacement && !replacement.classList.contains("is-page-hidden") && !replacement.classList.contains("is-search-hidden")) bar.scrollTop += replacement.getBoundingClientRect().top - anchorTop;
      }
      if (searchFocused) { search.focus({ preventScroll: true }); search.setSelectionRange(...selection); }
      bar._lmbRenderSig = renderSig;
      this.lmbSyncPdfNoteSelection(leaf);
    } catch (err) { console.warn("[lmb] render pdf sidebar failed:", err); }
  }
});

/* Editable Markdown overlays. Content stays in the existing excerpt note store;
 * this store contains presentation only, keyed by PDF path and stable excerpt ID. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  async lmbCreatePageNote(leaf, file, page, point, markdown, placement = {}) {
    if (this._unloaded || !leaf.view || leaf.view.file !== file) throw new Error("PDF 已切换，请在目标页面重新创建");
    if (!String(markdown || "").trim()) return null;
    const path = file.path, exId = placement.exId || "page-note-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    const item = { exId, pageNote: true, page, text: "", note: String(markdown) };
    const store = this.settings.quickExcerpts || (this.settings.quickExcerpts = {});
    const list = store[path] || (store[path] = []);
    const views = this.lmbTextBlockViews(path);
    const x = Math.max(0, Math.min(.8, Number(point.x) || 0)), y = Math.max(0, Math.min(.95, Number(point.y) || 0));
    list.push(item); views[exId] = placement.view || { page, x, y, w: Math.min(.6, 1 - x), fontSize: 16 };
    try { await this.saveSettings(); }
    catch (err) { list.splice(list.indexOf(item), 1); delete views[exId]; throw err; }
    try { await this.lmbRefreshTextBlocks(); await this.lmbRenderPdfSidebarForLeaf(leaf); }
    catch (err) { new Notice("备注已保存，预览刷新失败：" + err.message); }
    return item;
  },

  lmbStartPageNote(leaf) {
    const file = leaf && leaf.view && leaf.view.file;
    if (!file || file.extension !== "pdf") { new Notice("请先打开 PDF"); return; }
    if (this._lmbCancelTextPlacement) this._lmbCancelTextPlacement();
    if (this.inkMode) this.lmbSetInkMode(false);
    if (this.rectMode) this.setRectMode(false);
    const root = leaf.containerEl, doc = root.ownerDocument;
    const notice = new Notice("点击 PDF 空白处新建 Markdown 页注；Esc 取消", 0);
    root.classList.add("lmb-text-placing");
    let active = true, placing = false;
    const cancel = () => {
      active = false;
      root.classList.remove("lmb-text-placing"); notice.hide();
      doc.removeEventListener("click", place, true); doc.removeEventListener("keydown", key, true);
      this._lmbCancelTextPlacement = null;
    };
    const key = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); cancel(); } };
    const place = async (ev) => {
      const page = ev.target.closest && ev.target.closest(".page[data-page-number]");
      if (!page || !root.contains(page) || ev.button !== 0 || ev.target.closest(".lmb-pdf-text-block")) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (!active || placing) return;
      placing = true;
      try {
        const sidebar = root.querySelector(".lmb-pdf-excerpt-sidebar");
        if (sidebar && sidebar._lmbSidebarEditor && !await sidebar._lmbSidebarEditor.save()) return;
        for (const block of Array.from(this._lmbActiveInlineBlocks || [])) {
          if (root.contains(block) && block._lmbInlineEditor && !await block._lmbInlineEditor.save()) return;
        }
        if (!active) return;
        if (leaf.view.file !== file) { cancel(); return; }
        const rect = page.getBoundingClientRect();
        const point = { x: (ev.clientX - rect.left) / rect.width, y: (ev.clientY - rect.top) / rect.height };
        const pageNumber = Number(page.dataset.pageNumber);
        cancel();
        const view = { page: pageNumber, x: Math.max(0, Math.min(.8, point.x)), y: Math.max(0, Math.min(.95, point.y)), w: Math.min(.6, 1 - Math.max(0, Math.min(.8, point.x))), fontSize: 16 };
        const entry = { exId: "page-note-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10), pdfPath: file.path, quick: true, pageNote: true };
        const draft = this.lmbCreateTextBlock(page, entry, view);
        draft.addClass("is-draft");
        let created = false;
        this.lmbOpenInlineNoteEditor(draft, { title: `新建页注 · P.${pageNumber}`, autosave: true, pageRoot: root, value: "", sourcePath: file.path,
          onSubmit: async (text) => {
            if (created) await this.lmbSaveTextBlockNote(entry, text);
            else {
              const item = await this.lmbCreatePageNote(leaf, file, pageNumber, point, text, { exId: entry.exId, view });
              created = !!item;
            }
            this.lmbSchedulePdfSidebarRefresh(0);
          },
          onClose: () => { draft.remove(); if (!this._unloaded) this.lmbRefreshTextBlocks().catch(err => new Notice(err.message)); }
        });
        this.lmbStyleTextBlock(draft, page, view);
      } finally { placing = false; }
    };
    this._lmbCancelTextPlacement = cancel;
    // Consume the completed placement click before installing the editor's
    // outside-click listener. Opening on pointerdown lets its trailing click
    // immediately close the empty draft again (including mouse/touch retargeting).
    doc.addEventListener("click", place, true); doc.addEventListener("keydown", key, true);
  },

  lmbTextBlockViews(path) {
    const store = this.settings.pdfTextBlocks || (this.settings.pdfTextBlocks = {});
    return store[path] || (store[path] = {});
  },

  async lmbTextBlockNote(entry) {
    const draft = this._lmbSidebarNoteDrafts && this._lmbSidebarNoteDrafts.get(this.lmbNoteEditorKey(entry));
    if (draft && !draft.closed) return draft.getText();
    if (entry.quick) {
      const list = this.settings.quickExcerpts && this.settings.quickExcerpts[entry.pdfPath];
      const item = Array.isArray(list) && list.find((x) => x.exId === entry.exId);
      return String(item ? item.note || "" : entry.note || "");
    }
    return this._lmbFindSidebarNote(await this._lmbReadSidebarNotes(entry.sourceMd), entry.exId);
  },

  async lmbSaveTextBlockNote(entry, value) {
    if (entry.quick) {
      const list = this.settings.quickExcerpts && this.settings.quickExcerpts[entry.pdfPath];
      const item = Array.isArray(list) && list.find((x) => x.exId === entry.exId);
      if (!item) throw new Error("这条批注已被删除");
      const previous = item.note, next = String(value || ""); item.note = next;
      try { await this.saveSettings(); }
      catch (err) { if (item.note === next) item.note = previous; throw err; }
    } else {
      const source = this.app.vault.getAbstractFileByPath(entry.sourceMd);
      if (!source || !await this.lmbSaveExcerptNote(source, entry.exId, value)) throw new Error("未找到对应摘录，未修改文档");
      await this.reindexFile(source, true);
    }
  },

  async lmbEditTextBlockNote(entry, afterSave, preferredBlock, editEvent) {
    if (this.inkMode) await this.lmbSetInkMode(false);
    try {
      const block = preferredBlock || (this.app.workspace.getLeavesOfType("pdf") || [])
        .filter((leaf) => leaf.view && leaf.view.file && leaf.view.file.path === entry.pdfPath)
        .flatMap((leaf) => Array.from(leaf.containerEl.querySelectorAll(".lmb-pdf-text-block")))
        .find((el) => el.dataset.exId === entry.exId);
      if (block && block._lmbInlineEditor) { block._lmbInlineEditor.input.focus({ preventScroll: true }); return; }
      const sidebarDraft = this._lmbSidebarNoteDrafts && this._lmbSidebarNoteDrafts.get(this.lmbNoteEditorKey(entry));
      if ((!block || !block.isConnected) && sidebarDraft && !sidebarDraft.closed) { sidebarDraft.input.focus({ preventScroll: true }); return; }
      const value = await this.lmbTextBlockNote(entry);
      if (block && block.isConnected) {
        const owner = (this.app.workspace.getLeavesOfType("pdf") || []).find(l => l.containerEl.contains(block));
        if (owner) {
          const bar = owner.containerEl.querySelector(".lmb-pdf-excerpt-sidebar");
          if (bar && bar._lmbSidebarEditor && !await bar._lmbSidebarEditor.save()) { bar._lmbSidebarEditor.input.focus({ preventScroll: true }); return; }
          const editors = Array.from(this._lmbActiveInlineBlocks || []).filter(el => el !== block && owner.containerEl.contains(el) && el._lmbInlineEditor);
          for (const other of editors) if (!await other._lmbInlineEditor.save()) { other._lmbInlineEditor.input.focus({ preventScroll: true }); return; }
          if (!owner.view.file || owner.view.file.path !== entry.pdfPath) return;
        }
        const cursorOffset = editEvent ? this.lmbLivePointerOffset(block.querySelector(".lmb-pdf-text-body"), value, editEvent) : 0;
        this.lmbOpenInlineNoteEditor(block, { title: "实时编辑", autosave: true, pageRoot: owner && owner.containerEl, value, cursorOffset, sourcePath: entry.sourceMd || entry.pdfPath || "",
          onSubmit: async (text) => { await this.lmbSaveTextBlockNote(entry, text); this.lmbSchedulePdfSidebarRefresh(0); },
          onClose: (saved, text) => {
            if (this._unloaded) return;
            this.lmbRefreshTextBlocks().catch((err) => new Notice("预览刷新失败：" + err.message));
            if (saved) { this.lmbSchedulePdfSidebarRefresh(0); if (afterSave) Promise.resolve(afterSave(text)).catch((err) => new Notice(err.message)); }
          }
        });
        return;
      }
      const leaf = (this.app.workspace.getLeavesOfType("pdf") || []).find(l => l.view && l.view.file && l.view.file.path === entry.pdfPath);
      if (leaf) { await this.lmbOpenSidebarNoteEditor(entry, leaf, null, afterSave); return; }
      new LMBExcerptNoteModal(this.app, {
        title: "Markdown 批注", value, sourcePath: entry.sourceMd || "", compact: true,
        onSubmit: async (text) => {
            await this.lmbSaveTextBlockNote(entry, text);
            await this.lmbRefreshTextBlocks();
            this.lmbSchedulePdfSidebarRefresh(0);
            if (afterSave) await afterSave(text);
        }
      }).open();
    } catch (err) { new Notice("无法打开批注：" + err.message); }
  },

  lmbIsTextBlockCollapsed(view) {
    return !!(view && (view.collapsed === undefined ? view.hidden : view.collapsed));
  },

  async lmbSetTextBlockCollapsed(entry, path, collapsed) {
    const views = this.lmbTextBlockViews(path);
    const view = views[entry.exId] || (views[entry.exId] = {});
    view.collapsed = !!collapsed;
    delete view.hidden; // Previous releases hid the row; now it always retains an expand entry.
    this.lmbApplySidebarCollapsedState(path, entry.exId, !!collapsed);
    await this.saveSettings();
  },

  async lmbStartTextBlockPlacement(entry, leaf) {
    if (!entry.exId) return;
    // Placement transitions from drawing to text. Otherwise the active ink
    // capture layer remains above the new block and swallows its edit click.
    if (this.inkMode) await this.lmbSetInkMode(false);
    if (this.rectMode) this.setRectMode(false);
    if (!(await this.lmbTextBlockNote(entry)).trim()) {
      await this.lmbEditTextBlockNote(entry, (text) => text.trim() && this.lmbStartTextBlockPlacement(entry, leaf));
      return;
    }
    if (this._lmbCancelTextPlacement) this._lmbCancelTextPlacement();
    const root = leaf.containerEl, doc = root.ownerDocument;
    const notice = new Notice("点击 PDF 空白处放置文本块；Esc 取消", 0);
    root.classList.add("lmb-text-placing");
    const cancel = () => {
      root.classList.remove("lmb-text-placing"); notice.hide();
      doc.removeEventListener("pointerdown", place, true); doc.removeEventListener("keydown", key, true);
      this._lmbCancelTextPlacement = null;
    };
    const key = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); cancel(); } };
    const place = async (ev) => {
      const page = ev.target.closest && ev.target.closest(".page[data-page-number]");
      if (!page || !root.contains(page) || ev.button !== 0 || ev.target.closest(".lmb-pdf-text-block")) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      const rect = page.getBoundingClientRect(), path = leaf.view.file.path;
      const x = Math.max(0, Math.min(.8, (ev.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(.95, (ev.clientY - rect.top) / rect.height));
      const views = this.lmbTextBlockViews(path);
      Object.assign(views[entry.exId] || (views[entry.exId] = {}), {
        page: Number(page.dataset.pageNumber), x, y, w: Math.min(.55, 1 - x),
        fontSize: Number(views[entry.exId] && views[entry.exId].fontSize) || 16
      });
      if (entry.pageNote) {
        const list = this.settings.quickExcerpts && this.settings.quickExcerpts[path];
        const item = Array.isArray(list) && list.find((e) => e.exId === entry.exId);
        if (item) item.page = Number(page.dataset.pageNumber);
        this.lmbSchedulePdfSidebarRefresh(0);
      }
      cancel();
      try { await this.saveSettings(); await this.lmbRefreshTextBlocks(); }
      catch (err) { new Notice("文本块保存失败：" + err.message); }
    };
    this._lmbCancelTextPlacement = cancel;
    doc.addEventListener("pointerdown", place, true); doc.addEventListener("keydown", key, true);
  },

  async lmbRefreshTextBlocks() {
    for (const leaf of this.app.workspace.getLeavesOfType("pdf") || []) {
      const file = leaf.view && leaf.view.file;
      if (!file) continue;
      await Promise.all(Array.from(leaf.containerEl.querySelectorAll(".page[data-page-number]"),
        (page) => this.lmbRenderTextBlocksOnPage(page, file.path)));
      this.lmbSyncPdfNoteSelection(leaf);
    }
  },

  async lmbRenderTextBlocksOnPage(page, path) {
    const token = {}; page._lmbTextBlockToken = token;
    // PDF.js may recycle a page while it contains an unsaved editor. Reattach
    // that editor (including its draft/caret) when the same page returns.
    for (const block of this._lmbActiveInlineBlocks || []) {
      if (!block.isConnected && block._lmbTextEntry.pdfPath === path && Number(block._lmbTextView.page) === Number(page.dataset.pageNumber)) {
        page.appendChild(block); this.lmbStyleTextBlock(block, page, block._lmbTextView);
        const state = block._lmbInlineEditor;
        if (state && state.observer) { state.observer.disconnect(); state.observer.observe(page); }
      }
    }
    const views = this.settings.pdfTextBlocks && this.settings.pdfTextBlocks[path] || {};
    if (!Object.values(views).some((view) => view && Number(view.page) === Number(page.dataset.pageNumber))) {
      page.querySelectorAll(":scope > .lmb-pdf-text-block").forEach((el) => { if (!el._lmbInlineEditor) el.remove(); });
      this.lmbReleaseTextBlockPage(page);
      return;
    }
    page._lmbTextBlockPath = path;
    const observers = this._lmbTextResizeObservers || (this._lmbTextResizeObservers = new Map());
    if (!observers.has(page) && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        if (!page.isConnected || this._unloaded) { this.lmbReleaseTextBlockPage(page); return; }
        this.lmbRenderTextBlocksOnPage(page, page._lmbTextBlockPath).catch((err) => console.warn("[lmb] text resize failed", err));
      });
      observers.set(page, observer); observer.observe(page);
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    const entries = this._lmbGetPdfSidebarEntries(file);
    const wanted = new Set();
    for (const entry of entries) {
      const view = views[entry.exId];
      if (!view || Number(view.page) !== Number(page.dataset.pageNumber)) continue;
      wanted.add(entry.exId);
      const note = await this.lmbTextBlockNote(Object.assign({}, entry, { pdfPath: path }));
      if (this._unloaded || page._lmbTextBlockToken !== token || !page.isConnected) return;
      let block = Array.from(page.querySelectorAll(":scope > .lmb-pdf-text-block")).find((el) => el.dataset.exId === entry.exId);
      const sourceKey = JSON.stringify([path, entry.sourceMd || "", !!entry.quick]);
      if (block && block._lmbTextSourceKey !== sourceKey && !block._lmbInlineEditor) { block.remove(); block = null; }
      if (!block) block = this.lmbCreateTextBlock(page, Object.assign({}, entry, { pdfPath: path }), view);
      this.lmbStyleTextBlock(block, page, view);
      if (block._lmbInlineEditor) continue;
      const body = block.querySelector(".lmb-pdf-text-body");
      if (body._lmbMarkdown !== note || !body.childNodes.length) {
        body._lmbMarkdown = note; body.empty();
        // Render detached so an older async Markdown render cannot overwrite a newer note.
        const content = page.ownerDocument.createElement("div");
        try { await MarkdownRenderer.render(this.app, note || "*空批注，双击编辑*", content, entry.sourceMd || "", this); }
        catch (_) { content.textContent = note; }
        if (page._lmbTextBlockToken === token && body._lmbMarkdown === note) body.replaceChildren(content);
      }
    }
    if (page._lmbTextBlockToken !== token) return;
    page.querySelectorAll(":scope > .lmb-pdf-text-block").forEach((el) => { if (!wanted.has(el.dataset.exId) && !el._lmbInlineEditor) el.remove(); });
    for (const leaf of this.app.workspace.getLeavesOfType("pdf") || []) {
      if (leaf._lmbSelectedExcerpt && leaf.view && leaf.view.file && leaf.view.file.path === path) this.lmbSyncPdfNoteSelection(leaf);
    }
  },

  lmbStyleTextBlock(block, page, view) {
    block.style.left = (view.x || 0) * 100 + "%";
    const pageHeight = page.getBoundingClientRect().height;
    // Editing must keep the same page anchor, including notes near the bottom.
    const y = view.y || 0;
    block.style.top = y * 100 + "%";
    block.style.width = (view.w || .55) * 100 + "%";
    // 1000 reference units keep type proportional when PDF.js zooms or resizes.
    block.style.fontSize = (view.fontSize || 16) * page.getBoundingClientRect().width / 1000 + "px";
    block.style.setProperty("--lmb-pdf-text-size", block.style.fontSize);
    const body = block.querySelector(".lmb-pdf-text-body");
    body.style.maxHeight = Math.max(24, pageHeight * (1 - y) - 8) + "px";
    body.title = block._lmbInlineEditor ? "点击段落切换源码；Ctrl/Cmd+Enter 保存，Esc 取消" : "点击文字原位编辑 Markdown；长文可在块内滚动";
    block.querySelector("input").value = String(view.fontSize || 16);
    const tools = block.querySelector(".lmb-pdf-text-tools");
    const nearTop = (view.y || 0) * page.getBoundingClientRect().height < Math.max(76, tools.offsetHeight || 0);
    tools.style.bottom = nearTop ? "auto" : "100%";
    tools.style.top = nearTop ? "0" : "auto";
    tools.style.left = Math.min(0, page.getBoundingClientRect().width * (1 - (view.x || 0)) - Math.max(260, tools.offsetWidth || 0)) + "px";
    block.querySelector(".lmb-text-sidebar-toggle").textContent = this.lmbIsTextBlockCollapsed(view) ? "侧栏展开" : "侧栏收起";
    block.classList.toggle("is-note-style", view.style === "note");
  },

  lmbCreateTextBlock(page, entry, view) {
    const block = page.createDiv({ cls: "lmb-pdf-text-block" }); block.dataset.exId = entry.exId;
    block._lmbTextEntry = entry;
    block._lmbTextView = view;
    block._lmbTextSourceKey = JSON.stringify([entry.pdfPath, entry.sourceMd || "", !!entry.quick]);
    block.tabIndex = 0;
    const bar = block.createDiv({ cls: "lmb-pdf-text-tools" });
    const grip = bar.createEl("button", { text: "⠿", attr: { title: "拖动移动文本块", "aria-label": "移动文本块" } });
    const button = (text, action, cls) => {
      const b = bar.createEl("button", { text, cls: cls || "" });
      b.onclick = (ev) => { ev.stopPropagation(); Promise.resolve(action()).catch((err) => new Notice("操作失败：" + err.message)); }; return b;
    };
    const persist = async () => { await this.saveSettings(); this.lmbSchedulePdfSidebarRefresh(0); };
    const size = bar.createEl("input", { attr: { type: "number", min: "8", max: "72", step: "1", "aria-label": "文本块字号（随 PDF 缩放）", title: "字号（随 PDF 缩放）" } });
    size.onchange = async () => {
      view.fontSize = Math.max(8, Math.min(72, Number(size.value) || 16));
      this.lmbStyleTextBlock(block, page, view);
      try { await persist(); } catch (err) { new Notice("字号保存失败：" + err.message); }
    };
    size.oninput = () => {
      const value = Number(size.value);
      if (value >= 8 && value <= 72) size.onchange();
    };
    const adjustSize = (delta) => {
      size.value = String(Math.max(8, Math.min(72, (Number(view.fontSize) || 16) + delta)));
      return size.onchange();
    };
    const smaller = button("A−", () => adjustSize(-1), "lmb-text-size-step");
    smaller.setAttribute("aria-label", "减小字号"); smaller.setAttribute("title", "减小字号");
    const larger = button("A+", () => adjustSize(1), "lmb-text-size-step");
    larger.setAttribute("aria-label", "增大字号"); larger.setAttribute("title", "增大字号");
    button("样式", () => { view.style = view.style === "note" ? "transparent" : "note"; this.lmbStyleTextBlock(block, page, view); return persist(); });
    button("侧栏收起", () => this.lmbSetTextBlockCollapsed(entry, entry.pdfPath, !this.lmbIsTextBlockCollapsed(view)), "lmb-text-sidebar-toggle");
    button("移除", async () => {
      if (block._lmbInlineEditor && !await block._lmbInlineEditor.save()) return;
      delete view.page; block.remove(); await persist(); await this.lmbRefreshTextBlocks();
    });
    const body = block.createDiv({ cls: "lmb-pdf-text-body markdown-rendered" });
    body.addEventListener("click", (ev) => {
      if (block._lmbInlineEditor || ev.ctrlKey || ev.metaKey) return;
      const selection = body.ownerDocument.defaultView && body.ownerDocument.defaultView.getSelection();
      if (selection && !selection.isCollapsed) return;
      const leaf = (this.app.workspace.getLeavesOfType("pdf") || []).find(l => l.view && l.view.file && l.view.file.path === entry.pdfPath);
      if (leaf) this.lmbSelectPdfSidebarEntry(leaf, entry);
      ev.preventDefault(); ev.stopPropagation(); this.lmbEditTextBlockNote(entry, null, block, ev);
    }, true);
    body.ondblclick = (ev) => { ev.stopPropagation(); this.lmbEditTextBlockNote(entry, null, block, ev); };
    // Keep overlay interaction out of PDF selection/ink gestures while preserving text selection.
    ["pointerdown", "click", "dblclick"].forEach((type) => block.addEventListener(type, (ev) => ev.stopPropagation()));
    const resize = block.createDiv({ cls: "lmb-pdf-text-resize", attr: { title: "拖动调整宽度" } });
    const start = (ev, widthOnly) => {
      if (ev.button !== 0) return;
      ev.preventDefault(); ev.stopPropagation();
      const rect = page.getBoundingClientRect(), origin = { x: view.x, y: view.y, w: view.w }, sx = ev.clientX, sy = ev.clientY;
      const control = ev.currentTarget; control.setPointerCapture(ev.pointerId);
      const move = (event) => {
        const dx = (event.clientX - sx) / rect.width, dy = (event.clientY - sy) / rect.height;
        if (widthOnly) view.w = Math.max(.12, Math.min(1 - view.x, origin.w + dx));
        else {
          view.x = Math.max(0, Math.min(1 - view.w, origin.x + dx));
          const height = Math.min(1, block.getBoundingClientRect().height / rect.height);
          view.y = Math.max(0, Math.min(1 - height, origin.y + dy));
        }
        this.lmbStyleTextBlock(block, page, view);
      };
      const finish = () => {
        control.removeEventListener("pointermove", move); control.removeEventListener("pointerup", finish);
        control.removeEventListener("pointercancel", cancel);
        persist().catch((err) => new Notice("位置保存失败：" + err.message));
      };
      const cancel = () => { Object.assign(view, origin); this.lmbStyleTextBlock(block, page, view); finish(); };
      control.addEventListener("pointermove", move); control.addEventListener("pointerup", finish); control.addEventListener("pointercancel", cancel);
    };
    grip.onpointerdown = (ev) => start(ev, false); resize.onpointerdown = (ev) => start(ev, true);
    return block;
  },

  lmbSetupTextBlocks() {
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!file || file.extension !== "pdf") return;
      const store = this.settings.pdfTextBlocks;
      if (store && store[oldPath]) {
        store[file.path] = Object.assign({}, store[oldPath], store[file.path]); delete store[oldPath];
        const quick = this.settings.quickExcerpts;
        if (quick && quick[oldPath]) { quick[file.path] = (quick[file.path] || []).concat(quick[oldPath]); delete quick[oldPath]; }
        this.saveSettings().then(() => this.lmbRefreshTextBlocks()).catch((err) => new Notice("文本块路径更新失败：" + err.message));
      }
    }));
    this.register(() => {
      if (this._lmbCancelTextPlacement) this._lmbCancelTextPlacement();
      for (const block of Array.from(this._lmbActiveInlineBlocks || [])) if (block._lmbInlineEditor) block._lmbInlineEditor.close(false);
      for (const block of Array.from(this._lmbActiveSidebarNoteBlocks || [])) if (block._lmbInlineEditor) block._lmbInlineEditor.close(false);
      if (this._lmbSidebarNoteDrafts) this._lmbSidebarNoteDrafts.clear();
      for (const observer of (this._lmbTextResizeObservers || new Map()).values()) observer.disconnect();
      if (this._lmbTextResizeObservers) this._lmbTextResizeObservers.clear();
      document.querySelectorAll(".lmb-pdf-text-block").forEach((el) => { if (el._lmbInlineEditor) el._lmbInlineEditor.close(false); el.remove(); });
    });
  },

  lmbReleaseTextBlockPage(page) {
    const observers = this._lmbTextResizeObservers;
    if (observers && observers.has(page)) { observers.get(page).disconnect(); observers.delete(page); }
  }
});

/* One document flow: only the active Markdown block is an editor. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  lmbLivePointerOffset(container, source, event) {
    try {
      const doc = container.ownerDocument;
      const caret = doc.caretPositionFromPoint ? doc.caretPositionFromPoint(event.clientX, event.clientY) : null;
      const range = !caret && doc.caretRangeFromPoint ? doc.caretRangeFromPoint(event.clientX, event.clientY) : null;
      const node = caret ? caret.offsetNode : range && range.startContainer;
      const offset = caret ? caret.offset : range && range.startOffset;
      if (!node || node.nodeType !== 3 || !container.contains(node)) return 0;
      const before = doc.createRange(); before.selectNodeContents(container); before.setEnd(node, 0);
      return lmbLiveCaretOffset(source, node.textContent || "", offset || 0, before.toString().length);
    } catch (_) { return 0; }
  },

  lmbOpenInlineNoteEditor(block, opts) {
    if (block._lmbInlineEditor) { block._lmbInlineEditor.input.focus(); return block._lmbInlineEditor; }
    const doc = block.ownerDocument, body = opts.body || block.querySelector(".lmb-pdf-text-body");
    const panel = block.createDiv({ cls: "lmb-inline-note-editor" }); block.insertBefore(panel, body);
    const controls = panel.createDiv({ cls: "lmb-inline-note-controls" });
    controls.createSpan({ text: "实时编辑" });
    const status = controls.createSpan({ cls: "lmb-inline-note-status", text: "点击段落编辑" });
    const save = controls.createEl("button", { text: opts.autosave ? "完成" : "保存", attr: { type: "button" } });
    const cancel = controls.createEl("button", { text: "取消", attr: { type: "button" } });
    const input = body.createEl("textarea", { cls: "lmb-live-markdown-input", attr: { "aria-label": "当前段落 Markdown", placeholder: "输入 Markdown…", spellcheck: "false", rows: "1" } });
    const text = String(opts.value || "").replace(/\r\n/g, "\n");
    const state = { input, text, parts: lmbLiveMarkdownBlocks(text), active: 0, closed: false, busy: false, sequence: 0, cache: new Map(), history: [], redo: [], composing: false };
    state.lastSavedText = text;
    let autosaveTimer = null, pendingSave = null, finishing = null;
    const changed = (value) => {
      if (opts.onChange) opts.onChange(value);
      if (!opts.autosave) return;
      clearTimeout(autosaveTimer); status.setText("等待自动保存…");
      autosaveTimer = setTimeout(() => { state.persist(); }, opts.autosaveDelay || 800);
    };
    const partsAtCaret = (source, caret) => {
      const parts = lmbLiveMarkdownBlocks(source);
      // A newly typed blank paragraph can sit between existing blocks. Keep an
      // empty source range there instead of moving the caret into the next one.
      if (!parts.some(part => part.start <= caret && caret <= part.end)) {
        const index = parts.findIndex(part => part.start > caret);
        parts.splice(index < 0 ? parts.length : index, 0, { start: caret, end: caret, kind: "paragraph", source: "" });
      }
      return parts;
    };
    block._lmbInlineEditor = state; block.addClass("is-editing"); block.addClass("is-live-editing");
    const active = opts.sidebar ? (this._lmbActiveSidebarNoteBlocks || (this._lmbActiveSidebarNoteBlocks = new Set()))
      : (this._lmbActiveInlineBlocks || (this._lmbActiveInlineBlocks = new Set())); active.add(block);
    state.getText = () => {
      const part = state.parts[state.active];
      return state.text.slice(0, part.start) + input.value + state.text.slice(part.end);
    };
    const resize = () => {
      // Collapse the intrinsic height before measuring, including when deleting
      // wrapped text. Otherwise the default textarea rows become a height floor.
      input.style.height = "0px";
      const win = doc.defaultView;
      const line = win && win.getComputedStyle ? parseFloat(win.getComputedStyle(input).lineHeight) : 24;
      input.style.height = Math.max(line || 24, input.scrollHeight || 0) + "px";
      if (block.parentElement && block._lmbTextView) this.lmbStyleTextBlock(block, block.parentElement, block._lmbTextView);
    };
    state.rebuild = (index, caret = 0, focus = true) => {
      const sequence = ++state.sequence, scroll = body.scrollTop, previous = state.cache, cache = new Map(), jobs = [];
      const scrolls = [];
      for (let el = body; el; el = el.parentElement) scrolls.push([el, el.scrollTop, el.scrollLeft]);
      state.active = Math.max(0, Math.min(state.parts.length - 1, index));
      const wrappers = state.parts.map((part, i) => {
        const wrapper = doc.createElement("div"); wrapper.classList.add("lmb-live-markdown-block"); wrapper.dataset.kind = part.kind;
        const heading = /^(#{1,6})\s/.exec(part.source);
        if (heading) wrapper.style.setProperty("--lmb-live-heading-size", heading[1].length === 1 ? "1.7em" : heading[1].length === 2 ? "1.4em" : heading[1].length === 3 ? "1.2em" : "1em");
        if (i === state.active) {
          wrapper.classList.add("is-active"); wrapper.appendChild(input); input.value = part.source;
        } else {
          wrapper.tabIndex = 0; wrapper.setAttribute("aria-label", `编辑第 ${i + 1} 段`);
          const record = previous.get(i);
          if (record && record.source === part.source && record.node) { wrapper.appendChild(record.node); cache.set(i, record); }
          else {
            const content = doc.createElement("div");
            jobs.push((async () => {
              try { await MarkdownRenderer.render(this.app, part.source || "\u200b", content, opts.sourcePath || "", this); }
              catch (_) { content.textContent = part.source; }
              if (state.closed || sequence !== state.sequence) return;
              wrapper.replaceChildren(content); cache.set(i, { source: part.source, node: content });
            })());
          }
          wrapper.addEventListener("click", (event) => {
            if (event.ctrlKey || event.metaKey || state.busy || state.composing) return;
            event.preventDefault(); event.stopPropagation();
            state.activate(i, this.lmbLivePointerOffset(wrapper, part.source, event));
          }, true);
          wrapper.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); state.activate(i, 0); }
          });
        }
        return wrapper;
      });
      state.cache = cache; body.replaceChildren(...wrappers); body.scrollTop = scroll;
      const position = Math.max(0, Math.min(input.value.length, caret));
      // Size the textarea before focusing it: a default two-row field can make
      // the browser reveal its caret by scrolling the PDF viewport first.
      resize(); input.setSelectionRange(position, position);
      if (focus) input.focus({ preventScroll: true });
      for (const [el, top, left] of scrolls) { el.scrollTop = top; el.scrollLeft = left; }
      return Promise.all(jobs);
    };
    state.sync = (record = true) => {
      const old = state.parts[state.active], selection = input.selectionStart == null ? input.value.length : input.selectionStart;
      const nextText = state.getText(), caret = old.start + selection;
      if (nextText === state.text) { resize(); return Promise.resolve(); }
      if (record) { state.history.push({ text: state.text, caret: state.beforeCaret == null ? old.start : state.beforeCaret }); if (state.history.length > 100) state.history.shift(); state.redo.length = 0; }
      const parts = partsAtCaret(nextText, caret), index = lmbLiveBlockAt(parts, caret);
      const stable = index === state.active && parts.length === state.parts.length && parts.every((part, i) => i === index || part.source === state.parts[i].source);
      state.text = nextText; state.parts = parts;
      changed(nextText);
      if (stable) { if (input.parentElement) input.parentElement.dataset.kind = parts[index].kind; resize(); return Promise.resolve(); }
      return state.rebuild(index, caret - parts[index].start);
    };
    state.render = () => state.sync();
    state.activate = (index, caret = 0) => {
      if (state.closed || state.busy || state.composing) return Promise.resolve();
      state.sync();
      index = Math.max(0, Math.min(state.parts.length - 1, index));
      return state.rebuild(index, caret === "end" ? state.parts[index].source.length : caret);
    };
    state.restore = (snapshot) => {
      state.text = snapshot.text; state.parts = partsAtCaret(state.text, snapshot.caret);
      changed(state.text);
      const index = lmbLiveBlockAt(state.parts, snapshot.caret);
      return state.rebuild(index, snapshot.caret - state.parts[index].start);
    };
    state.undo = (redo = false) => {
      const from = redo ? state.redo : state.history, to = redo ? state.history : state.redo;
      if (!from.length || state.composing || state.busy) return;
      const caret = state.parts[state.active].start + (input.selectionStart || 0);
      to.push({ text: state.getText(), caret }); state.restore(from.pop());
    };
    state.close = (saved) => {
      if (state.closed) return;
      const result = state.getText(); state.closed = true; state.sequence++;
      clearTimeout(autosaveTimer);
      if (state.outsideClick) opts.pageRoot.removeEventListener("click", state.outsideClick, true);
      if (state.observer) state.observer.disconnect();
      panel.remove(); block.classList.remove("is-editing"); block.classList.remove("is-live-editing"); delete block._lmbInlineEditor; active.delete(block);
      body._lmbMarkdown = undefined;
      if (block.parentElement && block._lmbTextView) this.lmbStyleTextBlock(block, block.parentElement, block._lmbTextView);
      if (opts.onClose) opts.onClose(saved, result);
    };
    state.persist = () => {
      clearTimeout(autosaveTimer);
      if (state.closed || state.composing) return Promise.resolve(false);
      if (pendingSave) return pendingSave;
      pendingSave = (async () => {
        try {
          // A write can finish after another keystroke. Drain the newest text
          // serially before allowing the editor to close or switch notes.
          do {
            if (state.composing) return false;
            const snapshot = state.getText();
            if (opts.autosave && snapshot === state.lastSavedText) break;
            status.setText("保存中…");
            await opts.onSubmit(snapshot);
            state.lastSavedText = snapshot;
          } while (!state.closed && state.getText() !== state.lastSavedText);
          status.setText(opts.autosave ? "已自动保存" : "已保存");
          return true;
        } catch (err) {
          clearTimeout(autosaveTimer);
          status.setText("保存失败，草稿已保留"); new Notice("保存失败，草稿已保留：" + err.message);
          return false;
        }
      })().finally(() => { pendingSave = null; });
      return pendingSave;
    };
    state.save = () => {
      if (finishing) return finishing;
      if (state.closed) return Promise.resolve(false);
      if (state.composing) { if (opts.autosave) new Notice("请先确认输入法中的文字，草稿仍保留在当前备注"); return Promise.resolve(false); }
      state.busy = true; input.readOnly = true; save.disabled = cancel.disabled = true; status.setText("保存中…");
      finishing = (async () => {
        try { const ok = await state.persist(); if (ok) state.close(true); return ok; }
        finally { state.busy = false; input.readOnly = false; save.disabled = cancel.disabled = false; finishing = null; }
      })();
      return finishing;
    };
    state.cancel = () => { if (!state.busy && !pendingSave) state.close(false); };
    if (opts.autosave) { status.setText("自动保存已开启"); cancel.setAttribute("title", "放弃尚未保存的修改；已自动保存的内容会保留"); }
    save.onclick = (event) => { event.stopPropagation(); state.save(); }; cancel.onclick = (event) => { event.stopPropagation(); state.cancel(); };
    input.addEventListener("compositionstart", () => { state.composing = true; });
    input.addEventListener("compositionend", () => { state.composing = false; state.sync(); });
    input.addEventListener("beforeinput", (event) => {
      state.beforeCaret = state.parts[state.active].start + (input.selectionStart || 0);
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") { event.preventDefault(); state.undo(event.inputType === "historyRedo"); }
    });
    input.addEventListener("input", (event) => { if (event.isComposing || state.composing) resize(); else state.sync(); });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || state.composing) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); state.save(); return; }
      if ((event.ctrlKey || event.metaKey) && /^(z|y)$/i.test(event.key)) { event.preventDefault(); event.stopPropagation(); state.undo(event.shiftKey || event.key.toLowerCase() === "y"); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); state.cancel(); return; }
      const start = input.selectionStart, end = input.selectionEnd;
      if (start !== end || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (start === 0 && /^(ArrowUp|ArrowLeft)$/.test(event.key) && state.active > 0) { event.preventDefault(); state.activate(state.active - 1, "end"); }
      else if (end === input.value.length && /^(ArrowDown|ArrowRight)$/.test(event.key) && state.active + 1 < state.parts.length) { event.preventDefault(); state.activate(state.active + 1, 0); }
      else if (event.key === "Backspace" && start === 0 && state.parts[state.active].start > 0 || event.key === "Delete" && end === input.value.length && state.parts[state.active].end < state.text.length) {
        event.preventDefault(); const at = state.parts[state.active].start + start, remove = event.key === "Backspace" ? at - 1 : at;
        state.history.push({ text: state.getText(), caret: at }); state.redo.length = 0;
        state.restore({ text: state.text.slice(0, remove) + state.text.slice(remove + 1), caret: remove });
      }
    });
    if (opts.pageRoot) {
      let outsideRequest = 0;
      state.outsideClick = async (event) => {
        const target = event.target;
        if (state.closed || block.contains(target) || event.ctrlKey || event.metaKey || event.button > 0) return;
        const page = target.closest && target.closest(".page[data-page-number]");
        if (!page || !opts.pageRoot.contains(page)) return;
        const next = target.closest(".lmb-pdf-text-block");
        // Toolbar actions are separate interactions; clicking a note body switches editors.
        if (next && !target.closest(".lmb-pdf-text-body")) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const request = ++outsideRequest;
        if (!await state.save()) { input.focus({ preventScroll: true }); return; }
        if (request !== outsideRequest || this._unloaded) return;
        if (next && next.isConnected) await this.lmbEditTextBlockNote(next._lmbTextEntry, null, next, event);
      };
      opts.pageRoot.addEventListener("click", state.outsideClick, true);
    }
    const initialOffset = Math.max(0, Math.min(text.length, opts.cursorOffset || 0));
    state.rebuild(lmbLiveBlockAt(state.parts, initialOffset), initialOffset - state.parts[lmbLiveBlockAt(state.parts, initialOffset)].start);
    if (typeof ResizeObserver !== "undefined" && block.parentElement && block._lmbTextView) {
      state.observer = new ResizeObserver(() => { if (!state.closed && block.isConnected) resize(); }); state.observer.observe(block.parentElement);
    }
    return state;
  }
});

/* Sidebar and page share one paragraph editor and the existing note source. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  lmbNoteEditorKey(entry) {
    return JSON.stringify([entry.pdfPath || "", entry.exId || "", entry.sourceMd || "", !!entry.quick]);
  },

  async lmbOpenSidebarNoteEditor(entry, leaf, preferredRow, afterSave) {
    if (this.inkMode) await this.lmbSetInkMode(false);
    const bar = leaf && this.lmbEnsurePdfSidebarEl(leaf);
    if (!bar) return false;
    // Serialize rapid card clicks, including clicks while a disk write is pending.
    const previous = bar._lmbSidebarSwitch || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (!leaf.view.file || leaf.view.file.path !== entry.pdfPath) return false;
      bar._lmbSidebarSwitching = true;
      try {
        for (const block of Array.from(this._lmbActiveInlineBlocks || [])) {
          if (leaf.containerEl.contains(block) && block._lmbInlineEditor && !await block._lmbInlineEditor.save()) {
            block._lmbInlineEditor.input.focus({ preventScroll: true }); return false;
          }
        }
        const current = bar._lmbSidebarEditor;
        if (current && !current.closed && this.lmbNoteEditorKey(current._entry) !== this.lmbNoteEditorKey(entry)) {
          if (!await current.save()) {
            current.input.focus({ preventScroll: true });
            this.lmbSelectPdfSidebarEntry(leaf, current._entry);
            return false;
          }
        }
        await this.lmbMountSidebarNoteEditor(entry, leaf, preferredRow && preferredRow.isConnected ? preferredRow : null, afterSave);
        return !!bar._lmbSidebarEditor && bar._lmbSidebarEditingId === entry.exId;
      } finally { bar._lmbSidebarSwitching = false; }
    });
    bar._lmbSidebarSwitch = task;
    try { return await task; } finally { if (bar._lmbSidebarSwitch === task) delete bar._lmbSidebarSwitch; }
  },

  async lmbMountSidebarNoteEditor(entry, leaf, preferredRow, afterSave) {
    const file = leaf && leaf.view && leaf.view.file;
    if (!file || file.path !== entry.pdfPath) return;
    const bar = this.lmbEnsurePdfSidebarEl(leaf);
    if (!bar) return;
    const existing = this._lmbSidebarNoteDrafts && this._lmbSidebarNoteDrafts.get(this.lmbNoteEditorKey(entry));
    if (existing && !existing.closed) {
      const ownerLeaf = existing._leaf || leaf;
      if (ownerLeaf !== leaf && this.app.workspace.setActiveLeaf) this.app.workspace.setActiveLeaf(ownerLeaf, { focus: true });
      if (!existing.input.isConnected) await this.lmbRenderPdfSidebarForLeaf(ownerLeaf);
      existing.input.focus({ preventScroll: true }); return;
    }
    if (bar._lmbSidebarEditor && !bar._lmbSidebarEditor.closed) {
      bar._lmbSidebarEditor.input.focus({ preventScroll: true });
      if (bar._lmbSidebarEditingId !== entry.exId) new Notice("请先保存或取消正在编辑的备注");
      return;
    }
    if (bar._lmbSidebarOpening) return;
    const pageEditor = Array.from(leaf.containerEl.querySelectorAll(".lmb-pdf-text-block"))
      .find(block => block.dataset.exId === entry.exId && block._lmbInlineEditor);
    if (pageEditor) { pageEditor._lmbInlineEditor.input.focus({ preventScroll: true }); new Notice("该备注正在页内编辑，请先保存或取消"); return; }
    let row = preferredRow;
    if (!row) {
      await this.lmbRenderPdfSidebarForLeaf(leaf);
      row = Array.from(bar.querySelectorAll(".lmb-pdf-sidebar-item")).find(el => el.dataset.exId === entry.exId);
    }
    if (!row) { new Notice("找不到对应的侧栏条目，请刷新后重试"); return; }
    const token = {}; bar._lmbSidebarOpening = token; bar._lmbRenderToken = {};
    try {
      const value = await this.lmbTextBlockNote(entry);
      if (this._unloaded || bar._lmbSidebarOpening !== token || leaf.view.file !== file || !row.isConnected) return;
      this.lmbSetPdfSidebarVisible(leaf, true);
      this.lmbSelectPdfSidebarEntry(leaf, entry);
      row.classList.remove("is-compact"); row.classList.add("is-note-editing");
      const headerButtons = Array.from(row.querySelectorAll(".lmb-pdf-sidebar-header-actions button"));
      for (const button of headerButtons) button.disabled = true;
      let host = row.querySelector(".lmb-pdf-sidebar-item-note");
      if (!host) {
        host = row.createDiv({ cls: "lmb-pdf-sidebar-item-note" });
        row.insertBefore(host, row.querySelector(".lmb-pdf-sidebar-item-actions"));
      }
      host.classList.remove("is-collapsed"); host.classList.add("is-sidebar-editing");
      let body = host.querySelector(".lmb-pdf-sidebar-item-note-body");
      if (!body) body = host.createDiv({ cls: "lmb-pdf-sidebar-item-note-body markdown-rendered" });
      if (!host._lmbEditorEvents) {
        host._lmbEditorEvents = true;
        for (const type of ["pointerdown", "click", "dblclick", "keydown"]) host.addEventListener(type, event => { if (host._lmbInlineEditor) event.stopPropagation(); });
      }
      const drafts = this._lmbSidebarNoteDrafts || (this._lmbSidebarNoteDrafts = new Map());
      const key = this.lmbNoteEditorKey(entry);
      let timer = null;
      const state = this.lmbOpenInlineNoteEditor(host, { body, sidebar: true, autosave: true, value, sourcePath: entry.sourceMd || file.path,
        onChange: () => {
          clearTimeout(timer);
          timer = setTimeout(() => { if (!state.closed) this.lmbRefreshTextBlocks().catch(err => console.warn("[lmb] sidebar draft preview failed", err)); }, 80);
        },
        onSubmit: text => this.lmbSaveTextBlockNote(entry, text),
        onClose: (saved, text) => {
          clearTimeout(timer); drafts.delete(key);
          if (bar._lmbSidebarEditor === state) { delete bar._lmbSidebarEditor; delete bar._lmbSidebarEditingId; }
          row.classList.remove("is-note-editing"); host.classList.remove("is-sidebar-editing");
          for (const button of headerButtons) button.disabled = false;
          bar._lmbRenderSig = null;
          // Keep the existing row visible until the detached sidebar render is ready.
          const content = body.ownerDocument.createElement("div");
          Promise.resolve().then(() => MarkdownRenderer.render(this.app, saved ? text : state.lastSavedText, content, entry.sourceMd || file.path, this))
            .then(() => { if (!host._lmbInlineEditor && host.isConnected) body.replaceChildren(content); }).catch(() => {});
          if (this._unloaded) return;
          this.lmbRefreshTextBlocks().catch(err => console.warn("[lmb] sidebar preview restore failed", err));
          if (!bar._lmbSidebarSwitching) this.lmbRenderPdfSidebarForLeaf(leaf).catch(err => console.warn("[lmb] sidebar editor refresh failed", err));
          if (saved && afterSave) Promise.resolve(afterSave(text)).catch(err => new Notice(err.message));
        }
      });
      state._entry = entry; state._row = row; state._sidebarBar = bar; state._pdfPath = file.path; state._leaf = leaf;
      drafts.set(key, state); bar._lmbSidebarEditor = state; bar._lmbSidebarEditingId = entry.exId;
    } catch (err) { new Notice("无法打开备注：" + err.message); }
    finally {
      if (bar._lmbSidebarOpening === token) delete bar._lmbSidebarOpening;
      if (!this._unloaded && leaf.view.file !== file) this.lmbRenderPdfSidebarForLeaf(leaf).catch(() => {});
    }
  }
});

/* 36-plugin-jump —— 双向跳转/链接接管/相关笔记（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

  // A navigation belongs to one user action. Loading may finish much later;
  // switching tabs or starting another navigation permanently cancels it.
  _lmbBeginNavigation() {
    if (this._lmbNavigation) this._lmbNavigation.cancelled = true;
    const workspace = this.app.workspace;
    const request = { leaf: workspace.activeLeaf, cancelled: false };
    this._lmbNavigation = request;
    if (typeof workspace.on === "function") {
      request.event = workspace.on("active-leaf-change", (leaf) => {
        if (!request.creating && leaf !== request.leaf) request.cancelled = true;
      });
    }
    request.document = request.leaf && request.leaf.containerEl && request.leaf.containerEl.ownerDocument;
    if (request.document) {
      request.interrupt = () => { request.cancelled = true; };
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
        request.document.addEventListener(event, request.interrupt, { capture: true, passive: true });
    }
    return request;
  },

  _lmbNavigationCurrent(request) {
    return !this._unloaded && request && !request.cancelled
      && this._lmbNavigation === request
      && (!this.app.workspace.activeLeaf || this.app.workspace.activeLeaf === request.leaf);
  },

  _lmbEndNavigation(request) {
    if (request && request.document && request.interrupt)
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
        request.document.removeEventListener(event, request.interrupt, true);
    if (request && request.event && this.app.workspace.offref) this.app.workspace.offref(request.event);
    if (this._lmbNavigation === request) this._lmbNavigation = null;
  },

  async _lmbActivateNavigationLeaf(request, leaf, file) {
    const workspace = this.app.workspace;
    if (!this._lmbNavigationCurrent(request)) return null;
    if (!leaf) {
      request.creating = true;
      try { leaf = workspace.getLeaf("tab"); }
      finally { request.creating = false; }
      // getLeaf may activate the blank tab synchronously.
      request.leaf = workspace.activeLeaf;
      await leaf.openFile(file, { active: false });
      if (!this._lmbNavigationCurrent(request)) return null;
    }
    if (typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
    if (!this._lmbNavigationCurrent(request)) return null;
    request.leaf = leaf;
    workspace.setActiveLeaf(leaf, { focus: true });
    // Older hosts expose revealLeaf but not loadIfDeferred.
    if (typeof leaf.loadIfDeferred !== "function" && typeof workspace.revealLeaf === "function")
      await workspace.revealLeaf(leaf);
    return this._lmbNavigationCurrent(request) ? leaf : null;
  },

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
   * 返回：{ filePath, page, selection, rect, target }；非 pdf#page= 链接返回 null。
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
      // v0.16.6 P1-7：必须取**最后一个** `#`，不能用第一个 —— PDF 文件名本身可能含 `#`
      //   （例如 `[[报告#2.pdf#page=3&selection=...]]`）。旧版 indexOf 取第一个 #
      //   → path 被截断成 "报告" → /\.pdf$/ 不匹配 → 返回 null → 调用方静默放行
      //   → 用户点了链接**什么都没发生、也没有任何提示**。
      const hash = linktext.lastIndexOf("#");
      if (hash < 0) return null;
      const rawPath = linktext.slice(0, hash).trim();
      // v0.16.5 修复 R5：调用方优先取的是 a.href，Obsidian 对空格等字符做 %20 编码 ——
      //   不解码的话「路径含空格的 PDF」会因路径比对失败而报「找不到 PDF」。
      //   解码失败（非法 % 序列）保留原样，行为退回旧版，不会更差。
      let path = rawPath;
      try { path = decodeURIComponent(rawPath); } catch (_) { path = rawPath; }
      const sub = linktext.slice(hash + 1);
      if (!/\.pdf$/i.test(path)) return null;
      if (!/(^|&)page=/.test(sub)) return null;          // 必须有 page=
      const params = new URLSearchParams(sub);
      const page = parseInt(params.get("page"), 10);
      if (!page || isNaN(page)) return null;
      const sm = LMB_SEL_RE.exec((params.get("selection") || "").trim());
      const rm = LMB_RECT_RE.exec((params.get("rect") || "").trim());
      const target = params.get("target") || null;
      return {
        filePath: path,
        page: page,
        selection: sm ? [+sm[1], +sm[2], +sm[3], +sm[4]] : null,
        rect: rm ? [+rm[1], +rm[2], +rm[3], +rm[4]] : null,
        target: target,
        ...(params.get("ink") ? { inkRef: params.get("ink") } : {})
      };
    } catch (_) { return null; }
  },

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
          if (!hit) {
            /* v0.16.6 P1-7：看起来是 pdf 链接却解析不出 page= → 不再静默。
             *   旧版直接 return，事件原样冒泡给 Obsidian，Obsidian 把 `#page=3&...`
             *   当标题锚点解析 → 用户点了没反应、控制台也没错，只能认为插件坏了。
             *   限定「含 # 且含 .pdf」才提示，避免对普通 `[[x.pdf]]` 文件链接刷屏。 */
            if (/#/.test(href) && /\.pdf/i.test(href)) {
              try {
                new Notice("MarginBook：这个 PDF 链接缺少 page= 参数或不完整，无法跳转\n" + String(href).slice(0, 80), 5000);
              } catch (_) {}
            }
            return;                                        // 非 pdf#page= 链接不碰
          }
          ev.preventDefault();
          ev.stopPropagation();
          ev.stopImmediatePropagation();                     // Obsidian / 其他插件都别想碰
          if (hit.inkRef) this.lmbLocateInkReference(hit.inkRef);
          else this.lmbJumpToSelection(hit.filePath, hit.page, hit.selection, hit.rect, null, hit.target);
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
  },

  /** 拆除 DOM 层链接拦截（onunload 调用） */
  lmbTeardownLinkInterception() {
    try {
      if (this._ppdLinkHandler) {
        document.removeEventListener("click", this._ppdLinkHandler, true);
        this._ppdLinkHandler = null;
      }
    } catch (_) { /* noop */ }
  },

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
            if (hit.inkRef) this.lmbLocateInkReference(hit.inkRef);
            else this.lmbJumpToSelection(hit.filePath, hit.page, hit.selection, hit.rect, null, hit.target);
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
  },

  /** 等 .page 元素出现（pdf.js 会给所有页建 .page，只是 textLayer 虚拟化） */
  async lmbWaitPageEl(container, pageNum, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 6000)) {
      const el = container.querySelector('.page[data-page-number="' + pageNum + '"]');
      if (el) return el;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  },

  /** 轮询直到选区能解出矩形（= textLayer 已就绪）；超时返回 null */
  async lmbWaitSelectionRects(pageEl, selection, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 8000)) {
      const rects = this.lmbResolveSelectionRects(pageEl, selection);
      if (rects) return rects;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  },

  /**
   * 正向跳转：滚到页 → 按可用坐标定位 → 闪烁。
   *   selection（文字选区）→ 等 textLayer 后解矩形
   *   rect（截图摘录）→ 直接用页面百分比，【不需要 textLayer】
   *   两者都没有 → 只滚到页
   * 只匹配「真正渲染了」的 leaf（view.file 有值）——僵尸 leaf 一律绕开重开。
   */
  async lmbJumpToSelection(filePath, pageNum, selection, rect, preferredLeaf, entryText) {
    const request = this._lmbBeginNavigation();
    try {
      if (!filePath || !pageNum) return;
      let leaf = null, resolvedFile = this.app.vault.getAbstractFileByPath(filePath);
      if (!resolvedFile) {
        try { resolvedFile = this.app.metadataCache.getFirstLinkpathDest(filePath, ""); } catch (_) { resolvedFile = null; }
      }
      const resolvedPath = resolvedFile && resolvedFile.path ? resolvedFile.path : filePath;
      if (preferredLeaf && preferredLeaf.view && preferredLeaf.view.file
        && preferredLeaf.view.file.path === resolvedPath) leaf = preferredLeaf;
      const leaves = this.app.workspace.getLeavesOfType("pdf");
      for (const l of leaves) {
        if (leaf) break;
        const v = l && l.view;
        if (v && v.file && v.file.path === resolvedPath) { leaf = l; break; }
      }
      if (!leaf) {
        // v0.16.5 R5：路径解析兜底 —— 直接路径取不到（相对名 / 编码残留）时走
        //   metadataCache 的链接解析，与摘录索引层（reindexFile）用的是同一套规则
        const f = resolvedFile;
        if (!f) { new Notice("MarginBook: 找不到 PDF " + filePath); return; }
      }
      leaf = await this._lmbActivateNavigationLeaf(request, leaf, resolvedFile);
      if (!leaf) return;
      const view = leaf.view;
      const container = view && view.containerEl;
      if (!container) return;

      const pageEl = await this.lmbWaitPageEl(container, pageNum, 6000);
      if (!this._lmbNavigationCurrent(request) || leaf.view !== view || view.file?.path !== resolvedPath) return;
      if (!pageEl) { new Notice("MarginBook: 找不到第 " + pageNum + " 页"); return; }
      pageEl.scrollIntoView({ block: "center" });

      // 截图摘录：rect 是页面百分比，直接闪（不需要 textLayer，最稳）
      if (rect && rect.length === 4 && rect[2] > 0 && rect[3] > 0) {
        await new Promise((r) => setTimeout(r, 350));     // 给滚动/渲染一点时间
        if (!this._lmbNavigationCurrent(request)) return;
        this.lmbFlashRects(pageEl, null, rect);
        return;
      }

      // 文字选区：pdf.js 虚拟化，刚滚到的页可能还没渲染文本层，必须等
      if (selection) {
        const rects = await this.lmbWaitSelectionRects(pageEl, selection, 8000);
        if (!this._lmbNavigationCurrent(request)) return;
        if (!rects) {
          new Notice("MarginBook: 已到第 " + pageNum
            + " 页，但选区无法精确定位（文本层未就绪或索引漂移）。可跑「重建摘录索引」重试。");
          return;
        }
        this.lmbFlashRects(pageEl, rects, null);
      } else if (entryText) {
        const rects = this.lmbResolveEntryTextRects(pageEl, entryText);
        if (rects) this.lmbFlashRects(pageEl, rects, null);
      }
    } catch (err) {
      console.warn("[lmb] lmbJumpToSelection error:", err);
    } finally { this._lmbEndNavigation(request); }
  },

  /** 已打开则复用（包括尚未加载的后台标签），否则新建标签，保留当前视图模式。 */
  async lmbOpenExcerptInMd(exId, sourceMd, pdfLeaf) {
    const navigation = this._lmbBeginNavigation();
    try {
      if (!exId || !sourceMd) { new Notice("MarginBook: 该摘录缺少 Markdown 来源"); return false; }
      const file = this.app.vault.getAbstractFileByPath(sourceMd);
      if (!(file instanceof TFile)) { new Notice("MarginBook: 找不到摘录文档 " + sourceMd); return false; }
      // Serialize requests for the same file: openFile is asynchronous, so two
      // rapid clicks must not both conclude that the document is not open yet.
      const queue = this._lmbMdNavigationQueue || (this._lmbMdNavigationQueue = new Map());
      const previous = queue.get(file.path) || Promise.resolve();
      const request = previous.catch(() => {}).then(async () => {
        if (!this._lmbNavigationCurrent(navigation)) return false;
        const workspace = this.app.workspace;
        const mdLeaves = workspace.getLeavesOfType("markdown") || [];
        let leaf = mdLeaves.find((candidate) => {
          if (!candidate || candidate === pdfLeaf) return false;
          if (candidate.view && candidate.view.file && candidate.view.file.path === file.path) return true;
          const state = typeof candidate.getViewState === "function" ? candidate.getViewState() : null;
          return state && state.state && state.state.file === file.path;
        });
        leaf = await this._lmbActivateNavigationLeaf(navigation, leaf, file);
        if (!leaf) return false;
        return this._lmbPositionMdExcerpt(leaf, file, exId, navigation);
      });
      queue.set(file.path, request);
      try { return await request; }
      finally { if (queue.get(file.path) === request) queue.delete(file.path); }
    } catch (err) { console.warn("[lmb] lmbOpenExcerptInMd error:", err); return false; }
    finally { this._lmbEndNavigation(navigation); }
  },

  /** 定位当前可见子视图；等待阅读渲染就绪，绝不通过重复 openFile 重试。 */
  async _lmbPositionMdExcerpt(leaf, file, exId, navigation) {
    let fallbackLine = null;
    const initialMode = leaf.view && leaf.view.getMode();
    for (let attempt = 0; attempt < 30; attempt++) {
      if (navigation && !this._lmbNavigationCurrent(navigation)) return false;
      const view = leaf.view;
      // A delayed renderer must not move the cursor in a document the user
      // switched to, or pull focus back after the user selected another tab.
      if (!view || !view.file || view.file.path !== file.path || view.getMode() !== initialMode
        || (this.app.workspace.activeLeaf && this.app.workspace.activeLeaf !== leaf)) return false;
      const cache = this.app.metadataCache.getFileCache(file);
      const block = cache && cache.blocks && cache.blocks[exId];
      let line = block && block.position && block.position.start ? block.position.start.line : fallbackLine;
      if (line == null && fallbackLine == null) {
        // The metadata cache can lag behind newly written excerpts. Read the
        // literal marker rather than reopening the same file with a subpath.
        const text = await this.app.vault.cachedRead(file);
        const lines = text.split(/\r?\n/);
        fallbackLine = lines.findIndex((textLine) => {
          const match = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(textLine);
          return match && match[1] === exId;
        });
        if (fallbackLine >= 0) line = fallbackLine;
      }
      // cachedRead above can yield while the user changes the active document.
      if (navigation && !this._lmbNavigationCurrent(navigation)) return false;
      if (leaf.view !== view || !view.file || view.file.path !== file.path || view.getMode() !== initialMode
        || (this.app.workspace.activeLeaf && this.app.workspace.activeLeaf !== leaf)) return false;
      if (Number.isInteger(line) && line >= 0) {
        if (view.getMode() === "preview") {
          const preview = view.previewMode;
          const renderer = preview && preview.renderer;
          // Obsidian's renderer knows source lines even for virtualized blocks.
          // Its false return means the section layout is not ready yet.
          if (renderer && typeof renderer.applyScroll === "function") {
            if (renderer.applyScroll(line, { center: true, highlight: true }) !== false) {
              if (typeof view.syncScroll === "function") view.syncScroll();
              return true;
            }
          } else if (preview && typeof preview.applyScroll === "function") {
            preview.applyScroll(line);
            if (typeof view.syncScroll === "function") view.syncScroll();
            return true;
          }
        } else if (view.editor) {
          const editor = view.editor;
          const lastLine = Math.max(0, editor.lineCount() - 1);
          line = Math.min(line, lastLine);
          editor.setCursor({ line, ch: 0 });
          editor.scrollIntoView({ from: { line: Math.max(0, line - 3), ch: 0 }, to: { line: Math.min(lastLine, line + 3), ch: 0 } }, true);
          if (typeof view.syncScroll === "function") view.syncScroll();
          return true;
        }
      }
      if (attempt < 29) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    new Notice("MarginBook: 暂时无法定位摘录 " + exId + "（块不存在或视图尚未就绪）");
    return false;
  },

  /** 闪烁定位：覆盖 accent 色矩形，闪 3 次后自清理。
   *  二参一给 rects（页面客户坐标）一给 rectPcts（页面百分比），二选一。 */
  lmbFlashRects(pageEl, rects, rectPcts) {
    try {
      let pcts = rectPcts || null;
      if (!pcts && rects) pcts = this.lmbRectsToPercents(rects, pageEl);
      if (!pcts || !pcts.length) return;
      const focusHost = pageEl.closest && pageEl.closest(".workspace-leaf-content");
      if (focusHost && focusHost.classList) focusHost.classList.add("lmb-focus-mode");
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
          if (focusHost && focusHost.classList) focusHost.classList.remove("lmb-focus-mode");
        } catch (_) { /* noop */ }
      }, 2200);
    } catch (_) { /* noop */ }
  },

  /**
   * 反向跳转：双击标记区域 → 跳到摘录所在处。
   * **优先 canvas 卡片**（v0.9.1 起按用户要求改的：跳到摘录的画布，不是 md），
   * 找不到 canvas 位置 / 节点没等到时才回退 md 的 ^ex- 块。
   */
  async lmbOpenExcerptAt(exId, sourceMd) {
    const navigation = this._lmbBeginNavigation();
    try {
      if (!exId) return;
      // ① 优先 canvas 卡片
      const loc = this.excerptCanvasIndex ? this.excerptCanvasIndex.get(exId) : null;
      if (loc && loc.canvasPath && loc.nodeId) {
        const cf = this.app.vault.getAbstractFileByPath(loc.canvasPath);
        if (cf && (await this.lmbFocusCanvasNode(cf, loc.nodeId, navigation))) return;
      }
      if (!this._lmbNavigationCurrent(navigation)) return;
      // ② 回退 md
      let path = sourceMd || null;
      if (!path && this.excerptIndex) {
        for (const arr of this.excerptIndex.values()) {
          const hit = arr.find((e) => e.exId === exId);
          if (hit && hit.sourceMd) { path = hit.sourceMd; break; }
        }
      }
      if (!path) { new Notice("MarginBook: 找不到该摘录的来源（canvas 和 md 都没查到）"); return; }
      await this.lmbOpenExcerptInMd(exId, path, this._lmbGetActivePdfLeaf());
    } catch (err) {
      console.warn("[lmb] lmbOpenExcerptAt error:", err);
    } finally { this._lmbEndNavigation(navigation); }
  },

  /* ==================== 旧知识自动浮现（补丁 B：P1-4 相关笔记 + P1-5 颜色语义） ==================== */

  lmbInvalidateRelatedFile(file, oldPath) {
    try {
      if (!this._lmbRelatedCorpus) this._lmbRelatedCorpus = new Map();
      if (!this._lmbRelatedDirtyFiles) this._lmbRelatedDirtyFiles = new Map();
      if (oldPath) this._lmbRelatedCorpus.delete(oldPath);
      if (!file || file.extension !== "md" || String(file.basename || "").endsWith("-摘录")) {
        if (file && file.path) this._lmbRelatedCorpus.delete(file.path);
        if (oldPath && this.relatedCache) this.relatedCache.clear();
        return;
      }
      if (this.relatedCache) this.relatedCache.clear();
      this._lmbRelatedCorpus.delete(file.path);
      this._lmbRelatedDirtyFiles.set(file.path, file);
    } catch (_) { /* invalidation must never interrupt vault events */ }
  },

  async _lmbLoadRelatedCorpusFile(file) {
    if (!file || file.extension !== "md" || file.path.includes(".obsidian")
      || String(file.basename || "").endsWith("-摘录")) return null;
    let cache = null;
    try { cache = this.app.metadataCache.getFileCache(file); } catch (_) { return null; }
    if (!cache) return null;
    const bag = [String(file.basename || "").toLowerCase()];
    for (const h of cache.headings || []) if (h.heading) bag.push(String(h.heading).toLowerCase());
    for (const t of cache.tags || []) if (t.tag) bag.push(String(t.tag).toLowerCase());
    const fm = cache.frontmatter;
    if (fm) for (const [k, value] of Object.entries(fm)) {
      if (k === "position") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (typeof item === "string") bag.push(item.toLowerCase());
      } else if (typeof value === "string") bag.push(value.toLowerCase());
    }
    let body = "";
    try { body = (await this.app.vault.cachedRead(file)).toLowerCase(); } catch (_) { return null; }
    return { file, haystack: bag.join("\n"), body };
  },

  async _lmbEnsureRelatedCorpus() {
    if (this._lmbRelatedCorpusPromise) return this._lmbRelatedCorpusPromise;
    this._lmbRelatedCorpusPromise = (async () => {
      if (!this._lmbRelatedCorpus) this._lmbRelatedCorpus = new Map();
      if (!this._lmbRelatedDirtyFiles) this._lmbRelatedDirtyFiles = new Map();
      if (!this._lmbRelatedCorpusReady) {
        this._lmbRelatedCorpus.clear();
        // Clear before asynchronous reads so events arriving during the build
        // remain queued and are applied below instead of being lost.
        this._lmbRelatedDirtyFiles.clear();
        const files = this.app.vault.getMarkdownFiles().filter((file) => file
          && !file.path.includes(".obsidian") && !String(file.basename || "").endsWith("-摘录"));
        for (let i = 0; i < files.length; i += 24) {
          const docs = await Promise.all(files.slice(i, i + 24).map((file) => this._lmbLoadRelatedCorpusFile(file)));
          for (const doc of docs) if (doc) this._lmbRelatedCorpus.set(doc.file.path, doc);
          if (i + 24 < files.length) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        this._lmbRelatedCorpusReady = true;
      }
      if (this._lmbRelatedDirtyFiles.size) {
        const dirty = Array.from(this._lmbRelatedDirtyFiles.values());
        this._lmbRelatedDirtyFiles.clear();
        const docs = await Promise.all(dirty.map((file) => this._lmbLoadRelatedCorpusFile(file)));
        for (let i = 0; i < dirty.length; i++) {
          const doc = docs[i];
          if (doc) this._lmbRelatedCorpus.set(doc.file.path, doc);
          else if (dirty[i] && dirty[i].path) this._lmbRelatedCorpus.delete(dirty[i].path);
        }
      }
      return this._lmbRelatedCorpus;
    })();
    try { return await this._lmbRelatedCorpusPromise; }
    finally { this._lmbRelatedCorpusPromise = null; }
  },

  _lmbCountToken(text, token, limit) {
    let count = 0, from = 0;
    while (count < (limit || 2)) {
      const at = text.indexOf(token, from);
      if (at < 0) break;
      count++; from = at + Math.max(1, token.length);
    }
    return count;
  },

  /**
   * P1-4：相关笔记检索（MarginNote 4「标题链接」平替，纯本地零 AI）。
   * v0.19：元数据给予高权重，同时读取正文做本地 BM25 风格评分；结果仍按 entryId 缓存。
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
        const corpus = await this._lmbEnsureRelatedCorpus();
        for (const doc of corpus.values()) {
          try {
            const file = doc.file, haystack = doc.haystack, body = doc.body;
            let score = 0;
            for (const tk of tokens) {
              if (haystack.includes(tk)) score += 3;
              if (body) {
                const hits = this._lmbCountToken(body, tk, 2);
                if (hits) score += Math.min(2, hits) / (1 + body.length / 6000);
              }
            }
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
  },

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
        .replace(/\^ex-[0-9a-z]{4,16}/g, " ")
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
  },

});

/* 37-plugin-canvasbar —— canvas 卡片悬浮操作栏（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js）
 * ----------------------------------------------------------------------------
 * v0.13.0：选中 canvas 里的一张摘录卡时，在卡片正上方浮出一条操作栏，含最多三个按钮：
 *   评论（message-square）/ 跳回 PDF（book-open）/ 切换文字·图片视图（image）
 *
 * 修改注意：
 *   1. 这三个功能**早就有了**（v0.11.0 评论 / v0.9.1 跳转 / v0.11.3 切换），本文件只负责
 *      「把入口从卡内搬到悬浮栏」，**任何业务逻辑都不要在这里重写**。对应的现有入口：
 *        this.editCommentForNode(file, nodeId)        33-plugin-note-comment.js
 *        this.lmbParsePdfLink(href) → lmbJumpToSelection(...)   36-plugin-jump.js
 *        this.toggleCardView(callout)                 33-plugin-note-comment.js
 *   2. 挂载点必须是 canvas.wrapperEl（.canvas-wrapper），**不能**是卡片或 .canvas：
 *      canvas 的 transform:scale() 加在 .canvas 上，wrapperEl 是其父级、不参与缩放。
 *      挂在 wrapper 上按钮尺寸恒定，挂在里面会跟着画布一起缩小到看不清。
 *   3. 浮层的 left/top 由 26-pure-canvasbar.js 的 lmbCalcBarPos() 算，本文件只负责取值与写入。
 *   4. canvas 的**一切**内部 API（canvas / selection / wrapperEl / nodes）都要能力检测 +
 *      try/catch。Obsidian 版本一变这些就可能没了，宁可静默降级也不能让插件崩。
 *   5. 本文件是 Object.assign 混入，**方法之间用逗号分隔**（30-plugin-core.js 才是 class 体
 *      不加逗号，别搞混）。
 * ========================================================================== */

Object.assign(LuciasMarginBookPlugin.prototype, {

  /* ==================== v0.13.0：canvas 卡片悬浮操作栏 ==================== */

  /**
   * 取（或创建）悬浮栏容器 —— 幂等，轮询每轮都会调。
   * @param {HTMLElement} wrapperEl  canvas.wrapperEl（或其退化 .canvas-wrapper）
   * @returns {HTMLElement|null}
   */
  lmbEnsureCanvasBarEl(wrapperEl) {
    try {
      if (!wrapperEl || !wrapperEl.querySelector) return null;

      // 幂等：已存在直接复用（低频兜底轮询，不复用会反复创建 DOM）
      // v0.13.8：**先看版本**。重载插件时 canvas leaf 的 DOM 不重建，旧版本造的浮层会
      //   被一直复用，而它的按钮绑的是**旧版 click 回调**（比如 v0.13.4 的 fit 按钮是
      //   `if (!c) return` 静默版）→ 代码改了、插件重载了，行为还是老样子。
      //   版本不匹配就移除重建，保证用户手上的永远是"当前代码造的"浮层。
      const exist = wrapperEl.querySelector(LMB_BAR_SEL);
      if (exist) {
        if (exist.dataset && exist.dataset.lmbBarVer === LMB_BAR_VERSION) return exist;
        if (exist.parentNode) exist.remove();
      }

      // 容器必须可定位，否则浮层的 absolute 会相对更外层的祖先定位而整体错位。
      // 只在我们能确认它是 static 时才改成 relative，不无脑覆盖用户/主题的样式。
      try {
        const cs = getComputedStyle(wrapperEl);
        if (!cs || cs.position === "static") wrapperEl.style.position = "relative";
      } catch (_) { /* getComputedStyle 不可用就算了，CSS 侧 .canvas-wrapper 本身就是 relative */ }

      const bar = wrapperEl.createDiv
        ? wrapperEl.createDiv({ cls: "lmb-canvas-bar" })
        : document.createElement("div");
      if (!bar.classList || !bar.classList.contains("lmb-canvas-bar")) {
        bar.className = "lmb-canvas-bar";
      }
      // v0.13.8：打版本标记（配合 lmbEnsureCanvasBarEl 顶部的版本检查，见那里的说明）
      try { bar.dataset.lmbBarVer = LMB_BAR_VERSION; } catch (_) {}

      // 四个按钮：只建一次，显隐与行为都在别处控制。withText 可选：传了就追加文字节点（fit 按钮专用，
      //   让用户一眼看到"高度"二字，不再把 move-vertical 误认成 view 切换）
      const mk = (cls, icon, label, withText) => {
        const b = document.createElement("div");
        b.className = cls;
        b.setAttribute("aria-label", label);
        try { setIcon(b, icon); } catch (_) { /* 图标失败也要能用 */ }
        if (withText) {
          const t = document.createElement("span");
          t.className = "lmb-bar-text";
          t.textContent = withText;
          b.appendChild(t);
        }
        // 注意：这里**不**把 nodeId / acts 闭包进回调 —— 浮层是复用的，选中卡片会变，
        // 闭包快照会 stale（点了 A 卡却操作 B 卡）。统一走 lmbCanvasBarAction 读最新上下文。
        b.addEventListener("click", (ev) => {
          try {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();   // 别让 canvas 把它当成框选/拖拽
            this.lmbCanvasBarAction(cls === "lmb-bar-comment" ? "comment"
              : cls === "lmb-bar-jump" ? "jump"
              : cls === "lmb-bar-view" ? "view"
              : cls === "lmb-bar-color" ? "color"
              : cls === "lmb-bar-follow" ? "follow"
              : cls === "lmb-bar-disconnect" ? "disconnect" : "fit");
          } catch (_) { /* noop */ }
        });
        return b;
      };
      // v0.14.8：4 个按钮统一加两个字文字（"评论"/"跳转"/"视图"/"高度"）—— 用户反馈
      //   纯图标按钮看不清用途，统一"图标 + 两字文字"既好认又对齐。label 保留完整 aria-label。
      bar.appendChild(mk("lmb-bar-comment", "message-square", "添加或编辑评论", "评论"));
      bar.appendChild(mk("lmb-bar-jump", "book-open", "跳回 PDF 原位置", "跳转"));
      bar.appendChild(mk("lmb-bar-view", "image", "切换文字或图片视图", "视图"));
      bar.appendChild(mk("lmb-bar-color", "palette", "修改摘录颜色", "颜色"));
      bar.appendChild(mk("lmb-bar-fit", "move-vertical", "根据内容自动调整卡片高度", "高度"));
      bar.appendChild(mk("lmb-bar-follow", "git-branch", "移动父卡时带上全部子卡", "联动"));
      bar.appendChild(mk("lmb-bar-disconnect", "unlink", "断开卡片连线", "断开"));

      wrapperEl.appendChild(bar);
      return bar;
    } catch (_) { return null; }
  },

  /**
   * 派发悬浮栏按钮动作。
   *   上下文统一从 this._barCtx 读（每轮 tick 更新），**不用**创建按钮时的闭包快照 ——
   *   浮层是复用的，选中卡片会变，闭包捕获的旧 nodeId 会操作到错误的卡片上。
   * @param {"comment"|"jump"|"view"} kind
   */
  lmbCanvasBarAction(kind) {
    try {
      let c = this._barCtx;
      if (!c) {
        // v0.13.7：**不要静默 return**。轮询期间 canvas 选中会间歇性返回空
        //   （焦点切换 / Modal 开关 / canvas 内部 state 刷新），那一刻 _lmbHideBar 清掉
        //   _barCtx；等下次 tick 重建前用户点按钮 → 拿到 null → 旧版直接 return，
        //   用户视角就是"点了没反应、连 Notice 都不弹"（v0.13.6 用户反馈）。
        //   这里不依赖轮询，直接从当前选中即时重建一次。
        c = this._lmbRebuildBarCtx();
      }

      if (kind === "color") {
        const ex = String(c.node && c.node.text || "").match(EX_ID_RE);
        if (ex) this.lmbChooseExcerptColor(ex[0].slice(1), document.querySelector(".lmb-canvas-bar .lmb-bar-color"));
        return;
      }
      if (!c) {
        // 真的没选中卡片 —— 也要告诉用户，绝不静默失败
        try { new Notice("没找到选中的卡片，请重新点选一张卡", 2500); } catch (_) {}
        return;
      }

      if (kind === "comment") {
        // v0.13.2：评论编辑 Modal 关闭后 canvas 选中可能丢失 → 浮层暂时消失。
        //   不等 120ms 自然 tick，Modal 关闭后立刻刷一次，确保浮层尽快回来。
        //   这是 v0.13.1 守卫之外的**第二道保险** —— 守卫保住按下时选中，但 Modal 关闭
        //   这种纯逻辑事件守卫拦不到，只能靠这里主动 tick。
        const p = this.editCommentForNode(c.file, c.nodeId);
        if (p && typeof p.then === "function") {
          p.then(() => { try { this.lmbCanvasBarTick(); } catch (_) {} });
        }
        return;
      }
      if (kind === "jump") {
        // v0.13.2：jump 后当前 canvas leaf 可能失焦（切到 PDF leaf），立即 tick 让浮层/选中状态对齐
        // acts.jump 是剥掉 [[]] 与 |别名 的链接正文，参数解析交给现有的 lmbParsePdfLink
        const hit = this.lmbParsePdfLink(c.acts && c.acts.jump);
        if (hit) this.lmbJumpToSelection(hit.filePath, hit.page, hit.selection, hit.rect);
        try { this.lmbCanvasBarTick(); } catch (_) {}
        return;
      }
      if (kind === "view") {
        // v0.16.0：**不再靠 lmb-view callout 反查 host**（新卡不写那行了，查了也是 null
        //   → 按钮静默失效，v0.13.1 同款坑）。直接取渲染容器 host 传给 toggleCardViewByHost。
        //   host 优先级：.canvas-node-content（canvas 文本节点的内容容器）→ 节点元素本身兜底。
        //   切完 host class（lmb-view-img）→ 卡片高度变化 → 浮层位置要重算
        //   v0.13.2：切完立刻 tick（不等 120ms），否则用户看到浮层停在旧位置上像没响应
        const el = c.nodeEl;
        const host = (el && el.querySelector)
          ? (el.querySelector(".canvas-node-content") || el.querySelector(".markdown-rendered") || el)
          : null;
        if (host) {
          const toImg = this.toggleCardViewByHost(host);
          if (toImg !== null) {
            this.settings.nodeViews = this.settings.nodeViews || {};
            this.settings.nodeViews[c.file.path + "::" + c.nodeId] = toImg ? "image" : "text";
            const ex = String(c.node && c.node.text || "").match(EX_ID_RE);
            if (ex) {
              this.settings.excerptViews = this.settings.excerptViews || {};
              this.settings.excerptViews[ex[0].slice(1)] = toImg ? "image" : "text";
            }
            this.saveSettings().catch(() => {});
            setTimeout(() => {
              this._lmbAutoFitCard(c.file, c.nodeId, c.node, { allowViewShrink: true })
                .then(() => { try { this.lmbCanvasBarTick(); } catch (_) {} })
                .catch((err) => console.warn("[lmb] view auto-fit failed:", err));
            }, 0);
          }
        } else {
          // 真的拿不到容器 —— 也要告诉用户，绝不静默失败（v0.13.7 定下的规矩）
          try { new Notice("找不到卡片内容容器，视图未能切换", 2500); } catch (_) {}
        }
        setTimeout(() => { try { this.lmbCanvasBarTick(); } catch (_) {} }, 0);
      }
      if (kind === "fit") {
        // v0.14.3：入口探针「开始调整卡片高度…」使命完成（v0.13.9 加它定位链路，
        //   v0.14.1 实锤断点后已确认全链路通），正常路径只保留最终结果一个 Notice，
        //   避免每次点击连弹三条。失败路径的编号探针（fit[0]-[4]、Promise 异常）
        //   全部保留 —— 异常时依然每一步都说话。
        // v0.14.1：调用本身也要有探针 —— 上一版只有入口探针，`lmbFitNodeById` 内部
        //   的无声 early return 让流程断在中间而用户毫无感知。现在：
        //   调用抛异常 / 返回非 Promise / Promise 内部 early return（fit[1]-[4] 编号
        //   Notice）每一步都可见，不再有任何静默出口。
        try {
          const p = this.lmbFitNodeById(c.file, c.nodeId, c.node);
          if (p && typeof p.then === "function") {
            p.then(() => { try { this.lmbCanvasBarTick(); } catch (_) {} })
             .catch((err) => {
               console.warn("[lmb] fit error:", err);
               try { new Notice("fit Promise 异常：" + (err && err.message ? err.message : err), 3200); } catch (_) {}
             });
          } else {
            try { new Notice("fit[0] lmbFitNodeById 未返回 Promise（typeof=" + typeof p + "）", 3200); } catch (_) {}
          }
        } catch (err) {
          console.warn("[lmb] fit call error:", err);
          try { new Notice("fit 调用异常：" + (err && err.message ? err.message : err), 3200); } catch (_) {}
        }
      }
      if (kind === "disconnect") {
        const p = this.lmbDisconnectCard(c);
        if (p && typeof p.then === "function") {
          p.then(() => { try { this.lmbCanvasBarTick(); } catch (_) {} })
            .catch((err) => {
              console.warn("[lmb] disconnect error:", err);
              try { new Notice("断开连线失败：" + (err && err.message ? err.message : err), 3200); } catch (_) {}
            });
        }
      }
      if (kind === "follow") {
        const enabled = !(this.settings && this.settings.moveDescendantsWithParent === true);
        if (this.settings) this.settings.moveDescendantsWithParent = enabled;
        const p = this.saveSettings();
        if (p && typeof p.catch === "function") p.catch((err) => console.warn("[lmb] save follow setting failed:", err));
        this._barSig = "";
        try { this.lmbCanvasBarTick(); } catch (_) {}
        try { new Notice(enabled ? "已开启：移动父卡时子卡会一起移动" : "已关闭子卡联动移动", 2200); } catch (_) {}
      }
    } catch (_) { /* noop：按钮回调绝不能抛错破坏 canvas */ }
  },

  /** 取得运行时 edge 对应的可点击 SVG/DOM；不同 Obsidian 版本字段名不同，逐项兼容。 */
  _lmbDisconnectEdgeTargets(canvas, edgeId) {
    const out = [];
    const add = (el) => {
      if (!el || typeof el.addEventListener !== "function" || out.includes(el)) return;
      out.push(el);
    };
    try {
      let runtime = null;
      if (canvas && canvas.edges) {
        runtime = typeof canvas.edges.get === "function" ? canvas.edges.get(edgeId) : canvas.edges[edgeId];
        if (!runtime) {
          const vals = typeof canvas.edges.values === "function"
            ? Array.from(canvas.edges.values()) : Object.values(canvas.edges);
          runtime = vals.find((e) => e && (e.id === edgeId || (e.edge && e.edge.id === edgeId)
            || (e.data && e.data.id === edgeId)));
        }
      }
      if (runtime) {
        for (const k of ["lineGroupEl", "interactionEl", "pathEl", "path", "el", "svgEl"]) add(runtime[k]);
        if (runtime.line) {
          for (const k of ["interactionEl", "pathEl", "path", "el"]) add(runtime.line[k]);
        }
      }
      const root = canvas && canvas.wrapperEl;
      if (root && typeof root.querySelectorAll === "function") {
        const safe = String(edgeId).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        for (const el of Array.from(root.querySelectorAll(
          `[data-edge-id="${safe}"], [data-id="${safe}"]`
        ))) add(el);
      }
    } catch (_) {}
    return out;
  },

  _lmbExitDisconnectMode(silent) {
    const mode = this._lmbDisconnectMode;
    if (!mode) return false;
    try {
      for (const item of mode.bindings || []) {
        try { item.el.removeEventListener("pointerdown", item.down, true); } catch (_) {}
        try { item.el.removeEventListener("click", item.click, true); } catch (_) {}
        try { item.el.classList.remove("lmb-disconnect-candidate"); } catch (_) {}
      }
      if (mode.keydown) document.removeEventListener("keydown", mode.keydown, true);
    } catch (_) {}
    this._lmbDisconnectMode = null;
    if (!silent) { try { new Notice("已退出连线选择", 1200); } catch (_) {} }
    return true;
  },

  _lmbDisconnectChoiceLabel(edge, nodeId, nodes) {
    try {
      const otherId = edge.fromNode === nodeId ? edge.toNode : edge.fromNode;
      const other = (Array.isArray(nodes) ? nodes : []).find((n) => n && n.id === otherId);
      let text = other && typeof other.text === "string" ? other.text : otherId;
      text = String(text || "未知卡片").split(/\r?\n/)[0]
        .replace(/^[#>*\-+\s]+/, "").replace(/\[\[|\]\]/g, "").trim();
      if (text.length > 32) text = text.slice(0, 32) + "…";
      return `断开与「${text || "未命名卡片"}」的连线`;
    } catch (_) { return "断开这条连线"; }
  },

  _lmbEnterDisconnectMode(file, canvas, nodeId, candidates, data) {
    this._lmbExitDisconnectMode(true);
    const bindings = [];
    let allResolved = true;
    for (const edge of candidates) {
      const targets = this._lmbDisconnectEdgeTargets(canvas, edge.id);
      if (!targets.length) { allResolved = false; break; }
      const label = this._lmbDisconnectChoiceLabel(edge, nodeId, data.nodes);
      for (const el of targets) {
        const down = (ev) => {
          try { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); } catch (_) {}
        };
        const click = (ev) => {
          try { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); } catch (_) {}
          this._lmbExitDisconnectMode(true);
          this._lmbDeleteCanvasEdge(file, canvas, edge.id).catch(() => {});
        };
        try {
          el.classList.add("lmb-disconnect-candidate");
          el.setAttribute("aria-label", label);
          el.addEventListener("pointerdown", down, true);
          el.addEventListener("click", click, true);
          bindings.push({ el, down, click });
        } catch (_) {}
      }
    }
    if (!allResolved || !bindings.length) {
      for (const item of bindings) {
        try { item.el.removeEventListener("pointerdown", item.down, true); } catch (_) {}
        try { item.el.removeEventListener("click", item.click, true); } catch (_) {}
        try { item.el.classList.remove("lmb-disconnect-candidate"); } catch (_) {}
      }
      const items = candidates.map((edge) => ({
        edgeId: edge.id,
        label: this._lmbDisconnectChoiceLabel(edge, nodeId, data.nodes)
      }));
      try {
        new LMBNodeSuggester(this.app, items,
          (it) => { this._lmbDeleteCanvasEdge(file, canvas, it.edgeId).catch(() => {}); }).open();
      } catch (_) { new Notice("无法定位连线，请先直接点选要删除的线", 2600); }
      return;
    }
    const keydown = (ev) => {
      if (ev && ev.key === "Escape") {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
        this._lmbExitDisconnectMode(false);
      }
    };
    document.addEventListener("keydown", keydown, true);
    this._lmbDisconnectMode = { bindings, keydown, filePath: file.path, nodeId };
    new Notice("请选择要断开的高亮连线；Esc 或再次点“断开”可取消", 4200);
  },

  async lmbDisconnectCard(barCtx) {
    if (this._lmbDisconnectMode) {
      this._lmbExitDisconnectMode(false);
      return false;
    }
    const ctx = this.activeCanvasContext();
    const view = ctx && ctx.leaf && ctx.leaf.view;
    const canvas = view && view.canvas;
    const file = (barCtx && barCtx.file) || (ctx && ctx.file);
    const nodeId = barCtx && barCtx.nodeId;
    if (!canvas || !file || !nodeId || typeof canvas.getData !== "function") {
      new Notice("无法读取当前画布或选中卡片", 2400);
      return false;
    }
    const data = canvas.getData();
    const sidecar = (this.autoEdges && this.autoEdges.get(file.path)) || new Set();
    const plan = lmbPlanDisconnect(nodeId, data && data.edges, sidecar);
    if (plan.kind === "none") {
      new Notice("这张卡片没有连线", 1600);
      return false;
    }
    if (plan.kind === "direct") return this._lmbDeleteCanvasEdge(file, canvas, plan.edgeId);
    this._lmbEnterDisconnectMode(file, canvas, nodeId, plan.candidates, data);
    return true;
  },

  async _lmbDeleteCanvasEdge(file, canvas, edgeId) {
    if (!canvas || typeof canvas.getData !== "function" || typeof canvas.setData !== "function") {
      new Notice("当前 Obsidian 版本不支持直接修改连线", 2200);
      return false;
    }
    const latest = canvas.getData();
    const edges = latest && Array.isArray(latest.edges) ? latest.edges : [];
    const edge = edges.find((e) => e && e.id === edgeId);
    if (!edge) { new Notice("这条连线已经不存在", 1600); return false; }
    const next = Object.assign({}, latest, {
      nodes: Array.isArray(latest.nodes) ? latest.nodes.map((n) => Object.assign({}, n)) : [],
      edges: edges.filter((e) => e && e.id !== edgeId).map((e) => Object.assign({}, e))
    });
    const sidecar = (this.autoEdges && this.autoEdges.get(file.path)) || new Set();
    const wasAuto = sidecar.has(edgeId);
    this._instantSkip = Date.now() + 1200;
    canvas.setData(next);
    // setData 成功后再改账本；若 Canvas 拒绝写入，不能留下“线还在、登记已删”的半状态。
    sidecar.delete(edgeId);
    if (this.autoEdges) this.autoEdges.set(file.path, sidecar);
    if (typeof canvas.requestFrame === "function") canvas.requestFrame();
    if (typeof canvas.requestSave === "function") canvas.requestSave();
    if (this.persistAutoSizeSoon) this.persistAutoSizeSoon();
    this._barSig = null;
    this._lmbLastDisconnected = {
      filePath: file.path, canvas, edge: Object.assign({}, edge), wasAuto, at: Date.now()
    };
    const notice = new Notice("已断开连线", 6500);
    try {
      const host = notice && notice.noticeEl;
      if (host && host.createEl) {
        host.createEl("button", { text: "撤销" }).addEventListener("click", () => {
          this._lmbUndoDisconnectedEdge().catch(() => {});
          try { notice.hide(); } catch (_) {}
        });
      }
    } catch (_) {}
    return true;
  },

  async _lmbUndoDisconnectedEdge() {
    const rec = this._lmbLastDisconnected;
    if (!rec || Date.now() - rec.at > 30000) {
      new Notice("没有可撤销的断线操作", 1600);
      return false;
    }
    const canvas = rec.canvas;
    const latest = canvas && typeof canvas.getData === "function" ? canvas.getData() : null;
    if (!latest || !Array.isArray(latest.edges)) return false;
    if (!latest.edges.some((e) => e && e.id === rec.edge.id)) {
      const next = Object.assign({}, latest, {
        nodes: Array.isArray(latest.nodes) ? latest.nodes.map((n) => Object.assign({}, n)) : [],
        edges: latest.edges.map((e) => Object.assign({}, e)).concat([Object.assign({}, rec.edge)])
      });
      canvas.setData(next);
      if (typeof canvas.requestFrame === "function") canvas.requestFrame();
      if (typeof canvas.requestSave === "function") canvas.requestSave();
    }
    if (rec.wasAuto && this.autoEdges) {
      const sidecar = this.autoEdges.get(rec.filePath) || new Set();
      sidecar.add(rec.edge.id);
      this.autoEdges.set(rec.filePath, sidecar);
    }
    if (this.persistAutoSizeSoon) this.persistAutoSizeSoon();
    this._lmbLastDisconnected = null;
    this._barSig = null;
    new Notice("已恢复连线", 1600);
    return true;
  },

  /**
   * v0.16.1：给画布上的**双重摘录卡**打标（nodeEl 加 lmb-dual class）。
   *
   * 为什么要这个（Bug5 的完整因果）：
   *   v0.11.3~v0.15.0 靠卡里那行 `> [!lmb-view]` callout 当 CSS 判据
   *   （`:has(.callout[data-callout="lmb-view"]) img{display:none}`）→ 有效。
   *   v0.16.0 卡片精简后新卡不写这行了，把 CSS 判据换成
   *   `:has(a[href*=".pdf#page="]):has(img)` —— **实测不命中**，双重卡在文字视图下
   *   图文并存（用户反馈 Bug5）。根因：canvas 卡片里指向 .pdf 的 internal-link，
   *   Obsidian 渲染时对**非 md 文件**很可能丢弃 #page= 子路径（href/data-href 只剩
   *   "xxx.pdf"），属性选择器匹配不上 → 猜 DOM 结构不如不让 CSS 猜。
   *
   *   修法（本函数）：判定权收回 JS —— 用 lmbPickBarActions().view（markdown 层，
   *   同时含 pdf 引用行 + 截图 embed）判双重卡，把结果**打在 nodeEl** 上
   *   （class `lmb-dual`）；CSS 改用 `.lmb-dual … img{display:none}`。
   *   这样 CSS 与 JS 判定 **100% 同源**：JS 给「视图」按钮的判据 = CSS 藏图的判据，
   *   不会出现「图片被 CSS 藏了却没有按钮切回来」的死角。
   *
   * 为什么打在 nodeEl 而不是 contentEl：markdown **重渲染会重建** contentEl
   *   （class 随之丢失、缓存却以为没变 → 永不重打 → 标记静默失效）；nodeEl 的
   *   生命周期 = 节点生命周期，稳定。
   *
   * 性能：低频兜底扫描全部节点；文本、宿主和视图状态没变的卡直接跳过，
   *   正则和 DOM 写入都不再执行；nodeEl 未就绪的卡不写缓存，下轮重试。
   *
   * 副作用清理：onunload 不特意摘 class —— class 是无害标记，插件重载后本函数
   *   会重新对齐（变非双重卡的卡会被 toggle 掉）。
   */
  lmbMarkDualCards(canvas) {
    try {
      if (!this._lmbDualCache) this._lmbDualCache = new Map();
      const cache = this._lmbDualCache;
      const nodes = canvas && canvas.nodes;
      if (!nodes) return;
      const entries = (typeof nodes.entries === "function") ? nodes.entries() : Object.entries(nodes);
      for (const [id, node] of entries) {
        if (!node || typeof node.text !== "string" || !node.text) continue;
        const c = cache.get(id);
        const el = node.nodeEl || node.contentEl;
        // host 只用来确认内容容器已渲染；class 本身打 nodeEl（抗 markdown 重渲染）
        const host = el && el.querySelector
          ? (el.querySelector(".canvas-node-content") || el.querySelector(".markdown-rendered"))
          : null;
        if (!host) continue;                             // 未就绪 → 不写缓存，下轮重试
        // Fast path: unchanged text and host means the expensive action regexes
        // and DOM writes can be skipped.  The previous implementation read the
        // cache but never used it, so every fallback tick reparsed every card.
        const cachedExId = c && c.text === node.text ? c.exId : "";
        const cachedSaved = (cachedExId && this.settings.excerptViews && this.settings.excerptViews[cachedExId])
          || (this.settings.nodeViews && this.settings.nodeViews[(canvas.view && canvas.view.file
            ? canvas.view.file.path : "") + "::" + id]);
        if (c && c.text === node.text && c.host === host && c.saved === cachedSaved
          && !!(el.classList && el.classList.contains("lmb-dual")) === !!c.dual
          && !!host.classList.contains("lmb-view-img") === !!(c.dual && cachedSaved === "image")) continue;
        const isDual = !!lmbPickBarActions(node.text).view;
        // Markdown 重渲染会替换 host；即使文本 hash 没变，也必须在新 host 上恢复视图。
        const ex = String(node.text || "").match(EX_ID_RE);
        const exId = ex ? ex[0].slice(1) : "";
        const saved = (exId && this.settings.excerptViews && this.settings.excerptViews[exId])
          || (this.settings.nodeViews && this.settings.nodeViews[(canvas.view && canvas.view.file
            ? canvas.view.file.path : "") + "::" + id]);
        if (el.classList) el.classList.toggle("lmb-dual", isDual);
        if (isDual) host.classList.toggle("lmb-view-img", saved === "image");
        cache.set(id, { text: node.text, dual: isDual, host: host, exId, saved });
      }
      // 缓存里已删除节点的条目顺手清掉（防长期使用内存缓慢增长）
      const has = (typeof nodes.has === "function") ? (k) => nodes.has(k) : (k) => (k in nodes);
      for (const id of Array.from(cache.keys())) {
        if (!has(id)) cache.delete(id);
      }
    } catch (_) { /* noop：打标失败只影响显隐，绝不能打断轮询 */ }
  },

  /**
   * v0.13.7：即时从**当前** canvas 选中重建 _barCtx（不依赖轮询缓存）。
   *
   * 为什么需要：轮询期间 canvas.getSelection() 会**间歇性**返回空
   *   （焦点切换 / Modal 开关 / canvas 内部 state 刷新的瞬间）。那一刻 tick 走
   *   _lmbHideBar() 把 _barCtx 清成 null；等下次 tick 重建之前，
   *   用户点按钮就会拿到 null —— 旧版直接 `if (!c) return` 静默退出，
   *   用户视角"点了没反应、连 Notice 都不弹"。
   *
   * 这里绕开轮询缓存，直接重新解析一次当前选中；拿不到才让调用方提示用户。
   * 只处理「恰好 1 个 text 节点」，与 tick 的判定保持一致（多选/没选中/group 不算）。
   */
  _lmbRebuildBarCtx() {
    try {
      const ctx = this.activeCanvasContext();
      if (!ctx) return null;
      const view = ctx.leaf && ctx.leaf.view;
      const canvas = view ? view.canvas : null;
      if (!canvas || !canvas.nodes) return null;
      let arr = [];
      try {
        arr = LmbCanvasAdapter.selection(canvas);
      } catch (_) { arr = []; }
      const nodes = arr.filter((n) => n && typeof n.text === "string" && n.type !== "group");
      if (nodes.length !== 1) return null;
      const node = nodes[0];
      const nodeEl = node.nodeEl || node.contentEl;
      if (!nodeEl) return null;
      const acts = lmbPickBarActions(node.text);
      try {
        const data = LmbCanvasAdapter.data(canvas);
        const sidecar = (this.autoEdges && this.autoEdges.get(ctx.file.path)) || new Set();
        acts.disconnect = lmbPlanDisconnect(node.id, data && data.edges, sidecar).kind !== "none";
      } catch (_) { acts.disconnect = false; }
      this._barCtx = { file: ctx.file, nodeId: node.id, node, acts, nodeEl };
      return this._barCtx;
    } catch (_) { return null; }
  },

  /**
   * v0.13.3：按 file+nodeId 找到 canvas 节点，实际测量 DOM 高度并写回 canvas json。
   *   返回 Promise（让 caller 可以 then 里 tick；fire-and-forget 也行）。
   *   复用 32-plugin-canvas.js 的 lmbFitNodeActual（DOM 是真相，最准）。
   *   写文件模式与 processCanvas 一致：selfWritten 防自写循环、缩进与原文件保持一致。
   */
  /** 为手动高度提交创建全新的数据/节点引用，避免原地修改实时节点导致 Canvas 跳过重绘。 */
  _lmbCloneCanvasForHeight(data, nodeId, height) {
    if (!data || !Array.isArray(data.nodes)) return null;
    const cloned = Object.assign({}, data, {
      nodes: data.nodes.map((n) => Object.assign({}, n)),
      edges: Array.isArray(data.edges) ? data.edges.map((e) => Object.assign({}, e)) : []
    });
    const node = cloned.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    node.height = height;
    return { data: cloned, node };
  },

  lmbFitNodeById(file, nodeId, nodeHint, opts) {
    return (async () => {
      try {
        const quiet = !!(opts && opts.quiet);
        // v0.14.1：每个 early return 都带编号探针。上一版只探了分支入口（「开始调整…」
        //   弹了），但函数内部的 4 个无声 early return 仍然在静默退出 —— 用户看到的
        //   还是"只有探针没下文"。编号探针弹哪个，断点就在哪，一步定位不用再猜。
        if (!file || !nodeId) {
          try { new Notice("fit[1] 缺少 file 或 nodeId", 2600); } catch (_) {}
          return null;
        }
        const ctx = this.activeCanvasContext();
        if (!ctx) {
          try { new Notice("fit[2] 拿不到画布上下文（activeCanvasContext 为空）", 2600); } catch (_) {}
          return null;
        }
        const view = ctx.leaf && ctx.leaf.view;
        const canvas = view ? view.canvas : null;
        if (!canvas || !canvas.nodes) {
          try { new Notice("fit[3] 拿不到 canvas 对象或 nodes 集合", 2600); } catch (_) {}
          return null;
        }
        // v0.13.6：优先 canvas 内部 API（getData / setData / requestSave）。
        //   旧版走「读文件 → 改 → 写文件」—— 磁盘往返慢是次要的，**致命的是改了 live
        //   node 却没调 requestSave，canvas 内部 state 不刷新 → 视觉上什么都没变**。
        //   instantAttach（v0.5.0 起）早就证明 setData + requestSave 是毫秒级生效的正路。
        const canInternal = typeof canvas.getData === "function"
          && typeof canvas.setData === "function"
          && typeof canvas.requestSave === "function";
        // v0.14.2：**节点对象由调用方直接传入（nodeHint），不再依赖 canvas.nodes.get 反查**。
        //   v0.14.1 探针实锤：get(nodeId) 返回的对象 type=undefined（该环境节点对象
        //   结构与预期不符），导致 fit[4] 静默退出。而 _barCtx 里的 node 是 tick 从
        //   selection 拿的、经过 `typeof n.text === "string"` 验证的对象 —— 直接用它。
        //   同时 type 检查放宽为 text 检查：能 fit 的判据是"有文本可量"，不是某个
        //   特定字段的字面值。
        let node = (nodeHint && typeof nodeHint.text === "string") ? nodeHint : null;
        if (!node) {
          node = typeof canvas.nodes.get === "function" ? canvas.nodes.get(nodeId) : canvas.nodes[nodeId];
        }
        if (!node || typeof node.text !== "string") {
          try {
            const keys = node ? Object.keys(node).slice(0, 8).join(",") : "无";
            new Notice("fit[4] 节点不可用（"
              + (node
                ? "keys=[" + keys + "]"
                : "未找到，id=" + String(nodeId == null ? "null" : nodeId).slice(0, 8)) + "）", 3600);
          } catch (_) {}
          return null;
        }
        // v0.14.3：fit[5] 中间探针已移除（链路验证完成；测量段自身有兜底 ——
        //   naturalH=0 时会弹「未能测量内容高度」，不会静默）。
        // v0.13.5：等 nodeEl 就绪（最多 500ms）。canvas reactive 渲染是异步的，
        //   点 fit 按钮时 markdown 可能还在 layout —— 直接测 scrollHeight 会得 0。
        await this._lmbWaitForNodeEl(node, 500);
        if (this.lmbMarkDualCards) this.lmbMarkDualCards(canvas);

        // v0.16.12：测量离屏自然展开副本，避免当前卡片的固定高度、滚动条宽度和
        // overflow 状态污染结果。同一内容/同一外框宽度应得到稳定的同一高度。
        let naturalH = 0;
        let measuredWholeCard = false;
        try {
          const wrapperEl = node.nodeEl || node.contentEl;
          const contentEl = wrapperEl && wrapperEl.querySelector
            ? (wrapperEl.querySelector(".canvas-node-content")
              || wrapperEl.querySelector(".markdown-rendered") || wrapperEl)
            : null;
          // v0.16.2【Bug4 残留根因】：等卡内**图片加载完**（最多 2s）再实测。
          //   _lmbWaitForNodeEl 等的是 nodeEl 存在，不是内容 layout 完成 —— img 未加载时
          //   高度是 0/占位，实测必然偏小 → 「一次 fit 不到位，再点一次才对」（用户长文
          //   自建卡带图时症状完全吻合：第一次裁、第二次图加载完了就对了）。
          //   complete = 加载完成或失败（失败也占位，等它没有意义）；循环 120ms 一查。
          try {
            const imgs = contentEl && contentEl.querySelectorAll
              ? Array.from(contentEl.querySelectorAll("img")) : [];
            const tImg = Date.now();
            while (Date.now() - tImg < 2000) {
              if (!imgs.some((im) => !im.complete && (!im.getClientRects || im.getClientRects().length))) break;
              await new Promise((r) => setTimeout(r, 120));
            }
          } catch (_) {}
          if (contentEl && contentEl.children && contentEl.children.length > 0) {
            // 等字体就绪；用短超时避免第三方字体异常让按钮一直没有响应。
            try {
              const fontsReady = contentEl.ownerDocument && contentEl.ownerDocument.fonts
                ? contentEl.ownerDocument.fonts.ready : null;
              if (fontsReady && typeof fontsReady.then === "function") {
                await Promise.race([fontsReady, new Promise((r) => setTimeout(r, 600))]);
              }
            } catch (_) {}
            let scale = 1;
            try {
              const s = canvas && canvas.scale;
              if (s && isFinite(s) && s > 0) scale = s;
            } catch (_) { scale = 1; }
            // 至少等待三次一致（而不是旧版两次），并取稳定样本；每次都是全新的自然布局副本。
            let previous = 0, best = 0, stable = 0;
            for (let sample = 0; sample < 6; sample++) {
              const measured = lmbMeasureNaturalCard(wrapperEl, contentEl, scale, {
                ignoreLiveHeight: !!(opts && opts.allowViewShrink)
              });
              if (measured > 0) {
                best = Math.max(best, measured);
                if (previous > 0 && Math.abs(measured - previous) < 1) stable++;
                else stable = 0;
                previous = measured;
              }
              if (stable >= 2) break;
              if (sample < 5) await new Promise((r) => setTimeout(r, 50));
            }
            naturalH = stable >= 2 ? previous : best;
            measuredWholeCard = naturalH > 0;
          }
        } catch (_) {}
        // 兜底：子元素未就绪（markdown 未渲染完 / children 为空）→ 估算
        let usedEstimate = false;
        if (naturalH <= 0) {
          try {
            const size = this.estimateSizeFor(node.text, { width: node.width, view: opts && opts.view });
            naturalH = Math.round(size.h);
            usedEstimate = naturalH > 0;
            if (!quiet) { try { new Notice("内容未就绪，使用估算高度", 1600); } catch (_) {} }
          } catch (_) {}
        }
        // A valid natural measurement takes precedence over estimates that may
        // still include a hidden screenshot or raw Markdown. Verify overflow below.
        const origH = node.height;
        let beforeDomH = null;
        try {
          const beforeEl = node.nodeEl || node.contentEl;
          const beforeRect = beforeEl && beforeEl.getBoundingClientRect ? beforeEl.getBoundingClientRect() : null;
          const beforeScale = canvas && isFinite(canvas.scale) && canvas.scale > 0 ? canvas.scale : 1;
          if (beforeRect && beforeRect.height > 0) beforeDomH = beforeRect.height / beforeScale;
        } catch (_) {}
        // v0.14.8：评论余量。评论块（含折叠/展开 callout）的底部内边距比普通行大，
        //   固定 24px buffer 在带评论的卡片上会被裁掉底行（用户反馈「到了肯定是劳动力」
        //   末尾被截）。检测文本里有没有评论 callout → 有则额外 +16 buffer（call 块底部
        //   padding + 边框）。不引入精确测量（callout 内容高度由内容决定），16 是经验值。
        const hasComment = (function () {
          try {
            const t = node && node.text;
            if (typeof t !== "string" || !LMB_COMMENT_CALLOUT_RE) return false;
            return t.split(/\r?\n/).some((line) => LMB_COMMENT_CALLOUT_RE.test(line));
          } catch (_) { return false; }
        })();
        // v0.16.2【Bug1 残留根因】：节点自身 chrome（padding + border）从「固定 buffer
        //   经验值」改为**精确测量**。naturalH 是从 contentEl 顶部算到内容底部，但
        //   node.height 指整个卡片 —— contentEl 之外的节点 padding（实测上下各 ~10-12px，
        //   v0.13.3 注释）此前全靠 buffer 24 兜底；有评论时 buffer 40 = 24 + 16，而评论
        //   callout 自身的 padding + border 又吃掉 ~15-25px，两下相抵经常差一点 → 边缘裁剪。
        //   现在：chromePad = nodeEl 实测的 paddingTop/borderTop + paddingBottom/borderBottom
        //   （基线是 contentEl.top，所以 padding-top 也必须补回来；contentEl 自己的
        //   paddingBottom 已在 naturalH 里单独加过，不重复计）。buffer 降为纯内容余量：
        //   有评论 28（末尾 callout 的 padding+border+安全余量）、无评论 8。
        let chromePad = 0;
        try {
          const pel = node.nodeEl || node.contentEl;
          const ncs = pel ? getComputedStyle(pel) : null;
          if (ncs) {
            chromePad = (parseFloat(ncs.paddingTop) || 0) + (parseFloat(ncs.borderTopWidth) || 0)
              + (parseFloat(ncs.paddingBottom) || 0) + (parseFloat(ncs.borderBottomWidth) || 0);
          }
          /* v0.16.6 P1-3：**删掉** contentEl 的 paddingTop/borderTop 补偿 —— 它是重复计入。
           *   旧注释（v0.16.3）称「cRect.top 在 contentEl 的 padding-top **内侧**」，这句是错的：
           *   getBoundingClientRect().top 返回的是 **border-box 顶边**，位于 padding-top
           *   **外侧**。所以上面 walk 里 `r.bottom - cRect.top` 的差值**已经包含**
           *   contentEl 的 borderTop + paddingTop，这里再补一次就是双倍。
           *   后果：每次 fit 系统性多算 contentEl 的 paddingTop+borderTop（canvas 卡片
           *   通常 10~40px）→ 「点一次涨一截、留白越来越多」。
           *   pel（nodeEl）自身那一份 paddingTop/borderTop 是**另一段距离**（nodeEl 顶边
           *   → contentEl 顶边），必须保留，上面的 ncs 计算不受影响。 */
        } catch (_) { chromePad = 0; }
        // v0.16.1【Bug4 根因之一】：上限 1200 → 4000。实测（walk 叶节点）是 DOM 真相，
        //   用户手写的长文自建卡内容远超 1200px，旧钳制把它压回去 → 内容被裁、
        //   「怎么点高度都不对」。摘录卡文本短，4000 的天花板不构成行为变化。
        //   （估算路径的 900 钳制也同步放宽到 2000 —— 见 32-plugin-canvas.js。）
        // estimateSizeFor 返回的已经是整张卡片高度；只有 DOM 实测值才需要补 chrome/buffer。
        let finalH = naturalH > 0
          ? lmbFinalizeCardHeight(naturalH, chromePad, hasComment,
            usedEstimate || measuredWholeCard)
          : (origH || 200);
        // 不要在 setData 前直接修改 nodeHint：它通常就是 Canvas 的实时节点对象。
        // ---- v0.14.9：写入改用「内存数据」而非「文件数据」+ 必要时主动重载画布 ----
        // v0.14.5 起只走文件写（当时判定 setData 无效），带来两个副作用，正是用户这次
        //   反馈的现象：
        //   ① 文件里的内容可能**落后于内存**（用户刚拖动卡片、Obsidian 还没落盘）→
        //      我把旧内容写回 = **覆盖了用户的拖动**（症状「卡片跳回拖拽前的位置」）
        //   ② 写完依赖 Obsidian vault 监听触发 canvas 重载，但该监听不总是触发 →
        //      数据改了画面没刷（症状「点高度没反应，拉伸一下才展开」「要点两下」）
        // 修法：以 canvas.getData() 的**内存最新数据**为准（含用户未落盘的改动），改完
        //   height 后 ① setData 更新内存 ② 用同一份数据写文件（不丢任何改动）
        //   ③ 等 250ms 看渲染跟上没，没跟上就**主动 view.loadFile() 强制重载画布**。
        let memData = null;
        try { memData = canInternal ? canvas.getData() : null; } catch (_) { memData = null; }
        let memOk = false;
        if (memData && Array.isArray(memData.nodes)) {
          const cloned = this._lmbCloneCanvasForHeight(memData, nodeId, finalH);
          if (cloned) {
            memData = cloned.data;
            const changedNode = cloned.node;
            // v0.16.4 修复 P2-7：手动 fit 改高度后仍做一次组内重居中——locked 只锁
            //   「尺寸不被自动 fit 覆盖」，不锁「对齐」；否则撑高后中心偏出父卡轴线且永不回正。
            try {
              lmbRecenterNode(changedNode, memData.nodes,
                Array.isArray(memData.edges) ? memData.edges : (memData.edges = []),
                (this.autoEdges && this.autoEdges.get(file.path)) || new Set());
            } catch (_) {}
            try {
              canvas.setData(memData);
              if (typeof canvas.requestFrame === "function") canvas.requestFrame();
              canvas.requestSave();
              memOk = true;
            } catch (_) {}
          }
        }
        // 写文件：优先用内存数据（含用户拖动），拿不到才回退「读文件→改→写」
        // 内部通道成功时由 requestSave 单独落盘，避免与 adapter.write 双写竞争。
        let writeOk = memOk;
        if (!writeOk) {
          try {
            const raw = await this.app.vault.read(file);
            let d; try { d = JSON.parse(raw); } catch (_) { d = null; }
            const arr = d && d.nodes;
            if (Array.isArray(arr)) {
              const idx = arr.findIndex((n) => n.id === nodeId);
              if (idx >= 0) {
                arr[idx].height = finalH;
                // v0.16.4 P2-7：文件写路径同样补组内重居中
                try {
                  lmbRecenterNode(arr[idx], arr,
                    Array.isArray(d.edges) ? d.edges : (d.edges = []),
                    (this.autoEdges && this.autoEdges.get(file.path)) || new Set());
                } catch (_) {}
                const indent = /\n\t"/.test(raw) ? "\t" : "  ";
                if (this.selfWritten) this.selfWritten.set(file.path, Date.now()); // v0.16.4 P2-4 时间戳
                await this.app.vault.adapter.write(file.path, JSON.stringify(d, null, indent));
                writeOk = true;
              }
            }
          } catch (_) {}
        }
        // 等 vault watcher → canvas 重载
        await new Promise((r) => setTimeout(r, 250));
        // v0.16.13：闭环验证真正的滚动宿主。离屏高度只是预测；最终正确性的判据必须是
        // scrollHeight <= clientHeight。若主题/flex/选中边框造成映射偏差，按实际溢出量
        // 补高后重绘，最多三轮；每轮从最新内存只合并高度，不覆盖用户刚拖动的位置。
        let overflowCorrected = 0;
        if (canInternal) {
          for (let pass = 0; pass < 3; pass++) {
            let overflow = 0;
            try {
              const liveNow = typeof canvas.nodes.get === "function"
                ? canvas.nodes.get(nodeId) : canvas.nodes[nodeId];
              const liveWrapper = liveNow && (liveNow.nodeEl || liveNow.contentEl);
              const liveContent = liveWrapper && liveWrapper.querySelector
                ? (liveWrapper.querySelector(".canvas-node-content")
                  || liveWrapper.querySelector(".markdown-rendered") || liveWrapper)
                : liveWrapper;
              overflow = lmbVerticalOverflow(liveContent);
            } catch (_) { overflow = 0; }
            if (overflow <= 0) break;

            const correctedH = lmbHeightAfterOverflow(finalH, overflow);
            if (correctedH <= finalH) break;
            overflowCorrected += correctedH - finalH;
            finalH = correctedH;
            try {
              const latest = canvas.getData();
              const corrected = this._lmbCloneCanvasForHeight(latest, nodeId, finalH);
              if (!corrected) break;
              memData = corrected.data;
              try {
                lmbRecenterNode(corrected.node, memData.nodes,
                  Array.isArray(memData.edges) ? memData.edges : (memData.edges = []),
                  (this.autoEdges && this.autoEdges.get(file.path)) || new Set());
              } catch (_) {}
              canvas.setData(memData);
              if (typeof canvas.requestFrame === "function") canvas.requestFrame();
              canvas.requestSave();
              writeOk = true;
            } catch (_) { break; }
            await new Promise((r) => setTimeout(r, 180));
          }
        }
        // 回读校验：文件 + canvas 内存
        let readBack = null, canvasReadBack = null;
        try {
          const d2 = JSON.parse(await this.app.vault.read(file));
          const n2 = d2 && d2.nodes && d2.nodes.find((nn) => nn.id === nodeId);
          readBack = n2 ? n2.height : null;
        } catch (_) {}
        if (canInternal) {
          try {
            const data3 = canvas.getData();
            const n3 = data3 && data3.nodes && data3.nodes.find((nn) => nn.id === nodeId);
            canvasReadBack = n3 ? n3.height : null;
          } catch (_) {}
        }
        let renderStale = false;
        try {
          const liveNow = canvas && canvas.nodes
            ? (typeof canvas.nodes.get === "function" ? canvas.nodes.get(nodeId) : canvas.nodes[nodeId]) : null;
          const afterEl = liveNow && (liveNow.nodeEl || liveNow.contentEl);
          const afterRect = afterEl && afterEl.getBoundingClientRect ? afterEl.getBoundingClientRect() : null;
          const afterScale = canvas && isFinite(canvas.scale) && canvas.scale > 0 ? canvas.scale : 1;
          const afterDomH = afterRect && afterRect.height > 0 ? afterRect.height / afterScale : null;
          renderStale = beforeDomH !== null && afterDomH !== null
            && Math.abs(finalH - origH) >= 2 && Math.abs(afterDomH - beforeDomH) < 1;
        } catch (_) { renderStale = false; }
        // 渲染没跟上（canvas 内存高度 ≠ 设定值）→ **主动重载画布**。
        //   这是「点了没反应、拉伸一下才展开」的直接解药：不再干等 Obsidian 的监听，
        //   自己调 view.loadFile(file) 强制重读文件 + 重建节点（选中会保留在同一 view）。
        let reloaded = false;
        if ((canvasReadBack !== null && canvasReadBack !== finalH) || renderStale) {
          try {
            // requestSave 尚未落盘时先用刚才的完整新快照兜底，再重载视图。
            if (readBack !== finalH && memData) {
              const raw5 = await this.app.vault.read(file);
              const indent5 = /\n\t"/.test(raw5) ? "\t" : "  ";
              if (this.selfWritten) this.selfWritten.set(file.path, Date.now());
              await this.app.vault.adapter.write(file.path, JSON.stringify(memData, null, indent5));
              readBack = finalH;
            }
            if (ctx.leaf && ctx.leaf.view && typeof ctx.leaf.view.loadFile === "function") {
              await ctx.leaf.view.loadFile(file);
              await new Promise((r) => setTimeout(r, 220));
              reloaded = true;
              try {
                const d4 = JSON.parse(await this.app.vault.read(file));
                const n4 = d4 && d4.nodes && d4.nodes.find((nn) => nn.id === nodeId);
                readBack = n4 ? n4.height : readBack;
              } catch (_) {}
            }
          } catch (_) {}
        }
        if (this.persistAutoSizeSoon) this.persistAutoSizeSoon();
        let store = this.autoSize ? this.autoSize.get(file.path) : null;
        if (!store) { store = new Map(); if (this.autoSize) this.autoSize.set(file.path, store); }
        store.set(nodeId, { hash: this.simpleHash(node.text), w: node.width, h: finalH,
          locked: !usedEstimate, pendingActual: usedEstimate || undefined,
          naturalHeightVersion: usedEstimate ? undefined : 3 });
        if (usedEstimate && this._scheduleActualFitRetry) this._scheduleActualFitRetry(file);
        // 操作反馈：测量值 + 文件回读 + canvas 内存回读（双保险：哪条通道生效都显示）
        if (!quiet) try {
          const tag = usedEstimate ? "（估算：子元素未就绪）" : "";
          const overflowTag = overflowCorrected > 0 ? `（溢出校正 +${overflowCorrected}px）` : "";
          const tail = reloaded ? "（已强制重载画布）" : "";
          new Notice(`卡片高度：${node.width}×${finalH}（内容 ${naturalH}px${tag}${overflowTag}）｜回读：${readBack == null ? "读不到" : readBack}${tail}`, 3600);
        } catch (_) {}
      } catch (err) {
        // v0.13.7：**异常绝不能静默吞掉**。旧版是 `catch (_) {}` —— 里面任何一步抛错
        //   （getData 不存在、autoSize 未初始化、vault 读取失败…）都被吞，用户视角
        //   就是"点了没反应、Notice 也不弹"。现在既弹 Notice 也打 console。
        console.warn("[lmb] lmbFitNodeById failed:", err);
        try {
          new Notice("调整高度失败：" + (err && err.message ? err.message : "未知错误"), 3500);
        } catch (_) {}
      }
    })();
  },

  /**
   * v0.13.9：命令面板入口「调整选中卡片高度」—— **完全不依赖悬浮栏**。
   *   背景：悬浮栏按钮排查了 5 版用户仍反馈没反应，无法区分是按钮 DOM 问题还是
   *   fit 逻辑问题。命令面板是 Obsidian 最稳的入口，用它做二分：
   *     命令能用 → 问题锁定在悬浮栏链路（按钮 DOM / 事件绑定）
   *     命令也坏 → fit 逻辑本身有问题，换方向修
   *   选卡复用现成的 pickCanvasNode（33-plugin-note-comment.js）：
   *   已选中一张 → 直接用；没选中/多选 → 弹模糊搜索列表让用户挑。
   */
  lmbFitSelectedCard() {
    return (async () => {
      try {
        const ctx = this.activeCanvasContext();
        if (!ctx) {
          try { new Notice("请先打开一个画布（canvas）再执行", 2500); } catch (_) {}
          return null;
        }
        const pick = await this.pickCanvasNode(ctx);
        if (!pick || !pick.node) return null;   // 用户取消选卡
        return await this.lmbFitNodeById(ctx.file, pick.node.id, pick.node);
      } catch (err) {
        console.warn("[lmb] fitSelectedCard failed:", err);
        try { new Notice("调整高度失败：" + (err && err.message ? err.message : "未知错误"), 3500); } catch (_) {}
        return null;
      }
    })();
  },

  /**
   * v0.13.5：等 node.nodeEl 就绪（最多 maxMs）。Obsidian canvas 异步渲染节点时，
   *   nodeEl 可能为 null → 直接 fit 拿不到 DOM。
   *   30ms 一次检查，避免空转。
   */
  _lmbWaitForNodeEl(node, maxMs) {
    return new Promise((resolve) => {
      if (!node) return resolve();
      if (node.nodeEl) return resolve();
      let elapsed = 0;
      const step = 30;
      const tick = () => {
        if (node.nodeEl) return resolve();
        if (elapsed >= maxMs) return resolve();
        elapsed += step;
        setTimeout(tick, step);
      };
      tick();
    });
  },

  /**
   * 按卡片内容决定三个按钮谁该出现。
   *   不是每张卡三个都适用：没有 PDF 引用行的卡点了「跳转」没反应，非双重卡点了
   *   「切换」也没反应 —— 宁可不显示，也不放点了没用的死按钮。
   */
  _lmbApplyBarActions(bar, acts) {
    try {
      const map = {
        comment: ".lmb-bar-comment", jump: ".lmb-bar-jump", view: ".lmb-bar-view",
        fit: ".lmb-bar-fit", follow: ".lmb-bar-follow", disconnect: ".lmb-bar-disconnect"
      };
      for (const k of Object.keys(map)) {
        const b = bar.querySelector(map[k]);
        if (!b) continue;
        // jump 的可用性看 acts.jump 是否为字符串，其余看布尔位
        const ok = k === "follow" ? true : (k === "jump" ? !!(acts && acts.jump) : !!(acts && acts[k]));
        lmbSetToolbarVisibility(b, ok ? "show" : "hideRemove");
        if (k === "follow" && b.classList) b.classList.toggle("is-active",
          !!(this.settings && this.settings.moveDescendantsWithParent));
      }
    } catch (_) { /* noop */ }
  },

  /** 隐藏（而非移除）所有悬浮栏 —— 切出 canvas / 没选中卡片时走这里 */
  _lmbHideBar() {
    try {
      this._barCtx = null;
      document.querySelectorAll(LMB_BAR_SEL).forEach((b) => lmbSetToolbarVisibility(b, "hideRemove"));
    } catch (_) { /* noop */ }
  },

  /**
   * 单次轮询。
   *   canvas 没有原生的「选中变化」事件（advanced-canvas 那个 selection-changed 是它自己
   *   monkey-patch 出来的，要引 monkey-around 依赖，不值得），所以只能轮询。
   *   一次轮询同时解决两件事：选中变化 → 重建按钮；视口平移缩放 → 重算位置。
   *
   *   性能上的分工（很重要）：
   *     - 位置**每轮都重算**：拖动卡片、平移画布时它都会变，而 getBoundingClientRect()
   *       只读两个元素，低频执行开销很小。
   *     - 按钮**只在指纹变化时才重建**：那是要动 DOM 的（清 class、setIcon 已建好不再动，
   *       但要重设显隐与上下文），每帧做纯属浪费。
   *
   *   本函数是 setInterval 回调，**整体绝不能抛异常**，否则会持续刷错误。
   */
  lmbCanvasBarTick() {
    try {
      if (this._barDragging) {
        document.querySelectorAll(LMB_BAR_SEL).forEach((b) => lmbSetToolbarVisibility(b, "hideRemove"));
        return;
      }
      const ctx = this.activeCanvasContext();
      if (!ctx) { this._lmbHideBar(); return; }

      const view = ctx.leaf && ctx.leaf.view;
      const canvas = view ? view.canvas : null;
      if (!canvas) { this._lmbHideBar(); return; }

      // v0.16.1：双重摘录卡打标（Bug5 修复）。刻意放在「选中判定」**之前** ——
      //   打标服务的是**所有**卡的显隐（没选中也要打），不依赖 wrapperEl / 选中集合。
      //   失败被内部 try/catch 吞掉，绝不影响后面的浮层逻辑。
      this.lmbMarkDualCards(canvas);

      // 挂载点：优先官方的 wrapperEl（不参与缩放），退化为 DOM 查询
      const wrapperEl = canvas.wrapperEl
        || (ctx.leaf.containerEl && ctx.leaf.containerEl.querySelector(".canvas-wrapper"));
      if (!wrapperEl) { this._lmbHideBar(); return; }

      // 选中集合：getSelection() 优先，退化 .selection 属性
      let arr = [];
      try {
        const sel = typeof canvas.getSelection === "function"
          ? canvas.getSelection() : canvas.selection;
        arr = sel ? Array.from(sel) : [];
      } catch (_) { arr = []; }

      // 只服务「恰好选中 1 个文本节点」：
      //   没选中 / 多选 / 选中的是 file·link·group 节点 → 一律不显示。
      //   多选取第一个容易误操作（用户以为操作的是整组），不如干脆不显示。
      const nodes = arr.filter((n) => n && typeof n.text === "string" && n.type !== "group");
      if (nodes.length !== 1) { this._lmbHideBar(); return; }
      const node = nodes[0];

      const nodeEl = node.nodeEl || node.contentEl;
      if (!nodeEl || typeof nodeEl.getBoundingClientRect !== "function") { this._lmbHideBar(); return; }
      // v0.18：首次遇到节点时从 data.json 恢复用户上次选择的文字/图片视图。
      try {
        const host = nodeEl.querySelector && (nodeEl.querySelector(".canvas-node-content") || nodeEl.querySelector(".markdown-rendered"));
        const ex = String(node.text || "").match(EX_ID_RE);
        const exId = ex ? ex[0].slice(1) : "";
        const saved = (exId && this.settings && this.settings.excerptViews
          && this.settings.excerptViews[exId])
          || (this.settings && this.settings.nodeViews
            && this.settings.nodeViews[ctx.file.path + "::" + node.id]);
        if (host && saved) host.classList.toggle("lmb-view-img", saved === "image");
      } catch (_) {}

      const bar = this.lmbEnsureCanvasBarEl(wrapperEl);
      if (!bar) return;
      // _lmbHideBar() 会把复用浮栏设成 display:none；display:none 的元素宽高恒为 0。
      // 首次恢复时先进入“参与布局但不可见”的测量态，随后完成按钮筛选与定位，最后
      // 才 show。整个过程发生在同一帧，用户只会看到卡片外侧的最终位置。
      lmbSetToolbarVisibility(bar, "hideKeepSpace");

      // ① 按钮可用性（指纹变了 **或上下文丢了** 才重算）
      //    ⚠ 必须带 `|| !this._barCtx`：_lmbHideBar() 会清掉 _barCtx 但**不**重置 _barSig。
      //      若只看指纹，选中恢复后 sig 与上次完全相同 → 永远不再重建 _barCtx →
      //      浮层照样显示，但按钮点了没反应（正是「点过一次就失效」的根因）。
      //      触发路径：点击浮层按钮时 canvas 选中被瞬间清空 → tick 走 _lmbHideBar 清 ctx
      //      → 选中恢复 → sig 未变 → ctx 不再重建。
      let barData = null, edgeSig = "";
      try {
        barData = typeof canvas.getData === "function" ? canvas.getData() : null;
        edgeSig = ((barData && Array.isArray(barData.edges)) ? barData.edges : [])
          .filter((e) => e && (e.fromNode === node.id || e.toNode === node.id))
          .map((e) => e.id).sort().join(",");
      } catch (_) {}
      const sig = lmbBarSignature([node.id], { x: canvas.x, y: canvas.y, zoom: canvas.zoom })
        + "|edges:" + edgeSig + "|follow:" + !!(this.settings && this.settings.moveDescendantsWithParent);
      if (sig !== this._barSig || !this._barCtx) {
        this._barSig = sig;
        const acts = lmbPickBarActions(node.text);
        try {
          const sidecar = (this.autoEdges && this.autoEdges.get(ctx.file.path)) || new Set();
          acts.disconnect = lmbPlanDisconnect(node.id, barData && barData.edges, sidecar).kind !== "none";
        } catch (_) { acts.disconnect = false; }
        this._barCtx = { file: ctx.file, nodeId: node.id, node, acts, nodeEl };
        this._lmbApplyBarActions(bar, acts);
      }

      // ② 按钮显隐确定后，才读取浮栏的最终尺寸并定位。新建浮栏默认 visibility:hidden，
      //    所以用户只会看到已经放好的最终位置，不会看到“先在卡内、再跳到卡外”。
      const barRect = bar.getBoundingClientRect ? bar.getBoundingClientRect() : null;
      const barWidth = (barRect && barRect.width) || bar.offsetWidth;
      const barHeight = (barRect && barRect.height) || bar.offsetHeight;
      const p = lmbCalcBarPos(
        nodeEl.getBoundingClientRect(),
        wrapperEl.getBoundingClientRect(),
        { width: barWidth, height: barHeight },
        { mobile: !!this.isMobile }
      );
      bar.style.left = p.left + "px";
      bar.style.top = p.top + "px";
      if (bar.dataset) bar.dataset.lmbPlacement = p.placement;

      lmbSetToolbarVisibility(bar, "show");
    } catch (_) { /* noop：轮询回调绝不抛异常 */ }
  },

  /**
   * v0.13.1：注册浮层的「指针守卫」（全局一次，document 捕获阶段）。
   *
   * 为什么需要它：canvas 的选中逻辑多半监听 pointerdown / mousedown。浮层虽然是
   *   .canvas 的兄弟节点（事件不冒泡过去），但 canvas 常把监听挂在更外层，按下的
   *   一瞬间就会把选中清空 —— 于是 120ms 后轮询发现「没选中」→ 浮层消失、
   *   _barCtx 被清，表现为「点了一下按钮，之后就再也点不动」。
   *
   * 为什么放在 document 的**捕获**阶段：事件是先从 document 往下捕获、再冒泡回来的。
   *   挂在按钮自己的捕获监听上拦不住 —— document 的捕获比它更早执行。
   *
   * 为什么只拦 pointerdown / mousedown 而不拦 click：click 是独立事件对象，拦前面
   *   两个不影响按钮自己的 click 回调；反过来若把 click 也拦了，按钮就真点不动了。
   *   且这里只用 stopPropagation，不用 preventDefault —— 后者会连 hover / focus
   *   之类的原生反馈一起干掉。
   */
  _lmbInstallBarGuard() {
    try {
      if (this._barGuard) return;                 // 幂等
      const guard = (ev) => {
        try {
          const t = ev.target;
          if (!t || !t.closest) return;
          if (!t.closest(LMB_BAR_SEL)) return;    // 不是点在浮层上 → 一律不管
          ev.stopPropagation();
          ev.stopImmediatePropagation();
        } catch (_) { /* noop */ }
      };
      document.addEventListener("pointerdown", guard, true);
      document.addEventListener("mousedown", guard, true);
      this._barGuard = guard;
    } catch (_) { /* noop */ }
  },

  /** 拆除指针守卫（onunload 走；幂等） */
  _lmbUninstallBarGuard() {
    try {
      if (!this._barGuard) return;
      document.removeEventListener("pointerdown", this._barGuard, true);
      document.removeEventListener("mousedown", this._barGuard, true);
      this._barGuard = null;
    } catch (_) { this._barGuard = null; }
  },

  /**
   * 拖动 Canvas 卡片时隐藏侧栏。只有指针移动超过 4px 才进入拖动态，普通单击不会
   * 造成可见闪烁；松开后按卡片最终位置重新计算并显示。
   */
  _lmbInstallBarDragWatch() {
    try {
      if (this._barDragHandlers) return;
      const down = (ev) => {
        try {
          const target = ev.target;
          if (!target || !target.closest || target.closest(LMB_BAR_SEL)) return;
          if (!target.closest(".canvas-wrapper")) return;
          if (this.isMobile) {
            if (!this._barGesturePointers) this._barGesturePointers = new Set();
            this._barGesturePointers.add(ev.pointerId);
            this._barDragging = true;
            this._lmbHideBar();
          }
          this._barDragArm = {
            pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY,
            viewport: !target.closest(".canvas-node")
          };
          if (!this.isMobile) this._barDragging = false;
          // iPad 双指缩放/背景平移开始就隐藏工具栏，避免每次合成都带一个独立浮层。
          if (this._barDragArm.viewport && this.isMobile) {
            this._barDragging = true;
            this._lmbHideBar();
          }
        } catch (_) {}
      };
      const move = (ev) => {
        try {
          const arm = this._barDragArm;
          if (!arm || (arm.pointerId != null && ev.pointerId !== arm.pointerId)) return;
          if (!this._barDragging && Math.hypot(ev.clientX - arm.x, ev.clientY - arm.y) >= 4) {
            this._barDragging = true;
            this._lmbHideBar();
          }
        } catch (_) {}
      };
      const end = (ev) => {
        try {
          if (this.isMobile) {
            if (this._barGesturePointers) this._barGesturePointers.delete(ev.pointerId);
            if (this._barGesturePointers && this._barGesturePointers.size) return;
            this._barDragArm = null;
            this._barDragging = false;
            clearTimeout(this._barGestureEndTimer);
            this._barGestureEndTimer = setTimeout(() => {
              try { this.lmbCanvasBarTick(); } catch (_) {}
            }, 160);
            return;
          }
          const arm = this._barDragArm;
          if (!arm || (arm.pointerId != null && ev.pointerId !== arm.pointerId)) return;
          const wasDragging = this._barDragging;
          this._barDragArm = null;
          this._barDragging = false;
          if (wasDragging) setTimeout(() => { try { this.lmbCanvasBarTick(); } catch (_) {} }, 0);
        } catch (_) {
          this._barDragArm = null;
          this._barDragging = false;
        }
      };
      document.addEventListener("pointerdown", down, true);
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", end, true);
      document.addEventListener("pointercancel", end, true);
      this._barDragHandlers = { down, move, end };
    } catch (_) {}
  },

  _lmbUninstallBarDragWatch() {
    try {
      const h = this._barDragHandlers;
      if (h) {
        document.removeEventListener("pointerdown", h.down, true);
        document.removeEventListener("pointermove", h.move, true);
        document.removeEventListener("pointerup", h.end, true);
        document.removeEventListener("pointercancel", h.end, true);
      }
      this._barDragHandlers = null;
      this._barDragArm = null;
      this._barDragging = false;
      if (this._barGesturePointers) this._barGesturePointers.clear();
      this._barGesturePointers = null;
      clearTimeout(this._barGestureEndTimer);
      this._barGestureEndTimer = null;
    } catch (_) {}
  },

  /** 启动悬浮栏轮询（onLayoutReady 调用；幂等） */
  lmbStartCanvasBarWatch() {
    try {
      if (this._barTimer) return;             // 防重入：重复启动会叠加 interval
      this._lmbInstallBarGuard();             // v0.13.1：先装守卫，再开始轮询
      this._lmbInstallBarDragWatch();
      // v0.13.8：启动时先全局清掉所有**版本不匹配**的旧浮层。
      //   canvas leaf 的 DOM 不随插件重载而重建，旧浮层会一直挂在 DOM 里，
      //   光靠 lmbEnsureCanvasBarEl 只能修好「当前这个 wrapperEl」的那一颗，
      //   其他 canvas leaf 上残留的旧浮层（旧版回调）还得靠这里兜底。
      this._lmbPurgeStaleBars();
      // iPad 完全采用 pointerup / workspace 事件驱动。持续轮询会在双指缩放期间
      // 反复读取 Canvas 布局并扫描节点，直接参与每一轮合成，造成明显掉帧。
      this._barTimer = this.isMobile ? null : setInterval(() => this.lmbCanvasBarTick(), LMB_BAR_POLL_MS);
      this.lmbCanvasBarTick();                // 先跑一次，避免刚进 canvas 要等下一轮才出现
    } catch (_) { /* noop */ }
  },

  /**
   * v0.13.8：全局移除版本不匹配的旧悬浮栏。
   *   判定：`dataset.lmbBarVer !== LMB_BAR_VERSION`（旧版浮层压根没有这个字段）。
   */
  _lmbPurgeStaleBars() {
    try {
      document.querySelectorAll(LMB_BAR_SEL).forEach((b) => {
        if (!b.dataset || b.dataset.lmbBarVer !== LMB_BAR_VERSION) {
          if (b.parentNode) b.remove();
        }
      });
    } catch (_) { /* noop */ }
  },

  /** 停止轮询并移除浮层（onunload 调用；幂等） */
  lmbStopCanvasBarWatch() {
    try {
      this._lmbExitDisconnectMode(true);
      if (this._barTimer) { clearInterval(this._barTimer); this._barTimer = null; }
      this._lmbUninstallBarGuard();           // v0.13.1：守卫是 document 级的，不拆会一直拦事件
      this._lmbUninstallBarDragWatch();
      this._barSig = null;
      this._barCtx = null;
      // 这里必须 remove 而不是隐藏：插件都卸载了，不该在 DOM 里留残留节点
      document.querySelectorAll(LMB_BAR_SEL).forEach((b) => { if (b.parentNode) b.remove(); });
    } catch (_) { /* noop */ }
  },

});

/* 40-modals —— 评论/补充描述输入弹窗 + 卡片模糊选择器 */

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

/** v0.21：摘录卡追加笔记编辑器，输入与 Markdown 预览实时同步。 */
class LMBExcerptNoteModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts || {}; this.value = this.opts.value || ""; }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.addClass("lmb-note-editor");
    if (this.opts.compact) contentEl.addClass("lmb-note-editor-compact");
    contentEl.createEl("h3", { text: this.opts.title || "摘录笔记" });
    const grid = contentEl.createDiv({ cls: "lmb-note-editor-grid" });
    const ta = grid.createEl("textarea", { cls: "lmb-note-editor-input" });
    const preview = grid.createDiv({ cls: "lmb-note-editor-preview markdown-rendered" });
    ta.value = this.value; ta.placeholder = "写下理解、疑问、联想；支持 Markdown、公式和链接……";
    const fitInput = () => { if (this.opts.compact) { ta.style.height = "auto"; ta.style.height = Math.max(72, Math.min(180, ta.scrollHeight)) + "px"; } };
    const render = async () => {
      preview.empty();
      if (!ta.value.trim()) { preview.createEl("span", { text: "实时预览", cls: "lmb-note-preview-empty" }); return; }
      try { await MarkdownRenderer.render(this.app, ta.value, preview, this.opts.sourcePath || "", this); }
      catch (_) { preview.setText(ta.value); }
    };
    ta.addEventListener("input", () => { fitInput(); clearTimeout(this._renderTimer); this._renderTimer = setTimeout(render, 80); });
    ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.submit(); } });
    this.ta = ta; fitInput(); render();
    const bar = contentEl.createDiv({ cls: "lmb-note-editor-actions" });
    const remove = bar.createEl("button", { text: "删除笔记" });
    const cancel = bar.createEl("button", { text: "取消" });
    const save = bar.createEl("button", { text: "保存", cls: "mod-cta" });
    remove.onclick = () => { ta.value = ""; this.submit(); };
    cancel.onclick = () => this.close(); save.onclick = () => this.submit();
    setTimeout(() => ta.focus(), 30);
  }
  async submit() {
    if (this._submitting) return;
    this._submitting = true;
    try {
      const value = this.ta ? this.ta.value : "";
      if (this.opts.onSubmit) await this.opts.onSubmit(value);
      this.close();
    } catch (err) { new Notice("保存失败，编辑内容已保留：" + err.message); }
    finally { this._submitting = false; }
  }
  onClose() { clearTimeout(this._renderTimer); this.contentEl.empty(); }
}

/** A deliberate confirmation step for destructive sidebar actions. */
class LMBConfirmModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts || {}; }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl("h3", { text: this.opts.title || "确认操作" });
    contentEl.createEl("p", { text: this.opts.message || "此操作无法直接撤销。" });
    const bar = contentEl.createDiv({ cls: "lmb-note-editor-actions" });
    const cancel = bar.createEl("button", { text: "取消" });
    const confirm = bar.createEl("button", { text: this.opts.confirmText || "删除", cls: "mod-warning" });
    cancel.onclick = () => this.close();
    confirm.onclick = () => { this.close(); if (this.opts.onConfirm) this.opts.onConfirm(); };
    setTimeout(() => confirm.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* 41-settings-tab —— 设置页 */

/* ==================== 设置页 ==================== */

class LMBSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("当前运行版本")
      .setDesc((this.plugin.manifest && this.plugin.manifest.version || "0.37.0") + " · " + (this.plugin.isMobile ? "iPad / 移动端" : "桌面端"));
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

    containerEl.createEl("h2", { text: "PDF 手写批注" });
    new Setting(containerEl)
      .setName("书写输入")
      .setDesc("“触控笔和鼠标”适合桌面；“仅触控笔”可防止鼠标误画。手指始终交给 PDF 滚动和双指缩放。")
      .addDropdown((d) => d
        .addOption("pen-mouse", "触控笔和鼠标")
        .addOption("pen-only", "仅触控笔")
        .setValue(this.plugin.settings.inkInputMode === "pen-only" ? "pen-only" : "pen-mouse")
        .onChange(async (v) => { this.plugin.settings.inkInputMode = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("笔压效果")
      .setDesc("自然压感适合普通书写；钢笔效果的粗细变化较克制；固定宽度适合画图。")
      .addDropdown((d) => d
        .addOption("natural", "自然压感")
        .addOption("fountain", "钢笔效果")
        .addOption("fixed", "固定宽度")
        .setValue(this.plugin.settings.inkPressureMode || "natural")
        .onChange(async (v) => { this.plugin.settings.inkPressureMode = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("橡皮命中范围")
      .setDesc("局部／整笔橡皮的半径（屏幕像素）；可在手写工具栏的更多设置中切换模式。")
      .addSlider((s) => s.setLimits(8, 48, 2).setDynamicTooltip()
        .setValue(Number(this.plugin.settings.inkEraserSize) || 18)
        .onChange(async (v) => { this.plugin.settings.inkEraserSize = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("橡皮模式")
      .addDropdown(d => d.addOption("partial", "局部擦除").addOption("stroke", "整笔擦除")
        .setValue(this.plugin.settings.inkEraserMode || "partial")
        .onChange(async value => { this.plugin.settings.inkEraserMode = value; await this.plugin.saveSettings(); this.plugin.lmbRenderInkTools(); }));
    new Setting(containerEl)
      .setName("擦完自动回到画笔")
      .setDesc("一次擦除结束后回到之前的画笔；关闭后可以连续擦除。")
      .addToggle(t => t.setValue(this.plugin.settings.inkEraserAutoReturn !== false)
        .onChange(async value => { this.plugin.settings.inkEraserAutoReturn = value; await this.plugin.saveSettings(); this.plugin.lmbRenderInkTools(); }));

    /* ---- v0.14.8 / v0.15.0：摘录附件与删除清理 ---- */
    containerEl.createEl("h2", { text: "摘录卡片与附件" });

    new Setting(containerEl)
      .setName("Canvas 摘录卡统一宽度")
      .setDesc("新拖入 Canvas 的摘录卡统一使用该宽度；之后手动调整的宽度会被保留。")
      .addSlider((s) => s
        .setLimits(320, 800, 20)
        .setDynamicTooltip()
        .setValue(Math.max(320, Math.min(800, Number(this.plugin.settings.excerptCardWidth) || 560)))
        .onChange(async (v) => { this.plugin.settings.excerptCardWidth = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("新摘录自动附截图")
      .setDesc("拖出摘录时一并截取选中区域存成 webp 附件（卡片可在「文字 / 图片」视图间切换）。"
        + "关闭后新摘录只有文字，卡片更紧凑、也不占 vault 空间。"
        + "注意：关闭不影响已有的双重摘录卡。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.autoAttachScreenshot !== false)
        .onChange(async (v) => { this.plugin.settings.autoAttachScreenshot = v; await this.plugin.saveSettings(); }));

    if (this.plugin.settings.storageLayout === "central") {
      new Setting(containerEl).setName("MarginBook 工作区")
        .setDesc(`摘录、Canvas 与附件统一保存至 ${this.plugin.settings.storageRoot || "Lucia's Marginbook"}/课程路径/PDF名称/；PDF 原文保持原位。现有历史摘录保留独立关联，不自动合并。`);
    }

    if (this.plugin.settings.storageLayout !== "central") new Setting(containerEl)
      .setName("摘录截图保存目录")
      .setDesc("相对于 Vault 根目录；{pdf} 会替换为 PDF 文件名。默认：附件/{pdf}")
      .addText((t) => t
        .setPlaceholder("附件/{pdf}")
        .setValue(this.plugin.settings.excerptImageFolder || "附件/{pdf}")
        .onChange(async (v) => {
          this.plugin.settings.excerptImageFolder = String(v || "").trim().replace(/^\/+|\/+$/g, "") || "附件/{pdf}";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("图片摘录的 PDF 标记")
      .setDesc("仅控制纯图片摘录在原 PDF 上的定位方式；带自动附图的文字摘录始终使用荧光笔底色。")
      .addDropdown((d) => d
        .addOption("dashed", "虚线边框（默认）")
        .addOption("highlight", "半透明高亮")
        .setValue(this.plugin.settings.imageExcerptMarkStyle === "highlight" ? "highlight" : "dashed")
        .onChange(async (v) => {
          this.plugin.settings.imageExcerptMarkStyle = v === "highlight" ? "highlight" : "dashed";
          await this.plugin.saveSettings();
          this.plugin.lmbRefreshAllMarks();
        }));

    const cleanIntro = containerEl.createEl("p", {
      text: "删除画布上的摘录卡时，一并清理它留下的残留（截图附件 + md 摘录文档里的对应条目）。"
        + "⚠ 这是数据级操作，默认关闭 —— 请确认理解风险后再开启。"
    });
    cleanIntro.style.cssText = "font-size:12px;color:var(--text-muted);line-height:1.6;margin:0 0 4px;";

    new Setting(containerEl)
      .setName("删除卡片时级联清理")
      .setDesc("开启后：删除画布摘录卡 → 自动把截图附件移入回收目录 + 从 md 摘录文档移除该条目。"
        + "安全策略：① 只删插件自己命名的附件（xxx-P<页>-<戳>.webp），你的图片不碰；"
        + "② 全 vault 扫描，其他笔记还在引用就不删（避免 broken image）；"
        + "③ Markdown 原块与截图会先移入 .lmb-trash，可真正恢复；"
        + "④ 引用检查只要有一个文件读取失败，就保留截图；"
        + "⑤ 底部弹提示告知清理了几项。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.autoCleanOnDelete === true)
        .onChange(async (v) => {
          this.plugin.settings.autoCleanOnDelete = v;
          await this.plugin.saveSettings();
        }));

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
      .setDesc("关闭（v0.12.0 起默认）：新拖出的摘录卡不再自动带空描述框（v0.12.0 卡片精简迁移）。"
        + "开启：新拖出的摘录卡下方自动带一个空的补充描述框，点开即可写。"
        + "插件首次扫描某画布时会给已有摘录卡也补上（不覆盖已写过的内容）。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.noteAutoBoxOnNew !== false)
        .onChange(async (v) => { this.plugin.settings.noteAutoBoxOnNew = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("新摘录卡自动挂评论栏")
      .setDesc("关闭（v0.16.0 起默认）：新拖出的摘录卡**不再**自动带「💬 添加评论」底栏，卡里只留摘录内容。"
        + "评论功能照常可用 —— 入口是选中卡片后左侧悬浮栏的「评论」按钮、命令面板"
        + "（给卡片添加/编辑评论）、以及侧边栏 ribbon。"
        + "开启：恢复旧行为，新卡底部自动带评论栏，点它直接弹编辑框（仿 PDF Flow 批注样式）。"
        + "存量卡与已写过的评论不受此开关影响。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.commentAutoBoxOnNew === true)
        .onChange(async (v) => { this.plugin.settings.commentAutoBoxOnNew = v; await this.plugin.saveSettings(); }));
  }
}

module.exports = LuciasMarginBookPlugin;
module.exports.__test = {
  lmbShouldReshowSelection, lmbMeasureRenderedContent, lmbMeasureNaturalCard,
  lmbVerticalOverflow, lmbHeightAfterOverflow, lmbFinalizeCardHeight, EX_ID_RE,
  lmbRectsOverlapRatio, lmbPickDropParent, lmbBuildSpatialIndex, lmbSnapChildPosition, lmbBuildTree,
  lmbDiffCanvasNodes, lmbSideOf, lmbSideEnds, lmbLayoutGroup, lmbGroupBySide,
  lmbAutoEdgeAlive, lmbAutoParentEdgeOf,
  lmbMoveDescendants,
  lmbLayoutTree,
  // PDF 手写：采样、命中、套索与版本化存储文件名
  LMB_INK_SCHEMA_VERSION, LMB_INK_HISTORY_LIMIT,
  lmbInkBounds, lmbInkObjectHit, lmbInkObjectsInLasso, lmbInkIsStylusInput, lmbInkTouchPointEvent,
  lmbInkAppendSamples, lmbInkSimplifyPoints, lmbInkSegmentWidth, lmbInkFileKey,
  lmbInkBuildPatch, lmbInkApplyPatch, lmbInkMergePages,
  lmbInkEraseFragments, lmbInkIsTextInput,
  lmbInkGroupObjects, lmbInkGroupBounds, lmbInkCanvasReference,
  // v0.8.0：卡片补充描述
  lmbSplitNote, lmbJoinNote, lmbStripNote, lmbRenderedText,
  LMB_NOTE_START, LMB_NOTE_END,
  // P1：摘录索引层
  lmbParseExcerptDoc, LMB_LINK_RE, LMB_SEL_RE,
  lmbUnwrapExcerptCard,
  // v0.12.0：引用行 📖 化
  lmbBookLink, lmbRestoreRefDisplayName,
  // v0.11.0：首连锁定 / 改挂侧 / 尺寸重居中 + 独立评论
  lmbPlanAutoLink, lmbApplyReside, lmbRecenterNode,
  lmbSplitComment, lmbJoinComment, LMB_COMMENT_TYPE, LMB_COMMENT_CALLOUT_RE,
  // v0.12.1：工具栏宿主解析层（借鉴 editing-toolbar v4.1.1：规格表同源 + 兜底 + 缓存 + 显隐分级）
  LMB_VIEW_SPECS, lmbResolveToolbarAnchor, LmbDomCache, lmbSetToolbarVisibility,
  // v0.12.1：样式表（从 injectStyles 抽出，per-view-type 适配集中在 CSS 侧）
  LMB_STYLES,
  // v0.13.0：canvas 卡片悬浮操作栏（坐标换算 + 按钮可用性判定 + 轮询指纹）
  LMB_BAR_POLL_MS, LMB_BAR_GAP, LMB_BAR_MARGIN, LMB_BAR_SEL,
  lmbCalcBarPos, lmbPickBarActions, lmbBarSignature,
  lmbPlanDisconnect,
  // v0.13.8：悬浮栏结构版本（改按钮组成 / 事件绑定方式时必须 +1，触发旧浮层重建）
  LMB_BAR_VERSION
}; // 测试钩子（node 冒烟脚本用）
// 注：lmbParsePdfLink 是类方法（不依赖 this），测试走 PluginClass.prototype.lmbParsePdfLink

// v0.12.1：11-styles.js / 25-pure-toolbar.js 在拼接顺序上早于本文件，它们挂在
//   module.exports 上的 __lmbStyles / __lmbToolbar 会被第一行的
//   `module.exports = LuciasMarginBookPlugin` 覆盖掉，这里重新挂回去（供外部单测直取）。
if (typeof module !== "undefined" && module.exports) {
  module.exports.__lmbStyles = { LMB_STYLES };
  module.exports.__lmbToolbar = {
    LMB_VIEW_SPECS, lmbResolveToolbarAnchor, LmbDomCache, lmbSetToolbarVisibility,
  };
  module.exports.__lmbCanvasBar = {
    LMB_BAR_POLL_MS, LMB_BAR_GAP, LMB_BAR_MARGIN, LMB_BAR_SEL, LMB_BAR_VERSION,
    lmbCalcBarPos, lmbPickBarActions, lmbBarSignature,
  };
}
