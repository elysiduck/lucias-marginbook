// Native layout regression, run through text-block-preview.html?layout.
(async()=>{
 const out=document.body.createEl('pre',{attr:{id:'layout-results'}});out.style.cssText='position:fixed;top:0;left:0;z-index:99999;background:#222;color:#fff;padding:8px';
 let checks=0;const check=(ok,msg)=>{if(!ok)throw Error(msg);checks++};const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 try{
 await plugin.lmbRenderPdfSidebarForLeaf(leaf);await plugin.lmbRefreshTextBlocks();await frame();
 const page=document.querySelector('.page'),viewport=document.querySelector('.view-content');
 for(const size of [16,24])for(const y of [.02,.25,.94]){
 const source='A paragraph with **Markdown** and an inline formula $D(t)=\\delta^t$, followed by a second sentence.\n\nSecond paragraph stays rendered.\n\nThird paragraph.';
 const view={page:1,x:.1,y,w:.65,fontSize:size};plugin.settings.pdfTextBlocks['demo.pdf']['layout-test']=view;
 plugin.settings.quickExcerpts['demo.pdf'].push({exId:'layout-test',page:1,note:source,text:'Layout test'});
 const block=plugin.lmbCreateTextBlock(page,{exId:'layout-test',pdfPath:'demo.pdf',quick:true},view);const body=block.querySelector('.lmb-pdf-text-body');
 await stubRender(null,source,body);plugin.lmbStyleTextBlock(block,page,view);viewport.scrollTop=y>.8?500:0;await frame();
 const before={top:block.getBoundingClientRect().top,body:body.getBoundingClientRect().top,scroll:viewport.scrollTop,max:body.style.maxHeight};
 const glyph=document.createRange();glyph.selectNodeContents(body.querySelector('p'));const textTop=glyph.getClientRects()[0].top;
 const editor=plugin.lmbOpenInlineNoteEditor(block,{value:source,onSubmit:async()=>{},onClose:()=>{body.empty();stubRender(null,source,body)}});await frame();
 check(Math.abs(block.getBoundingClientRect().top-before.top)<1,'block anchor moved '+y);
 check(Math.abs(body.getBoundingClientRect().top-before.body)<1,'body pushed by toolbar');
 check(viewport.scrollTop===before.scroll,'PDF viewport scrolled');check(body.style.maxHeight===before.max,'reading viewport height changed');
 const input=editor.input;check(Math.abs(input.getBoundingClientRect().top-textTop)<4,'active paragraph baseline moved');
 check(block.querySelector('.lmb-inline-note-editor').getBoundingClientRect().bottom<=body.getBoundingClientRect().top+1,'toolbar consumes body flow');
 await editor.activate(1,3);await frame();check(viewport.scrollTop===before.scroll,'paragraph switch scrolled PDF');check(Math.abs(block.getBoundingClientRect().top-before.top)<1,'paragraph switch moved note');
 editor.cancel();await frame();check(Math.abs(block.getBoundingClientRect().top-before.top)<1,'cancel moved note');
 delete plugin.settings.pdfTextBlocks['demo.pdf']['layout-test'];plugin.settings.quickExcerpts['demo.pdf']=plugin.settings.quickExcerpts['demo.pdf'].filter(x=>x.exId!=='layout-test');block.remove();
 }
 out.textContent='PASS '+checks+' native layout checks (2 sizes × 3 page positions)';
 }catch(error){out.textContent='FAIL '+checks+': '+error.stack;throw error}
})();
