/* 38-plugin-pdf-sidebar —— PDF 独立占位批注边页（原型混入） */
Object.assign(LuciasMarginBookPlugin.prototype, {
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
        try { if (this.app && this.app.workspace) this.app.workspace.trigger("resize"); } catch (_) {}
        try { win.dispatchEvent(new win.Event("resize")); } catch (_) {}
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
      else if (host) this._lmbNotifyPdfSidebarLayout(leaf);
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

  _lmbApplySidebarPageFilter(leaf, forcedPage) {
    try {
      const bar = leaf && leaf.containerEl && leaf.containerEl.querySelector(".lmb-pdf-excerpt-sidebar");
      if (!bar) return;
      const page = forcedPage || this._lmbCurrentPdfPage(leaf) || Number(bar.dataset.page) || 1;
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

  lmbHandlePdfSidebarScroll(ev) {
    if (this._lmbPdfSidebarFollow === false) return;
    const target = ev && ev.target && ev.target.nodeType === 1 ? ev.target : null;
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
    try {
      if (!exId) return false;
      let loc = this.excerptCanvasIndex && this.excerptCanvasIndex.get(exId);
      // 索引可能刚好晚于 Canvas 落盘；未命中时定点补扫一次所有 Canvas。
      if (!loc && this.app.vault.getFiles) {
        const files = this.app.vault.getFiles().filter((f) => f.extension === "canvas");
        for (const file of files) {
          await this.lmbIndexCanvasFile(file);
          loc = this.excerptCanvasIndex && this.excerptCanvasIndex.get(exId);
          if (loc) break;
        }
      }
      if (!loc || !loc.canvasPath || !loc.nodeId) {
        new Notice("MarginBook: 没有找到包含该摘录的 Canvas 卡片"); return false;
      }
      const file = this.app.vault.getAbstractFileByPath(loc.canvasPath);
      if (!(file instanceof TFile)) { new Notice("MarginBook: Canvas 文件已不存在"); return false; }
      const ok = await this.lmbFocusCanvasNode(file, loc.nodeId);
      if (!ok) new Notice("MarginBook: 已打开 Canvas，但没有找到对应卡片");
      return ok;
    } catch (err) { console.warn("[lmb] canvas excerpt locate failed:", err); return false; }
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
      const grip = bar.querySelector(".lmb-pdf-sidebar-resizer");
      Array.from(bar.children).forEach((child) => { if (child !== grip) child.remove(); });
      // 保持索引原始顺序，与 PDF 回绘的既有编号一致。不能按来源文档的
      // line 字段重排：不同 Markdown 文件的行号彼此不可比较，会让 PDF
      // 上已经稳定的序号整体洗牌。
      const entries = this._lmbGetPdfSidebarEntries(file);
      bar.dataset.total = String(entries.length);
      const pageOrdinals = new Map();
      for (const e of entries) {
        const key = String(e.page || "?");
        const ordinal = (pageOrdinals.get(key) || 0) + 1;
        pageOrdinals.set(key, ordinal); e._lmbSidebarOrdinal = ordinal;
      }
      const head = bar.createDiv({ cls: "lmb-pdf-sidebar-title" }), titleRow = head.createDiv({ cls: "lmb-pdf-sidebar-title-row" });
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
      currentBtn.onclick = () => { this._lmbPdfSidebarView = "current"; sync(); this._lmbApplySidebarPageFilter(leaf); };
      allBtn.onclick = () => { this._lmbPdfSidebarView = "all"; sync(); this._lmbApplySidebarPageFilter(leaf); };
      followBtn.onclick = () => { this._lmbPdfSidebarFollow = this._lmbPdfSidebarFollow === false; sync(); };
      sync();
      const search = head.createEl("input", { cls: "lmb-pdf-sidebar-search", attr: { type: "search", placeholder: "搜索摘录或备注…" } });
      const list = bar.createDiv({ cls: "lmb-pdf-sidebar-list" }), mdCache = new Map();
      for (const e of entries) {
        const row = list.createDiv({ cls: "lmb-pdf-sidebar-item" }); row.dataset.page = String(e.page || ""); row.dataset.exId = e.exId || "";
        const header = row.createDiv({ cls: "lmb-pdf-sidebar-item-header" });
        // 卡片头部只呈现定位信息。摘录类型可由内容/操作判断，target 仅供
        // 内部回绘校验使用，不再把这两项重复展示给用户。
        header.createDiv({ cls: "lmb-pdf-sidebar-item-title", text: `P.${e.page || "?"} · ${e._lmbSidebarOrdinal}` });
        if (e.tags && e.tags.length) header.createDiv({ cls: "lmb-pdf-sidebar-item-tags", text: e.tags.map((t) => "#" + t).join(" ") });
        const body = row.createDiv({ cls: "lmb-pdf-sidebar-item-body" });
        const cleanText = String(e.text || "").trim();
        let textEl = null;
        if (cleanText) {
          textEl = body.createDiv({ cls: "lmb-pdf-sidebar-item-text lmb-pdf-sidebar-item-text-excerpt markdown-rendered" });
          try { await MarkdownRenderer.render(this.app, cleanText, textEl, e.sourceMd || "", this); }
          catch (_) { textEl.setText(cleanText); }
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
          if (!mdCache.has(e.sourceMd)) mdCache.set(e.sourceMd, await this._lmbReadSidebarNotes(e.sourceMd));
          note = this._lmbFindSidebarNote(mdCache.get(e.sourceMd) || "", e.exId);
        }
        if (note) {
          const noteEl = row.createDiv({ cls: "lmb-pdf-sidebar-item-note" });
          const noteBody = noteEl.createDiv({ cls: "lmb-pdf-sidebar-item-note-body markdown-rendered" });
          try { await MarkdownRenderer.render(this.app, note, noteBody, e.sourceMd || "", this); }
          catch (_) { noteBody.setText(note); }
        }
        const actions = row.createDiv({ cls: "lmb-pdf-sidebar-item-actions" });
        const iconButton = (icon, label) => {
          const button = actions.createEl("button", { cls: "lmb-pdf-sidebar-icon-button", attr: { title: label, "aria-label": label } });
          try { setIcon(button, icon); } catch (_) { button.setText(label.slice(0, 1)); }
          return button;
        };
        const color = iconButton("palette", "修改摘录颜色");
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
        const jump = iconButton("book-open", "在 PDF 中定位");
        const openMd = iconButton("notebook-pen", "在摘录文档中定位");
        const openCanvas = iconButton("waypoints", "在 Canvas 中定位");
        const edit = iconButton(note ? "pencil" : "message-square-plus", note ? "编辑备注" : "添加备注");
        jump.onclick = (ev) => { ev.stopPropagation(); this.lmbJumpToSelection(e.pdfPath || file.path, e.page, e.selection, e.rect, leaf, e.text); };
        openMd.onclick = (ev) => { ev.stopPropagation(); this.lmbOpenExcerptInMd(e.exId, e.sourceMd, leaf); };
        openCanvas.onclick = (ev) => { ev.stopPropagation(); this.lmbOpenExcerptInCanvas(e.exId); };
        edit.onclick = (ev) => {
          ev.stopPropagation(); const source = e.sourceMd && this.app.vault.getAbstractFileByPath(e.sourceMd);
          if (!(source instanceof TFile) || !e.exId) { new Notice("该摘录缺少可编辑的来源文档"); return; }
          new LMBExcerptNoteModal(this.app, { title: "PDF 摘录备注", value: note || "", sourcePath: source.path,
            onSubmit: async (value) => {
              const ok = await this.lmbSaveExcerptNote(source, e.exId, value);
              if (ok) { await this.reindexFile(source, true); await this.lmbRenderPdfSidebarForLeaf(leaf); new Notice("备注已同步"); }
              else new Notice("未找到对应摘录，未修改文档");
            } }).open();
        };
        }
        if (e.quick) {
          const editQuick = iconButton(note ? "pencil" : "message-square-plus", note ? "编辑备注" : "添加备注");
          editQuick.onclick = (ev) => {
            ev.stopPropagation();
            new LMBExcerptNoteModal(this.app, { title: "简洁摘录备注", value: note || "", sourcePath: "",
              onSubmit: async (value) => {
                const path = String(file.path || "").replace(/\\/g, "/");
                const list = this.settings.quickExcerpts && this.settings.quickExcerpts[path];
                const item = Array.isArray(list) && list.find((x) => x && x.exId === e.exId);
                if (!item) { new Notice("未找到这条简洁摘录"); return; }
                item.note = String(value || "");
                await this.saveSettings(); await this.lmbRenderPdfSidebarForLeaf(leaf);
                new Notice("备注已保存");
              }
            }).open();
          };
        }
        const remove = iconButton("trash-2", "删除摘录");
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
      search.oninput = () => {
        const query = String(search.value || "").trim().toLowerCase();
        list.querySelectorAll(".lmb-pdf-sidebar-item").forEach((row) => row.toggleClass("is-search-hidden", !!query && !row.textContent.toLowerCase().includes(query)));
      };
      if (!entries.length) list.createDiv({ cls: "lmb-pdf-sidebar-empty", text: "当前 PDF 暂无可用批注" });
      this._lmbApplySidebarPageFilter(leaf);
    } catch (err) { console.warn("[lmb] render pdf sidebar failed:", err); }
  }
});
