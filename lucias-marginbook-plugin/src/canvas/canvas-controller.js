/* 32-plugin-canvas —— 画布处理/尺寸自适应/自愈（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

  scheduleCanvasSync(file) {
    const old = this.syncTimers.get(file.path);
    if (old) clearTimeout(old);
    // v0.4.5：防抖 800→250ms；v0.7.1：再→400ms 减少拖拽期 processCanvas 频率。
    // 拖拽时 Obsidian canvas 连续触发 modify，debounce 不断重置；400ms 让本插件不再打断拖拽手感。
    this.syncTimers.set(file.path, setTimeout(() => {
      this.syncTimers.delete(file.path);
      this.processCanvas(file).catch((err) => console.error("[lmb] canvas process failed:", err));
    }, 400));
  },

  /**
   * v0.16.1：拿目标画布的**内存最新数据**（canvas.getData()）。
   *   Bug6 的根因与修法说明见 processCanvas 顶部注释。找不到打开着的这个画布 → null
   *   （后台文件 / 未打开），调用方回退读文件。
   */
  _lmbMemCanvasData(cf) {
    try {
      const leaves = this.app.workspace.getLeavesOfType("canvas") || [];
      const leaf = leaves.find((l) => l && l.view && l.view.file && l.view.file.path === cf.path);
      if (!leaf) return null;
      const canvas = leaf.view.canvas;
      if (!canvas || typeof canvas.getData !== "function") return null;
      const data = canvas.getData();
      if (!data || !Array.isArray(data.nodes)) return null;
      /* v0.16.6 P0-1：nodes 为空 + 档案非空 = 画布正在加载（onOpenFile → setData 之间）
       *   的瞬时脏数据。旧版照常返回 → _lmbUpdateNodeMeta 的 alive 集合为空 →
       *   档案里**全部**条目被判成「已删除」→ 开启级联清理时该画布的 webp 被全删、
       *   摘录 md 的条目被整片删除（不可逆）。
       *   宁可这一次不处理（返回 null → 走文件读取 / 直接跳过），也绝不误删。 */
      if (data.nodes.length === 0) {
        const meta = this.nodeMeta && this.nodeMeta.get(cf.path);
        if (meta && meta.size > 0) return null;
      }
      return { canvas, data };
    } catch (_) { return null; }
  },

  /**
   * v0.16.1：processCanvas 的统一写回 —— **setData + requestSave + 同一份数据写盘**。
   *   关键纪律：写盘用的 data 必须就是刚 setData 的那份内存数据。
   *   旧版「改完再 adapter.write(改过的 data)」看似等价，但如果 data 的来源是**文件**
   *   （而不是内存），写盘等于把「文件里的陈旧位置」钉回去 —— 用户刚拖未落盘的移动丢失，
   *   表现为卡片弹回原位 / 在几个位置间瞬移（Bug6）。
   *   内存优先写（setData 毫秒级刷新渲染 + requestSave 让 Obsidian 自己落盘），
   *   文件写是同一份数据的持久化，不是「再改一次」。
   * @returns {boolean} 是否写盘成功
   */
  async _lmbWriteCanvasData(cf, data, memCanvas, rawForIndent) {
    let indent = "  ";
    try { indent = /\n\t"/.test(rawForIndent || "") ? "\t" : "  "; } catch (_) {}
    if (memCanvas && typeof memCanvas.setData === "function"
        && typeof memCanvas.requestSave === "function") {
      try {
        // 活动画布只保留一个写入者，避免 requestSave 与 adapter.write 竞态重载旧坐标。
        this.selfWritten.set(cf.path, Date.now());
        memCanvas.setData(data);
        memCanvas.requestSave();
        return true;
      } catch (_) {
        this.selfWritten.delete(cf.path);
        // 内部 API 失败时才回退文件写。
      }
    }
    this.selfWritten.set(cf.path, Date.now()); // v0.16.4 P2-4：存时间戳（过期不吞真实 modify）
    try {
      await this.app.vault.adapter.write(cf.path, JSON.stringify(data, null, indent));
      return true;
    } catch (err) {
      this.selfWritten.delete(cf.path);
      console.error("[lmb] canvas write failed:", err);
      return false;
    }
  },

  /**
   * v0.16.4（修复 P1-3）：评论/补充描述/批量挂框等单卡编辑链路的统一读取入口。
   *   与 processCanvas 同纪律：画布正打开 → 用 getData() 的内存数据（含未落盘改动）；
   *   拿不到 → 回退读文件。raw 一并返回（供 _lmbWriteCanvasData 探测缩进）。
   * @returns {{data:object, memCanvas:object|null, raw:string|null}|null}
   */
  async _lmbReadCanvasData(cf) {
    let raw = null;
    try { raw = await this.app.vault.adapter.read(cf.path); } catch (_) { raw = null; }
    const mem = this._lmbMemCanvasData(cf);
    if (mem) return { data: mem.data, memCanvas: mem.canvas, raw };
    if (!raw) return null;
    try { return { data: JSON.parse(raw), memCanvas: null, raw }; } catch (_) { return null; }
  },

  async processCanvas(cf) {
    // v0.16.1【Bug6 根因修复】：数据源从「文件」改为「canvas 内存」优先。
    //   旧版第 17 行 vault.read(cf) 读到的是**磁盘内容**：用户刚拖动 / 删除卡片后
    //   Obsidian 未必已落盘（modify 防抖 400ms + Obsidian 自身落盘时机不定），此时
    //   本函数若做了任何改动（fit 高度 / 自动挂框 / 自动父子）并写回，等于把**拖动前
    //   的旧位置**钉回文件 → Obsidian 重载画布 → 卡片弹回原位 / 在几个位置间瞬移。
    //   这与 v0.14.9 修 lmbFitNodeById 的是同一个坑 —— 那条链路修了，本函数漏了。
    //   修法：_lmbMemCanvasData(cf) 能拿到（画布正打开）就用 getData() 的内存数据
    //   （必然含用户未落盘的改动）；拿不到才回退读文件。raw 仍要读一次 —— 只为探测
    //   缩进风格（写入格式与用户文件保持一致），内容本身以内存为准。
    let raw = null;
    try { raw = await this.app.vault.read(cf); } catch (_) { raw = null; }
    let data = null;
    let memCanvas = null;
    const mem = this._lmbMemCanvasData(cf);
    if (mem) { data = mem.data; memCanvas = mem.canvas; }
    if (!data) {
      if (!raw) return;
      try { data = JSON.parse(raw); } catch (_) { return; }
    }
    const nodes = data.nodes || [];

    let changed = false;
    let store = this.autoSize.get(cf.path);
    if (!store) { store = new Map(); this.autoSize.set(cf.path, store); }

    /* v0.8.2：新出现的摘录卡自动挂一个「空的补充描述框」。
     *   放在 fitNode 之前，这样尺寸估算会基于「已加框」的文本一次算准，不用二次修正。
     *   判定「新出现」= canvasPositions 档案里没有这个节点 id（插件见过的卡一律不动，
     *   避免把存量卡批量改造）。已有描述的卡也跳过。设置项 noteAutoBoxOnNew 可关。
     *   注意：插件首次扫描某画布时 lastPos 为空 → 所有卡都算「新」→ 会给存量卡也加框，
     *   这是有意为之（用户要的就是「能看到框」）；不想要就在设置里关掉自动。 */
    const attachNote = this.settings.noteAutoBoxOnNew !== false;
    // v0.16.0：默认 false（卡片精简 v2 —— 卡内不再自动出现「💬 添加评论」栏）。
    //   评论能力本身保留，入口 = 悬浮栏「评论」按钮 / 命令面板 / ribbon；存量卡与已写评论不受影响。
    //   用户在设置里手动开回 true 时行为与旧版完全一致。
    const attachComment = this.settings.commentAutoBoxOnNew === true; // v0.11.0：评论栏
    if (attachNote || attachComment) {
      const lastPos0 = this.canvasPositions.get(cf.path) || new Map();
      const fold0 = !!this.settings.noteFoldByDefault;
      for (const node of nodes) {
        if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
        if (lastPos0.has(node.id)) continue;              // 见过的卡 → 不动
        let touched = false;
        // v0.16.6：note 类型白名单随设置走（旧版任意 callout 都会被当成补充描述）
        const noteTypes0 = this.settings.noteCalloutType || "ppd-note";
        if (attachNote && !lmbSplitNote(node.text, noteTypes0).hasNote) {   // 已有描述 → 不动
          node.text = lmbJoinNote(node.text, "", {
            type: this.settings.noteCalloutType || "ppd-note",
            title: this.settings.noteTitle || "补充描述",
            fold: fold0,
            allowEmpty: true
          });
          touched = true;
          console.log("[lmb] 新摘录卡自动挂补充描述框:", node.id.slice(0, 8));
        }
        // v0.11.0：新摘录卡自动挂「评论栏」（PDF Flow 式底栏按钮，点它直接弹编辑框）
        if (attachComment && !lmbSplitComment(node.text).hasComment) {
          node.text = lmbJoinComment(node.text, "", { allowEmpty: true });
          touched = true;
          console.log("[lmb] 新摘录卡自动挂评论栏:", node.id.slice(0, 8));
        }
        if (touched) changed = true;
      }
    }

    if (!Array.isArray(data.edges)) data.edges = []; // v0.11.0：fit 重居中要用，提前归一
    const fittedNodes = [];
    for (const node of nodes) {
      if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
      const fitted = this.fitNode(node, store);
      if (fitted) {
        node.width = Math.round(fitted.w);
        node.height = Math.round(fitted.h);
        fittedNodes.push(node);
        changed = true;
        console.log("[lmb] node resized:", node.id, node.width + "x" + node.height);
      }
    }
    // v0.11.0 R1「乱放」根因修复：fitNode 在排布之后把卡撑大 → 高度变了 y 不变 →
    //   中心偏出父卡横/纵轴。尺寸修正过的卡按自动父边做组内重新居中。
    if (fittedNodes.length && data.edges.length) {
      const sidecarFit = this.autoEdges.get(cf.path) || new Set();
      let recentered = 0;
      for (const node of fittedNodes) {
        if (lmbRecenterNode(node, nodes, data.edges, sidecarFit)) recentered++;
      }
      if (recentered) {
        changed = true;
        console.log("[lmb] 尺寸修正后组内重新居中:", recentered, "卡");
      }
    }
    if (changed) {
      // v0.16.1：统一写回（setData + requestSave + 同一份内存数据写盘，防覆盖用户拖动）
      await this._lmbWriteCanvasData(cf, data, memCanvas, raw);
    }

    /* ---- v0.7.0：通用自动父子 + 组居中（任意画布卡片，拖动即生效） ----
     * 触发：任意文本/图片卡（不再限 ^ex）位置变更（movedOrNew，含新卡），与其余卡重叠即建父→子连线 + 组居中排布。
     * 判定：lmbPickDropParent 多信号（落点角/中心/相交 ≥ 较小卡 20%）。
     * v0.7.1：① 边去重 by (parent,child) 对，防止瞬时重复连线；② 自动建的边用 sidecar 跟踪，
     *         端点不再重叠即清理（用户手动连线不会被破坏：不在 sidecar 里）。 */
    if (!Array.isArray(data.edges)) data.edges = [];
    if (!this.canvasPositions) this.canvasPositions = new Map();
    if (!this.autoEdges) this.autoEdges = new Map();

    // v0.7.1：边去重 —— 同一 (parent, child) 对仅保留第一条，避免「同一对父子多根线」
    {
      const seenPair = new Set();
      const before = data.edges.length;
      data.edges = data.edges.filter((ed) => {
        if (!ed.fromNode || !ed.toNode || ed.fromNode === ed.toNode) return false;
        const k = ed.fromNode < ed.toNode ? ed.fromNode + "|" + ed.toNode : ed.toNode + "|" + ed.fromNode;
        if (seenPair.has(k)) return false;
        seenPair.add(k); return true;
      });
      if (data.edges.length !== before) console.log("[lmb] 边去重：移除", before - data.edges.length, "条重复边");
    }

    /* v0.7.3：清理端点已被删除的自动边（这是唯一安全的清理条件）。
     *   ⚠️ 历史教训（v0.7.1 回归，用户报「连线自动消失」）：
     *   这里【绝不能】按「端点是否还重叠」来清理 —— lmbLayoutGroup 排布的目的恰恰是
     *   让子卡不再遮挡父卡，所以正常排布后父子必然不重叠。按重叠清理 = 把刚建的边自己删掉。
     *   时序：①拖 B 压 A → 建边 A→B → 排布把 B 挪到 A 右侧 gap=30（不再重叠）→ 写盘
     *        ②下一次 sync → 清理看到重叠率 0 → 删边 → 线消失。
     *   孤儿边（瞬时拖动压到别的卡）改由「换父时移除旧的自动父边」处理，见下方 movedOrNew 循环。 */
    {
      const sidecar = this.autoEdges.get(cf.path) || new Set();
      const byId = new Map(nodes.map((n) => [n.id, n]));
      let removed = 0;
      const survivingAuto = new Set();
      data.edges = data.edges.filter((ed) => {
        if (!sidecar.has(ed.id)) return true; // 手动边不动
        if (!lmbAutoEdgeAlive(ed, byId)) { removed++; return false; } // 仅端点被删才移除
        survivingAuto.add(ed.id);
        return true;
      });
      this.autoEdges.set(cf.path, survivingAuto);
      if (removed) {
        changed = true;
        console.log("[lmb] 自动边清理：移除", removed, "条端点已删除的孤儿边");
      }
    }

    const lastPos = this.canvasPositions.get(cf.path) || new Map();
    const currentPos = new Map();
    const movedOrNew = [];
    // v0.11.1：拆分「尺寸变化」与「位置变化」——fitNode 撑大是尺寸变化（位置没动），
    //   由 lmbRecenterNode 在前面已居中过；这里若再走 lmbPlanAutoLink 会因
    //   lmbSideOf CURRENT（中心偏移）算出相反侧 → 触发 lmbApplyReside 把侧翻转
    //   （用户截图的"下变右"bug 根因）。sizeOnly 让 lmbPlanAutoLink 走 recenter op
    //   保留原侧。user-truly-moved 的 nn 则 sizeOnly=false，照常 detect。
    const sizeOnlyIds = new Set();
    for (const n of nodes) {
      if (n.type === "group") continue;
      const cur = { x: n.x, y: n.y, width: n.width || 0, height: n.height || 0 };
      currentPos.set(n.id, cur);
      const prev = lastPos.get(n.id);
      if (!prev) {
        movedOrNew.push(n);
      } else if (prev.x !== cur.x || prev.y !== cur.y) {
        movedOrNew.push(n);
      } else if (prev.width !== cur.width || prev.height !== cur.height) {
        // 仅尺寸变化——lmbRecenterNode 已经基于原 side 居中过，跳过本循环（防侧翻）
        sizeOnlyIds.add(n.id);
      }
    }
    // 当前画布已经成功解析，可安全清除已不存在节点的尺寸缓存。
    const aliveNodeIds = new Set(nodes.filter((n) => n && n.id).map((n) => n.id));
    for (const id of Array.from(store.keys())) if (!aliveNodeIds.has(id)) store.delete(id);
    this.canvasPositions.set(cf.path, currentPos);
    this.persistAutoSizeSoon(); // 落盘档案（canvasPositions + autoEdges + autoSize 共用防抖）

    // ---- v0.15.0：删除级联（实时检测）----
    //   canvasPositions 只存位置，不存 text；而节点一旦删除，data.nodes 里就没了，
    //   拿不到 text 就无法知道它引用了哪个附件/哪条摘录。所以另存一份**轻量元数据**
    //   （只存附件名 + exId，不存全文，避免内存膨胀），删除时靠它定位清理目标。
    const gone = this._lmbUpdateNodeMeta(cf, nodes);   // 顺带返回本次消失的节点
    if (gone.length && this.settings && this.settings.autoCleanOnDelete === true) {
      // 不 await：清理是异步的，不能拖慢 processCanvas 主流程
      this._lmbCleanupDeletedNodes(cf, gone).catch((err) => {
        console.warn("[lmb] cascade cleanup failed:", err);
      });
    }

    if (movedOrNew.length) {
      // hoisted：所有迭代共用同一个 sidecar 引用，统一在末尾持久化
      const sidecar2 = this.autoEdges.get(cf.path) || new Set();
      for (const nn of movedOrNew) {
        // v0.11.1：新卡（drop 下的 ^ex 卡）走 instantAttach 设了位置，
        //   再被 fitNode 撑大——x/y 与 instantAttach 之后一致但 size 已变。
        //   用 sizeOnly 标记，让 lmbPlanAutoLink 保留原侧不翻转。
        // 真正的 user drag（canvas 内移动）会有 lastPos 与当前 x/y 不同，sizeOnly=false 照常 detect。
        const prevForNew = sizeOnlyIds.has(nn.id);
        // 新卡（不在 sizeOnlyIds）lastPos 里没记录：它的「位置变化」是 instantAttach 写入的，
        //   后续 fitNode 改尺寸由 lmbRecenterNode 处理，不属于 user-truly-moved。
        //   标记为 sizeOnly 让 lmbPlanAutoLink 走 recenter 而不是 reside。
        const isNewCard = !lastPos.has(nn.id);
        const sizeOnly = prevForNew || isNewCard;
        const others = nodes.filter((n) => n.id !== nn.id && n.type !== "group");
        const hit = lmbPickDropParent(nn, others);
        if (!hit) continue;
        const parent = hit.node;
        if (parent.id === nn.id) continue;

        /* v0.11.0 首连锁定 + 改挂侧（取代 v0.7.3 换父）：
         *   每张卡只自动建一条连线——已有自动父边且父不是本次压中的卡 → skip，
         *   不再自动换父（想换父请手动删线重拖）；压中已连线的卡 → reside 改挂侧；
         *   手动边不参与锁定。副作用：旧版「排布紧密顺带碰到别的卡就换父」的误触发
         *   也被一并消除（这正是锁定规则的收益）。 */
        const plan = lmbPlanAutoLink(nn, parent, data.edges, sidecar2, { sizeOnly });
        if (plan.op === "skip") continue;
        if (plan.op === "recenter") {
          // v0.11.1：尺寸变化触发的 recenter——只整组重排，不动 edge side。
          // ⚠️ 必须从 kidsBySide 过滤掉 nn 自身（lmbGroupBySide 通过 edge 找子卡，会把 nn 也算进来），
          //   否则 group = [nn, nn] → lmbLayoutGroup 当成两卡分组排布，x 算错。
          const kidsBySideRecenter = lmbGroupBySide(parent, nodes, data.edges);
          const groupRecenter = [...(kidsBySideRecenter.get(plan.side) || []).filter((k) => k.id !== nn.id), nn];
          lmbLayoutGroup(parent, groupRecenter, plan.side, 30);
          // 顺便把 instantAttach 漏登记的边补进 sidecar（一次性兜底）
          if (!sidecar2.has(plan.edge.id)) sidecar2.add(plan.edge.id);
          changed = true;
          console.log("[lmb] 自动父子（尺寸变化 + recenter v0.11.1）:", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
            "(保留" + plan.side + ")" + (isNewCard ? " [新卡 fitNode]" : ""));
          continue;
        }
        if (plan.op === "reside") {
          const r = lmbApplyReside(parent, nn, plan, nodes, data.edges);
          // 顺便把 instantAttach 漏登记的边补进 sidecar
          if (!sidecar2.has(plan.edge.id)) sidecar2.add(plan.edge.id);
          changed = true;
          console.log("[lmb] 自动父子（改挂侧）:", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
            "(" + plan.oldSide + "→" + r.side + ", 相交" + Math.round(hit.ratio * 100) + "%)");
          continue;
        }

        // 取父卡现有子卡按侧分组；把新卡 nn 加进同侧组，整组贴边对齐+组居中排布（v0.9.3 不再拉伸尺寸）
        // v0.11.1 防御：lmbGroupBySide 会通过任何 edge 把 nn 算进来（理论上 create 路径不会，
        //   但若 instantAttach 已建边 + 文件层兜底未删干净，这里会重复。仍然 filter 一遍）
        const kidsBySide = lmbGroupBySide(parent, nodes, data.edges);
        const group = [...(kidsBySide.get(plan.side) || []).filter((k) => k.id !== nn.id), nn];
        lmbLayoutGroup(parent, group, plan.side, 30);
        const ends = lmbSideEnds(plan.side);
        const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        data.edges.push({
          id: eid, fromNode: parent.id, toNode: nn.id,
          fromSide: ends.fromSide, toSide: ends.toSide
        });
        // 标记为自动边（用于后续清理）
        sidecar2.add(eid);
        changed = true;
        console.log("[lmb] 自动父子（首连锁定 v0.11.0）:", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
          "(" + ends.fromSide + "→" + ends.toSide + ", 相交" + Math.round(hit.ratio * 100) + "%, 组" + group.length + ")");
      }

      if (changed) {
        // 持续持久化 sidecar 的兜底补登条目（含本次循环内所有 recenter/reside 补的）
        this.autoEdges.set(cf.path, sidecar2);
        // v0.16.1：统一写回（与上方 fit 写入同一条纪律 —— 以内存数据为准，防瞬移）
        await this._lmbWriteCanvasData(cf, data, memCanvas, raw);
      }
    }

    const byPdf = new Map();
    const seenIds = new Set(); // 补丁 A：卡片级去重——同一 ^ex id 只保留 canvas 顺序中的第一个节点
    for (const node of nodes) {
      if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
      const pm = node.text.match(/\[\[([^\]#|]+\.pdf)/i);
      if (!pm) continue;
      const pdfPath = pm[1].trim();
      const id = node.text.match(EX_ID_RE)[0].slice(1);
      if (seenIds.has(id)) {
        // 同一选区重复拖拽产生的内容寻址重复卡：md 只收一条，canvas 原卡保留不动
        console.log("[lmb] canvas 卡按 id 去重:", id, "（重复卡片，仅保留首个）");
        continue;
      }
      seenIds.add(id);
      // v0.8.0：除非设置里明确要同步，否则补充描述不进摘录文档（保持摘录文档是「原文」的镜像）
      // v0.16.6 P1-4：传 note 类型白名单 —— 旧版会把用户自有的 [!warning]/[!quote] 整段删掉
      const srcText = this.settings.noteIntoSync
        ? node.text
        : lmbStripNote(node.text, this.settings.noteCalloutType || "ppd-note");
      const body = srcText
        .split("\n")
        .filter((l) => !/^\s*\^ex-[0-9a-z]{4,8}\s*$/.test(l))
        // v0.11.3：lmb-view 是卡片上的视图切换按钮（UI 开关），不属于摘录内容，剥掉
        .filter((l) => !LMB_VIEW_CALLOUT_RE.test(l))
        .join("\n")
        .trim();
      // 补丁 A（P1-3）：回跳链接页码 #page=12 → entry.page；提取失败为 null（归入「未定位」）
      // 仅匹配 ASCII 数字，对中文文件名 / 中文摘录文本无副作用
      const pgm = node.text.match(/#page=(\d+)/);
      const page = pgm ? parseInt(pgm[1], 10) : null;
      if (!byPdf.has(pdfPath)) byPdf.set(pdfPath, []);
      byPdf.get(pdfPath).push({ id, body, page });
    }

    // v0.4.0：canvas 连线 → 摘录层级（child ^ex id -> parent ^ex id）。
    // 手动在 canvas 上连的两张 ^ex 卡同样生效；父是普通文本卡/图片卡则不进 md 层级。
    const exNodes = nodes.filter((n) => n.type === "text" && n.text && EX_ID_RE.test(n.text));
    const exIdByNodeId = new Map();
    for (const n of exNodes) exIdByNodeId.set(n.id, n.text.match(EX_ID_RE)[0].slice(1));
    const parentOf = new Map();
    for (const e of (data.edges || [])) {
      const p = exIdByNodeId.get(e.fromNode), c = exIdByNodeId.get(e.toNode);
      if (p && c && p !== c && !parentOf.has(c)) parentOf.set(c, p);
    }

    for (const [pdfPath, entries] of byPdf) {
      try {
        await this.writeExcerptMd(cf, pdfPath, entries, parentOf);
      } catch (err) {
        // 单个 PDF 的摘录文档写入失败不阻断其它 PDF 的同步
        console.error("[lmb] excerpt sync failed for", pdfPath, err);
      }
    }

    // v0.13.4：节点刚挂载时 canvas DOM 未填充，fitNode 走估算（可能偏大）；
    //   延迟 250ms 再 actual 重测一次（详见 _scheduleActualFitRetry）—— 用户反馈
    //   "直接摘录的卡片高度还是太高"，根因是 processCanvas 跑时新节点 nodeEl 还没
    //   填充（canvas reactive 异步渲染），fitNode 走估算 + 写文件，导致估算值被永久化。
    // 只有 DOM 未就绪、曾走估算路径的卡才需要延迟重测。普通移动/手动拉伸不触发全卡扫描。
    if (Array.from(store.values()).some((v) => v && v.pendingActual)) {
      this._scheduleActualFitRetry(cf);
    }
  },

  /**
   * v0.13.4：节点刚挂载时 canvas DOM 未填充，fitNode 走估算（可能偏大），
   *   延迟一次 actual 测量重试，等渲染完成用 DOM 真值修正高度。
   *   setTimeout 250ms：Obsidian canvas reactive 渲染通常在状态变更后 100-200ms 内完成。
   *   每文件独立 timer（防抖），processCanvas 可能连续跑（比如 drop flush + 后续 modify）。
   */
  _scheduleActualFitRetry(cf) {
    try {
      const k = cf.path;
      if (!this._fitRetry) this._fitRetry = {};
      const prev = this._fitRetry[k];
      if (prev && prev.timer) clearTimeout(prev.timer);
      this._fitRetry[k] = { timer: setTimeout(() => {
        try { delete this._fitRetry[k]; } catch (_) {}
        this._actualFitRetryForFile(cf).catch(() => {});
      }, 250) };
    } catch (_) {}
  },

  /**
   * v0.13.4：actual 测量重试 + 写回 canvas json。
   *   为什么不复用 processCanvas：那个流程还要做自动连线/组居中/摘录同步，
   *   这里只要"按 DOM 真值重 fit"，多跑一遍主流程代价大且可能引入 side 翻转。
   */
  async _actualFitRetryForFile(cf) {
    try {
      // v0.16.5 R8：插件已卸载 → 退出（本函数的图片等待重试链没有保留 setTimeout
      //   句柄，无法从 onunload 直接取消，只能靠入口标记兜底）
      if (this._unloaded) return;
      const leaves = this.app.workspace.getLeavesOfType("canvas") || [];
      const leaf = leaves.find((l) => l && l.view && l.view.file && l.view.file.path === cf.path);
      if (!leaf) return;
      const canvas = leaf.view.canvas;
      if (!canvas || !canvas.nodes) return;
      // v0.16.3【图片等待重试链】：卡内有 img 未加载完时，lmbFitNodeActual 会返回 null
      //   （v0.16.3 起）→ fitNode 回退估算 → 估算值被写进档案。若没有这轮补测，图片加载
      //   完成后就**没人再量一次**，偏小的估算值被固化 —— 「自动高度依旧偏小」的主根因。
      //   递增间隔追加最多 3 轮（800ms / 1600ms / 2400ms），测到真值那轮写回后自然收敛；
      //   计数表独立于 _fitRetry（那是 250ms 主调度的防抖位，语义不同）。
      try {
        let pendingImg = false;
        const entries = (typeof canvas.nodes.entries === "function")
          ? Array.from(canvas.nodes.entries())
          : Object.entries(canvas.nodes);
        for (const [, n] of entries) {
          const el = n && (n.nodeEl || n.contentEl);
          const imgs = el && el.querySelectorAll ? el.querySelectorAll("img") : null;
          if (!imgs) continue;
          for (let i = 0; i < imgs.length; i++) {
            if (!imgs[i].complete) { pendingImg = true; break; }
          }
          if (pendingImg) break;
        }
        if (pendingImg) {
          if (!this._fitRetryImg) this._fitRetryImg = {};
          const k = cf.path;
          const cnt = (this._fitRetryImg[k] || 0) + 1;
          if (cnt <= 3) {
            this._fitRetryImg[k] = cnt;
            setTimeout(() => {
              try { this._actualFitRetryForFile(cf).catch(() => {}); } catch (_) {}
            }, 800 * cnt);
            return;                       // 本轮不测（测了也是偏小值）
          }
          try { delete this._fitRetryImg[k]; } catch (_) {}   // 放弃：按现状测
        } else {
          if (this._fitRetryImg) { try { delete this._fitRetryImg[cf.path]; } catch (_) {} }
        }
      } catch (_) { /* 重试链自身异常不阻断本轮测量 */ }
      const store = this.autoSize ? this.autoSize.get(cf.path) : null;
      if (!store) return;
      // v0.13.6：优先 canvas 内部 API（getData / setData / requestSave），毫秒级生效。
      //   磁盘写最终也会让 canvas view reload（Obsidian 原生监听），但改 live node 后
      //   不调 requestSave 的话 canvas 内部 state 不刷新 —— 用户看到"没反应"。
      const canInternal = typeof canvas.getData === "function"
        && typeof canvas.setData === "function"
        && typeof canvas.requestSave === "function";
      let data = null;
      if (canInternal) { try { data = canvas.getData(); } catch (_) { data = null; } }
      if (!data) {
        let raw; try { raw = await this.app.vault.read(cf); } catch (_) { return; }
        try { data = JSON.parse(raw); } catch (_) { return; }
      }
      if (!data || !Array.isArray(data.nodes)) return;
      const sizeUpdates = new Map();
      for (const n of data.nodes) {
        if (n.type !== "text" || !n.text || !EX_ID_RE.test(n.text)) continue;
        const cached = store.get(n.id);
        const textHash = this.simpleHash(n.text);
        if (cached && cached.locked) continue;
        const outerWidth = Number(n.width) || 0;
        if (cached && cached.hash === textHash && !cached.pendingActual
          && (outerWidth <= 0 || Math.abs((Number(cached.w) || 0) - outerWidth) < 2)) continue;
        const live = canvas.nodes.get ? canvas.nodes.get(n.id) : canvas.nodes[n.id];
        if (!live) continue;
        // v0.13.5：actual 可能拿不到（markdown 异步渲染还没 layout）—— 200ms 后多试一次
        //   仍拿不到就用 estimate（保证至少有值可写，否则 retry 永远静默失败）
        let actual = this.lmbFitNodeActual(live, store);
        if (!actual) {
          await new Promise((r) => setTimeout(r, 200));
          actual = this.lmbFitNodeActual(live, store);
        }
        if (actual && !actual.unchanged) {
          sizeUpdates.set(n.id, { width: Math.round(actual.w), height: Math.round(actual.h) });
        }
      }
      if (sizeUpdates.size) {
        let done = false;
        if (canInternal) {
          try {
            // 测量期间用户可能移动卡片；提交前重读最新状态，只合并宽高。
            const fresh = canvas.getData();
            if (fresh && Array.isArray(fresh.nodes)) {
              for (const n of fresh.nodes) {
                const next = sizeUpdates.get(n.id);
                if (!next) continue;
                n.width = next.width;
                n.height = next.height;
              }
              this.selfWritten.set(cf.path, Date.now());
              canvas.setData(fresh);
              canvas.requestSave();
              done = true;
            }
          } catch (_) { /* 回退文件写 */ }
        }
        if (!done) {
          let raw; try { raw = await this.app.vault.read(cf); } catch (_) { return; }
          let fresh; try { fresh = JSON.parse(raw); } catch (_) { return; }
          if (!fresh || !Array.isArray(fresh.nodes)) return;
          for (const n of fresh.nodes) {
            const next = sizeUpdates.get(n.id);
            if (!next) continue;
            n.width = next.width;
            n.height = next.height;
          }
          const indent = /\n\t"/.test(raw) ? "\t" : "  ";
          this.selfWritten.set(cf.path, Date.now()); // v0.16.4 P2-4：存时间戳（过期不吞真实 modify）
          await this.app.vault.adapter.write(cf.path, JSON.stringify(fresh, null, indent));
        }
        this.persistAutoSizeSoon();
      }
    } catch (_) {}
  },

  /**
   * v0.6.0：规范化已有重叠摘录（命令入口）。
   *   遍历当前打开的 canvas（若无则扫 vault 顶层 *.canvas），对每张 ^ex 卡
   *   找它最重叠的另一张 ^ex 卡作为父卡；按 (parent, side) 分组整组重排
   *   （v0.9.3 起为贴边对齐 + 以父卡中心对称轴组居中，保留各卡自身尺寸），新增父子边；写回文件。
   *   幂等：重复执行不重复改位置（get后无重叠卡），不重复建边（dup 检查）。
   */
  /**
   * v0.6.0：重叠规范化。v0.9.2 起支持传入 targetFile（只处理这一张画布），
   *   供「跳转落地后的重叠自愈」定点调用；不传参时行为与旧版完全一致。
   */
  async normalizeOverlappingExcerpts(targetFile, opts) {
    // v0.16.5 修复 R1：opts.healOnly = true 时只「重排已有父子关系且当前仍重叠」的组，
    //   **不新建任何边** —— 自动自愈不该替用户决定父子关系。
    //   命令路径沿用 v0.6.0 的重叠建边语义，但加两道约束：
    //     ① 已有自动父边的卡跳过 —— 不许绕过 v0.11.0「首连锁定（一卡一线）」；
    //     ② 新建的边必须登记进 sidecar（autoEdges）—— 否则会出现「recenter 认它
    //        （e<base36> 命名兜底）但清理按 sidecar 过滤不认它」的账本矛盾 → 孤儿边残留。
    const healOnly = !!(opts && opts.healOnly);
    let targets;
    if (targetFile) {
      targets = [targetFile];                       // 定点：只处理这一张画布
    } else {
      targets = this.app.workspace.getLeavesOfType("canvas")
        .map((l) => l.view && l.view.file).filter(Boolean);
      if (!targets.length) {
        targets = this.app.vault.getFiles().filter((f) => f.extension === "canvas");
      }
    }
    if (!targets.length) { new Notice("未找到 canvas 文件"); return; }

    let totalEdges = 0, totalMoves = 0;
    for (const cf of targets) {
      try {
        // v0.16.1：数据源与 processCanvas 同纪律 —— 内存优先（防覆盖用户未落盘的拖动）
        let raw = null;
        try { raw = await this.app.vault.read(cf); } catch (_) { raw = null; }
        let data = null;
        let memCanvas = null;
        const mem = this._lmbMemCanvasData(cf);
        if (mem) { data = mem.data; memCanvas = mem.canvas; }
        if (!data) {
          if (!raw) continue;
          try { data = JSON.parse(raw); } catch (_) { continue; }
        }
        const nodes = data.nodes || [];
        if (!Array.isArray(data.edges)) data.edges = [];
        let sidecarDirty = false;   // v0.16.5 R1：是否有新建边需要写回 sidecar 账本

        const ex = nodes.filter((n) => n.type === "text" && n.text && EX_ID_RE.test(n.text));
        const sidecarN = this.autoEdges.get(cf.path) || new Set();
        // 每张 ^ex 卡：选相交面积最大的另一张 ^ex 作父；阈值与 processCanvas 一致
        const parentOfCard = new Map(); // childId -> parentId
        if (healOnly) {
          // v0.16.5 R1：自愈模式 —— 只用「现有边 + 当前仍重叠」的父子对，不新建关系。
          //   边的方向可能是 child→parent（用户手连），两端都试，以带 ^ex 的那端为子。
          for (const ed of data.edges) {
            if (!ed || !ed.fromNode || !ed.toNode || ed.fromNode === ed.toNode) continue;
            let p = nodes.find((n) => n.id === ed.fromNode);
            let c = nodes.find((n) => n.id === ed.toNode);
            const isEx = (n) => n && n.type === "text" && n.text && EX_ID_RE.test(n.text);
            if (!isEx(c)) { const t = p; p = c; c = t; }
            if (!isEx(c) || !p || p.type === "group") continue;
            if (!lmbPickDropParent(c, [p], 0.2)) continue;      // 不重叠 → 无需自愈
            if (!parentOfCard.has(c.id)) parentOfCard.set(c.id, p.id);
          }
        } else {
          for (const nn of ex) {
            // ① 已有自动父边 → 跳过（首连锁定：想换父请手动删线重拖）
            if (lmbAutoParentEdgeOf(nn.id, data.edges, sidecarN)) continue;
            const others = ex.filter((o) => o.id !== nn.id);
            const hit = lmbPickDropParent(nn, others, 0.2);
            if (hit) parentOfCard.set(nn.id, hit.node.id);
          }
        }

        // 分组：按 (parentId, side) 收集
        const groups = new Map();
        for (const nn of ex) {
          const pid = parentOfCard.get(nn.id);
          if (!pid) continue;
          const parent = nodes.find((n) => n.id === pid);
          if (!parent) continue;
          const side = lmbSideOf(nn, parent);
          const key = pid + "|" + side;
          if (!groups.has(key)) groups.set(key, { parent, side, kids: [] });
          groups.get(key).kids.push(nn);
        }

        let changed = false;
        for (const g of groups.values()) {
          // 1) 全组贴边对齐 + 组居中（v0.9.3 不再拉伸子卡尺寸）
          lmbLayoutGroup(g.parent, g.kids, g.side, 30);
          for (const k of g.kids) { k.x = Math.round(k.x); k.y = Math.round(k.y); }
          totalMoves += g.kids.length;
          // 2) 建父子边（dup 检查，幂等）
          const ends = lmbSideEnds(g.side);
          for (const k of g.kids) {
            const exists = data.edges.some((ed) =>
              (ed.fromNode === g.parent.id && ed.toNode === k.id) ||
              (ed.fromNode === k.id && ed.toNode === g.parent.id));
            if (!exists) {
              const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
              data.edges.push({
                id: eid, fromNode: g.parent.id, toNode: k.id,
                fromSide: ends.fromSide, toSide: ends.toSide
              });
              // ② 新建的边登记进 sidecar（自动边账本）—— 自愈模式不建边，故不受影响
              if (!sidecarN.has(eid)) { sidecarN.add(eid); sidecarDirty = true; }
              totalEdges++;
            }
          }
          changed = true;
        }
        if (sidecarDirty) this.autoEdges.set(cf.path, sidecarN);

        if (changed) {
          // v0.16.1：统一写回（setData + requestSave + 同一份数据写盘，防瞬移）
          await this._lmbWriteCanvasData(cf, data, memCanvas, raw);
          console.log("[lmb] 规范化画布:", cf.path,
            "组数=" + groups.size + " 移动=" + groups.size + "组 新边=" + totalEdges);
        }
      } catch (err) {
        console.error("[lmb] normalize failed for", cf.path, err);
      }
    }
    new Notice(`已规范化：新建 ${totalEdges} 条边，整组移动 ${totalMoves} 张卡（${targets.length} 个画布）`);
  },

  /**
   * v0.13.3：自动适配卡片尺寸到内容高度。
   *   优先用**实际 DOM 测量**（lmbFitNodeActual）—— canvas 节点已渲染时这是真相。
   *   节点未渲染（首次扫描 / 节点在视口外）回退到 estimateSizeFor 的估算。
   *   返回 null 表示不需要变（hash 没变或尺寸差 < 2px）。
   */
  fitNode(node, store) {
    // v0.14.8：手动 fit 过的卡片「锁定」，自动 fit 不再覆盖（避免子节点 fit 后被 processCanvas
    //   的 estimateSizeFor 误差覆盖回错的尺寸 —— 用户反馈「子节点调整高度失效」）。
    const prev0 = store.get(node.id);
    if (prev0 && prev0.locked) return null;
    const hash = this.simpleHash(node.text);
    // 文本没变说明这次 modify 只是移动、连线或手动调尺寸；绝不能再次测量高度。
    const currentWidth = Number(node.width) || 0;
    if (prev0 && prev0.hash === hash
      && (currentWidth <= 0 || Math.abs((Number(prev0.w) || 0) - currentWidth) < 2)) return null;
    const actual = this.lmbFitNodeActual(node, store);
    if (actual) return actual.unchanged ? null : { w: actual.w, h: actual.h };
    // 估算回退（节点未渲染或 DOM 拿不到）
    const prev = store.get(node.id);
    if (prev && prev.hash === hash) return null;
    const size = this.estimateSizeFor(node.text);
    // DOM/图片尚未就绪时只估算一次，并明确标记供延迟重测定点处理。
    store.set(node.id, { hash, w: size.w, h: size.h, pendingActual: true });
    this.persistAutoSizeSoon();
    if (prev && Math.abs(prev.w - size.w) < 2 && Math.abs(prev.h - size.h) < 2) return null;
    return size;
  },

  /**
   * v0.13.3：实际测量 canvas 节点**已渲染**的内容高度，设回 node.height。
   *   比 estimateSizeFor 精确 —— DOM 是真相。前提：节点已渲染（nodeEl / contentEl
   *   可查）。否则返回 null 让调用者回退估算。
   *   scrollHeight 是内容刚好需要的最小高度（包含 contentEl 自身 padding，**不含**
   *   margin，也不含 contentEl 之外的节点 padding）。
   *
   *   v0.16.3【自动路径与手动路径对齐】：此前这里还是 `scrollHeight + 24` 老逻辑，
   *   而 v0.16.1/v0.16.2 的三项增强全改在了手动路径（lmbFitNodeById）—— 自动 fit
   *   （新卡拖入 / processCanvas / 250ms 重测）走的就是本函数，结果：
   *     ① 节点 chrome 靠 +24 经验值 → 评论 callout 余量不足 → 裁底；
   *     ② **没有图片等待** —— 自动 fit 几乎总发生在卡片刚创建、webp 还没加载完时，
   *        scrollHeight 偏小 → 高度偏小**且被写进档案**（hash 没变就不再重测），
   *        偏小值被固化 —— 这就是「自动高度调整依旧小于实际所需」的主根因。
   *   修法（本函数是同步的，不能 await 图片）：
   *     - h = scrollHeight + chromePad(nodeEl 上下 padding+border 实测) + buffer(28/8)
   *     - **卡内有 img 未加载完 → 返回 null**（调用方 fitNode 回退估算），配合
   *       _actualFitRetryForFile 的图片等待重试链（v0.16.3）在加载完后测出真值写回。
   *   用途：自动 fit / 250ms 重测 / 评论区保存后刷新。
   */
  lmbFitNodeActual(node, store) {
    try {
      if (!node) return null;
      const wrapperEl = node.nodeEl || node.contentEl;
      if (!wrapperEl || typeof wrapperEl.querySelector !== "function") return null;
      const contentEl = wrapperEl.querySelector(".canvas-node-content")
        || wrapperEl.querySelector(".markdown-rendered")
        || wrapperEl;
      if (!contentEl || typeof contentEl.scrollHeight !== "number") return null;
      // scrollHeight === 0：元素不可见（display:none / 刚挂载未布局）
      if (contentEl.scrollHeight <= 0) return null;
      // v0.16.3：卡内有图片未加载完 → 高度必然偏小，宁可用估算+重试链，不固化错值
      try {
        const imgs = contentEl.querySelectorAll("img");
        for (let i = 0; i < imgs.length; i++) {
          if (!imgs[i].complete) return null;
        }
      } catch (_) { /* 查不了就照旧测（最坏情况回到旧行为） */ }
      // v0.16.3：节点 chrome 精确测量（上下 padding + border），不再用 +24 经验值。
      //   buffer 与手动路径同源：有评论 28（末尾 callout 的 padding+border+余量）、无 8。
      let chromePad = 0;
      try {
        const ncs = getComputedStyle(wrapperEl);
        if (ncs) {
          chromePad = (parseFloat(ncs.paddingTop) || 0) + (parseFloat(ncs.borderTopWidth) || 0)
            + (parseFloat(ncs.paddingBottom) || 0) + (parseFloat(ncs.borderBottomWidth) || 0);
        }
      } catch (_) { chromePad = 0; }
      const hasComment = (function () {
        try {
          const t = node && node.text;
          if (typeof t !== "string" || !LMB_COMMENT_CALLOUT_RE) return false;
          return t.split(/\r?\n/).some((line) => LMB_COMMENT_CALLOUT_RE.test(line));
        } catch (_) { return false; }
      })();
      // 缓存和写回都使用 Canvas JSON 的外框宽度。clientWidth 是内部宽度，若把它写回
      // node.width 会让卡片每次 fit 变窄、文本重新换行，随后高度自然又变了。
      const w = Math.max(80, Number(node.width) || Number(wrapperEl.offsetWidth)
        || Number(contentEl.offsetWidth) || 280);
      let measureScale = 1;
      try {
        const rr = contentEl.getBoundingClientRect();
        const layoutW = contentEl.offsetWidth || contentEl.clientWidth;
        if (rr && rr.width > 0 && layoutW > 0) measureScale = rr.width / layoutW;
      } catch (_) {}
      const naturalCardH = lmbMeasureNaturalCard(wrapperEl, contentEl, measureScale);
      const contentH = naturalCardH > 0
        ? naturalCardH
        : lmbMeasureRenderedContent(contentEl, measureScale);
      if (contentH <= 0) return null;
      // 无 DOM 克隆能力（测试桩或旧环境）才回退叶节点算法和旧安全余量。
      const h = naturalCardH > 0
        ? naturalCardH
        : lmbFinalizeCardHeight(contentH, chromePad, hasComment, false);
      const prev = store && store.get(node.id);
      const hash = this.simpleHash(node.text);
      if (prev && prev.hash === hash
        && Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2) {
        // pendingActual 是一次性任务；实际尺寸已稳定时必须清除，否则每次 modify 都会重试。
        if (prev.pendingActual && store) {
          store.set(node.id, { hash, w, h, locked: !!prev.locked });
          this.persistAutoSizeSoon();
        }
        return { w, h, unchanged: true };
      }
      if (store) {
        store.set(node.id, { hash, w, h });
        this.persistAutoSizeSoon();
      }
      return { w, h };
    } catch (_) { return null; }
  },

  /** 图片卡：按截图真实宽高比；文本卡：按行宽/行数估算；v0.11.3 双重卡：取文字/图片布局的较大高 */
  estimateSizeFor(text) {
    const em = text.match(/!\[\[([^\]|]+?)\]\]/);   // em[1] = 完整附件名（含 .webp）
    if (em) {
      const dims = this.imgDims.get(em[1]);
      const w = 380;
      // v0.11.3 双重卡判定：卡里同时有 embed 和 PDF 引用块行（文字+截图并存，
      //   靠 lmb-view 切换视图）。两种视图共用同一张卡 → 高取两者较大值，
      //   宽度固定不随切换变化（用户要求：切换内容显示方式时固定卡片宽度）。
      const hasQuote = LMB_LINK_RE.test(text);
      LMB_LINK_RE.lastIndex = 0; // 全局正则复用后必须重置（否则下一次 test 从旧 lastIndex 开始漏匹配）
      if (hasQuote) {
        const imgH = (dims && dims.w > 0)
          ? Math.round(w * dims.h / dims.w) + 78   // 图片高（等比）+ 回跳引用行 + 内边距
          : 460;                                    // 尺寸档案缺失时的兜底
        // v0.16.6：note 类型白名单随设置走（estimateSizeFor 里的两处调用同源）
        const nt = (this.settings && this.settings.noteCalloutType) || "ppd-note";
        const textH = this.estimateTextSize(lmbRenderedText(text, nt)).h;
        return this.addNoteChrome({ w, h: Math.max(imgH, textH) }, text);
      }
      if (dims && dims.w > 0) {
        // 图片高（按卡片宽等比）+ 回跳引用行（约 2 行）+ 内边距
        const imgH = Math.round(w * dims.h / dims.w);
        return this.addNoteChrome({ w, h: imgH + 78 }, text);
      }
      return this.addNoteChrome({ w, h: 460 }, text);
    }
    // v0.13.3：lmbRenderedText 现在真正剥离 callout，纯文字行高度更准；
    //   addNoteChrome 加 ppd-note 高度，新增 addCommentChrome 加 lmb-comment 展开态高度
    return this.addCommentChrome(
      this.addNoteChrome(
        this.estimateTextSize(lmbRenderedText(text, (this.settings && this.settings.noteCalloutType) || "ppd-note")),
        text
      ),
      text
    );
  },

  /**
   * v0.8.0：给尺寸补上 callout（补充描述框）的额外高度。
   *   callout 渲染出来会有背景框 + 标题行 + 上下内边距，这部分不在纯文本行高里。
   *   估约 46px（标题行 25 + 上下 padding 约 21），近似值，够用。
   */
  addNoteChrome(size, text) {
    // v0.16.6：只认插件自有的 note 类型（用户自有 callout 不该被算成补充描述高度）
    const types = (this.settings && this.settings.noteCalloutType) || "ppd-note";
    if (!lmbSplitNote(text, types).hasNote) return size;
    return { w: size.w, h: Math.ceil(Math.min(2000, size.h + 46)) };
  },
  /**
   * v0.13.3：给尺寸补上 lmb-comment callout 的额外高度。
   *   - 折叠态（标题行 + 单行「添加评论」）：约 30px（标题 25 + 上下 padding + 边框）
   *   - 展开态：v0.16.1 改为**按评论内容行数**算 —— 旧版固定 +50 是 Bug1 的主根因：
   *     estimateTextSize 的输入 lmbRenderedText 已把评论内容剥掉，内容行全靠这里补，
   *     而展开态评论一超过一行（50 - 标题25 - padding ≈ 只够 0 行内容！）就必然
   *     把卡片算矮 → 自动 fit 后评论底部被裁（用户实测「有评论的卡片自动高度
   *     裁掉评论底部」）。修法：标题 25 + 内容行数×25 + callout 自身 padding/边框 24。
   *     多行评论按行数线性增长，与实际渲染趋势一致。
   */
  addCommentChrome(size, text) {
    if (!lmbSplitComment(text).hasComment) return size;
    const c = lmbSplitComment(text);
    if (!c.comment || c.fold) {
      // 折叠态 / 空占位：单行按钮，30 不变
      return { w: size.w, h: Math.ceil(Math.min(2000, size.h + 30)) };
    }
    const lines = Math.max(1, String(c.comment).split("\n").length);
    const extra = 25 + lines * 25 + 24;   // 标题行 + 内容行 + callout padding/边框
    return { w: size.w, h: Math.ceil(Math.min(2000, size.h + extra)) };
  },

  estimateTextSize(text) {
    const doc = typeof activeDocument !== "undefined" ? activeDocument : document;
    const meas = doc.createElement("span");
    meas.style.cssText = "position:fixed;left:-9999px;top:0;white-space:pre;visibility:hidden;" +
      "font-size:16px;line-height:1.5;font-family:var(--font-text,-apple-system,'Microsoft YaHei',sans-serif);";
    doc.body.appendChild(meas);
    const lines = text.split("\n").map((l) => {
      let s = l.replace(/\[\[[^\]]*\|([^\]]+)\]\]/g, "$1").replace(/\[\[[^\]]*\]\]/g, "……");
      const quote = /^>/.test(s);
      s = s.replace(/^>\s?/, "");
      meas.textContent = s || " ";
      return { w: meas.getBoundingClientRect().width, quote };
    });
    meas.remove();

    const padX = 28, padY = 40, lineH = 25, quoteIndent = 22;
    const natural = Math.max.apply(null, lines.map((l) => l.w + (l.quote ? quoteIndent : 0)));
    const w = Math.ceil(Math.min(560, Math.max(260, natural + padX)));
    const innerW = Math.max(80, w - padX - quoteIndent);
    let h = padY;
    for (const l of lines) {
      h += Math.max(1, Math.ceil(l.w / innerW)) * lineH + (l.quote ? 4 : 0);
    }
    return { w, h: Math.ceil(Math.min(2000, Math.max(80, h))) };
  },

  simpleHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return String(h);
  },

  persistAutoSizeSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.saveSettings().catch(() => {});
    }, 2000);
  },

});
