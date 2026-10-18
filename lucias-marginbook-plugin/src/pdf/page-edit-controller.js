/* Offline PDF page edits: backups and a recovery journal precede every write. */
Object.assign(LuciasMarginBookPlugin.prototype, {
  lmbPdfPageJournalPath() { return `.obsidian/plugins/${this.manifest?.id || 'lucias-marginbook'}/page-edit-pending.json`; },

  async lmbRecoverPdfPageEdit() {
    const adapter = this.app.vault.adapter, journalPath = this.lmbPdfPageJournalPath();
    if (!await adapter.exists(journalPath)) return;
    const journal = JSON.parse(await adapter.read(journalPath));
    if (!['writing', 'recovery-required'].includes(journal.phase)) return;
    const safe = path => typeof path === 'string' && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..');
    const prefix = `.obsidian/plugins/${this.manifest?.id || 'lucias-marginbook'}/page-backups/`;
    if (!Array.isArray(journal.files) || journal.files.some(item => !safe(item.path) || !safe(item.backup) || !item.backup.startsWith(prefix))) throw Error('PDF 插页恢复记录路径无效，请检查备份');
    for (const item of [...journal.files].reverse()) {
      if (item.binary) await adapter.writeBinary(item.path, await adapter.readBinary(item.backup));
      else await adapter.write(item.path, await adapter.read(item.backup));
    }
    journal.phase = 'rolled-back'; await adapter.write(journalPath, JSON.stringify(journal));
    this._lmbPdfPageRecoveryRequired = false;
    this._lmbPdfPageMutation = false;
    new Notice('已恢复未完成的 PDF 插页操作；原 PDF、备注与画布保持插页前状态', 6000);
  },

  lmbPdfPageLinkMatches(dest, source, pdfPath) {
    try { dest = decodeURIComponent(dest); } catch (_) {}
    dest = String(dest).replace(/\\/g, '/');
    if (dest === pdfPath) return true;
    const resolved = this.app.metadataCache?.getFirstLinkpathDest(dest, source);
    if (resolved) return resolved.path === pdfPath;
    // Exact relative paths, then unambiguous bare names only.
    const parts = source.split('/'); parts.pop();
    for (const part of dest.split('/')) { if (part === '..') parts.pop(); else if (part !== '.') parts.push(part); }
    if (parts.join('/') === pdfPath) return true;
    const files = this.app.vault.getFiles().filter(file => file.name === dest);
    return files.length === 1 && files[0].path === pdfPath;
  },

  async lmbInsertBlankPdfPage(leaf, pageNumber, after, expectedMtime) {
    if (this._lmbPdfPageRecoveryRequired) { new Notice('上次操作尚待恢复，请先重新载入插件'); return false; }
    if (this._lmbPdfPagePreparing) { new Notice('正在处理插页，请稍候'); return false; }
    this._lmbPdfPagePreparing = true;
    try { return await this._lmbInsertBlankPdfPage(leaf, pageNumber, after, expectedMtime); }
    finally { this._lmbPdfPagePreparing = false; }
  },

  async _lmbInsertBlankPdfPage(leaf, pageNumber, after, expectedMtime) {
    if (this._lmbPdfPageMutation) { new Notice('正在插入页面，请稍候'); return false; }
    const file = leaf?.view?.file;
    if (!file || file.extension !== 'pdf' || !Number.isInteger(pageNumber) || pageNumber < 1) return false;
    if (expectedMtime != null && file.stat?.mtime !== expectedMtime) { new Notice('PDF 已改变，请重新打开页面菜单'); return false; }
    if (this._isIndexing) { new Notice('摘录索引正在更新，请稍后再插页'); return false; }
    if (!await this.lmbSaveEditorsBeforeInkNavigation()) return false;
    if (this.inkMode) await this.lmbSetInkMode(false);
    await this.lmbFlushInkStorage();
    if (this._lmbSettingsWriteQueue) await this._lmbSettingsWriteQueue;
    if (!await this.lmbEnsureInkDocument(file.path)) throw Error('笔迹未能完整载入，未修改 PDF');
    const path = file.path, adapter = this.app.vault.adapter;
    const progress = new LMBPdfPageProgress(this.app); progress.open();
    this._lmbPdfPageMutation = true;
    let journal, plans = [], changed = [], oldSettings, oldInk, memorySettingsChanged = false;
    const bytes = value => new Uint8Array(value);
    const equalBytes = (a, b) => { a = bytes(a); b = bytes(b); return a.length === b.length && a.every((n, i) => n === b[i]); };
    try {
      const original = await this.app.vault.readBinary(file);
      const doc = await LMB_PDF_LIB.PDFDocument.load(bytes(original), { updateMetadata: false });
      if (doc.isEncrypted) throw Error('加密 PDF 暂不支持插页');
      if (pageNumber > doc.getPageCount()) throw Error('页码已改变，请重新选择页面');
      const fields = doc.catalog.lookupMaybe(LMB_PDF_LIB.PDFName.of('AcroForm'), LMB_PDF_LIB.PDFDict);
      if (fields?.get(LMB_PDF_LIB.PDFName.of('SigFlags'))) throw Error('带签名的 PDF 不作原位修改，请先使用无签名副本');
      const storage = LmbPdfAdapter.document(leaf.view)?.annotationStorage;
      if (storage?.modifiedIds?.ids?.size) throw Error('请先保存 PDF 自身的批注，再插入空白页');
      const index = pageNumber - (after ? 0 : 1), inserted = index + 1;
      const reference = doc.getPage(pageNumber - 1), box = reference.getCropBox();
      const blank = doc.insertPage(index, [box.width, box.height]); blank.setRotation(reference.getRotation());
      const labels = doc.catalog.lookupMaybe(LMB_PDF_LIB.PDFName.of('PageLabels'), LMB_PDF_LIB.PDFDict);
      const nums = labels?.lookupMaybe(LMB_PDF_LIB.PDFName.of('Nums'), LMB_PDF_LIB.PDFArray);
      if (nums) {
        for (let i = 0; i < nums.size(); i += 2) {
          const n = nums.lookup(i, LMB_PDF_LIB.PDFNumber).asNumber();
          if (n >= index) nums.set(i, LMB_PDF_LIB.PDFNumber.of(n + 1));
        }
        if (index === 0) { nums.insert(0, LMB_PDF_LIB.PDFNumber.of(0)); nums.insert(1, doc.context.obj({ S: 'D' })); }
      }
      const result = await doc.save({ updateFieldAppearances: false });
      const verified = await LMB_PDF_LIB.PDFDocument.load(result, { updateMetadata: false });
      if (verified.getPageCount() !== doc.getPageCount()) throw Error('PDF 写入前验证失败');
      oldSettings = JSON.parse(JSON.stringify(this.settings)); oldInk = this.lmbInkStore()[path] || {};
      const newSettings = lmbShiftPageSettings(this.settings, path, inserted), newInk = lmbShiftInkPages(oldInk, inserted);
      plans.push({ path, binary: true, before: original, after: result });
      // Flush native Markdown editors first so backups include their newest text.
      for (const mdLeaf of this.app.workspace.getLeavesOfType('markdown') || []) {
        if (typeof mdLeaf.view.save === 'function') await mdLeaf.view.save();
        else if (mdLeaf.view.editor && mdLeaf.view.file && mdLeaf.view.editor.getValue() !== await adapter.read(mdLeaf.view.file.path)) throw Error('请先保存打开的 Markdown 文档');
      }
      progress.setStatus('正在检查摘录、画布和回跳链接…');
      const candidates = this.app.vault.getFiles().filter(f => f.extension === 'md' || f.extension === 'canvas');
      for (let offset = 0; offset < candidates.length; offset += 20) {
        const batch = await Promise.all(candidates.slice(offset, offset + 20).map(async candidate => {
          const raw = await adapter.read(candidate.path), matches = dest => this.lmbPdfPageLinkMatches(dest, candidate.path, path);
          if (candidate.extension === 'md') {
            const text = lmbShiftPdfTextLinks(raw, inserted, matches);
            return text === raw ? null : { path: candidate.path, before: raw, after: text, file: candidate };
          }
          const memory = this._lmbMemCanvasData(candidate);
          if (!memory && !/\.pdf/i.test(raw)) return null;
          const data = memory?.data || JSON.parse(raw);
          const next = lmbShiftCanvasPdfPages(data, path, inserted, matches);
          if (JSON.stringify(data) === JSON.stringify(next)) return null;
          const before = memory && JSON.stringify(data) !== JSON.stringify(JSON.parse(raw)) ? JSON.stringify(data, null, 2) : raw;
          return { path: candidate.path, before, diskBefore: raw,
            after: JSON.stringify(next, null, 2), memory: memory?.canvas, dataBefore: data, dataAfter: next, file: candidate };
        }));
        plans.push(...batch.filter(Boolean));
      }
      const settingsPath = `.obsidian/plugins/${this.manifest?.id || 'lucias-marginbook'}/data.json`;
      // Read after editor saves; unrelated settings must survive this edit too.
      const settingsRaw = await adapter.read(settingsPath);
      plans.push({ path: settingsPath, before: settingsRaw, settings: true });
      const sidecar = `${this.lmbInkStorageDir()}/${lmbInkFileKey(path)}`;
      if (await adapter.exists(sidecar)) {
        for (const inkPath of [sidecar, sidecar + '.tmp', sidecar + '.bak']) if (await adapter.exists(inkPath)) {
          const raw = await adapter.read(inkPath), ink = JSON.parse(raw);
          if (ink.pdfPath !== path) throw Error('手写批注路径不匹配，未修改文件');
          // Shift every recovery copy, retaining each copy's own strokes.
          const pages = inkPath === sidecar ? newInk : lmbShiftInkPages(ink.pages, inserted);
          plans.push({ path: inkPath, before: raw, after: JSON.stringify({ ...ink, pages, revision: (ink.revision || 0) + 1 }) });
        }
      }
      // Detect intervening external writes before producing a committed edit.
      for (const plan of plans) {
        const latest = plan.binary ? await adapter.readBinary(plan.path) : await adapter.read(plan.path);
        if (plan.binary ? !equalBytes(latest, plan.before) : latest !== (plan.diskBefore ?? plan.before)) throw Error('文件在检查期间被其他操作修改，请重试');
        if (plan.memory && JSON.stringify(plan.memory.getData()) !== JSON.stringify(plan.dataBefore)) throw Error('画布布局已改变，请重试');
      }
      const folder = `.obsidian/plugins/${this.manifest?.id || 'lucias-marginbook'}/page-backups/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (this._unloaded) throw Error('插件已卸载，未执行插页');
      let current = '';
      for (const part of folder.split('/')) { current = current ? current + '/' + part : part; if (!await adapter.exists(current)) await adapter.mkdir(current); }
      journal = { version: 1, phase: 'prepared', pdf: path, inserted, files: [] };
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i], backup = `${folder}/${i}${plan.binary ? '.pdf' : '.txt'}`;
        if (plan.binary) await adapter.writeBinary(backup, plan.before); else await adapter.write(backup, plan.before);
        const saved = plan.binary ? await adapter.readBinary(backup) : await adapter.read(backup);
        if (plan.binary ? !equalBytes(saved, plan.before) : saved !== plan.before) throw Error('备份校验失败，未修改 PDF');
        journal.files.push({ path: plan.path, backup, binary: !!plan.binary });
      }
      await adapter.write(`${folder}/manifest.json`, JSON.stringify(journal, null, 2));
      journal.phase = 'writing'; await adapter.write(this.lmbPdfPageJournalPath(), JSON.stringify(journal));
      progress.setStatus('备份完成，正在插入空白页并更新页码…');
      const settingKeys = ['quickExcerpts', 'pdfTextBlocks', 'inkExcerptLinks', 'inkAnnotations'];
      for (const key of settingKeys) if (newSettings[key]?.[path] != null) this.settings[key][path] = newSettings[key][path];
      memorySettingsChanged = true; this.lmbInkStore()[path] = newInk;
      const serialized = this.settingsStore.serialize(this.settings, this.runtimeState);
      plans.find(plan => plan.settings).after = JSON.stringify(serialized, null, 2);
      for (const plan of plans) {
        if (this._unloaded) throw Error('插件已卸载，正在恢复插页前的文件');
        changed.push(plan);
        if (plan.memory) { plan.memory.setData(plan.dataAfter); plan.memory.requestSave(); }
        for (const mdLeaf of this.app.workspace.getLeavesOfType('markdown') || []) if (mdLeaf.view.file?.path === plan.path && mdLeaf.view.editor) {
          const cursor = mdLeaf.view.editor.getCursor(); mdLeaf.view.editor.setValue(plan.after); mdLeaf.view.editor.setCursor(cursor);
        }
        if (plan.file?.extension === 'canvas') this.selfWritten.set(plan.path, Date.now());
        if (plan.binary) await this.app.vault.modifyBinary(file, plan.after.buffer.slice(plan.after.byteOffset, plan.after.byteOffset + plan.after.byteLength));
        else if (plan.file) await this.app.vault.modify(plan.file, plan.after);
        else await adapter.write(plan.path, plan.after);
        const actual = plan.binary ? await adapter.readBinary(plan.path) : await adapter.read(plan.path);
        if (plan.binary ? !equalBytes(actual, plan.after) : actual !== plan.after) throw Error('文件保存后校验失败：' + plan.path);
      }
      journal.phase = 'committed'; await adapter.write(this.lmbPdfPageJournalPath(), JSON.stringify(journal));
      this._lmbInkHistory?.clear(); this._lmbInkSpatialCache?.clear();
      this._lmbInkContinuation = null; this._lmbInkLinkedFocus = null;
      for (const pdfLeaf of this.app.workspace.getLeavesOfType('pdf') || []) if (pdfLeaf.view.file?.path === path) {
        pdfLeaf._lmbSelectedExcerpt = null; pdfLeaf._lmbTextInteraction = {};
        await LmbPdfAdapter.reload(pdfLeaf.view, file);
      }
      this._lmbPdfPageMutation = false;
      await this.buildExcerptIndex(); this.lmbScheduleMarksRefresh(0); this.lmbSchedulePdfSidebarRefresh(0); this.lmbScheduleInkReferenceRefresh();
      if (leaf.view.file?.path === path) {
        LmbPdfAdapter.page(leaf.view, inserted);
      }
      new Notice(`已插入第 ${inserted} 页空白页；后续批注和链接已同步，备份已保留`, 5000);
      return true;
    } catch (error) {
      if (journal?.phase === 'committed') {
        this._lmbPdfPageMutation = false;
        try { await this.buildExcerptIndex(); this.lmbScheduleMarksRefresh(0); this.lmbSchedulePdfSidebarRefresh(0); this.lmbScheduleInkReferenceRefresh(); } catch (_) {}
        new Notice('插页已保存，界面刷新失败，请重新打开 PDF：' + error.message, 6000); return true;
      }
      try {
        for (const plan of [...changed].reverse()) {
          if (plan.memory) { plan.memory.setData(plan.dataBefore); plan.memory.requestSave(); }
          for (const mdLeaf of this.app.workspace.getLeavesOfType('markdown') || []) if (mdLeaf.view.file?.path === plan.path && mdLeaf.view.editor) mdLeaf.view.editor.setValue(plan.before);
          if (plan.binary) await adapter.writeBinary(plan.path, plan.before); else await adapter.write(plan.path, plan.before);
        }
        if (memorySettingsChanged) {
          for (const key of ['quickExcerpts', 'pdfTextBlocks', 'inkExcerptLinks', 'inkAnnotations']) {
            if (oldSettings[key]?.[path] != null) this.settings[key][path] = oldSettings[key][path];
          }
          this.lmbInkStore()[path] = oldInk;
        }
        if (journal) { journal.phase = 'rolled-back'; await adapter.write(this.lmbPdfPageJournalPath(), JSON.stringify(journal)); }
        // A view may have observed the intermediate PDF; UI failure must not
        // turn an already successful disk rollback into failed recovery.
        for (const pdfLeaf of this.app.workspace.getLeavesOfType('pdf') || []) if (changed.some(plan => plan.binary) && pdfLeaf.view.file?.path === path) {
          try { await LmbPdfAdapter.reload(pdfLeaf.view, file); } catch (_) {}
        }
        new Notice('未完成插页，已保留或恢复原文件：' + error.message, 7000);
      } catch (recoveryError) {
        this._lmbPdfPageRecoveryRequired = true;
        if (memorySettingsChanged) {
          for (const key of ['quickExcerpts', 'pdfTextBlocks', 'inkExcerptLinks', 'inkAnnotations']) if (oldSettings[key]?.[path] != null) this.settings[key][path] = oldSettings[key][path];
          this.lmbInkStore()[path] = oldInk;
        }
        if (journal) { journal.phase = 'recovery-required'; await adapter.write(this.lmbPdfPageJournalPath(), JSON.stringify(journal)); }
        progress.setStatus('恢复尚未完成。请停止编辑，释放存储空间或修复写入问题后重新载入插件，自动恢复备份。');
        new Notice('恢复尚未完成，请停止编辑并重新载入插件以恢复备份：' + recoveryError.message, 0);
      }
      return false;
    } finally {
      this._lmbPdfPageMutation = !!this._lmbPdfPageRecoveryRequired;
      if (!this._lmbPdfPageRecoveryRequired) { progress.busy = false; progress.close(); }
    }
  },

  lmbPdfThumbnailTarget(target) {
    const thumbnail = target?.closest?.('.thumbnail[data-page-number],.pdf-thumbnail[data-page-number],[data-page-number].pdf-thumbnail-item');
    if (!thumbnail) return null;
    const leaf = (this.app.workspace.getLeavesOfType('pdf') || []).find(l => l.containerEl.contains(thumbnail));
    const page = Number(thumbnail.dataset.pageNumber);
    return leaf?.view.file?.extension === 'pdf' && Number.isInteger(page) && page > 0 ? { leaf, page, thumbnail } : null;
  },

  lmbShowPdfPageMenu(target, x, y) {
    const file = target.leaf.view.file, mtime = file.stat?.mtime, menu = new Menu();
    for (const [after, title] of [[false, '在此页前插入空白页'], [true, '在此页后插入空白页']]) menu.addItem(item => item.setTitle(title).setIcon('file-plus').onClick(() => {
      if (target.leaf.view.file !== file) { new Notice('PDF 已切换，请重新选择页面'); return; }
      this.lmbInsertBlankPdfPage(target.leaf, target.page, after, mtime).catch(error => new Notice('无法插页：' + error.message, 5000));
    }));
    menu.showAtPosition({ x, y });
  },

  lmbSetupPdfPageEditing() {
    let press, timer, lastLongPress = 0;
    const cancel = () => { clearTimeout(timer); press = null; };
    this.registerDomEvent(document, 'contextmenu', event => {
      const target = this.lmbPdfThumbnailTarget(event.target); if (!target) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
      if (Date.now() - lastLongPress < 800) return;
      this.lmbShowPdfPageMenu(target, event.clientX, event.clientY);
    }, true);
    this.registerDomEvent(document, 'pointerdown', event => {
      cancel(); if (!['touch', 'pen'].includes(event.pointerType) || event.isPrimary === false || event.button > 0) return;
      const target = this.lmbPdfThumbnailTarget(event.target); if (!target) return;
      press = { id: event.pointerId, x: event.clientX, y: event.clientY };
      timer = setTimeout(() => { if (!press) return; lastLongPress = Date.now(); this.lmbShowPdfPageMenu(target, press.x, press.y); cancel(); }, 550);
    }, { capture: true, passive: true });
    this.registerDomEvent(document, 'pointermove', event => { if (press && (press.id !== event.pointerId || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10)) cancel(); }, { capture: true, passive: true });
    for (const type of ['pointerup', 'pointercancel', 'scroll']) this.registerDomEvent(document, type, cancel, true);
    this.registerDomEvent(window, 'blur', cancel); this.register(cancel);
  }
});

class LMBPdfPageProgress extends Modal {
  constructor(app) { super(app); this.busy = true; }
  onOpen() { this.contentEl.createEl('h3', { text: '插入 PDF 空白页' }); this.status = this.contentEl.createDiv({ text: '正在保存备注并准备备份…' }); }
  setStatus(text) { if (this.status) this.status.textContent = text; }
  close() { if (!this.busy) super.close(); }
}
