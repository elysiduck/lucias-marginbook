/* 30-plugin-core —— 插件类核心：构造器/生命周期/设置/样式注入 */

class LuciasMarginBookPlugin extends Plugin {

  async onload() {
    this._unloaded = false;          // v0.16.5 R8：卸载后异步链的退出标记
    this.runtimeState = new LmbRuntimeState();
    this.runtimeState.attach(this);
    this.chipEl = null;
    this._saveTimer = null;
    this._chipSig = null;            // 当前 chip 承载的选区签名（text@page），防重复重建
    this._lastNoSelNotice = 0;
    this.rectMode = false;           // 框选模式（v0.11.2 起为常驻开关：ribbon/工具栏按钮/命令共用）
    this.inkMode = false;            // PDF 手写批注模式（非破坏式，数据保存在插件 data.json）
    this.isMobile = LMB_IS_MOBILE;
    this._mobileSelectionTimer = null;
    this._ribbonEl = null;
    this._toolbarBtnTimer = null;    // v0.11.2：PDF 工具栏按钮注入的重试定时器
    // v0.12.1：工具栏宿主 DOM 缓存（LmbDomCache，见 25-pure-toolbar.js）
    //   key = leaf 对象本身（一个 leaf 一份工具栏，绝不能用 "pdf" 这种全局单例 key）
    //   value = 该 leaf 解析出来的工具栏宿主 el（get() 内部用 isConnected 自动判失效）
    this._toolbarCache = new LmbDomCache();
    this._dragArm = null;            // 我们的 chip 拖拽进行中（drop 捕获用）
    this._instantSkip = 0;           // 即时通道成功后短暂抑制文件层自动父子（防双写）
    this._dropFlush = null;          // v0.7.2：canvas 内松手后的快速通道 {path, t, timer}
    this._lmbPdfSidebarTimer = null; // PDF 右侧批注侧栏防抖定时器
    this._lmbCachePruneDirty = false;
    this._lmbRuntimeStateDirty = true;

    // P1：摘录索引层（反向索引：摘录 md → PDF/页/选区）
    this._isIndexing = false;        // 全量重建进行中标记（防重入）
    // P3.5：exId -> canvas 卡片位置（反向跳转优先进画布，而非 md）

    // 补丁 B：相关笔记缓存 + 颜色归一化上下文（须在 settings 与 canvas 监听之前就绪）
    this._colorCtx = null;           // 颜色归一化用的离屏 canvas 2d context（惰性创建）
    this.settingsStore = new LmbSettingsStore(this);
    const loadedSettings = await this.settingsStore.load();
    this.settings = loadedSettings.settings;
    const inkStorageMigrated = await this.lmbInitializeInkStorage();
    this.lmbSetupInk();
    const inkLinkNumbersMigrated = this.lmbInitializeInkLinkNumbers();
    this.lmbSetupInkReferences();
    this.lmbSetupTextBlocks();
    // v0.12.0 一次性迁移：老配置里 noteAutoBoxOnNew 已被持久化成 true，
    //   只改默认值不生效。用标记保证只强制关这一次，之后用户在设置里改回 true 不再被覆盖。
    let settingsMigrated = loadedSettings.migrated || inkStorageMigrated || inkLinkNumbersMigrated;
    // v0.16.0 一次性迁移（与上面同一套机制）：老配置里 commentAutoBoxOnNew 已被持久化成 true，
    //   只改默认值对存量用户不生效。强制关这一次，之后用户在设置里改回 true 不再被覆盖。
    // 两项迁移合并成一次有序写入，避免并发 saveData 互相覆盖。
    if (settingsMigrated) await this.saveSettings();
    // 补丁 C：Recall 回忆模式状态（settings.recallDefault = 是否默认开启）
    this.recallMode = !!this.settings.recallDefault;
    try {
      if (this.settings.autoSizes) {
        for (const [path, entries] of Object.entries(this.settings.autoSizes)) {
          this.autoSize.set(path, new Map(entries));
        }
      }
      if (this.settings.imgDims) {
        for (const [k, v] of Object.entries(this.settings.imgDims)) this.imgDims.set(k, v);
      }
      // v0.7.0：恢复持久化的画布节点位置档案（用于位置 diff 识别「刚被拖动」的卡）
      if (this.settings.canvasPositions) {
        for (const [p, entries] of Object.entries(this.settings.canvasPositions)) {
          this.canvasPositions.set(p, new Map(entries));
        }
      }
      // v0.7.1：恢复持久化的「自动建边 id」档案（跨重载识别哪些边是插件自动建的，可清理）
      if (this.settings.autoEdges) {
        for (const [p, ids] of Object.entries(this.settings.autoEdges)) {
          this.autoEdges.set(p, new Set(ids));
        }
      }
    } catch (_) { /* noop */ }
    // Loaded persisted maps need one cleanup pass; subsequent saves only prune
    // after a vault delete/rename instead of scanning the whole vault every time.
    this._lmbCachePruneDirty = true;
    this._lmbRuntimeStateDirty = true;

    // v0.16.12：旧缓存中的 hash 与文本仍相同；若不失效，新算法永远没有机会运行。
    // 保留 locked（用户明确手动锁定）的卡片，其余只标成 pendingActual，等待对应画布
    // 渲染后定点实测，不在启动时直接改文件，也不会触碰卡片坐标。
    if (!this.settings.naturalHeightV2Migrated) {
      for (const store of this.autoSize.values()) {
        for (const [id, entry] of store.entries()) {
          if (!entry || entry.locked) continue;
          store.set(id, Object.assign({}, entry, { pendingActual: true }));
        }
      }
      this.settings.naturalHeightV2Migrated = true;
      await this.saveSettings();
    }
    if (!this.settings.overflowHeightVerifiedMigrated) {
      for (const store of this.autoSize.values()) {
        for (const [id, entry] of store.entries()) {
          if (!entry || entry.locked) continue;
          store.set(id, Object.assign({}, entry, { pendingActual: true }));
        }
      }
      this.settings.overflowHeightVerifiedMigrated = true;
      await this.saveSettings();
    }

    if (this.isMobile) {
      this.registerDomEvent(document, "pointerdown", (e) => this.onDocPointerDown(e), true);
      this.registerDomEvent(document, "pointerup", (e) => this.onDocPointerUp(e), true);
      // iOS selection handles can change the selection without another pointerup.
      this.registerDomEvent(document, "selectionchange", () => this.onMobileSelectionChange(), true);
    } else {
      this.registerDomEvent(document, "mousedown", (e) => this.onDocMouseDown(e), true);
      this.registerDomEvent(document, "mouseup", (e) => this.onDocMouseUp(e), true);
    }
    this.registerDomEvent(document, "scroll", (e) => {
      this.hideChip();
      this.lmbHandlePdfSidebarScroll(e);
    }, true);
    // PDF 标记本身不抢占文字选择；在捕获层按坐标命中标记，实现 PDF → 边页定位。
    this.registerDomEvent(document, "click", (e) => this.lmbHandlePdfSidebarClick(e), true);

    // v0.7.2 松手快速通道：canvas 内 mouseup → 武装 flush，让下一个 modify 走 80ms 极短防抖
    // （原本要干等 400ms 才重排）。capture 阶段注册，早于 Obsidian 自己的 canvas mouseup。
    // v0.9.3：再加内存级即时通道 —— mouseup 后不等 Obsidian 落盘，直接在 canvas 内存数据上
    // 做父子判定 + 组排布（setData 毫秒级生效），落盘管线退为兜底。
    this.registerDomEvent(document, "mouseup", (e) => {
      try {
        const f = this.canvasFileFromEvent(e);
        if (f) this.armDropFlush(f);
        if (e.button === 0) {
          // v0.11.1：canvasCtxFromEvent 同时拿 file 与 canvasObj（避开 canvasObj.view 的填值时机坑）
          const ctx = this.canvasCtxFromEvent(e);
          if (ctx && ctx.canvasObj) {
            this.instantMoveAttach(ctx.canvasObj, ctx.file).catch((err) =>
              console.warn("[lmb] instant move error:", err));
          }
        }
      } catch (_) { /* noop */ }
      try { this.lmbCanvasBarTick(); } catch (_) { /* event-driven bar refresh */ }
    }, true);

    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f instanceof TFile && f.extension === "canvas") {
        // v0.16.4 修复 P2-4：selfWritten 的值改为写入时刻的时间戳。
        //   旧版存 true 且靠下一次 modify 清除——若该 modify 未触发，残留标志会吞掉
        //   用户的下一次真实修改。现在超过 5s 的旧标志不再吞。
        const selfT = this.selfWritten.get(f.path);
        if (selfT) {
          this.selfWritten.delete(f.path);
          if (Date.now() - selfT < 5000) return;
        }
        // v0.7.2 快速通道：刚在 canvas 松手 → 用 80ms 而非 400ms（省 ~320ms 延迟）
        const flush = this._dropFlush;
        if (flush && flush.path === f.path && Date.now() - flush.t < 1500) {
          if (flush.timer) clearTimeout(flush.timer);
          this._dropFlush = null;
          const old = this.syncTimers.get(f.path);
          if (old) clearTimeout(old);
          this.syncTimers.set(f.path, setTimeout(() => {
            this.syncTimers.delete(f.path);
            this.processCanvas(f).catch((err) =>
              console.error("[lmb] canvas process failed:", err));
          }, 80));
          return;
        }
        this.scheduleCanvasSync(f);
      }
    }));

    // v0.5.0 即时通道：捕获我们的 chip 落进 canvas 的 drop 事件，走 canvas 内部 API
    // （getData/setData/requestSave）直接改内存数据，毫秒级生效；
    // 内部 API 缺失/超时/没压中卡 → 静默退回文件层管线（250ms + 出生重试）。
    // v0.11.1：canvasCtxFromEvent 同时拿 file → 即时通道建边时直接登记 sidecar，
    //   不再依赖 canvasObj.view 是否已挂 .file（polling 早期可能为 null）
    this.registerDomEvent(document, "drop", (e) => {
      try {
        if (!this._dragArm) return;
        const target = e.target && e.target.nodeType === 1 ? e.target : null;
        if (!target) return;
        const ctx = this.canvasCtxFromEvent(e);
        if (!ctx || !ctx.canvasObj) {
          console.log("[lmb] canvas 内部 API 不可用 → 文件层兜底（250ms）");
          return;
        }
        this.instantAttach(ctx.canvasObj, ctx.file).catch((err) => console.warn("[lmb] instant attach error:", err));
      } catch (err) {
        console.warn("[lmb] drop capture error:", err);
      }
    }, true);

    // v0.11.2：PDF 原生工具栏注入「图片框选」按钮（PDF++ 式 crop 按钮，摆脱 Alt）。
    //   工具栏由 pdf.js 异步渲染，所以在布局事件后做有限次重试（lmbScheduleToolbarButtons）。
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.lmbScheduleToolbarButtons();
      this.lmbSchedulePdfSidebarRefresh(220);
      this.lmbScheduleInkRefresh(220);
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.lmbScheduleToolbarButtons();
      this.lmbSchedulePdfSidebarRefresh(120);
      this.lmbScheduleInkRefresh(120);
      this.lmbRenderActivePdfSidebar().catch(() => {});
      this.lmbScheduleVisibleCanvasFits();
    }));
    this.registerEvent(this.app.workspace.on("file-open", (f) => {
      if (f && f.extension === "canvas") this._scheduleActualFitRetry(f);
      if (f && f.extension === "pdf") {
        this.lmbScheduleToolbarButtons();
        this.lmbSchedulePdfSidebarRefresh(180);
        this.lmbScheduleInkRefresh(180);
      }
    }));

    // v0.11.2：Esc 退出框选模式（与按钮开关对称；Alt 临时拖拽不受影响）
    this.registerDomEvent(document, "keydown", (e) => {
      if (e.key === "Escape" && this.rectMode) {
        this.setRectMode(false);
        new Notice("MarginBook: 图片框选模式已关闭", 2000);
      }
    }, true);

    // 侧边栏按钮：图片框选模式（v0.11.2 起为常驻开关：再点一次/Esc 关闭，截图后不自动关）
    this._ribbonEl = this.addRibbonIcon("scan-search", "MarginBook: 图片框选（点击开启，直接在 PDF 上拖拽截图；再点一次/Esc 关闭）", () => {
      this.setRectMode(!this.rectMode);
      new Notice(this.rectMode
        ? "MarginBook: 图片框选模式已开启 —— 在 PDF 上直接拖拽即可（再点一次/Esc 关闭）"
        : "MarginBook: 图片框选模式已关闭", 3000);
    });
    if (this._ribbonEl) this._ribbonEl.addClass("lmb-btn");

    /* v0.8.1：侧边栏按钮 —— 给（画布里选中的）卡片添加/编辑补充描述。
     *   用户偏好 GUI 胜过 CLI（记命令费劲），所以把 edit-card-note 命令也挂到侧边栏。
     *   按钮状态跟随「当前是否在 canvas 视图」：在画布里高亮，不在则灰（点了会提示）。 */
    this._noteRibbonEl = this.addRibbonIcon("message-square",
      "MarginBook: 给卡片添加 / 编辑补充描述（需在画布里选中一张卡）", () => {
        this.runCardNoteCommand("edit").catch((err) => {
          console.error("[lmb] note command failed:", err);
          new Notice("补充描述操作失败，详情见控制台");
        });
      });
    if (this._noteRibbonEl) this._noteRibbonEl.addClass("lmb-btn");
    this.updateNoteRibbonState();
    // 切换视图时刷新按钮可用性（灰/亮）
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.updateNoteRibbonState();
      try { this.lmbCanvasBarTick(); } catch (_) { /* noop */ }
    }));

    /* v0.11.0：侧边栏按钮 —— 给（画布里选中的）卡片添加/编辑评论（独立评论体系）。 */
    this._commentRibbonEl = this.addRibbonIcon("message-square-plus",
      "MarginBook: 给卡片添加 / 编辑评论（需在画布里选中一张卡）", () => {
        this.runCardCommentCommand("edit").catch((err) => {
          console.error("[lmb] comment command failed:", err);
          new Notice("评论操作失败，详情见控制台");
        });
      });
    if (this._commentRibbonEl) this._commentRibbonEl.addClass("lmb-btn");

    // v0.11.0：canvas 里点「评论栏」直接弹编辑框（capture 层，折叠箭头/非 canvas 不拦截）
    this.registerDomEvent(document, "click", (e) => this.onCanvasCalloutClick(e), true);
    this.registerMarkdownPostProcessor((el, ctx) => {
      this.lmbEnhanceExcerptCallouts(el, ctx).catch((err) => console.warn("[lmb] excerpt note action failed:", err));
    });

    /* ---- P1：摘录索引的增量维护 ----
     * modify 会在每次敲键触发，所以 reindexFile 内有两道廉价闸门
     * （不链 pdf 且不在索引中 → 跳过；mtime 未变 → 跳过），不会读盘。
     */
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f && f.extension === "md") this.lmbInvalidateRelatedFile(f);
      if (f && f.extension === "canvas") this.lmbScheduleCanvasIndex(f); // P3.5 canvas 索引（v0.16.5 R7 防抖）
      else this.reindexFile(f);
    }));
    this.registerEvent(this.app.vault.on("create", (f) => {
      if (f && f.extension === "md") this.lmbInvalidateRelatedFile(f);
      if (f && f.extension === "canvas") this.lmbIndexCanvasFile(f);
      else this.reindexFile(f);
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      if (!f) return;
      this._lmbCachePruneDirty = true;
      if (f.extension === "md") this.lmbInvalidateRelatedFile(f);
      if (f.extension === "canvas") {
        for (const [k, v] of Array.from(this.excerptCanvasIndex.entries())) {
          if (v && v.canvasPath === f.path) this.excerptCanvasIndex.delete(k);
        }
      } else this.dropFileFromIndex(f.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
      this._lmbCachePruneDirty = true;
      if ((f && f.extension === "md") || /\.md$/i.test(oldPath || "")) {
        this.lmbInvalidateRelatedFile(f, oldPath);
      }
      if (f && f.extension === "pdf") this.lmbHandleInkPdfRename(f, oldPath).catch((err) => console.warn("[lmb] PDF ink rename failed", err));
    }));
    if (this.app.metadataCache && this.app.metadataCache.on) {
      this.registerEvent(this.app.metadataCache.on("changed", (f) => {
        if (f && f.extension === "md") this.lmbInvalidateRelatedFile(f);
      }));
    }
    this.app.workspace.onLayoutReady(() => {
      this.buildExcerptIndex();
      // v0.11.2：启动时若 PDF 已打开（layout-change/file-open 不会补发），也要注入工具栏按钮
      this.lmbScheduleToolbarButtons();
      this.lmbScheduleInkRefresh(250);
      // v0.17.0：启动时即使用户在恢复的工作区里已经停留在 PDF，也要补一次侧栏渲染。
      this.lmbSchedulePdfSidebarRefresh(250);
      // v0.13.0：启动 canvas 卡片悬浮栏轮询（每 120ms 比对选中集合与视口状态）
      if (typeof this.lmbStartCanvasBarWatch === "function") this.lmbStartCanvasBarWatch();
      this.lmbScheduleVisibleCanvasFits();
    });

    /* ---- P2：回绘标记的触发时机 ----
     * 注意 pdf.js 虚拟化：不能假设"打开 PDF 就能画"。
     * ① file-open：打开文件后等 300ms 让 pdf.js 渲出首页
     * ② layout-change / active-leaf-change：切标签页、改布局时重画
     * ③ MutationObserver（lmbSetupObserver）：滚动虚拟化增删页面时重画
     */
    this.registerEvent(this.app.workspace.on("file-open", (f) => {
      if (f && f.extension === "pdf") this.lmbScheduleMarksRefresh(300);
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.lmbScheduleMarksRefresh(250);
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.lmbScheduleMarksRefresh(250);
    }));

    // P3：接管 pdf 链接（主力 = DOM 捕获层拦截，优先级高于一切其他插件；openLinkText 劫持作兜底）
    this.lmbSetupLinkInterception();

    this.addCommand({
      id: "rect-select-mode",
      name: "图片框选模式（开关，开启后直接拖拽截图）",
      callback: () => {
        this.setRectMode(!this.rectMode);
        new Notice(this.rectMode
          ? "MarginBook: 图片框选模式已开启 —— 在 PDF 上直接拖拽即可（再点一次/Esc 关闭）"
          : "MarginBook: 图片框选模式已关闭", 3000);
      }
    });
    this.addCommand({
      id: "pdf-ink-mode",
      name: "PDF 手写批注模式（开关）",
      callback: () => this.lmbSetInkMode(!this.inkMode)
    });
    this.addCommand({ id: "pdf-ink-undo", name: "PDF 手写批注：撤销当前页上一笔", callback: () => this.lmbUndoInk() });
    this.addCommand({ id: "pdf-ink-redo", name: "PDF 手写批注：重做当前页操作", callback: () => this.lmbRedoInk() });
    this.addCommand({ id: "pdf-ink-clear-page", name: "PDF 手写批注：清除当前页", callback: () => this.lmbClearInk() });

    // 补丁 C：Recall 回忆模式开关：模糊摘录 blockquote，点击揭示（借鉴 MarginNote 4.4）
    this.addCommand({
      id: "recall-toggle",
      name: "回忆模式：开关（模糊摘录，点击揭示）",
      callback: () => {
        try {
          this.recallMode = !this.recallMode;
          if (!this.recallMode) {
            // 关闭时立即清除页面上已模糊的元素（无需等重新渲染）
            document.querySelectorAll(".lmb-recall-blur").forEach((n) => {
              n.classList.remove("lmb-recall-blur", "lmb-recall-reveal");
              if (n._ppdReblurTimer) clearTimeout(n._ppdReblurTimer);
            });
          } else {
            // v0.16.5 修复 R4：开启侧此前什么都没做 —— MarkdownPostProcessor 只在
            //   **渲染时**跑一次，已打开的阅读视图不会重渲染 → 用户开了 Recall 却
            //   看不到任何模糊，必须手动切走再切回才生效。现在主动触发一次重渲染。
            this.lmbRerenderRecallViews();
          }
          new Notice(this.recallMode
            ? "回忆模式已开启：摘录已模糊，点击揭示（3 秒后重新模糊）"
            : "回忆模式已关闭", 3000);
        } catch (err) {
          console.warn("[lmb] recall toggle error:", err);
        }
      }
    });

    // 补丁 C：直达当前 PDF 的摘录文档（<PDF名>-摘录.md）
    this.addCommand({
      id: "open-excerpt-doc",
      name: "打开当前 PDF 的摘录文档",
      checkCallback: (checking) => {
        try {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "pdf") return false; // 非活动 PDF 时置灰
          if (checking) return true;
          if (this.settings.storageLayout === "central") {
            this.lmbOpenOrCreateExcerptMd(file).catch(err => new Notice("无法打开摘录文档：" + err.message));
            return true;
          }
          // v0.9.1：同名摘录 md 可能撞名（命名按 basename，跨目录会重）。
          //   优先取与 PDF 同目录的；仍有多个 → 弹选择器让用户挑，不再静默取第一个。
          const all = this.app.vault.getMarkdownFiles()
            .filter((f) => f.basename === file.basename + "-摘录");
          if (!all.length) {
            new Notice("尚未生成摘录文档（先拖一条摘录到画布）");
            return true;
          }
          const pdfDir = file.parent && file.parent.path ? file.parent.path : "/";
          const sameFolder = all.find((f) => f.parent && f.parent.path === pdfDir);
          const picks = sameFolder ? [sameFolder] : all;
          if (picks.length === 1) {
            this.app.workspace.openLinkText(picks[0].path, "", false);
          } else {
            new LMBNodeSuggester(this.app,
              picks.map((f) => ({ label: f.path, path: f.path })),
              (it) => this.app.workspace.openLinkText(it.path, "", false));
          }
          return true;
        } catch (err) {
          console.warn("[lmb] open-excerpt-doc error:", err);
          return false;
        }
      }
    });

    this.addCommand({
      id: "copy-selection-as-quote",
      name: "复制当前 PDF 选区为引用块（含回跳链接）",
      checkCallback: (checking) => {
        const sel = window.getSelection();
        const info = sel && !sel.isCollapsed ? this.extractSelection(sel) : null;
        if (checking) return !!info;
        if (info) {
          navigator.clipboard.writeText(this.buildDropText(info));
          new Notice("已复制引用块到剪贴板");
        }
        return true;
      }
    });

    // v0.6.0：规范化当前画布上已有的重叠摘录卡片。
    //   扫描当前打开的 canvas（或全 vault），对每对重叠的 ^ex 卡建父子边，
    //   按 (parent, side) 全组重排（v0.9.3 起为贴边对齐 + 以父卡中心对称轴组居中，
    //   不再拉伸子卡尺寸），写回画布文件。重复运行幂等。
    this.addCommand({
      id: "normalize-existing-excerpts",
      name: "规范化画布上已有的重叠摘录卡片（贴边对齐+组居中）",
      callback: async () => {
        await this.normalizeOverlappingExcerpts();
      }
    });
    this.addCommand({ id: "layout-tree-right", name: "将当前 Canvas 排为从左到右知识树", callback: () => this.lmbApplyTreeLayout("right") });
    this.addCommand({ id: "layout-tree-down", name: "将当前 Canvas 排为自上而下知识树", callback: () => this.lmbApplyTreeLayout("down") });

    /* ---- v0.8.0：卡片补充描述（note）三条命令 ---- */
    this.addCommand({
      id: "edit-card-note",
      name: "给卡片添加 / 编辑补充描述",
      callback: async () => { await this.runCardNoteCommand("edit"); }
    });
    this.addCommand({
      id: "remove-card-note",
      name: "移除卡片的补充描述",
      callback: async () => { await this.runCardNoteCommand("remove"); }
    });
    this.addCommand({
      id: "toggle-card-note-fold",
      name: "折叠 / 展开卡片的补充描述",
      callback: async () => { await this.runCardNoteCommand("fold"); }
    });
    // v0.8.2：批量入口 —— 一条命令给当前画布所有摘录卡挂上空的补充描述框，
    // 让用户不依赖侧边栏按钮也能立刻看到效果（ribbon 在某些环境不出现）。
    this.addCommand({
      id: "add-note-box-to-all",
      name: "给画布上所有摘录卡添加补充描述框",
      callback: async () => { await this.addNoteBoxToAllCards(); }
    });

    /* ---- v0.13.9：卡片高度自适应命令（悬浮栏之外的独立入口）----
     * 为什么单独加命令：悬浮栏按钮链路排查了 5 版（v0.13.4→v0.13.8）用户仍反馈
     * "完全没反应、Notice 也不弹"，无法定位是按钮 DOM 的问题还是 fit 逻辑的问题。
     * 命令面板是 Obsidian 最稳的入口（不依赖任何自建 DOM）——
     *   命令能用  → fit 逻辑没问题，问题锁定在悬浮栏链路
     *   命令也坏  → fit 逻辑本身有问题，换方向修
     * 无论哪种结果都能立刻收敛，而且命令本身就是一个永久可用的备选入口。 */
    this.addCommand({
      id: "fit-card-height",
      name: "调整选中卡片高度（按内容自适应）",
      callback: () => { this.lmbFitSelectedCard(); }
    });

    /* ---- v0.11.0：独立评论（批注评论底栏）命令 ---- */
    this.addCommand({
      id: "edit-card-comment",
      name: "给卡片添加 / 编辑评论",
      callback: async () => { await this.runCardCommentCommand("edit"); }
    });
    this.addCommand({
      id: "remove-card-comment",
      name: "移除卡片的评论",
      callback: async () => { await this.runCardCommentCommand("remove"); }
    });
    this.addCommand({
      id: "add-comment-box-to-all",
      name: "给画布上所有摘录卡添加评论栏",
      callback: async () => { await this.addCommentBoxToAllCards(); }
    });

    /* ---- P1：摘录索引 ---- */
    this.addCommand({
      id: "lmb-rebuild-index",
      name: "重建摘录索引",
      callback: async () => {
        const s = await this.buildExcerptIndex();
        new Notice("MarginBook: 索引已重建 —— PDF " + s.pdfs
          + " 个 / 摘录 " + s.excerpts + " 条 / 文件 " + s.files + " 个");
      }
    });
    this.addCommand({
      id: "lmb-index-stats",
      name: "显示摘录索引统计",
      callback: () => {
        const s = this.getIndexStats();
        new Notice("MarginBook: PDF " + s.pdfs
          + " 个 / 摘录 " + s.excerpts + " 条 / 已索引文件 " + s.files + " 个");
      }
    });

    // P2：强制刷新摘录标记（解决标记消失 / 没画出来的兜底入口）
    this.addCommand({
      id: "lmb-refresh-marks",
      name: "强制刷新摘录标记",
      callback: () => { this.lmbRefreshAllMarks(); }
    });

    this.addSettingTab(new LMBSettingTab(this.app, this));
    this.injectStyles();
    try { document.body.toggleClass("lmb-mobile", !!this.isMobile); } catch (_) {}

    // 补丁 C：Recall——阅读模式下把含「【文件名-P.数字】」回跳链接的 blockquote 模糊化。
    // 揭示策略 = 点击后展示 3 秒自动重新模糊：
    //   ① 单向流程，无"再点一次是隐藏还是保持"的歧义，不易误触；
    //   ② 更贴 Recall 训练节奏（回忆 → 自动再藏）；定时器挂在元素上，重复点击只续期不叠加。
    this.registerMarkdownPostProcessor((el, ctx) => {
      try {
        if (!this.recallMode) return;
        let quotes = el.querySelectorAll ? Array.from(el.querySelectorAll("blockquote")) : [];
        if (el.matches && el.matches("blockquote")) quotes.unshift(el); // 片段本身即 blockquote
        for (const bq of quotes) {
          if (bq.dataset.lmbRecall === "1") continue;                    // 防重复处理
          if (!/【[^】]+-P\.\d+】/.test(bq.textContent || "")) continue;  // 仅命中摘录回跳块
          bq.dataset.lmbRecall = "1";
          bq.classList.add("lmb-recall-blur");
          bq.addEventListener("click", (ev) => {
            ev.stopPropagation();
            bq.classList.add("lmb-recall-reveal");
            clearTimeout(bq._ppdReblurTimer);
            bq._ppdReblurTimer = setTimeout(() => {
              bq.classList.remove("lmb-recall-reveal");
            }, 3000);
          });
        }
      } catch (err) {
        console.warn("[lmb] recall postProcessor error:", err);
      }
    });

    if (this.isMobile) new Notice("MarginBook 0.25.6 已加载（视图跳转修复版）", 5000);
    this.debugNotice("已加载 ✓（v0.25.6）");
    console.log("[lmb] loaded (v0.25.6)");
  }

  onunload() {
    this._unloaded = true;
    if (this._lmbNavigation) {
      this._lmbNavigation.cancelled = true;
      this._lmbEndNavigation(this._lmbNavigation);
    }
    this.hideChip();
    this.syncTimers.forEach((t) => clearTimeout(t));
    this.syncTimers.clear();

    // v0.11.2：拆掉 PDF 工具栏注入的框选按钮 + 重试定时器 + body 模式类
    try {
      if (this._toolbarBtnTimer) { clearTimeout(this._toolbarBtnTimer); this._toolbarBtnTimer = null; }
      // v0.16.4 修复 P2-1：此前只删 crop，md / canvas 两颗按钮残留成死按钮
      document.querySelectorAll(".lmb-toolbar-group")
        .forEach((b) => { if (b.parentNode) b.remove(); });
      document.querySelectorAll(".lmb-ink-layer,.lmb-ink-live-layer,.lmb-ink-tools").forEach((layer) => layer.remove());
      // v0.17.0（实验）：清理 PDF 批注侧栏，防止卸载后残留
      this._lmbClearPdfSidebars();
      document.body.removeClass("lmb-rect-mode");
      document.body.removeClass("lmb-ink-mode");
      document.body.removeClass("lmb-ink-capture");
      document.body.removeClass("lmb-mobile");
      // v0.12.1：清掉工具栏宿主的 DOM 缓存（不清的话 Map 里会残留整棵已卸载的 leaf 引用）
      if (this._toolbarCache) this._toolbarCache.clear();
      // v0.13.0：停掉 canvas 悬浮栏轮询 + 移除浮层 DOM
      //   （不清 interval 的话插件卸载后它还会每 120ms 继续跑，且持有已销毁 leaf 的引用）
      if (typeof this.lmbStopCanvasBarWatch === "function") this.lmbStopCanvasBarWatch();
      // v0.16.5 修复 R8：清掉所有自建定时器 + 置卸载标记（异步链入口自行退出）
      this._unloaded = true;
      this._lmbClearTimers();
    } catch (_) { /* noop */ }

    // P3.5：先拆 DOM 层链接拦截（越早越好，避免卸载过程中还拦截点击）
    this.lmbTeardownLinkInterception();

    // v0.9.2：撤掉重叠自愈定时器
    try { if (this._ppdHealTimer) { clearTimeout(this._ppdHealTimer); this._ppdHealTimer = null; } }
    catch (_) { /* noop */ }

    // P2：拆掉所有 MutationObserver、清掉所有回绘标记、撤掉防抖定时器
    try {
      if (this._ppdMarksTimer) { clearTimeout(this._ppdMarksTimer); this._ppdMarksTimer = null; }
      const leaves = this.app.workspace.getLeavesOfType("pdf");
      for (const l of leaves) {
        const v = l && l.view;
        if (!v) continue;
        this.lmbDisconnectObserver(v);
        if (v.containerEl) this.lmbClearMarks(v.containerEl);
      }
      document.querySelectorAll(".lmb-mark").forEach((m) => { if (m.parentNode) m.parentNode.removeChild(m); });

      // P3：拆掉双击监听（openLinkText 的还原走 this.register，无需在此处理）
      for (const t of (this._ppdDblClickTargets || [])) {
        try {
          if (t && t._ppdMarkDblClick) {
            t.removeEventListener("dblclick", t._ppdMarkDblClick);
            t._ppdMarkDblClick = null;
          }
        } catch (_) { /* noop */ }
      }
      this._ppdDblClickTargets = [];
    } catch (err) {
      console.warn("[lmb] onunload cleanup error:", err);
    }

    const st = document.getElementById("lmb-styles");
    if (st) st.remove();
  }

  /* ==================== v0.11.2：框选模式（常驻开关）+ PDF 工具栏按钮 ==================== */

  /**
   * 框选模式统一开关入口：ribbon / 命令 / PDF 工具栏按钮 / Esc 全走这里，
   * 保证三处 UI（ribbon、所有 PDF 工具栏按钮、body 模式类）同步刷新。
   */
  setRectMode(on) {
    this.rectMode = !!on;
    this.updateRibbonState();
  }

  /**
   * v0.11.2：同步所有框选模式 UI。
   *   ribbon 图标 + 每个 PDF 工具栏里注入的 .lmb-toolbar-crop + body.lmb-rect-mode
   *   （body 类供 CSS 把 PDF 页面光标换成 crosshair，给「正在框选」的视觉反馈）。
   */
  updateRibbonState() {
    if (this._ribbonEl) this._ribbonEl.toggleClass("is-active", !!this.rectMode);
    try {
      document.querySelectorAll(".lmb-toolbar-crop").forEach((b) => b.toggleClass("is-active", !!this.rectMode));
      document.body.toggleClass("lmb-rect-mode", !!this.rectMode);
    } catch (_) { /* noop */ }
  }

  /**
   * v0.11.2：工具栏按钮注入的有限重试调度。
   *   pdf.js 的 .pdf-toolbar 在视图打开后异步渲染，单次注入大概率扑空；
   *   这里 250ms × 最多 8 次（2 秒），全部就绪后提前停。
   *
   * v0.12.1：每轮 tick 开头先 prune 工具栏宿主缓存，清掉已被 Obsidian 摘掉的游离节点，
   *   避免关掉分屏后缓存里残留死引用、也保证下一轮对失效 leaf 重新解析。
   *   重试节奏**故意保持不变**：120ms 首延 + 250ms × 最多 8 次（有次数上限 + 有节流），
   *   比 editing-toolbar v4.1.1 那种「裸 setTimeout(200) 无节流重建」更稳 —— 它每个
   *   事件都全量重建一遍按钮，事件密集时会反复 remove/append 抖动，我们不会。
   *
   * v0.12.1（修订）：allowFallback 只在**最后一次** tick 才放行。
   *   tries 自增时机是「先 setTimeout、后 tries++」，所以进入第 N 次 tick 时 tries === N-1：
   *     tick1(tries=0) … tick8(tries=7) → false；tick9(tries=8) → true，且 8 < 8 不成立、
   *     不再排下一轮，所以 tick9 就是最后一轮。共 9 轮（120ms + 250ms × 8 ≈ 2.12s）。
   */
  lmbScheduleToolbarButtons() {
    if (this._toolbarBtnTimer) clearTimeout(this._toolbarBtnTimer);
    let tries = 0;
    const tick = () => {
      this._toolbarBtnTimer = null;
      // v0.12.1：先清游离缓存，再解析（不清的话命中旧节点就永远跳过 querySelector）
      try { if (this._toolbarCache) this._toolbarCache.prune(); } catch (_) { /* noop */ }
      // v0.12.1（修订）：除最后一轮外都不准用兜底宿主（详见 lmbEnsureToolbarButtons 注释）
      const missing = this.lmbEnsureToolbarButtons(tries >= 8);
      if (missing && tries < 8) {
        tries++;
        this._toolbarBtnTimer = setTimeout(tick, 250);
      }
    };
    this._toolbarBtnTimer = setTimeout(tick, 120);
  }

  /**
   * v0.11.2：给所有打开的 PDF 视图的 .pdf-toolbar 补挂按钮（幂等）。
   * 返回是否仍有视图的工具栏未就绪（true = 需要重试）。
   * DOM 参照（与 PDF++ 同款挂法）：.pdf-toolbar 内 .clickable-icon 按钮；
   * PDF 嵌入（.pdf-embed）的迷你工具栏不注入（空间小、框选主战场是完整视图）。
   *
   * v0.12.0：按钮从 1 个扩到 3 个，各自独立判定是否已挂（不能再按 crop 存在与否
   * 提前 continue，否则旧版本升级后 crop 在、新按钮永远挂不上）：
   *   ① .lmb-toolbar-crop   图片框选（v0.11.2）
   *   ② .lmb-toolbar-md     打开/创建该 PDF 的摘录文档（<PDF名>-摘录.md）
   *   ③ .lmb-toolbar-canvas 打开/创建该 PDF 的专属画布（<PDF名>.canvas）
   * 文件一律在点击时从按钮所在 leaf 反查（注入时闭包存 file 会在切文件后失效）。
   *
   * v0.12.1：宿主不再硬编码 `.pdf-toolbar`，改走 lmbResolveToolbarAnchor 查
   *   LMB_VIEW_SPECS（判定 + 选择器 + enabled 三合一的单一真相源，见 25-pure-toolbar.js），
   *   并加了一层 per-leaf 缓存（key = leaf 对象）避免每次事件都全量 querySelector。
   *   三个按钮自身的判定结构（各自独立判存在 / 幂等追加）**保持原样不动**。
   *
   * v0.12.1（修订）：**fallback 只在重试用尽后才允许**（allowFallback，默认 false）。
   *   为什么必须分：`.pdf-toolbar` 是 pdf.js **异步渲染**的，在它出现之前的那一两帧，
   *   lmbResolveToolbarAnchor 的兜底会命中 PDF 视图里一直存在的 `.view-content`，
   *   于是：① 三个按钮被 append 进内容区而不是顶部工具栏 → 按钮跑到 PDF 正文上面、
   *   破坏布局；② 这个错误宿主被写进 per-leaf 缓存 → 等真正的 `.pdf-toolbar` 渲出来时
   *   缓存命中、不再重新解析，**按钮永远迁移不回真正的工具栏**。
   *   重试机制本来就是为「等 `.pdf-toolbar` 渲染」而设计的，fallback 的语义是
   *   「这个视图类型确实没有我们期望的宿主容器」，不是「异步还没准备好」——两者不能混。
   *   所以 allowFallback === false 时遇到 fallback：**不注入、不写缓存、算 missing**。
   *
   * @param {boolean} [allowFallback=false] 是否允许用兜底宿主（由调度层按重试进度给，
   *   只在最后一轮为 true）
   * @returns {boolean} missing（true = 还有视图未就绪，需要重试）
   */
  lmbEnsureToolbarButtons(allowFallback = false) {
    let missing = false;
    const cache = this._toolbarCache;
    let leaves = [];
    try { leaves = this.app.workspace.getLeavesOfType("pdf"); } catch (_) { return true; }
    for (const leaf of leaves) {
      // v0.11.2：从 leaf.containerEl 找（比 view.containerEl 更宽，工具栏挂在任何子层级都能命中）
      const root = leaf && leaf.containerEl;
      if (!root || !root.querySelector) continue;

      // v0.12.1：viewType 从 leaf.view 上取（查规格表用），取不到回落 "pdf"
      //   （Obsidian 的 PDF 视图 getViewType() 返回的就是 "pdf"）
      let viewType = "pdf";
      try {
        const v = leaf.view;
        if (v && typeof v.getViewType === "function") viewType = v.getViewType() || "pdf";
      } catch (_) { viewType = "pdf"; }

      // v0.12.1：先查缓存。key 用 leaf 对象本身 —— 每个 leaf 有自己独立的一份工具栏，
      //   绝不能用 "pdf" 这种全局单例 key（多 PDF 分屏时会把按钮注到第一个 leaf 里）。
      //   缓存命中且 isConnected 为真（LmbDomCache.get 内部已判）→ 直接复用，跳过 querySelector。
      let el = null;
      try { el = cache ? cache.get(leaf) : null; } catch (_) { el = null; }
      if (!el) {
        let resolved = null;
        try { resolved = lmbResolveToolbarAnchor(root, viewType); } catch (_) { resolved = null; }
        const spec = resolved && resolved.spec;
        const source = resolved ? resolved.source : null;

        // v0.12.1（修订）：按 source 分三路。**写缓存只有两条路径**：
        //   ① source === "spec"；② source === "fallback" 且 allowFallback 为 true。
        //   其余一律不写缓存（否则错误宿主被缓存住就再也纠正不回来）。
        if (source === "fallback" && allowFallback !== true) {
          // 「还没渲染出来」不是「没有宿主」→ 不注入、不写缓存，留给外层继续等真正的
          // .pdf-toolbar（下一轮这里会重新解析，因为缓存里根本没有条目）
          missing = true;
          continue;
        }
        if (source === null) {
          // 情况一：spec 登记了但 enabled === false（用户/规格有意关掉）→ 不是「未就绪」，
          //   静默跳过，不让外层白重试；顺手清掉该 leaf 的旧缓存条目。
          // 情况二：未知视图 / 连兜底都没找到 → 算 missing，交给外层重试。
          if (spec && spec.enabled === false) {
            try { if (cache) cache.delete(leaf); } catch (_) { /* noop */ }
            continue;
          }
          missing = true;
          continue;
        }
        el = resolved.el;
        try { if (cache) cache.set(leaf, el); } catch (_) { /* noop */ }
      }

      // MarginBook 按钮统一收进一个靠右的紧凑组，避免被 PDF 原生 toolbar
      // 的 justify-content 分散到整行。
      let group = el.querySelector(".lmb-toolbar-group");
      if (!group) {
        group = document.createElement("div");
        group.className = "lmb-toolbar-group";
        el.appendChild(group);
      }
      for (const old of Array.from(el.querySelectorAll(":scope > .lmb-toolbar-crop, :scope > .lmb-toolbar-md, :scope > .lmb-toolbar-canvas, :scope > .lmb-toolbar-sidebar"))) {
        group.appendChild(old);
      }

      // ⓪ 手写批注（保留原 PDF，按页存为归一化笔划）
      if (!group.querySelector(".lmb-toolbar-ink")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon lmb-toolbar-ink";
        btn.setAttribute("aria-label", "MarginBook: PDF 手写批注（开启后用触控笔或鼠标书写；Esc 退出）");
        try { setIcon(btn, "pen-tool"); } catch (_) { btn.setText("✎"); }
        btn.addEventListener("click", (e) => { e.stopPropagation(); this.lmbSetInkMode(!this.inkMode); });
        group.appendChild(btn);
        btn.toggleClass("is-active", !!this.inkMode);
      }

      if (!group.querySelector(".lmb-toolbar-page-note")) {
        const btn = document.createElement("button");
        btn.className = "clickable-icon lmb-toolbar-page-note";
        btn.setAttribute("aria-label", "新建 Markdown 页注");
        btn.setAttribute("title", "新建 Markdown 页注（无需选中文字）");
        try { setIcon(btn, "square-pen"); } catch (_) { btn.setText("T+"); }
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          const currentLeaf = this.app.workspace.getLeavesOfType("pdf").find((candidate) => candidate.containerEl && candidate.containerEl.contains(btn));
          this.lmbStartPageNote(currentLeaf);
        });
        group.appendChild(btn);
      }

      // ① 图片框选
      if (!group.querySelector(".lmb-toolbar-crop")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon lmb-toolbar-crop";
        btn.setAttribute("aria-label",
          "MarginBook: 图片框选（开启后直接在 PDF 上拖拽截图；Esc 或再点一次关闭）");
        try { setIcon(btn, "box-select"); }
        catch (_) { btn.setText("▦"); } // 图标缺失时兜底一个字形，按钮功能不受影响
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.setRectMode(!this.rectMode);
          new Notice(this.rectMode
            ? "MarginBook: 图片框选模式已开启 —— 直接拖拽截图，Esc 或再点一次关闭"
            : "MarginBook: 图片框选模式已关闭", 2500);
        });
        group.appendChild(btn);
        btn.toggleClass("is-active", !!this.rectMode);
      }

      // ② 打开/创建摘录文档
      if (!group.querySelector(".lmb-toolbar-md")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon lmb-toolbar-md";
        btn.setAttribute("aria-label",
          "MarginBook: 打开 / 创建该 PDF 的摘录文档（使用 MarginBook 存储规则）");
        try { setIcon(btn, "file-text"); }
        catch (_) { btn.setText("📄"); }
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          // v0.12.1：宿主在点击时从按钮自身反查（parentElement），而不是直接用闭包里的 el。
          //   理由：el 现在可能来自缓存，「缓存命中」与「按钮当初被挂进去的那个节点」不是
          //   一回事（Obsidian 重排/搬家工具栏时按钮和 el 可能一起换地方）。从按钮反查拿到
          //   的永远是它当时真正所在的宿主，最稳；反查不到再退回闭包 el 兜底。
          //   fallback 路径下按钮挂在 .view-content（或其首个子 div）里，parentElement 拿到的
          //   就不是 .pdf-toolbar —— 但没关系：lmbPdfFileFromToolbar 只做 closest(
          //   ".workspace-leaf")，兜底宿主和 .pdf-toolbar 同属一个 .workspace-leaf，照样反查得到。
          const host = (e.currentTarget && e.currentTarget.parentElement) || el;
          const f = this.lmbPdfFileFromToolbar(host);
          if (!f) { new Notice("MarginBook: 该工具栏没有对应的 PDF 文件"); return; }
          this.lmbOpenOrCreateExcerptMd(f).catch((err) => {
            console.error("[lmb] open excerpt md failed:", err);
            new Notice("MarginBook: 打开摘录文档失败，详情见控制台");
          });
        });
        group.appendChild(btn);
      }

      // ③ 打开/创建专属画布
      if (!group.querySelector(".lmb-toolbar-canvas")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon lmb-toolbar-canvas";
        btn.setAttribute("aria-label",
          "MarginBook: 打开 / 创建该 PDF 的专属画布（使用 MarginBook 存储规则）");
        try { setIcon(btn, "layout-dashboard"); }
        catch (_) { btn.setText("▦"); }
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          // v0.12.1：同 ② —— 点击时从按钮反查宿主，闭包 el 仅作兜底
          const host = (e.currentTarget && e.currentTarget.parentElement) || el;
          const f = this.lmbPdfFileFromToolbar(host);
          if (!f) { new Notice("MarginBook: 该工具栏没有对应的 PDF 文件"); return; }
          this.lmbOpenOrCreatePdfCanvas(f).catch((err) => {
            console.error("[lmb] open pdf canvas failed:", err);
            new Notice("MarginBook: 打开专属画布失败，详情见控制台");
          });
        });
        group.appendChild(btn);
      }

      // ④ 打开 / 关闭 PDF 批注边栏
      if (!group.querySelector(".lmb-toolbar-sidebar")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon lmb-toolbar-sidebar";
        btn.setAttribute("aria-label", "MarginBook: 打开 / 关闭 PDF 批注边栏");
        try { setIcon(btn, "panel-right"); } catch (_) { btn.setText("▥"); }
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const leafEl = btn.closest(".workspace-leaf");
          const currentLeaf = leafEl ? this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl) : leaf;
          if (!currentLeaf) return;
          this.lmbSetPdfSidebarVisible(currentLeaf, currentLeaf._lmbPdfSidebarOpen === false);
        });
        group.appendChild(btn);
        btn.toggleClass("is-active", leaf._lmbPdfSidebarOpen !== false);
      }
    }
    return missing;
  }

  /**
   * v0.12.0：从按钮所在的 .pdf-toolbar 反查当前 PDF 文件。
   * 点击时实时解析（不在注入时闭包存 file）：同一 leaf 换了文件后按钮依然正确。
   *
   * v0.12.1：入参只要求是「按钮所在的宿主容器内/本身」的任意元素 —— 可能是 .pdf-toolbar，
   *   也可能是重试用尽后走兜底时的 .view-content（或其首个子 div）。本函数只关心
   *   closest(".workspace-leaf")，两者同属一个 leaf，结果一致。
   */
  lmbPdfFileFromToolbar(toolbar) {
    try {
      const leafEl = toolbar.closest(".workspace-leaf");
      const leaf = leafEl
        ? this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl)
        : null;
      const view = leaf && leaf.view;
      return (view && view.file) ? view.file : null;
    } catch (_) { return null; }
  }

  /**
   * v0.12.1：对所有已注入的工具栏按钮做显隐分级。
   *
   * ⚠️ 目前**没有调用方**，这是预留能力，别当死代码删掉：
   *   下一步要做「切到非 PDF 视图时用 hideKeepSpace 保留占位，而不是把按钮 DOM 移除」
   *   （移除 = 切回来要重新注入 + 原生按钮重排抖动），接线点在 workspace 的
   *   active-leaf-change 里，到时候本方法就是那个调用入口。
   *   显隐分级的实现在 25-pure-toolbar.js 的 lmbSetToolbarVisibility。
   *
   * @param {"show"|"hideKeepSpace"|"hideRemove"} mode
   */
  lmbApplyToolbarVisibility(mode) {
    try {
      // LmbDomCache 没有对外暴露遍历接口（那是别人的文件，不为遍历去改它），
      // 所以退化成全局选择器：这三个类名是本插件独占的，命中集合 == 已注入的按钮集合。
      const sels = ".lmb-toolbar-ink, .lmb-toolbar-crop, .lmb-toolbar-md, .lmb-toolbar-canvas, .lmb-toolbar-sidebar";
      document.querySelectorAll(sels).forEach((b) => lmbSetToolbarVisibility(b, mode));
    } catch (_) { /* noop：绝不让异常打断调用方的事件链 */ }
  }

  /**
   * v0.8.1：补充描述按钮的可用性状态。
   *   这是「动作按钮」不是「模式开关」，所以不用 is-active（那是"已开启"的高亮语义，会误导）。
   *   改为：不在 canvas 视图 → 加 is-idle 灰显（表示当前点了也没用）；在 canvas → 恢复正常。
   *   仅视觉提示，点击时仍走 runCardNoteCommand 的上下文检查（双重保险）。
   */
  updateNoteRibbonState() {
    if (!this._noteRibbonEl) return;
    let inCanvas = false;
    try { inCanvas = !!this.activeCanvasContext(); } catch (_) { inCanvas = false; }
    this._noteRibbonEl.toggleClass("is-idle", !inCanvas);
  }

  /**
   * v0.16.5 修复 R4：回忆模式开启后主动重渲染已打开的阅读视图。
   *   registerMarkdownPostProcessor 只在**渲染时**触发一次，开关切换不会重跑它 ——
   *   旧版开启侧什么都没做，用户开了 Recall 却看不到模糊，要手动切页才生效。
   *   previewMode 是内部对象，故全部能力检测，拿不到就静默跳过（只慢一拍）。
   */
  lmbRerenderRecallViews() {
    try {
      const leaves = this.app.workspace.getLeavesOfType("markdown") || [];
      for (const l of leaves) {
        try {
          const v = l && l.view;
          const pm = v && v.previewMode;
          if (pm && typeof pm.rerender === "function") pm.rerender(true);
        } catch (_) { /* 单个视图失败不影响其它 */ }
      }
    } catch (_) { /* noop */ }
  }

  /**
   * v0.16.5 修复 R7：canvas 索引的防抖入口。
   *   canvas 的 modify 在拖拽期连续触发（Obsidian 频繁落盘），旧版每次都全量
   *   cachedRead + JSON.parse 整张画布。按文件防抖 400ms，与 processCanvas 同节奏。
   */
  lmbScheduleCanvasIndex(f) {
    try {
      if (!this._canvasIndexTimers) this._canvasIndexTimers = new Map();
      const old = this._canvasIndexTimers.get(f.path);
      if (old) clearTimeout(old);
      this._canvasIndexTimers.set(f.path, setTimeout(() => {
        this._canvasIndexTimers.delete(f.path);
        this.lmbIndexCanvasFile(f).catch(() => {});
      }, 400));
    } catch (_) {
      try { this.lmbIndexCanvasFile(f).catch(() => {}); } catch (_2) { /* noop */ }
    }
  }

  /**
   * v0.16.5 修复 R8：集中清掉所有自建定时器。
   *   图片等待重试链（_actualFitRetryForFile）的 setTimeout 没有保留句柄，靠
   *   _unloaded 标记在入口处自行退出兜底。
   */
  _lmbClearTimers() {
    try {
      if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
      if (this._dropFlush && this._dropFlush.timer) clearTimeout(this._dropFlush.timer);
      this._dropFlush = null;
      if (this._lmbPdfSidebarTimer) {
        clearTimeout(this._lmbPdfSidebarTimer);
        this._lmbPdfSidebarTimer = null;
      }
      if (this._mobileSelectionTimer) {
        clearTimeout(this._mobileSelectionTimer);
        this._mobileSelectionTimer = null;
      }
      if (this._lmbInkSaveTimer) {
        clearTimeout(this._lmbInkSaveTimer);
        this._lmbInkSaveTimer = null;
      }
      if (this._lmbInkRefreshTimer) {
        clearTimeout(this._lmbInkRefreshTimer);
        this._lmbInkRefreshTimer = null;
      }
      if (this._fitRetry) {
        for (const k of Object.keys(this._fitRetry)) {
          const r = this._fitRetry[k];
          if (r && r.timer) clearTimeout(r.timer);
        }
        this._fitRetry = {};
      }
      this._fitRetryImg = {};
      this._fitRetryActual = {};
      if (this._canvasIndexTimers) {
        this._canvasIndexTimers.forEach((t) => clearTimeout(t));
        this._canvasIndexTimers.clear();
      }
    } catch (_) { /* noop */ }
  }

  debugNotice(msg) {
    console.log("[lmb]", msg);
    if (this.settings && this.settings.debug) new Notice("MarginBook: " + msg, 4000);
  }

  /* ==================== 设置 ==================== */

  saveSettings() {
    // One writer for data.json: overlapping editor/preferences saves must not
    // finish out of order. Snapshot when this job starts, after prior failures
    // have reached their callers and rolled back the affected note.
    const previous = this._lmbSettingsWriteQueue || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => {
      this._lmbPrunePersistedCaches();
      const obj = this.settingsStore.serialize(this.settings, this.runtimeState);
      return this.saveData(obj);
    });
    this._lmbSettingsWriteQueue = pending.catch(() => {});
    return pending;
  }

  /** 清除已删除画布和附件留下的持久化缓存，避免 data.json 无限制增长。 */
  _lmbPrunePersistedCaches() {
    try {
      if (!this._lmbCachePruneDirty) return;
      const files = this.app && this.app.vault && typeof this.app.vault.getFiles === "function"
        ? this.app.vault.getFiles() : [];
      const canvasPaths = new Set(files.filter((f) => f && f.extension === "canvas").map((f) => f.path));
      const imageNames = new Set(files
        .filter((f) => f && /^(?:webp|png|jpe?g)$/i.test(f.extension || ""))
        .map((f) => f.name));
      for (const map of [this.autoSize, this.canvasPositions, this.autoEdges, this.nodeMeta]) {
        if (!map || typeof map.keys !== "function") continue;
        for (const path of Array.from(map.keys())) if (!canvasPaths.has(path)) map.delete(path);
      }
      if (this.imgDims && typeof this.imgDims.keys === "function") {
        for (const name of Array.from(this.imgDims.keys())) {
          const base = String(name).split("/").pop();
          if (!imageNames.has(base)) this.imgDims.delete(name);
        }
      }
      this._lmbCachePruneDirty = false;
      this._lmbRuntimeStateDirty = true;
    } catch (err) {
      console.warn("[lmb] cache prune failed:", err);
    }
  }

  /* ==================== 样式 ==================== */

  injectStyles() {
    let st = document.getElementById("lmb-styles");
    if (!st) {
      st = document.createElement("style");
      st.id = "lmb-styles";
      document.head.appendChild(st);
    }
    // v0.12.1：CSS 全部抽到 src/11-styles.js 的 LMB_STYLES，
    //   per-view-type 适配规则也集中在那边（借鉴 editing-toolbar：视图差异交给 CSS，不动 JS）。
    st.textContent = LMB_STYLES.join("");
    st.dataset.lmbVersion = "0.40.1";
  }

}
