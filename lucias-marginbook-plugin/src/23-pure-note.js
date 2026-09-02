/* 23-pure-note —— 补充描述(ppd-note) + 独立评论(lmb-comment) 解析/合并（纯函数，可单测） */

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
