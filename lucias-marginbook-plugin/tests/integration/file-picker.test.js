"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
class Plugin {}
const context = { LuciasMarginBookPlugin: Plugin, Modal: class {}, console, document: { createElement: () => ({ remove() { this.removed = true; } }), head: { appendChild() {} } } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../../src/ui/file-picker.js"), "utf8") + "\nglobalThis.pickerTest = { lmbPickerSearch, lmbPickerLectureKey };", context);
const { lmbPickerSearch: search, lmbPickerLectureKey: lectureKey } = context.pickerTest;
function file(name, folder = "USC/508", mtime = 1) {
  return { basename: name.replace(/\.[^.]+$/, ""), extension: name.split(".").pop(), path: `${folder}/${name}`, parent: { path: folder }, stat: { mtime } };
}
const pdf = file("Lecture 17 ECON508.pdf"), note = file("Lecture 17 ECON508_详细梳理.md"), other = file("Lecture 170 ECON508.md"), next = file("Lecture 15 ECON508.pdf"), outside = file("Lecture 17 ECON508.md", "USC/5080");
const files = [next, other, note, pdf, outside];
const paths = result => Array.from(result, item => item.file.path);
assert.deepEqual(paths(search(files, "508 lecture 17", "pdf", "USC/508", [], () => [])), [pdf.path]);
assert.deepEqual(paths(search(files, "Ｌｅｃｔｕｒｅ １７", "pdf", "", [], () => [])), [pdf.path]);
assert.deepEqual(paths(search(files, "逐页理解", "note", "", [], f => f === note ? ["逐页理解"] : [])), [note.path]);
assert.equal(search(files, "unmatched", "all", "", [], () => []).length, 0);
assert.equal(search(files, "", "all", "", [pdf.path, next.path], () => [])[0].file, pdf);
assert(!paths(search(files, "", "all", "USC/508", [], () => [])).includes(outside.path));
Object.assign(pdf.stat, { ctime: 10, mtime: 20 });
Object.assign(next.stat, { ctime: 40, mtime: 5 }); // Imported file with an older source modification date.
Object.assign(note.stat, { ctime: 15, mtime: 30 });
const sorted = mode => paths(search(files, "econ508", "all", "USC/508", [pdf.path, note.path], () => [], mode));
assert.deepEqual(sorted("opened").slice(0, 2), [pdf.path, note.path]);
assert.deepEqual(sorted("added"), [next.path, note.path, pdf.path, other.path]);
assert.deepEqual(sorted("modified"), [note.path, pdf.path, next.path, other.path]);
assert.deepEqual(sorted("activity"), [next.path, note.path, pdf.path, other.path]);
assert.equal(lectureKey(pdf), lectureKey(note));
assert.notEqual(lectureKey(pdf), lectureKey(other));
assert.equal(lectureKey(file("ECON508.md")), null);
// Real adapter functions: original homepage command, existing hotkeys, direct
// switcher calls, late layout readiness and full unload restoration.
const callbacks = [], listeners = {};
let normalCommands = 0, originalOpens = 0;
const instance = { open() { originalOpens++; } };
const command = { callback() { originalOpens++; }, checkCallback(checking) { if (!checking) originalOpens++; return true; } };
const originals = { open: instance.open, callback: command.callback, check: command.checkCallback };
const commands = { commands: { "switcher:open": command }, executeCommandById(id) { normalCommands++; return id; } };
originals.execute = commands.executeCommandById;
const plugin = new Plugin();
let newOpens = 0, closed = 0;
plugin.lmbOpenFilePicker = () => newOpens++;
plugin.addCommand = c => { plugin.command = c; };
plugin.register = cb => callbacks.push(cb);
plugin.registerEvent = () => {};
plugin.app = { commands, internalPlugins: { getPluginById: () => ({ instance }) }, workspace: { onLayoutReady(fn) { listeners.ready = fn; }, on(event, fn) { listeners[event] = fn; } } };
plugin.lmbSetupFilePicker();
listeners.ready(); listeners["layout-change"]();
instance.open(); command.callback();
assert.equal(command.checkCallback(true), true);
assert.equal(newOpens, 2, "checking a command must not open a modal");
command.checkCallback(false);
assert.equal(commands.executeCommandById("switcher:open"), true);
assert.equal(commands.executeCommandById("other"), "other");
plugin.command.callback();
assert.equal(newOpens, 5); assert.equal(originalOpens, 0); assert.equal(normalCommands, 1);
assert.equal(plugin.command.hotkeys[0].key, "k");
plugin._lmbFilePicker = { close() { closed++; } };
callbacks.forEach(fn => fn());
assert.equal(closed, 1);
assert.equal(instance.open, originals.open); assert.equal(command.callback, originals.callback);
assert.equal(command.checkCallback, originals.check); assert.equal(commands.executeCommandById, originals.execute);
instance.open(); assert.equal(originalOpens, 1);
// Another plugin may wrap our adapter after startup. Never overwrite its wrapper.
callbacks.length = 0; plugin.lmbSetupFilePicker();
const anotherWrapper = commands.executeCommandById = () => "another";
callbacks.forEach(fn => fn()); assert.equal(commands.executeCommandById, anotherWrapper);
console.log("File picker search, folder boundaries, Unicode/aliases, lecture association, command routing and unload restoration passed");
