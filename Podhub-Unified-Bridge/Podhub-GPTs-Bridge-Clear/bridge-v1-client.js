(function installPodhubBridgeV1(globalScope) {
  'use strict';

  const BASE_PATH = '/api/bridge/v1';
  const STATE_KEY = 'pub_bridge_v1_state';
  const PROBE_TTL_MS = 5 * 60 * 1000;
  const DISABLED_CODES = new Set([
    'CAPABILITY_NOT_SUPPORTED',
    'BRIDGE_V1_DISABLED',
    'BRIDGE_GATEWAY_DISABLED'
  ]);

  const cleanId = value => String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .slice(0, 180);

  const idempotencyKey = (scope, id) => `ext-v1:${cleanId(scope)}:${cleanId(id) || 'unknown'}`;

  const fingerprint = value => {
    const input = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };

  const marketplaceListing = payload => {
    const source = String(payload?.marketplace || payload?.source || '').toLowerCase();
    const capturedAt = payload?.captured_at || payload?.raw_payload?.captured_at || new Date().toISOString();
    return {
      source,
      source_listing_id: String(payload?.external_id || payload?.source_listing_id || payload?.id || ''),
      captured_at: capturedAt,
      listing: {...payload},
      requested_workflows: Array.isArray(payload?.requested_workflows) ? payload.requested_workflows : [],
      metadata: {source_page: payload?.source_page || payload?.product_url || null}
    };
  };

  const resultPayload = message => ({
    kind: message.kind,
    result: message.kind === 'listing'
      ? (message.body || message.meta || {})
      : {
          data_url: message.dataUrl,
          filename: message.filename || `${message.kind || 'result'}.png`
        },
    asset_ids: Array.isArray(message.assetIds) ? message.assetIds : [],
    metadata: message.meta && typeof message.meta === 'object' ? message.meta : {},
    terminal: message.terminal === true
  });

  function createClient({request, storageGet, storageSet, now = () => Date.now()}) {
    if (typeof request !== 'function' || typeof storageGet !== 'function' || typeof storageSet !== 'function') {
      throw new Error('Bridge v1 client dependencies chưa đầy đủ.');
    }

    const readState = async () => {
      const saved = await storageGet([STATE_KEY]);
      const value = saved?.[STATE_KEY];
      return value && typeof value === 'object' ? value : null;
    };

    const writeState = async mode => {
      const state = {mode, checked_at: now(), expires_at: now() + PROBE_TTL_MS};
      await storageSet({[STATE_KEY]: state});
      return state;
    };

    const probe = async (force = false) => {
      const current = await readState();
      if (!force && current?.expires_at > now()) return current.mode === 'v1';
      try {
        const capabilities = await request(`${BASE_PATH}/capabilities`, {method: 'GET'});
        const supported = capabilities?.contract_version === 'bridge_api_v1';
        await writeState(supported ? 'v1' : 'legacy');
        return supported;
      } catch (error) {
        if (Number(error?.status) === 404 || DISABLED_CODES.has(String(error?.code || ''))) {
          await writeState('legacy');
          return false;
        }
        throw error;
      }
    };

    const write = (path, body, key) => request(path, {
      method: 'POST',
      body,
      headers: {'Idempotency-Key': key}
    });

    return {
      probe,
      clearProbe: () => storageSet({[STATE_KEY]: null}),
      listJobs: workflow => request(`${BASE_PATH}/jobs?workflow=${encodeURIComponent(workflow)}`, {method: 'GET'}),
      nextJob: workflow => request(`${BASE_PATH}/jobs/next?workflow=${encodeURIComponent(workflow)}`, {method: 'GET'}),
      claimJob: (jobId, installationId) => write(
        `${BASE_PATH}/jobs/${encodeURIComponent(jobId)}/claim`,
        {},
        idempotencyKey('claim', `${jobId}:${installationId}`)
      ),
      updateStatus: (jobId, body, installationId) => {
        const status = String(body?.status || '');
        if (status === 'queued') {
          return write(
            `${BASE_PATH}/jobs/${encodeURIComponent(jobId)}/release`,
            {reason: body?.error || 'runner_release'},
            idempotencyKey('release', `${jobId}:${installationId}:${body?.error || 'release'}`)
          );
        }
        return write(
          `${BASE_PATH}/jobs/${encodeURIComponent(jobId)}/status`,
          {status, ...(body?.error ? {error: String(body.error)} : {})},
          idempotencyKey('status', `${jobId}:${status}:${body?.error || ''}`)
        );
      },
      saveResult: (message, installationId) => write(
        `${BASE_PATH}/jobs/${encodeURIComponent(message.jobId)}/result`,
        resultPayload(message),
        idempotencyKey('result', `${message.jobId}:${message.kind}:${message.filename || fingerprint(message.body || message.meta) || installationId}`)
      ),
      saveMarketplaceListing: payload => {
        const body = marketplaceListing(payload);
        return write(
          `${BASE_PATH}/marketplace/listings`,
          body,
          idempotencyKey('listing-v2', `${body.source}:${body.source_listing_id}`)
        );
      },
      queueMockups: (assetIds, options, installationId) => Promise.all(
        [...new Set(Array.isArray(assetIds) ? assetIds.filter(Boolean) : [])].map(assetId => write(
          `${BASE_PATH}/jobs`,
          {
            workflow: 'mockup',
            source: {type: 'asset', id: String(assetId)},
            options: options && typeof options === 'object' ? options : {},
            metadata: {created_by: 'podhub-unified-bridge'},
            priority: 0
          },
          idempotencyKey('mockup-job', `${assetId}:${installationId}`)
        ))
      ),
      getAsset: assetId => request(`${BASE_PATH}/assets/${encodeURIComponent(assetId)}`, {method: 'GET'})
    };
  }

  globalScope.PodhubBridgeV1 = Object.freeze({
    BASE_PATH,
    STATE_KEY,
    createClient,
    fingerprint,
    idempotencyKey,
    marketplaceListing,
    resultPayload
  });
})(globalThis);
