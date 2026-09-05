# Repository workflow

For changes under this plugin directory:

1. Edit source files under `src/`; never hand-edit generated `main.js`.
2. Run `npm run build` and `npm run verify` after implementation.
3. After a user-requested change is complete and verification passes, commit only
   this plugin directory and push it to `origin/main`, unless the user explicitly
   asks not to push.
4. Use `npm run backup -- "<concise commit message>"` for the verified commit and
   push workflow.
