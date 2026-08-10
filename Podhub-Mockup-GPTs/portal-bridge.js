(() => {
  'use strict';
  if (window.__podhubMockupPortalBridge) return;
  window.__podhubMockupPortalBridge = true;
  const channel=()=>document.getElementById('pmg-extension-channel');
  const reply=(requestId,result={})=>{
    const response={type:'PMG_PORTAL_RESULT',request_id:requestId,ok:result.ok===true,error:result.error||null};
    window.postMessage(response,location.origin);
    const node=channel();
    if(node){node.setAttribute('data-pmg-response',JSON.stringify(response));node.dispatchEvent(new Event('PMG_PORTAL_RESULT_EVENT'))}
  };
  const forward=message=>{
    if(message?.type!=='PMG_PORTAL_IMPORT'||!message.request_id||!message.asset?.id)return;
    try{
      chrome.runtime.sendMessage({type:'PMG_IMPORT_ASSET',asset:message.asset},result=>{
        const runtimeError=chrome.runtime.lastError;
        if(runtimeError)return reply(message.request_id,{ok:false,error:runtimeError.message||'EXTENSION_BRIDGE_ERROR'});
        reply(message.request_id,result||{ok:false,error:'EXTENSION_NO_RESPONSE'});
      });
    }catch(error){reply(message.request_id,{ok:false,error:error?.message||'EXTENSION_BRIDGE_ERROR'})}
  };
  window.addEventListener('message', event => {
    if(event.source!==window||event.origin!==location.origin)return;
    forward(event.data);
  });
  document.addEventListener('PMG_PORTAL_IMPORT_EVENT',()=>{
    const raw=channel()?.getAttribute('data-pmg-request');
    if(!raw)return;
    try{forward(JSON.parse(raw))}catch{}
  });
})();
