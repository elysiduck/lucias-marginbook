/* Run in the DevTools console of a DISPOSABLE Obsidian vault only.
 * The marker file and two test notes must be created before running this script.
 * Target note: 1000 source lines, with "Target excerpt paragraph. ^ex-target"
 * at line 800. The other note is currently-reading.md.
 */
(async () => {
  const marker = app.vault.getAbstractFileByPath("LMB-NAVIGATION-SANDBOX.md");
  if (!marker || (await app.vault.cachedRead(marker)).trim() !== "Disposable navigation test vault.") {
    throw new Error("This test requires an explicitly marked, disposable navigation test vault.");
  }
  const plugin = app.plugins.plugins["lucias-marginbook"];
  if (!plugin) throw new Error("MarginBook is not loaded");
  const workspace = app.workspace;
  const file = app.vault.getAbstractFileByPath("book-excerpts.md");
  const keepFile = app.vault.getAbstractFileByPath("currently-reading.md");
  const results = [];
  const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, passed, details) => { results.push({ name, passed: !!passed, details }); };
  const targets = () => workspace.getLeavesOfType("markdown").filter((leaf) =>
    leaf.view.file?.path === file.path || leaf.getViewState().state?.file === file.path);
  let victim = workspace.getLeavesOfType("markdown").find((leaf) => !targets().includes(leaf));
  if (!victim) victim = workspace.getLeaf("tab");
  await victim.openFile(keepFile, { active: true, state: { mode: "preview" } });
  for (const leaf of targets()) leaf.detach();
  workspace.setActiveLeaf(victim, { focus: true });

  function visibleTarget(leaf) {
    const preview = leaf.view.previewMode;
    const paragraph = [...preview.containerEl.querySelectorAll("p")].find((el) => el.textContent.includes("Target excerpt paragraph."));
    const scroller = preview.containerEl.querySelector(".markdown-preview-view") || preview.containerEl;
    const bounds = scroller.getBoundingClientRect(), rect = paragraph?.getBoundingClientRect();
    return { visible: !!rect && rect.bottom > bounds.top && rect.top < bounds.bottom,
      scroll: preview.getScroll(), mode: leaf.view.getMode(), paragraphTop: rect?.top,
      viewport: { top: bounds.top, bottom: bounds.bottom } };
  }

  const opened = await plugin.lmbOpenExcerptInMd("ex-target", file.path, null);
  await wait();
  let target = targets()[0];
  check("unopened excerpt preserves the current tab", opened && victim.view.file.path === keepFile.path && target !== victim && targets().length === 1,
    { victim: victim.view.file.path, targetCount: targets().length });
  check("new reading tab displays the excerpt without changing mode", opened && target.view.getMode() === "preview" && visibleTarget(target).visible, visibleTarget(target));

  target.view.previewMode.applyScroll(0);
  await wait();
  const previewResult = await plugin.lmbOpenExcerptInMd("ex-target", file.path, null);
  await wait();
  check("existing reading tab visibly scrolls and stays in reading mode", previewResult && visibleTarget(target).visible && target.view.getMode() === "preview", visibleTarget(target));
  check("existing reading tab is reused", targets().length === 1 && targets()[0] === target, { targetCount: targets().length });

  await target.setViewState({ type: "markdown", state: { file: file.path, mode: "source" } });
  workspace.setActiveLeaf(target, { focus: true });
  await wait();
  target.view.editor.setCursor({ line: 0, ch: 0 });
  const sourceResult = await plugin.lmbOpenExcerptInMd("ex-target", file.path, null);
  check("source mode positions the editor and preserves source mode", sourceResult && target.view.editor.getCursor().line === 800 && target.view.getMode() === "source",
    { cursor: target.view.editor.getCursor(), mode: target.view.getMode() });

  await target.setViewState({ type: "markdown", state: { file: file.path, mode: "preview" } });
  workspace.setActiveLeaf(target, { focus: true });
  await wait();
  const getFileCache = app.metadataCache.getFileCache;
  let metadataResult;
  try {
    app.metadataCache.getFileCache = function (entry) { return entry.path === file.path ? null : getFileCache.call(this, entry); };
    target.view.previewMode.applyScroll(0);
    metadataResult = await plugin.lmbOpenExcerptInMd("ex-target", file.path, null);
  } finally { app.metadataCache.getFileCache = getFileCache; }
  await wait();
  check("missing block cache still locates the excerpt", metadataResult && visibleTarget(target).visible, visibleTarget(target));
  check("saved viewport matches the visible preview after positioning", Math.abs(target.view.scroll - target.view.previewMode.getScroll()) < 1,
    { saved: target.view.scroll, visible: target.view.previewMode.getScroll() });

  // Change the DOM scroll position like a user scroll. applyScroll itself marks
  // the event as programmatic and intentionally skips Obsidian's state sync.
  const scroller = target.view.previewMode.containerEl.querySelector(".markdown-preview-view");
  scroller.scrollTop = scroller.scrollHeight * 0.15;
  await wait(200);
  const manualScroll = target.view.previewMode.getScroll();
  workspace.setActiveLeaf(victim, { focus: true });
  await wait();
  workspace.setActiveLeaf(target, { focus: true });
  await wait();
  const returnedScroll = target.view.previewMode.getScroll();
  check("switching tabs does not replay the excerpt jump", Math.abs(manualScroll - returnedScroll) < 3,
    { before: manualScroll, after: returnedScroll });

  await target.setViewState({ type: "markdown", state: { file: file.path, mode: "source" } });
  await wait();
  const editingScroll = target.view.currentMode.getScroll();
  check("entering edit mode preserves the manually selected reading location", Math.abs(editingScroll - manualScroll) < 10,
    { reading: manualScroll, editing: editingScroll });
  await target.setViewState({ type: "markdown", state: { file: file.path, mode: "preview" } });
  await wait();
  check("returning to reading mode preserves that location", Math.abs(target.view.previewMode.getScroll() - manualScroll) < 10,
    { before: manualScroll, after: target.view.previewMode.getScroll() });

  const missing = await plugin.lmbOpenExcerptInMd("ex-absent", file.path, null);
  check("missing target returns false and preserves the tab", missing === false && targets()[0] === target && target.view.getMode() === "preview", { result: missing });

  target.detach();
  workspace.setActiveLeaf(victim, { focus: true });
  const concurrent = await Promise.all(Array.from({ length: 3 }, () => plugin.lmbOpenExcerptInMd("ex-target", file.path, null)));
  target = targets()[0];
  await wait();
  check("three simultaneous requests create one excerpt tab; only latest executes", concurrent[0] === false && concurrent[1] === false && concurrent[2] === true && targets().length === 1 && victim.view.file.path === keepFile.path,
    { results: concurrent, targetCount: targets().length });
  check("concurrent requests finish with the excerpt visible", visibleTarget(target).visible, visibleTarget(target));

  return { app: document.title, pluginVersion: plugin.manifest.version,
    vault: app.vault.adapter.basePath, passed: results.filter((result) => result.passed).length, total: results.length, results };
})()
