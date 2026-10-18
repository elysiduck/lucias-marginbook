// Selection/editing are distinct. These checks use actual DOM hit testing.
(async()=>{
 const out=document.body.createEl('pre',{attr:{id:'selection-results'}}),results=[];
 const check=(ok,label)=>{if(!ok)throw Error(label);results.push(label);};
 const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const until=async(fn,label)=>{const t=performance.now();while(!fn()){if(performance.now()-t>5000)throw Error(label);await frame();}};
 try{
  let fail=false,disk;plugin.saveSettings=async()=>{if(fail)throw Error('test save failure');disk=JSON.parse(JSON.stringify(plugin.settings));};
  plugin.settings.quickExcerpts[pdf.path]=[{exId:'note-a',page:1,note:'## First\nOriginal first paragraph',text:'First'},{exId:'note-b',page:1,note:'## Second\nOriginal second paragraph',text:'Second'}];
  plugin.settings.pdfTextBlocks[pdf.path]={'note-a':{page:1,x:.1,y:.4,w:.7,fontSize:16},'note-b':{page:1,x:.1,y:.3,w:.7,fontSize:16}};
  await plugin.lmbRefreshTextBlocks();await plugin.lmbRenderPdfSidebarForLeaf(leaf);await frame();
  const page=leaf.containerEl.querySelector('.page'),block=id=>page.querySelector('[data-ex-id="'+id+'"]'),body=id=>block(id).querySelector('.lmb-pdf-text-body');
  for(const pointerType of ['mouse','touch','pen']){
   body('note-a').dispatchEvent(new PointerEvent('click',{bubbles:true,button:0,detail:1,pointerType}));await frame();
   check(!block('note-a')._lmbInlineEditor&&block('note-a').classList.contains('lmb-note-selected'),pointerType+' single click only selects');
   check(getComputedStyle(block('note-a').querySelector('.lmb-pdf-text-tools')).opacity==='1',pointerType+' toolbar remains visible after selection');
   page.click();await frame();check(!page.querySelector('.lmb-note-selected')&&!leaf._lmbSelectedExcerpt,pointerType+' blank clears persistent outline and badge');
  }
  body('note-a').click();await frame();block('note-a').focus();page.click();await frame();
  check(!block('note-a').contains(document.activeElement),'blank releases focus inside the old block');
  body('note-a').click();await frame();block('note-a').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));await frame();
  check(!page.querySelector('.lmb-note-selected'),'Escape cancels non-editing selection');
  body('note-a').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,detail:2}));await until(()=>block('note-a')._lmbInlineEditor,'double click opens editor');
  let state=block('note-a')._lmbInlineEditor;check(!!state,'double click opens rendered Markdown editing');
  state.input.value='First revised safely';state.input.dispatchEvent(new InputEvent('input',{bubbles:true}));
  body('note-b').click();await until(()=>state.closed,'single-click switch saves current note');
  check(disk.quickExcerpts[pdf.path][0].note.includes('First revised safely')&&!block('note-b')._lmbInlineEditor&&block('note-b').classList.contains('lmb-note-selected'),'switching saves first and selects the other block without editing');
  body('note-b').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));await until(()=>block('note-b')._lmbInlineEditor,'second edit');state=block('note-b')._lmbInlineEditor;
  state.input.value='Keep this failed draft';state.input.dispatchEvent(new InputEvent('input',{bubbles:true}));fail=true;
  page.click();await frame();check(!state.closed&&state.getText().includes('Keep this failed draft'),'failed blank save retains editor and draft');
  body('note-a').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));await frame();check(!state.closed&&!block('note-a')._lmbInlineEditor,'failed switch never opens another editor');
  fail=false;page.click();await until(()=>state.closed,'blank retry');await frame();
  check(!page.querySelector('.lmb-note-selected')&&disk.quickExcerpts[pdf.path][1].note.includes('Keep this failed draft'),'successful retry saves and removes selection');
  const read=plugin.lmbTextBlockNote;let release,waiting=false;
  const gate=new Promise(resolve=>release=resolve);
  plugin.lmbTextBlockNote=async function(entry){const value=await read.call(this,entry);if(entry.exId==='note-a'&&!waiting){waiting=true;await gate;}return value;};
  body('note-a').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));await until(()=>waiting,'delayed note read');
  page.click();await frame();release();await frame();await frame();
  check(!block('note-a')._lmbInlineEditor&&!page.querySelector('.lmb-note-selected'),'blank click invalidates a delayed double-click editor opening');
  plugin.lmbTextBlockNote=read;
  body('note-a').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));await until(()=>block('note-a')._lmbInlineEditor,'Escape editor');
  block('note-a')._lmbInlineEditor.input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));await frame();
  check(!block('note-a')._lmbInlineEditor&&!page.querySelector('.lmb-note-selected'),'cancelling editing also releases its selected outline');
  // Deliberately put a later sibling behind the active block toolbar.
  const view=plugin.settings.pdfTextBlocks[pdf.path]['note-b'];view.y=.36;plugin.lmbStyleTextBlock(block('note-b'),page,view);
  body('note-a').click();await frame();leaf.containerEl.querySelector('.view-content').scrollTop=0;
  const button=block('note-a').querySelector('[aria-label="增大字号"]'),r=button.getBoundingClientRect();
  check(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===button,'selected toolbar wins actual hit testing over overlapping note content');
  const prior=plugin.settings.pdfTextBlocks[pdf.path]['note-a'].fontSize;button.click();await frame();
  check(plugin.settings.pdfTextBlocks[pdf.path]['note-a'].fontSize===prior+1,'overlapping toolbar action updates the intended note');
  check(getComputedStyle(block('note-a').querySelector('.lmb-pdf-text-tools')).opacity==='1','toolbar click keeps selection pinned');
  out.textContent='PASS '+results.length+' text block selection/editing checks';out.dataset.report=JSON.stringify({checks:results.length,results,physicalTablet:false,nativeObsidian:false});
 }catch(error){out.textContent='FAIL after '+results.length+': '+error.stack;throw error;}
})();
