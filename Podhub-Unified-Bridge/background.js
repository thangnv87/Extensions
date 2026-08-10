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
    id: 'clone',
    label: 'Clone',
    gpt_url: '',
    list_jobs_path: '/api/extension/clone-jobs',
    next_job_path: '/api/extension/clone-jobs/next',
    status_path_template: '/api/extension/clone-jobs/:job_id/status',
    claim_path_template: '/api/extension/clone-jobs/:job_id/claim',
    heartbeat_path_template: '/api/extension/clone-jobs/:job_id/heartbeat',
    result_kind: 'raw_clone',
    result_path_template: '/api/extension/clone-jobs/:job_id/raw-clone'
  },
  redesign: {
    id: 'redesign',
    label: 'Redesign',
    gpt_url: '',
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
    id: 'mockup',
    label: 'Mockup',
    gpt_url: '',
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

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(value) {
  return chrome.storage.local.set(value);
}

function api(path, options = {}) {
  return storageGet([STORAGE.token]).then(async saved => {
    const token = String(saved[STORAGE.token] || '');
    const response = await fetch(TOOLS_ORIGIN + path, {
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof FormData) ? {'Content-Type': 'application/json'} : {}),
        ...(token ? {Authorization: 'Bearer ' + token} : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || payload?.message || `HTTP_${response.status}`);
    }
    return payload.data || payload;
  });
}

async function apiPost(path, body) {
  return api(path, {method: 'POST', body: JSON.stringify(body || {})});
}

function fillTemplate(template, values = {}) {
  return String(template || '').replace(/:([a-z_]+)/g, (_, key) => encodeURIComponent(values[key] || ''));
}

function appendQuery(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value) !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
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
    modules[id] = {
      ...modules[id],
      ...item,
      id,
      gpt_url: item.gpt_url || item.url || item.gpt?.url || modules[id].gpt_url
    };
  }
  const links = config?.gpt_links || {};
  for (const [rawId, link] of Object.entries(links)) {
    const id = MODULE_ALIASES[rawId] || rawId;
    if (!modules[id]) continue;
    if (link?.url) modules[id].gpt_url = link.url;
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
  const installationId = await getOrCreateInstallationId();
  const baseBody = {
    license_key: String(licenseKey || '').trim(),
    installation_id: installationId,
    app_name: 'Podhub GPTs Bridge',
    extension_version: chrome.runtime.getManifest().version,
    browser_name: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome',
    browser_version: navigator.userAgent,
    os: navigator.platform
  };
  const payload = await apiPost('/api/license/activate', baseBody)
    .catch(() => apiPost('/api/extension/activate', baseBody));
  const token = payload.access_token || payload.token;
  if (!token) {
    throw new Error('Activation did not return an access token.');
  }
  await storageSet({
    [STORAGE.token]: token,
    [STORAGE.user]: payload.user || null
  });
  await refreshConfig();
  return payload;
}

async function refreshConfig() {
  let config = {};
  try {
    config = await api('/api/extension/config');
  } catch (error) {
    const saved = await storageGet([STORAGE.token]);
    config = await apiPost('/api/license/introspect', {access_token: saved[STORAGE.token]});
  }
  const normalized = {
    ...config,
    modules: normalizeModules(config)
  };
  await storageSet({[STORAGE.config]: normalized});
  return normalized;
}

async function getState() {
  const saved = await storageGet([STORAGE.token, STORAGE.user, STORAGE.config]);
  return {
    active: Boolean(saved[STORAGE.token]),
    user: saved[STORAGE.user] || null,
    config: saved[STORAGE.config] || {modules: MODULE_DEFAULTS}
  };
}

async function ensureConfig() {
  const state = await getState();
  if (state.config?.modules) return state.config;
  return refreshConfig();
}

async function getModule(moduleId) {
  const config = await ensureConfig();
  let module = config.modules?.[moduleId] || MODULE_DEFAULTS[moduleId];
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
  const path = module.list_jobs_path || MODULE_DEFAULTS[module.id]?.list_jobs_path;
  const result = await api(path).catch(() => []);
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.jobs)) return result.jobs;
  if (Array.isArray(result.data)) return result.data;
  return [];
}

async function openGpt(module, job = null, jobs = null) {
  const url = module.gpt_url;
  if (!url) throw new Error(`Server has not configured GPT link for ${module.id}.`);
  const activeRun = {
    module_id: module.id,
    module,
    job,
    jobs: Array.isArray(jobs) ? jobs : undefined,
    started_at: new Date().toISOString()
  };
  await storageSet({[STORAGE.activeRun]: activeRun});
  const tab = await chrome.tabs.create({url});
  return {tab_id: tab.id, module_id: module.id, job_id: job?.id || job?.job_id || null};
}

async function fetchAsset(message) {
  const source = message?.source || {};
  if (source.data_url) {
    return {
      data_url: source.data_url,
      name: source.name || source.filename || 'podhub-asset.png',
      type: source.type || 'image/png'
    };
  }
  const url = source.url || source.image_url || source.asset_url;
  const path = source.asset_id ? `/api/extension/assets/${encodeURIComponent(source.asset_id)}/content` : '';
  const response = await storageGet([STORAGE.token]).then(saved => fetch(path ? TOOLS_ORIGIN + path : url, {
    credentials: path ? 'same-origin' : 'include',
    headers: {
      ...(saved[STORAGE.token] ? {Authorization: 'Bearer ' + saved[STORAGE.token]} : {})
    }
  }));
  if (!response.ok) throw new Error(`ASSET_HTTP_${response.status}`);
  const blob = await response.blob();
  return {
    data_url: await blobToDataUrl(blob),
    name: source.name || source.filename || decodeURIComponent(response.headers.get('X-Podhub-Design-Name') || '') || 'podhub-asset.png',
    type: response.headers.get('Content-Type') || blob.type || 'image/png'
  };
}

async function updateJobStatus(moduleId, jobId, body = {}) {
  const module = await getModule(moduleId);
  const template = module.status_path_template || MODULE_DEFAULTS[module.id]?.status_path_template;
  if (!template || !jobId) return {skipped: true};
  return api(fillTemplate(template, {job_id: jobId}), {method: 'POST', body: JSON.stringify(body)});
}

async function claimJob(moduleId, jobId, body = {}) {
  const module = await getModule(moduleId);
  const template = module.claim_path_template || MODULE_DEFAULTS[module.id]?.claim_path_template;
  if (!template || !jobId) return body.job || null;
  return api(fillTemplate(template, {job_id: jobId}), {method: 'POST', body: JSON.stringify(body)}).catch(() => body.job || null);
}

async function uploadResult(message) {
  const module = await getModule(message.moduleId);
  const jobId = message.jobId;
  if (!jobId) throw new Error('JOB_ID_REQUIRED');
  const kind = message.kind || module.result_kind || MODULE_DEFAULTS[module.id]?.result_kind || module.id;
  const template = kind === 'listing'
    ? (module.listing_path_template || MODULE_DEFAULTS[module.id]?.listing_path_template)
    : (module.result_path_template || MODULE_DEFAULTS[module.id]?.result_path_template);
  if (!template) throw new Error(`RESULT_PATH_MISSING:${module.id}`);
  let path = fillTemplate(template, {job_id: jobId});
  if (kind === 'mockup') {
    path = appendQuery(path, {
      product_id: message.meta?.product_id,
      mockup_no: message.meta?.mockup_no,
      filename: message.filename || 'mockup.png'
    });
  } else if (kind !== 'listing') {
    path = appendQuery(path, {
      kind,
      filename: message.filename || `${kind}.png`,
      runner_id: message.meta?.runner_id
    });
  }
  if (kind === 'listing') {
    return api(path, {method: 'POST', body: JSON.stringify(message.body || message.meta || {})});
  }
  const blob = await dataUrlToBlob(message.dataUrl);
  return api(path, {
    method: 'POST',
    body: blob,
    headers: {
      'Content-Type': blob.type || 'image/png',
      'X-Podhub-Result-Kind': kind
    }
  });
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

async function startJob(moduleId, job) {
  const module = await getModule(moduleId);
  return openGpt(module, job || null);
}

async function startJobs(moduleId, jobs) {
  const module = await getModule(moduleId);
  const batch = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  if (!batch.length) throw new Error('NO_JOBS_SELECTED');
  return openGpt(module, batch[0], batch);
}

async function deleteJob(moduleId, jobId) {
  const module = await getModule(moduleId);
  const listPath = module.list_jobs_path || MODULE_DEFAULTS[module.id]?.list_jobs_path;
  if (!listPath || !jobId) throw new Error('JOB_ID_REQUIRED');
  return api(`${listPath}/${encodeURIComponent(jobId)}`, {method: 'DELETE'});
}

async function deleteJobs(moduleId, jobIds) {
  const ids = [...new Set(Array.isArray(jobIds) ? jobIds.filter(Boolean) : [])];
  if (!ids.length) throw new Error('JOB_IDS_REQUIRED');
  const deleted = [];
  const errors = [];
  for (const jobId of ids) {
    try {
      await deleteJob(moduleId, jobId);
      deleted.push(jobId);
    } catch (error) {
      errors.push({job_id: jobId, error: error.message});
    }
  }
  return {deleted, failed: errors.length, errors};
}

async function saveMarketplaceListing(payload) {
  return apiPost('/api/extension/marketplace-listings', payload);
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
  const current = saved[STORAGE.activeRun];
  if (!current) return null;
  const next = {...current, ...patch, updated_at: new Date().toISOString()};
  await storageSet({[STORAGE.activeRun]: next});
  return next;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    if (message?.type === 'PUB_GET_STATE') return getState();
    if (message?.type === 'PUB_ACTIVATE') return activate(message.licenseKey);
    if (message?.type === 'PUB_REFRESH_CONFIG') return refreshConfig();
    if (message?.type === 'PUB_LIST_JOBS') return listJobs(message.moduleId);
    if (message?.type === 'PUB_START_JOB') return startJob(message.moduleId, message.job);
    if (message?.type === 'PUB_START_JOBS') return startJobs(message.moduleId, message.jobs);
    if (message?.type === 'PUB_DELETE_JOB') return deleteJob(message.moduleId, message.jobId);
    if (message?.type === 'PUB_DELETE_JOBS') return deleteJobs(message.moduleId, message.jobIds);
    if (message?.type === 'PUB_MODULE_ACTION') return moduleAction(message.moduleId, message.action, message.runOptions || {});
    if (message?.type === 'PUB_API') return api(message.request.path, {
      method: message.request.method || 'GET',
      body: message.request.body ? JSON.stringify(message.request.body) : undefined
    });
    if (message?.type === 'PUB_FETCH_ASSET') return fetchAsset(message);
    if (message?.type === 'PUB_CLAIM_JOB') return claimJob(message.moduleId, message.jobId, message.body || {});
    if (message?.type === 'PUB_JOB_STATUS') return updateJobStatus(message.moduleId, message.jobId, message.body || {});
    if (message?.type === 'PUB_UPLOAD_RESULT') return uploadResult(message);
    if (message?.type === 'PUB_SAVE_MARKETPLACE_LISTING') return saveMarketplaceListing(message.payload || {});
    if (message?.type === 'PUB_QUEUE_MOCKUPS') return queueRawAssetsForMockup(message.assetIds, message.runOptions || {});
    if (message?.type === 'PUB_GET_ACTIVE_RUN') {
      const saved = await storageGet([STORAGE.activeRun]);
      return saved[STORAGE.activeRun] || null;
    }
    if (message?.type === 'PUB_CLEAR_ACTIVE_RUN') {
      await chrome.storage.local.remove([STORAGE.activeRun]);
      return {cleared: true};
    }
    if (message?.type === 'PUB_UPDATE_ACTIVE_RUN') return updateActiveRun(message.patch || {});
    throw new Error('UNKNOWN_MESSAGE');
  };
  run().then(
    data => sendResponse({ok: true, data}),
    error => sendResponse({ok: false, error: error.message})
  );
  return true;
});
