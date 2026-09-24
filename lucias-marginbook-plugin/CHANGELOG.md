# Changelog

## 0.24.1

- Harden handwriting storage with lazy per-PDF loading, verified writes, recovery from newer temporary/backup copies, bounded retries, and fail-closed handling for corrupt sidecars.
- Fix stylus taps, final pointer samples, palm interference, stale virtualized PDF pages, cross-pane selection, reverse-drawn shape resizing, and incomplete lasso intersections.
- Preserve pressure extrema during stroke simplification, replace full-page history snapshots with incremental patches, and narrow eraser hit-testing through a spatial grid.
- Preserve and merge handwriting across legacy migration and PDF renames, normalize old/duplicate object IDs, and expand automated recovery and interaction simulations.

## 0.24.0

- Rebuild PDF handwriting around a non-blocking pen input path: Pencil/stylus writes while fingers keep native PDF scrolling and pinch zoom.
- Add coalesced pointer sampling, frame-batched live rendering, pressure/velocity-aware page-relative strokes, highlighter, stroke eraser, lasso selection, and per-PDF toolbars.
- Add full per-page undo/redo for drawing, erasing, moving, resizing, styling, deleting, and clearing; clearing can now be undone.
- Move annotations into verified per-PDF sidecar files with automatic legacy migration, backup writes, save-state feedback, and a safe `data.json` fallback.
- Add configurable input/pressure/eraser settings plus automated dense-input, pointer-flow, geometry, history, migration, and failure-fallback simulations.

## 0.23.2

- Apply all iPad layout rules through a plugin-owned mobile marker instead of relying on an optional Obsidian body class.
- Replace stale injected CSS when the plugin reloads and expose the exact runtime version in Settings and a mobile startup notice.
- Remove Canvas toolbar polling entirely on mobile and keep the overlay suspended until every finger in a pan/pinch gesture is released.

## 0.23.1

- Reflow the PDF viewer beside the annotation sidebar on iPad instead of overlaying it.
- Lock sidebar controls, action icons, and color swatches to stable non-stretched mobile sizes.
- Render text excerpts as translucent highlighter marks even when an automatic screenshot is attached.
- Place the Canvas card toolbar horizontally above or below the card on mobile and hide it during pan/pinch gestures.
- Remove viewport movement from the toolbar action fingerprint and lower mobile polling frequency to reduce zoom jank.
- Retry delayed Canvas DOM/image height measurement until the rendered card stabilizes.

## 0.23.0

- Add iPad/iPhone support and allow the plugin to load in Obsidian Mobile.
- Replace desktop-only mouse selection flows with touch/Apple Pencil pointer handling on mobile.
- Add touch rectangle capture, delayed iOS text-selection detection, and mobile-sized excerpt actions.
- Add a direct “send to PDF canvas” action because iOS WebKit does not provide the desktop HTML5 drag-and-drop workflow.
- Keep all existing mouse, Alt-drag, PDF, Markdown, and Canvas behavior unchanged on desktop.

## 0.22.1

- Fix dual excerpt cards staying at image height after switching back to text. View-triggered fitting now ignores the previous fixed outer height and bypasses the dual-view maximum-height safety floor.

## 0.22.0

- Give newly dragged excerpt cards one configurable Canvas width (560px by default), while preserving every later manual width change during comments and height fitting.
- Automatically fit card height after switching text/image view and after saving or removing a comment.
- Store new excerpt screenshots under the configurable Vault-root template `附件/{pdf}` and enable recoverable linked cleanup for managed excerpt assets.
- Rename the visible excerpt comment/note label from “我的笔记” to “备注”.

## 0.21.9

- Hide the Canvas side toolbar as soon as card movement passes a small drag threshold; keep it hidden throughout the drag and restore it at the card's final position on release.

## 0.21.8

- Fix reused Canvas sidebars measuring as zero-width after `display:none`: they now enter an invisible layout state before action filtering and positioning, then appear directly outside the card.

## 0.21.7

- Position the Canvas side toolbar only after its visible actions have been measured, preventing the initial inside-card flash.
- Keep the toolbar outside the card: prefer the left side and automatically switch to the right when left-side space is insufficient.

## 0.21.6

- Remove empty rendered containers left by hidden excerpt identifiers and nested-note fallbacks, eliminating excess vertical space in Markdown and Canvas cards.
- Strip embedded excerpt-ID markers before index regeneration so they no longer duplicate, and tighten excerpt/comment spacing.

## 0.21.5

- Unify Canvas comments with the Markdown excerpt-note appearance: green accent, compact note card, pencil icon, and “我的笔记” label, while preserving click-to-edit and existing data.

## 0.21.4

- Make excerpt notes render reliably across Obsidian versions by placing the nested Callout title first and adding a rendered-note fallback.
- Add a Markdown dual-excerpt switch: text and screenshot are mutually exclusive, with text shown by default.

## 0.21.3

- Fix nested Callout syntax for saved excerpt notes. “我的笔记” now renders as a proper Callout instead of showing its markup as plain text.

## 0.21.2

- Fix the excerpt-note editor on constrained windows: its two panes now shrink safely, switch to a vertical layout when needed, and keep all action buttons visible.

## 0.21.1

- Fix the Markdown/Live Preview action for `lmb-excerpt` cards: the “追加我的笔记” button now resolves the excerpt reliably, including existing cards created before v0.21.
- New excerpts embed an invisible stable identifier inside the Callout, so their note action stays attached after rendering and refreshes.

## 0.21.0

- `lmb-excerpt` 批注卡新增“追加/编辑我的笔记”按钮。
- 新增双栏 Markdown 编辑器，输入时实时渲染公式、链接、列表等预览。
- 笔记以 `LMB-NOTE:BEGIN/END` 边界内联保存到对应 `exId` 卡片，只更新笔记区域。

## 0.20.1

- 直接从 PDF 拖入任意 Markdown 的摘录也会立即生成统一批注卡，不再只依赖 Canvas 同步路径。
- Canvas 同步会自动剥离卡片外层视觉包装，避免生成摘录文档时产生嵌套卡片。

## 0.20.0

- 摘录 Markdown 改为统一的 `lmb-excerpt` 视觉批注卡，来源、内容、截图和评论保持在同一单元中。
- 每页摘录自动生成稳定序号，并在摘录卡标题与 PDF 标记上同步显示。
- 精确回跳时暂时弱化其他 PDF 标记并突出目标区域，增强同页多摘录辨识度。

## 0.19.0

- 相关笔记检索纳入正文词频与长度归一化评分，标题、标签和别名仍保持更高权重。
- 新增“从左到右知识树”和“自上而下知识树”Canvas 命令，按已有父子边重排。

## 0.18.0

- 摘录 Markdown 改为受控生成区；`<!-- LMB:BEGIN -->` 与 `<!-- LMB:END -->` 外的补充内容不会被同步覆盖。
- 旧摘录文档首次迁移时完整保留原正文，避免手写内容丢失。
- Canvas 卡片的文字/图片视图会按 `canvas path + node id` 持久化并在重开后恢复。

## 0.17.0

- 新增 Canvas / PDF 兼容适配层，集中少量 Obsidian 私有 API 访问。
- Canvas 悬浮栏改为 pointerup / 视图切换即时刷新，800ms 低频轮询只作兜底。
- PDF 标记观察器收窄到页面、文字层与批注层相关变动。
- 新摘录 ID 升级为 10 位内容寻址 ID，旧 ID 保持可读。

## 0.16.16

- 级联清理改为可恢复删除：摘录 Markdown 原块、元数据与截图进入 `.lmb-trash/<日期>/`，不再永久删除截图。
- 附件引用检查改为 fail closed；任一引用文件无法读取时保留附件。
- 相关笔记缓存会在 Markdown 创建、修改、重命名、删除或元数据变化时失效。

## 0.16.15

- 卡片悬浮栏新增“联动”开关；开启后移动父卡会按相同位移带走整棵子卡树，关闭后恢复单卡移动。
- 联动状态会持久保存，并兼容多选拖动、深层后代与意外环形连线，避免重复位移。

## 0.16.14

- Restored the source workspace behind the distributed `main.js` artifact.
- Added an explicit deterministic build manifest and build-consistency check.
- Split source code and tests by responsibility.
- Added dedicated runtime-state and settings-persistence services.

Historical release notes for earlier versions are archived in
`docs/historical-bootstrap.md` without inflating the runtime artifact.
