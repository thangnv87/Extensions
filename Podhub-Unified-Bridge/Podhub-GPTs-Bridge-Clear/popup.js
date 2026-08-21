'use strict';

const stateEl = document.getElementById('licenseState');
const keyInput = document.getElementById('licenseKey');
const keyHint = document.getElementById('keyHint');
const activateButton = document.getElementById('activate');
const logoutButton = document.getElementById('logout');
const licenseInfo = document.getElementById('licenseInfo');
const moduleNames = {clone: 'Clone', redesign: 'Redesign', mockup: 'Mockup'};
const send = message => chrome.runtime.sendMessage(message);

function normalizeModuleId(value) {
  const text = String(value?.id || value?.module_id || value || '').toLowerCase();
  if (text.includes('clone')) return 'clone';
  if (text.includes('redesign') || text.includes('multiplier')) return 'redesign';
  if (text.includes('mockup')) return 'mockup';
  return '';
}

function accessFromState(state) {
  const user = state.user || {};
  const config = state.config || {};
  const configuredModules = Array.isArray(config.allowed_modules) ? config.allowed_modules : null;
  const enabledConfigModules = config.modules && !Array.isArray(config.modules)
    ? Object.values(config.modules).filter(module => module?.enabled === true)
    : [];
  const rawModules = configuredModules || user.allowed_modules || user.module_ids || user.modules || enabledConfigModules;
  let modules = [...new Set((Array.isArray(rawModules) ? rawModules : []).map(normalizeModuleId).filter(Boolean))];
  const planText = String(config.plan_name || user.plan_name || user.plan?.name || user.plan || '').toLowerCase();
  if (rawModules?.includes?.('all') || (!configuredModules && /\b(pro|bundle|studio|full)\b/.test(planText))) {
    modules = Object.keys(moduleNames);
  }
  return {
    plan: config.plan_name || user.plan_name || user.plan?.name || (modules.length === 3 ? 'POD Pro Bundle' : moduleNames[modules[0]] || 'Podhub'),
    email: user.email || user.username || config.account?.email || 'Tài khoản Podhub',
    modules,
    maskedKey: state.license?.masked_key || config.license?.masked_key || 'Đã kích hoạt',
    expiresAt: state.license?.expires_at || config.license?.expires_at || user.expires_at || null
  };
}

function formatExpiry(value) {
  if (!value) return 'Không giới hạn';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Theo gói cước' : date.toLocaleDateString('vi-VN');
}

function setHint(text, tone = '') {
  keyHint.textContent = text;
  keyHint.className = `hint${tone ? ` ${tone}` : ''}`;
}

function withTimeout(promise, timeoutMs = 4000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('LICENSE_SYNC_TIMEOUT')), timeoutMs))
  ]);
}

async function localState() {
  const saved = await chrome.storage.local.get([
    'pub_license_token', 'pub_license_user', 'pub_license_info', 'pub_runtime_config'
  ]);
  return {
    active: Boolean(saved.pub_license_token),
    user: saved.pub_license_user || null,
    license: saved.pub_license_info || null,
    config: saved.pub_runtime_config || null
  };
}

function renderState(state) {
  const active = Boolean(state.active);
  const access = accessFromState(state);

  stateEl.textContent = active ? `${access.plan} · Active` : 'Chưa kích hoạt';
  stateEl.className = active ? 'active' : '';
  activateButton.textContent = active ? 'Đổi key' : 'Kích hoạt';
  keyInput.placeholder = active ? access.maskedKey : 'phb_live_…';
  licenseInfo.hidden = !active;
  setHint(active ? 'Nhập key mới rồi bấm Đổi key. Key hiện tại vẫn giữ nguyên nếu key mới không hợp lệ.' : 'Nhập key được cấp trong tài khoản Podhub.');

  if (!active) return;
  document.getElementById('planName').textContent = access.plan;
  document.getElementById('maskedKey').textContent = access.maskedKey;
  document.getElementById('accountEmail').textContent = access.email;
  document.getElementById('licenseExpiry').textContent = formatExpiry(access.expiresAt);
  const list = document.getElementById('moduleList');
  list.replaceChildren(...access.modules.map(moduleId => {
    const chip = document.createElement('span');
    chip.className = 'module-chip';
    chip.textContent = moduleNames[moduleId] || moduleId;
    return chip;
  }));
}

async function refreshState(refreshConfig = false) {
  renderState(await localState());
  if (refreshConfig) await withTimeout(send({type: 'PUB_REFRESH_CONFIG'})).catch(() => null);
  const response = await withTimeout(send({type: 'PUB_GET_STATE'}));
  if (!response?.ok) throw new Error(response?.error || 'Không đọc được trạng thái license.');
  renderState(response.data || {});
}

async function activate() {
  const licenseKey = keyInput.value.trim();
  if (!licenseKey) {
    setHint('Vui lòng nhập license key mới.', 'error');
    keyInput.focus();
    return;
  }
  activateButton.disabled = true;
  setHint('Đang kiểm tra license…');
  try {
    const response = await send({type: 'PUB_ACTIVATE', licenseKey});
    if (!response?.ok) throw new Error(response?.error || 'Kích hoạt thất bại.');
    keyInput.value = '';
    await refreshState();
    setHint('Đã cập nhật license thành công.', 'success');
  } catch (error) {
    setHint(error.message || 'Kích hoạt thất bại.', 'error');
  } finally {
    activateButton.disabled = false;
  }
}

async function logout() {
  if (!window.confirm('Đăng xuất license Podhub khỏi extension này?')) return;
  logoutButton.disabled = true;
  setHint('Đang đăng xuất…');
  try {
    const response = await withTimeout(send({type: 'PUB_DEACTIVATE'}), 7000);
    if (!response?.ok) throw new Error(response?.error || 'Đăng xuất thất bại.');
    keyInput.value = '';
    renderState(await localState());
    setHint('Đã đăng xuất license.', 'success');
  } catch (error) {
    setHint(error.message || 'Đăng xuất thất bại.', 'error');
  } finally {
    logoutButton.disabled = false;
  }
}

async function openDashboard() {
  const button = document.getElementById('openDashboard');
  button.disabled = true;
  try {
    const tabs = await chrome.tabs.query({url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']});
    const activeTab = tabs.find(tab => tab.active) || tabs[0];
    if (!activeTab) {
      await chrome.storage.local.set({pub_open_dashboard_requested: Date.now()});
      await chrome.tabs.create({url: 'https://chatgpt.com/'});
      window.close();
      return;
    }
    await chrome.tabs.update(activeTab.id, {active: true});
    if (activeTab.windowId) await chrome.windows.update(activeTab.windowId, {focused: true}).catch(() => null);
    const response = await chrome.tabs.sendMessage(activeTab.id, {type: 'PUB_OPEN_DASHBOARD'}).catch(() => null);
    if (!response?.ok) {
      await chrome.storage.local.set({pub_open_dashboard_requested: Date.now()});
      throw new Error('Tab ChatGPT chưa kết nối với extension. Anh refresh tab ChatGPT một lần rồi mở lại bảng điều khiển.');
    }
    window.close();
  } catch (error) {
    button.disabled = false;
    setHint(error.message || 'Không mở được bảng điều khiển.', 'error');
  }
}

activateButton.addEventListener('click', activate);
keyInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') activate();
});
document.getElementById('openDashboard').addEventListener('click', openDashboard);
logoutButton.addEventListener('click', logout);

refreshState(true).catch(async () => {
  renderState(await localState());
  setHint('Đang dùng thông tin license đã lưu; server sẽ đồng bộ lại sau.', 'error');
});
