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

  async processCanvas(cf) {
    const raw = await this.app.vault.read(cf);
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
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
    const attachComment = this.settings.commentAutoBoxOnNew !== false; // v0.11.0：评论栏
    if (attachNote || attachComment) {
      const lastPos0 = this.canvasPositions.get(cf.path) || new Map();
      const fold0 = !!this.settings.noteFoldByDefault;
      for (const node of nodes) {
        if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
        if (lastPos0.has(node.id)) continue;              // 见过的卡 → 不动
        let touched = false;
        if (attachNote && !lmbSplitNote(node.text).hasNote) {   // 已有描述 → 不动
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
      const indent = /\n\t"/.test(raw) ? "\t" : "  ";
      this.selfWritten.set(cf.path, true);
      try {
        await this.app.vault.adapter.write(cf.path, JSON.stringify(data, null, indent));
      } catch (err) {
        this.selfWritten.delete(cf.path);
        console.error("[lmb] canvas resize write failed:", err);
      }
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
    for (const n of nodes) {
      if (n.type === "group") continue;
      const cur = { x: n.x, y: n.y, width: n.width || 0, height: n.height || 0 };
      currentPos.set(n.id, cur);
      const prev = lastPos.get(n.id);
      if (!prev || prev.x !== cur.x || prev.y !== cur.y ||
          prev.width !== cur.width || prev.height !== cur.height) {
        movedOrNew.push(n);
      }
    }
    this.canvasPositions.set(cf.path, currentPos);
    this.persistAutoSizeSoon(); // 落盘档案（canvasPositions + autoEdges + autoSize 共用防抖）

    if (movedOrNew.length) {
      for (const nn of movedOrNew) {
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
        const sidecar2 = this.autoEdges.get(cf.path) || new Set();
        const plan = lmbPlanAutoLink(nn, parent, data.edges, sidecar2);
        if (plan.op === "skip") continue;
        if (plan.op === "reside") {
          const r = lmbApplyReside(parent, nn, plan, nodes, data.edges);
          changed = true;
          console.log("[lmb] 自动父子（改挂侧）:", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
            "(" + plan.oldSide + "→" + r.side + ", 相交" + Math.round(hit.ratio * 100) + "%)");
          continue;
        }

        // 取父卡现有子卡按侧分组；把新卡 nn 加进同侧组，整组贴边对齐+组居中排布（v0.9.3 不再拉伸尺寸）
        const kidsBySide = lmbGroupBySide(parent, nodes, data.edges);
        const group = [...(kidsBySide.get(plan.side) || []), nn];
        lmbLayoutGroup(parent, group, plan.side, 30);
        const ends = lmbSideEnds(plan.side);
        const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        data.edges.push({
          id: eid, fromNode: parent.id, toNode: nn.id,
          fromSide: ends.fromSide, toSide: ends.toSide
        });
        // 标记为自动边（用于后续清理）
        sidecar2.add(eid);
        this.autoEdges.set(cf.path, sidecar2);
        changed = true;
        console.log("[lmb] 自动父子（首连锁定 v0.11.0）:", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
          "(" + ends.fromSide + "→" + ends.toSide + ", 相交" + Math.round(hit.ratio * 100) + "%, 组" + group.length + ")");
      }

      if (changed) {
        const indent2 = /\n\t"/.test(raw) ? "\t" : "  ";
        this.selfWritten.set(cf.path, true);
        try {
          await this.app.vault.adapter.write(cf.path, JSON.stringify(data, null, indent2));
        } catch (err) {
          this.selfWritten.delete(cf.path);
          console.error("[lmb] hierarchy write failed:", err);
        }
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
      const srcText = this.settings.noteIntoSync ? node.text : lmbStripNote(node.text);
      const body = srcText
        .split("\n")
        .filter((l) => !/^\s*\^ex-[0-9a-z]{4,8}\s*$/.test(l))
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
  async normalizeOverlappingExcerpts(targetFile) {
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
        const raw = await this.app.vault.read(cf);
        let data; try { data = JSON.parse(raw); } catch (_) { continue; }
        const nodes = data.nodes || [];
        if (!Array.isArray(data.edges)) data.edges = [];

        const ex = nodes.filter((n) => n.type === "text" && n.text && EX_ID_RE.test(n.text));
        // 每张 ^ex 卡：选相交面积最大的另一张 ^ex 作父；阈值与 processCanvas 一致
        const parentOfCard = new Map(); // childId -> parentId
        for (const nn of ex) {
          const others = ex.filter((o) => o.id !== nn.id);
          const hit = lmbPickDropParent(nn, others, 0.2);
          if (hit) parentOfCard.set(nn.id, hit.node.id);
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
              data.edges.push({
                id: "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                fromNode: g.parent.id, toNode: k.id,
                fromSide: ends.fromSide, toSide: ends.toSide
              });
              totalEdges++;
            }
          }
          changed = true;
        }

        if (changed) {
          const indent = /\n\t"/.test(raw) ? "\t" : "  ";
          this.selfWritten.set(cf.path, true);
          await this.app.vault.adapter.write(cf.path, JSON.stringify(data, null, indent));
          console.log("[lmb] 规范化画布:", cf.path,
            "组数=" + groups.size + " 移动=" + groups.size + "组 新边=" + totalEdges);
        }
      } catch (err) {
        console.error("[lmb] normalize failed for", cf.path, err);
      }
    }
    new Notice(`已规范化：新建 ${totalEdges} 条边，整组移动 ${totalMoves} 张卡（${targets.length} 个画布）`);
  },

  fitNode(node, store) {
    const hash = this.simpleHash(node.text);
    const prev = store.get(node.id);
    if (prev && prev.hash === hash) return null;  // 已适配或用户手动调整过
    const size = this.estimateSizeFor(node.text);
    store.set(node.id, { hash, w: size.w, h: size.h });
    this.persistAutoSizeSoon();
    if (prev && Math.abs(prev.w - size.w) < 2 && Math.abs(prev.h - size.h) < 2) return null;
    return size;
  },

  /** 图片卡：按截图真实宽高比；文本卡：按行宽/行数估算 */
  estimateSizeFor(text) {
    const em = text.match(/!\[\[([^\]|]+?)\]\]/);   // em[1] = 完整附件名（含 .webp）
    if (em) {
      const dims = this.imgDims.get(em[1]);
      const w = 380;
      if (dims && dims.w > 0) {
        // 图片高（按卡片宽等比）+ 回跳引用行（约 2 行）+ 内边距
        const imgH = Math.round(w * dims.h / dims.w);
        return this.addNoteChrome({ w, h: imgH + 78 }, text);
      }
      return this.addNoteChrome({ w, h: 460 }, text);
    }
    // v0.8.0：不可见的注释锚点行不计入高度，按「实际渲染的文本」估算，再补 callout 框高
    return this.addNoteChrome(this.estimateTextSize(lmbRenderedText(text)), text);
  },

  /**
   * v0.8.0：给尺寸补上 callout（补充描述框）的额外高度。
   *   callout 渲染出来会有背景框 + 标题行 + 上下内边距，这部分不在纯文本行高里。
   *   估约 46px（标题行 25 + 上下 padding 约 21），近似值，够用。
   */
  addNoteChrome(size, text) {
    if (!lmbSplitNote(text).hasNote) return size;
    return { w: size.w, h: Math.ceil(Math.min(900, size.h + 46)) };
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
    return { w, h: Math.ceil(Math.min(900, Math.max(80, h))) };
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
