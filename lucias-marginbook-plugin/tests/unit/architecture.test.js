"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const plugin = fs.readFileSync(path.join(root, "src/core/plugin.js"), "utf8");
const state = fs.readFileSync(path.join(root, "src/core/runtime-state.js"), "utf8");
const settings = fs.readFileSync(path.join(root, "src/core/settings-store.js"), "utf8");
const foundation = fs.readFileSync(path.join(root, "src/shared/foundation.js"), "utf8");

assert(plugin.includes("new LmbRuntimeState()"));
assert(plugin.includes("new LmbSettingsStore(this)"));
assert(state.includes("class LmbRuntimeState"));
assert(settings.includes("class LmbSettingsStore"));
assert(settings.includes("autoCleanOnDelete"));
assert(settings.includes("autoAttachScreenshot"));
assert(plugin.includes("this.isMobile = LMB_IS_MOBILE"));
assert(plugin.includes('"selectionchange"'));
assert(foundation.includes('.lmb-excerpt-id{display:none!important;}'));
assert(!foundation.includes('p:has(>.lmb-excerpt-id){display:none!important;}'));
assert.equal(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).isDesktopOnly, false);
console.log("Architecture boundary verification passed");
