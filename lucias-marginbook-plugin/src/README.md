# Source architecture

`main.js` is generated. Edit files under `src/`, then run `npm run build`.

- `core/`: plugin composition, lifecycle, runtime state, and settings persistence
- `excerpt/`: excerpt parsing, indexing, and Markdown synchronization
- `canvas/`: layout, persistence coordination, card actions, and toolbar behavior
- `pdf/`: selection, marks, and navigation
- `note/`: note/comment parsing and editing
- `ui/`: toolbar resolution, modals, settings UI
- `shared/`: constants, styles, and low-level helpers

The build order is declared in `build.config.js`; it is not inferred from names.
