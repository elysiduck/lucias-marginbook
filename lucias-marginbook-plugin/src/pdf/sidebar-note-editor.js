/* Sidebar and page share one paragraph editor and the existing note source. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  lmbNoteEditorKey(entry) {
    return JSON.stringify([entry.pdfPath || "", entry.exId || "", entry.sourceMd || "", !!entry.quick]);
  },

  async lmbOpenSidebarNoteEditor(entry, leaf, preferredRow, afterSave) {
    if (this.inkMode) await this.lmbSetInkMode(false);
    const bar = leaf && this.lmbEnsurePdfSidebarEl(leaf);
    if (!bar) return false;
    // Serialize rapid card clicks, including clicks while a disk write is pending.
    const previous = bar._lmbSidebarSwitch || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (!leaf.view.file || leaf.view.file.path !== entry.pdfPath) return false;
      bar._lmbSidebarSwitching = true;
      try {
        for (const block of Array.from(this._lmbActiveInlineBlocks || [])) {
          if (leaf.containerEl.contains(block) && block._lmbInlineEditor && !await block._lmbInlineEditor.save()) {
            block._lmbInlineEditor.input.focus({ preventScroll: true }); return false;
          }
        }
        const current = bar._lmbSidebarEditor;
        if (current && !current.closed && this.lmbNoteEditorKey(current._entry) !== this.lmbNoteEditorKey(entry)) {
          if (!await current.save()) {
            current.input.focus({ preventScroll: true });
            this.lmbSelectPdfSidebarEntry(leaf, current._entry);
            return false;
          }
        }
        await this.lmbMountSidebarNoteEditor(entry, leaf, preferredRow && preferredRow.isConnected ? preferredRow : null, afterSave);
        return !!bar._lmbSidebarEditor && bar._lmbSidebarEditingId === entry.exId;
      } finally { bar._lmbSidebarSwitching = false; }
    });
    bar._lmbSidebarSwitch = task;
    try { return await task; } finally { if (bar._lmbSidebarSwitch === task) delete bar._lmbSidebarSwitch; }
  },

  async lmbMountSidebarNoteEditor(entry, leaf, preferredRow, afterSave) {
    const file = leaf && leaf.view && leaf.view.file;
    if (!file || file.path !== entry.pdfPath) return;
    const bar = this.lmbEnsurePdfSidebarEl(leaf);
    if (!bar) return;
    const existing = this._lmbSidebarNoteDrafts && this._lmbSidebarNoteDrafts.get(this.lmbNoteEditorKey(entry));
    if (existing && !existing.closed) {
      const ownerLeaf = existing._leaf || leaf;
      if (ownerLeaf !== leaf && this.app.workspace.setActiveLeaf) this.app.workspace.setActiveLeaf(ownerLeaf, { focus: true });
      if (!existing.input.isConnected) await this.lmbRenderPdfSidebarForLeaf(ownerLeaf);
      existing.input.focus({ preventScroll: true }); return;
    }
    if (bar._lmbSidebarEditor && !bar._lmbSidebarEditor.closed) {
      bar._lmbSidebarEditor.input.focus({ preventScroll: true });
      if (bar._lmbSidebarEditingId !== entry.exId) new Notice("请先保存或取消正在编辑的备注");
      return;
    }
    if (bar._lmbSidebarOpening) return;
    const pageEditor = Array.from(leaf.containerEl.querySelectorAll(".lmb-pdf-text-block"))
      .find(block => block.dataset.exId === entry.exId && block._lmbInlineEditor);
    if (pageEditor) { pageEditor._lmbInlineEditor.input.focus({ preventScroll: true }); new Notice("该备注正在页内编辑，请先保存或取消"); return; }
    let row = preferredRow;
    if (!row) {
      await this.lmbRenderPdfSidebarForLeaf(leaf);
      row = Array.from(bar.querySelectorAll(".lmb-pdf-sidebar-item")).find(el => el.dataset.exId === entry.exId);
    }
    if (!row) { new Notice("找不到对应的侧栏条目，请刷新后重试"); return; }
    const token = {}; bar._lmbSidebarOpening = token; bar._lmbRenderToken = {};
    try {
      const value = await this.lmbTextBlockNote(entry);
      if (this._unloaded || bar._lmbSidebarOpening !== token || leaf.view.file !== file || !row.isConnected) return;
      this.lmbSetPdfSidebarVisible(leaf, true);
      this.lmbSelectPdfSidebarEntry(leaf, entry);
      row.classList.remove("is-compact"); row.classList.add("is-note-editing");
      const headerButtons = Array.from(row.querySelectorAll(".lmb-pdf-sidebar-header-actions button"));
      for (const button of headerButtons) button.disabled = true;
      let host = row.querySelector(".lmb-pdf-sidebar-item-note");
      if (!host) {
        host = row.createDiv({ cls: "lmb-pdf-sidebar-item-note" });
        row.insertBefore(host, row.querySelector(".lmb-pdf-sidebar-item-actions"));
      }
      host.classList.remove("is-collapsed"); host.classList.add("is-sidebar-editing");
      let body = host.querySelector(".lmb-pdf-sidebar-item-note-body");
      if (!body) body = host.createDiv({ cls: "lmb-pdf-sidebar-item-note-body markdown-rendered" });
      if (!host._lmbEditorEvents) {
        host._lmbEditorEvents = true;
        for (const type of ["pointerdown", "click", "dblclick", "keydown"]) host.addEventListener(type, event => { if (host._lmbInlineEditor) event.stopPropagation(); });
      }
      const drafts = this._lmbSidebarNoteDrafts || (this._lmbSidebarNoteDrafts = new Map());
      const key = this.lmbNoteEditorKey(entry);
      let timer = null;
      const state = this.lmbOpenInlineNoteEditor(host, { body, sidebar: true, autosave: true, value, sourcePath: entry.sourceMd || file.path,
        onChange: () => {
          clearTimeout(timer);
          timer = setTimeout(() => { if (!state.closed) this.lmbRefreshTextBlocks().catch(err => console.warn("[lmb] sidebar draft preview failed", err)); }, 80);
        },
        onSubmit: text => this.lmbSaveTextBlockNote(entry, text),
        onClose: (saved, text) => {
          clearTimeout(timer); drafts.delete(key);
          if (bar._lmbSidebarEditor === state) { delete bar._lmbSidebarEditor; delete bar._lmbSidebarEditingId; }
          row.classList.remove("is-note-editing"); host.classList.remove("is-sidebar-editing");
          for (const button of headerButtons) button.disabled = false;
          bar._lmbRenderSig = null;
          // Keep the existing row visible until the detached sidebar render is ready.
          const content = body.ownerDocument.createElement("div");
          Promise.resolve().then(() => MarkdownRenderer.render(this.app, saved ? text : state.lastSavedText, content, entry.sourceMd || file.path, this))
            .then(() => { if (!host._lmbInlineEditor && host.isConnected) body.replaceChildren(content); }).catch(() => {});
          if (this._unloaded) return;
          this.lmbRefreshTextBlocks().catch(err => console.warn("[lmb] sidebar preview restore failed", err));
          if (!bar._lmbSidebarSwitching) this.lmbRenderPdfSidebarForLeaf(leaf).catch(err => console.warn("[lmb] sidebar editor refresh failed", err));
          if (saved && afterSave) Promise.resolve(afterSave(text)).catch(err => new Notice(err.message));
        }
      });
      state._entry = entry; state._row = row; state._sidebarBar = bar; state._pdfPath = file.path; state._leaf = leaf;
      drafts.set(key, state); bar._lmbSidebarEditor = state; bar._lmbSidebarEditingId = entry.exId;
    } catch (err) { new Notice("无法打开备注：" + err.message); }
    finally {
      if (bar._lmbSidebarOpening === token) delete bar._lmbSidebarOpening;
      if (!this._unloaded && leaf.view.file !== file) this.lmbRenderPdfSidebarForLeaf(leaf).catch(() => {});
    }
  }
});
