/* Editable Markdown overlays. Content stays in the existing excerpt note store;
 * this store contains presentation only, keyed by PDF path and stable excerpt ID. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  async lmbFinishTextBlockEditors(leaf, except) {
    const sidebar = leaf.containerEl.querySelector('.lmb-pdf-excerpt-sidebar');
    const sidebarEditor = sidebar?._lmbSidebarEditor;
    if (sidebarEditor && !await sidebarEditor.save()) { sidebarEditor.input.focus({ preventScroll: true }); return false; }
    for (const block of [...(this._lmbActiveInlineBlocks || [])]) {
      const editor = block._lmbInlineEditor;
      if (block !== except && leaf.containerEl.contains(block) && editor && !await editor.save()) { editor.input.focus({ preventScroll: true }); return false; }
    }
    return true;
  },

  async lmbActivateTextBlock(block, edit = false, event) {
    const leaf = (this.app.workspace.getLeavesOfType('pdf') || []).find(l => l.containerEl.contains(block));
    if (!leaf || !block.isConnected) return false;
    const request = leaf._lmbTextInteraction = {};
    if (!await this.lmbFinishTextBlockEditors(leaf, block)) return false;
    if (leaf._lmbTextInteraction !== request || !block.isConnected || leaf.view.file?.path !== block._lmbTextEntry.pdfPath || this._unloaded) return false;
    this.lmbSelectPdfSidebarEntry(leaf, block._lmbTextEntry);
    if (edit) await this.lmbEditTextBlockNote(block._lmbTextEntry, null, block, event, request);
    return true;
  },

  lmbEnsureTextBlockInteractions(leaf) {
    if (!leaf || leaf._lmbTextSelectionListener) return;
    const root = leaf.containerEl, doc = root.ownerDocument;
    const clear = async (event, force = false) => {
      const target = event.target;
      if (!target?.closest || event.button > 0 || !force && root.contains(target) && target.closest('.lmb-pdf-text-block')) return;
      if (root.contains(target) && target.closest('.lmb-pdf-excerpt-sidebar,.lmb-sidebar-header-actions,.lmb-mark')) return;
      if (!root.querySelector('.lmb-pdf-text-block.lmb-note-selected,.lmb-pdf-text-block.is-editing')) return;
      const request = leaf._lmbTextInteraction = {};
      const editing = root.querySelector('.lmb-pdf-text-block.is-editing');
      if (editing && root.contains(target) && target.closest('.page')) { event.preventDefault(); event.stopImmediatePropagation(); }
      if (!await this.lmbFinishTextBlockEditors(leaf)) return;
      if (leaf._lmbTextInteraction !== request || this._unloaded) return;
      leaf._lmbSelectedExcerpt = null;
      root.querySelectorAll('.lmb-pdf-text-block').forEach(block => {
        block.classList.remove('lmb-note-hover');
        if (block.contains(doc.activeElement)) doc.activeElement.blur();
      });
      this.lmbSyncPdfNoteSelection(leaf);
    };
    const escape = event => {
      if (event.key !== 'Escape' || event.isComposing || root.querySelector('.lmb-pdf-text-block.is-editing') || /INPUT|TEXTAREA/.test(event.target?.tagName)) return;
      if (root.querySelector('.lmb-pdf-text-block.lmb-note-selected')) clear(event, true);
    };
    leaf._lmbTextSelectionListener = clear;
    doc.addEventListener('click', clear, true); root.addEventListener('keydown', escape);
    if (this.register) this.register(() => { doc.removeEventListener('click', clear, true); root.removeEventListener('keydown', escape); delete leaf._lmbTextSelectionListener; });
  },

  async lmbCreatePageNote(leaf, file, page, point, markdown, placement = {}) {
    if (this._unloaded || !leaf.view || leaf.view.file !== file) throw new Error("PDF 已切换，请在目标页面重新创建");
    if (!String(markdown || "").trim()) return null;
    const path = file.path, exId = placement.exId || "page-note-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    const item = { exId, pageNote: true, page, text: "", note: String(markdown) };
    const store = this.settings.quickExcerpts || (this.settings.quickExcerpts = {});
    const list = store[path] || (store[path] = []);
    const views = this.lmbTextBlockViews(path);
    const x = Math.max(0, Math.min(.8, Number(point.x) || 0)), y = Math.max(0, Math.min(.95, Number(point.y) || 0));
    list.push(item); views[exId] = placement.view || { page, x, y, w: Math.min(.6, 1 - x), fontSize: 16 };
    try { await this.saveSettings(); }
    catch (err) { list.splice(list.indexOf(item), 1); delete views[exId]; throw err; }
    try { await this.lmbRefreshTextBlocks(); await this.lmbRenderPdfSidebarForLeaf(leaf); }
    catch (err) { new Notice("备注已保存，预览刷新失败：" + err.message); }
    return item;
  },

  lmbStartPageNote(leaf) {
    const file = leaf && leaf.view && leaf.view.file;
    if (!file || file.extension !== "pdf") { new Notice("请先打开 PDF"); return; }
    if (this._lmbCancelTextPlacement) this._lmbCancelTextPlacement();
    if (this.inkMode) this.lmbSetInkMode(false);
    if (this.rectMode) this.setRectMode(false);
    const root = leaf.containerEl, doc = root.ownerDocument;
    const notice = new Notice("点击 PDF 空白处新建 Markdown 页注；Esc 取消", 0);
    root.classList.add("lmb-text-placing");
    let active = true, placing = false;
    const cancel = () => {
      active = false;
      root.classList.remove("lmb-text-placing"); notice.hide();
      doc.removeEventListener("click", place, true); doc.removeEventListener("keydown", key, true);
      this._lmbCancelTextPlacement = null;
    };
    const key = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); cancel(); } };
    const place = async (ev) => {
      const page = ev.target.closest && ev.target.closest(".page[data-page-number]");
      if (!page || !root.contains(page) || ev.button !== 0 || ev.target.closest(".lmb-pdf-text-block")) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (!active || placing) return;
      placing = true;
      try {
        const sidebar = root.querySelector(".lmb-pdf-excerpt-sidebar");
        if (sidebar && sidebar._lmbSidebarEditor && !await sidebar._lmbSidebarEditor.save()) return;
        for (const block of Array.from(this._lmbActiveInlineBlocks || [])) {
          if (root.contains(block) && block._lmbInlineEditor && !await block._lmbInlineEditor.save()) return;
        }
        if (!active) return;
        if (leaf.view.file !== file) { cancel(); return; }
        const rect = page.getBoundingClientRect();
        const point = { x: (ev.clientX - rect.left) / rect.width, y: (ev.clientY - rect.top) / rect.height };
        const pageNumber = Number(page.dataset.pageNumber);
        cancel();
        const view = { page: pageNumber, x: Math.max(0, Math.min(.8, point.x)), y: Math.max(0, Math.min(.95, point.y)), w: Math.min(.6, 1 - Math.max(0, Math.min(.8, point.x))), fontSize: 16 };
        const entry = { exId: "page-note-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10), pdfPath: file.path, quick: true, pageNote: true };
        const draft = this.lmbCreateTextBlock(page, entry, view);
        draft.addClass("is-draft");
        let created = false;
        this.lmbOpenInlineNoteEditor(draft, { title: `新建页注 · P.${pageNumber}`, autosave: true, pageRoot: root, value: "", sourcePath: file.path,
          onSubmit: async (text) => {
            if (created) await this.lmbSaveTextBlockNote(entry, text);
            else {
              const item = await this.lmbCreatePageNote(leaf, file, pageNumber, point, text, { exId: entry.exId, view });
              created = !!item;
            }
            this.lmbSchedulePdfSidebarRefresh(0);
          },
          onClose: () => { draft.remove(); if (!this._unloaded) this.lmbRefreshTextBlocks().catch(err => new Notice(err.message)); }
        });
        this.lmbStyleTextBlock(draft, page, view);
      } finally { placing = false; }
    };
    this._lmbCancelTextPlacement = cancel;
    // Consume the completed placement click before installing the editor's
    // outside-click listener. Opening on pointerdown lets its trailing click
    // immediately close the empty draft again (including mouse/touch retargeting).
    doc.addEventListener("click", place, true); doc.addEventListener("keydown", key, true);
  },

  lmbTextBlockViews(path) {
    const store = this.settings.pdfTextBlocks || (this.settings.pdfTextBlocks = {});
    return store[path] || (store[path] = {});
  },

  async lmbTextBlockNote(entry) {
    const draft = this._lmbSidebarNoteDrafts && this._lmbSidebarNoteDrafts.get(this.lmbNoteEditorKey(entry));
    if (draft && !draft.closed) return draft.getText();
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
      const previous = item.note, next = String(value || ""); item.note = next;
      try { await this.saveSettings(); }
      catch (err) { if (item.note === next) item.note = previous; throw err; }
    } else {
      const source = this.app.vault.getAbstractFileByPath(entry.sourceMd);
      if (!source || !await this.lmbSaveExcerptNote(source, entry.exId, value)) throw new Error("未找到对应摘录，未修改文档");
      await this.reindexFile(source, true);
    }
  },

  async lmbEditTextBlockNote(entry, afterSave, preferredBlock, editEvent, interactionToken) {
    if (this.inkMode) await this.lmbSetInkMode(false);
    try {
      const block = preferredBlock || (this.app.workspace.getLeavesOfType("pdf") || [])
        .filter((leaf) => leaf.view && leaf.view.file && leaf.view.file.path === entry.pdfPath)
        .flatMap((leaf) => Array.from(leaf.containerEl.querySelectorAll(".lmb-pdf-text-block")))
        .find((el) => el.dataset.exId === entry.exId);
      if (block && block._lmbInlineEditor) { block._lmbInlineEditor.input.focus({ preventScroll: true }); return; }
      const sidebarDraft = this._lmbSidebarNoteDrafts && this._lmbSidebarNoteDrafts.get(this.lmbNoteEditorKey(entry));
      if ((!block || !block.isConnected) && sidebarDraft && !sidebarDraft.closed) { sidebarDraft.input.focus({ preventScroll: true }); return; }
      const value = await this.lmbTextBlockNote(entry);
      const interactionLeaf = interactionToken && (this.app.workspace.getLeavesOfType('pdf') || []).find(l => l.containerEl.contains(block));
      if (interactionToken && (!interactionLeaf || interactionLeaf._lmbTextInteraction !== interactionToken)) return;
      if (block && block.isConnected) {
        const owner = (this.app.workspace.getLeavesOfType("pdf") || []).find(l => l.containerEl.contains(block));
        if (owner) {
          const bar = owner.containerEl.querySelector(".lmb-pdf-excerpt-sidebar");
          if (bar && bar._lmbSidebarEditor && !await bar._lmbSidebarEditor.save()) { bar._lmbSidebarEditor.input.focus({ preventScroll: true }); return; }
          const editors = Array.from(this._lmbActiveInlineBlocks || []).filter(el => el !== block && owner.containerEl.contains(el) && el._lmbInlineEditor);
          for (const other of editors) if (!await other._lmbInlineEditor.save()) { other._lmbInlineEditor.input.focus({ preventScroll: true }); return; }
          if (!owner.view.file || owner.view.file.path !== entry.pdfPath) return;
          if (interactionToken && owner._lmbTextInteraction !== interactionToken) return;
        }
        const cursorOffset = editEvent ? this.lmbLivePointerOffset(block.querySelector(".lmb-pdf-text-body"), value, editEvent) : 0;
        this.lmbOpenInlineNoteEditor(block, { title: "实时编辑", autosave: true, pageRoot: owner && owner.containerEl, value, cursorOffset, sourcePath: entry.sourceMd || entry.pdfPath || "",
          onSubmit: async (text) => { await this.lmbSaveTextBlockNote(entry, text); this.lmbSchedulePdfSidebarRefresh(0); },
          onClose: (saved, text) => {
            if (this._unloaded) return;
            if (!saved && owner?._lmbSelectedExcerpt?.exId === entry.exId) {
              owner._lmbTextInteraction = {}; owner._lmbSelectedExcerpt = null;
              this.lmbSyncPdfNoteSelection(owner);
            }
            this.lmbRefreshTextBlocks().catch((err) => new Notice("预览刷新失败：" + err.message));
            if (saved) { this.lmbSchedulePdfSidebarRefresh(0); if (afterSave) Promise.resolve(afterSave(text)).catch((err) => new Notice(err.message)); }
          }
        });
        return;
      }
      const leaf = (this.app.workspace.getLeavesOfType("pdf") || []).find(l => l.view && l.view.file && l.view.file.path === entry.pdfPath);
      if (leaf) { await this.lmbOpenSidebarNoteEditor(entry, leaf, null, afterSave); return; }
      new LMBExcerptNoteModal(this.app, {
        title: "Markdown 批注", value, sourcePath: entry.sourceMd || "", compact: true,
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
    // Placement transitions from drawing to text. Otherwise the active ink
    // capture layer remains above the new block and swallows its edit click.
    if (this.inkMode) await this.lmbSetInkMode(false);
    if (this.rectMode) this.setRectMode(false);
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
      if (entry.pageNote) {
        const list = this.settings.quickExcerpts && this.settings.quickExcerpts[path];
        const item = Array.isArray(list) && list.find((e) => e.exId === entry.exId);
        if (item) item.page = Number(page.dataset.pageNumber);
        this.lmbSchedulePdfSidebarRefresh(0);
      }
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
      this.lmbSyncPdfNoteSelection(leaf);
    }
  },

  async lmbRenderTextBlocksOnPage(page, path) {
    const token = {}; page._lmbTextBlockToken = token;
    // PDF.js may recycle a page while it contains an unsaved editor. Reattach
    // that editor (including its draft/caret) when the same page returns.
    for (const block of this._lmbActiveInlineBlocks || []) {
      if (!block.isConnected && block._lmbTextEntry.pdfPath === path && Number(block._lmbTextView.page) === Number(page.dataset.pageNumber)) {
        page.appendChild(block); this.lmbStyleTextBlock(block, page, block._lmbTextView);
        const state = block._lmbInlineEditor;
        if (state && state.observer) { state.observer.disconnect(); state.observer.observe(page); }
      }
    }
    const views = this.settings.pdfTextBlocks && this.settings.pdfTextBlocks[path] || {};
    if (!Object.values(views).some((view) => view && Number(view.page) === Number(page.dataset.pageNumber))) {
      page.querySelectorAll(":scope > .lmb-pdf-text-block").forEach((el) => { if (!el._lmbInlineEditor) el.remove(); });
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
      if (block && block._lmbTextSourceKey !== sourceKey && !block._lmbInlineEditor) { block.remove(); block = null; }
      if (!block) block = this.lmbCreateTextBlock(page, Object.assign({}, entry, { pdfPath: path }), view);
      this.lmbStyleTextBlock(block, page, view);
      if (block._lmbInlineEditor) continue;
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
    page.querySelectorAll(":scope > .lmb-pdf-text-block").forEach((el) => { if (!wanted.has(el.dataset.exId) && !el._lmbInlineEditor) el.remove(); });
    for (const leaf of this.app.workspace.getLeavesOfType("pdf") || []) {
      if (leaf._lmbSelectedExcerpt && leaf.view && leaf.view.file && leaf.view.file.path === path) this.lmbSyncPdfNoteSelection(leaf);
    }
  },

  lmbStyleTextBlock(block, page, view) {
    block.style.left = (view.x || 0) * 100 + "%";
    const pageHeight = page.getBoundingClientRect().height;
    // Editing must keep the same page anchor, including notes near the bottom.
    const y = view.y || 0;
    block.style.top = y * 100 + "%";
    block.style.width = (view.w || .55) * 100 + "%";
    // 1000 reference units keep type proportional when PDF.js zooms or resizes.
    block.style.fontSize = (view.fontSize || 16) * page.getBoundingClientRect().width / 1000 + "px";
    block.style.setProperty("--lmb-pdf-text-size", block.style.fontSize);
    const body = block.querySelector(".lmb-pdf-text-body");
    body.style.maxHeight = Math.max(24, pageHeight * (1 - y) - 8) + "px";
    body.title = block._lmbInlineEditor ? "点击段落切换源码；Ctrl/Cmd+Enter 保存，Esc 取消" : "单击选中并显示工具栏；双击编辑 Markdown；长文可在块内滚动";
    block.querySelector("input").value = String(view.fontSize || 16);
    const tools = block.querySelector(".lmb-pdf-text-tools");
    const nearTop = (view.y || 0) * page.getBoundingClientRect().height < Math.max(76, tools.offsetHeight || 0);
    tools.style.bottom = nearTop ? "auto" : "100%";
    tools.style.top = nearTop ? "0" : "auto";
    tools.style.left = Math.min(0, page.getBoundingClientRect().width * (1 - (view.x || 0)) - Math.max(260, tools.offsetWidth || 0)) + "px";
    block.querySelector(".lmb-text-sidebar-toggle").textContent = this.lmbIsTextBlockCollapsed(view) ? "侧栏展开" : "侧栏收起";
    block.classList.toggle("is-note-style", view.style === "note");
  },

  lmbCreateTextBlock(page, entry, view) {
    const block = page.createDiv({ cls: "lmb-pdf-text-block" }); block.dataset.exId = entry.exId;
    block._lmbTextEntry = entry;
    block._lmbTextView = view;
    block._lmbTextSourceKey = JSON.stringify([entry.pdfPath, entry.sourceMd || "", !!entry.quick]);
    block.tabIndex = 0;
    const owner = (this.app.workspace.getLeavesOfType('pdf') || []).find(l => l.containerEl.contains(page));
    this.lmbEnsureTextBlockInteractions(owner);
    const bar = block.createDiv({ cls: "lmb-pdf-text-tools" });
    const grip = bar.createEl("button", { text: "⠿", attr: { title: "拖动移动文本块", "aria-label": "移动文本块" } });
    const button = (text, action, cls) => {
      const b = bar.createEl("button", { text, cls: cls || "" });
      b.onclick = (ev) => { ev.stopPropagation(); Promise.resolve(action()).catch((err) => new Notice("操作失败：" + err.message)); }; return b;
    };
    const persist = async () => { await this.saveSettings(); this.lmbSchedulePdfSidebarRefresh(0); };
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
    const adjustSize = (delta) => {
      size.value = String(Math.max(8, Math.min(72, (Number(view.fontSize) || 16) + delta)));
      return size.onchange();
    };
    const smaller = button("A−", () => adjustSize(-1), "lmb-text-size-step");
    smaller.setAttribute("aria-label", "减小字号"); smaller.setAttribute("title", "减小字号");
    const larger = button("A+", () => adjustSize(1), "lmb-text-size-step");
    larger.setAttribute("aria-label", "增大字号"); larger.setAttribute("title", "增大字号");
    button("样式", () => { view.style = view.style === "note" ? "transparent" : "note"; this.lmbStyleTextBlock(block, page, view); return persist(); });
    button("侧栏收起", () => this.lmbSetTextBlockCollapsed(entry, entry.pdfPath, !this.lmbIsTextBlockCollapsed(view)), "lmb-text-sidebar-toggle");
    button("移除", async () => {
      if (block._lmbInlineEditor && !await block._lmbInlineEditor.save()) return;
      delete view.page; block.remove(); await persist(); await this.lmbRefreshTextBlocks();
    });
    const body = block.createDiv({ cls: "lmb-pdf-text-body markdown-rendered" });
    body.addEventListener("click", (ev) => {
      if (block._lmbInlineEditor || ev.ctrlKey || ev.metaKey) return;
      const selection = body.ownerDocument.defaultView && body.ownerDocument.defaultView.getSelection();
      if (selection && !selection.isCollapsed) return;
      ev.stopPropagation(); this.lmbActivateTextBlock(block, false, ev);
    }, true);
    body.ondblclick = (ev) => { if (ev.ctrlKey || ev.metaKey) return; ev.preventDefault(); ev.stopPropagation(); this.lmbActivateTextBlock(block, true, ev); };
    block.addEventListener('keydown', ev => { if (ev.target === block && (ev.key === 'Enter' || ev.key === 'F2')) { ev.preventDefault(); this.lmbActivateTextBlock(block, true); } });
    // Keep overlay interaction out of PDF selection/ink gestures while preserving text selection.
    ["pointerdown", "click", "dblclick"].forEach((type) => block.addEventListener(type, (ev) => ev.stopPropagation()));
    const resize = block.createDiv({ cls: "lmb-pdf-text-resize", attr: { title: "拖动调整宽度" } });
    const start = (ev, widthOnly) => {
      if (ev.button !== 0) return;
      ev.preventDefault(); ev.stopPropagation();
      if (owner) this.lmbSelectPdfSidebarEntry(owner, entry);
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
      for (const block of Array.from(this._lmbActiveInlineBlocks || [])) if (block._lmbInlineEditor) block._lmbInlineEditor.close(false);
      for (const block of Array.from(this._lmbActiveSidebarNoteBlocks || [])) if (block._lmbInlineEditor) block._lmbInlineEditor.close(false);
      if (this._lmbSidebarNoteDrafts) this._lmbSidebarNoteDrafts.clear();
      for (const observer of (this._lmbTextResizeObservers || new Map()).values()) observer.disconnect();
      if (this._lmbTextResizeObservers) this._lmbTextResizeObservers.clear();
      document.querySelectorAll(".lmb-pdf-text-block").forEach((el) => { if (el._lmbInlineEditor) el._lmbInlineEditor.close(false); el.remove(); });
    });
  },

  lmbReleaseTextBlockPage(page) {
    const observers = this._lmbTextResizeObservers;
    if (observers && observers.has(page)) { observers.get(page).disconnect(); observers.delete(page); }
  }
});
