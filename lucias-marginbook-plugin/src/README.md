# Source architecture

`main.js` is generated. Edit files under `src/`, then run `npm run build`.

- `core/`: plugin composition, lifecycle, runtime state, and settings persistence
- `excerpt/`: excerpt parsing, indexing, and Markdown synchronization
- `canvas/`: layout, persistence coordination, card actions, and toolbar behavior
- `pdf/`: selection, marks, and navigation
- `pdf/page-edit-controller.js`: thumbnail context menus, offline blank-page insertion, coordinated page-reference migration, verified backups and startup recovery
- `vendor/`: locally bundled pdf-lib 1.17.1 and retained dependency license notices
- `note/`: note/comment parsing and editing
- `ui/`: toolbar resolution, modals, settings UI
- `shared/`: constants, styles, and low-level helpers

The build order is declared in `build.config.js`; it is not inferred from names.

## PDF blank pages

Open the PDF thumbnail rail. Right-click a thumbnail, or hold it for 550 ms with touch/pen, then choose insertion before or after that page. Movement over 10 CSS pixels, scrolling or another finger cancels the hold. The PDF remains at its original path. This changes its actual page count; it is not a virtual overlay.

Before writing, active Markdown editors and ink storage must save successfully. The controller checks file versions and current Canvas data, backs up each affected file under `.obsidian/plugins/lucias-marginbook/page-backups/<transaction>/`, then writes and rereads all changes. `manifest.json` maps numbered backups to their original paths. Keep the entire backup directory for manual recovery. A failed or interrupted transaction is restored using `page-edit-pending.json` before settings load; failed recovery prevents continued plugin writes until the storage problem is resolved and the plugin reloads.

Encrypted PDFs and detected signed PDFs are rejected. Third-party page-number metadata outside known MarginBook stores and resolved Markdown/Canvas PDF links is not rewritten. Physical mobile hardware needs a separate test; browser pointer simulations cover touch/pen menus and cancellation.
