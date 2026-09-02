/* 22-pure-tree —— 摘录树构建 / canvas 新卡 diff（纯函数） */

/**
 * 由 entries（已按页/画布序排好）+ parentOf（canvas 边导出的 childExId→parentExId）建树。
 * 父不在本组 / 自环 → 当根；环由渲染端 rendered 集合兜底，绝不死循环。
 */
function lmbBuildTree(entries, parentOf) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const children = new Map();
  const roots = [];
  for (const en of entries) {
    const p = (en.parentId && en.parentId !== en.id && byId.has(en.parentId)) ? en.parentId : null;
    if (p) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(en);
    } else {
      roots.push(en);
    }
  }
  return { roots, children };
}
/**
 * canvas 新卡识别（纯函数）：prevIds=null 表示该画布从未见过（插件加载后首扫或全新画布）
 * → 只建档不动作；否则 diff 出新落下的 ^ex 卡。
 * 注意：canvasSeen 已持久化到 data.json（v0.4.1 修复），重载后 prevIds 仍在，
 * 「重载后拖第一张卡」不再被 firstRun 吞掉——这是 v0.4.0「完全没效果」的必现根因。
 */
function lmbDiffCanvasNodes(prevIds, exNodes) {
  if (!prevIds) return { firstRun: true, newNodes: [] };
  return { firstRun: false, newNodes: exNodes.filter((n) => !prevIds.has(n.id)) };
}
