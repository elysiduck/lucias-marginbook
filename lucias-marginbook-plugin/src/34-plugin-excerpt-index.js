/* 34-plugin-excerpt-index —— 摘录索引/文档同步/画布聚焦（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

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
  },

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
  },

  /** 摘掉某个摘录文档贡献的全部条目（文件删除 or 重索引前调用） */
  dropFileFromIndex(mdPath) {
    if (!mdPath || !this.excerptIndex) return;
    for (const [k, arr] of Array.from(this.excerptIndex.entries())) {
      const kept = arr.filter((e) => e.sourceMd !== mdPath);
      if (kept.length !== arr.length) this.excerptIndex.set(k, kept);
    }
    this.indexMtime.delete(mdPath);
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
        const ids = n.text.match(/\^ex-[0-9a-z]{4,8}/g);
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

});
