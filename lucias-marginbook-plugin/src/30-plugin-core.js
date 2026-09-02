/* 30-plugin-core —— 插件类核心：构造器/生命周期/设置/样式注入 */

class LuciasMarginBookPlugin extends Plugin {

  async onload() {
    this.syncTimers = new Map();
    this.selfWritten = new Map();
    this.autoSize = new Map();
    this.imgDims = new Map();        // webp 全名 -> {w,h}
    this.chipEl = null;
    this._saveTimer = null;
    this._chipSig = null;            // 当前 chip 承载的选区签名（text@page），防重复重建
    this.canvasPositions = new Map(); // v0.7.0：canvas 路径 -> 节点 id -> {x,y,width,height}（位置 diff 识别「刚被拖动」的卡）
    this.autoEdges = new Map();      // v0.7.1：canvas 路径 -> 自动建边的 id 集合（用于清理不再重叠的瞬时孤儿边，防重复连线）
    this._lastNoSelNotice = 0;
    this.rectMode = false;           // ribbon 按钮的一次性框选模式
    this._ribbonEl = null;
    this._dragArm = null;            // 我们的 chip 拖拽进行中（drop 捕获用）
    this._instantSkip = 0;           // 即时通道成功后短暂抑制文件层自动父子（防双写）
    this._dropFlush = null;          // v0.7.2：canvas 内松手后的快速通道 {path, t, timer}

    // P1：摘录索引层（反向索引：摘录 md → PDF/页/选区）
    this.excerptIndex = new Map();   // pdf 路径 -> 条目数组
    this.indexMtime = new Map();     // 摘录文档路径 -> mtime（增量判定用）
    this._isIndexing = false;        // 全量重建进行中标记（防重入）
    // P3.5：exId -> canvas 卡片位置（反向跳转优先进画布，而非 md）
    this.excerptCanvasIndex = new Map();

    // 补丁 B：相关笔记缓存 + 颜色归一化上下文（须在 settings 与 canvas 监听之前就绪）
    this.relatedCache = new Map();   // 摘录 id -> 相关笔记 wikilink 数组（每 id 只检索一次）
    this._colorCtx = null;           // 颜色归一化用的离屏 canvas 2d context（惰性创建）
    this.settings = Object.assign({
      debug: true, colorMap: "",
      // v0.8.0：卡片补充描述
      noteCalloutType: "ppd-note",  // callout 类型名（渲染成框）
      noteTitle: "补充描述",         // callout 标题
      noteFoldByDefault: false,     // 新建时是否默认折叠
      noteIntoSync: false,          // 补充描述是否同步进摘录 md（默认否，保持摘录文档干净）
      noteAutoBoxOnNew: true,       // v0.8.2：新摘录卡自动挂一个空的补充描述框（一眼能看见）
      commentAutoBoxOnNew: true     // v0.11.0：新摘录卡自动挂评论栏（PDF Flow 式底栏按钮）
    }, await this.loadData());
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

    this.registerDomEvent(document, "mousedown", (e) => this.onDocMouseDown(e), true);
    this.registerDomEvent(document, "mouseup", (e) => this.onDocMouseUp(e), true);
    this.registerDomEvent(document, "scroll", () => this.hideChip(), true);

    // v0.7.2 松手快速通道：canvas 内 mouseup → 武装 flush，让下一个 modify 走 80ms 极短防抖
    // （原本要干等 400ms 才重排）。capture 阶段注册，早于 Obsidian 自己的 canvas mouseup。
    // v0.9.3：再加内存级即时通道 —— mouseup 后不等 Obsidian 落盘，直接在 canvas 内存数据上
    // 做父子判定 + 组排布（setData 毫秒级生效），落盘管线退为兜底。
    this.registerDomEvent(document, "mouseup", (e) => {
      try {
        const f = this.canvasFileFromEvent(e);
        if (f) this.armDropFlush(f);
        if (e.button === 0) {
          const canvasObj = this.canvasObjFromEvent(e);
          if (canvasObj) {
            this.instantMoveAttach(canvasObj).catch((err) =>
              console.warn("[lmb] instant move error:", err));
          }
        }
      } catch (_) { /* noop */ }
    }, true);

    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f instanceof TFile && f.extension === "canvas") {
        if (this.selfWritten.get(f.path)) { this.selfWritten.delete(f.path); return; }
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
    this.registerDomEvent(document, "drop", (e) => {
      try {
        if (!this._dragArm) return;
        const target = e.target && e.target.nodeType === 1 ? e.target : null;
        if (!target) return;
        const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.containerEl.contains(target));
        const canvasObj = leaf && leaf.view && leaf.view.canvas;
        if (!canvasObj || typeof canvasObj.getData !== "function" ||
            typeof canvasObj.setData !== "function" || typeof canvasObj.requestSave !== "function") {
          console.log("[lmb] canvas 内部 API 不可用 → 文件层兜底（250ms）");
          return;
        }
        this.instantAttach(canvasObj).catch((err) => console.warn("[lmb] instant attach error:", err));
      } catch (err) {
        console.warn("[lmb] drop capture error:", err);
      }
    }, true);

    // 侧边栏按钮：一次性图片框选模式
    this._ribbonEl = this.addRibbonIcon("scan-search", "MarginBook: 图片框选（点击后在 PDF 上直接拖拽）", () => {
      this.rectMode = !this.rectMode;
      this.updateRibbonState();
      new Notice(this.rectMode
        ? "MarginBook: 图片框选模式已开启 —— 在 PDF 上直接拖拽即可（一次性）"
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

    /* ---- P1：摘录索引的增量维护 ----
     * modify 会在每次敲键触发，所以 reindexFile 内有两道廉价闸门
     * （不链 pdf 且不在索引中 → 跳过；mtime 未变 → 跳过），不会读盘。
     */
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f && f.extension === "canvas") this.lmbIndexCanvasFile(f);   // P3.5：canvas 索引
      else this.reindexFile(f);
    }));
    this.registerEvent(this.app.vault.on("create", (f) => {
      if (f && f.extension === "canvas") this.lmbIndexCanvasFile(f);
      else this.reindexFile(f);
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      if (!f) return;
      if (f.extension === "canvas") {
        for (const [k, v] of Array.from(this.excerptCanvasIndex.entries())) {
          if (v && v.canvasPath === f.path) this.excerptCanvasIndex.delete(k);
        }
      } else this.dropFileFromIndex(f.path);
    }));
    this.app.workspace.onLayoutReady(() => { this.buildExcerptIndex(); });

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
      name: "图片框选模式（下一次拖拽生效）",
      callback: () => {
        this.rectMode = true;
        this.updateRibbonState();
        new Notice("MarginBook: 图片框选模式已开启 —— 在 PDF 上直接拖拽即可（一次性）", 3000);
      }
    });

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

    this.debugNotice("已加载 ✓（v0.8.1：拖拽摘录 / 自动父子组居中 / 卡片补充描述）");
    console.log("[lmb] loaded (v0.11.0)");
  }

  onunload() {
    this.hideChip();
    this.syncTimers.forEach((t) => clearTimeout(t));
    this.syncTimers.clear();

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

  updateRibbonState() {
    if (!this._ribbonEl) return;
    this._ribbonEl.toggleClass("is-active", !!this.rectMode);
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

  debugNotice(msg) {
    console.log("[lmb]", msg);
    if (this.settings && this.settings.debug) new Notice("MarginBook: " + msg, 4000);
  }

  /* ==================== 设置 ==================== */

  async saveSettings() {
    const obj = { debug: this.settings.debug };
    obj.recallDefault = !!this.settings.recallDefault; // 补丁 C：回忆模式默认值
    obj.colorMap = this.settings.colorMap;             // 补丁 B：颜色语义映射
    // v0.8.0：卡片补充描述设置
    obj.noteCalloutType = this.settings.noteCalloutType;
    obj.noteTitle = this.settings.noteTitle;
    obj.noteFoldByDefault = !!this.settings.noteFoldByDefault;
    obj.noteIntoSync = !!this.settings.noteIntoSync;
    obj.noteAutoBoxOnNew = this.settings.noteAutoBoxOnNew !== false;
    obj.commentAutoBoxOnNew = this.settings.commentAutoBoxOnNew !== false; // v0.11.0
    if (this.autoSize.size) {
      const autoSizes = {};
      for (const [path, store] of this.autoSize) autoSizes[path] = Array.from(store.entries());
      obj.autoSizes = autoSizes;
    }
    if (this.imgDims.size) obj.imgDims = Object.fromEntries(this.imgDims);
    // v0.7.0：持久化画布节点位置（用于位置 diff 识别「刚被拖动」的卡）
    if (this.canvasPositions && this.canvasPositions.size) {
      const pos = {};
      for (const [p, m] of this.canvasPositions) {
        if (m.size) pos[p] = Array.from(m.entries());
      }
      if (Object.keys(pos).length) obj.canvasPositions = pos;
    }
    // v0.7.1：持久化「自动建边 id」档案（用于清理瞬时重叠产生的孤儿边）
    if (this.autoEdges && this.autoEdges.size) {
      const ae = {};
      for (const [p, s] of this.autoEdges) {
        if (s.size) ae[p] = Array.from(s);
      }
      if (Object.keys(ae).length) obj.autoEdges = ae;
    }
    await this.saveData(obj);
  }

  /* ==================== 样式 ==================== */

  injectStyles() {
    if (document.getElementById("lmb-styles")) return;
    const st = document.createElement("style");
    st.id = "lmb-styles";
    st.textContent = [
      ".lmb-chip{position:fixed;z-index:1000;",
      "background:var(--interactive-accent,#7c6cf0);color:var(--text-on-accent,#fff);",
      "font-size:12px;padding:6px 12px;border-radius:16px;cursor:grab;",
      "box-shadow:0 4px 14px rgba(0,0,0,.5);user-select:none;white-space:nowrap;}",
      ".lmb-chip:active{cursor:grabbing}",
      ".lmb-rect{position:fixed;z-index:999;",
      "border:2px dashed var(--interactive-accent,#7c6cf0);",
      "background:rgba(124,108,240,.15);pointer-events:none;}",
      ".lmb-btn.is-active{color:var(--text-on-accent);background:var(--interactive-accent);}",
      // v0.8.1：动作按钮（补充描述）在不可用上下文里灰显，区别于「模式已开启」的 is-active
      ".lmb-btn.is-idle{opacity:.35;}",
      ".lmb-btn{cursor:pointer;}",
      // ===== 补丁 C：Recall 回忆模式 =====
      ".lmb-recall-blur{position:relative;cursor:pointer;}",
      ".lmb-recall-blur>*{filter:blur(6px);transition:filter .25s;}",
      ".lmb-recall-blur.lmb-recall-reveal>*{filter:none;}",
      // ::after 挂在容器上（blur 只作用于子元素 > *，提示本身不会被糊掉）
      ".lmb-recall-blur::after{content:'\\1F50D  点击回忆';position:absolute;top:6px;right:10px;", // Bugfix: 转义后首空格被 CSS 吃掉，补一个
      "font-size:11px;line-height:1.4;color:var(--text-muted);",
      "background:var(--background-secondary);border:1px solid var(--background-modifier-border);",
      "border-radius:10px;padding:1px 8px;opacity:.85;pointer-events:none;}",
      ".lmb-recall-blur.lmb-recall-reveal::after{display:none;}",
      // ===== P2：摘录回绘标记 =====
      // 关键：百分比定位 + .page 相对定位 → 覆盖层随页面缩放自动跟随，
      //       完全不需要监听 zoom 事件重算（P0 实测 span 索引与缩放无关）。
      'div[data-type="pdf"] .page{position:relative !important;}',
      // 标记保持 pointer-events:none（见下）：单击/划选穿透，双击才跳转（P3）。
      // 原因：标记覆盖在已摘录文字上，若单击可交互，会吃掉划选的起笔事件，
      //       而"在 PDF 上划选拖拽"是本插件的主工作流，不能破坏。
      ".lmb-mark{position:absolute;pointer-events:none;border-radius:2px;",
      "mix-blend-mode:multiply;box-sizing:border-box;}",
      // 降级标记：selection 缺失或 span 对不上时画页顶细条，宁可不准也不消失
      '.lmb-mark[data-fallback="1"]{left:0 !important;right:0 !important;',
      "top:0 !important;height:3px !important;width:auto !important;opacity:.75;}",
      // ===== P3：跳转闪烁 =====
      // 跳到目标选区后闪 3 次（0.5s × 3 = 1.5s），动画结束 opacity 回 0，2.2s 后 JS 移除节点
      ".lmb-flash{position:absolute;pointer-events:none;border-radius:2px;",
      "background:var(--interactive-accent,#7c6cf0);mix-blend-mode:multiply;",
      "animation:lmb-flash-anim .5s ease-in-out 3;}",
      "@keyframes lmb-flash-anim{0%,100%{opacity:0}45%,55%{opacity:.6}}",
      // ===== v0.11.0：评论栏（仿 PDF Flow 批注底栏） =====
      // 未知 callout 类型 Obsidian 默认给铅笔图标（✎）——正合底栏视觉；
      // 折叠态 = 单行按钮条，展开态 = 标题 + 评论内容
      '.callout[data-callout="lmb-comment"]{background:var(--background-secondary,transparent);',
      "border:none !important;border-top:1px solid var(--background-modifier-border) !important;",
      "border-radius:0 !important;box-shadow:none !important;padding:6px 10px !important;margin-top:10px;}",
      '.callout[data-callout="lmb-comment"] .callout-title{gap:6px;}',
      '.callout[data-callout="lmb-comment"] .callout-title-inner{color:var(--text-muted);font-weight:400;font-size:12.5px;}',
      '.callout[data-callout="lmb-comment"] .callout-icon{color:var(--text-faint);}',
      // 折叠箭头推到最右（PDF Flow 的「›」位置）；lmb-comment-clickable 供 JS/测试识别
      '.callout[data-callout="lmb-comment"] .callout-fold{margin-left:auto;}'
    ].join("");
    document.head.appendChild(st);
  }

}
