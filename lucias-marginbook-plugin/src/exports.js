module.exports = LuciasMarginBookPlugin;
module.exports.__test = {
  lmbShouldReshowSelection, lmbMeasureRenderedContent, lmbMeasureNaturalCard,
  lmbVerticalOverflow, lmbHeightAfterOverflow, lmbFinalizeCardHeight, EX_ID_RE,
  lmbRectsOverlapRatio, lmbPickDropParent, lmbBuildSpatialIndex, lmbSnapChildPosition, lmbBuildTree,
  lmbDiffCanvasNodes, lmbSideOf, lmbSideEnds, lmbLayoutGroup, lmbGroupBySide,
  lmbAutoEdgeAlive, lmbAutoParentEdgeOf,
  lmbMoveDescendants,
  lmbLayoutTree,
  // PDF 手写：采样、命中、套索与版本化存储文件名
  LMB_INK_SCHEMA_VERSION, LMB_INK_HISTORY_LIMIT,
  lmbInkBounds, lmbInkObjectHit, lmbInkObjectsInLasso, lmbInkIsStylusInput, lmbInkTouchPointEvent,
  lmbInkAppendSamples, lmbInkSimplifyPoints, lmbInkSegmentWidth, lmbInkFileKey,
  lmbInkBuildPatch, lmbInkApplyPatch, lmbInkMergePages,
  lmbInkEraseFragments, lmbInkIsTextInput,
  // v0.8.0：卡片补充描述
  lmbSplitNote, lmbJoinNote, lmbStripNote, lmbRenderedText,
  LMB_NOTE_START, LMB_NOTE_END,
  // P1：摘录索引层
  lmbParseExcerptDoc, LMB_LINK_RE, LMB_SEL_RE,
  lmbUnwrapExcerptCard,
  // v0.12.0：引用行 📖 化
  lmbBookLink, lmbRestoreRefDisplayName,
  // v0.11.0：首连锁定 / 改挂侧 / 尺寸重居中 + 独立评论
  lmbPlanAutoLink, lmbApplyReside, lmbRecenterNode,
  lmbSplitComment, lmbJoinComment, LMB_COMMENT_TYPE, LMB_COMMENT_CALLOUT_RE,
  // v0.12.1：工具栏宿主解析层（借鉴 editing-toolbar v4.1.1：规格表同源 + 兜底 + 缓存 + 显隐分级）
  LMB_VIEW_SPECS, lmbResolveToolbarAnchor, LmbDomCache, lmbSetToolbarVisibility,
  // v0.12.1：样式表（从 injectStyles 抽出，per-view-type 适配集中在 CSS 侧）
  LMB_STYLES,
  // v0.13.0：canvas 卡片悬浮操作栏（坐标换算 + 按钮可用性判定 + 轮询指纹）
  LMB_BAR_POLL_MS, LMB_BAR_GAP, LMB_BAR_MARGIN, LMB_BAR_SEL,
  lmbCalcBarPos, lmbPickBarActions, lmbBarSignature,
  lmbPlanDisconnect,
  // v0.13.8：悬浮栏结构版本（改按钮组成 / 事件绑定方式时必须 +1，触发旧浮层重建）
  LMB_BAR_VERSION
}; // 测试钩子（node 冒烟脚本用）
// 注：lmbParsePdfLink 是类方法（不依赖 this），测试走 PluginClass.prototype.lmbParsePdfLink

// v0.12.1：11-styles.js / 25-pure-toolbar.js 在拼接顺序上早于本文件，它们挂在
//   module.exports 上的 __lmbStyles / __lmbToolbar 会被第一行的
//   `module.exports = LuciasMarginBookPlugin` 覆盖掉，这里重新挂回去（供外部单测直取）。
if (typeof module !== "undefined" && module.exports) {
  module.exports.__lmbStyles = { LMB_STYLES };
  module.exports.__lmbToolbar = {
    LMB_VIEW_SPECS, lmbResolveToolbarAnchor, LmbDomCache, lmbSetToolbarVisibility,
  };
  module.exports.__lmbCanvasBar = {
    LMB_BAR_POLL_MS, LMB_BAR_GAP, LMB_BAR_MARGIN, LMB_BAR_SEL, LMB_BAR_VERSION,
    lmbCalcBarPos, lmbPickBarActions, lmbBarSignature,
  };
}
