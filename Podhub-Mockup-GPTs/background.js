'use strict';

const DEFAULT_ORIGIN = 'https://tools.podhub.space';

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

async function apiRequest({path, method = 'GET', body, headers = {}}) {
  const saved = await storageGet(['pmg_api_origin', 'pmg_license_token']);
  const origin = String(saved.pmg_api_origin || DEFAULT_ORIGIN).replace(/\/$/, '');
  const token = String(saved.pmg_license_token || '');
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      ...(token ? {Authorization: 'Bearer ' + token} : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = payload.error || `HTTP_${response.status}`;
    if (response.status === 401 && ['EXTENSION_SESSION_INVALID','SESSION_KICKED'].includes(code)) {
      await chrome.storage.local.remove(['pmg_license_token','pmg_license_user','pmg_runtime_config','pmg_gpt_url']);
    }
    throw new Error(code);
  }
  return payload;
}

async function refreshStoredSession(force=false){
  const saved=await storageGet(['pmg_api_origin','pmg_license_token','pmg_session_refreshed_at']);
  const token=String(saved.pmg_license_token||'');
  if(!token)return false;
  if(!force&&Date.now()-Number(saved.pmg_session_refreshed_at||0)<24*60*60*1000)return true;
  const origin=String(saved.pmg_api_origin||DEFAULT_ORIGIN).replace(/\/$/,'');
  const response=await fetch(origin+'/api/extension/session/refresh',{method:'POST',headers:{Authorization:'Bearer '+token}});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||!payload.success){
    const code=payload.error||`HTTP_${response.status}`;
    if(response.status===401&&['EXTENSION_SESSION_INVALID','SESSION_KICKED'].includes(code))await chrome.storage.local.remove(['pmg_license_token','pmg_license_user','pmg_runtime_config','pmg_gpt_url','pmg_session_refreshed_at']);
    throw new Error(code);
  }
  const accessToken=payload.data?.access_token;
  if(accessToken)await chrome.storage.local.set({pmg_license_token:accessToken,pmg_session_refreshed_at:Date.now()});
  return true;
}

chrome.runtime.onInstalled.addListener(()=>refreshStoredSession(true).catch(()=>{}));
chrome.runtime.onStartup.addListener(()=>refreshStoredSession().catch(()=>{}));

async function assetData(asset) {
  const saved=await storageGet(['pmg_api_origin','pmg_license_token']);
  const origin=String(saved.pmg_api_origin||DEFAULT_ORIGIN).replace(/\/$/,'');
  const response=await fetch(`${origin}/api/extension/assets/${encodeURIComponent(asset.id)}/content`,{headers:{Authorization:'Bearer '+String(saved.pmg_license_token||'')}});
  if(!response.ok){const payload=await response.json().catch(()=>({}));throw new Error(payload.error||`HTTP_${response.status}`)}
  const bytes=new Uint8Array(await response.arrayBuffer());
  let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return {name:decodeURIComponent(response.headers.get('X-Podhub-Design-Name')||'')||asset.name||'raw-design.png',type:response.headers.get('Content-Type')||'image/png',data_url:`data:${response.headers.get('Content-Type')||'image/png'};base64,${btoa(binary)}`};
}

async function uploadMockup(message){
  const saved=await storageGet(['pmg_api_origin','pmg_license_token']);
  const origin=String(saved.pmg_api_origin||DEFAULT_ORIGIN).replace(/\/$/,'');
  const blob=await(await fetch(message.data_url)).blob();
  const query=new URLSearchParams({product_id:String(message.product_id||''),mockup_no:String(message.mockup_no||1),filename:String(message.filename||'mockup.png')});
  const response=await fetch(`${origin}/api/extension/mockup-jobs/${encodeURIComponent(message.job_id)}/mockups?${query}`,{
    method:'POST',headers:{Authorization:'Bearer '+String(saved.pmg_license_token||''),'Content-Type':blob.type||'image/png'},body:blob
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||`HTTP_${response.status}`);
  return payload.data||payload;
}

async function createManualJob(message){
  const saved=await storageGet(['pmg_api_origin','pmg_license_token']);
  const origin=String(saved.pmg_api_origin||DEFAULT_ORIGIN).replace(/\/$/,'');
  const blob=await(await fetch(message.data_url)).blob();
  const query=new URLSearchParams({filename:String(message.filename||'raw-design.png')});
  const response=await fetch(`${origin}/api/extension/mockup-jobs/manual?${query}`,{method:'POST',headers:{Authorization:'Bearer '+String(saved.pmg_license_token||''),'Content-Type':blob.type||'image/png'},body:blob});
  const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error||`HTTP_${response.status}`);return payload.data||payload;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PMG_API') {
    apiRequest(message.request).then(
      data => sendResponse({ok: true, data}),
      error => sendResponse({ok: false, error: error.message})
    );
    return true;
  }
  if(message?.type==='PMG_REFRESH_SESSION'){
    refreshStoredSession(message.force===true).then(ok=>sendResponse({ok:true,data:{refreshed:ok}}),error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if (message?.type === 'PMG_OPEN_GPT') {
    chrome.tabs.create({url: message.url}).then(tab => sendResponse({ok: true, tabId: tab.id}));
    return true;
  }
  if(message?.type==='PMG_GET_PENDING_ASSET'){
    (async()=>{
      const saved=await storageGet(['pmg_pending_asset']);
      let asset=saved.pmg_pending_asset||null;
      if(!asset){const next=await apiRequest({path:'/api/extension/mockup-jobs/next'});asset=next?.data||null}
      if(!asset)return {ok:true,data:null};
      try{
        const data=await assetData(asset);
        if(asset.job_id)await apiRequest({path:`/api/extension/mockup-jobs/${encodeURIComponent(asset.job_id)}/status`,method:'POST',body:{status:'imported'}});
        if(saved.pmg_pending_asset)await chrome.storage.local.remove('pmg_pending_asset');
        return {ok:true,data:{...asset,...data}};
      }catch(error){
        if(asset.job_id)await apiRequest({path:`/api/extension/mockup-jobs/${encodeURIComponent(asset.job_id)}/status`,method:'POST',body:{status:'failed',error:error.message}}).catch(()=>{});
        throw error;
      }
    })().then(sendResponse,error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if(message?.type==='PMG_FETCH_ASSET'){
    assetData(message.asset).then(data=>sendResponse({ok:true,data:{...message.asset,...data}}),error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if(message?.type==='PMG_UPLOAD_MOCKUP'){
    uploadMockup(message).then(data=>sendResponse({ok:true,data}),error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if(message?.type==='PMG_CREATE_MANUAL_JOB'){
    createManualJob(message).then(data=>sendResponse({ok:true,data}),error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  return false;
});
