/* 35-plugin-marks —— PDF 回绘标记/颜色语义（原型混入，运行时与类内声明等价；由 build.js 拼回 main.js） */

Object.assign(LuciasMarginBookPlugin.prototype, {

  /* ==================== P2：回绘层 ====================
   * 在 PDF 页面上把「已摘录」的段落标出来，让"哪里摘过"一眼可见。
   *
   * P0 的三条实测结论直接决定了这里的写法：
   *   ① span 索引与缩放无关、textLayer 重建后不变 → 可以放心用索引定位
   *   ② 25 页里只有 3 页有 textLayer（pdf.js 虚拟化）→ 必须靠 MutationObserver 驱动重画
   *   ③ resolveSelectionRects 往返误差 < 6px → 逆运算可用
   *
   * 定位方式：百分比 + .page 相对定位。覆盖层随页面缩放自动跟随，
   *           完全不需要监听 zoom 事件重算。
   *
   * 降级原则（比 PDF Flow 好）：宁可画得不准，也绝不什么都不画。
   *   PDF Flow 在 span 对不上时静默返回 null，高亮直接消失；
   *   我们改画页顶灰色细条并打 data-fallback="1"。
   * ===================================================================== */

  /** 页面矩形 → 相对 .page 的百分比（随缩放自动跟随） */
  lmbRectsToPercents(rects, pageEl) {
    const pr = pageEl.getBoundingClientRect();
    if (!pr.width || !pr.height) return null;
    return rects.map((cr) => ({
      left: 100 * (cr.left - pr.left) / pr.width,
      top: 100 * (cr.top - pr.top) / pr.height,
      width: 100 * cr.width / pr.width,
      height: 100 * cr.height / pr.height
    }));
  },

  /**
   * 选区参数 → 页面内矩形数组。这是 buildSelectionParams 的**逆运算**。
   * 口径必须与正向一致：divs = .textLayer 的**直接子元素**。
   * 失败返回 null（由调用方走降级）。
   */
  lmbResolveSelectionRects(pageEl, selection) {
    try {
      if (!pageEl || !selection || selection.length !== 4) return null;
      const layer = pageEl.querySelector(".textLayer");
      if (!layer) return null;
      const divs = Array.from(layer.children);
      if (!divs.length) return null;

      const locate = (idx, off) => {
        const div = divs[idx];
        if (!div) return null;
        const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
        let acc = 0, n;
        while ((n = w.nextNode())) {
          const len = n.textContent ? n.textContent.length : 0;
          if (acc + len >= off) return { node: n, offset: off - acc };
          acc += len;
        }
        // 偏移超出该 span 长度 → 退到 span 末尾（不返回 null，尽量画出来）
        const last = div.lastChild && div.lastChild.nodeType === 3 ? div.lastChild : div;
        return { node: last, offset: (last.textContent || "").length };
      };

      const s = locate(selection[0], selection[1]);
      const e = locate(selection[2], selection[3]);
      if (!s || !e) return null;
      const r = document.createRange();
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
      const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0.5 && x.height > 0.5);
      return rects.length ? rects : null;
    } catch (_) { return null; }
  },

  /** #rrggbb → rgba()，失败返回 null */
  lmbHexToRgba(hex, alpha) {
    const h = String(hex || "").replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  },

  /**
   * 标记颜色：优先用 colorMap 反查（tag → hex）。
   * parseColorMap 给的是 hex → tag，这里倒过来查。
   * 没映射就用默认柔和黄。
   */
  lmbMarkColor(entry) {
    try {
      const raw = this.settings && this.settings.colorMap;
      if (raw && entry && entry.tags && entry.tags.length) {
        const map = this.parseColorMap(raw);
        for (const [hex, tag] of map.entries()) {
          if (entry.tags.indexOf(tag) >= 0) {
            const c = this.lmbHexToRgba("#" + hex, 0.42);
            if (c) return c;
          }
        }
      }
    } catch (_) { /* 解析失败 → 默认色 */ }
    return "rgba(255, 226, 120, 0.40)";
  },

  /** 画单条摘录的标记（跨行会有多个矩形，每个矩形一个 div） */
  lmbDrawEntryMark(pageEl, entry) {
    try {
      let pcts = null;
      if (entry && entry.selection) {
        const rects = this.lmbResolveSelectionRects(pageEl, entry.selection);
        if (rects) pcts = this.lmbRectsToPercents(rects, pageEl);
      } else if (entry && entry.rect && entry.rect.length === 4) {
        // 截图摘录：rect 就是页面百分比，直接用——不需要 textLayer，
        // 虚拟化（未渲染）的页也能画。这是"截图摘录在 PDF 里没标记"的修复。
        const [l, t, w, h] = entry.rect;
        if (w > 0 && h > 0) pcts = [{ left: l, top: t, width: w, height: h }];
      }

      const frag = document.createDocumentFragment();
      if (pcts && pcts.length) {
        const bg = this.lmbMarkColor(entry);
        for (const p of pcts) {
          const d = document.createElement("div");
          d.className = "lmb-mark";
          if (entry.exId) d.setAttribute("data-ex", entry.exId);
          // 反向跳转（P3 双击）需要知道来源摘录文档
          if (entry.sourceMd) d.setAttribute("data-src", entry.sourceMd);
          if (entry.tags && entry.tags.length) d.setAttribute("data-tag", entry.tags.join(" "));
          d.style.left = p.left + "%";
          d.style.top = p.top + "%";
          d.style.width = p.width + "%";
          d.style.height = p.height + "%";
          d.style.background = bg;
          frag.appendChild(d);
        }
      } else {
        // 降级：缺坐标或 span 对不上 → 页顶细条（绝不静默消失）
        const bar = document.createElement("div");
        bar.className = "lmb-mark";
        bar.setAttribute("data-fallback", "1");
        if (entry && entry.exId) bar.setAttribute("data-ex", entry.exId);
        if (entry && entry.sourceMd) bar.setAttribute("data-src", entry.sourceMd);
        bar.style.background = "rgba(140,140,140,0.55)";
        bar.title = "此处有摘录，但无法精确定位（缺 selection 或文本层对不上）";
        frag.appendChild(bar);
      }
      pageEl.appendChild(frag);
    } catch (_) { /* 单条失败不影响其他条 */ }
  },

  /** 性能守卫：摘录很多时只画视口附近的页 */
  lmbPageNearViewport(pageEl) {
    try {
      const r = pageEl.getBoundingClientRect();
      const h = window.innerHeight || 800;
      return r.bottom > -2 * h && r.top < 3 * h;
    } catch (_) { return true; }
  },

  /** 清掉一个容器内的全部标记 */
  lmbClearMarks(containerEl) {
    try {
      if (!containerEl) return;
      const marks = containerEl.querySelectorAll(".lmb-mark");
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        if (m.parentNode) m.parentNode.removeChild(m);
      }
    } catch (_) { /* noop */ }
  },

  /** 画一个 PDF 视图的全部标记 */
  lmbDrawMarksForView(view) {
    try {
      if (!view || !view.containerEl) return;
      const container = view.containerEl;
      this.lmbClearMarks(container);

      const file = view.file;
      if (!file) return;
      const entries = this.getExcerptsForPdf(file.path);
      if (!entries || !entries.length) { this.lmbDisconnectObserver(view); return; }

      const pages = container.querySelectorAll("div.page");
      if (!pages.length) return;   // 还没渲染（僵尸 leaf / 刚打开）→ 等 observer 触发

      const guard = entries.length > 200;   // 性能守卫

      for (let i = 0; i < pages.length; i++) {
        const pageEl = pages[i];
        const num = parseInt(pageEl.getAttribute("data-page-number") || "", 10);
        if (!num) continue;
        // 虚拟化的页没有文本层，等它进入视口后 observer 会重画
        if (!pageEl.querySelector(".textLayer")) continue;
        if (guard && !this.lmbPageNearViewport(pageEl)) continue;
        const list = entries.filter((e) => e.page === num);
        for (const e of list) this.lmbDrawEntryMark(pageEl, e);
      }
      this.lmbSetupObserver(view);
    } catch (err) {
      console.warn("[lmb] lmbDrawMarksForView error:", err);
    }
  },

  /**
   * 挂 MutationObserver 驱动重画。
   * pdf.js 虚拟化会不断增删 .page / .textLayer，所以必须盯着。
   * **关键**：要过滤掉我们自己造成的变动（append .lmb-mark），否则无限重画。
   */
  lmbSetupObserver(view) {
    try {
      if (!view || !view.containerEl || view._ppdMarkObserver) return;
      const target = view.containerEl.querySelector(".pdfViewer") || view.containerEl;
      if (!target) return;
      const isOwn = (n) => n && n.nodeType === 1 && n.classList && n.classList.contains("lmb-mark");
      let timer = null;
      const ob = new MutationObserver((records) => {
        let relevant = false;
        for (const rec of records) {
          const scan = (list) => {
            for (let i = 0; i < list.length; i++) {
              const n = list[i];
              if (n.nodeType === 3) return true;                 // 文本节点（textLayer 填字）
              if (n.nodeType === 1 && !isOwn(n)) return true;    // 非我们自己的元素
            }
            return false;
          };
          if (scan(rec.addedNodes) || scan(rec.removedNodes)) { relevant = true; break; }
        }
        if (!relevant) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          try {
            if (view && view.containerEl && view.containerEl.isConnected) {
              this.lmbDrawMarksForView(view);
            }
          } catch (_) { /* noop */ }
        }, 150);
      });
      ob.observe(target, { childList: true, subtree: true });
      view._ppdMarkObserver = ob;

      // P3：双击标记区域 → 跳回摘录（单击/划选完全不受影响，标记仍是 pointer-events:none）
      if (!target._ppdMarkDblClick) {
        const handler = (ev) => {
          try {
            const t = ev.target;
            if (!t || !t.closest) return;
            const pageEl = t.closest("div.page");
            if (!pageEl) return;
            const x = ev.clientX, y = ev.clientY;
            const marks = pageEl.querySelectorAll(".lmb-mark");
            for (let i = marks.length - 1; i >= 0; i--) {   // 从最上层往下找
              const m = marks[i];
              const r = m.getBoundingClientRect();
              if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                const exId = m.getAttribute("data-ex");
                const src = m.getAttribute("data-src");
                if (exId) { ev.preventDefault(); this.lmbOpenExcerptAt(exId, src); }
                return;
              }
            }
          } catch (err) {
            console.warn("[lmb] 双击标记跳转出错:", err);
          }
        };
        target.addEventListener("dblclick", handler);
        target._ppdMarkDblClick = handler;
        this._ppdDblClickTargets = this._ppdDblClickTargets || [];
        this._ppdDblClickTargets.push(target);
      }
    } catch (_) { /* noop */ }
  },

  lmbDisconnectObserver(view) {
    try {
      if (view && view._ppdMarkObserver) {
        view._ppdMarkObserver.disconnect();
        view._ppdMarkObserver = null;
      }
      if (view && view._ppdMarkTimer) {
        clearTimeout(view._ppdMarkTimer);
        view._ppdMarkTimer = null;
      }
    } catch (_) { /* noop */ }
  },

  /** 全量刷新所有 PDF 视图的标记 */
  lmbRefreshAllMarks() {
    try {
      const leaves = this.app.workspace.getLeavesOfType("pdf");
      for (const l of leaves) {
        const v = l && l.view;
        if (v && v.containerEl) this.lmbDrawMarksForView(v);
      }
    } catch (err) {
      console.warn("[lmb] lmbRefreshAllMarks error:", err);
    }
  },

  /** 防抖刷新（布局变化 / 切标签 / 索引更新都走这里） */
  lmbScheduleMarksRefresh(delay) {
    try {
      if (this._ppdMarksTimer) clearTimeout(this._ppdMarksTimer);
      this._ppdMarksTimer = setTimeout(() => {
        this._ppdMarksTimer = null;
        this.lmbRefreshAllMarks();
      }, delay == null ? 200 : delay);
    } catch (_) { /* noop */ }
  },

  /**
   * P1-5：探测选区命中的高亮背景色 → 按 settings.colorMap 映射为标签名。
   * 探测不到 / 未配置 / 未命中一律返回 null（与现状行为一致，静默跳过）。
   */
  detectColorTag(anchorEl, pageEl) {
    try {
      const rawMap = this.settings && this.settings.colorMap;
      if (!rawMap) return null;
      const map = this.parseColorMap(rawMap);
      if (!map.size) return null;
      const colors = this.collectHighlightColors(anchorEl, pageEl);
      for (const hex of colors) {
        const tag = map.get(hex);
        if (tag) {
          console.log("[lmb] colorTag hit:", hex, "->", tag);
          return tag;
        }
      }
      return null;
    } catch (err) {
      console.warn("[lmb] detectColorTag error:", err);
      return null;
    }
  },

  /** 解析「颜色语义映射」textarea：每行 rrgggbb=标签名，忽略空行/错行/#前缀/大小写 */
  parseColorMap(raw) {
    const map = new Map();
    try {
      for (const lineRaw of String(raw || "").split("\n")) {
        const line = lineRaw.trim();
        if (!line) continue; // Bugfix: 不再把 # 开头当注释——key 侧本就允许 # 前缀（如 "#fff3a3=核心观点"），两者曾自相矛盾
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim().replace(/^#/, "").toLowerCase();
        const tag = line.slice(eq + 1).trim();
        if (!/^[0-9a-f]{6}$/.test(key) || !tag) continue;
        map.set(key, tag);
      }
    } catch (_) { /* noop：解析失败按空映射 */ }
    return map;
  },

  /**
   * 收集选区可能命中的高亮背景色（归一化 #rrggbb，小写，按优先顺序）：
   * ① anchorEl 向上到 pageEl 的祖先链（万一某些版本把高亮画在 textLayer DOM 内）；
   * ② 主路径：同页 .annotationLayer 里与选区矩形相交的注释 section
   *    （及其内部 quad div），pdf.js 用内联 background-color 渲染高亮注释
   *    （PDF++ 高亮走的就是 pdf.js 标准 annotationLayer：
   *    .annotationLayer > section:not(.linkAnnotation)——高亮不在 textLayer。）
   */
  collectHighlightColors(anchorEl, pageEl) {
    const out = [];
    const seen = new Set();
    const add = (el) => {
      try {
        if (!el || el.nodeType !== 1) return;
        const win = el.ownerDocument && el.ownerDocument.defaultView;
        if (!win || !win.getComputedStyle) return;
        const hex = this.normalizeColor(win.getComputedStyle(el).backgroundColor);
        if (hex && !seen.has(hex)) { seen.add(hex); out.push(hex); }
      } catch (_) { /* noop */ }
    };
    try {
      let cur = anchorEl;
      while (cur && cur !== pageEl) { add(cur); cur = cur.parentElement; }
    } catch (_) { /* noop */ }
    try {
      const rect = anchorEl.getBoundingClientRect();
      if (rect.width || rect.height) {
        const sections = pageEl.querySelectorAll(".annotationLayer section");
        for (const sec of sections) {
          try {
            const r = sec.getBoundingClientRect();
            const ox = Math.min(rect.right, r.right) - Math.max(rect.left, r.left);
            const oy = Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top);
            if (ox > 2 && oy > 2) {
              add(sec);
              const quads = sec.querySelectorAll("div");
              for (const q of quads) add(q);
            }
          } catch (_) { /* noop */ }
        }
      }
    } catch (_) { /* noop */ }
    return out;
  },

  /**
   * 任意 CSS 颜色字符串 → 6 位 hex（小写）；透明/非法返回 null。
   * 借离屏 canvas 的 fillStyle 归一化能力（rgb/rgba/#hex/颜色名通吃），零依赖。
   */
  normalizeColor(str) {
    try {
      if (!str || str === "transparent") return null;
      if (!this._colorCtx) this._colorCtx = document.createElement("canvas").getContext("2d");
      if (!this._colorCtx) return null;
      this._colorCtx.fillStyle = "#000000";      // 先垫底色，非法值不会覆盖
      this._colorCtx.fillStyle = str;
      const v = this._colorCtx.fillStyle;
      if (typeof v !== "string") return null;
      const m = v.match(/^rgba?\(([^)]+)\)$/i);
      if (m) {
        const p = m[1].split(",").map((s) => parseFloat(s));
        if (p.length < 3) return null;
        if (p.length >= 4 && p[3] <= 0.05) return null;   // 近全透明视为无高亮
        return p.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(n)))
          .toString(16).padStart(2, "0")).join("");
      }
      const m2 = v.match(/^#([0-9a-f]{6})$/i);
      return m2 ? m2[1].toLowerCase() : null;
    } catch (_) {
      return null;
    }
  },

});
