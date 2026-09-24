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
      const mdPath = normalizePath(folder === "/" ? pdfBase + "-摘录.md" : folder + "/" + pdfBase + "-摘录.md");
      // Markdown 是备注真相源。重建受控摘录区之前先读取现有备注，稍后按 exId
      // 原样嵌回，避免 Canvas 同步正文时把用户在 MD/PDF 侧栏写的备注覆盖掉。
      const existing = this.app.vault.getAbstractFileByPath(mdPath);
      let existingRaw = "";
      if (existing instanceof TFile) {
        try { existingRaw = await this.app.vault.read(existing); } catch (_) { existingRaw = ""; }
      }

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
        const canonicalNote = existingRaw ? this._lmbFindSidebarNote(existingRaw, en.id) : "";
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

      const head = "---\nPDF: \"[[" + pdfPath + "]]\"\ncanvas: \"[[" + cf.basename + "]]\"\n";
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
   * 打开（必要时创建）PDF 专属摘录文档：<PDF名>-摘录.md（与 PDF 同目录）。
   * 存在 → 直接打开；已打开的 md 视图复用（绝不重开第二个标签）。
   * 不存在 → 写入 frontmatter 模板（PDF/canvas 指回本 PDF），与 writeExcerptMd 的头格式一致。
   */
  /** Ensure the canonical excerpt document exists without stealing focus from a PDF. */
  async lmbEnsureExcerptMdFile(pdfFile) {
    if (!pdfFile) return null;
    const folder = pdfFile.parent && pdfFile.parent.path ? pdfFile.parent.path : "/";
    const name = pdfFile.basename + "-摘录.md";
    const path = normalizePath(folder === "/" ? name : folder + "/" + name);
    let f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) {
      const canvasName = pdfFile.basename + ".canvas";
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
   * 打开（必要时创建）PDF 专属画布：<PDF名>.canvas（与 PDF 同目录）。
   * 复用约定与 lmbFocusCanvasNode 一致：已打开的画布直接激活，绝不重开第二视图
   * （同一文件两个视图会让 canvasPositions 等按视图对象为键的状态全部失效）。
   */
  async lmbOpenOrCreatePdfCanvas(pdfFile) {
    if (!pdfFile) return null;
    const folder = pdfFile.parent && pdfFile.parent.path ? pdfFile.parent.path : "/";
    const name = pdfFile.basename + ".canvas";
    const path = normalizePath(folder === "/" ? name : folder + "/" + name);
    let f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) {
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
      // Canvas 索引此时已经完整，按 Markdown 准值做一次启动同步。
      for (const md of cands) {
        try {
          const raw = await this.app.vault.cachedRead(md);
          await this.lmbMirrorMdNotesToCanvas(md, raw, lmbParseExcerptDoc(raw, md.path));
        } catch (_) {}
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
