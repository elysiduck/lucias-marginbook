/**
 * P0 实测 · v7 —— 收尾：内层 pdfViewer 缩放 API + TEST A + 逆运算往返验证
 * =====================================================================
 * v6 结论：
 *   ✅ TEST B PASS：textLayer 销毁重建后 span 索引完全一致（最大风险解除）
 *   🔍 viewer.pdfViewer 是 Obsidian 的【应用级包装器】，不是 pdf.js PDFViewer
 *      真正的 PDFViewer 在 viewer.pdfViewer.pdfViewer（嵌套多一层）
 *      外层有 zoomIn / zoomOut 函数、pagesCount=25
 *
 * v7 目标：
 *   Step 3  确认内层 viewer.pdfViewer.pdfViewer.currentScaleValue 可用
 *   Step 4  TEST A 五档缩放稳定性
 *   Step 5  逆运算 resolveSelectionRects 往返验证（P2 核心算法提前验）
 *
 * 操作：Ctrl+Shift+I → Console → 全选粘贴 → 回车
 * 副作用：新开 PDF 标签页 + 滚动 + 切缩放，跑完 detach
 */
(async function P0_DIAG_V7() {
  const L = (...a) => console.log("[P0v7]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { ok: false, steps: {} };
  console.clear();
  L("========== P0 v7（内层 pdfViewer + TEST A + 逆运算验证）==========");
  const app = window.app;

  /* ===== 1) 开 PDF ===== */
  const pdfFiles = app.vault.getFiles().filter((f) => f.extension === "pdf" && f.stat.size > 50000);
  if (!pdfFiles.length) { L("❌ 没找到 >50KB 的 PDF"); return; }
  const pdfFile = pdfFiles[0];
  L("PDF:", pdfFile.path);
  let leaf = null;
  try { leaf = app.workspace.getLeaf(true); await leaf.openFile(pdfFile); }
  catch (e) { L("openFile 失败:", e && e.message); return; }

  /* ===== 2) 等渲染 ===== */
  const view = leaf.view;
  let rendered = false;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const c = view.containerEl;
    if ((c?.querySelectorAll(".textLayer").length || 0) > 0 || !!view.viewer) { rendered = true; break; }
  }
  if (!rendered) { L("❌ 未渲染，终止"); try { leaf.detach(); } catch (e) {} return; }
  await sleep(2000);
  L("渲染 ✅");

  const ce = view.containerEl;
  const viewer = view.viewer ? (typeof view.viewer.then === "function" ? await Promise.race([view.viewer, sleep(8000).then(() => null)]) : view.viewer) : null;
  if (!viewer) { L("❌ 拿不到 viewer"); try { leaf.detach(); } catch (e) {} return; }

  /* ===== 3) 找内层 pdfViewer 与缩放 API ===== */
  L("");
  L("Step 3: 内层 pdfViewer + 缩放 API");
  const outer = viewer.pdfViewer;
  const inner = outer && outer.pdfViewer;
  out.steps.innerFound = !!inner;
  if (!inner) {
    L("❌ viewer.pdfViewer.pdfViewer 不存在");
    out.steps.inner = null;
  } else {
    out.steps.inner = { ctor: inner.constructor?.name, ownPropCount: Object.getOwnPropertyNames(inner).length };
    L("  内层 pdfViewer 找到 ✅  ctor:", inner.constructor?.name, " 自有属性:", out.steps.inner.ownPropCount);
    L("  内层自有属性:", Object.getOwnPropertyNames(inner).slice(0, 45));
    const api = {};
    for (const n of ["currentScaleValue", "currentScale", "pagesCount", "setScale", "zoomIn", "zoomOut", "scrollPageIntoView"]) {
      let v; try { v = inner[n]; } catch (e) { v = undefined; }
      api[n] = { type: typeof v, value: (typeof v === "number" || typeof v === "string") ? v : undefined };
      L("   " + (v !== undefined ? "✅" : "❌") + " inner." + n.padEnd(20), typeof v, "=", (typeof v === "number" || typeof v === "string") ? v : "");
    }
    out.steps.inner.api = api;
  }

  // 缩放句柄：优先内层 currentScaleValue，其次内层 currentScale，最后外层 zoomIn/zoomOut
  let scaleHandle = null, scalePath = null;
  if (inner && inner.currentScaleValue !== undefined) {
    scaleHandle = { get: () => inner.currentScaleValue, set: (v) => { inner.currentScaleValue = v; } };
    scalePath = "viewer.pdfViewer.pdfViewer.currentScaleValue";
  } else if (inner && inner.currentScale !== undefined) {
    scaleHandle = { get: () => inner.currentScale, set: (v) => { inner.currentScale = v; } };
    scalePath = "viewer.pdfViewer.pdfViewer.currentScale";
  }
  out.steps.scalePath = scalePath;
  if (scalePath) L("  🎯 缩放句柄:", scalePath, "当前 =", scaleHandle.get());
  else L("  ⚠️ 内层无 currentScale*，TEST A 改用外层 zoomIn/zoomOut");

  /* ===== 采样工具 ===== */
  const samplePage = (n) => {
    const pg = ce.querySelector('.page[data-page-number="' + n + '"]');
    if (!pg) return null;
    const layer = pg.querySelector(".textLayer");
    if (!layer) return { page: n, hasLayer: false, direct: -1, fp: "" };
    const direct = layer.children.length;
    let fp = "";
    for (let i = 0; i < Math.min(10, direct); i++) fp += (layer.children[i].textContent || "").slice(0, 8) + "|";
    return { page: n, hasLayer: true, direct, fp };
  };
  const firstPageNum = () => {
    const p = ce.querySelector(".page[data-page-number]");
    return p ? p.getAttribute("data-page-number") : null;
  };
  const scrollToPage = async (n, ms) => {
    const pg = ce.querySelector('.page[data-page-number="' + n + '"]');
    if (pg) { try { pg.scrollIntoView({ block: "center" }); } catch (e) { pg.scrollIntoView(); } }
    await sleep(ms || 1200);
  };
  const waitLayer = async (n, maxMs) => {
    const t = Date.now();
    while (Date.now() - t < (maxMs || 7000)) {
      const s = samplePage(n);
      if (s && s.hasLayer && s.direct > 0) return s;
      await sleep(250);
    }
    return samplePage(n);
  };

  const p1 = firstPageNum();
  L("");
  L("样本页: 第", p1, "页");

  /* ===== 4) TEST A 缩放稳定性 ===== */
  L("");
  L("Step 4: TEST A 缩放稳定性");
  await scrollToPage(p1, 1500);
  const results = {};
  let testA = "UNKNOWN";

  if (scaleHandle) {
    const orig = scaleHandle.get();
    for (const sc of ["0.5", "1", "2", "page-fit", "page-width"]) {
      try {
        scaleHandle.set(sc);
        await sleep(700);
        await scrollToPage(p1, 900);
        const s = await waitLayer(p1, 8000);
        results[String(sc)] = s;
        L("   缩放", String(sc).padEnd(10), "→ direct:", s?.direct, " 有层:", s?.hasLayer);
      } catch (e) { L("   缩放", sc, "失败:", e && e.message); results[String(sc)] = null; }
    }
    const valid = Object.entries(results).filter(([, v]) => v && v.hasLayer && v.direct > 0);
    if (valid.length < 2) { testA = "UNKNOWN"; L("  ⚠️ 有效采样不足"); }
    else {
      const base = valid[0][1]; testA = "PASS"; const diffs = [];
      for (let i = 1; i < valid.length; i++) {
        const [sc, s] = valid[i];
        if (s.direct !== base.direct || s.fp !== base.fp) {
          testA = "FAIL";
          diffs.push({ scale: sc, baseDirect: base.direct, nowDirect: s.direct, fpSame: s.fp === base.fp });
        }
      }
      L("   " + (testA === "PASS" ? "✅" : "❌") + " TEST A:", testA, "(基准 direct =", base.direct, ")");
      if (diffs.length) console.table(diffs);
      out.steps.testA = { result: testA, base, diffs, results };
    }
    try { scaleHandle.set(orig); await sleep(400); L("  已还原缩放:", orig); } catch (e) {}
  } else if (outer && typeof outer.zoomIn === "function") {
    // 兜底：用 zoomIn/zoomOut 改变缩放（无法精确设值，但能验证"变缩放索引是否变"）
    L("  用外层 zoomIn/zoomOut 兜底（无法精确设值）");
    const a = await waitLayer(p1, 6000);
    for (let i = 0; i < 4; i++) { try { outer.zoomIn(); } catch (e) {} await sleep(500); }
    await scrollToPage(p1, 1200);
    const b = await waitLayer(p1, 8000);
    for (let i = 0; i < 4; i++) { try { outer.zoomOut(); } catch (e) {} await sleep(500); }
    await scrollToPage(p1, 1200);
    const c = await waitLayer(p1, 8000);
    L("   放大4档后 direct:", b?.direct, " 还原后 direct:", c?.direct);
    testA = (a && b && c && a.direct === b.direct && a.direct === c.direct && a.fp === b.fp && a.fp === c.fp) ? "PASS" : "FAIL";
    L("   " + (testA === "PASS" ? "✅" : "❌") + " TEST A(兜底):", testA);
    out.steps.testA = { result: testA, method: "zoomIn/zoomOut", a, b, c };
  } else {
    L("  ⚠️ 无任何缩放 API，TEST A 跳过");
    out.steps.testA = { skipped: true };
  }

  /* ===== 5) 逆运算往返验证（P2 核心算法提前验）===== */
  L("");
  L("Step 5: 逆运算 resolveSelectionRects 往返验证");
  await scrollToPage(p1, 1500);
  const pgEl = ce.querySelector('.page[data-page-number="' + p1 + '"]');
  const layerEl = pgEl && pgEl.querySelector(".textLayer");
  if (!layerEl) {
    L("  ❌ 第" + p1 + "页没有 textLayer，跳过");
    out.steps.roundTrip = { skipped: true };
  } else {
    const divs = Array.from(layerEl.children);
    // 模拟 buildSelectionParams：选 spans[5] 第2字符 → spans[8] 第4字符
    const S_IDX = 5, S_OFF = 2, E_IDX = 8, E_OFF = 4;
    // 正向：算出"字符串偏移"（buildSelectionParams 用的口径）
    const toStrOffset = (div, charIdx) => {
      // 用 Range 从 div 头到目标字符，量出字符数
      const r = document.createRange();
      r.selectNodeContents(div);
      // 简化：直接截取 textContent 前 charIdx 个字符的长度
      return Math.min(charIdx, (div.textContent || "").length);
    };
    const expectS = toStrOffset(divs[S_IDX], S_OFF);
    const expectE = toStrOffset(divs[E_IDX], E_OFF);

    // 逆运算：locate(idx, off) → {node, offset}
    const locate = (idx, off) => {
      const div = divs[idx]; if (!div) return null;
      const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      let acc = 0, n;
      while ((n = w.nextNode())) {
        const len = n.textContent.length;
        if (acc + len >= off) return { node: n, offset: off - acc };
        acc += len;
      }
      const last = div.lastChild && div.lastChild.nodeType === 3 ? div.lastChild : div;
      return { node: last, offset: (last.textContent || "").length };
    };
    const s = locate(S_IDX, expectS);
    const e = locate(E_IDX, expectE);
    let rects = [];
    if (s && e) {
      try {
        const r = document.createRange();
        r.setStart(s.node, s.offset);
        r.setEnd(e.node, e.offset);
        rects = Array.from(r.getClientRects()).map((x) => ({ l: Math.round(x.left), t: Math.round(x.top), w: Math.round(x.width), h: Math.round(x.height) }));
      } catch (err) { L("  Range 构造失败:", err && err.message); }
    }
    // 期望：divs[5..8] 的并集 bbox
    let expL = Infinity, expT = Infinity, expR = -Infinity, expB = -Infinity;
    for (let i = S_IDX; i <= E_IDX && i < divs.length; i++) {
      const b = divs[i].getBoundingClientRect();
      expL = Math.min(expL, b.left); expT = Math.min(expT, b.top);
      expR = Math.max(expR, b.right); expB = Math.max(expB, b.bottom);
    }
    const gotL = rects.length ? Math.min(...rects.map((r) => r.l)) : null;
    const gotT = rects.length ? Math.min(...rects.map((r) => r.t)) : null;
    const gotR = rects.length ? Math.max(...rects.map((r) => r.l + r.w)) : null;
    const gotB = rects.length ? Math.max(...rects.map((r) => r.t + r.h)) : null;
    const tol = 6; // 像素容差
    const ok = rects.length > 0 && Math.abs(gotL - expL) < tol && Math.abs(gotT - expT) < tol
      && Math.abs(gotR - expR) < tol && Math.abs(gotB - expB) < tol;
    out.steps.roundTrip = {
      selection: [S_IDX, expectS, E_IDX, expectE],
      rectCount: rects.length,
      expected: { l: Math.round(expL), t: Math.round(expT), r: Math.round(expR), b: Math.round(expB) },
      got: gotL === null ? null : { l: gotL, t: gotT, r: gotR, b: gotB },
      result: ok ? "PASS" : "FAIL"
    };
    L("   selection =", [S_IDX, expectS, E_IDX, expectE].join(","));
    L("   解出矩形数:", rects.length, rects.slice(0, 4));
    L("   期望 bbox:", out.steps.roundTrip.expected);
    L("   实际 bbox:", out.steps.roundTrip.got);
    L("   " + (ok ? "✅ 往返一致（容差 " + tol + "px）→ P2 逆运算算法可用" : "❌ 往返不一致 → 逆运算算法需调整"));
  }

  /* ===== 6) 清理 ===== */
  L("");
  L("Step 6: 清理");
  try { leaf.detach(); L("  已 detach 临时 leaf"); } catch (e) { L("  detach 失败:", e && e.message); }

  out.ok = (out.steps.testA?.result === "PASS") || (out.steps.roundTrip?.result === "PASS");
  L("");
  L("========== P0 v7 汇总 ==========");
  L(JSON.stringify(out, null, 2));
  try { await navigator.clipboard.writeText(JSON.stringify(out, null, 2)); L("✅ JSON 已复制到剪贴板"); }
  catch (e) { L("（剪贴板不可用，请手动复制上方 JSON）"); }
})();