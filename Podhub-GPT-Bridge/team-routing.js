(function () {
  'use strict';
  if (globalThis.__podhubTeamRouting) return;

  const TOOLS_ORIGIN = 'https://tools.podhub.space';
  const DEFAULT_DATA_ORIGIN = 'https://ex.podhub.space';
  const ROUTING_STORAGE_KEY = 'phb_team_routing';
  const LEGACY_DATA_ORIGINS = new Set([
    DEFAULT_DATA_ORIGIN,
    'https://www.ex.podhub.space'
  ]);
  const REFRESH_MARGIN_MS = 60 * 1000;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  let refreshPromise = null;

  const storageGet = keys => new Promise(resolve => {
    try { chrome.storage.local.get(keys, resolve); } catch (_) { resolve({}); }
  });
  const storageSet = value => new Promise(resolve => {
    try { chrome.storage.local.set(value, resolve); } catch (_) { resolve(); }
  });
  const normalizeOrigin = value => {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.origin : '';
    } catch (_) {
      return '';
    }
  };
  const decodeExpiry = token => {
    try {
      const segment = String(token || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = segment + '='.repeat((4 - segment.length % 4) % 4);
      return Number(JSON.parse(atob(padded)).exp || 0) * 1000;
    } catch (_) {
      return 0;
    }
  };
  const normalizeRouting = value => {
    const teamAccessToken = String(value?.team_access_token || '');
    return {
      team_id:value?.team_id || null,
      team_name:value?.team_name || null,
      api_base_url:normalizeOrigin(value?.api_base_url) || DEFAULT_DATA_ORIGIN,
      audience:value?.audience || 'podhub-ex-api',
      config_version:Number(value?.config_version || 1),
      team_access_token:teamAccessToken,
      expires_at:Number(value?.expires_at || decodeExpiry(teamAccessToken) || 0)
    };
  };
  const usable = value => Boolean(
    value?.team_id &&
    value?.team_access_token &&
    value?.api_base_url &&
    Number(value.expires_at || 0) > Date.now() + REFRESH_MARGIN_MS
  );
  const ensureOriginPermission = async origin => {
    if (!origin || LEGACY_DATA_ORIGINS.has(origin)) return true;
    try {
      const response = await chrome.runtime.sendMessage({
        type:'PODHUB_ENSURE_ORIGIN_PERMISSION',
        origin
      });
      return Boolean(response?.granted);
    } catch (_) {
      return false;
    }
  };
  const refreshRouting = async () => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const saved = await storageGet([ROUTING_STORAGE_KEY, 'phb_license_token']);
      const current = normalizeRouting(saved[ROUTING_STORAGE_KEY]);
      if (usable(current)) return current;
      const extensionToken = String(saved.phb_license_token || '');
      if (!extensionToken) return current;
      const response = await nativeFetch(TOOLS_ORIGIN + '/api/extension/routing', {
        headers:{Authorization:'Bearer ' + extensionToken}
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        if (current.team_access_token && current.expires_at > Date.now()) return current;
        throw new Error(payload.error || 'ROUTING_REFRESH_FAILED');
      }
      const next = normalizeRouting(payload.data?.routing || payload.data);
      await ensureOriginPermission(next.api_base_url);
      await storageSet({[ROUTING_STORAGE_KEY]:next});
      return next;
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };

  globalThis.fetch = async function podhubTeamFetch(input, init) {
    const originalUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    let parsed;
    try { parsed = new URL(originalUrl, location.href); } catch (_) { return nativeFetch(input, init); }
    if (!LEGACY_DATA_ORIGINS.has(parsed.origin)) return nativeFetch(input, init);

    const routing = await refreshRouting();
    if (!usable(routing)) return nativeFetch(input, init);
    const targetUrl = routing.api_base_url + parsed.pathname + parsed.search + parsed.hash;
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.delete('Authorization');
    headers.set('X-Podhub-Team-Token', routing.team_access_token);
    if (input instanceof Request) {
      return nativeFetch(new Request(targetUrl, input), {...init, headers});
    }
    return nativeFetch(targetUrl, {...init, headers});
  };

  globalThis.__podhubTeamRouting = {
    get:refreshRouting,
    refresh:refreshRouting
  };
})();
