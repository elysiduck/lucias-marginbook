/* Editable Markdown overlays. Content stays in the existing excerpt note store;
 * this store contains presentation only, keyed by PDF path and stable excerpt ID. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  lmbTextBlockViews(path) {
    const store = this.settings.pdfTextBlocks || (this.settings.pdfTextBlocks = {});
    return store[path] || (store[path] = {});
  },

  async lmbTextBlockNote(entry) {
    if (entry.quick) {
      const list = this.settings.quickExcerpts && this.settings.quickExcerpts[entry.pdfPath];
      const item = Array.isArray(list) && list.find((x) => x.exId === entry.exId);
      return String(item ? item.note || "" : entry.note || "");
    }
    return this._lmbFindSidebarNote(await this._lmbReadSidebarNotes(entry.sourceMd), entry.exId);
  },

  async lmbSaveTextBlockNote(entry, value) {
    if (entry.quick) {
      const list = this.settings.quickExcerpts && this.settings.quickExcerpts[entry.pdfPath];
      const item = Array.isArray(list) && list.find((x) => x.exId === entry.exId);
      if (!item) throw new Error("这条批注已被删除");
      item.note = String(value || "");
      await this.saveSettings();
    } else {
      const source = this.app.vault.getAbstractFileByPath(entry.sourceMd);
      if (!source || !await this.lmbSaveExcerptNote(source, entry.exId, value)) throw new Error("未找到对应摘录，未修改文档");
      await this.reindexFile(source, true);
    }
  },

  async lmbEditTextBlockNote(entry, afterSave) {
    try {
      const value = await this.lmbTextBlockNote(entry);
      new LMBExcerptNoteModal(this.app, {
        title: "Markdown 批注", value, sourcePath: entry.sourceMd || "",
        onSubmit: async (text) => {
            await this.lmbSaveTextBlockNote(entry, text);
            await this.lmbRefreshTextBlocks();
            this.lmbSchedulePdfSidebarRefresh(0);
            if (afterSave) await afterSave(text);
        }
      }).open();
    } catch (err) { new Notice("无法打开批注：" + err.message); }
  },

  lmbIsTextBlockCollapsed(view) {
    return !!(view && (view.collapsed === undefined ? view.hidden : view.collapsed));
  },

  async lmbSetTextBlockCollapsed(entry, path, collapsed) {
    const views = this.lmbTextBlockViews(path);
    const view = views[entry.exId] || (views[entry.exId] = {});
    view.collapsed = !!collapsed;
    delete view.hidden; // Previous releases hid the row; now it always retains an expand entry.
    this.lmbApplySidebarCollapsedState(path, entry.exId, !!collapsed);
    await this.saveSettings();
  },

  async lmbStartTextBlockPlacement(entry, leaf) {
    if (!entry.exId) return;
    if (!(await this.lmbTextBlockNote(entry)).trim()) {
      await this.lmbEditTextBlockNote(entry, (text) => text.trim() && this.lmbStartTextBlockPlacement(entry, leaf));
      return;
    }
    if (this._lmbCancelTextPlacement) this._lmbCancelTextPlacement();
    const root = leaf.containerEl, doc = root.ownerDocument;
    const notice = new Notice("点击 PDF 空白处放置文本块；Esc 取消", 0);
    root.classList.add("lmb-text-placing");
    const cancel = () => {
      root.classList.remove("lmb-text-placing"); notice.hide();
      doc.removeEventListener("pointerdown", place, true); doc.removeEventListener("keydown", key, true);
      this._lmbCancelTextPlacement = null;
    };
    const key = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); cancel(); } };
    const place = async (ev) => {
      const page = ev.target.closest && ev.target.closest(".page[data-page-number]");
      if (!page || !root.contains(page) || ev.button !== 0 || ev.target.closest(".lmb-pdf-text-block")) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      const rect = page.getBoundingClientRect(), path = leaf.view.file.path;
      const x = Math.max(0, Math.min(.8, (ev.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(.95, (ev.clientY - rect.top) / rect.height));
      const views = this.lmbTextBlockViews(path);
      Object.assign(views[entry.exId] || (views[entry.exId] = {}), {
        page: Number(page.dataset.pageNumber), x, y, w: Math.min(.55, 1 - x),
        fontSize: Number(views[entry.exId] && views[entry.exId].fontSize) || 16
      });
      cancel();
      try { await this.saveSettings(); await this.lmbRefreshTextBlocks(); }
      catch (err) { new Notice("文本块保存失败：" + err.message); }
    };
    this._lmbCancelTextPlacement = cancel;
    doc.addEventListener("pointerdown", place, true); doc.addEventListener("keydown", key, true);
  },

  async lmbRefreshTextBlocks() {
    for (const leaf of this.app.workspace.getLeavesOfType("pdf") || []) {
      const file = leaf.view && leaf.view.file;
      if (!file) continue;
      await Promise.all(Array.from(leaf.containerEl.querySelectorAll(".page[data-page-number]"),
        (page) => this.lmbRenderTextBlocksOnPage(page, file.path)));
    }
  },

  async lmbRenderTextBlocksOnPage(page, path) {
    const token = {}; page._lmbTextBlockToken = token;
    const views = this.settings.pdfTextBlocks && this.settings.pdfTextBlocks[path] || {};
    if (!Object.values(views).some((view) => view && Number(view.page) === Number(page.dataset.pageNumber))) {
      page.querySelectorAll(":scope > .lmb-pdf-text-block").forEach((el) => el.remove());
      this.lmbReleaseTextBlockPage(page);
      return;
    }
    page._lmbTextBlockPath = path;
    const observers = this._lmbTextResizeObservers || (this._lmbTextResizeObservers = new Map());
    if (!observers.has(page) && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        if (!page.isConnected || this._unloaded) { this.lmbReleaseTextBlockPage(page); return; }
        this.lmbRenderTextBlocksOnPage(page, page._lmbTextBlockPath).catch((err) => console.warn("[lmb] text resize failed", err));
      });
      observers.set(page, observer); observer.observe(page);
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    const entries = this._lmbGetPdfSidebarEntries(file);
    const wanted = new Set();
    for (const entry of entries) {
      const view = views[entry.exId];
      if (!view || Number(view.page) !== Number(page.dataset.pageNumber)) continue;
      wanted.add(entry.exId);
      const note = await this.lmbTextBlockNote(Object.assign({}, entry, { pdfPath: path }));
      if (this._unloaded || page._lmbTextBlockToken !== token || !page.isConnected) return;
      let block = Array.from(page.querySelectorAll(":scope > .lmb-pdf-text-block")).find((el) => el.dataset.exId === entry.exId);
      const sourceKey = JSON.stringify([path, entry.sourceMd || "", !!entry.quick]);
      if (block && block._lmbTextSourceKey !== sourceKey) { block.remove(); block = null; }
      if (!block) block = this.lmbCreateTextBlock(page, Object.assign({}, entry, { pdfPath: path }), view);
      this.lmbStyleTextBlock(block, page, view);
      const body = block.querySelector(".lmb-pdf-text-body");
      if (body._lmbMarkdown !== note || !body.childNodes.length) {
        body._lmbMarkdown = note; body.empty();
        // Render detached so an older async Markdown render cannot overwrite a newer note.
        const content = page.ownerDocument.createElement("div");
        try { await MarkdownRenderer.render(this.app, note || "*空批注，双击编辑*", content, entry.sourceMd || "", this); }
        catch (_) { content.textContent = note; }
        if (page._lmbTextBlockToken === token && body._lmbMarkdown === note) body.replaceChildren(content);
      }
    }
    if (page._lmbTextBlockToken !== token) return;
    page.querySelectorAll(":scope > .lmb-pdf-text-block").forEach((el) => { if (!wanted.has(el.dataset.exId)) el.remove(); });
  },

  lmbStyleTextBlock(block, page, view) {
    block.style.left = (view.x || 0) * 100 + "%";
    block.style.top = (view.y || 0) * 100 + "%";
    block.style.width = (view.w || .55) * 100 + "%";
    // 1000 reference units keep type proportional when PDF.js zooms or resizes.
    block.style.fontSize = (view.fontSize || 16) * page.getBoundingClientRect().width / 1000 + "px";
    const body = block.querySelector(".lmb-pdf-text-body");
    body.style.maxHeight = Math.max(24, page.getBoundingClientRect().height * (1 - (view.y || 0)) - 8) + "px";
    body.title = "双击编辑 Markdown；长文超出页面时可在块内滚动";
    block.querySelector("input").value = String(view.fontSize || 16);
    const tools = block.querySelector(".lmb-pdf-text-tools");
    const nearTop = (view.y || 0) * page.getBoundingClientRect().height < 60;
    tools.style.bottom = nearTop ? "auto" : "100%";
    tools.style.top = nearTop ? "0" : "auto";
    tools.style.left = Math.min(0, page.getBoundingClientRect().width * (1 - (view.x || 0)) - 280) + "px";
    block.querySelector(".lmb-text-sidebar-toggle").textContent = this.lmbIsTextBlockCollapsed(view) ? "侧栏展开" : "侧栏收起";
    block.classList.toggle("is-note-style", view.style === "note");
  },

  lmbCreateTextBlock(page, entry, view) {
    const block = page.createDiv({ cls: "lmb-pdf-text-block" }); block.dataset.exId = entry.exId;
    block._lmbTextSourceKey = JSON.stringify([entry.pdfPath, entry.sourceMd || "", !!entry.quick]);
    block.tabIndex = 0;
    const bar = block.createDiv({ cls: "lmb-pdf-text-tools" });
    const grip = bar.createEl("button", { text: "⠿", attr: { title: "拖动移动文本块", "aria-label": "移动文本块" } });
    const button = (text, action, cls) => {
      const b = bar.createEl("button", { text, cls: cls || "" });
      b.onclick = (ev) => { ev.stopPropagation(); Promise.resolve(action()).catch((err) => new Notice("操作失败：" + err.message)); }; return b;
    };
    const persist = async () => { await this.saveSettings(); this.lmbSchedulePdfSidebarRefresh(0); };
    button("编辑", () => this.lmbEditTextBlockNote(entry));
    const size = bar.createEl("input", { attr: { type: "number", min: "8", max: "72", step: "1", "aria-label": "文本块字号（随 PDF 缩放）", title: "字号（随 PDF 缩放）" } });
    size.onchange = async () => {
      view.fontSize = Math.max(8, Math.min(72, Number(size.value) || 16));
      this.lmbStyleTextBlock(block, page, view);
      try { await persist(); } catch (err) { new Notice("字号保存失败：" + err.message); }
    };
    size.oninput = () => {
      const value = Number(size.value);
      if (value >= 8 && value <= 72) size.onchange();
    };
    button("样式", () => { view.style = view.style === "note" ? "transparent" : "note"; this.lmbStyleTextBlock(block, page, view); return persist(); });
    button("侧栏收起", () => this.lmbSetTextBlockCollapsed(entry, entry.pdfPath, !this.lmbIsTextBlockCollapsed(view)), "lmb-text-sidebar-toggle");
    button("移除", async () => {
      delete view.page; block.remove(); await persist(); await this.lmbRefreshTextBlocks();
    });
    const body = block.createDiv({ cls: "lmb-pdf-text-body markdown-rendered" });
    body.ondblclick = (ev) => { ev.stopPropagation(); this.lmbEditTextBlockNote(entry); };
    // Keep overlay interaction out of PDF selection/ink gestures while preserving text selection.
    ["pointerdown", "click", "dblclick"].forEach((type) => block.addEventListener(type, (ev) => ev.stopPropagation()));
    const resize = block.createDiv({ cls: "lmb-pdf-text-resize", attr: { title: "拖动调整宽度" } });
    const start = (ev, widthOnly) => {
      if (ev.button !== 0) return;
      ev.preventDefault(); ev.stopPropagation();
      const rect = page.getBoundingClientRect(), origin = { x: view.x, y: view.y, w: view.w }, sx = ev.clientX, sy = ev.clientY;
      const control = ev.currentTarget; control.setPointerCapture(ev.pointerId);
      const move = (event) => {
        const dx = (event.clientX - sx) / rect.width, dy = (event.clientY - sy) / rect.height;
        if (widthOnly) view.w = Math.max(.12, Math.min(1 - view.x, origin.w + dx));
        else {
          view.x = Math.max(0, Math.min(1 - view.w, origin.x + dx));
          const height = Math.min(1, block.getBoundingClientRect().height / rect.height);
          view.y = Math.max(0, Math.min(1 - height, origin.y + dy));
        }
        this.lmbStyleTextBlock(block, page, view);
      };
      const finish = () => {
        control.removeEventListener("pointermove", move); control.removeEventListener("pointerup", finish);
        control.removeEventListener("pointercancel", cancel);
        persist().catch((err) => new Notice("位置保存失败：" + err.message));
      };
      const cancel = () => { Object.assign(view, origin); this.lmbStyleTextBlock(block, page, view); finish(); };
      control.addEventListener("pointermove", move); control.addEventListener("pointerup", finish); control.addEventListener("pointercancel", cancel);
    };
    grip.onpointerdown = (ev) => start(ev, false); resize.onpointerdown = (ev) => start(ev, true);
    return block;
  },

  lmbSetupTextBlocks() {
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!file || file.extension !== "pdf") return;
      const store = this.settings.pdfTextBlocks;
      if (store && store[oldPath]) {
        store[file.path] = Object.assign({}, store[oldPath], store[file.path]); delete store[oldPath];
        const quick = this.settings.quickExcerpts;
        if (quick && quick[oldPath]) { quick[file.path] = (quick[file.path] || []).concat(quick[oldPath]); delete quick[oldPath]; }
        this.saveSettings().then(() => this.lmbRefreshTextBlocks()).catch((err) => new Notice("文本块路径更新失败：" + err.message));
      }
    }));
    this.register(() => {
      if (this._lmbCancelTextPlacement) this._lmbCancelTextPlacement();
      for (const observer of (this._lmbTextResizeObservers || new Map()).values()) observer.disconnect();
      if (this._lmbTextResizeObservers) this._lmbTextResizeObservers.clear();
      document.querySelectorAll(".lmb-pdf-text-block").forEach((el) => el.remove());
    });
  },

  lmbReleaseTextBlockPage(page) {
    const observers = this._lmbTextResizeObservers;
    if (observers && observers.has(page)) { observers.get(page).disconnect(); observers.delete(page); }
  }
});
