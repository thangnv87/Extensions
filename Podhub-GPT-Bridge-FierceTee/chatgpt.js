/* Podhub GPTs v1.0 — Tong hop v3.4
   - Luon dung Podhub VPS (bo local/dual mode)
   - Phase A JSON + Phase B anh, /gpt-result, filename bg_color, batch/reload
   - Job management: them/sua/xoa job trong panel
*/
(function () {
  'use strict';
  if (document.getElementById('phb-root-gpts')) return;

  const VERSION = '1.0.0-ft';
  const POLL_FAST_MS = 450;
  const POLL_MED_MS = 900;
  const POLL_STABLE_ROUNDS = 3;
  const MAX_WAIT_TEXT_MS = 5 * 60 * 1000;

  const PODHUB_ORIGIN = 'https://ex.podhub.space';
  const TOOLS_ORIGIN = 'https://tools.podhub.space';
  const PARTNER_NAME = 'FierceTee';
  const PARTNER_TEAM_NAME = 'fiercetee';
  const PARTNER_DATA_ORIGIN = 'https://api.fiercetee.com';
  const RAILWAY_ORIGIN = PODHUB_ORIGIN;
  const TEAM_ROUTING_STORAGE_KEY = 'phb_team_routing';
  const TEAM_ROUTING_REFRESH_MARGIN_MS = 60 * 1000;
  const ROUTABLE_DATA_ORIGINS = new Set([
    PODHUB_ORIGIN,
    'https://www.ex.podhub.space'
  ]);

  // Luon dung Podhub VPS, khong co local/dual mode
  function getOrigin(target) {
    if (typeof target === 'string' && /^https?:\/\//i.test(target)) return target;
    if (target && typeof target === 'object' && target._serverOrigin) return target._serverOrigin;
    return PODHUB_ORIGIN;
  }
  function getQueueApi(origin = getOrigin()) { return getOrigin(origin) + '/api/ext-queue'; }
  function getLibApi(origin = getOrigin()) { return getOrigin(origin) + '/api/raw-designs'; }

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

  // ============ API HELPERS ============
  async function requestJson(url, pathOrOptions = {}, maybeOptions) {
    let finalUrl = url;
    let options = pathOrOptions || {};
    if (typeof pathOrOptions === 'string') {
      finalUrl = String(url).replace(/\/+$/, '') + '/' + String(pathOrOptions).replace(/^\/+/, '');
      options = maybeOptions || {};
    }

    const routed = await routeTeamRequest(finalUrl);
    finalUrl = routed.url;

    // Tools JWT chi gui ve tools.podhub.space. Team server nhan token routing
    // rieng, tranh lam lo session quan ly trung tam cho server doi tac.
    const token = await getExtensionToken();
    if (routed.teamAccessToken) {
      options.headers = {
        ...(options.headers || {}),
        'X-Podhub-Team-Token': routed.teamAccessToken
      };
    } else if (token) {
      options.headers = {
        ...(options.headers || {}),
        'Authorization': 'Bearer ' + token
      };
    }
    const machineId = await getMachineFingerprint();
    options.headers = {
      ...(options.headers || {}),
      'X-Machine-ID': machineId
    };

    const r = await fetch(finalUrl, options);
    let data = null;
    try { data = await r.json(); } catch(e) {}
    if (r.status === 401 && (data?.error === 'SESSION_KICKED' || /thiết bị khác|device/i.test(data?.message || ''))) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(['phb_license_token','phb_license_user']);
      }
      localStorage.removeItem('phb_license_token');
      alert('🚨 Tài khoản của bạn đã được đăng nhập trên một thiết bị/máy tính khác! Bạn đã bị đăng xuất khỏi thiết bị này.');
      window.location.reload();
      throw new Error('SESSION_KICKED');
    }
    if (!r.ok) {
      const rawMsg = data?.error?.message || data?.error || data?.message || r.statusText || 'HTTP ' + r.status;
      let msg = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
      if ((r.status === 401 || r.status === 403) && /ex\.podhub\.space/i.test(finalUrl)) {
        msg += ' (Phiên truy cập pipeline cũ không còn hợp lệ.)';
      }
      throw new Error(r.status + ' ' + msg);
    }
    return data || {};
  }
  const jsonHeaders = {'Content-Type':'application/json'};
  const sleep = ms => new Promise(r => setTimeout(r, ms)); // khai bao som, dung boi retryAsync va nhieu noi khac
  const apiGetFrom  = (origin,p) => requestJson(getQueueApi(origin) + p);
  const apiPostTo = (origin,p,b) => requestJson(getQueueApi(origin) + p, {method:'POST', headers:jsonHeaders, body:JSON.stringify(b)});
  const apiDelFrom  = (origin,p) => requestJson(getQueueApi(origin) + p, {method:'DELETE'});
  const apiPatchFrom = (origin,p,b) => requestJson(getQueueApi(origin) + p, {method:'PATCH', headers:jsonHeaders, body:JSON.stringify(b)});
  const libGetFrom = (origin,p) => requestJson(getLibApi(origin) + p);
  const libPostTo = (origin,p,b) => requestJson(getLibApi(origin) + p, {method:'POST', headers:jsonHeaders, body:JSON.stringify(b)});
  const apiGet  = p => apiGetFrom(RAILWAY_ORIGIN, p);
  const apiPost = (p,b) => apiPostTo(RAILWAY_ORIGIN, p, b);
  const apiDel  = p => apiDelFrom(RAILWAY_ORIGIN, p);
  const libGet = p => libGetFrom(RAILWAY_ORIGIN, p);
  const libPost = (p,b) => libPostTo(RAILWAY_ORIGIN, p, b);

  // ============ CHROME STORAGE / TOKEN ============
  function chromeStorageGet(keys) {
    return new Promise(resolve => {
      try {
        if (!chrome?.storage?.local) return resolve({});
        chrome.storage.local.get(keys, resolve);
      } catch(e) {
        resolve({});
      }
    });
  }

  function chromeStorageSet(obj) {
    return new Promise(resolve => {
      try {
        if (!chrome?.storage?.local) return resolve(false);
        chrome.storage.local.set(obj, () => resolve(true));
      } catch(e) {
        resolve(false);
      }
    });
  }

  async function getExtensionToken() {
    const data = await chromeStorageGet(['phb_license_token']);
    return String(data?.phb_license_token || '').trim();
  }

  function decodeJwtExpiry(token) {
    try {
      const segment = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = segment + '='.repeat((4 - segment.length % 4) % 4);
      const payload = JSON.parse(atob(padded));
      return Number(payload.exp || 0) * 1000;
    } catch (_) {
      return 0;
    }
  }

  function normalizeTeamRouting(value) {
    let apiBaseUrl = '';
    try {
      const parsed = new URL(String(value?.api_base_url || PODHUB_ORIGIN));
      if (parsed.protocol === 'https:') apiBaseUrl = parsed.origin;
    } catch (_) {}
    const teamAccessToken = String(value?.team_access_token || '');
    return {
      team_id: value?.team_id || null,
      team_name: value?.team_name || null,
      api_base_url: apiBaseUrl || PODHUB_ORIGIN,
      audience: value?.audience || 'podhub-ex-api',
      config_version: Number(value?.config_version || 1),
      team_access_token: teamAccessToken,
      expires_at: Number(value?.expires_at || decodeJwtExpiry(teamAccessToken) || 0)
    };
  }

  function isUsableTeamRouting(value) {
    return Boolean(
      value?.team_id &&
      String(value?.team_name || '').trim().toLowerCase() === PARTNER_TEAM_NAME &&
      value?.api_base_url === PARTNER_DATA_ORIGIN &&
      value?.team_access_token &&
      value?.api_base_url &&
      Number(value.expires_at || 0) > Date.now() + TEAM_ROUTING_REFRESH_MARGIN_MS
    );
  }

  function assertPartnerRouting(value) {
    if (String(value?.team_name || '').trim().toLowerCase() !== PARTNER_TEAM_NAME ||
        value?.api_base_url !== PARTNER_DATA_ORIGIN) {
      throw new Error(`Key này không thuộc team ${PARTNER_NAME}.`);
    }
    return value;
  }

  async function ensureOriginPermission(origin) {
    if (!origin || ROUTABLE_DATA_ORIGINS.has(origin)) return true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'PODHUB_ENSURE_ORIGIN_PERMISSION',
        origin
      });
      return Boolean(response?.granted);
    } catch (_) {
      return false;
    }
  }

  async function refreshTeamRouting() {
    const token = await getExtensionToken();
    if (!token) return null;
    const response = await fetch(TOOLS_ORIGIN + '/api/extension/routing', {
      headers: {Authorization: 'Bearer ' + token}
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || 'Khong lam moi duoc routing team');
    }
    const routing = assertPartnerRouting(normalizeTeamRouting(payload.data?.routing || payload.data));
    await ensureOriginPermission(routing.api_base_url);
    await chromeStorageSet({[TEAM_ROUTING_STORAGE_KEY]: routing});
    return routing;
  }

  async function getTeamRouting() {
    const saved = await chromeStorageGet([TEAM_ROUTING_STORAGE_KEY]);
    const routing = normalizeTeamRouting(saved?.[TEAM_ROUTING_STORAGE_KEY]);
    if (isUsableTeamRouting(routing)) return routing;
    try {
      return await refreshTeamRouting();
    } catch (error) {
      if (routing?.team_access_token && Number(routing.expires_at || 0) > Date.now()) return routing;
      throw error;
    }
  }

  async function routeTeamRequest(inputUrl) {
    let parsed;
    try {
      parsed = new URL(String(inputUrl), location.href);
    } catch (_) {
      return {url: inputUrl, teamAccessToken: ''};
    }
    if (!ROUTABLE_DATA_ORIGINS.has(parsed.origin)) {
      return {url: parsed.href, teamAccessToken: ''};
    }
    const routing = await getTeamRouting();
    if (!isUsableTeamRouting(routing)) {
      return {url: parsed.href, teamAccessToken: ''};
    }
    const target = new URL(parsed.pathname + parsed.search + parsed.hash, routing.api_base_url);
    return {url: target.href, teamAccessToken: routing.team_access_token};
  }

  async function getAuthUser() {
    const data = await chromeStorageGet(['phb_auth_user']);
    return data?.phb_auth_user || null;
  }

  async function setExtensionToken(token) {
    const clean = String(token || '').trim();
    if (!clean) {
      localStorage.removeItem('phb_license_token');
      await chromeStorageSet({phb_license_token: ''});
      return;
    }
    localStorage.setItem('phb_license_token', clean);
    await chromeStorageSet({phb_license_token: clean});
  }

  async function getOrCreateInstallationId() {
    const data = await chromeStorageGet(['phb_installation_id']);
    if (data?.phb_installation_id) return data.phb_installation_id;
    const id = crypto.randomUUID();
    await chromeStorageSet({ phb_installation_id: id });
    return id;
  }

  async function activateLicense(licenseKey) {
    const installationId = await getOrCreateInstallationId();
    const response = await fetch(TOOLS_ORIGIN + '/api/extension/activate', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        license_key: String(licenseKey || '').trim(),
        installation_id: installationId,
        browser_name: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome',
        browser_version: navigator.userAgent,
        os: navigator.platform,
        extension_version: VERSION
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) throw new Error(payload.error || 'Kích hoạt license thất bại');
    await chromeStorageSet({
      phb_license_token: payload.data.access_token,
      phb_license_user: payload.data.user,
      phb_license_limit: payload.data.installation_limit,
      [TEAM_ROUTING_STORAGE_KEY]: assertPartnerRouting(normalizeTeamRouting(payload.data.routing))
    });
    const routing = assertPartnerRouting(normalizeTeamRouting(payload.data.routing));
    await ensureOriginPermission(routing.api_base_url);
    return payload.data;
  }

  const sourceMockupUploads = new Set();
  async function uploadSourceMockupToTools(job, token) {
    const jobId = String(job?.id || '').trim();
    const sourceUrl = String(job?.sourceImageUrl || '').trim();
    if (!jobId || !sourceUrl || sourceMockupUploads.has(jobId)) return;
    let directError = null;
    try {
      const imageResponse = await fetch(sourceUrl, {credentials:'include'});
      if (!imageResponse.ok) throw new Error(`Khong tai duoc mockup goc: HTTP ${imageResponse.status}`);
      const blob = await imageResponse.blob();
      const params = new URLSearchParams({
        job_id:jobId,
        image_id:'source-mockup',
        filename:`${jobId}-source-mockup.png`,
        role:'source_mockup',
        asset_id:normalizeJobAssetId(job)
      });
      const response = await fetch(TOOLS_ORIGIN + '/api/extension/raw-design/upload?' + params, {
        method:'POST',
        headers:{Authorization:'Bearer ' + token,'Content-Type':blob.type || 'image/png'},
        body:blob
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || `Tools Source Mockup HTTP ${response.status}`);
    } catch (error) {
      directError = error;
      const response = await fetch(TOOLS_ORIGIN + '/api/extension/source-mockup/import-url', {
        method:'POST',
        headers:{Authorization:'Bearer ' + token,'Content-Type':'application/json'},
        body:JSON.stringify({
          job_id:jobId,
          source_url:sourceUrl,
          asset_id:normalizeJobAssetId(job)
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || directError.message || `Tools Source Mockup HTTP ${response.status}`);
      }
      log('Tools Source Mockup: server da tai anh goc thay extension');
    }
    sourceMockupUploads.add(jobId);
  }

  async function uploadRawDesignToTools(job, image) {
    const token = await getExtensionToken();
    if (!token) throw new Error('Chua kich hoat Extension License tren tools.podhub.space');
    // The source marketplace mockup is useful metadata, but Etsy/Amazon may
    // reject browser-side fetches (CORS/hotlink protection). Never let that
    // optional upload block the generated redesign image.
    try {
      await uploadSourceMockupToTools(job, token);
    } catch (sourceError) {
      log(`Tools Source Mockup bo qua: ${sourceError.message}`);
    }
    const source = image.dataUrl || image.imageUrl;
    if (!source) throw new Error('Raw Design khong co du lieu anh');
    const imageResponse = await fetch(source, {credentials:'include'});
    if (!imageResponse.ok) throw new Error(`Khong tai duoc anh GPT: HTTP ${imageResponse.status}`);
    const blob = await imageResponse.blob();
    const imageId = String(image.design_id || `${image.style_id || image.style || 'style'}-${image.image_no || 1}`);
    const filename = String(image.filename || `${imageId}.png`);
    const params = new URLSearchParams({
      job_id:String(job.id),
      image_id:imageId,
      filename,
      asset_id:normalizeJobAssetId(job),
      variant_index:String(image.style_id || image.style || image.image_no || 1),
      product_type:getBlankCode(image),
      background_color_name:String(image.primary_shirt_color || image.background_color || getStyleShirtColor(image) || ''),
      background_color_slug:String(image.background_color_slug || slugify(image.primary_shirt_color || image.background_color || getStyleShirtColor(image) || '')),
      mockup_match_key:String(image.background_color_tag || getBlankColorTag(image))
    });
    const response = await fetch(TOOLS_ORIGIN + '/api/extension/raw-design/upload?' + params, {
      method:'POST',
      headers:{Authorization:'Bearer ' + token,'Content-Type':blob.type || 'image/png'},
      body:blob
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) throw new Error(payload.error || `Tools Raw Design HTTP ${response.status}`);
    return payload.data;
  }

  const WORKFLOW_REDESIGN_ONLY = 'redesign_only';
  const WORKFLOW_REDESIGN_LISTING = 'redesign_listing';
  const DEFAULT_PIPELINE = {
    workflow_mode:WORKFLOW_REDESIGN_ONLY,
    features:{analyze_styles:true,generate_image_prompts:true,generate_images:true,listings:{walmart:false,shopify:false,etsy:false}},
    max_styles:8,analysis_prompt:'',listing_prompt:''
  };
  let activePipelineConfig = DEFAULT_PIPELINE;
  function normalizeWorkflowMode(value, fallback = WORKFLOW_REDESIGN_ONLY) {
    const mode = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (['redesign_listing','redesign_and_listing','listing','full_listing'].includes(mode)) return WORKFLOW_REDESIGN_LISTING;
    if (['redesign_only','redesign','design_only'].includes(mode)) return WORKFLOW_REDESIGN_ONLY;
    return fallback;
  }
  function normalizeMarketplaceList(value) {
    const supported = new Set(['walmart','shopify','etsy']);
    let items = [];
    if (Array.isArray(value)) items = value;
    else if (typeof value === 'string') items = value.split(/[,;\s]+/);
    else if (value && typeof value === 'object') items = Object.entries(value).filter(([,enabled]) => enabled === true).map(([name]) => name);
    return Array.from(new Set(items.map(name => String(name || '').trim().toLowerCase()).filter(name => supported.has(name))));
  }
  function normalizePipelineConfig(value) {
    const p=value&&typeof value==='object'?value:{};
    const f=p.features&&typeof p.features==='object'?p.features:{};
    const l=f.listings&&typeof f.listings==='object'?f.listings:{};
    const listings={walmart:l.walmart===true,shopify:l.shopify===true,etsy:l.etsy===true};
    const configuredMarkets=normalizeMarketplaceList(listings);
    const fallbackMode=configuredMarkets.length?WORKFLOW_REDESIGN_LISTING:WORKFLOW_REDESIGN_ONLY;
    return {...DEFAULT_PIPELINE,...p,workflow_mode:normalizeWorkflowMode(p.workflow_mode||p.output_mode,fallbackMode),features:{analyze_styles:f.analyze_styles!==false,
      generate_image_prompts:f.generate_image_prompts!==false,generate_images:f.generate_images!==false,
      listings}};
  }
  function resolveWorkflow(job, batch) {
    const meta=batch?.meta||{};
    const batchMarkets=normalizeMarketplaceList(meta.marketplaces);
    const jobMarkets=normalizeMarketplaceList(
      job?.marketplaces||job?.listing_marketplaces||job?.output_marketplaces||
      job?.pipeline?.marketplaces||job?.metadata?.marketplaces
    );
    const configuredMarkets=normalizeMarketplaceList(activePipelineConfig?.features?.listings);
    const markets=batchMarkets.length?batchMarkets:(jobMarkets.length?jobMarkets:configuredMarkets);
    const requestedMode=meta.workflow_mode||job?.workflow_mode||job?.output_mode||
      job?.pipeline?.workflow_mode||job?.metadata?.workflow_mode||activePipelineConfig?.workflow_mode;
    const normalizedMode=normalizeWorkflowMode(requestedMode,markets.length?WORKFLOW_REDESIGN_LISTING:WORKFLOW_REDESIGN_ONLY);
    const mode=normalizedMode===WORKFLOW_REDESIGN_LISTING&&markets.length===0
      ? WORKFLOW_REDESIGN_ONLY
      : normalizedMode;
    return {mode,marketplaces:mode===WORKFLOW_REDESIGN_LISTING?markets:[]};
  }
  function enabledMarketplaces(job, batch) {
    return resolveWorkflow(job,batch).marketplaces;
  }
  function fillPipelineTemplate(text, values) {
    return String(text||'').replace(/\{\{(\w+)\}\}/g,(_,key)=>String(values[key]??''));
  }
  async function getActiveGptUrl() {
    const data = await chromeStorageGet(['phb_license_token']);
    if (!data?.phb_license_token) throw new Error('Vui lòng nhập Extension License Key trước khi chạy.');
    const response = await fetch(TOOLS_ORIGIN + '/api/extension/config', {
      headers: {Authorization: 'Bearer ' + data.phb_license_token}
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await chromeStorageSet({phb_license_token:'',phb_license_user:null});
      throw new Error('License đã bị thu hồi hoặc được kích hoạt trên trình duyệt khác.');
    }
    if (!response.ok || !payload.success) throw new Error(payload.error || 'Không lấy được cấu hình GPT');
    const url = payload.data?.gpt_links?.['design-multiplier-gpts']?.url;
    if (!url) throw new Error('Admin chưa cấu hình link Redesign Multiplier GPTs.');
    activePipelineConfig=normalizePipelineConfig(payload.data?.pipeline);
    imageGenEnabled=activePipelineConfig.features.generate_images;
    await chromeStorageSet({phb_pipeline_config:activePipelineConfig});
    return url;
  }

  async function reportGeneratedImage(job, style) {
    if (!job || !style || !(style.image_url || style.image_data_url || style.raw_design_url || style.raw_design_asset_id)) return;
    const data = await chromeStorageGet(['phb_license_token']);
    if (!data?.phb_license_token) return;
    const jobId = String(job.id || job.assetId || '').trim();
    const imageId = String(style.style_id || style.design_id || style.raw_design_asset_id || '').trim();
    if (!jobId || !imageId) return;
    try {
      await fetch(TOOLS_ORIGIN + '/api/extension/usage/image', {
        method: 'POST',
        headers: {'Content-Type':'application/json',Authorization:'Bearer ' + data.phb_license_token},
        body: JSON.stringify({job_id:jobId,image_id:imageId})
      });
    } catch (_) {}
  }

  const RUNNER_KEY = 'phb_gpts_runner_id';
  function makeRunnerId() {
    return 'GPT-' + Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Date.now().toString(36).slice(-4).toUpperCase();
  }
  function getRunnerId() {
    let id = String(localStorage.getItem(RUNNER_KEY) || '').trim();
    if (!id) {
      id = makeRunnerId();
      localStorage.setItem(RUNNER_KEY, id);
    }
    return id;
  }
  function setRunnerId(id) {
    const clean = String(id || '').trim().replace(/[^\w .:@-]+/g, '-').slice(0, 48) || makeRunnerId();
    localStorage.setItem(RUNNER_KEY, clean);
    return clean;
  }
  let runnerId = getRunnerId();

  // Helper retry: thu lai toi da maxRetries lan, doi delayMs giua cac lan
  // Chi retry khi loi la network (Failed to fetch) hoac 5xx
  async function retryAsync(fn, maxRetries = 3, delayMs = 3000, label = '') {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch(e) {
        lastErr = e;
        const isNetwork = /failed to fetch|networkerror|load failed|net::/i.test(e.message || '');
        const is5xx = /^5\d\d /.test(e.message || '');
        if (attempt < maxRetries && (isNetwork || is5xx)) {
          const wait = delayMs * attempt;
          log((label ? label + ': ' : '') + `Lan ${attempt} that bai (${e.message}), thu lai sau ${wait/1000}s...`);
          await sleep(wait);
        } else {
          break;
        }
      }
    }
    throw lastErr;
  }

  // Khai bao som de KHONG gap TDZ khi postJobToLocalhost hoac bat ky function nao dung
  const PIPELINE_SCHEMA_VERSION = 'podhub_gpt_batch_v1';
  const PIPELINE_SOURCE = 'chatgpt_extension';

  // Mau nen POD duoc phep (khong transparent, khong mau khac)
  const ALLOWED_BG_COLORS = [
    'Black',
    'Navy',
    'Dark Heather',
    'Sport Grey',
    'White',
    'Light Pink',
    'Light Blue',
    'Sand'
  ];
  const ALLOWED_BG_COLORS_LOWER = new Set(ALLOWED_BG_COLORS.map(c => c.toLowerCase()));
  const BG_COLOR_ALIASES = {
    black: 'Black',
    charcoal: 'Black',
    graphite: 'Black',
    navy: 'Navy',
    'dark navy': 'Navy',
    'dark heather': 'Dark Heather',
    darkheather: 'Dark Heather',
    heather: 'Dark Heather',
    'sport grey': 'Sport Grey',
    'sport gray': 'Sport Grey',
    sportgrey: 'Sport Grey',
    sportgray: 'Sport Grey',
    grey: 'Sport Grey',
    gray: 'Sport Grey',
    'ash grey': 'Sport Grey',
    white: 'White',
    ivory: 'White',
    natural: 'White',
    'light pink': 'Light Pink',
    lightpink: 'Light Pink',
    pink: 'Light Pink',
    blossom: 'Light Pink',
    blush: 'Light Pink',
    'light blue': 'Light Blue',
    lightblue: 'Light Blue',
    'powder blue': 'Light Blue',
    skyblue: 'Light Blue',
    chambray: 'Light Blue',
    sand: 'Sand',
    beige: 'Sand',
    sandstone: 'Sand',
    tan: 'Sand',
    khaki: 'Sand'
  };

  function buildBackgroundColorPromptRule() {
    return '';
  }

  function normalizeAllowedBackgroundColor(raw, fallback = 'White') {
    const s = String(raw || '').trim().toLowerCase();
    if (!s || s === 'unknown background' || s === 'unknown_background') {
      return fallback && ALLOWED_BG_COLORS.includes(fallback) ? fallback : '';
    }
    if (/transparent|clear|none|no background/i.test(s)) {
      return fallback && ALLOWED_BG_COLORS.includes(fallback) ? fallback : '';
    }
    if (ALLOWED_BG_COLORS_LOWER.has(s)) {
      return ALLOWED_BG_COLORS.find(c => c.toLowerCase() === s);
    }
    if (BG_COLOR_ALIASES[s]) return BG_COLOR_ALIASES[s];
    for (const allowed of ALLOWED_BG_COLORS) {
      if (s.includes(allowed.toLowerCase()) || allowed.toLowerCase().includes(s)) return allowed;
    }
    for (const [alias, canonical] of Object.entries(BG_COLOR_ALIASES)) {
      if (s.includes(alias) || alias.includes(s)) return canonical;
    }
    return fallback && ALLOWED_BG_COLORS.includes(fallback) ? fallback : '';
  }

  function getStyleBlank(style) {
    return style?.best_blank || style?.blank || style?.blank_type || style?.blankType ||
      style?.apparel_blank || style?.apparelBlank || style?.product_blank || style?.productBlank ||
      style?.garment_blank || style?.garmentBlank || style?.shirt_blank || style?.shirtBlank || '';
  }

  function getStyleShirtColor(style) {
    return style?.primary_shirt_color || style?.primaryShirtColor ||
      style?.shirt_color || style?.shirtColor ||
      style?.garment_color || style?.garmentColor ||
      style?.product_color || style?.productColor ||
      style?.background_color || style?.backgroundColor ||
      getStyleBackgroundColor(style);
  }

  function compactNameForTag(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/gi, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }

  function getBlankCode(style) {
    const raw = String(getStyleBlank(style) || '').trim();
    if (/comfort\s*colors|comfort\s*color/i.test(raw)) return 'ComfortColors1717';
    if (/gildan\s*5000/i.test(raw) || /^gildan$/i.test(raw)) return 'Gildan5000';
    return compactNameForTag(raw) || 'Blank';
  }

  function getBlankColorTag(style) {
    const blank = getBlankCode(style);
    const color = compactNameForTag(getStyleShirtColor(style)) || 'Unknown';
    return `${blank}-${color}`;
  }

  function deriveShortTitle(title) {
    const text = String(title || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= 60) return text;
    const cut = text.slice(0, 60).replace(/\s+\S*$/, '').trim();
    return cut || text.slice(0, 60).trim();
  }

  function deriveShelfDescription(description, title) {
    const text = String(description || title || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= 250) return text;
    const cut = text.slice(0, 250).replace(/\s+\S*$/, '').trim();
    return cut || text.slice(0, 250).trim();
  }

  function normalizeKeywordArray(value, title = '', max = 30) {
    let arr = [];
    if (Array.isArray(value)) {
      arr = value;
    } else if (typeof value === 'string') {
      arr = value.split(/[,;\n]+/);
    } else if (value && typeof value === 'object') {
      arr = Object.values(value);
    }
    const seen = new Set();
    const out = arr
      .map(v => String(v || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter(v => {
        const key = v.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, max);
    if (!out.length && title) {
      const base = String(title).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (base) out.push(base);
    }
    return out;
  }

  function applyStyleBackgroundColor(style, fallback = 'White') {
    const raw = style.primary_shirt_color || style.background_color || getStyleBackgroundColor(style);
    if (!raw || /unknown background|unknown_background/i.test(String(raw))) {
      style.background_color = '';
      style.background_color_slug = '';
      style.background_color_tag = '';
      return '';
    }
    const finalColor = String(raw).trim();
    if (!style.primary_shirt_color) style.primary_shirt_color = finalColor;
    style.background_color = finalColor;
    style.background_color_slug = slugify(finalColor);
    style.background_color_tag = getBlankColorTag(style);
    return finalColor;
  }

  // Da bo local mirror (chi con Podhub VPS)
  function postJobToLocalhost() {}

  async function postGptResultToServerOn(job, batch, rawResponse, phase, originOverride) {
    const ids = normalizeBatchForPipeline(job, batch);
    const serverBatch = buildServerBatchPayload(batch);
    const workflow = resolveWorkflow(job, batch);
    const eventType = phase === 'style_image_generated'
      ? 'raw_design.import.requested'
      : phase === 'phase_b_done'
        ? 'design.generation.completed'
        : 'gpt.batch.validated';
    const nextSteps = ['raw_design.import.requested', 'bg.removal.requested', 'mockup.requested'];
    if (workflow.mode === WORKFLOW_REDESIGN_LISTING) nextSteps.push('listing.requested');
    const payload = {
      schema_version: PIPELINE_SCHEMA_VERSION,
      source: PIPELINE_SOURCE,
      extension_version: VERSION,
      workflow_mode: workflow.mode,
      marketplaces: workflow.marketplaces,
      product_id: ids.product_id,
      job_id: ids.job_id,
      batch_id: ids.batch_id,
      status: phase,
      current_step: phase === 'style_image_generated' || phase === 'phase_b_done' ? 'design' : 'gpt',
      progress: countBatchProgress(batch),
      events: [{
        event_type: eventType,
        product_id: ids.product_id,
        job_id: ids.job_id,
        batch_id: ids.batch_id,
        created_at: new Date().toISOString(),
        next_steps: nextSteps
      }],
      batch: serverBatch,
      raw_response: rawResponse || null,
      completed_at: new Date().toISOString()
    };
    const base = (originOverride || getOrigin()) + '/api/ext-queue';
    const res = await requestJson(base, '/jobs/' + encodeURIComponent(job.id) + '/gpt-result', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload)
    });
    if (res?.data) mergeServerBatch(batch, res.data);
    return res;
  }

  function extractEtsyListingIdFromJob(job) {
    const fields = [
      job.etsyListingId, job.etsy_listing_id, job.etsyId, job.etsy_id,
      job.assetId, job.asin, job.title, job.prompt, job.sourceTitle,
      job.source_title, job.product_id, job.productId, job.marketplace_id,
      job.marketplaceId, job.batch?.meta?.source_title, job.batch?.meta?.asset_id,
      job.batch?.meta?.product_id
    ];
    for (const raw of fields) {
      const s = String(raw || '').trim();
      if (!s || /^etsystatic$/i.test(s) || /^i\.etsystatic\.com$/i.test(s)) continue;
      const legacy = s.match(/^Etsy\s+(\d{8,})$/i);
      if (legacy) return legacy[1];
      const prefixed = s.match(/^etsy[-_]?(\d{8,})$/i);
      if (prefixed) return prefixed[1];
      if (/^\d{8,}$/.test(s)) return s;
    }
    const url = String(job.sourceImageUrl || '');
    const m = url.match(/listing\/(\d{8,})/i);
    return m ? m[1] : null;
  }

  function extractAmazonAsinFromJob(job) {
    const fields = [
      job.amazonAsin, job.amazon_asin, job.asin, job.ASIN, job.assetId,
      job.title, job.prompt, job.sourceTitle, job.source_title,
      job.product_id, job.productId, job.marketplace_id, job.marketplaceId,
      job.batch?.meta?.source_title, job.batch?.meta?.asset_id,
      job.batch?.meta?.product_id
    ];
    for (const raw of fields) {
      const s = String(raw || '').trim().toUpperCase();
      if (!s) continue;
      const prefixed = s.match(/^AMZ[-_]?([A-Z0-9]{10})$/);
      if (prefixed) return prefixed[1];
      const m = s.match(/\b(B0[A-Z0-9]{8})\b/);
      if (m) return m[1];
    }
    const url = String(job.sourceImageUrl || '');
    const dp = url.match(/\/dp\/([A-Z0-9]{10})/i);
    return dp ? dp[1].toUpperCase() : null;
  }

  function normalizeJobAssetId(job) {
    const src = String(job?.source || '').toLowerCase();
    const etsyId = extractEtsyListingIdFromJob(job);
    if (etsyId) return 'etsy-' + etsyId;
    const amz = extractAmazonAsinFromJob(job);
    if (amz) return 'amz-' + amz;
    if (src.includes('amazon') || src.includes('amz')) {
      const amz2 = extractAmazonAsinFromJob(job);
      if (amz2) return 'amz-' + amz2;
    }
    if (src.includes('etsy')) {
      const etsy2 = extractEtsyListingIdFromJob(job);
      if (etsy2) return 'etsy-' + etsy2;
    }
    const aid = String(job?.assetId || '').trim();
    if (aid && !/^etsystatic$/i.test(aid)) return aid;
    return job?.id || '';
  }

  function formatAssetIdLabel(assetId) {
    const s = String(assetId || '').trim();
    const etsy = s.match(/^etsy-(\d{8,})$/i);
    if (etsy) return 'Etsy-' + etsy[1];
    const amz = s.match(/^amz-([A-Z0-9]{10})$/i);
    if (amz) return 'AMZ-' + amz[1];
    if (/^\d{8,}$/.test(s)) return 'Etsy-' + s;
    if (/^B0[A-Z0-9]{8}$/i.test(s)) return 'AMZ-' + s.toUpperCase();
    const legacy = s.match(/^Etsy\s+(\d{8,})$/i);
    if (legacy) return 'Etsy-' + legacy[1];
    return s;
  }

  function getJobChatTitle(job) {
    const etsy = extractEtsyListingIdFromJob(job);
    if (etsy) return 'Etsy - ' + etsy;
    const amz = extractAmazonAsinFromJob(job);
    if (amz) return 'AMZ - ' + amz;
    const asset = normalizeJobAssetId(job);
    if (/^etsy-(\d{8,})$/i.test(asset)) return 'Etsy - ' + asset.match(/^etsy-(\d{8,})$/i)[1];
    if (/^amz-([A-Z0-9]{10})$/i.test(asset)) return 'AMZ - ' + asset.match(/^amz-([A-Z0-9]{10})$/i)[1].toUpperCase();
    return '';
  }

  let renameScheduleToken = 0;

  function cancelPendingChatRenames() {
    renameScheduleToken++;
  }

  function getCurrentConversationId() {
    const fromC = location.pathname.match(/\/c\/([a-f0-9-]{20,})/i);
    if (fromC) return fromC[1];
    const uuid = location.href.match(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i);
    return uuid ? uuid[1] : null;
  }

  async function waitConversationId(ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const id = getCurrentConversationId();
      if (id) return id;
      await sleep(POLL_MED_MS);
    }
    return getCurrentConversationId();
  }

  async function requestChatgptRename(conversationId, title) {
    // is_title_auto_generated: false -> bao ChatGPT server "ten nay do user dat, khong tu doi lai"
    const body = JSON.stringify({title, is_title_auto_generated: false});
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
    // Khong encode conversationId - ChatGPT API dung UUID thang, encode se thanh 404
    const cid = conversationId;
    const attempts = [
      {method: 'PATCH', path: '/backend-api/conversation/' + cid, body},
      {method: 'POST', path: '/backend-api/conversation/' + cid + '/title', body},
    ];
    const errors = [];
    for (const attempt of attempts) {
      try {
        const r = await fetch(attempt.path, {
          method: attempt.method,
          credentials: 'include',
          headers,
          body: attempt.body
        });
        if (r.ok) {
          log('Rename chat API OK: ' + attempt.method + ' ' + attempt.path.slice(-12));
          return true;
        }
        let text = '';
        try { text = await r.text(); } catch(_) {}
        errors.push(attempt.method + ' ' + r.status + (text ? ': ' + text.slice(0, 80) : ''));
      } catch(e) {
        errors.push(attempt.method + ' ' + e.message);
      }
    }
    throw new Error(errors.join(' | '));
  }

  function updateCurrentChatTitleInSidebar(title, conversationId) {
    if (!title) return false;
    let changed = false;
    // Tim tat ca link chat trong sidebar
    const allLinks = Array.from(document.querySelectorAll('a[href*="/c/"]'));
    // Uu tien link cua conversation hien tai
    const targets = conversationId
      ? allLinks.filter(a => (a.href || a.getAttribute('href') || '').includes(conversationId))
      : allLinks.filter(a => a.getAttribute('aria-current') === 'page');
    // Fallback: link active hien tai
    if (!targets.length) {
      document.querySelectorAll('[aria-current="page"]').forEach(el => targets.push(el));
    }
    for (const a of targets) {
      // Tim text node nong nhat khong chua icon
      const spans = Array.from(a.querySelectorAll('div, span, p')).filter(el =>
        !el.querySelector('svg, img, button') &&
        (el.textContent || '').trim().length > 0 &&
        (el.textContent || '').trim().length < 200
      );
      const target = spans[spans.length - 1] || a;
      if ((target.textContent || '').trim() !== title) {
        target.textContent = title;
        changed = true;
      }
      a.setAttribute('title', title);
    }
    return changed;
  }

  async function renameCurrentChatForJob(job, token = renameScheduleToken) {
    if (token !== renameScheduleToken) return false;
    const title = getJobChatTitle(job);
    if (!title) {
      log('Rename chat bo qua: job khong co ma AMZ/Etsy hop le');
      return false;
    }
    const conversationId = await waitConversationId(15000);
    if (token !== renameScheduleToken) return false;
    if (!conversationId) {
      log('Rename chat: chua co conversation id, bo qua');
      return false;
    }
    try {
      await requestChatgptRename(conversationId, title);
      // Cap nhat sidebar DOM ngay lap tuc
      const domChanged = updateCurrentChatTitleInSidebar(title, conversationId);
      log('Rename chat OK: "' + title + '"' + (domChanged ? ' (sidebar updated)' : ' (sidebar not found)'));
      return true;
    } catch(e) {
      log('Rename chat that bai: ' + e.message);
      // Van thu cap nhat DOM du API fail
      updateCurrentChatTitleInSidebar(title, conversationId);
      return false;
    }
  }

  function scheduleRenameChatForJob(job) {
    const token = ++renameScheduleToken;
    [0, 5000, 15000].forEach(delay => {
      setTimeout(() => renameCurrentChatForJob(job, token).catch(()=>{}), delay);
    });
  }

  // Doi sau khi job hoan thanh: ChatGPT tu dong doi ten chat ~5-30s sau khi hoi thoai ket thuc,
  // nen phai dat lai ten cua minh sau do. Fire o 8s, 35s, 90s de chac chan ghi de auto-rename.
  function scheduleRenameChatAfterJobDone(job) {
    const token = ++renameScheduleToken;
    [8000, 35000, 90000].forEach(delay => {
      setTimeout(() => renameCurrentChatForJob(job, token).catch(()=>{}), delay);
    });
  }

  function getSourceProductId(job, batch) {
    return normalizeJobAssetId(job) || batch?.meta?.asset_id || job.id;
  }

  function makePipelineIds(job, batch) {
    const productId = getSourceProductId(job, batch);
    const jobId = job.id;
    const batchId = batch?.meta?.batch_id || `batch_${jobId}_${Date.now()}`;
    return {
      product_id: productId,
      job_id: jobId,
      batch_id: batchId
    };
  }

  function countBatchProgress(batch) {
    const styles = Array.isArray(batch?.styles) ? batch.styles : [];
    return {
      styles_total: styles.length,
      designs_done: styles.filter(s => s.image_url || s.image_data_url || s.raw_design_url || s.raw_design_asset_id).length,
      raw_design_done: styles.filter(s => s.raw_design_url || s.raw_design_asset_id).length,
      bg_done: 0,
      mockups_done: 0
    };
  }

  function finalizeRawDesignProgress(progress, rawDesignResult) {
    const out = {...(progress || {})};
    if (!rawDesignResult) return {status: 'raw_design_queued', progress: out};
    const saved = Number(rawDesignResult.saved || 0);
    const total = Number(rawDesignResult.total || out.designs_done || out.styles_total || 0);
    out.raw_design_saved = saved;
    out.raw_design_done = saved;
    if (!out.designs_done) out.designs_done = total;
    if (!out.styles_total) out.styles_total = total;
    return {
      status: saved >= total && total > 0 ? 'raw_design_done' : 'raw_design_partial',
      progress: out
    };
  }

  function getStyleBackgroundColor(style) {
    const direct = style.primary_shirt_color || style.primaryShirtColor ||
      style.background_color || style.backgroundColor || style.bg_color || style.bgColor ||
      style.shirt_color || style.shirtColor || style.garment_color || style.garmentColor ||
      style.product_color || style.productColor || style.color || style.background;
    if (direct && typeof direct === 'string') return direct;
    const prompt = String(style.design_prompt || style.designPrompt || style.image_prompt || '');
    const m = prompt.match(/background(?: color)?\s*[:=\-]\s*([a-z0-9# ,\-]+?)(?:[.;,\n]|$)/i);
    if (m && m[1]) return m[1].trim();
    return 'unknown background';
  }

  function makeRawDesignFilename(job, batch, style, ids) {
    const productId = formatAssetIdLabel(ids.product_id || normalizeJobAssetId(job) || 'Podhub');
    const safeProductId = String(productId).replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'Podhub';
    const styleId = String(style.style_id || 1).padStart(2, '0');
    const bgTag = style.background_color_tag || getBlankColorTag(style);
    return `RAW_${safeProductId}_v${styleId}_bg_${bgTag}.png`;
  }

  function shouldRefreshRawDesignFilename(style, expectedFilename) {
    const current = String(style?.raw_design_filename || '');
    if (!current) return true;
    const tag = style?.background_color_tag || getBlankColorTag(style);
    if (/__des_batch_/i.test(current) || /__des_[^_]+_/i.test(current)) return true;
    if (tag && !current.includes(`__bg_${tag}`)) return true;
    if (tag && /__bg_[a-z0-9_]+\.png$/i.test(current) && !/__bg_[A-Za-z0-9]+-[A-Za-z0-9]+\.png$/i.test(current)) return true;
    if (/__bg_(white|black|navy|sport_grey|dark_heather|light_pink|light_blue|sand|unknown|unknown_background)\.png$/i.test(current)) return true;
    return false;
  }

  function makeRawDesignImageFilename(job, batch, style, ids, item) {
    const base = makeRawDesignFilename(job, batch, style, ids).replace(/\.[^.]+$/, '');
    const imageNo = item?.image_no || item?.imageNo || 1;
    const typeSlug = slugify(item?.image_type || item?.type || item?.template || 'image') || 'image';
    return `${base}__img_${imageNo}_${typeSlug}.png`;
  }

  function getStyleImagePromptItems(style) {
    const legacyPrompt = Array.isArray(style?.image_prompts)
      ? style.image_prompts.map(item => typeof item === 'string' ? item : (item?.prompt || item?.design_prompt || item?.designPrompt || item?.image_prompt || item?.redesign_prompt || '')).find(Boolean)
      : '';
    return [{
      image_no: 1,
      image_type: 'Redesign image',
      template: '',
      prompt: style?.design_prompt || style?.designPrompt || style?.prompt || style?.image_prompt || style?.redesign_prompt || legacyPrompt || style?.description || style?.title || ''
    }];
  }

  function getStyleGeneratedImageItems(style) {
    if (Array.isArray(style?.generated_images) && style.generated_images.length) return style.generated_images;
    if (Array.isArray(style?.image_prompts) && style.image_prompts.some(x => x?.image_url || x?.image_data_url || x?.raw_design_url)) return style.image_prompts;
    const remoteUrl = style.image_url || style.chatgpt_image_url || style.image_source_url;
    if (remoteUrl || style?.image_data_url || style?.raw_design_url) return [{
      image_no: 1,
      image_type: 'Redesign image',
      prompt: style.design_prompt || style.image_prompt,
      image_url: remoteUrl,
      chatgpt_image_url: style.chatgpt_image_url || style.image_source_url || null,
      image_data_url: style.image_data_url,
      raw_design_url: style.raw_design_url,
      raw_design_asset_id: style.raw_design_asset_id,
      raw_design_filename: style.raw_design_filename
    }];
    return [];
  }

  function makeReloadRawDesignFilename(job, styleId) {
    const batch = {meta: {source_title: job.title || job.prompt || job.assetId || job.id}};
    const ids = makePipelineIds(job, batch);
    const style = {
      style_id: styleId,
      style_name: 'reload',
      design_id: `des_reload_${ids.job_id}_${styleId}`,
      background_color: 'unknown_background'
    };
    return makeRawDesignFilename(job, batch, style, ids);
  }

  function normalizeBatchForPipeline(job, batch) {
    const ids = makePipelineIds(job, batch);
    if (!batch.meta) batch.meta = {};
    batch.meta.product_id = ids.product_id;
    batch.meta.job_id = ids.job_id;
    batch.meta.batch_id = ids.batch_id;
    batch.meta.schema_version = PIPELINE_SCHEMA_VERSION;

    if (Array.isArray(batch.styles)) {
      batch.styles = batch.styles.map((style, idx) => {
        const normalized = {
          ...style,
          style_id: style.style_id || idx + 1,
          product_id: ids.product_id,
          job_id: ids.job_id,
          batch_id: ids.batch_id,
          design_id: style.design_id || `des_${ids.batch_id}_${style.style_id || idx + 1}`,
          asset_id: style.asset_id || null,
          raw_design_asset_id: style.raw_design_asset_id || null,
          raw_design_url: style.raw_design_url || null,
          no_bg_asset_id: style.no_bg_asset_id || null,
          mockup_ids: Array.isArray(style.mockup_ids) ? style.mockup_ids : []
        };
        const firstGenerated = getStyleGeneratedImageItems(style).find(item => item.image_url || item.image_data_url);
        if (!normalized.image_url && firstGenerated?.image_url) normalized.image_url = firstGenerated.image_url;
        if (!normalized.image_data_url && firstGenerated?.image_data_url) normalized.image_data_url = firstGenerated.image_data_url;
        if (!normalized.image_generated_at && firstGenerated?.image_generated_at) normalized.image_generated_at = firstGenerated.image_generated_at;
        applyStyleBackgroundColor(normalized, 'White');
        const nextRawFilename = makeRawDesignFilename(job, batch, normalized, ids);
        normalized.raw_design_filename = shouldRefreshRawDesignFilename(style, nextRawFilename)
          ? nextRawFilename
          : style.raw_design_filename;
        normalized.design_prompt = normalized.design_prompt || getStyleImagePromptItems(normalized)[0]?.prompt || '';
        normalized.image_prompt = normalized.image_prompt || normalized.design_prompt || '';
        delete normalized.image_prompts;
        delete normalized.generated_images;
        return normalized;
      });
    }

    return ids;
  }

  function mergeServerBatch(batch, serverBatch) {
    if (!serverBatch || !Array.isArray(serverBatch.styles)) return batch;
    if (serverBatch.meta) batch.meta = {...(batch.meta || {}), ...serverBatch.meta};
    const byStyleId = new Map(serverBatch.styles.map(s => [String(s.style_id), s]));
    batch.styles = (batch.styles || []).map(style => {
      const serverStyle = byStyleId.get(String(style.style_id)) || {};
      const merged = {...style, ...serverStyle};
      if (typeof serverStyle.image_url === 'string' && /^data:image\//i.test(serverStyle.image_url)) {
        merged.image_url = style.image_url || serverStyle.chatgpt_image_url || serverStyle.image_source_url || null;
      }
      return merged;
    });
    return batch;
  }

  function buildServerBatchPayload(batch) {
    const serverBatch = JSON.parse(JSON.stringify(batch || {}));
    if (!Array.isArray(serverBatch.styles)) return serverBatch;
    serverBatch.styles = serverBatch.styles.map(style => {
      if (!style || typeof style !== 'object') return style;
      const chatgptImageUrl = style.chatgpt_image_url || style.image_source_url ||
        (typeof style.image_url === 'string' && !/^data:image\//i.test(style.image_url) ? style.image_url : null);
      const out = {...style};
      if (out.image_data_url) {
        out.image_data_url_saved = false;
        delete out.image_data_url;
      }
      if (out.image_url) {
        out.image_source_url = chatgptImageUrl;
        out.image_url_saved = false;
        delete out.image_url;
      }
      if (typeof out.image_url === 'string' && /^data:image\//i.test(out.image_url)) {
        out.image_url_saved = false;
        out.image_url = chatgptImageUrl;
      }
      if (Array.isArray(out.generated_images)) {
        out.generated_images = out.generated_images.map(item => {
          if (!item || typeof item !== 'object') return item;
          const clean = {...item};
          if (clean.image_data_url) {
            clean.image_data_url_saved = false;
            delete clean.image_data_url;
          }
          if (clean.image_url) {
            clean.image_source_url = clean.chatgpt_image_url || clean.image_source_url || clean.image_url;
            clean.image_url_saved = false;
            delete clean.image_url;
          }
          if (typeof clean.image_url === 'string' && /^data:image\//i.test(clean.image_url)) {
            clean.image_url_saved = false;
            clean.image_url = clean.chatgpt_image_url || clean.image_source_url || null;
          }
          return clean;
        });
      }
      return {
        ...out,
        chatgpt_image_url: chatgptImageUrl,
        image_source_url: chatgptImageUrl,
        image_transfer: chatgptImageUrl ? 'chatgpt_url' : out.image_transfer
      };
    });
    return serverBatch;
  }

  function makeStyleListingJson(batch, style) {
    const meta = batch?.meta || {};
    const styleId = Number(style?.style_id || style?.style_no || 1);
    return {
      schema_version: 'podhub_style_listing_v1',
      product_id: style?.product_id || meta.product_id || meta.asset_id || '',
      job_id: style?.job_id || meta.job_id || '',
      batch_id: style?.batch_id || meta.batch_id || '',
      source_title: meta.source_title || meta.title || '',
      style_id: styleId,
      style_name: style?.style_name || ('Style ' + styleId),
      style_reason: style?.style_reason || '',
      best_blank: getStyleBlank(style),
      primary_shirt_color: style?.primary_shirt_color || style?.background_color || '',
      background_color: style?.background_color || style?.primary_shirt_color || '',
      background_color_tag: style?.background_color_tag || getBlankColorTag(style),
      title: style?.title || '',
      short_title: style?.short_title || deriveShortTitle(style?.title || ''),
      bullets: Array.isArray(style?.bullets) ? style.bullets : [],
      description: style?.description || '',
      shelf_description: style?.shelf_description || deriveShelfDescription(style?.description || '', style?.title || ''),
      seo_keywords: Array.isArray(style?.seo_keywords) ? style.seo_keywords : [],
      backend_search_terms: Array.isArray(style?.backend_search_terms) ? style.backend_search_terms : [],
      materials: Array.isArray(style?.materials) ? style.materials : [],
      care_instructions: Array.isArray(style?.care_instructions) ? style.care_instructions : [],
      occasion: Array.isArray(style?.occasion) ? style.occasion : [],
      color_suggestions: Array.isArray(style?.color_suggestions) ? style.color_suggestions : [],
      size_range: Array.isArray(style?.size_range) && style.size_range.length ? style.size_range : ['S','M','L','XL','2XL','3XL'],
      design_prompt: getStyleDesignPrompt(style),
      image_prompt: getStyleDesignPrompt(style),
      raw_design_url: style?.raw_design_url || null,
      raw_design_asset_id: style?.raw_design_asset_id || null,
      raw_design_filename: style?.raw_design_filename || null,
      no_bg_url: style?.no_bg_url || null,
      no_bg_asset_id: style?.no_bg_asset_id || null,
      mockup_ids: Array.isArray(style?.mockup_ids) ? style.mockup_ids : []
    };
  }

  function attachStyleListingJson(batch, style) {
    if (!style || typeof style !== 'object') return style;
    style.listing_json = makeStyleListingJson(batch, style);
    return style;
  }

  function makeSingleStyleBatch(job, batch, style) {
    const miniBatch = {
      ...batch,
      meta: {...(batch?.meta || {})},
      styles: [attachStyleListingJson(batch, style)]
    };
    normalizeBatchForPipeline(job, miniBatch);
    attachStyleListingJson(miniBatch, miniBatch.styles[0]);
    return miniBatch;
  }

  async function ensureGeneratedImageDataUrls(batch) {
    if (!Array.isArray(batch?.styles)) return;
    for (const style of batch.styles) {
      for (const item of getStyleGeneratedImageItems(style)) {
        if (!item?.image_url || item.image_data_url || !/^https?:\/\//i.test(item.image_url)) continue;
        log(`Nap lai data URL cho style ${style.style_id || '?'} img ${item.image_no || '?'} truoc khi upload server`);
        item.image_data_url = await imageUrlToDataUrl(item.image_url);
      }
      if (!style?.image_url || style.image_data_url || !/^https?:\/\//i.test(style.image_url)) continue;
      log(`Nap lai data URL cho style ${style.style_id || '?'} truoc khi upload server`);
      style.image_data_url = await imageUrlToDataUrl(style.image_url);
      if (!style.image_data_url) {
        log(`CANH BAO: Style ${style.style_id || '?'} khong co data URL, server co the khong import duoc URL ChatGPT`);
      }
    }
  }

  async function fillMissingImageDataUrlsFromPage(batch) {
    if (!Array.isArray(batch?.styles)) return 0;
    const missing = batch.styles.filter(style =>
      (style.image_url || style.raw_design_url) &&
      !style.image_data_url &&
      !style.raw_design_url &&
      !style.raw_design_asset_id
    );
    if (!missing.length) return 0;
    try {
      const imageItems = await collectReloadImageDataUrls(batch.styles.length);
      if (!imageItems.length) return 0;
      let filled = 0;
      for (let i = 0; i < batch.styles.length; i++) {
        const style = batch.styles[i];
        if (!style || style.image_data_url || style.raw_design_url || style.raw_design_asset_id) continue;
        const item = imageItems[i];
        if (!item?.dataUrl) continue;
        style.image_url = style.image_url || item.src;
        style.image_data_url = item.dataUrl;
        style.image_generated_at = style.image_generated_at || new Date().toISOString();
        filled++;
      }
      if (filled) log(`Raw Designs: nap lai ${filled} data URL tu anh tren trang GPT`);
      return filled;
    } catch(e) {
      log('Raw Designs: khong nap duoc data URL tu trang GPT: ' + e.message);
      return 0;
    }
  }

  async function postGptResultToServer(job, batch, rawResponse, phase = 'gpt_json_received') {
    try {
      const res = await postGptResultToServerOn(job, batch, rawResponse, phase, PODHUB_ORIGIN);
      return res;
    } catch(e) {
      log('POST Podhub VPS fail: ' + e.message);
      throw e;
    }
  }

  function isRawDesignImportError(error) {
    return /RAW_DESIGN_IMPORT_FAILED|request entity too large|Imported \d+\/\d+|stored \d+\/\d+ raw designs/i.test(error?.message || '');
  }

  async function postGptResultCheckpoint(job, batch, phase, label = 'Checkpoint') {
    try {
      const res = await postGptResultToServer(job, batch, null, phase);
      return {ok: true, res};
    } catch(e) {
      if (isRawDesignImportError(e)) {
        log(`${label}: server da luu JSON nhung raw import fail, bo qua de upload Raw Designs rieng: ${e.message}`);
        return {ok: false, ignored: true, error: e};
      }
      throw e;
    }
  }

  async function postRawDesignsToLibraryOn(job, batch, origin, serverLabel = '', options = {}) {
    const rawLogPrefix = serverLabel ? `Raw Designs ${serverLabel}: ` : 'Raw Designs: ';
    normalizeBatchForPipeline(job, batch);
    await ensureGeneratedImageDataUrls(batch);
    await fillMissingImageDataUrlsFromPage(batch);

    // Lay tat ca styles co anh (uu tien data URL, fallback ChatGPT URL neu khong convert duoc)
    const images = (batch.styles || []).flatMap(style => {
      const items = getStyleGeneratedImageItems(style);
      return items
        .filter(item => {
          if (item.raw_design_url || item.raw_design_asset_id) return false;
          const hasDataUrl = item.image_data_url && /^data:image\//i.test(item.image_data_url);
          const chatUrl = item.image_url || item.chatgpt_image_url || item.image_source_url;
          const hasChatGptUrl = chatUrl && /^https?:\/\//i.test(chatUrl);
          return hasDataUrl || hasChatGptUrl;
        })
        .map(item => ({
          dataUrl: (item.image_data_url && /^data:image\//i.test(item.image_data_url)) ? item.image_data_url : null,
          imageUrl: item.image_url || item.chatgpt_image_url || item.image_source_url || null,
          style: style.style_id,
          style_id: style.style_id,
          image_no: item.image_no || 1,
          image_type: item.image_type || 'Redesign image',
          template: item.template || '',
          design_id: item.design_id || `${style.design_id || 'design'}_img_${item.image_no || 1}`,
          filename: item.raw_design_filename || style.raw_design_filename,
          background_color: style.background_color,
          background_color_tag: style.background_color_tag || getBlankColorTag(style),
          best_blank: getStyleBlank(style),
          primary_shirt_color: style.primary_shirt_color || style.background_color,
          title: style.title,
          prompt: item.prompt || style.image_prompt,
          transfer_mode: (item.image_data_url && /^data:image\//i.test(item.image_data_url)) ? 'data_url' : 'chatgpt_url'
        }));
    });

    if (!images.length) {
      const missing = (batch.styles || []).map(s => s.style_id || '?');
      throw new Error(
        'Khong co anh nao (data URL hoac ChatGPT URL) de day vao Raw Designs' +
        (missing.length ? ` (styles: ${missing.join(', ')})` : '')
      );
    }

    // Log so luong anh theo loai
    const dataUrlCount = images.filter(i => i.transfer_mode === 'data_url').length;
    const chatGptUrlCount = images.filter(i => i.transfer_mode === 'chatgpt_url').length;
    if (chatGptUrlCount > 0) {
      log(`${rawLogPrefix}${dataUrlCount} data URL + ${chatGptUrlCount} ChatGPT URL (server se tu fetch)`);
    }

    const assetId = normalizeJobAssetId(job) || batch.meta?.asset_id || job.id;
    batch.meta.asset_id = assetId;
    batch.meta.product_id = assetId;
    const listingMetaPayload = {
      product_id: batch.meta?.product_id,
      job_id: job.id,
      batch_id: batch.meta?.batch_id,
      sourceTitle: batch.meta?.source_title || job.title || job.prompt || '',
      styles: (batch.styles || []).map(style => ({
        style: style.style_id,
        style_id: style.style_id,
        style_name: style.style_name,
        style_reason: style.style_reason,
        title: style.title,
        short_title: style.short_title,
        bullets: style.bullets,
        description: style.description,
        shelf_description: style.shelf_description,
        seo_keywords: style.seo_keywords,
        backend_search_terms: style.backend_search_terms,
        design_id: style.design_id,
        filename: style.raw_design_filename,
        background_color: style.background_color,
        background_color_slug: style.background_color_slug,
        background_color_tag: style.background_color_tag || getBlankColorTag(style),
        best_blank: getStyleBlank(style),
        primary_shirt_color: style.primary_shirt_color || style.background_color
      }))
    };
    let libJobId = null;
    try {
      const listed = await libGetFrom(origin, '/jobs');
      const hit = (listed.data || []).find(j => {
        if (j.source !== 'manual') return false;
        const normalized = normalizeJobAssetId({ assetId: j.assetId, source: j.source, sourceImageUrl: j.sourceImageUrl });
        return j.assetId === assetId || normalized === assetId;
      });
      if (hit?.id) {
        libJobId = hit.id;
        log(`${rawLogPrefix}dung lai job ${libJobId.slice(0, 8)} cho ${assetId}`);
      }
    } catch(e) {
      log(`${rawLogPrefix}khong tim duoc job cu: ${e.message}`);
    }

    if (!libJobId) {
      const libJob = await libPostTo(origin, '/jobs/manual', {
        assetId,
        prompt: job.title || job.prompt || batch.meta?.source_title || '',
        listingMeta: listingMetaPayload
      });
      libJobId = libJob.id || libJob.job?.id;
    }
    if (!libJobId) throw new Error('Raw Designs khong tra ve job id');

    let saved = 0;
    const responses = [];
    for (const image of images) {
      try {
        const out = await libPostTo(origin, '/jobs/' + encodeURIComponent(libJobId) + '/outputs', {
          images: [image],
          listingMeta: listingMetaPayload
        });
        const n = Number(out.added || out.count || 1);
        saved += n > 0 ? 1 : 0;
        responses.push(out);
        log(`${rawLogPrefix}saved style ${image.style_id} (${saved}/${images.length})`);
      } catch(e) {
        log(`${rawLogPrefix}fail style ${image.style_id}: ${e.message}`);
      }
    }
    if (saved <= 0) throw new Error(`RAW_DESIGNS_UPLOAD_FAILED: saved 0/${images.length}`);
    log(`${rawLogPrefix}DB saved ${saved}/${images.length}`);
    let toolsSaved = 0;
    if (options.uploadTools !== false) {
      for (const image of images) {
        await uploadRawDesignToTools(job, image);
        toolsSaved++;
        log(`Tools Library: saved style ${image.style_id} (${toolsSaved}/${images.length})`);
      }
    }
    return {libJobId, saved, total: images.length, toolsSaved, response: responses};
  }

  async function postRawDesignsToLibrary(job, batch, options = {}) {
    const res = await postRawDesignsToLibraryOn(job, batch, PODHUB_ORIGIN, 'Podhub VPS', options);
    return {saved: res.saved, total: res.total, responses: [res]};
  }

  function extractUploadedRawDesignUrl(result) {
    const responses = Array.isArray(result?.responses) ? result.responses : [];
    for (const serverResult of responses) {
      const outs = Array.isArray(serverResult?.response) ? serverResult.response : [];
      for (const out of outs) {
        const urls = out?.data?.outputImageUrls || out?.job?.outputImageUrls || out?.outputImageUrls;
        if (Array.isArray(urls) && urls.length) return urls[urls.length - 1];
        if (typeof out?.url === 'string') return out.url;
      }
    }
    return '';
  }

  function countPendingRawDesignUploads(batch) {
    return (batch?.styles || []).filter(style => {
      if (style.raw_design_url || style.raw_design_asset_id) return false;
      const remote = style.chatgpt_image_url || style.image_source_url;
      return !!(style.image_url || style.image_data_url || remote);
    }).length;
  }

  async function postStyleRawDesignToLibrary(job, batch, style) {
    if (!job || !batch || !style) return null;
    if (!style.image_url && !style.image_data_url) return {saved: 0, total: 0, skipped: true};
    const generatedItem = getStyleGeneratedImageItems(style)[0] || {};
    const directImage = {
      dataUrl: generatedItem.image_data_url || style.image_data_url || null,
      imageUrl: generatedItem.image_url || style.image_url || style.chatgpt_image_url || null,
      style: style.style_id,
      style_id: style.style_id,
      image_no: generatedItem.image_no || 1,
      design_id: generatedItem.design_id || style.design_id || `design_${job.id}_${style.style_id}`,
      filename: generatedItem.raw_design_filename || style.raw_design_filename,
      background_color: style.background_color,
      title: style.title,
      prompt: generatedItem.prompt || getStyleDesignPrompt(style)
    };

    // Tools is the commercial system of record. Save the binary here first;
    // a failure in the legacy PodHub mirror must never block the user's image.
    const toolsAsset = await uploadRawDesignToTools(job, directImage);
    style.raw_design_asset_id = toolsAsset?.id || style.raw_design_asset_id || null;
    style.raw_design_url = toolsAsset?.public_url || toolsAsset?.url || toolsAsset?.storage_url || style.raw_design_url || null;
    style.raw_design_filename = toolsAsset?.original_name || directImage.filename || style.raw_design_filename || null;
    style.raw_design_uploaded_at = new Date().toISOString();

    // Keep the Tools asset on the canonical style, but clear uploaded flags on
    // the mirror copy so the team server does not filter out this same image.
    const legacyStyle = {
      ...style,
      raw_design_url: null,
      raw_design_asset_id: null,
      generated_images: Array.isArray(style.generated_images)
        ? style.generated_images.map(item => ({...item, raw_design_url:null, raw_design_asset_id:null}))
        : style.generated_images
    };
    const miniBatch = {
      ...batch,
      meta: {...(batch.meta || {})},
      styles: [legacyStyle]
    };
    try {
      const legacyResult = await postRawDesignsToLibrary(job, miniBatch, {uploadTools:false});
      const uploadedUrl = extractUploadedRawDesignUrl(legacyResult);
      if (uploadedUrl) style.raw_design_url = style.raw_design_url || uploadedUrl;
      return {...legacyResult, toolsAsset};
    } catch (legacyError) {
      log(`Legacy Raw Designs mirror bo qua: ${legacyError.message}`);
      return {saved: 1, total: 1, toolsAsset, legacy_error: legacyError.message};
    }
  }

  async function postPageImagesToLibrary(job, imageItems) {
    if (!job) throw new Error('Can tick dung 1 job truoc khi reload anh');
    const assetId = normalizeJobAssetId(job) || job.assetId || job.id;

    // === Lookup job Raw Designs cu theo assetId, tranh tao dup ===
    let libJobId = null;
    let existingCount = 0;
    try {
      const listed = await libGet('/jobs');
      const hit = (listed.data || []).find(j => {
        const norm = normalizeJobAssetId({ assetId: j.assetId, source: j.source, sourceImageUrl: j.sourceImageUrl });
        return j.assetId === assetId || norm === assetId;
      });
      if (hit?.id) {
        libJobId = hit.id;
        existingCount = Number(hit.outputCount || hit.outputs_count || 0);
        log(`Reload no-batch: dung lai Raw Designs job ${libJobId.slice(0,8)} (da co ${existingCount} anh)`);
      }
    } catch(e) {
      log('Reload no-batch: khong tim duoc job cu, se tao moi: ' + e.message);
    }

    // Chi upload anh chua co tren server
    const allImages = imageItems
      .filter(item => item?.dataUrl)
      .map((item, i) => {
        const styleId = i + 1;
        return {
          dataUrl: item.dataUrl,
          style: styleId,
          style_id: styleId,
          design_id: `des_reload_${job.id}_${styleId}`,
          filename: makeReloadRawDesignFilename(job, styleId),
          background_color: 'unknown_background',
          source_url: item.src || null
        };
      });

    // Neu job cu da co du anh -> skip
    const toUpload = existingCount > 0 ? allImages.slice(existingCount) : allImages;
    if (!toUpload.length && allImages.length > 0) {
      log(`Reload no-batch: da co du ${existingCount} anh tren server, bo qua`);
      return {libJobId, saved: 0, total: allImages.length, skipped: true, response: []};
    }
    if (!allImages.length) throw new Error('Khong convert duoc anh tren trang de day Raw Designs');

    // Tao job moi neu chua co
    if (!libJobId) {
      const libJob = await libPost('/jobs/manual', {
        assetId,
        prompt: job.title || job.prompt || 'Reload anh tu ChatGPT',
        listingMeta: {
          job_id: job.id,
          sourceTitle: job.title || job.prompt || '',
          source: 'chatgpt_reload_no_batch'
        }
      });
      libJobId = libJob.id || libJob.job?.id;
      if (!libJobId) throw new Error('Raw Designs khong tra ve job id');
    }

    // Upload tung anh con thieu
    let saved = 0;
    const responses = [];
    for (const image of toUpload) {
      try {
        const out = await libPost('/jobs/' + encodeURIComponent(libJobId) + '/outputs', {images: [image]});
        const n = Number(out.added || out.count || 1);
        saved += n > 0 ? 1 : 0;
        responses.push(out);
        log(`Reload no-batch: saved style ${image.style_id} (${existingCount + saved}/${allImages.length})`);
      } catch(e) {
        log(`Reload no-batch: fail style ${image.style_id}: ${e.message}`);
      }
    }
    log(`Raw Designs DB saved ${saved}/${toUpload.length} (reload no batch, tong ${existingCount + saved}/${allImages.length})`);
    return {libJobId, saved, total: allImages.length, response: responses};
  }

  async function updateJobStatus(jobId, status, extra) {
    const targetJob = allJobs.find(j => j._key === jobId) ||
      (activeJobRef && (activeJobRef._key === jobId || activeJobRef.id === jobId) ? activeJobRef : null) ||
      allJobs.find(j => activeJobKey && j._key === activeJobKey && j.id === jobId) ||
      allJobs.find(j => j.id === jobId);
    const origin = targetJob?._serverOrigin || RAILWAY_ORIGIN;
    const realJobId = targetJob?.id || jobId;
    try {
      return await apiPostTo(origin, '/jobs/' + encodeURIComponent(realJobId) + '/status', {status, ...(extra || {})});
    } catch(e) {
      if (!/400|Invalid status/i.test(e.message || '')) throw e;
      const fallback = status === 'done' ? 'done' : status === 'queued' ? 'queued' : status === 'failed' ? 'failed' : 'processing';
      return apiPostTo(origin, '/jobs/' + encodeURIComponent(realJobId) + '/status', {
        status: fallback,
        error: extra?.error_message || extra?.error || (fallback === 'processing' ? status : undefined)
      });
    }
  }

  // ============ STORAGE ============
  const STORAGE_KEY = 'phb_v3_batches';
  const ACTIVE_RUN_KEY = 'phb_v3_active_run';
  function loadBatches() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch(e) { return []; }
  }
  function saveBatches(arr) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(-30))); }
    catch(e) { log('Loi luu storage: ' + e.message); }
  }
  function addBatch(batch) {
    const arr = loadBatches();
    arr.push(sanitizeForLocalStorage(batch));
    saveBatches(arr);
  }

  function addDebugItem(title, content) {
    addBatch({
      id: 'debug_' + Date.now(),
      title,
      exported_at: new Date().toISOString(),
      files: [{ filename: title + '.txt', content }],
      batch: { meta: { source_title: title, exported_at: new Date().toISOString() }, styles: [] }
    });
  }

  function currentRunUrl() {
    return location.href.split('#')[0];
  }

  function sanitizeForLocalStorage(value) {
    const copy = JSON.parse(JSON.stringify(value || null));
    const scrubStyle = style => {
      if (!style || typeof style !== 'object') return;
      if (style.image_data_url) {
        style.image_data_url_saved = false;
        delete style.image_data_url;
      }
      if (typeof style.image_url === 'string' && /^data:image\//i.test(style.image_url)) {
        style.image_url_saved = false;
        delete style.image_url;
      }
    };
    if (Array.isArray(copy?.styles)) copy.styles.forEach(scrubStyle);
    if (Array.isArray(copy?.batch?.styles)) copy.batch.styles.forEach(scrubStyle);
    if (Array.isArray(copy?.files)) {
      copy.files = copy.files.map(file => {
        if (!file || typeof file.content !== 'string') return file;
        try {
          return {
            ...file,
            content: JSON.stringify(sanitizeForLocalStorage(JSON.parse(file.content)), null, 2)
          };
        } catch(e) {}
        return file;
      });
    }
    return copy;
  }

  function saveActiveRun(job, batch, phase) {
    if (!job || !batch) return;
    try {
      localStorage.setItem(ACTIVE_RUN_KEY, JSON.stringify({
        job,
        batch: sanitizeForLocalStorage(batch),
        phase,
        chat_url: currentRunUrl(),
        pathname: location.pathname,
        updated_at: new Date().toISOString()
      }));
    } catch(e) { log('Loi luu checkpoint: ' + e.message); }
  }

  function loadActiveRunForCurrentPage() {
    try {
      const st = JSON.parse(localStorage.getItem(ACTIVE_RUN_KEY) || 'null');
      if (!st?.job || !st?.batch) return null;
      if (st.chat_url === currentRunUrl() || st.pathname === location.pathname) return st;
    } catch(e) {}
    return null;
  }

  function loadActiveRunForJob(job) {
    try {
      const st = JSON.parse(localStorage.getItem(ACTIVE_RUN_KEY) || 'null');
      if (!st?.job || !st?.batch || !job) return null;
      const jobIds = new Set([
        String(job.id || ''),
        String(job.assetId || ''),
        String(normalizeJobAssetId(job) || '')
      ].filter(Boolean));
      const activeIds = [
        st.job?.id,
        st.job?.assetId,
        normalizeJobAssetId(st.job),
        st.batch?.meta?.job_id,
        st.batch?.meta?.asset_id,
        st.batch?.meta?.product_id
      ].map(x => String(x || '')).filter(Boolean);
      return activeIds.some(id => jobIds.has(id)) ? st : null;
    } catch(e) {}
    return null;
  }

  function clearActiveRun(jobId) {
    try {
      const st = JSON.parse(localStorage.getItem(ACTIVE_RUN_KEY) || 'null');
      if (!jobId || st?.job?.id === jobId) localStorage.removeItem(ACTIVE_RUN_KEY);
    } catch(e) { localStorage.removeItem(ACTIVE_RUN_KEY); }
  }

  function compactStoredBatches() {
    try {
      const batches = loadBatches();
      if (batches.length) saveBatches(batches);
      const active = JSON.parse(localStorage.getItem(ACTIVE_RUN_KEY) || 'null');
      if (active?.job && active?.batch) {
        localStorage.setItem(ACTIVE_RUN_KEY, JSON.stringify({
          ...active,
          batch: sanitizeForLocalStorage(active.batch)
        }));
      }
    } catch(e) {
      log('Khong compact duoc local storage: ' + e.message);
    }
  }



  // ============ DOM HELPERS ============
  function findBox() {
    for (const s of ['div[contenteditable="true"][role="textbox"]', '#prompt-textarea', 'textarea', '[contenteditable="true"]']) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function setPrompt(t) {
    const b = findBox(); if (!b) return false;
    b.focus();
    if (b.tagName === 'TEXTAREA') {
      const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      s?.call(b, t);
      b.dispatchEvent(new Event('input', {bubbles:true}));
    } else {
      b.textContent = '';
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(b); sel.addRange(r); }
      document.execCommand('insertText', false, t);
      b.dispatchEvent(new InputEvent('input', {bubbles:true, data:t}));
    }
    return true;
  }

  async function pastePromptText(t) {
    const b = findBox();
    if (!b) return false;
    const hasText = () => (b.textContent || b.value || '').includes(t.slice(0, 30));
    b.focus();
    try {
      b.textContent = '';
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      b.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:dt}));
      await sleep(300);
      if (hasText()) return true;
    } catch(e) {}
    if (setPrompt(t)) {
      await sleep(300);
      if (hasText()) return true;
    }
    try {
      await navigator.clipboard.writeText(t);
      b.focus();
      document.execCommand('paste');
      await sleep(300);
      return hasText();
    } catch(e) {
      log('Paste prompt fail: ' + e.message);
      return false;
    }
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-submit-button"]',
      'button[aria-label*="Send prompt"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="Send"]',
      'form button[type="submit"]'
    ];
    for (const s of selectors) {
      const btn = document.querySelector(s);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return btn;
    }
    return null;
  }

  function clickSend() {
    const btn = findSendButton();
    if (btn) { btn.click(); return true; }
    const box = findBox();
    if (box) {
      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true}));
    }
    return false;
  }

  async function clickSendWithRetry(maxWaitMs = 15000) {
    const end = Date.now() + maxWaitMs;
    while (Date.now() < end) {
      if (clickSend()) return true;
      await sleep(POLL_FAST_MS);
    }
    return false;
  }

  // ============ FILE UPLOAD ============
  function convertToPng(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          c.toBlob(b => b ? res(new File([b], file.name.replace(/\.[^.]+$/, '') + '.png', {type:'image/png'})) : rej(new Error('toBlob null')), 'image/png');
        } catch(e) { URL.revokeObjectURL(url); rej(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('load fail')); };
      img.src = url;
    });
  }

  async function copyClip(file) {
    try { await navigator.clipboard.write([new ClipboardItem({[file.type]:file})]); return true; }
    catch(e) { return false; }
  }

  function hasAttachmentSignal(beforeSrcs) {
    const selectors = [
      '[data-testid*="attachment"]', '[data-testid*="file"]',
      '[class*="attachment"]', '[class*="file-preview"]', '[class*="upload"]',
      'img[alt*="Uploaded"]', 'img[src^="blob:"]'
    ];
    if (selectors.some(s => document.querySelector(s))) return true;
    const imgs = Array.from(document.querySelectorAll('img')).map(i => i.currentSrc || i.src).filter(Boolean);
    return imgs.some(src => !beforeSrcs.has(src) && (src.startsWith('blob:') || src.startsWith('data:image')));
  }

  async function waitAttachReady(beforeSrcs, maxWaitMs = 15000) {
    const end = Date.now() + maxWaitMs;
    while (Date.now() < end) {
      if (hasAttachmentSignal(beforeSrcs) || findSendButton()) return true;
      await sleep(POLL_FAST_MS);
    }
    return false;
  }

  function setInputFiles(inp, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    try { Object.defineProperty(inp, 'files', {value:dt.files, writable:true, configurable:true}); }
    catch(e) { inp.files = dt.files; }
    inp.dispatchEvent(new Event('input', {bubbles:true}));
    inp.dispatchEvent(new Event('change', {bubbles:true}));
  }

  async function tryFileInputs(file, beforeSrcs) {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    for (const inp of inputs) {
      try {
        setInputFiles(inp, file);
        if (await waitAttachReady(beforeSrcs, 12000)) return true;
      } catch(e) {}
    }
    return false;
  }

  async function attachFile(fileRaw) {
    let file = fileRaw;
    if (fileRaw.type !== 'image/png' && fileRaw.type !== 'image/jpeg') {
      try { file = await convertToPng(fileRaw); log('Convert -> PNG OK'); }
      catch(e) { log('Convert fail: ' + e.message); }
    }
    const beforeSrcs = new Set(Array.from(document.querySelectorAll('img')).map(i => i.currentSrc || i.src).filter(Boolean));

    try {
      const box = findBox() || document.body; box.focus();
      const dt = new DataTransfer(); dt.items.add(file);
      box.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:dt}));
      if (await waitAttachReady(beforeSrcs, 10000)) { log('OK Paste event!'); return true; }
      if (await copyClip(file)) {
        box.focus(); await sleep(300);
        document.execCommand('paste');
        await sleep(300);
        if (await waitAttachReady(beforeSrcs, 12000)) { log('OK Paste!'); return true; }
      }
    } catch(e) {}

    if (await tryFileInputs(file, beforeSrcs)) { log('OK Input!'); return true; }

    for (const s of ['button[data-testid="composer-plus-btn"]', 'button[aria-label*="Upload"]', 'button[aria-label*="Attach"]']) {
      const btn = document.querySelector(s);
      if (btn) { btn.click(); await sleep(600); if (await tryFileInputs(file, beforeSrcs)) { log('OK Upload!'); return true; } }
    }

    const tgt = findBox() || document.body;
    const dt2 = new DataTransfer(); dt2.items.add(file);
    for (const ev of ['dragenter', 'dragover', 'drop']) tgt.dispatchEvent(new DragEvent(ev, {bubbles:true, cancelable:true, dataTransfer:dt2}));
    if (await waitAttachReady(beforeSrcs, 12000)) { log('OK Drag-drop!'); return true; }

    log('CANH BAO: Khong attach duoc. Copy clipboard, bam Ctrl+V!');
    await copyClip(file).catch(()=>{});
    showToast('ANH DA COPY - Bam Ctrl+V!');
    return false;
  }

  // Fetch anh tu URL (truc tiep, neu fail thi proxy)
  async function getSourceFile(job) {
    if (!job.sourceImageUrl) throw new Error('Job khong co sourceImageUrl');
    const srcUrl = job.sourceImageUrl.startsWith('/data/')
      ? getOrigin(job) + job.sourceImageUrl
      : job.sourceImageUrl;
    // Try direct fetch
    try {
      const r = await fetch(srcUrl);
      if (r.ok) {
        const b = await r.blob();
        if (b.type.startsWith('image/')) return new File([b], (job.assetId || job.id) + '.png', {type:b.type});
      }
    } catch(e) { log('Direct fetch fail, thu proxy...'); }
    // Proxy fallback
    try {
      const proxyUrl = getOrigin(job) + '/api/raw-designs/proxy-image?url=' + encodeURIComponent(srcUrl);
      const r = await fetch(proxyUrl);
      if (r.ok) {
        const b = await r.blob();
        if (b.type.startsWith('image/')) return new File([b], (job.assetId || job.id) + '.png', {type:b.type});
      }
    } catch(e) { log('Proxy fail: ' + e.message); }
    // Canvas fallback
    try {
      const blob = await new Promise((resolve, reject) => {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth || img.width;
          c.height = img.naturalHeight || img.height;
          c.getContext('2d').drawImage(img, 0, 0);
          c.toBlob(b => b ? resolve(b) : reject(new Error('canvas empty')), 'image/png');
        };
        img.onerror = reject;
        img.src = srcUrl;
        setTimeout(() => reject(new Error('timeout')), 10000);
      });
      if (blob) return new File([blob], (job.assetId || job.id) + '.png', {type:'image/png'});
    } catch(e) { log('Canvas fail: ' + e.message); }
    throw new Error('Khong tai duoc anh nguon');
  }

  // ============ WAIT FOR GPT RESPONSE ============
  function getAssistantTextCandidates() {
    const readText = el => {
      const a = el?.innerText || '';
      const b = el?.textContent || '';
      return a.length >= b.length ? a : b;
    };
    const directAssistant = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'))
      .filter(el => !el.closest('#phb-root-gpts'))
      .map(readText)
      .filter(Boolean)
      .reverse();
    if (directAssistant.length) return directAssistant;

    const selectors = ['[data-testid*="conversation-turn"]', 'article'];
    const seen = new Set();
    const texts = [];
    for (const s of selectors) {
      document.querySelectorAll(s).forEach(el => {
        if (el.closest('#phb-root-gpts')) return;
        if (seen.has(el)) return;
        seen.add(el);
        const text = readText(el);
        if (text) texts.push(text);
      });
    }
    return texts.reverse();
  }

  function getLatestAssistantText() {
    const texts = getAssistantTextCandidates();
    return texts[0] || '';
  }

  // Tim nut "Stop generating" - khi GPT dang stream text se co nut nay
  function findStopButton() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[data-testid="composer-stop-button"]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Stop streaming"]'
    ];
    for (const s of selectors) {
      const btn = document.querySelector(s);
      if (btn && !btn.disabled) return btn;
    }
    return null;
  }

  async function waitSendEnabled(ms) {
    const end = Date.now() + ms;
    await sleep(800);
    while (Date.now() < end) {
      if (findSendButton()) return true;
      await sleep(POLL_MED_MS);
    }
    return false;
  }

  // Kiem tra text co JSON block hoan chinh (```json ... ``` da dong)
  function hasCompleteJSONBlock(text) {
    if (!text) return false;
    const m = text.match(/```(?:json)?\s*\n[\s\S]*?\n\s*```/);
    return !!m;
  }

  // Kiem tra text co JSON parse duoc khong (test cuoi cung)
  function canExtractValidJSON(text) {
    if (!text) return false;
    try {
      const obj = extractAnyJSON(text) || extractJSON(text);
      if (!obj) return false;
      if (looksLikeBatchJson(obj)) {
        const batch = normalizeGptBatchJSON(JSON.parse(JSON.stringify(obj)));
        return !!(batch.styles && Array.isArray(batch.styles) && batch.styles.length >= 1 && batch.styles.length <= 30);
      }
      return looksLikeStyleListingJson(obj);
    } catch(e) { return false; }
  }

  async function waitForGPTTextResponse(maxWaitMs = MAX_WAIT_TEXT_MS, previousText = '') {
    const waitRunVersion = taskRunVersion;
    log('Cho GPT tra loi (toi da ' + Math.round(maxWaitMs/60000) + ' phut)...');
    const end = Date.now() + maxWaitMs;
    await sleep(1500);

    let lastLen = 0;
    let lastChangeAt = Date.now();
    let lastLogAt = 0;
    let firstSeenAt = 0;

    while (Date.now() < end) {
      if (taskStopRequested || waitRunVersion !== taskRunVersion) throw new Error('Task stopped by user');
      const texts = getAssistantTextCandidates();
      const curText = texts[0] || '';
      const isOldText = previousText && curText.trim() === String(previousText || '').trim();
      const curLen = curText.length;

      // Log moi 8s de nguoi dung biet con song
      if (Date.now() - lastLogAt > 8000) {
        const stopBtn = !!findStopButton();
        const sendBtn = !!findSendButton();
        const hasJSON = hasCompleteJSONBlock(curText);
        log('  ...' + curLen + ' ky tu, stop=' + stopBtn + ', send=' + sendBtn + ', JSON=' + hasJSON);
        lastLogAt = Date.now();
      }

      // Tracking thay doi cua text
      if (!isOldText && curLen !== lastLen) {
        lastChangeAt = Date.now();
        lastLen = curLen;
        if (!firstSeenAt && curLen > 50) firstSeenAt = Date.now();
      }

      const stableMs = Date.now() - lastChangeAt; // bao lau khong thay doi
      const hasJSON = hasCompleteJSONBlock(curText);

      // === DIEU KIEN DUNG (theo thu tu uu tien) ===

      // 1. JSON block dong day du + valid + text on dinh 3 giay -> chac chan xong
      if (!isOldText && hasJSON && stableMs >= 3000 && canExtractValidJSON(curText)) {
        log('GPT da xong (JSON valid 6-10 styles + on dinh 3s)');
        return curText;
      }

      // 2. Khong co code fence nhung extract JSON duoc + GPT da dung
      if (!isOldText && stableMs >= 2500 && curLen > 80 && !findStopButton() && canExtractValidJSON(curText)) {
        log('GPT da xong (JSON valid + GPT da dung)');
        return curText;
      }

      // 3. GPT da dung that su nhung JSON chua valid: tra ve de luu debug, tranh cat giua chung.
      if (!isOldText && stableMs >= 12000 && curLen > 80 && !findStopButton()) {
        log('GPT da dung nhung JSON chua parse duoc, lay text de debug');
        return curText;
      }

      await sleep(POLL_MED_MS);
    }

    log('TIMEOUT sau ' + Math.round(maxWaitMs/60000) + ' phut');
    const texts = getAssistantTextCandidates();
    const latest = texts.length > 0 ? texts[0] : '';
    return latest && latest.trim() !== String(previousText || '').trim() ? latest : null;
  }

  async function waitForGPTPlainTextResponse(maxWaitMs = MAX_WAIT_TEXT_MS) {
    const waitRunVersion = taskRunVersion;
    log('Cho GPT tra loi text (toi da ' + Math.round(maxWaitMs/60000) + ' phut)...');
    const end = Date.now() + maxWaitMs;
    await sleep(1500);
    let lastLen = 0;
    let lastChangeAt = Date.now();
    let lastLogAt = 0;

    while (Date.now() < end) {
      if (taskStopRequested || waitRunVersion !== taskRunVersion) throw new Error('Task stopped by user');
      const texts = getAssistantTextCandidates();
      const curText = texts[0] || '';
      const curLen = curText.length;

      if (Date.now() - lastLogAt > 8000) {
        log('  ...text ' + curLen + ' ky tu, stop=' + !!findStopButton() + ', send=' + !!findSendButton());
        lastLogAt = Date.now();
      }

      if (curLen !== lastLen) {
        lastLen = curLen;
        lastChangeAt = Date.now();
      }

      const stableMs = Date.now() - lastChangeAt;
      if (curLen > 100 && stableMs >= 3000 && !findStopButton()) {
        log('GPT da xong text plan');
        return curText;
      }

      if (curLen > 100 && stableMs >= 8000) {
        log('GPT text on dinh 8s, chap nhan');
        return curText;
      }

      await sleep(POLL_MED_MS);
    }

    log('TIMEOUT text sau ' + Math.round(maxWaitMs/60000) + ' phut');
    const texts = getAssistantTextCandidates();
    return texts.length > 0 ? texts[0] : null;
  }

  // ============ JSON EXTRACTION ============

  // Sua ky tu dieu khien (newline, tab, CR) chua duoc escape ben trong string JSON
  function repairJsonControlChars(str) {
    let out = '';
    let inStr = false;
    let i = 0;
    while (i < str.length) {
      const ch = str[i];
      if (inStr) {
        if (ch === '\\') {
          // Escape sequence hop le: giu nguyen ca 2 ky tu
          out += ch + (str[i + 1] || '');
          i += 2;
          continue;
        } else if (ch === '"') {
          inStr = false;
          out += ch;
        } else if (ch === '\n') {
          out += '\\n'; // unescaped newline trong string -> escape
        } else if (ch === '\r') {
          out += '\\r';
        } else if (ch === '\t') {
          out += '\\t';
        } else {
          out += ch;
        }
      } else {
        if (ch === '"') inStr = true;
        out += ch;
      }
      i++;
    }
    return out;
  }

  function cleanJsonCandidate(candidate) {
    return String(candidate || '')
      .replace(/^\uFEFF/, '')
      .replace(/[\u200B-\u200D\u2060]/g, '')
      .replace(/\u00A0/g, ' ')
      .trim();
  }

  // Sua cac loi JSON pho bien theo thu tu uu tien
  function repairJsonString(candidate) {
    return cleanJsonCandidate(candidate)
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')   // curly double quotes
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")   // curly single quotes
      .replace(/,(\s*[}\]])/g, '$1')                  // trailing commas
      .replace(/([}\]"'])\s*\n\s*([{["'])/g, '$1,$2'); // thiáº¿u dáº¥u pháº©y giá»¯a 2 element
  }

  function repairLooseJsonQuotes(candidate) {
    const s = repairJsonString(repairJsonControlChars(candidate));
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) {
          out += ch;
          esc = false;
          continue;
        }
        if (ch === '\\') {
          out += ch;
          esc = true;
          continue;
        }
        if (ch === '"') {
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) j++;
          const next = s[j] || '';
          if (!next || next === ':' || next === ',' || next === '}' || next === ']') {
            inStr = false;
            out += ch;
          } else {
            out += '\\"';
          }
          continue;
        }
        out += ch;
      } else {
        if (ch === '"') inStr = true;
        out += ch;
      }
    }
    return out;
  }

  // Thu parse tung buoc, tra ve object hoac null
  function tryParseJson(candidate) {
    candidate = cleanJsonCandidate(candidate);
    if (!candidate) return null;
    // Buoc 1: parse thang
    try { return JSON.parse(candidate); } catch(e1) {}
    // Buoc 2: fix control chars trong strings
    try { return JSON.parse(repairJsonControlChars(candidate)); } catch(e2) {}
    // Buoc 3: fix cac loi pho bien
    try {
      const r = repairJsonString(candidate);
      return JSON.parse(r);
    } catch(e3) {}
    // Buoc 4: fix control chars + fix pho bien
    try {
      const r = repairJsonString(repairJsonControlChars(candidate));
      return JSON.parse(r);
    } catch(e4) {}
    // Buoc 5: GPT hay de quote trong design_prompt, vd text reading "PAPA".
    try {
      return JSON.parse(repairLooseJsonQuotes(candidate));
    } catch(e5) {}
    // Buoc 6: truncation recovery - cat den } cuoi cung va thu parse
    const lastBrace = candidate.lastIndexOf('}');
    if (lastBrace > 0 && lastBrace < candidate.length - 1) {
      const truncated = candidate.slice(0, lastBrace + 1);
      try { return JSON.parse(repairJsonString(repairJsonControlChars(truncated))); } catch(e6) {}
      try { return JSON.parse(repairLooseJsonQuotes(truncated)); } catch(e7) {}
    }
    return null;
  }

  function findBalancedJsonCandidates(text) {
    const out = [];
    const s = cleanJsonCandidate(text);
    for (let start = 0; start < s.length; start++) {
      const open = s[start];
      if (open !== '{' && open !== '[') continue;
      const close = open === '{' ? '}' : ']';
      const stack = [close];
      let inStr = false;
      let esc = false;
      for (let i = start + 1; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') {
          if (stack[stack.length - 1] !== ch) break;
          stack.pop();
          if (!stack.length) {
            out.push(s.slice(start, i + 1));
            break;
          }
        }
      }
    }
    return out.sort((a, b) => b.length - a.length).slice(0, 30);
  }

  function looksLikeBatchJson(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (Array.isArray(obj)) return obj.some(x => x && typeof x === 'object' && (x.style_id !== undefined || x.style !== undefined || x.title));
    if (Array.isArray(obj.styles)) return true;
    for (const key of ['data', 'result', 'output', 'response', 'batch', 'content', 'json', 'payload']) {
      if (obj[key] && typeof obj[key] === 'object' && looksLikeBatchJson(obj[key])) return true;
    }
    return Object.values(obj).some(v => Array.isArray(v) && v.some(x => x && typeof x === 'object' && (x.style_id !== undefined || x.style !== undefined || x.title)));
  }

  function looksLikeStyleListingJson(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (obj.style_id !== undefined || obj.style_no !== undefined) return true;
    if (obj.walmart_listing && typeof obj.walmart_listing === 'object') return true;
    if (obj.listing && typeof obj.listing === 'object') return true;
    return !!(obj.title && (obj.bullets || obj.description || obj.image_prompt || obj.design_prompt));
  }

  function extractAnyJSON(text) {
    if (!text) return null;
    text = cleanJsonCandidate(text);

    const blockRe = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/gi;
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      const obj = tryParseJson(m[1]);
      if (obj && typeof obj === 'object') return obj;
    }

    for (const candidate of findBalancedJsonCandidates(text)) {
      const obj = tryParseJson(candidate);
      if (obj && typeof obj === 'object') return obj;
    }

    const firstBrace = text.indexOf('{');
    const lastBrace  = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const obj = tryParseJson(text.slice(firstBrace, lastBrace + 1));
      if (obj && typeof obj === 'object') return obj;
    }

    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      const obj = tryParseJson(text.slice(firstBracket, lastBracket + 1));
      if (obj && typeof obj === 'object') return obj;
    }
    return null;
  }

  function extractJSON(text) {
    if (!text) return null;
    text = cleanJsonCandidate(text);

    // Uu tien: tim tat ca cac JSON block (``` json ... ```) va thu tung cai
    const blockRe = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/gi;
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      const obj = tryParseJson(m[1]);
      if (obj && typeof obj === 'object' && looksLikeBatchJson(obj)) return obj;
    }

    // Thu parse cac object/array JSON can bang ngoac trong toan bo text.
    for (const candidate of findBalancedJsonCandidates(text)) {
      const obj = tryParseJson(candidate);
      if (obj && typeof obj === 'object' && looksLikeBatchJson(obj)) return obj;
    }

    // Fallback: lay tu { dau den } cuoi trong toan bo text
    const firstBrace = text.indexOf('{');
    const lastBrace  = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const obj = tryParseJson(text.slice(firstBrace, lastBrace + 1));
      if (obj && typeof obj === 'object') return obj;
    }

    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      const obj = tryParseJson(text.slice(firstBracket, lastBracket + 1));
      if (obj && typeof obj === 'object') return obj;
    }

    log('Parse JSON fail: khong extract duoc JSON hop le tu text ' + text.length + ' ky tu');
    return null;
  }


  function normalizeGptBatchJSON(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    // Thu unwrap cac wrapper phong phu GPT hay tra ve:
    // { "data": { "styles": [...] } }
    // { "result": { "styles": [...] } }
    // { "output": { "styles": [...] } }
    // { "response": { "styles": [...] } }
    // Array thang: [ {style_id:1,...}, ... ]
    if (!Array.isArray(obj.styles)) {
      // Case 1: nested one level
      const wrappers = ['data', 'result', 'output', 'response', 'batch', 'content', 'json', 'payload'];
      for (const key of wrappers) {
        if (obj[key] && typeof obj[key] === 'object' && Array.isArray(obj[key].styles)) {
          log('normalizeGptBatchJSON: unwrap wrapper key "' + key + '"');
          const inner = obj[key];
          // Giu lai meta tu outer neu inner khong co
          if (!inner.meta && obj.meta) inner.meta = obj.meta;
          obj = inner;
          break;
        }
      }
      // Case 2: obj chinh la array styles
      if (!obj.styles && Array.isArray(obj)) {
        log('normalizeGptBatchJSON: obj la array, boc thanh {styles:[...]}');
        obj = { styles: obj };
      }
      // Case 3: tim bat ky field nao la array co it nhat 1 phan tu co style_id
      if (!obj.styles || !Array.isArray(obj.styles)) {
        for (const key of Object.keys(obj || {})) {
          if (Array.isArray(obj[key]) && obj[key].length >= 1 && obj[key][0]?.style_id !== undefined) {
            log('normalizeGptBatchJSON: tim thay styles tai key "' + key + '"');
            obj.styles = obj[key];
            break;
          }
        }
      }
    }

    if (!Array.isArray(obj.styles)) return obj; // van khong co styles, tra nguyen de validate catch

    obj.styles = obj.styles.map((style, idx) => {
      const s = style && typeof style === 'object' ? style : {};
      if (!s.style_id) s.style_id = idx + 1;
      if (!s.style_name) s.style_name = 'Style ' + s.style_id;
      if (!Array.isArray(s.bullets)) {
        if (typeof s.bullets === 'string') s.bullets = [s.bullets];
        else if (s.bullets && typeof s.bullets === 'object') s.bullets = Object.values(s.bullets);
        else if (Array.isArray(s.key_features)) s.bullets = s.key_features;
        else if (Array.isArray(s.features)) s.bullets = s.features;
        else s.bullets = [];
      }
      if (!s.title && obj.meta?.source_title) s.title = obj.meta.source_title;
      if (!s.description) {
        s.description = Array.isArray(s.bullets) && s.bullets.length
          ? s.bullets.map(b => '- ' + b).join('\n')
          : '';
      }
      if (!s.design_prompt) s.design_prompt = getStyleImagePromptItems(s)[0]?.prompt || s.description || s.title || '';
      if (!s.image_prompt) s.image_prompt = s.design_prompt;
      delete s.image_prompts;
      delete s.generated_images;
      applyStyleBackgroundColor(s, 'White');
      return s;
    });
    return obj;
  }

  function validateBatchJSON(obj, expectedCount) {
    if (!obj || typeof obj !== 'object') return 'Khong phai object';
    if (!obj.styles || !Array.isArray(obj.styles)) return 'Thieu mang styles';
    if (expectedCount && obj.styles.length !== expectedCount) return 'Phai co dung ' + expectedCount + ' styles, hien co ' + obj.styles.length;
    if (obj.styles.length < 1 || obj.styles.length > 30) return 'Phai co 1-30 styles, hien co ' + obj.styles.length;
    const required = ['style_id', 'style_name', 'title', 'description', 'design_prompt', 'background_color'];
    for (let i = 0; i < obj.styles.length; i++) {
      const s = obj.styles[i];
      for (const f of required) {
        if (!(f in s)) return 'Style ' + (i+1) + ' thieu field ' + f;
      }
      if (!Array.isArray(s.key_features) && Array.isArray(s.bullets)) s.key_features = s.bullets;
      if (!Array.isArray(s.bullets) && Array.isArray(s.key_features)) s.bullets = s.key_features;
      if (!Array.isArray(s.bullets)) return 'Style ' + (i+1) + ' bullets/key_features phai la mang';
      if (s.background_color) {
        if (!s.primary_shirt_color) s.primary_shirt_color = s.background_color;
        s.background_color_slug = slugify(s.background_color);
        s.background_color_tag = getBlankColorTag(s);
      } else {
        s.background_color_slug = '';
        s.background_color_tag = '';
      }
    }
    return null;
  }

  // ============ EXPORT FILES ============
  function slugify(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50);
  }

  function formatStyleForFile(meta, style) {
    return JSON.stringify({meta:meta, style:style}, null, 2);
  }

  function downloadTextFile(filename, content) {
    const blob = new Blob([content], {type:'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  function buildExportFiles(batch) {
    const meta = batch.meta || {};
    const baseName = slugify(meta.source_title || 'product') || 'product';
    const ts = new Date().toISOString().slice(0, 10);
    const total = Array.isArray(batch.styles) ? batch.styles.length : 0;
    const files = [{
      filename: `${baseName}__all_styles__${total || 'x'}__${ts}.json`,
      content: JSON.stringify(batch, null, 2),
      kind: 'batch'
    }];
    for (const style of batch.styles || []) {
      attachStyleListingJson(batch, style);
      const styleSlug = slugify(style.style_name || ('style_' + style.style_id));
      const filename = `${baseName}__style_${style.style_id}_${styleSlug}__listing__${ts}.json`;
      files.push({
        filename,
        content: JSON.stringify(style.listing_json || makeStyleListingJson(batch, style), null, 2),
        style_id: style.style_id,
        style_name: style.style_name,
        kind: 'style_listing'
      });
    }
    return files;
  }

  // Export file JSON tong (gop styles) + cac file listing rieng theo style
  async function exportOneFile(batch, autoDownload) {
    const files = buildExportFiles(batch);
    const main = files[0];
    if (autoDownload) {
      downloadTextFile(main.filename, main.content);
    }
    // Không gắn mảng chứa chính `main` vào main.files vì sẽ tạo vòng:
    // main -> files[0] -> main và làm JSON.stringify History thất bại.
    return {
      ...main,
      files: files.map(file => {
        const {files: _nestedFiles, ...cleanFile} = file;
        return cleanFile;
      })
    };
  }

  function filesFromExport(file) {
    const source = Array.isArray(file?.files) && file.files.length ? file.files : [file];
    return source.map(item => {
      const {files: _nestedFiles, ...cleanItem} = item || {};
      return cleanItem;
    });
  }

  // Giu lai exportSixFiles cho History (re-export khi user can)
  async function exportSixFiles(batch, autoDownload) {
    const files = buildExportFiles(batch).filter(f => f.kind === 'style_listing');
    for (const file of files) {
      if (!autoDownload) continue;
      downloadTextFile(file.filename, file.content);
      await sleep(200);
    }
    return files;
  }

  // ============ PROCESS TEXT BATCH ============
  async function processTextBatch(imageFile, title, styleCount = redesignCount) {
    log('=== BAT DAU TEXT BATCH ===');
    const rawCount = Number(styleCount || redesignCount || 8);
    const count = Math.max(1, Math.min(Number(activePipelineConfig.max_styles)||8, Number.isFinite(rawCount) ? Math.round(rawCount) : 8));

    if (imageFile) {
      log('Attach anh: ' + imageFile.name);
      const ok = await attachFile(imageFile);
      if (!ok) throw new Error('Attach anh that bai');
      await sleep(800);
    }

    const finalPrompt = title
      ? `Ph\u00e2n t\u00edch \u1ea3nh n\u00e0y v\u00e0 ti\u00eau \u0111\u1ec1: "${title}". sau \u0111\u00f3 tr\u1ea3 v\u1ec1 ph\u00e2n t\u00edch t\u1ed5ng h\u1ee3p design \u0111\u1ecbnh d\u1ea1ng text th\u00f4ng th\u01b0\u1eddng, n\u1ed9i dung style listing Walmart tr\u1ea3 v\u1ec1 \u0111\u1ecbnh d\u1ea1ng JSON ${count} redesign styles theo schema \u0111\u00e3 \u0111\u1ecbnh ngh\u0129a.`
      : `Ph\u00e2n t\u00edch \u1ea3nh n\u00e0y. sau \u0111\u00f3 tr\u1ea3 v\u1ec1 ph\u00e2n t\u00edch t\u1ed5ng h\u1ee3p design \u0111\u1ecbnh d\u1ea1ng text th\u00f4ng th\u01b0\u1eddng, n\u1ed9i dung style listing Walmart tr\u1ea3 v\u1ec1 \u0111\u1ecbnh d\u1ea1ng JSON ${count} redesign styles theo schema \u0111\u00e3 \u0111\u1ecbnh ngh\u0129a.`;

    log('Paste prompt...');
    if (!await pastePromptText(finalPrompt)) throw new Error('Paste prompt that bai');
    await sleep(600);

    log('Gui prompt len GPT...');
    if (!await clickSendWithRetry(30000)) throw new Error('Khong bam duoc nut gui');

    const responseText = await waitForGPTTextResponse(MAX_WAIT_TEXT_MS);
    if (!responseText) throw new Error('GPT khong tra loi sau ' + (MAX_WAIT_TEXT_MS/60000) + ' phut');
    log('Nhan duoc text dai ' + responseText.length + ' ky tu');

    const obj = normalizeGptBatchJSON(extractJSON(responseText));
    if (!obj) {
      addDebugItem('debug_raw_response_' + Date.now(), responseText);
      throw new Error('GPT khong tra JSON. Da luu debug trong History');
    }
    log('Parse JSON OK');

    const err = validateBatchJSON(obj, count);
    if (err) {
      // Log keys de debug GPT tra cau truc gi
      const keys = Object.keys(obj || {}).join(', ');
      const stylesInfo = Array.isArray(obj.styles)
        ? obj.styles.length + ' items'
        : (typeof obj.styles);
      log('DEBUG JSON keys: [' + keys + '] | styles=' + stylesInfo);
      addDebugItem('debug_invalid_json_' + Date.now(), JSON.stringify(obj, null, 2));
      throw new Error('JSON khong hop le: ' + err);
    }
    log('Validate OK - ' + obj.styles.length + ' styles day du');

    if (!obj.meta) obj.meta = {};
    obj.meta.source_title = obj.meta.source_title || title || '';
    obj.meta.exported_at = new Date().toISOString();
    obj.meta.image_filename = imageFile ? imageFile.name : null;

    return obj;
  }

  function normalizePlanBatchJSON(obj, title, imageFile, expectedCount, workflow) {
    obj = normalizeGptBatchJSON(obj);
    if (!obj || typeof obj !== 'object') return obj;
    if (!obj.meta) obj.meta = {};
    obj.schema_version = obj.schema_version || 'podhub_plan_v1';
    obj.meta.source_title = obj.meta.source_title || obj.input?.title || title || '';
    obj.meta.exported_at = new Date().toISOString();
    obj.meta.image_filename = imageFile ? imageFile.name : (obj.meta.image_filename || null);
    const workflowMode = workflow?.mode || WORKFLOW_REDESIGN_ONLY;
    obj.meta.workflow_mode = workflowMode;
    obj.meta.marketplaces = Array.isArray(workflow?.marketplaces) ? workflow.marketplaces : [];
    obj.meta.flow_version = workflowMode === WORKFLOW_REDESIGN_LISTING
      ? 'plan_listing_image_v2'
      : 'plan_image_v2';
    obj.meta.requested_style_count = expectedCount;

    if (!obj.analysis && obj.phase_a?.source_analysis) obj.analysis = obj.phase_a.source_analysis;
    if (!Array.isArray(obj.styles) && Array.isArray(obj.concepts)) obj.styles = obj.concepts;
    if (!Array.isArray(obj.styles) && Array.isArray(obj.phase_b?.concepts)) obj.styles = obj.phase_b.concepts;
    if (!Array.isArray(obj.styles)) return obj;

    obj.styles = obj.styles.map((style, idx) => {
      const s = style && typeof style === 'object' ? {...style} : {};
      const id = Number(s.style_id || s.style_no || s.style || idx + 1);
      s.style_id = Number.isFinite(id) && id > 0 ? id : idx + 1;
      s.style_name = s.style_name || s.name || ('Style ' + s.style_id);
      s.style_reason = s.style_reason || s.reason || s.concept_reason || '';
      s.design_prompt = s.design_prompt || s.prompt || s.image_prompt || s.redesign_prompt || s.visual_direction || '';
      s.image_prompt = s.image_prompt || s.design_prompt || '';
      s.best_blank = s.best_blank || s.blank || '';
      s.primary_shirt_color = s.primary_shirt_color || s.background_color || s.shirt_color || '';
      s.background_color = s.background_color || s.primary_shirt_color || '';
      s.title = '';
      s.short_title = '';
      s.bullets = [];
      s.description = '';
      s.shelf_description = '';
      s.seo_keywords = [];
      s.backend_search_terms = [];
      s.materials = [];
      s.care_instructions = [];
      s.occasion = Array.isArray(s.occasion) ? s.occasion : [];
      s.color_suggestions = Array.isArray(s.color_suggestions) ? s.color_suggestions : [];
      s.size_range = Array.isArray(s.size_range) ? s.size_range : [];
      s.listing_json_status = workflowMode === WORKFLOW_REDESIGN_LISTING ? 'pending' : 'skipped';
      delete s.image_prompts;
      delete s.generated_images;
      applyStyleBackgroundColor(s, 'White');
      return s;
    });
    return obj;
  }

  function validatePlanJSON(obj, expectedCount, workflowMode = WORKFLOW_REDESIGN_ONLY) {
    if (!obj || typeof obj !== 'object') return 'Khong phai object';
    if (!Array.isArray(obj.styles)) return 'Thieu mang styles';
    if (expectedCount && obj.styles.length !== expectedCount) return 'Phai co dung ' + expectedCount + ' styles, hien co ' + obj.styles.length;
    if (obj.styles.length < 1 || obj.styles.length > 30) return 'Phai co 1-30 styles, hien co ' + obj.styles.length;
    for (let i = 0; i < obj.styles.length; i++) {
      const s = obj.styles[i] || {};
      if (!s.style_id) return 'Style ' + (i + 1) + ' thieu style_id';
      if (!s.style_name) return 'Style ' + (i + 1) + ' thieu style_name';
      if (workflowMode === WORKFLOW_REDESIGN_LISTING) continue;
      if (!s.design_prompt && !s.image_prompt) return 'Style ' + (i + 1) + ' thieu design_prompt';
      if (!s.primary_shirt_color) return 'Style ' + (i + 1) + ' thieu primary_shirt_color';
      if (!s.background_color) return 'Style ' + (i + 1) + ' thieu background_color';
    }
    return null;
  }

  function extractStyleBriefsFromJsonLike(obj, count) {
    const out = [];
    const seen = new Set();
    if (!obj || typeof obj !== 'object') return out;
    const source = Array.isArray(obj)
      ? obj
      : (Array.isArray(obj.styles) ? obj.styles
        : Array.isArray(obj.concepts) ? obj.concepts
          : Array.isArray(obj.phase_b?.concepts) ? obj.phase_b.concepts
            : []);
    source.forEach((item, idx) => {
      if (!item || typeof item !== 'object') return;
      const id = Number(item.style_id || item.style_no || item.style || idx + 1);
      if (!Number.isFinite(id) || id < 1 || id > count || seen.has(id)) return;
      const name = String(item.style_name || item.name || item.concept_title || item.title || ('Style ' + id)).trim();
      const reason = String(item.style_reason || item.reason || item.concept_reason || item.visual_direction || '').trim();
      out.push({style_id: id, style_name: name.slice(0, 80), style_reason: reason.slice(0, 300)});
      seen.add(id);
    });
    return out.sort((a, b) => a.style_id - b.style_id);
  }

  function extractStyleBriefsFromText(text, count) {
    const jsonBriefs = extractStyleBriefsFromJsonLike(extractAnyJSON(text), count);
    if (jsonBriefs.length) {
      const seenJson = new Set(jsonBriefs.map(x => x.style_id));
      for (let i = 1; i <= count; i++) {
        if (!seenJson.has(i)) jsonBriefs.push({style_id: i, style_name: 'Style ' + i, style_reason: ''});
      }
      return jsonBriefs.sort((a, b) => a.style_id - b.style_id).slice(0, count);
    }

    const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const briefs = [];
    const seen = new Set();
    for (const line of lines) {
      let m =
        line.match(/^(?:style\s*)?(\d{1,2})[\).\:\-\s]+(.+)$/i) ||
        line.match(/^[-*]\s*(?:style\s*)?(\d{1,2})[\).\:\-\s]+(.+)$/i);
      if (!m) continue;
      const id = Number(m[1]);
      if (!Number.isFinite(id) || id < 1 || id > count || seen.has(id)) continue;
      let rest = m[2].replace(/^["']|["']$/g, '').trim();
      rest = rest.replace(/^style\s*\d{1,2}\s*[:\-]\s*/i, '').trim();
      const parts = rest.split(/\s+[-\u2013\u2014:]\s+/);
      const name = (parts[0] || rest).replace(/^["']|["']$/g, '').trim();
      const reason = parts.slice(1).join(' - ').trim();
      if (!name) continue;
      briefs.push({style_id: id, style_name: name.slice(0, 80), style_reason: reason || rest.slice(0, 220)});
      seen.add(id);
    }
    briefs.sort((a, b) => a.style_id - b.style_id);
    for (let i = 1; i <= count; i++) {
      if (!seen.has(i)) briefs.push({style_id: i, style_name: 'Style ' + i, style_reason: ''});
    }
    return briefs.sort((a, b) => a.style_id - b.style_id).slice(0, count);
  }

  function buildTextPlanBatch(planText, title, imageFile, count, workflow) {
    const workflowMode = workflow?.mode || WORKFLOW_REDESIGN_ONLY;
    const styles = extractStyleBriefsFromText(planText, count).map(s => {
      const style = {
        style_id: s.style_id,
        style_name: s.style_name,
        style_reason: s.style_reason || '',
        design_prompt: '',
        image_prompt: '',
        best_blank: '',
        primary_shirt_color: '',
        background_color: '',
        title: '',
        short_title: '',
        bullets: [],
        description: '',
        shelf_description: '',
        seo_keywords: [],
        backend_search_terms: [],
        materials: [],
        care_instructions: [],
        occasion: [],
        color_suggestions: [],
        size_range: [],
        listing_json_status: workflowMode === WORKFLOW_REDESIGN_LISTING ? 'pending' : 'skipped'
      };
      applyStyleBackgroundColor(style, 'White');
      return style;
    });
    return {
      schema_version: 'podhub_text_plan_v1',
      meta: {
        source_title: title || '',
        exported_at: new Date().toISOString(),
        image_filename: imageFile ? imageFile.name : null,
        workflow_mode: workflowMode,
        marketplaces: Array.isArray(workflow?.marketplaces) ? workflow.marketplaces : [],
        flow_version: workflowMode === WORKFLOW_REDESIGN_LISTING ? 'text_plan_listing_image_v2' : 'text_plan_image_v2',
        requested_style_count: count,
        analysis_text: planText || ''
      },
      analysis_text: planText || '',
      styles
    };
  }

  async function processStylePlanBatch(imageFile, title, styleCount = redesignCount, job = null) {
    log('=== BAT DAU STYLE PLAN ===');
    // Navigation sang Custom GPT làm content script reload, nên luôn nạp lại
    // cấu hình hiệu lực theo license ngay trước khi bắt đầu pipeline.
    await getActiveGptUrl();
    const workflow = resolveWorkflow(job);
    const rawCount = Number(styleCount || redesignCount || 8);
    const count = Math.max(1, Math.min(30, Number.isFinite(rawCount) ? Math.round(rawCount) : 8));

    if (imageFile) {
      log('Attach anh: ' + imageFile.name);
      const ok = await attachFile(imageFile);
      if (!ok) throw new Error('Attach anh that bai');
      await sleep(800);
    }

    const customAnalysis=fillPipelineTemplate(activePipelineConfig.analysis_prompt,{title:title?`"${title}"`:'(không có tiêu đề)',style_count:count});
    const analysisLead = customAnalysis||`Phân tích ảnh và tiêu đề "${title||''}", sau đó đề xuất ${count} hướng redesign khác nhau.`;
    const finalPrompt = workflow.mode === WORKFLOW_REDESIGN_LISTING
      ? `${analysisLead}
Trả về phần phân tích text và một JSON object duy nhất có đúng ${count} styles.
Mỗi style chỉ gồm style_id và style_name. Chưa tạo listing, design_prompt, phôi áo hoặc màu áo ở bước này.`
      : `${analysisLead}
Trả về phần phân tích text và JSON có đúng ${count} styles. Mỗi style bắt buộc có:
- style_id
- style_name
- ${activePipelineConfig.features.generate_image_prompts?'design_prompt tạo ảnh':'mô tả hướng thiết kế ngắn'}
- best_blank: mã phôi áo phù hợp, ưu tiên Gildan 5000 hoặc Comfort Colors 1717
- primary_shirt_color: tên màu áo đề xuất, không được để trống
- background_color: màu nền dùng để tạo Raw Design, không được để trống và phải giống chính xác primary_shirt_color
Ví dụ: {"best_blank":"Gildan 5000","primary_shirt_color":"Black","background_color":"Black"}.
Chưa cần listing đầy đủ.`;
    log(`Workflow: ${workflow.mode}${workflow.marketplaces.length ? ' [' + workflow.marketplaces.join(', ') + ']' : ''}`);

    log('Paste prompt style plan...');
    if (!await pastePromptText(finalPrompt)) throw new Error('Paste prompt that bai');
    await sleep(600);

    log('Gui prompt plan len GPT...');
    if (!await clickSendWithRetry(30000)) throw new Error('Khong bam duoc nut gui');

    const responseText = await waitForGPTPlainTextResponse(MAX_WAIT_TEXT_MS);
    if (!responseText) throw new Error('GPT khong tra loi sau ' + (MAX_WAIT_TEXT_MS/60000) + ' phut');
    log('Nhan duoc text plan dai ' + responseText.length + ' ky tu');
    // Preserve image prompts returned with the analysis. The old text-only
    // fallback discarded them and forced Phase B to ask GPT for them again.
    const parsedPlan = extractAnyJSON(responseText) || extractJSON(responseText);
    if (parsedPlan) {
      const normalizedPlan = normalizePlanBatchJSON(parsedPlan, title, imageFile, count, workflow);
      const planError = validatePlanJSON(normalizedPlan, count, workflow.mode);
      if (!planError) {
        normalizedPlan.meta.analysis_text = responseText;
        normalizedPlan.analysis_text = normalizedPlan.analysis_text || responseText;
        log('Structured plan OK - reuse ' + normalizedPlan.styles.length + ' image prompts');
        return normalizedPlan;
      }
      log('Structured plan incomplete (' + planError + '), fallback to text plan');
      addDebugItem('debug_incomplete_plan_' + Date.now(), JSON.stringify(parsedPlan, null, 2));
    }

    const batch = buildTextPlanBatch(responseText, title, imageFile, count, workflow);
    log('Text plan fallback - ' + batch.styles.length + ' styles');
    return batch;
  }

  function unwrapSingleStyleJson(obj, styleId) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      return obj.find(x => String(x?.style_id || x?.style_no || x?.style) === String(styleId)) || obj[0] || {};
    }
    if (Array.isArray(obj.styles)) {
      return obj.styles.find(x => String(x?.style_id || x?.style_no || x?.style) === String(styleId)) || obj.styles[0] || {};
    }
    for (const key of ['data', 'result', 'output', 'response', 'style', 'json', 'payload']) {
      if (obj[key] && typeof obj[key] === 'object') {
        const unwrapped = unwrapSingleStyleJson(obj[key], styleId);
        if (unwrapped && typeof unwrapped === 'object') return {...obj, ...unwrapped};
      }
    }
    return obj;
  }

  function normalizeSingleStyleJSON(obj, planStyle, batch) {
    const styleId = planStyle?.style_id || planStyle?.style_no || 1;
    const raw = unwrapSingleStyleJson(obj, styleId) || {};
    const marketplaceListings=raw.marketplace_listings||raw.listings||{};
    const listing = raw.walmart_listing || raw.listing || raw.walmart || marketplaceListings.walmart || marketplaceListings.shopify || marketplaceListings.etsy || {};
    const merged = {
      ...planStyle,
      ...raw,
      ...listing
    };
    merged.style_id = Number(merged.style_id || merged.style_no || styleId);
    merged.style_name = merged.style_name || planStyle?.style_name || ('Style ' + merged.style_id);
    merged.style_reason = merged.style_reason || planStyle?.style_reason || '';
    merged.design_prompt = merged.design_prompt || merged.designPrompt || merged.image_prompt || merged.imagePrompt || merged.prompt || merged.redesign_prompt || merged.redesignPrompt || planStyle?.design_prompt || planStyle?.image_prompt || '';
    merged.image_prompt = merged.image_prompt || merged.design_prompt || planStyle?.image_prompt || '';
    merged.best_blank = merged.best_blank || merged.blank || planStyle?.best_blank || '';
    merged.primary_shirt_color = merged.primary_shirt_color || merged.background_color || merged.shirt_color || planStyle?.primary_shirt_color || '';
    merged.background_color = merged.background_color || merged.primary_shirt_color || planStyle?.background_color || '';
    merged.title = merged.title || '';
    merged.short_title = merged.short_title || deriveShortTitle(merged.title);
    if (!Array.isArray(merged.bullets)) {
      if (typeof merged.bullets === 'string') merged.bullets = [merged.bullets];
      else if (merged.bullets && typeof merged.bullets === 'object') merged.bullets = Object.values(merged.bullets);
      else if (Array.isArray(merged.key_features)) merged.bullets = merged.key_features;
      else if (Array.isArray(merged.features)) merged.bullets = merged.features;
      else merged.bullets = [];
    }
    if (!merged.bullets.length && Array.isArray(merged.key_features)) merged.bullets = merged.key_features;
    if (!merged.bullets.length && Array.isArray(merged.features)) merged.bullets = merged.features;
    merged.description = merged.description || '';
    merged.shelf_description = merged.shelf_description || deriveShelfDescription(merged.description, merged.title);
    merged.seo_keywords = normalizeKeywordArray(merged.seo_keywords || merged.keywords || merged.tags, merged.title, 18);
    merged.backend_search_terms = normalizeKeywordArray(merged.backend_search_terms || merged.search_terms || merged.seo_keywords, merged.title, 30);
    merged.materials = Array.isArray(merged.materials) ? merged.materials : [];
    merged.care_instructions = Array.isArray(merged.care_instructions) ? merged.care_instructions : [];
    merged.occasion = Array.isArray(merged.occasion) ? merged.occasion : [];
    merged.color_suggestions = Array.isArray(merged.color_suggestions) ? merged.color_suggestions : [];
    merged.size_range = Array.isArray(merged.size_range) && merged.size_range.length ? merged.size_range : ['S','M','L','XL','2XL','3XL'];
    merged.listing_json_status = 'done';
    merged.listing_json_received_at = new Date().toISOString();
    merged.marketplace_listings={
      ...(planStyle?.marketplace_listings||{}),...(marketplaceListings||{}),
      ...(raw.walmart_listing||raw.walmart?{walmart:raw.walmart_listing||raw.walmart}:{}),
      ...(raw.shopify_listing||raw.shopify?{shopify:raw.shopify_listing||raw.shopify}:{}),
      ...(raw.etsy_listing||raw.etsy?{etsy:raw.etsy_listing||raw.etsy}:{})
    };
    delete merged.walmart_listing;
    delete merged.listing;
    delete merged.walmart;
    delete merged.image_prompts;
    delete merged.generated_images;
    applyStyleBackgroundColor(merged, 'White');
    attachStyleListingJson(batch, merged);
    return merged;
  }

  async function claimJob(job) {
    if (!job?.id) return job;
    try {
      const res = await apiPostTo(getOrigin(job), '/jobs/' + encodeURIComponent(job.id) + '/claim', {
        runner_id: runnerId,
        runner_label: runnerId,
        force: false
      });
      const data = res.data || res.job || res;
      return {...job, ...data, _serverOrigin: job._serverOrigin, _serverKey: job._serverKey, _serverLabel: job._serverLabel, _key: job._key};
    } catch(e) {
      if (/^404\b|not found/i.test(e.message || '')) {
        log('Claim job bo qua: backend chua co endpoint lock hoac job mirror khong ton tai (' + e.message + ')');
        return job;
      }
      throw e;
    }
  }

  async function heartbeatJob(job) {
    if (!job?.id) return;
    try {
      await apiPostTo(getOrigin(job), '/jobs/' + encodeURIComponent(job.id) + '/heartbeat', {runner_id: runnerId});
    } catch(e) {
      log('Heartbeat fail: ' + e.message);
    }
  }

  async function releaseJob(job, reason) {
    if (!job?.id) return;
    try {
      await apiPostTo(getOrigin(job), '/jobs/' + encodeURIComponent(job.id) + '/release', {runner_id: runnerId, reason: reason || ''});
    } catch(e) {}
  }

  async function checkQueueDuplicates(deleteDupes = false) {
    const results = [];
    let crossRemoved = 0;
    if (deleteDupes && rawLoadedJobs.length) {
      const groups = new Map();
      for (const job of rawLoadedJobs) {
        const key = jobDedupeKey(job);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(job);
      }
      for (const jobs of groups.values()) {
        if (jobs.length < 2) continue;
        const keep = jobs.reduce((best, j) => (scoreQueueJob(j) > scoreQueueJob(best) ? j : best));
        for (const job of jobs) {
          if (job._key === keep._key) continue;
          try {
            await apiDelFrom(getOrigin(job), '/jobs/' + encodeURIComponent(job.id));
            crossRemoved++;
          } catch(e) {
            log(`Xoa dup cheo ${job._serverLabel || ''} fail: ${e.message}`);
          }
        }
      }
      if (crossRemoved) log('Xoa dup trong queue: ' + crossRemoved + ' job');
    }
    try {
      const path = deleteDupes ? '/duplicates/delete' : '/duplicates/check';
      const res = await apiPostTo(PODHUB_ORIGIN, path, {runner_id: runnerId});
      results.push({res});
      const groups = Number(res.duplicateGroups || res.groups || 0);
      const dupes = Number(res.duplicates || res.removed || 0);
      log(`Podhub VPS: ${deleteDupes ? 'xoa dup' : 'check dup'} -> ${groups} nhom, ${dupes} job`);
    } catch(e) {
      log(`Podhub VPS: ${deleteDupes ? 'xoa dup' : 'check dup'} fail: ${e.message}`);
    }
    await reloadJobs();
    if (crossRemoved) results.push({crossRemoved});
    return results;
  }

  function isStyleListingComplete(style, job, batch) {
    if (enabledMarketplaces(job,batch).length === 0) return true;
    return !!(style && style.listing_json_status === 'done' && style.title && Array.isArray(style.bullets) && style.bullets.length >= 1 && style.description);
  }

  function getStyleDesignPrompt(style) {
    const itemPrompt = getStyleImagePromptItems(style)[0]?.prompt || '';
    return String(style?.design_prompt || style?.designPrompt || style?.image_prompt || style?.imagePrompt || style?.prompt || style?.redesign_prompt || style?.redesignPrompt || itemPrompt || '').trim();
  }

  function isStyleReadyForImage(style) {
    return !!(style && getStyleDesignPrompt(style));
  }

  function buildFallbackDesignPrompt(style, batch) {
    const title = batch?.meta?.source_title || style?.title || 'POD t-shirt design';
    const styleName = style?.style_name || ('Style ' + (style?.style_id || ''));
    const reason = style?.style_reason ? ' Style reason: ' + style.style_reason + '.' : '';
    const bg = style?.background_color || style?.primary_shirt_color || 'White';
    return `Create a centered square 1:1 POD artwork redesign based on the original product title "${title}". Use the redesign direction "${styleName}".${reason} Preserve the original niche, message, humor, emotion, and buyer intent. Create artwork only, no t-shirt mockup, no model, no product scene, no props, no watermark, no logo. Use clean print-ready high-contrast graphics, sharp readable text if text is included, full artwork visible with small margin, solid ${bg} background, no gradients, no shadows, no fabric texture.`;
  }

  function validateStyleListingJSON(style, job, batch) {
    if (!style || typeof style !== 'object') return 'Khong phai object';
    if (!getStyleDesignPrompt(style)) return 'Thieu design_prompt';
    const missing = [];
    if (!style.primary_shirt_color) missing.push('primary_shirt_color');
    if (!style.background_color) missing.push('background_color');
    if (missing.length) return 'Thieu field bat buoc: ' + missing.join(', ');
    if (enabledMarketplaces(job,batch).length === 0) return null;
    if (!style.title) missing.push('title');
    if (!Array.isArray(style.bullets) || !style.bullets.length) missing.push('bullets');
    if (!style.description) missing.push('description');
    if (missing.length) {
      style.listing_quality_error = 'Thieu field listing: ' + missing.join(', ');
      return style.listing_quality_error;
    }
    return null;
  }

  async function repairStyleListingJson(style, totalStyles, reason, markets = []) {
    log(`Style ${style.style_id}: sua lai JSON listing (${reason})`);
    const beforeText = getLatestAssistantText();
    const repairPrompt =
      `Convert the previous answer into a valid JSON object for style #${style.style_id}/${totalStyles}: "${style.style_name}".\n` +
      `Return exactly this root schema: {"analysis":{},"styles":[]}.\n` +
      `The styles array must contain exactly 1 item for this style.\n` +
      `The style item must include design_prompt.\n` +
      `The style item must include non-empty best_blank, primary_shirt_color, and background_color. ` +
      `background_color must exactly equal primary_shirt_color because it is the Raw Design background used for matching the shirt mockup.\n` +
      (markets.length
        ? `The style item must include marketplace_listings with only these keys: ${markets.join(', ')}. Each marketplace listing must include title, short_title, description, shelf_description, key_features, primary_keyword, and backend_search_terms.\n`
        : '') +
      `Return JSON object only. No markdown. No explanation.`;
    if (!await pastePromptText(repairPrompt)) throw new Error('Paste prompt repair JSON that bai');
    await sleep(300);
    if (!await clickSendWithRetry(30000)) throw new Error('Khong bam duoc nut gui repair JSON');
    const repairText = await waitForGPTTextResponse(MAX_WAIT_TEXT_MS, beforeText);
    if (!repairText) throw new Error('GPT khong tra repair JSON');
    const repaired = extractAnyJSON(repairText) || extractJSON(repairText);
    if (!repaired) {
      addDebugItem('debug_style_listing_repair_raw_' + style.style_id + '_' + Date.now(), repairText);
      throw new Error('Repair van khong parse duoc JSON');
    }
    return repaired;
  }
  async function requestStyleListingJson(job, batch, style, totalStyles) {
    log(`>>> Style ${style.style_id}/${totalStyles}: hoi JSON listing rieng`);
    const beforeText = getLatestAssistantText();
    const markets=enabledMarketplaces(job,batch);
    const existingPrompt=getStyleDesignPrompt(style);
    const marketLabels=markets.map(name=>name.charAt(0).toUpperCase()+name.slice(1));
    const base=fillPipelineTemplate(activePipelineConfig.listing_prompt,{marketplaces:marketLabels.join(', '),style_id:style.style_id,style_name:style.style_name});
    const finalPrompt = markets.length === 0
      ? `Tạo prompt ảnh redesign từ mẫu gốc gửi lên theo style_id: ${style.style_id}, style_name: "${style.style_name}".
Trả về JSON object theo schema đã định nghĩa và bắt buộc có đầy đủ:
- design_prompt
- best_blank (ưu tiên Gildan 5000 hoặc Comfort Colors 1717)
- primary_shirt_color (không được trống)
- background_color (không được trống và phải giống chính xác primary_shirt_color)
Ví dụ: {"best_blank":"Gildan 5000","primary_shirt_color":"Black","background_color":"Black"}.
Không markdown, không giải thích.`
      : `${base||`Tạo listing hoàn chỉnh cho ${marketLabels.join(', ')} style_id: ${style.style_id}, style_name: "${style.style_name}".`}
Nội dung style listing ${marketLabels.join(', ')} trả về định dạng JSON theo schema đã định nghĩa.
${existingPrompt
  ? `Chỉ tạo dữ liệu listing, không tạo lại hoặc sửa design_prompt. Giữ nguyên design_prompt hiện có: ${JSON.stringify(existingPrompt)}.`
  : 'JSON phải bao gồm design_prompt tạo ảnh hoàn chỉnh, phù hợp với style này và sẵn sàng cho POD.'}
JSON style bắt buộc có best_blank, primary_shirt_color và background_color; primary_shirt_color không được trống và background_color phải giống chính xác primary_shirt_color.
marketplace_listings chỉ chứa các key: ${markets.join(', ')}. Không markdown, không giải thích.`;

    if (!await pastePromptText(finalPrompt)) throw new Error('Paste prompt JSON listing that bai');
    await sleep(300);
    if (!await clickSendWithRetry(30000)) throw new Error('Khong bam duoc nut gui JSON listing');

    const responseText = await waitForGPTTextResponse(MAX_WAIT_TEXT_MS, beforeText);
    if (!responseText) throw new Error('GPT khong tra JSON listing cho style ' + style.style_id);
    let obj = extractAnyJSON(responseText) || extractJSON(responseText);
    if (!obj) {
      addDebugItem('debug_style_listing_raw_' + style.style_id + '_' + Date.now(), responseText);
      obj = await repairStyleListingJson(style, totalStyles, 'khong parse duoc JSON', markets);
    }
    let normalized = normalizeSingleStyleJSON(obj, style, batch);
    if (existingPrompt) {
      normalized.design_prompt = existingPrompt;
      normalized.image_prompt = existingPrompt;
    }
    const err = validateStyleListingJSON(normalized, job, batch);
    if (err) {
      addDebugItem('debug_invalid_style_listing_' + style.style_id + '_' + Date.now(), JSON.stringify(obj, null, 2));
      obj = await repairStyleListingJson(style, totalStyles, err, markets);
      normalized = normalizeSingleStyleJSON(obj, style, batch);
      if (existingPrompt) {
        normalized.design_prompt = existingPrompt;
        normalized.image_prompt = existingPrompt;
      }
      const retryErr = validateStyleListingJSON(normalized, job, batch);
      if (retryErr) {
        addDebugItem('debug_invalid_style_listing_repair_' + style.style_id + '_' + Date.now(), JSON.stringify(obj, null, 2));
        throw new Error('JSON listing style ' + style.style_id + ' khong hop le: ' + retryErr);
      }
    }
    return normalized;
  }

  // ============ PHASE B: IMAGE GENERATION ============
  const MAX_WAIT_IMAGE_MS = 10 * 60 * 1000;

  // Kiem tra 1 URL co phai anh GPT tao khong (mo rong pattern)
  function isGptImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (!url.startsWith('http')) return false;
    // Cac pattern ChatGPT serve anh:
    // 1. URL moi (2026): https://chatgpt.com/backend-api/estuary/content?id=file_xxx&sig=...
    // 2. URL cu: oaiusercontent.com, dalleprodsec, sdmnt...
    // 3. files trong path
    return /backend-api\/(estuary\/content|files)|oaiusercontent\.com|dalleprodsec|sdmntpr|sdmnt|openai\.com.*\/files/i.test(url);
  }

  // Lay tat ca URL anh tu cac assistant turn (khong tinh anh trong panel hay attachment user)
  function getAssistantImageUrls() {
    const urls = [];
    // Nhieu selector vi ChatGPT thay doi DOM:
    // - [data-message-author-role="assistant"] (cu)
    // - [data-turn="assistant"] (moi 2026)
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-turn="assistant"]',
      '[data-turn-id-container] [data-turn="assistant"]'
    ];
    const turns = new Set();
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(t => turns.add(t));
    }
    turns.forEach(turn => {
      turn.querySelectorAll('img').forEach(img => {
        if (img.closest('#phb-root-gpts')) return;
        const src = img.currentSrc || img.src || img.getAttribute('src') || '';
        if (isGptImageUrl(src)) urls.push(src);
      });
    });
    // Fallback: neu khong tim duoc qua turn, quet toan bo img tren trang
    if (urls.length === 0) {
      document.querySelectorAll('img').forEach(img => {
        if (img.closest('#phb-root-gpts')) return;
        const src = img.currentSrc || img.src || img.getAttribute('src') || '';
        if (isGptImageUrl(src)) urls.push(src);
      });
    }
    return urls;
  }

  // Snapshot URL anh hien tai (de so sanh sau)
  function snapshotImageUrls() {
    return new Set(getAssistantImageUrls());
  }

  function detectImageFilePathFailure(text) {
    const s = String(text || '');
    if (/\/mnt\/data\/[^\s)]+\.png/i.test(s)) return 'mnt_data_path';
    if (/kh[oô]ng\s+(?:đọc|doc)\s+được\s+file|cannot\s+(?:read|access|open)\s+(?:the\s+)?file|unable\s+to\s+(?:read|access|open)\s+(?:the\s+)?file/i.test(s)) {
      return 'file_read_failed';
    }
    return '';
  }

  // Cho anh moi xuat hien (so sanh voi snapshot truoc do)
  async function waitForNewImage(beforeUrls, maxWaitMs = MAX_WAIT_IMAGE_MS) {
    log('Cho GPT tao anh (toi da ' + Math.round(maxWaitMs/60000) + ' phut)...');
    const end = Date.now() + maxWaitMs;
    await sleep(700);

    let lastNewUrl = null;
    let lastChangeAt = Date.now();
    let lastLogAt = 0;
    let debugDumped = false;

    while (Date.now() < end) {
      const currentUrls = getAssistantImageUrls();
      const newUrls = currentUrls.filter(u => !beforeUrls.has(u));
      const latestText = getLatestAssistantText();
      const filePathFailure = detectImageFilePathFailure(latestText);
      if (filePathFailure && newUrls.length === 0 && !findStopButton()) {
        log('GPT khong render anh trong chat: ' + filePathFailure);
        return {error: filePathFailure};
      }

      if (Date.now() - lastLogAt > 10000) {
        const stopBtn = !!findStopButton();
        log('  ...new imgs=' + newUrls.length + ', total=' + currentUrls.length + ', stop=' + stopBtn);
        lastLogAt = Date.now();

        // Sau 30s khong tim duoc anh, dump het URL ra log de debug
        if (!debugDumped && Date.now() - (end - maxWaitMs) > 30000 && newUrls.length === 0) {
          debugDumped = true;
          log('=== DEBUG: dump tat ca img URL ===');
          const allImgs = Array.from(document.querySelectorAll('img'))
            .filter(i => !i.closest('#phb-root-gpts'))
            .map(i => (i.currentSrc || i.src || '').slice(0, 100))
            .filter(Boolean);
          allImgs.slice(-10).forEach((u, i) => log('  img[' + i + ']: ' + u));
        }
      }

      if (newUrls.length > 0) {
        const cur = newUrls[newUrls.length - 1];
        if (cur !== lastNewUrl) {
          lastNewUrl = cur;
          lastChangeAt = Date.now();
        }
        const stableMs = Date.now() - lastChangeAt;
        const noStop = !findStopButton();
        if (stableMs >= 2500 && noStop) {
          log('Anh moi xuat hien: ' + cur.slice(0, 80));
          return cur;
        }
        if (stableMs >= 3000) {
          log('Anh on dinh 3s, chap nhan');
          return cur;
        }
      }

      // Fallback: khong co stop button + co anh moi nhat (nhung khong khac before set)
      // Co the do ChatGPT reuse URL hoac DOM khac. Check theo tieu chi khac:
      if (!findStopButton() && currentUrls.length > 0 && newUrls.length === 0) {
        // Lay anh cuoi cung trong assistant turn moi nhat (thu nhieu selector)
        let lastTurn = null;
        for (const sel of ['[data-turn="assistant"]', '[data-message-author-role="assistant"]']) {
          const all = document.querySelectorAll(sel);
          if (all.length > 0) { lastTurn = all[all.length - 1]; break; }
        }
        if (lastTurn) {
          const lastImgs = Array.from(lastTurn.querySelectorAll('img'))
            .map(i => i.currentSrc || i.src || i.getAttribute('src') || '')
            .filter(isGptImageUrl);
          if (lastImgs.length > 0) {
            const lastImg = lastImgs[lastImgs.length - 1];
            if (lastImg !== lastNewUrl) {
              lastNewUrl = lastImg;
              lastChangeAt = Date.now();
              log('Detect anh qua turn cuoi (fallback): ' + lastImg.slice(0, 80));
            }
            const stableMs = Date.now() - lastChangeAt;
            if (stableMs >= 3000) {
              log('Anh on dinh 3s (turn-based fallback)');
              return lastImg;
            }
          }
        }
      }

      await sleep(POLL_MED_MS);
    }

    log('TIMEOUT cho anh sau ' + Math.round(maxWaitMs/60000) + ' phut');
    return {error: 'timeout'};
  }

  // Gui prompt tao 1 anh va doi anh moi
  async function generateOneImage(stylePrompt, styleId, totalStyles, backgroundColor) {
    log(`>>> Style ${styleId}/${totalStyles}: gui prompt tao anh`);

    const beforeUrls = snapshotImageUrls();
    log('  (truoc: ' + beforeUrls.size + ' anh)');

    const bg = backgroundColor ? String(backgroundColor).trim() : '';
    const fullPrompt =
      `Tạo ảnh trực tiếp trong ChatGPT cho STYLE ${styleId}/${totalStyles}. ` +
      `Bắt buộc dùng công cụ tạo ảnh và hiển thị ảnh hoàn chỉnh ngay trong chat. ` +
      `Không trả về đường dẫn file, không trả /mnt/data, không trả markdown, không trả text giải thích. ` +
      `Chỉ render một ảnh PNG vuông 1:1 theo prompt sau: ` +
      stylePrompt +
      (bg ? `. Background color: ${bg}.` : '');
    if (!await pastePromptText(fullPrompt)) throw new Error('Paste prompt anh that bai');
    await sleep(250);

    if (!await clickSendWithRetry(30000)) throw new Error('Khong bam gui duoc');

    let newUrl = await waitForNewImage(beforeUrls, MAX_WAIT_IMAGE_MS);
    if (newUrl && typeof newUrl === 'object' && newUrl.error) {
      log(`Style ${styleId}: retry render anh vi ${newUrl.error}`);
      const retryBeforeUrls = snapshotImageUrls();
      const retryPrompt =
        `Bạn vừa trả về file path hoặc báo không đọc được file. Không dùng file path đó. ` +
        `Hãy tạo lại ảnh mới trực tiếp bằng công cụ tạo ảnh của ChatGPT và hiển thị ảnh trong khung chat. ` +
        `Không trả /mnt/data, không trả link, không trả markdown, không giải thích. ` +
        `Render một ảnh PNG vuông 1:1 cho STYLE ${styleId}/${totalStyles}: ` +
        stylePrompt +
        (bg ? `. Background color: ${bg}.` : '');
      if (!await pastePromptText(retryPrompt)) throw new Error('Paste prompt retry anh that bai');
      await sleep(250);
      if (!await clickSendWithRetry(30000)) throw new Error('Khong bam gui duoc retry anh');
      newUrl = await waitForNewImage(retryBeforeUrls, MAX_WAIT_IMAGE_MS);
    }
    if (!newUrl || (typeof newUrl === 'object' && newUrl.error)) {
      const reason = newUrl?.error ? ': ' + newUrl.error : '';
      throw new Error('GPT khong tao anh sau ' + (MAX_WAIT_IMAGE_MS/60000) + ' phut' + reason);
    }

    return newUrl;
  }

  async function imageUrlToDataUrl(url) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    try {
      const r = await fetch(url, {credentials:'include'});
      if (!r.ok) throw new Error('fetch image ' + r.status);
      const blob = await r.blob();
      if (!String(blob.type || '').startsWith('image/')) throw new Error('not image: ' + blob.type);
      return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error || new Error('FileReader fail'));
        fr.readAsDataURL(blob);
      });
    } catch(e) {
      log('Fetch dataUrl fail: ' + e.message);
    }
    log('Khong convert duoc anh sang dataUrl (giu nguyen bytes GPT, khong qua canvas)');
    return null;
  }

  const MIN_RELOAD_IMAGE_BYTES = 30 * 1024;

  function dataUrlByteSize(dataUrl) {
    if (!dataUrl || !dataUrl.includes(',')) return 0;
    return Math.round((dataUrl.split(',')[1] || '').length * 0.75);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('FileReader fail'));
      fr.readAsDataURL(blob);
    });
  }

  async function imageElementToDataUrl(img) {
    const src = img.currentSrc || img.src || img.getAttribute('src') || '';
    if (!src) return null;
    if (src.startsWith('data:image/')) return src;
    try {
      const r = await fetch(src, {credentials:'include'});
      if (r.ok) {
        const blob = await r.blob();
        if (String(blob.type || '').startsWith('image/')) return await blobToDataUrl(blob);
      }
    } catch(e) {}
    return null;
  }

  async function collectReloadImageDataUrls(limit) {
    const selectors = [
      '[data-message-author-role="assistant"] img',
      '[data-turn="assistant"] img',
      'article img'
    ];
    const nodes = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(img => {
        if (!img.closest('#phb-root-gpts')) nodes.push(img);
      });
    }
    if (!nodes.length) {
      document.querySelectorAll('img').forEach(img => {
        if (!img.closest('#phb-root-gpts')) nodes.push(img);
      });
    }

    const seenSrc = new Set();
    const seenSize = new Map();
    const items = [];
    for (const img of nodes) {
      const src = img.currentSrc || img.src || img.getAttribute('src') || '';
      if (!src || seenSrc.has(src)) continue;
      seenSrc.add(src);
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 200 || h < 200) continue;
      const dataUrl = await imageElementToDataUrl(img);
      const size = dataUrlByteSize(dataUrl);
      if (!dataUrl || size < MIN_RELOAD_IMAGE_BYTES) {
        log(`Bo qua anh reload ${Math.round(size/1024)}KB`);
        continue;
      }
      const sizeKey = String(size);
      const sizeCount = seenSize.get(sizeKey) || 0;
      if (sizeCount >= 2) continue;
      seenSize.set(sizeKey, sizeCount + 1);
      items.push({dataUrl, src, size, width: w, height: h});
    }
    const selected = limit ? items.slice(-limit) : items;
    log(`Reload scan: ${items.length} anh hop le, chon ${selected.length}`);
    return selected;
  }

  // Loop styles tao 1 anh redesign trong cung chat
  async function processImagePhase(batch, onProgress, onStyleDone) {
    log('=== BAT DAU PHASE B: JSON TUNG STYLE + TAO ANH ===');
    // Resume/Re-GPT có thể bỏ qua Phase A, nên Phase B cũng phải tự tải lại
    // pipeline hiệu lực để không quay về cấu hình mặc định sau navigation.
    await getActiveGptUrl();

    for (let i = 0; i < batch.styles.length; i++) {
      if (taskStopRequested) throw new Error('Task stopped by user');
      const style = batch.styles[i];

      const markets = enabledMarketplaces(activeJobRef, batch);
      const alreadyHasPrompt = isStyleReadyForImage(style);
      const needsListingRequest = markets.length > 0 && style.listing_json_status !== 'done';
      const needsPromptFallback = !alreadyHasPrompt;

      if (!needsListingRequest && alreadyHasPrompt && style.listing_json_status !== 'done') {
        style.listing_json_status = markets.length ? 'done' : 'skipped';
        delete style.listing_json_error;
        log(`Style ${style.style_id} da co image prompt, tao anh ngay`);
      } else if (needsListingRequest || needsPromptFallback) {
        try {
          const imageState = {
            image_url: style.image_url || null,
            image_data_url: style.image_data_url || null,
            image_generated_at: style.image_generated_at || null,
            chatgpt_image_url: style.chatgpt_image_url || null,
            image_source_url: style.image_source_url || null,
            raw_design_url: style.raw_design_url || null,
            raw_design_asset_id: style.raw_design_asset_id || null,
            raw_design_filename: style.raw_design_filename || null,
            no_bg_asset_id: style.no_bg_asset_id || null,
            no_bg_url: style.no_bg_url || null,
            mockup_ids: Array.isArray(style.mockup_ids) ? style.mockup_ids : []
          };
          const listingStyle = await requestStyleListingJson(activeJobRef || {}, batch, style, batch.styles.length);
          Object.assign(style, listingStyle, imageState);
          style.listing_json_status = 'done';
          delete style.listing_json_error;
          log(`<<< Style ${style.style_id}/${batch.styles.length} JSON/prompt xong`);
        } catch(e) {
          style.listing_json_status = 'failed';
          style.listing_json_error = e.message;
          log(`Style ${style.style_id} JSON listing LOI: ${e.message}`);
        }
      } else {
        log(`Style ${style.style_id} da co JSON listing, bo qua`);
      }

      if (taskStopRequested) throw new Error('Task stopped by user');
      const hasImage = !!(style.image_url || style.image_data_url || style.raw_design_url || style.raw_design_asset_id);
      if (hasImage) {
        log(`Style ${style.style_id} da co anh, bo qua`);
      } else if (isStyleReadyForImage(style)) {
        try {
          const prompt = getStyleDesignPrompt(style);
          log(`Style ${style.style_id}: gui prompt anh (${prompt.length} ky tu)`);
          const imgUrl = await generateOneImage(prompt, style.style_id, batch.styles.length, style.background_color);
          const imageDataUrl = await imageUrlToDataUrl(imgUrl);
          style.image_url = imgUrl;
          style.image_data_url = imageDataUrl;
          style.image_generated_at = new Date().toISOString();
          delete style.image_prompts;
          delete style.generated_images;
          log(`<<< Style ${style.style_id}/${batch.styles.length} tao anh xong`);
        } catch(e) {
          log(`Style ${style.style_id} tao anh LOI: ${e.message}`);
          style.image_url = null;
          style.image_error = e.message;
        }
      } else {
        log(`Style ${style.style_id} bo qua tao anh vi chua co design_prompt hop le`);
      }

      if (taskStopRequested) throw new Error('Task stopped by user');
      if (onStyleDone) await onStyleDone(style, i + 1, batch.styles.length);

      if (onProgress) onProgress(i + 1, batch.styles.length, style);

      // Nghi ngan giua cac anh de UI cap nhat, giu toc do batch nhanh.
      await sleep(500);
    }

    const successCount = batch.styles.filter(s => s.image_url || s.image_data_url || s.raw_design_url || s.raw_design_asset_id).length;
    const jsonCount = batch.styles.filter(s => s.listing_json_status === 'done').length;
    log(`=== PHASE B XONG: ${successCount}/${batch.styles.length} anh, ${jsonCount}/${batch.styles.length} JSON ===`);
    return batch;
  }

  function getSelectedJobForReload() {
    if (selectedJobs.size !== 1) return null;
    const id = [...selectedJobs][0];
    return allJobs.find(j => j._key === id || j.id === id) || null;
  }

  function findHistoryBatchForJob(job) {
    if (!job) return null;
    const batches = loadBatches();
    const hit = [...batches].reverse().find(item =>
      item?.batch?.styles?.length &&
      (item.asset_id === job.assetId ||
        item.asset_id === job.id ||
        item.asset_id === normalizeJobAssetId(job) ||
        item.batch?.meta?.job_id === job.id ||
        item.batch?.meta?.product_id === normalizeJobAssetId(job))
    );
    return hit?.batch || null;
  }

  function getCurrentChatAssetId() {
    const text = [document.title, location.href]
      .concat(getAssistantTextCandidates().slice(0, 2))
      .join(' ');
    const etsy = text.match(/\bEtsy\s*[-Â·:]\s*(\d{8,})\b/i) || text.match(/\betsy[-_](\d{8,})\b/i);
    if (etsy) return 'etsy-' + etsy[1];
    const amz = text.match(/\bAMZ\s*[-Â·:]\s*([A-Z0-9]{10})\b/i) || text.match(/\bamz[-_]([A-Z0-9]{10})\b/i) || text.match(/\b(B0[A-Z0-9]{8})\b/i);
    if (amz) return 'amz-' + amz[1].toUpperCase();
    return '';
  }

  function findHistoryItemByAssetId(assetId) {
    const id = String(assetId || '').trim();
    if (!id) return null;
    return [...loadBatches()].reverse().find(item => {
      const vals = [
        item.asset_id,
        item.batch?.meta?.asset_id,
        item.batch?.meta?.product_id,
        item.batch?.meta?.job_id
      ].map(x => String(x || '').trim());
      return vals.includes(id) ||
        vals.includes(id.replace(/^etsy-/i, '')) ||
        vals.includes(id.replace(/^amz-/i, ''));
    }) || null;
  }

  function getJobFromHistoryItem(item) {
    return resolveHistoryJob(item);
  }

  function extractBatchFromJob(job) {
    const candidates = [
      job?.batch,
      job?.gptBatch,
      job?.gpt_result?.batch,
      job?.gptResult?.batch,
      job?.result?.batch,
      job?.listing?.batch
    ];
    return candidates.find(b => b?.styles?.length) || null;
  }

  function getResumeStateForJob(job) {
    const active = loadActiveRunForJob(job);
    if (active?.batch?.styles?.length) return active;
    const serverBatch = extractBatchFromJob(job);
    if (serverBatch?.styles?.length) return {job, batch: JSON.parse(JSON.stringify(serverBatch)), phase: 'server_batch'};
    const historyBatch = findHistoryBatchForJob(job);
    if (historyBatch?.styles?.length) return {job, batch: JSON.parse(JSON.stringify(historyBatch)), phase: 'history'};
    return null;
  }

  async function continueJobImages(job) {
    const st = getResumeStateForJob(job);
    if (!st?.batch?.styles?.length) {
      throw new Error('Khong tim thay checkpoint/history JSON cho job nay. Can Re-GPT hoac chay lai tu dau.');
    }
    st.job = {...job, ...(st.job || {}), id: job.id || st.job?.id, assetId: job.assetId || st.job?.assetId};
    normalizeBatchForPipeline(st.job, st.batch);
    const missing = st.batch.styles.filter(s => !s.image_url && !s.image_data_url && !s.raw_design_url && !s.raw_design_asset_id).length;
    if (!missing) {
      log('Continue: job da du anh, chi re-post Raw Designs');
    } else {
      log(`Continue: tiep tuc ${missing}/${st.batch.styles.length} anh con thieu cho ${job.assetId || job.id.slice(0,8)}`);
    }
    await resumeActiveRun(st);
  }

  function getReloadImagesContext() {
    const active = loadActiveRunForCurrentPage();
    if (active?.job && active?.batch?.styles?.length) return {job: active.job, batch: active.batch, source: 'checkpoint'};

    const job = getSelectedJobForReload();
    const batch = findHistoryBatchForJob(job);
    if (job && batch?.styles?.length) return {job, batch, source: 'history'};

    const chatAssetId = getCurrentChatAssetId();
    const histItem = findHistoryItemByAssetId(chatAssetId);
    if (histItem?.batch?.styles?.length) {
      return {job: getJobFromHistoryItem(histItem), batch: JSON.parse(JSON.stringify(histItem.batch)), source: 'history_chat_title', histItem};
    }

    return {job: job || null, batch: batch || null, source: null};
  }

  async function reloadCurrentPageImagesToServer() {
    const ctx = getReloadImagesContext();
    const rawUrls = Array.from(new Set(getAssistantImageUrls()));

    // === TRUONG HOP KHONG CO BATCH ===
    if (!ctx.batch?.styles?.length) {
      if (!ctx.job) throw new Error('Khong co batch. Hay tick dung 1 job hoac mo chat co title Etsy/AMZ dung voi History truoc khi bam R.');
      const imageItems = await collectReloadImageDataUrls();
      if (!imageItems.length) throw new Error('Khong tim thay anh GPT hop le tren trang chat hien tai');
      log(`Reload no-batch: tim ${rawUrls.length} URL, ${imageItems.length} anh, job ${ctx.job.assetId || ctx.job.id.slice(0,8)}`);
      // postPageImagesToLibrary da co lookup job cu + chi upload anh con thieu
      const rawDesignResult = await postPageImagesToLibrary(ctx.job, imageItems);
      if (rawDesignResult.skipped) {
        log('Reload no-batch: tat ca anh da co tren server, khong can upload them');
        await reloadJobs();
        return {styles_total: rawDesignResult.total, designs_done: rawDesignResult.total, raw_design_done: rawDesignResult.total};
      }
      const finalRaw = finalizeRawDesignProgress({
        styles_total: rawDesignResult.total,
        designs_done: rawDesignResult.total,
        bg_done: 0,
        mockups_done: 0
      }, rawDesignResult);
      await updateJobStatus(ctx.job.id, finalRaw.status, {current_step: 'raw_design', progress: finalRaw.progress});
      await reloadJobs();
      return {...finalRaw.progress, status: finalRaw.status};
    }

    // === TRUONG HOP CO BATCH ===
    normalizeBatchForPipeline(ctx.job, ctx.batch);
    const total = ctx.batch.styles.length;

    // Nut R la thao tac replace/re-post chu dong: luon lay anh tren trang va
    // thay the tham chieu Raw Design cu, ke ca tham chieu den server team khac.
    const imageItems = await collectReloadImageDataUrls(total);
    if (!imageItems.length) throw new Error('Khong tim thay anh GPT hop le tren trang chat hien tai');
    log(`Reload co batch: ${rawUrls.length} URL tren trang, re-post ${imageItems.length}/${total} style (${ctx.source})`);

    // Map anh theo position va xoa dau vet upload cu de bo loc khong skip anh moi.
    for (let i = 0; i < ctx.batch.styles.length; i++) {
      const style = ctx.batch.styles[i];
      const item = imageItems[i];
      if (!item) { log(`CANH BAO: khong co anh cho style ${style.style_id || i+1} (vi tri ${i+1}/${total})`); continue; }
      style.raw_design_url = null;
      style.raw_design_asset_id = null;
      style.asset_id = null;
      style.image_url = item.src;
      style.image_data_url = item.dataUrl;
      style.image_generated_at = style.image_generated_at || new Date().toISOString();
    }

    saveActiveRun(ctx.job, ctx.batch, 'manual_reload_images_done');

    // Upload JSON (overwrite ok)
    try {
      await postGptResultToServer(ctx.job, ctx.batch, null, 'phase_b_done');
    } catch(e) {
      log('Reload: gpt-result fail, tiep tuc day Raw Designs: ' + e.message);
    }

    // Upload Raw Designs - filter tu dong skip style da co raw_design_url
    const rawDesignResult = await postRawDesignsToLibrary(ctx.job, ctx.batch);
    const finalRaw = finalizeRawDesignProgress(countBatchProgress(ctx.batch), rawDesignResult);
    await updateJobStatus(ctx.job.id, finalRaw.status, {current_step:'raw_design', progress:finalRaw.progress});

    if (ctx.histItem?.id) {
      const file = await exportOneFile(ctx.batch, false);
      saveBatches(loadBatches().map(item => item.id === ctx.histItem.id ? {
        ...item, batch: ctx.batch, files: filesFromExport(file), exported_at: new Date().toISOString()
      } : item));
      renderBatches();
    }
    saveActiveRun(ctx.job, ctx.batch, 'manual_reload_images_uploaded');
    renderJobs();
    return finalRaw.progress;
  }

  // Xu ly 1 job tu server queue - Phase A (text) + Phase B (anh) + Phase C (export)
  async function processServerJob(job) {
    cancelPendingChatRenames();
    activeJobKey = job._key || '';
    activeJobRef = job || null;
    log('--- JOB: ' + (job.assetId || job.id.slice(0,8)) + ' ---');
    // Reset trang thai terminal truoc khi chay lai (de server chap nhan cac update tiep theo)
    const RERUN_TERMINAL = new Set(['done','raw_design_done','raw_design_partial',
      'design_generated','gpt_json_validated','gpt_result_post_failed']);
    if (RERUN_TERMINAL.has(job.status)) {
      log('Re-run: reset status "' + job.status + '" -> queued...');
      try { await updateJobStatus(job.id, 'queued'); } catch(e) { log('Reset status fail (khong chan): ' + e.message); }
    }
    try { await updateJobStatus(job.id, 'gpt_running', {current_step:'gpt'}); }
    catch(e) {
      try { await updateJobStatus(job.id, 'processing'); }
      catch(err) {}
    }

    let imageFile = null;
    try {
      imageFile = await getSourceFile(job);
      log('Tai anh nguon OK: ' + imageFile.name);
    } catch(e) {
      log('Khong tai duoc anh: ' + e.message);
      if (!job.title && !job.prompt) throw new Error('Khong co anh va khong co title');
    }

    const title = job.title || job.prompt || '';

    // === PHASE A: Phan tich text -> JSON 6-10 styles ===
    const batch = await processStylePlanBatch(imageFile, title, getRedesignCount(job), job);
    batch.meta.asset_id = job.assetId || job.id;
    batch.meta.source_url = job.sourceImageUrl || null;
    normalizeBatchForPipeline(job, batch);
    saveActiveRun(job, batch, 'phase_a_done');
    log('Phase A xong');
    try { await updateJobStatus(job.id, 'gpt_json_validated', {current_step:'gpt', progress:countBatchProgress(batch)}); }
    catch(e) { log('Khong update status gpt_json_validated: ' + e.message); }

    try {
      await retryAsync(
        () => postGptResultToServer(job, batch, null, 'gpt_json_received'),
        3, 4000, 'Upload Phase A'
      );
      saveActiveRun(job, batch, 'json_uploaded');
      log('Da upload JSON Phase A len server');
    } catch(e) {
      // Khong kill job - tiep tuc Phase B, se retry upload o phase_b_done
      saveActiveRun(job, batch, 'json_upload_failed');
      log('CANH BAO: Upload Phase A fail sau 3 lan thu (' + e.message + ') - tiep tuc Phase B, se retry o cuoi job');
      try { await updateJobStatus(job.id, 'design_generating', {current_step:'gpt_then_design', error_note: 'phase_a_upload_failed_retrying'}); }
      catch(err) {}
    }

    // === PHASE B: Tao 6 anh trong cung chat ===
    if (imageGenEnabled) {
      try { await updateJobStatus(job.id, 'design_generating', {current_step:'design', progress:countBatchProgress(batch)}); }
      catch(e) { log('Khong update status design_generating: ' + e.message); }
      await processImagePhase(batch, (done, total, style) => {
        // Update progress vao UI batch status neu can
        const statusEl = document.getElementById('phb3-batch-status');
        if (statusEl && batchRunning) {
          statusEl.textContent = `Job ${batchIdx+1}/${batchQueue.length} - anh ${done}/${total}`;
        }
        saveActiveRun(job, batch, 'style_' + done + '_done');
        if (done === 1) scheduleRenameChatForJob(job);
        renderJobs();
      }, async (style, done, total) => {
        saveActiveRun(job, batch, 'style_' + done + '_done');
        // Upload the image to Tools before any legacy JSON checkpoint. Queue
        // authentication may expire independently and must not lose the image.
        if (style.raw_design_url || style.raw_design_asset_id) {
          log(`Raw Designs style ${style.style_id}/${total} da co tren Tools, bo qua upload`);
        } else if (style.image_url || style.image_data_url) {
          try {
            await postStyleRawDesignToLibrary(job, batch, style);
            saveActiveRun(job, batch, 'style_' + done + '_raw_uploaded');
            log(`Raw Designs style ${style.style_id}/${total} upload Tools OK`);
          } catch(rawErr) {
            style.raw_design_error = rawErr.message;
            log(`Raw Designs style ${style.style_id}/${total} upload Tools fail: ${rawErr.message}`);
          }
        }

        try {
          attachStyleListingJson(batch, style);
          const checkpoint = await postGptResultCheckpoint(job, makeSingleStyleBatch(job, batch, style), 'style_image_generated', 'Style ' + style.style_id + ' checkpoint');
          saveActiveRun(job, batch, checkpoint.ignored ? 'style_' + done + '_json_saved_raw_retry' : 'style_' + done + '_uploaded');
          log(`Upload style ${style.style_id}/${total} checkpoint OK`);
          await reportGeneratedImage(job, style);
        } catch(e) {
          saveActiveRun(job, batch, 'style_' + done + '_upload_failed');
          log(`Upload style ${style.style_id} checkpoint fail, tiep tuc: ${e.message}`);
        }
      });
      try { await updateJobStatus(job.id, 'design_generated', {current_step:'design', progress:countBatchProgress(batch)}); }
      catch(e) { log('Khong update status design_generated: ' + e.message); }
    } else {
      log('Phase B bi tat (chi xuat text)');
    }

    // === PHASE B.5: Chot checkpoint cuoi cung (retry Phase A neu can) ===
    let postResultError = null;
    let rawDesignResult = null;
    try {
      const saved = await postGptResultCheckpoint(job, batch, 'phase_b_done', 'Checkpoint cuoi');
      if (saved?.res?.batch_id && batch.meta) batch.meta.batch_id = saved.res.batch_id;
      saveActiveRun(job, batch, saved.ignored ? 'phase_b_json_saved_raw_retry' : 'phase_b_uploaded');
      log(saved.ignored ? 'Checkpoint cuoi: JSON da luu, Raw Designs se upload rieng' : 'Da POST checkpoint cuoi len server');
    } catch(e) {
      postResultError = e;
      log('POST JSON ve server fail sau 3 lan thu: ' + e.message + ' (se van thu day Raw Designs)');
    }

    if (imageGenEnabled) {
      try {
        const pendingRaw = countPendingRawDesignUploads(batch);
        rawDesignResult = pendingRaw > 0
          ? await retryAsync(() => postRawDesignsToLibrary(job, batch), 3, 5000, 'Raw Designs upload')
          : {saved: batch.styles.length, total: batch.styles.length, skipped: true};
      } catch(e) {
        postResultError = postResultError || e;
        log('Raw Designs DB fail: ' + e.message);
      }
    }

    // === PHASE C: Tao JSON history, khong auto-download local ===
    const file = await exportOneFile(batch, false);
    log('Luu JSON history ' + file.filename);

    const histItem = {
      id: 'b_' + Date.now(),
      title: batch.meta.source_title || title || 'Job ' + (job.assetId || job.id.slice(0,6)),
      asset_id: job.assetId || job.id,
      image_filename: batch.meta.image_filename,
      exported_at: batch.meta.exported_at,
      files: filesFromExport(file),
      batch: batch
    };
    addBatch(histItem);
    renderBatches();

    if (postResultError && !rawDesignResult) {
      try { await updateJobStatus(job.id, 'gpt_result_post_failed', {current_step:'gpt_result_post', error_message:postResultError.message}); }
      catch(e) { log('Khong update status gpt_result_post_failed: ' + e.message); }
      throw new Error('POST ve server fail: ' + postResultError.message);
    }

    const finalRaw = finalizeRawDesignProgress(countBatchProgress(batch), rawDesignResult);
    try { await updateJobStatus(job.id, finalRaw.status, {current_step:'raw_design', progress:finalRaw.progress}); }
    catch(e) { log('Khong update status ' + finalRaw.status + ': ' + e.message); }

    // === GUI VE LOCALHOST (song song, khong block) ===
    postJobToLocalhost(job, batch);

    scheduleRenameChatAfterJobDone(job);
    clearActiveRun(job.id);
    activeJobKey = '';
    activeJobRef = null;

    return histItem;
  }

  async function resumeActiveRun(st) {
    const job = st.job;
    const batch = st.batch;
    if (!job || !batch || !Array.isArray(batch.styles)) return;
    taskStopRequested = false;
    taskRunVersion++;
    activeJobKey = job._key || activeJobKey;
    activeJobRef = job || activeJobRef;
    const done = batch.styles.filter(s => s.image_url || s.image_data_url || s.raw_design_url || s.raw_design_asset_id).length;
    log(`Khoi phuc job dang do: ${job.assetId || job.id.slice(0,8)} - anh ${done}/${batch.styles.length}`);
    batchQueue = [job.id];
    batchIdx = 0;
    batchRunning = true;
    updateBatchUI();
    try { await updateJobStatus(job.id, 'design_generating', {current_step:'design', progress:countBatchProgress(batch)}); }
    catch(e) {}

    try {
      try {
        const token = await getExtensionToken();
        if (token) await uploadSourceMockupToTools(job, token);
      } catch (sourceError) {
        log(`Resume Source Mockup bo qua: ${sourceError.message}`);
      }
      await postGptResultCheckpoint(job, batch, done ? 'phase_b_done' : 'gpt_json_received', 'Resume checkpoint dau');
      saveActiveRun(job, batch, 'resume_checkpoint_uploaded');
      await processImagePhase(batch, (curDone, total) => {
        const statusEl = document.getElementById('phb3-batch-status');
        if (statusEl) statusEl.textContent = `Resume - anh ${curDone}/${total}`;
        saveActiveRun(job, batch, 'resume_style_' + curDone + '_done');
        renderJobs();
      }, async (style, curDone, total) => {
        saveActiveRun(job, batch, 'resume_style_' + curDone + '_done');
        try {
          attachStyleListingJson(batch, style);
          const checkpoint = await postGptResultCheckpoint(job, makeSingleStyleBatch(job, batch, style), 'style_image_generated', 'Resume style ' + style.style_id + ' checkpoint');
          saveActiveRun(job, batch, checkpoint.ignored ? 'resume_style_' + curDone + '_json_saved_raw_retry' : 'resume_style_' + curDone + '_uploaded');
          log(`Resume upload style ${style.style_id}/${total} checkpoint OK`);
          if (style.raw_design_url || style.raw_design_asset_id) {
            log(`Resume Raw Designs style ${style.style_id}/${total} da co tren server, bo qua upload`);
          } else if (style.image_url || style.image_data_url) {
            try {
              await postStyleRawDesignToLibrary(job, batch, style);
              saveActiveRun(job, batch, 'resume_style_' + curDone + '_raw_uploaded');
              log(`Resume Raw Designs style ${style.style_id}/${total} upload OK`);
            } catch(rawErr) {
              style.raw_design_error = rawErr.message;
              log(`Resume Raw Designs style ${style.style_id}/${total} upload fail: ${rawErr.message}`);
            }
          }
        } catch(e) {
          saveActiveRun(job, batch, 'resume_style_' + curDone + '_upload_failed');
          log(`Resume upload style ${style.style_id}/${total} checkpoint fail, tiep tuc: ${e.message}`);
        }
      });

      try {
        await postGptResultCheckpoint(job, batch, 'phase_b_done', 'Resume phase_b');
      } catch(e) {
        log('Resume phase_b gpt-result fail, tiep tuc day Raw Designs: ' + e.message);
      }
      const pendingRaw = countPendingRawDesignUploads(batch);
      const rawDesignResult = pendingRaw > 0
        ? await postRawDesignsToLibrary(job, batch)
        : {saved: batch.styles.length, total: batch.styles.length, skipped: true};
      const file = await exportOneFile(batch, false);
      addBatch({
        id: 'b_' + Date.now(),
        title: batch.meta?.source_title || job.title || 'Resume',
        asset_id: job.assetId || job.id,
        image_filename: batch.meta?.image_filename,
        exported_at: new Date().toISOString(),
        files: filesFromExport(file),
        batch
      });
      renderBatches();
      const finalRaw = finalizeRawDesignProgress(countBatchProgress(batch), rawDesignResult);
      try { await updateJobStatus(job.id, finalRaw.status, {current_step:'raw_design', progress:finalRaw.progress}); }
      catch(e) {}
      scheduleRenameChatAfterJobDone(job);

      // === GUI VE LOCALHOST (song song, khong block) ===
      postJobToLocalhost(job, batch);

      clearActiveRun(job.id);
      log('Resume xong, da day sang raw_design_queued');
    } catch(e) {
      saveActiveRun(job, batch, 'resume_failed');
      try { await updateJobStatus(job.id, 'failed', {current_step:'resume', error_message:e.message, progress:countBatchProgress(batch)}); }
      catch(err) {}
      log('Resume FAIL: ' + e.message);
    } finally {
      batchRunning = false;
      activeJobKey = '';
      activeJobRef = null;
      updateBatchUI();
    }
  }

  async function navigateToNewChat() {
    cancelPendingChatRenames();
    log('Mo chat moi...');
    sessionStorage.setItem('phb_v3_auto', JSON.stringify({running:true, queue:batchQueue, idx:batchIdx, jobs: batchJobSnapshots}));
    location.href = await getActiveGptUrl();
  }

  async function waitPageReady(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const box = findBox();
      if (box && box.offsetParent !== null) return true;
      await sleep(POLL_FAST_MS);
    }
    return false;
  }

  // ============ BATCH RUNNER ============
  let batchQueue = [];
  let batchJobSnapshots = {};
  let batchIdx = 0;
  let batchRunning = false;
  let taskStopRequested = false;
  let taskRunVersion = 0;
  let activeJobKey = '';
  let activeJobRef = null;
  let heartbeatTimer = null;

  function startHeartbeat(job) {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => heartbeatJob(job), 30000);
    heartbeatJob(job);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function startBatch(jobIds) {
    if (batchRunning) { showToast('Batch dang chay roi!', '#f59e0b'); return; }
    const availableJobIds = (jobIds || []).filter(id => {
      const job = allJobs.find(j => j._key === id || j.id === id || (j._mirrorKeys || []).includes(id));
      return job && !isJobLockedByOther(job);
    });
    if (availableJobIds.length < (jobIds || []).length) log('Batch: bo qua ' + ((jobIds || []).length - availableJobIds.length) + ' job dang bi runner khac giu');
    const cleanJobIds = dedupeJobIdsForBatch(availableJobIds);
    if (!cleanJobIds.length) { showToast('Chua chon job nao', '#ef4444'); return; }
    if (cleanJobIds.length < availableJobIds.length) log('Batch: da bo ' + (availableJobIds.length - cleanJobIds.length) + ' job trung asset');
    batchQueue = cleanJobIds.slice();
    batchJobSnapshots = {};
    allJobs.forEach(job => {
      if (job?._key && batchQueue.includes(job._key)) batchJobSnapshots[job._key] = job;
    });
    batchIdx = 0;
    batchRunning = true;
    taskStopRequested = false;
    taskRunVersion++;
    updateBatchUI();
    log('=== START BATCH: ' + batchQueue.length + ' jobs ===');
    log('Mo GPT redesign truoc khi chay batch...');
    sessionStorage.setItem('phb_v3_auto', JSON.stringify({running:true, queue:batchQueue, idx:batchIdx, jobs: batchJobSnapshots}));
    location.href = await getActiveGptUrl();
  }

  async function runNextInBatch() {
    if (!batchRunning) return;
    if (batchIdx >= batchQueue.length) {
      log('=== BATCH DONE: ' + batchQueue.length + ' jobs ===');
      showToast('Batch xong! ' + batchQueue.length + ' jobs', '#10b981');
      batchRunning = false;
      await releaseSelectedQueueJobs('batch_done');
      sessionStorage.removeItem('phb_v3_auto');
      await reloadJobs();
      updateBatchUI();
      return;
    }
    const jobId = batchQueue[batchIdx];
    let job = allJobs.find(j => j._key === jobId || j.id === jobId);
    if (!job) {
      log('Job ' + jobId + ' chua co trong queue hien tai, reload lai...');
      await reloadJobs();
      await sleep(1000);
      job = allJobs.find(j => j._key === jobId || j.id === jobId);
    }
    if (!job && batchJobSnapshots[jobId]) {
      job = batchJobSnapshots[jobId];
      log('Dung snapshot cho job ' + jobId);
    }
    if (!job) {
      log('Job ' + jobId + ' khong tim thay, bo qua');
      batchIdx++;
      runNextInBatch();
      return;
    }
    log('=== BATCH ' + (batchIdx+1) + '/' + batchQueue.length + ' ===');
    updateBatchUI();
    try {
      job = await claimJob(job);
      startHeartbeat(job);
      await processServerJob(job);
      stopHeartbeat();
      await releaseJob(job, 'done');
      batchIdx++;
      if (batchIdx < batchQueue.length) {
        await sleep(1500);
        await navigateToNewChat();
      } else {
        runNextInBatch();
      }
    } catch(e) {
      if (taskStopRequested) {
        log('JOB STOPPED: ' + e.message);
        batchRunning = false;
        sessionStorage.removeItem('phb_v3_auto');
        updateBatchUI();
        return;
      }
      log('JOB FAIL: ' + e.message);
      try { await updateJobStatus(job.id, 'failed', {error_message:e.message}); }
      catch(err) {}
      stopHeartbeat();
      await releaseJob(job, 'failed');
      activeJobKey = '';
      activeJobRef = null;
      batchIdx++;
      if (batchIdx < batchQueue.length) {
        log('Bo qua, mo chat moi de chay job tiep theo...');
        await sleep(2000);
        await navigateToNewChat();
      } else {
        runNextInBatch();
      }
    }
  }

  function stopBatch() {
    if (!batchRunning) return;
    cancelPendingChatRenames();
    taskStopRequested = true;
    taskRunVersion++;
    batchRunning = false;
    sessionStorage.removeItem('phb_v3_auto');
    stopHeartbeat();
    if (activeJobRef) releaseJob(activeJobRef, 'stopped');
    releaseSelectedQueueJobs('stopped');
    const stopBtn = findStopButton();
    if (stopBtn) {
      try { stopBtn.click(); } catch(e) {}
    }
    log('=== BATCH STOPPED ===');
    selectedJobs.clear();
    updateBatchUI();
  }

  // ============ DEDUP + PENDING CAPTURE (tu v2.4) ============
  const MIN_PENDING_BYTES = 1024 * 1024;
  let pendingCapture = [];
  let pendingEl = null;
  let autoDetect = true;
  let lastAutoCmd = '';

  function extractGenerateCommand(text) {
    const m = String(text || '').match(/Generate\s+Image\s*[:#-]?\s*(\d+)/i);
    return m ? 'Generate Image ' + m[1] : null;
  }

  async function dedupAll() {
    log('Loc anh trung URL trong queue...');
    try {
      const d = await requestJson(getLibApi(), '/jobs/dedup-all', {method:'POST'});
      if (d.success) { log('Xoa ' + (d.dupesRemoved || 0) + ' URL trung!'); await reloadJobs(); }
    } catch(e) { log('Loi dedup: ' + e.message); }
  }

  function releasePendingItem(item) {
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }

  function clearPendingCapture() {
    pendingCapture.forEach(releasePendingItem);
    pendingCapture = [];
  }

  async function pendingItemToDataUrl(item) {
    if (item.dataUrl) return item.dataUrl;
    if (item.blob) return blobToDataUrl(item.blob);
    return null;
  }

  async function collectFilteredImgs() {
    const containers = document.querySelectorAll('[data-message-author-role="assistant"] img, article img, [data-turn="assistant"] img');
    const candidates = Array.from(containers.length ? containers : document.querySelectorAll('img'))
      .filter(img => img.naturalWidth >= 200 && img.naturalHeight >= 200 && !img.closest('#phb-root-gpts'));
    const seenSrc = new Set();
    const withSize = [];
    for (const img of candidates) {
      const src = img.currentSrc || img.src;
      if (!src || seenSrc.has(src)) continue;
      seenSrc.add(src);
      try {
        if (src.startsWith('data:image')) {
          const size = Math.round((src.split(',')[1] || '').length * 0.75);
          if (size >= MIN_PENDING_BYTES) withSize.push({ size, dataUrl: src, src });
          continue;
        }
        const r = await fetch(src);
        if (!r.ok) continue;
        const blob = await r.blob();
        if (blob.size < MIN_PENDING_BYTES) continue;
        withSize.push({ size, blob, previewUrl: URL.createObjectURL(blob), src });
      } catch(e) {}
    }
    const sizeCount = new Map();
    const deduped = [];
    for (const item of withSize) {
      const cnt = sizeCount.get(item.size) || 0;
      if (cnt < 2) { sizeCount.set(item.size, cnt + 1); deduped.push(item); }
    }
    return deduped;
  }

  function renderPending() {
    if (!pendingEl) return;
    pendingEl.innerHTML = '';
    if (!pendingCapture.length) { pendingEl.style.display = 'none'; return; }
    pendingEl.style.display = 'block';
    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:5px';
    hdr.innerHTML = '<span style="font-size:11px;font-weight:800;color:#34d399">' + pendingCapture.length + ' anh cho push</span>';
    const clr = document.createElement('button');
    clr.textContent = 'Xoa het';
    clr.style.cssText = 'font-size:9px;color:#64748b;background:none;border:none;cursor:pointer';
    clr.onclick = () => { clearPendingCapture(); renderPending(); };
    hdr.appendChild(clr);
    pendingEl.appendChild(hdr);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:7px';
    pendingCapture.forEach((item, i) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;width:58px;flex-shrink:0';
      const img = document.createElement('img');
      img.src = item.previewUrl || item.dataUrl;
      img.style.cssText = 'width:58px;height:58px;object-fit:cover;border-radius:5px;background:#020617;border:1px solid rgba(52,211,153,.3)';
      const xb = document.createElement('button');
      xb.textContent = 'X';
      xb.style.cssText = 'position:absolute;top:1px;right:1px;width:14px;height:14px;font-size:8px;border:none;border-radius:3px;background:rgba(239,68,68,.9);color:#fff;cursor:pointer';
      xb.onclick = () => { const removed = pendingCapture.splice(i, 1); removed.forEach(releasePendingItem); renderPending(); };
      wrap.append(img, xb);
      grid.appendChild(wrap);
    });
    pendingEl.appendChild(grid);
    const pushBtn = document.createElement('button');
    pushBtn.textContent = 'Push len PodHub';
    pushBtn.style.cssText = 'width:100%;height:28px;font-size:11px;font-weight:900;border-radius:6px;cursor:pointer;border:1px solid rgba(99,102,241,.6);background:rgba(30,27,75,.9);color:#a5b4fc';
    pushBtn.onclick = async () => {
      pushBtn.disabled = true;
      try {
        const job = getSelectedJobForReload() || allJobs.find(j => selectedJobs.has(j._key)) || allJobs[0];
        const assetId = job?.assetId || ('manual-' + Date.now());
        const createRes = await libPost('/jobs/manual', { assetId, prompt: job?.title || job?.prompt || 'Push thu cong tu ChatGPT' });
        const jobId = createRes.id || createRes.job?.id;
        if (!jobId) throw new Error('Khong tao duoc job trong library');
        const images = [];
        for (const p of pendingCapture) {
          const dataUrl = await pendingItemToDataUrl(p);
          if (dataUrl) images.push({ dataUrl });
        }
        if (!images.length) throw new Error('Khong convert duoc anh');
        const r = await libPost('/jobs/' + encodeURIComponent(jobId) + '/outputs', { images });
        log('Push pending xong! +' + (r.added || images.length) + ' anh');
        clearPendingCapture();
        renderPending();
        await reloadJobs();
      } catch(e) { log('Loi push pending: ' + e.message); }
      finally { pushBtn.disabled = false; }
    };
    pendingEl.appendChild(pushBtn);
  }

  async function capturePageAll() {
    log('=== TAI LAI: loc anh >= 1MB ===');
    const items = await collectFilteredImgs();
    if (!items.length) { log('Khong co anh phu hop.'); return; }
    const existSrc = new Set(pendingCapture.map(p => p.src));
    const newItems = items.filter(i => !existSrc.has(i.src));
    pendingCapture.push(...newItems);
    log('Them ' + newItems.length + ' vao pending (' + pendingCapture.length + ' tong)');
    renderPending();
  }

  // Auto-detect Generate Image N (tu v2.4, ho tro GPT tra lenh text)
  setInterval(async () => {
    if (!autoDetect || batchRunning) return;
    let cmd = null;
    for (const text of getAssistantTextCandidates()) {
      cmd = extractGenerateCommand(text);
      if (cmd) break;
    }
    if (!cmd || cmd === lastAutoCmd) return;
    if (!findSendButton()) return;
    lastAutoCmd = cmd;
    log('Auto-detect: ' + cmd);
    if (!await pastePromptText(cmd)) { lastAutoCmd = ''; return; }
    await sleep(600);
    if (!await clickSendWithRetry(10000)) lastAutoCmd = '';
  }, 1500);

  // ============ TOAST + LOG ============
  function showToast(msg, color) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.setAttribute('style', `position:fixed!important;top:20px!important;left:50%!important;transform:translateX(-50%)!important;background:${color||'#1e40af'};color:#fff;padding:10px 22px;border-radius:10px;font-size:13px;font-weight:700;z-index:2147483648;pointer-events:none`);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  let logEl = null;
  function log(msg) {
    console.log('[PODHUB-GPTs]', msg);
    const t = new Date().toLocaleTimeString('vi', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    const d = document.createElement('div');
    d.textContent = '[' + t + '] ' + msg;
    const isErr = /loi|fail|CANH BAO|FAIL/i.test(msg);
    const isOk = /OK|xong|done|DONE|!$/i.test(msg);
    const isW = /Cho|Tim|Convert|Paste|Attach|Mo /i.test(msg);
    d.style.cssText = 'font-size:10px;line-height:1.5;color:' + (isErr ? '#f87171' : isOk ? '#4ade80' : isW ? '#fbbf24' : '#94a3b8');
    if (logEl) {
      logEl.appendChild(d);
      while (logEl.children.length > 100) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  // ============ JOB QUEUE STATE ============
  let allJobs = [];
  let rawLoadedJobs = [];
  let selectedJobs = new Set();
  let selectedJobsHeartbeatTimer = null;
  let currentTab = 'queue';
  let imageGenEnabled = true; // Phase B luon bat
  let redesignCount = Math.max(1, Math.min(30, Number(localStorage.getItem('phb_v3_redesign_count') || 8)));
  let historyFilter = localStorage.getItem('phb_v3_history_filter') || '';
  let currentPage = 0;
  const PAGE_SIZE = 20;

  function getRedesignCount(job) {
    const raw = Number(job?.redesign_count || job?.redesignCount || job?.styles_count || job?.styleCount || redesignCount || 8);
    return Math.max(1, Math.min(30, Number.isFinite(raw) ? Math.round(raw) : 8));
  }

  function jobDedupeKey(job) {
    const asset = normalizeJobAssetId(job);
    if (asset) return 'asset:' + String(asset).toLowerCase();
    const url = String(job?.sourceImageUrl || '').trim();
    if (url) return 'url:' + url.toLowerCase();
    return 'id:' + String(job?._serverKey || '') + ':' + String(job?.id || '');
  }

  function jobStatusRank(job) {
    if (isPendingJob(job)) return 400;
    if (isFailedJob(job)) return 300;
    if (isDoneJob(job)) return 200;
    return 100;
  }

  function jobProgressScore(job) {
    const p = job?.progress || {};
    return Number(p.raw_design_done || p.designs_done || p.raw_design_saved || 0) +
      Number(p.styles_total || p.total || 0) / 100;
  }

  function scoreQueueJob(job) {
    let score = jobStatusRank(job) * 100000;
    score += jobProgressScore(job) * 1000;
    if (job?._serverKey === 'podhub') score += 200;
    if (job?._serverKey === 'local') score += 100;
    score += Date.parse(job?.updatedAt || job?.createdAt || 0) / 100000000;
    return score;
  }

  function mergeQueueDuplicates(jobs) {
    const byKey = new Map();
    const order = [];
    for (const job of jobs || []) {
      const key = jobDedupeKey(job);
      if (!byKey.has(key)) {
        byKey.set(key, {
          ...job,
          _dedupeKey: key,
          _mirrorKeys: [job._key].filter(Boolean),
          _mirrorServers: [job._serverLabel || job._serverKey].filter(Boolean)
        });
        order.push(key);
        continue;
      }
      const cur = byKey.get(key);
      const keep = scoreQueueJob(job) > scoreQueueJob(cur) ? job : cur;
      const drop = keep === job ? cur : job;
      byKey.set(key, {
        ...keep,
        _dedupeKey: key,
        _mirrorKeys: Array.from(new Set([...(cur._mirrorKeys || []), job._key].filter(Boolean))),
        _mirrorServers: Array.from(new Set([...(cur._mirrorServers || []), job._serverLabel || job._serverKey].filter(Boolean))),
        _duplicateCount: ((cur._mirrorKeys || []).length || 1)
      });
      if (drop?._key && selectedJobs.has(drop._key)) selectedJobs.add(keep._key);
    }
    return order.map(key => byKey.get(key));
  }

  function dedupeJobIdsForBatch(jobIds) {
    const out = [];
    const seen = new Set();
    for (const id of jobIds || []) {
      const job = allJobs.find(j => j._key === id || j.id === id || (j._mirrorKeys || []).includes(id));
      const key = job ? jobDedupeKey(job) : String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(job?._key || id);
    }
    return out;
  }

  function isJobMine(job) {
    const id = String(job?.runner_id || '').trim();
    return !!id && id === runnerId;
  }

  function isJobLockedByOther(job) {
    const id = String(job?.runner_id || '').trim();
    return !!id && id !== runnerId;
  }

  function mergeKnownJob(updated) {
    if (!updated?.id) return updated;
    const patchJob = job => {
      if (!job || (job.id !== updated.id && job._key !== updated._key && !(job._mirrorKeys || []).includes(updated._key))) return job;
      return {
        ...job,
        ...updated,
        _serverOrigin: job._serverOrigin || updated._serverOrigin,
        _serverKey: job._serverKey || updated._serverKey,
        _serverLabel: job._serverLabel || updated._serverLabel,
        _key: job._key || updated._key,
        _mirrorKeys: job._mirrorKeys || updated._mirrorKeys,
        _mirrorServers: job._mirrorServers || updated._mirrorServers
      };
    };
    allJobs = allJobs.map(patchJob);
    rawLoadedJobs = rawLoadedJobs.map(patchJob);
    return allJobs.find(j => j._key === updated._key || j.id === updated.id) || updated;
  }

  async function selectQueueJob(job) {
    if (!job?.id) return null;
    if (isJobLockedByOther(job)) throw new Error('Job dang duoc runner khac giu: ' + job.runner_id);
    const claimed = mergeKnownJob(await claimJob(job));
    if (isJobLockedByOther(claimed)) throw new Error('Job vua bi runner khac giu: ' + claimed.runner_id);
    selectedJobs.add(claimed._key || job._key);
    updateSelectedJobsHeartbeat();
    console.log('[PHB] Da giu job:', claimed.assetId || claimed.id);
    return claimed;
  }

  async function unselectQueueJob(job, reason = 'unselected') {
    if (!job) return;
    selectedJobs.delete(job._key);
    (job._mirrorKeys || []).forEach(key => selectedJobs.delete(key));
    if (isJobMine(job)) {
      await releaseJob(job, reason);
      mergeKnownJob({...job, runner_id: null, runner_label: null});
      console.log('[PHB] Da bo giu job:', job.assetId || job.id);
    }
    updateSelectedJobsHeartbeat();
  }

  async function releaseSelectedQueueJobs(reason = 'clear_selection') {
    const jobs = allJobs.filter(j => selectedJobs.has(j._key) || (j._mirrorKeys || []).some(key => selectedJobs.has(key)));
    for (const job of jobs) {
      try { await unselectQueueJob(job, reason); }
      catch(e) { log('Release selected job fail: ' + e.message); }
    }
    selectedJobs.clear();
    updateSelectedJobsHeartbeat();
  }

  async function heartbeatSelectedQueueJobs() {
    const jobs = allJobs.filter(j => isJobMine(j) && (selectedJobs.has(j._key) || (j._mirrorKeys || []).some(key => selectedJobs.has(key))));
    for (const job of jobs) {
      try { await heartbeatJob(job); }
      catch(e) {}
    }
  }

  function updateSelectedJobsHeartbeat() {
    if (selectedJobs.size && !selectedJobsHeartbeatTimer) {
      selectedJobsHeartbeatTimer = setInterval(() => heartbeatSelectedQueueJobs(), 30000);
      heartbeatSelectedQueueJobs();
    } else if (!selectedJobs.size && selectedJobsHeartbeatTimer) {
      clearInterval(selectedJobsHeartbeatTimer);
      selectedJobsHeartbeatTimer = null;
    }
  }

  async function reloadJobs() {
    try {
      const loaded = [];
      const responses = [];
      const scoped = await apiGetFrom(PODHUB_ORIGIN, '/jobs?runner_id=' + encodeURIComponent(runnerId));
      responses.push(scoped);
      try {
        const all = await apiGetFrom(PODHUB_ORIGIN, '/jobs');
        responses.push(all);
      } catch(e) {
        log('Load all job bo qua: ' + e.message);
      }
      const seen = new Set();
      responses.forEach(d => (d.data || []).forEach(job => {
        const key = 'podhub:' + job.id;
        if (seen.has(key)) return;
        seen.add(key);
        loaded.push({
          ...job,
          _serverKey: 'podhub',
          _serverLabel: 'Podhub VPS',
          _serverOrigin: PODHUB_ORIGIN,
          _key: key
        });
      }));
      rawLoadedJobs = loaded;
      allJobs = mergeQueueDuplicates(loaded);
      const existingKeys = new Set(allJobs.flatMap(j => [j._key, ...(j._mirrorKeys || [])].filter(Boolean)));
      selectedJobs = new Set([...selectedJobs].map(id => {
        const job = allJobs.find(j => j._key === id || (j._mirrorKeys || []).includes(id));
        return job?._key || id;
      }).filter(id => existingKeys.has(id)));
      updateSelectedJobsHeartbeat();
      renderJobs();
      updateSubtitle();
    } catch(e) {
      log('Loi load job: ' + e.message);
      updateSubtitle('Mat ket noi Podhub VPS');
    }
  }

  function updateSubtitle(forcedMsg) {
    const el = document.getElementById('phb3-sub');
    if (!el) return;
    if (forcedMsg) { el.textContent = forcedMsg; return; }
    const pending = allJobs.filter(isPendingJob).length;
    el.textContent = pending + ' cho · ' + allJobs.length + ' tong · ' + selectedJobs.size + ' chon · Podhub VPS';
  }

  function updateQueueFilterUI() {
    const counts = {
      pending: allJobs.filter(isPendingJob).length,
      failed: allJobs.filter(isFailedJob).length,
      done: allJobs.filter(isDoneJob).length,
      all: allJobs.length
    };
    document.querySelectorAll('.phb3-filter').forEach(btn => {
      const f = btn.getAttribute('data-filter') || 'pending';
      const active = f === queueFilter;
      const color = f === 'failed' ? '#f87171' : f === 'done' ? '#34d399' : f === 'pending' ? '#fbbf24' : '#38bdf8';
      btn.textContent = `${f.charAt(0).toUpperCase() + f.slice(1)} ${counts[f] || 0}`;
      btn.style.background = active ? color + '22' : '#101b2d';
      btn.style.color = active ? color : '#94a3b8';
      btn.style.borderColor = active ? color + '88' : 'rgba(148,163,184,.25)';
    });
  }

  function statusColor(s) {
    return ({
      queued:'#3b82f6', processing:'#f59e0b', done:'#10b981', failed:'#ef4444',
      gpt_running:'#f59e0b', gpt_json_validated:'#8b5cf6', gpt_result_saved:'#8b5cf6', design_generating:'#f59e0b',
      design_generated:'#06b6d4', raw_design_partial:'#f59e0b', raw_design_done:'#10b981',
      raw_design_queued:'#06b6d4', raw_design_importing:'#f59e0b',
      raw_design_failed:'#ef4444', gpt_result_post_failed:'#ef4444'
    })[s] || '#64748b';
  }

  function getJobProgressText(job) {
    let total = Number(job?.progress?.styles_total || 0);
    let done = Number(job?.progress?.designs_done || job?.progress?.raw_design_done || job?.progress?.raw_design_saved || 0);
    const active = loadActiveRunForCurrentPage();
    if (active?.job?.id === job.id && Array.isArray(active.batch?.styles)) {
      total = active.batch.styles.length;
      done = Math.max(done, active.batch.styles.filter(s =>
        s.image_url || s.chatgpt_image_url || s.image_source_url || s.image_generated_at || s.raw_design_url || s.raw_design_asset_id
      ).length);
    }
    if (!total) return '';
    return `Redesign ${done}/${total} Images`;
  }

  // ============ RE-POST & RE-GPT (History) ============
  function resolveHistoryJob(item) {
    return allJobs.find(j =>
      j.assetId === item.asset_id || normalizeJobAssetId(j) === item.asset_id || j.id === item.batch?.meta?.job_id
    ) || { id: item.batch?.meta?.job_id || item.asset_id || ('history_' + Date.now()), assetId: item.asset_id, title: item.title };
  }

  async function reloadImagesForHistoryItem(item) {
    if (!item?.batch?.styles?.length) throw new Error('History item khong co batch data');
    const batch = JSON.parse(JSON.stringify(item.batch));
    const job = resolveHistoryJob(item);
    normalizeBatchForPipeline(job, batch);
    const total = batch.styles.length;
    const imageItems = await collectReloadImageDataUrls(total);
    if (!imageItems.length) throw new Error('Khong tim thay anh GPT hop le tren trang hien tai');
    log(`History reload: gan ${imageItems.length}/${total} anh cho "${item.title}"`);

    for (let i = 0; i < batch.styles.length; i++) {
      const style = batch.styles[i];
      const image = imageItems[i];
      if (!image) continue;
      style.raw_design_url = null;
      style.raw_design_asset_id = null;
      style.asset_id = null;
      style.image_url = image.src;
      style.image_data_url = image.dataUrl;
      style.image_generated_at = new Date().toISOString();
    }

    normalizeBatchForPipeline(job, batch);
    try {
      await postGptResultCheckpoint(job, batch, 'phase_b_done', 'History reload');
    } catch(e) {
      log('History reload: gpt-result fail, tiep tuc Raw Designs: ' + e.message);
    }
    const rawDesignResult = await postRawDesignsToLibrary(job, batch);
    const finalRaw = finalizeRawDesignProgress(countBatchProgress(batch), rawDesignResult);
    try { await updateJobStatus(job.id, finalRaw.status, {current_step:'raw_design', progress:finalRaw.progress}); } catch(e) {}

    const file = await exportOneFile(batch, false);
    const batches = loadBatches().map(b => b.id === item.id ? {...b, batch, files: filesFromExport(file), exported_at: new Date().toISOString()} : b);
    saveBatches(batches);
    renderBatches();
    return finalRaw.progress;
  }

  // Luong A: Re-normalize + Re-POST batch da luu len server (khong can GPT)
  async function repostHistoryBatch(item) {
    if (!item?.batch) throw new Error('Khong co batch data');
    const batch = JSON.parse(JSON.stringify(item.batch));
    const job = resolveHistoryJob(item);
    normalizeBatchForPipeline(job, batch);
    const err = validateBatchJSON(batch);
    if (err) log('Re-post: batch sau normalize con loi (van thu post): ' + err);
    await postGptResultCheckpoint(job, batch, 'phase_b_done', 'Re-post');
    if (batch.styles.some(s => s.image_url || s.image_data_url)) {
      try { await postRawDesignsToLibrary(job, batch); } catch(e) { log('Re-post raw designs fail: ' + e.message); }
    }
    const file = await exportOneFile(batch, false);
    const batches = loadBatches().map(b => b.id === item.id ? {...b, batch, files: filesFromExport(file)} : b);
    saveBatches(batches);
    renderBatches();
    showToast('Re-post OK!', '#10b981');
    log('Re-post "' + item.title + '" -> server OK');
  }

  function hasStyleListingPayload(style) {
    if (!style || typeof style !== 'object') return false;
    return !!(
      style.title ||
      style.short_title ||
      style.description ||
      style.shelf_description ||
      getStyleDesignPrompt(style) ||
      (Array.isArray(style.bullets) && style.bullets.length) ||
      (Array.isArray(style.seo_keywords) && style.seo_keywords.length)
    );
  }

  function mergeCurrentPageJsonIntoBatch(batch) {
    if (!batch || !Array.isArray(batch.styles) || !batch.styles.length) return 0;
    const candidates = getAssistantTextCandidates();
    let merged = 0;
    const mergedIds = new Set();

    for (const text of candidates) {
      const obj = extractAnyJSON(text) || extractJSON(text);
      if (!obj || typeof obj !== 'object') continue;

      for (const style of batch.styles) {
        if (!style) continue;
        const styleId = String(style.style_id || style.style_no || '');
        if (!styleId || mergedIds.has(styleId)) continue;

        const normalized = normalizeSingleStyleJSON(obj, style, batch);
        const normalizedId = String(normalized?.style_id || normalized?.style_no || '');
        if (normalizedId !== styleId) continue;
        if (!hasStyleListingPayload(normalized)) continue;

        Object.assign(style, normalized);
        style.listing_json_status = 'done';
        style.listing_json_received_at = style.listing_json_received_at || new Date().toISOString();
        delete style.listing_json_error;
        applyStyleBackgroundColor(style, 'White');
        mergedIds.add(styleId);
        merged++;
      }
    }

    if (merged) log('R Json: lay duoc ' + merged + '/' + batch.styles.length + ' JSON style tu trang hien tai');
    else log('R Json: khong tim thay JSON style moi tren trang, dung batch history hien co');
    return merged;
  }

  async function repostHistoryJsonOnly(item) {
    if (!item?.batch) throw new Error('Khong co batch data');
    const batch = JSON.parse(JSON.stringify(item.batch));
    const job = resolveHistoryJob(item);
    const mergedFromPage = mergeCurrentPageJsonIntoBatch(batch);
    normalizeBatchForPipeline(job, batch);
    const err = validateBatchJSON(batch);
    if (err) log('R Json: batch sau normalize con loi (van thu post): ' + err);
    await postGptResultCheckpoint(job, batch, 'phase_b_done', 'R Json');
    const file = await exportOneFile(batch, false);
    const batches = loadBatches().map(b => b.id === item.id ? {...b, batch, files: filesFromExport(file), exported_at: new Date().toISOString()} : b);
    saveBatches(batches);
    renderBatches();
    showToast(mergedFromPage ? ('R Json OK - ' + mergedFromPage + ' style') : 'R Json OK', '#10b981');
    log('R Json "' + item.title + '" -> ' + 'Podhub VPS' + ' OK');
  }

  // Luong B buoc 1: Luu ctx vao sessionStorage + navigate sang GPT URL
  async function startReGptFlow(item) {
    const oldImages = {};
    (item.batch?.styles || []).forEach(s => {
      if (s.style_id != null) {
        oldImages[String(s.style_id)] = {
          image_url: s.image_url || null,
          image_data_url: s.image_data_url || null,
          raw_design_url: s.raw_design_url || null,
          raw_design_asset_id: s.raw_design_asset_id || null
        };
      }
    });
    const ctx = {
      histItemId: item.id,
      title: item.title,
      assetId: item.asset_id,
      styleCount: (item.batch?.styles || []).length || redesignCount,
      oldImages
    };
    sessionStorage.setItem('phb_v3_regpt', JSON.stringify(ctx));
    log('Re-GPT: luu ctx + chuyen sang GPT URL...');
    location.href = await getActiveGptUrl();
  }

  // Luong B buoc 2: Chay sau khi navigate: Phase A -> merge anh cu -> Phase B cho styles con thieu
  async function resumeReGptFlow(ctx) {
    sessionStorage.removeItem('phb_v3_regpt');
    log('=== RE-GPT FLOW: ' + (ctx.title || ctx.assetId || '?') + ' ===');
    const job = allJobs.find(j =>
      j.assetId === ctx.assetId || normalizeJobAssetId(j) === ctx.assetId
    ) || { id: ctx.assetId || ('regpt_' + Date.now()), assetId: ctx.assetId, title: ctx.title };

    let imageFile = null;
    try {
      imageFile = await getSourceFile(job);
      log('Re-GPT: tai anh OK: ' + imageFile.name);
    } catch(e) {
      log('Re-GPT: khong tai duoc anh (' + e.message + '), van thu Phase A khong anh');
    }

    // Phase A: hoi lai GPT
    const batch = await processStylePlanBatch(imageFile, ctx.title, ctx.styleCount || redesignCount, job);
    batch.meta.asset_id = ctx.assetId;
    batch.meta.source_title = batch.meta.source_title || ctx.title || '';

    // Merge anh cu vao styles moi theo style_id
    let mergedCount = 0;
    batch.styles.forEach(s => {
      const old = ctx.oldImages?.[String(s.style_id)];
      if (old?.image_url) {
        s.image_url = old.image_url;
        if (old.image_data_url) s.image_data_url = old.image_data_url;
        if (old.raw_design_url) s.raw_design_url = old.raw_design_url;
        if (old.raw_design_asset_id) s.raw_design_asset_id = old.raw_design_asset_id;
        mergedCount++;
      }
    });
    log('Re-GPT: merge ' + mergedCount + '/' + batch.styles.length + ' anh cu theo style_id');

    // Phase B: tao anh cho styles con thieu + hoi JSON listing rieng cho moi style
    const missingCount = batch.styles.filter(s => !s.image_url && !s.image_data_url && !s.raw_design_url && !s.raw_design_asset_id).length;
    const missingJsonCount = batch.styles.filter(s => !isStyleListingComplete(s, job, batch)).length;
    if ((missingCount > 0 || missingJsonCount > 0) && imageGenEnabled) {
      log('Re-GPT: can tao them ' + missingCount + ' anh moi, ' + missingJsonCount + ' JSON listing...');
      await processImagePhase(batch, (done, total) => {
        const statusEl = document.getElementById('phb3-batch-status');
        if (statusEl) statusEl.textContent = 'Re-GPT - anh ' + done + '/' + total;
      }, async (style, done, total) => {
        try {
          attachStyleListingJson(batch, style);
          await postGptResultCheckpoint(job, makeSingleStyleBatch(job, batch, style), 'style_image_generated', 'Re-GPT style ' + style.style_id + ' checkpoint');
          if (style.image_url || style.image_data_url) {
            await postStyleRawDesignToLibrary(job, batch, style);
            log(`Re-GPT Raw Designs style ${style.style_id}/${total} upload OK`);
          }
        } catch(e) {
          log(`Re-GPT style ${style.style_id}/${total} upload fail: ${e.message}`);
        }
      });
    } else if (missingCount > 0) {
      log('Re-GPT: ' + missingCount + ' styles chua co anh nhung Phase B dang tat');
    }

    // Normalize + POST
    normalizeBatchForPipeline(job, batch);
    try {
      await postGptResultCheckpoint(job, batch, 'phase_b_done', 'Re-GPT post');
      log('Re-GPT: POST server OK');
    } catch(e) {
      log('Re-GPT: post server fail: ' + e.message);
    }
    if (countPendingRawDesignUploads(batch) > 0) {
      try { await postRawDesignsToLibrary(job, batch); } catch(e) { log('Re-GPT: raw designs fail: ' + e.message); }
    }

    // Luu vao history + auto-download JSON
    const file = await exportOneFile(batch, true);
    addBatch({
      id: 'b_' + Date.now(),
      title: ctx.title || 'Re-GPT',
      asset_id: ctx.assetId,
      exported_at: new Date().toISOString(),
      files: filesFromExport(file),
      batch
    });
    renderBatches();
    showToast('Re-GPT xong! ' + batch.styles.length + ' styles', '#10b981');
    log('=== RE-GPT XONG ===');
  }

  // ============ UI ============
  let jobListEl = null;
  let batchesEl = null;
  let manualImageFile = null;
  let manualTitle = '';
  let queueFilter = localStorage.getItem('phb_v3_queue_filter') || 'pending';

  function isDoneJob(job) {
    return new Set(['done','raw_design_done','design_generated','gpt_json_validated']).has(job?.status);
  }

  function isFailedJob(job) {
    return new Set(['failed','raw_design_failed','gpt_result_post_failed']).has(job?.status);
  }

  function isPendingJob(job) {
    return !isDoneJob(job) && !isFailedJob(job);
  }

  function isJobVisibleByFilter(job) {
    if (queueFilter === 'failed') return isFailedJob(job);
    if (queueFilter === 'done') return isDoneJob(job);
    if (queueFilter === 'pending') return isPendingJob(job);
    return true;
  }

  function getVisibleJobs() {
    return allJobs.filter(isJobVisibleByFilter);
  }

  function buildPanel() {
    const root = document.createElement('div');
    root.id = 'phb-root-gpts';
    const RC = 'position:fixed!important;top:0!important;left:0!important;right:auto!important;width:380px!important;height:100vh!important;z-index:2147483647!important;display:none;flex-direction:column;background:#08111f;border-right:1px solid rgba(148,163,184,.25);box-shadow:6px 0 24px rgba(0,0,0,.5);font-family:Inter,system-ui,Arial,sans-serif;color:#e2e8f0;overflow:hidden';
    root.setAttribute('style', RC);
    const openBtnStyle = 'position:fixed!important;top:140px!important;right:0!important;left:auto!important;width:38px;height:42px;z-index:2147483647;border:none;border-radius:8px 0 0 8px;background:linear-gradient(135deg,#0f766e,#14b8a6);color:#fff;font-size:15px;font-weight:900;cursor:pointer;box-shadow:-4px 6px 18px rgba(0,0,0,.35)';
    let launcherBtn = null;
    let floatingStopBtn = null;
    function ensureLauncher() {
      if (launcherBtn && document.body.contains(launcherBtn)) return;
      launcherBtn = document.createElement('button');
      launcherBtn.id = 'phb3-launcher';
      launcherBtn.textContent = 'P';
      launcherBtn.title = 'FierceTee Team Bridge';
      launcherBtn.setAttribute('style', openBtnStyle);
      launcherBtn.onclick = () => {
        const active = document.documentElement.getAttribute('data-podhub-active-panel');
        document.documentElement.setAttribute('data-podhub-active-panel', active === 'bridge' && root.style.display === 'flex' ? '' : 'bridge');
        document.dispatchEvent(new Event('podhub-panel-switch'));
      };
      document.body.appendChild(launcherBtn);
      if (!floatingStopBtn || !document.body.contains(floatingStopBtn)) {
        floatingStopBtn = document.createElement('button');
        floatingStopBtn.id = 'phb3-floating-stop';
        floatingStopBtn.textContent = 'STOP';
        floatingStopBtn.title = 'Dung tac vu Podhub dang chay';
        floatingStopBtn.setAttribute('style', 'position:fixed!important;top:236px!important;right:0!important;left:auto!important;width:58px;height:38px;z-index:2147483647;border:none;border-radius:8px 0 0 8px;background:#7f1d1d;color:#fecaca;font-size:12px;font-weight:900;cursor:pointer;box-shadow:-4px 6px 18px rgba(0,0,0,.35);display:none');
        floatingStopBtn.onclick = () => stopBatch();
        document.body.appendChild(floatingStopBtn);
      }
    }

    // Header
    const hdr = document.createElement('div');
    hdr.style.cssText = 'padding:10px 12px;border-bottom:1px solid rgba(148,163,184,.2);background:#0a1628;display:flex;align-items:center;justify-content:space-between;flex-shrink:0';
    hdr.innerHTML = `
      <div>
        <div style="font-size:14px;font-weight:900;color:#e2e8f0">FierceTee Team Bridge v${VERSION}</div>
        <div id="phb3-sub" style="font-size:11px;color:#64748b">Dang tai...</div>
      </div>
      <div style="display:flex;gap:4px">
        <button id="phb3-cfg-toggle" title="Cai dat (Token, Runner, DUP...)" style="height:26px;padding:0 7px;border-radius:6px;border:1px solid rgba(148,163,184,.3);background:#101b2d;color:#94a3b8;cursor:pointer;font-size:13px">&#9881;</button>
        <button id="phb3-scan" title="Quet anh GPT tren trang (>=1MB) vao pending" style="height:26px;padding:0 7px;border-radius:6px;border:1px solid rgba(16,185,129,.4);background:rgba(16,185,129,.15);color:#34d399;cursor:pointer;font-size:10px;font-weight:800">&#x21BA;</button>
        <button id="phb3-rf" title="Tai lai danh sach job" style="width:26px;height:26px;border-radius:6px;border:1px solid rgba(148,163,184,.25);background:#101b2d;color:#e2e8f0;cursor:pointer;font-size:13px">&#8635;</button>
        <button id="phb3-cl" title="An panel" style="width:26px;height:26px;border-radius:6px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.1);color:#f87171;cursor:pointer;font-size:11px;font-weight:900">&#x2715;</button>
      </div>
    `;
    root.appendChild(hdr);

    // Config drawer (collapsed by default)
    const configDrawer = document.createElement('div');
    configDrawer.id = 'phb3-config-drawer';
    configDrawer.style.cssText = 'display:none;flex-direction:column;gap:6px;padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.2);flex-shrink:0;background:#0a1628';
    configDrawer.innerHTML = `
      <div id="phb3-sso-status" style="padding:6px 8px;border-radius:6px;background:rgba(30,41,59,.6);border:1px solid rgba(148,163,184,.25);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:10px;color:#cbd5e1">Kiểm tra kết nối PodHub...</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:10px;font-weight:700;color:#94a3b8">EXTENSION LICENSE KEY:</span>
        <a href="${TOOLS_ORIGIN}/account" target="_blank" style="font-size:9px;color:#38bdf8;text-decoration:none">Quan ly key</a>
      </div>
      <div style="display:flex;gap:5px">
        <input id="phb3-license-input" type="password" placeholder="phb_ext_live_..." style="flex:1;height:24px;padding:0 8px;background:#020617;border:1px solid rgba(148,163,184,.25);border-radius:5px;color:#e2e8f0;font-size:10px;outline:none">
        <button id="phb3-license-activate" style="height:24px;padding:0 8px;border-radius:5px;border:1px solid rgba(56,189,248,.5);background:rgba(56,189,248,.15);color:#38bdf8;cursor:pointer;font-size:10px;font-weight:900">KICH HOAT</button>
      </div>
      <div style="display:flex;align-items:center;gap:5px">
        <span style="font-size:10px;font-weight:800;color:#94a3b8;white-space:nowrap">RUNNER:</span>
        <input id="phb3-runner-input" value="${runnerId.replace(/"/g, '&quot;')}" title="Moi trinh duyet/profile nen co Runner rieng" style="flex:1;height:24px;padding:0 7px;background:#020617;border:1px solid rgba(148,163,184,.25);border-radius:5px;color:#e2e8f0;font-size:10px;font-weight:800;outline:none">
        <button id="phb3-runner-save" style="height:24px;padding:0 8px;border-radius:5px;border:1px solid rgba(52,211,153,.45);background:rgba(52,211,153,.12);color:#34d399;cursor:pointer;font-size:10px;font-weight:900">LUU</button>
      </div>
      <div style="display:flex;gap:5px">
        <button id="phb3-check-dup"  style="flex:1;height:26px;border-radius:5px;border:1px solid rgba(56,189,248,.35);background:rgba(56,189,248,.1);color:#38bdf8;cursor:pointer;font-size:9px;font-weight:900">DUP?</button>
        <button id="phb3-delete-dup" style="flex:1;height:26px;border-radius:5px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.1);color:#f87171;cursor:pointer;font-size:9px;font-weight:900">-DUP</button>
        <button id="phb3-delete-done" style="flex:1;height:26px;border-radius:5px;border:1px solid rgba(251,191,36,.35);background:rgba(251,191,36,.08);color:#fbbf24;cursor:pointer;font-size:9px;font-weight:900">Xoa Done</button>
      </div>
      <div style="display:flex;align-items:center;gap:5px">
        <span style="font-size:10px;font-weight:800;color:#94a3b8;white-space:nowrap">SO ANH REDESIGN:</span>
        <input id="phb3-redesign-count-sticky" title="So anh redesign mac dinh khi chay batch" type="number" min="1" max="30" step="1" value="${redesignCount}" style="width:50px;height:24px;padding:0 5px;background:#020617;border:1px solid rgba(148,163,184,.3);border-radius:5px;color:#e2e8f0;font-size:11px;font-weight:800;outline:none">
        <span style="font-size:9px;color:#64748b">anh/job</span>
      </div>
    `;
    root.appendChild(configDrawer);

    async function updateSsoStatusUI() {
      const ssoEl = root.querySelector('#phb3-sso-status');
      if (!ssoEl) return;
      const licenseData = await chromeStorageGet(['phb_license_token','phb_license_user','phb_license_limit']);
      const token = licenseData?.phb_license_token;
      const user = licenseData?.phb_license_user;
      
      if (token) {
        const uname = user?.username || user?.id || 'Nhân viên';
        ssoEl.style.background = 'rgba(16,185,129,.15)';
        ssoEl.style.borderColor = 'rgba(16,185,129,.4)';
        ssoEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:6px">
            <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981"></span>
            <span style="font-size:10px;font-weight:700;color:#34d399">License đã kích hoạt: ${uname} (${licenseData.phb_license_limit || 1} slots)</span>
          </div>
          <a href="${TOOLS_ORIGIN}/account" target="_blank" style="font-size:9px;color:#38bdf8;text-decoration:none;font-weight:700">Quản lý &nearr;</a>
        `;
      } else {
        ssoEl.style.background = 'rgba(239,68,68,.15)';
        ssoEl.style.borderColor = 'rgba(239,68,68,.4)';
        ssoEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:6px">
            <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#ef4444"></span>
            <span style="font-size:10px;font-weight:700;color:#f87171">Chưa kích hoạt Extension License</span>
          </div>
          <a href="${TOOLS_ORIGIN}/account" target="_blank" style="font-size:10px;padding:2px 6px;border-radius:4px;background:#38bdf8;color:#020617;text-decoration:none;font-weight:800">Lấy key</a>
        `;
      }
    }
    updateSsoStatusUI();
    setInterval(updateSsoStatusUI, 3000);

    // Tabs
    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;border-bottom:1px solid rgba(148,163,184,.15);flex-shrink:0;background:#060d1a';
    tabs.innerHTML = `
      <button data-tab="queue"   class="phb3-tab" style="flex:1;height:32px;border:none;border-bottom:2px solid transparent;background:transparent;color:#94a3b8;cursor:pointer;font-size:11px;font-weight:700">&#128203; Queue</button>
      <button data-tab="manual"  class="phb3-tab" style="flex:1;height:32px;border:none;border-bottom:2px solid transparent;background:transparent;color:#94a3b8;cursor:pointer;font-size:11px;font-weight:700">&#9995; Manual</button>
      <button data-tab="history" class="phb3-tab" style="flex:1;height:32px;border:none;border-bottom:2px solid transparent;background:transparent;color:#94a3b8;cursor:pointer;font-size:11px;font-weight:700">&#128340; History</button>
    `;
    root.appendChild(tabs);
    tabs.querySelector('[data-tab="history"]').insertAdjacentHTML('beforebegin',
      '<button id="phb3-reload-imgs" title="Tai lai toan bo anh GPT tren trang nay va submit len server" style="width:34px;height:32px;border:none;border-bottom:2px solid transparent;background:transparent;color:#38bdf8;cursor:pointer;font-size:13px;font-weight:900">R</button>'
    );

    const bodyWrap = document.createElement('div');
    bodyWrap.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column';
    root.appendChild(bodyWrap);

    // === TAB 1: QUEUE ===
    const queueTab = document.createElement('div');
    queueTab.id = 'phb3-tab-queue';
    queueTab.style.cssText = 'flex:1;overflow-y:auto;display:flex;flex-direction:column;padding:0 10px 8px;gap:7px';
    queueTab.innerHTML = `
      <input id="phb3-imggen" type="hidden">
      <input id="phb3-redesign-count" type="hidden" value="${redesignCount}">
      <div id="phb3-sticky-controls" style="position:sticky;top:0;z-index:5;display:flex;flex-direction:column;gap:5px;background:#08111f;margin:0 -10px;padding:8px 10px 6px;box-shadow:0 12px 20px rgba(2,6,23,.42)">
        <div id="phb3-batch-bar" style="display:flex;gap:5px;align-items:center;padding:6px;background:#0f1a2e;border:1px solid rgba(99,102,241,.3);border-radius:6px">
          <span id="phb3-batch-status" style="font-size:10px;color:#a5b4fc;flex:1">San sang</span>
          <button id="phb3-batch-run" style="height:28px;padding:0 10px;border-radius:5px;border:1px solid rgba(16,185,129,.5);background:rgba(16,185,129,.15);color:#34d399;cursor:pointer;font-size:11px;font-weight:900">&#9654; RUN</button>
          <button id="phb3-batch-stop" style="height:28px;padding:0 8px;border-radius:5px;border:1px solid rgba(239,68,68,.5);background:rgba(239,68,68,.1);color:#f87171;cursor:pointer;font-size:11px;font-weight:900;display:none">&#9632; STOP</button>
        </div>
        <div id="phb3-bulk-bar" style="display:none;align-items:center;gap:4px;padding:5px 6px;background:#0c1a10;border:1px solid rgba(52,211,153,.25);border-radius:6px">
          <label style="display:flex;align-items:center;gap:3px;cursor:pointer;font-size:9px;color:#94a3b8;flex-shrink:0">
            <input id="phb3-sel-page" type="checkbox" style="accent-color:#34d399;width:12px;height:12px"> Trang
          </label>
          <span id="phb3-bulk-count" style="font-size:9px;font-weight:800;color:#34d399;flex:1">0 chon</span>
          <input id="phb3-bulk-count-input" title="So anh redesign cho batch" type="number" min="1" max="30" step="1" value="${redesignCount}" style="width:40px;height:22px;padding:0 3px;background:#020617;border:1px solid rgba(148,163,184,.3);border-radius:4px;color:#e2e8f0;font-size:10px;font-weight:800">
          <button id="phb3-bulk-apply-count" title="Ap dung so anh redesign cho tat ca job da chon" style="height:22px;padding:0 6px;border-radius:4px;border:1px solid rgba(52,211,153,.4);background:rgba(52,211,153,.1);color:#34d399;cursor:pointer;font-size:9px;font-weight:900">Ap dung</button>
          <button id="phb3-bulk-delete" title="Xoa tat ca job da chon" style="height:22px;padding:0 6px;border-radius:4px;border:1px solid rgba(239,68,68,.4);background:rgba(239,68,68,.1);color:#f87171;cursor:pointer;font-size:9px;font-weight:900">Xoa</button>
          <button id="phb3-sel-none" title="Bo chon tat ca" style="height:22px;padding:0 5px;border-radius:4px;border:1px solid rgba(148,163,184,.3);background:#101b2d;color:#64748b;cursor:pointer;font-size:11px">&#x2715;</button>
        </div>
        <div id="phb3-filter-tabs" style="display:flex;gap:4px;align-items:center">
          <button data-filter="pending" class="phb3-filter" style="flex:1;height:25px;border-radius:5px;border:1px solid rgba(148,163,184,.25);background:#101b2d;color:#94a3b8;cursor:pointer;font-size:9px;font-weight:800">Pending</button>
          <button data-filter="failed"  class="phb3-filter" style="flex:1;height:25px;border-radius:5px;border:1px solid rgba(148,163,184,.25);background:#101b2d;color:#94a3b8;cursor:pointer;font-size:9px;font-weight:800">Failed</button>
          <button data-filter="done"    class="phb3-filter" style="flex:1;height:25px;border-radius:5px;border:1px solid rgba(148,163,184,.25);background:#101b2d;color:#94a3b8;cursor:pointer;font-size:9px;font-weight:800">Done</button>
          <button data-filter="all"     class="phb3-filter" style="flex:1;height:25px;border-radius:5px;border:1px solid rgba(148,163,184,.25);background:#101b2d;color:#94a3b8;cursor:pointer;font-size:9px;font-weight:800">All</button>
        </div>
      </div>
      <div id="phb3-pending" style="display:none;padding:8px;background:#071a12;border:1px solid rgba(52,211,153,.25);border-radius:8px"></div>
      <div id="phb3-job-list" style="display:flex;flex-direction:column;gap:6px"></div>
    `;
    bodyWrap.appendChild(queueTab);

    // === TAB 2: MANUAL ===
    const manualTab = document.createElement('div');
    manualTab.id = 'phb3-tab-manual';
    manualTab.style.cssText = 'flex:1;overflow-y:auto;padding:10px;display:none;flex-direction:column;gap:10px';
    manualTab.innerHTML = `
      <div style="background:#0d1929;border:1px solid rgba(56,189,248,.25);border-radius:8px;padding:10px">
        <div style="font-size:11px;font-weight:700;color:#38bdf8;margin-bottom:6px">&#65291; THEM JOB MOI VAO QUEUE</div>
        <label style="font-size:10px;color:#64748b;display:block;margin-bottom:3px">URL anh nguon</label>
        <input id="phb3-add-url" placeholder="https://..." style="height:26px;padding:0 8px;background:#020617;border:1px solid rgba(148,163,184,.25);border-radius:5px;color:#e2e8f0;font-size:10px;outline:none;width:100%;box-sizing:border-box;margin-bottom:5px">
        <label style="font-size:10px;color:#64748b;display:block;margin-bottom:3px">Tieu de san pham</label>
        <input id="phb3-add-title" placeholder="VD: Admit It You'll Low Key Miss Me..." style="height:26px;padding:0 8px;background:#020617;border:1px solid rgba(148,163,184,.25);border-radius:5px;color:#e2e8f0;font-size:10px;outline:none;width:100%;box-sizing:border-box;margin-bottom:5px">
        <button id="phb3-add-submit" style="width:100%;height:28px;border-radius:5px;border:1px solid rgba(56,189,248,.5);background:rgba(56,189,248,.15);color:#38bdf8;cursor:pointer;font-size:10px;font-weight:900">Them vao Queue</button>
      </div>
      <div style="background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:8px;padding:10px">
        <div style="font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:6px">INPUT THU CONG</div>
        <label style="font-size:10px;color:#64748b;display:block;margin-bottom:3px">Anh nguon</label>
        <input id="phb3-file" type="file" accept="image/*" style="width:100%;font-size:10px;color:#e2e8f0;margin-bottom:6px">
        <div id="phb3-fname" style="font-size:9px;color:#fbbf24;margin-bottom:6px;min-height:12px"></div>
        <label style="font-size:10px;color:#64748b;display:block;margin-bottom:3px">Tieu de</label>
        <textarea id="phb3-title" placeholder="VD: Admit It You'll Low Key Miss Me..." style="width:100%;min-height:50px;padding:6px;background:#020617;border:1px solid rgba(148,163,184,.2);border-radius:5px;color:#e2e8f0;font-size:11px;resize:vertical;box-sizing:border-box"></textarea>
        <label style="font-size:10px;color:#64748b;display:block;margin:6px 0 3px">So anh redesign</label>
        <input id="phb3-manual-count" type="number" min="1" max="30" step="1" value="${redesignCount}" style="width:100%;height:28px;padding:0 7px;background:#020617;border:1px solid rgba(148,163,184,.2);border-radius:5px;color:#e2e8f0;font-size:11px;box-sizing:border-box">
        <button id="phb3-run-manual" style="width:100%;height:34px;margin-top:8px;border-radius:6px;border:1px solid rgba(16,185,129,.5);background:rgba(16,185,129,.15);color:#34d399;cursor:pointer;font-size:11px;font-weight:900">&#9654; RUN (TEXT + ANH)</button>
      </div>
    `;
    bodyWrap.appendChild(manualTab);

    // === TAB 3: HISTORY ===
    const histTab = document.createElement('div');
    histTab.id = 'phb3-tab-history';
    histTab.style.cssText = 'flex:1;overflow-y:auto;padding:10px;display:none;flex-direction:column;gap:8px';
    histTab.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:11px;font-weight:700;color:#94a3b8">LICH SU EXPORT</div>
        <button id="phb3-clear-hist" style="height:22px;padding:0 8px;border-radius:4px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.1);color:#f87171;cursor:pointer;font-size:9px;font-weight:700">Xoa het</button>
      </div>
      <input id="phb3-hist-search" type="search" placeholder="Tim title, assetId, Etsy/AMZ..." value="${historyFilter.replace(/"/g, '&quot;')}" style="width:100%;height:28px;padding:0 8px;background:#020617;border:1px solid rgba(148,163,184,.22);border-radius:5px;color:#e2e8f0;font-size:10px;box-sizing:border-box">
      <div id="phb3-batches" style="display:flex;flex-direction:column;gap:5px"></div>
    `;
    bodyWrap.appendChild(histTab);

    // === LOG ===
    const logBox = document.createElement('div');
    logBox.style.cssText = 'border-top:1px solid rgba(148,163,184,.15);padding:6px 10px;background:#060d1a;flex-shrink:0';
    logBox.innerHTML = `<div style="font-size:9px;font-weight:700;color:#64748b;margin-bottom:3px">LOG</div>`;
    const logArea = document.createElement('div');
    logArea.id = 'phb3-log';
    logArea.style.cssText = 'background:#020617;border:1px solid rgba(148,163,184,.12);border-radius:5px;padding:5px 7px;height:95px;overflow-y:auto';
    logBox.appendChild(logArea);
    root.appendChild(logBox);

    document.body.appendChild(root);
    const syncSharedPanel = () => {
      const active = document.documentElement.getAttribute('data-podhub-active-panel');
      root.style.display = active === 'bridge' ? 'flex' : 'none';
      if (launcherBtn) {
        launcherBtn.style.opacity = active === 'bridge' ? '1' : '.72';
        launcherBtn.style.boxShadow = active === 'bridge' ? '-4px 6px 18px rgba(20,184,166,.5)' : '-4px 6px 18px rgba(0,0,0,.35)';
      }
    };
    document.addEventListener('podhub-panel-switch', syncSharedPanel);
    syncSharedPanel();

    logEl = logArea;
    jobListEl = root.querySelector('#phb3-job-list');
    batchesEl = root.querySelector('#phb3-batches');
    pendingEl = root.querySelector('#phb3-pending');

    // ============ EVENTS ============
    // Config drawer toggle
    root.querySelector('#phb3-cfg-toggle').onclick = () => {
      const drawer = root.querySelector('#phb3-config-drawer');
      const open = drawer.style.display === 'flex';
      drawer.style.display = open ? 'none' : 'flex';
      root.querySelector('#phb3-cfg-toggle').style.color = open ? '#94a3b8' : '#34d399';
      root.querySelector('#phb3-cfg-toggle').style.borderColor = open ? 'rgba(148,163,184,.3)' : 'rgba(52,211,153,.5)';
    };

    root.querySelector('#phb3-runner-save').onclick = async () => {
      runnerId = setRunnerId(root.querySelector('#phb3-runner-input').value);
      root.querySelector('#phb3-runner-input').value = runnerId;
      log('Runner -> ' + runnerId);
      await reloadJobs();
    };
    root.querySelector('#phb3-scan').onclick = async () => {
      const btn = root.querySelector('#phb3-scan');
      if (btn) { btn.style.opacity = '0.5'; }
      try { await capturePageAll(); } catch(e) { log('Loi tai lai: ' + e.message); }
      finally { if (btn) btn.style.opacity = '1'; }
    };
    root.querySelector('#phb3-cl').onclick = () => {
      document.documentElement.setAttribute('data-podhub-active-panel', '');
      document.dispatchEvent(new Event('podhub-panel-switch'));
    };
    root.querySelector('#phb3-rf').onclick = () => reloadJobs();
    root.querySelector('#phb3-check-dup').onclick = async () => {
      await checkQueueDuplicates(false);
      showToast('Check dup xong', '#38bdf8');
    };
    root.querySelector('#phb3-delete-dup').onclick = async () => {
      if (!confirm('Xoa cac job trung trong queue? Se giu ban moi/uu tien nhat.')) return;
      await checkQueueDuplicates(true);
      showToast('Da xoa dup queue', '#10b981');
    };
    root.querySelector('#phb3-delete-done').onclick = async () => {
      const doneStatuses = new Set(['done','raw_design_done','raw_design_partial',
        'design_generated','gpt_json_validated','gpt_result_post_failed']);
      const doneJobs = allJobs.filter(j => doneStatuses.has(j.status) && !isJobLockedByOther(j));
      if (!doneJobs.length) { showToast('Khong co job Done de xoa', '#f59e0b'); return; }
      if (!confirm('Xoa ' + doneJobs.length + ' job co trang thai Done/Partial?')) return;
      let ok = 0;
      for (const job of doneJobs) {
        try {
          await apiDelFrom(getOrigin(job), '/jobs/' + encodeURIComponent(job.id));
          selectedJobs.delete(job._key);
          ok++;
        } catch(e) { log('Xoa done job fail: ' + e.message); }
      }
      showToast('Da xoa ' + ok + ' job done', '#10b981');
      await reloadJobs();
    };
    root.querySelector('#phb3-reload-imgs').onclick = async () => {
      const btn = root.querySelector('#phb3-reload-imgs');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '...';
      btn.style.opacity = '0.55';
      try {
        const progress = await reloadCurrentPageImagesToServer();
        showToast('Da submit lai anh ' + progress.designs_done + '/' + progress.styles_total, '#10b981');
        log('Reload anh submit server OK: ' + progress.designs_done + '/' + progress.styles_total);
        await reloadJobs();
      } catch(e) {
        log('Reload anh FAIL: ' + e.message);
        showToast('Reload anh FAIL: ' + e.message, '#ef4444');
      } finally {
        btn.disabled = false;
        btn.textContent = 'R';
        btn.style.opacity = '1';
      }
    };

    root.querySelectorAll('.phb3-tab').forEach(btn => {
      btn.onclick = () => {
        const t = btn.getAttribute('data-tab');
        currentTab = t;
        root.querySelectorAll('.phb3-tab').forEach(b => {
          const active = b.getAttribute('data-tab') === t;
          b.style.color = active ? '#34d399' : '#94a3b8';
          b.style.borderBottomColor = active ? '#34d399' : 'transparent';
        });
        root.querySelector('#phb3-tab-queue').style.display   = t === 'queue'   ? 'flex' : 'none';
        root.querySelector('#phb3-tab-manual').style.display  = t === 'manual'  ? 'flex' : 'none';
        root.querySelector('#phb3-tab-history').style.display = t === 'history' ? 'flex' : 'none';
      };
    });
    root.querySelectorAll('.phb3-filter').forEach(btn => {
      btn.onclick = () => {
        queueFilter = btn.getAttribute('data-filter') || 'pending';
        currentPage = 0;
        localStorage.setItem('phb_v3_queue_filter', queueFilter);
        renderJobs();
        updateSubtitle();
      };
    });
    root.querySelector('.phb3-tab[data-tab="queue"]').click();

    // Bulk bar: clear selection
    root.querySelector('#phb3-sel-none').onclick = async () => {
      await releaseSelectedQueueJobs('clear_selection');
      renderJobs(); updateSubtitle();
    };

    // Bulk bar: select all on current page
    root.querySelector('#phb3-sel-page').onchange = (e) => {
      const visibleJobs = getVisibleJobs();
      const start = currentPage * PAGE_SIZE;
      const pageJobs = visibleJobs.slice(start, start + PAGE_SIZE);
      if (e.target.checked) {
        pageJobs.filter(j => !isJobLockedByOther(j)).forEach(j => selectedJobs.add(j._key));
      } else {
        pageJobs.forEach(j => selectedJobs.delete(j._key));
      }
      renderJobs(); updateSubtitle();
    };

    // Bulk bar: apply redesign count to selected jobs
    root.querySelector('#phb3-bulk-apply-count').onclick = async () => {
      const n = Math.max(1, Math.min(30, Number(root.querySelector('#phb3-bulk-count-input')?.value || redesignCount)));
      if (!selectedJobs.size) { showToast('Chua chon job nao', '#ef4444'); return; }
      const jobs = allJobs.filter(j => selectedJobs.has(j._key));
      let ok = 0;
      for (const job of jobs) {
        try {
          await apiPatchFrom(getOrigin(job), '/jobs/' + encodeURIComponent(job.id), { redesign_count: n });
          ok++;
        } catch(e) { log('Cap nhat job fail: ' + e.message); }
      }
      showToast('Da cap nhat ' + ok + '/' + jobs.length + ' job → ' + n + ' anh', '#10b981');
      await reloadJobs();
    };

    // Bulk bar: delete selected jobs
    root.querySelector('#phb3-bulk-delete').onclick = async () => {
      if (!selectedJobs.size) return;
      if (!confirm('Xoa ' + selectedJobs.size + ' job da chon?')) return;
      const jobs = allJobs.filter(j => selectedJobs.has(j._key));
      let ok = 0;
      for (const job of jobs) {
        try {
          await unselectQueueJob(job, 'delete');
          await apiDelFrom(getOrigin(job), '/jobs/' + encodeURIComponent(job.id));
          ok++;
        } catch(e) { log('Xoa job fail: ' + e.message); }
      }
      selectedJobs.clear();
      showToast('Da xoa ' + ok + ' job', '#10b981');
      await reloadJobs();
    };
    root.querySelector('#phb3-batch-run').onclick = () => {
      setRedesignCount(root.querySelector('#phb3-redesign-count-sticky')?.value || root.querySelector('#phb3-redesign-count')?.value || redesignCount);
      // Mo rong runnable: cho phep chay lai ca job da done/partial
      const runnable = new Set(['queued', 'failed', 'done', 'raw_design_done',
        'raw_design_partial', 'design_generated', 'design_generating',
        'gpt_json_validated', 'gpt_result_saved', 'gpt_result_post_failed']);
      const ids = [...selectedJobs].filter(id => {
        const job = allJobs.find(j => j._key === id || j.id === id);
        return job && !isJobLockedByOther(job) && runnable.has(job.status);
      });
      if (!ids.length) { showToast('Chua chon job nao co the chay', '#ef4444'); return; }
      startBatch(ids);
    };
    root.querySelector('#phb3-batch-stop').onclick = () => stopBatch();

    // Activate the Tools PodHub extension license.
    root.querySelector('#phb3-license-activate').onclick = async () => {
      const input = root.querySelector('#phb3-license-input');
      const licenseKey = (input?.value || '').trim();
      if (!licenseKey) { showToast('Vui long nhap Extension License Key', '#ef4444'); return; }
      const button = root.querySelector('#phb3-license-activate');
      button.disabled = true; button.textContent = 'DANG...';
      try {
        await activateLicense(licenseKey);
        input.value = '';
        await getActiveGptUrl();
        log('Extension License da kich hoat thanh cong.');
        showToast('Kich hoat license thanh cong!', '#10b981');
        await updateSsoStatusUI();
      } catch (error) {
        log('Kich hoat license that bai: ' + error.message);
        showToast(error.message || 'Kich hoat that bai', '#ef4444');
      } finally {
        button.disabled = false; button.textContent = 'KICH HOAT';
      }
    };

    root.querySelector('#phb3-add-submit').onclick = async () => {
      const urlInput = root.querySelector('#phb3-add-url');
      const titleInput = root.querySelector('#phb3-add-title');
      const imageUrl = (urlInput?.value || '').trim();
      const title = (titleInput?.value || '').trim();
      if (!imageUrl && !title) { showToast('Can it nhat URL hoac title!', '#ef4444'); return; }
      const btn = root.querySelector('#phb3-add-submit');
      btn.disabled = true; btn.textContent = 'Dang them...';
      try {
        await apiPost('/jobs', {
          source: 'manual-add',
          images: [{
            url: imageUrl || '',
            sourceImageUrl: imageUrl || '',
            title: title || '',
            prompt: title || '',
            assetId: String(Date.now())
          }]
        });
        log('Da them job: ' + (title || imageUrl));
        showToast('Da them job!', '#10b981');
        if (urlInput) urlInput.value = '';
        if (titleInput) titleInput.value = '';
        const wrap = root.querySelector('#phb3-add-job-wrap');
        if (wrap) wrap.removeAttribute('open');
        await reloadJobs();
      } catch(e) {
        log('Them job that bai: ' + e.message);
        showToast('Loi: ' + e.message, '#ef4444');
      } finally {
        btn.disabled = false; btn.textContent = 'Them vao Queue';
      }
    };

    // Toggle Image Gen
    const imgGenCB = root.querySelector('#phb3-imggen');
    if (imgGenCB) imgGenCB.checked = true;

    function setRedesignCount(raw) {
      const n = Number(raw || 8);
      redesignCount = Math.max(1, Math.min(30, Number.isFinite(n) ? Math.round(n) : 8));
      localStorage.setItem('phb_v3_redesign_count', String(redesignCount));
      const q = root.querySelector('#phb3-redesign-count');
      const qs = root.querySelector('#phb3-redesign-count-sticky');
      const m = root.querySelector('#phb3-manual-count');
      if (q && Number(q.value) !== redesignCount) q.value = String(redesignCount);
      if (qs && Number(qs.value) !== redesignCount) qs.value = String(redesignCount);
      if (m && Number(m.value) !== redesignCount) m.value = String(redesignCount);
      log('So anh redesign: ' + redesignCount);
    }
    root.querySelector('#phb3-redesign-count').onchange = (e) => setRedesignCount(e.target.value);
    root.querySelector('#phb3-redesign-count-sticky').onchange = (e) => setRedesignCount(e.target.value);
    root.querySelector('#phb3-manual-count').onchange = (e) => setRedesignCount(e.target.value);

    const fileInput = root.querySelector('#phb3-file');
    const fnameEl = root.querySelector('#phb3-fname');
    fileInput.onchange = (e) => {
      const f = e.target.files[0];
      if (f) {
        manualImageFile = f;
        fnameEl.textContent = 'OK ' + f.name + ' (' + (f.size/1024).toFixed(0) + 'KB)';
      } else { manualImageFile = null; fnameEl.textContent = ''; }
    };
    root.querySelector('#phb3-title').oninput = (e) => { manualTitle = e.target.value.trim(); };

    root.querySelector('#phb3-run-manual').onclick = async () => {
      if (batchRunning) { showToast('Batch dang chay!', '#f59e0b'); return; }
      if (!manualImageFile && !manualTitle) { showToast('Can it nhat anh hoac title!', '#ef4444'); return; }
      setRedesignCount(root.querySelector('#phb3-manual-count')?.value || redesignCount);
      const btn = root.querySelector('#phb3-run-manual');
      batchQueue = ['manual'];
      batchIdx = 0;
      batchRunning = true;
      taskStopRequested = false;
      taskRunVersion++;
      updateBatchUI();
      btn.disabled = true; btn.textContent = 'DANG CHAY...'; btn.style.opacity = '0.6';
      try {
        // Phase A: Text
        const batch = await processStylePlanBatch(manualImageFile, manualTitle, redesignCount, null);

        // Phase B: Anh (neu bat)
        if (imageGenEnabled) {
          btn.textContent = 'DANG TAO ANH...';
          await processImagePhase(batch);
        }

        // Phase C: Export 1 file JSON
        const file = await exportOneFile(batch, true);
        log('=== XONG! Tai file ' + file.filename + ' ===');
        showToast('Done!', '#10b981');
        addBatch({
          id: 'b_' + Date.now(),
          title: batch.meta.source_title || manualTitle || 'Manual',
          image_filename: batch.meta.image_filename,
          exported_at: batch.meta.exported_at,
          files: filesFromExport(file),
          batch: batch
        });
        renderBatches();
      } catch(e) {
        log('LOI: ' + e.message);
        showToast('Loi: ' + e.message, '#ef4444');
      } finally {
        batchRunning = false;
        taskStopRequested = false;
        updateBatchUI();
        btn.disabled = false; btn.textContent = 'RUN (TEXT + ANH)'; btn.style.opacity = '1';
      }
    };

    root.querySelector('#phb3-clear-hist').onclick = () => {
      if (!confirm('Xoa toan bo lich su?')) return;
      saveBatches([]); renderBatches();
    };
    const histSearch = root.querySelector('#phb3-hist-search');
    histSearch.oninput = e => {
      historyFilter = e.target.value || '';
      localStorage.setItem('phb_v3_history_filter', historyFilter);
      renderBatches();
    };

    renderBatches();
    updateBatchUI();
    [1000, 3000, 8000].forEach(t => setTimeout(() => {
      const open = root.style.display === 'flex';
      root.setAttribute('style', RC.replace('display:none', 'display:' + (open ? 'flex' : 'none')));
    }, t));
    ensureLauncher();
  }

  function renderJobs() {
    if (!jobListEl) return;
    jobListEl.innerHTML = '';
    updateQueueFilterUI();
    const visibleJobs = getVisibleJobs();

    // Update bulk bar
    const bulkBar = document.getElementById('phb3-bulk-bar');
    const bulkCount = document.getElementById('phb3-bulk-count');
    if (bulkBar) {
      bulkBar.style.display = selectedJobs.size > 0 ? 'flex' : 'none';
      if (bulkCount) bulkCount.textContent = selectedJobs.size + ' chon';
    }
    // Sync bulk redesign count with sticky input
    const bulkCountInput = document.getElementById('phb3-bulk-count-input');
    const stickyCount = document.getElementById('phb3-redesign-count-sticky');
    if (bulkCountInput && stickyCount && bulkCountInput !== document.activeElement) {
      bulkCountInput.value = stickyCount.value;
    }

    if (!visibleJobs.length) {
      const e = document.createElement('div');
      e.style.cssText = 'color:#64748b;font-size:11px;text-align:center;padding:24px';
      e.textContent = 'Khong co job. Bam reload de tai lai.';
      jobListEl.appendChild(e);
      return;
    }

    // Pagination
    const totalPages = Math.max(1, Math.ceil(visibleJobs.length / PAGE_SIZE));
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    const start = currentPage * PAGE_SIZE;
    const pageJobs = visibleJobs.slice(start, start + PAGE_SIZE);

    // Page nav (only if >1 page)
    if (totalPages > 1) {
      const nav = document.createElement('div');
      nav.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0';
      const prev = document.createElement('button');
      prev.textContent = '◀';
      prev.disabled = currentPage === 0;
      prev.style.cssText = 'height:24px;padding:0 8px;border-radius:4px;border:1px solid rgba(148,163,184,.3);background:#101b2d;color:#94a3b8;cursor:pointer;font-size:11px;opacity:' + (currentPage === 0 ? '.4' : '1');
      prev.onclick = () => { currentPage--; renderJobs(); };
      const next = document.createElement('button');
      next.textContent = '▶';
      next.disabled = currentPage >= totalPages - 1;
      next.style.cssText = 'height:24px;padding:0 8px;border-radius:4px;border:1px solid rgba(148,163,184,.3);background:#101b2d;color:#94a3b8;cursor:pointer;font-size:11px;opacity:' + (currentPage >= totalPages - 1 ? '.4' : '1');
      next.onclick = () => { currentPage++; renderJobs(); };
      const info = document.createElement('span');
      info.style.cssText = 'flex:1;text-align:center;font-size:10px;color:#64748b';
      info.textContent = 'Trang ' + (currentPage + 1) + '/' + totalPages + ' · ' + visibleJobs.length + ' job';
      nav.appendChild(prev); nav.appendChild(info); nav.appendChild(next);
      jobListEl.appendChild(nav);

      // Update sel-page checkbox state
      const selPage = document.getElementById('phb3-sel-page');
      if (selPage) {
        const allPageSelected = pageJobs.filter(j => !isJobLockedByOther(j)).every(j => selectedJobs.has(j._key));
        selPage.checked = allPageSelected && pageJobs.length > 0;
        selPage.indeterminate = !allPageSelected && pageJobs.some(j => selectedJobs.has(j._key));
      }
    }

    pageJobs.forEach(job => {
      const card = document.createElement('div');
      card.style.cssText = 'background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:8px;padding:7px;display:flex;gap:7px;align-items:center';
      const lockedByOther = isJobLockedByOther(job);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !lockedByOther && selectedJobs.has(job._key);
      cb.disabled = lockedByOther;
      cb.title = lockedByOther ? ('Dang duoc runner khac giu: ' + job.runner_id) : 'Chon job';
      cb.style.cssText = 'width:14px;height:14px;cursor:' + (lockedByOther ? 'not-allowed' : 'pointer') + ';accent-color:#34d399;flex-shrink:0';
      cb.onchange = () => {
        if (cb.checked) selectedJobs.add(job._key);
        else selectedJobs.delete(job._key);
        renderJobs();
        updateSubtitle();
      };
      card.appendChild(cb);

      const srcUrl = job.sourceImageUrl?.startsWith('/data/') ? getOrigin(job) + job.sourceImageUrl : (job.sourceImageUrl || '');
      if (srcUrl) {
        const img = document.createElement('img');
        img.src = srcUrl;
        img.style.cssText = 'width:42px;height:42px;object-fit:cover;border-radius:5px;flex-shrink:0;cursor:pointer;background:#020617';
        img.onclick = () => window.open(srcUrl, '_blank');
        card.appendChild(img);
      }

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      const idDiv = document.createElement('div');
      const rawAssetId = job.assetId || job.id.slice(0,8);
      idDiv.textContent = formatAssetIdLabel(rawAssetId);
      idDiv.title = rawAssetId;
      idDiv.style.cssText = 'font-size:10px;font-weight:800;color:#e2e8f0;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      info.appendChild(idDiv);

      if (job.title || job.prompt) {
        const ttl = document.createElement('div');
        ttl.textContent = (job.title || job.prompt || '').slice(0, 70);
        ttl.title = job.title || job.prompt;
        ttl.style.cssText = 'font-size:9px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px';
        info.appendChild(ttl);
      }

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:4px;align-items:center;margin-top:3px';
      const st = document.createElement('span');
      st.textContent = job.status.toUpperCase();
      st.style.cssText = 'font-size:8px;font-weight:900;padding:1px 5px;border-radius:999px;background:' + statusColor(job.status) + '22;color:' + statusColor(job.status);
      row.appendChild(st);
      const pgText = getJobProgressText(job);
      if (pgText) {
        const pg = document.createElement('span');
        pg.textContent = pgText;
        pg.style.cssText = 'font-size:8px;font-weight:800;padding:1px 5px;border-radius:999px;background:rgba(14,165,233,.12);color:#38bdf8';
        row.appendChild(pg);
      }
      if ((job._mirrorKeys || []).length > 1) {
        const dup = document.createElement('span');
        dup.textContent = 'dup x' + (job._mirrorKeys || []).length;
        dup.title = 'Da gop: ' + (job._mirrorServers || []).join(', ');
        dup.style.cssText = 'font-size:8px;font-weight:900;padding:1px 5px;border-radius:999px;background:rgba(251,191,36,.14);color:#fbbf24';
        row.appendChild(dup);
      }
      if (job.runner_id) {
        const rn = document.createElement('span');
        rn.textContent = job.runner_id === runnerId ? 'mine' : 'locked';
        rn.title = 'Runner: ' + job.runner_id;
        rn.style.cssText = 'font-size:8px;font-weight:900;padding:1px 5px;border-radius:999px;background:' + (lockedByOther ? 'rgba(239,68,68,.14)' : 'rgba(168,85,247,.14)') + ';color:' + (lockedByOther ? '#f87171' : '#c084fc');
        row.appendChild(rn);
      }
      info.appendChild(row);
      card.appendChild(info);

      const totalForContinue = Number(job?.progress?.styles_total || 0);
      const doneForContinue = Number(job?.progress?.designs_done || job?.progress?.raw_design_done || job?.progress?.raw_design_saved || 0);
      const canContinueStatus = new Set(['failed', 'raw_design_partial', 'design_generated', 'design_generating', 'gpt_result_post_failed', 'gpt_json_validated']);
      const canContinue = canContinueStatus.has(job.status) || (totalForContinue > 0 && doneForContinue < totalForContinue);
      if (canContinue) {
        const cont = document.createElement('button');
        cont.textContent = '▶';
        cont.title = 'Tiep tuc job: quet checkpoint/history va tao tiep cac anh con thieu';
        cont.disabled = lockedByOther;
        if (lockedByOther) cont.title = 'Job dang duoc runner khac giu: ' + job.runner_id;
        cont.style.cssText = 'width:26px;height:26px;border-radius:4px;border:1px solid rgba(20,184,166,.45);background:rgba(20,184,166,.12);color:#2dd4bf;cursor:' + (lockedByOther ? 'not-allowed' : 'pointer') + ';font-size:12px;font-weight:900;flex-shrink:0;opacity:' + (lockedByOther ? '.45' : '1');
        cont.onclick = async () => {
          if (lockedByOther) { showToast('Job dang bi runner khac giu', '#ef4444'); return; }
          if (batchRunning) { showToast('Batch dang chay!', '#f59e0b'); return; }
          cont.disabled = true; cont.textContent = '...';
          try {
            await selectQueueJob(job);
            await continueJobImages(job);
            await reloadJobs();
            showToast('Continue job xong', '#10b981');
          } catch(e) {
            log('Continue job fail: ' + e.message);
            showToast('Continue fail: ' + e.message, '#ef4444');
          } finally { cont.disabled = false; cont.textContent = '▶'; }
        };
        card.appendChild(cont);
      }

      // Edit button — opens inline edit form below card
      const editBtn = document.createElement('button');
      editBtn.textContent = '✎';
      editBtn.title = 'Sua title va so anh redesign';
      editBtn.style.cssText = 'width:26px;height:26px;border-radius:4px;border:1px solid rgba(251,191,36,.35);background:rgba(251,191,36,.08);color:#fbbf24;cursor:pointer;font-size:13px;flex-shrink:0';
      card.appendChild(editBtn);

      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Xoa khoi queue';
      del.disabled = lockedByOther;
      if (lockedByOther) del.title = 'Khong the xoa job dang duoc runner khac giu';
      del.style.cssText = 'width:26px;height:26px;border-radius:4px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.1);color:#f87171;cursor:' + (lockedByOther ? 'not-allowed' : 'pointer') + ';font-size:13px;font-weight:900;flex-shrink:0;opacity:' + (lockedByOther ? '.45' : '1');
      del.onclick = async () => {
        if (lockedByOther) return;
        if (!confirm('Xoa job "' + (job.title || job.assetId || job.id).slice(0,40) + '"?')) return;
        await unselectQueueJob(job, 'delete');
        try { await apiDelFrom(getOrigin(job), '/jobs/' + encodeURIComponent(job.id)); } catch(e) {}
        selectedJobs.delete(job._key);
        allJobs = allJobs.filter(j => j._key !== job._key);
        renderJobs(); updateSubtitle();
      };
      card.appendChild(del);

      // Inline edit form (hidden by default, toggled by editBtn)
      const editForm = document.createElement('div');
      editForm.style.cssText = 'display:none;grid-column:1/-1;padding:6px;background:#0a1628;border-top:1px solid rgba(251,191,36,.2);border-radius:0 0 6px 6px;display:none;flex-direction:column;gap:5px;margin:-7px -7px -7px;margin-top:5px';
      editForm.innerHTML = `
        <input class="phb-edit-title" value="${(job.title || job.prompt || '').replace(/"/g,'&quot;')}" placeholder="Tieu de" style="height:24px;padding:0 7px;background:#020617;border:1px solid rgba(148,163,184,.3);border-radius:4px;color:#e2e8f0;font-size:10px;outline:none">
        <div style="display:flex;gap:5px;align-items:center">
          <span style="font-size:10px;color:#94a3b8;flex:1">So anh redesign:</span>
          <input class="phb-edit-count" type="number" min="1" max="30" value="${job.redesign_count || redesignCount}" style="width:52px;height:24px;padding:0 5px;background:#020617;border:1px solid rgba(148,163,184,.3);border-radius:4px;color:#e2e8f0;font-size:11px;font-weight:800">
        </div>
        <div style="display:flex;gap:5px">
          <button class="phb-edit-save" style="flex:1;height:24px;border-radius:4px;border:1px solid rgba(16,185,129,.5);background:rgba(16,185,129,.15);color:#34d399;cursor:pointer;font-size:9px;font-weight:900">LUU</button>
          <button class="phb-edit-cancel" style="flex:1;height:24px;border-radius:4px;border:1px solid rgba(148,163,184,.3);background:#101b2d;color:#94a3b8;cursor:pointer;font-size:9px;font-weight:700">HUY</button>
        </div>
      `;
      card.appendChild(editForm);
      card.style.flexWrap = 'wrap';

      editBtn.onclick = () => {
        const open = editForm.style.display === 'flex';
        editForm.style.display = open ? 'none' : 'flex';
        editForm.style.flexDirection = 'column';
        editBtn.style.background = open ? 'rgba(251,191,36,.08)' : 'rgba(251,191,36,.25)';
      };
      editForm.querySelector('.phb-edit-cancel').onclick = () => {
        editForm.style.display = 'none';
        editBtn.style.background = 'rgba(251,191,36,.08)';
      };
      editForm.querySelector('.phb-edit-save').onclick = async () => {
        const saveBtn = editForm.querySelector('.phb-edit-save');
        const newTitle = (editForm.querySelector('.phb-edit-title')?.value || '').trim();
        const newCount = Math.max(1, Math.min(30, Number(editForm.querySelector('.phb-edit-count')?.value || redesignCount)));
        saveBtn.disabled = true; saveBtn.textContent = '...';
        try {
          await requestJson(getQueueApi(getOrigin(job)) + '/jobs/' + encodeURIComponent(job.id), {
            method: 'PATCH',
            headers: jsonHeaders,
            body: JSON.stringify({ title: newTitle, redesign_count: newCount, prompt: newTitle })
          });
          log('Da sua job: ' + newTitle);
          showToast('Da luu!', '#10b981');
          editForm.style.display = 'none';
          editBtn.style.background = 'rgba(251,191,36,.08)';
          await reloadJobs();
        } catch(e) {
          log('Sua job that bai: ' + e.message);
          showToast('Loi: ' + e.message, '#ef4444');
        } finally { saveBtn.disabled = false; saveBtn.textContent = 'LUU'; }
      };

      jobListEl.appendChild(card);
    });
  }

  function updateBatchUI() {
    const statusEl = document.getElementById('phb3-batch-status');
    const runBtn = document.getElementById('phb3-batch-run');
    const stopBtn = document.getElementById('phb3-batch-stop');
    const floatingStopBtn = document.getElementById('phb3-floating-stop');
    if (!statusEl) return;
    if (batchRunning) {
      statusEl.textContent = `Dang chay: ${batchIdx+1}/${batchQueue.length}`;
      statusEl.style.color = '#fbbf24';
      runBtn.style.display = 'none';
      stopBtn.style.display = 'inline-block';
      if (floatingStopBtn) floatingStopBtn.style.display = 'block';
    } else {
      statusEl.textContent = selectedJobs.size ? `Da chon ${selectedJobs.size} job` : 'San sang';
      statusEl.style.color = '#a5b4fc';
      runBtn.style.display = 'inline-block';
      stopBtn.style.display = 'none';
      if (floatingStopBtn) floatingStopBtn.style.display = 'none';
    }
  }

  function showJsonViewer(title, data) {
    const old = document.getElementById('phb-json-viewer');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'phb-json-viewer';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(2,6,23,.72);display:flex;align-items:center;justify-content:center;padding:18px;font-family:Inter,system-ui,Arial,sans-serif';
    const text = JSON.stringify(data || {}, null, 2);
    wrap.innerHTML = `
      <div style="width:min(920px,96vw);height:min(780px,92vh);background:#0f172a;border:1px solid rgba(148,163,184,.28);border-radius:10px;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.5);overflow:hidden">
        <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(148,163,184,.18);background:#111c31">
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:900;color:#e2e8f0">JSON tong</div>
            <div style="font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${String(title || '').replace(/</g, '&lt;')}</div>
          </div>
          <button id="phb-json-copy" style="height:30px;padding:0 12px;border-radius:6px;border:1px solid rgba(52,211,153,.5);background:rgba(16,185,129,.15);color:#34d399;cursor:pointer;font-size:12px;font-weight:900">Copy</button>
          <button id="phb-json-close" style="height:30px;width:34px;border-radius:6px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.1);color:#f87171;cursor:pointer;font-size:14px;font-weight:900">x</button>
        </div>
        <textarea id="phb-json-text" spellcheck="false" style="flex:1;width:100%;box-sizing:border-box;border:0;outline:none;resize:none;background:#020617;color:#dbeafe;padding:14px;font-family:Consolas,monospace;font-size:12px;line-height:1.45">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</textarea>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelector('#phb-json-close').onclick = () => wrap.remove();
    wrap.onclick = e => { if (e.target === wrap) wrap.remove(); };
    wrap.querySelector('#phb-json-copy').onclick = async () => {
      const val = wrap.querySelector('#phb-json-text')?.value || text;
      try {
        await navigator.clipboard.writeText(val);
        showToast('Da copy JSON', '#10b981');
      } catch(e) {
        const ta = wrap.querySelector('#phb-json-text');
        ta?.focus();
        ta?.select();
        document.execCommand('copy');
        showToast('Da copy JSON', '#10b981');
      }
    };
  }

  function renderBatches() {
    if (!batchesEl) return;
    batchesEl.innerHTML = '';
    const q = String(historyFilter || '').trim().toLowerCase();
    const arr = loadBatches().reverse().filter(item => {
      if (!q) return true;
      const haystack = [
        item.title,
        item.asset_id,
        item.id,
        item.batch?.meta?.source_title,
        item.batch?.meta?.product_id,
        item.batch?.meta?.job_id
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
    if (!arr.length) {
      const e = document.createElement('div');
      e.style.cssText = 'color:#64748b;font-size:10px;text-align:center;padding:12px';
      e.textContent = q ? 'Khong tim thay batch phu hop' : 'Chua co batch nao';
      batchesEl.appendChild(e);
      return;
    }
    arr.forEach(item => {
      const card = document.createElement('div');
      card.style.cssText = 'background:#0f172a;border:1px solid rgba(148,163,184,.15);border-radius:6px;padding:6px 8px';
      const ttl = document.createElement('div');
      ttl.style.cssText = 'font-size:10px;font-weight:700;color:#e2e8f0;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      ttl.textContent = item.title; ttl.title = item.title;
      card.appendChild(ttl);
      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:9px;color:#64748b;margin-bottom:5px';
      const ts = item.exported_at ? new Date(item.exported_at).toLocaleString('vi') : '?';
      const imgCount = (item.batch?.styles || []).filter(s => s.image_url || s.image_data_url || s.raw_design_url || s.raw_design_asset_id).length;
      const totalStyles = (item.batch?.styles || []).length;
      const imgInfo = totalStyles ? ` - ${imgCount}/${totalStyles} anh` : '';
      meta.textContent = ts + imgInfo + (item.asset_id ? ' - ' + item.asset_id : '');
      card.appendChild(meta);

      // Row 1: Download buttons
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:4px;margin-bottom:4px';

      // Tai file JSON tong (chinh)
      const dl1 = document.createElement('button');
      dl1.textContent = 'JSON tong';
      dl1.title = 'Xem JSON tong va copy';
      dl1.style.cssText = 'flex:1;height:22px;border-radius:4px;border:1px solid rgba(16,185,129,.5);background:rgba(6,78,59,.5);color:#34d399;cursor:pointer;font-size:9px;font-weight:700';
      dl1.onclick = () => {
        showJsonViewer(item.title || 'JSON tong', item.batch || {});
      };
      btnRow.appendChild(dl1);

      // Tai file JSON listing rieng theo style
      const dl6 = document.createElement('button');
      dl6.textContent = 'Style JSON';
      dl6.title = 'Tai JSON listing rieng, moi file 1 style';
      dl6.style.cssText = 'flex:1;height:22px;border-radius:4px;border:1px solid rgba(99,102,241,.5);background:rgba(30,27,75,.7);color:#a5b4fc;cursor:pointer;font-size:9px;font-weight:700';
      dl6.onclick = async () => {
        if (!item.batch) return;
        const files = await exportSixFiles(item.batch, true);
        showToast('Tai ' + files.length + ' file', '#10b981');
      };
      btnRow.appendChild(dl6);

      const del = document.createElement('button');
      del.textContent = 'x';
      del.style.cssText = 'width:22px;height:22px;border-radius:4px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.1);color:#f87171;cursor:pointer;font-size:11px;font-weight:900';
      del.onclick = () => { saveBatches(loadBatches().filter(x => x.id !== item.id)); renderBatches(); };
      btnRow.appendChild(del);
      card.appendChild(btnRow);

      // Row 2: Re-format buttons
      const actionRow = document.createElement('div');
      actionRow.style.cssText = 'display:flex;gap:4px';

      // Re-post: normalize + re-POST len server (khong can GPT)
      const repost = document.createElement('button');
      repost.textContent = 'Re-post';
      repost.title = 'Re-normalize batch va POST lai len server (khong can GPT, giu nguyen anh)';
      repost.style.cssText = 'flex:1;height:22px;border-radius:4px;border:1px solid rgba(14,165,233,.5);background:rgba(14,165,233,.1);color:#38bdf8;cursor:pointer;font-size:9px;font-weight:700';
      repost.onclick = async () => {
        repost.disabled = true;
        repost.textContent = '...';
        try {
          await repostHistoryBatch(item);
        } catch(e) {
          log('Re-post fail: ' + e.message);
          showToast('Re-post fail: ' + e.message, '#ef4444');
        } finally {
          repost.disabled = false;
          repost.textContent = 'Re-post';
        }
      };
      actionRow.appendChild(repost);

      // R Json: day lai toan bo JSON ve server dang chon, khong goi GPT
      const reGpt = document.createElement('button');
      reGpt.textContent = 'R Json';
      reGpt.title = 'Day lai toan bo JSON batch ve server dang chon, khong upload lai anh';
      reGpt.style.cssText = 'flex:1;height:22px;border-radius:4px;border:1px solid rgba(251,191,36,.5);background:rgba(251,191,36,.1);color:#fbbf24;cursor:pointer;font-size:9px;font-weight:700';
      reGpt.onclick = async () => {
        reGpt.disabled = true;
        reGpt.textContent = '...';
        try {
          await repostHistoryJsonOnly(item);
        } catch(e) {
          log('R Json fail: ' + e.message);
          showToast('R Json fail: ' + e.message, '#ef4444');
        } finally {
          reGpt.disabled = false;
          reGpt.textContent = 'R Json';
        }
      };
      actionRow.appendChild(reGpt);

      const reloadHist = document.createElement('button');
      reloadHist.textContent = 'R anh';
      reloadHist.title = 'Lay anh GPT tren trang hien tai gan vao batch nay, regenerate filename va upload lai';
      reloadHist.style.cssText = 'flex:1;height:22px;border-radius:4px;border:1px solid rgba(20,184,166,.5);background:rgba(20,184,166,.1);color:#2dd4bf;cursor:pointer;font-size:9px;font-weight:800';
      reloadHist.onclick = async () => {
        if (!confirm('Lay anh tren trang GPT hien tai gan vao history "' + item.title + '"?')) return;
        reloadHist.disabled = true;
        reloadHist.textContent = '...';
        try {
          const progress = await reloadImagesForHistoryItem(item);
          showToast('Reload history OK ' + (progress.raw_design_done || progress.designs_done || '') + '/' + (progress.styles_total || ''), '#10b981');
        } catch(e) {
          log('History reload fail: ' + e.message);
          showToast('History reload fail: ' + e.message, '#ef4444');
        } finally {
          reloadHist.disabled = false;
          reloadHist.textContent = 'R anh';
        }
      };
      actionRow.appendChild(reloadHist);

      card.appendChild(actionRow);
      batchesEl.appendChild(card);
    });
  }

  // ============ INIT ============
  buildPanel();
  log('Podhub GPTs v' + VERSION + ' san sang.');
  compactStoredBatches();

  reloadJobs();
  setInterval(reloadJobs, 8000);

  // Resume batch sau khi navigate
  const savedState = sessionStorage.getItem('phb_v3_auto');
  if (savedState) {
    try {
      const st = JSON.parse(savedState);
      if (st.running && Array.isArray(st.queue)) {
        batchQueue = st.queue;
        batchJobSnapshots = st.jobs || {};
        batchIdx = st.idx || 0;
        batchRunning = true;
        log('Khoi phuc batch: ' + (batchIdx+1) + '/' + batchQueue.length);
        updateBatchUI();
        setTimeout(async () => {
          await waitPageReady(30000);
          await sleep(2500);
          log('Trang san sang, chay tiep...');
          runNextInBatch();
        }, 2000);
      }
    } catch(e) { sessionStorage.removeItem('phb_v3_auto'); }
  } else {
    // Uu tien: kiem tra Re-GPT flow truoc (user bam Re-GPT tu History)
    const savedReGpt = sessionStorage.getItem('phb_v3_regpt');
    if (savedReGpt) {
      try {
        const ctx = JSON.parse(savedReGpt);
        setTimeout(async () => {
          await waitPageReady(30000);
          await sleep(2500);
          log('Khoi phuc Re-GPT flow: ' + (ctx.title || ctx.assetId || '?'));
          await resumeReGptFlow(ctx);
        }, 2000);
      } catch(e) {
        log('Re-GPT ctx parse fail, bo qua: ' + e.message);
        sessionStorage.removeItem('phb_v3_regpt');
      }
    } else {
      const activeRun = loadActiveRunForCurrentPage();
      if (activeRun) {
        setTimeout(async () => {
          await waitPageReady(30000);
          await sleep(1500);
          if (!batchRunning) await resumeActiveRun(activeRun);
        }, 2000);
      }
    }
  }
})();
