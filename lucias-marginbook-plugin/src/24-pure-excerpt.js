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
