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
 * ^ex- 是块尾锚点。没有 ID 的旧摘录仍按选区、受控区域或摘录包装保留；
 * 普通 PDF 页码链接只负责导航，不再自动产生摘录。
 */
function lmbUnwrapExcerptCard(content) {
  return lmbExcerptCardSourceLines(content).map((line) => line.text).join("\n");
}

// Preserve per-line card provenance while removing the visual wrapper. A card
// elsewhere in a mixed document must not make its ordinary links into excerpts.
function lmbExcerptCardSourceLines(content) {
  const wrapped = /\[!lmb-excerpt\]/i.test(content || "");
  let cardDepth = 0;
  return String(content || "").split(/\r?\n/).flatMap((raw) => {
    const depth = ((raw.match(/^\s*((?:>\s*)*)/) || ["", ""])[1].match(/>/g) || []).length;
    if (wrapped && /\[!lmb-excerpt\]/i.test(raw)) { cardDepth = depth; return []; }
    if (wrapped && /class=["']lmb-excerpt-id["']/i.test(raw)) return [];
    if (cardDepth && depth <= cardDepth && raw.trim()) cardDepth = 0;
    return [{ text: wrapped ? raw.replace(/^(\s*)>\s?/, "$1") : raw, card: cardDepth > 0 && depth > cardDepth }];
  });
}

function lmbExcerptDocumentRole(content) {
  // Only a real top-level frontmatter scalar controls indexing. Mentions inside
  // prose, code examples, and other properties must have no effect.
  const frontmatter = String(content || "").match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!frontmatter) return "";
  const role = frontmatter[1].match(/^marginbook-role:[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*?))[ \t]*(?:#.*)?$/m);
  return role ? String(role[1] || role[2] || role[3] || "").trim().toLowerCase() : "";
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
  const role = lmbExcerptDocumentRole(content);
  if (role === "reading-guide") return entries;
  // v0.18：只把插件受控生成区编入索引，用户补充区里的 PDF 链接不会制造幽灵摘录。
  const generated = content.match(/<!--\s*LMB:BEGIN\s*-->([\s\S]*?)<!--\s*LMB:END\s*-->/i);
  // 词语备注是用户主动建立的独立条目，不能随 Canvas 同步重写的受控区一起被覆盖。
  // 因此它单独保存在文档尾部；索引时把两个区域合并读取。
  const wordNotes = content.match(/<!--\s*LMB:WORD-NOTES:BEGIN\s*-->([\s\S]*?)<!--\s*LMB:WORD-NOTES:END\s*-->/i);
  const manual = content.match(/<!--\s*LMB:MANUAL-EXCERPTS:BEGIN\s*-->([\s\S]*?)<!--\s*LMB:MANUAL-EXCERPTS:END\s*-->/i);
  if (generated) content = generated[1] + (manual ? "\n" + manual[1] : "") + (wordNotes ? "\n" + wordNotes[1] : "");
  // v0.20：摘录卡使用外层 lmb-excerpt callout。解析前只剥掉这一层视觉包装，
  // 内部原文、图片、评论和 ^ex 锚点仍按旧格式解析，存量文档完全兼容。
  const sourceLines = lmbExcerptCardSourceLines(content);
  const lines = sourceLines.map((line) => line.text);
  let pending = null;
  let pendingEvidence = false;
  let managed = !!generated;
  const flush = () => {
    if (pending && (pendingEvidence || pending.exId)) entries.push(pending);
    pending = null;
    pendingEvidence = false;
  };
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
    if (/<!--\s*LMB:(?:MANUAL-EXCERPTS|WORD-NOTES):BEGIN\s*-->/i.test(raw)) { flush(); managed = true; continue; }
    if (/<!--\s*LMB:(?:MANUAL-EXCERPTS|WORD-NOTES):END\s*-->/i.test(raw)) { flush(); managed = !!generated; continue; }
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
      // PDF Flow used select=/square= before the selection=/rect= convention.
      // Retain those records without reinterpreting their coordinate systems.
      const legacyGeometry = /&(?:select|square)=(?:\d+(?:\.\d+)?,){3}\d+(?:\.\d+)?(?=[&|\]])/i.test(lm[0]);
      const legacyQuote = /^\s*(?:>\s*)+\(\s*\[\[[\s\S]+\]\]\s*\)\s*$/.test(raw);
      pendingEvidence = !!(sm || rm || legacyGeometry || legacyQuote || managed || sourceLines[i].card || role === "excerpts");
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
      flush();
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
