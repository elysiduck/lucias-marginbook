"use strict";

// The order is explicit because the production artifact is one Obsidian CommonJS
// module. Source files may share that bundle scope, but their dependency order is
// never inferred from filenames or directory enumeration.
module.exports = Object.freeze([
  "src/bootstrap.js",
  "src/vendor/pdf-lib.js",
  "src/pdf/pure-page-edit.js",
  "src/shared/foundation.js",
  "src/compat/obsidian-adapters.js",
  "src/note/pure-note.js",
  "src/canvas/pure-interaction.js",
  "src/canvas/pure-layout.js",
  "src/canvas/pure-tree.js",
  "src/excerpt/pure-excerpt.js",
  "src/pdf/pure-ink.js",
  "src/pdf/pure-ink-links.js",
  "src/pdf/pure-live-markdown.js",
  "src/ui/toolbar.js",
  "src/canvas/canvasbar-pure.js",
  "src/core/runtime-state.js",
  "src/core/settings-store.js",
  "src/core/plugin.js",
  "src/pdf/page-edit-controller.js",
  "src/pdf/ink-controller.js",
  "src/pdf/ink-links-controller.js",
  "src/pdf/selection-controller.js",
  "src/canvas/canvas-controller.js",
  "src/note/note-comment-controller.js",
  "src/excerpt/index-service.js",
  "src/excerpt/storage-paths.js",
  "src/pdf/mark-service.js",
  "src/pdf/sidebar-controller.js",
  "src/pdf/text-block-controller.js",
  "src/pdf/live-editor-controller.js",
  "src/pdf/sidebar-note-editor.js",
  "src/pdf/navigation-service.js",
  "src/canvas/canvasbar-controller.js",
  "src/ui/modals.js",
  "src/ui/settings-tab.js",
  "src/exports.js"
]);
