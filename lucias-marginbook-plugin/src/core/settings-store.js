/* core/settings-store — defaults, migrations, and persistence shape */

const LMB_DEFAULT_SETTINGS = Object.freeze({
  debug: false,
  colorMap: "",
  noteCalloutType: "ppd-note",
  noteTitle: "补充描述",
  noteFoldByDefault: false,
  noteIntoSync: false,
  noteAutoBoxOnNew: false,
  commentAutoBoxOnNew: false,
  excerptCardWidth: 560,
  autoAttachScreenshot: true,
  excerptImageFolder: "附件/{pdf}",
  storageLayout: "central",
  storageRoot: "Lucia's Marginbook",
  pdfSourceRoot: "Books/pdf书籍",
  storageBindings: {},
  imageExcerptMarkStyle: "dashed",
  autoCleanOnDelete: true,
  moveDescendantsWithParent: false,
  nodeViews: {},
  excerptViews: {},
  quickExcerpts: {},
  pdfTextBlocks: {},
  excerptColors: {},
  notePlaceholderOffMigrated: false,
  commentBoxOffMigrated: false,
  naturalHeightV2Migrated: false,
  overflowHeightVerifiedMigrated: false,
  managedExcerptAssetsV1Migrated: false,
  inkSidecarV2Migrated: false,
  inkInputMode: "pen-mouse",
  inkPressureMode: "natural",
  inkLastTool: "pen",
  inkPenColor: "#e05252",
  inkPenWidth: 3,
  inkHighlighterColor: "#ffd84d",
  inkHighlighterWidth: 12,
  inkEraserSize: 18,
  inkEraserMode: "partial",
  inkEraserAutoReturn: true,
  inkToolbarCollapsed: false,
  inkAnnotations: {},
  inkExcerptLinks: {},
  inkLinkCounters: {}
});

class LmbSettingsStore {
  constructor(plugin) {
    this.plugin = plugin;
  }

  async load() {
    const saved = await this.plugin.loadData();
    const settings = Object.assign({}, LMB_DEFAULT_SETTINGS, saved);
    // Existing vaults retain their paths until an explicit, backed-up migration.
    if (saved && Object.keys(saved).length && !saved.storageLayout) settings.storageLayout = "legacy";
    let migrated = false;
    if (!settings.notePlaceholderOffMigrated) {
      settings.noteAutoBoxOnNew = false;
      settings.notePlaceholderOffMigrated = true;
      migrated = true;
    }
    if (!settings.commentBoxOffMigrated) {
      settings.commentAutoBoxOnNew = false;
      settings.commentBoxOffMigrated = true;
      migrated = true;
    }
    if (!settings.managedExcerptAssetsV1Migrated) {
      settings.excerptImageFolder = settings.excerptImageFolder || "附件/{pdf}";
      settings.autoCleanOnDelete = true;
      settings.managedExcerptAssetsV1Migrated = true;
      migrated = true;
    }
    return { settings, migrated };
  }

  serialize(settings, state) {
    const obj = {
      debug: !!settings.debug,
      recallDefault: !!settings.recallDefault,
      colorMap: settings.colorMap,
      noteCalloutType: settings.noteCalloutType,
      noteTitle: settings.noteTitle,
      noteFoldByDefault: !!settings.noteFoldByDefault,
      noteIntoSync: !!settings.noteIntoSync,
      noteAutoBoxOnNew: settings.noteAutoBoxOnNew !== false,
      commentAutoBoxOnNew: settings.commentAutoBoxOnNew === true,
      excerptCardWidth: Math.max(320, Math.min(800, Number(settings.excerptCardWidth) || 560)),
      autoAttachScreenshot: settings.autoAttachScreenshot !== false,
      excerptImageFolder: String(settings.excerptImageFolder || "附件/{pdf}"),
      storageLayout: settings.storageLayout === "central" ? "central" : "legacy",
      storageRoot: String(settings.storageRoot || "Lucia's Marginbook"),
      pdfSourceRoot: String(settings.pdfSourceRoot || "Books/pdf书籍"),
      storageBindings: settings.storageBindings || {},
      imageExcerptMarkStyle: settings.imageExcerptMarkStyle === "highlight" ? "highlight" : "dashed",
      autoCleanOnDelete: settings.autoCleanOnDelete === true,
      moveDescendantsWithParent: settings.moveDescendantsWithParent === true,
      nodeViews: settings.nodeViews && typeof settings.nodeViews === "object" ? settings.nodeViews : {},
      excerptViews: settings.excerptViews && typeof settings.excerptViews === "object" ? settings.excerptViews : {},
      quickExcerpts: settings.quickExcerpts && typeof settings.quickExcerpts === "object" ? settings.quickExcerpts : {},
      inkExcerptLinks: settings.inkExcerptLinks && typeof settings.inkExcerptLinks === "object" ? settings.inkExcerptLinks : {},
      inkLinkCounters: settings.inkLinkCounters && typeof settings.inkLinkCounters === "object" ? settings.inkLinkCounters : {},
      pdfTextBlocks: settings.pdfTextBlocks && typeof settings.pdfTextBlocks === "object" ? settings.pdfTextBlocks : {},
      excerptColors: settings.excerptColors && typeof settings.excerptColors === "object" ? settings.excerptColors : {},
      notePlaceholderOffMigrated: !!settings.notePlaceholderOffMigrated,
      commentBoxOffMigrated: !!settings.commentBoxOffMigrated,
      naturalHeightV2Migrated: !!settings.naturalHeightV2Migrated,
      overflowHeightVerifiedMigrated: !!settings.overflowHeightVerifiedMigrated,
      managedExcerptAssetsV1Migrated: !!settings.managedExcerptAssetsV1Migrated,
      inkSidecarV2Migrated: !!settings.inkSidecarV2Migrated,
      inkInputMode: settings.inkInputMode === "pen-only" ? "pen-only" : "pen-mouse",
      inkPressureMode: ["fixed", "natural", "fountain"].includes(settings.inkPressureMode) ? settings.inkPressureMode : "natural",
      inkLastTool: typeof settings.inkLastTool === "string" ? settings.inkLastTool : "pen",
      inkPenColor: String(settings.inkPenColor || "#e05252"),
      inkPenWidth: Math.max(1, Math.min(14, Number(settings.inkPenWidth) || 3)),
      inkHighlighterColor: String(settings.inkHighlighterColor || "#ffd84d"),
      inkHighlighterWidth: Math.max(4, Math.min(30, Number(settings.inkHighlighterWidth) || 12)),
      inkEraserSize: Math.max(8, Math.min(48, Number(settings.inkEraserSize) || 18)),
      inkEraserMode: settings.inkEraserMode === "stroke" ? "stroke" : "partial",
      inkEraserAutoReturn: settings.inkEraserAutoReturn !== false,
      inkToolbarCollapsed: !!settings.inkToolbarCollapsed,
      inkAnnotations: this.plugin._lmbInkSidecarReady ? {} :
        (this.plugin._lmbInkDocs && typeof this.plugin._lmbInkDocs === "object" ? this.plugin._lmbInkDocs :
          (settings.inkAnnotations && typeof settings.inkAnnotations === "object" ? settings.inkAnnotations : {}))
    };
    let runtime = this.plugin._lmbSerializedRuntimeCaches;
    if (!runtime || this.plugin._lmbRuntimeStateDirty) {
      runtime = {};
      if (state.autoSize.size) {
        runtime.autoSizes = Object.fromEntries(Array.from(state.autoSize, ([path, store]) => [path, Array.from(store)]));
      }
      if (state.imgDims.size) runtime.imgDims = Object.fromEntries(state.imgDims);
      const positions = this._nonEmptyEntries(state.canvasPositions);
      if (positions) runtime.canvasPositions = positions;
      const edges = this._nonEmptyEntries(state.autoEdges);
      if (edges) runtime.autoEdges = edges;
      this.plugin._lmbSerializedRuntimeCaches = runtime;
      this.plugin._lmbRuntimeStateDirty = false;
    }
    Object.assign(obj, runtime);
    return obj;
  }

  _nonEmptyEntries(source) {
    const result = {};
    for (const [path, values] of source || []) {
      if (values.size) result[path] = Array.from(values);
    }
    return Object.keys(result).length ? result : null;
  }
}
