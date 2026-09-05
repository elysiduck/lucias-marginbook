/* 37-plugin-canvasbar —— canvas 卡片悬浮操作栏（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js）
 * ----------------------------------------------------------------------------
 * v0.13.0：选中 canvas 里的一张摘录卡时，在卡片正上方浮出一条操作栏，含最多三个按钮：
 *   评论（message-square）/ 跳回 PDF（book-open）/ 切换文字·图片视图（image）
 *
 * 修改注意：
 *   1. 这三个功能**早就有了**（v0.11.0 评论 / v0.9.1 跳转 / v0.11.3 切换），本文件只负责
 *      「把入口从卡内搬到悬浮栏」，**任何业务逻辑都不要在这里重写**。对应的现有入口：
 *        this.editCommentForNode(file, nodeId)        33-plugin-note-comment.js
 *        this.lmbParsePdfLink(href) → lmbJumpToSelection(...)   36-plugin-jump.js
 *        this.toggleCardView(callout)                 33-plugin-note-comment.js
 *   2. 挂载点必须是 canvas.wrapperEl（.canvas-wrapper），**不能**是卡片或 .canvas：
 *      canvas 的 transform:scale() 加在 .canvas 上，wrapperEl 是其父级、不参与缩放。
 *      挂在 wrapper 上按钮尺寸恒定，挂在里面会跟着画布一起缩小到看不清。
 *   3. 浮层的 left/top 由 26-pure-canvasbar.js 的 lmbCalcBarPos() 算，本文件只负责取值与写入。
 *   4. canvas 的**一切**内部 API（canvas / selection / wrapperEl / nodes）都要能力检测 +
 *      try/catch。Obsidian 版本一变这些就可能没了，宁可静默降级也不能让插件崩。
 *   5. 本文件是 Object.assign 混入，**方法之间用逗号分隔**（30-plugin-core.js 才是 class 体
 *      不加逗号，别搞混）。
 * ========================================================================== */

Object.assign(LuciasMarginBookPlugin.prototype, {

  /* ==================== v0.13.0：canvas 卡片悬浮操作栏 ==================== */

  /**
   * 取（或创建）悬浮栏容器 —— 幂等，轮询每轮都会调。
   * @param {HTMLElement} wrapperEl  canvas.wrapperEl（或其退化 .canvas-wrapper）
   * @returns {HTMLElement|null}
   */
  lmbEnsureCanvasBarEl(wrapperEl) {
    try {
      if (!wrapperEl || !wrapperEl.querySelector) return null;

      // 幂等：已存在直接复用（轮询 120ms 一次，不复用会疯狂建 DOM）
      // v0.13.8：**先看版本**。重载插件时 canvas leaf 的 DOM 不重建，旧版本造的浮层会
      //   被一直复用，而它的按钮绑的是**旧版 click 回调**（比如 v0.13.4 的 fit 按钮是
      //   `if (!c) return` 静默版）→ 代码改了、插件重载了，行为还是老样子。
      //   版本不匹配就移除重建，保证用户手上的永远是"当前代码造的"浮层。
      const exist = wrapperEl.querySelector(LMB_BAR_SEL);
      if (exist) {
        if (exist.dataset && exist.dataset.lmbBarVer === LMB_BAR_VERSION) return exist;
        if (exist.parentNode) exist.remove();
      }

      // 容器必须可定位，否则浮层的 absolute 会相对更外层的祖先定位而整体错位。
      // 只在我们能确认它是 static 时才改成 relative，不无脑覆盖用户/主题的样式。
      try {
        const cs = getComputedStyle(wrapperEl);
        if (!cs || cs.position === "static") wrapperEl.style.position = "relative";
      } catch (_) { /* getComputedStyle 不可用就算了，CSS 侧 .canvas-wrapper 本身就是 relative */ }

      const bar = wrapperEl.createDiv
        ? wrapperEl.createDiv({ cls: "lmb-canvas-bar" })
        : document.createElement("div");
      if (!bar.classList || !bar.classList.contains("lmb-canvas-bar")) {
        bar.className = "lmb-canvas-bar";
      }
      // v0.13.8：打版本标记（配合 lmbEnsureCanvasBarEl 顶部的版本检查，见那里的说明）
      try { bar.dataset.lmbBarVer = LMB_BAR_VERSION; } catch (_) {}

      // 四个按钮：只建一次，显隐与行为都在别处控制。withText 可选：传了就追加文字节点（fit 按钮专用，
      //   让用户一眼看到"高度"二字，不再把 move-vertical 误认成 view 切换）
      const mk = (cls, icon, label, withText) => {
        const b = document.createElement("div");
        b.className = cls;
        b.setAttribute("aria-label", label);
        try { setIcon(b, icon); } catch (_) { /* 图标失败也要能用 */ }
        if (withText) {
          const t = document.createElement("span");
          t.className = "lmb-bar-text";
          t.textContent = withText;
          b.appendChild(t);
        }
        // 注意：这里**不**把 nodeId / acts 闭包进回调 —— 浮层是复用的，选中卡片会变，
        // 闭包快照会 stale（点了 A 卡却操作 B 卡）。统一走 lmbCanvasBarAction 读最新上下文。
        b.addEventListener("click", (ev) => {
          try {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();   // 别让 canvas 把它当成框选/拖拽
            this.lmbCanvasBarAction(cls === "lmb-bar-comment" ? "comment"
              : cls === "lmb-bar-jump" ? "jump"
              : cls === "lmb-bar-view" ? "view"
              : cls === "lmb-bar-disconnect" ? "disconnect" : "fit");
          } catch (_) { /* noop */ }
        });
        return b;
      };
      // v0.14.8：4 个按钮统一加两个字文字（"评论"/"跳转"/"视图"/"高度"）—— 用户反馈
      //   纯图标按钮看不清用途，统一"图标 + 两字文字"既好认又对齐。label 保留完整 aria-label。
      bar.appendChild(mk("lmb-bar-comment", "message-square", "添加或编辑评论", "评论"));
      bar.appendChild(mk("lmb-bar-jump", "book-open", "跳回 PDF 原位置", "跳转"));
      bar.appendChild(mk("lmb-bar-view", "image", "切换文字或图片视图", "视图"));
      bar.appendChild(mk("lmb-bar-fit", "move-vertical", "根据内容自动调整卡片高度", "高度"));
      bar.appendChild(mk("lmb-bar-disconnect", "unlink", "断开卡片连线", "断开"));

      wrapperEl.appendChild(bar);
      return bar;
    } catch (_) { return null; }
  },

  /**
   * 派发悬浮栏按钮动作。
   *   上下文统一从 this._barCtx 读（每轮 tick 更新），**不用**创建按钮时的闭包快照 ——
   *   浮层是复用的，选中卡片会变，闭包捕获的旧 nodeId 会操作到错误的卡片上。
   * @param {"comment"|"jump"|"view"} kind
   */
  lmbCanvasBarAction(kind) {
    try {
      let c = this._barCtx;
      if (!c) {
        // v0.13.7：**不要静默 return**。轮询每 120ms 跑，canvas 选中会间歇性返回空
        //   （焦点切换 / Modal 开关 / canvas 内部 state 刷新），那一刻 _lmbHideBar 清掉
        //   _barCtx；等下次 tick 重建前用户点按钮 → 拿到 null → 旧版直接 return，
        //   用户视角就是"点了没反应、连 Notice 都不弹"（v0.13.6 用户反馈）。
        //   这里不依赖轮询，直接从当前选中即时重建一次。
        c = this._lmbRebuildBarCtx();
      }
      if (!c) {
        // 真的没选中卡片 —— 也要告诉用户，绝不静默失败
        try { new Notice("没找到选中的卡片，请重新点选一张卡", 2500); } catch (_) {}
        return;
      }

      if (kind === "comment") {
        // v0.13.2：评论编辑 Modal 关闭后 canvas 选中可能丢失 → 浮层暂时消失。
        //   不等 120ms 自然 tick，Modal 关闭后立刻刷一次，确保浮层尽快回来。
        //   这是 v0.13.1 守卫之外的**第二道保险** —— 守卫保住按下时选中，但 Modal 关闭
        //   这种纯逻辑事件守卫拦不到，只能靠这里主动 tick。
        const p = this.editCommentForNode(c.file, c.nodeId);
        if (p && typeof p.then === "function") {
          p.then(() => { try { this.lmbCanvasBarTick(); } catch (_) {} });
        }
        return;
      }
      if (kind === "jump") {
        // v0.13.2：jump 后当前 canvas leaf 可能失焦（切到 PDF leaf），立即 tick 让浮层/选中状态对齐
        // acts.jump 是剥掉 [[]] 与 |别名 的链接正文，参数解析交给现有的 lmbParsePdfLink
        const hit = this.lmbParsePdfLink(c.acts && c.acts.jump);
        if (hit) this.lmbJumpToSelection(hit.filePath, hit.page, hit.selection, hit.rect);
        try { this.lmbCanvasBarTick(); } catch (_) {}
        return;
      }
      if (kind === "view") {
        // v0.16.0：**不再靠 lmb-view callout 反查 host**（新卡不写那行了，查了也是 null
        //   → 按钮静默失效，v0.13.1 同款坑）。直接取渲染容器 host 传给 toggleCardViewByHost。
        //   host 优先级：.canvas-node-content（canvas 文本节点的内容容器）→ 节点元素本身兜底。
        //   切完 host class（lmb-view-img）→ 卡片高度变化 → 浮层位置要重算
        //   v0.13.2：切完立刻 tick（不等 120ms），否则用户看到浮层停在旧位置上像没响应
        const el = c.nodeEl;
        const host = (el && el.querySelector)
          ? (el.querySelector(".canvas-node-content") || el.querySelector(".markdown-rendered") || el)
          : null;
        if (host) {
          this.toggleCardViewByHost(host);
        } else {
          // 真的拿不到容器 —— 也要告诉用户，绝不静默失败（v0.13.7 定下的规矩）
          try { new Notice("找不到卡片内容容器，视图未能切换", 2500); } catch (_) {}
        }
        setTimeout(() => { try { this.lmbCanvasBarTick(); } catch (_) {} }, 0);
      }
      if (kind === "fit") {
        // v0.14.3：入口探针「开始调整卡片高度…」使命完成（v0.13.9 加它定位链路，
        //   v0.14.1 实锤断点后已确认全链路通），正常路径只保留最终结果一个 Notice，
        //   避免每次点击连弹三条。失败路径的编号探针（fit[0]-[4]、Promise 异常）
        //   全部保留 —— 异常时依然每一步都说话。
        // v0.14.1：调用本身也要有探针 —— 上一版只有入口探针，`lmbFitNodeById` 内部
        //   的无声 early return 让流程断在中间而用户毫无感知。现在：
        //   调用抛异常 / 返回非 Promise / Promise 内部 early return（fit[1]-[4] 编号
        //   Notice）每一步都可见，不再有任何静默出口。
        try {
          const p = this.lmbFitNodeById(c.file, c.nodeId, c.node);
          if (p && typeof p.then === "function") {
            p.then(() => { try { this.lmbCanvasBarTick(); } catch (_) {} })
             .catch((err) => {
               console.warn("[lmb] fit error:", err);
               try { new Notice("fit Promise 异常：" + (err && err.message ? err.message : err), 3200); } catch (_) {}
             });
          } else {
            try { new Notice("fit[0] lmbFitNodeById 未返回 Promise（typeof=" + typeof p + "）", 3200); } catch (_) {}
          }
        } catch (err) {
          console.warn("[lmb] fit call error:", err);
          try { new Notice("fit 调用异常：" + (err && err.message ? err.message : err), 3200); } catch (_) {}
        }
      }
      if (kind === "disconnect") {
        const p = this.lmbDisconnectCard(c);
        if (p && typeof p.then === "function") {
          p.then(() => { try { this.lmbCanvasBarTick(); } catch (_) {} })
            .catch((err) => {
              console.warn("[lmb] disconnect error:", err);
              try { new Notice("断开连线失败：" + (err && err.message ? err.message : err), 3200); } catch (_) {}
            });
        }
      }
    } catch (_) { /* noop：按钮回调绝不能抛错破坏 canvas */ }
  },

  /** 取得运行时 edge 对应的可点击 SVG/DOM；不同 Obsidian 版本字段名不同，逐项兼容。 */
  _lmbDisconnectEdgeTargets(canvas, edgeId) {
    const out = [];
    const add = (el) => {
      if (!el || typeof el.addEventListener !== "function" || out.includes(el)) return;
      out.push(el);
    };
    try {
      let runtime = null;
      if (canvas && canvas.edges) {
        runtime = typeof canvas.edges.get === "function" ? canvas.edges.get(edgeId) : canvas.edges[edgeId];
        if (!runtime) {
          const vals = typeof canvas.edges.values === "function"
            ? Array.from(canvas.edges.values()) : Object.values(canvas.edges);
          runtime = vals.find((e) => e && (e.id === edgeId || (e.edge && e.edge.id === edgeId)
            || (e.data && e.data.id === edgeId)));
        }
      }
      if (runtime) {
        for (const k of ["lineGroupEl", "interactionEl", "pathEl", "path", "el", "svgEl"]) add(runtime[k]);
        if (runtime.line) {
          for (const k of ["interactionEl", "pathEl", "path", "el"]) add(runtime.line[k]);
        }
      }
      const root = canvas && canvas.wrapperEl;
      if (root && typeof root.querySelectorAll === "function") {
        const safe = String(edgeId).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        for (const el of Array.from(root.querySelectorAll(
          `[data-edge-id="${safe}"], [data-id="${safe}"]`
        ))) add(el);
      }
    } catch (_) {}
    return out;
  },

  _lmbExitDisconnectMode(silent) {
    const mode = this._lmbDisconnectMode;
    if (!mode) return false;
    try {
      for (const item of mode.bindings || []) {
        try { item.el.removeEventListener("pointerdown", item.down, true); } catch (_) {}
        try { item.el.removeEventListener("click", item.click, true); } catch (_) {}
        try { item.el.classList.remove("lmb-disconnect-candidate"); } catch (_) {}
      }
      if (mode.keydown) document.removeEventListener("keydown", mode.keydown, true);
    } catch (_) {}
    this._lmbDisconnectMode = null;
    if (!silent) { try { new Notice("已退出连线选择", 1200); } catch (_) {} }
    return true;
  },

  _lmbDisconnectChoiceLabel(edge, nodeId, nodes) {
    try {
      const otherId = edge.fromNode === nodeId ? edge.toNode : edge.fromNode;
      const other = (Array.isArray(nodes) ? nodes : []).find((n) => n && n.id === otherId);
      let text = other && typeof other.text === "string" ? other.text : otherId;
      text = String(text || "未知卡片").split(/\r?\n/)[0]
        .replace(/^[#>*\-+\s]+/, "").replace(/\[\[|\]\]/g, "").trim();
      if (text.length > 32) text = text.slice(0, 32) + "…";
      return `断开与「${text || "未命名卡片"}」的连线`;
    } catch (_) { return "断开这条连线"; }
  },

  _lmbEnterDisconnectMode(file, canvas, nodeId, candidates, data) {
    this._lmbExitDisconnectMode(true);
    const bindings = [];
    let allResolved = true;
    for (const edge of candidates) {
      const targets = this._lmbDisconnectEdgeTargets(canvas, edge.id);
      if (!targets.length) { allResolved = false; break; }
      const label = this._lmbDisconnectChoiceLabel(edge, nodeId, data.nodes);
      for (const el of targets) {
        const down = (ev) => {
          try { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); } catch (_) {}
        };
        const click = (ev) => {
          try { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); } catch (_) {}
          this._lmbExitDisconnectMode(true);
          this._lmbDeleteCanvasEdge(file, canvas, edge.id).catch(() => {});
        };
        try {
          el.classList.add("lmb-disconnect-candidate");
          el.setAttribute("aria-label", label);
          el.addEventListener("pointerdown", down, true);
          el.addEventListener("click", click, true);
          bindings.push({ el, down, click });
        } catch (_) {}
      }
    }
    if (!allResolved || !bindings.length) {
      for (const item of bindings) {
        try { item.el.removeEventListener("pointerdown", item.down, true); } catch (_) {}
        try { item.el.removeEventListener("click", item.click, true); } catch (_) {}
        try { item.el.classList.remove("lmb-disconnect-candidate"); } catch (_) {}
      }
      const items = candidates.map((edge) => ({
        edgeId: edge.id,
        label: this._lmbDisconnectChoiceLabel(edge, nodeId, data.nodes)
      }));
      try {
        new LMBNodeSuggester(this.app, items,
          (it) => { this._lmbDeleteCanvasEdge(file, canvas, it.edgeId).catch(() => {}); }).open();
      } catch (_) { new Notice("无法定位连线，请先直接点选要删除的线", 2600); }
      return;
    }
    const keydown = (ev) => {
      if (ev && ev.key === "Escape") {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
        this._lmbExitDisconnectMode(false);
      }
    };
    document.addEventListener("keydown", keydown, true);
    this._lmbDisconnectMode = { bindings, keydown, filePath: file.path, nodeId };
    new Notice("请选择要断开的高亮连线；Esc 或再次点“断开”可取消", 4200);
  },

  async lmbDisconnectCard(barCtx) {
    if (this._lmbDisconnectMode) {
      this._lmbExitDisconnectMode(false);
      return false;
    }
    const ctx = this.activeCanvasContext();
    const view = ctx && ctx.leaf && ctx.leaf.view;
    const canvas = view && view.canvas;
    const file = (barCtx && barCtx.file) || (ctx && ctx.file);
    const nodeId = barCtx && barCtx.nodeId;
    if (!canvas || !file || !nodeId || typeof canvas.getData !== "function") {
      new Notice("无法读取当前画布或选中卡片", 2400);
      return false;
    }
    const data = canvas.getData();
    const sidecar = (this.autoEdges && this.autoEdges.get(file.path)) || new Set();
    const plan = lmbPlanDisconnect(nodeId, data && data.edges, sidecar);
    if (plan.kind === "none") {
      new Notice("这张卡片没有连线", 1600);
      return false;
    }
    if (plan.kind === "direct") return this._lmbDeleteCanvasEdge(file, canvas, plan.edgeId);
    this._lmbEnterDisconnectMode(file, canvas, nodeId, plan.candidates, data);
    return true;
  },

  async _lmbDeleteCanvasEdge(file, canvas, edgeId) {
    if (!canvas || typeof canvas.getData !== "function" || typeof canvas.setData !== "function") {
      new Notice("当前 Obsidian 版本不支持直接修改连线", 2200);
      return false;
    }
    const latest = canvas.getData();
    const edges = latest && Array.isArray(latest.edges) ? latest.edges : [];
    const edge = edges.find((e) => e && e.id === edgeId);
    if (!edge) { new Notice("这条连线已经不存在", 1600); return false; }
    const next = Object.assign({}, latest, {
      nodes: Array.isArray(latest.nodes) ? latest.nodes.map((n) => Object.assign({}, n)) : [],
      edges: edges.filter((e) => e && e.id !== edgeId).map((e) => Object.assign({}, e))
    });
    const sidecar = (this.autoEdges && this.autoEdges.get(file.path)) || new Set();
    const wasAuto = sidecar.has(edgeId);
    this._instantSkip = Date.now() + 1200;
    canvas.setData(next);
    // setData 成功后再改账本；若 Canvas 拒绝写入，不能留下“线还在、登记已删”的半状态。
    sidecar.delete(edgeId);
    if (this.autoEdges) this.autoEdges.set(file.path, sidecar);
    if (typeof canvas.requestFrame === "function") canvas.requestFrame();
    if (typeof canvas.requestSave === "function") canvas.requestSave();
    if (this.persistAutoSizeSoon) this.persistAutoSizeSoon();
    this._barSig = null;
    this._lmbLastDisconnected = {
      filePath: file.path, canvas, edge: Object.assign({}, edge), wasAuto, at: Date.now()
    };
    const notice = new Notice("已断开连线", 6500);
    try {
      const host = notice && notice.noticeEl;
      if (host && host.createEl) {
        host.createEl("button", { text: "撤销" }).addEventListener("click", () => {
          this._lmbUndoDisconnectedEdge().catch(() => {});
          try { notice.hide(); } catch (_) {}
        });
      }
    } catch (_) {}
    return true;
  },

  async _lmbUndoDisconnectedEdge() {
    const rec = this._lmbLastDisconnected;
    if (!rec || Date.now() - rec.at > 30000) {
      new Notice("没有可撤销的断线操作", 1600);
      return false;
    }
    const canvas = rec.canvas;
    const latest = canvas && typeof canvas.getData === "function" ? canvas.getData() : null;
    if (!latest || !Array.isArray(latest.edges)) return false;
    if (!latest.edges.some((e) => e && e.id === rec.edge.id)) {
      const next = Object.assign({}, latest, {
        nodes: Array.isArray(latest.nodes) ? latest.nodes.map((n) => Object.assign({}, n)) : [],
        edges: latest.edges.map((e) => Object.assign({}, e)).concat([Object.assign({}, rec.edge)])
      });
      canvas.setData(next);
      if (typeof canvas.requestFrame === "function") canvas.requestFrame();
      if (typeof canvas.requestSave === "function") canvas.requestSave();
    }
    if (rec.wasAuto && this.autoEdges) {
      const sidecar = this.autoEdges.get(rec.filePath) || new Set();
      sidecar.add(rec.edge.id);
      this.autoEdges.set(rec.filePath, sidecar);
    }
    if (this.persistAutoSizeSoon) this.persistAutoSizeSoon();
    this._lmbLastDisconnected = null;
    this._barSig = null;
    new Notice("已恢复连线", 1600);
    return true;
  },

  /**
   * v0.16.1：给画布上的**双重摘录卡**打标（nodeEl 加 lmb-dual class）。
   *
   * 为什么要这个（Bug5 的完整因果）：
   *   v0.11.3~v0.15.0 靠卡里那行 `> [!lmb-view]` callout 当 CSS 判据
   *   （`:has(.callout[data-callout="lmb-view"]) img{display:none}`）→ 有效。
   *   v0.16.0 卡片精简后新卡不写这行了，把 CSS 判据换成
   *   `:has(a[href*=".pdf#page="]):has(img)` —— **实测不命中**，双重卡在文字视图下
   *   图文并存（用户反馈 Bug5）。根因：canvas 卡片里指向 .pdf 的 internal-link，
   *   Obsidian 渲染时对**非 md 文件**很可能丢弃 #page= 子路径（href/data-href 只剩
   *   "xxx.pdf"），属性选择器匹配不上 → 猜 DOM 结构不如不让 CSS 猜。
   *
   *   修法（本函数）：判定权收回 JS —— 用 lmbPickBarActions().view（markdown 层，
   *   同时含 pdf 引用行 + 截图 embed）判双重卡，把结果**打在 nodeEl** 上
   *   （class `lmb-dual`）；CSS 改用 `.lmb-dual … img{display:none}`。
   *   这样 CSS 与 JS 判定 **100% 同源**：JS 给「视图」按钮的判据 = CSS 藏图的判据，
   *   不会出现「图片被 CSS 藏了却没有按钮切回来」的死角。
   *
   * 为什么打在 nodeEl 而不是 contentEl：markdown **重渲染会重建** contentEl
   *   （class 随之丢失、缓存却以为没变 → 永不重打 → 标记静默失效）；nodeEl 的
   *   生命周期 = 节点生命周期，稳定。
   *
   * 性能：120ms 一次，遍历全部节点。用 simpleHash(text) 缓存，文本没变的卡
   *   直接跳过（正则不再跑）；nodeEl 未就绪的卡**不写缓存**，下轮重试。
   *
   * 副作用清理：onunload 不特意摘 class —— class 是无害标记，插件重载后本函数
   *   会重新对齐（变非双重卡的卡会被 toggle 掉）。
   */
  lmbMarkDualCards(canvas) {
    try {
      if (!this._lmbDualCache) this._lmbDualCache = new Map();
      const cache = this._lmbDualCache;
      const nodes = canvas && canvas.nodes;
      if (!nodes) return;
      const entries = (typeof nodes.entries === "function") ? nodes.entries() : Object.entries(nodes);
      for (const [id, node] of entries) {
        if (!node || typeof node.text !== "string" || !node.text) continue;
        const hash = this.simpleHash(node.text);
        const c = cache.get(id);
        if (c && c.hash === hash) continue;              // 文本没变 → 标记已在 DOM 上
        const isDual = !!lmbPickBarActions(node.text).view;
        const el = node.nodeEl || node.contentEl;
        // host 只用来确认内容容器已渲染；class 本身打 nodeEl（抗 markdown 重渲染）
        const host = el && el.querySelector
          ? (el.querySelector(".canvas-node-content") || el.querySelector(".markdown-rendered"))
          : null;
        if (!host) continue;                             // 未就绪 → 不写缓存，下轮重试
        if (el.classList) el.classList.toggle("lmb-dual", isDual);
        cache.set(id, { hash: hash, dual: isDual });
      }
      // 缓存里已删除节点的条目顺手清掉（防长期使用内存缓慢增长）
      const has = (typeof nodes.has === "function") ? (k) => nodes.has(k) : (k) => (k in nodes);
      for (const id of Array.from(cache.keys())) {
        if (!has(id)) cache.delete(id);
      }
    } catch (_) { /* noop：打标失败只影响显隐，绝不能打断轮询 */ }
  },

  /**
   * v0.13.7：即时从**当前** canvas 选中重建 _barCtx（不依赖轮询缓存）。
   *
   * 为什么需要：轮询每 120ms 跑一次，而 canvas.getSelection() 会**间歇性**返回空
   *   （焦点切换 / Modal 开关 / canvas 内部 state 刷新的瞬间）。那一刻 tick 走
   *   _lmbHideBar() 把 _barCtx 清成 null；等下次 tick 重建（最多 120ms 后）之前，
   *   用户点按钮就会拿到 null —— 旧版直接 `if (!c) return` 静默退出，
   *   用户视角"点了没反应、连 Notice 都不弹"。
   *
   * 这里绕开轮询缓存，直接重新解析一次当前选中；拿不到才让调用方提示用户。
   * 只处理「恰好 1 个 text 节点」，与 tick 的判定保持一致（多选/没选中/group 不算）。
   */
  _lmbRebuildBarCtx() {
    try {
      const ctx = this.activeCanvasContext();
      if (!ctx) return null;
      const view = ctx.leaf && ctx.leaf.view;
      const canvas = view ? view.canvas : null;
      if (!canvas || !canvas.nodes) return null;
      let arr = [];
      try {
        const sel = typeof canvas.getSelection === "function"
          ? canvas.getSelection() : canvas.selection;
        arr = sel ? Array.from(sel) : [];
      } catch (_) { arr = []; }
      const nodes = arr.filter((n) => n && typeof n.text === "string" && n.type !== "group");
      if (nodes.length !== 1) return null;
      const node = nodes[0];
      const nodeEl = node.nodeEl || node.contentEl;
      if (!nodeEl) return null;
      const acts = lmbPickBarActions(node.text);
      try {
        const data = typeof canvas.getData === "function" ? canvas.getData() : null;
        const sidecar = (this.autoEdges && this.autoEdges.get(ctx.file.path)) || new Set();
        acts.disconnect = lmbPlanDisconnect(node.id, data && data.edges, sidecar).kind !== "none";
      } catch (_) { acts.disconnect = false; }
      this._barCtx = { file: ctx.file, nodeId: node.id, node, acts, nodeEl };
      return this._barCtx;
    } catch (_) { return null; }
  },

  /**
   * v0.13.3：按 file+nodeId 找到 canvas 节点，实际测量 DOM 高度并写回 canvas json。
   *   返回 Promise（让 caller 可以 then 里 tick；fire-and-forget 也行）。
   *   复用 32-plugin-canvas.js 的 lmbFitNodeActual（DOM 是真相，最准）。
   *   写文件模式与 processCanvas 一致：selfWritten 防自写循环、缩进与原文件保持一致。
   */
  /** 为手动高度提交创建全新的数据/节点引用，避免原地修改实时节点导致 Canvas 跳过重绘。 */
  _lmbCloneCanvasForHeight(data, nodeId, height) {
    if (!data || !Array.isArray(data.nodes)) return null;
    const cloned = Object.assign({}, data, {
      nodes: data.nodes.map((n) => Object.assign({}, n)),
      edges: Array.isArray(data.edges) ? data.edges.map((e) => Object.assign({}, e)) : []
    });
    const node = cloned.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    node.height = height;
    return { data: cloned, node };
  },

  lmbFitNodeById(file, nodeId, nodeHint) {
    return (async () => {
      try {
        // v0.14.1：每个 early return 都带编号探针。上一版只探了分支入口（「开始调整…」
        //   弹了），但函数内部的 4 个无声 early return 仍然在静默退出 —— 用户看到的
        //   还是"只有探针没下文"。编号探针弹哪个，断点就在哪，一步定位不用再猜。
        if (!file || !nodeId) {
          try { new Notice("fit[1] 缺少 file 或 nodeId", 2600); } catch (_) {}
          return null;
        }
        const ctx = this.activeCanvasContext();
        if (!ctx) {
          try { new Notice("fit[2] 拿不到画布上下文（activeCanvasContext 为空）", 2600); } catch (_) {}
          return null;
        }
        const view = ctx.leaf && ctx.leaf.view;
        const canvas = view ? view.canvas : null;
        if (!canvas || !canvas.nodes) {
          try { new Notice("fit[3] 拿不到 canvas 对象或 nodes 集合", 2600); } catch (_) {}
          return null;
        }
        // v0.13.6：优先 canvas 内部 API（getData / setData / requestSave）。
        //   旧版走「读文件 → 改 → 写文件」—— 磁盘往返慢是次要的，**致命的是改了 live
        //   node 却没调 requestSave，canvas 内部 state 不刷新 → 视觉上什么都没变**。
        //   instantAttach（v0.5.0 起）早就证明 setData + requestSave 是毫秒级生效的正路。
        const canInternal = typeof canvas.getData === "function"
          && typeof canvas.setData === "function"
          && typeof canvas.requestSave === "function";
        // v0.14.2：**节点对象由调用方直接传入（nodeHint），不再依赖 canvas.nodes.get 反查**。
        //   v0.14.1 探针实锤：get(nodeId) 返回的对象 type=undefined（该环境节点对象
        //   结构与预期不符），导致 fit[4] 静默退出。而 _barCtx 里的 node 是 tick 从
        //   selection 拿的、经过 `typeof n.text === "string"` 验证的对象 —— 直接用它。
        //   同时 type 检查放宽为 text 检查：能 fit 的判据是"有文本可量"，不是某个
        //   特定字段的字面值。
        let node = (nodeHint && typeof nodeHint.text === "string") ? nodeHint : null;
        if (!node) {
          node = typeof canvas.nodes.get === "function" ? canvas.nodes.get(nodeId) : canvas.nodes[nodeId];
        }
        if (!node || typeof node.text !== "string") {
          try {
            const keys = node ? Object.keys(node).slice(0, 8).join(",") : "无";
            new Notice("fit[4] 节点不可用（"
              + (node
                ? "keys=[" + keys + "]"
                : "未找到，id=" + String(nodeId == null ? "null" : nodeId).slice(0, 8)) + "）", 3600);
          } catch (_) {}
          return null;
        }
        // v0.14.3：fit[5] 中间探针已移除（链路验证完成；测量段自身有兜底 ——
        //   naturalH=0 时会弹「未能测量内容高度」，不会静默）。
        // v0.13.5：等 nodeEl 就绪（最多 500ms）。canvas reactive 渲染是异步的，
        //   点 fit 按钮时 markdown 可能还在 layout —— 直接测 scrollHeight 会得 0。
        await this._lmbWaitForNodeEl(node, 500);

        // v0.16.12：测量离屏自然展开副本，避免当前卡片的固定高度、滚动条宽度和
        // overflow 状态污染结果。同一内容/同一外框宽度应得到稳定的同一高度。
        let naturalH = 0;
        let measuredWholeCard = false;
        try {
          const wrapperEl = node.nodeEl || node.contentEl;
          const contentEl = wrapperEl && wrapperEl.querySelector
            ? (wrapperEl.querySelector(".canvas-node-content")
              || wrapperEl.querySelector(".markdown-rendered") || wrapperEl)
            : null;
          // v0.16.2【Bug4 残留根因】：等卡内**图片加载完**（最多 2s）再实测。
          //   _lmbWaitForNodeEl 等的是 nodeEl 存在，不是内容 layout 完成 —— img 未加载时
          //   高度是 0/占位，实测必然偏小 → 「一次 fit 不到位，再点一次才对」（用户长文
          //   自建卡带图时症状完全吻合：第一次裁、第二次图加载完了就对了）。
          //   complete = 加载完成或失败（失败也占位，等它没有意义）；循环 120ms 一查。
          try {
            const imgs = contentEl && contentEl.querySelectorAll
              ? Array.from(contentEl.querySelectorAll("img")) : [];
            const tImg = Date.now();
            while (Date.now() - tImg < 2000) {
              if (!imgs.some((im) => !im.complete)) break;
              await new Promise((r) => setTimeout(r, 120));
            }
          } catch (_) {}
          if (contentEl && contentEl.children && contentEl.children.length > 0) {
            // 等字体就绪；用短超时避免第三方字体异常让按钮一直没有响应。
            try {
              const fontsReady = contentEl.ownerDocument && contentEl.ownerDocument.fonts
                ? contentEl.ownerDocument.fonts.ready : null;
              if (fontsReady && typeof fontsReady.then === "function") {
                await Promise.race([fontsReady, new Promise((r) => setTimeout(r, 600))]);
              }
            } catch (_) {}
            let scale = 1;
            try {
              const s = canvas && canvas.scale;
              if (s && isFinite(s) && s > 0) scale = s;
            } catch (_) { scale = 1; }
            // 至少等待三次一致（而不是旧版两次），并取稳定样本；每次都是全新的自然布局副本。
            let previous = 0, best = 0, stable = 0;
            for (let sample = 0; sample < 6; sample++) {
              const measured = lmbMeasureNaturalCard(wrapperEl, contentEl, scale);
              if (measured > 0) {
                best = Math.max(best, measured);
                if (previous > 0 && Math.abs(measured - previous) < 1) stable++;
                else stable = 0;
                previous = measured;
              }
              if (stable >= 2) break;
              if (sample < 5) await new Promise((r) => setTimeout(r, 50));
            }
            naturalH = stable >= 2 ? previous : best;
            measuredWholeCard = naturalH > 0;
          }
        } catch (_) {}
        // 兜底：子元素未就绪（markdown 未渲染完 / children 为空）→ 估算
        let usedEstimate = false;
        if (naturalH <= 0) {
          try {
            const size = this.estimateSizeFor(node.text);
            naturalH = Math.round(size.h);
            usedEstimate = naturalH > 0;
            try { new Notice("内容未就绪，使用估算高度", 1600); } catch (_) {}
          } catch (_) {}
        }
        // v0.14.6：合理性校验 —— 实测值若明显小于估算（< 60%）则采用估算值。
        //   目的：防止测量异常时把卡片压得**比内容还矮**（内容会被裁剪，比"留白"
        //   糟糕得多）。估算走 v0.13.3 修过 lmbRenderedText 的 estimateSizeFor。
        try {
          const est = this.estimateSizeFor(node.text);
          const estH = Math.round((est && est.h) || 0);
          if (estH > 0 && naturalH > 0 && naturalH < estH * 0.6) {
            const measuredH = Math.round(naturalH);
            naturalH = estH;
            try {
              new Notice(`实测 ${measuredH}px 明显小于估算 ${estH}px，已采用估算值（防止内容被裁）`, 3000);
            } catch (_) {}
          }
        } catch (_) {}
        const origH = node.height;
        let beforeDomH = null;
        try {
          const beforeEl = node.nodeEl || node.contentEl;
          const beforeRect = beforeEl && beforeEl.getBoundingClientRect ? beforeEl.getBoundingClientRect() : null;
          const beforeScale = canvas && isFinite(canvas.scale) && canvas.scale > 0 ? canvas.scale : 1;
          if (beforeRect && beforeRect.height > 0) beforeDomH = beforeRect.height / beforeScale;
        } catch (_) {}
        // v0.14.8：评论余量。评论块（含折叠/展开 callout）的底部内边距比普通行大，
        //   固定 24px buffer 在带评论的卡片上会被裁掉底行（用户反馈「到了肯定是劳动力」
        //   末尾被截）。检测文本里有没有评论 callout → 有则额外 +16 buffer（call 块底部
        //   padding + 边框）。不引入精确测量（callout 内容高度由内容决定），16 是经验值。
        const hasComment = (function () {
          try {
            const t = node && node.text;
            if (typeof t !== "string" || !LMB_COMMENT_CALLOUT_RE) return false;
            return t.split(/\r?\n/).some((line) => LMB_COMMENT_CALLOUT_RE.test(line));
          } catch (_) { return false; }
        })();
        // v0.16.2【Bug1 残留根因】：节点自身 chrome（padding + border）从「固定 buffer
        //   经验值」改为**精确测量**。naturalH 是从 contentEl 顶部算到内容底部，但
        //   node.height 指整个卡片 —— contentEl 之外的节点 padding（实测上下各 ~10-12px，
        //   v0.13.3 注释）此前全靠 buffer 24 兜底；有评论时 buffer 40 = 24 + 16，而评论
        //   callout 自身的 padding + border 又吃掉 ~15-25px，两下相抵经常差一点 → 边缘裁剪。
        //   现在：chromePad = nodeEl 实测的 paddingTop/borderTop + paddingBottom/borderBottom
        //   （基线是 contentEl.top，所以 padding-top 也必须补回来；contentEl 自己的
        //   paddingBottom 已在 naturalH 里单独加过，不重复计）。buffer 降为纯内容余量：
        //   有评论 28（末尾 callout 的 padding+border+安全余量）、无评论 8。
        let chromePad = 0;
        try {
          const pel = node.nodeEl || node.contentEl;
          const ncs = pel ? getComputedStyle(pel) : null;
          if (ncs) {
            chromePad = (parseFloat(ncs.paddingTop) || 0) + (parseFloat(ncs.borderTopWidth) || 0)
              + (parseFloat(ncs.paddingBottom) || 0) + (parseFloat(ncs.borderBottomWidth) || 0);
          }
          /* v0.16.6 P1-3：**删掉** contentEl 的 paddingTop/borderTop 补偿 —— 它是重复计入。
           *   旧注释（v0.16.3）称「cRect.top 在 contentEl 的 padding-top **内侧**」，这句是错的：
           *   getBoundingClientRect().top 返回的是 **border-box 顶边**，位于 padding-top
           *   **外侧**。所以上面 walk 里 `r.bottom - cRect.top` 的差值**已经包含**
           *   contentEl 的 borderTop + paddingTop，这里再补一次就是双倍。
           *   后果：每次 fit 系统性多算 contentEl 的 paddingTop+borderTop（canvas 卡片
           *   通常 10~40px）→ 「点一次涨一截、留白越来越多」。
           *   pel（nodeEl）自身那一份 paddingTop/borderTop 是**另一段距离**（nodeEl 顶边
           *   → contentEl 顶边），必须保留，上面的 ncs 计算不受影响。 */
        } catch (_) { chromePad = 0; }
        // v0.16.1【Bug4 根因之一】：上限 1200 → 4000。实测（walk 叶节点）是 DOM 真相，
        //   用户手写的长文自建卡内容远超 1200px，旧钳制把它压回去 → 内容被裁、
        //   「怎么点高度都不对」。摘录卡文本短，4000 的天花板不构成行为变化。
        //   （估算路径的 900 钳制也同步放宽到 2000 —— 见 32-plugin-canvas.js。）
        // estimateSizeFor 返回的已经是整张卡片高度；只有 DOM 实测值才需要补 chrome/buffer。
        let finalH = naturalH > 0
          ? lmbFinalizeCardHeight(naturalH, chromePad, hasComment,
            usedEstimate || measuredWholeCard)
          : (origH || 200);
        // 不要在 setData 前直接修改 nodeHint：它通常就是 Canvas 的实时节点对象。
        // ---- v0.14.9：写入改用「内存数据」而非「文件数据」+ 必要时主动重载画布 ----
        // v0.14.5 起只走文件写（当时判定 setData 无效），带来两个副作用，正是用户这次
        //   反馈的现象：
        //   ① 文件里的内容可能**落后于内存**（用户刚拖动卡片、Obsidian 还没落盘）→
        //      我把旧内容写回 = **覆盖了用户的拖动**（症状「卡片跳回拖拽前的位置」）
        //   ② 写完依赖 Obsidian vault 监听触发 canvas 重载，但该监听不总是触发 →
        //      数据改了画面没刷（症状「点高度没反应，拉伸一下才展开」「要点两下」）
        // 修法：以 canvas.getData() 的**内存最新数据**为准（含用户未落盘的改动），改完
        //   height 后 ① setData 更新内存 ② 用同一份数据写文件（不丢任何改动）
        //   ③ 等 250ms 看渲染跟上没，没跟上就**主动 view.loadFile() 强制重载画布**。
        let memData = null;
        try { memData = canInternal ? canvas.getData() : null; } catch (_) { memData = null; }
        let memOk = false;
        if (memData && Array.isArray(memData.nodes)) {
          const cloned = this._lmbCloneCanvasForHeight(memData, nodeId, finalH);
          if (cloned) {
            memData = cloned.data;
            const changedNode = cloned.node;
            // v0.16.4 修复 P2-7：手动 fit 改高度后仍做一次组内重居中——locked 只锁
            //   「尺寸不被自动 fit 覆盖」，不锁「对齐」；否则撑高后中心偏出父卡轴线且永不回正。
            try {
              lmbRecenterNode(changedNode, memData.nodes,
                Array.isArray(memData.edges) ? memData.edges : (memData.edges = []),
                (this.autoEdges && this.autoEdges.get(file.path)) || new Set());
            } catch (_) {}
            try {
              canvas.setData(memData);
              if (typeof canvas.requestFrame === "function") canvas.requestFrame();
              canvas.requestSave();
              memOk = true;
            } catch (_) {}
          }
        }
        // 写文件：优先用内存数据（含用户拖动），拿不到才回退「读文件→改→写」
        // 内部通道成功时由 requestSave 单独落盘，避免与 adapter.write 双写竞争。
        let writeOk = memOk;
        if (!writeOk) {
          try {
            const raw = await this.app.vault.read(file);
            let d; try { d = JSON.parse(raw); } catch (_) { d = null; }
            const arr = d && d.nodes;
            if (Array.isArray(arr)) {
              const idx = arr.findIndex((n) => n.id === nodeId);
              if (idx >= 0) {
                arr[idx].height = finalH;
                // v0.16.4 P2-7：文件写路径同样补组内重居中
                try {
                  lmbRecenterNode(arr[idx], arr,
                    Array.isArray(d.edges) ? d.edges : (d.edges = []),
                    (this.autoEdges && this.autoEdges.get(file.path)) || new Set());
                } catch (_) {}
                const indent = /\n\t"/.test(raw) ? "\t" : "  ";
                if (this.selfWritten) this.selfWritten.set(file.path, Date.now()); // v0.16.4 P2-4 时间戳
                await this.app.vault.adapter.write(file.path, JSON.stringify(d, null, indent));
                writeOk = true;
              }
            }
          } catch (_) {}
        }
        // 等 vault watcher → canvas 重载
        await new Promise((r) => setTimeout(r, 250));
        // v0.16.13：闭环验证真正的滚动宿主。离屏高度只是预测；最终正确性的判据必须是
        // scrollHeight <= clientHeight。若主题/flex/选中边框造成映射偏差，按实际溢出量
        // 补高后重绘，最多三轮；每轮从最新内存只合并高度，不覆盖用户刚拖动的位置。
        let overflowCorrected = 0;
        if (canInternal) {
          for (let pass = 0; pass < 3; pass++) {
            let overflow = 0;
            try {
              const liveNow = typeof canvas.nodes.get === "function"
                ? canvas.nodes.get(nodeId) : canvas.nodes[nodeId];
              const liveWrapper = liveNow && (liveNow.nodeEl || liveNow.contentEl);
              const liveContent = liveWrapper && liveWrapper.querySelector
                ? (liveWrapper.querySelector(".canvas-node-content")
                  || liveWrapper.querySelector(".markdown-rendered") || liveWrapper)
                : liveWrapper;
              overflow = lmbVerticalOverflow(liveContent);
            } catch (_) { overflow = 0; }
            if (overflow <= 0) break;

            const correctedH = lmbHeightAfterOverflow(finalH, overflow);
            if (correctedH <= finalH) break;
            overflowCorrected += correctedH - finalH;
            finalH = correctedH;
            try {
              const latest = canvas.getData();
              const corrected = this._lmbCloneCanvasForHeight(latest, nodeId, finalH);
              if (!corrected) break;
              memData = corrected.data;
              try {
                lmbRecenterNode(corrected.node, memData.nodes,
                  Array.isArray(memData.edges) ? memData.edges : (memData.edges = []),
                  (this.autoEdges && this.autoEdges.get(file.path)) || new Set());
              } catch (_) {}
              canvas.setData(memData);
              if (typeof canvas.requestFrame === "function") canvas.requestFrame();
              canvas.requestSave();
              writeOk = true;
            } catch (_) { break; }
            await new Promise((r) => setTimeout(r, 180));
          }
        }
        // 回读校验：文件 + canvas 内存
        let readBack = null, canvasReadBack = null;
        try {
          const d2 = JSON.parse(await this.app.vault.read(file));
          const n2 = d2 && d2.nodes && d2.nodes.find((nn) => nn.id === nodeId);
          readBack = n2 ? n2.height : null;
        } catch (_) {}
        if (canInternal) {
          try {
            const data3 = canvas.getData();
            const n3 = data3 && data3.nodes && data3.nodes.find((nn) => nn.id === nodeId);
            canvasReadBack = n3 ? n3.height : null;
          } catch (_) {}
        }
        let renderStale = false;
        try {
          const liveNow = canvas && canvas.nodes
            ? (typeof canvas.nodes.get === "function" ? canvas.nodes.get(nodeId) : canvas.nodes[nodeId]) : null;
          const afterEl = liveNow && (liveNow.nodeEl || liveNow.contentEl);
          const afterRect = afterEl && afterEl.getBoundingClientRect ? afterEl.getBoundingClientRect() : null;
          const afterScale = canvas && isFinite(canvas.scale) && canvas.scale > 0 ? canvas.scale : 1;
          const afterDomH = afterRect && afterRect.height > 0 ? afterRect.height / afterScale : null;
          renderStale = beforeDomH !== null && afterDomH !== null
            && Math.abs(finalH - origH) >= 2 && Math.abs(afterDomH - beforeDomH) < 1;
        } catch (_) { renderStale = false; }
        // 渲染没跟上（canvas 内存高度 ≠ 设定值）→ **主动重载画布**。
        //   这是「点了没反应、拉伸一下才展开」的直接解药：不再干等 Obsidian 的监听，
        //   自己调 view.loadFile(file) 强制重读文件 + 重建节点（选中会保留在同一 view）。
        let reloaded = false;
        if ((canvasReadBack !== null && canvasReadBack !== finalH) || renderStale) {
          try {
            // requestSave 尚未落盘时先用刚才的完整新快照兜底，再重载视图。
            if (readBack !== finalH && memData) {
              const raw5 = await this.app.vault.read(file);
              const indent5 = /\n\t"/.test(raw5) ? "\t" : "  ";
              if (this.selfWritten) this.selfWritten.set(file.path, Date.now());
              await this.app.vault.adapter.write(file.path, JSON.stringify(memData, null, indent5));
              readBack = finalH;
            }
            if (ctx.leaf && ctx.leaf.view && typeof ctx.leaf.view.loadFile === "function") {
              await ctx.leaf.view.loadFile(file);
              await new Promise((r) => setTimeout(r, 220));
              reloaded = true;
              try {
                const d4 = JSON.parse(await this.app.vault.read(file));
                const n4 = d4 && d4.nodes && d4.nodes.find((nn) => nn.id === nodeId);
                readBack = n4 ? n4.height : readBack;
              } catch (_) {}
            }
          } catch (_) {}
        }
        if (this.persistAutoSizeSoon) this.persistAutoSizeSoon();
        let store = this.autoSize ? this.autoSize.get(file.path) : null;
        if (!store) { store = new Map(); if (this.autoSize) this.autoSize.set(file.path, store); }
        store.set(nodeId, { hash: this.simpleHash(node.text), w: node.width, h: finalH, locked: true });
        // 操作反馈：测量值 + 文件回读 + canvas 内存回读（双保险：哪条通道生效都显示）
        try {
          const tag = usedEstimate ? "（估算：子元素未就绪）" : "";
          const overflowTag = overflowCorrected > 0 ? `（溢出校正 +${overflowCorrected}px）` : "";
          const tail = reloaded ? "（已强制重载画布）" : "";
          new Notice(`卡片高度：${node.width}×${finalH}（内容 ${naturalH}px${tag}${overflowTag}）｜回读：${readBack == null ? "读不到" : readBack}${tail}`, 3600);
        } catch (_) {}
      } catch (err) {
        // v0.13.7：**异常绝不能静默吞掉**。旧版是 `catch (_) {}` —— 里面任何一步抛错
        //   （getData 不存在、autoSize 未初始化、vault 读取失败…）都被吞，用户视角
        //   就是"点了没反应、Notice 也不弹"。现在既弹 Notice 也打 console。
        console.warn("[lmb] lmbFitNodeById failed:", err);
        try {
          new Notice("调整高度失败：" + (err && err.message ? err.message : "未知错误"), 3500);
        } catch (_) {}
      }
    })();
  },

  /**
   * v0.13.9：命令面板入口「调整选中卡片高度」—— **完全不依赖悬浮栏**。
   *   背景：悬浮栏按钮排查了 5 版用户仍反馈没反应，无法区分是按钮 DOM 问题还是
   *   fit 逻辑问题。命令面板是 Obsidian 最稳的入口，用它做二分：
   *     命令能用 → 问题锁定在悬浮栏链路（按钮 DOM / 事件绑定）
   *     命令也坏 → fit 逻辑本身有问题，换方向修
   *   选卡复用现成的 pickCanvasNode（33-plugin-note-comment.js）：
   *   已选中一张 → 直接用；没选中/多选 → 弹模糊搜索列表让用户挑。
   */
  lmbFitSelectedCard() {
    return (async () => {
      try {
        const ctx = this.activeCanvasContext();
        if (!ctx) {
          try { new Notice("请先打开一个画布（canvas）再执行", 2500); } catch (_) {}
          return null;
        }
        const pick = await this.pickCanvasNode(ctx);
        if (!pick || !pick.node) return null;   // 用户取消选卡
        return await this.lmbFitNodeById(ctx.file, pick.node.id, pick.node);
      } catch (err) {
        console.warn("[lmb] fitSelectedCard failed:", err);
        try { new Notice("调整高度失败：" + (err && err.message ? err.message : "未知错误"), 3500); } catch (_) {}
        return null;
      }
    })();
  },

  /**
   * v0.13.5：等 node.nodeEl 就绪（最多 maxMs）。Obsidian canvas 异步渲染节点时，
   *   nodeEl 可能为 null → 直接 fit 拿不到 DOM。
   *   30ms 一次检查，避免空转。
   */
  _lmbWaitForNodeEl(node, maxMs) {
    return new Promise((resolve) => {
      if (!node) return resolve();
      if (node.nodeEl) return resolve();
      let elapsed = 0;
      const step = 30;
      const tick = () => {
        if (node.nodeEl) return resolve();
        if (elapsed >= maxMs) return resolve();
        elapsed += step;
        setTimeout(tick, step);
      };
      tick();
    });
  },

  /**
   * 按卡片内容决定三个按钮谁该出现。
   *   不是每张卡三个都适用：没有 PDF 引用行的卡点了「跳转」没反应，非双重卡点了
   *   「切换」也没反应 —— 宁可不显示，也不放点了没用的死按钮。
   */
  _lmbApplyBarActions(bar, acts) {
    try {
      const map = {
        comment: ".lmb-bar-comment", jump: ".lmb-bar-jump", view: ".lmb-bar-view",
        fit: ".lmb-bar-fit", disconnect: ".lmb-bar-disconnect"
      };
      for (const k of Object.keys(map)) {
        const b = bar.querySelector(map[k]);
        if (!b) continue;
        // jump 的可用性看 acts.jump 是否为字符串，其余看布尔位
        const ok = k === "jump" ? !!(acts && acts.jump) : !!(acts && acts[k]);
        lmbSetToolbarVisibility(b, ok ? "show" : "hideRemove");
      }
    } catch (_) { /* noop */ }
  },

  /** 隐藏（而非移除）所有悬浮栏 —— 切出 canvas / 没选中卡片时走这里 */
  _lmbHideBar() {
    try {
      this._barCtx = null;
      document.querySelectorAll(LMB_BAR_SEL).forEach((b) => lmbSetToolbarVisibility(b, "hideRemove"));
    } catch (_) { /* noop */ }
  },

  /**
   * 单次轮询。
   *   canvas 没有原生的「选中变化」事件（advanced-canvas 那个 selection-changed 是它自己
   *   monkey-patch 出来的，要引 monkey-around 依赖，不值得），所以只能轮询。
   *   一次轮询同时解决两件事：选中变化 → 重建按钮；视口平移缩放 → 重算位置。
   *
   *   性能上的分工（很重要）：
   *     - 位置**每轮都重算**：拖动卡片、平移画布时它都会变，而 getBoundingClientRect()
   *       只读两个元素，120ms 一次完全可以忽略。
   *     - 按钮**只在指纹变化时才重建**：那是要动 DOM 的（清 class、setIcon 已建好不再动，
   *       但要重设显隐与上下文），每帧做纯属浪费。
   *
   *   本函数是 setInterval 回调，**整体绝不能抛异常**，否则会每 120ms 刷一次错误。
   */
  lmbCanvasBarTick() {
    try {
      const ctx = this.activeCanvasContext();
      if (!ctx) { this._lmbHideBar(); return; }

      const view = ctx.leaf && ctx.leaf.view;
      const canvas = view ? view.canvas : null;
      if (!canvas) { this._lmbHideBar(); return; }

      // v0.16.1：双重摘录卡打标（Bug5 修复）。刻意放在「选中判定」**之前** ——
      //   打标服务的是**所有**卡的显隐（没选中也要打），不依赖 wrapperEl / 选中集合。
      //   失败被内部 try/catch 吞掉，绝不影响后面的浮层逻辑。
      this.lmbMarkDualCards(canvas);

      // 挂载点：优先官方的 wrapperEl（不参与缩放），退化为 DOM 查询
      const wrapperEl = canvas.wrapperEl
        || (ctx.leaf.containerEl && ctx.leaf.containerEl.querySelector(".canvas-wrapper"));
      if (!wrapperEl) { this._lmbHideBar(); return; }

      // 选中集合：getSelection() 优先，退化 .selection 属性
      let arr = [];
      try {
        const sel = typeof canvas.getSelection === "function"
          ? canvas.getSelection() : canvas.selection;
        arr = sel ? Array.from(sel) : [];
      } catch (_) { arr = []; }

      // 只服务「恰好选中 1 个文本节点」：
      //   没选中 / 多选 / 选中的是 file·link·group 节点 → 一律不显示。
      //   多选取第一个容易误操作（用户以为操作的是整组），不如干脆不显示。
      const nodes = arr.filter((n) => n && typeof n.text === "string" && n.type !== "group");
      if (nodes.length !== 1) { this._lmbHideBar(); return; }
      const node = nodes[0];

      const nodeEl = node.nodeEl || node.contentEl;
      if (!nodeEl || typeof nodeEl.getBoundingClientRect !== "function") { this._lmbHideBar(); return; }

      const bar = this.lmbEnsureCanvasBarEl(wrapperEl);
      if (!bar) return;

      // ① 位置（每轮重算）
      const p = lmbCalcBarPos(
        nodeEl.getBoundingClientRect(),
        wrapperEl.getBoundingClientRect(),
        { width: bar.offsetWidth, height: bar.offsetHeight }
      );
      bar.style.left = p.left + "px";
      bar.style.top = p.top + "px";

      // ② 按钮可用性（指纹变了 **或上下文丢了** 才重算）
      //    ⚠ 必须带 `|| !this._barCtx`：_lmbHideBar() 会清掉 _barCtx 但**不**重置 _barSig。
      //      若只看指纹，选中恢复后 sig 与上次完全相同 → 永远不再重建 _barCtx →
      //      浮层照样显示，但按钮点了没反应（正是「点过一次就失效」的根因）。
      //      触发路径：点击浮层按钮时 canvas 选中被瞬间清空 → tick 走 _lmbHideBar 清 ctx
      //      → 选中恢复 → sig 未变 → ctx 不再重建。
      let barData = null, edgeSig = "";
      try {
        barData = typeof canvas.getData === "function" ? canvas.getData() : null;
        edgeSig = ((barData && Array.isArray(barData.edges)) ? barData.edges : [])
          .filter((e) => e && (e.fromNode === node.id || e.toNode === node.id))
          .map((e) => e.id).sort().join(",");
      } catch (_) {}
      const sig = lmbBarSignature([node.id], { x: canvas.x, y: canvas.y, zoom: canvas.zoom })
        + "|edges:" + edgeSig;
      if (sig !== this._barSig || !this._barCtx) {
        this._barSig = sig;
        const acts = lmbPickBarActions(node.text);
        try {
          const sidecar = (this.autoEdges && this.autoEdges.get(ctx.file.path)) || new Set();
          acts.disconnect = lmbPlanDisconnect(node.id, barData && barData.edges, sidecar).kind !== "none";
        } catch (_) { acts.disconnect = false; }
        this._barCtx = { file: ctx.file, nodeId: node.id, node, acts, nodeEl };
        this._lmbApplyBarActions(bar, acts);
      }

      lmbSetToolbarVisibility(bar, "show");
    } catch (_) { /* noop：轮询回调绝不抛异常 */ }
  },

  /**
   * v0.13.1：注册浮层的「指针守卫」（全局一次，document 捕获阶段）。
   *
   * 为什么需要它：canvas 的选中逻辑多半监听 pointerdown / mousedown。浮层虽然是
   *   .canvas 的兄弟节点（事件不冒泡过去），但 canvas 常把监听挂在更外层，按下的
   *   一瞬间就会把选中清空 —— 于是 120ms 后轮询发现「没选中」→ 浮层消失、
   *   _barCtx 被清，表现为「点了一下按钮，之后就再也点不动」。
   *
   * 为什么放在 document 的**捕获**阶段：事件是先从 document 往下捕获、再冒泡回来的。
   *   挂在按钮自己的捕获监听上拦不住 —— document 的捕获比它更早执行。
   *
   * 为什么只拦 pointerdown / mousedown 而不拦 click：click 是独立事件对象，拦前面
   *   两个不影响按钮自己的 click 回调；反过来若把 click 也拦了，按钮就真点不动了。
   *   且这里只用 stopPropagation，不用 preventDefault —— 后者会连 hover / focus
   *   之类的原生反馈一起干掉。
   */
  _lmbInstallBarGuard() {
    try {
      if (this._barGuard) return;                 // 幂等
      const guard = (ev) => {
        try {
          const t = ev.target;
          if (!t || !t.closest) return;
          if (!t.closest(LMB_BAR_SEL)) return;    // 不是点在浮层上 → 一律不管
          ev.stopPropagation();
          ev.stopImmediatePropagation();
        } catch (_) { /* noop */ }
      };
      document.addEventListener("pointerdown", guard, true);
      document.addEventListener("mousedown", guard, true);
      this._barGuard = guard;
    } catch (_) { /* noop */ }
  },

  /** 拆除指针守卫（onunload 走；幂等） */
  _lmbUninstallBarGuard() {
    try {
      if (!this._barGuard) return;
      document.removeEventListener("pointerdown", this._barGuard, true);
      document.removeEventListener("mousedown", this._barGuard, true);
      this._barGuard = null;
    } catch (_) { this._barGuard = null; }
  },

  /** 启动悬浮栏轮询（onLayoutReady 调用；幂等） */
  lmbStartCanvasBarWatch() {
    try {
      if (this._barTimer) return;             // 防重入：重复启动会叠加 interval
      this._lmbInstallBarGuard();             // v0.13.1：先装守卫，再开始轮询
      // v0.13.8：启动时先全局清掉所有**版本不匹配**的旧浮层。
      //   canvas leaf 的 DOM 不随插件重载而重建，旧浮层会一直挂在 DOM 里，
      //   光靠 lmbEnsureCanvasBarEl 只能修好「当前这个 wrapperEl」的那一颗，
      //   其他 canvas leaf 上残留的旧浮层（旧版回调）还得靠这里兜底。
      this._lmbPurgeStaleBars();
      this._barTimer = setInterval(() => this.lmbCanvasBarTick(), LMB_BAR_POLL_MS);
      this.lmbCanvasBarTick();                // 先跑一次，避免刚进 canvas 要等 120ms 才出现
    } catch (_) { /* noop */ }
  },

  /**
   * v0.13.8：全局移除版本不匹配的旧悬浮栏。
   *   判定：`dataset.lmbBarVer !== LMB_BAR_VERSION`（旧版浮层压根没有这个字段）。
   */
  _lmbPurgeStaleBars() {
    try {
      document.querySelectorAll(LMB_BAR_SEL).forEach((b) => {
        if (!b.dataset || b.dataset.lmbBarVer !== LMB_BAR_VERSION) {
          if (b.parentNode) b.remove();
        }
      });
    } catch (_) { /* noop */ }
  },

  /** 停止轮询并移除浮层（onunload 调用；幂等） */
  lmbStopCanvasBarWatch() {
    try {
      this._lmbExitDisconnectMode(true);
      if (this._barTimer) { clearInterval(this._barTimer); this._barTimer = null; }
      this._lmbUninstallBarGuard();           // v0.13.1：守卫是 document 级的，不拆会一直拦事件
      this._barSig = null;
      this._barCtx = null;
      // 这里必须 remove 而不是隐藏：插件都卸载了，不该在 DOM 里留残留节点
      document.querySelectorAll(LMB_BAR_SEL).forEach((b) => { if (b.parentNode) b.remove(); });
    } catch (_) { /* noop */ }
  },

});
