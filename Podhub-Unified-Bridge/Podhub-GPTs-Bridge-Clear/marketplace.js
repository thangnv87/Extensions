'use strict';

(function () {
  if (window.__podhubMarketplaceCaptureV2) return;
  window.__podhubMarketplaceCaptureV2 = true;

  const host = location.hostname.toLowerCase();
  const marketplace = host.includes('etsy.com') ? 'etsy' : host.includes('amazon.com') ? 'amazon' : '';
  if (!marketplace) return;

  const selected = new Map();

  function clean(value, max = 1000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function absolute(url) {
    try { return new URL(url, location.href).href.split('?')[0]; } catch (_) { return ''; }
  }

  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function toast(message, type = 'info') {
    document.getElementById('pub-market-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'pub-market-toast';
    el.textContent = message;
    el.style.cssText = [
      'position:fixed','right:16px','bottom:84px','z-index:2147483647','max-width:380px',
      'padding:10px 12px','border-radius:10px','box-shadow:0 12px 36px #0005',
      `background:${type === 'error' ? '#991b1b' : type === 'success' ? '#166534' : '#1e293b'}`,
      'color:#fff','font:800 13px/1.4 system-ui,Arial,sans-serif'
    ].join(';');
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  async function saveListing(item) {
    const response = await send({type: 'PUB_SAVE_MARKETPLACE_LISTING', payload: {
      marketplace,
      external_id: item.external_id,
      product_url: item.product_url,
      title: item.title,
      price: item.price || '',
      currency: item.currency || '',
      image_url: item.image_url,
      seller_name: item.seller_name || '',
      shop_url: item.shop_url || '',
      source_page: item.source_page,
      raw_payload: {
        ...item,
        captured_at: new Date().toISOString(),
        page_title: document.title,
        location: location.href
      }
    }});
    if (!response?.ok) throw new Error(response?.error || 'Không lưu được listing.');
    return response.data;
  }

  function saveSummary(results) {
    const values = results.map(result => result.value || {}).filter(Boolean);
    const added = values.reduce((sum, value) => sum + Number(value.added || 0), 0);
    const spySynced = values.filter(value => value.spy_synced).length;
    return {added, spySynced};
  }

  async function runPool(items, worker, concurrency = 3) {
    const queue = [...items];
    const results = [];
    async function consume() {
      while (queue.length) {
        const item = queue.shift();
        try { results.push({item, ok: true, value: await worker(item)}); }
        catch (error) { results.push({item, ok: false, error}); }
      }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, consume));
    return results;
  }

  function ensureStyles() {
    if (document.getElementById('pub-market-style')) return;
    const style = document.createElement('style');
    style.id = 'pub-market-style';
    style.textContent = `
      .pub-market-pick{position:absolute!important;top:8px!important;left:8px!important;z-index:2147483000!important;border:2px solid #fff!important;border-radius:8px!important;background:#334155!important;color:#fff!important;padding:6px 9px!important;font:900 12px system-ui,Arial,sans-serif!important;box-shadow:0 5px 16px rgba(15,23,42,.35)!important;cursor:pointer!important}
      .pub-market-pick[data-selected="1"]{background:#16a34a!important}
      #pub-market-toolbar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483646;display:none;align-items:center;gap:8px;padding:9px 11px;border-radius:12px;background:#0f172a;color:#fff;box-shadow:0 14px 42px rgba(15,23,42,.4);font:800 13px system-ui,Arial,sans-serif}
      #pub-market-toolbar button,#pub-market-product-save{border:0;border-radius:8px;padding:8px 11px;font-weight:900;cursor:pointer}
      #pub-market-save-selected,#pub-market-product-save{background:#16a34a;color:#fff}
      #pub-market-clear-selected{background:#334155;color:#fff}
      #pub-market-product-save{position:fixed;right:16px;bottom:18px;z-index:2147483646;box-shadow:0 12px 36px rgba(15,23,42,.35);font:900 13px system-ui,Arial,sans-serif}
    `;
    document.head.appendChild(style);
  }

  function toolbar() {
    let el = document.getElementById('pub-market-toolbar');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'pub-market-toolbar';
    el.innerHTML = '<span id="pub-market-count">Đã chọn 0</span><button id="pub-market-clear-selected" type="button">Bỏ chọn</button><button id="pub-market-save-selected" type="button">Lưu vào Podhub</button>';
    document.documentElement.appendChild(el);
    el.querySelector('#pub-market-clear-selected').onclick = () => {
      selected.clear();
      document.querySelectorAll('.pub-market-pick[data-selected="1"]').forEach(button => {
        button.dataset.selected = '0';
        button.textContent = 'Chọn';
      });
      refreshToolbar();
    };
    el.querySelector('#pub-market-save-selected').onclick = saveSelected;
    return el;
  }

  function refreshToolbar() {
    const el = toolbar();
    el.style.display = selected.size ? 'flex' : 'none';
    el.querySelector('#pub-market-count').textContent = `Đã chọn ${selected.size}`;
  }

  async function saveSelected() {
    const button = document.getElementById('pub-market-save-selected');
    const items = [...selected.values()];
    if (!items.length || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Đang lưu...';
    const results = await runPool(items, saveListing, 3);
    const ok = results.filter(result => result.ok);
    ok.forEach(result => selected.delete(result.item.external_id));
    button.disabled = false;
    button.textContent = 'Lưu vào Podhub';
    refreshToolbar();
    const summary = saveSummary(ok);
    const failed = results.length - ok.length;
    const message = `Bridge nhận ${ok.length} listing · ${summary.added} job mới · Spy đã lưu ${summary.spySynced}/${ok.length}${failed ? ` · lỗi ${failed}` : ''}.`;
    toast(message, failed || summary.spySynced !== ok.length ? 'error' : 'success');
  }

  function etsyId(url = location.href) {
    return /\/listing\/(\d{6,})/i.exec(url)?.[1] || '';
  }

  function normalizeEtsyImage(src) {
    const raw = String(src || '').trim();
    if (!raw) return '';
    return (raw.startsWith('//') ? `https:${raw}` : raw).replace(/il_\d+x(?:\d+|N)/g, 'il_fullxfull');
  }

  function etsyCard(anchor) {
    const card = anchor.closest('li') || anchor.closest('[data-listing-id]') || anchor.closest('.v2-listing-card') || anchor.closest('div');
    const img = card?.querySelector('img[src*="etsystatic"],img[data-src*="etsystatic"],img');
    const productUrl = absolute(anchor.href);
    return {
      marketplace: 'etsy',
      external_id: etsyId(productUrl) || card?.getAttribute('data-listing-id') || '',
      product_url: productUrl,
      title: clean(img?.alt || card?.querySelector('h2,h3,[data-listing-card-title]')?.textContent || anchor.getAttribute('title'), 500),
      price: clean(card?.querySelector('.currency-value,.wt-text-title-03')?.textContent, 80),
      currency: clean(card?.querySelector('.currency-symbol')?.textContent, 20),
      image_url: normalizeEtsyImage(img?.currentSrc || img?.getAttribute('data-src') || img?.src),
      source_page: 'listing_card'
    };
  }

  function etsyProduct() {
    const productUrl = absolute(document.querySelector('link[rel="canonical"]')?.href || location.href);
    const image = normalizeEtsyImage(document.querySelector('meta[property="og:image"]')?.getAttribute('content') || document.querySelector('img[src*="etsystatic"]')?.src);
    return {
      marketplace: 'etsy',
      external_id: etsyId(productUrl),
      product_url: productUrl,
      title: clean(document.querySelector('h1[data-buy-box-listing-title],h1')?.textContent || document.querySelector('meta[property="og:title"]')?.getAttribute('content'), 500),
      price: clean(document.querySelector('[data-buy-box-region="price"],.wt-text-title-03,.currency-value')?.textContent, 80),
      image_url: image,
      seller_name: clean(document.querySelector('[data-buy-box-region="shop-name"],a[href*="/shop/"]')?.textContent, 240),
      shop_url: absolute(document.querySelector('a[href*="/shop/"]')?.href || ''),
      source_page: 'product'
    };
  }

  function asinFrom(value) {
    const raw = String(value || '').trim().toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(raw)) return raw;
    return /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i.exec(raw)?.[1]?.toUpperCase() || '';
  }

  function normalizeAmazonImage(src) {
    return String(src || '').trim().replace(/\._[^.]+_\.(?=[a-z]{3,4}(?:\?|$))/i, '.');
  }

  function amazonCard(card) {
    const link = card.querySelector('h2 a[href*="/dp/"],a[href*="/dp/"],a[href*="/gp/product/"]');
    const asin = asinFrom(card.getAttribute('data-asin')) || asinFrom(link?.href);
    const img = card.querySelector('img.s-image,img[data-image-latency],img');
    return {
      marketplace: 'amazon',
      external_id: asin,
      product_url: asin ? `https://www.amazon.com/dp/${asin}` : absolute(link?.href || ''),
      title: clean(card.querySelector('h2 span,h2,[data-cy="title-recipe"]')?.textContent || img?.alt, 500),
      price: clean(card.querySelector('.a-price .a-offscreen')?.textContent, 80),
      image_url: normalizeAmazonImage(img?.currentSrc || img?.src),
      source_page: 'listing_card'
    };
  }

  function amazonProduct() {
    const asin = asinFrom(location.href);
    return {
      marketplace: 'amazon',
      external_id: asin,
      product_url: asin ? `https://www.amazon.com/dp/${asin}` : absolute(location.href),
      title: clean(document.querySelector('#productTitle')?.textContent || document.querySelector('meta[property="og:title"]')?.getAttribute('content'), 500),
      price: clean(document.querySelector('.a-price .a-offscreen,#priceblock_ourprice,#priceblock_dealprice')?.textContent, 80),
      image_url: normalizeAmazonImage(document.querySelector('#landingImage')?.getAttribute('src') || document.querySelector('meta[property="og:image"]')?.getAttribute('content')),
      seller_name: clean(document.querySelector('#bylineInfo')?.textContent, 240),
      shop_url: absolute(document.querySelector('#bylineInfo')?.getAttribute('href') || ''),
      source_page: 'product'
    };
  }

  function addPickButton(card, item) {
    if (!card || !item.external_id || !item.title || !item.image_url) return;
    if (card.querySelector(`.pub-market-pick[data-id="${CSS.escape(item.external_id)}"]`)) return;
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pub-market-pick';
    button.dataset.id = item.external_id;
    button.dataset.selected = selected.has(item.external_id) ? '1' : '0';
    button.textContent = selected.has(item.external_id) ? 'Đã chọn' : 'Chọn';
    button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      if (selected.has(item.external_id)) {
        selected.delete(item.external_id);
        button.dataset.selected = '0';
        button.textContent = 'Chọn';
      } else {
        selected.set(item.external_id, item);
        button.dataset.selected = '1';
        button.textContent = 'Đã chọn';
      }
      refreshToolbar();
    };
    card.appendChild(button);
  }

  function scanCards() {
    ensureStyles();
    if (marketplace === 'etsy') {
      document.querySelectorAll('a[href*="/listing/"]').forEach(anchor => {
        if (anchor.dataset.pubMarketScanned === '1') return;
        anchor.dataset.pubMarketScanned = '1';
        addPickButton(anchor.closest('li') || anchor.closest('[data-listing-id]') || anchor.closest('.v2-listing-card') || anchor.closest('div'), etsyCard(anchor));
      });
    } else {
      document.querySelectorAll('[data-component-type="s-search-result"][data-asin],div.s-result-item[data-asin]').forEach(card => {
        if (card.dataset.pubMarketScanned === '1') return;
        card.dataset.pubMarketScanned = '1';
        addPickButton(card, amazonCard(card));
      });
    }
  }

  function mountProductButton() {
    const item = marketplace === 'etsy' ? etsyProduct() : amazonProduct();
    if (!item.external_id || !item.title || !item.image_url || document.getElementById('pub-market-product-save')) return;
    const button = document.createElement('button');
    button.id = 'pub-market-product-save';
    button.type = 'button';
    button.textContent = 'Lưu Podhub';
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = 'Đang lưu...';
      try {
        const saved = await saveListing(item);
        toast(`Đã đưa vào Bridge · ${saved.added || 0} job mới · ${saved.spy_synced ? `${marketplace === 'etsy' ? 'Etsy' : 'Amazon'} Spy đã lưu` : 'Spy chưa đồng bộ'}.`, saved.spy_synced ? 'success' : 'error');
        button.textContent = 'Đã lưu';
      } catch (error) {
        toast(error.message || 'Không lưu được listing.', 'error');
        button.textContent = 'Lưu Podhub';
      } finally {
        button.disabled = false;
      }
    };
    document.documentElement.appendChild(button);
  }

  ensureStyles();
  toolbar();
  scanCards();
  mountProductButton();
  const observer = new MutationObserver(() => {
    clearTimeout(window.__pubMarketScanTimer);
    window.__pubMarketScanTimer = setTimeout(() => {
      scanCards();
      mountProductButton();
    }, 300);
  });
  observer.observe(document.documentElement, {childList: true, subtree: true});
})();
