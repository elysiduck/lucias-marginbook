/* core/runtime-state — owns mutable, session-scoped plugin state */

class LmbRuntimeState {
  constructor() {
    this.syncTimers = new Map();
    this.selfWritten = new Map();
    this.autoSize = new Map();
    this.imgDims = new Map();
    this.canvasPositions = new Map();
    this.autoEdges = new Map();
    this.nodeMeta = new Map();
    this.excerptIndex = new Map();
    this.indexMtime = new Map();
    this.excerptCanvasIndex = new Map();
    this.relatedCache = new Map();
  }

  /**
   * Expose stable compatibility aliases while controllers are incrementally
   * migrated away from direct fields on the Obsidian Plugin instance.
   */
  attach(plugin) {
    for (const key of Object.keys(this)) plugin[key] = this[key];
    return this;
  }
}
