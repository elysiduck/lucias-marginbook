/* 21-pure-layout —— 父子吸附/组居中/首连锁定/改挂侧/重居中（纯函数，可单测） */

/**
 * 从候选节点里挑出「新卡落下时压住」的父节点 —— v0.4.3 多信号判定（修复识别率低）：
 *   ① 落点角命中：新卡左上角（≈鼠标松手点，Obsidian drop 的锚点）落在目标矩形内；
 *   ② 中心命中：新卡中心落在目标矩形内；
 *   ③ 面积命中：相交面积 ≥ 两卡中**较小者**面积的 threshold
 *      （旧版只算新卡面积——大新卡压小目标时占比天然很小 → 漏判的主因）。
 * 任一信号命中即候选，多候选取相交面积比最大者。group 是容器语义，不劫持。
 */
function lmbPickDropParent(newNode, otherNodes, threshold = 0.2) {
  let best = null, bestRatio = 0;
  const nw = newNode.width, nh = newNode.height;
  const ncx = newNode.x + nw / 2, ncy = newNode.y + nh / 2;
  for (const n of otherNodes || []) {
    if (!n || n.id === newNode.id || n.type === "group") continue;
    const ox = Math.min(newNode.x + nw, n.x + n.width) - Math.max(newNode.x, n.x);
    const oy = Math.min(newNode.y + nh, n.y + n.height) - Math.max(newNode.y, n.y);
    const ratio = (ox > 0 && oy > 0)
      ? (ox * oy) / Math.max(1, Math.min(nw * nh, n.width * n.height))
      : 0;
    const cornerIn = newNode.x >= n.x && newNode.x <= n.x + n.width &&
                     newNode.y >= n.y && newNode.y <= n.y + n.height;
    const centerIn = ncx >= n.x && ncx <= n.x + n.width &&
                     ncy >= n.y && ncy <= n.y + n.height;
    if ((cornerIn || centerIn || ratio >= threshold) && ratio > bestRatio) {
      bestRatio = ratio; best = n;
    }
  }
  return best ? { node: best, ratio: bestRatio } : null;
}

/**
 * Build a lightweight grid index for overlap/containment lookups.
 * Canvas auto-linking only needs nodes whose rectangles share at least one grid
 * cell with the moved node; checking every node made bulk imports quadratic.
 */
function lmbBuildSpatialIndex(nodes, cellSize = 512) {
  const size = Math.max(64, Number(cellSize) || 512);
  const buckets = new Map();
  const overflow = [];
  const key = (x, y) => x + "," + y;
  const cellsFor = (node) => {
    const x = Number(node && node.x) || 0, y = Number(node && node.y) || 0;
    const w = Math.max(0, Number(node && node.width) || 0);
    const h = Math.max(0, Number(node && node.height) || 0);
    const x0 = Math.floor(x / size), y0 = Math.floor(y / size);
    const x1 = Math.floor((x + Math.max(1, w) - 0.001) / size);
    const y1 = Math.floor((y + Math.max(1, h) - 0.001) / size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) return null;
    const out = [];
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) out.push(key(cx, cy));
    return out;
  };
  for (const node of nodes || []) {
    if (!node || node.type === "group") continue;
    const cells = cellsFor(node);
    if (!cells) { overflow.push(node); continue; }
    for (const cell of cells) {
      if (!buckets.has(cell)) buckets.set(cell, []);
      buckets.get(cell).push(node);
    }
  }
  return {
    query(node) {
      const cells = cellsFor(node);
      if (!cells) return (nodes || []).filter((n) => n && n.type !== "group" && n.id !== node.id);
      const seen = new Set(), out = [];
      const add = (candidate) => {
        if (!candidate || candidate.id === node.id || seen.has(candidate.id)) return;
        seen.add(candidate.id); out.push(candidate);
      };
      for (const cell of cells) for (const candidate of buckets.get(cell) || []) add(candidate);
      for (const candidate of overflow) add(candidate);
      return out;
    }
  };
}
/**
 * 子卡吸附到父卡旁边 —— v0.4.4 四方向择位（修复「长龙」问题）：
 *   按落点相对方位选首选面；首选面被已占位节点（含先吸附的兄弟卡）占据时，
 *   依次换面（下 → 右 → 上 → 左，首选优先），四面全占才沿父卡右侧级联兜底。
 *   效果：往中间卡上拖子卡 → 子卡贴在该卡的空面上（通常是正下方），
 *   不再被「一路向右推」甩到队尾形成长龙。越出画布负区的面自动翻转到对侧。
 */
function lmbSnapChildPosition(parent, child, gap = 30, occupied = []) {
  const pcx = parent.x + parent.width / 2, pcy = parent.y + parent.height / 2;
  const ccx = child.x + child.width / 2, ccy = child.y + child.height / 2;
  const dx = ccx - pcx, dy = ccy - pcy;
  const midY = Math.max(0, parent.y + (parent.height - child.height) / 2);
  const midX = Math.max(0, parent.x + (parent.width - child.width) / 2);
  // 四方向候选；负区一面翻转到对侧
  const cand = {
    right:  { fromSide: "right",  toSide: "left",   x: parent.x + parent.width + gap, y: midY },
    bottom: { fromSide: "bottom", toSide: "top",    x: midX, y: parent.y + parent.height + gap },
    left:   { fromSide: "left",   toSide: "right",  x: parent.x - child.width - gap, y: midY },
    top:    { fromSide: "top",    toSide: "bottom", x: midX, y: parent.y - child.height - gap }
  };
  if (cand.left.x < 0) cand.left = { ...cand.right };
  if (cand.top.y < 0) cand.top = { ...cand.bottom };

  // 择面顺序：首选方位优先，其后 下 → 右 → 上 → 左（去重）
  const horiz = Math.abs(dx) >= Math.abs(dy);
  const pref = horiz ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top");
  const order = [];
  for (const s of [pref, "bottom", "right", "top", "left"]) {
    if (!order.includes(s)) order.push(s);
  }

  const hits = (c) => {
    const m = gap * 0.5;
    for (const o of occupied) {
      if (!o || o.id === child.id) continue;
      if (c.x < o.x + o.width + m && c.x + child.width + m > o.x &&
          c.y < o.y + o.height + m && c.y + child.height + m > o.y) return o;
    }
    return null;
  };
  for (const s of order) {
    if (!hits(cand[s])) return cand[s];
  }

  // 四面全占 → 兜底：沿父卡右侧向右级联（旧行为，guard 防死循环）
  let x = cand.right.x, guard = 0, blocker = hits(cand.right);
  while (blocker && guard++ < 24) {
    x = blocker.x + blocker.width + gap;
    if (x < 0) break;
    blocker = hits({ ...cand.right, x });
  }
  return { fromSide: "right", toSide: "left", x: Math.round(x), y: Math.round(cand.right.y) };
}
/**
 * v0.7.3：自动边的存活判定（纯函数，便于测试）。
 *   ⚠️ 绝不能按「端点是否重叠」判定 —— lmbLayoutGroup 排布的目的就是让子卡不再遮挡父卡，
 *   正常排布后父子必然不重叠；按重叠判定会把刚建的边自己删掉（v0.7.1「连线自动消失」回归）。
 *   当前规则：只有端点节点仍存在才保留；换父由调用方在新建边前显式移除旧的自动父边。
 */
function lmbAutoEdgeAlive(edge, byId) {
  if (!edge || !edge.fromNode || !edge.toNode) return false;
  return !!(byId.get(edge.fromNode) && byId.get(edge.toNode));
}
/**
 * v0.7.3：找出某张子卡当前的自动父边（用于「换父」时先摘掉旧的，避免同一张卡挂两条自动父子线）。
 *   v0.11.1 兜底：当 sidecar 缺记录时（典型场景：instantAttach 早期 path2 还没拿到，
 *   sidecar 漏登记；或在持久化档加载失败时），从 edges 里按 id 命名规范「e<base36>」
 *   直接兜底识别 —— 这是一贯的自动边命名规则，绝不与 Obsidian 自动边或用户手动边
 *   冲突（Obsidian 自动边通常是 16/32 位 hex，按 /e[0-9a-f]{8,}/ 排除）。
 *   返回 null = 都不是（手动边或孤儿边）。
 *   返回 { edge, reversed }：reversed=true 表示边方向是 child→parent（少见，但写法上要兜底）；
 *   .fromNode/.fromSide 取自 edge.reversed ? toNode 与 toSide : fromNode 与 fromSide。
 */
function lmbAutoParentEdgeOf(childId, edges, sidecar) {
  for (const ed of edges || []) {
    if (!ed || !ed.fromNode || !ed.toNode) continue;
    if (ed.toNode !== childId && ed.fromNode !== childId) continue;
    const reversed = ed.fromNode === childId;
    if (sidecar && sidecar.has(ed.id)) return { edge: ed, reversed };
    // v0.11.1 兜底：sidecar 没记录但 id 形如本插件自动边命名也认
    if (typeof ed.id === "string" && /^e[0-9a-z]+$/.test(ed.id)
        && !/^e[0-9a-f]{8,}$/i.test(ed.id)) {
      return { edge: ed, reversed };
    }
  }
  return null;
}
/**
 * v0.6.0：由 child 当前中心相对 parent 中心，判定 child 在 parent 的哪一侧。
 *   主轴优先（横向 |dx| ≥ |dy| → right/left，否则 top/bottom），与 snapChild 选面规则一致。
 */
function lmbSideOf(child, parent) {
  const dx = (child.x + (child.width || 0) / 2) - (parent.x + parent.width / 2);
  const dy = (child.y + (child.height || 0) / 2) - (parent.y + parent.height / 2);
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top");
}
/**
 * v0.6.0：父→子 edge 的两端 side 标识（用于 SVG 连线端点）。
 */
function lmbSideEnds(side) {
  if (side === "right") return { fromSide: "right", toSide: "left" };
  if (side === "left") return { fromSide: "left", toSide: "right" };
  if (side === "top") return { fromSide: "top", toSide: "bottom" };
  return { fromSide: "bottom", toSide: "top" }; // bottom
}
/**
 * v0.11.1：side 取反。edge.fromSide 是「from 节点」视角的连出方向，
 *   当 from 是子不是父时（reversed 边方向），需要翻一次得到父视角。
 *   未知 side 原样返回（防御：旧数据可能缺字段）。
 */
function lmbSideFlip(side) {
  if (side === "top") return "bottom";
  if (side === "bottom") return "top";
  if (side === "left") return "right";
  if (side === "right") return "left";
  return side;
}
/**
 * v0.6.0：从 edges 中导出指定父卡的所有子卡，按它们相对父卡的位置分组（right/left/top/bottom）。
 *   用法：拿到 kidsBySide.get(side) 后加上新子卡，整组调用 lmbLayoutGroup。
 */
function lmbGroupBySide(parent, nodes, edges, nodeById) {
  const m = new Map();
  const byId = nodeById || new Map((nodes || []).filter((n) => n && n.id).map((n) => [n.id, n]));
  for (const e of edges || []) {
    let childId = null;
    if (e.fromNode === parent.id) childId = e.toNode;
    else if (e.toNode === parent.id) childId = e.fromNode;
    if (!childId) continue;
    const child = byId.get(childId);
    if (!child) continue;
    const side = lmbSideOf(child, parent);
    if (!m.has(side)) m.set(side, []);
    m.get(side).push(child);
  }
  return m;
}
/**
 * v0.6.0：同侧多子卡组居中布局 —— 修复「不同高度/宽度导致互相压住」的 bug。
 * v0.9.3：不再拉伸子卡尺寸（用户要求：把所有卡片拉成一样高/宽没有必要），
 *   改为「贴边对齐 + 组居中」：
 *   - 竖列（right/left）：保留各自宽高，左边贴齐（right）/右边贴齐（left），
 *     整列以父卡竖直中心为对称轴依次堆叠；
 *   - 横排（bottom/top）：保留各自宽高，顶边贴齐（bottom）/底边贴齐（top），
 *     整行以父卡水平中心为对称轴依次排开。
 *   效果：新增下方/右侧的卡时，整组自动重新居中，不会因尺寸不齐互相压住，
 *   且每张卡保持自己的自然大小。
 */
function lmbLayoutGroup(parent, kids, side, gap = 30) {
  if (!kids || !kids.length) return;
  const vertical = (side === "right" || side === "left");
  // ① 组居中：竖列同贴边 x + 整列竖直居中父卡；横排同贴边 y + 整行水平居中父卡
  if (vertical) {
    const totalH = kids.reduce((s, k) => s + (k.height || 0), 0) + gap * (kids.length - 1);
    const axisY = parent.y + parent.height / 2;
    let y = axisY - totalH / 2;
    for (const k of kids) {
      // right：各卡左边贴齐同一条 x；left：各卡右边贴齐（x 随卡宽各自退让）
      const x = side === "right"
        ? parent.x + parent.width + gap
        : parent.x - gap - (k.width || 0);
      k.x = Math.round(x);
      k.y = Math.round(y);
      y += (k.height || 0) + gap;
    }
  } else {
    const totalW = kids.reduce((s, k) => s + (k.width || 0), 0) + gap * (kids.length - 1);
    const axisX = parent.x + parent.width / 2;
    let x = axisX - totalW / 2;
    for (const k of kids) {
      // bottom：各卡顶边贴齐同一条 y；top：各卡底边贴齐（y 随卡高各自退让）
      const y = side === "bottom"
        ? parent.y + parent.height + gap
        : parent.y - gap - (k.height || 0);
      k.x = Math.round(x);
      k.y = Math.round(y);
      x += (k.width || 0) + gap;
    }
  }
}

/**
 * 按有向连线（fromNode=父，toNode=子）平移一组被拖动卡片的全部后代。
 * 多选拖动时，显式移动的卡片不再被祖先重复平移；环形连线也只访问一次。
 * @returns {number} 实际被联动平移的卡片数
 */
function lmbMoveDescendants(nodes, edges, movements) {
  const byId = new Map((nodes || []).filter((n) => n && n.id).map((n) => [n.id, n]));
  const children = new Map();
  for (const edge of edges || []) {
    if (!edge || !byId.has(edge.fromNode) || !byId.has(edge.toNode) || edge.fromNode === edge.toNode) continue;
    if (!children.has(edge.fromNode)) children.set(edge.fromNode, []);
    children.get(edge.fromNode).push(edge.toNode);
  }
  const roots = (movements || []).filter((m) => m && byId.has(m.id)
    && Number.isFinite(m.dx) && Number.isFinite(m.dy) && (m.dx !== 0 || m.dy !== 0));
  const explicit = new Set(roots.map((m) => m.id));
  const shifted = new Set();
  for (const move of roots) {
    const seen = new Set([move.id]);
    const queue = [...(children.get(move.id) || [])];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const childId of children.get(id) || []) queue.push(childId);
      if (explicit.has(id) || shifted.has(id)) continue;
      const node = byId.get(id);
      if (!node || node.type === "group") continue;
      node.x = Math.round((Number(node.x) || 0) + move.dx);
      node.y = Math.round((Number(node.y) || 0) + move.dy);
      shifted.add(id);
    }
  }
  return shifted.size;
}

/** v0.19：按父子边把一棵树排成左→右或上→下的阅读树；无环保护。 */
function lmbLayoutTree(nodes, edges, direction = "right", gap = 60) {
  const byId = new Map((nodes || []).filter((n) => n && n.id && n.type !== "group").map((n) => [n.id, n]));
  const kids = new Map(), childIds = new Set();
  for (const e of edges || []) if (byId.has(e.fromNode) && byId.has(e.toNode)) {
    if (!kids.has(e.fromNode)) kids.set(e.fromNode, []);
    kids.get(e.fromNode).push(e.toNode); childIds.add(e.toNode);
  }
  const roots = [...byId.keys()].filter((id) => !childIds.has(id));
  let cursor = 0;
  const walk = (id, depth, seen) => {
    if (seen.has(id)) return 0; seen.add(id);
    const node = byId.get(id), children = kids.get(id) || [];
    let span = 0;
    for (const child of children) span += walk(child, depth + 1, seen) + gap;
    span = Math.max(span - (children.length ? gap : 0), direction === "down" ? (node.width || 200) : (node.height || 120));
    if (direction === "down") { node.x = Math.round(cursor + (span - (node.width || 200)) / 2); node.y = Math.round(depth * ((node.height || 120) + gap)); }
    else { node.x = Math.round(depth * ((node.width || 240) + gap)); node.y = Math.round(cursor + (span - (node.height || 120)) / 2); }
    cursor += span + gap; return span;
  };
  for (const id of roots) walk(id, 0, new Set());
  return roots.length;
}
/* ==================== v0.11.0：首连锁定 / 改挂侧 / 尺寸重居中 ==================== */

/**
 * v0.11.0（纯函数）：决定 nn 落到 parent 上时的自动连线动作。
 *   R3 首连锁定：一张卡最多一条「自动」边——已有自动父边且父不是 parent → skip，
 *   不再换父、不再自动新建（换父已移除；想换父请手动删线后重拖，手动边不参与锁定）。
 *   R4 改挂侧：nn 与 parent 之间已有边（自动或手动）→ reside：按落点方位改边端点 + 两侧组重排。
 *   create：nn 还没有任何自动边 → 首次自动建线（此后即锁定）。
 *   v0.11.1 新增 recenter：sizeOnly=true（由调用方标识「只是尺寸变化、位置没动」）
 *   → 保留原侧不翻转，专门修复 fitNode 把卡撑大后 lmbSideOf CURRENT 算出相反侧、
 *   导致 lmbApplyReside 把「下」翻成「右」的对齐 bug。
 * 返回：
 *   { op: "skip" }                                — 不动作
 *   { op: "reside", edge, oldSide, newSide }      — 已有连线，按当前落点改挂侧
 *   { op: "recenter", edge, side }                — 尺寸变化，保留原侧重新居中（v0.11.1）
 *   { op: "create", side }                        — 首次自动建线
 */
function lmbPlanAutoLink(nn, parent, edges, sidecar, opts) {
  if (!nn || !parent || nn.id === parent.id) return { op: "skip" };
  const eds = Array.isArray(edges) ? edges : [];
  const auto = lmbAutoParentEdgeOf(nn.id, eds, sidecar);
  if (auto) {
    // R3：首连锁定——已有自动父边且父不是本次压中的卡 → skip
    // 「父」就是「非 nn 那端」：reversed 时 nn=fromNode 父=toNode，否则父=fromNode
    const parentEnd = auto.reversed ? auto.edge.toNode : auto.edge.fromNode;
    if (parentEnd !== parent.id) return { op: "skip" };
  }
  let linkEdge = null;
  let linkEdgeReversed = false;
  for (const ed of eds) {
    if (!ed || !ed.fromNode || !ed.toNode) continue;
    if (ed.fromNode === parent.id && ed.toNode === nn.id) { linkEdge = ed; linkEdgeReversed = false; break; }
    if (ed.fromNode === nn.id && ed.toNode === parent.id) { linkEdge = ed; linkEdgeReversed = true; break; }
  }
  if (linkEdge) {
    const parentFacingSide = linkEdgeReversed
      ? lmbSideFlip(linkEdge.toSide)
      : linkEdge.fromSide;
    const oldSide = parentFacingSide || (linkEdgeReversed ? linkEdge.toSide : linkEdge.fromSide);

    const sizeOnly = !!(opts && opts.sizeOnly);
    // v0.11.1 sizeOnly：nn 是 fitNode 撑大的（位置没动），保留原侧避免翻转
    if (sizeOnly) {
      return { op: "recenter", edge: linkEdge, side: oldSide, oldSide };
    }
    return { op: "reside", edge: linkEdge, oldSide: oldSide, newSide: lmbSideOf(nn, parent) };
  }
  if (auto) return { op: "skip" }; // 防御：auto 必然对应 linkEdge
  return { op: "create", side: lmbSideOf(nn, parent) };
}
/**
 * v0.11.0（纯函数，原地改 edge + 坐标）：执行「改挂侧」。
 *   ① edge 两端 side 改为新侧（保持 from/to 方向属性不变，只换端点标识）；
 *   ② 旧侧组（不含 nn）整组重排 —— nn 离开后该侧重新居中；
 *   ③ 新侧组（含 nn）整组 lmbLayoutGroup —— 组居中保证单子卡必在父卡横/纵轴上；
 *      oldSide === newSide 时只做③，等价「拖回原位重新对齐」，顺带修复手动拖歪。
 */
function lmbApplyReside(parent, nn, plan, nodes, edges) {
  const side = plan.newSide;
  const ends = lmbSideEnds(side);
  const ed = plan.edge;
  if (ed.fromNode === parent.id) { ed.fromSide = ends.fromSide; ed.toSide = ends.toSide; }
  else { ed.fromSide = ends.toSide; ed.toSide = ends.fromSide; }
  const others = (edges || []).filter((e) => e !== ed);
  const kidsBySide = lmbGroupBySide(parent, nodes, others);
  const strip = (arr) => (arr || []).filter((k) => k && k.id !== nn.id);
  if (plan.oldSide !== side) {
    const oldGroup = strip(kidsBySide.get(plan.oldSide));
    if (oldGroup.length) lmbLayoutGroup(parent, oldGroup, plan.oldSide, 30);
  }
  const newGroup = [...strip(kidsBySide.get(side)), nn];
  lmbLayoutGroup(parent, newGroup, side, 30);
  return { side, ends };
}
/**
 * v0.11.0（纯函数，原地改坐标）：尺寸变化后的组内重新居中 —— R1「乱放」的根因修复。
 *   根因链：instantAttach 用卡片落下时的默认小尺寸做组居中 → fitNode 随后把卡撑到
 *   真实内容尺寸 → 高度变了但 y 不变 → 中心偏出父卡横/纵轴（截图里的乱放）。
 *   本函数在 fitNode 之后调用：找 nn 的【自动】父边 → 定侧 → 该侧组（含 nn）整组重排，
 *   用新尺寸重新居中。只认自动边：手动连线的卡是用户亲手摆的，不自动挪。
 * 返回 true = 找到自动父边且至少移动了一个坐标。
 */
function lmbRecenterNode(nn, nodes, edges, sidecar) {
  if (!nn || !nodes || !edges) return false;
  // v0.11.1：lmbAutoParentEdgeOf 返回 { edge, reversed }；兜底识别 e<base36> 命名
  const find = lmbAutoParentEdgeOf(nn.id, edges, sidecar || new Set());
  if (!find) return false;
  const auto = find.edge;
  // 父 id：
  //   reversed=true  ⇒ 边方向是 nn→parent（auto.fromNode===nn.id，auto.toNode 是 parent）
  //   reversed=false ⇒ 边方向是 parent→nn（auto.fromNode 是 parent，auto.toNode===nn.id）
  // 一言以蔽之：parentId = find.reversed ? auto.toNode : auto.fromNode
  const parentId = find.reversed ? auto.toNode : auto.fromNode;
  const parent = nodes.find((n) => n && n.id === parentId);
  if (!parent || parent.type === "group") return false;
  // side：fromSide 是「父端」对子方向的标识。原始代码假设 fromNode=parent，读 auto.fromSide；
  //   reversed 时 fromNode=nn（即「子」端），所以 fromSide 不再是父视角，需要翻一次。
  const side = find.reversed ? lmbSideFlip(auto.fromSide) : (auto.fromSide || lmbSideOf(nn, parent));
  const group = [];
  for (const e of edges) {
    if (!e || e === auto) continue;
    let cid = null;
    if (e.fromNode === parentId) cid = e.toNode;
    else if (e.toNode === parentId) cid = e.fromNode;
    if (!cid || cid === nn.id) continue;
    const child = nodes.find((n) => n && n.id === cid);
    if (child && child.type !== "group" && lmbSideOf(child, parent) === side) group.push(child);
  }
  group.push(nn);
  const before = group.map((k) => k.x + ":" + k.y).join("|");
  lmbLayoutGroup(parent, group, side, 30);
  const after = group.map((k) => k.x + ":" + k.y).join("|");
  return before !== after;
}
