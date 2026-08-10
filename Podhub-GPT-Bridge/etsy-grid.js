(function () {
  'use strict';
  if (!/(^|\.)etsy\.com$/i.test(location.hostname)) return;
  if (document.getElementById('ft-etsy-grid-init')) return;
  const marker = document.createElement('meta');
  marker.id = 'ft-etsy-grid-init';
  document.head.appendChild(marker);

  const shared = window.PodhubMarketplace;
  if (!shared) return;
  const selected = new Map();

  function normalizeImage(src) {
    const raw = String(src || '').trim();
    if (!raw) return '';
    const absolute = raw.startsWith('//') ? 'https:' + raw : raw;
    return absolute.replace(/il_\d+x(?:\d+|N)/g, 'il_fullxfull');
  }

  function listingIdFromUrl(url) {
    return String(url || '').match(/\/listing\/(\d{6,})/i)?.[1] || '';
  }

  function findCard(anchor) {
    return anchor.closest('li') ||
      anchor.closest('[data-listing-id]') ||
      anchor.closest('.v2-listing-card') ||
      anchor.closest('div');
  }

  function extractCard(anchor, card) {
    const listingId = listingIdFromUrl(anchor.href);
    const imageEl = card.querySelector('img[src*="etsystatic"], img[data-src*="etsystatic"], img');
    const image = normalizeImage(imageEl?.currentSrc || imageEl?.getAttribute('data-src') || imageEl?.src);
    const title = shared.cleanText(
      imageEl?.alt ||
      card.querySelector('h2, h3, [data-listing-card-title]')?.textContent ||
      anchor.getAttribute('title'),
      500
    );
    return {
      listingId,
      title,
      image,
      url: anchor.href.split('?')[0]
    };
  }

  function ensureStyles() {
    if (document.getElementById('ft-etsy-grid-style')) return;
    const style = document.createElement('style');
    style.id = 'ft-etsy-grid-style';
    style.textContent = `
      .ft-etsy-pick{position:absolute!important;top:8px!important;left:8px!important;z-index:20!important;border:2px solid #fff!important;border-radius:8px!important;background:#4f46e5!important;color:#fff!important;padding:6px 9px!important;font:800 12px Arial,sans-serif!important;box-shadow:0 4px 15px rgba(15,23,42,.3)!important;cursor:pointer!important}
      .ft-etsy-pick[data-selected="1"]{background:#16a34a!important}
      #ft-etsy-toolbar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483645;display:none;align-items:center;gap:8px;padding:9px 11px;border-radius:12px;background:#0f172a;color:#fff;box-shadow:0 14px 42px rgba(15,23,42,.4);font:700 13px Arial,sans-serif}
      #ft-etsy-toolbar button{border:0;border-radius:8px;padding:8px 11px;font-weight:800;cursor:pointer}
      #ft-etsy-save-selected{background:#16a34a;color:#fff}
      #ft-etsy-clear-selected{background:#334155;color:#fff}
    `;
    document.head.appendChild(style);
  }

  function ensureToolbar() {
    let toolbar = document.getElementById('ft-etsy-toolbar');
    if (toolbar) return toolbar;
    toolbar = document.createElement('div');
    toolbar.id = 'ft-etsy-toolbar';
    toolbar.innerHTML = `
      <span id="ft-etsy-count">Đã chọn 0</span>
      <button id="ft-etsy-clear-selected" type="button">Bỏ chọn</button>
      <button id="ft-etsy-save-selected" type="button">Lưu vào PodHub</button>
    `;
    document.body.appendChild(toolbar);
    toolbar.querySelector('#ft-etsy-clear-selected').onclick = () => {
      selected.clear();
      document.querySelectorAll('.ft-etsy-pick[data-selected="1"]').forEach(button => {
        button.dataset.selected = '0';
        button.textContent = 'Chọn';
      });
      refreshToolbar();
    };
    toolbar.querySelector('#ft-etsy-save-selected').onclick = saveSelected;
    return toolbar;
  }

  function refreshToolbar() {
    const toolbar = ensureToolbar();
    toolbar.style.display = selected.size ? 'flex' : 'none';
    toolbar.querySelector('#ft-etsy-count').textContent = `Đã chọn ${selected.size}`;
  }

  async function saveOne(item) {
    const metadata = {
      listingTags: [],
      images: [item.image],
      description: '',
      podhubTags: [],
      sentToGpts: true,
      sent_to_gpts: true,
      sourceUrl: item.url,
      savedBy: 'podhub-gpts-extension',
      savedAt: new Date().toISOString()
    };
    await shared.request('/api/local-spy/etsy/save', {
      method: 'POST',
      body: JSON.stringify({
        id: item.listingId,
        asin: item.listingId,
        title: item.title,
        image: item.image,
        type: 'T-Shirt',
        niche: '',
        tags: metadata,
        sold24h: 0,
        totalSold: 0,
        totalViews: 0,
        keyword: 'podhub-gpts'
      })
    });
    return shared.request('/api/ext-queue/jobs', {
      method: 'POST',
      body: JSON.stringify({
        source: 'etsy-spy',
        images: [{
          url: item.image,
          sourceImageUrl: item.image,
          title: item.title,
          prompt: item.title,
          assetId: item.listingId,
          id: item.listingId,
          etsyListingId: item.listingId,
          sourceUrl: item.url
        }]
      })
    });
  }

  async function saveSelected() {
    const button = document.getElementById('ft-etsy-save-selected');
    const items = [...selected.values()];
    if (!items.length || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Đang lưu...';
    const results = await shared.runPool(items, saveOne, 3);
    const successful = results.filter(result => result.ok);
    successful.forEach(result => selected.delete(result.item.listingId));
    button.disabled = false;
    button.textContent = 'Lưu vào PodHub';
    refreshToolbar();
    const failed = results.length - successful.length;
    shared.toast(
      failed ? `Đã lưu ${successful.length}, lỗi ${failed} sản phẩm Etsy.` : `Đã lưu ${successful.length} sản phẩm Etsy.`,
      failed ? 'error' : 'success'
    );
  }

  function scanCards() {
    ensureStyles();
    document.querySelectorAll('a[href*="/listing/"]').forEach(anchor => {
      if (anchor.dataset.ftEtsyScanned === '1') return;
      const card = findCard(anchor);
      const item = extractCard(anchor, card);
      if (!card || !item.listingId || !item.title || !item.image) return;
      anchor.dataset.ftEtsyScanned = '1';
      if (card.querySelector(`.ft-etsy-pick[data-listing-id="${item.listingId}"]`)) return;
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ft-etsy-pick';
      button.dataset.listingId = item.listingId;
      button.dataset.selected = selected.has(item.listingId) ? '1' : '0';
      button.textContent = selected.has(item.listingId) ? 'Đã chọn' : 'Chọn';
      button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        if (selected.has(item.listingId)) {
          selected.delete(item.listingId);
          button.dataset.selected = '0';
          button.textContent = 'Chọn';
        } else {
          selected.set(item.listingId, item);
          button.dataset.selected = '1';
          button.textContent = 'Đã chọn';
        }
        refreshToolbar();
      };
      card.appendChild(button);
    });
  }

  ensureToolbar();
  scanCards();
  const observer = new MutationObserver(() => {
    clearTimeout(window.__ftEtsyScanTimer);
    window.__ftEtsyScanTimer = setTimeout(scanCards, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
