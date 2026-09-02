module.exports = LuciasMarginBookPlugin;
module.exports.__test = {
  lmbShouldReshowSelection, EX_ID_RE,
  lmbRectsOverlapRatio, lmbPickDropParent, lmbSnapChildPosition, lmbBuildTree,
  lmbDiffCanvasNodes, lmbSideOf, lmbSideEnds, lmbLayoutGroup, lmbGroupBySide,
  lmbAutoEdgeAlive, lmbAutoParentEdgeOf,
  // v0.8.0：卡片补充描述
  lmbSplitNote, lmbJoinNote, lmbStripNote, lmbRenderedText,
  LMB_NOTE_START, LMB_NOTE_END,
  // P1：摘录索引层
  lmbParseExcerptDoc, LMB_LINK_RE, LMB_SEL_RE,
  // v0.11.0：首连锁定 / 改挂侧 / 尺寸重居中 + 独立评论
  lmbPlanAutoLink, lmbApplyReside, lmbRecenterNode,
  lmbSplitComment, lmbJoinComment, LMB_COMMENT_TYPE, LMB_COMMENT_CALLOUT_RE
}; // 测试钩子（node 冒烟脚本用）
// 注：lmbParsePdfLink 是类方法（不依赖 this），测试走 PluginClass.prototype.lmbParsePdfLink
