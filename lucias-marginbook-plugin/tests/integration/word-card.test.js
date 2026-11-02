"use strict";
const assert = require("node:assert/strict"), Module = require("node:module"), fs = require("node:fs"), vm = require("node:vm");
class TFile { constructor(path) { this.path = path; this.name = path.split('/').pop(); this.extension = path.split('.').pop(); } }
let request, notices = [], modals = [];
const original = Module._load;
Module._load = function(name, ...rest) {
  if (name === "obsidian") return { Plugin: class {}, TFile, Notice: class { constructor(message) { notices.push(message); } }, PluginSettingTab: class {}, Setting: class {}, Modal: class { open() { modals.push(this); } }, FuzzySuggestModal: class {}, normalizePath: x => x, setIcon() {}, requestUrl: args => request(args) };
  return original.call(this, name, ...rest);
};
const P = require("../../main.js"); Module._load = original;
const { lmbWordEndpoint, lmbWordMarkdown } = P.__test;
const result = { meaning: "显著的", pos: "形容词", phonetic: "", translation: "一个显著特征。", example: "A salient point.", exampleTranslation: "一个要点。" };
const response = () => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify(result) } }] } });
function fixture() {
  const p = new P(), source = new TFile("book-excerpts.md"), pdf = new TFile("book.pdf"); let raw = "<!-- LMB:BEGIN -->\n<!-- LMB:END -->\n";
  p.settings = { wordAiUrl: "https://example.test/v1", wordAiKey: "secret-key", wordAiModel: "test-model", wordAiContext: true };
  p.app = { vault: { cachedRead: async () => raw, getAbstractFileByPath: path => path === source.path ? source : null,
    process: async (_, transform) => { raw = transform(raw); } } };
  p.lmbEnsureExcerptMdFile = async () => source;
  p.reindexFile = async () => {}; p.lmbRefreshAllMarks = () => {}; p.lmbSchedulePdfSidebarRefresh = () => {}; p.lmbRevealPdfSidebarEntry = () => {};
  const info = { file: pdf, text: "salient", pageNum: 12, selectionParams: "1,0,1,7", link: "[[book.pdf#page=12&selection=1,0,1,7&target=salient|P.12]]" };
  return { p, source, info, raw: () => raw, setRaw: value => { raw = value; } };
}
async function main() {
  assert.equal(lmbWordEndpoint("https://example.test/v1/"), "https://example.test/v1/chat/completions");
  assert.equal(lmbWordEndpoint("http://localhost:11434/v1/chat/completions"), "http://localhost:11434/v1/chat/completions");
  for (const url of ["file:///a", "https://u:password@example.test", "https://example.test?key=secret"]) assert.throws(() => lmbWordEndpoint(url));
  assert(!lmbWordMarkdown('<img src=x> [[a.pdf#page=1]] ^ex-aaaa').includes('<img'));
  let calls = 0;
  request = async args => { calls++; assert.equal(args.headers.Authorization, "Bearer secret-key"); const body = JSON.parse(args.body); assert.equal(body.model, "test-model"); assert.equal(body.stream, false); return response(); };
  const f = fixture(); await f.p.lmbCreateAiWordCard(f.info);
  const entries = P.__test.lmbParseExcerptDoc(f.raw(), f.source.path);
  assert.equal(entries.length, 1); assert.equal(entries[0].wordCard, true); assert.equal(entries[0].word, "salient"); assert.deepEqual(entries[0].selection, [1,0,1,7]);
  const entry = entries[0]; assert(f.p._lmbFindSidebarNote(f.raw(), entry.exId).includes("显著的"));
  await f.p.lmbCreateAiWordCard(f.info); assert.equal(calls, 1, "same occurrence does not query or create twice");
  assert.equal(P.__test.lmbParseExcerptDoc(f.raw(), f.source.path).length, 1);
  const different = fixture(); let finish;
  request = () => new Promise(resolve => { finish = resolve; });
  const creating = different.p.lmbCreateAiWordCard(different.info);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await different.p.lmbCreateAiWordCard(different.info);
  const pendingEntry = P.__test.lmbParseExcerptDoc(different.raw(), different.source.path)[0];
  different.setRaw(different.raw().replace(/正在查询词义[^\n]+/, "用户在等待期间写入的备注"));
  finish(response()); await creating;
  assert(different.p._lmbFindSidebarNote(different.raw(), pendingEntry.exId).includes("用户在等待期间"));
  assert(modals.at(-1).opts.value.includes("显著的"), "conflicting response remains available for manual merge");
  const failing = fixture(); request = async () => ({ status: 401, text: "secret-key" });
  await failing.p.lmbCreateAiWordCard(failing.info);
  const failedEntry = P.__test.lmbParseExcerptDoc(failing.raw(), failing.source.path)[0];
  assert(failing.raw().includes("查询未完成")); assert(!notices.join(" ").includes("secret-key"));
  request = async () => response(); await failing.p.lmbRetryWordCard(failedEntry);
  assert(failing.p._lmbFindSidebarNote(failing.raw(), failedEntry.exId).includes("显著的"));
  const malformed = fixture(); request = async () => ({ status: 200, json: { choices: [{ message: { content: "not JSON" } }] } });
  await malformed.p.lmbCreateAiWordCard(malformed.info); assert(malformed.raw().includes("查询未完成"));
  const deleted = fixture(); let resolveDeleted;
  request = () => new Promise(resolve => { resolveDeleted = resolve; });
  const pendingDelete = deleted.p.lmbCreateAiWordCard(deleted.info);
  while (!resolveDeleted) await new Promise(resolve => setImmediate(resolve));
  deleted.setRaw(""); resolveDeleted(response()); await pendingDelete;
  assert.equal(deleted.raw(), "", "late AI response cannot resurrect a deleted card");
  const plain = P.__test.lmbParseExcerptDoc('> [[book.pdf#page=1&selection=0,0,0,1|p]]\n> a\n> ^ex-plain1', 'x.md');
  assert(!plain[0].wordCard, "ordinary one-word excerpts stay ordinary");
  const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync('src/core/settings-store.js', 'utf8') + ';globalThis.Store=LmbSettingsStore;', ctx);
  const store = new ctx.Store({ _lmbSerializedRuntimeCaches: {} });
  const saved = store.serialize({ ...f.p.settings, wordAiContext: false }, {});
  const loaded = await new ctx.Store({ loadData: async () => saved }).load();
  for (const key of ['wordAiUrl', 'wordAiKey', 'wordAiModel', 'wordAiContext']) assert.equal(loaded.settings[key], saved[key]);
  console.log("AI vocabulary: request binding, persistence, classification, deduplication, retry, malformed output, deletion safety and settings roundtrip passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
