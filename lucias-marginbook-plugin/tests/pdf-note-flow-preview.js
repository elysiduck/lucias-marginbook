// End-to-end event sequences using the real plugin and an in-memory durable store.
// Synthetic touch/pen events exercise handlers; they do not emulate iPadOS/WebKit.
(async () => {
 const out=document.body.createEl('pre',{attr:{id:'flow-results'}});
 out.style.cssText='position:fixed;top:0;left:0;z-index:99999;max-width:90vw;white-space:pre-wrap;background:#20372c;color:white;padding:8px';
 let checks=0;const results=[];const check=(ok,label)=>{if(!ok)throw Error(label);checks++;results.push(label)};
 const tick=()=>new Promise(r=>setTimeout(r,40));
 const until=async(fn,label)=>{const start=performance.now();while(!fn()){if(performance.now()-start>5000)throw Error('Timed out: '+label);await tick()}};
 const clone=x=>JSON.parse(JSON.stringify(x));const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
 try{
 const P=module.exports,source=Object.assign(new StubFile(),{path:'flow-notes.md',extension:'md',stat:{mtime:1}});
 const entries=['b','c'].map(id=>({exId:'ex-flow'+id+'001',pdfPath:pdf.path,sourceMd:source.path,page:1,text:'Original '+id}));
 let raw=entries.map((e,i)=>'> [!lmb-excerpt]+ P.1\n> [[demo.pdf#page=1|PDF]]\n> '+e.text+'\n> > [!lmb-note]\n> > <!-- LMB-NOTE:BEGIN -->\n> > Original note '+i+'\n> > <!-- LMB-NOTE:END -->\n> ^'+e.exId+'\n').join('\n');
 plugin.settings={quickExcerpts:{[pdf.path]:[]},pdfTextBlocks:{[pdf.path]:Object.fromEntries(entries.map((e,i)=>[e.exId,{page:1,x:.1+i*.48,y:.57,w:.4,fontSize:16}]))}};
 let disk=clone(plugin.settings);const plans=[],writes=[];
 const writing=async(kind,value)=>{const plan=plans.shift()||{};writes.push({kind,value:clone(value)});if(plan.start)plan.start();if(plan.gate)await plan.gate.promise;if(plan.fail)throw Error('Simulated full disk');};
 plugin.settingsStore={serialize:settings=>clone(settings)};plugin._lmbPrunePersistedCaches=()=>{};
 plugin.saveSettings=P.prototype.saveSettings.bind(plugin);plugin.saveData=async snapshot=>{await writing('settings',snapshot);disk=clone(snapshot)};
 plugin.app.vault={getAbstractFileByPath:p=>p===pdf.path?pdf:p===source.path?source:null,read:async()=>raw,cachedRead:async()=>raw,process:async(_f,fn)=>{await writing('markdown',raw);raw=fn(raw);source.stat.mtime++}};
 plugin.reindexFile=async()=>{};plugin.getExcerptsForPdf=()=>entries;plugin.excerptIndex=new Map();plugin.lmbJumpToSelection=()=>{};
 leaf.view.file=pdf;plugin._lmbPdfSidebarView='all';await plugin.lmbRenderPdfSidebarForLeaf(leaf);await plugin.lmbRefreshTextBlocks();await tick();
 const page=()=>leaf.containerEl.querySelector('.page');
 const block=id=>Array.from(page().querySelectorAll('.lmb-pdf-text-block')).find(el=>el.dataset.exId===id);
 const durable=id=>(disk.quickExcerpts[pdf.path]||[]).find(n=>n.exId===id)?.note;
 const normal=id=>plugin._lmbFindSidebarNote(raw,id);
 const bar=()=>leaf.containerEl.querySelector('.lmb-pdf-excerpt-sidebar');
 const row=id=>Array.from(bar().querySelectorAll('.lmb-pdf-sidebar-item')).find(el=>el.dataset.exId===id);
 const edit=(state,text,composing=false)=>{state.input.value=text;state.input.setSelectionRange(text.length,text.length);state.input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:composing,inputType:composing?'insertCompositionText':'insertText',data:text}));};
 const gesture=(target,type,extra={})=>{const r=target.getBoundingClientRect(),options={bubbles:true,cancelable:true,button:0,buttons:1,pointerId:type==='mouse'?1:7,pointerType:type,isPrimary:true,clientX:r.left+20,clientY:r.top+20,...extra};target.dispatchEvent(new PointerEvent('pointerdown',options));target.dispatchEvent(new PointerEvent('pointerup',{...options,buttons:0}));target.dispatchEvent(new PointerEvent('click',{...options,buttons:0,detail:1}));};
 for(const type of ['mouse','touch','pen']){
  out.textContent='运行完整流程：'+type;plugin.isMobile=type!=='mouse';document.body.classList.toggle('lmb-mobile',plugin.isMobile);
  leaf.containerEl.style.maxWidth=type==='mouse'?'1200px':'900px';
  const before=plugin.settings.quickExcerpts[pdf.path].length;
  // A scrolling/cancelled pointer sequence has no click and cannot place a note.
  plugin.lmbStartPageNote(leaf);const target=page(),r=target.getBoundingClientRect();
  for(const event of ['pointerdown','pointermove','pointercancel'])target.dispatchEvent(new PointerEvent(event,{bubbles:true,cancelable:true,pointerType:type,pointerId:21,button:0,clientX:r.left+40,clientY:r.top+(event==='pointerdown'?40:130)}));
  await tick();check(!page().querySelector('.is-draft'),type+': cancelled gesture creates no editor');
  document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));
  plugin.lmbStartPageNote(leaf);gesture(page(),type);await until(()=>page().querySelector('.is-draft textarea'),type+' create');
  let a=page().querySelector('.is-draft'),state=a._lmbInlineEditor;const id=a.dataset.exId;
  check(document.activeElement===state.input,type+': completed placement focuses surviving editor');
  // IME changes are not committed while the candidate is still being composed.
  const composed='中文候选已确认 '+type+' **Markdown**';state.input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));edit(state,composed,true);
  gesture(page(),type);await tick();check(!state.closed&&state.getText()===composed,type+': outside tap during IME retains full draft');
  check(plugin.settings.quickExcerpts[pdf.path].length===before,type+': IME candidate does not create a partial note');
  state.input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:composed}));state.input.dispatchEvent(new InputEvent('input',{bubbles:true,data:composed,isComposing:false}));
  await until(()=>durable(id)===composed,type+' autosave');check(!state.closed&&state.input.isConnected,type+': committed IME autosaves without closing editor');
  gesture(row(entries[0].exId),type);await until(()=>bar()._lmbSidebarEditingId===entries[0].exId,type+' page to sidebar');
  check(state.closed,type+': sidebar tap safely exits page editor');state=bar()._lmbSidebarEditor;edit(state,'侧栏切换保存 '+type);
  gesture(row(entries[1].exId),type);await until(()=>bar()._lmbSidebarEditingId===entries[1].exId,type+' sidebar switch');
  check(normal(entries[0].exId)==='侧栏切换保存 '+type,type+': sidebar tap saves previous canonical source');state=bar()._lmbSidebarEditor;edit(state,'侧栏失败草稿 '+type);
  plans.push({fail:true});gesture(row(id),type);await until(()=>bar().querySelector('.lmb-inline-note-status')?.textContent.includes('保存失败'),type+' sidebar failure');
  check(bar()._lmbSidebarEditor===state&&state.getText()==='侧栏失败草稿 '+type,type+': failed sidebar switch keeps original editor and draft');
  gesture(row(id),type);await until(()=>bar()._lmbSidebarEditingId===id,type+' sidebar retry');check(normal(entries[1].exId)==='侧栏失败草稿 '+type,type+': sidebar retry saves before switching');
  gesture(block(id).querySelector('.lmb-pdf-text-body'),type);await until(()=>block(id)._lmbInlineEditor,type+' sidebar to page');a=block(id);state=a._lmbInlineEditor;
  check(!bar()._lmbSidebarEditor&&state.getText()===composed,type+': page tap switches back from sidebar without changing source');
  const tail='\n\n正文 **加粗**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |',markdown='## '+type+' 标题'+tail;edit(state,markdown);await tick();
  const heading=a.querySelector('.lmb-live-markdown-block:not(.is-active)');gesture(heading,type);await tick();
  check(!state.closed&&a.querySelectorAll('textarea').length===1,type+': tapping rendered paragraph retains one editor');
  check(!!a.querySelector('table'),type+': inactive table remains rendered');await state.persist();check(durable(id)===markdown,type+': Markdown source saved without duplication');
  const cancelOptions={bubbles:true,cancelable:true,pointerType:type,pointerId:31,button:0};
  for(const event of ['pointerdown','pointermove','pointercancel'])page().dispatchEvent(new PointerEvent(event,cancelOptions));await tick();
  check(!state.closed&&state.getText()===markdown,type+': cancelled scroll/pen gesture cannot close active editor');
  for(const pointerId of [31,32])page().dispatchEvent(new PointerEvent('pointerdown',{...cancelOptions,pointerId}));
  for(const pointerId of [31,32])page().dispatchEvent(new PointerEvent('pointercancel',{...cancelOptions,pointerId}));await tick();
  check(!state.closed,type+': cancelled two-pointer gesture leaves editing state intact');
  // PDF.js page replacement, as can happen during zoom/keyboard viewport changes.
  const input=state.input,caret=input.selectionStart;const previousPage=page(),replacement=previousPage.cloneNode(false);previousPage.replaceWith(replacement);
  await plugin.lmbRenderTextBlocksOnPage(replacement,pdf.path);check(input.isConnected&&state.input===input,type+': page recycling restores the same editor');
  check(state.getText()===markdown&&input.selectionStart===caret,type+': page recycling preserves source and caret');
  const gate=deferred(),started=deferred();plans.push({gate,start:started.resolve});edit(state,'慢写第一版 '+type);const pending=state.persist();await started.promise;
  check(!input.readOnly,type+': typing remains possible during background write');edit(state,'慢写期间的最终版 '+type);gesture(block(entries[0].exId).querySelector('.lmb-pdf-text-body'),type);await tick();
  check(!state.closed&&!block(entries[0].exId)._lmbInlineEditor,type+': target editor waits for pending save');gate.resolve();await pending;
  await until(()=>block(entries[0].exId)._lmbInlineEditor,type+' switch after slow write');check(durable(id)==='慢写期间的最终版 '+type+tail,type+': switch drains newest text after slow write');
  state=block(entries[0].exId)._lmbInlineEditor;edit(state,'普通备注保存后切换 '+type);
  gesture(block(entries[1].exId).querySelector('.lmb-pdf-text-body'),type);await until(()=>block(entries[1].exId)._lmbInlineEditor,type+' normal switch');
  check(normal(entries[0].exId)==='普通备注保存后切换 '+type,type+': ordinary Markdown note flushes before switch');
  state=block(entries[1].exId)._lmbInlineEditor;const original=normal(entries[1].exId);edit(state,'磁盘失败保留 '+type);plans.push({fail:true});gesture(page(),type);
  await until(()=>block(entries[1].exId).querySelector('.lmb-inline-note-status')?.textContent.includes('保存失败'),type+' failed blank exit');
  check(!state.closed&&state.input.isConnected&&state.getText()==='磁盘失败保留 '+type,type+': failed blank exit retains editable draft');check(normal(entries[1].exId)===original,type+': failed write preserves last durable note');
  plans.push({fail:true});gesture(block(id).querySelector('.lmb-pdf-text-body'),type);await tick();check(!state.closed&&!block(id)._lmbInlineEditor,type+': failed switch does not open another editor');
  await plugin.lmbRenderPdfSidebarForLeaf(leaf);await plugin.lmbRefreshTextBlocks();check(state.getText()==='磁盘失败保留 '+type,type+': refresh cannot replace failed draft');
  gesture(page(),type);await until(()=>state.closed,type+' blank retry');check(normal(entries[1].exId)==='磁盘失败保留 '+type,type+': later blank tap saves retained draft and exits');
  gesture(block(id).querySelector('.lmb-pdf-text-body'),type);await until(()=>block(id)._lmbInlineEditor,type+' reopen');state=block(id)._lmbInlineEditor;
  check(state.getText()==='慢写期间的最终版 '+type+tail,type+': reopening loads the last complete note');edit(state,'快速切换最终稿 '+type);
  gesture(block(entries[0].exId).querySelector('.lmb-pdf-text-body'),type);gesture(block(entries[1].exId).querySelector('.lmb-pdf-text-body'),type);
  await until(()=>block(entries[1].exId)._lmbInlineEditor,type+' rapid switches');check(!block(entries[0].exId)._lmbInlineEditor&&durable(id)==='快速切换最终稿 '+type+tail,type+': rapid taps preserve source and open only the last target');
  await block(entries[1].exId)._lmbInlineEditor.save();
  // Failed first save rolls back the temporary record but keeps the editor.
  plugin.lmbStartPageNote(leaf);gesture(page(),type);await until(()=>page().querySelector('.is-draft'),type+' failed creation');a=page().querySelector('.is-draft');state=a._lmbInlineEditor;const retryId=a.dataset.exId;
  edit(state,'第一次保存失败后重试 '+type);plans.push({fail:true});check(await state.persist()===false,type+': failed initial save reports failure');
  check(!state.closed&&plugin.settings.quickExcerpts[pdf.path].length===before+1,type+': failed initial save keeps draft without ghost record');
  check(await state.persist()===true,type+': failed initial save can retry');check(durable(retryId)==='第一次保存失败后重试 '+type,type+': retry persists exact initial draft');
  gesture(page(),type);await until(()=>state.closed,type+' finish retry');check(plugin.settings.quickExcerpts[pdf.path].length===before+2,type+': creation retries never duplicate notes');
  // Re-read the durable settings, so checks cannot pass solely on UI memory.
  plugin.settings=clone(disk);await plugin.lmbRefreshTextBlocks();check(await plugin.lmbTextBlockNote({exId:id,pdfPath:pdf.path,quick:true})==='快速切换最终稿 '+type+tail,type+': durable settings reread preserves final source');
  check(!page().querySelector('textarea'),type+': completed flow leaves no orphan editor');
 }
 document.body.classList.remove('lmb-mobile');
 out.textContent='PASS '+checks+' chained mouse/touch/pen workflow checks';out.dataset.report=JSON.stringify({checks,results,writes:writes.length,types:['mouse','touch','pen'],physicalTablet:false});
 }catch(error){out.textContent='FAIL after '+checks+': '+error.stack;throw error}
})();
