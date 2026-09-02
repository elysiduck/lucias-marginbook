/* 20-pure-interaction —— chip 重建把关（纯函数，可单测） */

/* ==================== v0.4.0：MN4 式「拖到节点上自动成为子节点」纯函数 ==================== */

/** 两矩形相交面积 / a 的面积（canvas 坐标：x,y 左上，y 向下） */
function lmbRectsOverlapRatio(a, b) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return 0;
  const areaA = a.w * a.h;
  return areaA > 0 ? (ox * oy) / areaA : 0;
}
