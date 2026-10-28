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

## Standing backup authorization

On 2026-10-29, the user explicitly authorized committing and pushing this update
and future updates to this plugin to `https://github.com/elysiduck/lucias-marginbook`
using the workflow above. The authorized push destination is `origin/main` in
that repository. Verify the remote still points to that repository before pushing.
Keep commits scoped to this plugin directory; do not include unrelated workspace
files. Continue this backup workflow unless the user revokes or changes it.
