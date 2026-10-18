'use strict';
const assert=require('node:assert/strict'),Module=require('node:module');
class TFile{constructor(path){this.path=path;this.name=path.split('/').pop();this.extension=path.split('.').pop();this.stat={mtime:1};}}
class Modal{constructor(){this.contentEl={createEl(){},createDiv(){return {textContent:''};}};}open(){this.onOpen();}close(){}}
const load=Module._load;Module._load=function(name,...args){if(name==='obsidian')return{Plugin:class{},Notice:class{},Modal,TFile,Menu:class{},PluginSettingTab:class{},Setting:class{},FuzzySuggestModal:class{},setIcon(){},normalizePath:p=>p};return load.call(this,name,...args);};
const P=require('../../main.js');Module._load=load;const pure=P.__test,{PDFDocument,PDFName,PDFArray,degrees}=pure.LMB_PDF_LIB;
const clone=x=>JSON.parse(JSON.stringify(x)),ab=b=>{b=Buffer.from(b);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
async function fixture(){
 const p=new P(),pdf=new TFile('Books/doc.pdf'),md=new TFile('Notes/doc.md'),canvas=new TFile('Notes/doc.canvas'),other=new TFile('Other/doc.pdf'),files=new Map([pdf,md,canvas,other].map(f=>[f.path,f])),raw=new Map(),original=await PDFDocument.create();
 for(let i=0;i<3;i++){const page=original.addPage([400+i*20,600+i*30]);page.drawText('ORIGINAL PAGE '+(i+1));if(i===1)page.setRotation(degrees(90));}
 original.catalog.set(PDFName.of('PageLabels'),original.context.obj({Nums:[0,{S:'D'},2,{S:'r'}]}));
 raw.set(pdf.path,Buffer.from(await original.save()));raw.set(md.path,'> [!lmb-excerpt]+ P.2 · 原文\n> [[Books/doc.pdf#page=2&selection=1,0,2,4|【doc-P.2】]]\n> <!-- LMB-NOTE:BEGIN -->\n> KEEP MY COMMENT P.2\n> <!-- LMB-NOTE:END -->\n> ^ex-keep\n[[Other/doc.pdf#page=2|other]]\n[link](../Books/doc.pdf#page=3)');
 const data={nodes:[{id:'a',type:'text',text:'[[Books/doc.pdf#page=2|📖]]',x:11,y:27,width:400,height:230},{id:'file',type:'file',file:pdf.path,subpath:'#page=3',x:500,y:50,width:400,height:600}],edges:[{id:'edge',fromNode:'a',toNode:'file'}],custom:{keep:true}};raw.set(canvas.path,JSON.stringify(data));
 p.settings={quickExcerpts:{[pdf.path]:[{exId:'quick',page:2,note:'KEEP QUICK',pageNote:true}]},pdfTextBlocks:{[pdf.path]:{quick:{page:2,x:.2,y:.3,w:.5,fontSize:18}}},inkExcerptLinks:{[pdf.path]:{quick:{id:'ref',number:4,groups:[{id:'g',page:2,objectIds:['s']}]}}},inkAnnotations:{},inkLinkCounters:{[pdf.path]:5}};
 p._lmbInkDocs={[pdf.path]:{'1':{objects:[{id:'one'}]},'2':{objects:[{id:'s',points:[{x:.1,y:.2,p:.7,t:1}]}]}}};p.manifest={id:'lucias-marginbook'};
 const dir=p.lmbInkStorageDir(),ink=dir+'/'+pure.lmbInkFileKey(pdf.path),settingsPath='.obsidian/plugins/lucias-marginbook/data.json';
 for(const suffix of ['', '.tmp','.bak'])raw.set(ink+suffix,JSON.stringify({version:pure.LMB_INK_SCHEMA_VERSION,pdfPath:pdf.path,revision:1,pages:p._lmbInkDocs[pdf.path]}));raw.set(settingsPath,JSON.stringify(p.settings));
 let failPath=null,failCount=0;const adapter={exists:async path=>raw.has(path),mkdir:async path=>raw.set(path,null),read:async path=>{if(!raw.has(path))throw Error('missing '+path);return raw.get(path);},readBinary:async path=>ab(raw.get(path)),write:async(path,text)=>{if(path===failPath&&failCount-- >0)throw Error('simulated write failure');raw.set(path,text);},writeBinary:async(path,bytes)=>raw.set(path,Buffer.from(bytes))};
 const memory={getData:()=>memory.data,setData:d=>{memory.data=clone(d);},requestSave(){},data:clone(data)};
 const leaf={containerEl:{},view:{file:pdf,viewer:{pdfViewer:{currentPageNumber:1}},loadFile:async()=>{}}};
 p.app={vault:{adapter,getFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path),readBinary:async f=>ab(raw.get(f.path)),modifyBinary:async(f,b)=>{raw.set(f.path,Buffer.from(b));f.stat.mtime++;},modify:async(f,text)=>adapter.write(f.path,text)},workspace:{getLeavesOfType:type=>type==='pdf'?[leaf]:[]},metadataCache:{getFirstLinkpathDest:(dest,source)=>files.get(dest)|| (dest==='../Books/doc.pdf'?pdf:null)}};
 p._lmbMemCanvasData=f=>f.path===canvas.path?{data:memory.data,canvas:memory}:null;p.selfWritten=new Map();p.settingsStore={serialize:clone};
 p.lmbSaveEditorsBeforeInkNavigation=async()=>true;p.lmbFlushInkStorage=async()=>true;p.lmbEnsureInkDocument=async()=>true;p.buildExcerptIndex=async()=>{};
 p.lmbScheduleMarksRefresh=p.lmbSchedulePdfSidebarRefresh=p.lmbScheduleInkReferenceRefresh=()=>{};
 return{p,pdf,md,canvas,raw,leaf,ink,memory,settingsPath,original,fail:(path,count=1)=>{failPath=path;failCount=count;}};
}
async function main(){
 const grouped='<!-- LMB:BEGIN -->\n## P.2\n> [!lmb-excerpt]+ ① P.2 · 原文\n> [[Books/doc.pdf#page=2|📖]]\n<!-- LMB:END -->\n## P.2';
 const shifted=pure.lmbShiftPdfTextLinks(grouped,2,d=>d==='Books/doc.pdf');assert(shifted.includes('## P.3\n> [!lmb-excerpt]+ ① P.3'));assert(shifted.endsWith('## P.2'),'unmanaged written headings remain untouched');
 const f=await fixture(),before=clone(f.p.settings),refs=f.original.getPages().map(page=>page.ref.toString());f.memory.data.nodes[0].x=999;
 assert.equal(await f.p.lmbInsertBlankPdfPage(f.leaf,2,false,1),true);
 const doc=await PDFDocument.load(f.raw.get(f.pdf.path));assert.equal(doc.getPageCount(),4);assert.deepEqual([doc.getPage(0),doc.getPage(2),doc.getPage(3)].map(p=>p.ref.toString()),refs);
 assert.equal(doc.getPage(1).getRotation().angle,90);assert.deepEqual(doc.getPage(1).getSize(),{width:420,height:630});assert.equal(doc.getPage(1).node.Contents(),undefined,'inserted page is genuinely blank');
 const nums=doc.catalog.lookup(PDFName.of('PageLabels')).lookup(PDFName.of('Nums'),PDFArray);assert.equal(nums.get(2).asNumber(),3);
 assert.equal(f.p.settings.quickExcerpts[f.pdf.path][0].page,3);assert.equal(f.p.settings.pdfTextBlocks[f.pdf.path].quick.page,3);assert.equal(f.p.settings.inkExcerptLinks[f.pdf.path].quick.groups[0].page,3);
 assert.equal(f.p.settings.quickExcerpts[f.pdf.path][0].note,'KEEP QUICK');assert.equal(f.p.settings.pdfTextBlocks[f.pdf.path].quick.fontSize,18);assert.equal(f.p.settings.inkLinkCounters[f.pdf.path],5);
 assert(f.raw.get(f.md.path).includes('P.3 · 原文'));assert(f.raw.get(f.md.path).includes('#page=3&selection=1,0,2,4'));assert(f.raw.get(f.md.path).includes('KEEP MY COMMENT P.2'));assert(f.raw.get(f.md.path).includes('Other/doc.pdf#page=2'));assert(f.raw.get(f.md.path).includes('../Books/doc.pdf#page=4'));
 const canvas=JSON.parse(f.raw.get(f.canvas.path));assert.equal(canvas.nodes[0].x,999,'current unsaved canvas position is preserved');assert.equal(canvas.nodes[1].subpath,'#page=4');assert.deepEqual(canvas.edges,f.memory.data.edges);assert.deepEqual(canvas.custom,{keep:true});
 for(const suffix of ['', '.tmp','.bak']){const ink=JSON.parse(f.raw.get(f.ink+suffix));assert.equal(ink.pages['3'].objects[0].id,'s');assert.deepEqual(ink.pages['3'].objects[0].points,[{x:.1,y:.2,p:.7,t:1}]);}
 const journal=JSON.parse(f.raw.get(f.p.lmbPdfPageJournalPath()));assert.equal(journal.phase,'committed');assert(Buffer.isBuffer(f.raw.get(journal.files[0].backup)));assert.equal(f.leaf.view.viewer.pdfViewer.currentPageNumber,2);
 const end=await fixture();assert(await end.p.lmbInsertBlankPdfPage(end.leaf,3,true,1));assert.equal((await PDFDocument.load(end.raw.get(end.pdf.path))).getPageCount(),4);assert.deepEqual(end.p.settings,before,'append after final page does not shift existing records');
 const start=await fixture();assert(await start.p.lmbInsertBlankPdfPage(start.leaf,1,false,1));assert(start.p.lmbInkStore()[start.pdf.path]['2'].objects[0].id==='one');
 const failure=await fixture(),snapshot=new Map([...failure.raw].map(([k,v])=>[k,Buffer.isBuffer(v)?Buffer.from(v):v]));failure.fail(failure.ink+'.tmp');
 assert.equal(await failure.p.lmbInsertBlankPdfPage(failure.leaf,2,false,1),false);for(const[k,v]of snapshot)assert.deepEqual(failure.raw.get(k),v,'rollback '+k);assert.deepEqual(failure.p.settings,before);assert.equal(JSON.parse(failure.raw.get(failure.p.lmbPdfPageJournalPath())).phase,'rolled-back');
 const interrupted=await fixture(),originalData=Buffer.from(interrupted.raw.get(interrupted.pdf.path)),backup='.obsidian/plugins/lucias-marginbook/page-backups/test/0.pdf';interrupted.raw.set(backup,originalData);interrupted.raw.set(interrupted.pdf.path,Buffer.from('incomplete'));interrupted.raw.set(interrupted.p.lmbPdfPageJournalPath(),JSON.stringify({phase:'writing',files:[{path:interrupted.pdf.path,backup,binary:true}]}));await interrupted.p.lmbRecoverPdfPageEdit();assert.deepEqual(interrupted.raw.get(interrupted.pdf.path),originalData);
 interrupted.raw.set(interrupted.p.lmbPdfPageJournalPath(),JSON.stringify({phase:'writing',files:[{path:'../escape',backup,binary:true}]}));await assert.rejects(interrupted.p.lmbRecoverPdfPageEdit(),/路径无效/);
 const stale=await fixture();assert.equal(await stale.p.lmbInsertBlankPdfPage(stale.leaf,2,false,99),false);assert.equal((await PDFDocument.load(stale.raw.get(stale.pdf.path))).getPageCount(),3);
 const refresh=await fixture();let rebuilt=0;refresh.leaf.view.onLoadFile=async()=>{throw Error('host reload failure');};refresh.p.buildExcerptIndex=async()=>{rebuilt++;};assert(await refresh.p.lmbInsertBlankPdfPage(refresh.leaf,2,false,1));assert.equal(rebuilt,1);assert.equal(JSON.parse(refresh.raw.get(refresh.p.lmbPdfPageJournalPath())).phase,'committed');assert.equal(refresh.p._lmbPdfPageMutation,false);
 const rollbackView=await fixture();rollbackView.leaf.view.onLoadFile=async()=>{throw Error('host reload failure');};rollbackView.fail(rollbackView.ink+'.tmp');assert.equal(await rollbackView.p.lmbInsertBlankPdfPage(rollbackView.leaf,2,false,1),false);assert.equal(JSON.parse(rollbackView.raw.get(rollbackView.p.lmbPdfPageJournalPath())).phase,'rolled-back');assert.equal(rollbackView.p._lmbPdfPageRecoveryRequired,undefined);
 const broken=await fixture();broken.fail(broken.ink+'.tmp',2);assert.equal(await broken.p.lmbInsertBlankPdfPage(broken.leaf,2,false,1),false);assert.equal(broken.p._lmbPdfPageRecoveryRequired,true);assert.equal(await broken.p.lmbInsertBlankPdfPage(broken.leaf,2,false),false);await broken.p.lmbRecoverPdfPageEdit();assert.equal((await PDFDocument.load(broken.raw.get(broken.pdf.path))).getPageCount(),3);
 console.log('PDF page insertion: real PDF geometry/rotation/identity, page labels, links, comments, ink backups, live Canvas layout, rollback and restart recovery passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
