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
  '@media(any-pointer:coarse){.lmb-pdf-text-tools button,.lmb-pdf-text-tools input{height:40px!important;min-height:40px!important;font-size:13px;}.lmb-pdf-text-tools button:first-child,.lmb-pdf-text-tools .lmb-text-size-step{min-width:36px;}.lmb-pdf-text-tools input{width:44px!important;min-width:44px;max-width:44px;}}',
  '.lmb-ink-tools-content>.lmb-ink-width-control{flex:0 0 105px;min-width:105px;}.lmb-ink-link-drag{touch-action:none;user-select:none;cursor:grab!important;}.lmb-ink-link-drag:active{cursor:grabbing!important;}.lmb-ink-link-ghost{position:fixed;z-index:100000;pointer-events:none;background:var(--interactive-accent);color:var(--text-on-accent);padding:7px 11px;border-radius:8px;box-shadow:0 3px 12px #0005;font-size:13px;}',
  '.lmb-ink-association-hint{display:flex;align-items:center;gap:8px;padding:8px;margin-top:6px;border:1px solid var(--interactive-accent);border-radius:7px;font-size:12px;line-height:1.5;color:var(--text-normal);}.lmb-ink-association-hint>span{flex:1;}.lmb-ink-association-hint button{min-height:32px;}.lmb-pdf-sidebar-item.is-ink-link-target{outline:1px dashed var(--interactive-accent);outline-offset:-3px;cursor:copy;}.lmb-pdf-sidebar-item.is-ink-drop-target{outline:3px solid var(--interactive-accent);background:color-mix(in srgb,var(--interactive-accent) 25%,var(--background-primary));}.lmb-ink-ref-actions{display:flex;flex-wrap:wrap;gap:6px;}',
  '.lmb-sidebar-side-toggle{margin-left:auto;white-space:nowrap;min-height:28px;padding:2px 6px;font-size:11px;border:1px solid var(--background-modifier-border);border-radius:6px;background:var(--background-secondary);color:var(--text-muted);}.lmb-sidebar-side-toggle:hover{background:var(--background-modifier-hover);}.lmb-pdf-sidebar-host.lmb-sidebar-left{padding-right:0!important;padding-left:var(--lmb-pdf-sidebar-width,340px)!important;}.lmb-pdf-sidebar-host.lmb-sidebar-left.lmb-pdf-sidebar-closed{padding-left:0!important;}.lmb-sidebar-left>.lmb-pdf-excerpt-sidebar{left:0;right:auto;border-left:0;border-right:1px solid var(--background-modifier-border);padding:0 13px 28px 10px;}.lmb-sidebar-left .lmb-pdf-sidebar-resizer{left:auto;right:-3px;}.lmb-sidebar-left>.lmb-sidebar-state-toggle{left:calc(var(--lmb-pdf-sidebar-width,340px) - 42px);right:auto;}.lmb-sidebar-left.lmb-pdf-sidebar-closed>.lmb-sidebar-state-toggle{left:12px;}.lmb-sidebar-left:not(.lmb-pdf-sidebar-closed)>.lmb-ink-tools{left:calc(var(--lmb-pdf-sidebar-width,340px) + 12px);right:12px;}.lmb-sidebar-left>.lmb-ink-tools.is-collapsed{left:auto;right:12px;}',
  '@media(any-pointer:coarse){.lmb-sidebar-side-toggle{min-height:40px;}.lmb-sidebar-left>.lmb-sidebar-state-toggle{left:calc(var(--lmb-pdf-sidebar-width,340px) - 52px);}.lmb-sidebar-left.lmb-pdf-sidebar-closed>.lmb-sidebar-state-toggle{left:6px;}}@media(max-width:700px){body.lmb-mobile .lmb-sidebar-left:not(.lmb-pdf-sidebar-closed){padding-left:min(46vw,320px)!important;}body.lmb-mobile .lmb-sidebar-left:not(.lmb-pdf-sidebar-closed)>.lmb-ink-tools{left:calc(min(46vw,320px) + 6px);right:6px;}body.lmb-mobile .lmb-sidebar-left:not(.lmb-pdf-sidebar-closed)>.lmb-sidebar-state-toggle{left:calc(min(46vw,320px) - 52px);}}',
];

if (typeof module !== "undefined" && module.exports) {
  module.exports.__lmbStyles = { LMB_STYLES };
}
