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
    const raw = await this.app.vault.adapter.read(ctx.file.path);
    let data;
    try { data = JSON.parse(raw); } catch (_) { new Notice("画布解析失败"); return; }
    const nodes = data.nodes || [];
    const fold = !!this.settings.noteFoldByDefault;   // 跟随设置（默认 false = 展开，一眼能看见）
    let n = 0;
    for (const node of nodes) {
      if (node.type !== "text" || !node.text) continue;
      if (!EX_ID_RE.test(node.text)) continue;             // 只处理摘录卡
      if (lmbSplitNote(node.text).hasNote) continue;       // 已有描述 → 跳过，不覆盖
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
    const indent = /\n\t"/.test(raw) ? "\t" : "  ";
    this.selfWritten.set(ctx.file.path, true);
    await this.app.vault.adapter.write(ctx.file.path, JSON.stringify(data, null, indent));
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
    const raw = await this.app.vault.adapter.read(ctx.file.path);
    let data;
    try { data = JSON.parse(raw); } catch (_) { new Notice("画布解析失败"); return; }
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
    const indent = /\n\t"/.test(raw) ? "\t" : "  ";
    this.selfWritten.set(ctx.file.path, true);
    await this.app.vault.adapter.write(ctx.file.path, JSON.stringify(data, null, indent));
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
    const raw = await this.app.vault.adapter.read(file.path);
    let data;
    try { data = JSON.parse(raw); } catch (_) { return { ok: false, msg: "画布解析失败" }; }
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

    const indent = /\n\t"/.test(raw) ? "\t" : "  ";
    this.selfWritten.set(file.path, true);
    await this.app.vault.adapter.write(file.path, JSON.stringify(data, null, indent));
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

  /** 按节点 id 直开评论编辑弹窗（点击评论栏的入口，无需选择器） */
  async editCommentForNode(file, nodeId) {
    if (!file) return;
    const raw = await this.app.vault.adapter.read(file.path);
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    const node = (data.nodes || []).find((n) => n.id === nodeId);
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

  /** 拿到当前 canvas 上下文 { file, leaf }；不在 canvas 里则返回 null */
  activeCanvasContext() {
    const leaves = this.app.workspace.getLeavesOfType("canvas") || [];
    if (!leaves.length) return null;
    let leaf = null;
    try { leaf = this.app.workspace.activeLeaf; } catch (_) { leaf = null; }
    const isCanvas = (l) => l && l.view && (!l.view.getViewType || l.view.getViewType() === "canvas");
    if (!isCanvas(leaf)) leaf = leaves.find(isCanvas) || leaves[0];
    const f = leaf && leaf.view && leaf.view.file;
    if (!f || f.extension !== "canvas") return null;
    return { file: f, leaf };
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
          const has = lmbSplitNote(n.text).hasNote;
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
    const raw = await this.app.vault.adapter.read(file.path);
    let data;
    try { data = JSON.parse(raw); } catch (_) { return { ok: false, msg: "画布解析失败" }; }
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (!node) return { ok: false, msg: "找不到该卡片（可能已被删除）" };
    if (node.type !== "text") return { ok: false, msg: "只有文本卡片支持补充描述" };

    const cur = lmbSplitNote(node.text || "");
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

    const indent = /\n\t"/.test(raw) ? "\t" : "  ";
    this.selfWritten.set(file.path, true);
    await this.app.vault.adapter.write(file.path, JSON.stringify(data, null, indent));
    this.persistAutoSizeSoon();
    return { ok: true, msg: "" };
  },

  /** 三条命令的统一入口：edit（弹窗编辑）/ remove（清空）/ fold（切换折叠） */
  async runCardNoteCommand(mode) {
    const ctx = this.activeCanvasContext();
    if (!ctx) { new Notice("请先在 canvas 里操作（当前不在画布视图）"); return; }
    const pick = await this.pickCanvasNode(ctx);
    if (!pick || !pick.node) return;
    const cur = lmbSplitNote(pick.node.text || "");

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
