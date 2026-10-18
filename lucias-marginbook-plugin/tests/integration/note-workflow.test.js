"use strict";
const assert = require("node:assert/strict"), Module = require("node:module");
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === "obsidian") return { Plugin: class {}, TFile: class {}, Notice: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, FuzzySuggestModal: class {}, normalizePath: x => x, setIcon() {} };
  return original.call(this, name, ...args);
};
const P = require("../../main.js"); Module._load = original;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const p = new P(); p.settings = { a: 1 };
  p._lmbPrunePersistedCaches = () => {};
  p.settingsStore = { serialize: settings => JSON.parse(JSON.stringify(settings)) };
  return p;
}
async function main() {
  const p = fixture(), gate = deferred(), writes = [];
  let disk;
  p.saveData = async snapshot => { writes.push(snapshot); if (writes.length === 1) await gate.promise; disk = snapshot; };
  const first = p.saveSettings(); await tick();
  p.settings.b = 2; const second = p.saveSettings(); await tick();
  assert.equal(writes.length, 1, "overlapping note/settings writes must wait for earlier writes");
  gate.resolve(); await Promise.all([first, second]); assert.deepEqual(disk, { a: 1, b: 2 }, "late completion cannot restore an older snapshot");

  const failed = fixture(), failGate = deferred(); let attempts = 0, failedDisk;
  failed.settings = { quickExcerpts: { "test.pdf": [{ exId: "a", note: "original A" }, { exId: "b", note: "original B" }] } };
  failed.saveData = async snapshot => { if (++attempts === 1) { await failGate.promise; throw Error("disk full"); } failedDisk = snapshot; };
  const saveA = failed.lmbSaveTextBlockNote({ pdfPath: "test.pdf", exId: "a", quick: true }, "unsaved A");
  const caughtA = saveA.catch(e => e); await tick();
  const saveB = failed.lmbSaveTextBlockNote({ pdfPath: "test.pdf", exId: "b", quick: true }, "saved B");
  failGate.resolve(); assert((await caughtA) instanceof Error); await saveB;
  assert.equal(failedDisk.quickExcerpts["test.pdf"][0].note, "original A", "failed note rollback happens before the next snapshot");
  assert.equal(failedDisk.quickExcerpts["test.pdf"][1].note, "saved B", "a failed write must not poison the queue");
  await failed.lmbSaveTextBlockNote({ pdfPath: "test.pdf", exId: "a", quick: true }, "retry A");
  assert.equal(failedDisk.quickExcerpts["test.pdf"][0].note, "retry A");
  console.log("Note workflow persistence: ordered writes, failure rollback, queue recovery and retries passed");
}
main().catch(err => { console.error(err); process.exitCode = 1; });
