// Host menu substitute; pointer lifecycle and the production target/menu code are real.
(async()=>{
 const out=document.body.createEl('pre',{attr:{id:'pages-results'}}),results=[];
 const check=(ok,label)=>{if(!ok)throw Error(label);results.push(label);},wait=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  const calls=[];plugin.lmbInsertBlankPdfPage=async(...args)=>{calls.push(args);return true;};
  plugin.registerDomEvent=(el,type,fn,opts)=>el.addEventListener(type,fn,opts);plugin.register=()=>{};plugin.lmbSetupPdfPageEditing();
  pdf.stat={mtime:7};const rail=leaf.containerEl.createDiv({cls:'pdf-thumbnails'});rail.style.cssText='position:fixed;left:5px;top:50px;z-index:8000;background:#333;padding:8px';
  const thumb=rail.createDiv({cls:'thumbnail',attr:{'data-page-number':'2'}});thumb.createEl('div',{text:'PDF 第 2 页缩略图'});thumb.style.cssText='width:140px;height:160px;border:1px solid #888;background:white;color:black';
  const inner=thumb.firstChild,context=()=>inner.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:160,clientY:65}));
  context();let buttons=document.querySelectorAll('.fixture-page-menu button');
  check(buttons.length===2&&buttons[0].textContent.includes('页前')&&buttons[1].textContent.includes('页后'),'right-click thumbnail reveals both insert actions');
  buttons[0].click();await wait(0);check(calls[0][1]===2&&calls[0][2]===false&&calls[0][3]===7,'before action retains source page and file version');
  context();document.querySelectorAll('.fixture-page-menu button')[1].click();await wait(0);check(calls[1][2]===true,'after action chooses the correct insertion side');
  const pointer=(type,extra={})=>inner.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:8,pointerType:'touch',isPrimary:true,button:0,clientX:50,clientY:90,...extra}));
  let count=window.fixturePageMenus;pointer('pointerdown');await wait(610);check(window.fixturePageMenus===count+1,'stationary touch long press opens page actions');
  context();check(window.fixturePageMenus===count+1,'native contextmenu following long press never duplicates the menu');pointer('pointerup');
  document.querySelector('.fixture-page-menu').remove();count=window.fixturePageMenus;pointer('pointerdown');pointer('pointermove',{clientY:130});await wait(600);check(window.fixturePageMenus===count,'scrolling/moving finger cancels long press');
  pointer('pointerdown');pointer('pointerup');await wait(600);check(window.fixturePageMenus===count,'a short tap only navigates and never opens the menu');
  pointer('pointerdown');pointer('pointercancel');await wait(600);check(window.fixturePageMenus===count,'cancelled touch cannot open a delayed menu');
  pointer('pointerdown');document.dispatchEvent(new Event('scroll'));await wait(600);check(window.fixturePageMenus===count,'thumbnail scrolling cancels the pending menu');
  pointer('pointerdown');pointer('pointerdown',{pointerId:9,isPrimary:false});await wait(600);check(window.fixturePageMenus===count,'second finger cancels long press');
  pointer('pointerdown',{pointerType:'pen'});await wait(610);check(window.fixturePageMenus===count+1,'stationary pen long press opens the same actions');pointer('pointerup',{pointerType:'pen'});
  const other=Object.assign(new StubFile(),{path:'other.pdf',extension:'pdf'});leaf.view.file=other;const before=calls.length;document.querySelector('.fixture-page-menu button').click();await wait(0);check(calls.length===before,'a stale menu cannot edit a newly selected PDF');leaf.view.file=pdf;
  out.textContent='PASS '+results.length+' PDF thumbnail menu/long-press checks';out.dataset.report=JSON.stringify({checks:results.length,results,physicalTablet:false,nativeMenu:false});
 }catch(error){out.textContent='FAIL after '+results.length+': '+error.stack;throw error;}
})();
