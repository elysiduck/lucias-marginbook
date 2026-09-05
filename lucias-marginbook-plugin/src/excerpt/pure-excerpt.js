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
function lmbParseExcerptDoc(content, sourcePath) {
  const entries = [];
  if (!content || typeof content !== "string") return entries;
  const lines = content.split(/\r?\n/);
  let pending = null;
  const flush = () => { if (pending) { entries.push(pending); pending = null; } };
  /* v0.16.6 P1-8：callout 区块内**整段**跳过，不只是首行。
   *   旧版只有 `if (/^\s*(?:>\s*)+\[!/.test(raw)) continue;` —— 只挡 `> [!xxx]` 标题行，
   *   于是「> 我的批注」这类 note 正文行会落进 5) 被收成摘录正文（索引里变成
   *   「原文 我的批注」），「> #误当标签」被收成假标签，note 里若含 [[y.pdf#page=3]]
   *   还会凭空开出一条幽灵摘录。
   *   状态位：遇 `[!` 首行置 true，遇非 `>` 行（空行 / 新块）复位。 */
  let inCallout = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] || "";
    if (!/^\s*>/.test(raw)) inCallout = false;   // 块结束（空行/新块）→ 复位

    // Callout 必须先于链接解析处理，否则其正文中的 PDF 链接会生成幽灵摘录。
    if (/^\s*(?:>\s*)+\[!/.test(raw)) { inCallout = true; continue; }
    if (inCallout) continue;

    // 1) 回跳链接行 → 开新条目
    LMB_LINK_RE.lastIndex = 0;
    const lm = LMB_LINK_RE.exec(raw);
    if (lm) {
      flush();
      inCallout = false;
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
