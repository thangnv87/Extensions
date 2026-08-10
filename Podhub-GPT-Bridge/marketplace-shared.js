(function () {
  'use strict';
  if (window.PodhubMarketplace) return;

  const ORIGIN = 'https://ex.podhub.space';

  function cleanText(value, maxLength = 1000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function storageGet(keys) {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(keys, data => resolve(data || {}));
      } catch (_error) {
        resolve({});
      }
    });
  }

  async function getToken() {
    const stored = await storageGet(['phb_license_token']);
    return String(stored.phb_license_token || '').trim();
  }

  async function request(path, options = {}) {
    const token = await getToken();
    if (!token) {
      throw new Error('Chưa kích hoạt Extension License. Hãy mở ChatGPT, vào cài đặt PodHub và nhập key.');
    }
    const response = await fetch(ORIGIN + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    }
    return body;
  }

  function toast(message, type = 'info') {
    const old = document.getElementById('ft-marketplace-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'ft-marketplace-toast';
    el.textContent = message;
    const color = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '#4f46e5';
    el.style.cssText = `position:fixed;right:18px;bottom:82px;z-index:2147483647;max-width:420px;padding:11px 14px;border-radius:9px;background:${color};color:#fff;font:700 13px/1.4 Arial,sans-serif;box-shadow:0 12px 35px rgba(15,23,42,.3)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  async function runPool(items, worker, concurrency = 3) {
    const queue = [...items];
    const results = [];
    async function consume() {
      while (queue.length) {
        const item = queue.shift();
        try {
          results.push({ item, ok: true, value: await worker(item) });
        } catch (error) {
          results.push({ item, ok: false, error });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
    return results;
  }

  window.PodhubMarketplace = {
    ORIGIN,
    cleanText,
    escapeHtml,
    getToken,
    request,
    toast,
    runPool
  };
})();
