// Real DOM with an append-only icon API: refreshes must not accumulate labels.
(async () => {
  const out = document.body.createEl('pre', {attr:{id:'controls-results'}}), results=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);results.push(label);};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  try {
    await plugin.lmbRenderPdfSidebarForLeaf(leaf);
    const host=leaf.containerEl.querySelector('.lmb-pdf-sidebar-host'), bar=host.querySelector('.lmb-pdf-excerpt-sidebar');
    for(let i=0;i<24;i++) {
      await plugin.lmbSetPdfSidebarSide(i%2?'right':'left');
      plugin.lmbEnsurePdfSidebarEl(leaf); plugin.lmbSetPdfSidebarVisible(leaf,i%3!==0);
      await plugin.lmbRenderPdfSidebarForLeaf(leaf);
      const side=host.querySelector('.lmb-sidebar-side-toggle'), toggle=host.querySelector('.lmb-sidebar-state-toggle');
      check(side.querySelectorAll('span').length===0&&side.querySelectorAll('svg').length===1&&side.textContent.trim()===''&&side.title===side.getAttribute('aria-label'),'refresh '+i+' retains one icon without visible side text and keeps an accessible tooltip');
      check(toggle.querySelectorAll('svg').length===1&&host.querySelectorAll('.lmb-sidebar-header-actions button').length===2,'refresh '+i+' retains exactly two header controls');
    }
    plugin.lmbSetPdfSidebarVisible(leaf,true);
    const row=bar.querySelector('.lmb-pdf-sidebar-item'), body=row.querySelector('.lmb-pdf-sidebar-item-note-body');
    body.closest('.lmb-pdf-sidebar-item-note').classList.remove('is-collapsed');
    body.createEl('pre').createEl('code',{text:'long_code_identifier_'.repeat(80)});
    const table=body.createEl('table'), tr=table.createEl('tr');
    for(let i=0;i<5;i++)tr.createEl('td',{text:'https://example.com/'+('unbroken-content-'.repeat(20))});
    const actions=row.querySelector('.lmb-pdf-sidebar-item-actions');
    for(let i=0;i<8;i++)actions.createEl('button',{text:'⋮',cls:'lmb-pdf-sidebar-icon-button'});
    for(const mobile of [false,true])for(const width of [260,340,560])for(const side of ['right','left']) {
      document.body.classList.toggle('lmb-mobile',mobile);plugin._lmbPdfSidebarWidth=width;
      plugin.lmbEnsurePdfSidebarEl(leaf);bar.style.width=width+'px';await plugin.lmbSetPdfSidebarSide(side);await frame();
      const a=host.querySelector('.lmb-sidebar-side-toggle').getBoundingClientRect(),b=host.querySelector('.lmb-sidebar-state-toggle').getBoundingClientRect();
      check(Math.abs(a.top-b.top)<1&&Math.abs(a.height-b.height)<1&&a.right<=b.left,'aligned header '+mobile+'/'+width+'/'+side);
      check(getComputedStyle(bar).overflowX==='hidden'&&bar.scrollWidth<=bar.clientWidth+1,'no horizontal sidebar overflow '+mobile+'/'+width+'/'+side);
      const controls=actions.getBoundingClientRect(), buttons=[...actions.children].map(el=>el.getBoundingClientRect());
      check(buttons.every(rect=>rect.left>=controls.left-1&&rect.right<=controls.right+1),'actions wrap inside the card '+mobile+'/'+width+'/'+side);
    }
    document.body.classList.remove('lmb-mobile');plugin._lmbPdfSidebarWidth=340;plugin.lmbEnsurePdfSidebarEl(leaf);bar.style.width='340px';await plugin.lmbSetPdfSidebarSide('right');
    out.textContent='PASS '+results.length+' repeated-header and sidebar overflow checks';out.dataset.report=JSON.stringify({checks:results.length,results,hostLikeIcon:true,nativeObsidian:false});
  }catch(error){out.textContent='FAIL after '+results.length+': '+error.stack;throw error;}
})();
