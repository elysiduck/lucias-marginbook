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
  imageExcerptMarkStyle: "dashed",
  autoCleanOnDelete: true,
  moveDescendantsWithParent: false,
  nodeViews: {},
  excerptViews: {},
  quickExcerpts: {},
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
  inkToolbarCollapsed: false,
  inkAnnotations: {}
});

class LmbSettingsStore {
  constructor(plugin) {
    this.plugin = plugin;
  }

  async load() {
    const settings = Object.assign({}, LMB_DEFAULT_SETTINGS, await this.plugin.loadData());
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
      imageExcerptMarkStyle: settings.imageExcerptMarkStyle === "highlight" ? "highlight" : "dashed",
      autoCleanOnDelete: settings.autoCleanOnDelete === true,
      moveDescendantsWithParent: settings.moveDescendantsWithParent === true,
      nodeViews: settings.nodeViews && typeof settings.nodeViews === "object" ? settings.nodeViews : {},
      excerptViews: settings.excerptViews && typeof settings.excerptViews === "object" ? settings.excerptViews : {},
      quickExcerpts: settings.quickExcerpts && typeof settings.quickExcerpts === "object" ? settings.quickExcerpts : {},
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
      inkToolbarCollapsed: !!settings.inkToolbarCollapsed,
      inkAnnotations: this.plugin._lmbInkSidecarReady ? {} :
        (this.plugin._lmbInkDocs && typeof this.plugin._lmbInkDocs === "object" ? this.plugin._lmbInkDocs :
          (settings.inkAnnotations && typeof settings.inkAnnotations === "object" ? settings.inkAnnotations : {}))
    };
    if (state.autoSize.size) {
      obj.autoSizes = Object.fromEntries(Array.from(state.autoSize, ([path, store]) => [path, Array.from(store)]));
    }
    if (state.imgDims.size) obj.imgDims = Object.fromEntries(state.imgDims);
    const positions = this._nonEmptyEntries(state.canvasPositions);
    if (positions) obj.canvasPositions = positions;
    const edges = this._nonEmptyEntries(state.autoEdges);
    if (edges) obj.autoEdges = edges;
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
