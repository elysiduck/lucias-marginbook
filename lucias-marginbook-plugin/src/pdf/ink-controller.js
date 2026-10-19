/* PDF ink controller: pen-first input, cached rendering, history and sidecar persistence. */
const LMB_INK_TOOLS = ["hand", "select", "pen", "highlighter", "eraser", "text", "line", "rect"];

LuciasMarginBookPlugin.prototype.lmbInkStore = function () {
  if (!this._lmbInkDocs || typeof this._lmbInkDocs !== "object") {
    this._lmbInkDocs = this.settings.inkAnnotations && typeof this.settings.inkAnnotations === "object"
      ? this.settings.inkAnnotations : {};
  }
  return this._lmbInkDocs;
};

LuciasMarginBookPlugin.prototype.lmbInkStorageDir = function () {
  const id = this.manifest && this.manifest.id || "lucias-marginbook";
  return normalizePath(`.obsidian/plugins/${id}/ink-data`);
};

LuciasMarginBookPlugin.prototype.lmbInitializeInkStorage = async function () {
  const migrationWasComplete = this.settings.inkSidecarV2Migrated === true;
  const legacy = this.settings.inkAnnotations && typeof this.settings.inkAnnotations === "object"
    ? this.settings.inkAnnotations : {};
  this._lmbInkDocs = {};
  this._lmbInkDirtyPaths = new Set();
  this._lmbInkDirtyRevisions = new Map();
  this._lmbInkLoadedPaths = new Set();
  this._lmbInkLoadPromises = new Map();
  this._lmbInkLoadErrors = new Set();
  this._lmbInkRetryCount = 0;
  this._lmbInkLastBackup = new Map();
  this._lmbInkSaveState = "saved";
  try {
    const adapter = this.app.vault.adapter, dir = this.lmbInkStorageDir();
    if (!adapter || typeof adapter.read !== "function" || typeof adapter.write !== "function") throw new Error("adapter unavailable");
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    const legacyPaths = Object.keys(legacy);
    for (const path of legacyPaths) {
      const sidecar = await this.lmbReadInkSidecar(path, adapter, dir);
      this._lmbInkDocs[path] = lmbInkMergePages(sidecar && sidecar.pages, legacy[path]);
      this._lmbInkLoadedPaths.add(path);
      this._lmbInkDirtyPaths.add(path);
      this._lmbInkDirtyRevisions.set(path, 1);
    }
    this._lmbInkSidecarReady = true;
    if (legacyPaths.length) {
      await this.lmbFlushInkStorage();
      this.settings.inkAnnotations = {};
      this.settings.inkSidecarV2Migrated = true;
      return true;
    }
    this.settings.inkSidecarV2Migrated = true;
    return !migrationWasComplete;
  } catch (error) {
    console.warn("[lmb] ink sidecar unavailable; retaining data.json fallback", error);
    this._lmbInkDocs = legacy;
    this._lmbInkSidecarReady = false;
    this._lmbInkSaveState = "error";
    return false;
  }
};

LuciasMarginBookPlugin.prototype.lmbReadInkSidecar = async function (path, adapter, dir) {
  const target = normalizePath(`${dir || this.lmbInkStorageDir()}/${lmbInkFileKey(path)}`);
  let sawExisting = false, best = null;
  for (const candidate of [target, target + ".tmp", target + ".bak"]) {
    try {
      if (!(await adapter.exists(candidate))) continue;
      sawExisting = true;
      const doc = JSON.parse(await adapter.read(candidate));
      if (doc && doc.version === LMB_INK_SCHEMA_VERSION && doc.pdfPath === path && doc.pages && typeof doc.pages === "object") {
        const rank = Math.max(Number(doc.revision) || 0, Number(doc.savedAt) || 0);
        if (!best || rank > best.rank) best = { doc, rank };
        continue;
      }
      console.warn("[lmb] incompatible ink sidecar", candidate);
    } catch (error) { console.warn("[lmb] failed to read ink sidecar", candidate, error); }
  }
  if (best) return best.doc;
  if (sawExisting) throw new Error(`No valid ink sidecar copy for ${path}`);
  return null;
};

LuciasMarginBookPlugin.prototype.lmbEnsureInkDocument = function (path) {
  if (!path || !this._lmbInkSidecarReady || this._lmbInkLoadedPaths && this._lmbInkLoadedPaths.has(path)) return Promise.resolve(true);
  if (this._lmbInkLoadErrors && this._lmbInkLoadErrors.has(path)) return Promise.resolve(false);
  if (this._lmbInkLoadPromises.has(path)) return this._lmbInkLoadPromises.get(path);
  const promise = (async () => {
    try {
      const doc = await this.lmbReadInkSidecar(path, this.app.vault.adapter, this.lmbInkStorageDir());
      this._lmbInkDocs[path] = doc ? doc.pages : {};
      this._lmbInkLoadedPaths.add(path);
      document.querySelectorAll(".lmb-ink-layer").forEach((canvas) => {
        if (canvas.dataset.lmbInkPath === path) canvas.dataset.lmbInkDrawn = "0";
      });
      this.lmbScheduleInkRefresh(0);
      return true;
    } catch (error) {
      console.warn("[lmb] lazy ink load failed", path, error);
      if (this._lmbInkLoadErrors) this._lmbInkLoadErrors.add(path);
      this._lmbInkSaveState = "error"; this.lmbUpdateInkSaveStatus(); return false;
    } finally { this._lmbInkLoadPromises.delete(path); }
  })();
  this._lmbInkLoadPromises.set(path, promise);
  return promise;
};

LuciasMarginBookPlugin.prototype.lmbInkDocumentReady = function (path) {
  return !this._lmbInkSidecarReady || !this._lmbInkLoadedPaths || this._lmbInkLoadedPaths.has(path);
};

LuciasMarginBookPlugin.prototype.lmbHandleInkPdfRename = async function (file, oldPath) {
  if (!file || file.extension !== "pdf" || !oldPath || oldPath === file.path) return false;
  try {
    let oldPages = this._lmbInkDocs && this._lmbInkDocs[oldPath];
    if (!oldPages && this._lmbInkSidecarReady) {
      const oldDoc = await this.lmbReadInkSidecar(oldPath, this.app.vault.adapter, this.lmbInkStorageDir());
      oldPages = oldDoc && oldDoc.pages;
    }
    if (!oldPages) return false;
    let newPages = this._lmbInkDocs && this._lmbInkDocs[file.path];
    if (!newPages && this._lmbInkSidecarReady) {
      const newDoc = await this.lmbReadInkSidecar(file.path, this.app.vault.adapter, this.lmbInkStorageDir());
      newPages = newDoc && newDoc.pages;
    }
    this._lmbInkDocs[file.path] = lmbInkMergePages(newPages, oldPages);
    delete this._lmbInkDocs[oldPath];
    if (this._lmbInkDirtyPaths) this._lmbInkDirtyPaths.delete(oldPath);
    if (this._lmbInkDirtyRevisions) this._lmbInkDirtyRevisions.delete(oldPath);
    if (this._lmbInkLoadedPaths) { this._lmbInkLoadedPaths.delete(oldPath); this._lmbInkLoadedPaths.add(file.path); }
    if (this._lmbInkHistory) {
      for (const [key, history] of Array.from(this._lmbInkHistory.entries())) if (key.startsWith(oldPath + "\n")) {
        this._lmbInkHistory.delete(key); this._lmbInkHistory.set(file.path + key.slice(oldPath.length), history);
      }
    }
    this.lmbMarkInkDirty(file.path);
    await this.lmbFlushInkStorage();
    if (this.settings.inkExcerptLinks && this.settings.inkExcerptLinks[oldPath]) {
      const oldLinks = this.settings.inkExcerptLinks[oldPath];
      this.settings.inkExcerptLinks[file.path] = { ...oldLinks, ...(this.settings.inkExcerptLinks[file.path] || {}) };
      delete this.settings.inkExcerptLinks[oldPath];
      if (this.settings.inkLinkCounters && this.settings.inkLinkCounters[oldPath]) {
        this.settings.inkLinkCounters[file.path] = Math.max(this.settings.inkLinkCounters[file.path] || 1, this.settings.inkLinkCounters[oldPath]);
        delete this.settings.inkLinkCounters[oldPath];
      }
      await this.saveSettings(); this.lmbScheduleInkReferenceRefresh();
    }
    this.lmbScheduleInkRefresh(0); return true;
  } catch (error) { console.warn("[lmb] PDF ink rename migration failed", oldPath, file.path, error); return false; }
};

LuciasMarginBookPlugin.prototype.lmbInkId = function () {
  return "ink-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
};

LuciasMarginBookPlugin.prototype.lmbInkObjects = function (path, page, create) {
  const store = this.lmbInkStore();
  if (!store[path] && create) store[path] = {};
  if (!store[path]) return [];
  const key = String(page), value = store[path][key];
  if (Array.isArray(value)) store[path][key] = { objects: value.map((stroke) => Object.assign({ type: "pen", id: this.lmbInkId() }, stroke)) };
  if (!store[path][key] && create) store[path][key] = { objects: [] };
  const pageData = store[path][key];
  if (!pageData || !Array.isArray(pageData.objects)) return [];
  let normalized = false;
  const seenIds = new Set();
  for (const object of pageData.objects) {
    if (!object.id || seenIds.has(object.id)) { object.id = this.lmbInkId(); normalized = true; }
    seenIds.add(object.id);
    if (!object.type) { object.type = "pen"; normalized = true; }
  }
  if (normalized && this.lmbInkDocumentReady(path)) this.lmbMarkInkDirty(path);
  return pageData.objects;
};

LuciasMarginBookPlugin.prototype.lmbReplaceInkObjects = function (path, page, objects) {
  const store = this.lmbInkStore();
  if (!store[path]) store[path] = {};
  store[path][String(page)] = { objects: lmbInkClone(objects || []) };
  this.lmbInvalidateInkSpatial(path, page);
};

LuciasMarginBookPlugin.prototype.lmbMarkInkDirty = function (path) {
  if (!path) return;
  if (!this._lmbInkDirtyPaths) this._lmbInkDirtyPaths = new Set();
  if (!this._lmbInkDirtyRevisions) this._lmbInkDirtyRevisions = new Map();
  this._lmbInkDirtyPaths.add(path);
  this._lmbInkDirtyRevisions.set(path, (this._lmbInkDirtyRevisions.get(path) || 0) + 1);
  this._lmbInkRetryCount = 0;
  this._lmbInkSaveState = "saving";
  if (typeof document !== "undefined" && this.settings.inkExcerptLinks && this.settings.inkExcerptLinks[path]) this.lmbScheduleInkReferenceRefresh();
  this.lmbUpdateInkSaveStatus();
  clearTimeout(this._lmbInkSaveTimer);
  // Coalesce short pen lifts into one durable snapshot. 350ms caused a full
  // sidecar rewrite between normal handwriting strokes.
  this._lmbInkSaveTimer = setTimeout(() => this.lmbFlushInkStorage().catch(() => {}), 800);
};

LuciasMarginBookPlugin.prototype.lmbFlushInkStorage = async function () {
  if (this._lmbInkFlushPromise) return this._lmbInkFlushPromise;
  // Do not memoize a synchronously resolved empty flush. Otherwise the async
  // IIFE returns before its finally block and leaves a completed promise here
  // forever, preventing every later stroke from reaching disk.
  if (!this._lmbInkDirtyPaths || !this._lmbInkDirtyPaths.size) {
    this._lmbInkSaveState = "saved"; this.lmbUpdateInkSaveStatus(); return true;
  }
  if (!this._lmbInkLastBackup) this._lmbInkLastBackup = new Map();
  this._lmbInkFlushPromise = (async () => {
    const paths = Array.from(this._lmbInkDirtyPaths || []).map((path) => [path, this._lmbInkDirtyRevisions && this._lmbInkDirtyRevisions.get(path) || 0]);
    if (!paths.length) { this._lmbInkSaveState = "saved"; this.lmbUpdateInkSaveStatus(); return true; }
    try {
      if (!this._lmbInkSidecarReady) {
        this.settings.inkAnnotations = this.lmbInkStore();
        await this.saveSettings();
      } else {
        const adapter = this.app.vault.adapter, dir = this.lmbInkStorageDir();
        for (const [path] of paths) {
          const target = normalizePath(`${dir}/${lmbInkFileKey(path)}`), temp = target + ".tmp", backup = target + ".bak";
          const body = JSON.stringify({ version: LMB_INK_SCHEMA_VERSION, pdfPath: path, revision: this._lmbInkDirtyRevisions.get(path) || 0, savedAt: Date.now(), pages: this.lmbInkStore()[path] || {} });
          await adapter.write(temp, body);
          // Keep recovery guarantees without six I/O operations per stroke:
          // the temp file is already a complete recoverable copy, and the
          // older target only needs refreshing into .bak occasionally.
          const lastBackup = this._lmbInkLastBackup && this._lmbInkLastBackup.get(path) || 0;
          if (Date.now() - lastBackup > 30000 && await adapter.exists(target)) {
            try {
              await adapter.write(backup, await adapter.read(target));
              this._lmbInkLastBackup.set(path, Date.now());
            } catch (_) {}
          }
          await adapter.write(target, body);
          const written = await adapter.read(target);
          const verified = JSON.parse(written);
          if (verified.pdfPath !== path || verified.version !== LMB_INK_SCHEMA_VERSION) throw new Error("ink sidecar verification failed");
          if (written !== body) throw new Error("ink sidecar content verification failed");
        }
      }
      for (const [path, revision] of paths) if ((this._lmbInkDirtyRevisions.get(path) || 0) === revision) this._lmbInkDirtyPaths.delete(path);
      this._lmbInkRetryCount = 0;
      this._lmbInkSaveState = this._lmbInkDirtyPaths.size ? "saving" : "saved";
      this.lmbUpdateInkSaveStatus();
      return true;
    } catch (error) {
      this._lmbInkSaveState = "error";
      this.lmbUpdateInkSaveStatus();
      console.warn("[lmb] ink save failed", error);
      this._lmbInkRetryCount = (this._lmbInkRetryCount || 0) + 1;
      if (this._lmbInkRetryCount === 1) new Notice("MarginBook：手写批注保存失败，原数据仍保留，将稍后重试", 5000);
      throw error;
    } finally {
      this._lmbInkFlushPromise = null;
      if (!this._unloaded && this._lmbInkDirtyPaths && this._lmbInkDirtyPaths.size && this._lmbInkRetryCount <= 5) {
        clearTimeout(this._lmbInkSaveTimer);
        const delays = [1000, 2000, 5000, 15000, 60000];
        this._lmbInkSaveTimer = setTimeout(() => this.lmbFlushInkStorage().catch(() => {}), delays[Math.max(0, this._lmbInkRetryCount - 1)] || 60000);
      }
    }
  })();
  return this._lmbInkFlushPromise;
};

LuciasMarginBookPlugin.prototype.lmbSaveInkSoon = function (path) {
  const canvas = this.lmbActiveInkCanvas();
  this.lmbMarkInkDirty(path || canvas && canvas.dataset.lmbInkPath);
};

LuciasMarginBookPlugin.prototype.lmbSetInkMode = async function (on) {
  if (!on) this.lmbEndInkContinuation(false);
  const request = this._lmbInkModeRequest = (this._lmbInkModeRequest || 0) + 1;
  if (on) {
    // Finish notes through their existing save queue, including IME/failure
    // guards. Never cover an unsaved Markdown editor with the ink surface.
    const editors = new Set(Array.from(this._lmbActiveInlineBlocks || [], block => block._lmbInlineEditor).filter(Boolean));
    for (const bar of document.querySelectorAll(".lmb-pdf-excerpt-sidebar")) if (bar._lmbSidebarEditor) editors.add(bar._lmbSidebarEditor);
    for (const editor of editors) if (!await editor.save()) return false;
    if (request !== this._lmbInkModeRequest) return false;
  }
  document.querySelectorAll(".page[data-lmb-ink-bound]").forEach(page => { if (page._lmbFinishInk) page._lmbFinishInk(); });
  this.inkMode = !!on;
  if (!on) {
    this._lmbInkSelection = []; this._lmbInkSelectionContext = null;
    this.lmbCancelInkAssociation();
    // Offscreen pages can skip the normal refresh. Clear every live overlay
    // immediately, including pending animation frames which could repaint it.
    document.querySelectorAll(".lmb-ink-live-layer").forEach(live => {
      if (live._lmbInkFrame) cancelAnimationFrame(live._lmbInkFrame);
      live._lmbInkFrame = 0; live._lmbInkPendingActive = null;
      this.lmbDrawInkLiveLayer(live, null);
    });
  }
  if (!this.inkTool || !LMB_INK_TOOLS.includes(this.inkTool)) this.inkTool = this.settings.inkLastTool || "pen";
  this.inkColor = this.inkColor || this.settings.inkPenColor || "#e05252";
  this.inkWidth = Number(this.inkWidth || this.settings.inkPenWidth) || 3;
  if (this.inkMode && this.rectMode && typeof this.setRectMode === "function") this.setRectMode(false);
  try {
    document.body.toggleClass("lmb-ink-mode", this.inkMode);
    document.body.toggleClass("lmb-ink-capture", this.inkMode && this.inkTool !== "hand");
    document.querySelectorAll(".lmb-toolbar-ink").forEach((el) => el.toggleClass("is-active", this.inkMode));
  } catch (_) {}
  this.lmbRefreshInkLayers();
  this.lmbRenderInkTools();
  new Notice(this.inkMode ? "MarginBook：手写批注已开启；笔书写，手指滚动和缩放" : "MarginBook：手写批注已关闭", 1800);
};

LuciasMarginBookPlugin.prototype.lmbScheduleInkRefresh = function (delay) {
  clearTimeout(this._lmbInkRefreshTimer);
  this._lmbInkRefreshTimer = setTimeout(() => this.lmbRefreshInkLayers(), Number(delay) || 0);
};

LuciasMarginBookPlugin.prototype.lmbRefreshInkLayers = function () {
  try {
    const leaves = this.app.workspace.getLeavesOfType("pdf") || [];
    for (const leaf of leaves) {
      const file = leaf && leaf.view && leaf.view.file, root = leaf && leaf.containerEl;
      if (!file || !root) continue;
      this.lmbEnsureInkDocument(file.path).catch(() => {});
      root.querySelectorAll(".page").forEach((pageEl, index) => {
        pageEl._lmbInkPageContext = { path: file.path, index };
        if (this._lmbInkVisibilityObserver && !this._lmbInkObservedPages.has(pageEl)) {
          this._lmbInkObservedPages.add(pageEl);
          this._lmbInkVisibilityObserver.observe(pageEl);
        }
        this.lmbEnsureInkLayer(pageEl, file.path, index);
      });
    }
    if (this.inkMode && document.querySelectorAll(".lmb-ink-tools").length !== leaves.length) this.lmbRenderInkTools();
  } catch (error) { console.warn("[lmb] ink refresh failed", error); }
};

LuciasMarginBookPlugin.prototype.lmbEnsureInkLayer = function (pageEl, pdfPath, fallbackIndex) {
  if (!pageEl || !pdfPath) return;
  const pageNumber = Number(pageEl.dataset.pageNumber) || fallbackIndex + 1;
  if (this.settings.pdfTextBlocks && this.settings.pdfTextBlocks[pdfPath] || this._lmbActiveInlineBlocks && this._lmbActiveInlineBlocks.size)
    this.lmbRenderTextBlocksOnPage(pageEl, pdfPath).catch((err) => console.warn("[lmb] text block render failed", err));
  // Capture policy must update synchronously when ink mode toggles; waiting for
  // IntersectionObserver leaves PDF.js in control of the first Pencil stroke.
  this.lmbUpdateInkPageCapture(pageEl);
  // IntersectionObserver includes the PDF scroller's clipping, not just the window.
  if (this._lmbInkVisibilityObserver && pageEl._lmbInkNearViewport !== true) {
    let visiblyNear = false;
    if (typeof pageEl.getBoundingClientRect === "function") {
      try {
        const rect = pageEl.getBoundingClientRect();
        const viewer = pageEl.closest && pageEl.closest(".pdf-viewer-container");
        const clip = viewer && viewer.getBoundingClientRect ? viewer.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        visiblyNear = rect.bottom >= clip.top - 300 && rect.top <= clip.bottom + 300;
      } catch (_) {}
    }
    if (!visiblyNear) return;
    pageEl._lmbInkNearViewport = true;
  }
  if (!this.inkMode && !this.lmbInkObjects(pdfPath, pageNumber).length) {
    for (const layer of pageEl.querySelectorAll(":scope > .lmb-ink-layer, :scope > .lmb-ink-live-layer")) {
      layer.style.display = "none";
      if (layer.width !== 1 || layer.height !== 1) { layer.width = 1; layer.height = 1; }
      layer.dataset.lmbInkDrawn = "0";
    }
    return;
  }
  let canvas = pageEl.querySelector(":scope > .lmb-ink-layer");
  let live = pageEl.querySelector(":scope > .lmb-ink-live-layer");
  if (!canvas) { canvas = document.createElement("canvas"); canvas.className = "lmb-ink-layer"; pageEl.appendChild(canvas); }
  if (!live) { live = document.createElement("canvas"); live.className = "lmb-ink-live-layer"; pageEl.appendChild(live); }
  const identity = `${pdfPath}\n${pageNumber}`, identityChanged = canvas.dataset.lmbInkIdentity !== identity;
  if (identityChanged && pageEl._lmbFinishInk) pageEl._lmbFinishInk();
  for (const layer of [canvas, live]) {
    layer.dataset.lmbInkPath = pdfPath; layer.dataset.lmbInkPage = String(pageNumber);
    layer.dataset.lmbInkIdentity = identity;
    layer.style.display = "block";
  }
  this.lmbUpdateInkPageCapture(pageEl);
  const width = Math.max(1, Math.round(pageEl.clientWidth)), height = Math.max(1, Math.round(pageEl.clientHeight));
  const ratio = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
  let resized = false;
  if ([canvas, live].some(layer => layer.width !== Math.round(width * ratio) || layer.height !== Math.round(height * ratio)) && pageEl._lmbFinishInk) pageEl._lmbFinishInk();
  for (const layer of [canvas, live]) {
    if (layer.width !== Math.round(width * ratio) || layer.height !== Math.round(height * ratio)) {
      layer.width = Math.round(width * ratio); layer.height = Math.round(height * ratio);
      layer.style.width = width + "px"; layer.style.height = height + "px"; resized = true;
    }
  }
  if (!pageEl.dataset.lmbInkBound || pageEl._lmbInkInputSurface && pageEl._lmbInkInputSurface !== live || pageEl._lmbInkStaticSurface && pageEl._lmbInkStaticSurface !== canvas) {
    if (pageEl._lmbFinishInk) pageEl._lmbFinishInk();
    if (pageEl._lmbInkInputAbort) pageEl._lmbInkInputAbort.abort();
    if (this._lmbInkSelectionContext?.canvas === pageEl._lmbInkStaticSurface && pageEl._lmbInkStaticSurface !== canvas) { this._lmbInkSelection = []; this._lmbInkSelectionContext = null; }
    pageEl.dataset.lmbInkBound = "1";
    pageEl._lmbInkInputSurface = live;
    pageEl._lmbInkStaticSurface = canvas;
    this.lmbBindInkPage(pageEl, canvas, live);
  }
    if (!pageEl._lmbInkResizeObserver && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        clearTimeout(pageEl._lmbInkResizeTimer);
        pageEl._lmbInkResizeTimer = setTimeout(() => {
          const context = pageEl._lmbInkPageContext;
          if (!this._unloaded && pageEl.isConnected && context) this.lmbEnsureInkLayer(pageEl, context.path, context.index);
        }, 100);
      });
      observer.observe(pageEl); pageEl._lmbInkResizeObserver = observer;
    }
  if (identityChanged) canvas.dataset.lmbInkDrawn = "0";
  if (identityChanged || resized) this.lmbDrawInkLiveLayer(live, null);
  if (identityChanged || resized || canvas.dataset.lmbInkDrawn !== "1") this.lmbDrawInkLayer(canvas);
};

LuciasMarginBookPlugin.prototype.lmbUpdateInkPageCapture = function (pageEl, forceOff) {
  if (!pageEl || !pageEl.style) return;
  const capture = !forceOff && this.inkMode && this.inkTool !== "hand" && !this._lmbInkSpacePan;
  if (capture) {
    if (!pageEl._lmbInkTouchActionBefore) pageEl._lmbInkTouchActionBefore = {
      value: pageEl.style.getPropertyValue("touch-action"),
      priority: pageEl.style.getPropertyPriority("touch-action"),
      callout: pageEl.style.getPropertyValue("-webkit-touch-callout")
    };
    pageEl.style.setProperty("touch-action", "none", "important");
    pageEl.style.setProperty("-webkit-touch-callout", "none", "important");
    const live = pageEl.querySelector && pageEl.querySelector(":scope > .lmb-ink-live-layer");
    if (live && live.style) {
      live.style.setProperty("pointer-events", "auto", "important");
      live.style.setProperty("touch-action", "none", "important");
      live.style.setProperty("-webkit-touch-callout", "none", "important");
      live.dataset.lmbInkInputSurface = "active";
    }
    return;
  }
  const live = pageEl.querySelector && pageEl.querySelector(":scope > .lmb-ink-live-layer");
  if (live && live.style) {
    live.style.setProperty("pointer-events", "none", "important");
    live.style.removeProperty("touch-action");
    live.style.removeProperty("-webkit-touch-callout");
    delete live.dataset.lmbInkInputSurface;
  }
  const before = pageEl._lmbInkTouchActionBefore;
  if (!before) return;
  if (before.value) pageEl.style.setProperty("touch-action", before.value, before.priority || "");
  else pageEl.style.removeProperty("touch-action");
  if (before.callout) pageEl.style.setProperty("-webkit-touch-callout", before.callout);
  else pageEl.style.removeProperty("-webkit-touch-callout");
  pageEl._lmbInkTouchActionBefore = null;
};

LuciasMarginBookPlugin.prototype.lmbInkPoint = function (pageEl, event) {
  const rect = pageEl.getBoundingClientRect();
  const rawTime = Number(event.timeStamp);
  const pressure = Number(event.pressure) > 0 ? Number(event.pressure) : Number(event.force) > 0 ? Number(event.force) : lmbInkIsStylusInput(event) && (event.pressure === 0 || event.force === 0) ? .02 : .5;
  return lmbInkNormalizePoint({ x: (event.clientX - rect.left) / Math.max(1, rect.width), y: (event.clientY - rect.top) / Math.max(1, rect.height), p: pressure, t: Number.isFinite(rawTime) ? rawTime : Date.now() });
};

LuciasMarginBookPlugin.prototype.lmbInkEventPoints = function (pageEl, event, contactOnly = false) {
  let events = [event];
  try {
    if (typeof event.getCoalescedEvents === "function") {
      const coalesced = event.getCoalescedEvents();
      if (Array.isArray(coalesced) && coalesced.length) {
        events = coalesced.slice();
        const last = events[events.length - 1];
        if (last.clientX !== event.clientX || last.clientY !== event.clientY || last.timeStamp !== event.timeStamp) events.push(event);
      }
    }
  } catch (_) {}
  return events.filter(sample => !contactOnly || lmbInkIsContactSample(sample, event)).map((sample) => this.lmbInkPoint(pageEl, sample));
};

LuciasMarginBookPlugin.prototype.lmbInkShouldDraw = function (event) {
  if (!this.inkMode || this._lmbInkSpacePan || this.inkTool === "hand") return false;
  if (event.pointerType === "touch" && !lmbInkIsStylusInput(event)) return false;
  if (event.pointerType === "mouse" && this.settings.inkInputMode === "pen-only") return false;
  return event.pointerType !== "mouse" || event.button === 0;
};

LuciasMarginBookPlugin.prototype.lmbBindInkPage = function (pageEl, canvas, live) {
  let active = null;
  const inputSurface = live || pageEl;
  // Share navigation contacts across pages in the same PDF (two fingers may
  // land on different pages). A pen takes ownership until its contacts lift.
  const host = pageEl.closest && (pageEl.closest(".pdf-viewer-container") || pageEl.closest(".view-content"));
  const navigation = host ? (host._lmbInkNavigation || (host._lmbInkNavigation = { points: new Map() })) : { points: new Map() };
  const touchPoints = navigation.points;
  const stylusTouchIds = new Set();
  const path = () => canvas.dataset.lmbInkPath, page = () => canvas.dataset.lmbInkPage;
  const scrollHost = () => pageEl.closest && (pageEl.closest(".pdf-viewer-container") || pageEl.closest(".view-content"));
  const resetTouchPan = () => {
    navigation.pan = null; navigation.pinch = null;
    if (Array.from(touchPoints.values()).some(p => p.blocked)) return;
    const entry = touchPoints.values().next().value, host = scrollHost();
    if (touchPoints.size === 1) navigation.pan = entry && host ? { id: entry.id, x: entry.x, y: entry.y, left: host.scrollLeft, top: host.scrollTop, host } : null;
    else if (touchPoints.size === 2 && host) {
      const pair = Array.from(touchPoints.values()), viewer = this.lmbInkZoomViewer && this.lmbInkZoomViewer(pageEl);
      navigation.pinch = { distance: Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y), viewer };
    }
  };
  const redrawLive = () => this.lmbRequestInkLiveDraw(live, active);
  const down = (event) => {
    if (!this.inkMode || this.inkTool === "hand" || this._lmbInkSpacePan || lmbInkIsTextInput(event.target)) return;
    const stylus = lmbInkIsStylusInput(event);
    if (stylus && stylusTouchIds.size && !String(event.pointerId || "").startsWith("stylus-touch-")) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (event.pointerType === "touch" && !stylus) {
      const blocked = !!navigation.pen || Date.now() < (navigation.penUntil || 0) || Number(event.width) > 45 || Number(event.height) > 45;
      touchPoints.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY, blocked });
      try { inputSurface.setPointerCapture(event.pointerId); } catch (_) {}
      resetTouchPan();
      event.preventDefault(); event.stopPropagation();
      return;
    }
    if (active || navigation.pen || this._lmbInkPenActive) return;
    if (!this.lmbInkShouldDraw(event)) return;
    if (!this.lmbInkDocumentReady(path())) {
      this.lmbEnsureInkDocument(path()).catch(() => {});
      new Notice(this._lmbInkLoadErrors && this._lmbInkLoadErrors.has(path()) ? "MarginBook：此 PDF 的批注文件无法读取，已停止写入以保护数据" : "MarginBook：正在加载此 PDF 的批注，请稍后再写", 2600); return;
    }
    const objects = this.lmbInkObjects(path(), page(), true), point = this.lmbInkPoint(pageEl, event);
    let tool = this.inkTool;
    if (tool === "select") this.lmbCancelInkAssociation();
    if (stylus && (event.button === 5 || event.button === 2 || (event.buttons & 32))) tool = "eraser";
    event.preventDefault(); event.stopPropagation();
    navigation.pen = event.pointerId; navigation.penUntil = Date.now() + 300;
    this._lmbInkPenActive = true;
    for (const p of touchPoints.values()) p.blocked = true;
    navigation.pan = null; navigation.pinch = null;
    try { inputSurface.setPointerCapture(event.pointerId); } catch (_) {}
    const before = lmbInkClone(objects);
    if (tool === "text") { navigation.pen = null; this._lmbInkPenActive = false; this.lmbStartInkText(canvas, point); return; }
    if (tool === "select") {
      if (this._lmbInkSelectionContext && this._lmbInkSelectionContext.canvas !== canvas) {
        const oldLive = this._lmbInkSelectionContext.canvas && this._lmbInkSelectionContext.canvas.parentElement && this._lmbInkSelectionContext.canvas.parentElement.querySelector(":scope > .lmb-ink-live-layer");
        this._lmbInkSelection = []; this._lmbInkSelectionContext = null; if (oldLive) this.lmbDrawInkLiveLayer(oldLive, null);
      }
      active = this.lmbStartInkSelection(canvas, point, objects, event.shiftKey);
      if (!active) active = { kind: "lasso", points: [point], before, additive: !!event.shiftKey, priorSelection: (this._lmbInkSelection || []).slice() };
      else active.beforePage = before;
      active.pointerId = event.pointerId;
      this._lmbInkHiddenIds = new Set(active.kind === "moveMulti" ? active.entries.map((entry) => entry.object.id) : active.object ? [active.object.id] : []);
      this.lmbDrawInkLayer(canvas); redrawLive(); return;
    }
    if (tool === "eraser") { active = { kind: "erase", before, removed: new Set(), point, pointerId: event.pointerId, eraserMode: this.settings.inkEraserMode || "partial", returnTool: this.inkTool === "eraser" && this.settings.inkEraserAutoReturn !== false ? this._lmbInkLastDrawTool || "pen" : null }; this.lmbEraseAt(canvas, point, active); redrawLive(); return; }
    const preset = tool === "highlighter"
      ? { color: this.settings.inkHighlighterColor || "#ffd84d", width: Number(this.settings.inkHighlighterWidth) || 12, opacity: .3 }
      : { color: this.inkColor, width: this.inkWidth, opacity: 1 };
    const object = { id: this.lmbInkId(), type: tool, color: preset.color, opacity: preset.opacity, width: preset.width / 1000, widthUnit: "page", pressureMode: this.settings.inkPressureMode || "natural", x1: point.x, y1: point.y, x2: point.x, y2: point.y, points: [point] };
    this.lmbAssignInkContinuation(object, path(), page());
    if (tool === "pen") object.renderVersion = 3;
    const rect = pageEl.getBoundingClientRect();
    active = { kind: "draw", object, before, pointerId: event.pointerId, stylus,
      stabilizer: tool === "pen" && stylus ? { level: lmbInkStabilityLevel(this.settings.inkStabilization), detail: true, width: rect.width, height: rect.height, raw: point, tip: point } : null }; redrawLive();
  };
  const move = (event) => {
    if (event.pointerType === "touch" && !lmbInkIsStylusInput(event)) {
      const point = touchPoints.get(event.pointerId);
      if (!point) return;
      event.preventDefault(); event.stopPropagation();
      if (navigation.pen || point.blocked) return;
      point.x = event.clientX; point.y = event.clientY;
      const touchPan = navigation.pan, pinch = navigation.pinch;
      if (touchPoints.size === 1 && touchPan && touchPan.id === event.pointerId && Math.hypot(event.clientX - touchPan.x, event.clientY - touchPan.y) >= 6) {
        touchPan.host.scrollLeft = touchPan.left - (event.clientX - touchPan.x);
        touchPan.host.scrollTop = touchPan.top - (event.clientY - touchPan.y);
      } else if (touchPoints.size === 2 && pinch && pinch.viewer) {
        const pair = Array.from(touchPoints.values()), distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (pinch.distance > 10 && distance > 10) {
          const host = scrollHost(), rect = host.getBoundingClientRect(), cx = (pair[0].x + pair[1].x) / 2 - rect.left, cy = (pair[0].y + pair[1].y) / 2 - rect.top;
          const before = Number(pinch.viewer.currentScale), next = lmbInkClamp(before * distance / pinch.distance, .25, 5);
          if (before > 0 && Math.abs(next - before) > .001) {
            const left = host.scrollLeft, top = host.scrollTop;
            pinch.viewer.currentScale = next;
            host.scrollLeft = (left + cx) * next / before - cx; host.scrollTop = (top + cy) * next / before - cy;
          }
        }
        pinch.distance = distance;
      }
      return;
    }
    if (!active || active.pointerId != null && event.pointerId !== active.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const points = this.lmbInkEventPoints(pageEl, event, active.kind === "draw" && active.stylus);
    if (!points.length) return;
    const point = points[points.length - 1];
    if (active.kind === "draw") {
      const object = active.object;
      if (active.stabilizer) lmbInkStabilizeSamples(object.points, points, active.stabilizer);
      else if (object.type === "pen" || object.type === "highlighter") lmbInkAppendSamples(object.points, points, .0003);
      else { object.x2 = point.x; object.y2 = point.y; }
    } else if (active.kind === "erase") for (const sample of points) this.lmbEraseAt(canvas, sample, active);
    else if (active.kind === "lasso") lmbInkAppendSamples(active.points, points, .0015);
    else this.lmbMoveInkSelection(active, point);
    redrawLive();
  };
  const finish = (event, cancelled) => {
    if (event && event.pointerType === "touch" && !lmbInkIsStylusInput(event)) {
      touchPoints.delete(event.pointerId);
      event.preventDefault(); event.stopPropagation();
      resetTouchPan();
      return;
    }
    if (!active || event && active.pointerId != null && event.pointerId !== active.pointerId) return;
    if (event) { event.preventDefault(); event.stopPropagation(); }
    // A stylus release is not a contact sample, even on devices reporting the
    // preceding pressure at new hover coordinates. Keep the last valid move.
    if (!cancelled && event && !(active.kind === "draw" && active.stylus)) {
      const finalPoints = this.lmbInkEventPoints(pageEl, event), finalPoint = finalPoints[finalPoints.length - 1];
      if (active.kind === "draw") {
        if (active.object.type === "pen" || active.object.type === "highlighter") lmbInkAppendSamples(active.object.points, finalPoints, .00005);
        else { active.object.x2 = finalPoint.x; active.object.y2 = finalPoint.y; }
      } else if (active.kind === "erase") for (const sample of finalPoints) this.lmbEraseAt(canvas, sample, active);
      else if (active.kind === "lasso") lmbInkAppendSamples(active.points, finalPoints, .0005);
      else if (!["selectionOnly"].includes(active.kind)) this.lmbMoveInkSelection(active, finalPoint);
    }
    const current = active; active = null;
    live._lmbInkPendingActive = null;
    navigation.pen = null; navigation.penUntil = Date.now() + 300;
    this._lmbInkPenActive = false; this._lmbInkPalmUntil = Date.now() + 300;
    const objects = this.lmbInkObjects(path(), page(), true);
    const salvageCancelledStroke = cancelled && current.kind === "draw"
      && (current.object.type === "pen" || current.object.type === "highlighter")
      && Array.isArray(current.object.points) && current.object.points.length > 1;
    if (cancelled && !salvageCancelledStroke) this.lmbReplaceInkObjects(path(), page(), current.beforePage || current.before || objects);
    else if (current.kind === "draw") {
      const object = current.object;
      if (current.stabilizer) lmbInkFinishStabilization(object.points, current.stabilizer);
      if (object.type === "pen" || object.type === "highlighter") object.points = lmbInkSimplifyPoints(object.points, object.renderVersion >= 3 ? .00008 : .00018, object.renderVersion >= 3 ? .018 : .055);
      const isStroke = object.type === "pen" || object.type === "highlighter";
      const longEnough = Math.hypot((object.x2 || 0) - (object.x1 || 0), (object.y2 || 0) - (object.y1 || 0)) > .001;
      if (isStroke || longEnough) objects.push(object);
      this.lmbCommitInkChange(path(), page(), current.before, "draw");
    } else if (current.kind === "lasso") {
      const selected = lmbInkObjectsInLasso(objects, current.points);
      const selectedIds = selected.map((object) => object.id);
      this._lmbInkSelection = current.additive ? Array.from(new Set((current.priorSelection || []).concat(selectedIds))) : selectedIds;
      this._lmbInkSelectionContext = { canvas, path: path(), page: page() };
    } else if (current.kind === "erase") this.lmbCommitInkChange(path(), page(), current.before, "erase");
    else this.lmbCommitInkChange(path(), page(), current.beforePage, current.kind);
    this._lmbInkHiddenIds = null;
    this.lmbDrawInkLayer(canvas); this.lmbDrawInkLiveLayer(live, null);
    if (this.inkTool === "select") this.lmbRenderInkTools();
    if (current.kind === "erase" && current.returnTool && !cancelled && this.inkTool === "eraser") this.lmbSetInkTool(current.returnTool);
  };
  const inputAbort = new AbortController(); pageEl._lmbInkInputAbort = inputAbort;
  const captureActive = { capture: true, passive: false, signal: inputAbort.signal };
  inputSurface.addEventListener("pointerdown", down, captureActive);
  inputSurface.addEventListener("pointermove", move, captureActive);
  inputSurface.addEventListener("pointerup", (event) => finish(event, false), captureActive);
  inputSurface.addEventListener("pointercancel", (event) => finish(event, true), captureActive);
  inputSurface.addEventListener("lostpointercapture", (event) => finish(event, true), captureActive);
  // Flush an in-flight stroke before page recycling/tool switching. Clear a
  // queued animation as well, otherwise it can repaint a finished ghost stroke.
  pageEl._lmbFinishInk = () => {
    finish(null, true); touchPoints.clear(); navigation.pan = null; navigation.pinch = null; navigation.pen = null;
    live._lmbInkPendingActive = null;
  };
  const stylusTouches = (event) => Array.from(event.changedTouches || []).filter((touch) => lmbInkIsStylusInput(touch));
  inputSurface.addEventListener("touchstart", (event) => {
    const touches = stylusTouches(event); if (!touches.length) return;
    event.preventDefault(); event.stopPropagation();
    if (active) return;
    const touch = touches[0]; stylusTouchIds.add(touch.identifier);
    down(lmbInkTouchPointEvent(touch, event, false));
  }, captureActive);
  inputSurface.addEventListener("touchmove", (event) => {
    const touches = stylusTouches(event).filter((touch) => stylusTouchIds.has(touch.identifier)); if (!touches.length) return;
    event.preventDefault(); event.stopPropagation(); move(lmbInkTouchPointEvent(touches[0], event, false));
  }, captureActive);
  const finishStylusTouch = (event, cancelled) => {
    const touches = stylusTouches(event).filter((touch) => stylusTouchIds.has(touch.identifier)); if (!touches.length) return;
    event.preventDefault(); event.stopPropagation();
    const touch = touches[0]; finish(lmbInkTouchPointEvent(touch, event, true), cancelled); stylusTouchIds.delete(touch.identifier);
  };
  inputSurface.addEventListener("touchend", (event) => finishStylusTouch(event, false), captureActive);
  inputSurface.addEventListener("touchcancel", (event) => finishStylusTouch(event, true), captureActive);
  inputSurface.addEventListener("contextmenu", (event) => { if (this.inkMode && event.pointerType === "pen") event.preventDefault(); }, captureActive);
};

LuciasMarginBookPlugin.prototype.lmbInkZoomViewer = function (pageEl) {
  const leaf = (this.app.workspace.getLeavesOfType("pdf") || []).find(leaf => leaf.containerEl && leaf.containerEl.contains(pageEl));
  return LmbPdfAdapter.zoomViewer(leaf && leaf.view);
};

LuciasMarginBookPlugin.prototype.lmbRequestInkLiveDraw = function (live, active) {
  live._lmbInkPendingActive = active;
  if (live._lmbInkFrame) return;
  live._lmbInkFrame = requestAnimationFrame(() => { live._lmbInkFrame = 0; this.lmbDrawInkLiveLayer(live, live._lmbInkPendingActive); });
};

LuciasMarginBookPlugin.prototype.lmbCanvasContext = function (canvas) {
  const ctx = canvas.getContext("2d"), ratio = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: canvas.clientWidth, height: canvas.clientHeight };
};

LuciasMarginBookPlugin.prototype.lmbDrawInkObject = function (ctx, object, width, height) {
  if (!object) return;
  const color = object.color || "#e05252", type = object.type;
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = object.opacity == null ? 1 : object.opacity;
  if (type === "pen" || type === "highlighter") {
    const points = object.points || [];
    if (!points.length) { ctx.restore(); return; }
    if (type === "highlighter") ctx.globalCompositeOperation = "multiply";
    if (points.length === 1) {
      const radius = lmbInkSegmentWidth(object, points[0], null, width, height) / 2;
      ctx.beginPath(); ctx.arc(points[0].x * width, points[0].y * height, radius, 0, Math.PI * 2); ctx.fill();
    } else if (type === "pen" && object.renderVersion >= 2) {
      const { centers, left, right, corners } = lmbInkRibbon(object, width, height);
      const trace = (side, anchors) => {
        for (let i = 1; i < side.length - 1; i++) {
          if (anchors[i]) ctx.lineTo(side[i].x, side[i].y);
          else ctx.quadraticCurveTo(side[i].x, side[i].y, (side[i].x + side[i + 1].x) / 2, (side[i].y + side[i + 1].y) / 2);
        }
        ctx.lineTo(side[side.length - 1].x, side[side.length - 1].y);
      };
      ctx.beginPath(); ctx.moveTo(left[0].x, left[0].y); trace(left, corners);
      const last = centers.length - 1, end = centers[last], start = centers[0];
      const endAngle = Math.atan2(left[last].y - end.y, left[last].x - end.x);
      ctx.arc(end.x, end.y, Math.hypot(left[last].x - end.x, left[last].y - end.y), endAngle, endAngle - Math.PI, true);
      trace(right.slice().reverse(), corners.slice().reverse());
      const startAngle = Math.atan2(right[0].y - start.y, right[0].x - start.x);
      ctx.arc(start.x, start.y, Math.hypot(right[0].x - start.x, right[0].y - start.y), startAngle, startAngle - Math.PI, true);
      ctx.closePath(); ctx.fill();
    } else if (type === "highlighter") {
      ctx.lineWidth = lmbInkSegmentWidth(object, points[0], null, width);
      ctx.beginPath(); ctx.moveTo(points[0].x * width, points[0].y * height);
      for (let i = 1; i < points.length - 1; i++) {
        const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
        ctx.quadraticCurveTo(points[i].x * width, points[i].y * height, mid.x * width, mid.y * height);
      }
      ctx.lineTo(points[points.length - 1].x * width, points[points.length - 1].y * height); ctx.stroke();
    } else {
      let previous = points[0], cursor = previous;
      for (let i = 1; i < points.length; i++) {
        const point = points[i], priorWidth = lmbInkSegmentWidth(object, previous, i > 1 ? points[i - 2] : null, width);
        ctx.lineWidth = (priorWidth + lmbInkSegmentWidth(object, point, previous, width)) / 2;
        const mid = { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
        ctx.beginPath(); ctx.moveTo(cursor.x * width, cursor.y * height); ctx.quadraticCurveTo(previous.x * width, previous.y * height, mid.x * width, mid.y * height); ctx.stroke(); cursor = mid;
        previous = point;
      }
      ctx.beginPath(); ctx.moveTo(cursor.x * width, cursor.y * height); ctx.lineTo(previous.x * width, previous.y * height); ctx.stroke();
    }
  } else {
    ctx.lineWidth = object.widthUnit === "page" ? Math.max(.5, object.width * width) : Number(object.width) || 3;
    if (type === "line") { ctx.beginPath(); ctx.moveTo(object.x1 * width, object.y1 * height); ctx.lineTo(object.x2 * width, object.y2 * height); ctx.stroke(); }
    else if (type === "rect") ctx.strokeRect(Math.min(object.x1, object.x2) * width, Math.min(object.y1, object.y2) * height, Math.abs(object.x2 - object.x1) * width, Math.abs(object.y2 - object.y1) * height);
    else if (type === "text") {
      const size = object.fontUnit === "page" ? Math.max(9, object.fontSize * width) : object.fontSize || 16;
      ctx.font = `${size}px sans-serif`; ctx.textBaseline = "top";
      String(object.text || "").split("\n").forEach((line, index) => ctx.fillText(line, object.x * width, object.y * height + index * size * 1.25, (object.w || .24) * width));
    }
  }
  ctx.restore();
};

LuciasMarginBookPlugin.prototype.lmbDrawInkLayer = function (canvas) {
  const info = this.lmbCanvasContext(canvas); if (!info) return;
  info.ctx.clearRect(0, 0, info.width, info.height);
  const hidden = this._lmbInkHiddenIds || new Set();
  for (const object of this.lmbInkObjects(canvas.dataset.lmbInkPath, canvas.dataset.lmbInkPage)) if (!hidden.has(object.id)) this.lmbDrawInkObject(info.ctx, object, info.width, info.height);
  canvas.dataset.lmbInkDrawn = "1";
};

LuciasMarginBookPlugin.prototype.lmbDrawInkLiveLayer = function (canvas, active) {
  this.lmbUpdateInkLocation(canvas);
  const info = this.lmbCanvasContext(canvas); if (!info) return;
  const { ctx, width, height } = info; ctx.clearRect(0, 0, width, height);
  if (active && active.kind === "draw") this.lmbDrawInkObject(ctx, active.object, width, height);
  if (active && active.kind === "erase" && active.point) {
    ctx.save(); ctx.strokeStyle = "#64748b"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(active.point.x * width, active.point.y * height, Number(this.settings.inkEraserSize) || 18, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  if (active && ["move", "resize"].includes(active.kind)) this.lmbDrawInkObject(ctx, active.object, width, height);
  if (active && active.kind === "moveMulti") for (const entry of active.entries) this.lmbDrawInkObject(ctx, entry.object, width, height);
  if (active && active.kind === "lasso") {
    ctx.save(); ctx.strokeStyle = "#2d8cff"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.beginPath();
    active.points.forEach((point, index) => index ? ctx.lineTo(point.x * width, point.y * height) : ctx.moveTo(point.x * width, point.y * height)); ctx.stroke(); ctx.restore();
  }
  const selection = this._lmbInkSelectionContext;
  const editing = this.inkMode && this.inkTool === "select" && selection && selection.path === canvas.dataset.lmbInkPath && Number(selection.page) === Number(canvas.dataset.lmbInkPage);
  // Read-only location uses the persistent labelled outline. Resize handles
  // belong only to an active edit selection on this particular PDF page.
  const selected = new Set(editing && Array.isArray(this._lmbInkSelection) ? this._lmbInkSelection : []);
  const objects = this.lmbInkObjects(canvas.dataset.lmbInkPath, canvas.dataset.lmbInkPage);
  for (const object of objects.filter((item) => selected.has(item.id))) {
    const bounds = lmbInkBounds(object);
    ctx.save(); ctx.strokeStyle = "#2d8cff"; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
    ctx.strokeRect(bounds.x * width - 4, bounds.y * height - 4, Math.max(8, bounds.w * width + 8), Math.max(8, bounds.h * height + 8));
    ctx.setLineDash([]); ctx.fillStyle = "#2d8cff";
    if (object.type === "line") {
      ctx.fillRect(object.x1 * width - 6, object.y1 * height - 6, 12, 12);
      ctx.fillRect(object.x2 * width - 6, object.y2 * height - 6, 12, 12);
    } else ctx.fillRect((bounds.x + bounds.w) * width - 6, (bounds.y + bounds.h) * height - 6, 12, 12);
    ctx.restore();
  }
};

LuciasMarginBookPlugin.prototype.lmbObjectBounds = function (object) { return lmbInkBounds(object); };

LuciasMarginBookPlugin.prototype.lmbInvalidateInkSpatial = function (path, page) {
  if (this._lmbInkSpatialCache) this._lmbInkSpatialCache.delete(`${path}\n${page}`);
};

LuciasMarginBookPlugin.prototype.lmbBuildInkSpatial = function (objects) {
  const cellSize = .05, cells = new Map(), byId = new Map();
  for (const object of objects || []) {
    if (!object || !object.id) continue; byId.set(object.id, object);
    const bounds = lmbInkBounds(object), minX = Math.floor(bounds.x / cellSize), maxX = Math.floor((bounds.x + bounds.w) / cellSize), minY = Math.floor(bounds.y / cellSize), maxY = Math.floor((bounds.y + bounds.h) / cellSize);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const key = `${x},${y}`; if (!cells.has(key)) cells.set(key, new Set()); cells.get(key).add(object.id);
    }
  }
  return { cellSize, cells, byId };
};

LuciasMarginBookPlugin.prototype.lmbInkSpatialCandidates = function (spatial, point, tolerance) {
  const ids = new Set(), size = spatial.cellSize, minX = Math.floor((point.x - tolerance) / size), maxX = Math.floor((point.x + tolerance) / size), minY = Math.floor((point.y - tolerance) / size), maxY = Math.floor((point.y + tolerance) / size);
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (const id of spatial.cells.get(`${x},${y}`) || []) ids.add(id);
  return Array.from(ids, (id) => spatial.byId.get(id)).filter(Boolean);
};

LuciasMarginBookPlugin.prototype.lmbStartInkSelection = function (canvas, point, objects, additive) {
  const tolerance = Math.max(.006, 9 / Math.max(1, canvas.clientWidth));
  const hit = objects.slice().reverse().find((object) => lmbInkObjectHit(object, point, tolerance));
  const prior = Array.isArray(this._lmbInkSelection) ? this._lmbInkSelection : [];
  if (!hit) { if (!additive) this._lmbInkSelection = []; return null; }
  const ids = additive ? (prior.includes(hit.id) ? prior.filter((id) => id !== hit.id) : prior.concat(hit.id))
    : prior.includes(hit.id) && prior.length > 1 ? prior.slice() : [hit.id];
  this._lmbInkSelection = ids; this._lmbInkSelectionContext = { canvas, path: canvas.dataset.lmbInkPath, page: canvas.dataset.lmbInkPage };
  if (!ids.includes(hit.id)) return { kind: "selectionOnly", start: point };
  if (ids.length > 1) return { kind: "moveMulti", start: point, entries: objects.filter((object) => ids.includes(object.id)).map((object) => ({ object, before: lmbInkClone(object), bounds: lmbInkBounds(object) })) };
  const bounds = lmbInkBounds(hit);
  if (hit.type === "line") {
    const d1 = lmbInkDistance(point, { x: hit.x1, y: hit.y1 }), d2 = lmbInkDistance(point, { x: hit.x2, y: hit.y2 });
    if (Math.min(d1, d2) <= tolerance * 2) return { kind: "resize", endpoint: d1 <= d2 ? 1 : 2, object: hit, start: point, before: lmbInkClone(hit), bounds };
  }
  const resize = point.x > bounds.x + bounds.w - tolerance * 2 && point.y > bounds.y + bounds.h - tolerance * 2;
  const resizeKeys = hit.type === "rect" ? { x: hit.x1 > hit.x2 ? "x1" : "x2", y: hit.y1 > hit.y2 ? "y1" : "y2" } : null;
  return { kind: resize ? "resize" : "move", resizeKeys, object: hit, start: point, before: lmbInkClone(hit), bounds };
};

LuciasMarginBookPlugin.prototype.lmbMoveInkSelection = function (selection, point) {
  if (!selection) return;
  if (selection.kind === "moveMulti") { for (const entry of selection.entries) this.lmbMoveInkSelection({ kind: "move", object: entry.object, before: entry.before, bounds: entry.bounds, start: selection.start }, point); return; }
  const object = selection.object, before = selection.before, dx = point.x - selection.start.x, dy = point.y - selection.start.y;
  if (!object) return;
  if (selection.kind === "resize") {
    if (object.type === "text") {
      const newWidth = Math.max(.04, (selection.bounds.w || .2) + dx);
      object.fontSize = Math.max(.009, Math.min(.09, (before.fontUnit === "page" ? before.fontSize : (before.fontSize || 16) / 1000) * newWidth / (selection.bounds.w || .2)));
      object.fontUnit = "page"; object.w = newWidth; object.h = Math.max(.025, (selection.bounds.h || .05) + dy);
    } else if (object.type === "pen" || object.type === "highlighter") {
      const sx = Math.max(.08, ((selection.bounds.w || .02) + dx) / (selection.bounds.w || .02)), sy = Math.max(.08, ((selection.bounds.h || .02) + dy) / (selection.bounds.h || .02));
      object.points = before.points.map((p) => Object.assign({}, p, { x: selection.bounds.x + (p.x - selection.bounds.x) * sx, y: selection.bounds.y + (p.y - selection.bounds.y) * sy }));
    } else if (object.type === "line") {
      const suffix = selection.endpoint === 1 ? "1" : "2"; object[`x${suffix}`] = before[`x${suffix}`] + dx; object[`y${suffix}`] = before[`y${suffix}`] + dy;
    } else {
      const keys = selection.resizeKeys || { x: "x2", y: "y2" }; object[keys.x] = before[keys.x] + dx; object[keys.y] = before[keys.y] + dy;
    }
  } else if (object.type === "pen" || object.type === "highlighter") object.points = before.points.map((p) => Object.assign({}, p, { x: p.x + dx, y: p.y + dy }));
  else if (object.type === "text") { object.x = before.x + dx; object.y = before.y + dy; }
  else { object.x1 = before.x1 + dx; object.y1 = before.y1 + dy; object.x2 = before.x2 + dx; object.y2 = before.y2 + dy; }
};

LuciasMarginBookPlugin.prototype.lmbEraseAt = function (canvas, point, active) {
  const objects = this.lmbInkObjects(canvas.dataset.lmbInkPath, canvas.dataset.lmbInkPage, true);
  const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
  const radius = Number(this.settings.inkEraserSize) || 18, from = active.erasePrevious || point;
  active.erasePrevious = point; active.point = point;
  let changed = false;
  for (let index = objects.length - 1; index >= 0; index--) {
    const object = objects[index], bounds = lmbInkBounds(object), pad = radius / width + (Number(object.width) || 0);
    if (bounds.x > Math.max(from.x, point.x) + pad || bounds.x + bounds.w < Math.min(from.x, point.x) - pad
      || bounds.y > Math.max(from.y, point.y) + radius / height + pad || bounds.y + bounds.h < Math.min(from.y, point.y) - radius / height - pad) continue;
    const fragments = lmbInkEraseFragments(object, from, point, radius, width, height);
    if (fragments === null && !(object.type === "text" && lmbInkObjectHit(object, point, radius / width))) continue;
    changed = true;
    if (active.eraserMode === "stroke" || fragments === null || !fragments.length) objects.splice(index, 1);
    else {
      const pieces = fragments.map((points, part) => ({ ...object,
        id: part === 0 ? object.id : this.lmbInkId(), type: object.type === "highlighter" ? "highlighter" : "pen", points,
        ...(object.renderVersion >= 3 ? {
          inkCutStart: !!object.inkCutStart || !object.points?.length || lmbInkDistance(points[0], object.points[0]) > 1e-9,
          inkCutEnd: !!object.inkCutEnd || !object.points?.length || lmbInkDistance(points[points.length - 1], object.points[object.points.length - 1]) > 1e-9
        } : {}),
        inkSourceIds: Array.from(new Set([...(object.inkSourceIds || []), object.id])),
        x1: points[0].x, y1: points[0].y, x2: points[points.length - 1].x, y2: points[points.length - 1].y,
        pressureMode: object.type === "line" || object.type === "rect" ? "fixed" : object.pressureMode || "natural"
      }));
      objects.splice(index, 1, ...pieces);
    }
  }
  if (changed) { this.lmbInvalidateInkSpatial(canvas.dataset.lmbInkPath, canvas.dataset.lmbInkPage); this.lmbRequestInkStaticDraw(canvas); }
};

LuciasMarginBookPlugin.prototype.lmbRequestInkStaticDraw = function (canvas) {
  if (canvas._lmbInkStaticFrame) return;
  canvas._lmbInkStaticFrame = requestAnimationFrame(() => { canvas._lmbInkStaticFrame = 0; this.lmbDrawInkLayer(canvas); });
};

LuciasMarginBookPlugin.prototype.lmbStartInkText = function (canvas, point) {
  const pageEl = canvas.parentElement, box = document.createElement("textarea");
  box.className = "lmb-ink-text-editor"; box.placeholder = "输入备注…"; box.style.left = point.x * 100 + "%"; box.style.top = point.y * 100 + "%"; box.style.color = this.inkColor;
  pageEl.appendChild(box); box.focus(); let finished = false;
  const finish = (save) => {
    if (finished) return; finished = true;
    const text = box.value.trim();
    if (save && text) {
      const path = canvas.dataset.lmbInkPath, page = canvas.dataset.lmbInkPage, objects = this.lmbInkObjects(path, page, true), before = lmbInkClone(objects);
      const measuredWidth = Math.max(40, Number(box.offsetWidth) || 190), measuredHeight = Math.max(28, Number(box.offsetHeight) || 54);
      objects.push({ id: this.lmbInkId(), type: "text", text, x: point.x, y: point.y, w: measuredWidth / Math.max(1, canvas.clientWidth), h: measuredHeight / Math.max(1, canvas.clientHeight), color: this.inkColor, width: this.inkWidth / 1000, widthUnit: "page", fontSize: .016, fontUnit: "page" });
      this.lmbCommitInkChange(path, page, before, "text"); this.lmbDrawInkLayer(canvas);
    }
    box.remove();
  };
  box.addEventListener("blur", () => finish(true), { once: true });
  box.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(false); else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") box.blur(); });
};

LuciasMarginBookPlugin.prototype.lmbHistoryFor = function (path, page) {
  if (!this._lmbInkHistory) this._lmbInkHistory = new Map();
  const key = `${path}\n${page}`;
  if (!this._lmbInkHistory.has(key)) this._lmbInkHistory.set(key, { undo: [], redo: [] });
  return this._lmbInkHistory.get(key);
};

LuciasMarginBookPlugin.prototype.lmbCommitInkChange = function (path, page, before, label) {
  const after = lmbInkClone(this.lmbInkObjects(path, page, true));
  const patch = lmbInkBuildPatch(before, after);
  if (!patch.added.length && !patch.removed.length && !patch.modified.length) return false;
  const history = this.lmbHistoryFor(path, page);
  history.undo.push({ patch, label });
  if (history.undo.length > LMB_INK_HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0; this.lmbInvalidateInkSpatial(path, page); this.lmbMarkInkDirty(path); return true;
};

LuciasMarginBookPlugin.prototype.lmbActiveInkCanvas = function () {
  const activeRoot = this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.containerEl;
  const root = arguments[0] && typeof arguments[0].querySelectorAll === "function" ? arguments[0] : activeRoot || document;
  const explicitPath = arguments[1];
  const file = this.app.workspace.getActiveFile(), filePath = explicitPath || file && file.path; if (!filePath) return null;
  const candidates = Array.from(root.querySelectorAll(".lmb-ink-layer")).filter((canvas) => canvas.dataset.lmbInkPath === filePath);
  let best = null, bestArea = -1;
  for (const canvas of candidates) {
    const rect = canvas.getBoundingClientRect(), visible = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
    if (visible > bestArea) { best = canvas; bestArea = visible; }
  }
  return best;
};

LuciasMarginBookPlugin.prototype.lmbUndoInk = function (canvas) { return this.lmbApplyInkHistory("undo", canvas); };
LuciasMarginBookPlugin.prototype.lmbRedoInk = function (canvas) { return this.lmbApplyInkHistory("redo", canvas); };
LuciasMarginBookPlugin.prototype.lmbApplyInkHistory = function (direction, preferredCanvas) {
  const canvas = preferredCanvas || this.lmbActiveInkCanvas(); if (!canvas) return false;
  const path = canvas.dataset.lmbInkPath, page = canvas.dataset.lmbInkPage, history = this.lmbHistoryFor(path, page), entry = history[direction].pop(); if (!entry) return false;
  this.lmbReplaceInkObjects(path, page, lmbInkApplyPatch(this.lmbInkObjects(path, page), entry.patch, direction));
  if (direction === "undo") history.redo.push(entry); else history.undo.push(entry);
  this._lmbInkSelection = []; this._lmbInkSelectionContext = null; this.lmbRedrawInkPage(canvas); this.lmbMarkInkDirty(path); return true;
};

LuciasMarginBookPlugin.prototype.lmbClearInk = function () {
  const canvas = this.lmbActiveInkCanvas(); if (!canvas) return false;
  const path = canvas.dataset.lmbInkPath, page = canvas.dataset.lmbInkPage, objects = this.lmbInkObjects(path, page);
  if (!objects.length) return false;
  const before = lmbInkClone(objects); objects.length = 0; this._lmbInkSelection = []; this._lmbInkSelectionContext = null;
  this.lmbCommitInkChange(path, page, before, "clear"); this.lmbRedrawInkPage(canvas); new Notice("MarginBook：已清空当前页，可用撤销恢复", 2200); return true;
};

LuciasMarginBookPlugin.prototype.lmbDeleteInkSelection = function (preferredCanvas) {
  this.lmbCancelInkAssociation();
  const context = this._lmbInkSelectionContext;
  if (preferredCanvas && (!context || context.canvas !== preferredCanvas)) return false;
  const canvas = context && context.canvas && context.canvas.isConnected ? context.canvas : preferredCanvas || this.lmbActiveInkCanvas();
  const ids = new Set(Array.isArray(this._lmbInkSelection) ? this._lmbInkSelection : []); if (!canvas || !ids.size) return false;
  const path = canvas.dataset.lmbInkPath, page = canvas.dataset.lmbInkPage, objects = this.lmbInkObjects(path, page), before = lmbInkClone(objects);
  for (let i = objects.length - 1; i >= 0; i--) if (ids.has(objects[i].id)) objects.splice(i, 1);
  if (before.length === objects.length) return false;
  this._lmbInkSelection = []; this._lmbInkSelectionContext = null;
  this.lmbCommitInkChange(path, page, before, "delete"); this.lmbRedrawInkPage(canvas); return true;
};

LuciasMarginBookPlugin.prototype.lmbRedrawInkPage = function (canvas) {
  if (!canvas) return;
  this.lmbDrawInkLayer(canvas);
  const live = canvas.parentElement && canvas.parentElement.querySelector(":scope > .lmb-ink-live-layer");
  if (live) this.lmbDrawInkLiveLayer(live, null);
};

LuciasMarginBookPlugin.prototype.lmbApplyInkStyleToSelection = function (property, value, scopeHost) {
  const context = this._lmbInkSelectionContext, ids = new Set(this._lmbInkSelection || []);
  if (!context || !ids.size) return false;
  if (scopeHost && typeof scopeHost.contains === "function" && !scopeHost.contains(context.canvas)) return false;
  const objects = this.lmbInkObjects(context.path, context.page), before = lmbInkClone(objects);
  for (const object of objects) if (ids.has(object.id)) {
    if (property === "color") object.color = value;
    if (property === "width") { object.width = Number(value) / 1000; object.widthUnit = "page"; }
  }
  if (!this.lmbCommitInkChange(context.path, context.page, before, "style")) return false;
  this.lmbRedrawInkPage(context.canvas); return true;
};

LuciasMarginBookPlugin.prototype.lmbSetInkTool = function (tool) {
  if (!LMB_INK_TOOLS.includes(tool)) return;
  if (tool !== "select") this.lmbCancelInkAssociation();
  if (["hand", "select", "text"].includes(tool)) this.lmbEndInkContinuation(false);
  if (["pen", "highlighter", "line", "rect"].includes(this.inkTool)) this._lmbInkLastDrawTool = this.inkTool;
  if (typeof document !== "undefined") document.querySelectorAll(".page[data-lmb-ink-bound]").forEach(page => { if (page._lmbFinishInk) page._lmbFinishInk(); });
  this.inkTool = tool; this.settings.inkLastTool = tool;
  try { document.body.toggleClass("lmb-ink-capture", this.inkMode && tool !== "hand"); } catch (_) {}
  if (tool === "highlighter") { this.inkColor = this.settings.inkHighlighterColor || "#ffd84d"; this.inkWidth = Number(this.settings.inkHighlighterWidth) || 12; }
  else if (["pen", "text", "line", "rect"].includes(tool)) { this.inkColor = this.settings.inkPenColor || "#e05252"; this.inkWidth = Number(this.settings.inkPenWidth) || 3; }
  this.lmbPersistInkPreferences(); this.lmbRefreshInkLayers(); this.lmbRenderInkTools();
};

LuciasMarginBookPlugin.prototype.lmbPersistInkPreferences = function () {
  clearTimeout(this._lmbInkPrefsTimer);
  this._lmbInkPrefsTimer = setTimeout(() => this.saveSettings().catch((error) => console.warn("[lmb] ink preferences save failed", error)), 300);
};

LuciasMarginBookPlugin.prototype.lmbUpdateInkSaveStatus = function () {
  const label = this._lmbInkSaveState === "saving" ? "保存中…" : this._lmbInkSaveState === "error" ? "保存失败" : "已保存";
  document.querySelectorAll(".lmb-ink-save-status").forEach((element) => { element.textContent = label; element.dataset.state = this._lmbInkSaveState || "saved"; });
};

LuciasMarginBookPlugin.prototype.lmbRenderInkTools = function () {
  document.querySelectorAll(".lmb-ink-tools").forEach((bar) => bar.remove());
  if (!this.inkMode) return;
  const specs = [["hand", "hand", "抓手（空格临时启用）", "手"], ["select", "mouse-pointer-2", "选择 / 套索", "选"], ["pen", "pencil", "画笔", "笔"], ["highlighter", "highlighter", "荧光笔", "荧"], ["eraser", "eraser", this.settings.inkEraserMode === "stroke" ? "整笔橡皮" : "局部橡皮", "擦"], ["text", "type", "文字", "字"], ["line", "minus", "直线", "线"], ["rect", "square", "矩形", "框"]];
  const applyIcon = (element, icon, fallback) => { try { setIcon(element, icon); } catch (_) { element.textContent = fallback || "•"; } };
  for (const leaf of this.app.workspace.getLeavesOfType("pdf") || []) {
    const leafRoot = leaf && leaf.containerEl; if (!leafRoot) continue;
    const host = leafRoot.querySelector(":scope > .view-content") || leafRoot.querySelector(".view-content") || leafRoot;
    const bar = document.createElement("div"); bar.className = "lmb-ink-tools"; if (this.settings.inkToolbarCollapsed) bar.classList.add("is-collapsed");
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "lmb-ink-collapse"; toggle.title = "收起 / 展开手写工具栏"; toggle.setAttribute("aria-label", toggle.title); applyIcon(toggle, this.settings.inkToolbarCollapsed ? "pencil" : "chevron-left", this.settings.inkToolbarCollapsed ? "笔" : "‹");
    toggle.addEventListener("click", () => { this.settings.inkToolbarCollapsed = !this.settings.inkToolbarCollapsed; this.lmbPersistInkPreferences(); this.lmbRenderInkTools(); }); bar.appendChild(toggle);
    const content = document.createElement("div"); content.className = "lmb-ink-tools-content"; bar.appendChild(content);
    const toolButtons = document.createElement("div"); toolButtons.className = "lmb-ink-tool-buttons"; content.appendChild(toolButtons);
    const advanced = document.createElement("div"); advanced.className = "lmb-ink-advanced"; advanced.hidden = !this._lmbInkToolsExpanded;
    for (const [tool, icon, title, fallback] of specs) {
      const button = document.createElement("button"); button.type = "button"; button.title = title; button.setAttribute("aria-label", title); button.dataset.tool = tool; button.classList.toggle("is-active", this.inkTool === tool); applyIcon(button, icon, fallback);
      button.setAttribute("aria-pressed", String(this.inkTool === tool));
      button.addEventListener("click", () => this.lmbSetInkTool(tool)); (["text", "line", "rect"].includes(tool) ? advanced : toolButtons).appendChild(button);
    }
    const colors = this.inkTool === "highlighter" ? ["#ffd84d", "#7ee787", "#70b7ff"] : ["#e05252", "#222222", "#2d8cff"];
    const swatches = document.createElement("div"); swatches.className = "lmb-ink-swatches";
    for (const value of colors) {
      const swatch = document.createElement("button"); swatch.type = "button"; swatch.className = "lmb-ink-swatch"; swatch.style.backgroundColor = value; swatch.title = value; swatch.setAttribute("aria-label", `颜色 ${value}`); swatch.classList.toggle("is-active", (this.inkColor || "").toLowerCase() === value);
      swatch.addEventListener("click", () => { this.inkColor = value; if (this.inkTool === "highlighter") this.settings.inkHighlighterColor = value; else this.settings.inkPenColor = value; this.lmbApplyInkStyleToSelection("color", value, host); this.lmbPersistInkPreferences(); this.lmbRenderInkTools(); }); swatches.appendChild(swatch);
    }
    content.appendChild(swatches);
    const colorPicker = document.createElement("label"); colorPicker.className = "lmb-ink-color-picker"; colorPicker.title = "自定义颜色";
    const colorIcon = document.createElement("span"); colorIcon.className = "lmb-ink-color-icon"; applyIcon(colorIcon, "palette", "色"); colorPicker.appendChild(colorIcon);
    const colorPreview = document.createElement("span"); colorPreview.className = "lmb-ink-color-preview"; colorPreview.style.backgroundColor = this.inkColor || "#e05252"; colorPicker.appendChild(colorPreview);
    const color = document.createElement("input"); color.type = "color"; color.className = "lmb-ink-color-input"; color.value = this.inkColor || "#e05252"; color.setAttribute("aria-label", "自定义颜色");
    color.addEventListener("change", () => { this.inkColor = color.value; colorPreview.style.backgroundColor = color.value; if (this.inkTool === "highlighter") this.settings.inkHighlighterColor = color.value; else this.settings.inkPenColor = color.value; this.lmbApplyInkStyleToSelection("color", color.value, host); this.lmbPersistInkPreferences(); }); colorPicker.appendChild(color); advanced.appendChild(colorPicker);
    const widthControl = document.createElement("div"); widthControl.className = "lmb-ink-width-control";
    const widthIcon = document.createElement("span"); widthIcon.className = "lmb-ink-width-icon"; applyIcon(widthIcon, "minus", "—"); widthControl.appendChild(widthIcon);
    const isEraser = this.inkTool === "eraser", widthLabel = isEraser ? "橡皮半径" : "粗细";
    const width = document.createElement("input"); width.type = "range"; width.min = isEraser ? "8" : "1"; width.max = isEraser ? "48" : this.inkTool === "highlighter" ? "30" : "14"; width.step = isEraser ? "2" : "1"; width.value = String(isEraser ? Number(this.settings.inkEraserSize) || 18 : this.inkWidth || 3); width.title = `${widthLabel} ${width.value}`; width.setAttribute("aria-label", width.title);
    const widthValue = document.createElement("span"); widthValue.className = "lmb-ink-width-value"; widthValue.textContent = width.value;
    width.addEventListener("input", () => { width.title = `${widthLabel} ${width.value}`; width.setAttribute("aria-label", width.title); widthValue.textContent = width.value; if (isEraser) this.settings.inkEraserSize = Number(width.value); else { this.inkWidth = Number(width.value); if (this.inkTool === "highlighter") this.settings.inkHighlighterWidth = this.inkWidth; else this.settings.inkPenWidth = this.inkWidth; } });
    width.addEventListener("change", () => { if (!isEraser) this.lmbApplyInkStyleToSelection("width", this.inkWidth, host); this.lmbPersistInkPreferences(); }); widthControl.appendChild(width); widthControl.appendChild(widthValue); content.appendChild(widthControl);
    const eraseMode = document.createElement("select"); eraseMode.className = "lmb-ink-eraser-mode"; eraseMode.setAttribute("aria-label", "橡皮模式");
    for (const [value, label] of [["partial", "局部橡皮"], ["stroke", "整笔橡皮"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; eraseMode.appendChild(option); }
    eraseMode.value = this.settings.inkEraserMode || "partial";
    eraseMode.addEventListener("change", () => { this.settings.inkEraserMode = eraseMode.value; this.lmbPersistInkPreferences(); this.lmbRenderInkTools(); }); advanced.appendChild(eraseMode);
    const autoReturn = document.createElement("label"); autoReturn.className = "lmb-ink-auto-return";
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = this.settings.inkEraserAutoReturn !== false;
    check.addEventListener("change", () => { this.settings.inkEraserAutoReturn = check.checked; this.lmbPersistInkPreferences(); }); autoReturn.appendChild(check); autoReturn.appendChild(document.createTextNode("擦完回笔")); advanced.appendChild(autoReturn);
    const stabilityLabel = document.createElement("label"); stabilityLabel.textContent = "跟笔稳定 ";
    const stability = document.createElement("select"); stability.setAttribute("aria-label", "跟笔稳定");
    for (const [value, label] of [[0, "关闭"], [1, "轻"], [2, "标准"], [3, "强"]]) { const option = document.createElement("option"); option.value = String(value); option.textContent = label; stability.appendChild(option); }
    stability.value = String(lmbInkStabilityLevel(this.settings.inkStabilization));
    stability.addEventListener("change", () => { this.settings.inkStabilization = Number(stability.value); this.lmbPersistInkPreferences(); }); stabilityLabel.appendChild(stability); advanced.appendChild(stabilityLabel);
    const leafCanvas = () => this.lmbActiveInkCanvas(host, leaf.view && leaf.view.file && leaf.view.file.path);
    const actions = document.createElement("div"); actions.className = "lmb-ink-actions"; content.appendChild(actions);
    const action = (icon, title, handler, fallback) => { const button = document.createElement("button"); button.type = "button"; button.title = title; button.setAttribute("aria-label", title); applyIcon(button, icon, fallback); button.addEventListener("click", handler); actions.appendChild(button); };
    action("undo-2", "撤销", () => this.lmbUndoInk(leafCanvas()), "↶");
    action("redo-2", "重做", () => this.lmbRedoInk(leafCanvas()), "↷");
    const session = this._lmbInkContinuation;
    if (session && leaf.view?.file?.path === session.path) {
      const continuation = document.createElement("div"); continuation.className = "lmb-ink-selection-actions lmb-ink-continuation";
      const label = document.createElement("span"); label.className = "lmb-ink-link-badge";
      label.textContent = `续写 ${this.lmbInkLinkLabel(session.path, session.exId).replace(/^手写 /, "")} · P.${session.page}`; continuation.appendChild(label);
      const done = document.createElement("button"); done.type = "button"; done.className = "lmb-ink-link-action"; done.textContent = "完成续写";
      done.addEventListener("click", () => this.lmbEndInkContinuation()); continuation.appendChild(done); bar.appendChild(continuation);
    }
    if (this.inkTool === "select" && this._lmbInkSelection && this._lmbInkSelection.length) {
      const selectionTools = document.createElement("div"); selectionTools.className = "lmb-ink-selection-actions";
      const count = document.createElement("span"); count.textContent = `已选 ${this._lmbInkSelection.length} 笔`; selectionTools.appendChild(count);
      const selection = this._lmbInkSelectionContext;
      if (selection) {
        const ids = new Set(this._lmbInkSelection);
        const labels = Object.entries(this.lmbInkLinks(selection.path)).filter(([, link]) => (link.groups || []).some(group => Number(group.page) === Number(selection.page) && lmbInkGroupObjects(this.lmbInkStore()[selection.path], group).some(object => ids.has(object.id)))).map(([exId]) => this.lmbInkLinkLabel(selection.path, exId));
        if (labels.length) { const badge = document.createElement("span"); badge.className = "lmb-ink-link-badge"; badge.textContent = labels.join(" / "); selectionTools.appendChild(badge); }
      }
      action("link", "将所选笔迹关联已有摘录", () => this.lmbChooseInkExcerpt(), "关联");
      const associate = actions.lastElementChild; associate.className = "lmb-ink-link-action"; associate.appendChild(document.createTextNode("关联摘录")); selectionTools.appendChild(associate);
      const drag = document.createElement("button"); drag.type = "button"; drag.className = "lmb-ink-link-action lmb-ink-link-drag"; drag.textContent = "拖到摘录";
      drag.title = "按住拖到侧栏摘录卡片；也可点击后再点目标卡片";
      drag.addEventListener("pointerdown", event => this.lmbStartInkAssociationDrag(event));
      drag.addEventListener("click", () => { if (!drag._lmbSuppressClick) this.lmbChooseInkExcerpt(); });
      selectionTools.appendChild(drag);
      action("sticky-note", "用所选笔迹新建手写备注", () => this.lmbCreateInkNoteFromSelection(), "新建");
      const create = actions.lastElementChild; create.className = "lmb-ink-link-action"; create.appendChild(document.createTextNode("新建手写")); selectionTools.appendChild(create);
      bar.appendChild(selectionTools);
    }
    const more = document.createElement("button"); more.type = "button"; more.title = "更多工具与笔迹设置"; more.setAttribute("aria-label", more.title); more.setAttribute("aria-expanded", String(!!this._lmbInkToolsExpanded)); applyIcon(more, "ellipsis", "…");
    more.addEventListener("click", () => { this._lmbInkToolsExpanded = !this._lmbInkToolsExpanded; this.lmbRenderInkTools(); }); actions.appendChild(more);
    action("trash-2", "删除所选", () => this.lmbDeleteInkSelection(leafCanvas()), "删");
    bar.appendChild(advanced);
    const status = document.createElement("span"); status.className = "lmb-ink-save-status"; content.appendChild(status); host.appendChild(bar);
  }
  this.lmbUpdateInkSaveStatus();
};

LuciasMarginBookPlugin.prototype.lmbSetupInk = function () {
  this._lmbInkObservedPages = new Set();
  if (typeof IntersectionObserver !== "undefined") {
    this._lmbInkVisibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pageEl = entry.target, context = pageEl._lmbInkPageContext;
        pageEl._lmbInkNearViewport = entry.isIntersecting;
        if (!this._unloaded && entry.isIntersecting && pageEl.isConnected && context) this.lmbEnsureInkLayer(pageEl, context.path, context.index);
      }
    }, { rootMargin: "300px" });
  }
  this.inkTool = this.settings.inkLastTool || "pen"; this.inkColor = this.settings.inkPenColor || "#e05252"; this.inkWidth = Number(this.settings.inkPenWidth) || 3; this._lmbInkSelection = [];
  this._lmbInkLastDrawTool = ["pen", "highlighter", "line", "rect"].includes(this.inkTool) ? this.inkTool : "pen";
  const palms = new Set();
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "click"]) this.registerDomEvent(document, type, event => {
    if (!this.inkMode || event.pointerType !== "touch" || lmbInkIsStylusInput(event)) return;
    if (type === "pointerdown") {
      palms.delete(event.pointerId);
      if (this._lmbInkPenActive || Date.now() < (this._lmbInkPalmUntil || 0) || Number(event.width) > 45 || Number(event.height) > 45) palms.add(event.pointerId);
    }
    if (!palms.has(event.pointerId)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (type === "click" || type === "pointercancel") palms.delete(event.pointerId);
  }, { capture: true, passive: false });
  // Synthetic clicks after a stroke must not open a Markdown editor or trigger
  // its outside-click exit. Existing text editors keep their own event path.
  this.registerDomEvent(document, "click", event => {
    const target = event.target;
    if (!this.inkMode || this.inkTool === "hand" || this._lmbInkSpacePan || !target || !target.closest) return;
    if (target.closest(".page") && !target.closest(".is-editing,.lmb-pdf-text-tools,.lmb-ink-text-editor")) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  try { document.body.toggleClass("lmb-ink-capture", this.inkMode && this.inkTool !== "hand"); } catch (_) {}
  this.registerDomEvent(document, "keydown", (event) => {
    if (lmbInkIsTextInput(event.target) || event.isComposing) return;
    if (event.code === "Space" && this.inkMode && !/INPUT|TEXTAREA/.test(event.target && event.target.tagName || "")) {
      this._lmbInkSpacePan = true;
      try { document.body.removeClass("lmb-ink-capture"); } catch (_) {}
      this.lmbRefreshInkLayers();
    }
    if (event.target && event.target.classList && event.target.classList.contains("lmb-ink-text-editor")) return;
    if (event.key === "Escape" && this.inkMode) { this.lmbSetInkMode(false); return; }
    if (!this.inkMode) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { const changed = event.shiftKey ? this.lmbRedoInk() : this.lmbUndoInk(); if (changed) event.preventDefault(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y" && this.lmbRedoInk()) event.preventDefault();
    else if ((event.key === "Delete" || event.key === "Backspace") && this.lmbDeleteInkSelection(this.lmbActiveInkCanvas())) event.preventDefault();
  }, true);
  this.registerDomEvent(document, "keyup", (event) => { if (event.code === "Space") { this._lmbInkSpacePan = false; try { document.body.toggleClass("lmb-ink-capture", this.inkMode && this.inkTool !== "hand"); } catch (_) {} this.lmbRefreshInkLayers(); } }, true);
  const finishInterruptedInk = () => document.querySelectorAll(".page[data-lmb-ink-bound]").forEach(page => { if (page._lmbFinishInk) page._lmbFinishInk(); });
  this.registerDomEvent(window, "blur", () => { finishInterruptedInk(); this._lmbInkSpacePan = false; try { document.body.toggleClass("lmb-ink-capture", this.inkMode && this.inkTool !== "hand"); } catch (_) {} this.lmbRefreshInkLayers(); }, true);
  this.registerDomEvent(document, "visibilitychange", () => { if (document.hidden) finishInterruptedInk(); });
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of Array.from(record.removedNodes || [])) {
      if (!node || node.nodeType !== 1) continue;
      const pages = [];
      if (node.matches && node.matches(".page")) pages.push(node);
      if (node.querySelectorAll) pages.push(...node.querySelectorAll(".page"));
      for (const pageEl of pages) {
        if (pageEl.isConnected) continue;
        if (pageEl._lmbFinishInk) pageEl._lmbFinishInk();
        if (pageEl._lmbInkInputAbort) pageEl._lmbInkInputAbort.abort();
        delete pageEl.dataset.lmbInkBound; delete pageEl._lmbInkInputSurface; delete pageEl._lmbInkStaticSurface;
        this.lmbReleaseTextBlockPage(pageEl);
        clearTimeout(pageEl._lmbInkResizeTimer);
        if (this._lmbInkVisibilityObserver) this._lmbInkVisibilityObserver.unobserve(pageEl);
        this._lmbInkObservedPages.delete(pageEl);
        delete pageEl._lmbInkNearViewport;
        if (pageEl._lmbInkResizeObserver) { pageEl._lmbInkResizeObserver.disconnect(); pageEl._lmbInkResizeObserver = null; }
        if (this._lmbInkSelectionContext && pageEl.contains && pageEl.contains(this._lmbInkSelectionContext.canvas)) { this._lmbInkSelection = []; this._lmbInkSelectionContext = null; }
      }
    }
    const relevant = records.some((record) => {
      const nodes = Array.from(record.addedNodes || []);
      if (nodes.some(node => node.nodeType === 1 && (node.matches?.(".page,.pdf-viewer-container") || node.querySelector?.(".page")))) return true;
      // PDF.js reset() can remove our canvases while retaining the same page.
      // Do not react to our own layer additions, which would form a refresh loop.
      const page = record.target.closest?.('.page');
      return page?.isConnected && (Array.from(record.removedNodes || []).some(node => node.nodeType === 1 && (node.matches?.('.lmb-ink-layer,.lmb-ink-live-layer') || node.querySelector?.('.lmb-ink-layer,.lmb-ink-live-layer')))
        || nodes.some(node => node.nodeType === 1 && node.matches?.('.canvasWrapper,.textLayer,.annotationLayer')));
    });
    if (relevant) this.lmbScheduleInkRefresh(60);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  this.register(() => {
    document.querySelectorAll(".page[data-lmb-ink-bound]").forEach(page => { if (page._lmbFinishInk) page._lmbFinishInk(); });
    if (this._lmbInkVisibilityObserver) this._lmbInkVisibilityObserver.disconnect();
    for (const pageEl of this._lmbInkObservedPages) clearTimeout(pageEl._lmbInkResizeTimer);
    this._lmbInkObservedPages.clear();
    observer.disconnect(); clearTimeout(this._lmbInkSaveTimer); clearTimeout(this._lmbInkPrefsTimer); this.lmbFlushInkStorage().catch(() => {});
    document.querySelectorAll(".lmb-ink-tools").forEach((element) => element.remove());
    document.querySelectorAll(".page[data-lmb-ink-bound]").forEach((pageEl) => {
      this.lmbUpdateInkPageCapture(pageEl, true);
      if (pageEl._lmbInkInputAbort) pageEl._lmbInkInputAbort.abort();
      if (pageEl._lmbInkResizeObserver) pageEl._lmbInkResizeObserver.disconnect();
      pageEl._lmbInkResizeObserver = null;
      pageEl.querySelectorAll(":scope > .lmb-ink-layer,:scope > .lmb-ink-live-layer").forEach(layer => { if (layer._lmbInkFrame) cancelAnimationFrame(layer._lmbInkFrame); if (layer._lmbInkStaticFrame) cancelAnimationFrame(layer._lmbInkStaticFrame); layer.remove(); });
      delete pageEl.dataset.lmbInkBound; delete pageEl._lmbInkInputSurface; delete pageEl._lmbInkStaticSurface; delete pageEl._lmbInkInputAbort; delete pageEl._lmbFinishInk;
    });
  });
};
