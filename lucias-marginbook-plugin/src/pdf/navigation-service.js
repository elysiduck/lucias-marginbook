/* 36-plugin-jump —— 双向跳转/链接接管/相关笔记（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

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
        target: target
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
          this.lmbJumpToSelection(hit.filePath, hit.page, hit.selection, hit.rect, null, hit.target);
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
            this.lmbJumpToSelection(hit.filePath, hit.page, hit.selection, hit.rect, null, hit.target);
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
      } else if (entryText) {
        const rects = this.lmbResolveEntryTextRects(pageEl, entryText);
        if (rects) this.lmbFlashRects(pageEl, rects, null);
      }
    } catch (err) {
      console.warn("[lmb] lmbJumpToSelection error:", err);
    }
  },

  /**
   * 在 Markdown 摘录文档中定位：已打开则复用；存在左右分区时选择离 PDF 最远的
   * 现有 leaf；只有一个分区时才开新标签。绝不重复打开同一文档。
   */
  async lmbOpenExcerptInMd(exId, sourceMd, pdfLeaf) {
    try {
      if (!exId || !sourceMd) { new Notice("MarginBook: 该摘录缺少 Markdown 来源"); return false; }
      const file = this.app.vault.getAbstractFileByPath(sourceMd);
      if (!(file instanceof TFile)) { new Notice("MarginBook: 找不到摘录文档 " + sourceMd); return false; }
      const mdLeaves = this.app.workspace.getLeavesOfType("markdown") || [];
      let leaf = mdLeaves.find((l) => l && l.view && l.view.file && l.view.file.path === file.path) || null;
      if (!leaf) {
        const all = [];
        try { this.app.workspace.iterateAllLeaves((l) => { if (l && l !== pdfLeaf && l.containerEl) all.push(l); }); } catch (_) {}
        if (all.length) {
          const pr = pdfLeaf && pdfLeaf.containerEl ? pdfLeaf.containerEl.getBoundingClientRect() : null;
          all.sort((a, b) => {
            if (!pr) return 0;
            const ar = a.containerEl.getBoundingClientRect(), br = b.containerEl.getBoundingClientRect();
            return Math.abs((br.left + br.right) / 2 - (pr.left + pr.right) / 2)
              - Math.abs((ar.left + ar.right) / 2 - (pr.left + pr.right) / 2);
          });
          leaf = all[0];
        }
        if (!leaf) leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(file, { active: true, eState: { subpath: "#^" + exId } });
      } else {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }
      const editor = leaf.view && leaf.view.editor;
      const cache = this.app.metadataCache.getFileCache(file);
      const block = cache && cache.blocks && cache.blocks[exId];
      if (editor && block && block.position && block.position.start) {
        const line = block.position.start.line;
        editor.setCursor({ line, ch: 0 });
        editor.scrollIntoView({ from: { line: Math.max(0, line - 3), ch: 0 }, to: { line: line + 3, ch: 0 } }, true);
      } else {
        // 阅读模式或缓存尚未就绪：在同一个 leaf 上重设 subpath，仍不会新开标签。
        await leaf.openFile(file, { active: true, eState: { subpath: "#^" + exId } });
      }
      return true;
    } catch (err) { console.warn("[lmb] lmbOpenExcerptInMd error:", err); return false; }
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
      await this.lmbOpenExcerptInMd(exId, path, this._lmbGetActivePdfLeaf());
    } catch (err) {
      console.warn("[lmb] lmbOpenExcerptAt error:", err);
    }
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
