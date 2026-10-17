# Changelog

## 0.26.3

- Update sidebar collapse state in place instead of rebuilding the sidebar and rerendering Markdown. Preserve the page counter, search, focus and scroll position.
- Prepare full sidebar refreshes offscreen, apply page/search filters before committing, retain a visible scroll anchor and discard superseded renders. Reconcile collapse clicks received while content is loading.
- Exclude text-block geometry/type size/compact state from content signatures and ignore sidebar scrolling for PDF page-follow updates.
- Add borders, hover lift/highlighting, pressed feedback and keyboard focus rings to the new sidebar buttons, with reduced-motion support.
- Add slow-Markdown/multi-page regression coverage and an 11-entry browser stress fixture.

## 0.26.2

- Label compact sidebar entries with the note title/opening text, falling back to excerpt text, and truncate with a single-line ellipsis.
- Move delete and sidebar-collapse actions to the card's upper-right corner. Remove the redundant PDF locate button while preserving click-card navigation.
- Embed the long-note expand/collapse control in the note's lower-right corner instead of a separate row.

## 0.26.1

- Replace sidebar hiding with a compact row containing the page/ordinal and a direct expand button. Previously hidden entries automatically appear as compact rows.
- Remove the hidden-entry filter and rename page controls to sidebar collapse/expand; preserve Markdown content and page placement while collapsing.
- Cover legacy hidden-state compatibility, persistence, expansion and current-page filtering.

## 0.26.0

- Place excerpt notes on PDF pages as selectable Markdown text blocks, with drag handles, width reflow, adjustable type size and transparent/sticky-note styles.
- Share the existing Markdown/quick-excerpt note source between page and sidebar editing; save only presentation metadata separately.
- Hide individual sidebar entries and recover them with “显示已隐藏”; keep placed text visible independently. Collapse long sidebar notes by default.
- Restore geometry and visibility after reopening, track PDF page resizing independently of ink, and preserve editor drafts on save failure.
- Add text-block integration coverage and a browser smoke fixture (`tests/text-block-preview.html`). Page overlays remain plugin data; PDF export is outside this release.

## 0.25.5

- Open previously unopened Markdown excerpts in a new tab instead of replacing another document, Canvas, or sidebar view.
- Reuse deferred excerpt tabs and serialize concurrent reverse jumps to avoid duplicate tabs.
- Locate blocks in the visible reading or editing view without reopening files with a block subpath; retry unfinished preview layouts and handle delayed metadata.
- Stop pending positioning when the active document changes, bound editor scroll ranges to the document, and report missing targets instead of silently claiming success.
- Add regression coverage for tab preservation, reading mode, deferred views, concurrent jumps, metadata delays, and cancellation.

## 0.25.4

- Make the live handwriting canvas the actual hit-test surface while a drawing tool is active, instead of leaving PDF.js text and annotation layers in control of Pencil input.
- Bind Pointer Events and iOS stylus Touch Events directly to that input surface with `pointer-events:auto` and `touch-action:none`, then restore pass-through behavior in hand mode.
- Add regression coverage that verifies the live canvas owns hit testing before Pencil input begins.

## 0.25.3

- Lazily create handwriting canvases for visible PDF pages with saved ink or active handwriting; release unused blank canvas buffers in reading mode.
- Refresh only the resized page after zoom settles instead of traversing every open PDF, and defer offscreen canvas resizing until visibility changes.
- Refresh visible saved annotations after asynchronous sidecar loading, and clean up visibility observers and per-page resize timers.
- Batch excerpt highlight insertion after measuring all excerpts on a page to reduce repeated layout work.
- Add regression coverage for blank pages, offscreen zoom, saved ink in reading mode, asynchronous loading, and local resize coalescing.

## 0.25.2

- Add a dedicated non-passive iOS Touch Events path that recognizes `Touch.touchType=stylus` and Pencil angle metadata instead of depending solely on `PointerEvent.pointerType`.
- Force page-level `touch-action:none` while a drawing tool is active so WKWebView cannot promote Pencil movement into PDF scrolling before the plugin receives it.
- Restore the page's original touch policy when handwriting capture stops, while retaining plugin-managed finger panning and PDF pinch handling.

## 0.25.1

- Stop Apple Pencil strokes from being converted into PDF scrolling by declaring pinch-only direct manipulation while drawing, while retaining one-finger PDF panning and two-finger pinch zoom.
- Preserve sampled pen/highlighter strokes if iPadOS issues a late pointer cancellation, and consume palm touches during an active Pencil stroke.
- Rebuild the handwriting toolbar with stable Lucide icons, bounded sidebar-aware sizing, mobile wrapping, a custom color picker, and an explicitly styled width slider.

## 0.25.0

- Cache related-note source documents across excerpt queries and invalidate only changed notes, removing repeated vault-wide reads and allocation-heavy token counting.
- Use a spatial grid and node lookup maps for Canvas parent detection, and make the dual-card toolbar cache actually skip unchanged cards.
- Incrementally redraw PDF marks by page, reuse unchanged PDF sidebars, parse excerpt notes in one pass, and render sidebar Markdown in responsive batches.
- Avoid repeated full-vault cache pruning, remove duplicate startup indexing reads, batch Canvas note fitting delays, and coalesce handwriting snapshots with fewer verification I/O operations.
- Add large-Canvas, shared-corpus, and linear note-parser regression coverage.

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
