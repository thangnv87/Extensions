'use strict';

const TOOLS_ORIGIN = 'https://tools.podhub.space';
const STORAGE = {
  token: 'pub_license_token',
  user: 'pub_license_user',
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

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
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
  const id = await getOrCreateInstallationId();
  const body = {
    license_key: String(licenseKey || '').trim(), installation_id: id,
    bridge_gateway: true,
    app_name: 'Podhub GPTs Bridge', extension_version: chrome.runtime.getManifest().version,
    browser_name: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome',
    browser_version: navigator.userAgent, os: navigator.platform
  };
  const payload = await apiPost('/api/license/activate', body).catch(() => apiPost('/api/extension/activate', body));
  const token = payload.access_token || payload.token;
  if (!token) throw new Error('Activation did not return an access token.');
  const safePayload = sanitizeGatewayPayload(payload);
  await storageSet({[STORAGE.token]: token, [STORAGE.user]: safePayload.user || null});
  await bridge.clearProbe();
  await refreshConfig();
  return safePayload;
}

async function deactivate() {
  await chrome.storage.local.remove([
    STORAGE.token, STORAGE.user, STORAGE.config, STORAGE.activeRun, globalThis.PodhubBridgeV1.STATE_KEY
  ]);
  return {deactivated: true};
}

async function refreshConfig() {
  let config = {};
  try {
    config = await api('/api/extension/config?bridge_gateway=1', {
      headers: {'X-Podhub-Bridge-Client': 'bridge_api_v1'}
    });
  } catch {
    const saved = await storageGet([STORAGE.token]);
    config = await apiPost('/api/license/introspect', {access_token: saved[STORAGE.token]});
  }
  const safeConfig = sanitizeGatewayPayload(config);
  const normalized = {...safeConfig, modules: normalizeModules(safeConfig)};
  await storageSet({[STORAGE.config]: normalized});
  return normalized;
}

async function getState() {
  const saved = await storageGet([STORAGE.token, STORAGE.user, STORAGE.config, globalThis.PodhubBridgeV1.STATE_KEY]);
  return {
    active: Boolean(saved[STORAGE.token]), user: saved[STORAGE.user] || null,
    config: saved[STORAGE.config] || {modules: MODULE_DEFAULTS},
    bridge_mode: saved[globalThis.PodhubBridgeV1.STATE_KEY]?.mode || 'unknown'
  };
}

async function getModule(moduleId) {
  const state = await getState();
  let module = state.config?.modules?.[moduleId] || MODULE_DEFAULTS[moduleId];
  if (module && !module.gpt_url) {
    const fresh = await refreshConfig().catch(() => null);
    module = fresh?.modules?.[moduleId] || module;
  }
  if (!module) throw new Error(`Unknown module: ${moduleId}`);
  return module;
}

async function fetchNextJob(module) {
  if (await bridge.probe()) return bridge.nextJob(module.id);
  const path = module.next_job_path || MODULE_DEFAULTS[module.id]?.next_job_path;
  return api(path, {method: 'POST'}).catch(() => api(path));
}

async function listJobs(moduleId) {
  const module = await getModule(moduleId);
  const result = await bridge.probe()
    ? bridge.listJobs(module.id)
    : api(module.list_jobs_path || MODULE_DEFAULTS[module.id]?.list_jobs_path).catch(() => []);
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.jobs)) return result.jobs;
  if (Array.isArray(result?.data)) return result.data;
  return [];
}

async function openGpt(module, job = null, jobs = null) {
  if (!module.gpt_url) throw new Error(`Server has not configured GPT link for ${module.id}.`);
  await storageSet({[STORAGE.activeRun]: {
    module_id: module.id, module, job,
    jobs: Array.isArray(jobs) ? jobs : undefined,
    started_at: new Date().toISOString()
  }});
  const tab = await chrome.tabs.create({url: module.gpt_url});
  return {tab_id: tab.id, module_id: module.id, job_id: job?.id || job?.job_id || null};
}

async function fetchAsset(message) {
  const source = message?.source || {};
  if (source.data_url) return {data_url: source.data_url, name: source.name || source.filename || 'podhub-asset.png', type: source.type || 'image/png'};
  let url = source.url || source.image_url || source.asset_url;
  let authenticated = false;
  if (source.asset_id && await bridge.probe()) {
    const asset = await bridge.getAsset(source.asset_id);
    url = asset.content_url;
    authenticated = String(url || '').startsWith('/');
  } else if (source.asset_id) {
    url = `/api/extension/assets/${encodeURIComponent(source.asset_id)}/content`;
    authenticated = true;
  }
  const saved = await storageGet([STORAGE.token]);
  const response = await fetch(authenticated ? TOOLS_ORIGIN + url : url, {
    credentials: authenticated ? 'same-origin' : 'include',
    headers: authenticated && saved[STORAGE.token] ? {Authorization: 'Bearer ' + saved[STORAGE.token]} : {}
  });
  if (!response.ok) throw new Error(`ASSET_HTTP_${response.status}`);
  const blob = await response.blob();
  return {
    data_url: await blobToDataUrl(blob),
    name: source.name || source.filename || decodeURIComponent(response.headers.get('X-Podhub-Design-Name') || '') || 'podhub-asset.png',
    type: response.headers.get('Content-Type') || blob.type || 'image/png'
  };
}

async function updateJobStatus(moduleId, jobId, body = {}) {
  if (!jobId) return {skipped: true};
  if (await bridge.probe()) return bridge.updateStatus(jobId, body, await installationId());
  const module = await getModule(moduleId);
  const template = module.status_path_template || MODULE_DEFAULTS[module.id]?.status_path_template;
  return template ? api(fillTemplate(template, {job_id: jobId}), {method: 'POST', body}) : {skipped: true};
}

async function claimJob(moduleId, jobId, body = {}) {
  if (!jobId) return body.job || null;
  if (await bridge.probe()) return bridge.claimJob(jobId, await installationId());
  const module = await getModule(moduleId);
  const template = module.claim_path_template || MODULE_DEFAULTS[module.id]?.claim_path_template;
  return template ? api(fillTemplate(template, {job_id: jobId}), {method: 'POST', body}).catch(() => body.job || null) : body.job || null;
}

async function uploadResult(message) {
  const module = await getModule(message.moduleId);
  if (!message.jobId) throw new Error('JOB_ID_REQUIRED');
  const kind = message.kind || module.result_kind || MODULE_DEFAULTS[module.id]?.result_kind || module.id;
  if (await bridge.probe()) return bridge.saveResult({...message, kind}, await installationId());
  const template = kind === 'listing'
    ? (module.listing_path_template || MODULE_DEFAULTS[module.id]?.listing_path_template)
    : (module.result_path_template || MODULE_DEFAULTS[module.id]?.result_path_template);
  if (!template) throw new Error(`RESULT_PATH_MISSING:${module.id}`);
  let path = fillTemplate(template, {job_id: message.jobId});
  if (kind === 'mockup') path = appendQuery(path, {product_id: message.meta?.product_id, mockup_no: message.meta?.mockup_no, filename: message.filename || 'mockup.png'});
  else if (kind !== 'listing') path = appendQuery(path, {kind, filename: message.filename || `${kind}.png`, runner_id: message.meta?.runner_id});
  if (kind === 'listing') return api(path, {method: 'POST', body: message.body || message.meta || {}});
  const blob = await dataUrlToBlob(message.dataUrl);
  return api(path, {method: 'POST', body: blob, headers: {'Content-Type': blob.type || 'image/png', 'X-Podhub-Result-Kind': kind}});
}

async function moduleAction(moduleId, action, runOptions = {}) {
  const module = await getModule(moduleId);
  if (module.enabled === false) throw new Error(`${module.label || moduleId} is disabled by server.`);
  if (action === 'open') return openGpt(module);
  if (action === 'start') {
    const job = await fetchNextJob(module);
    return openGpt(module, job ? {...job, run_options: runOptions} : job);
  }
  throw new Error(`Unknown action: ${action}`);
}

const startJob = async (moduleId, job) => openGpt(await getModule(moduleId), job || null);
async function startJobs(moduleId, jobs) {
  const batch = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  if (!batch.length) throw new Error('NO_JOBS_SELECTED');
  return openGpt(await getModule(moduleId), batch[0], batch);
}

async function deleteJob(moduleId, jobId) {
  if (await bridge.probe()) return bridge.updateStatus(jobId, {status: 'cancelled'}, await installationId());
  const module = await getModule(moduleId);
  const path = module.list_jobs_path || MODULE_DEFAULTS[module.id]?.list_jobs_path;
  if (!path || !jobId) throw new Error('JOB_ID_REQUIRED');
  return api(`${path}/${encodeURIComponent(jobId)}`, {method: 'DELETE'});
}

async function deleteJobs(moduleId, jobIds) {
  const ids = [...new Set(Array.isArray(jobIds) ? jobIds.filter(Boolean) : [])];
  if (!ids.length) throw new Error('JOB_IDS_REQUIRED');
  const deleted = [], errors = [];
  for (const jobId of ids) {
    try { await deleteJob(moduleId, jobId); deleted.push(jobId); }
    catch (error) { errors.push({job_id: jobId, error: error.message}); }
  }
  return {deleted, failed: errors.length, errors};
}

async function saveMarketplaceListing(payload) {
  if (await bridge.probe()) return bridge.saveMarketplaceListing(payload);
  return apiPost('/api/extension/marketplace-listings', payload);
}

async function queueRawAssetsForMockup(assetIds, runOptions = {}) {
  let result;
  if (await bridge.probe()) {
    const jobs = await bridge.queueMockups(assetIds, runOptions, await installationId());
    result = {jobs};
  } else {
    result = await apiPost('/api/extension/mockup-jobs/queue-assets', {asset_ids: assetIds, options: runOptions});
  }
  const jobs = Array.isArray(result?.jobs) ? result.jobs : [];
  if (!jobs.length) throw new Error('MOCKUP_JOBS_NOT_CREATED');
  const runnable = jobs.map(job => ({...job, run_options: job.run_options || job.options || runOptions}));
  const opened = await openGpt(await getModule('mockup'), runnable[0], runnable);
  return {...result, opened};
}

async function updateActiveRun(patch = {}) {
  const saved = await storageGet([STORAGE.activeRun]);
  if (!saved[STORAGE.activeRun]) return null;
  const next = {...saved[STORAGE.activeRun], ...patch, updated_at: new Date().toISOString()};
  await storageSet({[STORAGE.activeRun]: next});
  return next;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    if (message?.type === 'PUB_GET_STATE') return getState();
    if (message?.type === 'PUB_ACTIVATE') return activate(message.licenseKey);
    if (message?.type === 'PUB_DEACTIVATE') return deactivate();
    if (message?.type === 'PUB_REFRESH_CONFIG') return refreshConfig();
    if (message?.type === 'PUB_LIST_JOBS') return listJobs(message.moduleId);
    if (message?.type === 'PUB_START_JOB') return startJob(message.moduleId, message.job);
    if (message?.type === 'PUB_START_JOBS') return startJobs(message.moduleId, message.jobs);
    if (message?.type === 'PUB_DELETE_JOB') return deleteJob(message.moduleId, message.jobId);
    if (message?.type === 'PUB_DELETE_JOBS') return deleteJobs(message.moduleId, message.jobIds);
    if (message?.type === 'PUB_MODULE_ACTION') return moduleAction(message.moduleId, message.action, message.runOptions || {});
    if (message?.type === 'PUB_API') return api(message.request.path, {method: message.request.method || 'GET', body: message.request.body});
    if (message?.type === 'PUB_FETCH_ASSET') return fetchAsset(message);
    if (message?.type === 'PUB_CLAIM_JOB') return claimJob(message.moduleId, message.jobId, message.body || {});
    if (message?.type === 'PUB_JOB_STATUS') return updateJobStatus(message.moduleId, message.jobId, message.body || {});
    if (message?.type === 'PUB_UPLOAD_RESULT') return uploadResult(message);
    if (message?.type === 'PUB_SAVE_MARKETPLACE_LISTING') return saveMarketplaceListing(message.payload || {});
    if (message?.type === 'PUB_QUEUE_MOCKUPS') return queueRawAssetsForMockup(message.assetIds, message.runOptions || {});
    if (message?.type === 'PUB_GET_ACTIVE_RUN') return (await storageGet([STORAGE.activeRun]))[STORAGE.activeRun] || null;
    if (message?.type === 'PUB_CLEAR_ACTIVE_RUN') { await chrome.storage.local.remove([STORAGE.activeRun]); return {cleared: true}; }
    if (message?.type === 'PUB_UPDATE_ACTIVE_RUN') return updateActiveRun(message.patch || {});
    throw new Error('UNKNOWN_MESSAGE');
  };
  run().then(data => sendResponse({ok: true, data}), error => sendResponse({ok: false, error: error.message}));
  return true;
});
