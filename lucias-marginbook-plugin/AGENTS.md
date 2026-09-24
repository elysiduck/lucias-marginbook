# Repository workflow

For changes under this plugin directory:

1. Edit source files under `src/`; never hand-edit generated `main.js`.
2. Run `npm run build` and `npm run verify` after implementation.
3. After a successful build and verification, sync `main.js` and `manifest.json` to
   `D:\\下载\\文档\\Obsidian\\往昔的涟漪\\.obsidian\\plugins\\lucias-marginbook\\`.
   Confirm the deployed `main.js` hash matches the build output before reporting completion.
4. After a user-requested change is complete and verification passes, commit only
   this plugin directory and push it to `origin/main`, unless the user explicitly
   asks not to push.
5. Use `npm run backup -- "<concise commit message>"` for the verified commit and
   push workflow.
