(async()=>{
  const out=document.body.createEl('pre',{attr:{id:'cache-results'}}),results=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);results.push(label);};
  const NativePath=window.Path2D;let builds=0;
  try{
    window.Path2D=class extends NativePath{constructor(...args){super(...args);builds++;}};
    const object={id:'cache-stroke',type:'pen',renderVersion:3,width:.005,widthUnit:'page',pressureMode:'natural',color:'#223344',points:Array.from({length:160},(_,i)=>({x:.1+i*.004,y:.3+Math.sin(i*.06)*.08,p:.04+.76*Math.sin(Math.PI*i/159),t:i*8}))};
    const paint=(o,w,h,cached)=>{const c=document.createElement('canvas');c.width=w;c.height=h;plugin.lmbDrawInkObject(c.getContext('2d'),o,w,h,cached);return c;};
    const diff=(a,b)=>{const left=a.getContext('2d').getImageData(0,0,a.width,a.height).data,right=b.getContext('2d').getImageData(0,0,b.width,b.height).data;let delta=0;for(let i=3;i<left.length;i+=4)delta+=Math.abs(left[i]-right[i]);return delta/(left.length/4);};
    for(const scale of [1,.6,1.5,1.1]){
      const w=Math.round(800*scale),h=Math.round(1100*scale);
      check(diff(paint(object,w,h,true),paint(object,w,h,false))<.02,'cached and active pen outlines agree at zoom '+scale);
    }
    check(builds===1,'zoom reuses a single reference-space path');
    const beforeColor=builds;object.color='#e05252';paint(object,800,1100,true);check(builds===beforeColor,'color changes reuse geometry');
    object.width=.008;paint(object,800,1100,true);check(builds===beforeColor+1,'width changes invalidate geometry');
    const beforePoints=builds;object.points=object.points.map(p=>({...p,x:p.x+.01}));paint(object,800,1100,true);check(builds===beforePoints+1,'moving points rebuilds the path');
    plugin._lmbInkDocs={'demo.pdf':{'1':{objects:[object]}}};plugin.settings.inkAnnotations={};plugin.lmbMarkInkDirty=()=>{};
    const before=JSON.parse(JSON.stringify([object])),beforeEdit=builds;object.points[40].x+=.03;plugin.lmbCommitInkChange('demo.pdf',1,before,'geometry');paint(object,800,1100,true);check(builds===beforeEdit+1,'committing an in-place geometry edit invalidates the path');
    const legacy={...object,id:'legacy-cache',renderVersion:2};check(diff(paint(legacy,800,1100,true),paint(legacy,800,1100,false))<.02,'older outlines retain exact size-specific geometry');
    for(const w of [850,900,950,1000])paint(legacy,w,Math.round(w*1.375),true);
    check(plugin._lmbInkPathCache.get(legacy).paths.size<=3,'older zoom cache has bounded size');
    const aspectBuilds=builds;paint(object,800,800,true);check(builds===aspectBuilds+1,'a genuine page aspect change rebuilds geometry');
    const snapshot=JSON.stringify(object);paint(object,800,800,true);check(JSON.stringify(object)===snapshot,'render cache never modifies editable stroke data');
    const hiddenBuilds=builds;paint(object,0,0,true);check(builds===hiddenBuilds,'hidden zero-size canvases cannot create invalid cached paths');
    out.textContent='PASS '+results.length+' ink path cache and zoom geometry checks';out.dataset.report=JSON.stringify({checks:results.length,results});
  }catch(error){out.textContent='FAIL after '+results.length+': '+error.stack;throw error;}finally{window.Path2D=NativePath;}
})();
