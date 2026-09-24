/* ============================================================
 * 26-pure-canvasbar —— canvas 卡片悬浮操作栏的纯计算层
 *   （坐标换算 / 按钮可用性判定 / 轮询指纹）
 * 修改注意：
 *   1. 本文件**不依赖 Obsidian API**（没有 require("obsidian")）。坐标一律是视口坐标
 *      （就是 getBoundingClientRect() 返回的那种），入参只用 plain object / string /
 *      number，**不要期待传进来的是真 DOM 元素**（离线单测传的是 mock）。
 *   2. 构建顺序由 build.config.js 显式声明，**顶层 const/function/class 共享同一 bundle
 *      作用域**，所以所有导出名统一 lmb / LMB_ 前缀，避免和别的片段撞名。
 *   3. 本层只出「算什么、往哪放、哪些按钮能点」的结论，**不碰 DOM、不读 canvas 实例**。
 *      真正的 DOM 挂载与事件绑定在 37-plugin-canvasbar.js（并行开发中）。
 *   4. 三个函数**一律吞异常、绝不 throw**：它们跑在 120ms 的 setInterval 里，
 *      抛一次就会打断整个轮询链（后续帧全没了），宁可这一帧画错位置也不能崩。
 * ============================================================ */

/* ==================== 悬浮栏基础常量 ====================
 * 三个功能（评论 / 跳转 / 切换视图）在 v0.11.0 ~ v0.11.3 都已实现，
 * 本文件只是把入口从「卡内」搬到「卡片上方的悬浮栏」，不新增业务逻辑。
 */
const LMB_BAR_POLL_MS = 800;      // 事件驱动后的低频兜底轮询（ms）
const LMB_BAR_GAP = 8;            // 悬浮栏与卡片边缘的间距（px）
const LMB_BAR_MARGIN = 4;         // 贴边时的安全留白（px）
const LMB_BAR_SEL = ".lmb-canvas-bar";  // 悬浮栏容器 class

// v0.13.8：悬浮栏**结构版本**。改浮动栏的按钮组成 / 事件绑定方式时**必须 +1**。
//   为什么需要它：重载插件时 Obsidian 只重新执行插件 JS，**workspace layout 与 canvas
//   leaf 的 DOM 不会重建**。而 lmbEnsureCanvasBarEl 是靠 className 幂等复用浮层的 ——
//   于是"旧版本创建的那颗浮层"会被新代码一直复用，它的按钮绑的是**旧版 click 回调**
//   （例如 v0.13.4 的 fit 按钮绑的是 `if (!c) return` 静默版）。
//   表现极其迷惑：代码明明改了、也重载了，行为却是老样子。
//   加版本号后，版本不匹配的浮层会被移除重建，保证用户手上的永远是"当前代码造的"浮层。
const LMB_BAR_VERSION = "v0.24.1";

/* LMB_BAR_POLL_MS 为什么是 800ms：
 *   - canvas **没有原生「选中变化」事件**。advanced-canvas 插件那个 `selection-changed`
 *     不是 Obsidian 原生 API，是它自己 monkey-patch canvas 内部方法造出来的；
 *     我们不依赖 advanced-canvas，所以只能轮询。
 *   - pointerup、active-leaf-change 已负责立即刷新；800ms 只兜底宿主未暴露的选中、平移与缩放变动，
 *     将常驻检查从每秒约 8 次降到约 1 次。
 *   - **一次轮询同时解决两件事**，这是选轮询而非监听的额外收益：
 *       ① 选中变化 → 要**重建按钮**（不同卡片能点的按钮不一样，见 lmbPickBarActions）
 *       ② 视口平移/缩放 → 要**重算位置**（卡片在屏幕上的位置变了，浮层要跟着走）
 *     监听方案得同时挂 selection-changed + 平移 + 缩放三套事件，还容易漏；
 *     轮询一个定时器全包，逻辑只有一条路径。
 */

/* ---- 内部小工具：取有限数，非数字/NaN/Infinity 一律退回默认值 ----
 * 名字带 lmb 前缀（拼接作用域要求），不导出到 __test。 */
function lmbBarNum(v, dflt) {
  const n = (typeof v === "number") ? v : parseFloat(v);
  return (typeof n === "number" && isFinite(n)) ? n : dflt;
}

/* ---- 内部小工具：格式化指纹里的浮点数，固定 2 位小数 ---- */
function lmbBarFix2(v) {
  return lmbBarNum(v, 0).toFixed(2);
}

/**
 * 计算悬浮栏在挂载容器内的位置（纯函数，绝不抛异常）。
 *
 * ==================== 为什么浮层要挂在 wrapper 上，而不是卡片上 ====================
 * 实测 Obsidian canvas typings + 翻 DOM 得出的结论（写下来免得后人再踩一遍）：
 *   - canvas 的缩放 `transform: scale(...)` 是加在 **`.canvas`** 元素上的；
 *   - 而 `canvas.wrapperEl`（即 **`.canvas-wrapper`**）是 `.canvas` 的**父级**，
 *     它自己**不参与**这个 scale 变换。
 * 所以浮层挂到卡片（`.canvas-node`）里的话，按钮会跟着画布一起被缩放：
 * 用户把画布缩到 30%，按钮就变成蚂蚁大小点不中；放大到 300%，按钮又蠢大。
 * 挂在 wrapperEl 上，浮层的 px 尺寸恒定，**按钮大小永远不变**，
 * 代价只是每帧要把卡片 rect 换算成 wrapper 内相对坐标（本函数干的就是这件事）。
 * ===============================================================================
 *
 * 算法（顺序不能改）：
 *   1. 坐标系换算：nodeRect / wrapperRect 都在视口坐标系，
 *      浮层要定位在 wrapper 内部（position:absolute 相对 wrapper），故：
 *          relLeft = nodeRect.left  - wrapperRect.left
 *          relTop  = nodeRect.top   - wrapperRect.top
 *   2. 默认放卡片正上方、水平居中：
 *          left = relLeft + (nodeRect.width - barSize.width) / 2
 *          top  = relTop - barSize.height - gap
 *          placement = "top"
 *   3. 上方空间不够（top < margin，说明卡片已经贴着 wrapper 顶边，
 *      浮层会被裁掉看不见）→ 翻到卡片下方：
 *          top = relTop + nodeRect.height + gap
 *          placement = "bottom"
 *      （只翻一次，不做二次钳制：翻下去还溢出说明 wrapper 本身矮得离谱，
 *        这时让用户自己滚动画布更合理，硬塞反而更怪。）
 *   4. 左右钳制到 [margin, wrapperRect.width - barSize.width - margin]。
 *      ⚠ 边界：当 `wrapperRect.width - barSize.width - margin < margin`
 *      （浮层比容器还宽的极端情况），区间左右端点是**颠倒**的，
 *      直接 Math.min/Math.max 会算出负数上界。此时**直接取 margin**，
 *      宁可右边溢出一点，也不要给出负 left（负 left 在视觉上等于"凭空消失"，极难查）。
 *   5. 返回值 Math.round 取整：亚像素坐标会让文字渲染走灰度抗锯齿，看着发虚。
 *
 * 异常策略：nodeRect / wrapperRect / barSize 任一为 null、字段缺失、值为 NaN
 *   → 一律返回 { left: 0, top: 0, placement: "top" }，绝不抛异常。
 *
 * @param {{left:number, top:number, width:number, height:number}} nodeRect     卡片元素的视口 rect
 * @param {{left:number, top:number, width:number, height:number}} wrapperRect  挂载容器（canvas.wrapperEl 或 .canvas-wrapper）的视口 rect
 * @param {{width:number, height:number}} barSize  悬浮栏自身尺寸
 * @param {{gap?:number, margin?:number}} [opts]   可选；不传用 LMB_BAR_GAP / LMB_BAR_MARGIN
 * @returns {{left:number, top:number, placement:"left"|"right"}} placement：
 *   "left" = 卡片左边缘外侧（默认）、"right" = 左边不足时放到右边缘外侧
 */
function lmbCalcBarPos(nodeRect, wrapperRect, barSize, opts) {
  try {
    const gap = lmbBarNum(opts && opts.gap, LMB_BAR_GAP);
    const margin = lmbBarNum(opts && opts.margin, LMB_BAR_MARGIN);

    const nodeLeft = lmbBarNum(nodeRect && nodeRect.left, NaN);
    const nodeTop = lmbBarNum(nodeRect && nodeRect.top, NaN);
    const nodeW = lmbBarNum(nodeRect && nodeRect.width, NaN);
    const nodeH = lmbBarNum(nodeRect && nodeRect.height, NaN);
    const wrapLeft = lmbBarNum(wrapperRect && wrapperRect.left, NaN);
    const wrapTop = lmbBarNum(wrapperRect && wrapperRect.top, NaN);
    const wrapW = lmbBarNum(wrapperRect && wrapperRect.width, NaN);
    const wrapH = lmbBarNum(wrapperRect && wrapperRect.height, NaN);   // v0.13.2：竖排后浮层变高，需要 top 钳制
    const barW = lmbBarNum(barSize && barSize.width, NaN);
    const barH = lmbBarNum(barSize && barSize.height, NaN);

    // 缺字段 / NaN 一律走兜底（NaN 会让下面的比较全为 false，静默算出错误坐标）
    if (!isFinite(nodeLeft) || !isFinite(nodeTop) || !isFinite(nodeW) || !isFinite(nodeH)
      || !isFinite(wrapLeft) || !isFinite(wrapTop) || !isFinite(wrapW) || !isFinite(wrapH)
      || !isFinite(barW) || !isFinite(barH)) {
      return { left: 0, top: 0, placement: "left" };
    }

    // 1. 视口坐标 → wrapper 内相对坐标
    const relLeft = nodeLeft - wrapLeft;
    const relTop = nodeTop - wrapTop;

    // iPad 使用横向工具栏，放在卡片下方；桌面继续使用左侧竖排。
    if (opts && opts.mobile) {
      let mobileLeft = relLeft + (nodeW - barW) / 2;
      let mobileTop = relTop + nodeH + gap;
      let mobilePlacement = "bottom";
      if (mobileTop + barH > wrapH - margin) {
        mobileTop = relTop - barH - gap;
        mobilePlacement = "top";
      }
      const mobileMaxLeft = wrapW - barW - margin;
      mobileLeft = mobileMaxLeft < margin ? margin : Math.max(margin, Math.min(mobileMaxLeft, mobileLeft));
      mobileTop = Math.max(margin, Math.min(Math.max(margin, wrapH - barH - margin), mobileTop));
      return { left: Math.round(mobileLeft), top: Math.round(mobileTop), placement: mobilePlacement };
    }

    // 2. v0.13.2：默认贴在卡片**左侧**（竖排，顶端对齐卡片顶端）
    //    上一版是「卡片上边缘外侧」，用户反馈贴左更顺手、视觉上更像"卡片的"工具栏。
    let left = relLeft - barW - gap;
    let top = relTop;
    let placement = "left";

    // 3. 左侧放不下 → 翻到卡片**右侧外边**。绝不先塞进卡片内部，避免首次
    //    测量与下一帧测量之间出现“栏从卡片里跳出去”的闪动。
    if (left < margin) {
      left = relLeft + nodeW + gap;
      placement = "right";
    }

    // 4. 左右钳制（含「浮层比容器还宽」的颠倒区间边界）
    const maxLeft = wrapW - barW - margin;
    if (maxLeft < margin) {
      left = margin;              // 区间无效，贴左留白，不要算出负数
    } else if (left < margin) {
      left = margin;
    } else if (left > maxLeft) {
      left = maxLeft;
    }

    // 5. 上下钳制（v0.13.2 竖排后浮层高度可达 86px，wrapper 可能放不下）
    const maxTop = wrapH - barH - margin;
    if (maxTop < margin) {
      top = margin;
    } else if (top < margin) {
      top = margin;
    } else if (top > maxTop) {
      top = maxTop;
    }

    // 6. 取整
    return { left: Math.round(left), top: Math.round(top), placement: placement };
  } catch (e) {
    return { left: 0, top: 0, placement: "left" };
  }
}

/* ==================== 按钮可用性判定用的两条正则 ====================
 * 为什么要自己写、不直接复用 LMB_LINK_RE（10-constants.js）：
 *   LMB_LINK_RE 是给「解析出 page=/selection=/rect= 参数」用的，捕获组只抓了文件名，
 *   而本函数要的正好相反 —— **只要链接正文的壳，不要里面的参数**。
 *   另外它是 /g 正则、共享模块作用域，复用要手动管 lastIndex，容易出事故
 *   （32-plugin-canvas.js 就为此写过 lastIndex = 0 的补丁注释）。
 *   所以这里另写一条**只做「找出来 + 剥壳」**的正则，判定标准仍与 LMB_LINK_RE
 *   保持一致（必须 .pdf#page=数字），避免两处对「什么算 pdf 链接」的理解漂移。
 *
 * ⚠⚠ 明确职责边界：本函数**只剥壳、绝不解析 page=/selection= 参数**。
 *   参数解析是 lmbParsePdfLink() 的活（src/36-plugin-jump.js）。
 *   在这里重复实现一次，等于把同一份规则抄成两份，将来改格式必漂。
 *   调用方拿到 lmbPickBarActions().jump 后，直接丢给 lmbParsePdfLink() 即可。
 */
// 扫描用：抓出所有 [[...]] 的完整内层；match(/g) 内部会自重置 lastIndex，可安全复用
const LMB_BAR_WIKILINK_RE = /\[\[([^\]\n]*)\]\]/g;
// 判定用：这一段算不算「pdf 链接」（宽松版，与 LMB_LINK_RE 的核心特征对齐）
const LMB_BAR_PDF_HINT_RE = /\.pdf#page=\d+/i;
// 截图 embed：![[xxx.webp]] / ![[xxx.webp|400]]（v0.16.0：双重卡判定的「有图」半边）
const LMB_BAR_EMBED_RE = /!\[\[[^\]\n]+\]\]/;
// 双重摘录卡的视图切换标记：> [!lmb-view] 或 > [!lmb-view]-（宽松容忍多个空格 / 折叠符 / 行尾）
//   v0.16.0：lmbPickBarActions 的 view 判定**已不再使用它**（新卡不写这行了，见下）。
//   保留正则只为存量卡 / 兼容期排查，新代码不要依赖它。
const LMB_BAR_VIEW_RE = /^[ \t]*>[ \t]*\[!lmb-view\][ \t]*(?:[+-][ \t]*)?(?:$|\s)/m;

/**
 * 按卡片内容决定悬浮栏显示哪些按钮（纯函数，绝不抛异常）。
 *
 * 为什么要按内容动态判定：
 *   三个按钮**不是每张卡都适用**。无脑全显示的话，会出现点了没反应的死按钮
 *   （比如纯截图卡没有文字引用块，点「跳转」根本无处可跳），
 *   用户会以为插件坏了。宁可少显示，也不要死按钮。
 *
 * 判定规则：
 *   comment —— 卡片是**文本节点**就能加评论。判据：nodeText 是非空字符串（trim 后非空）。
 *   jump    —— 卡片里有 pdf 引用行才能跳回 PDF。引用行形如
 *              `> [[某文件.pdf#page=12&selection=1,2,3,4|📖]]`
 *              （`|` 后是显示别名，v0.12.0 起收拢成一个 📖 图标；也可能是别的别名，
 *                也可能干脆没有别名 —— 三种都要认）。
 *              取**第一个**命中的 pdf 链接（同一张卡可能有多个 = 多重摘录），
 *              返回**不含 [[]] 包裹、且剥掉 |别名 的链接正文**，如
 *              `"某文件.pdf#page=12&selection=1,2,3,4"`；找不到返回 null。
 *              链接不会跨行（canvas text 节点里一行就是一个引用块），故逐行扫描足够。
 *   view    —— 只有「双重摘录卡」（文字引用块 + 截图同时在卡里）才有切换视图按钮。
 *              v0.16.0 判定改版：= **同时含「PDF 引用行」+「截图 embed」**。
 *              旧版（v0.13.0~v0.15.0）靠卡里那行 `> [!lmb-view]` callout 当标记；
 *              v0.16.0 起新卡不再写这行（卡片精简 v2：用户要求卡内不放控件），
 *              若判定仍依赖它 → 新双重卡的「视图」按钮永远不显示 = 功能静默消失。
 *              所以改为按**内容**判定：有 pdf 引用行（jump 命中）+ 有 ![[xxx.webp]] embed。
 *              副作用是好的：老卡（markdown 里还留着 lmb-view 行）同样满足这两个条件，
 *              判定结果一致 → **新老卡零迁移、行为统一**。
 *
 * @param {string} nodeText  卡片的 markdown 文本（canvas text 节点的 text 字段）
 * @returns {{comment:boolean, jump:string|null, view:boolean, fit:boolean}}
 */
function lmbPickBarActions(nodeText) {
  try {
    const hasText = (typeof nodeText === "string") && nodeText.trim() !== "";
    // comment：文本节点就能加评论（与卡片有没有 pdf 链接无关）
    const comment = hasText;
    // v0.16.0：截图 embed（双重卡的「有图」半边；判据与 callout 无关）
    const hasEmbed = hasText && LMB_BAR_EMBED_RE.test(nodeText);

    let jump = null;
    if (hasText) {
      const hits = nodeText.match(LMB_BAR_WIKILINK_RE);   // /g 的 match 返回全部匹配，不污染 lastIndex
      if (hits && hits.length) {
        for (let i = 0; i < hits.length; i++) {
          const raw = hits[i];
          // 剥掉外层 [[ ]]
          const inner = raw.slice(2, raw.length - 2);
          // 剥掉 |别名（只按第一个 | 切；链接正文里不会出现 |）
          const pipe = inner.indexOf("|");
          const body = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
          if (body !== "" && LMB_BAR_PDF_HINT_RE.test(body)) {
            jump = body;
            break;                                        // 多重摘录取第一个
          }
        }
      }
    }

    // v0.16.0：view = 有截图 embed **且** 有 pdf 引用行（两者同时满足才算双重摘录卡）
    const view = hasEmbed && (jump !== null);
    // v0.13.3：fit = 自适应高度。文本节点都能调（lmbFitNodeById 内部判断 node.type）
    const fit = hasText;
    return { comment: comment, jump: jump, view: view, fit: fit, color: hasText && EX_ID_RE.test(nodeText), disconnect: false };
  } catch (e) {
    return { comment: false, jump: null, view: false, fit: false, color: false, disconnect: false };
  }
}

/** 决定断线行为：优先父边；否则单边直删，多边选择。 */
function lmbPlanDisconnect(nodeId, edges, autoEdgeIds) {
  try {
    const all = Array.isArray(edges) ? edges : [];
    const auto = autoEdgeIds instanceof Set ? autoEdgeIds : new Set(autoEdgeIds || []);
    const incident = all.filter((e) => e && e.id
      && (e.fromNode === nodeId || e.toNode === nodeId));
    if (!incident.length) return { kind: "none", candidates: [] };
    const parentEdges = incident.filter((e) => e.toNode === nodeId && auto.has(e.id));
    if (parentEdges.length) {
      return { kind: "direct", edgeId: parentEdges[0].id, candidates: incident, reason: "parent" };
    }
    if (incident.length === 1) {
      return { kind: "direct", edgeId: incident[0].id, candidates: incident, reason: "only" };
    }
    return { kind: "choose", candidates: incident };
  } catch (_) { return { kind: "none", candidates: [] }; }
}

/**
 * 生成轮询指纹（纯函数，绝不抛异常）。
 *
 * 用途：轮询每 120ms 跑一次，但**绝大多数帧什么都没变**（用户只是盯着看 / 在打字）。
 * 用指纹比对决定这一轮要不要**重建按钮**。
 *
 * 为什么「位置每轮都重算」而「按钮只在指纹变化时才重建」：
 *   - 位置：拖动卡片 / 平移画布时位置一直在变，而且 getBoundingClientRect()
 *     本身很便宜（一次布局读取），每轮算一遍完全扛得住，还能保证浮层严丝合缝跟手。
 *   - 按钮：重建是要**动 DOM** 的（清掉旧按钮、新建、绑事件、setIcon），
 *     比算坐标贵一两个数量级；而且选中没变时重建出来的一模一样，纯属白干
 *     （还会把正在 hover / 按下的按钮状态打断）。所以只在指纹变了才重建。
 *
 * 两个必须注意的细节：
 *   - nodeIds **先排序再拼接**：选中的遍历顺序（Map/Set 的插入顺序）不保证稳定，
 *     不排序的话「同一组选中」会因为顺序不同算出不同指纹，白重建一整轮。
 *   - viewport 的 x/y/zoom **保留 2 位小数**：平移缩放会产生 -20.000000000000004
 *     这种浮点毛刺，不截断的话指纹每帧都变，等于指纹机制完全失效。
 *
 * 格式：`"id1,id2|100.50,-20.00,0.80"`（节点段 + "|" + 视口段）
 *   空数组 → 节点段为空串，视口段照常输出，如 `"|100.50,-20.00,0.80"`
 *
 * @param {string[]} nodeIds   当前选中的节点 id 数组（顺序无关）
 * @param {{x:number, y:number, zoom:number}} viewport  canvas 视口状态
 * @returns {string}  指纹字符串；与本轮指纹相同则可跳过重建
 */
function lmbBarSignature(nodeIds, viewport) {
  try {
    // 节点段：排序后拼接（顺序无关）
    const ids = (nodeIds && typeof nodeIds.length === "number")
      ? Array.prototype.slice.call(nodeIds, 0)
      : [];
    const sorted = ids
      .map(function (id) { return (id == null) ? "" : String(id); })
      .sort();

    // 视口段：非数字一律按 0 处理（viewport 传 null 不该让指纹机制整个废掉）
    // 工具栏动作只由选中节点决定；平移/缩放只影响位置，不能触发按钮状态重建。
    // 保留 viewport 参数以兼容旧调用方，但故意不再写进指纹。
    return sorted.join(",");
  } catch (e) {
    return "";
  }
}

/* ---- 测试钩子：node 离线单测直接 require 本文件即可拿到；
 *      拼接进 main.js 后 module 依然存在于 CommonJS 作用域，钩子同样有效。 ---- */
if (typeof module !== "undefined" && module.exports) {
  module.exports.__lmbCanvasBar = {
    LMB_BAR_POLL_MS, LMB_BAR_GAP, LMB_BAR_MARGIN, LMB_BAR_SEL,
    lmbCalcBarPos, lmbPickBarActions, lmbBarSignature,
  };
}
