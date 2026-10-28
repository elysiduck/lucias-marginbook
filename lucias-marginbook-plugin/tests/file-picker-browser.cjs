// Real Edge + installed Obsidian CSS/PDF.js + a real course PDF. The small
// Obsidian API fixture tests UI behavior without touching a running workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const asar = process.env.OBSIDIAN_ASAR_PATH || 'E:/Users/ZephyrusG14/AppData/Local/Programs/Obsidian/resources/obsidian.asar';
const vault = process.env.OBSIDIAN_VAULT_PATH || 'D:/下载/文档/Obsidian/往昔的涟漪';
function asset(name) {
  const fd = fs.openSync(asar, 'r');
  try {
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12)); fs.readSync(fd, header, 0, header.length, 16);
    const entry = name.split('/').reduce((node, key) => node.files[key], JSON.parse(header));
    const buffer = Buffer.alloc(entry.size); fs.readSync(fd, buffer, 0, buffer.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    return buffer;
  } finally { fs.closeSync(fd); }
}
const pdfPath = path.join(vault, 'Books/pdf书籍/USC/508/Lecture 17 ECON508_FALL 2026.pdf');
const pdf = fs.readFileSync(pdfPath);
const fixture = () => {
  window.activeWindow = window;
  // Browser implementations of the Obsidian HTMLElement helpers used by this UI.
  Element.prototype.createEl = function(tag, opts = {}) {
    const el = document.createElement(tag);
    if (opts.text) el.textContent = opts.text;
    if (opts.cls) el.className = opts.cls;
    if (opts.type) el.type = opts.type;
    if (opts.placeholder) el.placeholder = opts.placeholder;
    for (const [key, value] of Object.entries(opts.attr || {})) el.setAttribute(key, value);
    this.appendChild(el); return el;
  };
  Element.prototype.createDiv = function(opts) { return this.createEl('div', opts); };
  Element.prototype.createSpan = function(opts) { return this.createEl('span', opts); };
  Element.prototype.empty = function() { this.replaceChildren(); };
  Element.prototype.setText = function(text) { this.textContent = text; };
  Element.prototype.addClass = function(cls) { this.classList.add(cls); };
  Element.prototype.toggleClass = function(cls, state) { this.classList.toggle(cls, state); };
  window.LuciasMarginBookPlugin = class {};
  window.Modal = class {
    constructor(app) {
      this.app = app;
      this.containerEl = document.body.createDiv({ cls: 'modal-container' });
      this.containerEl.createDiv({ cls: 'modal-bg' });
      this.modalEl = this.containerEl.createDiv({ cls: 'modal' });
      this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' });
      this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
    }
    open() { this.onOpen(); }
    close() { this.onClose(); this.containerEl.remove(); }
  };
  window.Component = class { load() {} unload() { window.unloads++; } };
  window.unloads = 0; window.opens = []; window.refs = new Set();
  window.Notice = class { constructor(message) { window.lastNotice = message; } };
  window.setIcon = el => { el.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/></svg>'; };
  window.loadPdfJs = async () => {
    const lib = await import('/lib/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = '/lib/pdfjs/pdf.worker.min.mjs'; return lib;
  };
  window.MarkdownRenderer = { async render(app, text, el) {
    if (text === 'slow') await new Promise(resolve => setTimeout(resolve, 400));
    el.createEl('h2', { text: text === 'slow' ? '过期的预览' : 'Lecture 17 · 详细梳理' });
    el.createEl('p', { text: '这里显示笔记正文。预览采用 Obsidian 的 Markdown 渲染接口。' });
  } };
  window.TFile = class {
    constructor(name, folder = 'Books/pdf书籍/USC/508') {
      this.basename = name.replace(/\.[^.]+$/, ''); this.extension = name.split('.').pop();
      this.path = folder + '/' + name; this.parent = { path: folder }; this.stat = { mtime: Date.UTC(2026, 9, 28), size: 1000 };
    }
  };
  window.files = [new TFile('Lecture 17 ECON508_FALL 2026.pdf'), new TFile('Lecture 17 ECON508_详细梳理.md'),
    new TFile('Lecture 15 ECON508_FALL 2026.pdf'), new TFile('Lecture 15 ECON508_逐页精读.md'), new TFile('Lecture 16 Discussion ECON508 FALL 2026.pdf'),
    new TFile('封面.png'), new TFile('slow.md'), new TFile('other.md', 'Other')];
  for (let i = 0; i < 100; i++) files.push(new TFile(`资料 ${i}.md`, 'Archive'));
  const leaf = { async openFile(file) { window.opens.push({ path: file.path, tab: false }); } };
  window.app = {
    vault: {
      getFiles: () => files, getAllLoadedFiles: () => [{ path: 'Books/pdf书籍/USC/508', children: [] }, { path: 'Other', children: [] }, { path: 'Archive', children: [] }],
      getAbstractFileByPath: name => files.find(file => file.path === name),
      readBinary: async () => Uint8Array.from(atob(window.coursePDF), char => char.charCodeAt(0)).buffer,
      cachedRead: async file => file.basename === 'slow' ? 'slow' : 'normal', getResourcePath: file => file.extension === 'pdf' ? '/course.pdf' : '/image.svg',
      on(event, fn) { const ref = { event, fn }; refs.add(ref); return ref; }, offref: ref => refs.delete(ref)
    },
    workspace: { activeLeaf: leaf, getLastOpenFiles: () => files.slice(0, 5).map(file => file.path), getLeaf: () => ({ async openFile(file) { opens.push({ path: file.path, tab: true }); } }) },
    metadataCache: { getFileCache: file => ({ frontmatter: { aliases: file.extension === 'pdf' ? ['课程讲义'] : [] } }), resolvedLinks: {} }
  };
};
(async () => {
  const resources = new Map([['/app.css', asset('app.css')], ['/course.pdf', pdf]]);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/public/fonts/')) {
      try { res.setHeader('Content-Type', 'font/woff2'); res.end(asset(req.url.slice(1))); } catch { res.writeHead(404); res.end(); } return;
    }
    if (req.url.startsWith('/lib/pdfjs/')) {
      try { res.setHeader('Content-Type', 'text/javascript'); res.end(asset(req.url.slice(1))); } catch { res.writeHead(404); res.end(); } return;
    }
    if (resources.has(req.url)) { res.statusCode = 200; res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.setHeader('Content-Length', resources.get(req.url).length); res.end(resources.get(req.url)); return; }
    if (req.url === '/image.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="green"/></svg>'); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"><body class="theme-dark is-frameless"><div style="padding:30px;color:#888">MarginBook 文件选择器 · 浏览器验证</div></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const checks = []; const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') console.log(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(fixture);
    await page.evaluate(base64 => { window.coursePDF = base64; }, pdf.toString('base64'));
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'src/ui/file-picker.js'), 'utf8') + '\nwindow.Picker = LMBFilePickerModal;' });
    await page.addStyleTag({ content: await page.evaluate(() => LMB_FILE_PICKER_CSS) });
    await page.evaluate(() => { window.plugin = new LuciasMarginBookPlugin(); window.picker = new Picker(app, plugin); plugin._lmbFilePicker = picker; picker.open(); });
    await page.waitForSelector('.lmb-fp-pdf-stage canvas', { timeout: 15000 }).catch(async error => { console.error(await page.locator('.lmb-fp-preview').innerText(), errors); throw error; });
    await page.waitForFunction(() => picker.pdfCache.size > 0);
    checks.push('Real installed PDF.js renders the real Lecture 17 course PDF');
    const geometry = await page.evaluate(() => {
      const modal = document.querySelector('.modal').getBoundingClientRect();
      const left = document.querySelector('.lmb-fp-left').getBoundingClientRect();
      const preview = document.querySelector('.lmb-fp-preview').getBoundingClientRect();
      return { modal: { width: modal.width, height: modal.height, x: modal.x, y: modal.y }, left: left.width, preview: preview.width, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert(geometry.left > 350 && geometry.preview > 400 && !geometry.overflow, JSON.stringify(geometry));
    const evidence = path.join(__dirname, 'evidence'); fs.mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, 'file-picker-0.46.0.png') });
    await page.getByRole('button', { name: '下一页 →', exact: true }).click();
    await page.waitForFunction(() => picker.pdfPage === 2 && picker.pdfCache.size >= 2);
    checks.push('PDF next page renders and caches independently');
    await page.locator('.lmb-fp-search input').fill('详细梳理');
    await page.waitForFunction(() => picker.results.length === 1);
    await page.waitForSelector('.markdown-rendered h2');
    checks.push('Search updates selection and renders Markdown with a managed component');
    await page.locator('.lmb-fp-search input').fill('课程讲义');
    await page.waitForFunction(() => picker.results.length === 3);
    checks.push('Frontmatter aliases match without being filenames');
    await page.getByRole('button', { name: '笔记', exact: true }).click();
    await page.waitForFunction(() => picker.results.length === 0);
    assert(await page.locator('.lmb-fp-empty').first().isVisible());
    checks.push('Type filter combines with search and displays empty state');
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page.locator('.lmb-fp-search input').fill('');
    await page.waitForFunction(() => picker.results.length === 108);
    await page.locator('.lmb-fp-folder').selectOption('Other');
    await page.waitForFunction(() => picker.results.length === 1);
    assert.equal(await page.locator('.lmb-fp-name').textContent(), 'other');
    checks.push('Folder filter restricts results');
    await page.locator('.lmb-fp-folder').selectOption('');
    await page.getByRole('button', { name: '最近打开', exact: true }).click();
    await page.waitForFunction(() => picker.results.length === 5);
    checks.push('Recent filter lists only history entries');
    await page.getByRole('button', { name: '最近打开', exact: true }).click();
    await page.locator('.lmb-fp-search input').fill('slow');
    await page.waitForFunction(() => picker.lastQuery === 'slow');
    await page.waitForTimeout(160);
    await page.locator('.lmb-fp-search input').fill('Lecture 17');
    await page.waitForFunction(() => picker.lastQuery === 'Lecture 17');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.lmb-fp-preview h3').textContent(), 'Lecture 17 ECON508_FALL 2026');
    assert.equal(await page.getByText('过期的预览', { exact: true }).count(), 0);
    checks.push('A delayed Markdown renderer cannot overwrite a newer PDF selection');
    await page.locator('.lmb-fp-search input').press('ArrowDown');
    assert.equal(await page.evaluate(() => picker.selected), 1);
    await page.locator('.lmb-fp-search input').press('Control+Enter');
    assert.equal(await page.locator('.modal').count(), 0);
    assert.equal(await page.evaluate(() => refs.size), 0);
    assert.equal(await page.evaluate(() => opens.at(-1).tab), true);
    checks.push('Arrow navigation, Ctrl+Enter opens a new tab, close removes all vault listeners');
    await page.evaluate(() => { window.picker = new Picker(app, plugin); plugin._lmbFilePicker = picker; picker.open(); });
    await page.locator('.lmb-fp-search input').press('Enter');
    assert.equal(await page.evaluate(() => opens.at(-1).tab), false);
    checks.push('Enter opens in the original leaf');
    await page.evaluate(() => { window.picker = new Picker(app, plugin); picker.open(); });
    await page.setViewportSize({ width: 650, height: 900 });
    await page.waitForTimeout(150);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    checks.push('Narrow viewport stays within screen bounds');
    await page.evaluate(() => picker.close());
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(evidence, 'file-picker-0.46.0.json'), JSON.stringify({ engine: 'headless Edge', actualObsidianCSS: true, actualPDFJS: true, actualCoursePDF: true, liveObsidian: false, checks, geometry, errors }, null, 2) + '\n');
    console.log(`PASS ${checks.length} file picker browser cases; screenshot saved`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
