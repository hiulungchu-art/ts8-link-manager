(function(){
  try{
    var CFG=(window.TS8_CONFIG)||{};
    var url=CFG.UPLOAD_WEBAPP_URL; if(!url) return;
    var secret=CFG.UPLOAD_SECRET||'';
    var k='ts8_cid';
    var cid=localStorage.getItem(k);
    if(!cid){ cid='c'+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem(k,cid); }
    window.__ts8Cid=cid;
    var body=JSON.stringify({
      secret:secret, op:'ping',
      path:location.pathname+location.search,
      ref:document.referrer||'',
      cid:cid,
      ua:(navigator.userAgent||'').slice(0,180)
    });
    fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:body,keepalive:true,mode:'cors'}).catch(function(){});
  }catch(e){}
})();
