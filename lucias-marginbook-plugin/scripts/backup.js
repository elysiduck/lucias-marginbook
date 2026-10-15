"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const pluginDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pluginDir, "..");
const relativePluginDir = path.relative(repoRoot, pluginDir).replace(/\\/g, "/");
const supplied = process.argv.slice(2).join(" ").trim();
const message = supplied || `backup: MarginBook ${new Date().toISOString()}`;

function run(command, args, cwd = repoRoot, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit"
  });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    if (capture) process.stderr.write(result.stderr || result.stdout || "");
    process.exit(result.status || 1);
  }
  return (result.stdout || "").trim();
}

// npm.cmd cannot be spawned directly without a shell on current Node/Windows.
// npm run supplies its JS entry point, which works with the same Node runtime
// and does not require passing commands through cmd.exe.
if (process.env.npm_execpath) {
  run(process.execPath, [process.env.npm_execpath, "run", "verify"], pluginDir);
} else {
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "verify"], pluginDir);
}
run("git", ["add", "--", relativePluginDir]);

const staged = run("git", ["diff", "--cached", "--name-only", "--", relativePluginDir], repoRoot, true);
if (!staged) {
  console.log("No plugin changes to back up.");
  process.exit(0);
}

run("git", ["commit", "-m", message, "--", relativePluginDir]);
run("git", ["push", "origin", "HEAD:main"]);
console.log("MarginBook changes backed up to origin/main.");
