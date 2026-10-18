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
  lmbResolveSelectionRects(pageEl, selection, expectedText, expectedRect) {
    try {
      if (!pageEl || !selection || selection.length !== 4) return null;
      const layer = pageEl.querySelector(".textLayer");
      if (!layer) return null;
      const divs = Array.from(layer.children);
      if (!divs.length) return null;

      const locate = (idx, off) => {
        const div = divs[idx];
        if (!div) return null;
        const w = pageEl.ownerDocument.createTreeWalker(div, 4);
        let acc = 0, n;
        while ((n = w.nextNode())) {
          const len = n.textContent ? n.textContent.length : 0;
          if (acc + len >= off) return { node: n, offset: off - acc };
          acc += len;
        }
        return null; // Invalid offsets must use text lookup, never clamp to another location.
      };

      const s = locate(selection[0], selection[1]);
      const e = locate(selection[2], selection[3]);
      if (!s || !e) return null;
      const r = pageEl.ownerDocument.createRange();
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
      // textLayer 的子元素序号会随 PDF.js 版本、字体解析或文档重载发生漂移。
      // 漂移后的 selection 仍可能构造出合法 Range，但会落在完全无关的文字上；
      // 有 target 时必须核对内容，错误坐标交给文字搜索兜底，不能将错就错。
      const expected = this._lmbNormalizePdfMatchText(expectedText);
      const actual = this._lmbNormalizePdfMatchText(r.toString());
      if (expected && actual !== expected
        && !(expected.length >= 160 && actual.startsWith(expected))) return null;
      const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0.5 && x.height > 0.5);
      if (rects.length && expectedRect && expectedRect.length === 4) {
        const pr = pageEl.getBoundingClientRect();
        const left = Math.min(...rects.map((x) => x.left));
        const top = Math.min(...rects.map((x) => x.top));
        const right = Math.max(...rects.map((x) => x.right));
        const bottom = Math.max(...rects.map((x) => x.bottom));
        const actualX = 100 * ((left + right) / 2 - pr.left) / pr.width;
        const actualY = 100 * ((top + bottom) / 2 - pr.top) / pr.height;
        const savedX = Number(expectedRect[0]) + Number(expectedRect[2]) / 2;
        const savedY = Number(expectedRect[1]) + Number(expectedRect[3]) / 2;
        // 同一短语可能在一页出现多次，仅文字一致仍不足以证明身份；
        // 保存时的页面百分比位置相差过大，也必须判定 selection 已漂移。
        if (pr.width && pr.height && (Math.abs(actualX - savedX) > 8 || Math.abs(actualY - savedY) > 8)) return null;
      }
      return rects.length ? rects : null;
    } catch (_) { return null; }
  },

  _lmbNormalizePdfMatchText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  },

  /** 在 textLayer 中查找文字，并保留归一化字符到真实文本节点偏移的映射。 */
  _lmbFindPdfTextMatch(layer, text, hintRect, pageEl) {
    try {
      let needle = this._lmbNormalizePdfMatchText(text);
      if (!layer || !needle) return null;
      const doc = layer.ownerDocument;
      let haystack = "";
      let positions = [];
      const appendSpace = (node, offset) => {
        if (haystack && haystack.charAt(haystack.length - 1) !== " ") {
          haystack += " "; positions.push({ node, offset });
        }
      };
      for (const div of Array.from(layer.children || [])) {
        const walker = doc.createTreeWalker(div, 4); // NodeFilter.SHOW_TEXT
        const nodes = []; let node;
        while ((node = walker.nextNode())) nodes.push(node);
        if (!nodes.length) continue;
        appendSpace(nodes[0], 0);
        for (const textNode of nodes) {
          const raw = String(textNode.textContent || "");
          for (let i = 0; i < raw.length; i++) {
            if (/\s/.test(raw.charAt(i))) appendSpace(textNode, i);
            else { haystack += raw.charAt(i).toLowerCase(); positions.push({ node: textNode, offset: i }); }
          }
        }
      }
      let index = haystack.indexOf(needle);
      if (index < 0) {
        // Some PDF.js versions split words into individual text-layer spans.
        // The separator above must not turn “models” into “m o d e l s”.
        let compact = ""; const mapped = [];
        for (let i = 0; i < haystack.length; i++) {
          if (!/\s/.test(haystack[i])) { compact += haystack[i]; mapped.push(positions[i]); }
        }
        haystack = compact; positions = mapped; needle = needle.replace(/\s/g, "");
        index = haystack.indexOf(needle);
        if (index < 0) return null;
      }
      let best = null, bestDistance = Infinity;
      while (index >= 0) {
        const start = positions[index], last = positions[index + needle.length - 1];
        const candidate = start && last ? { start, end: { node: last.node, offset: last.offset + 1 } } : null;
        if (candidate && hintRect && hintRect.length === 4 && pageEl && doc.createRange) {
          const range = doc.createRange();
          range.setStart(candidate.start.node, candidate.start.offset);
          range.setEnd(candidate.end.node, candidate.end.offset);
          const rr = range.getBoundingClientRect();
          const pr = pageEl.getBoundingClientRect();
          const x = pr.width ? 100 * ((rr.left + rr.right) / 2 - pr.left) / pr.width : 0;
          const y = pr.height ? 100 * ((rr.top + rr.bottom) / 2 - pr.top) / pr.height : 0;
          const hx = Number(hintRect[0]) + Number(hintRect[2]) / 2;
          const hy = Number(hintRect[1]) + Number(hintRect[3]) / 2;
          const distance = (x - hx) * (x - hx) + (y - hy) * (y - hy);
          if (distance < bestDistance) { best = candidate; bestDistance = distance; }
        } else if (candidate) return candidate;
        index = haystack.indexOf(needle, index + 1);
      }
      return best;
    } catch (_) { return null; }
  },

  /** 旧摘录没有 rect 或 selection 已漂移时，按摘录文字在当前文本层中兜底定位。 */
  lmbResolveEntryTextRects(pageEl, text, hintRect) {
    try {
      const layer = pageEl && pageEl.querySelector(".textLayer");
      const target = String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
      if (!layer || target.length < 2) return null;
      const match = this._lmbFindPdfTextMatch(layer, target, hintRect, pageEl);
      if (!match) return null;
      const range = pageEl.ownerDocument.createRange();
      range.setStart(match.start.node, match.start.offset);
      range.setEnd(match.end.node, match.end.offset);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > .5 && r.height > .5);
      return rects.length ? rects : null;
    } catch (_) {}
    return null;
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
      const explicit = entry && entry.exId && this.settings && this.settings.excerptColors && this.settings.excerptColors[entry.exId];
      const direct = this.lmbHexToRgba(explicit, 0.42);
      if (direct) return direct;
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
  lmbDrawEntryMark(pageEl, entry, destination) {
    if (entry && (entry.pageNote || entry.inkNote)) return;
    try {
      let pcts = null;
      if (entry && entry.selection) {
        const rects = this.lmbResolveSelectionRects(pageEl, entry.selection, entry.target || "", entry.rect);
        if (rects) pcts = this.lmbRectsToPercents(rects, pageEl);
      }
      if (!pcts && entry && (entry.target || entry.text)) {
        const textRects = this.lmbResolveEntryTextRects(pageEl, entry.target || entry.text, entry.rect);
        if (textRects) pcts = this.lmbRectsToPercents(textRects, pageEl);
      }
      // 文字 selection 索引因 PDF 文本层版本变化失效时，优先使用摘录时保存的
      // 页面百分比矩形，不再画到页面左上角的降级细条。
      if (!pcts && entry && entry.rect && entry.rect.length === 4) {
        // 截图摘录：rect 就是页面百分比，直接用——不需要 textLayer，
        // 虚拟化（未渲染）的页也能画。这是"截图摘录在 PDF 里没标记"的修复。
        const [l, t, w, h] = entry.rect;
        if (w > 0 && h > 0) pcts = [{ left: l, top: t, width: w, height: h }];
      }

      const frag = document.createDocumentFragment();
      if (pcts && pcts.length) {
        const bg = this.lmbMarkColor(entry);
        for (let pi = 0; pi < pcts.length; pi++) {
          const p = pcts[pi];
          const d = document.createElement("div");
          d.className = "lmb-mark";
          // 只有“纯图片摘录”才允许使用区域边框。文字摘录即使自动附带了截图，
          // 仍必须按文字语义显示为荧光笔底色，不能误判成图片后画虚线框。
          const entryText = String(entry && entry.text || "").trim();
          const imageOnly = !!(entry && entry.imagePath
            && (!entryText || /^（(?:矩形图像选区|图片摘录|图片)）$/.test(entryText)));
          const imageMark = !!(imageOnly && (!this.settings || this.settings.imageExcerptMarkStyle !== "highlight"));
          if (imageMark) d.classList.add("lmb-mark-image");
          if (pi === 0 && entry.pageOrdinal) d.setAttribute("data-no", String(entry.pageOrdinal));
          if (entry.exId) d.setAttribute("data-ex", entry.exId);
          // 反向跳转（P3 双击）需要知道来源摘录文档
          if (entry.sourceMd) d.setAttribute("data-src", entry.sourceMd);
          if (entry.tags && entry.tags.length) d.setAttribute("data-tag", entry.tags.join(" "));
          d.style.left = p.left + "%";
          d.style.top = p.top + "%";
          d.style.width = p.width + "%";
          d.style.height = p.height + "%";
          d.style.background = imageMark ? "transparent" : bg;
          if (imageMark) d.style.borderColor = this.lmbHexToRgba((this.settings && this.settings.excerptColors && this.settings.excerptColors[entry.exId]) || "#65c692", 0.95) || "rgba(101,198,146,.95)";
          frag.appendChild(d);
        }
      } else {
        // 降级：缺坐标或 span 对不上 → 页顶细条（绝不静默消失）
        const bar = document.createElement("div");
        bar.className = "lmb-mark";
        bar.setAttribute("data-fallback", "1");
        if (entry && entry.exId) bar.setAttribute("data-ex", entry.exId);
        if (entry && entry.pageOrdinal) bar.setAttribute("data-no", String(entry.pageOrdinal));
        if (entry && entry.sourceMd) bar.setAttribute("data-src", entry.sourceMd);
        bar.style.background = "rgba(140,140,140,0.55)";
        bar.title = "此处有摘录，但无法精确定位（缺 selection 或文本层对不上）";
        frag.appendChild(bar);
      }
      (destination || pageEl).appendChild(frag);
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
      const pages = containerEl.querySelectorAll("div.page");
      for (let i = 0; i < pages.length; i++) delete pages[i]._lmbMarkSignature;
    } catch (_) { /* noop */ }
  },

  /** 画一个 PDF 视图的全部标记 */
  lmbDrawMarksForView(view) {
    try {
      if (!view || !view.containerEl) return;
      const container = view.containerEl;

      const file = view.file;
      if (!file) return;
      // v0.12.0 根因修复：「有时显示/不显示/延迟显示」的根子在这里——
      //   旧版把 lmbSetupObserver 放在函数最末，而「页面还没渲染」（pages.length===0）
      //   会提前 return → Observer 从未挂上 → 之后 pdf.js 渲染出页面也没人触发重画，
      //   只能等下一次 layout-change / 切标签碰运气补画。
      //   现在只要有文件就先挂 Observer（幂等），页面渲染/虚拟化的瞬间都会自动重画。
      this.lmbSetupObserver(view);
      const entries = this._lmbGetPdfSidebarEntries ? this._lmbGetPdfSidebarEntries(file) : this.getExcerptsForPdf(file.path);
      if (!entries || !entries.length) { this.lmbClearMarks(container); this.lmbDisconnectObserver(view); return; }

      const pages = container.querySelectorAll("div.page");
      if (!pages.length) return;   // 还没渲染（僵尸 leaf / 刚打开）→ Observer 已挂，渲染瞬间自动重画

      const guard = entries.length > 200;   // 性能守卫
      const byPage = new Map();
      for (const entry of entries) {
        const page = Number(entry && entry.page);
        if (!page) continue;
        if (!byPage.has(page)) byPage.set(page, []);
        byPage.get(page).push(entry);
      }

      for (let i = 0; i < pages.length; i++) {
        const pageEl = pages[i];
        const num = parseInt(pageEl.getAttribute("data-page-number") || "", 10);
        if (!num) continue;
        if (guard && !this.lmbPageNearViewport(pageEl)) continue;
        const list = byPage.get(num) || [];
        // v0.16.5 修复 R2：旧版在循环开头无条件要求 .textLayer，把**不依赖文本层**
        //   的截图摘录（rect 条目）一起挡掉了 —— 与 lmbDrawEntryMark「rect 是页面
        //   百分比，虚拟化（未渲染文本层）的页也能画」的实现承诺自相矛盾。
        //   现在按条目类型分流：rect 条目只要 .page 在就画；selection 条目才要求文本层
        //   （虚拟化页没有文本层时跳过，等它进入视口、observer 触发后自然重画）。
        const textLayer = pageEl.querySelector(".textLayer"), hasLayer = !!textLayer;
        const signature = JSON.stringify([
          pageEl.clientWidth || 0, pageEl.clientHeight || 0,
          textLayer && textLayer.childElementCount || 0,
          this.settings && this.settings.imageExcerptMarkStyle,
          list.map((e) => [e.exId, e.selection, e.rect, e.target, e.color,
            this.settings && this.settings.excerptColors && this.settings.excerptColors[e.exId]])
        ]);
        if (pageEl._lmbMarkSignature === signature
          && (!list.length || pageEl.querySelector(".lmb-mark"))) continue;
        const oldMarks = pageEl.querySelectorAll(".lmb-mark");
        // Measure all excerpts before changing the page DOM to avoid repeated layouts.
        const nextMarks = pageEl.ownerDocument.createDocumentFragment();
        for (let ei = 0; ei < list.length; ei++) {
          const e = Object.assign({}, list[ei], { pageOrdinal: ei + 1 });
          if (e.pageNote) continue; // Page notes have their own text block, no excerpt highlight/fallback mark.
          const rectOnly = !!(e.rect && e.rect.length === 4 && e.rect[2] > 0 && e.rect[3] > 0);
          if (!hasLayer && !rectOnly) continue;
          this.lmbDrawEntryMark(pageEl, e, nextMarks);
        }
        for (let mi = 0; mi < oldMarks.length; mi++) oldMarks[mi].remove();
        pageEl.appendChild(nextMarks);
        pageEl._lmbMarkSignature = signature;
      }
      // v0.12.0：Observer 已在函数开头挂过（幂等），这里不再重复
      for (const leaf of this.app.workspace.getLeavesOfType("pdf") || []) {
        if (leaf._lmbSelectedExcerpt && leaf.view === view) this.lmbSyncPdfNoteSelection(leaf);
      }
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
      const target = LmbPdfAdapter.viewer(view);
      if (!target) return;
      /* v0.16.6 P1-6：防抖 timer 必须挂在 view 上，**不能**用闭包局部变量。
       *   lmbDisconnectObserver 清的是 view._ppdMarkTimer —— 若 timer 只是闭包变量，
       *   那段清理就是永远够不到的死代码：disconnect 之后 pending 的回调照样落地，
       *   调 lmbDrawMarksForView → 184 行又把 observer 挂回来（自我复活）；
       *   插件已卸载时同样会复活一个没人能回收的 observer。 */
      view._ppdMarkTimer = null;
      const ob = new MutationObserver((records) => {
        let relevant = false;
        for (const rec of records) {
          const scan = (list) => {
            for (let i = 0; i < list.length; i++) {
              const n = list[i];
              if (LmbPdfAdapter.isRelevantMutation(n)) return true;
            }
            return false;
          };
          if (scan(rec.addedNodes) || scan(rec.removedNodes)) { relevant = true; break; }
        }
        if (!relevant) return;
        if (view._ppdMarkTimer) clearTimeout(view._ppdMarkTimer);
        view._ppdMarkTimer = setTimeout(() => {
          view._ppdMarkTimer = null;
          // v0.16.6：已被 disconnect（无摘录的 PDF / 插件卸载）→ 不再自我复活
          if (!view._ppdMarkObserver) return;
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
