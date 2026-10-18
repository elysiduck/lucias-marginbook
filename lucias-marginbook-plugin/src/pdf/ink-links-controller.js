/* Excerpts, sidebar and Canvas reference original, editable PDF ink by ID. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  lmbInkLinks(path) { return this.settings.inkExcerptLinks && this.settings.inkExcerptLinks[path] || {}; },

  lmbInitializeInkLinkNumbers() {
    let changed = false;
    const counters = this.settings.inkLinkCounters || (this.settings.inkLinkCounters = {});
    for (const [path, records] of Object.entries(this.settings.inkExcerptLinks || {})) {
      const links = Object.values(records || {}).filter(link => link && link.id);
      let next = Math.max(Number(counters[path]) || 1, ...links.map(link => (Number(link.number) || 0) + 1));
      const used = new Set();
      for (const link of links) {
        if (!Number.isSafeInteger(link.number) || link.number < 1 || used.has(link.number)) { link.number = next++; changed = true; }
        used.add(link.number);
      }
      if (counters[path] !== next) { counters[path] = next; changed = true; }
    }
    return changed;
  },

  lmbInkLinkLabel(path, exId) {
    const records = this.lmbInkLinks(path), link = records[exId];
    return link ? `手写 H${link.number || Object.keys(records).indexOf(exId) + 1}` : "";
  },

  lmbFindInkReference(ref) {
    for (const [path, entries] of Object.entries(this.settings.inkExcerptLinks || {}))
      for (const [exId, link] of Object.entries(entries || {})) if (link && link.id === ref) return { path, exId, link };
    return null;
  },

  lmbInkSelectionSnapshot() {
    const context = this._lmbInkSelectionContext;
    if (!context || !context.path || !this._lmbInkSelection || !this._lmbInkSelection.length) throw Error("请先用套索选择笔迹");
    const group = { page: Number(context.page), objectIds: Array.from(new Set(this._lmbInkSelection)) };
    if (!lmbInkGroupObjects(this.lmbInkStore()[context.path], group).length) throw Error("所选笔迹已不存在，请重新选择");
    return { path: context.path, ...group, pageAspect: context.canvas && context.canvas.clientHeight / context.canvas.clientWidth || 1.4 };
  },

  async lmbLinkInkSelection(snapshot, entry, title) {
    // Serialize only association edits. Roll back only our own record on error,
    // leaving concurrent Markdown edits and their existing save queue untouched.
    const previous = this._lmbInkLinkQueue || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (this._unloaded) throw Error("插件已卸载，请重新打开手写工具");
      const path = snapshot.path;
      if (!await this.lmbEnsureInkDocument(path)) throw Error("笔迹尚未加载，未创建关联");
      if (!lmbInkGroupObjects(this.lmbInkStore()[path], snapshot).length) throw Error("所选笔迹已被删除，未创建关联");
      if (entry && entry.pdfPath !== path) throw Error("请选择同一 PDF 的摘录");
      // Durable strokes must exist before saving references to them.
      await this.lmbFlushInkStorage();
      if (this._unloaded) throw Error("插件已卸载，未创建关联");
      if (!lmbInkGroupObjects(this.lmbInkStore()[path], snapshot).length) throw Error("所选笔迹已被删除，未创建关联");
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) throw Error("PDF 已移动或不存在，请重新选择");
      if (entry && !this._lmbGetPdfSidebarEntries(file).some(e => e.exId === entry.exId)) throw Error("摘录已删除，请重新选择");
      const exId = entry ? entry.exId : "ink-note-" + this.lmbInkId().slice(4);
      const links = this.settings.inkExcerptLinks || (this.settings.inkExcerptLinks = {});
      const records = links[path] || (links[path] = {}), before = records[exId];
      this.lmbInitializeInkLinkNumbers();
      const record = lmbInkClone(before || { id: "inkref-" + this.lmbInkId().slice(4), groups: [] });
      if (!record.number) {
        const counters = this.settings.inkLinkCounters;
        record.number = counters[path] || 1; counters[path] = record.number + 1;
      }
      const ids = Array.from(new Set(snapshot.objectIds)).sort();
      const selectedIds = lmbInkGroupObjects(this.lmbInkStore()[path], snapshot).map(o => o.id);
      if (!record.groups.some(g => {
        if (g.page !== Number(snapshot.page)) return false;
        const covered = new Set(lmbInkGroupObjects(this.lmbInkStore()[path], g).map(o => o.id));
        return selectedIds.every(id => covered.has(id));
      }))
        record.groups.push({ id: this.lmbInkId(), page: Number(snapshot.page), objectIds: ids, pageAspect: Math.max(.2, Math.min(5, Number(snapshot.pageAspect) || 1.4)) });
      let created;
      if (!entry) {
        created = { exId, inkNote: true, page: Number(snapshot.page), text: String(title || "手写备注").trim().slice(0, 160) || "手写备注", note: "" };
        const quick = this.settings.quickExcerpts || (this.settings.quickExcerpts = {});
        (quick[path] || (quick[path] = [])).push(created);
      }
      records[exId] = record;
      try { await this.saveSettings(); }
      catch (error) {
        if (before) records[exId] = before; else delete records[exId];
        if (created) { const list = this.settings.quickExcerpts[path]; const index = list.indexOf(created); if (index >= 0) list.splice(index, 1); }
        throw error;
      }
      this.lmbSchedulePdfSidebarRefresh(0); this.lmbScheduleInkReferenceRefresh();
      if (typeof document !== "undefined") setTimeout(() => {
        // The host suggester may still be closing and moving focused elements.
        // A presentation failure must never report a durable association as lost.
        if (!this._unloaded) try { this.lmbRenderInkTools(); } catch (error) { console.warn("[lmb] ink toolbar refresh", error); }
      }, 0);
      return { path, exId, link: record, entry: created || entry };
    });
    this._lmbInkLinkQueue = task;
    try { return await task; } finally { if (this._lmbInkLinkQueue === task) this._lmbInkLinkQueue = null; }
  },

  lmbChooseInkExcerpt() {
    try {
      const snapshot = this.lmbInkSelectionSnapshot(), file = this.app.vault.getAbstractFileByPath(snapshot.path);
      const items = this._lmbGetPdfSidebarEntries(file).filter(e => e.exId).map(entry => ({ entry,
        label: `P.${entry.page || "?"} · ${String(entry.text || entry.note || "未命名备注").replace(/\s+/g, " ").slice(0, 120)}` }));
      if (!items.length) { new Notice("此 PDF 尚无摘录，可先新建手写备注"); return; }
      new LMBNodeSuggester(this.app, items, item => {
        this.lmbLinkInkSelection(snapshot, { ...item.entry, pdfPath: snapshot.path }).then(() => new Notice("已关联摘录，原笔迹仍可编辑"))
          .catch(error => new Notice("关联失败，笔迹和选择已保留：" + error.message, 5000));
      }).open();
    } catch (error) { new Notice(error.message); }
  },

  lmbCreateInkNoteFromSelection() {
    try {
      const snapshot = this.lmbInkSelectionSnapshot();
      new LMBInkNoteTitleModal(this.app, `手写备注 · P.${snapshot.page}`, async title => {
        await this.lmbLinkInkSelection(snapshot, null, title); new Notice("已创建手写备注，可在侧栏查看或放入 Canvas");
      }).open();
    } catch (error) { new Notice(error.message); }
  },

  async lmbSaveEditorsBeforeInkNavigation() {
    const states = new Set();
    for (const block of [...(this._lmbActiveInlineBlocks || []), ...(this._lmbActiveSidebarNoteBlocks || [])]) if (block._lmbInlineEditor) states.add(block._lmbInlineEditor);
    for (const state of states) if (!await state.save()) return false;
    return true;
  },

  lmbEndInkContinuation(render = true) {
    if (!this._lmbInkContinuation) return;
    this._lmbInkContinuation = null;
    if (render && typeof document !== "undefined") this.lmbRenderInkTools();
  },

  lmbAssignInkContinuation(object, path, page) {
    const session = this._lmbInkContinuation;
    if (!session) return false;
    const link = this.lmbInkLinks(path)[session.exId];
    const group = link && link.id === session.ref && (link.groups || []).find(g => g.id === session.groupId);
    if (session.path !== path || Number(session.page) !== Number(page) || !group || Number(group.page) !== Number(page)) {
      this.lmbEndInkContinuation(); return false;
    }
    // Membership travels in the SAME durable ink record as the new stroke.
    // No asynchronous data.json write per pen-up and no chance of a saved stroke
    // becoming detached because its later association write failed.
    object.inkGroupIds = Array.from(new Set([...(object.inkGroupIds || []), group.id]));
    return true;
  },

  async lmbLocateInkReference(ref, options = {}) {
    if (this._unloaded) return false;
    const token = this._lmbInkLocateToken = {};
    if (!await this.lmbSaveEditorsBeforeInkNavigation() || token !== this._lmbInkLocateToken) return false;
    const found = this.lmbFindInkReference(ref);
    if (!found) { new Notice("手写关联不存在，原卡片已保留"); return false; }
    const request = this._lmbBeginNavigation();
    try {
      if (!await this.lmbEnsureInkDocument(found.path) || !this._lmbNavigationCurrent(request)) return false;
      const groups = found.link.groups || [], group = groups.find(g => g.id === options.groupId)
        || groups.find(g => lmbInkGroupObjects(this.lmbInkStore()[found.path], g).length) || groups[0];
      const objects = lmbInkGroupObjects(this.lmbInkStore()[found.path], group), bounds = lmbInkGroupBounds(objects);
      if (!bounds && !(options.continue && group && group.id && group.page)) { new Notice("这组笔迹已被擦除；备注和卡片仍保留，可撤销擦除后再定位"); return false; }
      const file = this.app.vault.getAbstractFileByPath(found.path);
      if (!file) { new Notice("找不到关联的 PDF，未修改备注"); return false; }
      const existing = (this.app.workspace.getLeavesOfType("pdf") || []).find(l => l.view && l.view.file && l.view.file.path === found.path);
      const leaf = await this._lmbActivateNavigationLeaf(request, existing, file);
      if (!leaf) return false;
      const view = leaf.view;
      const pageEl = await this.lmbWaitPageEl(view.containerEl || leaf.containerEl, group.page, 6000);
      const current = () => this._lmbNavigationCurrent(request) && token === this._lmbInkLocateToken && leaf.view === view && view.file?.path === found.path && pageEl && pageEl.isConnected !== false;
      if (!current()) return false;
      pageEl.scrollIntoView({ block: "center" }); pageEl._lmbInkNearViewport = true;
      if (options.edit || options.continue) {
        if (await this.lmbSetInkMode(true) === false || !current()) return false;
        this.lmbSetInkTool(options.continue ? "pen" : "select");
      }
      this.lmbEnsureInkLayer(pageEl, found.path, Number(group.page) - 1);
      this.lmbSelectPdfSidebarEntry(leaf, { exId: found.exId, page: group.page });
      const canvas = pageEl.querySelector(":scope > .lmb-ink-layer");
      this.lmbEndInkContinuation(false);
      if (options.continue && canvas) {
        this._lmbInkContinuation = { path: found.path, page: Number(group.page), exId: found.exId, ref, groupId: group.id };
        this._lmbInkSelection = []; this._lmbInkSelectionContext = null;
        this.lmbRenderInkTools(); this.lmbRedrawInkPage(canvas);
      } else if (options.edit && canvas) {
        this._lmbInkSelection = objects.map(o => o.id); this._lmbInkSelectionContext = { canvas, path: found.path, page: group.page };
        this.lmbRenderInkTools(); this.lmbRedrawInkPage(canvas);
      }
      this.lmbUpdateInkLocation(canvas);
      const marker = pageEl.querySelector(":scope > .lmb-ink-location");
      if (marker) marker.scrollIntoView({ block: "center", inline: "nearest" });
      return true;
    } catch (error) { new Notice("定位手写备注失败：" + error.message); return false; }
    finally { this._lmbEndNavigation(request); }
  },

  lmbFocusLinkedInk(leaf, exId) {
    const path = leaf.view && leaf.view.file && leaf.view.file.path;
    if (this._lmbInkContinuation && (this._lmbInkContinuation.path !== path || this._lmbInkContinuation.exId !== exId)) this.lmbEndInkContinuation();
    const before = this._lmbInkLinkedFocus;
    if (before && before.path === path && before.exId === exId) return;
    this._lmbInkLinkedFocus = { path, exId };
    const leaves = new Set([leaf, ...(this.app.workspace.getLeavesOfType("pdf") || [])]);
    for (const pdfLeaf of leaves) for (const canvas of pdfLeaf.containerEl.querySelectorAll(".lmb-ink-layer")) this.lmbRedrawInkPage(canvas);
  },

  lmbInkFocusIds(path, page) {
    const focus = this._lmbInkLinkedFocus;
    if (!focus || focus.path !== path) return [];
    const link = this.lmbInkLinks(path)[focus.exId];
    return link ? (link.groups || []).filter(g => Number(g.page) === Number(page)).flatMap(g => lmbInkGroupObjects(this.lmbInkStore()[path], g).map(o => o.id)) : [];
  },

  lmbUpdateInkLocation(canvas) {
    if (!canvas || !canvas.parentElement) return;
    const pageEl = canvas.parentElement, path = canvas.dataset.lmbInkPath, page = Number(canvas.dataset.lmbInkPage);
    const focus = this._lmbInkLinkedFocus, link = focus && focus.path === path && this.lmbInkLinks(path)[focus.exId];
    const objects = link ? (link.groups || []).filter(g => Number(g.page) === page).flatMap(g => lmbInkGroupObjects(this.lmbInkStore()[path], g)) : [];
    const bounds = lmbInkGroupBounds(objects);
    let marker = pageEl.querySelector(":scope > .lmb-ink-location");
    if (!bounds) { if (marker) marker.remove(); return; }
    if (!marker) { marker = pageEl.ownerDocument.createElement("div"); marker.className = "lmb-ink-location"; pageEl.appendChild(marker); }
    marker.textContent = this.lmbInkLinkLabel(path, focus.exId);
    marker.dataset.lmbInkLabel = marker.textContent;
    Object.assign(marker.style, { left: bounds.x * 100 + "%", top: bounds.y * 100 + "%", width: bounds.w * 100 + "%", height: bounds.h * 100 + "%" });
  },

  async lmbRenderInkReference(host, ref, groupId) {
    if (this._unloaded) return;
    const renderToken = host._lmbInkRefToken = {};
    host.dataset.lmbInkRef = ref; if (groupId) host.dataset.lmbInkGroup = groupId;
    const found = this.lmbFindInkReference(ref);
    if (!found) { host.textContent = "手写关联不可用（原卡片保留）"; return; }
    const ready = await this.lmbEnsureInkDocument(found.path);
    if (host._lmbInkRefToken !== renderToken || this._unloaded) return;
    if (!ready) { host.textContent = "笔迹加载失败，备注与原卡片已保留"; return; }
    const groups = (found.link.groups || []).filter(g => !groupId || g.id === groupId);
    const items = groups.map(g => ({ group: g, objects: lmbInkGroupObjects(this.lmbInkStore()[found.path], g) }));
    host.replaceChildren(); host.classList.add("lmb-ink-reference");
    const title = host.ownerDocument.createElement("div"); title.className = "lmb-ink-ref-caption";
    title.textContent = this.lmbInkLinkLabel(found.path, found.exId) + " · " + items.map(i => `P.${i.group.page} · ${i.objects.length} 笔`).join(" / "); host.appendChild(title);
    const actions = host.ownerDocument.createElement("div"); actions.className = "lmb-ink-ref-actions";
    const edit = host.ownerDocument.createElement("button"); edit.type = "button"; edit.textContent = "继续手写"; edit.className = "lmb-ink-ref-edit";
    edit.title = "回到 PDF 补画，新笔迹自动加入这条手写备注";
    edit._lmbInkAction = () => this.lmbLocateInkReference(ref, { groupId, continue: true });
    edit.onclick = event => { event.stopPropagation(); edit._lmbInkAction(); }; actions.appendChild(edit); host.appendChild(actions);
    // Canvas consumes pointerdown to select/drag a card. Explicit controls must
    // receive the first tap; the preview remains draggable as before.
    actions.addEventListener("pointerdown", event => event.stopPropagation());
    actions.addEventListener("mousedown", event => event.stopPropagation());
    actions.addEventListener("touchstart", event => event.stopPropagation(), { passive: true });
    for (const item of items) {
      const bounds = lmbInkGroupBounds(item.objects);
      if (!bounds) { const empty = host.ownerDocument.createElement("div"); empty.textContent = "笔迹已擦除，备注保留"; host.appendChild(empty); continue; }
      const height = 1000 * (Number(item.group.pageAspect) || 1.4);
      const ns = "http://www.w3.org/2000/svg", svg = host.ownerDocument.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", `${bounds.x * 1000 - 10} ${bounds.y * height - 10} ${bounds.w * 1000 + 20} ${bounds.h * height + 20}`);
      svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `P.${item.group.page} 手写笔迹预览`);
      const add = (tag, attrs, text) => { const el = host.ownerDocument.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value)); if (text != null) el.textContent = text; svg.appendChild(el); };
      for (const o of item.objects) {
        const style = { fill: "none", stroke: o.color || "#e05252", "stroke-width": o.widthUnit === "page" ? Math.max(.5, (Number(o.width) || .003) * 1000) : Number(o.width) || 3, opacity: o.opacity == null ? 1 : o.opacity, "stroke-linecap": "round", "stroke-linejoin": "round" };
        if (o.type === "pen" || o.type === "highlighter") {
          const points = o.points || [];
          if (points.length === 1) add("circle", { cx: points[0].x * 1000, cy: points[0].y * height, r: Number(style["stroke-width"]) / 2, fill: style.stroke, opacity: style.opacity });
          else if (points.length) add("path", { ...style, d: points.map((p, i) => `${i ? "L" : "M"}${p.x * 1000},${p.y * height}`).join(" ") });
        } else if (o.type === "line") add("line", { ...style, x1: o.x1 * 1000, y1: o.y1 * height, x2: o.x2 * 1000, y2: o.y2 * height });
        else if (o.type === "rect") add("rect", { ...style, x: Math.min(o.x1, o.x2) * 1000, y: Math.min(o.y1, o.y2) * height, width: Math.abs(o.x2 - o.x1) * 1000, height: Math.abs(o.y2 - o.y1) * height });
        else if (o.type === "text") add("text", { x: o.x * 1000, y: o.y * height + 16, fill: o.color || "#222", "font-size": o.fontUnit === "page" ? o.fontSize * 1000 : o.fontSize || 16 }, o.text);
      }
      const button = host.ownerDocument.createElement("button"); button.type = "button"; button.className = "lmb-ink-ref-preview"; button.title = `定位 P.${item.group.page} 的原笔迹`;
      let pointerStart = null, dragged = false;
      button.addEventListener("pointerdown", event => { pointerStart = { x: event.clientX, y: event.clientY }; dragged = false; });
      button.addEventListener("pointermove", event => { if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6) dragged = true; });
      button.addEventListener("pointercancel", () => { dragged = true; pointerStart = null; });
      button.appendChild(svg); button.addEventListener("click", event => { event.stopPropagation(); const moved = dragged || event.detail > 0 && pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6; if (!moved && !event.ctrlKey && !event.metaKey && event.button === 0) this.lmbLocateInkReference(ref, { groupId: item.group.id }); }); host.appendChild(button);
    }
    this.lmbWatchInkCardSize(host);
  },

  lmbWatchInkCardSize(host) {
    if (!host.closest || !host.closest(".canvas-node")) return;
    if (typeof ResizeObserver !== "undefined" && !host._lmbInkSizeObserver) {
      const observer = new ResizeObserver(() => this.lmbScheduleInkCardFit(host));
      observer.observe(host); observer.observe(host.closest(".canvas-node")); host._lmbInkSizeObserver = observer;
      (this._lmbInkCardObservers || (this._lmbInkCardObservers = new Set())).add(host);
    }
    this.lmbScheduleInkCardFit(host);
  },

  lmbScheduleInkCardFit(host) {
    clearTimeout(host._lmbInkFitTimer);
    host._lmbInkFitTimer = setTimeout(() => {
      if (this._unloaded || !host.isConnected) return;
      this.lmbFitInkReferenceCards(host).catch(error => console.warn("[lmb] ink card fit", error));
    }, 180);
  },

  async lmbFitInkReferenceCards(host) {
    if (this._unloaded || host.isConnected === false) return;
    // Synchronous live snapshot + height-only merge: never move neighbours,
    // rewrite Markdown, or restore disk positions over an unsaved Canvas drag.
    for (const leaf of this.app.workspace.getLeavesOfType("canvas") || []) {
      if (!leaf.containerEl || !leaf.containerEl.contains(host)) continue;
      const file = leaf.view.file, canvas = leaf.view.canvas;
      if (!file || !canvas || !canvas.nodes || typeof canvas.getData !== "function") continue;
      const live = Array.from(typeof canvas.nodes.values === "function" ? canvas.nodes.values() : Object.values(canvas.nodes));
      const instance = live.find(node => (node.nodeEl || node.contentEl)?.contains(host));
      const data = canvas.getData(), node = instance && data.nodes.find(n => n.id === instance.id);
      if (!node || lmbInkCanvasReference(node.text) !== host.dataset.lmbInkRef) continue;
      const wrapper = instance.nodeEl || instance.contentEl;
      if (wrapper.querySelector("textarea, .cm-editor, [contenteditable=true]")) continue;
      const content = wrapper.querySelector(".canvas-node-content") || wrapper;
      const height = this.lmbMeasureInkCardHeight(wrapper, content);
      if (!(height > 0) || Math.abs(height - node.height) < 3) continue;
      const next = this._lmbCloneCanvasForHeight(data, node.id, height);
      if (next && !await this._lmbWriteCanvasData(file, next.data, canvas)) new Notice("手写卡片高度保存失败，原内容仍保留");
    }
  },

  lmbMeasureInkCardHeight(wrapper, content) { return lmbMeasureNaturalCard(wrapper, content, 1); },

  lmbScheduleInkReferenceRefresh() {
    if (typeof document === "undefined") return;
    clearTimeout(this._lmbInkRefRefreshTimer);
    this._lmbInkRefRefreshTimer = setTimeout(() => {
      for (const host of this._lmbInkCardObservers || []) if (!host.isConnected) {
        host._lmbInkSizeObserver.disconnect(); clearTimeout(host._lmbInkFitTimer); this._lmbInkCardObservers.delete(host);
      }
      document.querySelectorAll("[data-lmb-ink-ref]").forEach(host => this.lmbRenderInkReference(host, host.dataset.lmbInkRef, host.dataset.lmbInkGroup).catch(error => console.warn("[lmb] ink preview", error)));
    }, 80);
  },

  async lmbPutInkReferenceInCanvas(path, exId) {
    const queueKey = path + "\n" + exId;
    const pending = this._lmbInkCanvasQueue || (this._lmbInkCanvasQueue = new Map());
    if (pending.has(queueKey)) return pending.get(queueKey);
    const navigation = this._lmbBeginNavigation();
    const previousWrite = this._lmbInkCanvasWriteQueue || Promise.resolve();
    const task = previousWrite.catch(() => {}).then(async () => {
      if (this._unloaded) throw Error("插件已卸载，未修改画布");
      const link = this.lmbInkLinks(path)[exId]; if (!link) throw Error("此摘录没有手写关联");
      const pdf = this.app.vault.getAbstractFileByPath(path); if (!pdf) throw Error("找不到 PDF");
      const target = this.lmbStoragePaths(pdf).canvas;
      let file = this.app.vault.getAbstractFileByPath(target);
      if (!file) { await this.lmbEnsureStorageParent(target); file = await this.app.vault.create(target, JSON.stringify({ nodes: [], edges: [] })); }
      const rd = await this._lmbReadCanvasData(file); if (!rd || !Array.isArray(rd.data.nodes)) throw Error("画布无法读取，未覆盖原文件");
      if (this._unloaded) throw Error("插件已卸载，未修改画布内容");
      const data = lmbInkClone(rd.data);
      let node = data.nodes.find(n => lmbInkCanvasReference(n.text) === link.id);
      if (!node) {
        const entry = this._lmbGetPdfSidebarEntries(pdf).find(e => e.exId === exId), group = link.groups[0];
        const caption = String(entry && entry.text || "手写备注").replace(/[\r\n\[\]|]/g, " ").slice(0, 120);
        const text = `[[${path}#page=${group.page}&ink=${encodeURIComponent(link.id)}|${caption}]]\n\n\`\`\`marginbook-ink\n${JSON.stringify({ ref: link.id })}\n\`\`\``;
        const x = data.nodes.length ? Math.max(...data.nodes.map(n => (Number(n.x) || 0) + (Number(n.width) || 0))) + 60 : 0;
        node = { id: this.lmbInkId(), type: "text", text, x, y: 0, width: 420, height: Math.min(1600, 260 + link.groups.length * 150) }; data.nodes.push(node);
        if (!await this._lmbWriteCanvasData(file, data, rd.memCanvas, rd.raw)) throw Error("画布保存失败，关联和原笔迹已保留");
      }
      if (this.lmbFocusCanvasNode && this._lmbNavigationCurrent(navigation)) await this.lmbFocusCanvasNode(file, node.id, navigation);
      return { file, nodeId: node.id };
    });
    this._lmbInkCanvasWriteQueue = task.catch(() => {});
    pending.set(queueKey, task); try { return await task; } finally { pending.delete(queueKey); this._lmbEndNavigation(navigation); }
  },

  lmbSetupInkReferences() {
    if (this.app.workspace.on && this.registerEvent) this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      if (this._lmbInkContinuation && leaf?.view?.file?.path !== this._lmbInkContinuation.path) this.lmbEndInkContinuation();
    }));
    // Native Canvas selects a previously inactive node in its capture handler,
    // swallowing the first click before a button's handler can run. Reserve
    // only explicit controls; leave preview/card drags to the Canvas host.
    if (this.registerDomEvent) {
      const control = event => {
        const direct = event.target?.closest?.(".canvas-node .lmb-ink-ref-actions button");
        if (direct) return direct;
        // Unselected native Canvas cards have a transparent interaction cover.
        // Hit-test only this card's visible explicit buttons beneath that cover.
        const node = event.target?.closest?.(".canvas-node");
        return node && Array.from(node.querySelectorAll(".lmb-ink-ref-actions button")).find(button => {
          const r = button.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
        });
      };
      this.registerDomEvent(document, "pointerdown", event => {
        const button = control(event);
        if (!button || event.button !== 0 || event.isPrimary === false) return;
        this._lmbInkActionPress = { button, id: event.pointerId, x: event.clientX, y: event.clientY };
        event.stopImmediatePropagation(); event.preventDefault();
      }, true);
      this.registerDomEvent(document, "pointermove", event => {
        const press = this._lmbInkActionPress;
        if (!press || press.id !== event.pointerId) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) press.cancelled = true;
        event.stopImmediatePropagation(); event.preventDefault();
      }, true);
      this.registerDomEvent(document, "pointerup", event => {
        const press = this._lmbInkActionPress;
        if (!press || press.id !== event.pointerId) return;
        this._lmbInkActionPress = null;
        event.stopImmediatePropagation(); event.preventDefault();
        this._lmbInkActionClick = { button: press.button, until: Date.now() + 800 };
        if (!press.cancelled && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 8 && press.button.isConnected) press.button._lmbInkAction?.();
      }, true);
      this.registerDomEvent(document, "pointercancel", () => { this._lmbInkActionPress = null; }, true);
      this.registerDomEvent(document, "click", event => {
        const suppress = this._lmbInkActionClick;
        if (event.isTrusted && suppress && suppress.until > Date.now() && control(event) === suppress.button) { event.stopImmediatePropagation(); event.preventDefault(); }
      }, true);
    }
    if (this.registerMarkdownCodeBlockProcessor) this.registerMarkdownCodeBlockProcessor("marginbook-ink", async (source, host) => {
      try { const data = JSON.parse(source); if (!data || !/^inkref-[a-z0-9-]+$/.test(data.ref)) throw Error("关联标识无效"); await this.lmbRenderInkReference(host, data.ref); }
      catch (error) { host.textContent = "手写预览不可用：" + error.message; }
    });
    // Canvas DOM can outlive a plugin reload; replace old preview callbacks.
    this.lmbScheduleInkReferenceRefresh();
    this.register(() => { clearTimeout(this._lmbInkRefRefreshTimer); document.querySelectorAll(".lmb-ink-location").forEach(el => el.remove());
      for (const host of this._lmbInkCardObservers || []) { host._lmbInkSizeObserver.disconnect(); delete host._lmbInkSizeObserver; clearTimeout(host._lmbInkFitTimer); }
      this._lmbInkCardObservers?.clear();
      this._lmbInkActionPress = this._lmbInkActionClick = null;
      this._lmbInkContinuation = null;
    });
  }
});

class LMBInkNoteTitleModal extends Modal {
  constructor(app, title, submit) { super(app); this.title = title; this.submitNote = submit; }
  onOpen() {
    this.contentEl.createEl("h3", { text: "新建手写备注" });
    const input = this.contentEl.createEl("input", { attr: { type: "text", "aria-label": "手写备注标题", maxlength: "160" } }); input.value = this.title; input.style.width = "100%";
    this.contentEl.createEl("p", { text: "保留原始笔迹；创建后可在侧栏补充 Markdown，或放入 Canvas。" });
    const status = this.contentEl.createDiv({ cls: "lmb-ink-create-status" });
    const save = this.contentEl.createEl("button", { text: "创建" });
    save.onclick = async () => { if (save.disabled) return; save.disabled = true; try { await this.submitNote(input.value); this.close(); } catch (error) { status.textContent = "创建失败，标题与笔迹已保留：" + error.message; save.disabled = false; } };
    input.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) save.click(); };
    input.focus(); input.select();
  }
  onClose() { this.contentEl.empty(); }
}
