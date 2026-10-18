// Actual plugin UI and source-writing code, with vault data confined to memory.
(async()=>{
 const result=document.body.createEl('pre',{attr:{id:'sidebar-live-results'}});result.style.cssText='position:fixed;top:0;left:0;z-index:99999;background:#223d2c;color:white;padding:8px;max-width:65vw;white-space:pre-wrap';
 let checks=0;const check=(ok,label)=>{if(!ok)throw Error(label);checks++};const tick=()=>new Promise(r=>setTimeout(r,120));
 try{
 const source=Object.assign(new StubFile(),{path:'demo-摘录.md',extension:'md',stat:{mtime:1}}),otherPdf=Object.assign(new StubFile(),{path:'other.pdf',name:'Other.pdf',extension:'pdf'});
 const baseNote='## 侧栏实时编辑\n\n当前段落可以 **直接修改**。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
 let raw='> [!lmb-excerpt]+ P.1\n> [[demo.pdf#page=1|PDF]]\n> The original English excerpt.\n> > [!lmb-note]\n> > <!-- LMB-NOTE:BEGIN -->\n'+baseNote.split('\n').map(s=>'> > '+s).join('\n')+'\n> > <!-- LMB-NOTE:END -->\n> ^ex-normal01\n\n> [!lmb-excerpt]+ P.1\n> [[demo.pdf#page=1|PDF]]\n> Another excerpt without note.\n> ^ex-empty001\n';
 const entries=[{exId:'ex-normal01',pdfPath:'demo.pdf',page:1,text:'The original English excerpt.',sourceMd:source.path},{exId:'ex-empty001',pdfPath:'demo.pdf',page:1,text:'Another excerpt without note.',sourceMd:source.path}];
 let fail=false,jumps=0;plugin.settings={quickExcerpts:{'demo.pdf':[{exId:'quick-sidebar',page:1,text:'Quick excerpt.',note:'Quick original.'}]},pdfTextBlocks:{'demo.pdf':{'ex-normal01':{page:1,x:.08,y:.23,w:.64,fontSize:18}}}};plugin.excerptIndex=new Map();plugin.getExcerptsForPdf=p=>p==='demo.pdf'?entries:[];plugin.reindexFile=async()=>{};plugin.saveSettings=async()=>{if(fail)throw Error('Simulated settings write failure');};
 plugin.app.vault={getAbstractFileByPath:p=>p===pdf.path?pdf:p===source.path?source:p===otherPdf.path?otherPdf:null,cachedRead:async()=>raw,read:async()=>raw,process:async(_file,fn)=>{if(fail)throw Error('Simulated write failure');raw=fn(raw);source.stat.mtime++;}};
 plugin.lmbJumpToSelection=()=>{jumps++};plugin._lmbPdfSidebarView='all';leaf.view.file=pdf;
 await plugin.lmbRenderPdfSidebarForLeaf(leaf);await plugin.lmbRefreshTextBlocks();await tick();
 let row=()=>Array.from(document.querySelectorAll('.lmb-pdf-sidebar-item')).find(x=>x.dataset.exId==='ex-normal01');
 row().dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));row().click();
 let block=()=>document.querySelector('.lmb-pdf-text-block[data-ex-id="ex-normal01"]');check(block().classList.contains('lmb-note-selected'),'sidebar selection must identify page block');check(block().dataset.lmbBadge==='P.1 · 1','badge must match sidebar page/ordinal');
 row().dispatchEvent(new MouseEvent('mouseleave'));check(block().classList.contains('lmb-note-selected'),'pointer leave must keep association');
 const sizes=Array.from(block().querySelector('.lmb-pdf-text-tools').children).map(n=>n.getBoundingClientRect());check(sizes.every(x=>Math.abs(x.height-sizes[0].height)<1),'all toolbar controls same height');check(block().querySelector('input').getBoundingClientRect().width<=44,'compact font input');check(!Array.from(block().querySelectorAll('button')).some(b=>b.textContent==='编辑'),'remove redundant page edit button');
 await plugin.lmbOpenSidebarNoteEditor(entries[0],leaf,row());let editor=document.querySelector('.is-sidebar-editing')._lmbInlineEditor;
 check(document.querySelectorAll('.modal').length===0,'ordinary note cannot use modal');check(!!document.querySelector('.lmb-pdf-excerpt-sidebar textarea'),'editor belongs to sidebar');check(!block()._lmbInlineEditor,'sidebar edit must not open a page input');
 await editor.activate(1);check(document.querySelectorAll('textarea').length===1,'one source input');check(document.querySelector('.is-sidebar-editing table'),'inactive table stays rendered');
 const originalRaw=raw;editor.input.value='在侧栏输入 **实时预览**。';editor.input.setSelectionRange(12,12);editor.input.dispatchEvent(new InputEvent('input',{bubbles:true}));await tick();
 check(raw===originalRaw,'draft cannot persist before save');check(block().querySelector('.lmb-pdf-text-body').textContent.includes('实时预览'),'page follows unsaved draft');
 const editorInput=editor.input,bar=document.querySelector('.lmb-pdf-excerpt-sidebar');const jumpBefore=jumps;editor.input.click();check(jumps===jumpBefore,'editing cannot trigger card navigation');
 await plugin.lmbRenderPdfSidebarForLeaf(leaf);check(bar._lmbSidebarEditor===editor&&editor.input===editorInput&&editor.input.isConnected,'background refresh keeps draft and DOM');
 leaf.view.file=otherPdf;await plugin.lmbRenderPdfSidebarForLeaf(leaf);check(!editor.input.isConnected,'switch PDF shows other sidebar');check(!editor.closed,'switch PDF retains draft');
 leaf.view.file=pdf;await plugin.lmbRenderPdfSidebarForLeaf(leaf);await plugin.lmbRefreshTextBlocks();check(editor.input===editorInput&&editor.input.isConnected,'return restores exact input');check(editor.getText().includes('实时预览'),'draft text retained across PDF switch');
 editor.cancel();await tick();check(raw===originalRaw,'cancel leaves source unchanged');check(!block().textContent.includes('在侧栏输入'),'cancel restores page');check(document.querySelectorAll('textarea').length===0,'cancel closes editor');
 await plugin.lmbOpenSidebarNoteEditor(entries[0],leaf,row());editor=bar._lmbSidebarEditor;await editor.activate(1);editor.input.value='保存失败时保留 **草稿**。';await editor.render();fail=true;await editor.save();
 check(!editor.closed&&editor.input.isConnected,'failed save preserves sidebar draft');check(raw===originalRaw,'failed save leaves source intact');check(!editor.input.readOnly,'failed save remains editable');
 fail=false;await editor.save();await tick();check(plugin._lmbFindSidebarNote(raw,'ex-normal01').includes('保存失败时保留'),'ordinary note saves through canonical Markdown source');check(block().textContent.includes('保存失败时保留'),'saved page synchronized');check(document.querySelectorAll('textarea').length===0,'save closes editor');
 const emptyRow=()=>Array.from(document.querySelectorAll('.lmb-pdf-sidebar-item')).find(x=>x.dataset.exId==='ex-empty001');await plugin.lmbOpenSidebarNoteEditor(entries[1],leaf,emptyRow());editor=bar._lmbSidebarEditor;
 check(editor.input.value==='','add note starts empty');editor.input.value='新增普通备注 **加粗**';await editor.render();await editor.save();await tick();check(plugin._lmbFindSidebarNote(raw,'ex-empty001')==='新增普通备注 **加粗**','new ordinary note saved inline');
 const quickRow=Array.from(document.querySelectorAll('.lmb-pdf-sidebar-item')).find(x=>x.dataset.exId==='quick-sidebar');const quick={...plugin.settings.quickExcerpts['demo.pdf'][0],quick:true,pdfPath:'demo.pdf'};
 await plugin.lmbOpenSidebarNoteEditor(quick,leaf,quickRow);editor=bar._lmbSidebarEditor;editor.input.value='Quick **updated**.';await editor.render();await editor.save();await tick();check(plugin.settings.quickExcerpts['demo.pdf'][0].note==='Quick **updated**.','quick note shares inline editor');
 // Switching selected rows should clear only the old page association.
 plugin.lmbSelectPdfSidebarEntry(leaf,entries[1]);check(!block().classList.contains('lmb-note-selected'),'select another row clears old block');
 await plugin.lmbOpenSidebarNoteEditor(entries[0],leaf,row());editor=bar._lmbSidebarEditor;await editor.activate(1);
 editor.input.value='单行备注';await editor.render();
 check(editor.input.rows===1,'textarea intrinsic row count must be one');
 check(editor.input.getBoundingClientRect().height<=parseFloat(getComputedStyle(editor.input).lineHeight)+2,'one short line uses one line of height');
 editor.input.value='Long wrapped text '.repeat(50);await editor.render();const tall=editor.input.getBoundingClientRect().height;
 editor.input.value='单行备注';await editor.render();check(editor.input.getBoundingClientRect().height<tall,'deleting wrapped text shrinks the input');
 await new Promise(r=>setTimeout(r,950));check(plugin._lmbFindSidebarNote(raw,'ex-normal01').includes('单行备注'),'idle input automatically persists');check(!editor.closed&&editor.input.isConnected,'autosave leaves caret and editor in place');
 editor.input.value='切换前保存';await editor.render();await emptyRow().onclick();await tick();
 check(plugin._lmbFindSidebarNote(raw,'ex-normal01').includes('切换前保存'),'card click flushes current note');check(bar._lmbSidebarEditingId==='ex-empty001','card click directly edits target');
 editor=bar._lmbSidebarEditor;editor.input.value='磁盘失败时的草稿';await editor.render();fail=true;await new Promise(r=>setTimeout(r,950));
 check(!editor.closed&&editor.getText()==='磁盘失败时的草稿','failed autosave retains exact draft');check(document.querySelector('.lmb-inline-note-status').textContent.includes('保存失败'),'failed autosave shows persistent error');
 await row().onclick();check(bar._lmbSidebarEditor===editor,'failed switch stays on current editor');check(leaf._lmbSelectedExcerpt.exId==='ex-empty001','failed switch keeps selection on draft owner');
 fail=false;await row().onclick();await tick();check(plugin._lmbFindSidebarNote(raw,'ex-empty001')==='磁盘失败时的草稿','retrying card click persists retained draft');check(bar._lmbSidebarEditingId==='ex-normal01','retry switches after successful save');
 const rapidFirst=emptyRow().onclick();const rapidLast=Array.from(document.querySelectorAll('.lmb-pdf-sidebar-item')).find(x=>x.dataset.exId==='quick-sidebar').onclick();await Promise.all([rapidFirst,rapidLast]);check(bar._lmbSidebarEditingId==='quick-sidebar','rapid card switches complete in click order');
 bar._lmbSidebarEditor.cancel();await tick();
 // Page editing uses the same persistence contract, including blank-click exit.
 plugin.settings.pdfTextBlocks['demo.pdf']['quick-sidebar']={page:1,x:.65,y:.6,w:.3,fontSize:16};await plugin.lmbRefreshTextBlocks();
 const quickBlock=()=>document.querySelector('.lmb-pdf-text-block[data-ex-id="quick-sidebar"]');
 await plugin.lmbEditTextBlockNote(entries[0],null,block());editor=block()._lmbInlineEditor;await editor.activate(1);
 editor.input.value='页内自动保存';await editor.render();await new Promise(r=>setTimeout(r,950));
 check(plugin._lmbFindSidebarNote(raw,'ex-normal01').includes('页内自动保存'),'page idle input autosaves canonical note');check(!editor.closed,'page autosave keeps editor open');
 editor.input.value='切换另一个页内备注之前保存';await editor.render();quickBlock().querySelector('.lmb-pdf-text-body').click();await tick();
 check(editor.closed&&!!quickBlock()._lmbInlineEditor,'page click saves then edits another page note');check(plugin._lmbFindSidebarNote(raw,'ex-normal01').includes('切换另一个页内备注之前保存'),'page switch flushes content');
 editor=quickBlock()._lmbInlineEditor;editor.input.value='Quick page saved on blank';await editor.render();document.querySelector('.page').click();await tick();
 check(editor.closed&&plugin.settings.quickExcerpts['demo.pdf'][0].note==='Quick page saved on blank','blank click saves quick page note and exits');
 await plugin.lmbEditTextBlockNote(entries[0],null,block());editor=block()._lmbInlineEditor;await editor.activate(1);editor.input.value='从页内切换至侧栏';await editor.render();await emptyRow().onclick();await tick();check(editor.closed&&bar._lmbSidebarEditingId==='ex-empty001','sidebar card click flushes page editor and switches editing context');check(plugin._lmbFindSidebarNote(raw,'ex-normal01').includes('从页内切换至侧栏'),'page to sidebar switch saves source');await bar._lmbSidebarEditor.save();await tick();
 await plugin.lmbEditTextBlockNote(entries[0],null,block());editor=block()._lmbInlineEditor;await editor.activate(1);editor.input.value='页内失败的草稿';await editor.render();fail=true;
 await new Promise(r=>setTimeout(r,950));check(!editor.closed&&block().querySelector('.lmb-inline-note-status').textContent.includes('保存失败'),'failed page autosave keeps visible draft and status');quickBlock().querySelector('.lmb-pdf-text-body').click();await tick();check(!editor.closed&&!quickBlock()._lmbInlineEditor,'failed page switch preserves current editor');check(editor.getText().includes('页内失败的草稿'),'failed page switch preserves text');
 document.querySelector('.page').click();await tick();check(!editor.closed,'failed blank save cannot exit');fail=false;document.querySelector('.page').click();await tick();check(editor.closed&&plugin._lmbFindSidebarNote(raw,'ex-normal01').includes('页内失败的草稿'),'blank retry saves and exits');
 // New notes must get one stable identity even across several autosaves.
 const countBefore=plugin.settings.quickExcerpts['demo.pdf'].length,page=document.querySelector('.page'),bounds=page.getBoundingClientRect();
 plugin.lmbStartPageNote(leaf);page.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:bounds.left+40,clientY:bounds.top+100}));
 page.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,clientX:bounds.left+40,clientY:bounds.top+100}));page.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:1,clientX:bounds.left+40,clientY:bounds.top+100}));await tick();
 check(!!page.querySelector('.is-draft textarea'),'completed placement click must leave a visible editor');
 await new Promise(r=>setTimeout(r,950));check(!!page.querySelector('.is-draft textarea'),'empty new editor remains open beyond autosave delay');
 const draft=page.querySelector('.is-draft');editor=draft._lmbInlineEditor;editor.input.value='新页注第一次保存';await editor.render();await new Promise(r=>setTimeout(r,950));
 check(plugin.settings.quickExcerpts['demo.pdf'].length===countBefore+1,'new page note autosave creates one item');editor.input.value='新页注第二次保存';await editor.render();await new Promise(r=>setTimeout(r,950));
 check(plugin.settings.quickExcerpts['demo.pdf'].length===countBefore+1,'subsequent autosave never duplicates new note');check(plugin.settings.quickExcerpts['demo.pdf'].at(-1).note==='新页注第二次保存','new note subsequent autosave updates same source');page.click();await tick();check(!page.querySelector('.is-draft'),'blank finishes temporary draft');check(page.querySelectorAll('[data-ex-id="'+draft.dataset.exId+'"]').length===1,'created page note renders exactly once');
 for(const pointerType of ['touch','pen']){
   plugin.lmbStartPageNote(leaf);const gesture={bubbles:true,button:0,detail:1,pointerId:17,pointerType,clientX:bounds.left+70,clientY:bounds.top+150};
   for(const type of ['pointerdown','pointerup','click'])page.dispatchEvent(new PointerEvent(type,gesture));await tick();
   const touchDraft=page.querySelector('.is-draft');check(!!touchDraft?._lmbInlineEditor&&!touchDraft._lmbInlineEditor.closed,pointerType+' completed gesture keeps new editor open');touchDraft._lmbInlineEditor.cancel();await tick();
   check(plugin.settings.quickExcerpts['demo.pdf'].length===countBefore+1,pointerType+' empty cancellation creates no record');
 }
 await plugin.lmbOpenSidebarNoteEditor(entries[0],leaf,row());editor=bar._lmbSidebarEditor;
 let toggle=document.querySelector('.lmb-sidebar-state-toggle');check(toggle.getAttribute('aria-expanded')==='true','corner button starts expanded');toggle.click();check(toggle.getAttribute('aria-expanded')==='false','corner button updates collapsed state');check(getComputedStyle(toggle).display!=='none'&&toggle.getBoundingClientRect().width>0,'collapsed sidebar retains reopen control');check(editor.input.value&& !editor.closed,'sidebar collapse keeps draft');toggle.click();check(toggle.getAttribute('aria-expanded')==='true'&&editor.input.isConnected,'corner button reopens same editor');editor.cancel();await tick();
 result.textContent='PASS '+checks+' page/sidebar autosave, live-edit, association and toggle checks';
 await plugin.lmbOpenSidebarNoteEditor(entries[0],leaf,row());await bar._lmbSidebarEditor.activate(1);
 }catch(error){result.textContent='FAIL after '+checks+': '+error.stack;throw error;}
})();
