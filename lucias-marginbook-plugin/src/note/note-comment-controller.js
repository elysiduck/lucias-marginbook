/* 33-plugin-note-comment —— 补充描述 + 独立评论（命令/点击编辑/批量）（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

  /* ==================== v0.8.0：卡片补充描述（note） ==================== */

  /**
   * v0.8.2：给当前画布所有摘录卡批量添加「空的补充描述框」。
   *   存在的意义：ribbon 按钮在某些环境不出现，命令面板又不好找 —— 给一条能立刻
   *   看到效果的入口。跑完每张摘录卡下方都会多出一个 callout 框（点开即可写）。
   *   已有补充描述的卡跳过，绝不覆盖用户已写的内容。
   */
  async addNoteBoxToAllCards() {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    // v0.16.4 修复 P1-3：读改写迁移到内存优先（与 processCanvas v0.16.1 同纪律），
    //   不再把「磁盘上的旧位置」钉回去（Bug6 同款坑：用户刚拖动未落盘时被覆盖）。
    const rd = await this._lmbReadCanvasData(ctx.file);
    if (!rd) { new Notice("画布读取失败"); return; }
    const data = rd.data;
    const nodes = data.nodes || [];
    const fold = !!this.settings.noteFoldByDefault;   // 跟随设置（默认 false = 展开，一眼能看见）
    let n = 0;
    for (const node of nodes) {
      if (node.type !== "text" || !node.text) continue;
      if (!EX_ID_RE.test(node.text)) continue;             // 只处理摘录卡
      // v0.16.6 P1-4：只认插件自有的 note 类型，用户自有 callout 不再被当「已有描述」
      if (lmbSplitNote(node.text, this.settings.noteCalloutType || "ppd-note").hasNote) continue;
      node.text = lmbJoinNote(node.text, "", {
        type: this.settings.noteCalloutType || "ppd-note",
        title: this.settings.noteTitle || "补充描述",
        fold,
        allowEmpty: true
      });
      const size = this.estimateSizeFor(node.text);
      node.width = Math.round(size.w);
      node.height = Math.round(size.h);
      let store = this.autoSize.get(ctx.file.path);
      if (!store) { store = new Map(); this.autoSize.set(ctx.file.path, store); }
      store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });
      n++;
    }
    if (!n) { new Notice("这个画布里没有需要添加描述框的摘录卡（可能都已经有了）"); return; }
    // v0.16.4 P1-3：统一写回（setData + requestSave + 同一份内存数据写盘）
    await this._lmbWriteCanvasData(ctx.file, data, rd.memCanvas, rd.raw);
    this.persistAutoSizeSoon();
    new Notice(`已给 ${n} 张摘录卡添加补充描述框（${fold ? "已折叠" : "已展开"}，点开即可写）`);
  },

  /**
   * v0.11.0：给画布里所有还没有评论栏的摘录卡批量挂「添加评论」底栏（存量卡入口）。
   *   已有评论的卡跳过，绝不覆盖用户已写内容。
   */
  async addCommentBoxToAllCards() {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    // v0.16.4 修复 P1-3：读改写迁移到内存优先（同 addNoteBoxToAllCards）
    const rd = await this._lmbReadCanvasData(ctx.file);
    if (!rd) { new Notice("画布读取失败"); return; }
    const data = rd.data;
    const nodes = data.nodes || [];
    let n = 0;
    for (const node of nodes) {
      if (node.type !== "text" || !node.text) continue;
      if (!EX_ID_RE.test(node.text)) continue;                 // 只处理摘录卡
      if (lmbSplitComment(node.text).hasComment) continue;     // 已有评论 → 跳过
      node.text = lmbJoinComment(node.text, "", { allowEmpty: true });
      const size = this.estimateSizeFor(node.text);
      node.width = Math.round(size.w);
      node.height = Math.round(size.h);
      let store = this.autoSize.get(ctx.file.path);
      if (!store) { store = new Map(); this.autoSize.set(ctx.file.path, store); }
      store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });
      n++;
    }
    if (!n) { new Notice("这个画布里的摘录卡都已经有评论栏了"); return; }
    // v0.16.4 P1-3：统一写回（setData + requestSave + 同一份内存数据写盘）
    await this._lmbWriteCanvasData(ctx.file, data, rd.memCanvas, rd.raw);
    this.persistAutoSizeSoon();
    new Notice(`已给 ${n} 张摘录卡添加评论栏（点评论栏直接写）`);
  },

  /* ==================== v0.11.0：独立评论（批注评论底栏） ==================== */

  /**
   * 把评论写进指定节点。commentText 为空串 = 移除评论栏。
   * 结构：评论 callout 永远追加在卡片文本最末（补充描述之后），渲染成底栏。
   * 写完同步 autoSize 档案 + 组内重新居中（高度变化不再产生「乱放」）。
   */
  async applyCardComment(file, nodeId, commentText) {
    // v0.16.4 修复 P1-3：内存优先读取 + 统一写回（防覆盖用户未落盘的拖动，Bug6 同款坑）
    const rd = await this._lmbReadCanvasData(file);
    if (!rd) return { ok: false, msg: "画布读取失败" };
    const data = rd.data;
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (!node) return { ok: false, msg: "找不到该卡片（可能已被删除）" };
    if (node.type !== "text") return { ok: false, msg: "只有文本卡片支持评论" };

    const cur = lmbSplitComment(node.text || "");
    node.text = lmbJoinComment(cur.body, commentText, { allowEmpty: false });

    const size = this.estimateSizeFor(node.text);
    node.width = Math.round(size.w);
    node.height = Math.round(size.h);
    if (Array.isArray(data.edges) && data.edges.length) {
      lmbRecenterNode(node, data.nodes || [], data.edges, this.autoEdges.get(file.path) || new Set());
    }
    let store = this.autoSize.get(file.path);
    if (!store) { store = new Map(); this.autoSize.set(file.path, store); }
    store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });

    await this._lmbWriteCanvasData(file, data, rd.memCanvas, rd.raw);
    this.persistAutoSizeSoon();
    return { ok: true, msg: "" };
  },

  /** 评论命令统一入口（mode = "edit" 弹窗编辑 / "remove" 移除） */
  async runCardCommentCommand(mode) {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    const pick = await this.pickCanvasNode(ctx);
    if (!pick || !pick.node) return;
    const cur = lmbSplitComment(pick.node.text || "");
    if (mode === "remove") {
      if (!cur.hasComment) { new Notice("该卡片还没有评论"); return; }
      const r = await this.applyCardComment(ctx.file, pick.node.id, "");
      new Notice(r.ok ? "已移除评论" : r.msg);
      return;
    }
    new LMBNoteModal(this.app, {
      title: cur.hasComment ? "编辑评论" : "添加评论",
      value: cur.comment,
      onSubmit: async (v) => {
        const r = await this.applyCardComment(ctx.file, pick.node.id, v);
        new Notice(r.ok ? (String(v).trim() ? "已保存评论" : "已移除评论") : r.msg);
      }
    }).open();
  },

  /**
   * v0.11.0：canvas 里点击「评论栏」直接弹编辑框（PDF Flow 式交互）。
   *   document 捕获层 click：callout[data-callout="lmb-comment"] 且在 canvas 内 →
   *   通过 canvas.nodes 的 contentEl 反查节点 id → 弹 LMBNoteModal。
   *   点折叠箭头（.callout-fold）不拦截 → 保留原生展开/折叠；md 阅读视图不拦截。
   */
  onCanvasCalloutClick(e) {
    try {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(".callout-fold")) return; // 折叠箭头 → 原生折叠/展开
      // v0.11.3：双重摘录卡的「视图切换按钮」——点击在 文字/图片 显示间切换。
      //   不拦截事件（不 preventDefault/stopPropagation），保留 canvas 原生的
      //   选中卡片等交互；切换纯靠 DOM class + CSS 显隐，不改卡片文本 → 宽度不变。
      const viewCallout = t.closest('.callout[data-callout="lmb-view"]');
      if (viewCallout) { this.toggleCardView(viewCallout); return; }
      const callout = t.closest('.callout[data-callout="lmb-comment"]');
      if (!callout) return;
      const leafEl = callout.closest(".workspace-leaf");
      const leaf = leafEl && this.app.workspace.getLeavesOfType("canvas").find((l) => l.containerEl === leafEl);
      if (!leaf || !leaf.view || !leaf.view.canvas) return; // 非 canvas（md 视图）→ 原生行为
      const canvas = leaf.view.canvas;
      const nodeMap = canvas.nodes || new Map();
      const entries = (typeof nodeMap.entries === "function") ? nodeMap.entries() : Object.entries(nodeMap);
      let nodeId = null;
      for (const [id, cnode] of entries) {
        const el = cnode && (cnode.contentEl || cnode.nodeEl);
        if (el && el.contains && el.contains(callout)) { nodeId = id; break; }
      }
      if (!nodeId) return; // 内部 API 失配 → 静默（可走侧栏按钮/命令）
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const file = leaf.view.file;
      this.editCommentForNode(file, nodeId).catch((err) => {
        console.warn("[lmb] comment click edit error:", err);
      });
    } catch (_) { /* noop：点击拦截绝不能抛错破坏 canvas */ }
  },

  /**
   * v0.16.0：视图切换的**核心实现** —— 只认渲染容器（host），**不依赖任何 callout 存在**。
   *
   * 为什么要拆出来：v0.11.3 ~ v0.15.0 的双重卡靠卡里那行 `> [!lmb-view]` callout 当「切换按钮」，
   *   toggleCardView(callout) 用 callout.closest() 反查 host 再切 class。v0.16.0 起新建的卡
   *   不再写这行（卡片精简 v2：用户要求卡内不放控件）→ 那条反查路径对**新卡**永远找不到 callout
   *   → 悬浮栏「视图」按钮会变成点了没反应的死按钮（v0.13.1 踩过同款坑）。
   *   所以把「切 class」这步抽成独立函数，悬浮栏直接把 host 传进来。
   *
   * @param {HTMLElement} host  canvas 的 .canvas-node-content / md 的 .markdown-rendered
   * @returns {boolean|null} 切换后的状态：true=图片视图 / false=文字视图；host 无效返回 null
   */
  toggleCardViewByHost(host) {
    try {
      if (!host || !host.classList) return null;
      const toImg = !host.classList.contains("lmb-view-img");
      host.classList.toggle("lmb-view-img", toImg);
      return toImg;
    } catch (_) { return null; }
  },

  /**
   * v0.11.3：切换双重摘录卡的显示视图（文字 ↔ 图片）。
   *   实现 = 给渲染容器（canvas 的 .canvas-node-content / md 的 .markdown-rendered）
   *   切换 lmb-view-img class，CSS 负责显隐（默认文字视图隐藏图片；图片视图隐藏引用块）。
   *   不改节点 markdown 文本 → fitNode hash 不变 → 卡片宽度（和高度）保持不变。
   *
   *   v0.16.0：切 class 的活委托给 toggleCardViewByHost。**本函数保留是为存量卡兼容** ——
   *   老版本建的双重卡 markdown 里仍然有 `> [!lmb-view]` 行，点它照样能切、标题文字也跟着变。
   *   新建的卡走 37-plugin-canvasbar.js 悬浮栏 → 直接调 toggleCardViewByHost。
   *
   *   已知边界：切换态存 DOM，不落盘 —— 重载/重渲染后回到默认文字视图。
   * @param {HTMLElement} callout  lmb-view callout 元素（仅存量卡才有）
   */
  toggleCardView(callout) {
    try {
      const host = callout.closest(".canvas-node-content")
        || callout.closest(".markdown-rendered")
        || callout.parentElement;
      const toImg = this.toggleCardViewByHost(host);
      if (toImg === null) return;
      // 按钮标题即时反馈（重渲染后会回到落盘的默认标题，无碍——显隐以 class 为准）
      const inner = callout.querySelector(".callout-title-inner");
      if (inner) {
        const next = toImg ? LMB_VIEW_TITLE_IMG : LMB_VIEW_TITLE_TEXT;
        if (typeof inner.setText === "function") inner.setText(next);
        else inner.textContent = next;
      }
    } catch (_) { /* noop：切换失败绝不能抛错破坏 canvas */ }
  },

  /** 按节点 id 直开评论编辑弹窗（点击评论栏的入口，无需选择器） */
  async editCommentForNode(file, nodeId) {
    if (!file) return;
    // v0.16.4 P1-3：弹窗初值也走内存优先（旧版读文件，刚拖动未落盘时可能显示旧值）
    const rd = await this._lmbReadCanvasData(file);
    if (!rd) return;
    const node = (rd.data.nodes || []).find((n) => n.id === nodeId);
    if (!node || node.type !== "text") { new Notice("找不到该卡片（可能已被删除）"); return; }
    const cur = lmbSplitComment(node.text || "");
    new LMBNoteModal(this.app, {
      title: cur.hasComment ? "编辑评论" : "添加评论",
      value: cur.comment,
      onSubmit: async (v) => {
        const r = await this.applyCardComment(file, nodeId, v);
        new Notice(r.ok ? (String(v).trim() ? "已保存评论" : "已移除评论") : r.msg);
      }
    }).open();
  },

  /** 拿到当前 canvas 上下文 { file, leaf }；当前活动视图不是 canvas 则返回 null */
  activeCanvasContext() {
    // v0.16.4 修复 P2-5：不再静默回退到「任意一个打开的 canvas leaf」——
    //   旧行为会让用户在 md/PDF 视图触发命令时，操作悄悄落到某个后台画布上。
    //   现在只认当前活动 leaf 是 canvas，否则返回 null（调用方各自提示/灰显）。
    try {
      // v0.16.5 修复 R6：activeLeaf 是 deprecated API，一旦被移除，所有 canvas 命令
      //   会全部失效。加 getMostRecentLeaf() 兜底（返回最近使用过的 leaf；用户不在
      //   canvas 视图时它同样不是 canvas → 与严格判定的语义一致）。
      let leaf = null;
      try { leaf = this.app.workspace.activeLeaf || null; } catch (_) { leaf = null; }
      if (!leaf) {
        try {
          leaf = typeof this.app.workspace.getMostRecentLeaf === "function"
            ? this.app.workspace.getMostRecentLeaf() : null;
        } catch (_) { leaf = null; }
      }
      if (!leaf || !leaf.view) return null;
      let vt = null;
      try { vt = typeof leaf.view.getViewType === "function" ? leaf.view.getViewType() : null; } catch (_) { vt = null; }
      if (vt !== "canvas") return null;
      const f = leaf.view.file;
      if (!f || f.extension !== "canvas") return null;
      return { file: f, leaf };
    } catch (_) { return null; }
  },

  /**
   * 取目标卡片节点：
   *   ① canvas 内部 API getSelection()（便捷；非官方但社区通用，失败静默）
   *   ② 退回模糊搜索列出画布里的文本卡片让用户挑（纯公开 API，永远可用）
   */
  pickCanvasNode(ctx) {
    try {
      const canvas = ctx.leaf.view.canvas;
      const sel = canvas && typeof canvas.getSelection === "function" ? canvas.getSelection() : null;
      const arr = sel ? Array.from(sel) : [];
      const node = arr.find((n) => n && typeof n.text === "string");
      if (node) return Promise.resolve({ node, via: "selection" });
    } catch (_) { /* 内部 API 不可用 → 走 ② */ }

    return new Promise((resolve) => {
      this.app.vault.adapter.read(ctx.file.path).then((raw) => {
        let data = null;
        try { data = JSON.parse(raw); } catch (_) { /* noop */ }
        const nodes = (data && data.nodes) || [];
        const items = nodes.filter((n) => n.type === "text" && n.text).map((n) => {
          const first = String(n.text).split("\n").find((l) => l.trim()) || "(空卡片)";
          const has = lmbSplitNote(n.text, this.settings.noteCalloutType || "ppd-note").hasNote;
          return { id: n.id, label: (has ? "📝 " : "") + first.slice(0, 60), node: n };
        });
        if (!items.length) { new Notice("这个画布里没有文本卡片"); resolve(null); return; }
        new LMBNodeSuggester(this.app, items,
          (it) => resolve({ node: it.node, via: "picker" }),
          () => resolve(null)).open();
      }).catch(() => resolve(null));
    });
  },

  /**
   * 把补充描述写进指定节点。noteText 为空串 = 移除补充描述。
   *   opts.fold 为 boolean 时显式设置折叠态；为 null/undefined 时沿用当前折叠态。
   *   写完同步 autoSize 档案（hash + 尺寸），防止后续 sync 把卡片尺寸回退。
   */
  async applyCardNote(file, nodeId, noteText, opts) {
    const o = opts || {};
    // v0.16.4 修复 P1-3：内存优先读取 + 统一写回（同 applyCardComment）
    const rd = await this._lmbReadCanvasData(file);
    if (!rd) return { ok: false, msg: "画布读取失败" };
    const data = rd.data;
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (!node) return { ok: false, msg: "找不到该卡片（可能已被删除）" };
    if (node.type !== "text") return { ok: false, msg: "只有文本卡片支持补充描述" };

    // v0.16.6 P1-4：只认插件自有的 note 类型（用户自有 callout 不再被改写覆盖）
    const cur = lmbSplitNote(node.text || "", this.settings.noteCalloutType || "ppd-note");
    // 折叠态优先级：显式传入 > 沿用原有 > 新建时用设置里的默认值
    const fold = (typeof o.fold === "boolean")
      ? o.fold
      : (cur.hasNote ? cur.fold : !!this.settings.noteFoldByDefault);
    node.text = lmbJoinNote(cur.body, noteText, {
      type: this.settings.noteCalloutType || "ppd-note",
      title: this.settings.noteTitle || "补充描述",
      fold,
      tail: cur.tail // v0.11.0：评论块原样接回，编辑描述不再弄丢评论
    });

    // 补充描述会改变卡片高度 → 重算并同步档案
    const size = this.estimateSizeFor(node.text);
    node.width = Math.round(size.w);
    node.height = Math.round(size.h);
    // v0.11.0：高度变了 → 组内重新居中（中心保持在父卡横/纵轴上）
    if (Array.isArray(data.edges) && data.edges.length) {
      lmbRecenterNode(node, data.nodes || [], data.edges, this.autoEdges.get(file.path) || new Set());
    }
    let store = this.autoSize.get(file.path);
    if (!store) { store = new Map(); this.autoSize.set(file.path, store); }
    store.set(node.id, { hash: this.simpleHash(node.text), w: node.width, h: node.height });

    await this._lmbWriteCanvasData(file, data, rd.memCanvas, rd.raw);
    this.persistAutoSizeSoon();
    return { ok: true, msg: "" };
  },

  /** 三条命令的统一入口：edit（弹窗编辑）/ remove（清空）/ fold（切换折叠） */
  async runCardNoteCommand(mode) {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    const pick = await this.pickCanvasNode(ctx);
    if (!pick || !pick.node) return;
    const cur = lmbSplitNote(pick.node.text || "", this.settings.noteCalloutType || "ppd-note");

    if (mode === "fold") {
      if (!cur.hasNote) { new Notice("该卡片还没有补充描述"); return; }
      const r = await this.applyCardNote(ctx.file, pick.node.id, cur.note, { fold: !cur.fold });
      new Notice(r.ok ? (cur.fold ? "已展开补充描述" : "已折叠补充描述") : r.msg);
      return;
    }
    if (mode === "remove") {
      if (!cur.hasNote) { new Notice("该卡片本来就没有补充描述"); return; }
      const r = await this.applyCardNote(ctx.file, pick.node.id, "");
      new Notice(r.ok ? "已移除补充描述" : r.msg);
      return;
    }
    // edit
    new LMBNoteModal(this.app, {
      title: cur.hasNote ? "编辑补充描述" : "添加补充描述",
      value: cur.note,
      onSubmit: async (v) => {
        const r = await this.applyCardNote(ctx.file, pick.node.id, v);
        new Notice(r.ok ? (String(v).trim() ? "已保存补充描述" : "已移除补充描述") : r.msg);
      }
    }).open();
  },

});
