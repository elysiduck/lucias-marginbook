/* One resolver for toolbar creation, Canvas synchronization and screenshots. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  lmbStoragePaths(pdfFile, canvasPath) {
    const settings = this.settings || {};
    const path = String(typeof pdfFile === "string" ? pdfFile : pdfFile && pdfFile.path || "").replace(/\\/g, "/");
    const base = path.split("/").pop().replace(/\.pdf$/i, "") || pdfFile && pdfFile.basename;
    if (!base) throw new Error("缺少 PDF 文件路径");
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const central = settings.storageLayout === "central";
    if (!central) return { folder: dir, md: normalizePath((dir ? dir + "/" : "") + base + "-摘录.md"),
      canvas: normalizePath((dir ? dir + "/" : "") + base + ".canvas"), central: false };
    const clean = value => {
      const parts = String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      if (parts.some(part => part === "." || part === ".." || part.startsWith(".") || /[:*?"<>|]/.test(part))) throw new Error("MarginBook 目录无效");
      return parts.join("/");
    };
    const root = clean(settings.storageRoot || "Lucia's Marginbook");
    const source = clean(settings.pdfSourceRoot || "Books/pdf书籍");
    const relative = dir === source ? "" : dir.startsWith(source + "/") ? dir.slice(source.length + 1) : dir;
    const folder = normalizePath([root, relative, base].filter(Boolean).join("/"));
    const binding = settings.storageBindings && settings.storageBindings[path] || {};
    const bound = (candidate, fallback) => {
      if (!candidate) return fallback;
      const value = clean(candidate);
      if (!value.startsWith(root + "/")) throw new Error("MarginBook 文件关联超出工作区");
      return value;
    };
    const canvasMd = canvasPath && binding.canvasDocuments && binding.canvasDocuments[canvasPath];
    return { folder, md: bound(canvasMd || binding.md, folder + "/" + base + "-摘录.md"),
      canvas: bound(binding.canvas, folder + "/" + base + ".canvas"), attachments: folder + "/附件", central: true };
  },

  async lmbEnsureStorageParent(path) {
    const parts = String(path || "").split("/"); parts.pop();
    let current = "";
    for (const part of parts.filter(Boolean)) {
      current = current ? current + "/" + part : part;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try { await this.app.vault.createFolder(current); }
      catch (err) { if (!this.app.vault.getAbstractFileByPath(current)) throw err; }
    }
  }
});
