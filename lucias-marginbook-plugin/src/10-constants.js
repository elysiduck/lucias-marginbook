/* ============================================================
 * 10-constants —— 正则与数据格式常量
 * 修改注意：ppd-note / lmb-comment / selection= 是数据格式字面量，
 * 改了会破坏存量笔记，动前先确认。
 * ============================================================ */

const { Plugin, Notice, TFile, PluginSettingTab, Setting, normalizePath, Modal, FuzzySuggestModal } = require("obsidian");
const EX_ID_RE = /\^ex-[0-9a-z]{4,8}/;
/* ==================== P1：摘录索引层 ====================
 * 动机：现有链路是 canvas → 摘录 md 的单向同步，打开 PDF 时无法知道「哪些段落
 *   已经摘录过」。本层建立反向索引（摘录 md → PDF/页/选区），为 P2 回绘与
 *   P3 跳转提供数据。
 *
 * 设计原则（与全插件一致）：
 *   - 唯一真相源是摘录 md 本身，索引只是**可随时重建的缓存**，不写进 data.json
 *   - 解析器写成纯函数 lmbParseExcerptDoc，挂 __test 供 node 冒烟离线验证
 *   - 候选文件用 metadataCache.resolvedLinks 预筛，避免读全库 md 正文
 * ===================================================================== */
// 摘录回跳链接：[[x.pdf#page=21&selection=0,0,655,478|显示名]]
//             或 [[x.pdf#page=21&rect=12.5,3.2,45,8|显示名]]（截图摘录，页面百分比，P3.5 新增）
const LMB_LINK_RE = /\[\[([^#|\]]+\.pdf)#page=(\d+)(?:&selection=([\d,]+))?(?:&rect=([\d.,]+))?[^\]]*\]\]/g;
// selection 参数：a,b,c,d（textLayer 直接子元素序号 + 字符偏移）
const LMB_SEL_RE = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/;
// rect 参数：l,t,w,h（相对 .page 的百分比，浮点）—— 截图摘录用，不依赖 textLayer
const LMB_RECT_RE = /^\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*$/;
/* ==================== v0.8.0+：卡片补充描述（note） ====================
 * v0.8.0 最初设计：HTML 注释锚点 + callout 解析。v0.8.3 改成**完全可见**：
 *   - 砍掉 `<!-- ppd-note-start/end -->`（可疑失败点：要么被字面渲染破坏 callout，
 *     要么破坏解析；用户"啥也看不到"的根因之一）
 *   - callout 自身作为唯一标记（Obsidian 原生一定可见，原生一定渲染成框）
 *   - 空 callout 用「💬 添加评论」标题 + 占位提示行，看起来就是一个按钮，
 *     用户一眼能看到「卡片底部可以加评论」
 *
 * 落盘结构（v0.8.3）：
 *   原文内容
 *   ^ex-abc123
 *   > [!ppd-note] 💬 添加评论              ← 空时标题（按钮样式）
 *   > 点击此处写下你的想法...               ← 空时占位；用户写内容后被替换
 *
 * 向后兼容：旧 v0.8.0-v0.8.2 用 `<!-- ppd-note-start/end -->` 包围 callout，
 *   解析时仍能识别（不丢用户已写内容）；但 emit 永远用新格式。
 * ===================================================================== */
const LMB_NOTE_START = "<!-- ppd-note-start -->";   // 保留旧锚点用于回退解析
const LMB_NOTE_END = "<!-- ppd-note-end -->";
const LMB_NOTE_PLACEHOLDER_TITLE = "💬 添加评论";   // 空 callout 的标题（看起来像按钮）
const LMB_NOTE_PLACEHOLDER_HINT = "点击此处写下你的想法...";
const NOTE_START_LINE_RE = /^\s*<!--\s*ppd-note-start\s*-->\s*$/;
const NOTE_END_LINE_RE = /^\s*<!--\s*ppd-note-end\s*-->\s*$/;
// callout 首行：> [!类型][+-]? 标题
const NOTE_CALLOUT_RE = /^\s*>\s*\[!([^\]]+)\]\s*([+-]?)\s*(.*)$/;
/* ==================== v0.11.0：独立评论体系（lmb-comment） ====================
 * 与「补充描述」（ppd-note）并存的第二套数据，仿 PDF Flow 的批注评论底栏：
 *   空：> [!lmb-comment]- 添加评论     ← 折叠单行，渲染成底栏按钮
 *   有：> [!lmb-comment] 评论          ← 展开显示内容
 * 位置：永远在卡片文本最末（补充描述 callout 之后），渲染成卡片底栏。
 * lmb-comment 是保留类型字面量（不做成设置项），解析器按字面量识别。 */
const LMB_COMMENT_TYPE = "lmb-comment";
const LMB_COMMENT_EMPTY_TITLE = "添加评论";
const LMB_COMMENT_TITLE = "评论";
const LMB_COMMENT_CALLOUT_RE = /^\s*>\s*\[!lmb-comment\]\s*([+-]?)\s*(.*)$/;
