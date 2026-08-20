'use strict';

const TOOLS_ORIGIN = 'https://api.fiercetee.com';
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
  const normalizedKey = String(licenseKey || '').trim();
  const id = await getOrCreateInstallationId();
  const body = {
    license_key: normalizedKey,
    key: normalizedKey,
    installation_id: id,
    bridge_gateway: true,
    app_name: 'Podhub GPTs Bridge',
    extension_version: chrome.runtime.getManifest().version,
    browser_name: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome',
    browser_version: navigator.userAgent,
    os: navigator.platform
  };
  let payload;
  try {
    payload = await apiPost('/api/extension/activate', body);
  } catch (err) {
    try {
      payload = await apiPost('/api/extension/activate-license', body);
    } catch {
      payload = await apiPost('/api/license/activate', body);
    }
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
  if (id) {
    await apiPost('/api/extension/deactivate', { installation_id: id }).catch(() => null);
  }
  await chrome.storage.local.remove([
    STORAGE.token, STORAGE.user, STORAGE.license, STORAGE.config, STORAGE.activeRun, globalThis.PodhubBridgeV1.STATE_KEY
  ]);
  return {deactivated: true};
}

async function refreshConfig() {
  let config;
  try {
    config = await api('/api/extension/config?bridge_gateway=1', {
      headers: {'X-Podhub-Bridge-Client': 'bridge_api_v1'}
    });
  } catch {
    config = { modules: MODULE_DEFAULTS };
  }
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
  return api(appendQuery(moduleConfig.list_jobs_path, query));
}

async function fetchNextJob(moduleConfig) {
  return api(moduleConfig.next_job_path);
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
  await storageSet({[STORAGE.activeRun]: {module_id: moduleConfig.id, job, started_at: Date.now()}});
  const [existingTab] = await chrome.tabs.query({url: 'https://chatgpt.com/*'});
  if (existingTab?.id) {
    await chrome.tabs.update(existingTab.id, {url: moduleConfig.gpt_url, active: true});
    return {tabId: existingTab.id};
  }
  const created = await chrome.tabs.create({url: moduleConfig.gpt_url, active: true});
  return {tabId: created.id};
}

async function startJobs(rawId, jobs = []) {
  if (!jobs.length) throw new Error('Không có job nào được chọn.');
  return startJob(rawId, jobs[0]);
}

async function deleteJob(rawId, jobId) {
  const moduleConfig = await getModule(rawId);
  return api(fillTemplate(moduleConfig.status_path_template, {job_id: jobId}), {method: 'DELETE'});
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
  return results;
}

async function moduleAction(rawId, action, options = {}) {
  const moduleConfig = await getModule(rawId);
  return api(`/api/extension/${moduleConfig.id}/${action}`, {method: 'POST', body: options});
}

async function saveMarketplaceListing(data) {
  return api('/api/extension/marketplace/listings', {method: 'POST', body: data});
}

async function queueRawAssetsForMockup(data, options = {}) {
  return api('/api/extension/mockup/queue-raw-assets', {method: 'POST', body: {...data, ...options}});
}

async function uploadResult(payload = {}) {
  const {moduleId, jobId, resultKind, blobDataUrl, metadata = {}} = payload;
  const moduleConfig = await getModule(moduleId);
  const pathTemplate = resultKind === 'raw_clone'
    ? moduleConfig.result_path_template
    : resultKind === 'mockup'
      ? moduleConfig.result_path_template
      : moduleConfig.result_path_template;
  const url = fillTemplate(pathTemplate, {job_id: jobId});
  const formData = new FormData();
  if (blobDataUrl) {
    const blob = await dataUrlToBlob(blobDataUrl);
    formData.append('file', blob, metadata.filename || 'output.png');
  }
  formData.append('metadata', JSON.stringify(metadata));
  return api(url, {method: 'POST', body: formData});
}

async function fetchAsset(payload = {}) {
  const {url, returnType = 'dataUrl'} = payload;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch asset: HTTP_${response.status}`);
  const blob = await response.blob();
  if (returnType === 'dataUrl') return blobToDataUrl(blob);
  return blob;
}

async function updateActiveRun(activeRun) {
  await storageSet({[STORAGE.activeRun]: activeRun});
  return {saved: true};
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
    if (message?.type === 'PUB_CLAIM_JOB') return claimJob(message.moduleId, message.jobId, message.runOptions || {});
    if (message?.type === 'PUB_UPDATE_JOB_STATUS') return updateJobStatus(message.moduleId, message.jobId, message.body || {});
    if (message?.type === 'PUB_UPLOAD_RESULT') return uploadResult(message);
    if (message?.type === 'PUB_SAVE_MARKETPLACE_LISTING') return saveMarketplaceListing(message.data || {});
    if (message?.type === 'PUB_QUEUE_MOCKUP_ASSETS') return queueRawAssetsForMockup(message.data, message.options || {});
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
      return updateActiveRun(message.activeRun || {});
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
