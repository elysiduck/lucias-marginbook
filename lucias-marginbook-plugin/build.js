// 构建脚本：按固定顺序拼接 src/ → main.js（Obsidian 只加载单文件）。
// 用法：node build.js   （改完 src/ 里任何文件后重跑即可）
"use strict";
const fs = require("fs");
const path = require("path");

const ORDER = [
  "00-header.js",
  "01-deps.js",
  "10-constants.js",
  "23-pure-note.js",
  "20-pure-interaction.js",
  "21-pure-layout.js",
  "22-pure-tree.js",
  "24-pure-excerpt.js",
  "30-plugin-core.js",
  "31-plugin-selection.js",
  "32-plugin-canvas.js",
  "33-plugin-note-comment.js",
  "34-plugin-excerpt-index.js",
  "35-plugin-marks.js",
  "36-plugin-jump.js",
  "40-modals.js",
  "41-settings-tab.js",
  "99-exports.js"
];

const out = ORDER.map((f) => fs.readFileSync(path.join(__dirname, "src", f), "utf8").replace(/\n+$/, ""))
  .join("\n\n") + "\n";
fs.writeFileSync(path.join(__dirname, "main.js"), out);
console.log("built main.js:", out.split("\n").length, "lines from", ORDER.length, "files");
