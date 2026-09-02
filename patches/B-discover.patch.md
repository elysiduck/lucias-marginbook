# B-discover.patch — 旧知识自动浮现（P1-4 相关笔记检索 + P1-5 颜色语义）

> 目标文件：`pdf-plus-drag-plugin/main.js`（v0.2.4）
> 原则：只打补丁，不改 main.js 本体流程；全部 try/catch 优雅降级；零外部依赖；
> 检索只查 metadataCache 元数据，**禁止 vault.cachedRead / vault.read 文件正文**。
> 合并注意：本补丁与 A-core-sync.patch.md（## P.N 分页标题）都改 writeExcerptMd，
> 合并策略见 Edit 4。

---

## Edit 1: onload 增量 —— relatedCache 初始化 + colorMap 默认值

**锚点**（onload 内，唯一出现）：

```js
    this.settings = Object.assign({ debug: true }, await this.loadData());
```

**替换为**：

```js
    this.relatedCache = new Map();   // 摘录 id -> 相关笔记 wikilink 数组（每 id 只检索一次）
    this._colorCtx = null;           // 颜色归一化用的离屏 canvas 2d context（惰性创建）
    this.settings = Object.assign({ debug: true, colorMap: "" }, await this.loadData());
```

> 插入位置说明：必须在 settings 赋值**之前**建 relatedCache，且在任何 canvas
> modify 事件可能触发的 processCanvas → writeExcerptMd 之前完成（onload 同步
> 前段即满足）。`_colorCtx` 供 normalizeColor 复用，onunload 无需清理（GC 回收）。

---

## Edit 2: extractSelection —— 保持 selectionParams 链路不变，仅追加颜色探测

**锚点**（被替换的完整原方法，精确复制）：

```js
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

      let link;
      try {
        const params = this.buildSelectionParams(sel, pageEl);
        if (!params) throw new Error("no selection params");
        link = "[[" + file.path + "#page=" + pageNum + "&selection=" + params + "|" + display + "]]";
      } catch (_) {
        link = "[[" + file.path + "#page=" + pageNum + "|" + display + "]]";
      }
      return { file, pageNum, text, link, display, isImage: false };
    } catch (err) {
      console.warn("[pdf-plus-drag] extractSelection error:", err);
      return null;
    }
  }
```

**替换为**：

```js
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

      // P1-5 颜色语义：best-effort 探测选区命中的高亮注释背景色 → 映射标签名。
      // 探测不到 / 未命中映射 / 未配置 colorMap 时恒为 null，行为与现状一致。
      let colorTag = null;
      try { colorTag = this.detectColorTag(el, pageEl); }
      catch (err) { console.warn("[pdf-plus-drag] detectColorTag error:", err); }

      let link;
      try {
        const params = this.buildSelectionParams(sel, pageEl);
        if (!params) throw new Error("no selection params");
        link = "[[" + file.path + "#page=" + pageNum + "&selection=" + params + "|" + display + "]]";
      } catch (_) {
        link = "[[" + file.path + "#page=" + pageNum + "|" + display + "]]";
      }
      return { file, pageNum, text, link, display, isImage: false, colorTag };
    } catch (err) {
      console.warn("[pdf-plus-drag] extractSelection error:", err);
      return null;
    }
  }
```

> 说明：`buildSelectionParams` 调用链路一字未动；颜色探测放在 link 计算**之前**
> 且自带 try/catch，即使探测抛错也不影响 link 兜底逻辑。图片路径（captureRectImage
> 返回对象）不含 colorTag 字段，消费方须以 `info.isImage || !info.colorTag` 判断。

---

## Edit 3: 新增方法块 —— findRelatedNotes / tokenizeForSearch / detectColorTag / parseColorMap / collectHighlightColors / normalizeColor

**建议插入位置**：`writeExcerptMd` 方法之后、`/* ==================== 样式 ==================== */` 注释行之前（与 Edit 4 无锚点冲突）。

**插入内容**（整块新增）：

```js
  /* ==================== 旧知识自动浮现（P1-4 相关笔记 + P1-5 颜色语义） ==================== */

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
      if (result.length) console.log("[pdf-plus-drag] related for", entryId + ":", result.length);
      return result;
    } catch (err) {
      console.warn("[pdf-plus-drag] findRelatedNotes error:", err);
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
      console.warn("[pdf-plus-drag] tokenizeForSearch error:", err);
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
          console.log("[pdf-plus-drag] colorTag hit:", hex, "->", tag);
          return tag;
        }
      }
      return null;
    } catch (err) {
      console.warn("[pdf-plus-drag] detectColorTag error:", err);
      return null;
    }
  }

  /** 解析「颜色语义映射」textarea：每行 rrgggbb=标签名，忽略空行/错行/#前缀/大小写 */
  parseColorMap(raw) {
    const map = new Map();
    try {
      for (const lineRaw of String(raw || "").split("\n")) {
        const line = lineRaw.trim();
        if (!line || line.startsWith("#")) continue;
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
   * ② PDF++ 真实路径：同页 .annotationLayer 里与选区矩形相交的注释 section
   *    （及其内部 quad div），pdf.js 用内联 background-color 渲染高亮注释。
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
```

---

## Edit 4: writeExcerptMd —— 追加「> 相关：」行（含与 A 补丁的合并指引）

**⚠ 合并说明（先读这段）**：截至本文撰写，`patches/A-core-sync.patch.md` **尚不存在**。
下面给出两个东西：

- **4a. 基于「当前原版」的完整替换版本** —— 若合并时 A 补丁仍未落地，直接用 4a 整方法替换；
- **4b. 与 A 补丁（## P.N 分页标题 / 页分组）的合并 diff 点** —— 若 A 已落地，
  以 A 的版本为基底做两处追加（见 4b），**不要**用 4a 覆盖。

### 4a. 完整替换版本（仅当 A 补丁不存在时使用）

**锚点**（被替换的完整原方法，精确复制）：

```js
  async writeExcerptMd(cf, pdfPath, entries) {
    const pdfBase = pdfPath.split("/").pop().replace(/\.pdf$/i, "");
    const folder = cf.parent && cf.parent.path ? cf.parent.path : "/";
    const mdPath = normalizePath(folder === "/" ? pdfBase + "-摘录.md" : folder + "/" + pdfBase + "-摘录.md");

    let content = "---\nPDF: \"[[" + pdfPath + "]]\"\ncanvas: \"[[" + cf.basename + "]]\"\n---\n\n";
    for (const en of entries) {
      content += en.body + "\n^" + en.id + "\n\n";
    }

    const existing = this.app.vault.getAbstractFileByPath(mdPath);
    if (existing instanceof TFile) {
      const cur = await this.app.vault.read(existing);
      if (cur !== content) {
        await this.app.vault.process(existing, () => content);
        console.log("[pdf-plus-drag] excerpt doc updated:", mdPath);
      }
    } else {
      await this.app.vault.create(mdPath, content);
      new Notice("PDF++ Drag: 已创建摘录文档 " + mdPath);
      console.log("[pdf-plus-drag] excerpt doc created:", mdPath);
    }
  }
```

**替换为**：

```js
  async writeExcerptMd(cf, pdfPath, entries) {
    const pdfBase = pdfPath.split("/").pop().replace(/\.pdf$/i, "");
    const folder = cf.parent && cf.parent.path ? cf.parent.path : "/";
    const mdPath = normalizePath(folder === "/" ? pdfBase + "-摘录.md" : folder + "/" + pdfBase + "-摘录.md");

    // P1-4 相关笔记预取：只为缓存中没有的 id 检索（新条目最多几个，可接受）；
    // 有缓存的 id 不重复计算。单个失败不阻断写入。
    for (const en of entries) {
      if (this.relatedCache && this.relatedCache.has(en.id)) continue;
      try {
        await this.findRelatedNotes(en.id, en.body);
      } catch (err) {
        console.warn("[pdf-plus-drag] related prefetch failed:", en.id, err);
        if (!this.relatedCache.has(en.id)) this.relatedCache.set(en.id, []);
      }
    }

    let content = "---\nPDF: \"[[" + pdfPath + "]]\"\ncanvas: \"[[" + cf.basename + "]]\"\n---\n\n";
    for (const en of entries) {
      content += en.body + "\n^" + en.id + "\n";
      const rel = this.relatedCache.get(en.id);
      if (rel && rel.length) content += "> 相关：" + rel.join(" · ") + "\n";
      content += "\n";
    }

    const existing = this.app.vault.getAbstractFileByPath(mdPath);
    if (existing instanceof TFile) {
      const cur = await this.app.vault.read(existing);
      if (cur !== content) {
        await this.app.vault.process(existing, () => content);
        console.log("[pdf-plus-drag] excerpt doc updated:", mdPath);
      }
    } else {
      await this.app.vault.create(mdPath, content);
      new Notice("PDF++ Drag: 已创建摘录文档 " + mdPath);
      console.log("[pdf-plus-drag] excerpt doc created:", mdPath);
    }
  }
```

### 4b. 与 A-core-sync（## P.N 分页标题）的合并 diff 点（A 存在时以此为准）

以 **A 补丁版本的 writeExcerptMd** 为基底，只做两处追加（其余一律不动）：

1. **预取循环**：在 A 版本开始拼 `content` 字符串**之前**（即所有页分组循环之外、
   对「全量 entries 扁平列表」执行）。若 A 版本已把 entries 重组成按页分组结构
   （如 `Map<pageNo, entries[]>`），需先取扁平列表：

```js
  // —— B 补丁：P1-4 相关笔记预取（只算缓存中没有的 id）——
  const flatEntries = /* A 版本若已有扁平 entries 列表则直接用它；否则从分组结构取值展开 */;
  for (const en of flatEntries) {
    if (this.relatedCache && this.relatedCache.has(en.id)) continue;
    try {
      await this.findRelatedNotes(en.id, en.body);
    } catch (err) {
      console.warn("[pdf-plus-drag] related prefetch failed:", en.id, err);
      if (!this.relatedCache.has(en.id)) this.relatedCache.set(en.id, []);
    }
  }
```

2. **相关行**：在 A 版本写出每个条目的 `^ex-id` 行**之后**、条目之间的空行之前追加：

```js
      // A 版本原句（示意）：content += en.body + "\n^" + en.id + "\n\n";
      // 改为（在 ^ex-id 行后插入一行，再补条目间空行）：
      content += en.body + "\n^" + en.id + "\n";
      const rel = this.relatedCache.get(en.id);
      if (rel && rel.length) content += "> 相关：" + rel.join(" · ") + "\n";
      content += "\n";
```

> 输出形态示例（本补丁视角，A 的 `## P.N` 标题行落在条目组之前，互不干扰）：
>
> ```markdown
> > ([[file.pdf#page=12&selection=…|【file-P.12】]])
> > 选中文本
> ^ex-ab12
> > 相关：[[注意力相关笔记]] · [[Transformer 综述]]
> ```

---

## Edit 5: saveSettings 增量

**锚点**（saveSettings 内，唯一出现）：

```js
    if (this.imgDims.size) obj.imgDims = Object.fromEntries(this.imgDims);
```

**替换为**：

```js
    if (this.imgDims.size) obj.imgDims = Object.fromEntries(this.imgDims);
    obj.colorMap = this.settings.colorMap;
```

---

## Edit 6: PPDSettingTab.display() 增量块（不整体替换 display，插入到现有 debug 开关之后）

**锚点**（display() 内 debug 开关的结尾，唯一出现）：

```js
      .addToggle((t) => t
        .setValue(this.plugin.settings.debug)
        .onChange(async (v) => { this.plugin.settings.debug = v; await this.plugin.saveSettings(); }));
```

**在其后追加**（新增的 Setting 代码块）：

```js
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
```

> 注意：样式用内联属性写在 inputEl 上，**不改 injectStyles**（边界约束）。
> saveSettings 的 colorMap 增量见 Edit 5（先应用 Edit 5 再测设置页）。

---

## 附录：PDF++ 本体高亮 DOM 证据（Grep 结论）

> 取证对象：`D:\下载\文档\Obsidian\往昔的涟漪\.obsidian\plugins\pdf-plus\main.js`（minified 单长行，以下行号为文件行号）

1. **彩色高亮 = 真实 PDF 注释，不是 textLayer DOM**（第 80 行附近）：
   ```
   ...{r:l,g:d,b:h}=this.plugin.domManager.getRgb(o),u=tg(),p=this.lib.highlight.geometry,
   f=this.addAnnotation(c,{Subtype:r,Rect:p.mergeRectangles(...i),
   QuadPoints:p.rectsToQuadPoints(i),Contents:K.fromText(...),M:J.fromDate(new Date(...
   ```
   PDF++ 用 `addAnnotation({Subtype: "Highlight", ...})` 把带颜色的 `Rect/QuadPoints`
   注释写进 PDF 页对象后重渲染，颜色来源是 CSS 变量 `--pdf-plus-<颜色名>-rgb`
   （`getRgb`：`"--pdf-plus-default-color-rgb" → getComputedStyle(document.body).getPropertyValue(t)`）。

2. **页面上高亮的 DOM 载体是 `.annotationLayer > section[data-annotation-id]`**
   （第 65 行，选择器常量表 `Ku`）：
   ```
   var Ku={0:".annotationLayer > section.linkAnnotation:has(> a)",
           1:".annotationLayer > section:not(.linkAnnotation)",
           2:".pdf-plus-backlink-highlight-layer > .pdf-plus-backlink"}
   ```
   即：链接注释走 0 号选择器，**其余注释（含 Highlight 高亮）走 1 号
   `.annotationLayer > section:not(.linkAnnotation)`**；2 号是「回跳时的高亮层」，
   不是颜色语义。pdf.js 渲染 Highlight 注释时在 section（及其 QuadPoints 拆出的
   内部 div）上写**内联 `background-color: rgba(R,G,B,α)`** —— 这就是本补丁
   `collectHighlightColors` ② 路径采集的对象。

3. **注释数据自带 `.color` RGB 数组**（第 80 行，复制注释文本时的取色）：
   ```
   p=u!=null&&u.color?`${u.color[0]}, ${u.color[1]}, ${u.color[2]}`:""
   ```
   印证注释颜色以 RGB 三元组存储、经 pdf.js 落到 annotationLayer 内联样式。

4. **textLayer 内不存在高亮颜色标记**：`grep textLayer` 全部命中均为文本层
   定位/选区矩形计算（`computeMergedHighlightRects`、`textDivs` 等），无任何
   着色逻辑；`grep highlight` 命中的着色规则均为：调色板 UI
   （`.pdf-plus-color-palette-item[data-highlight-color=...]`，第 119/121 行）、
   md 侧 callout（第 125/127 行）、backlink 临时高亮层 —— 都不在 textLayer。

**结论**：原任务设想的「从选区节点在 textLayer 内向上找高亮标记」路径在 PDF++
当前版本**探不到东西**（高亮不在 textLayer）。因此本补丁的探测为双路径：
① 祖先链探测保留（兜底未来版本/其它渲染方式）；② 新增 annotationLayer
section 矩形相交探测（真实路径，取内联 backgroundColor 归一化为 `#rrggbb`
后查 colorMap）。若②也探不到（如注释未渲染、canvas 全屏遮盖等），一律
静默返回 null，与现状行为一致 —— 符合「探测不到 → 静默跳过」设计。

---

## 风险与边界自查

- 未触碰 `buildDropText` / `processCanvas` 分组逻辑 / `injectStyles` / 样式。
- 检索零 `cachedRead`/`vault.read`，全走 `metadataCache.getFileCache`（纯内存）。
- findRelatedNotes 失败时以 `[]` 占位写入缓存，保证不反复重试拖慢 writeExcerptMd。
- 颜色探测在 mouseup 同步路径上，最重开销是同页 annotationLayer 的
  getBoundingClientRect 循环（每页 section 数量通常 < 100），可接受；
  全程 try/catch，失败静默。
- relatedCache 仅内存缓存，重启后首个同步会重算（新条目量级，可接受）。
