/* ============================================================
 * 25-pure-toolbar —— 工具栏注入的宿主解析 / DOM 缓存 / 显隐分级（纯函数层）
 * 修改注意：
 *   1. 本文件**不依赖 Obsidian API**（没有 require("obsidian")），DOM 一律从参数传入，
 *      只在参数上假设 querySelector / querySelectorAll / isConnected / style 四个鸭子类型成员，
 *      目的是能被 node 离线单测直接用 mock 调。
 *   2. 构建顺序由 build.config.js 显式声明，**顶层 const/function/class 共享同一 bundle 作用域**，
 *      所以所有导出名统一 lmb / LMB_ / Lmb 前缀，避免和别的片段撞名。
 *   3. LMB_VIEW_SPECS 是「判定 + 选择器」的**单一真相源**，禁止再拆出第二张判定表。
 * ============================================================ */

/* ==================== 视图规格表：判定与选择器同源 ====================
 * 背景：在 .pdf-toolbar（原生的 PDF 视图工具栏）里注入 3 个自定义按钮
 *       （图片框选 / 打开摘录 md / 打开专属 canvas）。
 *
 * 为什么要这张表：
 *   - 旧实现把 `.pdf-toolbar` 硬编码在注入函数里，将来支持别的视图只能加 if-else；
 *     现在改成「viewType → 宿主选择器」的映射，加新视图 = 加一行，注入函数不动。
 *   - viewType 就是 leaf.view.getViewType() 返回的那个字符串，拿它直接查表，
 *     **判定（这个视图要不要注入）和选择器（往哪儿注入）读的是同一条记录**。
 *
 * 教训（逆向 editing-toolbar v4.1.1 得来）：
 *   它把「判定表」和「选择器表」写成了两份数据，结果字符串不一致
 *   （一份写 meld-encrypted-view，另一份写 meld_encrypted_view），
 *   选择器表那条从此成了永远走不到的死代码。
 *   → **判定和选择器必须同源**：不要另建 VIEW_TYPES / ENABLED_VIEWS 之类的第二张表，
 *     也不要在别处写 `.pdf-toolbar` 字面量，要改就改这里。
 *
 * 字段：
 *   selector —— 工具栏宿主容器的 CSS 选择器（相对 leaf.containerEl 做 querySelector）
 *   enabled  —— 该视图类型是否默认允许注入（false = 查得到 spec 也直接拒绝）
 *   note     —— 一句话说明，给人看，不参与逻辑
 *
 * 扩展示例（将来加新视图只加一行，注入层零改动）：
 *   // image: { selector: ".image-container", enabled: false, note: "图片视图" },
 *   // canvas: { selector: ".canvas-wrapper", enabled: false, note: "白板视图" },
 *   （enabled: false 表示「已登记但先关着」，等注入逻辑验证通过再打开）
 */
const LMB_VIEW_SPECS = {
  pdf: { selector: ".pdf-toolbar", enabled: true, note: "完整 PDF 视图" },
  // image: { selector: ".image-container", enabled: false, note: "图片视图" },
  // canvas: { selector: ".canvas-wrapper", enabled: false, note: "白板视图" },
};

/**
 * 解析工具栏宿主锚点（三级判定，纯函数，绝不抛异常）。
 *
 * 调用点：workspace 的 layout-change / active-leaf-change 回调里。
 * 异常策略：**任何异常都吞掉**并返回 { el: null, source: null, spec: null }。
 * 因为在 Obsidian 的事件链里抛异常会打断后续回调，宁可这一帧不注入按钮，
 * 也不能把别人的事件处理拖挂（与全插件「宁可画得不准也不崩」的原则一致）。
 *
 * 三级判定顺序（**顺序不能改**）：
 *   1. 查表 LMB_VIEW_SPECS[viewType]
 *      - 查不到 spec，或 spec.enabled === false → 直接拒绝，返回 { el: null, source: null, spec: spec || null }
 *        （注意：查不到时 spec 为 null，查到但被禁用时仍要把 spec 带回去，方便调用方区分
 *         「未知视图」和「已登记但关闭」这两种情况）
 *      - 命中且 enabled → root.querySelector(spec.selector)，命中返回 { el, source: "spec", spec }
 *   2. 兜底：spec 存在但选择器没命中（Obsidian 换版本改了 DOM 结构 / 视图还没渲染完）
 *      → 找 .view-content，取它第一个直接子 div（:scope > div），有就用第一个，没有就用 .view-content 本身
 *      → 命中返回 { el, source: "fallback", spec }
 *   3. 都找不到 → { el: null, source: null, spec }
 *
 * @param {Object} root     容器元素（leaf.containerEl），鸭子类型：只需 querySelector / querySelectorAll
 * @param {string} viewType 视图类型（如 "pdf"）
 * @returns {{el: Object|null, source: "spec"|"fallback"|null, spec: Object|null}}
 */
function lmbResolveToolbarAnchor(root, viewType) {
  try {
    if (!root || typeof root.querySelector !== "function") {
      return { el: null, source: null, spec: null };
    }
    const spec = (viewType && Object.prototype.hasOwnProperty.call(LMB_VIEW_SPECS, viewType))
      ? LMB_VIEW_SPECS[viewType]
      : null;

    // 一级：未知视图 / 已登记但禁用 → 不注入
    if (!spec || spec.enabled === false) {
      return { el: null, source: null, spec: spec || null };
    }

    // 一级（续）：spec 选择器命中
    if (spec.selector) {
      const hit = root.querySelector(spec.selector);
      if (hit) return { el: hit, source: "spec", spec: spec };
    }

    // 二级：兜底 —— .view-content 的第一个直接子 div，否则 .view-content 本身
    const content = root.querySelector(".view-content");
    if (content) {
      let first = null;
      try {
        // :scope > div 在部分极简 mock 上可能不支持，单独兜一层
        if (typeof content.querySelectorAll === "function") {
          first = content.querySelectorAll(":scope > div")[0] || null;
        }
      } catch (e) {
        first = null;
      }
      if (first) return { el: first, source: "fallback", spec: spec };
      return { el: content, source: "fallback", spec: spec };
    }

    // 三级：都没有
    return { el: null, source: null, spec: spec };
  } catch (e) {
    return { el: null, source: null, spec: null };
  }
}

/* ==================== LmbDomCache：DOM 引用缓存 ====================
 * 动机：旧实现每次 layout-change / active-leaf-change 都对所有 PDF leaf 做全量
 *       querySelector，事件密集时是白白的重复开销。缓存住解析结果，命中就跳过查询。
 *
 * ⚠⚠ 关键警告：key 必须带 leaf 标识（leaf.id、或直接用 leaf.containerEl 本身），
 *    **每个 leaf 有自己独立的一份工具栏**，绝不能用 "pdfToolbar" 这种全局单例 key ——
 *    否则切到第二个 PDF leaf 时会拿到第一个 leaf 的节点，按钮注入到错误的窗口里。
 *    （这条是抄 editing-toolbar 时的连带教训：它自己就注明「top 样式不缓存，
 *      因为每个 leaf 都有独立的工具栏」，说明它踩过单例 key 的坑。）
 *
 * ⚠⚠ 第二个关键：get 必须用 el.isConnected 校验。
 *    元素被 Obsidian 从文档里移除后，引用还在、isConnected 变成 false，
 *    不校验就会拿到游离节点（往里塞按钮 = 用户永远看不到，且不报错，极难排查）。
 *    命中但已游离时：删掉该条缓存并返回 null，让调用方重新解析。
 */
class LmbDomCache {
  constructor() {
    this._map = new Map();
  }

  /**
   * 取缓存。命中且 el.isConnected 为真才返回；否则删掉该条返回 null。
   * @param {*} key
   * @returns {Object|null}
   */
  get(key) {
    const el = this._map.get(key);
    if (el == null) return null;
    // 游离节点（已被 Obsidian 移除）视为缓存失效
    if (el.isConnected === false) {
      this._map.delete(key);
      return null;
    }
    return el;
  }

  /**
   * 写缓存。el 为空时不写（顺手删掉旧值，避免残留脏条目）。
   * @param {*} key
   * @param {Object} el
   */
  set(key, el) {
    if (el == null) {
      this._map.delete(key);
      return;
    }
    this._map.set(key, el);
  }

  /** 删单条 */
  delete(key) {
    this._map.delete(key);
  }

  /** 清空全部 */
  clear() {
    this._map.clear();
  }

  /**
   * 遍历清理所有已游离（isConnected === false）的条目。
   * 建议在 leaf 关闭 / 批量注入前调一次，防止 Map 无限增长。
   * @returns {number} 清理掉的条数
   */
  prune() {
    let n = 0;
    for (const [key, el] of Array.from(this._map.entries())) {
      if (!el || el.isConnected === false) {
        this._map.delete(key);
        n++;
      }
    }
    return n;
  }

  /** 当前条目数 */
  get size() {
    return this._map.size;
  }
}

/**
 * 工具栏显隐分级（纯函数，绝不抛异常）。
 *
 * 为什么分两级隐藏（这是本函数存在的全部理由）：
 *   - display:none  → 元素彻底离开渲染树、**不再占空间**，
 *     重新显示时周围原生按钮会重排，肉眼可见地跳动一下。
 *     适合「持久态」：比如用户在设置里把本插件全局关了，短期不会再开。
 *   - visibility:hidden → 元素保留占位、只是看不见，
 *     来回切换零抖动。适合「临时态」：比如当前视图类型不允许注入、
 *     切回来马上又要显示，用这个就不会跳。
 *
 * 对应关系（调用方按语义选，别混用）：
 *   "show"          → 可见（visibility:visible + display 清空）
 *   "hideKeepSpace" → 隐藏但保留占位（临时态：视图类型不允许等）
 *   "hideRemove"    → 隐藏且彻底移出渲染树（持久态：全局关闭）
 *
 * @param {Object} el
 * @param {"show"|"hideKeepSpace"|"hideRemove"} mode
 * @returns {boolean} 是否成功（el 为空 / mode 未知 / 抛异常 → false，且尽量不动 DOM）
 */
function lmbSetToolbarVisibility(el, mode) {
  if (!el) return false;
  try {
    const st = el.style;
    if (!st) return false;
    if (mode === "show") {
      st.visibility = "visible";
      st.display = "";
      return true;
    }
    if (mode === "hideKeepSpace") {
      st.visibility = "hidden";
      st.display = "";
      return true;
    }
    if (mode === "hideRemove") {
      st.display = "none";
      return true;
    }
    // 未知 mode：不动 DOM
    return false;
  } catch (e) {
    return false;
  }
}

/* ---- 测试钩子：node 离线单测直接 require 本文件即可拿到；
 *      拼接进 main.js 后 module 依然存在于 CommonJS 作用域，钩子同样有效。 ---- */
if (typeof module !== "undefined" && module.exports) {
  module.exports.__lmbToolbar = {
    LMB_VIEW_SPECS, lmbResolveToolbarAnchor, LmbDomCache, lmbSetToolbarVisibility,
  };
}
