# Changelog

## 0.45.1

- Give focused sidebar and on-page Markdown note editors their own Obsidian keyboard scope so PDF window-capture shortcuts cannot turn pages while moving the caret. Preserve native navigation and modified selection keys, paragraph-boundary movement, composition and other shortcuts; restore the PDF scope on blur or editor close.
- Add regressions for both editor locations, navigation modifiers, composition, paragraph switches and scope cleanup. Build and all 10 test suites pass.

## 0.45.0

- Cache completed pen outlines as native Path2D geometry. Natural-pressure version 3 strokes use reference-space paths so zoom transforms existing geometry instead of rebuilding pressure/taper outlines. Live and cached drawing share a single path tracer. Earlier outline versions retain exact size-specific geometry with three cached sizes per stroke.
- Invalidate paths on geometry, width, pressure mode or cut-boundary changes; release cache references on unload. Keep caches outside serialized data and avoid building paths for hidden zero-size canvases.
- Stop ink refresh from repeatedly laying out existing Markdown blocks on zoom. Their own resize observer remains responsible for layout; ink refresh still restores removed blocks on visible PDF pages and retains page-layer recovery.
- Remove the visible left/right text from the sidebar placement toggle. Keep a square icon button, hover/action description, accessible label and existing hover/press styling; narrow the reserved header space accordingly.
- Validate 10 Node suites and 493 browser checks, including cached/live pixel agreement, zoom reuse, cache invalidation, earlier versions, zero-size views, sidebar layout and Markdown/ink workflows. A Windows headless Edge fixture with 180 strokes/39,600 points reduced warmed synchronous zoom processing from about 13 ms to 0.5 ms. Initial display still builds the cache; these timings do not measure full PDF rendering or physical tablet latency.

## 0.44.0

- Preserve expressive pen details: reduce follower damping during pressure gestures, coherent turns and paused micro-adjustments. Retain short stationary pressure samples and keep raw pressure peaks through display smoothing and final simplification.
- Render new natural-pressure strokes with a finer light-pressure range and pressure-dependent pointed starts/releases. Close at the final contact coordinate, retain heavy rounded stops and uniform fine strokes, and recognize gradual release independently of sample density. Zero-pressure contact begins fine instead of creating a default-pressure blob.
- Preserve corner/pressure accent anchors in both Canvas and SVG outlines. Merge coincident display samples at peak pressure so stationary dots stay visible; preserve their original editable samples in storage.
- Keep previous render versions and current pressure/stability preferences. Mark erased boundaries so partial erasing cannot manufacture a new release taper. Handwriting remains editable with association, undo/redo, autosave and zoom recovery.
- Validate pressure-release outlines, held accents, dense samples, hooks, real dot pixels, SVG/Canvas agreement and existing Markdown/zoom workflows. Procreate's public taper/expression documentation informed the design; no Indigo brush assets or internal preset parameters were copied. Physical Apple Pencil Pro handwriting remains a user-device check.

## 0.43.0

- Add input-stage pen stabilization with off/light/standard/strong levels, selectable in plugin settings and the handwriting toolbar's More area. Default to standard. Apply speed-adaptive damping and bounded screen-pixel trailing distance before persistence; keep pressure, short dashes and release filtering. Existing ink is not reprocessed.
- Restore handwriting when PDF.js removes only child canvases during zoom while retaining the page element. Repaint visible reading-mode pages even if intersection state is stale; redraw static/live layers after backing-size changes.
- Finish active strokes before resizing, abort obsolete input listeners on layer replacement, and rebind recycled page elements. Replacing only the static canvas cannot leave handlers drawing into a detached surface or commit gestures twice.
- Reproduce the missing-layer bug against the prior build, then verify repeated zoom, real pixel redraw, partial layer replacement, detached input, page recycling, in-flight stroke preservation, Markdown autosave and stability preference persistence. Native Obsidian zoom in/out and reload passed on an isolated PDF; 49 existing managed files and settings remained unchanged. Physical tablet feel remains a user hardware check.

## 0.42.0

- Stop stylus drawing at the final valid contact sample. Do not append pointerup/touchend hover coordinates, even when a driver repeats positive pressure on release. Filter zero-pressure and buttons-up movement before fallback pressure normalization; retain valid coalesced samples and light-pressure finishing flicks.
- Render new pen strokes as a continuous filled outline with bounded, corner-aware display smoothing instead of individually stroked segments. Keep endpoints and raw contact geometry, and preserve old strokes with their previous renderer. Sidebar and Canvas previews use matching outlines.
- Keep new strokes editable through partial erasing, undo/redo, associations and persistence. No schema migration or rewrite of existing handwriting is performed.
- Add regressions for displaced releases, hover events, legacy Pencil force, coalesced contacts, dots, corner preservation and exact undo/save roundtrips. Verify Canvas/SVG render agreement and the existing Markdown autosave workflows. Physical stylus feel and latency remain hardware checks.

## 0.41.0

- Right-click a PDF page thumbnail to insert a blank page before or after it. Touch and pen long-press open the same menu; scrolling, short taps, cancelled contacts and a second finger cancel the long-press.
- Modify the original PDF locally with an adjacent page's dimensions and rotation. Shift subsequent excerpt, Markdown block, ink association and sidecar page references together, plus resolved Markdown/Canvas PDF links. Preserve note text, stroke payloads, identifiers and Canvas geometry/edges.
- Verify backups before writing; keep a transaction journal and restore interrupted or failed writes before loading plugin settings. Save active note editors first, reject stale menus and concurrent insertion, and retain backups under the plugin's `page-backups/` directory.
- Bundle pdf-lib 1.17.1 locally with its MIT license and dependency notices; insertion needs no download or server.
- Validate real PDF insertion/rollback/recovery, 12 browser gesture/menu cases, existing Markdown and handwriting workflows, and native Obsidian before/after insertion plus reopening. Physical tablet testing remains outstanding.

## 0.36.0

- Add contextual lasso actions to associate selected ink with an existing excerpt or create a named handwritten note. Persist references only after original ink is durable; creation failures retain the title and selection for retry.
- Show live ink previews and edit/source actions in the sidebar. Existing excerpt text and Markdown notes retain their original stores; handwritten notes use the existing sidebar autosave editor.
- Add idempotent Canvas reference cards in the configured MarginBook workspace. Store a stable reference, not copied strokes or image snapshots; preserve existing card geometry and edges, including unsaved live Canvas positions.
- Resolve references from current stroke geometry. Preserve reference lineage through partial erasing, movement, undo/redo and PDF rename; keep commentary and placeholders if all referenced ink is erased.
- Save active Markdown editors before navigating from a preview. Stop navigation on save failure or stale/cancelled view requests; keep normal PDF link behavior and avoid preview clicks after Canvas dragging.
- Add association, persistence, Canvas concurrency/rollback, rename and navigation regressions plus a connected browser workflow. Native Obsidian Canvas and physical tablet behavior remain separate host checks.

## 0.35.0

- Correct stylus detection: ordinary browser touch/mouse events also have a default altitude angle and must not be mistaken for a pen. Quarantine palm contacts through pen lift, share finger navigation across PDF pages and use the host PDF scale for two-finger zoom.
- Add geometric partial erasing with swept hit testing, interpolated pressure, editable fragments and one-gesture undo/redo. Keep whole-stroke erasing and make return to the previous pen configurable.
- Compact the ink toolbar: move secondary tools, custom color, width and eraser options into More; keep consistent touch targets and visible save status.
- Save active Markdown editors before entering ink mode; failed saves retain their drafts. Sidebar/page editing releases ink capture, text inputs retain their keyboard shortcuts, and trailing ink clicks cannot open or close Markdown editors.
- Preserve sampled strokes during page recycling/tool changes, clear queued live previews and release old canvas handlers on unload.
- Add geometry/event regressions and browser checks for handwriting, palm-first input, erase/undo/redo, pinch routing, narrow toolbars and Markdown autosave/failure recovery. Hardware tablet validation remains outstanding.

## 0.34.2

- Serialize plugin settings writes and snapshot at execution time, preventing overlapping autosaves/preferences writes from completing in reverse order and restoring old note data. Failed writes still reject to the original editor and do not block subsequent saves.
- Add persistence regression cases for concurrent writes, failure rollback, queue recovery and exact retry content.
- Add 105 chained browser workflow checks across mouse/touch/pen event sequences: creation, IME, paragraph/table editing, autosave, page/sidebar switching, cancelled gestures, page recycling, in-flight typing, rapid switches, failed blank exits and failed first-save recovery.
- Reread the in-memory durable store in workflow tests, verifying saved source rather than only the live editor. Physical tablet/browser-engine testing remains a separate validation step.

## 0.34.1

- Create PDF Markdown page-note editors on the completed placement click and consume that gesture before installing outside-click save/exit. The trailing click from the original pointerdown can no longer immediately close an empty draft.
- Guard pending placement against duplicate clicks and honor Escape while an existing note save is in progress.
- Add full pointerdown/pointerup/click regression coverage, empty editor idle retention, touch/pen sequences and cancelled/double-click placement races. Preserve subsequent blank-click save/exit and autosave behavior.

## 0.34.0

- Measure Canvas natural height from the unconstrained clone alone. Old fixed card height and empty outer space no longer become a minimum height.
- Keep valid rendered measurements instead of replacing short text with larger screenshot/Markdown estimates. Keep post-fit overflow correction for long content.
- Version actual measurements so old oversized caches, including previous Height locks, are remeasured when Canvas opens. Preserve geometry until DOM exists; unchanged current measurements do not refit on movement.
- Do not lock estimated heights. Retry them when rendered, restore saved text/image mode before measuring, and ignore hidden pending screenshots.
- Add legacy-cache, lock invalidation and stale-height regressions plus native Canvas checks for repeated fitting, image/text switching, narrow cards and zoom.

## 0.33.0

- Autosave page Markdown notes after 800 ms idle. Save before leaving via a blank PDF click, switching page notes or entering sidebar editing. Failed writes retain the current editor and draft.
- Give newly placed page notes a stable identity across autosaves, preserving a single note and placement. Cancel retains the latest successfully saved content.
- Add a bordered corner toggle that stays available after collapsing the sidebar, reflects its current state and preserves ongoing drafts.
- Default new centralized storage to `Lucia's Marginbook`, preserving explicit existing roots until a backed-up offline migration updates references and caches.
- Extend native browser coverage for page saves, failures, page/sidebar switching, new note identity and collapse/reopen state.

## 0.32.0

- Autosave sidebar note changes after 800 ms idle, keeping the live editor and caret in place. Serialize writes and drain edits made during a pending write.
- Clicking another card saves the current note before entering the target editor. Queue rapid switches and keep the current draft and selection when saving fails.
- Show persistent save status and failure notices. Finish flushes and closes; Cancel discards only changes newer than the last successful autosave.
- Remove the textarea default two-row height floor and remeasure from a collapsed height, so short paragraphs use a single line and shrink after deletions.
- Cover autosave, failed writes, switching, overlapping edits and native single-line sizing in regression tests.

## 0.31.0

- Unify PDF note toolbar control heights and compact the numeric font field; remove the redundant Edit action while preserving direct text editing and touch targets.
- Persist sidebar selection on the matching page Markdown block and excerpt marks, including a page/ordinal badge. Scope selection to its PDF view and restore it after rerendering.
- Edit ordinary and quick notes directly in sidebar cards using the shared paragraph-level Markdown editor, without a modal or duplicate preview. Preview drafts on placed page blocks while retaining canonical save/cancel behavior.
- Preserve editor DOM, caret and drafts across sidebar refreshes and PDF switches. Keep failed saves editable and prevent competing editors or destructive card actions during editing.
- Add sidebar persistence, failure, selection-scope and cancel regressions, plus 32 native browser checks; rerun 54 page-layout checks.


## 0.30.0

- Add centralized MarginBook storage grouped by source hierarchy and PDF name, keeping original PDFs in place. Use one resolver for excerpt creation, Canvas creation/sync, screenshots and cleanup.
- Persist explicit primary and per-Canvas source bindings so historical excerpt copies retain their notes and cannot overwrite another Canvas source. Scope comment lookup and mirroring to the correct Markdown source.
- Open the canonical excerpt directly from the PDF command and display the central storage policy in settings and toolbar descriptions.
- Keep preexisting installations on legacy paths until explicitly migrated; fresh installations use central storage. Add storage integration tests for creation/reuse, directory collisions, source ownership and settings persistence.


## 0.29.3

- Float the live-edit Save/Cancel bar above the note instead of inserting it into the text flow. Keep page anchors and available body height identical in reading and editing modes, including notes near the page bottom.
- Match paragraph spacing and remove textarea padding; size before focusing and preserve ancestor scroll positions during paragraph activation.
- Add 54 native browser layout checks across two font sizes and three page positions, plus a page-bottom anchor regression.


## 0.29.2

- Recover exact text anchors when PDF.js splits a word across individual spans. Keep source-node offsets and nearest-position matching for repeated phrases.
- Add a character-per-span lookup regression to support reanchoring legacy excerpts after toolbar contamination is cleaned.


## 0.29.1

- Restrict excerpt origin to the PDF text layer and clip crossing selections before extracting text, coordinates, link offsets or screenshots. Ignore editor mouseup events and make overlay controls unselectable.
- Preserve the sanitized range for desktop and mobile capture; map text-layer element boundaries to stable selection offsets.
- Reject out-of-range span offsets and partial-text matches during highlight reconstruction; use the page owner document for ranges.
- Add a native-browser regression fixture with 15 checks for forward/reverse selections, overlay crossings, toolbar exclusion, exact offsets, screenshot ranges and highlight geometry.


## 0.29.0

- Replace the duplicate input/preview with one document flow: click a rendered paragraph to edit its Markdown source, while other blocks stay rendered.
- Keep tables, lists, code fences and display math intact as editable blocks. Map clicked text to source caret positions and preserve whitespace between blocks.
- Support cross-block paste, paragraph insertion, document undo/redo and Chinese IME without duplicating active content. Retain save/cancel, shared-source synchronization and failed-save drafts.
- Add structural parsing, switching, caret mapping, undo/redo, insertion, paste and IME regressions.


## 0.28.0

- Edit placed notes directly inside the PDF text block, with a small auto-growing Markdown input (60–180px), live preview below, Save/Cancel and Ctrl/Cmd+Enter/Escape shortcuts.
- Create page notes in place instead of opening a large modal. Unplaced sidebar notes use a compact, stacked editor dialog.
- Keep unsaved previews isolated from the shared note source; retain drafts after save failures and roll back failed quick-note writes. Guard asynchronous preview ordering and Chinese IME composition.
- Preserve inline editors through background refreshes and PDF.js page recycling; restore page placement after leaving edit mode.
- Cover inline preview/save/cancel/failure, stale preview ordering, page recycling and cancelled creation in integration tests.

## 0.27.0

- Make page-overlay tables, headers and cells follow the block font size, overriding theme table sizes while retaining heading hierarchy.
- Add labeled A−/A+ font-size controls with 8–72 bounds and larger touch targets.
- Add a PDF toolbar action for standalone Markdown page notes: click an empty page position, edit, and save to both page and sidebar without selecting source text.
- Persist standalone notes in the existing quick-note store, avoid excerpt highlights/fallback marks, update page ownership on replacement, and remove page placement on deletion. Cancelled creation leaves no draft; failed saves roll back new records.
- Add page-note creation, cancellation, stale-file protection, failed-save rollback and size-button regression coverage; expand the browser fixture to test tables against fixed theme sizes.

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
