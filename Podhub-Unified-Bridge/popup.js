'use strict';

const MODULES = ['clone', 'redesign', 'mockup'];
const stateEl = document.getElementById('licenseState');

function setPanel(name) {
  document.querySelectorAll('.tab').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${name}`);
  });
}

function statusId(moduleId) {
  return `${moduleId}Status`;
}

function setStatus(moduleId, value) {
  const el = document.getElementById(statusId(moduleId));
  if (el) el.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function refreshState() {
  const response = await send({type: 'PUB_GET_STATE'});
  const data = response?.data || {};
  const user = data.user?.email || data.user?.username || '';
  stateEl.textContent = data.active ? `Active${user ? ` - ${user}` : ''}` : 'Not activated';
  document.getElementById('activation').hidden = Boolean(data.active);
  for (const moduleId of MODULES) {
    const module = data.config?.modules?.[moduleId] || null;
    setStatus(moduleId, module?.enabled === false ? 'Disabled by server' : 'Ready');
  }
}

async function activate() {
  const licenseKey = document.getElementById('licenseKey').value.trim();
  if (!licenseKey) {
    stateEl.textContent = 'Enter a license key first.';
    return;
  }
  stateEl.textContent = 'Activating...';
  const response = await send({type: 'PUB_ACTIVATE', licenseKey});
  if (!response?.ok) {
    stateEl.textContent = response?.error || 'Activation failed';
    return;
  }
  document.getElementById('licenseKey').value = '';
  await refreshState();
}

async function moduleAction(moduleId, action) {
  setStatus(moduleId, action === 'start' ? 'Preparing next job...' : 'Opening GPT...');
  const response = await send({type: 'PUB_MODULE_ACTION', moduleId, action});
  if (!response?.ok) {
    setStatus(moduleId, response?.error || 'Action failed');
    return;
  }
  setStatus(moduleId, response.data || 'Done');
}

document.querySelectorAll('.tab').forEach(button => {
  button.addEventListener('click', () => setPanel(button.dataset.tab));
});

document.getElementById('activate').addEventListener('click', activate);
document.getElementById('refreshConfig').addEventListener('click', async () => {
  stateEl.textContent = 'Refreshing config...';
  await send({type: 'PUB_REFRESH_CONFIG'});
  await refreshState();
});

document.querySelectorAll('[data-module][data-action]').forEach(button => {
  button.addEventListener('click', () => moduleAction(button.dataset.module, button.dataset.action));
});

refreshState().catch(error => {
  stateEl.textContent = error.message || 'Cannot load state';
});
