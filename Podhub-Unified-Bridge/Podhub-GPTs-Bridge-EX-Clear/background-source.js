'use strict';

const TOOLS_ORIGIN = 'https://ex.podhub.space';
const STORAGE = {
  token: 'pub_license_token',
  user: 'pub_license_user',
  license: 'pub_license_info',
  installation: 'pub_installation_id',
  config: 'pub_runtime_config',
  activeRun: 'pub_active_run'
};

const MODULE_DEFAULTS = {
  clone: {
    id: 'clone', label: 'Clone', gpt_url: '',
    list_jobs_path: '/api/extension/clone-jobs',
    next_job_path: '/api/extension/clone-jobs/next',
    status_path_template: '/api/extension/clone-jobs/:job_id/status',
    delete_path_template: '/api/extension/clone-jobs/:job_id',
    claim_path_template: '/api/extension/clone-jobs/:job_id/claim',
    heartbeat_path_template: '/api/extension/clone-jobs/:job_id/heartbeat',
    result_kind: 'raw_clone',
    result_path_template: '/api/extension/clone-jobs/:job_id/raw-clone'
  },
  redesign: {
    id: 'redesign', label: 'Redesign', gpt_url: '',
    list_jobs_path: '/api/extension/redesign-jobs',
    next_job_path: '/api/extension/redesign-jobs/next',
    status_path_template: '/api/extension/redesign-jobs/:job_id/status',
    delete_path_template: '/api/extension/redesign-jobs/:job_id',
    claim_path_template: '/api/extension/redesign-jobs/:job_id/claim',
    heartbeat_path_template: '/api/extension/redesign-jobs/:job_id/heartbeat',
    result_kind: 'raw_redesign',
    result_path_template: '/api/extension/redesign-jobs/:job_id/raw-redesign',
    listing_path_template: '/api/extension/redesign-jobs/:job_id/listings'
  },
  mockup: {
    id: 'mockup', label: 'Mockup', gpt_url: '',
    list_jobs_path: '/api/extension/mockup-jobs',
    next_job_path: '/api/extension/mockup-jobs/next',
    status_path_template: '/api/extension/mockup-jobs/:job_id/status',
    delete_path_template: '/api/extension/mockup-jobs/:job_id',
    claim_path_template: '/api/extension/mockup-jobs/:job_id/claim',
    heartbeat_path_template: '/api/extension/mockup-jobs/:job_id/heartbeat',
    result_kind: 'mockup',
    result_path_template: '/api/extension/mockup-jobs/:job_id/mockups',
    listing_path_template: '/api/extension/mockup-jobs/:job_id/listings'
  }
};
const MODULE_ALIASES = {
  'clone-gpts': 'clone',
  'mockup-gpts': 'mockup',
  'mockup-pro': 'mockup',
  'design-multiplier-gpts': 'redesign',
  'redesign-multiplier': 'redesign',
  'podhub-gpt-bridge': 'redesign'
};

const storageGet = keys => chrome.storage.local.get(keys);
const storageSet = value => chrome.storage.local.set(value);
chrome.storage.local.remove(['pub_reload_tab_id']).catch(() => {});

async function api(path, options = {}) {
  const saved = await storageGet([STORAGE.token]);
  const token = String(saved[STORAGE.token] || '');
  const rawBody = options.body;
  const isJsonBody = rawBody !== undefined && rawBody !== null &&
    !(rawBody instanceof Blob) && !(rawBody instanceof FormData) && typeof rawBody !== 'string';
  const response = await fetch(TOOLS_ORIGIN + path, {
    ...options,
    body: isJsonBody ? JSON.stringify(rawBody) : rawBody,
    headers: {
      ...((isJsonBody || typeof rawBody === 'string') ? {'Content-Type': 'application/json'} : {}),
      ...(token ? {Authorization: 'Bearer ' + token} : {}),
      'X-Podhub-Request-Id': options.requestId || `ext_${crypto.randomUUID()}`,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const error = new Error(payload?.message || payload?.error || `HTTP_${response.status}`);
    error.code = payload?.error || `HTTP_${response.status}`;
    error.status = response.status;
    error.retryable = payload?.retryable === true;
    throw error;
  }
  return payload.data ?? payload;
}

const apiPost = (path, body) => api(path, {method: 'POST', body});
const bridge = globalThis.PodhubBridgeV1.createClient({request: api, storageGet, storageSet});
const installationId = async () => (await storageGet([STORAGE.installation]))[STORAGE.installation] || '';

function sanitizeGatewayPayload(value) {
  if (!value || typeof value !== 'object') return value;
  const safe = {...value};
  if (safe.routing && typeof safe.routing === 'object') {
    safe.routing = {
      team_id: safe.routing.team_id || null,
      team_name: safe.routing.team_name || null,
      config_version: Number(safe.routing.config_version || 1),
      gateway_path: globalThis.PodhubBridgeV1.BASE_PATH
    };
  }
  delete safe.team_access_token;
  delete safe.server_origin;
  delete safe.api_base_url;
  return safe;
}

function fillTemplate(template, values = {}) {
  return String(template || '').replace(/:([a-z_]+)/g, (_, key) => encodeURIComponent(values[key] || ''));
}

function appendQuery(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value) !== '') params.set(key, String(value));
  }
  const value = params.toString();
  return value ? `${path}${path.includes('?') ? '&' : '?'}${value}` : path;
}

async function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then(response => response.blob());
}

function imageMimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))) return 'image/gif';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...bytes.subarray(8, 12)).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return '';
}

async function prepareImageBlob(blob) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('GPT_IMAGE_CONTENT_EMPTY');
  const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const detectedType = imageMimeFromBytes(bytes);
  if (!detectedType) throw new Error('GPT_IMAGE_BINARY_INVALID');
  return blob.type === detectedType ? blob : blob.slice(0, blob.size, detectedType);
}

function imageExtension(mimeType) {
  return mimeType === 'image/jpeg' ? 'jpg'
    : mimeType === 'image/webp' ? 'webp'
      : mimeType === 'image/gif' ? 'gif'
        : mimeType === 'image/avif' ? 'avif'
          : 'png';
}

function imageFilename(filename, mimeType) {
  const extension = imageExtension(mimeType);
  const value = String(filename || 'result').trim() || 'result';
  return /\.(?:png|jpe?g|webp|gif|avif)$/i.test(value)
    ? value.replace(/\.(?:png|jpe?g|webp|gif|avif)$/i, `.${extension}`)
    : `${value}.${extension}`;
}

async function fetchSourceImage(sourceUrl) {
  const url = new URL(String(sourceUrl || ''));
  if (url.protocol !== 'https:') throw new Error('GPT_IMAGE_SOURCE_INVALID');
  const response = await fetch(url.href, {
    credentials: 'include',
    headers: {Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9'}
  });
  if (!response.ok) throw new Error(`GPT_IMAGE_HTTP_${response.status}`);
  return prepareImageBlob(await response.blob());
}

async function uploadBinary(path, blob, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await api(path, {
        method: 'POST',
        body: blob,
        headers: {'Content-Type': blob.type || 'image/png'}
      });
    } catch (error) {
      lastError = error;
      const retryable = !error.status || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 600));
    }
  }
  throw lastError || new Error('RESULT_UPLOAD_FAILED');
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function fetchWithExtensionAuth(url, options = {}) {
  const saved = await storageGet([STORAGE.token]);
  const token = String(saved[STORAGE.token] || '');
  const absoluteUrl = new URL(String(url || ''), TOOLS_ORIGIN).href;
  const sameOrigin = new URL(absoluteUrl).origin === new URL(TOOLS_ORIGIN).origin;
  return fetch(absoluteUrl, {
    ...options,
    headers: {
      ...(sameOrigin && token ? {Authorization: `Bearer ${token}`} : {}),
      ...(sameOrigin ? {'X-Podhub-Request-Id': `ext_${crypto.randomUUID()}`} : {}),
      ...(options.headers || {})
    }
  });
}

function normalizeModules(config) {
  const list = Array.isArray(config?.modules) ? config.modules : Object.values(config?.modules || {});
  const modules = {...MODULE_DEFAULTS};
  for (const item of list) {
    const rawId = String(item?.id || item?.module_id || '').trim();
    const id = MODULE_ALIASES[rawId] || rawId;
    if (!id || !modules[id]) continue;
    modules[id] = {...modules[id], ...item, id, gpt_url: item.gpt_url || item.url || item.gpt?.url || modules[id].gpt_url};
  }
  for (const [rawId, link] of Object.entries(config?.gpt_links || {})) {
    const id = MODULE_ALIASES[rawId] || rawId;
    if (modules[id] && link?.url) modules[id].gpt_url = link.url;
  }
  return modules;
}

async function getOrCreateInstallationId() {
  const saved = await storageGet([STORAGE.installation]);
  if (saved[STORAGE.installation]) return saved[STORAGE.installation];
  const id = crypto.randomUUID();
  await storageSet({[STORAGE.installation]: id});
  return id;
}

async function activate(licenseKey) {
  const normalizedKey = String(licenseKey || '').trim();
  const id = await getOrCreateInstallationId();
  const body = {
    license_key: normalizedKey,
    key: normalizedKey,
    installation_id: id,
    bridge_gateway: true,
    app_name: 'Podhub GPTs Bridge EX',
    extension_version: chrome.runtime.getManifest().version,
    browser_name: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome',
    browser_version: navigator.userAgent,
    os: navigator.platform
  };
  let payload;
  if (normalizedKey.startsWith('phb_ext_live_')) {
    payload = await apiPost('/api/extension/activate', body);
  } else if (normalizedKey.startsWith('phb_live_')) {
    payload = await apiPost('/api/license/activate', body);
  } else {
    payload = await apiPost('/api/extension/activate', body);
  }
  const token = payload.access_token || payload.token || payload?.data?.token || payload?.data?.access_token;
  if (!token) throw new Error(payload?.error || 'Kích hoạt không trả về access token hợp lệ.');
  const safePayload = sanitizeGatewayPayload(payload?.data || payload);
  const activatedUser = safePayload.user ? {
    ...safePayload.user,
    ...(Array.isArray(safePayload.modules) ? {allowed_modules: safePayload.modules, modules: safePayload.modules} : {})
  } : null;
  const maskedKey = normalizedKey.length > 16
    ? `${normalizedKey.slice(0, 12)}••••${normalizedKey.slice(-4)}`
    : 'Đã kích hoạt';
  const license = {...(safePayload.license || {}), masked_key: safePayload.license?.masked_key || maskedKey};
  await storageSet({[STORAGE.token]: token, [STORAGE.user]: activatedUser, [STORAGE.license]: license});
  await bridge.clearProbe();
  const configRefreshed = await refreshConfig().then(() => true, () => false);
  return {...safePayload, config_refreshed: configRefreshed};
}

async function deactivate() {
  const id = await installationId();
  const remoteDeactivate = id
    ? Promise.race([
        apiPost('/api/extension/deactivate', {installation_id: id}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DEACTIVATE_TIMEOUT')), 3000))
      ]).catch(() => null)
    : Promise.resolve(null);
  await chrome.storage.local.remove([
    STORAGE.token, STORAGE.user, STORAGE.license, STORAGE.config, STORAGE.activeRun, globalThis.PodhubBridgeV1.STATE_KEY
  ]);
  await remoteDeactivate;
  return {deactivated: true};
}

async function refreshConfig() {
  const config = await api('/api/extension/config?bridge_gateway=1', {
    headers: {'X-Podhub-Bridge-Client': 'bridge_api_v1'}
  });
  const safeConfig = sanitizeGatewayPayload(config);
  const normalized = {...safeConfig, modules: normalizeModules(safeConfig)};
  const saved = await storageGet([STORAGE.user, STORAGE.license]);
  const account = safeConfig.account && typeof safeConfig.account === 'object' ? safeConfig.account : null;
  const license = safeConfig.license && typeof safeConfig.license === 'object' ? safeConfig.license : null;
  await storageSet({
    [STORAGE.config]: normalized,
    ...(account ? {[STORAGE.user]: {...(saved[STORAGE.user] || {}), ...account}} : {}),
    ...(license ? {[STORAGE.license]: {...(saved[STORAGE.license] || {}), ...license}} : {})
  });
  return normalized;
}

async function getState() {
  const saved = await storageGet([STORAGE.token, STORAGE.user, STORAGE.license, STORAGE.config, globalThis.PodhubBridgeV1.STATE_KEY]);
  return {
    active: Boolean(saved[STORAGE.token]), user: saved[STORAGE.user] || null,
    license: saved[STORAGE.license] || null,
    config: saved[STORAGE.config] || {modules: MODULE_DEFAULTS},
    bridge_mode: saved[globalThis.PodhubBridgeV1.STATE_KEY]?.mode || 'unknown'
  };
}

async function getModule(rawId) {
  const state = await getState();
  const id = MODULE_ALIASES[rawId] || rawId;
  const config = state.config?.modules?.[id] || MODULE_DEFAULTS[id];
  if (!config) throw new Error(`Module "${rawId}" is not configured.`);
  return config;
}

async function listJobs(rawId, query = {}) {
  const moduleConfig = await getModule(rawId);
  const result = await api(appendQuery(moduleConfig.list_jobs_path, query));
  return Array.isArray(result) ? result : (result?.jobs || result?.items || result?.data || []);
}

async function fetchNextJob(moduleConfig) {
  const result = await api(moduleConfig.next_job_path);
  return result?.job || result?.data || result;
}

async function claimJob(rawId, jobId, runOptions = {}) {
  const moduleConfig = await getModule(rawId);
  return api(fillTemplate(moduleConfig.claim_path_template, {job_id: jobId}), {
    method: 'POST', body: runOptions
  });
}

async function updateJobStatus(rawId, jobId, body = {}) {
  const moduleConfig = await getModule(rawId);
  return api(fillTemplate(moduleConfig.status_path_template, {job_id: jobId}), {
    method: 'POST', body
  });
}

async function startJob(rawId, job) {
  const moduleConfig = await getModule(rawId);
  if (!moduleConfig.gpt_url) throw new Error(`Chưa cấu hình link GPTs cho module "${rawId}".`);
  await storageSet({[STORAGE.activeRun]: {module_id: moduleConfig.id, module: moduleConfig, job, started_at: Date.now()}});
  const [existingTab] = await chrome.tabs.query({url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']});
  if (existingTab?.id) {
    await chrome.tabs.update(existingTab.id, {url: moduleConfig.gpt_url, active: true});
    return {tabId: existingTab.id};
  }
  const created = await chrome.tabs.create({url: moduleConfig.gpt_url, active: true});
  return {tabId: created.id};
}

async function startJobs(rawId, jobs = []) {
  if (!jobs.length) throw new Error('Không có job nào được chọn.');
  const moduleConfig = await getModule(rawId);
  if (!moduleConfig.gpt_url) throw new Error(`Chưa cấu hình link GPTs cho module "${rawId}".`);
  const activeRun = {
    module_id: moduleConfig.id,
    module: moduleConfig,
    jobs,
    job: jobs[0],
    next_index: 0,
    started_at: Date.now()
  };
  await storageSet({[STORAGE.activeRun]: activeRun});
  const [existingTab] = await chrome.tabs.query({url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']});
  if (existingTab?.id) {
    await chrome.tabs.update(existingTab.id, {url: moduleConfig.gpt_url, active: true});
    return {tabId: existingTab.id, queued: jobs.length};
  }
  const created = await chrome.tabs.create({url: moduleConfig.gpt_url, active: true});
  return {tabId: created.id, queued: jobs.length};
}

async function deleteJob(rawId, jobId) {
  const moduleConfig = await getModule(rawId);
  const template = moduleConfig.delete_path_template || String(moduleConfig.status_path_template || '').replace(/\/status$/, '');
  if (!template) throw new Error(`DELETE_PATH_MISSING:${rawId}`);
  return api(fillTemplate(template, {job_id: jobId}), {method: 'DELETE'});
}

async function deleteJobs(rawId, jobIds = []) {
  const results = [];
  for (const jobId of jobIds) {
    try {
      await deleteJob(rawId, jobId);
      results.push({jobId, ok: true});
    } catch (error) {
      results.push({jobId, ok: false, error: error.message});
    }
  }
  return {
    deleted: results.filter(item => item.ok).map(item => item.jobId),
    failed: results.filter(item => !item.ok),
    results
  };
}

async function moduleAction(rawId, action, options = {}) {
  const moduleConfig = await getModule(rawId);
  return api(`/api/extension/${moduleConfig.id}/${action}`, {method: 'POST', body: options});
}

async function saveMarketplaceListing(data) {
  const result = await api('/api/extension/marketplace-listings', {method: 'POST', body: data});
  const revision = Date.now();
  await storageSet({pub_marketplace_jobs_revision: revision});
  const tabs = await chrome.tabs.query({url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']}).catch(() => []);
  await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, {
    type: 'PUB_MARKETPLACE_JOBS_UPDATED',
    revision
  }).catch(() => null)));
  return result;
}

async function queueRawAssetsForMockup(data = {}, options = {}) {
  const assetIds = Array.isArray(data) ? data : (data.assetIds || data.asset_ids || []);
  return api('/api/extension/mockup-jobs/queue-assets', {
    method: 'POST',
    body: {asset_ids: assetIds, options}
  });
}

async function uploadResult(payload = {}) {
  const moduleId = payload.moduleId;
  const jobId = payload.jobId;
  const resultKind = payload.kind || payload.resultKind;
  const blobDataUrl = payload.dataUrl || payload.blobDataUrl;
  const sourceUrl = payload.sourceUrl || payload.imageUrl || payload.image_url;
  const metadata = {...(payload.metadata || payload.meta || {}), filename: payload.filename || payload.metadata?.filename || payload.meta?.filename};
  const moduleConfig = await getModule(moduleId);
  const pathTemplate = resultKind === 'listing'
    ? moduleConfig.listing_path_template
    : moduleConfig.result_path_template;
  if (!pathTemplate) throw new Error(`RESULT_PATH_MISSING:${moduleId}:${resultKind}`);
  const url = fillTemplate(pathTemplate, {job_id: jobId});
  if (resultKind === 'listing') {
    return api(url, {method: 'POST', body: payload.body || metadata});
  }
  if (!blobDataUrl && !sourceUrl) throw new Error(`RESULT_DATA_MISSING:${moduleId}:${resultKind}`);
  const blob = sourceUrl
    ? await fetchSourceImage(sourceUrl)
    : await prepareImageBlob(await dataUrlToBlob(blobDataUrl));
  metadata.filename = imageFilename(metadata.filename || `${resultKind || 'output'}.png`, blob.type);
  const uploadUrl = appendQuery(url, {
    ...metadata,
    filename: metadata.filename,
    kind: resultKind || moduleConfig.result_kind || 'result'
  });
  return uploadBinary(uploadUrl, blob);
}

async function fetchAsset(payload = {}) {
  const source = payload.source && typeof payload.source === 'object' ? payload.source : payload;
  const returnType = payload.returnType || 'dataUrl';
  if (source.data_url) return returnType === 'dataUrl' ? {
    data_url: source.data_url,
    name: source.name || 'podhub-asset.png',
    type: source.type || 'image/png'
  } : source.data_url;
  let url = source.url || source.image_url || source.asset_url || '';
  let name = source.name || source.filename || 'podhub-asset.png';
  let type = source.type || source.mime_type || 'image/png';
  const assetId = source.asset_id || source.id;
  if (assetId) {
    const contentResponse = await fetchWithExtensionAuth(`/api/extension/assets/${encodeURIComponent(assetId)}/content`).catch(() => null);
    if (contentResponse?.ok) {
      const blob = await contentResponse.blob();
      const encodedName = contentResponse.headers.get('X-Podhub-Design-Name');
      if (encodedName) {
        try { name = decodeURIComponent(encodedName); } catch (_) {}
      }
      return returnType === 'dataUrl' ? {
        data_url: await blobToDataUrl(blob),
        name,
        type: blob.type || type
      } : blob;
    }
  }
  if (!url && assetId) {
    const asset = await bridge.getAsset(assetId);
    if (asset?.data_url) return returnType === 'dataUrl' ? {
      data_url: asset.data_url,
      name: asset.name || asset.filename || name,
      type: asset.type || asset.mime_type || type
    } : asset.data_url;
    url = asset?.download_url || asset?.cdn_url || asset?.url || '';
    name = asset?.name || asset?.filename || name;
    type = asset?.type || asset?.mime_type || type;
  }
  if (!url) throw new Error('JOB_ASSET_SOURCE_MISSING');
  const response = await fetchWithExtensionAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch asset: HTTP_${response.status}`);
  const blob = await response.blob();
  if (returnType === 'dataUrl') return {
    data_url: await blobToDataUrl(blob),
    name,
    type: blob.type || type
  };
  return blob;
}

async function updateActiveRun(patch = {}) {
  const saved = await storageGet([STORAGE.activeRun]);
  const activeRun = {...(saved[STORAGE.activeRun] || {}), ...patch};
  await storageSet({[STORAGE.activeRun]: activeRun});
  return activeRun;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const dispatch = async () => {
    if (message?.type === 'PUB_GET_STATE') return getState();
    if (message?.type === 'PUB_ACTIVATE') return activate(message.licenseKey);
    if (message?.type === 'PUB_DEACTIVATE') return deactivate();
    if (message?.type === 'PUB_REFRESH_CONFIG') return refreshConfig();
    if (message?.type === 'PUB_LIST_JOBS') return listJobs(message.moduleId, message.query);
    if (message?.type === 'PUB_START_JOB') return startJob(message.moduleId, message.job);
    if (message?.type === 'PUB_START_JOBS') return startJobs(message.moduleId, message.jobs);
    if (message?.type === 'PUB_DELETE_JOB') return deleteJob(message.moduleId, message.jobId);
    if (message?.type === 'PUB_DELETE_JOBS') return deleteJobs(message.moduleId, message.jobIds);
    if (message?.type === 'PUB_MODULE_ACTION') return moduleAction(message.moduleId, message.action, message.runOptions || {});
    if (message?.type === 'PUB_RAW_API') return api(message.request.path, {
      method: message.request.method || 'GET',
      body: message.request.body
    });
    if (message?.type === 'PUB_FETCH_ASSET') return fetchAsset(message);
    if (message?.type === 'PUB_CLAIM_JOB') return claimJob(message.moduleId, message.jobId, message.body || message.runOptions || {});
    if (message?.type === 'PUB_UPDATE_JOB_STATUS' || message?.type === 'PUB_JOB_STATUS') return updateJobStatus(message.moduleId, message.jobId, message.body || {});
    if (message?.type === 'PUB_UPLOAD_RESULT') return uploadResult(message);
    if (message?.type === 'PUB_SAVE_MARKETPLACE_LISTING') return saveMarketplaceListing(message.data || message.payload || {});
    if (message?.type === 'PUB_QUEUE_MOCKUP_ASSETS' || message?.type === 'PUB_QUEUE_MOCKUPS') {
      return queueRawAssetsForMockup(message.data || {assetIds: message.assetIds}, message.options || message.runOptions || {});
    }
    if (message?.type === 'PUB_GET_ACTIVE_RUN' || message?.type === 'PUB_GET_ACTIVE_JOB') {
      const run = (await storageGet([STORAGE.activeRun]))[STORAGE.activeRun] || null;
      return run ? {...run, job: run.job || run} : null;
    }
    if (message?.type === 'PUB_FETCH_NEXT_JOB' || message?.type === 'PUB_FETCH_NEXT_TASK') {
      return fetchNextJob(await getModule(message.moduleId));
    }
    if (message?.type === 'PUB_CLEAR_ACTIVE_RUN') {
      await chrome.storage.local.remove([STORAGE.activeRun]);
      return {cleared: true};
    }
    if (message?.type === 'PUB_UPDATE_ACTIVE_RUN') {
      return updateActiveRun(message.patch || message.activeRun || {});
    }
    if (message?.type === 'PUB_DOWNLOAD_IMAGE') {
      const downloadId = await chrome.downloads.download({
        url: message.url,
        filename: message.filename || 'design.png',
        saveAs: Boolean(message.saveAs)
      });
      return {downloadId};
    }
    throw new Error(`Unhandled message type: ${message?.type}`);
  };

  dispatch().then(
    data => sendResponse({ok: true, data}),
    err => sendResponse({ok: false, error: err.message})
  );
  return true;
});
