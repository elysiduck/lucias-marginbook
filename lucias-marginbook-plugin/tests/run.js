"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const suites = [
  "tests/unit/build.test.js",
  "tests/unit/architecture.test.js",
  "tests/unit/ink.test.js",
  "tests/integration/behavior.test.js",
  "tests/integration/navigation.test.js",
  "tests/integration/text-block.test.js",
  "tests/integration/note-workflow.test.js",
  "tests/integration/storage.test.js"
];

for (const suite of suites) {
  const result = spawnSync(process.execPath, [suite], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`MarginBook test suites: ${suites.length} passed`);
