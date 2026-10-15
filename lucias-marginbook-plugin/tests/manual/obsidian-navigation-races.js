/* Disposable vault only. Controlled delays exercise pending navigation. */
(async()=>{
await (async () => {
 if (!app.vault.getAbstractFileByPath('LMB-NAVIGATION-SANDBOX.md')) throw Error('not sandbox');
 const wait = ms => new Promise(r=>setTimeout(r,ms));
 if (!app.vault.getAbstractFileByPath('audit.pdf')) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>','<< /Length 0 >>\nstream\n\nendstream'];
  let pdf='%PDF-1.4\n', offsets=[0];
  objs.forEach((o,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const x=pdf.length; pdf+='xref\n0 5\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  await app.vault.createBinary('audit.pdf',new TextEncoder().encode(pdf).buffer);
 }
 const p=app.plugins.plugins['lucias-marginbook'];
 const pdf=app.workspace.getLeaf('tab'); await pdf.openFile(app.vault.getAbstractFileByPath('audit.pdf'));
 const md=app.workspace.getLeaf('tab');await md.openFile(app.vault.getAbstractFileByPath('book-excerpts.md'));
 await md.setViewState({type:'markdown',state:{file:'book-excerpts.md',mode:'preview'},active:true});
 await wait(1500);
 const log=[];const orig=p._lmbNotifyPdfSidebarLayout;
 p._lmbNotifyPdfSidebarLayout=function(...args){log.push({event:'sidebar-resize',time:performance.now(),active:app.workspace.activeLeaf?.view?.file?.path});return orig.apply(this,args)};
 const view=md.view;const resize=view.previewMode.onResize;
 view.previewMode.onResize=function(...args){log.push({event:'markdown-resize',time:performance.now(),saved:view.scroll,actual:this.getScroll()});return resize.apply(this,args)};
 window.audit={p,pdf,md,log,wait};
 log.length=0;app.workspace.setActiveLeaf(pdf,{focus:true});await wait(500);app.workspace.setActiveLeaf(md,{focus:true});await wait(500);
 return {log,scroll:view.scroll,actual:view.previewMode.getScroll()};
})()
;
for(const leaf of app.workspace.getLeavesOfType('markdown'))if(leaf!==audit.md)leaf.detach();
const races=await (async()=>{
 const {p,pdf,md,wait}=audit;
 const page=pdf.containerEl.querySelector('.page');
 const originalWait=p.lmbWaitPageEl,originalScroll=page.scrollIntoView;
 let release, lateScroll=0;
 p.lmbWaitPageEl=()=>new Promise(r=>release=r);
 page.scrollIntoView=function(...args){lateScroll++;return originalScroll.apply(this,args)};
 const jump=p.lmbJumpToSelection('audit.pdf',1);
 await wait(30);app.workspace.setActiveLeaf(md,{focus:true});release(page);await jump;
 p.lmbWaitPageEl=originalWait;page.scrollIntoView=originalScroll;
 const originalPosition=p._lmbPositionMdExcerpt;
 let unblock;let n=0;
 p._lmbPositionMdExcerpt=function(...args){if(++n===1)return new Promise(r=>unblock=r);return originalPosition.apply(this,args)};
 const a=p.lmbOpenExcerptInMd('ex-target','book-excerpts.md');await wait(50);
 const b=p.lmbOpenExcerptInMd('ex-target','book-excerpts.md');
 app.workspace.setActiveLeaf(pdf,{focus:true});unblock(false);await Promise.all([a,b]);
 const stolen=app.workspace.activeLeaf===md;
 p._lmbPositionMdExcerpt=originalPosition;
 return {version:p.manifest.version,controlledDelay:true,pdfScrolledAfterSwitch:lateScroll,queuedMarkdownStoleFocus:stolen};
})()
;
const sidebar=await (async()=>{
 if(!app.vault.getAbstractFileByPath('LMB-NAVIGATION-SANDBOX.md'))throw Error('not sandbox');
 const p=app.plugins.plugins['lucias-marginbook'],wait=ms=>new Promise(r=>setTimeout(r,ms));
 const pdf=app.workspace.getLeavesOfType('pdf')[0],md=app.workspace.getLeavesOfType('markdown')[0];
 app.workspace.setActiveLeaf(md,{focus:true});await wait(700);
 let mdResizes=0,notifications=0;
 const resize=md.view.previewMode.onResize,notify=p._lmbNotifyPdfSidebarLayout;
 md.view.previewMode.onResize=function(...a){mdResizes++;return resize.apply(this,a)};
 p._lmbNotifyPdfSidebarLayout=function(...a){notifications++;return notify.apply(this,a)};
 for(let i=0;i<5;i++)await p.lmbRenderPdfSidebarForLeaf(pdf);
 await wait(400);const refresh={mdResizes,notifications};
 app.workspace.setActiveLeaf(pdf,{focus:true});await wait(400);
 const measure=()=>({container:pdf.containerEl.querySelector('.pdf-viewer-container').clientWidth,page:pdf.containerEl.querySelector('.page').getBoundingClientRect().width});
 p.lmbSetPdfSidebarVisible(pdf,true);await wait(400);const open=measure();
 p.lmbSetPdfSidebarVisible(pdf,false);await wait(400);const closed=measure();
 p.lmbSetPdfSidebarVisible(pdf,true);await wait(400);const reopened=measure();
 md.view.previewMode.onResize=resize;p._lmbNotifyPdfSidebarLayout=notify;
 return {version:p.manifest.version,refresh,open,closed,reopened,pdfStillResizes:closed.container>open.container&&closed.page>open.page&&Math.abs(reopened.page-open.page)<2};
})()
;
return {races,sidebar};
})()