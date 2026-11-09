/* File picker: public Modal/Vault/renderer APIs; core entry adapter is reversible. */
function lmbPickerKind(file) {
  const ext = file.extension.toLowerCase();
  return ext === "pdf" ? "pdf" : ext === "md" ? "note" : /^(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(ext) ? "image" : "other";
}

const LMB_PICKER_SORTS = [
  ["relevance", "综合排序"], ["opened", "最近打开"], ["added", "最近添加"],
  ["modified", "最近修改"], ["activity", "添加或修改"]
];

function lmbPickerTime(file, mode) {
  const { ctime, mtime } = file.stat;
  const valid = time => Number.isFinite(time) && time > 0 ? time : 0;
  if (mode === "added") return valid(ctime);
  if (mode === "activity") return Math.max(valid(ctime), valid(mtime));
  return valid(mtime);
}

function lmbPickerSearch(files, query, kind, folder, recent, aliases, sort = "relevance") {
  const tokens = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const ranks = new Map(recent.map((path, i) => [path, recent.length - i]));
  return files.flatMap(file => {
    if (kind !== "all" && lmbPickerKind(file) !== kind) return [];
    if (folder && !file.path.startsWith(folder + "/")) return [];
    const name = file.basename.normalize("NFKC").toLocaleLowerCase();
    const extra = aliases(file);
    const text = (file.path + " " + extra.join(" ")).normalize("NFKC").toLocaleLowerCase();
    if (!tokens.every(token => text.includes(token))) return [];
    const score = tokens.reduce((n, token) => n + (name === token ? 100 : name.startsWith(token) ? 35 : name.includes(token) ? 20 : 1), 0);
    return [{ file, score, recent: ranks.get(file.path) || 0, time: lmbPickerTime(file, sort) }];
  }).sort((a, b) => (sort === "relevance" ? 0 : sort === "opened" ? b.recent - a.recent : b.time - a.time) ||
    b.score - a.score || b.recent - a.recent || b.time - a.time ||
    a.file.path.localeCompare(b.file.path, "zh-CN", { numeric: true }));
}

function lmbPickerLectureKey(file) {
  const match = file.basename.match(/\blecture\s*(\d+)\b/i);
  return match ? `lecture-${Number(match[1])}` : null;
}

// Isolate undocumented core access here. Do not persist changes to hotkeys.json.
LuciasMarginBookPlugin.prototype.lmbSetupFilePicker = function () {
  const plugin = this;
  this.addCommand({ id: "open-file-picker", name: "打开文件（预览选择器）", hotkeys: [{ modifiers: ["Mod"], key: "k" }], callback: () => this.lmbOpenFilePicker() });
  const styles = document.createElement("style");
  styles.textContent = LMB_FILE_PICKER_CSS;
  document.head.appendChild(styles);
  const restores = [];
  const patched = new WeakMap();
  let enabled = true;
  const replace = (target, key, wrapper) => {
    if (!target || typeof target[key] !== "function") return;
    let keys = patched.get(target);
    if (!keys) patched.set(target, keys = new Set());
    if (keys.has(key)) return;
    const original = target[key];
    const replacement = function (...args) {
      // If another plugin retains this wrapper, disabling MarginBook must
      // still fall through to the original core handler.
      return (enabled ? wrapper : original).apply(this, args);
    };
    target[key] = replacement;
    keys.add(key);
    restores.push(() => { if (target[key] === replacement) target[key] = original; });
  };
  const wire = () => {
    if (!enabled || plugin._unloaded) return;
    const instance = plugin.app.internalPlugins?.getPluginById?.("switcher")?.instance;
    replace(instance, "open", () => plugin.lmbOpenFilePicker());
    const command = plugin.app.commands?.commands?.["switcher:open"];
    replace(command, "callback", () => plugin.lmbOpenFilePicker());
    replace(command, "checkCallback", checking => { if (!checking) plugin.lmbOpenFilePicker(); return true; });
  };
  // Routes command invocations even if the switcher is re-enabled later.
  const commands = this.app.commands;
  if (commands && typeof commands.executeCommandById === "function") {
    const original = commands.executeCommandById;
    replace(commands, "executeCommandById", function (id, ...args) {
      if (id === "switcher:open") { plugin.lmbOpenFilePicker(); return true; }
      return original.call(this, id, ...args);
    });
  }
  this.app.workspace.onLayoutReady(wire);
  this.registerEvent(this.app.workspace.on("layout-change", wire));
  this.register(() => {
    enabled = false;
    this._lmbFilePicker?.close();
    for (const restore of restores.reverse()) restore();
    styles.remove();
  });
};

LuciasMarginBookPlugin.prototype.lmbOpenFilePicker = function () {
  if (this._unloaded) return;
  if (this._lmbFilePicker) { this._lmbFilePicker.searchEl?.focus(); return; }
  const modal = new LMBFilePickerModal(this.app, this);
  this._lmbFilePicker = modal;
  modal.open();
};

class LMBFilePickerModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.kind = "all";
    this.folder = "";
    this.recentOnly = false;
    this.sort = plugin._lmbFilePickerSort || "relevance";
    this.selected = 0;
    this.generation = 0;
    this.pageGeneration = 0;
    this.closed = false;
    this.pdfCache = new Map();
    this.disposers = [];
    this.originLeaf = app.workspace.activeLeaf;
  }
  button(parent, text, fn, cls = "") {
    const el = parent.createEl("button", { text, cls });
    el.type = "button";
    el.addEventListener("click", fn);
    return el;
  }
  onOpen() {
    this.modalEl.addClass("lmb-file-picker");
    this.titleEl.setText("打开文件");
    const root = this.contentEl;
    root.empty();
    const search = root.createDiv({ cls: "lmb-fp-search" });
    setIcon(search.createSpan(), "search");
    this.searchEl = search.createEl("input", { type: "search", placeholder: "搜索文件名、别名、路径…" });
    this.searchEl.setAttribute("aria-label", "搜索文件");
    this.searchEl.setAttribute("aria-controls", "lmb-fp-results");
    this.searchEl.setAttribute("role", "combobox");
    this.searchEl.setAttribute("aria-expanded", "true");
    this.searchEl.setAttribute("aria-autocomplete", "list");
    this.searchEl.addEventListener("input", () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.refresh(), 70);
    });
    this.searchEl.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); event.stopPropagation();
        this.choose(this.selected + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter") {
        event.preventDefault(); event.stopPropagation();
        clearTimeout(this.searchTimer);
        if (this.lastQuery !== this.searchEl.value) this.refresh();
        this.openFile(this.results[this.selected]?.file, event.ctrlKey || event.metaKey);
      }
    });
    const filters = root.createDiv({ cls: "lmb-fp-filters" });
    this.tabs = new Map();
    for (const [kind, label] of [["all", "全部"], ["pdf", "PDF"], ["note", "笔记"], ["image", "图片"]]) {
      this.tabs.set(kind, this.button(filters, label, () => { this.kind = kind; this.refresh(); }));
    }
    this.recentButton = this.button(filters, "仅最近打开", () => { this.recentOnly = !this.recentOnly; this.refresh(); });
    this.folderEl = filters.createEl("select", { cls: "lmb-fp-folder" });
    this.folderEl.setAttribute("aria-label", "限定文件夹");
    const all = this.folderEl.createEl("option", { text: "所有文件夹" }); all.value = "";
    const folders = this.app.vault.getAllLoadedFiles().filter(file => Array.isArray(file.children) && file.path !== "/");
    for (const folder of folders.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"))) {
      const option = this.folderEl.createEl("option", { text: folder.path }); option.value = folder.path;
    }
    this.folderEl.addEventListener("change", () => { this.folder = this.folderEl.value; this.refresh(); });
    const body = root.createDiv({ cls: "lmb-fp-body" });
    const left = body.createDiv({ cls: "lmb-fp-left" });
    const listHeader = left.createDiv({ cls: "lmb-fp-list-header" });
    this.countEl = listHeader.createDiv({ cls: "lmb-fp-count" });
    this.countEl.setAttribute("aria-live", "polite");
    const sort = listHeader.createEl("select", { cls: "lmb-fp-sort", attr: { "aria-label": "文件排序" } });
    for (const [value, label] of LMB_PICKER_SORTS) sort.createEl("option", { text: label }).value = value;
    sort.value = this.sort;
    sort.addEventListener("change", () => {
      this.plugin._lmbFilePickerSort = this.sort = sort.value;
      this.refresh();
    });
    this.listEl = left.createDiv({ cls: "lmb-fp-list", attr: { id: "lmb-fp-results", role: "listbox", "aria-label": "文件搜索结果" } });
    this.previewEl = body.createDiv({ cls: "lmb-fp-preview" });
    const footer = root.createDiv({ cls: "lmb-fp-footer" });
    for (const [key, label] of [["↑↓", "选择"], ["Enter", "打开"], ["Ctrl / ⌘ + Enter", "新标签页"], ["Esc", "关闭"]]) {
      const hint = footer.createSpan(); hint.createEl("kbd", { text: key }); hint.createSpan({ text: label });
    }
    this.files = this.app.vault.getFiles();
    this.aliases = new Map();
    this.recent = this.app.workspace.getLastOpenFiles();
    const invalidate = () => {
      this.files = this.app.vault.getFiles(); this.aliases.clear();
      clearTimeout(this.vaultTimer); this.vaultTimer = setTimeout(() => { if (!this.closed) this.refresh(); }, 100);
    };
    for (const event of ["create", "delete", "rename", "modify"]) {
      const ref = this.app.vault.on(event, invalidate);
      this.disposers.push(() => this.app.vault.offref(ref));
    }
    this.refresh();
    this.searchEl.focus();
  }
  getAliases(file) {
    if (!this.aliases.has(file.path)) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const value = frontmatter?.aliases ?? frontmatter?.alias ?? [];
      this.aliases.set(file.path, (Array.isArray(value) ? value : [value]).filter(item => typeof item === "string"));
    }
    return this.aliases.get(file.path);
  }
  refresh() {
    if (this.closed) return;
    this.lastQuery = this.searchEl.value;
    const recent = new Set(this.recent);
    this.results = lmbPickerSearch(this.recentOnly ? this.files.filter(file => recent.has(file.path)) : this.files,
      this.lastQuery, this.kind, this.folder, this.recent, file => this.getAliases(file), this.sort);
    this.limit = 80;
    this.listEl.empty();
    for (const [kind, el] of this.tabs) { el.toggleClass("is-active", kind === this.kind); el.setAttribute("aria-pressed", String(kind === this.kind)); }
    this.recentButton.toggleClass("is-active", this.recentOnly);
    this.recentButton.setAttribute("aria-pressed", String(this.recentOnly));
    this.countEl.setText(`搜索结果 · ${this.results.length} 项`);
    this.renderRows();
    this.choose(0);
  }
  renderRows() {
    this.listEl.querySelector(".lmb-fp-more")?.remove();
    const start = this.listEl.querySelectorAll(".lmb-fp-row").length;
    for (let index = start; index < Math.min(this.limit, this.results.length); index++) {
      const { file, recent, time } = this.results[index];
      const kind = lmbPickerKind(file);
      const row = this.listEl.createDiv({ cls: "lmb-fp-row", attr: { role: "option", id: `lmb-fp-result-${index}`, "aria-selected": "false", tabindex: "-1" } });
      row.title = file.path;
      const icon = row.createDiv({ cls: `lmb-fp-file-icon is-${kind}` });
      setIcon(icon.createSpan(), kind === "image" ? "image" : kind === "note" ? "file-text" : "file");
      icon.createSpan({ text: file.extension.toUpperCase(), cls: "lmb-fp-ext" });
      const info = row.createDiv({ cls: "lmb-fp-info" });
      info.createDiv({ text: file.basename, cls: "lmb-fp-name" });
      const details = info.createDiv({ cls: "lmb-fp-details" });
      details.createSpan({ text: !file.parent?.path || file.parent.path === "/" ? "仓库根目录" : file.parent.path, cls: "lmb-fp-path" });
      if (time) {
        const added = this.sort === "added" || (this.sort === "activity" && time > lmbPickerTime(file, "modified"));
        const date = new Date(time);
        const stamp = details.createSpan({ text: `${added ? "添加" : "修改"} ${date.toLocaleDateString()}`, cls: "lmb-fp-date" });
        stamp.title = `${added ? "创建时间" : "修改时间"}：${date.toLocaleString()}`;
      }
      if (recent && !this.recentOnly) row.createSpan({ text: "最近", cls: "lmb-fp-badge", attr: { title: "最近打开" } });
      row.addEventListener("click", event => { if (event.ctrlKey || event.metaKey) this.openFile(file, true); else this.choose(index); });
      row.addEventListener("dblclick", () => this.openFile(file, false));
    }
    if (this.limit < this.results.length) this.button(this.listEl, "显示更多结果", () => { this.limit += 80; this.renderRows(); }, "lmb-fp-more");
    if (!this.results.length) this.listEl.createDiv({ text: "没有匹配的文件，试试更短的关键词或其他筛选。", cls: "lmb-fp-empty" });
  }
  choose(index) {
    if (!this.results.length) {
      this.clearPreview(); this.previewEl.empty();
      this.previewEl.createDiv({ text: "选择文件后，在这里预览内容", cls: "lmb-fp-empty" });
      this.searchEl.removeAttribute("aria-activedescendant"); return;
    }
    this.selected = Math.max(0, Math.min(index, this.results.length - 1));
    if (this.selected >= this.limit) { this.limit = this.selected + 40; this.renderRows(); }
    this.listEl.querySelectorAll(".lmb-fp-row").forEach((el, i) => {
      el.toggleClass("is-selected", i === this.selected); el.setAttribute("aria-selected", String(i === this.selected));
      if (i === this.selected) el.scrollIntoView({ block: "nearest" });
    });
    this.searchEl.setAttribute("aria-activedescendant", `lmb-fp-result-${this.selected}`);
    this.clearPreview();
    const generation = this.generation;
    this.previewTimer = setTimeout(() => this.preview(this.results[this.selected].file, generation), 100);
  }
  clearPreview() {
    this.generation++; this.pageGeneration++;
    clearTimeout(this.previewTimer);
    this.markdownComponent?.unload(); this.markdownComponent = null;
    this.renderTask?.cancel(); this.renderTask = null;
    const task = this.loadingTask; this.loadingTask = null; this.pdf = null;
    if (task) Promise.resolve(task.destroy()).catch(() => {});
  }
  related(file) {
    const resolved = this.app.metadataCache.resolvedLinks || {};
    const key = lmbPickerLectureKey(file);
    return this.files.filter(other => other.path !== file.path && other.extension === "md").map(other => {
      const linked = !!(resolved[other.path]?.[file.path] || resolved[file.path]?.[other.path]);
      const sameFolder = other.parent?.path === file.parent?.path;
      const nameMatch = sameFolder && (key ? lmbPickerLectureKey(other) === key : other.basename.startsWith(file.basename + "_") || other.basename.startsWith(file.basename + " "));
      return { file: other, score: linked ? 2 : nameMatch ? 1 : 0 };
    }).filter(item => item.score).sort((a, b) => b.score - a.score).slice(0, 4);
  }
  async preview(file, generation) {
    if (this.closed || generation !== this.generation) return;
    const pane = this.previewEl; pane.empty();
    const top = pane.createDiv({ cls: "lmb-fp-preview-top" });
    top.createSpan({ text: "内容预览" });
    this.button(top, "打开文件 ↗", () => this.openFile(file, true));
    pane.createEl("h3", { text: file.basename });
    pane.createDiv({ text: file.path, cls: "lmb-fp-preview-path" });
    const content = pane.createDiv({ cls: "lmb-fp-content" });
    content.setAttribute("aria-label", "文件内容预览");
    const kind = lmbPickerKind(file);
    if (kind === "pdf") content.addClass("is-pdf");
    const related = this.related(file);
    if (related.length) {
      pane.createDiv({ text: "配套笔记", cls: "lmb-fp-related-title" });
      const links = pane.createDiv({ cls: "lmb-fp-related" });
      for (const item of related) {
        const button = this.button(links, "", () => this.openFile(item.file, true));
        button.createSpan({ text: item.file.basename });
        button.createEl("small", { text: item.score === 2 ? "已有链接关联  ↗" : "同目录 · 文件名匹配候选  ↗" });
      }
    }
    try {
      if (kind === "note") {
        content.addClass("markdown-rendered");
        const text = await this.app.vault.cachedRead(file);
        if (generation !== this.generation || this.closed) return;
        const component = this.markdownComponent = new Component(); component.load();
        const stage = content.createDiv();
        await MarkdownRenderer.render(this.app, text.slice(0, 60000), stage, file.path, component);
        if (generation !== this.generation || this.closed) { component.unload(); return; }
        if (text.length > 60000) content.createDiv({ text: "预览已截取前 60,000 字符，打开文件可阅读全文。", cls: "lmb-fp-meta" });
        content.addEventListener("click", event => {
          const link = event.target.closest("a.internal-link");
          if (link) { event.preventDefault(); event.stopPropagation(); this.close(); this.app.workspace.openLinkText(link.getAttribute("data-href") || link.getAttribute("href"), file.path, true); }
        });
      } else if (kind === "image") {
        const image = content.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), alt: file.basename } });
        image.addEventListener("error", () => { image.remove(); content.createDiv({ text: "图片无法预览，请打开文件查看。", cls: "lmb-fp-empty" }); });
      } else if (kind === "pdf") {
        content.createDiv({ text: "正在加载 PDF…", cls: "lmb-fp-empty" });
        if (typeof loadPdfJs !== "function") throw new Error("此 Obsidian 版本不支持 PDF 预览，请升级后重试。");
        const lib = await loadPdfJs();
        if (generation !== this.generation || this.closed) return;
        // Vault binary access also works on mobile and avoids app:// URL/range
        // differences between Electron versions. Read only the selected PDF.
        const binary = await this.app.vault.readBinary(file);
        if (generation !== this.generation || this.closed) return;
        const task = this.loadingTask = lib.getDocument({ data: new Uint8Array(binary) });
        const pdf = await task.promise;
        if (generation !== this.generation || this.closed) return;
        this.pdf = pdf; this.pdfPage = 1;
        content.empty();
        const nav = content.createDiv({ cls: "lmb-fp-pdf-nav" });
        const back = this.button(nav, "← 上一页", () => show(this.pdfPage - 1));
        const label = nav.createSpan();
        const next = this.button(nav, "下一页 →", () => show(this.pdfPage + 1));
        const stage = content.createDiv({ cls: "lmb-fp-pdf-stage" });
        const show = page => {
          this.pdfPage = Math.max(1, Math.min(page, pdf.numPages));
          label.setText(`${this.pdfPage} / ${pdf.numPages}`);
          back.disabled = this.pdfPage === 1; next.disabled = this.pdfPage === pdf.numPages;
          this.renderPdfPage(file, pdf, stage, generation);
        };
        show(1);
      } else {
        content.createDiv({ text: `${file.extension.toUpperCase()} 文件 · ${(file.stat.size / 1024).toFixed(1)} KB`, cls: "lmb-fp-empty" });
        this.button(content, "打开此文件", () => this.openFile(file, false));
      }
    } catch (error) {
      if (generation === this.generation && !this.closed) {
        content.empty(); content.createDiv({ text: `暂时无法预览：${error.message || error}。仍可打开文件。`, cls: "lmb-fp-empty" });
      }
    }
  }
  async renderPdfPage(file, pdf, stage, generation) {
    this.renderTask?.cancel();
    const serial = ++this.pageGeneration;
    const key = `${file.path}:${file.stat.mtime}:${this.pdfPage}`;
    stage.empty();
    if (this.pdfCache.has(key)) { stage.createEl("img", { attr: { src: this.pdfCache.get(key), alt: `第 ${this.pdfPage} 页` } }); return; }
    try {
      const page = await pdf.getPage(this.pdfPage);
      if (generation !== this.generation || serial !== this.pageGeneration || this.closed) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1200 / base.width) });
      const canvas = stage.createEl("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const task = this.renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport });
      await task.promise;
      if (generation !== this.generation || serial !== this.pageGeneration || this.closed) return;
      this.pdfCache.set(key, canvas.toDataURL("image/webp", 0.85));
      while (this.pdfCache.size > 8) this.pdfCache.delete(this.pdfCache.keys().next().value);
      page.cleanup();
    } catch (error) {
      if (generation === this.generation && serial === this.pageGeneration && !this.closed && error.name !== "RenderingCancelledException") {
        console.warn("[lmb] file picker PDF page preview failed", error);
        stage.empty(); stage.createDiv({ text: "此页无法预览，请打开文件查看。", cls: "lmb-fp-empty" });
      }
    }
  }
  async openFile(file, newTab) {
    if (!file || this.opening) return;
    const live = this.app.vault.getAbstractFileByPath(file.path);
    if (!(live instanceof TFile)) { new Notice("文件已移除，请重新选择。"); this.refresh(); return; }
    this.opening = true;
    this.close();
    try {
      const leaf = newTab ? this.app.workspace.getLeaf("tab") : this.originLeaf || this.app.workspace.getLeaf(false);
      await leaf.openFile(live, { active: true });
    } catch (error) { new Notice(`打开文件失败：${error.message || error}`); }
  }
  onClose() {
    this.closed = true;
    clearTimeout(this.searchTimer); clearTimeout(this.vaultTimer);
    this.clearPreview(); this.pdfCache.clear();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    if (this.plugin._lmbFilePicker === this) this.plugin._lmbFilePicker = null;
    this.contentEl.empty();
  }
}

const LMB_FILE_PICKER_CSS = `
.modal.lmb-file-picker{--fp-accent:#a9c58e;--fp-selected:#303f30;width:min(1320px,94vw);max-width:94vw;height:min(820px,90vh);max-height:90vh;padding:24px 26px 0;border-radius:18px;background:var(--background-primary);overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px #0006}
.lmb-file-picker .modal-title{font-size:13px;color:var(--text-muted);margin:0 0 14px;font-weight:500}
.lmb-file-picker .modal-content{margin:0;overflow:hidden;display:flex;flex-direction:column;min-height:0;flex:1}
.lmb-fp-search{display:flex;gap:13px;align-items:center;background:var(--background-secondary);border:1px solid #6b8259;border-radius:10px;padding:0 16px;flex-shrink:0}
.lmb-fp-search>span{display:flex;color:var(--fp-accent)}
.lmb-fp-search input[type=search]{width:100%;font-size:20px;padding:13px 0;height:52px;box-shadow:none!important;background:transparent!important;border:0!important;color:var(--text-normal)}
.lmb-fp-filters{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:14px 0;flex-shrink:0}
.lmb-fp-filters button{box-shadow:none;background:transparent;color:var(--text-muted);padding:5px 14px;height:30px;border-radius:7px;border:1px solid transparent;font-size:13px}
.lmb-fp-filters button.is-active{background:var(--fp-selected);color:#d5e5c7;border-color:#566b48}
.lmb-fp-filters button:hover{background:var(--background-modifier-hover)}
.lmb-fp-filters button:nth-child(5){margin-left:12px}
.lmb-fp-folder{margin-left:auto;max-width:40%;font-size:12px;color:var(--text-muted)}
.lmb-fp-body{display:grid;grid-template-columns:44% 56%;flex:1;min-height:0;border-top:1px solid var(--background-modifier-border);margin:0}
.lmb-fp-left{display:flex;flex-direction:column;min-height:0;padding:16px 12px 10px 16px;border-right:1px solid var(--background-modifier-border)}
.lmb-fp-list-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 4px 9px}
.lmb-fp-count{font-size:12px;color:var(--text-muted)}
.lmb-fp-sort{font-size:12px;color:var(--text-normal);max-width:55%;height:28px}
.lmb-fp-list{overflow:auto;min-height:0;flex:1;scrollbar-width:thin}
.lmb-fp-row{display:flex;gap:9px;position:relative;padding:6px 8px;border:1px solid transparent;border-radius:7px;cursor:pointer;margin:0 2px 2px;align-items:center;min-height:50px}
.lmb-fp-row:hover{background:var(--background-modifier-hover)}
.lmb-fp-row.is-selected{background:var(--fp-selected);border-color:#536d45}
.lmb-fp-row.is-selected:before{content:'';position:absolute;left:0;top:10px;bottom:10px;width:3px;background:var(--fp-accent);border-radius:3px}
.lmb-fp-file-icon{flex-shrink:0;width:29px;height:34px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1px;border-radius:5px;background:#333b3b;color:#aab7af}
.lmb-fp-file-icon.is-pdf{background:#433a33;color:#e1b092}.lmb-fp-file-icon.is-note{background:#2a3a40;color:#9fc4d2}.lmb-fp-file-icon.is-image{background:#3e334c;color:#c2acdd}
.lmb-fp-file-icon>span:first-child{display:flex}.lmb-fp-file-icon svg{width:15px;height:15px}.lmb-fp-ext{font-size:8px;font-weight:700;line-height:10px;max-width:27px;overflow:hidden}
.lmb-fp-info{flex:1;min-width:0}.lmb-fp-name{font-size:14px;font-weight:600;line-height:1.35;color:var(--text-normal);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.lmb-fp-meta{font-size:12px;color:var(--text-muted);margin-top:5px}
.lmb-fp-details{display:flex;align-items:baseline;gap:7px;margin-top:2px;font-size:11px;line-height:1.3;color:var(--text-muted)}
.lmb-fp-path{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.lmb-fp-date{flex-shrink:0;white-space:nowrap}.lmb-fp-date:before{content:'·';margin-right:7px}
.lmb-fp-badge{flex-shrink:0;white-space:nowrap;font-size:10px;border-radius:4px;padding:2px 4px;background:#41523b;color:#c8d9bc}
.lmb-fp-preview{padding:18px 24px;overflow:auto;min-width:0;background:var(--background-secondary);display:flex;flex-direction:column;scrollbar-width:thin}
.lmb-fp-preview-top{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--text-muted)}
.lmb-fp-preview-top button{font-size:12px;box-shadow:none;background:var(--background-primary);color:var(--fp-accent)}
.lmb-fp-preview h3{font-size:20px;line-height:1.45;margin:16px 0 6px;overflow-wrap:anywhere}
.lmb-fp-preview-path{font-size:11px;color:var(--text-muted);overflow-wrap:anywhere;margin-bottom:16px}
.lmb-fp-content{border:1px solid var(--background-modifier-border);background:var(--background-primary);border-radius:10px;padding:20px;overflow:auto;min-height:180px;flex:1;scrollbar-width:thin;font-size:14px;line-height:1.65}
.lmb-fp-content img{max-width:100%;height:auto;display:block;margin:auto}.lmb-fp-content.is-pdf{padding:12px;background:var(--background-primary-alt);display:flex;flex-direction:column;overflow:hidden}
.lmb-fp-content.markdown-rendered>*{user-select:text}.lmb-fp-content.markdown-rendered pre{white-space:pre-wrap}.lmb-fp-content.markdown-rendered table{font-size:12px}
.lmb-fp-pdf-nav{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;font-size:12px;color:var(--text-muted);flex-shrink:0}
.lmb-fp-pdf-nav button{font-size:11px;padding:4px 8px;height:auto;box-shadow:none}.lmb-fp-pdf-stage{flex:1;min-height:0;display:flex;justify-content:center;align-items:center}.lmb-fp-pdf-stage canvas,.lmb-fp-pdf-stage img{display:block;width:100%;height:100%;object-fit:contain;background:transparent;filter:drop-shadow(0 4px 8px #0003)}
.lmb-fp-related-title{font-size:12px;color:var(--text-muted);margin:17px 0 9px}.lmb-fp-related{display:flex;flex-direction:column;gap:7px;max-height:160px;overflow:auto;flex-shrink:0}
.lmb-fp-related button{display:flex;flex-direction:column;align-items:flex-start;text-align:left;white-space:normal;height:auto;gap:5px;padding:10px 13px;background:var(--background-primary);border:1px solid var(--background-modifier-border);box-shadow:none;border-radius:8px}
.lmb-fp-related button>span{font-size:13px;overflow-wrap:anywhere}.lmb-fp-related small{font-size:10px;color:var(--text-muted)}
.lmb-fp-empty{padding:30px 12px;text-align:center;color:var(--text-muted);font-size:13px;line-height:1.8}.lmb-fp-more{display:block;margin:12px auto;box-shadow:none;font-size:12px}
.lmb-fp-footer{display:flex;gap:22px;flex-wrap:wrap;padding:14px 2px;border-top:1px solid var(--background-modifier-border);font-size:11px;color:var(--text-muted);flex-shrink:0}.lmb-fp-footer>span{display:flex;gap:7px;align-items:center}.lmb-fp-footer kbd{font-size:10px;background:var(--background-secondary);border-radius:4px;padding:3px 6px;box-shadow:none}
@media(max-width:760px){.modal.lmb-file-picker{padding:18px 14px 0;width:97vw;max-width:97vw;height:94vh;max-height:94vh}.lmb-fp-body{grid-template-columns:1fr;overflow:auto;display:flex;flex-direction:column}.lmb-fp-left{min-height:210px;flex:1;border-right:0;padding:10px}.lmb-fp-preview{min-height:270px;flex:1;border-top:1px solid var(--background-modifier-border);padding:14px}.lmb-fp-preview h3{font-size:16px}.lmb-fp-footer{gap:10px}.lmb-fp-filters{gap:2px}.lmb-fp-filters button{padding:5px 8px}.lmb-fp-folder{max-width:100%;width:100%;margin-top:7px}.lmb-fp-content{min-height:140px}}
`;
