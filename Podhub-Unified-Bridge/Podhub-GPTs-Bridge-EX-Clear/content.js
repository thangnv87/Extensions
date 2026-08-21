'use strict';

(function () {
  if (window.__podhubUnifiedBridge) return;
  window.__podhubUnifiedBridge = true;

  const MODULES = [
    {id: 'clone', label: 'Clone'},
    {id: 'redesign', label: 'Redesign'},
    {id: 'mockup', label: 'Mockup'}
  ];
  const DATA_ORIGIN = 'https://ex.podhub.space';
  const MIN_GPT_IMAGE_BYTES = 30 * 1024;
  const CLONE_PROMPT = `Clone chính xác design từ ảnh này thành flat artwork chính diện. Trước khi clone, phân tích kỹ text, typography, màu sắc, bố cục, tỷ lệ, texture và chi tiết, đồng thời loại bỏ ảnh hưởng của mockup như ánh sáng, nếp nhăn, texture vải, góc nghiêng và perspective.

Giữ design sát bản gốc nhất, không redesign, không thêm/bớt chi tiết, không đổi màu, không tự thêm outline/stroke/viền cho text hoặc artwork.

Output 1:1, high-resolution, design chính giữa, giữ đúng tỷ lệ, trên nền solid tương phản dễ tách; không transparent.`;
  const CLONE_REMOVE_BACKGROUND_PROMPT = 'Xóa toàn bộ background khỏi thiết kế này, bao gồm màu nền. Giữ nguyên chính xác artwork gốc, không vẽ lại, không chỉnh sửa bất kỳ màu nào khác. Giữ nguyên tất cả các màu (đỏ, vàng, trắng, be, v.v.) và mọi chi tiết. Không thêm yếu tố mới, không thay đổi thiết kế. Xuất file PNG nền trong suốt, kích thước 4500×5400 px, 300 DPI.';

  let root = null;
  let launcher = null;
  let floatingStop = null;
  let activeModule = 'clone';
  let queueFilter = 'pending';
  let jobs = [];
  let selectedJobIds = new Set();
  let selectedRawAssets = new Map();
  let running = false;
  let batchRunning = false;
  let activeRun = null;
  let runnerStarted = false;
  let settings = {
    license_key: '',
    runner_id: '',
    redesign_auto_style: true,
    redesign_style_presets: [],
    redesign_custom_style: '',
    redesign_custom_styles: [],
    redesign_count: 4,
    redesign_listing_markets: [],
    clone_with_background: false,
    clone_remove_background_gpt: false,
    mockup_products: ['tumbler_20oz', 'mug_11oz'],
    mockup_custom_products: [],
    listing_markets: ['etsy'],
    mockup_count: 3,
    mockup_aspect_ratio: '16:9'
  };
  let serverConfig = null;
  let dashboardOpenPending = false;

  function send(message) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) return reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
      try {
        chrome.runtime.sendMessage(message, response => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) reject(new Error(runtimeError.message || 'EXTENSION_MESSAGE_FAILED'));
          else resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function revealDashboard() {
    dashboardOpenPending = true;
    if (!root) return false;
    root.classList.add('pub-visible');
    launcher?.classList.add('active');
    loadJobs().catch(error => setLog(error.message));
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'PUB_OPEN_DASHBOARD') return;
    const opened = revealDashboard();
    sendResponse({ok: true, opened, pending: !opened});
  });

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function jobId(job) {
    return job?.id || job?.job_id || job?.raw_design_job_id || '';
  }

  function imageUrl(job) {
    return job?.thumbnail_url || job?.image_url || job?.mockup_url || job?.source_image_url || job?.sourceImageUrl || job?.asset_url || '';
  }

  function titleOf(job) {
    return job?.product_title || job?.listing_title || job?.marketplace_title || job?.source_title || job?.title || '';
  }

  function canonicalJobName(value) {
    const raw = String(value || '').split('/').pop().replace(/\.[^.]+$/, '').split('__')[0].trim();
    const normalized = raw.replace(/_/g, '-');
    const etsy = normalized.match(/(?:^|-)((?:raw-)?etsy)-(\d{6,})(?:-v(\d+))?/i);
    if (etsy) return `${/^raw-/i.test(etsy[1]) ? 'RAW-' : ''}Etsy-${etsy[2]}${etsy[3] ? `-v${etsy[3]}` : ''}`;
    const amazon = normalized.match(/(?:^|-)((?:raw-)?(?:amazon|amz))-([a-z0-9]{10})(?:-v(\d+))?/i);
    if (amazon) return `${/^raw-/i.test(amazon[1]) ? 'RAW-' : ''}AMZ-${amazon[2].toUpperCase()}${amazon[3] ? `-v${amazon[3]}` : ''}`;
    return raw;
  }

  function baseJobTitle(job, index = 0) {
    const candidates = [job?.display_name, job?.canonical_filename, job?.original_name, job?.design_name, job?.name, job?.title];
    for (const value of candidates) {
      const compact = canonicalJobName(value);
      if (compact && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(compact)) return compact.slice(0, 64);
    }
    return `Job ${index + 1}`;
  }

  function shortJobTitle(job, index = 0) {
    const base = baseJobTitle(job, index).replace(/-(Clone|Redesign|Mockup)$/i, '');
    const moduleLabel = MODULES.find(item => item.id === activeModule)?.label || activeModule;
    return queueGroup(job) === 'done' ? `${base}-${moduleLabel}` : base;
  }

  function platformProductTitle(job) {
    const candidates = [
      job?.product_title,
      job?.listing_title,
      job?.marketplace_title,
      job?.source_title,
      job?.metadata?.product_title,
      job?.metadata?.title,
      job?.asset_metadata?.product_title,
      job?.asset_metadata?.listing_title,
      job?.asset_metadata?.title,
      job?.raw_payload?.product_title,
      job?.raw_payload?.title,
      job?.title
    ];
    return candidates.map(value => String(value || '').trim()).find(value => {
      if (value.length < 8 || value.length > 500) return false;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return false;
      if (/^(raw[-_])?(etsy|amazon|amz)[-_][a-z0-9]+(?:[-_]v\d+)?(?:\.[a-z0-9]+)?$/i.test(value)) return false;
      if (/\.(png|jpe?g|webp|gif|json)$/i.test(value)) return false;
      return /[a-z]{3,}\s+[a-z]{3,}/i.test(value);
    }) || '';
  }

  function resultImages(job) {
    const results = job?.results && typeof job.results === 'object' ? job.results : {};
    const rows = [
      ...(Array.isArray(results.raw_clone_assets) ? results.raw_clone_assets : []),
      ...(Array.isArray(results.raw_redesign_assets) ? results.raw_redesign_assets : []),
      ...(Array.isArray(results.mockups) ? results.mockups : [])
    ];
    return rows.map(item => ({
      asset_id: item?.asset_id || item?.id || '',
      url: item?.url || item?.cdn_url || item?.image_url || '',
      name: item?.filename || item?.canonical_filename || '',
      kind: item?.kind || ''
    })).filter(item => item.url || item.asset_id);
  }

  async function hydrateResultImage(image) {
    if (!image || image.dataset.hydrated === '1' || image.dataset.hydrating === '1') return;
    const assetId = image.dataset.assetId || '';
    const url = image.dataset.assetUrl || image.getAttribute('src') || '';
    if (!assetId && !url) return;
    image.dataset.hydrating = '1';
    const response = await send({
      type: 'PUB_FETCH_ASSET',
      source: {
        asset_id: assetId,
        url,
        name: image.dataset.assetName || image.alt || 'podhub-result.png',
        type: image.dataset.assetType || 'image/png'
      }
    });
    delete image.dataset.hydrating;
    if (response?.ok && response.data?.data_url) {
      image.src = response.data.data_url;
      image.dataset.hydrated = '1';
      image.classList.remove('pub-image-load-failed');
      return;
    }
    image.classList.add('pub-image-load-failed');
    image.title = response?.error || 'RAW_IMAGE_LOAD_FAILED';
  }

  function hydrateResultImages(container) {
    container?.querySelectorAll('img[data-pub-result-image]').forEach(image => {
      hydrateResultImage(image).catch(error => {
        image.classList.add('pub-image-load-failed');
        image.title = error.message || 'RAW_IMAGE_LOAD_FAILED';
      });
    });
  }

  function assetSource(job) {
    return {
      asset_id: job?.asset_id || job?.design_asset_id || job?.source_asset_id || job?.raw_asset_id || '',
      url: imageUrl(job),
      name: job?.filename || job?.design_name || job?.name || 'podhub-job.png',
      type: job?.mime_type || job?.content_type || 'image/png'
    };
  }

  function statusOf(job) {
    return String(job?.status || job?.state || 'queued').toLowerCase();
  }

  function queueGroup(job) {
    const status = statusOf(job);
    if (['done', 'completed', 'success'].includes(status)) return 'done';
    if (['failed', 'error', 'cancelled'].includes(status)) return 'failed';
    return 'pending';
  }

  function setLog(value) {
    const el = root?.querySelector('.pub-log');
    if (!el) return;
    const message = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const isError = /(?:^|[_:\s])(FAILED|TIMEOUT|INVALID|MISSING|ERROR)(?:$|[_:\s])|không thể|không .*được|thất bại|\blỗi\b|\bcannot\b/i.test(message);
    el.textContent = message;
    el.title = isError ? 'Có lỗi · bấm để thu gọn/mở rộng' : 'Bấm để xem đầy đủ trạng thái';
    el.classList.toggle('error', isError);
    el.classList.toggle('expanded', isError);
  }

  function accountName(user) {
    return user?.email || user?.username || user?.id || '';
  }

  function moduleList(data) {
    const modules = data?.modules || data?.config?.modules || [];
    if (Array.isArray(modules)) return modules.join(', ');
    if (modules && typeof modules === 'object') return Object.keys(modules).join(', ');
    return '';
  }

  function setAccountStatus(data) {
    const el = root?.querySelector('[data-role="account-status"]');
    if (!el) return;
    const user = accountName(data?.user);
    const modules = moduleList(data);
    const active = Boolean(data?.active || user);
    root?.classList.toggle('license-active', active);
    el.classList.toggle('active', active);
    el.textContent = active
      ? `Tài khoản ${user || 'này'} đã active${modules ? ` · ${modules}` : ''}`
      : 'Chưa kích hoạt license.';
  }

  function storageKey() {
    return 'pub_unified_settings_v1';
  }

  function loadLocalSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey()) || '{}');
      settings = {...settings, ...saved};
    } catch (_) {}
    if (!Array.isArray(settings.redesign_style_presets)) settings.redesign_style_presets = [];
    if (!Array.isArray(settings.redesign_custom_styles)) settings.redesign_custom_styles = [];
    if (!Array.isArray(settings.redesign_listing_markets)) settings.redesign_listing_markets = [];
    if (!Array.isArray(settings.mockup_products)) settings.mockup_products = [];
    if (!Array.isArray(settings.mockup_custom_products)) settings.mockup_custom_products = [];
    if (!Array.isArray(settings.listing_markets)) settings.listing_markets = [];
    if (!settings.runner_id) {
      settings.runner_id = `runner_${Math.random().toString(36).slice(2, 8)}`;
      saveLocalSettings();
    }
  }

  function saveLocalSettings() {
    localStorage.setItem(storageKey(), JSON.stringify(settings));
  }

  function selectedValues(name) {
    return Array.from(root.querySelectorAll(`input[name="${name}"]:checked`)).map(input => input.value);
  }

  function defaultStylePresets() {
    return [
      {id: 'vintage', label: 'Vintage'},
      {id: 'minimal', label: 'Minimal'},
      {id: 'retro', label: 'Retro'},
      {id: 'bold_typography', label: 'Bold Typography'}
    ];
  }

  function stylePresets() {
    const fromServer = serverConfig?.modules?.redesign?.style_presets || serverConfig?.redesign?.style_presets || [];
    return Array.isArray(fromServer) && fromServer.length ? fromServer : defaultStylePresets();
  }

  function styleById(id) {
    return stylePresets().find(item => String(item.id || item.style_id || item.value || item.label) === String(id));
  }

  function defaultProducts() {
    return [
      {id: 'tumbler_20oz', label: '20oz Tumbler'},
      {id: 'mug_11oz', label: '11oz Mug'},
      {id: 'blanket', label: 'Blanket'},
      {id: 'tshirt', label: 'T-shirt'}
    ];
  }

  function productCatalog() {
    const fromServer = serverConfig?.modules?.mockup?.product_catalog || serverConfig?.product_catalog || [];
    return Array.isArray(fromServer) && fromServer.length ? fromServer : defaultProducts();
  }

  function listingOptions() {
    const fromServer = serverConfig?.modules?.mockup?.listing_options || serverConfig?.listing_options || [];
    return Array.isArray(fromServer) && fromServer.length ? fromServer : [
      {id: 'etsy', label: 'Etsy'}, {id: 'amazon', label: 'Amazon'},
      {id: 'walmart', label: 'Walmart'}, {id: 'shopify', label: 'Shopify'}
    ];
  }

  function mockupAspectRatios() {
    const values = serverConfig?.modules?.mockup?.aspect_ratios || [];
    return Array.isArray(values) && values.length ? values : ['1:1','4:5','3:4','16:9','9:16'];
  }

  function redesignMaxStyles() {
    return Math.max(1, Math.min(30, Number(serverConfig?.modules?.redesign?.pipeline?.max_styles || serverConfig?.module_pipelines?.redesign?.max_styles || 4)));
  }

  function slugId(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);
  }

  function syncSettingsFromConfig() {
    const licenseInput = root.querySelector('#pub-license-key');
    if (licenseInput) settings.license_key = licenseInput.value.trim();
    const runnerInput = root.querySelector('#pub-runner-id');
    if (runnerInput) settings.runner_id = runnerInput.value.trim() || settings.runner_id;
    const autoStyle = root.querySelector('#pub-redesign-auto-style');
    if (autoStyle) settings.redesign_auto_style = autoStyle.checked;
    const cloneRemoveBackground = root.querySelector('#pub-clone-remove-background-gpt');
    if (cloneRemoveBackground) settings.clone_remove_background_gpt = cloneRemoveBackground.checked;
    const cloneWithBackground = root.querySelector('#pub-clone-with-background');
    if (cloneWithBackground) settings.clone_with_background = cloneWithBackground.checked;
    const customStyle = root.querySelector('#pub-redesign-custom-style');
    if (customStyle) settings.redesign_custom_style = customStyle.value.trim();
    const redesignCount = root.querySelector('#pub-redesign-count');
    if (redesignCount) settings.redesign_count = Math.max(1, Math.min(redesignMaxStyles(), Number(redesignCount.value || 4)));
    settings.redesign_style_presets = selectedValues('pub-redesign-style');
    if (!settings.redesign_auto_style) settings.redesign_count = settings.redesign_style_presets.length;
    settings.redesign_listing_markets = selectedValues('pub-redesign-market');
    const mockupCount = root.querySelector('#pub-mockup-count');
    if (mockupCount) settings.mockup_count = Math.max(1, Math.min(10, Number(mockupCount.value || 3)));
    const aspectRatio = root.querySelector('#pub-mockup-aspect-ratio');
    if (aspectRatio) settings.mockup_aspect_ratio = aspectRatio.value || '16:9';
    settings.mockup_products = selectedValues('pub-product');
    settings.listing_markets = selectedValues('pub-market');
    saveLocalSettings();
    updateRedesignStyleState();
  }

  function currentRunOptions() {
    syncSettingsFromConfig();
    if (activeModule === 'redesign' && !settings.redesign_auto_style && !settings.redesign_style_presets.length) {
      throw new Error('Chọn ít nhất một style trước khi chạy Redesign.');
    }
    return {
      runner_id: settings.runner_id,
      clone_with_background: settings.clone_with_background === true,
      clone_remove_background_gpt: settings.clone_remove_background_gpt === true,
      redesign_auto_style: settings.redesign_auto_style,
      redesign_style_presets: settings.redesign_style_presets,
      redesign_custom_style: settings.redesign_custom_style,
      redesign_custom_styles: settings.redesign_custom_styles,
      redesign_count: settings.redesign_count,
      redesign_listing_markets: settings.redesign_listing_markets,
      mockup_products: settings.mockup_products,
      mockup_custom_products: settings.mockup_custom_products,
      listing_markets: settings.listing_markets,
      mockup_count: settings.mockup_count,
      mockup_aspect_ratio: settings.mockup_aspect_ratio
    };
  }

  async function activateLicense() {
    syncSettingsFromConfig();
    if (!settings.license_key) {
      setLog('Nhập license key trước.');
      return;
    }
    const response = await send({type: 'PUB_ACTIVATE', licenseKey: settings.license_key});
    if (!response?.ok) {
      setLog(response?.error || 'Kích hoạt thất bại.');
      return;
    }
    root.querySelector('#pub-license-key').value = '';
    settings.license_key = '';
    saveLocalSettings();
    setAccountStatus({active: true, user: response.data?.user, modules: response.data?.modules});
    setLog(`Đã kích hoạt${accountName(response.data?.user) ? `: ${accountName(response.data.user)}` : ' license'}.${moduleList(response.data) ? ` Module: ${moduleList(response.data)}` : ''}`);
  }

  async function deactivateLicense() {
    if (!window.confirm('Đăng xuất license Podhub khỏi extension này?')) return;
    const button = root.querySelector('[data-action="deactivate"]');
    if (button) button.disabled = true;
    try {
      const response = await send({type: 'PUB_DEACTIVATE'});
      if (!response?.ok) throw new Error(response?.error || 'Đăng xuất thất bại.');
      root.classList.remove('license-active');
      setAccountStatus({active: false});
      setLog('Đã đăng xuất license Podhub.');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function saveSettingsFromButton() {
    syncSettingsFromConfig();
    setLog('Đã lưu cấu hình.');
  }

  async function loadJobs() {
    setLog(`Loading ${activeModule} jobs...`);
    const stateResponse = await send({type: 'PUB_GET_STATE'});
    if (stateResponse?.ok) {
      serverConfig = stateResponse.data?.config || serverConfig;
      refreshConfigUi();
    }
    const response = await send({type: 'PUB_LIST_JOBS', moduleId: activeModule});
    if (!response?.ok) {
      jobs = [];
      renderJobs();
      setLog(response?.error || 'Cannot load jobs.');
      return;
    }
    jobs = Array.isArray(response.data) ? response.data : [];
    renderJobs();
    setLog(`${activeModule}: ${jobs.length} jobs`);
  }

  async function startJob(job) {
    await refreshServerConfig();
    const response = await send({type: 'PUB_START_JOB', moduleId: activeModule, job: {...job, run_options: currentRunOptions()}});
    if (!response?.ok) {
      setLog(response?.error || 'Cannot start job.');
      return;
    }
    running = true;
    updateRunButtons();
    setLog(response.data || 'GPT opened.');
  }

  async function startJobs(selected) {
    const batch = Array.isArray(selected) ? selected.filter(Boolean) : [];
    if (batch.length <= 1) return startJob(batch[0]);
    await refreshServerConfig();
    const response = await send({type: 'PUB_START_JOBS', moduleId: activeModule, jobs: batch.map(job => ({...job, run_options: currentRunOptions()}))});
    if (!response?.ok) throw new Error(response?.error || 'Không thể mở hàng đợi đã chọn.');
    running = true;
    updateRunButtons();
    setLog(`Đã mở ${batch.length} job ${activeModule}.`);
  }

  async function runSelectedOrNext() {
    const visible = jobs.filter(job => queueFilter === 'all' || queueGroup(job) === queueFilter);
    const selected = visible.filter(job => selectedJobIds.has(jobId(job)));
    if (selected.length) return startJobs(selected);
    const job = visible[0] || null;
    if (!job) {
      await refreshServerConfig();
      const response = await send({type: 'PUB_MODULE_ACTION', moduleId: activeModule, action: 'start', runOptions: currentRunOptions()});
      if (!response?.ok) {
        setLog(response?.error || 'Không có job để chạy.');
        return;
      }
      running = true;
      updateRunButtons();
      setLog(response.data || 'GPT opened.');
      return;
    }
    await startJob(job);
  }

  async function deleteJob(job) {
    const id = jobId(job);
    if (!id) return;
    const response = await send({type: 'PUB_DELETE_JOB', moduleId: activeModule, jobId: id});
    if (!response?.ok) throw new Error(response?.error || 'Không xoá được job.');
    selectedJobIds.delete(id);
    jobs = jobs.filter(item => jobId(item) !== id);
    renderJobs();
    setLog(`Đã xoá ${shortJobTitle(job)}.`);
  }

  async function deleteSelectedJobs() {
    const selected = jobs.filter(job => selectedJobIds.has(jobId(job)));
    if (!selected.length || running || batchRunning) return;
    if (!window.confirm(`Xoá ${selected.length} job đã chọn khỏi hàng đợi?`)) return;
    const response = await send({type: 'PUB_DELETE_JOBS', moduleId: activeModule, jobIds: selected.map(jobId)});
    if (!response?.ok) throw new Error(response?.error || 'Không xoá được các job đã chọn.');
    const deletedIds = new Set(response.data?.deleted || []);
    jobs = jobs.filter(job => !deletedIds.has(jobId(job)));
    deletedIds.forEach(id => selectedJobIds.delete(id));
    renderJobs();
    const failed = Number(response.data?.failed || 0);
    setLog(`Đã xoá ${deletedIds.size}/${selected.length} job${failed ? ` · ${failed} job lỗi` : ''}.`);
  }

  async function queueSelectedRawForMockup() {
    const assets = [...selectedRawAssets.values()];
    if (!assets.length || running || batchRunning) return;
    const runOptions = currentRunOptions();
    const response = await send({
      type: 'PUB_QUEUE_MOCKUPS',
      assetIds: assets.map(item => item.asset_id),
      runOptions
    });
    if (!response?.ok) throw new Error(response?.error || 'Không thể tạo hàng đợi Mockup.');
    const result = response.data || {};
    const mockupJobs = Array.isArray(result.jobs) ? result.jobs : [];
    if (!mockupJobs.length) throw new Error('MOCKUP_JOB_CREATE_EMPTY');
    selectedRawAssets.clear();
    queueFilter = 'pending';
    setModule('mockup');
    setLog(`Mockup nhận ${assets.length} ảnh. Đang mở GPT và chạy ngay...`);
    await startJobs(mockupJobs.map(job => ({...job, run_options: runOptions})));
  }

  function stopRun() {
    if (!running && !batchRunning) return;
    running = false;
    batchRunning = false;
    send({type: 'PUB_CLEAR_ACTIVE_RUN'}).catch(() => {});
    const stopButton = findStopButton();
    if (stopButton) {
      try { stopButton.click(); } catch (_) {}
    }
    updateRunButtons();
    setLog('Đã dừng runner và ngắt tác vụ đang chạy trên GPT.');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function assertRunning() {
    if (!running && !batchRunning) throw new Error('RUNNER_STOPPED');
  }

  function composer() {
    return document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]') ||
      document.querySelector('textarea');
  }

  function assistantTurns() {
    const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"],[data-turn="assistant"]')];
    return [...new Set(nodes)];
  }

  function getLatestAssistantText() {
    const turn = assistantTurns().at(-1);
    if (!turn) return '';
    const visibleText = String(turn.innerText || turn.textContent || '').trim();
    const codeText = [...turn.querySelectorAll('pre code, code')]
      .map(node => String(node.textContent || '').trim())
      .filter(Boolean)
      .join('\n');
    return codeText && !visibleText.includes(codeText) ? `${visibleText}\n${codeText}`.trim() : visibleText;
  }

  function findStopButton() {
    return document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop"],button[aria-label*="Dừng"]');
  }

  function isGptImageUrl(url) {
    return /^https?:/i.test(String(url || '')) && /backend-api\/(estuary\/content|files)|oaiusercontent\.com|dalleprodsec|sdmnt|blob\.core\.windows\.net|oaistatic\.com|images\.openai\.com|openai\.com.*\/files/i.test(url);
  }

  function assistantImageCandidates(img) {
    const candidates = [];
    const add = value => {
      const url = String(value || '').trim();
      if (isGptImageUrl(url) && !candidates.includes(url)) candidates.push(url);
    };
    add(img.getAttribute('src'));
    add(img.src);
    add(img.currentSrc);
    const srcset = String(img.getAttribute('srcset') || '').split(',')
      .map(item => item.trim().split(/\s+/)[0])
      .filter(Boolean);
    for (const value of srcset.reverse()) add(value);
    for (const attribute of ['data-src', 'data-original-src', 'data-full-src', 'data-download-url']) add(img.getAttribute(attribute));
    const anchor = img.closest('a[href]');
    add(anchor?.href || anchor?.getAttribute('href'));
    return candidates;
  }

  function getAssistantImageUrls() {
    const urls = [];
    for (const turn of assistantTurns()) {
      for (const img of turn.querySelectorAll('img')) {
        urls.push(...assistantImageCandidates(img));
      }
    }
    return [...new Set(urls)];
  }

  function imageSourceFallbacks(primaryUrl) {
    const urls = [String(primaryUrl || '')].filter(Boolean);
    for (const turn of assistantTurns()) {
      for (const img of turn.querySelectorAll('img')) {
        const candidates = assistantImageCandidates(img);
        if (!candidates.includes(primaryUrl)) continue;
        for (const candidate of [...candidates].reverse()) if (!urls.includes(candidate)) urls.push(candidate);
      }
    }
    return urls;
  }

  async function waitForComposer(maxWaitMs = 25000) {
    const end = Date.now() + maxWaitMs;
    while (Date.now() < end) {
      const box = composer();
      if (box) return box;
      await sleep(400);
    }
    throw new Error('CHATGPT_COMPOSER_NOT_FOUND');
  }

  async function sendPrompt(text) {
    assertRunning();
    const box = await waitForComposer();
    box.focus();
    if (box.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter ? setter.call(box, text) : (box.value = text);
      box.dispatchEvent(new Event('input', {bubbles: true}));
    } else {
      box.textContent = text;
      box.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
    }
    await sleep(250);
    const sendButton = document.querySelector('[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('button[aria-label*="Gửi"]');
    if (sendButton && !sendButton.disabled) sendButton.click();
    else box.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
    return true;
  }

  async function sendAttachmentOnly() {
    assertRunning();
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const button = document.querySelector('[data-testid="send-button"]') ||
        document.querySelector('button[aria-label*="Send"]') ||
        document.querySelector('button[aria-label*="Gửi"]');
      if (button && !button.disabled) {
        button.click();
        return true;
      }
      await sleep(300);
    }
    throw new Error('CHATGPT_ATTACHMENT_SEND_UNAVAILABLE');
  }

  function dataUrlToFile(dataUrl, filename, type = 'image/png') {
    const [head, body] = String(dataUrl).split(',');
    const mime = /data:([^;]+)/.exec(head)?.[1] || type || 'image/png';
    const binary = atob(body || '');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], filename || 'podhub-asset.png', {type: mime, lastModified: Date.now()});
  }

  async function attachDataUrl(dataUrl, filename, type) {
    assertRunning();
    let input = null;
    const end = Date.now() + 25000;
    while (Date.now() < end && !input) {
      input = [...document.querySelectorAll('input[type="file"]')].find(item => !item.closest('#pub-root'));
      if (!input) await sleep(400);
    }
    if (!input) throw new Error('CHATGPT_FILE_INPUT_NOT_FOUND');
    const transfer = new DataTransfer();
    transfer.items.add(dataUrlToFile(dataUrl, filename, type));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles: true}));
    await sleep(1600);
    return true;
  }

  async function waitForAssistantText(previousText = '', maxWaitMs = 300000) {
    const end = Date.now() + maxWaitMs;
    let last = '';
    let changedAt = Date.now();
    await sleep(1200);
    while (Date.now() < end) {
      assertRunning();
      const current = getLatestAssistantText();
      if (current !== last) {
        last = current;
        changedAt = Date.now();
      }
      if (current && current !== previousText && !findStopButton() && Date.now() - changedAt >= 4000) return current;
      await sleep(700);
    }
    throw new Error('GPT_TEXT_TIMEOUT');
  }

  async function requestAssistantText(prompt, previousText = '', attempts = 2) {
    let baseline = previousText;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await sendPrompt(prompt);
      try {
        return await waitForAssistantText(baseline);
      } catch (error) {
        lastError = error;
        if (error.message !== 'GPT_TEXT_TIMEOUT') throw error;
        if (findStopButton()) {
          try { return await waitForAssistantText(baseline, 180000); }
          catch (continuedError) { lastError = continuedError; }
        }
        baseline = getLatestAssistantText();
        if (attempt < attempts) await sleep(1800);
      }
    }
    throw lastError || new Error('GPT_TEXT_TIMEOUT');
  }

  async function waitForNewImage(beforeUrls, maxWaitMs = 240000) {
    const before = beforeUrls?.urls instanceof Set ? beforeUrls.urls : beforeUrls instanceof Set ? beforeUrls : new Set(beforeUrls || []);
    const beforeTurnCount = Number(beforeUrls?.turnCount || 0);
    const end = Date.now() + maxWaitMs;
    let candidate = '';
    let changedAt = Date.now();
    await sleep(700);
    while (Date.now() < end) {
      assertRunning();
      const fresh = getAssistantImageUrls().filter(url => !before.has(url));
      let latest = fresh.at(-1) || '';
      if (!latest && !findStopButton() && assistantTurns().length > beforeTurnCount) {
        const turn = assistantTurns().at(-1);
        latest = [...(turn?.querySelectorAll('img') || [])]
          .flatMap(assistantImageCandidates)
          .at(-1) || '';
      }
      if (latest !== candidate) {
        candidate = latest;
        changedAt = Date.now();
      }
      if (candidate && !findStopButton() && Date.now() - changedAt >= 2200) return candidate;
      const text = getLatestAssistantText();
      if (!fresh.length && !findStopButton() && /PODHUB_IMAGE_TOOL_UNAVAILABLE|\/mnt\/data\/[^\s)\]]+\.(?:png|jpe?g|webp)|cannot\s+(?:read|access|open)\s+(?:the\s+)?file/i.test(text)) {
        throw new Error('GPT_IMAGE_RENDER_FAILED');
      }
      await sleep(800);
    }
    throw new Error('GPT_IMAGE_TIMEOUT');
  }

  async function fetchJobAsset(job) {
    const response = await send({type: 'PUB_FETCH_ASSET', source: assetSource(job)});
    if (!response?.ok) throw new Error(response?.error || 'JOB_ASSET_FETCH_FAILED');
    return response.data;
  }

  function resultUploadPath(moduleId, id) {
    if (moduleId === 'clone') return `/api/extension/clone-jobs/${encodeURIComponent(id)}/raw-clone`;
    if (moduleId === 'redesign') return `/api/extension/redesign-jobs/${encodeURIComponent(id)}/raw-redesign`;
    if (moduleId === 'mockup') return `/api/extension/mockup-jobs/${encodeURIComponent(id)}/mockups`;
    throw new Error(`RESULT_MODULE_INVALID:${moduleId}`);
  }

  function filenameForBlob(filename, mimeType) {
    const extension = mimeType === 'image/jpeg' ? 'jpg'
      : mimeType === 'image/webp' ? 'webp'
        : mimeType === 'image/gif' ? 'gif'
          : 'png';
    return String(filename || 'result.png').replace(/\.(?:png|jpe?g|webp|gif)$/i, `.${extension}`);
  }

  async function validateCapturedImage(blob) {
    const mimeType = String(blob?.type || '').split(';')[0].toLowerCase();
    if (!(blob instanceof Blob) || !mimeType.startsWith('image/')) throw new Error('GPT_IMAGE_CONTENT_INVALID');
    if (blob.size < MIN_GPT_IMAGE_BYTES) throw new Error(`GPT_IMAGE_TOO_SMALL:${blob.size}`);
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();
      if (width < 200 || height < 200) throw new Error(`GPT_IMAGE_DIMENSIONS_INVALID:${width}x${height}`);
    }
    return blob;
  }

  async function captureGptImage(sourceUrls) {
    let lastError = null;
    for (const sourceUrl of sourceUrls) {
      try {
        const response = await fetch(sourceUrl, {credentials: 'include', cache: 'no-store'});
        if (!response.ok) throw new Error(`GPT_IMAGE_HTTP_${response.status}`);
        return {blob: await validateCapturedImage(await response.blob()), sourceUrl};
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('GPT_IMAGE_CAPTURE_FAILED');
  }

  async function uploadCapturedImage(moduleId, id, kind, filename, blob, meta = {}) {
    const stored = await chrome.storage.local.get(['pub_license_token']);
    const token = String(stored.pub_license_token || '');
    if (!token) throw new Error('EXTENSION_TOKEN_MISSING');
    const normalizedFilename = filenameForBlob(filename, blob.type);
    const query = new URLSearchParams({
      ...Object.fromEntries(Object.entries({...meta, runner_id: settings.runner_id})
        .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
        .map(([key, value]) => [key, String(value)])),
      filename: normalizedFilename,
      kind
    });
    const response = await fetch(`${DATA_ORIGIN}${resultUploadPath(moduleId, id)}?${query}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': blob.type || 'image/png',
        'X-Podhub-Request-Id': `ext_${crypto.randomUUID()}`
      },
      body: blob
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.message || payload?.error || `RESULT_UPLOAD_HTTP_${response.status}`);
    }
    return payload.data ?? payload;
  }

  async function uploadImageResult(moduleId, job, imageUrl, index, meta = {}) {
    const id = jobId(job);
    const stem = slugId(baseJobTitle(job) || id || moduleId) || moduleId;
    const kind = moduleId === 'clone' ? 'raw_clone' : moduleId === 'redesign' ? 'raw_redesign' : 'mockup';
    const filename = meta.filename || `${stem}__${kind}_${String(index).padStart(2, '0')}.png`;
    const sourceUrls = imageSourceFallbacks(imageUrl);
    const captured = await captureGptImage(sourceUrls);
    const uploaded = await uploadCapturedImage(moduleId, id, kind, filename, captured.blob, meta);
    rememberUploadedResult(moduleId, job, uploaded, filename, meta);
    return uploaded;
  }

  function rememberUploadedResult(moduleId, job, uploaded, filename, meta = {}) {
    const key = moduleId === 'clone' ? 'raw_clone_assets' : moduleId === 'redesign' ? 'raw_redesign_assets' : 'mockups';
    const item = {
      asset_id: uploaded?.asset_id || uploaded?.id || '',
      url: uploaded?.url || uploaded?.cdn_url || uploaded?.stored_url || '',
      filename,
      content_sha256: uploaded?.content_sha256 || '',
      ...meta
    };
    if (!item.asset_id && !item.url) return;
    const targets = [job, ...jobs.filter(candidate => jobId(candidate) === jobId(job))];
    for (const target of new Set(targets.filter(Boolean))) {
      if (!target.results || typeof target.results !== 'object') target.results = {};
      const current = Array.isArray(target.results[key]) ? target.results[key] : [];
      target.results[key] = current.filter(existing => {
        if (item.asset_id && String(existing?.asset_id || '') === String(item.asset_id)) return false;
        if (moduleId === 'mockup') {
          return !(String(existing?.product_id || '') === String(item.product_id || '') && Number(existing?.mockup_no) === Number(item.mockup_no));
        }
        return true;
      });
      target.results[key].push(item);
    }
    if (activeModule === moduleId) renderJobs();
  }

  async function apiStatus(moduleId, job, body) {
    if (!jobId(job)) return null;
    const response = await send({type: 'PUB_JOB_STATUS', moduleId, jobId: jobId(job), body});
    if (!response?.ok) setLog(response?.error || 'Không cập nhật được trạng thái job.');
    const updated = response?.data || null;
    if (response?.ok) {
      const patch = updated && typeof updated === 'object' ? updated : {status: body?.status};
      Object.assign(job, patch);
      for (const current of jobs) if (jobId(current) === jobId(job)) Object.assign(current, patch);
      if (body?.status === 'done') queueFilter = 'done';
      if (activeModule === moduleId) renderJobs();
    }
    return updated;
  }

  function moduleOptions(run) {
    return run?.job?.run_options || run?.run_options || currentRunOptions();
  }

  function labelList(values, fallback) {
    const list = Array.isArray(values) ? values.filter(Boolean) : [];
    return list.length ? list.join(', ') : fallback;
  }

  function mockupProductIds(options = {}) {
    const selected = Array.isArray(options.mockup_products) ? options.mockup_products : [];
    const custom = Array.isArray(options.mockup_custom_products) ? options.mockup_custom_products : [];
    const ids = selected.map(value => String(value || '').trim()).filter(Boolean);
    for (const label of custom) {
      const id = slugId(label);
      if (id && !ids.some(value => slugId(value) === id)) ids.push(id);
    }
    return [...new Map(ids.map(value => [slugId(value), value])).values()];
  }

  function buildRedesignPlanningPrompt(run) {
    const job = run.job || {};
    const options = moduleOptions(run);
    const count = options.redesign_auto_style ? Math.max(1, Number(options.redesign_count || 4)) : (options.redesign_style_presets || []).length;
    const selected = (options.redesign_style_presets || []).map(id => {
      const serverStyle = styleById(id);
      const customLabel = (options.redesign_custom_styles || []).find(label => slugId(label) === String(id));
      return serverStyle
        ? `${serverStyle.style_id || serverStyle.id} (${serverStyle.label})${serverStyle.prompt_hint ? `: ${serverStyle.prompt_hint}` : ''}`
        : `${id}${customLabel ? ` (${customLabel})` : ''}`;
    });
    if (options.redesign_auto_style) {
      const title = platformProductTitle(job);
      return [
        title ? `Phân tích ảnh này và tiêu đề: "${title}".` : 'Phân tích ảnh này.',
        `Sau đó trả về phân tích tổng hợp design bằng text thông thường và một JSON object duy nhất có đúng ${count} redesign styles.`,
        'Mỗi style chỉ có đúng 4 field: style_id, style_name, design_prompt, background_color.',
        'Chưa tạo ảnh, listing đầy đủ hoặc phôi áo ở bước này.'
      ].join('\n');
    }
    return [
      `Dựa trên artwork áo thun trong ảnh đính kèm, tạo ${count} redesign POD theo đúng các style sau:`,
      ...selected.map((style, index) => `${index + 1}. ${style}`),
      '',
      'Giữ nguyên niche, chủ đề, joke/thông điệp và tinh thần design gốc nhưng không copy bố cục. Mỗi bản phải khác nhau rõ ràng theo đúng phong cách.',
      'Tự động loại bỏ hoặc thay thế logo, thương hiệu, nhân vật bản quyền và IP rủi ro bằng yếu tố generic an toàn.',
      'Artwork-only, print-ready, chữ đúng chính tả và dễ đọc, bố cục giữa, không crop, khung vuông 1:1, nền solid. Không mockup, áo, người mẫu, product scene, watermark hoặc branding.',
      `Trả về một JSON object duy nhất có đúng ${count} styles. Mỗi style chỉ có đúng 4 field: style_id, style_name, design_prompt, background_color.`
    ].join('\n');
  }

  function buildMockupPlanningPrompt(run) {
    const options = moduleOptions(run);
    const products = labelList(mockupProductIds(options), 'sản phẩm đã cấu hình');
    const markets = labelList(options.listing_markets, 'không theo sàn cụ thể');
    const count = Math.max(1, Math.min(10, Number(options.mockup_count || 3)));
    const ratio = options.mockup_aspect_ratio || '16:9';
    return `Phân tích artwork đính kèm và lập kế hoạch ${count} mockup cho ${products}, tối ưu bộ ảnh cho ${markets}, tỷ lệ ${ratio}. Trả về ${count} prompt mockup cho mỗi sản phẩm, chưa tạo ảnh và chưa tạo listing.`;
  }

  function buildMockupImagePrompt(productId, mockupNo, total) {
    return `Dựa trên kế hoạch vừa lập, tạo mockup ${mockupNo}/${total} cho ${productId}. Chỉ tạo 1 ảnh mockup, chưa tạo listing.`;
  }

  function buildListingPrompt(productId, markets, total) {
    return `Tạo listing SEO đầy đủ cho ${productId} trên ${labelList(markets, 'Etsy')}, sử dụng toàn bộ ${total} mockup vừa hoàn thành.`;
  }

  function findMockupPlan(text) {
    const found = [];
    const visit = value => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      if (String(value.schema_version || '').trim().toLowerCase() === 'podhub_mockup_prompts_v1') found.push(value);
      for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
    };
    jsonValuesFromAssistantText(text).forEach(visit);
    return found.at(-1) || null;
  }

  function normalizeMockupPlan(plan, products) {
    if (!plan || typeof plan !== 'object') return null;
    const sourceProducts = Array.isArray(plan.products)
      ? plan.products
      : plan.products && typeof plan.products === 'object'
        ? Object.entries(plan.products).map(([productId, value]) => ({product_id: productId, ...(value && typeof value === 'object' ? value : {})}))
        : [];
    const normalizedProducts = products.map(expectedId => {
      const source = sourceProducts.find(item => slugId(item?.product_id ?? item?.id ?? item?.product) === slugId(expectedId));
      if (!source) return null;
      const prompts = source.mockup_prompts ?? source.mockupPrompts ?? source.prompts;
      return {
        ...source,
        product_id: expectedId,
        mockup_prompts: Array.isArray(prompts) ? prompts.map((item, index) => ({
          ...item,
          mockup_no: Number(item?.mockup_no ?? item?.mockup_number ?? item?.number ?? index + 1),
          prompt: String(item?.prompt ?? item?.image_prompt ?? item?.text ?? '').trim()
        })) : prompts
      };
    });
    return {...plan, schema_version: 'podhub_mockup_prompts_v1', products: normalizedProducts.filter(Boolean)};
  }

  function mockupPlanProblem(plan, products, count) {
    if (!plan) return 'PLAN_MISSING';
    if (!Array.isArray(plan.products) || plan.products.length !== products.length) return 'PRODUCTS_INVALID';
    for (const productId of products) {
      const product = plan.products.find(item => slugId(item?.product_id) === slugId(productId));
      if (!product) return `PRODUCT_MISSING:${productId}`;
      if (!Array.isArray(product.mockup_prompts) || product.mockup_prompts.length !== count) return `PROMPT_COUNT_INVALID:${productId}`;
      const numbers = new Set();
      for (const item of product.mockup_prompts) {
        const number = Number(item?.mockup_no ?? item?.mockup_number);
        if (!Number.isInteger(number) || number < 1 || number > count || numbers.has(number) || String(item?.prompt || '').trim().length < 20) return `PROMPT_INVALID:${productId}`;
        numbers.add(number);
      }
    }
    return '';
  }

  function balancedJsonValues(text) {
    const source = normalizeAssistantJsonText(text);
    const values = [];
    for (let start = 0; start < source.length; start++) {
      if (source[start] !== '{' && source[start] !== '[') continue;
      const stack = [];
      let quoted = false;
      let escaped = false;
      for (let index = start; index < source.length; index++) {
        const char = source[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') {
          quoted = true;
          continue;
        }
        if (char === '{' || char === '[') stack.push(char);
        else if (char === '}' || char === ']') {
          const open = stack.pop();
          if ((open === '{' && char !== '}') || (open === '[' && char !== ']')) break;
          if (!stack.length) {
            try {
              values.push(JSON.parse(source.slice(start, index + 1)));
              start = index;
            } catch (_) {}
            break;
          }
        }
      }
    }
    return values;
  }

  function normalizeAssistantJsonText(text) {
    return String(text || '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  }

  function jsonValuesFromAssistantText(text) {
    const source = normalizeAssistantJsonText(text);
    const values = [];
    const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
    for (const match of source.matchAll(fenced)) values.push(...balancedJsonValues(match[1]));
    values.push(...balancedJsonValues(source));
    return values;
  }

  function collectListings(values) {
    const found = [];
    const visit = (value, context = {}) => {
      if (Array.isArray(value)) return value.forEach(item => visit(item, context));
      if (!value || typeof value !== 'object') return;
      const next = {...context};
      for (const key of ['product_id', 'style_id', 'marketplace']) if (value[key] !== undefined) next[key] = value[key];
      const hasListingContent = value.title || value.tags || value.description || value.bullet_points || value.marketplace_payload;
      if (hasListingContent && !Array.isArray(value.styles) && !Array.isArray(value.products)) found.push({...next, ...value});
      for (const key of ['listing', 'listings', 'results', 'items', 'data', 'walmart_listing', 'etsy_listing', 'amazon_listing', 'shopify_listing']) {
        if (value[key] !== undefined) visit(value[key], next);
      }
    };
    values.forEach(value => visit(value));
    return found;
  }

  async function uploadListings(moduleId, job, text, extra = {}) {
    const candidates = collectListings(jsonValuesFromAssistantText(text));
    for (const listing of candidates) {
      const response = await send({
        type: 'PUB_UPLOAD_RESULT',
        moduleId,
        jobId: jobId(job),
        kind: 'listing',
        body: {
          ...listing,
          ...extra,
          marketplace: String(listing.marketplace || extra.marketplace || '').toLowerCase(),
          job_id: jobId(job),
          schema_version: listing.schema_version || 'podhub_product_listing_v2'
        }
      });
      if (!response?.ok) throw new Error(response?.error || 'LISTING_UPLOAD_FAILED');
    }
    return candidates.length;
  }

  function findRedesignPlan(text) {
    return jsonValuesFromAssistantText(text)
      .flatMap(value => Array.isArray(value) ? value : [value])
      .filter(value => Array.isArray(value?.styles))
      .at(-1);
  }

  function redesignPlanProblem(plan, expectedCount, expectedStyleIds = []) {
    if (!plan) return 'PLAN_MISSING';
    if (!Array.isArray(plan.styles) || plan.styles.length !== expectedCount) return 'STYLE_COUNT_INVALID';
    if (plan.styles.some(style => {
      const keys = Object.keys(style || {}).sort().join(',');
      return keys !== 'background_color,design_prompt,style_id,style_name' || !String(style?.style_id || '') || !String(style?.style_name || '') || !String(style?.background_color || '') || String(style?.design_prompt || '').trim().length < 20;
    })) return 'DESIGN_PROMPT_INVALID';
    if (expectedStyleIds.length) {
      const actual = new Set(plan.styles.map(style => String(style.style_id || '')));
      if (expectedStyleIds.some(id => !actual.has(String(id)))) return 'STYLE_ID_MISMATCH';
    }
    return '';
  }

  async function runCloneModule(run) {
    const job = run.job || {};
    const options = moduleOptions(run);
    const asset = await fetchJobAsset(job);
    const before = {urls: new Set(getAssistantImageUrls()), turnCount: assistantTurns().length};
    await attachDataUrl(asset.data_url, asset.name, asset.type);
    await apiStatus('clone', job, {status: 'processing', progress: {phase: 'image_sent', total: 1, done: 0}});
    let url;
    if (options.clone_with_background === true) {
      await sendPrompt(CLONE_PROMPT);
      url = await waitForNewImage(before);
    } else if (options.clone_remove_background_gpt === true) {
      await sendPrompt(CLONE_REMOVE_BACKGROUND_PROMPT);
      url = await waitForNewImage(before);
    } else {
      await sendAttachmentOnly();
      url = await waitForNewImage(before);
    }
    if (options.clone_with_background === true && options.clone_remove_background_gpt === true) {
      const beforeRemoval = {urls: new Set(getAssistantImageUrls()), turnCount: assistantTurns().length};
      await apiStatus('clone', job, {status: 'processing', progress: {phase: 'removing_background', total: 1, done: 0}});
      await sendPrompt(CLONE_REMOVE_BACKGROUND_PROMPT);
      url = await waitForNewImage(beforeRemoval);
    }
    await uploadImageResult('clone', job, url, 1, {
      clone_with_background: options.clone_with_background === true,
      background_removed: options.clone_remove_background_gpt === true
    });
    await apiStatus('clone', job, {status: 'done', progress: {phase: 'done', total: 1, done: 1}});
  }

  async function runRedesignModule(run) {
    const job = run.job || {};
    const options = moduleOptions(run);
    const selectedStyleIds = options.redesign_auto_style ? [] : (options.redesign_style_presets || []);
    const count = options.redesign_auto_style
      ? Math.max(1, Math.min(30, Number(options.redesign_count || 4)))
      : selectedStyleIds.length;
    if (!count) throw new Error('REDESIGN_STYLE_REQUIRED');
    const markets = Array.isArray(options.redesign_listing_markets) ? options.redesign_listing_markets : [];
    const asset = await fetchJobAsset(job);
    await attachDataUrl(asset.data_url, asset.name, asset.type);
    const previous = getLatestAssistantText();
    await apiStatus('redesign', job, {status: 'processing', progress: {phase: 'analysis', total: count, done: 0}});
    let planText = await requestAssistantText(buildRedesignPlanningPrompt(run), previous);
    let plan = findRedesignPlan(planText);
    let problem = redesignPlanProblem(plan, count, selectedStyleIds);
    if (problem) {
      const repairPrevious = getLatestAssistantText();
      planText = await requestAssistantText(`JSON kế hoạch redesign chưa đúng (${problem}). Trả lại đúng một JSON object có đúng ${count} styles${selectedStyleIds.length ? ` với các style_id: ${selectedStyleIds.join(', ')}` : ''}. Mỗi style chỉ có đúng style_id, style_name, design_prompt và background_color. Chưa tạo ảnh hoặc listing.`, repairPrevious);
      plan = findRedesignPlan(planText);
      problem = redesignPlanProblem(plan, count, selectedStyleIds);
    }
    if (problem) throw new Error(`REDESIGN_PLAN_INVALID:${problem}`);
    await apiStatus('redesign', job, {status: 'processing', progress: {phase: 'plan_ready', total: count, done: 0}, results: {redesign_plan: plan}});
    const before = new Set(getAssistantImageUrls());
    for (let index = 1; index <= count; index++) {
      const style = plan.styles[index - 1];
      await sendPrompt(String(style.design_prompt).trim());
      const url = await waitForNewImage(before);
      before.add(url);
      await uploadImageResult('redesign', job, url, index, {style_id: style.style_id || `style_${index}`, style_name: style.style_name || '', background_color: style.background_color || ''});
      for (const market of markets) {
        const listingPrevious = getLatestAssistantText();
        const listingText = await requestAssistantText(`Tạo listing hoàn chỉnh cho ${market} theo style_name: "${style.style_name}". Nội dung listing ${market} trả về định dạng JSON theo schema đã định nghĩa.`, listingPrevious);
        let saved = await uploadListings('redesign', job, listingText, {style_id: style.style_id || `style_${index}`, style_name: style.style_name || '', marketplace: market});
        if (!saved) {
          const repairPrevious = getLatestAssistantText();
          const repaired = await requestAssistantText(`Listing ${market} chưa có JSON hợp lệ. Trả lại đúng một JSON object listing hoàn chỉnh cho style_name: "${style.style_name}" và marketplace: "${market}".`, repairPrevious);
          saved = await uploadListings('redesign', job, repaired, {style_id: style.style_id || `style_${index}`, style_name: style.style_name || '', marketplace: market});
        }
        if (!saved) throw new Error(`REDESIGN_LISTING_JSON_MISSING:${style.style_id || index}:${market}`);
      }
      await apiStatus('redesign', job, {status: 'processing', progress: {phase: 'image_captured', total: count, done: index}});
    }
    await apiStatus('redesign', job, {status: 'done', progress: {phase: 'done', total: count, done: count}});
  }

  async function runMockupModule(run) {
    const job = run.job || {};
    const options = moduleOptions(run);
    const products = mockupProductIds(options);
    const productList = products.length ? products : ['mockup'];
    const markets = Array.isArray(options.listing_markets) ? options.listing_markets : [];
    const total = Math.max(1, Math.min(10, Number(options.mockup_count || 3)));
    const asset = await fetchJobAsset(job);
    await attachDataUrl(asset.data_url, asset.name, asset.type);
    const previousText = getLatestAssistantText();
    await apiStatus('mockup', job, {status: 'processing', progress: {phase: 'planning', mockups_total: productList.length * total, mockups_done: 0}});
    let planText = await requestAssistantText(buildMockupPlanningPrompt(run), previousText);
    let plan = normalizeMockupPlan(findMockupPlan(planText), productList);
    let planProblem = mockupPlanProblem(plan, productList, total);
    if (planProblem) {
      const repairPrevious = getLatestAssistantText();
      planText = await requestAssistantText(`Phần Mockup prompts chưa đúng (${planProblem}). Hãy trả lại riêng mục Mockup prompts với đúng một fenced JSON block schema podhub_mockup_prompts_v1 cho các sản phẩm ${productList.join(', ')}, mỗi sản phẩm có đúng ${total} prompt đánh số từ 1 đến ${total}. Chưa tạo ảnh.`, repairPrevious);
      plan = normalizeMockupPlan(findMockupPlan(planText), productList);
      planProblem = mockupPlanProblem(plan, productList, total);
    }
    if (planProblem) throw new Error(`MOCKUP_PLAN_INVALID:${planProblem}`);
    await apiStatus('mockup', job, {status: 'processing', progress: {phase: 'plan_ready', mockups_total: productList.length * total, mockups_done: 0}, results: {mockup_plan: plan}});
    let done = 0;
    const before = new Set(getAssistantImageUrls());
    for (const productId of productList) {
      const productPlan = plan.products.find(item => String(item.product_id) === String(productId));
      for (let mockupNo = 1; mockupNo <= total; mockupNo++) {
        const planned = productPlan.mockup_prompts.find(item => Number(item.mockup_no ?? item.mockup_number) === mockupNo);
        let saved = false;
        let lastError = null;
        for (let attempt = 1; attempt <= 3 && !saved; attempt++) {
          const snapshot = {urls: new Set(before), turnCount: assistantTurns().length};
          await sendPrompt(String(planned.prompt).trim());
          try {
            const url = await waitForNewImage(snapshot);
            before.add(url);
            await uploadImageResult('mockup', job, url, mockupNo, {product_id: productId, mockup_no: mockupNo});
            saved = true;
          } catch (error) {
            lastError = error;
          }
        }
        if (!saved) throw lastError || new Error(`MOCKUP_CAPTURE_FAILED:${productId}:${mockupNo}`);
        done += 1;
        await apiStatus('mockup', job, {status: 'processing', progress: {phase: 'mockup_captured', current_product: productId, mockups_total: productList.length * total, mockups_done: done}});
      }
      if (markets.length) {
        const prev = getLatestAssistantText();
        let text = await requestAssistantText(buildListingPrompt(productId, markets, total), prev);
        let saved = await uploadListings('mockup', job, text, {product_id: productId});
        if (!saved) {
          const repairPrevious = getLatestAssistantText();
          text = await requestAssistantText(`Listing cho ${productId} chưa đúng hoặc chưa có JSON. Hãy tạo lại listing SEO đầy đủ trên ${markets.join(' và ')}, dùng toàn bộ ${total} mockup vừa hoàn thành và áp dụng đúng Knowledge contract.`, repairPrevious);
          saved = await uploadListings('mockup', job, text, {product_id: productId});
        }
        if (!saved) throw new Error(`LISTING_JSON_INVALID:${productId}`);
      }
    }
    await apiStatus('mockup', job, {status: 'done', progress: {phase: 'done', mockups_total: productList.length * total, mockups_done: done}});
  }

  function isRetryableRunError(error) {
    return /^(GPT_|CHATGPT_|REDESIGN_PLAN_INVALID|MOCKUP_PLAN_INVALID|MOCKUP_CAPTURE_FAILED|REDESIGN_LISTING_JSON_MISSING|LISTING_JSON_INVALID|LISTING_UPLOAD_FAILED|ASSET_HTTP_429|ASSET_HTTP_5)/.test(String(error?.message || ''));
  }

  async function runActiveBridgeJob(run) {
    if (!run?.module_id || !run?.job) return {ok: false, terminal: true};
    running = true;
    updateRunButtons();
    setLog(`Đang chạy ${run.module_id} job ${jobId(run.job) || ''}...`);
    try {
      await send({type: 'PUB_CLAIM_JOB', moduleId: run.module_id, jobId: jobId(run.job), body: {runner_id: settings.runner_id, job: run.job}});
      await apiStatus(run.module_id, run.job, {status: 'processing', progress: {phase: 'config_loaded'}, results: {config_snapshot: {captured_at: new Date().toISOString(), versions: serverConfig?.config_versions || {}, run_options: moduleOptions(run)}}});
      if (run.module_id === 'mockup') await runMockupModule(run);
      else if (run.module_id === 'redesign') await runRedesignModule(run);
      else await runCloneModule(run);
      setLog(`Hoàn tất ${run.module_id} job ${jobId(run.job) || ''}.`);
      return {ok: true};
    } catch (error) {
      setLog(error.message);
      const stopped = error.message === 'RUNNER_STOPPED';
      const retryable = !stopped && isRetryableRunError(error);
      const retryCount = Number(run.job?.progress?.retry_count || 0) + (retryable ? 1 : 0);
      await apiStatus(run.module_id, run.job, {
        status: stopped || retryable ? 'queued' : 'failed',
        error: error.message,
        progress: {phase: stopped ? 'stopped' : retryable ? 'retry_pending' : 'failed', retry_count: retryCount}
      }).catch(() => {});
      return {ok: false, stopped, retryable, terminal: !stopped && !retryable, error: error.message};
    } finally {
      running = false;
      updateRunButtons();
    }
  }

  async function runActiveBridgeJobs(run) {
    const batch = Array.isArray(run?.jobs) && run.jobs.length ? run.jobs : [run?.job].filter(Boolean);
    const startIndex = Math.max(0, Math.min(batch.length, Number(run?.next_index || 0)));
    const jobsPerConversation = run?.module_id === 'clone' ? 10 : 1;
    const endIndex = Math.min(batch.length, startIndex + jobsPerConversation);
    batchRunning = true;
    updateRunButtons();
    for (let index = startIndex; index < endIndex; index++) {
      if (!batchRunning) break;
      const job = batch[index];
      const outcome = await runActiveBridgeJob({...run, job});
      if (outcome?.stopped) {
        batchRunning = false;
        break;
      }
      await send({type: 'PUB_UPDATE_ACTIVE_RUN', patch: {next_index: index + 1}});
    }
    if (batchRunning && endIndex < batch.length) {
      const nextRun = await send({type: 'PUB_UPDATE_ACTIVE_RUN', patch: {next_index: endIndex, conversation_started_at: new Date().toISOString()}});
      const nextUrl = nextRun?.data?.module?.gpt_url || run?.module?.gpt_url || serverConfig?.modules?.[run.module_id]?.gpt_url;
      if (!nextUrl) throw new Error(`GPT_URL_MISSING:${run.module_id}`);
      setLog(`${run.module_id === 'clone' ? 'Đã đủ 10 job' : 'Job đã hoàn tất'}. Đang mở hội thoại mới...`);
      location.href = nextUrl;
      return;
    }
    batchRunning = false;
    updateRunButtons();
    await send({type: 'PUB_CLEAR_ACTIVE_RUN'});
    selectedJobIds.clear();
    await loadJobs().catch(() => {});
  }

  function updateRunButtons() {
    const busy = running || batchRunning;
    const runButton = root?.querySelector('[data-action="run"]');
    const actionBar = root?.querySelector('.pub-bottom-actions');
    const rawBar = root?.querySelector('.pub-raw-actions');
    if (runButton) {
      runButton.disabled = busy;
      runButton.textContent = `RUN (${selectedJobIds.size})`;
    }
    const selectAllButton = root?.querySelector('[data-action="select-all"]');
    if (selectAllButton) {
      const visible = jobs.filter(job => queueFilter === 'all' || queueGroup(job) === queueFilter);
      const allSelected = visible.length > 0 && visible.every(job => selectedJobIds.has(jobId(job)));
      selectAllButton.textContent = allSelected ? 'Bỏ chọn' : 'Chọn tất cả';
      selectAllButton.classList.toggle('active', allSelected);
      selectAllButton.disabled = busy || !visible.length;
    }
    if (actionBar) actionBar.classList.toggle('visible', !busy && selectedJobIds.size > 0);
    if (rawBar) {
      rawBar.classList.toggle('visible', !busy && selectedRawAssets.size > 0);
      const count = rawBar.querySelector('[data-role="raw-count"]');
      if (count) count.textContent = `Đã chọn ${selectedRawAssets.size} ảnh`;
    }
    if (floatingStop) floatingStop.classList.toggle('visible', busy);
  }

  function renderJobs() {
    const list = root?.querySelector('.pub-job-list');
    if (!list) return;
    root.querySelectorAll('.pub-filter[data-filter]').forEach(button => {
      button.classList.toggle('active', button.dataset.filter === queueFilter);
    });
    const visible = jobs.filter(job => queueFilter === 'all' || queueGroup(job) === queueFilter);
    const knownIds = new Set(jobs.map(jobId));
    selectedJobIds.forEach(id => {
      if (!knownIds.has(id)) selectedJobIds.delete(id);
    });
    if (!visible.length) {
      list.innerHTML = '<div class="pub-empty">Không có job trong nhóm này.</div>';
      updateRunButtons();
      return;
    }
    list.innerHTML = visible.map((job, index) => {
      const title = shortJobTitle(job, index);
      const img = imageUrl(job);
      const id = jobId(job);
      const previews = resultImages(job);
      return `<article class="pub-job-card ${selectedJobIds.has(id) ? 'selected' : ''}" data-visible-index="${index}">
        <label class="pub-job-select" title="Chọn job"><input type="checkbox" ${selectedJobIds.has(id) ? 'checked' : ''}></label>
        <div class="pub-job-thumb">
          <button class="pub-job-source-button" type="button" data-gallery-index="0" title="Xem ảnh nguồn"><img class="pub-job-source" src="${escapeHtml(img)}" alt="${escapeHtml(title)}"></button>
          <button class="pub-job-delete" type="button" title="Xoá job">×</button>
        </div>
        <div class="pub-job-content">
          <b class="pub-job-title" title="${escapeHtml(titleOf(job) || title)}">${escapeHtml(title)}</b>
          ${previews.length ? `<div class="pub-result-strip">${previews.map((item, previewIndex) => `<div class="pub-result-item ${selectedRawAssets.has(item.asset_id) ? 'selected' : ''}"><button type="button" class="pub-result-preview" data-gallery-index="${previewIndex + 1}" title="Xem ảnh kết quả"><img data-pub-result-image="1" data-asset-id="${escapeHtml(item.asset_id)}" data-asset-url="${escapeHtml(item.url)}" data-asset-name="${escapeHtml(item.name)}" src="${escapeHtml(item.asset_id ? 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=' : (item.url || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='))}" alt="${escapeHtml(item.name)}"></button>${item.asset_id && activeModule !== 'mockup' ? `<label class="pub-raw-select" title="Chọn để tạo Mockup"><input type="checkbox" data-asset-id="${escapeHtml(item.asset_id)}" ${selectedRawAssets.has(item.asset_id) ? 'checked' : ''}></label>` : ''}</div>`).join('')}</div>` : ''}
        </div>
      </article>`;
    }).join('');
    list.querySelectorAll('.pub-job-card').forEach(card => {
      const job = visible[Number(card.dataset.visibleIndex)];
      card.querySelector('.pub-job-select input').addEventListener('change', event => {
        const id = jobId(job);
        if (event.target.checked) {
          selectedRawAssets.clear();
          list.querySelectorAll('.pub-raw-select input:checked').forEach(item => { item.checked = false; });
          list.querySelectorAll('.pub-result-item.selected').forEach(item => item.classList.remove('selected'));
          selectedJobIds.add(id);
        } else selectedJobIds.delete(id);
        card.classList.toggle('selected', event.target.checked);
        updateRunButtons();
      });
      card.querySelector('.pub-job-delete').addEventListener('click', () => {
        if (window.confirm(`Xoá ${shortJobTitle(job)} khỏi hàng đợi?`)) deleteJob(job).catch(error => setLog(error.message));
      });
      card.querySelectorAll('[data-gallery-index]').forEach(button => {
        button.addEventListener('click', () => {
          const gallery = [...card.querySelectorAll('[data-gallery-index] img')]
            .map(image => ({url: image.currentSrc || image.src || '', name: image.alt || ''}))
            .filter(item => item.url);
          openImagePreview(gallery, Number(button.dataset.galleryIndex || 0));
        });
      });
      card.querySelectorAll('.pub-raw-select input').forEach(input => {
        input.addEventListener('change', event => {
          const assetId = event.target.dataset.assetId;
          const asset = resultImages(job).find(item => item.asset_id === assetId);
          if (event.target.checked && asset) {
            selectedJobIds.clear();
            list.querySelectorAll('.pub-job-card.selected').forEach(item => item.classList.remove('selected'));
            list.querySelectorAll('.pub-job-select input:checked').forEach(item => { item.checked = false; });
            selectedRawAssets.set(assetId, asset);
          } else selectedRawAssets.delete(assetId);
          event.target.closest('.pub-result-item')?.classList.toggle('selected', event.target.checked);
          updateRunButtons();
        });
      });
    });
    hydrateResultImages(list);
    updateRunButtons();
  }

  function toggleSelectAllJobs() {
    if (running || batchRunning) return;
    const visible = jobs.filter(job => queueFilter === 'all' || queueGroup(job) === queueFilter);
    if (!visible.length) return;
    const allSelected = visible.every(job => selectedJobIds.has(jobId(job)));
    selectedRawAssets.clear();
    for (const job of visible) {
      const id = jobId(job);
      if (allSelected) selectedJobIds.delete(id);
      else if (id) selectedJobIds.add(id);
    }
    renderJobs();
  }

  function openImagePreview(images, initialIndex = 0) {
    const gallery = Array.isArray(images) ? images.filter(item => item?.url) : [];
    if (!gallery.length) return;
    let index = Math.max(0, Math.min(gallery.length - 1, initialIndex));
    const overlay = document.createElement('div');
    overlay.className = 'pub-image-overlay';
    overlay.innerHTML = `<button class="pub-gallery-close" type="button" title="Đóng">×</button><button class="pub-gallery-prev" type="button" title="Ảnh trước">‹</button><figure><img alt="Ảnh xem trước"><figcaption></figcaption></figure><button class="pub-gallery-next" type="button" title="Ảnh tiếp theo">›</button>`;
    const render = () => {
      const item = gallery[index];
      overlay.querySelector('img').src = item.url;
      overlay.querySelector('figcaption').textContent = `${index + 1}/${gallery.length}${item.name ? ` · ${item.name}` : ''}`;
      overlay.querySelector('.pub-gallery-prev').disabled = gallery.length < 2;
      overlay.querySelector('.pub-gallery-next').disabled = gallery.length < 2;
    };
    const move = delta => { index = (index + delta + gallery.length) % gallery.length; render(); };
    const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
    const onKey = event => {
      if (event.key === 'Escape') close();
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
    };
    overlay.querySelector('.pub-gallery-close').addEventListener('click', close);
    overlay.querySelector('.pub-gallery-prev').addEventListener('click', () => move(-1));
    overlay.querySelector('.pub-gallery-next').addEventListener('click', () => move(1));
    overlay.addEventListener('click', event => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    render();
  }

  function setModule(moduleId) {
    activeModule = moduleId;
    selectedJobIds.clear();
    selectedRawAssets.clear();
    root.querySelectorAll('.pub-tab').forEach(button => {
      button.classList.toggle('active', button.dataset.module === moduleId);
    });
    const module = MODULES.find(item => item.id === moduleId);
    updateModuleSummary();
    root.querySelector('.pub-config').dataset.module = moduleId;
    setConfigTab(moduleId);
    loadJobs().catch(error => setLog(error.message));
  }

  function flowTextHtml(moduleId) {
    const flows = {
      clone: 'Workflow: Mockup/design -> Clone GPTs -> Raw clone -> Remaster -> design chuẩn in',
      redesign: 'Workflow: Mockup/design -> Redesign GPTs -> Raw redesign',
      mockup: 'Workflow: Raw redesign/Clone -> Mockup GPTs -> thư viện Mockup -> Listing chuẩn SEO'
    };
    return `<div class="pub-flow-text">${escapeHtml(flows[moduleId] || flows.clone)}</div>`;
  }

  function updateModuleSummary() {
    const module = MODULES.find(item => item.id === activeModule);
    const summary = root.querySelector('[data-role="summary"]');
    if (summary) {
      summary.querySelector('.pub-module-label').textContent = `${module?.label || activeModule} module`;
    }
  }

  function setConfigTab(moduleId) {
    root.querySelectorAll('.pub-config-tab').forEach(button => {
      button.classList.toggle('active', button.dataset.configModule === moduleId);
    });
    root.querySelectorAll('.pub-config-panel').forEach(panel => {
      panel.classList.toggle('active', panel.dataset.configPanel === moduleId);
    });
  }

  function renderStylePresetChecks() {
    const presets = [
      ...stylePresets(),
      ...settings.redesign_custom_styles.map(value => ({id: slugId(value), label: value}))
    ];
    return presets.map(item => {
      const id = String(item.id || item.value || item.label || '').trim();
      const label = String(item.label || item.name || id);
      const userAdded = settings.redesign_custom_styles.includes(label);
      return `<label class="pub-check ${userAdded ? 'user-added' : ''}"><input name="pub-redesign-style" type="checkbox" value="${escapeHtml(id)}" ${settings.redesign_style_presets.includes(id) ? 'checked' : ''}><span>${escapeHtml(label)}</span>${userAdded ? `<button class="pub-check-remove" type="button" data-remove-style="${escapeHtml(label)}">×</button>` : ''}</label>`;
    }).join('');
  }

  function updateRedesignStyleState() {
    const auto = root?.querySelector('#pub-redesign-auto-style')?.checked ?? settings.redesign_auto_style;
    const grid = root?.querySelector('#pub-redesign-style-grid');
    if (!grid) return;
    grid.classList.toggle('disabled', auto);
    grid.querySelectorAll('input[name="pub-redesign-style"]').forEach(input => {
      input.disabled = auto;
    });
    const count = root?.querySelector('#pub-redesign-count');
    if (count) {
      count.disabled = !auto;
      count.max = String(redesignMaxStyles());
      if (!auto) count.value = String(grid.querySelectorAll('input[name="pub-redesign-style"]:checked').length);
    }
    root?.querySelectorAll('[data-role="redesign-count-field"]').forEach(element => element.classList.toggle('disabled', !auto));
  }

  function renderProductChecks() {
    const products = [
      ...productCatalog(),
      ...settings.mockup_custom_products.map(value => ({id: slugId(value), label: value}))
    ];
    return products.map(item => {
      const userAdded = settings.mockup_custom_products.includes(item.label);
      return `<label class="pub-check ${userAdded ? 'user-added' : ''}"><input name="pub-product" type="checkbox" value="${escapeHtml(item.id)}" ${settings.mockup_products.includes(item.id) ? 'checked' : ''}><span>${escapeHtml(item.label)}</span>${userAdded ? `<button class="pub-check-remove" type="button" data-remove-product="${escapeHtml(item.label)}">×</button>` : ''}</label>`;
    }).join('');
  }

  function renderListingChecks(name, selected) {
    return listingOptions().map(item => {
      const id = String(item.id || item.option_id || '').trim();
      const label = String(item.label || item.name || id);
      return `<label class="pub-check"><input name="${escapeHtml(name)}" type="checkbox" value="${escapeHtml(id)}" ${selected.includes(id) ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
    }).join('');
  }

  function renderAspectRatioOptions() {
    return mockupAspectRatios().map(value => `<option value="${escapeHtml(value)}" ${settings.mockup_aspect_ratio === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('');
  }

  function refreshConfigUi() {
    if (!root) return;
    const styleGrid = root.querySelector('#pub-redesign-style-grid');
    if (styleGrid) styleGrid.innerHTML = renderStylePresetChecks();
    const productGrid = root.querySelector('#pub-product-grid');
    if (productGrid) productGrid.innerHTML = renderProductChecks();
    const redesignMarkets = root.querySelector('#pub-redesign-market-grid');
    if (redesignMarkets) redesignMarkets.innerHTML = renderListingChecks('pub-redesign-market', settings.redesign_listing_markets);
    const mockupMarkets = root.querySelector('#pub-mockup-market-grid');
    if (mockupMarkets) mockupMarkets.innerHTML = renderListingChecks('pub-market', settings.listing_markets);
    const ratios = root.querySelector('#pub-mockup-aspect-ratio');
    if (ratios) ratios.innerHTML = renderAspectRatioOptions();
    updateRedesignStyleState();
  }

  async function refreshServerConfig() {
    const response = await send({type: 'PUB_REFRESH_CONFIG'});
    if (!response?.ok) throw new Error(response?.error || 'Không đồng bộ được cấu hình server.');
    serverConfig = response.data || serverConfig;
    refreshConfigUi();
    return serverConfig;
  }

  function addCustomStyle() {
    syncSettingsFromConfig();
    const input = root.querySelector('#pub-redesign-custom-style');
    const label = String(input?.value || '').trim();
    const id = slugId(label);
    if (!id) return;
    if (!settings.redesign_custom_styles.includes(label)) settings.redesign_custom_styles.push(label);
    if (!settings.redesign_style_presets.includes(id)) settings.redesign_style_presets.push(id);
    if (input) input.value = '';
    saveLocalSettings();
    root.querySelector('#pub-redesign-style-grid').innerHTML = renderStylePresetChecks();
    updateRedesignStyleState();
  }

  function addCustomProduct() {
    syncSettingsFromConfig();
    const input = root.querySelector('#pub-mockup-custom-product');
    const label = String(input?.value || '').trim();
    const id = slugId(label);
    if (!id) return;
    if (!settings.mockup_custom_products.includes(label)) settings.mockup_custom_products.push(label);
    if (!settings.mockup_products.includes(id)) settings.mockup_products.push(id);
    if (input) input.value = '';
    saveLocalSettings();
    root.querySelector('#pub-product-grid').innerHTML = renderProductChecks();
  }

  function removeCustomStyle(label) {
    const id = slugId(label);
    settings.redesign_custom_styles = settings.redesign_custom_styles.filter(item => item !== label);
    settings.redesign_style_presets = settings.redesign_style_presets.filter(item => item !== id);
    saveLocalSettings();
    root.querySelector('#pub-redesign-style-grid').innerHTML = renderStylePresetChecks();
    updateRedesignStyleState();
  }

  function removeCustomProduct(label) {
    const id = slugId(label);
    settings.mockup_custom_products = settings.mockup_custom_products.filter(item => item !== label);
    settings.mockup_products = settings.mockup_products.filter(item => item !== id);
    saveLocalSettings();
    root.querySelector('#pub-product-grid').innerHTML = renderProductChecks();
  }

  function buildPanel() {
    root = document.createElement('aside');
    root.id = 'pub-root';
    root.innerHTML = [
      '<header class="pub-head">',
      '  <div>',
      '    <div class="pub-title">Podhub GPTs Bridge EX</div>',
      `    <div class="pub-sub">v${chrome.runtime.getManifest().version} · Kết nối Custom GPTs với Podhub: Clone, Redesign, Mockup, Listing</div>`,
      '  </div>',
      '  <div class="pub-head-actions">',
      '    <button class="pub-icon-btn" type="button" data-action="reconnect-extension" title="Kết nối lại và đồng bộ">↻</button>',
      '    <button class="pub-icon-btn" type="button" data-action="config" title="Cấu hình">⚙</button>',
      '    <button class="pub-close" type="button">x</button>',
      '  </div>',
      '</header>',
      '<section class="pub-config">',
      '  <div class="pub-license-row">',
      `    <input id="pub-license-key" type="password" placeholder="phb_live_..." value="${escapeHtml(settings.license_key)}">`,
      '    <button class="pub-btn secondary" type="button" data-action="activate">KEY</button>',
      '  </div>',
      '  <div class="pub-account-status-row">',
      '    <div class="pub-account-status" data-role="account-status">Đang kiểm tra license...</div>',
      '    <button class="pub-btn pub-btn-logout" type="button" data-action="deactivate" hidden>Đăng xuất</button>',
      '  </div>',
      '  <label class="pub-runner-label"><span>Runner ID</span><button class="pub-help-btn" type="button" data-action="runner-help">?</button></label>',
      '  <div class="pub-field-row">',
      `    <input id="pub-runner-id" value="${escapeHtml(settings.runner_id)}">`,
      '    <button class="pub-btn secondary" type="button" data-action="save-settings">Save</button>',
      '  </div>',
      '  <div class="pub-note hidden" data-role="runner-note">Runner ID có thể giữ mặc định. Nếu muốn nhiều trình duyệt/profile dùng chung một runner thì nhập cùng ID.</div>',
      '  <div class="pub-config-tabs">',
      '    <button class="pub-config-tab active" type="button" data-config-module="clone">Clone</button>',
      '    <button class="pub-config-tab" type="button" data-config-module="redesign">Redesign</button>',
      '    <button class="pub-config-tab" type="button" data-config-module="mockup">Mockup</button>',
      '  </div>',
      '  <div class="pub-config-panel active" data-config-panel="clone">',
      `    ${flowTextHtml('clone')}`,
      '    <div class="pub-clone-options">',
      `      <label class="pub-check"><input id="pub-clone-with-background" type="checkbox" ${settings.clone_with_background ? 'checked' : ''}><span>Clone kèm nền</span></label>`,
      `      <label class="pub-check"><input id="pub-clone-remove-background-gpt" type="checkbox" ${settings.clone_remove_background_gpt ? 'checked' : ''}><span>Xóa nền bằng GPTs</span></label>`,
      '    </div>',
      '    <div class="pub-note">Không chọn option: chỉ gửi ảnh. Chọn cả hai: clone ảnh có nền trước, sau đó xóa nền và chỉ lưu ảnh cuối.</div>',
      '  </div>',
      '  <div class="pub-config-panel" data-config-panel="redesign">',
      `    ${flowTextHtml('redesign')}`,
      '    <label data-role="redesign-count-field">Số lượng redesign</label>',
      '    <div class="pub-field-row" data-role="redesign-count-field">',
      `      <input id="pub-redesign-count" type="number" min="1" max="${redesignMaxStyles()}" value="${escapeHtml(Math.min(redesignMaxStyles(), settings.redesign_count || 4))}">`,
      '      <button class="pub-btn secondary" type="button" data-action="save-settings">Save</button>',
      '    </div>',
      `    <label class="pub-check"><input id="pub-redesign-auto-style" type="checkbox" ${settings.redesign_auto_style ? 'checked' : ''}>Tự động chọn style <span style="color:#64748b;font-weight:400">GPT tự tạo style phù hợp</span></label>`,
      '    <label>Style cài đặt sẵn từ server</label>',
      `    <div id="pub-redesign-style-grid" class="pub-style-preset-grid">${renderStylePresetChecks()}</div>`,
      '    <label>Style user nhập thêm</label>',
      '    <div class="pub-add-row">',
      '      <input id="pub-redesign-custom-style" placeholder="Ví dụ: western vintage, cute mom quote...">',
      '      <button class="pub-btn secondary" type="button" data-action="add-style">Thêm</button>',
      '    </div>',
      '    <label>Cấu hình sàn listing</label>',
      `    <div id="pub-redesign-market-grid" class="pub-check-grid">${renderListingChecks('pub-redesign-market', settings.redesign_listing_markets)}</div>`,
      '  </div>',
      '  <div class="pub-config-panel" data-config-panel="mockup">',
      `    ${flowTextHtml('mockup')}`,
      '    <div class="pub-mockup-quick-row">',
      '      <label><span>Số ảnh / Sản phẩm</span>',
      `        <input id="pub-mockup-count" type="number" min="1" max="10" value="${escapeHtml(settings.mockup_count)}">`,
      '      </label>',
      '      <label><span>Tỉ lệ ảnh</span>',
      `        <select id="pub-mockup-aspect-ratio">${renderAspectRatioOptions()}</select>`,
      '      </label>',
      '      <button class="pub-btn secondary" type="button" data-action="save-settings">Save</button>',
      '    </div>',
      '    <label>Cấu hình sản phẩm</label>',
      `    <div id="pub-product-grid" class="pub-check-grid">${renderProductChecks()}</div>`,
      '    <div class="pub-add-row">',
      '      <input id="pub-mockup-custom-product" placeholder="Ví dụ: hoodie, poster, canvas...">',
      '      <button class="pub-btn secondary" type="button" data-action="add-product">Thêm</button>',
      '    </div>',
      '    <label>Cấu hình sàn listing</label>',
      `    <div id="pub-mockup-market-grid" class="pub-check-grid">${renderListingChecks('pub-market', settings.listing_markets)}</div>`,
      '  </div>',
      '</section>',
      '<nav class="pub-tabs">',
      '  <button class="pub-tab active" type="button" data-module="clone">Clone</button>',
      '  <button class="pub-tab" type="button" data-module="redesign">Redesign</button>',
      '  <button class="pub-tab" type="button" data-module="mockup">Mockup</button>',
      '</nav>',
      '<main class="pub-body">',
      '  <div class="pub-muted" data-role="summary"><span class="pub-module-label">Clone module</span></div>',
      '  <div class="pub-filter-row">',
      '    <button class="pub-filter active" type="button" data-filter="pending">Pending</button>',
      '    <button class="pub-filter" type="button" data-filter="failed">Failed</button>',
      '    <button class="pub-filter" type="button" data-filter="done">Done</button>',
      '    <button class="pub-filter pub-select-all" type="button" data-action="select-all">Chọn tất cả</button>',
      '  </div>',
      '  <div class="pub-job-list"></div>',
      '</main>',
      '  <div class="pub-raw-actions">',
      '    <span data-role="raw-count">Đã chọn 0 ảnh</span>',
      '    <button class="pub-btn" type="button" data-action="queue-mockup">Tạo Mockup</button>',
      '  </div>',
      '  <div class="pub-actions pub-bottom-actions">',
      '    <button class="pub-btn secondary" type="button" data-action="refresh">Refresh jobs</button>',
      '    <button class="pub-btn pub-run-compact" type="button" data-action="run" title="Chạy các job đã chọn">RUN</button>',
      '    <button class="pub-btn pub-delete-selected" type="button" data-action="delete-selected" title="Xoá các job đã chọn">Xoá</button>',
      '  </div>',
      '<pre class="pub-log">Podhub GPTs Bridge EX ready.</pre>'
    ].join('');
    document.body.appendChild(root);

    launcher = document.createElement('button');
    launcher.id = 'pub-launcher';
    launcher.textContent = 'P';
    launcher.title = 'Podhub GPTs Bridge EX';
    document.body.appendChild(launcher);

    floatingStop = document.createElement('button');
    floatingStop.id = 'pub-floating-stop';
    floatingStop.type = 'button';
    floatingStop.textContent = 'STOP';
    floatingStop.title = 'Dừng tác vụ Podhub đang chạy';
    floatingStop.addEventListener('click', stopRun);
    document.body.appendChild(floatingStop);

    if (dashboardOpenPending) revealDashboard();

    launcher.addEventListener('click', () => {
      const visible = root.classList.toggle('pub-visible');
      launcher.classList.toggle('active', visible);
      if (visible) loadJobs().catch(error => setLog(error.message));
    });
    root.querySelector('.pub-close').addEventListener('click', () => {
      root.classList.remove('pub-visible');
      launcher.classList.remove('active');
    });
    root.querySelector('[data-action="reconnect-extension"]').addEventListener('click', async () => {
      setLog('Đang kết nối lại và đồng bộ với Podhub...');
      try {
        const stateResponse = await send({type: 'PUB_GET_STATE'});
        if (!stateResponse?.ok) throw new Error(stateResponse?.error || 'EXTENSION_SESSION_CHECK_FAILED');
        serverConfig = stateResponse.data?.config || serverConfig;
        setAccountStatus(stateResponse.data || {});
        await refreshServerConfig();
        await loadJobs();
        setLog(`Đã kết nối lại Podhub · ${activeModule}: ${jobs.length} jobs.`);
      } catch (error) {
        setLog(error.message || 'EXTENSION_RECONNECT_FAILED');
      }
    });
    root.querySelector('[data-action="config"]').addEventListener('click', () => {
      const open = root.querySelector('.pub-config').classList.toggle('visible');
      root.classList.toggle('config-open', open);
      if (open) refreshServerConfig().catch(error => setLog(error.message));
    });
    root.querySelectorAll('.pub-config-tab').forEach(button => {
      button.addEventListener('click', () => setConfigTab(button.dataset.configModule));
    });
    root.querySelector('[data-action="activate"]').addEventListener('click', () => activateLicense().catch(error => setLog(error.message)));
    root.querySelector('[data-action="deactivate"]').addEventListener('click', () => deactivateLicense().catch(error => setLog(error.message)));
    root.querySelectorAll('[data-action="save-settings"]').forEach(button => {
      button.addEventListener('click', saveSettingsFromButton);
    });
    root.querySelector('[data-action="runner-help"]').addEventListener('click', () => {
      root.querySelector('[data-role="runner-note"]').classList.toggle('hidden');
    });
    root.querySelector('[data-action="add-style"]').addEventListener('click', addCustomStyle);
    root.querySelector('[data-action="add-product"]').addEventListener('click', addCustomProduct);
    root.querySelector('#pub-redesign-custom-style').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addCustomStyle();
      }
    });
    root.querySelector('#pub-mockup-custom-product').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addCustomProduct();
      }
    });
    root.querySelector('.pub-config').addEventListener('change', syncSettingsFromConfig);
    root.querySelector('.pub-config').addEventListener('input', syncSettingsFromConfig);
    root.querySelector('.pub-config').addEventListener('click', event => {
      const style = event.target?.dataset?.removeStyle;
      const product = event.target?.dataset?.removeProduct;
      if (style) {
        event.preventDefault();
        event.stopPropagation();
        removeCustomStyle(style);
      }
      if (product) {
        event.preventDefault();
        event.stopPropagation();
        removeCustomProduct(product);
      }
    });
    updateRedesignStyleState();
    root.querySelector('[data-action="refresh"]').addEventListener('click', () => loadJobs().catch(error => setLog(error.message)));
    root.querySelector('[data-action="run"]').addEventListener('click', () => runSelectedOrNext().catch(error => setLog(error.message)));
    root.querySelector('[data-action="select-all"]').addEventListener('click', toggleSelectAllJobs);
    root.querySelector('[data-action="delete-selected"]').addEventListener('click', () => deleteSelectedJobs().catch(error => setLog(error.message)));
    root.querySelector('[data-action="queue-mockup"]').addEventListener('click', () => queueSelectedRawForMockup().catch(error => setLog(error.message)));
    root.querySelector('.pub-log').addEventListener('click', event => event.currentTarget.classList.toggle('expanded'));
    root.querySelectorAll('.pub-tab').forEach(button => {
      button.addEventListener('click', () => setModule(button.dataset.module));
    });
    root.querySelectorAll('.pub-filter[data-filter]').forEach(button => {
      button.addEventListener('click', () => {
        queueFilter = button.dataset.filter;
        renderJobs();
      });
    });
  }

  async function init() {
    loadLocalSettings();
    buildPanel();
    const dashboardRequest = await chrome.storage.local.get(['pub_open_dashboard_requested']);
    if (dashboardRequest.pub_open_dashboard_requested) {
      revealDashboard();
      await chrome.storage.local.remove(['pub_open_dashboard_requested']);
    }
    const stateResponse = await send({type: 'PUB_GET_STATE'});
    if (stateResponse?.ok) {
      serverConfig = stateResponse.data?.config || serverConfig;
      setAccountStatus(stateResponse.data || {});
      refreshConfigUi();
    }
    const response = await send({type: 'PUB_GET_ACTIVE_RUN'});
    activeRun = response?.data || null;
    if (activeRun?.module_id) {
      root.classList.add('pub-visible');
      launcher.classList.add('active');
      setModule(activeRun.module_id);
      setLog({
        module: activeRun.module_id,
        job_id: jobId(activeRun.job || {}) || null,
        title: titleOf(activeRun.job || {}) || null,
        image_url: imageUrl(activeRun.job || {}) || null
      });
      if (!runnerStarted && activeRun.job) {
        runnerStarted = true;
        setTimeout(() => runActiveBridgeJobs(activeRun), 1200);
      }
    } else {
      renderJobs();
    }
  }

  init().catch(error => {
    console.error('[Podhub Bridge] Dashboard init failed:', error);
    if (root) {
      root.classList.add('pub-visible');
      launcher?.classList.add('active');
      setLog(`Dashboard init failed: ${error.message || error}`);
    }
  });
})();
