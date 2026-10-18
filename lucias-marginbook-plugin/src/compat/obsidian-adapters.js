/* compat/obsidian-adapters — Obsidian 私有 Canvas / PDF API 的单一边界。
 * 业务模块应优先通过这里读取或提交内部对象；宿主升级时集中在本文件适配。 */
const LmbCanvasAdapter = Object.freeze({
  data(canvas) {
    try { return canvas && typeof canvas.getData === "function" ? canvas.getData() : null; }
    catch (_) { return null; }
  },
  selection(canvas) {
    try { return canvas ? Array.from(typeof canvas.getSelection === "function" ? canvas.getSelection() : (canvas.selection || [])) : []; }
    catch (_) { return []; }
  },
  commit(canvas, data) {
    try {
      if (!canvas || typeof canvas.setData !== "function" || typeof canvas.requestSave !== "function") return false;
      canvas.setData(data); canvas.requestSave(); return true;
    } catch (_) { return false; }
  }
});

const LmbPdfAdapter = Object.freeze({
  document(view) {
    const child = view?.viewer?.child, outer = child?.pdfViewer || view?.viewer?.pdfViewer;
    return outer?.pdfDocument || outer?.pdfViewer?.pdfDocument || child?.pdfDocument || null;
  },
  async reload(view, file) {
    if (typeof view.onLoadFile === 'function') await view.onLoadFile(file);
    else if (typeof view.viewer?.loadFile === 'function') await view.viewer.loadFile(file);
    else if (typeof view.loadFile === 'function') await view.loadFile(file);
  },
  page(view, page) {
    if (typeof view.setEphemeralState === 'function') { view.setEphemeralState({ subpath: '#page=' + page }); return; }
    const outer = view.viewer?.child?.pdfViewer || view.viewer?.pdfViewer;
    if (outer) (outer.pdfViewer || outer).currentPageNumber = page;
  },
  zoomViewer(view) {
    try {
      const child = view && view.viewer && view.viewer.child;
      const viewer = child && child.pdfViewer;
      return viewer && Number(viewer.currentScale) > 0 ? viewer : null;
    } catch (_) { return null; }
  },
  viewer(view) {
    try { return view && view.containerEl && (view.containerEl.querySelector(".pdfViewer") || view.containerEl); }
    catch (_) { return null; }
  },
  isRelevantMutation(node) {
    try {
      if (!node) return false;
      if (node.nodeType === 3) return !!(node.parentElement && node.parentElement.closest(".textLayer"));
      return node.nodeType === 1 && !node.classList.contains("lmb-mark")
        && !!node.closest(".page, .textLayer, .annotationLayer");
    } catch (_) { return false; }
  }
});
