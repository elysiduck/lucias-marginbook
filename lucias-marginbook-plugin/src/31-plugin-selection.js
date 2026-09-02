/* 31-plugin-selection —— 选区/拖拽/chip/即时通道（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

  /* ==================== 框选启动（按钮模式 / Alt） ==================== */

  onDocMouseDown(e) {
    if (this.chipEl && !this.chipEl.contains(e.target)) this.hideChip();

    const el = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
    if (!el || !el.closest) return;
    const leafEl = el.closest(".workspace-leaf");
    const leaf = leafEl && this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl);

    // Alt 或 按钮模式 → 启动自带框选
    if ((e.altKey || this.rectMode) && e.button === 0 && leaf && leaf.view && leaf.view.file) {
      if (!e.altKey) e.preventDefault(); // 按钮模式拦截文字选择（Alt 亦然）
      e.stopPropagation();
      this.startRectDrag(leaf, e);
      return;
    }
  },

  startRectDrag(leaf, e) {
    const doc = typeof activeDocument !== "undefined" ? activeDocument : document;
    const box = doc.createElement("div");
    box.className = "lmb-rect";
    doc.body.appendChild(box);
    this.debugNotice("框选中…");

    const sx = e.clientX, sy = e.clientY;
    const mv = (ev) => {
      ev.preventDefault();
      box.style.left = Math.min(sx, ev.clientX) + "px";
      box.style.top = Math.min(sy, ev.clientY) + "px";
      box.style.width = Math.abs(ev.clientX - sx) + "px";
      box.style.height = Math.abs(ev.clientY - sy) + "px";
    };
    const up = async (ev) => {
      document.removeEventListener("mousemove", mv, true);
      document.removeEventListener("mouseup", up, true);
      box.remove();
      const w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy);
      if (w < 8 || h < 8) return; // 误触，按钮模式保持

      const pageEl = this.pageAtPoint(doc, ev.clientX, ev.clientY) || this.pageAtPoint(doc, sx, sy);
      if (!pageEl) { this.debugNotice("✗ 框选区域不在 PDF 页面内"); return; }
      const pageNum = parseInt(pageEl.dataset.pageNumber, 10) || 1;

      const screenRect = {
        left: Math.min(sx, ev.clientX), top: Math.min(sy, ev.clientY),
        right: Math.max(sx, ev.clientX), bottom: Math.max(sy, ev.clientY)
      };
      const ctx = await this.captureRectImage(leaf.view, pageEl, screenRect, pageNum);
      if (ctx) {
        if (this.rectMode) { this.rectMode = false; this.updateRibbonState(); } // 一次性消费
        this.debugNotice("✓ 截图已保存 " + ctx.attachmentName + "（" + ctx.imgW + "×" + ctx.imgH + "）");
        this.showChip(ev.clientX, ev.clientY, "🖼 图片已截图 · 按住拖到 md 或画布", ctx);
      } else {
        this.debugNotice("✗ 截图失败（页面画布不可用）");
      }
    };
    document.addEventListener("mousemove", mv, true);
    document.addEventListener("mouseup", up, true);
  },

  pageAtPoint(doc, x, y) {
    const hit = doc.elementFromPoint(x, y);
    return hit && hit.closest ? hit.closest(".page[data-page-number]") : null;
  },

  /* ==================== mouseup：出示手柄 ==================== */

  onDocMouseUp(e) {
    const doc = typeof activeDocument !== "undefined" ? activeDocument : document;

    // ① 文字选区（v0.3.1：经 lmbShouldReshowSelection 把关，杜绝拖放后旧选区反复重建 chip）
    const win = typeof activeWindow !== "undefined" ? activeWindow : window;
    const sel = win.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const info = this.extractSelection(sel);
      if (info) {
        const sig = info.text + "@" + info.pageNum;
        const hit = doc.elementFromPoint(e.clientX, e.clientY);
        const show = lmbShouldReshowSelection({
          hasSelection: true,
          targetOnChip: !!(this.chipEl && this.chipEl.contains(e.target)),
          chipVisible: !!this.chipEl,
          sameSelection: this._chipSig === sig,
          mouseOnPdf: !!(hit && hit.closest && hit.closest(".page[data-page-number]"))
        });
        if (show) {
          this._chipSig = sig; // 记录 chip 当前承载的选区签名（dragend 时清除）
          this.debugNotice("✓ 文字选区 " + info.display + "（" + info.text.length + " 字）");
          this.showChip(e.clientX, e.clientY, "📑 " + info.text.length + " 字 · 按住拖到 md 或画布", info);
          return;
        }
        // 被把关拦下（点在 chip 上 / 同选区重复 / 释放点不在 PDF 内）→ 静默，不再刷屏
        return;
      }
    }

    // ② v0.7.2：兜底提示只在「点的是 PDF 视图」时才可能弹。
    //    根因：onDocMouseUp 是 document 级全局监听（capture），点 canvas / md / 侧栏
    //    同样会跑到这里 —— 用户「还没选 PDF」就被提示，纯噪音。
    //    注意：debugNotice 里有 console.log 是无条件的，所以这里 return 前不调用即可彻底静默。
    if (!this.eventInPdfLeaf(e)) return;
    const now = Date.now();
    if (now - this._lastNoSelNotice > 5000) {
      this._lastNoSelNotice = now;
      this.debugNotice("mouseup：无文字选区（图片框选 = 侧栏按钮 或 Alt+拖）");
    }
  },

  /**
   * v0.7.2：判定鼠标事件是否发生在 PDF 视图（leaf）内。
   *   复用 onDocMouseDown 同款解析：事件目标 → 最近 .workspace-leaf → 在 getLeavesOfType("pdf") 里匹配。
   *   用于在「非 PDF 上下文」（canvas / md / 侧栏）彻底静默本插件的调试提示。
   */
  eventInPdfLeaf(e) {
    const t = e && e.target;
    const el = t && t.nodeType === 1 ? t : (t && t.parentElement);
    if (!el || !el.closest) return false;
    const leafEl = el.closest(".workspace-leaf");
    if (!leafEl) return false;
    try {
      return !!this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl);
    } catch (_) {
      return false;
    }
  },

  /**
   * v0.7.2：判定鼠标事件是否发生在 canvas 视图（leaf）内，返回其文件。
   */
  canvasFileFromEvent(e) {
    const t = e && e.target;
    const el = t && t.nodeType === 1 ? t : (t && t.parentElement);
    if (!el || !el.closest) return null;
    const leafEl = el.closest(".workspace-leaf");
    if (!leafEl) return null;
    try {
      const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.containerEl === leafEl);
      const f = leaf && leaf.view && leaf.view.file;
      return f && f.extension === "canvas" ? f : null;
    } catch (_) {
      return null;
    }
  },

  /**
   * v0.9.3：由鼠标事件找到所在 canvas 视图的内部 canvas 对象（API 齐全才返回），
   * 供 instantMoveAttach 在内存数据上直接做父子判定（不等落盘）。
   */
  canvasObjFromEvent(e) {
    const t = e && e.target;
    const el = t && t.nodeType === 1 ? t : (t && t.parentElement);
    if (!el || !el.closest) return null;
    const leafEl = el.closest(".workspace-leaf");
    if (!leafEl) return null;
    try {
      const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.containerEl === leafEl);
      const c = leaf && leaf.view && leaf.view.canvas;
      return (c && typeof c.getData === "function" &&
        typeof c.setData === "function" && typeof c.requestSave === "function") ? c : null;
    } catch (_) {
      return null;
    }
  },

  /**
   * v0.7.2：松手快速通道（drop flush）。
   *   拖拽期间 Obsidian canvas 连续触发 modify，400ms 防抖不断被重置 → 松手后还要干等 400ms。
   *   这里在 canvas 内 mouseup 时「武装」一次 flush：下一个 modify（= Obsidian 落盘）到达时
   *   改用 80ms 极短防抖立即处理，而不是 400ms。
   *   稳妥性：若 600ms 内没等到 save（说明落盘早于 mouseup），兜底定时器直接跑一次，
   *   最坏也只是按当前磁盘内容处理，随后的常规 400ms 通道会再纠正。
   */
  armDropFlush(file) {
    if (!file || file.extension !== "canvas") return;
    if (this._dropFlush && this._dropFlush.timer) clearTimeout(this._dropFlush.timer);
    const path = file.path;
    this._dropFlush = {
      path,
      t: Date.now(),
      timer: setTimeout(() => {
        this._dropFlush = null;
        this.processCanvas(file).catch((err) =>
          console.error("[lmb] drop flush failed:", err));
      }, 600)
    };
  },

  /* ==================== 图片：裁剪页面画布 → webp 附件 ==================== */

  /**
   * 屏幕矩形 → 裁剪页面画布 → 保存 webp 附件。
   * 零 pdfjs 内部 API：直接 drawImage 页面上已渲染的 <canvas>。
   */
  async captureRectImage(view, pageEl, screenRect, pageNum) {
    try {
      const src = pageEl.querySelector("canvas");
      if (!src || !src.width || !src.height) {
        console.warn("[lmb] page canvas not found");
        return null;
      }
      const base = src.getBoundingClientRect();
      if (!base.width || !base.height) return null;
      const kx = src.width / base.width, ky = src.height / base.height;
      let sx = (screenRect.left - base.left) * kx;
      let sy = (screenRect.top - base.top) * ky;
      let sw = (screenRect.right - screenRect.left) * kx;
      let sh = (screenRect.bottom - screenRect.top) * ky;
      sx = Math.max(0, Math.min(src.width - 1, sx));
      sy = Math.max(0, Math.min(src.height - 1, sy));
      sw = Math.max(1, Math.min(src.width - sx, sw));
      sh = Math.max(1, Math.min(src.height - sy, sh));

      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(sw));
      out.height = Math.max(1, Math.round(sh));
      out.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
      const blob = await new Promise((res) => out.toBlob(res, "image/webp", 0.92));
      if (!blob) return null;
      const buf = await blob.arrayBuffer();

      const stamp = Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 36 * 36).toString(36);
      const name = view.file.basename + "-P" + pageNum + "-" + stamp + ".webp";
      const folder = view.file.parent && view.file.parent.path ? view.file.parent.path : "/";
      const path = normalizePath(folder === "/" ? name : folder + "/" + name);
      await this.app.vault.createBinary(path, buf);

      this.imgDims.set(name, { w: out.width, h: out.height });
      this.persistAutoSizeSoon();

      const display = "【" + view.file.basename + "-P." + pageNum + "】";
      // P3.5：把框选区域编码成相对 .page 的百分比（rect=l,t,w,h）。
      //   这样截图摘录在回绘和跳转时都【不依赖 textLayer】——比文字选区更稳
      //   （pdf.js 虚拟化页没有文本层；百分比也与缩放无关）。
      let rectParam = null;
      try {
        const pr = pageEl.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) {
          const rl = 100 * (screenRect.left - pr.left) / pr.width;
          const rt = 100 * (screenRect.top - pr.top) / pr.height;
          const rw = 100 * (screenRect.right - screenRect.left) / pr.width;
          const rh = 100 * (screenRect.bottom - screenRect.top) / pr.height;
          rectParam = [rl, rt, rw, rh].map((v) => Math.round(v * 100) / 100).join(",");
        }
      } catch (_) { /* 算不出就不写 rect，回退到只画页顶条 */ }
      const link = "[[" + view.file.path + "#page=" + pageNum
        + (rectParam ? "&rect=" + rectParam : "") + "|" + display + "]]";
      return {
        file: view.file, pageNum, display,
        link, embed: "![[" + name + "]]",
        attachmentName: name, imgW: out.width, imgH: out.height,
        rectParam,
        text: "（矩形图像选区）", isImage: true
      };
    } catch (err) {
      console.error("[lmb] captureRectImage error:", err);
      return null;
    }
  },

  /* ==================== 文字选区 ==================== */

  resolvePdfContext(el) {
    const pageEl = el && el.closest && el.closest(".page[data-page-number]");
    if (!pageEl) return null;
    const leafEl = pageEl.closest(".workspace-leaf");
    if (!leafEl) return null;
    const leaf = this.app.workspace.getLeavesOfType("pdf").find((l) => l.containerEl === leafEl);
    const view = leaf && leaf.view;
    if (!view || !view.file) return null;
    return { view, pageEl, pageNum: parseInt(pageEl.dataset.pageNumber, 10) || 1 };
  },

  /**
   * 文字选区 → {file, pageNum, text, link, display}
   * selection 参数 = beginIndex,beginOffset,endIndex,endOffset（文本层索引）
   */
  extractSelection(sel) {
    try {
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const node = sel.anchorNode;
      if (!node) return null;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el || !el.closest) return null;
      const pageEl = el.closest(".page[data-page-number]");
      if (!pageEl) return null;
      const ctx = this.resolvePdfContext(el);
      if (!ctx || ctx.pageEl !== pageEl) return null;
      const file = ctx.view.file;
      const pageNum = ctx.pageNum;
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (!text) return null;
      const display = "【" + file.basename + "-P." + pageNum + "】";

      // 补丁 B：P1-5 颜色语义——best-effort 探测选区命中的高亮注释背景色 → 映射标签名。
      // 探测不到 / 未命中映射 / 未配置 colorMap 时恒为 null，行为与现状一致。
      let colorTag = null;
      try { colorTag = this.detectColorTag(el, pageEl); }
      catch (err) { console.warn("[lmb] detectColorTag error:", err); }

      let link;
      let selectionParams = null; // Bugfix: 必须随 info 返回，contentExId 才能区分「同页同文本不同位置」的选区
      try {
        const params = this.buildSelectionParams(sel, pageEl);
        if (!params) throw new Error("no selection params");
        selectionParams = params;
        link = "[[" + file.path + "#page=" + pageNum + "&selection=" + params + "|" + display + "]]";
      } catch (_) {
        link = "[[" + file.path + "#page=" + pageNum + "|" + display + "]]";
      }
      return { file, pageNum, text, link, display, isImage: false, colorTag, selectionParams };
    } catch (err) {
      console.warn("[lmb] extractSelection error:", err);
      return null;
    }
  },

  /** DOM 选区边界 → selection= 链接参数（textLayer 子 div 序号 + 字符偏移） */
  buildSelectionParams(sel, pageEl) {
    const doc = pageEl.ownerDocument;
    const layer = pageEl.querySelector(".textLayer");
    if (!layer) return null;
    const divs = Array.prototype.slice.call(layer.children);
    if (!divs.length) return null;

    const toIdxOff = (node, offset) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el || !layer.contains(el)) return null;
      let div = el;
      while (div && div.parentElement !== layer) div = div.parentElement;
      if (!div) return null;
      const idx = divs.indexOf(div);
      if (idx < 0) return null;
      const r = doc.createRange();
      r.selectNodeContents(div);
      try { r.setEnd(node, offset); } catch (_) { return null; }
      return { idx, off: r.toString().length };
    };

    const begin = toIdxOff(sel.anchorNode, sel.anchorOffset);
    const end = toIdxOff(sel.focusNode, sel.focusOffset);
    if (!begin || !end) return null;
    const a = (begin.idx < end.idx) || (begin.idx === end.idx && begin.off <= end.off) ? begin : end;
    const b = a === begin ? end : begin;
    return a.idx + "," + a.off + "," + b.idx + "," + b.off;
  },

  /**
   * 补丁 A：内容寻址 exId（P0-1）——同一选区重复拖拽 → 同一 ^ex id → 引用计数正确、天然去重。
   * 哈希基底：
   *   - 图片选区（isImage）：attachmentName（内含时间戳+随机戳，每张截图天然唯一）
   *   - 文字选区：file.path | pageNum | selectionParams（未注入时回退 text）
   * 复用 simpleHash（带符号 int32）：>>>0 转无符号后对 36^6 取模，保证恰好 6 位
   * base36 小写字母数字，稳定匹配 EX_ID_RE = /\^ex-[0-9a-z]{4,8}/。
   */
  contentExId(info) {
    try {
      const MOD36_6 = 2176782336; // 36^6
      const key = (info && info.isImage && info.attachmentName)
        ? "img|" + String(info.attachmentName)
        : [
            (info && info.file && info.file.path) ? info.file.path : "?",
            (info && info.pageNum != null) ? String(info.pageNum) : "?",
            String((info && (info.selectionParams || info.text)) || "")
          ].join("|");
      const signed = parseInt(this.simpleHash(key), 10) | 0;
      const u = (signed >>> 0) % MOD36_6;
      return "ex-" + u.toString(36).padStart(6, "0");
    } catch (err) {
      // 优雅降级：任何异常回退随机 id（仅损失去重能力，不影响功能）
      console.warn("[lmb] contentExId 降级为随机 id:", err);
      return "ex-" + Math.random().toString(36).slice(2, 8);
    }
  },

  buildDropText(info) {
    try {
      const exId = this.contentExId(info);
      // 补丁 B 颜色语义标签行（extractSelection 注入 info.colorTag，非空才输出），
      // 位于 ^ex 行之前；info.colorTag 不存在/为空时行为与旧版完全一致。
      const tagLine = (info && info.colorTag) ? "\n> #" + info.colorTag : "";
      if (info.isImage) {
        return info.embed + "\n> (" + info.link + ")" + tagLine + "\n^" + exId;
      }
      return "> (" + info.link + ")\n> " + info.text + tagLine + "\n^" + exId;
    } catch (err) {
      console.error("[lmb] buildDropText error:", err);
      // 降级：恢复旧版随机 id 行为
      const exId = "ex-" + Math.random().toString(36).slice(2, 8);
      if (info.isImage) {
        return info.embed + "\n> (" + info.link + ")\n^" + exId;
      }
      return "> (" + info.link + ")\n> " + info.text + "\n^" + exId;
    }
  },

  /* ==================== 拖拽手柄（纯原生 HTML5 drag） ==================== */

  showChip(x, y, label, info) {
    this.hideChip();
    const doc = typeof activeDocument !== "undefined" ? activeDocument : document;
    const chip = doc.createElement("div");
    chip.className = "lmb-chip";
    chip.textContent = label;
    chip.setAttribute("draggable", "true");
    chip.style.left = Math.min(x + 12, doc.defaultView.innerWidth - 240) + "px";
    chip.style.top = (y + 16) + "px";
    doc.body.appendChild(chip);
    this.chipEl = chip;

    chip.addEventListener("dragstart", (e) => {
      // Bugfix(严重回归)：守卫必须限定图片路径。文字选区的 info 没有 attachmentName 字段，
      // 无条件判断把所有文字拖拽在 dragstart 就 preventDefault 掐死（v0.2.0 引入图片截图时误伤，
      // 图片两条路径都是 await 截图完成后才 showChip，此守卫对图片仅剩"未完成"兜底意义）。
      if (info.isImage && !info.attachmentName) {
        e.preventDefault();
        this.debugNotice("截图尚未完成，请重新框选");
        return;
      }
      const dropText = this.buildDropText(info);
      e.dataTransfer.setData("text/plain", dropText);
      e.dataTransfer.effectAllowed = "copy";
      this._dragArm = { t: Date.now() }; // v0.5.0：武装即时通道（dragend 解除）
      console.log("[lmb] dragstart (" + (info.isImage ? "image" : "text") + "), len=" + dropText.length);
    });
    chip.addEventListener("dragend", () => {
      this._dragArm = null;
      this.hideChip();
      // v0.3.1：拖拽完成后，清除已被消费的 PDF 选区（防止同一选区被再次当成新摘录意图，
      // 导致 chip 复活 + Notice 刷屏）。仅当当前选区就是刚拖的那条时才清，不动用户其它选区。
      try {
        const win2 = typeof activeWindow !== "undefined" ? activeWindow : window;
        const s = win2.getSelection();
        if (s && s.rangeCount > 0 && info.text &&
            s.toString().replace(/\s+/g, " ").trim() === info.text) {
          s.removeAllRanges();
        }
      } catch (_) { /* noop */ }
      this._chipSig = null;
    });
  },

  hideChip() {
    if (this.chipEl) {
      this.chipEl.remove();
      this.chipEl = null;
    }
  },

  /* ==================== Canvas：尺寸适配 + 摘录文档同步 ==================== */

  /**
   * v0.5.0 即时通道：drop 后轮询内存 canvas 数据（60ms 间隔，最多 1.2s），
   * 新 ^ex 卡一出现立即做父子判定，命中则 setData + requestSave（毫秒级，绕过磁盘往返）。
   * 失败/超时/没压中卡 → 什么都不做，文件层管线（250ms + 出生重试）自然兜底。
   */
  async instantAttach(canvasObj) {
    const before = new Set(((canvasObj.getData() || {}).nodes || []).map((n) => n.id));
    const t0 = Date.now();
    while (Date.now() - t0 < 1200) {
      await new Promise((r) => setTimeout(r, 60));
      let data;
      try { data = canvasObj.getData(); } catch (_) { return; }
      const nodes = (data && data.nodes) || [];
      const nn = nodes.find((n) => !before.has(n.id) && n.type === "text" && n.text && EX_ID_RE.test(n.text));
      if (!nn) continue;
      const others = nodes.filter((n) => n.id !== nn.id && n.type !== "group");
      const hit = lmbPickDropParent(nn, others);
      if (!hit) return; // 没压到卡 → 交给文件层（含出生重试）
      const parent = hit.node;
      if (!Array.isArray(data.edges)) data.edges = [];
      const path2 = canvasObj.view && canvasObj.view.file ? canvasObj.view.file.path : null;
      const sidecar0 = (path2 && this.autoEdges.get(path2)) || new Set();
      const plan = lmbPlanAutoLink(nn, parent, data.edges, sidecar0);
      if (plan.op === "create") {
        const kidsBySide = lmbGroupBySide(parent, nodes, data.edges);
        const group = [...(kidsBySide.get(plan.side) || []), nn];
        lmbLayoutGroup(parent, group, plan.side, 30);
        const ends = lmbSideEnds(plan.side);
        const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        data.edges.push({
          id: eid, fromNode: parent.id, toNode: nn.id,
          fromSide: ends.fromSide, toSide: ends.toSide
        });
        // v0.11.0 修复：即时通道建的边此前漏登记 sidecar → 文件层不认账（当作手动边），
        //   首连锁定 / 自动边清理全都失明。现在建边即登记。
        if (path2) {
          const ae = this.autoEdges.get(path2) || new Set();
          ae.add(eid);
          this.autoEdges.set(path2, ae);
        }
        canvasObj.setData(data);
        canvasObj.requestSave();
        this._instantSkip = Date.now() + 4000; // 抑制文件层自动父子，防双写
        this.debugNotice("✓ 已自动挂到父卡（组居中，" + group.length + "卡）");
      }
      // reside/skip：新落下的卡不该有旧连线；万一出现，交给文件层兜底
      return;
    }
    // 1.2s 内没等到新卡 → 文件层兜底
  },

  /**
   * v0.9.3 即时通道（移动已有卡）：canvas 内 mouseup 后直接在「内存 canvas 数据」上做
   * 移动检测 + 父子判定 + 组排布，不再等 Obsidian 把画布落盘（save 防抖可达 1s+）
   * → 文件层 80/400ms。修复「拖到另一张卡上好一会才连线对齐」。
   *   - 只处理「档案里已见过 + 位置变了」的卡；新落下的 ^ex 卡归 instantAttach / 文件层管（防双写）；
   *   - 命中父卡 → 换父摘旧自动边 → lmbLayoutGroup → setData + requestSave（毫秒级生效），
   *     并同步位置档案，防文件层把同一批移动再处理一遍；
   *   - 没压到卡 / API 不可用 → 静默返回，文件层管线自然兜底。
   */
  async instantMoveAttach(canvasObj) {
    const file = canvasObj && canvasObj.view && canvasObj.view.file;
    const path = file && file.path;
    if (!path) return;
    const lastPos = this.canvasPositions && this.canvasPositions.get(path);
    if (!lastPos || !lastPos.size) return; // 首见画布 → 交给文件层建档
    const t0 = Date.now();
    while (Date.now() - t0 < 500) {
      let data;
      try { data = canvasObj.getData(); } catch (_) { return; }
      const nodes = (data && data.nodes) || [];
      // 只认「见过 + 位置变了」的卡（新卡不在档案里 → 跳过）
      const moved = [];
      for (const n of nodes) {
        if (n.type === "group") continue;
        const prev = lastPos.get(n.id);
        if (prev && (prev.x !== n.x || prev.y !== n.y)) moved.push(n);
      }
      if (!moved.length) {
        await new Promise((r) => setTimeout(r, 80)); // 拖拽终态可能还没提交进 canvas 内存数据
        continue;
      }
      let changed = false;
      for (const nn of moved) {
        const others = nodes.filter((n) => n.id !== nn.id && n.type !== "group");
        const hit = lmbPickDropParent(nn, others);
        if (!hit) continue;
        const parent = hit.node;
        if (!Array.isArray(data.edges)) data.edges = [];
        const sidecar = this.autoEdges.get(path) || new Set();
        // v0.11.0：首连锁定 + 改挂侧（取代 v0.7.3 换父）
        const plan = lmbPlanAutoLink(nn, parent, data.edges, sidecar);
        if (plan.op === "skip") continue;
        if (plan.op === "reside") {
          // R4：拖回已连线的卡上 → 按落点方位改挂侧 + 两侧组重排（同侧 = 重新对齐）
          const r = lmbApplyReside(parent, nn, plan, nodes, data.edges);
          changed = true;
          console.log("[lmb] 即时通道（改挂侧）: ", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
            "(" + plan.oldSide + "→" + r.side + ")");
          continue;
        }
        const kidsBySide = lmbGroupBySide(parent, nodes, data.edges);
        const group = [...(kidsBySide.get(plan.side) || []), nn];
        lmbLayoutGroup(parent, group, plan.side, 30);
        const ends = lmbSideEnds(plan.side);
        const eid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        data.edges.push({
          id: eid, fromNode: parent.id, toNode: nn.id,
          fromSide: ends.fromSide, toSide: ends.toSide
        });
        sidecar.add(eid);
        this.autoEdges.set(path, sidecar);
        changed = true;
        console.log("[lmb] 即时通道（移动）: ", parent.id.slice(0, 8), "->", nn.id.slice(0, 8),
          "(" + ends.fromSide + "→" + ends.toSide + ", 组" + group.length + ")");
      }
      if (changed) {
        try {
          canvasObj.setData(data);
          canvasObj.requestSave();
        } catch (_) { return; }
        // 同步位置档案：文件层下一次 sync 看到的就是「已排布后」的位置 → 不再重复处理
        const cur = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, width: n.width || 0, height: n.height || 0 }]));
        this.canvasPositions.set(path, cur);
        this._instantSkip = Date.now() + 4000;
        if (typeof this.persistAutoSizeSoon === "function") this.persistAutoSizeSoon();
        this.debugNotice("✓ 已自动挂到父卡（组居中）");
      }
      return;
    }
    // 500ms 内没检测到移动 → 文件层兜底
  },

});
