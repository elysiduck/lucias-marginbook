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
  autoAttachScreenshot: true,
  autoCleanOnDelete: false,
  notePlaceholderOffMigrated: false,
  commentBoxOffMigrated: false,
  naturalHeightV2Migrated: false,
  overflowHeightVerifiedMigrated: false
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
      autoAttachScreenshot: settings.autoAttachScreenshot !== false,
      autoCleanOnDelete: settings.autoCleanOnDelete === true,
      notePlaceholderOffMigrated: !!settings.notePlaceholderOffMigrated,
      commentBoxOffMigrated: !!settings.commentBoxOffMigrated,
      naturalHeightV2Migrated: !!settings.naturalHeightV2Migrated,
      overflowHeightVerifiedMigrated: !!settings.overflowHeightVerifiedMigrated
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
