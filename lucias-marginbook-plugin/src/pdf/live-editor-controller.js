/* One document flow: only the active Markdown block is an editor. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  lmbLivePointerOffset(container, source, event) {
    try {
      const doc = container.ownerDocument;
      const caret = doc.caretPositionFromPoint ? doc.caretPositionFromPoint(event.clientX, event.clientY) : null;
      const range = !caret && doc.caretRangeFromPoint ? doc.caretRangeFromPoint(event.clientX, event.clientY) : null;
      const node = caret ? caret.offsetNode : range && range.startContainer;
      const offset = caret ? caret.offset : range && range.startOffset;
      if (!node || node.nodeType !== 3 || !container.contains(node)) return 0;
      const before = doc.createRange(); before.selectNodeContents(container); before.setEnd(node, 0);
      return lmbLiveCaretOffset(source, node.textContent || "", offset || 0, before.toString().length);
    } catch (_) { return 0; }
  },

  lmbOpenInlineNoteEditor(block, opts) {
    if (block._lmbInlineEditor) { block._lmbInlineEditor.input.focus(); return block._lmbInlineEditor; }
    const doc = block.ownerDocument, body = opts.body || block.querySelector(".lmb-pdf-text-body");
    const panel = block.createDiv({ cls: "lmb-inline-note-editor" }); block.insertBefore(panel, body);
    const controls = panel.createDiv({ cls: "lmb-inline-note-controls" });
    controls.createSpan({ text: "实时编辑" });
    const status = controls.createSpan({ cls: "lmb-inline-note-status", text: "点击段落编辑" });
    const save = controls.createEl("button", { text: opts.autosave ? "完成" : "保存", attr: { type: "button" } });
    const cancel = controls.createEl("button", { text: "取消", attr: { type: "button" } });
    const input = body.createEl("textarea", { cls: "lmb-live-markdown-input", attr: { "aria-label": "当前段落 Markdown", placeholder: "输入 Markdown…", spellcheck: "false", rows: "1" } });
    const text = String(opts.value || "").replace(/\r\n/g, "\n");
    const state = { input, text, parts: lmbLiveMarkdownBlocks(text), active: 0, closed: false, busy: false, sequence: 0, cache: new Map(), history: [], redo: [], composing: false };
    // Obsidian handles PDF arrows in window capture, before textarea handlers.
    // A focused editor scope must claim them without preventing native caret /
    // selection behavior. Keep other shortcuts in the previously active scope.
    const keymap = this.app && this.app.keymap;
    let editorScope = null;
    const releaseScope = () => {
      if (editorScope) { keymap.popScope(editorScope); editorScope = null; }
    };
    input.addEventListener("focus", () => {
      if (state.closed || editorScope || !keymap || typeof Scope === "undefined") return;
      editorScope = new Scope(keymap.scope);
      for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"])
        editorScope.register(null, key, () => doc.activeElement === input && !state.closed ? true : undefined);
      keymap.pushScope(editorScope);
    });
    input.addEventListener("blur", releaseScope);
    state.lastSavedText = text;
    let autosaveTimer = null, pendingSave = null, finishing = null;
    const changed = (value) => {
      if (opts.onChange) opts.onChange(value);
      if (!opts.autosave) return;
      clearTimeout(autosaveTimer); status.setText("等待自动保存…");
      autosaveTimer = setTimeout(() => { state.persist(); }, opts.autosaveDelay || 800);
    };
    const partsAtCaret = (source, caret) => {
      const parts = lmbLiveMarkdownBlocks(source);
      // A newly typed blank paragraph can sit between existing blocks. Keep an
      // empty source range there instead of moving the caret into the next one.
      if (!parts.some(part => part.start <= caret && caret <= part.end)) {
        const index = parts.findIndex(part => part.start > caret);
        parts.splice(index < 0 ? parts.length : index, 0, { start: caret, end: caret, kind: "paragraph", source: "" });
      }
      return parts;
    };
    block._lmbInlineEditor = state; block.addClass("is-editing"); block.addClass("is-live-editing");
    const active = opts.sidebar ? (this._lmbActiveSidebarNoteBlocks || (this._lmbActiveSidebarNoteBlocks = new Set()))
      : (this._lmbActiveInlineBlocks || (this._lmbActiveInlineBlocks = new Set())); active.add(block);
    state.getText = () => {
      const part = state.parts[state.active];
      return state.text.slice(0, part.start) + input.value + state.text.slice(part.end);
    };
    const resize = () => {
      // Collapse the intrinsic height before measuring, including when deleting
      // wrapped text. Otherwise the default textarea rows become a height floor.
      input.style.height = "0px";
      const win = doc.defaultView;
      const line = win && win.getComputedStyle ? parseFloat(win.getComputedStyle(input).lineHeight) : 24;
      input.style.height = Math.max(line || 24, input.scrollHeight || 0) + "px";
      if (block.parentElement && block._lmbTextView) this.lmbStyleTextBlock(block, block.parentElement, block._lmbTextView);
    };
    state.rebuild = (index, caret = 0, focus = true) => {
      const sequence = ++state.sequence, scroll = body.scrollTop, previous = state.cache, cache = new Map(), jobs = [];
      const scrolls = [];
      for (let el = body; el; el = el.parentElement) scrolls.push([el, el.scrollTop, el.scrollLeft]);
      state.active = Math.max(0, Math.min(state.parts.length - 1, index));
      const wrappers = state.parts.map((part, i) => {
        const wrapper = doc.createElement("div"); wrapper.classList.add("lmb-live-markdown-block"); wrapper.dataset.kind = part.kind;
        const heading = /^(#{1,6})\s/.exec(part.source);
        if (heading) wrapper.style.setProperty("--lmb-live-heading-size", (opts.sidebar ? ["1.35em", "1.22em", "1.12em", "1em", "1em", "1em"] : ["1.7em", "1.4em", "1.2em", "1em", "1em", "1em"])[heading[1].length - 1]);
        if (i === state.active) {
          wrapper.classList.add("is-active"); wrapper.appendChild(input); input.value = part.source;
        } else {
          wrapper.tabIndex = 0; wrapper.setAttribute("aria-label", `编辑第 ${i + 1} 段`);
          const record = previous.get(i);
          if (record && record.source === part.source && record.node) { wrapper.appendChild(record.node); cache.set(i, record); }
          else {
            const content = doc.createElement("div");
            jobs.push((async () => {
              try { await MarkdownRenderer.render(this.app, part.source || "\u200b", content, opts.sourcePath || "", this); }
              catch (_) { content.textContent = part.source; }
              if (state.closed || sequence !== state.sequence) return;
              wrapper.replaceChildren(content); cache.set(i, { source: part.source, node: content });
            })());
          }
          wrapper.addEventListener("click", (event) => {
            if (event.ctrlKey || event.metaKey || state.busy || state.composing) return;
            event.preventDefault(); event.stopPropagation();
            state.activate(i, this.lmbLivePointerOffset(wrapper, part.source, event));
          }, true);
          wrapper.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); state.activate(i, 0); }
          });
        }
        return wrapper;
      });
      state.cache = cache; body.replaceChildren(...wrappers); body.scrollTop = scroll;
      const position = Math.max(0, Math.min(input.value.length, caret));
      // Size the textarea before focusing it: a default two-row field can make
      // the browser reveal its caret by scrolling the PDF viewport first.
      resize(); input.setSelectionRange(position, position);
      if (focus) input.focus({ preventScroll: true });
      for (const [el, top, left] of scrolls) { el.scrollTop = top; el.scrollLeft = left; }
      return Promise.all(jobs);
    };
    state.sync = (record = true) => {
      const old = state.parts[state.active], selection = input.selectionStart == null ? input.value.length : input.selectionStart;
      const nextText = state.getText(), caret = old.start + selection;
      if (nextText === state.text) { resize(); return Promise.resolve(); }
      if (record) { state.history.push({ text: state.text, caret: state.beforeCaret == null ? old.start : state.beforeCaret }); if (state.history.length > 100) state.history.shift(); state.redo.length = 0; }
      const parts = partsAtCaret(nextText, caret), index = lmbLiveBlockAt(parts, caret);
      const stable = index === state.active && parts.length === state.parts.length && parts.every((part, i) => i === index || part.source === state.parts[i].source);
      state.text = nextText; state.parts = parts;
      changed(nextText);
      if (stable) { if (input.parentElement) input.parentElement.dataset.kind = parts[index].kind; resize(); return Promise.resolve(); }
      return state.rebuild(index, caret - parts[index].start);
    };
    state.render = () => state.sync();
    state.activate = (index, caret = 0) => {
      if (state.closed || state.busy || state.composing) return Promise.resolve();
      state.sync();
      index = Math.max(0, Math.min(state.parts.length - 1, index));
      return state.rebuild(index, caret === "end" ? state.parts[index].source.length : caret);
    };
    state.restore = (snapshot) => {
      state.text = snapshot.text; state.parts = partsAtCaret(state.text, snapshot.caret);
      changed(state.text);
      const index = lmbLiveBlockAt(state.parts, snapshot.caret);
      return state.rebuild(index, snapshot.caret - state.parts[index].start);
    };
    state.undo = (redo = false) => {
      const from = redo ? state.redo : state.history, to = redo ? state.history : state.redo;
      if (!from.length || state.composing || state.busy) return;
      const caret = state.parts[state.active].start + (input.selectionStart || 0);
      to.push({ text: state.getText(), caret }); state.restore(from.pop());
    };
    state.close = (saved) => {
      if (state.closed) return;
      const result = state.getText(); state.closed = true; state.sequence++;
      releaseScope();
      clearTimeout(autosaveTimer);
      if (state.outsideClick) opts.pageRoot.removeEventListener("click", state.outsideClick, true);
      if (state.observer) state.observer.disconnect();
      panel.remove(); block.classList.remove("is-editing"); block.classList.remove("is-live-editing"); delete block._lmbInlineEditor; active.delete(block);
      body._lmbMarkdown = undefined;
      if (block.parentElement && block._lmbTextView) this.lmbStyleTextBlock(block, block.parentElement, block._lmbTextView);
      if (opts.onClose) opts.onClose(saved, result);
    };
    state.persist = () => {
      clearTimeout(autosaveTimer);
      if (state.closed || state.composing) return Promise.resolve(false);
      if (pendingSave) return pendingSave;
      pendingSave = (async () => {
        try {
          // A write can finish after another keystroke. Drain the newest text
          // serially before allowing the editor to close or switch notes.
          do {
            if (state.composing) return false;
            const snapshot = state.getText();
            if (opts.autosave && snapshot === state.lastSavedText) break;
            status.setText("保存中…");
            await opts.onSubmit(snapshot);
            state.lastSavedText = snapshot;
          } while (!state.closed && state.getText() !== state.lastSavedText);
          status.setText(opts.autosave ? "已自动保存" : "已保存");
          return true;
        } catch (err) {
          clearTimeout(autosaveTimer);
          status.setText("保存失败，草稿已保留"); new Notice("保存失败，草稿已保留：" + err.message);
          return false;
        }
      })().finally(() => { pendingSave = null; });
      return pendingSave;
    };
    state.save = () => {
      if (finishing) return finishing;
      if (state.closed) return Promise.resolve(false);
      if (state.composing) { if (opts.autosave) new Notice("请先确认输入法中的文字，草稿仍保留在当前备注"); return Promise.resolve(false); }
      state.busy = true; input.readOnly = true; save.disabled = cancel.disabled = true; status.setText("保存中…");
      finishing = (async () => {
        try { const ok = await state.persist(); if (ok) state.close(true); return ok; }
        finally { state.busy = false; input.readOnly = false; save.disabled = cancel.disabled = false; finishing = null; }
      })();
      return finishing;
    };
    state.cancel = () => { if (!state.busy && !pendingSave) state.close(false); };
    if (opts.autosave) { status.setText("自动保存已开启"); cancel.setAttribute("title", "放弃尚未保存的修改；已自动保存的内容会保留"); }
    save.onclick = (event) => { event.stopPropagation(); state.save(); }; cancel.onclick = (event) => { event.stopPropagation(); state.cancel(); };
    input.addEventListener("compositionstart", () => { state.composing = true; });
    input.addEventListener("compositionend", () => { state.composing = false; state.sync(); });
    input.addEventListener("beforeinput", (event) => {
      state.beforeCaret = state.parts[state.active].start + (input.selectionStart || 0);
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") { event.preventDefault(); state.undo(event.inputType === "historyRedo"); }
    });
    input.addEventListener("input", (event) => { if (event.isComposing || state.composing) resize(); else state.sync(); });
    input.addEventListener("keydown", (event) => {
      if (/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(event.key)) event.stopPropagation();
      if (event.isComposing || state.composing) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); state.save(); return; }
      if ((event.ctrlKey || event.metaKey) && /^(z|y)$/i.test(event.key)) { event.preventDefault(); event.stopPropagation(); state.undo(event.shiftKey || event.key.toLowerCase() === "y"); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); state.cancel(); return; }
      const start = input.selectionStart, end = input.selectionEnd;
      if (start !== end || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (start === 0 && /^(ArrowUp|ArrowLeft)$/.test(event.key) && state.active > 0) { event.preventDefault(); state.activate(state.active - 1, "end"); }
      else if (end === input.value.length && /^(ArrowDown|ArrowRight)$/.test(event.key) && state.active + 1 < state.parts.length) { event.preventDefault(); state.activate(state.active + 1, 0); }
      else if (event.key === "Backspace" && start === 0 && state.parts[state.active].start > 0 || event.key === "Delete" && end === input.value.length && state.parts[state.active].end < state.text.length) {
        event.preventDefault(); const at = state.parts[state.active].start + start, remove = event.key === "Backspace" ? at - 1 : at;
        state.history.push({ text: state.getText(), caret: at }); state.redo.length = 0;
        state.restore({ text: state.text.slice(0, remove) + state.text.slice(remove + 1), caret: remove });
      }
    });
    if (opts.pageRoot) {
      let outsideRequest = 0;
      state.outsideClick = async (event) => {
        const target = event.target;
        if (state.closed || block.contains(target) || event.ctrlKey || event.metaKey || event.button > 0) return;
        const page = target.closest && target.closest(".page[data-page-number]");
        if (!page || !opts.pageRoot.contains(page)) return;
        const next = target.closest(".lmb-pdf-text-block");
        // A different body saves the current editor and selects its target;
        // only the target's double-click handler requests a new editor.
        if (next && !target.closest(".lmb-pdf-text-body")) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (next && next._lmbTextEntry) { this.lmbActivateTextBlock(next, false, event); return; }
        const request = ++outsideRequest;
        if (!await state.save()) { input.focus({ preventScroll: true }); return; }
        if (request !== outsideRequest || this._unloaded) return;
      };
      opts.pageRoot.addEventListener("click", state.outsideClick, true);
    }
    const initialOffset = Math.max(0, Math.min(text.length, opts.cursorOffset || 0));
    state.rebuild(lmbLiveBlockAt(state.parts, initialOffset), initialOffset - state.parts[lmbLiveBlockAt(state.parts, initialOffset)].start);
    if (typeof ResizeObserver !== "undefined" && block.parentElement && block._lmbTextView) {
      state.observer = new ResizeObserver(() => { if (!state.closed && block.isConnected) resize(); }); state.observer.observe(block.parentElement);
    }
    return state;
  }
});
