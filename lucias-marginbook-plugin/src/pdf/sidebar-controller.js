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
      bar.querySelectorAll(".lmb-pdf-sidebar-item.is-active").forEach((el) => el.removeClass("is-active"));
      row.addClass("is-active"); row.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => row.removeClass("is-active"), 1800); return true;
    } catch (_) { return false; }
  },

  _lmbHighlightPdfSidebarTarget(exId, on) {
    try { document.querySelectorAll(".lmb-mark[data-ex]").forEach((m) => m.toggleClass("lmb-mark-sidebar-active", !!on && m.getAttribute("data-ex") === exId)); } catch (_) {}
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
      const entries = this._lmbGetPdfSidebarEntries(file);
      this.lmbRefreshTextBlocks().catch((err) => console.warn("[lmb] text block refresh failed", err));
      const sourceVersions = new Map();
      for (const e of entries) if (e && e.sourceMd && !sourceVersions.has(e.sourceMd)) {
        const source = this.app.vault.getAbstractFileByPath(e.sourceMd);
        sourceVersions.set(e.sourceMd, source && source.stat ? source.stat.mtime : 0);
      }
      const renderSig = JSON.stringify({
        file: file.path,
        entries: entries.map((e) => [e.exId, e.page, e.text, e.note, e.imagePath, e.tags]),
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
        const row = list.createDiv({ cls: "lmb-pdf-sidebar-item" }); row.dataset.page = String(e.page || ""); row.dataset.exId = e.exId || "";
        const textView = this.lmbTextBlockViews(file.path)[e.exId] || {};
        const compact = this.lmbIsTextBlockCollapsed(textView);
        row.toggleClass("is-compact", compact);
        const header = row.createDiv({ cls: "lmb-pdf-sidebar-item-header" });
        header.createDiv({ cls: "lmb-pdf-sidebar-item-title", text: `P.${e.page || "?"} · ${e._lmbSidebarOrdinal}` });
        const summary = header.createDiv({ cls: "lmb-pdf-sidebar-item-summary" });
        const expandEntry = header.createEl("button", { cls: "lmb-pdf-sidebar-expand-entry", text: "展开", attr: { "aria-label": `在侧栏展开 P.${e.page || "?"} · ${e._lmbSidebarOrdinal}` } });
        expandEntry.onclick = (ev) => { ev.stopPropagation(); this.lmbSetTextBlockCollapsed(e, file.path, false).catch((err) => new Notice("设置保存失败：" + err.message)); };
        if (e.tags && e.tags.length) header.createDiv({ cls: "lmb-pdf-sidebar-item-tags", text: e.tags.map((t) => "#" + t).join(" ") });
        const headerActions = header.createDiv({ cls: "lmb-pdf-sidebar-header-actions" });
        const body = row.createDiv({ cls: "lmb-pdf-sidebar-item-body" });
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
          ev.stopPropagation(); this.lmbEditTextBlockNote(Object.assign({}, e, { pdfPath: file.path }));
        };
        }
        if (e.quick) {
          const editQuick = iconButton(note ? "pencil" : "message-square-plus", note ? "编辑备注" : "添加备注");
          editQuick.onclick = (ev) => {
            ev.stopPropagation();
            this.lmbEditTextBlockNote(Object.assign({}, e, { pdfPath: file.path }));
          };
        }
        const remove = iconButton("trash-2", "删除摘录", headerActions);
        remove.addClass("lmb-pdf-sidebar-delete");
        remove.onclick = (ev) => {
          ev.stopPropagation();
          const message = e.quick
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
        row.onmouseenter = () => this._lmbHighlightPdfSidebarTarget(e.exId, true);
        row.onmouseleave = () => this._lmbHighlightPdfSidebarTarget(e.exId, false);
        row.onclick = () => this.lmbJumpToSelection(e.pdfPath || file.path, e.page, e.selection, e.rect, leaf, e.text);
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
      if (bar._lmbRenderToken !== renderToken || this._unloaded || leaf.view.file !== file) return;
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
      bar.scrollTop = oldScroll;
      if (anchor) {
        const replacement = Array.from(list.querySelectorAll(".lmb-pdf-sidebar-item")).find((row) => row.dataset.exId === anchor.dataset.exId);
        if (replacement && !replacement.classList.contains("is-page-hidden") && !replacement.classList.contains("is-search-hidden")) bar.scrollTop += replacement.getBoundingClientRect().top - anchorTop;
      }
      if (searchFocused) { search.focus({ preventScroll: true }); search.setSelectionRange(...selection); }
      bar._lmbRenderSig = renderSig;
    } catch (err) { console.warn("[lmb] render pdf sidebar failed:", err); }
  }
});
