(() => {
  'use strict';
  if (window.__podhubMockupGptsLoaded) return;
  window.__podhubMockupGptsLoaded = true;

  const MODULE_ID = 'mockup-gpts';
  const JOB_KEY = 'pmg_active_job';
  const BATCH_KEY = 'pmg_batch_v2';
  const PREFS_KEY = 'pmg_preferences_v1';
  const MAX_WAIT_TEXT_MS = 8 * 60 * 1000;
  const MAX_WAIT_IMAGE_MS = 12 * 60 * 1000;
  const FALLBACK_PRODUCTS = [
    {id:'tumbler_20oz', label:'20oz Tumbler', default_mockup_count:3},
    {id:'mug_11oz', label:'11oz Mug', default_mockup_count:3},
    {id:'blanket', label:'Blanket', default_mockup_count:3},
    {id:'poster', label:'Poster', default_mockup_count:3},
    {id:'tshirt', label:'T-shirt', default_mockup_count:3},
    {id:'hoodie', label:'Hoodie', default_mockup_count:3}
  ];
  let runtimeConfig = null;
  let activeJob = null;
  let observer = null;
  let knownImages = new Set();
  let queueJobs = [];
  let queueFilter = 'pending';
  let selectedQueueJobs = new Set();
  let queueRunning = false;
  let queuePaused = false;
  let activeJobResolver = null;
  let heartbeatTimer = null;
  let workflowRunning = false;
  let stopRequested = false;
  let preferencesHydrated = false;
  let preferencesTimer = null;

  const storageGet = keys => chrome.storage.local.get(keys);
  const storageSet = value => chrome.storage.local.set(value);
  const api = async request => {
    const result = await chrome.runtime.sendMessage({type:'PMG_API', request});
    if (!result?.ok) throw new Error(result?.error || 'API request failed');
    return result.data?.data || result.data;
  };
  const safe = text => String(text || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const slug = text => String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,80);

  function readUiPreferences(){
    return {
      products:[...document.querySelectorAll('input[name="pmg-product"]:checked')].map(x=>x.value),
      marketplaces:[...document.querySelectorAll('input[name="pmg-listing"]:checked')].map(x=>x.value),
      mockup_count:Math.max(1,Math.min(10,Number(document.querySelector('#pmg-count')?.value||3))),
      aspect_ratio:document.querySelector('#pmg-ratio')?.value||'1:1',
      auto_run:document.querySelector('#pmg-auto')?.checked===true
    };
  }

  async function persistUiPreferences(){
    if(!preferencesHydrated)return;
    await storageSet({[PREFS_KEY]:readUiPreferences()});
  }

  function schedulePreferencesSave(){
    clearTimeout(preferencesTimer);
    preferencesTimer=setTimeout(()=>persistUiPreferences().catch(()=>{}),150);
  }

  async function renderLicenseState(){
    const saved=await storageGet(['pmg_license_token','pmg_license_user']);
    const active=Boolean(saved.pmg_license_token);
    const input=document.querySelector('#pmg-license');
    const button=document.querySelector('#pmg-activate');
    const state=document.querySelector('#pmg-license-active');
    if(input){input.hidden=active;if(active)input.value=''}
    if(button)button.hidden=active;
    if(state){state.hidden=!active;state.textContent=active?`✓ Đã kích hoạt${saved.pmg_license_user?.username?` · ${saved.pmg_license_user.username}`:''}`:''}
  }

  function friendlyError(error) {
    const code = String(error?.message || error || '');
    if (code === 'EXTENSION_SESSION_INVALID') return 'Phiên extension không hợp lệ. Mở Cấu hình và kích hoạt lại License Key.';
    if (code === 'SESSION_KICKED') return 'Phiên extension đã bị thay thế hoặc thu hồi. Hãy kích hoạt lại License Key.';
    if (code === 'LICENSE_INACTIVE') return 'License Mockup GPTs đang bị khóa.';
    if (code === 'LICENSE_EXPIRED') return 'License Mockup GPTs đã hết hạn.';
    if (code.startsWith('LICENSE_MODULE_MISMATCH:')) return `License này thuộc module ${code.split(':')[1]}. Hãy nhập License Key của Mockup GPTs.`;
    return code || 'Có lỗi xảy ra.';
  }

  function status(text, kind = '', progress) {
    const box = document.querySelector('#pmg-status');
    if (!box) return;
    box.textContent = text;
    box.className = 'pmg-status ' + kind;
    if (kind === 'error' && /license|phiên extension/i.test(String(text))) document.querySelector('#pmg-config')?.classList.remove('hidden');
    const bar = document.querySelector('#pmg-progress i');
    if (bar && progress !== undefined) bar.style.width = Math.max(0, Math.min(100, progress)) + '%';
    if(kind==='ok')setTimeout(()=>{if(box.textContent===text){box.textContent='';box.className='pmg-status'}},2500);
  }

  function normalizeProducts(data) {
    const candidates = data?.product_catalog || data?.products || data?.pipeline?.products;
    if (!Array.isArray(candidates) || !candidates.length) return FALLBACK_PRODUCTS;
    return candidates.filter(x => x && x.enabled !== false).map(x => ({
      id:String(x.id || x.product_id || x.product_type),
      label:String(x.label || x.name || x.product_name || x.id),
      engine:String(x.engine || x.default_engine || 'chatgpt'),
      category:String(x.category || ''),
      image_url:String(x.image_url || x.thumbnail_url || ''),
      description:String(x.description || ''),
      default_mockup_count:Math.max(1, Number(x.default_mockup_count || x.recommended_mockup_count || 3) || 3)
    })).filter(x => x.id);
  }

  function renderProducts(products, selected = new Set()) {
    const hasRelevant=products.some(p=>selected.has(p.id));
    return products.map((p,index)=>`<label class="pmg-check"><input type="checkbox" name="pmg-product" value="${safe(p.id)}" ${selected.has(p.id)||(!hasRelevant&&index===0)?'checked':''}><span>${safe(p.label)}<small>Gợi ý ${Math.max(1,Number(p.default_mockup_count)||3)} mockup</small></span></label>`).join('');
  }

  const normalizeMarketplaceId=value=>({amzon:'amazon'}[String(value||'').trim().toLowerCase()]||String(value||'').trim().toLowerCase());
  function normalizeListings(data){const rows=data?.listing_options;return(Array.isArray(rows)&&rows.length?rows:[{id:'etsy',label:'Etsy JSON'},{id:'walmart',label:'Walmart JSON'},{id:'shopify',label:'Shopify JSON'}]).filter(x=>x.enabled!==false).map(x=>({id:normalizeMarketplaceId(x.id||x.option_id),label:String(x.label||x.option_id)}))}
  function renderListings(rows,selected=new Set(),defaultFirst=true){const hasRelevant=rows.some(x=>selected.has(x.id));return rows.map((x,i)=>`<label class="pmg-check"><input name="pmg-listing" type="checkbox" value="${safe(x.id)}" ${selected.has(x.id)||(defaultFirst&&!hasRelevant&&i===0)?'checked':''}><span>${safe(x.label)}</span></label>`).join('')}
  function bindProductCards(){}

  async function loadConfig() {
    const stored=await storageGet([PREFS_KEY]);
    const savedPrefs=stored[PREFS_KEY]&&typeof stored[PREFS_KEY]==='object'?stored[PREFS_KEY]:null;
    const preferred=preferencesHydrated?readUiPreferences():(savedPrefs||{});
    runtimeConfig = await api({path:'/api/extension/config'});
    const actualModule=runtimeConfig?.module_id||runtimeConfig?.pipeline?.module_id;
    if(actualModule&&actualModule!==MODULE_ID)throw new Error(`License đang thuộc module ${actualModule}. Hãy dùng License Key Mockup GPTs.`);
    if(!Array.isArray(runtimeConfig?.product_catalog)||!Array.isArray(runtimeConfig?.listing_options))throw new Error('Backend không trả về catalog Mockup GPTs. Hãy kích hoạt đúng License Key của module Mockup GPTs.');
    const gptUrl = runtimeConfig?.gpt_links?.[MODULE_ID]?.url;
    if (!gptUrl) throw new Error('Admin chưa cấu hình link Mockup GPTs.');
    await storageSet({pmg_runtime_config:runtimeConfig, pmg_gpt_url:gptUrl});
    const productsData=normalizeProducts(runtimeConfig),listingData=normalizeListings(runtimeConfig);
    const productIds=new Set(productsData.map(x=>x.id)),listingIds=new Set(listingData.map(x=>x.id));
    const selectedProducts=new Set((Array.isArray(preferred.products)?preferred.products:[]).map(String).filter(id=>productIds.has(id)));
    if(!selectedProducts.size&&productsData[0])selectedProducts.add(productsData[0].id);
    const hasSavedMarketplaceChoice=Array.isArray(preferred.marketplaces);
    const selectedListings=new Set((hasSavedMarketplaceChoice?preferred.marketplaces:[]).map(normalizeMarketplaceId).filter(id=>listingIds.has(id)));
    const grid = document.querySelector('#pmg-products');
    if (grid) { grid.innerHTML = renderProducts(productsData,selectedProducts); bindProductCards(); }
    const listings=document.querySelector('#pmg-listings');if(listings)listings.innerHTML=renderListings(listingData,selectedListings,!hasSavedMarketplaceChoice);
    const count=document.querySelector('#pmg-count');if(count&&preferred.mockup_count!=null)count.value=String(Math.max(1,Math.min(10,Number(preferred.mockup_count)||3)));
    const ratio=document.querySelector('#pmg-ratio');if(ratio&&preferred.aspect_ratio&&[...ratio.options].some(x=>x.value===preferred.aspect_ratio))ratio.value=preferred.aspect_ratio;
    const auto=document.querySelector('#pmg-auto');if(auto&&preferred.auto_run!=null)auto.checked=preferred.auto_run===true;
    preferencesHydrated=true;await persistUiPreferences();await renderLicenseState();
    const badge=document.querySelector('#pmg-version');if(badge)badge.textContent=`Catalog v${runtimeConfig.catalog_version||1} · ${new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}`;
    renderAnnouncement(runtimeConfig.announcement);
    return runtimeConfig;
  }

  function renderAnnouncement(item){const box=document.querySelector('#pmg-announcement');if(!box)return;const visible=item?.enabled===true&&String(item.message||'').trim();box.hidden=!visible;box.className=`pmg-announcement ${safe(item?.tone||'info')}`;box.querySelector('span').textContent=visible?String(item.message).trim():''}

  function injectPanel() {
    if (document.querySelector('#pmg-root')) return;
    const root = document.createElement('aside');
    root.id = 'pmg-root';
    root.innerHTML=`<header class="pmg-head"><div><div class="pmg-title">Podhub Mockup GPTs</div><div class="pmg-sub">AI Product Studio · v${chrome.runtime.getManifest().version}</div></div><div class="pmg-head-actions"><button id="pmg-settings">⚙</button><button id="pmg-sync">↻</button><button id="pmg-close">×</button></div></header>
      <div id="pmg-announcement" class="pmg-announcement" hidden><b>📣</b><span></span></div><div id="pmg-status" class="pmg-status"></div><div class="pmg-actions pmg-actions-top"><button id="pmg-run-toggle" class="pmg-btn">▶ Chạy</button><button id="pmg-stop" class="pmg-btn pmg-stop" hidden>■ Stop</button></div><div id="pmg-progress" class="pmg-progress"><i></i></div>
      <section id="pmg-config" class="pmg-config hidden"><div class="pmg-config-title"><b>Cấu hình</b><small id="pmg-version">Catalog v1</small></div><div class="pmg-license-row"><div id="pmg-license-active" class="pmg-license-active" hidden></div><input id="pmg-license" type="password" placeholder="phb_ext_live_..."><button id="pmg-activate">KÍCH HOẠT</button></div><div class="pmg-config-grid"><label>Mockup / sản phẩm<input id="pmg-count" type="number" min="1" max="10" value="3"></label><label>Tỷ lệ<select id="pmg-ratio"><option>1:1</option><option>4:5</option><option>3:4</option><option>16:9</option></select></label></div><div class="pmg-config-section"><b>Sản phẩm mockup <small>· chọn nhiều</small></b><div id="pmg-products" class="pmg-products">${renderProducts(FALLBACK_PRODUCTS)}</div></div><div class="pmg-config-section"><b>Listing JSON <small>· chọn nhiều</small></b><div id="pmg-listings" class="pmg-option-grid">${renderListings(normalizeListings(null))}</div></div><label class="pmg-inline"><input id="pmg-auto" type="checkbox"> Tự chạy từng mockup</label></section>
      <nav class="pmg-tabs"><button data-page="products">Upload thủ công</button><button class="active" data-page="jobs">Queue</button><button data-page="history">Lịch sử</button></nav>
      <main class="pmg-main"><section class="pmg-page" data-page="products"><div class="pmg-upload"><span>Chọn design từ máy</span><input id="pmg-file" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden><button id="pmg-upload-button" type="button">Upload</button><small id="pmg-design-note">Chưa chọn file</small></div><div class="pmg-empty">Có thể chọn nhiều design. Bấm Chạy để thêm vào Queue và xử lý.</div></section><section class="pmg-page active" data-page="jobs"><div class="pmg-queue-head"><span>Tick các job cần chạy</span><button id="pmg-refresh-queue">↻</button></div><div class="pmg-queue-filters"><button class="active" data-filter="pending">Pending <b id="pmg-count-pending">0</b></button><button data-filter="failed">Failed <b id="pmg-count-failed">0</b></button><button data-filter="done">Done <b id="pmg-count-done">0</b></button><button data-filter="all">All <b id="pmg-count-all">0</b></button></div><div id="pmg-queue-list"></div></section><section class="pmg-page" data-page="history"><div class="pmg-empty">Job hoàn tất sẽ được lưu về kho Podhub.</div></section></main><div class="pmg-log"><b>LOG</b><div>Mockup GPTs sẵn sàng.</div></div>`;
    document.body.appendChild(root);
    const launcher=document.createElement('button');launcher.id='pmg-launcher';launcher.textContent='M';launcher.title='Podhub Mockup GPTs';document.body.appendChild(launcher);
    const setActive=active=>{document.documentElement.setAttribute('data-podhub-active-panel',active?'mockup':'');document.dispatchEvent(new Event('podhub-panel-switch'))};
    const syncPanel=()=>{const active=document.documentElement.getAttribute('data-podhub-active-panel');root.style.display=active==='mockup'?'flex':'none';launcher.classList.toggle('active',active==='mockup');if(active==='mockup')loadConfig().catch(()=>{})};
    launcher.onclick=()=>setActive(document.documentElement.getAttribute('data-podhub-active-panel')!=='mockup');document.addEventListener('podhub-panel-switch',syncPanel);root.querySelector('#pmg-close').onclick=()=>setActive(false);syncPanel();
    root.querySelector('#pmg-settings').onclick=()=>root.querySelector('#pmg-config').classList.toggle('hidden');
    root.querySelector('#pmg-sync').onclick=()=>loadConfig().then(()=>status('Đã đồng bộ catalog.','ok')).catch(e=>status(friendlyError(e),'error'));
    root.querySelector('#pmg-activate').onclick=activateLicense;
    root.querySelector('#pmg-config').addEventListener('change',schedulePreferencesSave);
    root.querySelectorAll('.pmg-tabs button').forEach(button=>button.onclick=()=>{root.querySelectorAll('.pmg-tabs button,.pmg-page').forEach(x=>x.classList.remove('active'));button.classList.add('active');root.querySelector(`.pmg-page[data-page="${button.dataset.page}"]`)?.classList.add('active')});
    root.querySelector('#pmg-run-toggle').onclick=toggleRunPause;
    root.querySelector('#pmg-stop').onclick=stopCurrentRun;
    root.querySelector('#pmg-refresh-queue').onclick=()=>reloadQueueJobs().catch(error=>status(friendlyError(error),'error'));
    root.querySelectorAll('.pmg-queue-filters button').forEach(button=>button.onclick=()=>{queueFilter=button.dataset.filter;renderQueueJobs()});
    root.querySelector('#pmg-upload-button').onclick=()=>root.querySelector('#pmg-file').click();
    root.querySelector('#pmg-file').onchange = event => {
      const files=[...(event.target.files||[])];
      root.querySelector('#pmg-design-note').textContent = files.length===1?`${files[0].name} · ${(files[0].size/1024/1024).toFixed(1)} MB`:files.length?`${files.length} design đã chọn`:'Chưa chọn file';
    };
    renderLicenseState();loadConfig().then(() => status('Cấu hình đã sẵn sàng.', 'ok')).catch(error => {renderLicenseState();status(friendlyError(error), 'error')});
    bindProductCards();setInterval(()=>{if(root.style.display!=='none')loadConfig().catch(()=>renderLicenseState())},15000);restoreJob();reloadQueueJobs().catch(()=>{});setInterval(()=>reloadQueueJobs().catch(()=>{}),8000);setTimeout(()=>resumeBatchRunner().catch(error=>status(friendlyError(error),'error')),1800);
  }

  async function activateLicense(){
    try{const key=document.querySelector('#pmg-license')?.value.trim();if(!key)throw new Error('Vui lòng nhập License Key.');const saved=await storageGet(['pmg_installation_id']);const installationId=saved.pmg_installation_id||crypto.randomUUID();const result=await api({path:'/api/extension/activate',method:'POST',body:{license_key:key,installation_id:installationId,module_id:MODULE_ID,device_name:navigator.platform||'Chrome',extension_version:chrome.runtime.getManifest().version}});if(result.module_id&&result.module_id!==MODULE_ID)throw new Error(`License thuộc module ${result.module_id}, không phải Mockup GPTs.`);const token=result.token||result.access_token;if(!token)throw new Error('Kích hoạt không trả về phiên đăng nhập.');await storageSet({pmg_installation_id:installationId,pmg_license_token:token,pmg_license_user:result.user||null,pmg_session_refreshed_at:Date.now()});await renderLicenseState();await loadConfig();status('Đã kích hoạt License Key.','ok')}catch(error){await renderLicenseState();status(friendlyError(error),'error')}
  }

  async function importPendingAsset(){
    const result=await chrome.runtime.sendMessage({type:'PMG_GET_PENDING_ASSET'});
    if(!result?.ok)throw new Error(result?.error||'Không tải được Raw Design từ Podhub.');
    const asset=result.data;if(!asset?.data_url)return false;
    const blob=await(await fetch(asset.data_url)).blob();
    const file=new File([blob],asset.name||'raw-design.png',{type:asset.type||blob.type||'image/png'});
    const transfer=new DataTransfer();transfer.items.add(file);
    const input=document.querySelector('#pmg-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    document.documentElement.setAttribute('data-podhub-active-panel','mockup');document.dispatchEvent(new Event('podhub-panel-switch'));
    status(`Đã nhận ${file.name} từ Podhub Library. Chọn cấu hình rồi bấm Chạy.`,'ok');
    return true;
  }

  function selectedOptions() {
    return readUiPreferences();
  }

  const queueGroup=job=>job.status==='done'?'done':['failed','cancelled'].includes(job.status)?'failed':'pending';
  function appendLog(text){const box=document.querySelector('.pmg-log div');if(box){box.textContent=`[${new Date().toLocaleTimeString('vi-VN')}] ${text}\n${box.textContent}`.slice(0,5000)}}

  async function reloadQueueJobs(){
    queueJobs=await api({path:'/api/extension/mockup-jobs'});
    if(!Array.isArray(queueJobs))queueJobs=[];
    const ids=new Set(queueJobs.map(job=>job.id));selectedQueueJobs=new Set([...selectedQueueJobs].filter(id=>ids.has(id)));
    renderQueueJobs();return queueJobs;
  }

  function renderQueueJobs(){
    const root=document.querySelector('#pmg-root');if(!root)return;
    const counts={pending:0,failed:0,done:0,all:queueJobs.length};queueJobs.forEach(job=>counts[queueGroup(job)]++);
    Object.entries(counts).forEach(([key,value])=>{const el=root.querySelector(`#pmg-count-${key}`);if(el)el.textContent=value});
    root.querySelectorAll('.pmg-queue-filters button').forEach(button=>button.classList.toggle('active',button.dataset.filter===queueFilter));
    const visible=queueJobs.filter(job=>queueFilter==='all'||queueGroup(job)===queueFilter);
    const list=root.querySelector('#pmg-queue-list');
    list.innerHTML=visible.length?visible.map(job=>{
      const progress=job.progress||{};const result=job.results||{};const checked=selectedQueueJobs.has(job.id)?'checked':'';
      const details=[progress.current_product,progress.mockups_done!=null?`Mockup ${progress.mockups_done}/${progress.mockups_total||'?'}`:'',Array.isArray(result.mockups)?`${result.mockups.length} ảnh`:'' ].filter(Boolean).join(' · ');
      return `<article class="pmg-job-card" data-job-id="${safe(job.id)}"><input class="pmg-job-check" type="checkbox" ${checked}><img src="${safe(job.thumbnail_url)}" alt=""><div class="pmg-job-info"><b title="${safe(job.design_name)}">${safe(job.design_name||job.asset_id)}</b><small>${safe(details||new Date(job.created_at).toLocaleString('vi-VN'))}</small><span class="pmg-job-status ${safe(queueGroup(job))}">${safe(String(job.status||'queued').toUpperCase())}</span></div><button class="pmg-job-run" title="Chạy job">▶</button><button class="pmg-job-edit" title="Áp dụng cấu hình hiện tại">✎</button><button class="pmg-job-delete" title="Xóa job">×</button></article>`;
    }).join(''):'<div class="pmg-empty">Không có job trong nhóm này.</div>';
    list.querySelectorAll('.pmg-job-card').forEach(card=>{
      const id=card.dataset.jobId;
      const checkbox=card.querySelector('.pmg-job-check');
      checkbox.onchange=event=>{event.target.checked?selectedQueueJobs.add(id):selectedQueueJobs.delete(id);card.classList.toggle('selected',event.target.checked)};
      card.classList.toggle('selected',checkbox.checked);
      card.onclick=event=>{if(event.target.closest('button,input'))return;checkbox.checked=!checkbox.checked;checkbox.dispatchEvent(new Event('change',{bubbles:true}))};
      card.querySelector('.pmg-job-run').onclick=()=>{selectedQueueJobs=new Set([id]);runQueue()};
      card.querySelector('.pmg-job-edit').onclick=async()=>{await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(id)}`,method:'PATCH',body:{options:selectedOptions()}});status('Đã áp dụng cấu hình hiện tại cho job.','ok');reloadQueueJobs()};
      card.querySelector('.pmg-job-delete').onclick=async()=>{if(!confirm('Xóa job này khỏi queue?'))return;await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(id)}`,method:'DELETE'});selectedQueueJobs.delete(id);reloadQueueJobs()};
    });
    updateRunToggle();
  }

  function updateRunToggle(){
    const button=document.querySelector('#pmg-run-toggle');if(!button)return;
    const running=queueRunning||workflowRunning;
    button.classList.toggle('paused',queuePaused);
    button.textContent=queuePaused?'▶ Tiếp tục':(running?'⏸ Tạm dừng':'▶ Chạy');
    const stop=document.querySelector('#pmg-stop');if(stop)stop.hidden=!running;
  }

  function assertNotStopped(){if(stopRequested)throw new Error('WORKFLOW_STOPPED')}

  async function stopCurrentRun(){
    if(!(queueRunning||workflowRunning))return;
    stopRequested=true;queuePaused=false;
    findStopButton()?.click();
    const rawBatch=sessionStorage.getItem(BATCH_KEY);let batchJobId='';
    if(rawBatch){try{const state=JSON.parse(rawBatch);batchJobId=String(state.queue?.[state.idx]||'')}catch{}}
    sessionStorage.removeItem(BATCH_KEY);
    if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null}
    const stoppedJob=activeJob;
    if(stoppedJob){
      stoppedJob.status='cancelled';stoppedJob.cancelled_at=new Date().toISOString();
      await saveJob().catch(()=>{});
    }
    const serverJobId=String(stoppedJob?.job_id||batchJobId||'');
    if(serverJobId)await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(serverJobId)}/status`,method:'POST',body:{status:'cancelled',error:'Stopped by user',progress:{phase:'cancelled',current_product:stoppedJob?.current_product||null}}}).catch(()=>{});
    await chrome.storage.local.remove(JOB_KEY).catch(()=>{});
    queueRunning=false;selectedQueueJobs.clear();
    await reloadQueueJobs().catch(()=>{});renderQueueJobs();updateRunToggle();
    status('Đã Stop và hủy hẳn job đang chạy.','ok');appendLog('Đã Stop job theo yêu cầu người dùng');
  }

  function setBatchPaused(paused){
    queuePaused=paused;
    const raw=sessionStorage.getItem(BATCH_KEY);
    if(raw){try{const state=JSON.parse(raw);state.paused=paused;sessionStorage.setItem(BATCH_KEY,JSON.stringify(state))}catch{}}
    updateRunToggle();
  }

  async function pauseCheckpoint(){
    assertNotStopped();
    while(queuePaused){updateRunToggle();await sleep(400);assertNotStopped()}
  }

  async function toggleRunPause(){
    if(queueRunning||workflowRunning){
      const wasPaused=queuePaused;
      setBatchPaused(!queuePaused);
      status(queuePaused?'Đang tạm dừng sau bước hiện tại.':'Đã tiếp tục xử lý.','ok');
      if(wasPaused&&!workflowRunning)return resumeBatchRunner();
      return;
    }
    const raw=sessionStorage.getItem(BATCH_KEY);
    if(raw){try{const state=JSON.parse(raw);if(state.paused){state.paused=false;sessionStorage.setItem(BATCH_KEY,JSON.stringify(state));queuePaused=false;return resumeBatchRunner()}}catch{}}
    const files=[...(document.querySelector('#pmg-file')?.files||[])];
    const manualPage=document.querySelector('.pmg-page[data-page="products"]')?.classList.contains('active');
    if(files.length&&manualPage)return startWorkflow();
    if(selectedQueueJobs.size||queueJobs.some(job=>job.status==='queued'))return runQueue();
    if(activeJob&&!['done','cancelled'].includes(activeJob.status))return resumeWorkflow();
    if(files.length)return startWorkflow();
    status('Tick ít nhất một job trong Queue hoặc Upload thủ công một design.','error');
  }

  async function fetchQueueFile(job){
    const result=await chrome.runtime.sendMessage({type:'PMG_FETCH_ASSET',asset:{id:job.asset_id,name:job.design_name,url:job.thumbnail_url}});
    if(!result?.ok)throw new Error(result?.error||'Không tải được Raw Design.');
    const asset=result.data;const blob=await(await fetch(asset.data_url)).blob();
    const extension=(asset.name||job.design_name||'').match(/\.(png|jpe?g|webp)$/i)?.[0]?.toLowerCase()||'.png';
    const title=String(job.design_name||asset.name||'Podhub Design').replace(/\.[^.]+$/,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,54)||'Podhub-Design';
    const shortCode=String(job.asset_id||job.id||'design').replace(/[^a-z0-9]/gi,'').slice(0,6).toUpperCase();
    return new File([blob],`${title}_PH${shortCode}${extension}`,{type:asset.type||blob.type||'image/png'});
  }

  async function runQueue(){
    if(queueRunning)return;
    stopRequested=false;queuePaused=false;updateRunToggle();
    await loadConfig();await reloadQueueJobs();
    let jobs=queueJobs.filter(job=>selectedQueueJobs.has(job.id)&&['queued','failed'].includes(job.status));
    if(!jobs.length)jobs=queueJobs.filter(job=>job.status==='queued').reverse();
    if(!jobs.length)return status('Không có job Pending để chạy.','error');
    const defaults={...selectedOptions(),auto_run:true};
    if(!defaults.products.length)return status('Chọn ít nhất một sản phẩm trong Cấu hình.','error');
    const snapshots={};
    for(const job of jobs){
      const saved={...defaults,products:[...defaults.products],marketplaces:[...defaults.marketplaces]};
      const updated=await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(job.id)}`,method:'PATCH',body:{options:saved}});
      snapshots[job.id]={...job,...updated,options:saved};
    }
    sessionStorage.setItem(BATCH_KEY,JSON.stringify({running:true,paused:false,queue:jobs.map(job=>job.id),idx:0,jobs:snapshots}));
    queueRunning=true;renderQueueJobs();updateRunToggle();appendLog(`Bắt đầu batch ${jobs.length} job`);
    await navigateToFreshGpt();
  }

  async function startWorkflow() {
    try {
      const files=[...(document.querySelector('#pmg-file')?.files||[])];
      if (!files.length) throw new Error('Vui lòng Upload thủ công ít nhất một file design.');
      const options = selectedOptions();
      if (!options.products.length) throw new Error('Vui lòng chọn ít nhất một sản phẩm.');
      const created=[];
      for(const file of files){
        status(`Đang thêm ${created.length+1}/${files.length} design vào Queue…`,'ok');
        const result=await chrome.runtime.sendMessage({type:'PMG_CREATE_MANUAL_JOB',filename:file.name,data_url:await blobToDataUrl(file)});
        if(!result?.ok)throw new Error(result?.error||'MANUAL_JOB_CREATE_FAILED');
        const job=result.data;await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(job.id)}`,method:'PATCH',body:{options:{...options,auto_run:true}}});created.push(job.id);
      }
      selectedQueueJobs=new Set(created);queueFilter='pending';document.querySelector('.pmg-tabs button[data-page="jobs"]')?.click();
      const input=document.querySelector('#pmg-file');if(input)input.value='';const note=document.querySelector('#pmg-design-note');if(note)note.textContent='Chưa chọn file';
      await reloadQueueJobs();return runQueue();
    } catch (error) { status(friendlyError(error), 'error'); }
  }

  async function beginWorkflow(file,serverJob,options) {
      const designId = serverJob?.asset_id||'des_local_' + Date.now().toString(36);
      const previousResults=serverJob?.results&&typeof serverJob.results==='object'?serverJob.results:{};
      activeJob = {
        schema_version:'podhub_mockup_job_v2',
        job_id:serverJob?.id||'mjob_' + crypto.randomUUID(),
        task_id:'mtask_' + crypto.randomUUID(),
        design_id:designId,
        asset_id:serverJob?.asset_id||null,
        design_name:serverJob?.design_name||file.name,
        design_file:{name:file.name, type:file.type, size:file.size},
        options,
        status:'draft',
        created_at:new Date().toISOString(),
        chat_url:location.href,
        captured_images:sanitizeMockups(previousResults.mockups,options),
        listing_results:Array.isArray(previousResults.listings)?previousResults.listings:[],
        product_batches:options.products.map(productId=>({product_id:productId,status:'pending'}))
      };
      await saveJob();
      status('Đã lưu draft. Đang kiểm tra license và cấu hình…', '', 3);
      await loadConfig();
      await attachDesignFile(file);
      activeJob.wait_previous_text=getLatestAssistantText();
      const sent = await sendPrompt(buildPlanningPrompt(activeJob));
      if (!sent) throw new Error('Không tìm thấy ô nhập ChatGPT. Hãy mở đúng trang Custom GPT.');
      activeJob.status = 'planning';
      await saveJob();
      if(serverJob)await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(serverJob.id)}/status`,method:'POST',body:{status:'processing',progress:{phase:'planning',mockups_done:0,mockups_total:options.products.length*options.mockup_count}}});
      status('Đã gửi yêu cầu lập kế hoạch. Đang chờ GPT…', 'ok', 8);
      await runActiveWorkflow();
  }

  function buildPlanningPrompt(job) {
    const products=job.options.products.join(', ');
    const marketText=job.options.marketplaces.length?`tối ưu bộ ảnh cho ${job.options.marketplaces.join(' và ')}`:'không theo sàn cụ thể';
    return `Phân tích artwork đính kèm và lập kế hoạch ${job.options.mockup_count} mockup cho ${products}, ${marketText}, tỷ lệ ${job.options.aspect_ratio}. Trả về ${job.options.mockup_count} prompt mockup cho mỗi sản phẩm, chưa tạo ảnh và chưa tạo listing.`;
  }

  async function attachDesignFile(file) {
    let input=null;const end=Date.now()+20000;
    while(Date.now()<end&&!input){input=[...document.querySelectorAll('input[type="file"]')].find(x=>!x.closest('#pmg-root'));if(!input)await new Promise(resolve=>setTimeout(resolve,400));}
    if (!input) throw new Error('CHATGPT_FILE_INPUT_NOT_FOUND');
    const transfer = new DataTransfer();
    const extensionByType={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
    const uploadFile=new File([file],`approved-artwork.${extensionByType[file.type]||'png'}`,{type:file.type||'image/png',lastModified:file.lastModified||Date.now()});
    transfer.items.add(uploadFile);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
    await new Promise(resolve => setTimeout(resolve, 1600));
    return true;
  }

  function composer() {
    return document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]') || document.querySelector('textarea');
  }

  async function sendPrompt(text) {
    assertNotStopped();
    const box = composer();
    if (!box) return false;
    box.focus();
    if (box.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter ? setter.call(box, text) : (box.value = text);
      box.dispatchEvent(new Event('input', {bubbles:true}));
    } else {
      box.textContent = text;
      box.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    const send = document.querySelector('[data-testid="send-button"]') || document.querySelector('button[aria-label*="Send"]') || document.querySelector('button[aria-label*="Gửi"]');
    if (send && !send.disabled) send.click();
    else box.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true}));
    return true;
  }

  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

  function assistantTurns(){
    const nodes=[...document.querySelectorAll('[data-message-author-role="assistant"],[data-turn="assistant"]')];
    return [...new Set(nodes)];
  }

  function getLatestAssistantText(){
    const turns=assistantTurns();
    const turn=turns[turns.length-1];
    return String(turn?.innerText||turn?.textContent||'').trim();
  }

  function detectImageRenderFailure(text){
    const value=String(text||'');
    if(/\/mnt\/data\/[^\s)\]]+\.(?:png|jpe?g|webp)/i.test(value))return 'GPT_IMAGE_FILE_PATH';
    if(/PODHUB_IMAGE_TOOL_UNAVAILABLE/i.test(value))return 'GPT_IMAGE_TOOL_UNAVAILABLE';
    if(/cannot\s+(?:read|access|open)\s+(?:the\s+)?file|unable\s+to\s+(?:read|access|open)\s+(?:the\s+)?file|kh[oô]ng\s+(?:đọc|truy cập|mở)\s+được\s+(?:file|tệp)/i.test(value))return 'GPT_ARTWORK_READ_FAILED';
    return '';
  }

  function findStopButton(){
    return document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop"],button[aria-label*="Dừng"]');
  }

  function isGptImageUrl(url){
    return /^https?:/i.test(String(url||''))&&/backend-api\/(estuary\/content|files)|oaiusercontent\.com|dalleprodsec|sdmnt|openai\.com.*\/files/i.test(url);
  }

  function getAssistantImageUrls(){
    const urls=[];
    for(const turn of assistantTurns())for(const img of turn.querySelectorAll('img')){
      const url=img.currentSrc||img.src||img.getAttribute('src')||'';
      if(isGptImageUrl(url))urls.push(url);
    }
    return [...new Set(urls)];
  }

  function balancedJsonValues(text){
    const source=String(text||'');const values=[];
    for(let start=0;start<source.length;start++){
      if(source[start]!=='{'&&source[start]!=='[')continue;
      const stack=[];let quoted=false;let escaped=false;
      for(let i=start;i<source.length;i++){
        const char=source[i];
        if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
        if(char==='"'){quoted=true;continue;}
        if(char==='{'||char==='[')stack.push(char);
        else if(char==='}'||char===']'){
          const open=stack.pop();if((open==='{'&&char!=='}')||(open==='['&&char!==']'))break;
          if(!stack.length){try{values.push(JSON.parse(source.slice(start,i+1)));start=i;}catch{}break;}
        }
      }
    }
    return values;
  }

  async function waitForAssistantText(previousText='',maxWaitMs=MAX_WAIT_TEXT_MS){
    const end=Date.now()+maxWaitMs;let last='';let changedAt=Date.now();
    await sleep(1200);
    while(Date.now()<end){
      assertNotStopped();
      const current=getLatestAssistantText();
      if(current!==last){last=current;changedAt=Date.now();}
      if(current&&current!==previousText&&!findStopButton()&&Date.now()-changedAt>=2500)return current;
      await sleep(700);
    }
    throw new Error('GPT_TEXT_TIMEOUT');
  }

  async function waitForNewImage(before,maxWaitMs=MAX_WAIT_IMAGE_MS){
    const end=Date.now()+maxWaitMs;let candidate='';let changedAt=Date.now();
    const beforeUrls=before?.urls instanceof Set?before.urls:before;
    const beforeTurnCount=Number(before?.turnCount||0);
    await sleep(700);
    while(Date.now()<end){
      assertNotStopped();
      const fresh=getAssistantImageUrls().filter(url=>!beforeUrls.has(url));
      let latest=fresh[fresh.length-1]||'';
      if(!latest&&!findStopButton()&&assistantTurns().length>beforeTurnCount){
        const turn=assistantTurns().at(-1);const images=[...(turn?.querySelectorAll('img')||[])].map(img=>img.currentSrc||img.src||'').filter(isGptImageUrl);
        latest=images.at(-1)||'';
      }
      if(latest!==candidate){candidate=latest;changedAt=Date.now();}
      if(candidate&&!findStopButton()&&Date.now()-changedAt>=2200)return candidate;
      const renderFailure=detectImageRenderFailure(getLatestAssistantText());if(renderFailure&&!fresh.length&&!findStopButton())throw new Error(renderFailure);
      await sleep(800);
    }
    throw new Error('GPT_IMAGE_TIMEOUT');
  }

  function findPlan(values){
    const flat=values.flatMap(value=>Array.isArray(value)?value:[value]);
    return flat.find(value=>value&&typeof value==='object'&&value.schema_version==='podhub_mockup_prompts_v1');
  }

  function sanitizeMockups(items,options=activeJob?.options||{}){
    const products=new Set(Array.isArray(options.products)?options.products.map(String):[]);const limit=Math.max(1,Number(options.mockup_count)||1);
    const usedSlots=new Set();const usedAssets=new Set();const usedHashes=new Set();const clean=[];
    for(const source of Array.isArray(items)?items:[]){
      const item={...source,product_id:String(source.product_id||''),mockup_no:Number(source.mockup_no)};
      const slot=`${item.product_id}:${item.mockup_no}`;const asset=String(item.asset_id||'');const hash=String(item.content_sha256||'');
      if((products.size&&!products.has(item.product_id))||!Number.isInteger(item.mockup_no)||item.mockup_no<1||item.mockup_no>limit||usedSlots.has(slot)||!asset||usedAssets.has(asset)||(hash&&usedHashes.has(hash)))continue;
      usedSlots.add(slot);usedAssets.add(asset);if(hash)usedHashes.add(hash);clean.push(item);
    }
    return clean.sort((a,b)=>String(a.product_id).localeCompare(String(b.product_id))||a.mockup_no-b.mockup_no);
  }

  function planProblem(plan){
    if(!plan||typeof plan!=='object')return 'PLAN_MISSING';
    if(plan.schema_version!=='podhub_mockup_prompts_v1')return 'SCHEMA_VERSION_INVALID';
    if(!Array.isArray(plan.products)||plan.products.length!==activeJob.options.products.length)return 'PRODUCTS_INVALID';
    for(let index=0;index<activeJob.options.products.length;index++){
      const productId=activeJob.options.products[index];const product=plan.products[index];if(String(product?.product_id||'')!==String(productId))return `PRODUCT_INVALID:${productId}`;
      const prompts=product.mockup_prompts;if(!Array.isArray(prompts)||prompts.length!==activeJob.options.mockup_count)return `PROMPT_COUNT_INVALID:${productId}`;
      const numbers=new Set();for(const item of prompts){const number=Number(item?.mockup_no);if(!Number.isInteger(number)||number<1||number>activeJob.options.mockup_count||numbers.has(number)||String(item?.prompt||'').trim().length<20)return `PROMPT_INVALID:${productId}`;numbers.add(number)}
    }
    return '';
  }

  function buildPlanRepairPrompt(problem){
    return `Phần Mockup prompts chưa đúng (${problem}). Hãy trả lại riêng mục ## Mockup prompts với đúng một fenced JSON block schema podhub_mockup_prompts_v1 cho các sản phẩm ${activeJob.options.products.join(', ')}, mỗi sản phẩm có đúng ${activeJob.options.mockup_count} prompt đánh số từ 1 đến ${activeJob.options.mockup_count}. Chưa tạo ảnh.`;
  }

  function plannedMockup(productId,mockupNo){
    const product=activeJob.plan?.products?.find(item=>String(item?.product_id||'')===String(productId));
    return product?.mockup_prompts?.find(item=>Number(item?.mockup_no)===Number(mockupNo))||null;
  }

  function collectListings(values){
    const found=[];const visit=(value,context={})=>{
      if(Array.isArray(value))return value.forEach(item=>visit(item,context));
      if(!value||typeof value!=='object')return;
      const next={...context,...(['job_id','task_id','design_id','product_id'].reduce((out,key)=>(value[key]!==undefined&&(out[key]=value[key]),out),{}))};
      if(value.marketplace)found.push({...next,...value,marketplace:String(value.marketplace).toLowerCase()});
      for(const [key,child] of Object.entries(value))if(['listings','results','items','data'].includes(key))visit(child,next);
    };values.forEach(value=>visit(value));return found;
  }

  const MARKETPLACE_PAYLOAD_KEYS={
    etsy:['listing_type','title','description','seo','category_hint','attributes','personalization','image_alt_texts','compliance','data_warnings'],
    walmart:['spec_context','title','short_title','description','shelf_description','key_features','primary_keyword','backend_search_terms','target_audience','theme_tags','occasion_tags','gift_recipient','product_type','walmart_category_hint','data_warnings'],
    shopify:['title','description_html','seo','features','materials','product_details','product_type_hint','collection_hints','image_alt_texts','data_warnings']
  };

  function listingProblem(item,productId,marketplace){
    if(!item||typeof item!=='object')return 'ITEM_MISSING';
    if(String(item.product_id||'')!==String(productId))return 'PRODUCT_ID_MISMATCH';
    if(String(item.marketplace||'').toLowerCase()!==String(marketplace).toLowerCase())return 'MARKETPLACE_MISMATCH';
    const payload=item.marketplace_payload;
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||!Object.keys(payload).length)return 'MARKETPLACE_PAYLOAD_MISSING';
    const missing=(MARKETPLACE_PAYLOAD_KEYS[marketplace]||[]).filter(key=>!Object.prototype.hasOwnProperty.call(payload,key));
    if(missing.length)return `MARKETPLACE_PAYLOAD_FIELDS_MISSING:${missing.join('|')}`;
    if(!String(item.title||'').trim()||!String(item.description||'').trim())return 'LISTING_CONTENT_MISSING';
    if(String(payload.title||'')!==String(item.title||''))return 'PAYLOAD_TITLE_MISMATCH';
    const payloadDescription=marketplace==='shopify'?payload.description_html:payload.description;
    if(String(payloadDescription||'')!==String(item.description||''))return 'PAYLOAD_DESCRIPTION_MISMATCH';
    if(!Array.isArray(item.mockup_numbers)||!item.mockup_numbers.length)return 'MOCKUP_NUMBERS_MISSING';
    const expectedMockups=productMockups(productId).map(mockup=>Number(mockup.mockup_no)).sort((a,b)=>a-b);
    const actualMockups=item.mockup_numbers.map(Number).sort((a,b)=>a-b);
    if(expectedMockups.length!==actualMockups.length||expectedMockups.some((number,index)=>number!==actualMockups[index]))return 'MOCKUP_NUMBERS_MISMATCH';
    if(marketplace==='etsy'){
      if(String(item.title).length>140)return 'ETSY_TITLE_LENGTH_INVALID';
      if(!Array.isArray(item.tags)||item.tags.length!==13)return 'ETSY_TAG_COUNT_INVALID';
      if(item.tags.some(tag=>!String(tag||'').trim()||String(tag).length>20))return 'ETSY_TAG_LENGTH_INVALID';
    }
    return '';
  }

  function productMockups(productId){return sanitizeMockups(activeJob.captured_images,activeJob.options).filter(item=>item.product_id===productId&&item.upload_status!=='pending_backend')}
  function productListings(productId){return activeJob.listing_results.filter(item=>item.product_id===productId&&item.upload_status!=='pending_backend')}
  function totalExpectedMockups(){return activeJob.options.products.length*activeJob.options.mockup_count}
  function totalExpectedListings(){return activeJob.options.products.length*activeJob.options.marketplaces.length}

  async function runActiveWorkflow(){
    if(workflowRunning)return;workflowRunning=true;updateRunToggle();
    try{
      if(!activeJob.plan){
        let response=await waitForAssistantText(activeJob.wait_previous_text||'');
        let plan=findPlan(balancedJsonValues(response));
        if(!plan||planProblem(plan)){
          const previous=getLatestAssistantText();
          await sendPrompt(buildPlanRepairPrompt(planProblem(plan)));
          response=await waitForAssistantText(previous);
          plan=findPlan(balancedJsonValues(response));
        }
        const problem=planProblem(plan);if(problem)throw new Error(`MOCKUP_PLAN_INVALID:${problem}`);
        activeJob.plan=plan;activeJob.status='plan_ready';await saveJob();
      }else{
        const problem=planProblem(activeJob.plan);
        if(problem){
          const previous=getLatestAssistantText();await sendPrompt(buildPlanRepairPrompt(problem));
          const repaired=findPlan(balancedJsonValues(await waitForAssistantText(previous)));const repairedProblem=planProblem(repaired);if(repairedProblem)throw new Error(`MOCKUP_PLAN_INVALID:${repairedProblem}`);activeJob.plan=repaired;await saveJob();
        }
      }
      for(const batch of activeJob.product_batches){
        await pauseCheckpoint();
        await runProductBatch(batch);
      }
      await pauseCheckpoint();
      await finishJob();
    }finally{workflowRunning=false;updateRunToggle();}
  }

  async function runProductBatch(batch){
    await pauseCheckpoint();
    const productId=batch.product_id;batch.status='mockups';activeJob.current_product=productId;await saveJob();
    while(true){
      while(productMockups(productId).length<activeJob.options.mockup_count){
      await pauseCheckpoint();
      const completed=new Set(productMockups(productId).map(item=>Number(item.mockup_no)));const mockupNo=Array.from({length:activeJob.options.mockup_count},(_,index)=>index+1).find(number=>!completed.has(number));
      const planned=plannedMockup(productId,mockupNo);if(!planned)throw new Error(`MOCKUP_PROMPT_MISSING:${productId}:${mockupNo}`);
      const imagePrompt=String(planned.prompt||'').trim();
      let saved=false;
      for(let attempt=1;attempt<=3&&!saved;attempt++){
        const before={urls:new Set(getAssistantImageUrls()),turnCount:assistantTurns().length};
        activeJob.status='generating_mockup';activeJob.current_mockup={product_id:productId,mockup_no:mockupNo};await saveJob();
        await sendPrompt(imagePrompt);
        status(`Đang tạo ${productId} · ${mockupNo}/${activeJob.options.mockup_count}…`,'ok',20+Math.round(activeJob.captured_images.length/Math.max(1,totalExpectedMockups())*60));
        let url;
        try{url=await waitForNewImage(before)}catch(error){if(!/^GPT_(?:IMAGE_FILE_PATH|ARTWORK_READ_FAILED)$/.test(String(error.message||''))||attempt===3)throw error;continue}
        assertNotStopped();
        try{await captureImageUrl(url,{product_id:productId,mockup_no:mockupNo});saved=true;}catch(error){if(!/DUPLICATE/i.test(String(error.message||''))||attempt===3)throw error;}
      }
      }
      const validation=await syncProductValidation(productId);if(validation.complete)break;
      if(productMockups(productId).length>=activeJob.options.mockup_count)throw new Error(`MOCKUP_PRODUCT_INVALID:${productId}`);
    }
    await pauseCheckpoint();
    batch.status='listings';await saveJob();
    if(activeJob.options.marketplaces.length)await requestProductListings(productId);
    batch.status='done';batch.completed_at=new Date().toISOString();await saveJob();
    await updateServerProgress('product_done',productId);
  }

  async function syncProductValidation(productId){
    if(!activeJob.asset_id)return {complete:productMockups(productId).length===activeJob.options.mockup_count};
    const validation=await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(activeJob.job_id)}/products/${encodeURIComponent(productId)}/validation`});
    const other=activeJob.captured_images.filter(item=>String(item.product_id||'')!==String(productId));activeJob.captured_images=sanitizeMockups([...other,...(validation.valid_mockups||[])],activeJob.options);await saveJob();return validation;
  }

  async function blobToDataUrl(blob){
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob)});
  }

  async function captureImageUrl(url,spec){
    assertNotStopped();
    const response=await fetch(url,{credentials:'include'});if(!response.ok)throw new Error(`GPT_IMAGE_HTTP_${response.status}`);
    const blob=await response.blob();const bytes=await blob.arrayBuffer();
    assertNotStopped();
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    if(activeJob.captured_images.some(item=>item.content_sha256===hash))throw new Error('DUPLICATE_MOCKUP_IMAGE');
    const designStem=String(activeJob.design_file?.name||activeJob.design_name||'Podhub-Design').replace(/\.[^.]+$/,'');
    const item={schema_version:'podhub_mockup_asset_v2',job_id:activeJob.job_id,task_id:activeJob.task_id,design_id:activeJob.design_id,product_id:spec.product_id,mockup_no:spec.mockup_no,image_url:url,content_sha256:hash,filename:`${slug(designStem)}__${slug(spec.product_id)}__mockup_${String(spec.mockup_no).padStart(2,'0')}.png`,captured_at:new Date().toISOString()};
    const dataUrl=await blobToDataUrl(blob);
    const uploaded=await chrome.runtime.sendMessage({type:'PMG_UPLOAD_MOCKUP',job_id:activeJob.job_id,product_id:item.product_id,mockup_no:item.mockup_no,filename:item.filename,data_url:dataUrl});
    assertNotStopped();
    if(!uploaded?.ok){downloadBackup(dataUrl,item.filename);throw new Error(uploaded?.error||'MOCKUP_UPLOAD_FAILED');}
    item.asset_id=uploaded.data?.asset_id||null;item.cdn_url=uploaded.data?.url||null;item.content_sha256=uploaded.data?.content_sha256||item.content_sha256;item.upload_status='saved';
    if(item.asset_id&&activeJob.captured_images.some(existing=>existing.asset_id===item.asset_id&&!(existing.product_id===item.product_id&&Number(existing.mockup_no)===item.mockup_no)))throw new Error('DUPLICATE_MOCKUP_IMAGE');
    activeJob.captured_images=activeJob.captured_images.filter(existing=>!(existing.product_id===item.product_id&&Number(existing.mockup_no)===item.mockup_no));
    activeJob.captured_images.push(item);activeJob.current_mockup=null;activeJob.status='mockup_captured';await saveJob();
    await updateServerProgress('mockups',item.product_id);
  }

  function downloadBackup(dataUrl, filename) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function requestProductListings(productId){
    const wanted=activeJob.options.marketplaces.filter(marketplace=>!productListings(productId).some(item=>item.marketplace===marketplace));
    if(!wanted.length)return;
    activeJob.status='generating_listing';await saveJob();
    let previous=getLatestAssistantText();
    const marketplaceText=wanted.join(' và ');
    await sendPrompt(`Tạo listing SEO đầy đủ cho ${productId} trên ${marketplaceText}, sử dụng toàn bộ ${activeJob.options.mockup_count} mockup vừa hoàn thành.`);
    let text=await waitForAssistantText(previous);let candidates=collectListings(balancedJsonValues(text));
    let problems=Object.fromEntries(wanted.map(marketplace=>{const item=candidates.find(row=>row.product_id===productId&&row.marketplace===marketplace);return[marketplace,listingProblem(item,productId,marketplace)]}));
    let missing=wanted.filter(marketplace=>problems[marketplace]);
    if(missing.length){
      previous=getLatestAssistantText();
      await sendPrompt(`Listing cho ${productId} chưa đủ hoặc sai contract (${missing.map(marketplace=>`${marketplace}:${problems[marketplace]}`).join(', ')}). Hãy tạo lại listing SEO đầy đủ trên ${marketplaceText}, dùng toàn bộ ${activeJob.options.mockup_count} mockup vừa hoàn thành và áp dụng đúng Knowledge contract.`);
      text=await waitForAssistantText(previous);candidates=collectListings(balancedJsonValues(text));
      problems=Object.fromEntries(wanted.map(marketplace=>{const item=candidates.find(row=>row.product_id===productId&&row.marketplace===marketplace);return[marketplace,listingProblem(item,productId,marketplace)]}));
      missing=wanted.filter(marketplace=>problems[marketplace]);
    }
    if(missing.length)throw new Error(`LISTING_JSON_INVALID:${productId}:${missing.map(marketplace=>`${marketplace}:${problems[marketplace]}`).join(',')}`);
    for(const listing of candidates.filter(item=>item.product_id===productId&&wanted.includes(item.marketplace)&&!listingProblem(item,productId,item.marketplace)))await captureListing(listing);
  }

  async function captureListing(listing) {
    listing={...listing,marketplace:String(listing.marketplace||'').toLowerCase(),schema_version:listing.schema_version||'podhub_product_listing_v2',job_id:activeJob.job_id,task_id:activeJob.task_id,design_id:activeJob.design_id};
    const problem=listingProblem(listing,listing.product_id,listing.marketplace);if(problem)throw new Error(`LISTING_JSON_INVALID:${listing.product_id}:${listing.marketplace}:${problem}`);
    const key = `${listing.product_id || ''}:${listing.marketplace || ''}`;
    if (activeJob.listing_results.some(x => `${x.product_id || ''}:${x.marketplace || ''}` === key)) return;
    activeJob.listing_results.push(listing);
    try {
      await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(activeJob.job_id)}/listings`, method:'POST', body:listing});
      listing.upload_status = 'saved';
    } catch (error) {
      listing.upload_status = 'pending_backend';
      listing.upload_error = error.message;
      await saveJob();
      throw error;
    }
    await saveJob();
    const expected = totalExpectedListings();
    status(`Đã nhận Listing JSON ${activeJob.listing_results.length}/${expected}.`, 'ok', 90 + Math.round(activeJob.listing_results.length/expected*10));
  }

  async function updateServerProgress(phase,currentProduct){
    if(!activeJob.asset_id)return;
    await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(activeJob.job_id)}/status`,method:'POST',body:{status:'processing',progress:{phase,current_product:currentProduct,mockups_done:activeJob.captured_images.length,mockups_total:totalExpectedMockups(),listings_done:activeJob.listing_results.length,listings_total:totalExpectedListings(),product_batches:activeJob.product_batches}}}).catch(()=>{});
  }

  async function finishJob() {
    activeJob.status = 'done';
    activeJob.completed_at = new Date().toISOString();
    await saveJob();
    if(activeJob.asset_id)await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(activeJob.job_id)}/status`,method:'POST',body:{status:'done',progress:{phase:'done',mockups_done:activeJob.captured_images.length,mockups_total:totalExpectedMockups(),listings_done:activeJob.listing_results.length,listings_total:totalExpectedListings(),product_batches:activeJob.product_batches},results:{summary:{mockups:activeJob.captured_images.length,listings:activeJob.listing_results.length,products:activeJob.product_batches.length}}}});
    status(`Hoàn tất · ${activeJob.captured_images.length} mockup · ${activeJob.listing_results.length} listing.`, 'ok', 100);
    const resolver=activeJobResolver;if(resolver?.job_id===activeJob.job_id){activeJobResolver=null;resolver.resolve(activeJob)}
  }

  async function saveJob() {
    if (!activeJob) return;
    await storageSet({[JOB_KEY]:activeJob});
  }

  async function restoreJob() {
    const saved = await storageGet(JOB_KEY);
    if (!saved[JOB_KEY]) return;
    activeJob = saved[JOB_KEY];
    if (activeJob.status !== 'done') {
      status(`Có job chưa xong: ${activeJob.design_name || activeJob.design_id}\nTrạng thái: ${activeJob.status}`, '', 10);
    }
  }

  async function resumeWorkflow() {
    if (!activeJob) return status('Không có job để tiếp tục.', 'error');
    if (activeJob.status === 'draft') {
      try {
        const file = document.querySelector('#pmg-file')?.files?.[0];
        if (!file) throw new Error('Draft đã được giữ. Hãy chọn lại Raw Design rồi bấm Tiếp tục.');
        await loadConfig();
        await attachDesignFile(file);
        activeJob.wait_previous_text=getLatestAssistantText();
        await sendPrompt(buildPlanningPrompt(activeJob));
        activeJob.status = 'planning';
        await saveJob();
        status('Đã gửi lại workflow từ draft.', 'ok', 8);
        return runActiveWorkflow();
      } catch (error) { return status(friendlyError(error), 'error'); }
    }
    if(activeJob.status==='done')return status('Job này đã hoàn tất.','ok');
    return runActiveWorkflow().catch(error=>status(friendlyError(error),'error'));
  }

  async function navigateToFreshGpt(){
    const saved=await storageGet(['pmg_gpt_url']);const url=runtimeConfig?.gpt_links?.[MODULE_ID]?.url||saved.pmg_gpt_url;
    if(!url)throw new Error('Admin chưa cấu hình link Mockup GPTs.');
    location.href=url;
  }

  async function waitPageReady(maxWaitMs=30000){
    const end=Date.now()+maxWaitMs;while(Date.now()<end){if(composer())return true;await sleep(500)}return false;
  }

  async function resumeBatchRunner(){
    const raw=sessionStorage.getItem(BATCH_KEY);if(!raw)return;
    let state;try{state=JSON.parse(raw)}catch{sessionStorage.removeItem(BATCH_KEY);return}
    if(!state.running||!Array.isArray(state.queue))return;
    queueRunning=true;queuePaused=state.paused===true;renderQueueJobs();updateRunToggle();
    if(queuePaused)return status('Queue đang tạm dừng. Bấm Tiếp tục để chạy tiếp.','ok');
    if(!await waitPageReady())return status('ChatGPT chưa sẵn sàng để chạy queue.','error');
    await loadConfig();await reloadQueueJobs();
    if(state.idx>=state.queue.length){sessionStorage.removeItem(BATCH_KEY);queueRunning=false;queuePaused=false;selectedQueueJobs.clear();renderQueueJobs();updateRunToggle();return status('Đã xử lý xong hàng đợi.','ok',100)}
    const id=state.queue[state.idx];let job=queueJobs.find(item=>item.id===id)||state.jobs?.[id];
    if(!job){state.idx++;sessionStorage.setItem(BATCH_KEY,JSON.stringify(state));return navigateToFreshGpt()}
    if(job.status==='done'){state.idx++;sessionStorage.setItem(BATCH_KEY,JSON.stringify(state));return state.idx<state.queue.length?navigateToFreshGpt():resumeBatchRunner()}
    try{
      job=await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(id)}/claim`,method:'POST',body:{}});
      job={...(state.jobs?.[id]||{}),...job,design_name:job.design_name||state.jobs?.[id]?.design_name,thumbnail_url:job.thumbnail_url||state.jobs?.[id]?.thumbnail_url};
      const options=job.options&&Array.isArray(job.options.products)&&job.options.products.length?{...job.options,auto_run:true}:{...selectedOptions(),auto_run:true};
      heartbeatTimer=setInterval(()=>api({path:`/api/extension/mockup-jobs/${encodeURIComponent(id)}/heartbeat`,method:'POST',body:{}}).catch(()=>{}),30000);
      const file=await fetchQueueFile(job);await beginWorkflow(file,job,options);appendLog(`Done ${job.design_name||id}`);
    }catch(error){
      if(String(error?.message||error)==='WORKFLOW_STOPPED')return;
      appendLog(`Failed ${job.design_name||id}: ${error.message}`);
      await api({path:`/api/extension/mockup-jobs/${encodeURIComponent(id)}/status`,method:'POST',body:{status:'failed',error:error.message,progress:{phase:'failed',current_product:activeJob?.current_product||null}}}).catch(()=>{});
    }finally{if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null}}
    state.idx++;sessionStorage.setItem(BATCH_KEY,JSON.stringify(state));
    if(state.idx<state.queue.length)return navigateToFreshGpt();
    sessionStorage.removeItem(BATCH_KEY);queueRunning=false;queuePaused=false;selectedQueueJobs.clear();await reloadQueueJobs().catch(()=>{});renderQueueJobs();updateRunToggle();status('Đã xử lý xong hàng đợi đã chọn.','ok',100);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'PMG_IMPORT_JOB') return false;
    activeJob = {...message.job, schema_version:'podhub_mockup_job_v1', chat_url:location.href};
    saveJob().then(() => {
      status(`Đã nhận design ${activeJob.design_id} từ thư viện.`, 'ok');
      sendResponse({ok:true});
    });
    return true;
  });

  const boot = setInterval(() => {
    if (!document.body) return;
    clearInterval(boot);
    injectPanel();
  }, 400);
})();
