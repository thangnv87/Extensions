'use strict';

const MODULE_ID = 'mockup-gpts';
const DEFAULT_ORIGIN = 'https://tools.podhub.space';
const $ = id => document.getElementById(id);

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + kind;
}

function friendlyError(error) {
  const code = String(error?.message || error || '');
  if (code === 'EXTENSION_SESSION_INVALID') return 'Phiên extension không hợp lệ. Vui lòng nhập License Key và kích hoạt lại.';
  if (code === 'SESSION_KICKED') return 'Phiên này đã bị thay thế hoặc thu hồi. Vui lòng kích hoạt lại license.';
  if (code === 'LICENSE_INACTIVE') return 'License đang bị khóa.';
  if (code === 'LICENSE_EXPIRED') return 'License đã hết hạn.';
  return code || 'Có lỗi xảy ra.';
}

async function renderActivationState() {
  const saved = await chrome.storage.local.get(['pmg_license_token', 'pmg_license_user']);
  const active = Boolean(saved.pmg_license_token);
  $('license-label').hidden = active;
  $('license').hidden = active;
  $('activate').hidden = active;
  $('actions').classList.toggle('session-active', active);
  $('license-active').hidden = !active;
  $('license-active').textContent = active
    ? `✓ Đã kích hoạt${saved.pmg_license_user?.username ? ` · ${saved.pmg_license_user.username}` : ''}`
    : '';
  if (active) $('license').value = '';
}

async function activate() {
  const licenseKey = $('license').value.trim();
  const origin = $('origin').value.trim().replace(/\/$/, '') || DEFAULT_ORIGIN;
  if (!licenseKey) return setStatus('Vui lòng nhập License Key.', 'error');
  setStatus('Đang kích hoạt…');
  await chrome.storage.local.set({pmg_api_origin: origin});
  const installationSaved = await chrome.storage.local.get('pmg_installation_id');
  const installationId = installationSaved.pmg_installation_id || crypto.randomUUID();
  await chrome.storage.local.set({pmg_installation_id: installationId});
  try {
    const response = await fetch(origin + '/api/extension/activate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        license_key: licenseKey,
        installation_id: installationId,
        browser_name: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome',
        browser_version: navigator.userAgent,
        os: navigator.platform,
        extension_version: chrome.runtime.getManifest().version
        ,module_id: MODULE_ID
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) throw new Error(payload.error || 'Kích hoạt thất bại');
    const actualModule = payload.data?.module_id || payload.data?.routing?.module_id;
    if (actualModule && actualModule !== MODULE_ID) throw new Error(`License thuộc module ${actualModule}, không phải Mockup GPTs.`);
    await chrome.storage.local.set({
      pmg_license_token: payload.data.access_token,
      pmg_license_user: payload.data.user || null,
      pmg_session_refreshed_at: Date.now()
    });
    await renderActivationState();
    await refreshConfig();
  } catch (error) {
    await renderActivationState();
    setStatus(friendlyError(error), 'error');
  }
}

async function refreshConfig() {
  setStatus('Đang lấy cấu hình từ backend…');
  const result = await chrome.runtime.sendMessage({type: 'PMG_API', request: {path: '/api/extension/config'}});
  if (!result?.ok) {
    $('open').disabled = true;
    await renderActivationState();
    return setStatus(friendlyError(result?.error || 'Không lấy được cấu hình.'), 'error');
  }
  const data = result.data?.data || result.data || {};
  const link = data.gpt_links?.[MODULE_ID];
  if (!link?.url) {
    $('open').disabled = true;
    return setStatus('License hợp lệ, nhưng admin chưa cấu hình link Mockup GPTs.', 'error');
  }
  await chrome.storage.local.set({pmg_runtime_config: data, pmg_gpt_url: link.url});
  $('open').disabled = false;
  const user = (await chrome.storage.local.get('pmg_license_user')).pmg_license_user;
  setStatus(`Đã sẵn sàng${user?.username ? ` · ${user.username}` : ''}\nCấu hình v${data.pipeline?.version || 1}`, 'ok');
}

async function init() {
  const saved = await chrome.storage.local.get(['pmg_api_origin', 'pmg_license_token']);
  $('origin').value = saved.pmg_api_origin || DEFAULT_ORIGIN;
  await renderActivationState();
  if (saved.pmg_license_token) {
    await chrome.runtime.sendMessage({type:'PMG_REFRESH_SESSION'}).catch(()=>{});
    await renderActivationState();
    await refreshConfig();
  }
}

$('activate').addEventListener('click', activate);
$('refresh').addEventListener('click', refreshConfig);
$('open').addEventListener('click', async () => {
  const saved = await chrome.storage.local.get('pmg_gpt_url');
  if (saved.pmg_gpt_url) chrome.runtime.sendMessage({type: 'PMG_OPEN_GPT', url: saved.pmg_gpt_url});
});
init();
