// Real browser DOM/canvas and plugin handlers; synthetic PointerEvents cannot
// certify hardware palm rejection, latency or iPadOS gesture routing.
(async () => {
  const out = document.body.createEl('pre', { attr: { id: 'ink-results' } });
  out.style.cssText = 'position:fixed;bottom:4px;left:4px;z-index:99999;background:#20372c;color:white;padding:8px;max-width:90vw;white-space:pre-wrap';
  const results = [], check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const until = async (fn, label) => { const start = performance.now(); while (!fn()) { if (performance.now() - start > 5000) throw Error(label); await frame(); } };
  try {
    let failSave = false, disk;
    plugin.settings = { inkInputMode: 'pen-only', inkEraserMode: 'partial', inkEraserAutoReturn: true, inkPenWidth: 3,
      quickExcerpts: { 'demo.pdf': [{ exId: 'ex-inknote', page: 1, text: 'PDF 摘录', note: '原来的 Markdown 备注' }] },
      pdfTextBlocks: { 'demo.pdf': { 'ex-inknote': { page: 1, x: .12, y: .3, w: .65, fontSize: 18 } } } };
    plugin.saveSettings = async () => { if (failSave) throw Error('Simulated disk full'); disk = JSON.parse(JSON.stringify(plugin.settings)); };
    plugin.register = () => {};
    plugin.registerDomEvent = (target, type, fn, options) => target.addEventListener(type, fn, options);
    // A synchronous PDF scale adapter fixture changes page geometry like PDF.js.
    const page = leaf.containerEl.querySelector('.page'), scroller = page.closest('.pdf-viewer-container');
    scroller.style.cssText = 'height:calc(100vh - 45px);overflow:auto';
    let scale = 1;
    leaf.view.viewer = { child: { pdfViewer: { get currentScale() { return scale; }, set currentScale(v) { scale = v; page.style.width = 800 * v + 'px'; page.style.height = 1100 * v + 'px'; } } } };
    await plugin.lmbRenderPdfSidebarForLeaf(leaf); await plugin.lmbRefreshTextBlocks();
    plugin.lmbSetupInk();
    const entry = () => ({ ...plugin.settings.quickExcerpts['demo.pdf'][0], pdfPath: 'demo.pdf', quick: true });
    const block = () => page.querySelector('[data-ex-id="ex-inknote"]');
    const pointer = (target, type, id, x, y, kind = 'pen', extra = {}) => {
      const rect = page.getBoundingClientRect();
      const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: kind, button: 0,
        buttons: type === 'pointerup' ? 0 : 1, pressure: .5, clientX: rect.left + x, clientY: rect.top + y, ...extra });
      target.dispatchEvent(ev); return ev;
    };
    const items = () => plugin.lmbInkObjects('demo.pdf', '1');
    await plugin.lmbEditTextBlockNote(entry(), null, block());
    let editor = block()._lmbInlineEditor;
    editor.input.value = '进入手写前保存 **中文**'; editor.input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    failSave = true; await plugin.lmbSetInkMode(true);
    check(!plugin.inkMode && !editor.closed && editor.getText().includes('中文'), 'failed Markdown save keeps editor and prevents ink overlay');
    failSave = false; await plugin.lmbSetInkMode(true); await frame();
    check(plugin.inkMode && editor.closed && disk.quickExcerpts['demo.pdf'][0].note.includes('中文'), 'ink entry saves and closes the Markdown editor first');
    const live = page.querySelector('.lmb-ink-live-layer');
    check(!!live && getComputedStyle(live).pointerEvents === 'auto', 'ink surface captures input');
    const noteRect = block().getBoundingClientRect(), top = document.elementFromPoint(noteRect.left + 10, noteRect.top + 10);
    check(top === live, 'ink surface stays above rendered Markdown while writing');
    pointer(live, 'pointerdown', 51, 100, 350, 'touch');
    const scrollBefore = scroller.scrollTop;
    pointer(live, 'pointerdown', 52, 100, 400);
    pointer(live, 'pointermove', 51, 100, 500, 'touch');
    pointer(live, 'pointermove', 52, 650, 400);
    pointer(live, 'pointerup', 52, 650, 400);
    pointer(live, 'pointermove', 51, 100, 550, 'touch');
    check(scroller.scrollTop === scrollBefore, 'palm-first touch cannot move PDF during or after the pen stroke');
    pointer(live, 'pointerup', 51, 100, 550, 'touch');
    check(items().length === 1 && items()[0].points.length >= 2, 'one pen gesture creates exactly one stroke');
    pointer(live, 'click', 52, 650, 400);
    check(!block()._lmbInlineEditor, 'trailing pen click cannot reopen Markdown');
    plugin.lmbSetInkTool('eraser');
    pointer(live, 'pointerdown', 53, 380, 400); pointer(live, 'pointerup', 53, 380, 400);
    check(items().length === 2, 'partial eraser splits a sparse stroke');
    check(plugin.inkTool === 'pen', 'eraser automatically returns to previous pen');
    plugin.lmbUndoInk(page.querySelector('.lmb-ink-layer')); check(items().length === 1, 'one undo restores the full erased stroke');
    plugin.lmbRedoInk(page.querySelector('.lmb-ink-layer')); check(items().length === 2, 'redo restores the exact cut');
    plugin.settings.inkEraserAutoReturn = false; plugin.settings.inkEraserMode = 'stroke'; plugin.lmbSetInkTool('eraser');
    const eraserSize = leaf.containerEl.querySelector('.lmb-ink-width-control input'), penWidth = plugin.inkWidth;
    eraserSize.value = '22'; eraserSize.dispatchEvent(new Event('input')); eraserSize.dispatchEvent(new Event('change'));
    check(plugin.settings.inkEraserSize === 22 && plugin.inkWidth === penWidth, 'eraser size control does not change the saved pen width'); plugin.settings.inkEraserSize = 18;
    pointer(live, 'pointerdown', 54, 120, 400); pointer(live, 'pointerup', 54, 120, 400);
    check(items().length === 1 && plugin.inkTool === 'eraser', 'whole eraser and continuous erase option work');
    plugin.lmbSetInkTool('pen');
    const count = items().length;
    pointer(live, 'pointerdown', 55, 200, 450); pointer(live, 'pointermove', 55, 280, 480); pointer(live, 'pointercancel', 55, 280, 480);
    check(items().length === count + 1, 'cancelled sampled pen stroke is retained');
    await frame(); check(live._lmbInkPendingActive === null, 'finished stroke leaves no queued ghost drawing');
    const untilTime = performance.now() + 350; while (performance.now() < untilTime) await frame();
    pointer(live, 'pointerdown', 61, 100, 250, 'touch'); pointer(live, 'pointermove', 61, 100, 210, 'touch'); pointer(live, 'pointerup', 61, 100, 210, 'touch');
    check(scroller.scrollTop > scrollBefore, 'finger drags the PDF without adding ink');
    const beforeZoom = scale;
    pointer(live, 'pointerdown', 62, 100, 250, 'touch'); pointer(live, 'pointerdown', 63, 300, 250, 'touch');
    pointer(live, 'pointermove', 63, 400, 250, 'touch'); pointer(live, 'pointerup', 62, 100, 250, 'touch'); pointer(live, 'pointerup', 63, 400, 250, 'touch');
    check(scale > beforeZoom && items().length === count + 1, 'two fingers zoom through the PDF adapter without ink');
    leaf.view.viewer.child.pdfViewer.currentScale = 1; scroller.scrollTop = 0; await frame();
    const row = leaf.containerEl.querySelector('.lmb-pdf-sidebar-item');
    await plugin.lmbOpenSidebarNoteEditor(entry(), leaf, row);
    check(!plugin.inkMode, 'opening sidebar Markdown releases handwriting capture');
    const sidebar = leaf.containerEl.querySelector('.lmb-pdf-excerpt-sidebar'); editor = sidebar._lmbSidebarEditor;
    editor.input.value = '手写后继续编辑 Markdown'; editor.input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await until(() => disk.quickExcerpts['demo.pdf'][0].note === '手写后继续编辑 Markdown', 'sidebar autosave');
    check(!editor.closed, 'sidebar autosave keeps the editor open');
    // Inject key events while ink is active to catch document-level shortcuts.
    plugin.inkMode = true; let stolen = 0; const originalUndo = plugin.lmbUndoInk;
    plugin.lmbUndoInk = () => { stolen++; return true; };
    for (const key of ['z', 'Backspace']) editor.input.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: key === 'z', bubbles: true, cancelable: true }));
    check(stolen === 0 && !editor.closed && plugin.inkMode, 'ink shortcuts do not steal Markdown undo or delete');
    const probe = document.body.createEl('textarea'); probe.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); probe.remove();
    check(plugin.inkMode, 'Escape in a text input does not switch handwriting mode');
    editor.input.value = '手写后继续编辑 Markdown'; editor.input.dispatchEvent(new InputEvent('input', { bubbles: true })); await editor.persist();
    plugin.lmbUndoInk = originalUndo; plugin.inkMode = false;
    await plugin.lmbSetInkMode(true); await frame();
    const bar = leaf.containerEl.querySelector('.lmb-ink-tools');
    check(bar.querySelector('.lmb-ink-advanced').hidden, 'less-used tools start collapsed');
    bar.querySelector('[aria-label="更多工具与笔迹设置"]').click();
    check(!leaf.containerEl.querySelector('.lmb-ink-advanced').hidden, 'more button reveals eraser options and extra tools');
    for (const paneWidth of [1000, 720, 560]) {
      document.body.classList.add('lmb-mobile'); leaf.containerEl.style.width = paneWidth + 'px'; await frame();
      const tools = leaf.containerEl.querySelector('.lmb-ink-tools'), rect = tools.getBoundingClientRect();
      check(rect.width > 0 && rect.right <= leaf.containerEl.getBoundingClientRect().right + 1, 'compact toolbar stays inside narrow PDF pane ' + paneWidth);
      const sizes = [...tools.querySelectorAll('.lmb-ink-tool-buttons button')].map(b => b.getBoundingClientRect().height);
      check(sizes.every(h => h >= 36 && h === sizes[0]), 'tablet tool buttons have consistent touch height ' + paneWidth);
    }
    document.body.classList.remove('lmb-mobile'); leaf.containerEl.style.width = ''; await frame();
    const interruptedCount = items().length, activeLive = page.querySelector('.lmb-ink-live-layer');
    pointer(activeLive, 'pointerdown', 71, 300, 520); pointer(activeLive, 'pointermove', 71, 400, 550); window.dispatchEvent(new Event('blur'));
    check(items().length === interruptedCount + 1 && !plugin._lmbInkPenActive, 'window blur preserves sampled ink and releases pen ownership');
    await plugin.lmbFlushInkStorage(); check(disk.inkAnnotations['demo.pdf']['1'].objects.length === items().length, 'ink persistence retains editable fragments separately from Markdown');
    check(disk.quickExcerpts['demo.pdf'][0].note === '手写后继续编辑 Markdown', 'ink saving preserves the exact Markdown note');
    plugin.lmbSetInkTool('pen');
    pointer(activeLive, 'pointerdown', 91, 80, 610, 'pen', { pressure: .3 });
    pointer(activeLive, 'pointermove', 91, 180, 610, 'pen', { pressure: .04 });
    pointer(activeLive, 'pointermove', 91, 450, 700, 'pen', { pressure: 0, buttons: 0 });
    pointer(activeLive, 'pointerup', 91, 650, 760, 'pen', { pressure: .5 });
    const cleanStroke = items().at(-1), pageRect = page.getBoundingClientRect();
    check(Math.abs(cleanStroke.points.at(-1).x * pageRect.width - 180) < .01, 'hover and positive-pressure stylus release do not add a tail');
    check(Math.abs(cleanStroke.points.at(-1).p - .04) < .000001 && cleanStroke.renderVersion === 2, 'light contact remains editable with continuous outline rendering');
    const roundtrip = JSON.stringify(cleanStroke); await plugin.lmbFlushInkStorage();
    check(JSON.stringify(disk.inkAnnotations['demo.pdf']['1'].objects.at(-1)) === roundtrip, 'new render version and exact contact samples survive persistence');
    plugin.lmbUndoInk(page.querySelector('.lmb-ink-layer')); plugin.lmbRedoInk(page.querySelector('.lmb-ink-layer'));
    check(JSON.stringify(items().at(-1)) === roundtrip, 'undo redo preserves stabilized strokes exactly');
    out.textContent = 'PASS ' + results.length + ' ink / palm / Markdown workflow checks';
    out.dataset.report = JSON.stringify({ checks: results.length, results, physicalTablet: false });
  } catch (error) { out.textContent = 'FAIL after ' + results.length + ': ' + error.stack; throw error; }
})();
