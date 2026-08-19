'use strict';

const CONTROL_ORIGIN = 'https://tools.podhub.space';
const PARTNER_POLICY = Object.freeze({
  teamName: 'fiercetee',
  dataOrigin: 'https://api.fiercetee.com'
});
const STORAGE = {
  token: 'pub_license_token',
  user: 'pub_license_user',
  license: 'pub_license_info',
  installation: 'pub_installation_id',
  config: 'pub_runtime_config',
  activeRun: 'pub_active_run'
  ,routing: 'pub_team_routing'
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

const CONTROL_PATHS = new Set([
  '/api/extension/activate',
  '/api/license/activate',
  '/api/extension/config',
  '/api/extension/routing'
]);

function isControlPath(path) {
  return [...CONTROL_PATHS].some(prefix => String(path || '').split('?')[0] === prefix);
}

function partnerRouting(routing) {
  assertPartnerRouting(routing);
  return {
    team_id: routing.team_id || null,
    team_name: routing.team_name || PARTNER_POLICY.teamName,
    data_origin: new URL(String(routing.api_base_url)).origin,
    team_access_token: String(routing.team_access_token || ''),
    config_version: Number(routing.config_version || 1),
    refreshed_at: new Date().toISOString()
  };
}

async function refreshPartnerRouting(accessToken) {
  const response = await fetch(CONTROL_ORIGIN + '/api/extension/routing', {
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'X-Podhub-Request-Id': `ext_${crypto.randomUUID()}`
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) throw new Error(payload?.error || `ROUTING_HTTP_${response.status}`);
  const routing = partnerRouting(payload.data?.routing || payload.routing);
  if (!routing.team_access_token) throw new Error('FIERCETEE_TEAM_TOKEN_MISSING');
  await storageSet({[STORAGE.routing]: routing});
  return routing;
}

async function api(path, options = {}, allowRoutingRefresh = true) {
  const saved = await storageGet([STORAGE.token, STORAGE.routing]);
  const token = String(saved[STORAGE.token] || '');
  const controlRequest = isControlPath(path);
  const routing = saved[STORAGE.routing] || {};
  const origin = controlRequest ? CONTROL_ORIGIN : String(routing.data_origin || PARTNER_POLICY.dataOrigin);
  const rawBody = options.body;
  const isJsonBody = rawBody !== undefined && rawBody !== null &&
    !(rawBody instanceof Blob) && !(rawBody instanceof FormData) && typeof rawBody !== 'string';
  const response = await fetch(origin + path, {
    ...options,
    body: isJsonBody ? JSON.stringify(rawBody) : rawBody,
    headers: {
      ...((isJsonBody || typeof rawBody === 'string') ? {'Content-Type': 'application/json'} : {}),
      ...(controlRequest && token ? {Authorization: 'Bearer ' + token} : {}),
      ...(!controlRequest && routing.team_access_token ? {'X-Podhub-Team-Token': routing.team_access_token} : {}),
      'X-Podhub-Request-Id': options.requestId || `ext_${crypto.randomUUID()}`,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!controlRequest && response.status === 401 && token && allowRoutingRefresh) {
    await refreshPartnerRouting(token);
    return api(path, options, false);
  }
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

function assertPartnerRouting(routing) {
  const teamName = String(routing?.team_name || '').trim().toLowerCase();
  let dataOrigin = '';
  try {
    dataOrigin = new URL(String(routing?.api_base_url || '')).origin;
  } catch {}
  if (teamName !== PARTNER_POLICY.teamName || dataOrigin !== PARTNER_POLICY.dataOrigin) {
    throw new Error('LICENSE_NOT_ASSIGNED_TO_FIERCETEE');
  }
  return routing;
}

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
  const normalizedKey = String(licenseKey || '').trim();
  const id = await getOrCreateInstallationId();
  const body = {
    license_key: normalizedKey, installation_id: id,
    bridge_gateway: true,
    app_name: 'FierceTee Unified Bridge', extension_version: chrome.runtime.getManifest().version,
    browser_name: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome',
    browser_version: navigator.userAgent, os: navigator.platform
  };
  let activationPath;
  if (normalizedKey.startsWith('phb_ext_live_')) activationPath = '/api/extension/activate';
  else if (normalizedKey.startsWith('phb_live_')) activationPath = '/api/license/activate';
  else throw new Error('LICENSE_FORMAT_INVALID');
  const payload = await apiPost(activationPath, body);
  const routing = partnerRouting(payload.routing);
  if (!routing.team_access_token) throw new Error('FIERCETEE_TEAM_TOKEN_MISSING');
  const token = payload.access_token || payload.token;
  if (!token) throw new Error('Activation did not return an access token.');
  const safePayload = sanitizeGatewayPayload(payload);
  const activatedUser = safePayload.user ? {
    ...safePayload.user,
    ...(Array.isArray(safePayload.modules) ? {allowed_modules: safePayload.modules, modules: safePayload.modules} : {})
  } : null;
  const maskedKey = normalizedKey.length > 16
    ? `${normalizedKey.slice(0, 12)}••••${normalizedKey.slice(-4)}`
    : 'Đã kích hoạt';
  const license = {...(safePayload.license || {}), masked_key: safePayload.license?.masked_key || maskedKey};
  await storageSet({[STORAGE.token]: token, [STORAGE.user]: activatedUser, [STORAGE.license]: license, [STORAGE.routing]: routing});
  await bridge.clearProbe();
  const configRefreshed = await refreshConfig().then(() => true, () => false);
  return {...safePayload, config_refreshed: configRefreshed};
}

async function deactivate() {
  await chrome.storage.local.remove([
    STORAGE.token, STORAGE.user, STORAGE.license, STORAGE.config, STORAGE.activeRun, STORAGE.routing, globalThis.PodhubBridgeV1.STATE_KEY
  ]);
  return {deactivated: true};
}

async function refreshConfig() {
  const config = await api('/api/extension/config?bridge_gateway=1', {
    headers: {'X-Podhub-Bridge-Client': 'bridge_api_v1'}
  });
  const routing = partnerRouting(config.routing);
  if (!routing.team_access_token) throw new Error('FIERCETEE_TEAM_TOKEN_MISSING');
  const safeConfig = sanitizeGatewayPayload(config);
  const normalized = {...safeConfig, modules: normalizeModules(safeConfig)};
  const saved = await storageGet([STORAGE.user, STORAGE.license]);
  const account = safeConfig.account && typeof safeConfig.account === 'object' ? safeConfig.account : null;
  const license = safeConfig.license && typeof safeConfig.license === 'object' ? safeConfig.license : null;
  await storageSet({
    [STORAGE.config]: normalized,
    [STORAGE.routing]: routing,
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
  const path = module.next_job_path || MODULE_DEFAULTS[module.id]?.next_job_path;
  return api(path, {method: 'POST'}).catch(() => api(path));
}

async function listJobs(moduleId) {
  const module = await getModule(moduleId);
  // Marketplace capture currently writes to the deployed extension job tables.
  // Always read from the matching stable adapter so create/list/run cannot split
  // across the legacy and Bridge v1 queues.
  const result = await api(module.list_jobs_path || MODULE_DEFAULTS[module.id]?.list_jobs_path);
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
  if (source.asset_id) {
    url = `/api/extension/assets/${encodeURIComponent(source.asset_id)}/content`;
    authenticated = true;
  }
  const saved = await storageGet([STORAGE.token, STORAGE.routing]);
  let routing = saved[STORAGE.routing] || {};
  const requestAsset = () => fetch(authenticated ? String(routing.data_origin || PARTNER_POLICY.dataOrigin) + url : url, {
    credentials: authenticated ? 'same-origin' : 'include',
    headers: authenticated && routing.team_access_token ? {'X-Podhub-Team-Token': routing.team_access_token} : {}
  });
  let response = await requestAsset();
  if (authenticated && response.status === 401 && saved[STORAGE.token]) {
    routing = await refreshPartnerRouting(saved[STORAGE.token]);
    response = await requestAsset();
  }
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
  const module = await getModule(moduleId);
  const template = module.status_path_template || MODULE_DEFAULTS[module.id]?.status_path_template;
  return template ? api(fillTemplate(template, {job_id: jobId}), {method: 'POST', body}) : {skipped: true};
}

async function claimJob(moduleId, jobId, body = {}) {
  if (!jobId) return body.job || null;
  const module = await getModule(moduleId);
  const template = module.claim_path_template || MODULE_DEFAULTS[module.id]?.claim_path_template;
  return template ? api(fillTemplate(template, {job_id: jobId}), {method: 'POST', body}).catch(() => body.job || null) : body.job || null;
}

async function uploadResult(message) {
  const module = await getModule(message.moduleId);
  if (!message.jobId) throw new Error('JOB_ID_REQUIRED');
  const kind = message.kind || module.result_kind || MODULE_DEFAULTS[module.id]?.result_kind || module.id;
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

async function notifyMarketplaceJobsUpdated(result, payload) {
  const revision = {
    marketplace: payload?.marketplace || payload?.source || '',
    listing_id: payload?.external_id || payload?.source_listing_id || '',
    updated_at: new Date().toISOString()
  };
  await storageSet({pub_marketplace_jobs_revision: revision});
  if (!chrome.tabs?.query || !chrome.tabs?.sendMessage) return;
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
  }).catch(() => []);
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, {
    type: 'PUB_MARKETPLACE_JOBS_UPDATED',
    marketplace: revision.marketplace,
    listing_id: revision.listing_id,
    result: result || null,
    updated_at: revision.updated_at
  })));
}

async function saveMarketplaceListing(payload) {
  // Marketplace stays on the proven Unified endpoint. The server owns license
  // entitlements, Spy persistence and the exact jobs created for each listing.
  const result = await apiPost('/api/extension/marketplace-listings', payload);
  await notifyMarketplaceJobsUpdated(result, payload);
  return result;
}

async function queueRawAssetsForMockup(assetIds, runOptions = {}) {
  const result = await apiPost('/api/extension/mockup-jobs/queue-assets', {asset_ids: assetIds, options: runOptions});
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
