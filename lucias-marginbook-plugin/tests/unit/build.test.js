"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const sources = require("../../build.config.js");

const root = path.resolve(__dirname, "../..");
assert.equal(new Set(sources).size, sources.length, "build modules must be unique");
for (const source of sources) assert(fs.existsSync(path.join(root, source)), `missing ${source}`);

const check = spawnSync(process.execPath, ["build.js", "--check"], { cwd: root, encoding: "utf8" });
assert.equal(check.status, 0, check.stderr || check.stdout);
console.log("Build manifest verification passed");
