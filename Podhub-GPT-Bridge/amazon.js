(function () {
  'use strict';
  if (!/(^|\.)amazon\.com$/i.test(location.hostname)) return;
  if (document.getElementById('ft-amazon-init')) return;
  const marker = document.createElement('meta');
  marker.id = 'ft-amazon-init';
  document.head.appendChild(marker);

  const shared = window.PodhubMarketplace;
  if (!shared) return;
  const selected = new Map();

  function asinFrom(value) {
    const direct = String(value || '').trim().toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(direct)) return direct;
    return direct.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() || '';
  }

  function normalizeImage(src) {
    const raw = String(src || '').trim();
    if (!raw) return '';
    return raw.replace(/\._[^.]+_\.(?=[a-z]{3,4}(?:\?|$))/i, '.');
  }

  function extractCard(card) {
    const link = card.querySelector('h2 a[href*="/dp/"], a[href*="/dp/"], a[href*="/gp/product/"]');
    const asin = asinFrom(card.getAttribute('data-asin')) || asinFrom(link?.href);
    const imageEl = card.querySelector('img.s-image, img[data-image-latency], img');
    const title = shared.cleanText(
      card.querySelector('h2 span, h2, [data-cy="title-recipe"]')?.textContent || imageEl?.alt,
      500
    );
    const image = normalizeImage(imageEl?.currentSrc || imageEl?.src);
    const price = shared.cleanText(card.querySelector('.a-price .a-offscreen')?.textContent, 80);
    const rating = shared.cleanText(card.querySelector('.a-icon-alt')?.textContent, 80);
    const reviews = shared.cleanText(
      card.querySelector('[aria-label$="ratings"], a[href*="customerReviews"] span')?.textContent,
      80
    );
    return {
      asin,
      title,
      image,
      price,
      rating,
      reviews,
      url: link ? new URL(link.href, location.origin).href.split('?')[0] : `${location.origin}/dp/${asin}`
    };
  }

  function ensureStyles() {
    if (document.getElementById('ft-amazon-style')) return;
    const style = document.createElement('style');
    style.id = 'ft-amazon-style';
    style.textContent = `
      .ft-amazon-pick{position:absolute!important;top:8px!important;left:8px!important;z-index:100!important;border:2px solid #fff!important;border-radius:8px!important;background:#4f46e5!important;color:#fff!important;padding:6px 9px!important;font:800 12px Arial,sans-serif!important;box-shadow:0 4px 15px rgba(15,23,42,.3)!important;cursor:pointer!important}
      .ft-amazon-pick[data-selected="1"]{background:#16a34a!important}
      #ft-amazon-toolbar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483645;display:none;align-items:center;gap:8px;padding:9px 11px;border-radius:12px;background:#0f172a;color:#fff;box-shadow:0 14px 42px rgba(15,23,42,.4);font:700 13px Arial,sans-serif}
      #ft-amazon-toolbar button{border:0;border-radius:8px;padding:8px 11px;font-weight:800;cursor:pointer}
      #ft-amazon-save-selected{background:#16a34a;color:#fff}
      #ft-amazon-clear-selected{background:#334155;color:#fff}
    `;
    document.head.appendChild(style);
  }

  function ensureToolbar() {
    let toolbar = document.getElementById('ft-amazon-toolbar');
    if (toolbar) return toolbar;
    toolbar = document.createElement('div');
    toolbar.id = 'ft-amazon-toolbar';
    toolbar.innerHTML = `
      <span id="ft-amazon-count">Đã chọn 0</span>
      <button id="ft-amazon-clear-selected" type="button">Bỏ chọn</button>
      <button id="ft-amazon-save-selected" type="button">Lưu vào PodHub</button>
    `;
    document.body.appendChild(toolbar);
    toolbar.querySelector('#ft-amazon-clear-selected').onclick = () => {
      selected.clear();
      document.querySelectorAll('.ft-amazon-pick[data-selected="1"]').forEach(button => {
        button.dataset.selected = '0';
        button.textContent = 'Chọn';
      });
      refreshToolbar();
    };
    toolbar.querySelector('#ft-amazon-save-selected').onclick = saveSelected;
    return toolbar;
  }

  function refreshToolbar() {
    const toolbar = ensureToolbar();
    toolbar.style.display = selected.size ? 'flex' : 'none';
    toolbar.querySelector('#ft-amazon-count').textContent = `Đã chọn ${selected.size}`;
  }

  async function saveOne(item) {
    await shared.request('/api/local-spy/amazon/save', {
      method: 'POST',
      body: JSON.stringify({
        asin: item.asin,
        id: item.asin,
        title: item.title,
        image: item.image,
        image_url: item.image,
        price: item.price,
        rating: item.rating,
        reviews: item.reviews,
        source: 'amazon-extension',
        sourceUrl: item.url,
        type: 'T-Shirt'
      })
    });
    return shared.request('/api/ext-queue/jobs', {
      method: 'POST',
      body: JSON.stringify({
        source: 'amazon-spy',
        images: [{
          url: item.image,
          sourceImageUrl: item.image,
          title: item.title,
          prompt: item.title,
          assetId: item.asin,
          asin: item.asin,
          amazonAsin: item.asin,
          sourceUrl: item.url
        }]
      })
    });
  }

  async function saveSelected() {
    const button = document.getElementById('ft-amazon-save-selected');
    const items = [...selected.values()];
    if (!items.length || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Đang lưu...';
    const results = await shared.runPool(items, saveOne, 3);
    const successful = results.filter(result => result.ok);
    successful.forEach(result => selected.delete(result.item.asin));
    button.disabled = false;
    button.textContent = 'Lưu vào PodHub';
    refreshToolbar();
    const failed = results.length - successful.length;
    shared.toast(
      failed ? `Đã lưu ${successful.length}, lỗi ${failed} sản phẩm Amazon.` : `Đã lưu ${successful.length} sản phẩm Amazon.`,
      failed ? 'error' : 'success'
    );
  }

  function scanCards() {
    ensureStyles();
    document.querySelectorAll('[data-component-type="s-search-result"][data-asin], div.s-result-item[data-asin]').forEach(card => {
      if (card.dataset.ftAmazonScanned === '1') return;
      const item = extractCard(card);
      if (!item.asin || !item.title || !item.image) return;
      card.dataset.ftAmazonScanned = '1';
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ft-amazon-pick';
      button.dataset.asin = item.asin;
      button.dataset.selected = selected.has(item.asin) ? '1' : '0';
      button.textContent = selected.has(item.asin) ? 'Đã chọn' : 'Chọn';
      button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        if (selected.has(item.asin)) {
          selected.delete(item.asin);
          button.dataset.selected = '0';
          button.textContent = 'Chọn';
        } else {
          selected.set(item.asin, item);
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
    clearTimeout(window.__ftAmazonScanTimer);
    window.__ftAmazonScanTimer = setTimeout(scanCards, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
