"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sources = require("./build.config.js");

const root = __dirname;
const outputPath = path.join(root, "main.js");

function readSource(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Missing source module: ${relativePath}`);
  return fs.readFileSync(absolutePath, "utf8").replace(/\s+$/, "");
}

function buildText() {
  return sources.map(readSource).join("\n\n") + "\n";
}

function digest(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

const next = buildText();
if (process.argv.includes("--check")) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== next) {
    console.error("main.js is stale. Run `npm run build`.");
    process.exitCode = 1;
  } else {
    console.log(`Build is current (${sources.length} modules, sha256:${digest(next)}).`);
  }
} else {
  fs.writeFileSync(outputPath, next, "utf8");
  console.log(`Built main.js from ${sources.length} modules (sha256:${digest(next)}).`);
}
