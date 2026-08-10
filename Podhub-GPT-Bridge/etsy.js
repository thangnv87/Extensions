/* Podhub GPTs — Etsy Listing Quick Save
   Chay doc lap tren etsy.com, khong phu thuoc chatgpt.js
*/
(function () {
  'use strict';
  if (!/(^|\.)etsy\.com$/i.test(location.hostname)) return;
  if (document.getElementById('phb-etsy-saver-init')) return;
  const _marker = document.createElement('meta');
  _marker.id = 'phb-etsy-saver-init';
  document.head.appendChild(_marker);

  const VERSION = '1.0.76';
  const LOCAL_ORIGIN = 'http://localhost:3001';
  const PODHUB_ORIGIN = 'https://ex.podhub.space';

  const SERVERS = [
    { key: 'local',  label: 'Local',      origin: LOCAL_ORIGIN  },
    { key: 'podhub', label: 'Podhub VPS', origin: PODHUB_ORIGIN }
  ];

  function normalizeServerMode(mode) {
    return ['local', 'podhub', 'dual'].includes(mode) ? mode : 'podhub';
  }

  let currentMode = normalizeServerMode(localStorage.getItem('phb_mode') || 'podhub');

  function getOrigin() {
    const active = currentMode === 'dual' ? SERVERS : SERVERS.filter(s => s.key === currentMode);
    return (active[0] || SERVERS[1]).origin;
  }

  function getQueueApi() {
    return getOrigin() + '/api/ext-queue';
  }

  // ============ CHROME STORAGE HELPERS ============
  function chromeStorageGet(keys) {
    return new Promise(resolve => {
      try {
        if (!chrome?.storage?.local) return resolve({});
        chrome.storage.local.get(keys, resolve);
      } catch (e) {
        resolve({});
      }
    });
  }

  function chromeStorageSet(obj) {
    return new Promise(resolve => {
      try {
        if (!chrome?.storage?.local) return resolve(false);
        chrome.storage.local.set(obj, () => resolve(true));
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function getLicenseSession() {
    const data = await chromeStorageGet(['phb_license_token','phb_license_user']);
    return {
      token:String(data?.phb_license_token||'').trim(),
      user:data?.phb_license_user||null
    };
  }

  // ============ ETSY DATA EXTRACTORS ============
  const ETSY_SAVED_KEY = 'phb_etsy_saved_listings_v2';

  function normalizeEtsyHighRes(src) {
    const raw = String(src || '').trim();
    if (!raw) return '';
    if (/^\/\//.test(raw)) return 'https:' + raw;
    return raw
      .replace(/il_\d+x\d+/g, 'il_fullxfull')
      .replace(/il_\d+xN/g, 'il_fullxfull')
      .replace(/il_\d+x\d+\.jpg/g, 'il_fullxfull.jpg');
  }

  function getEtsyListingId() {
    const input = document.querySelector('input[name="listing_id"]')?.value;
    if (input && /^\d{6,}$/.test(String(input))) return String(input);
    const m = location.pathname.match(/\/listing\/(\d{6,})/i);
    return m ? m[1] : '';
  }

  function cleanText(text, max = 12000) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function getEtsyTitle() {
    const selectors = [
      'h1[data-buy-box-listing-title]',
      'h1.wt-text-body-03',
      'h1'
    ];
    for (const sel of selectors) {
      const text = cleanText(document.querySelector(sel)?.textContent, 500);
      if (text) return text;
    }
    return cleanText(document.title.replace(/\s*\|\s*Etsy.*$/i, ''), 500);
  }

  function getEtsyDescription() {
    const selectors = [
      '[data-id="description-text"]',
      '[data-product-details-description-text-content]',
      '#wt-content-toggle-product-details-read-more .wt-content-toggle__body',
      '#description-text',
      '[class*="description"]'
    ];
    for (const sel of selectors) {
      const text = cleanText(document.querySelector(sel)?.textContent);
      if (text && text.length > 20) return text;
    }
    const meta = document.querySelector('meta[property="og:description"], meta[name="description"]')?.getAttribute('content');
    return cleanText(meta);
  }

  function collectEtsyImages() {
    const out = [];
    const push = src => {
      const url = normalizeEtsyHighRes(src);
      if (url && /^https?:\/\//i.test(url) && !out.includes(url)) out.push(url);
    };
    const candidates = [
      ...document.querySelectorAll('ul.carousel-pane-list > li:not(.wt-display-none) img'),
      ...document.querySelectorAll('#photos img, .image-wrapper img, [data-carousel-pagination-list] img'),
      ...document.querySelectorAll('img[src*="etsystatic.com"], img[data-src*="etsystatic.com"]')
    ];
    candidates.forEach(img => push(img.currentSrc || img.getAttribute('data-src') || img.src));
    return out;
  }

  function getSelectedEtsyImage() {
    // Uu tien anh dang hien thi trong carousel (li active / khong aria-hidden)
    const activeSelectors = [
      'ul.carousel-pane-list > li[aria-hidden="false"] img',
      'ul.carousel-pane-list > li:not([aria-hidden="true"]) img',
      'ul.carousel-pane-list > li.is-selected img',
      'ul.carousel-pane-list > li.active img'
    ];
    for (const sel of activeSelectors) {
      const img = document.querySelector(sel);
      const src = img && normalizeEtsyHighRes(img.currentSrc || img.getAttribute('data-src') || img.src);
      if (src && /^https?:\/\//i.test(src)) return src;
    }
    // Fallback: anh dau trong danh sach chung
    return collectEtsyImages()[0] || '';
  }

  function loadSavedListings() {
    try {
      const value = JSON.parse(localStorage.getItem(ETSY_SAVED_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (e) {
      return {};
    }
  }

  function markListingSaved(listingId, user) {
    const saved=loadSavedListings();
    saved[listingId]={saved_at:new Date().toISOString(),user_id:user?.id||user?.email||user?.username||''};
    localStorage.setItem(ETSY_SAVED_KEY,JSON.stringify(saved));
  }

  function isListingSaved(listingId) {
    return Boolean(loadSavedListings()[listingId]);
  }

  // ============ STYLES ============
  function upsertEtsySaveStyles() {
    if (document.getElementById('phb-etsy-save-style')) return;
    const style = document.createElement('style');
    style.id = 'phb-etsy-save-style';
    style.textContent = `
      #phb-etsy-save-btn,#phb-etsy-modal *{box-sizing:border-box;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
      #phb-etsy-save-btn{position:absolute;top:14px;left:14px;z-index:2147483640;border:2px solid #fff;border-radius:8px;background:#4f46e5;color:#fff;padding:9px 13px;font-size:13px;font-weight:900;box-shadow:0 10px 24px rgba(15,23,42,.28);cursor:pointer}
      #phb-etsy-save-btn:hover{background:#4338ca;transform:translateY(-1px)}
      #phb-etsy-save-btn.phb-saved{background:#f97316;color:#fff}
      #phb-etsy-modal{position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px}
      #phb-etsy-modal .phb-card{width:min(460px,96vw);max-height:92vh;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 24px 80px rgba(15,23,42,.35);border:1px solid rgba(15,23,42,.12)}
      #phb-etsy-modal .phb-head{display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid #e5e7eb}
      #phb-etsy-modal .phb-body{padding:14px;display:flex;flex-direction:column;gap:12px}
      #phb-etsy-modal .phb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      #phb-etsy-modal input,#phb-etsy-modal textarea{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;font-size:12px;outline:none}
      #phb-etsy-modal textarea{min-height:74px;resize:vertical}
      #phb-etsy-modal .phb-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid #cbd5e1;border-radius:999px;padding:6px 9px;background:#f8fafc;color:#334155;font-size:12px;font-weight:800;cursor:pointer}
      #phb-etsy-modal .phb-chip input{width:auto;margin:0}
      #phb-etsy-modal .phb-status{display:inline-flex;align-items:center;border-radius:999px;padding:6px 9px;background:#ede9fe;color:#6d28d9;font-size:12px;font-weight:900}
      #phb-etsy-modal button{border:0;border-radius:8px;padding:9px 12px;font-size:12px;font-weight:900;cursor:pointer}
      #phb-etsy-modal .phb-cancel{background:#e2e8f0;color:#334155}
      #phb-etsy-modal .phb-save{background:#16a34a;color:#fff}
      #phb-etsy-modal .phb-add{background:#f97316;color:#fff;white-space:nowrap}
    `;
    document.head.appendChild(style);
  }

  // ============ PAYLOAD & API ============
  function buildEtsySavePayload(user) {
    const listingId = getEtsyListingId();
    const image = getSelectedEtsyImage();
    const title = getEtsyTitle();
    const description = getEtsyDescription();
    const images = collectEtsyImages();
    const meta = {
      listingTags: [],
      images: images.length ? images : [image].filter(Boolean),
      description,
      sentToGpts: true,
      sent_to_gpts: true,
      sourceUrl: location.href,
      savedBy: 'podhub-gpts-extension',
      savedAt: new Date().toISOString(),
      owner: user || null
    };
    return {
      listingId,
      image,
      title,
      description,
      spyPayload: {
        id: listingId,
        asin: listingId,
        title,
        image,
        type: 'T-Shirt',
        niche: '',
        tags: meta,
        sold24h: 0,
        totalSold: 0,
        totalViews: 0,
        keyword: 'podhub-gpts'
      },
      queuePayload: {
        source: 'etsy-spy',
        images: [{
          url: image,
          sourceImageUrl: image,
          title,
          prompt: title,
          assetId: listingId,
          id: listingId,
          asin: listingId,
          etsyListingId: listingId,
          sourceUrl: location.href,
          description
        }]
      }
    };
  }

  // ============ HARDWARE FINGERPRINT (Device Binding) ============
  let cachedMachineId = null;
  async function getMachineFingerprint() {
    try {
      if (cachedMachineId) return cachedMachineId;
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      let gpu = 'unknown_gpu';
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) gpu = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || gpu;
      }
      const components = [
        navigator.platform || '',
        navigator.hardwareConcurrency || '',
        navigator.deviceMemory || '',
        screen.width + 'x' + screen.height + 'x' + (screen.colorDepth || ''),
        gpu
      ];
      const rawString = components.join('###');
      const msgBuffer = new TextEncoder().encode(rawString);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      cachedMachineId = 'PC_' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 24);
      return cachedMachineId;
    } catch(e) {
      cachedMachineId = 'PC_FB_' + (navigator.userAgent.length + screen.width);
      return cachedMachineId;
    }
  }

  async function postEtsySave(payload, licenseToken) {
    const headers = { 'Content-Type': 'application/json' };
    headers.Authorization = 'Bearer ' + licenseToken;
    const machineId = await getMachineFingerprint();
    headers['X-Machine-ID'] = machineId;

    const saveSpy = await fetch(getOrigin() + '/api/local-spy/etsy/save', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload.spyPayload)
    });
    const spyJson = await saveSpy.json().catch(() => ({}));
    if (saveSpy.status === 401 && (spyJson?.error === 'SESSION_KICKED' || /thiết bị khác|device/i.test(spyJson?.message || ''))) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(['phb_license_token','phb_license_user']);
      }
      localStorage.removeItem('phb_license_token');
      alert('🚨 Tài khoản của bạn đã được đăng nhập trên một thiết bị/máy tính khác! Bạn đã bị đăng xuất.');
      window.location.reload();
      throw new Error('SESSION_KICKED');
    }
    if (!saveSpy.ok || spyJson?.success === false) {
      throw new Error(spyJson?.error || spyJson?.message || 'Luu Etsy Spy that bai');
    }

    const saveQueue = await fetch(getQueueApi() + '/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload.queuePayload)
    });
    const queueJson = await saveQueue.json().catch(() => ({}));
    if (saveQueue.status === 401 && (queueJson?.error === 'SESSION_KICKED' || /thiết bị khác|device/i.test(queueJson?.message || ''))) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(['phb_license_token','phb_license_user']);
      }
      localStorage.removeItem('phb_license_token');
      alert('🚨 Tài khoản của bạn đã được đăng nhập trên một thiết bị/máy tính khác! Bạn đã bị đăng xuất.');
      window.location.reload();
      throw new Error('SESSION_KICKED');
    }
    if (!saveQueue.ok || queueJson?.success === false) {
      throw new Error(queueJson?.error || queueJson?.message || 'Gui queue GPTs that bai');
    }

    return { spy: spyJson, queue: queueJson };
  }

  async function saveEtsyListing(btn) {
    const listingId = getEtsyListingId();
    const image = getSelectedEtsyImage();
    const title = getEtsyTitle();
    if (!listingId || !image || !title) {
      alert('Chua lay duoc listing ID, anh hoac title tren trang Etsy nay.');
      return;
    }
    const session=await getLicenseSession();
    if(!session.token) throw new Error('Vui lòng kích hoạt License Key trong extension trước.');
    const payload=buildEtsySavePayload(session.user);
    btn.disabled=true;
    btn.textContent='Saving...';
    try {
      await postEtsySave(payload,session.token);
      markListingSaved(listingId,session.user);
      btn.textContent='Saved';
      btn.classList.add('phb-saved');
    } catch(e) {
      btn.textContent='Save';
      btn.style.background='#dc2626';
      setTimeout(()=>{btn.style.background='';},1800);
      throw e;
    } finally {
      btn.disabled=false;
    }
  }

  // ============ BUTTON INJECTION ============
  function injectEtsySaveButton() {
    if (!location.pathname.includes('/listing/')) return;
    const listingId = getEtsyListingId();
    if (!listingId) return;
    upsertEtsySaveStyles();

    const wrapper = document.querySelector('#photos') ||
      document.querySelector('.image-wrapper') ||
      document.querySelector('[data-listing-page-cart]');
    if (!wrapper) return;

    const existing = document.getElementById('phb-etsy-save-btn');
    if (existing && existing.getAttribute('data-listing-id') === listingId) return;
    if (existing) existing.remove();

    if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative';

    const btn = document.createElement('button');
    btn.id = 'phb-etsy-save-btn';
    btn.type = 'button';
    btn.textContent = isListingSaved(listingId) ? 'Saved' : 'Save';
    if (isListingSaved(listingId)) btn.classList.add('phb-saved');
    btn.setAttribute('data-listing-id', listingId);
    btn.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      if (isListingSaved(listingId)) return;
      saveEtsyListing(btn).catch(e=>alert('Save thất bại: '+(e?.message||e)));
    };
    wrapper.appendChild(btn);
  }

  // ============ INIT ============
  function initEtsyListingSaver() {
    setTimeout(injectEtsySaveButton, 800);
    // Poll de handle SPA navigation (Etsy thay doi URL khong reload trang)
    // Clear interval sau khi button da inject thanh cong tren listing page
    let pollInterval = setInterval(() => {
      injectEtsySaveButton();
      // Neu dang o trang listing va button da co -> giu interval de catch navigation
      // Neu khong phai trang listing -> khong lam gi
    }, 1500);

    // Theo doi navigation de clear button cu khi user chuyen trang
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        const old = document.getElementById('phb-etsy-save-btn');
        if (old) old.remove();
        setTimeout(injectEtsySaveButton, 800);
      }
    }, 600);
  }

  initEtsyListingSaver();
})();
