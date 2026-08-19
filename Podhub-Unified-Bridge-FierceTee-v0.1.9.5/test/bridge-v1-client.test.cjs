'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../bridge-v1-client.js'), 'utf8');
const scope = {};
scope.globalThis = scope;
vm.runInNewContext(source, scope, {filename: 'bridge-v1-client.js'});
const bridgeModule = scope.PodhubBridgeV1;

const createHarness = ({responses = [], now = 1000} = {}) => {
  const storage = {};
  const calls = [];
  const request = async (requestPath, options) => {
    calls.push({path: requestPath, options});
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    calls,
    storage,
    client: bridgeModule.createClient({
      request,
      storageGet: async keys => Object.fromEntries(keys.map(key => [key, storage[key]])),
      storageSet: async values => Object.assign(storage, values),
      now: () => now
    })
  };
};

test('chuẩn hóa listing cũ sang contract Bridge v1 mà không mất payload gốc', () => {
  const input = {
    marketplace: 'Etsy',
    external_id: 'etsy-100',
    title: 'Listing thử',
    product_url: 'https://www.etsy.com/listing/100',
    requested_workflows: ['clone', 'mockup'],
    raw_payload: {captured_at: '2026-08-15T00:00:00.000Z', tags: ['pod']}
  };
  const output = bridgeModule.marketplaceListing(input);
  assert.equal(output.source, 'etsy');
  assert.equal(output.source_listing_id, 'etsy-100');
  assert.equal(output.captured_at, '2026-08-15T00:00:00.000Z');
  assert.equal(JSON.stringify(output.requested_workflows), JSON.stringify(['clone', 'mockup']));
  assert.equal(JSON.stringify(output.listing), JSON.stringify(input));
});

test('probe chỉ fallback khi gateway xác nhận chưa hỗ trợ', async () => {
  const disabled = Object.assign(new Error('disabled'), {status: 503, code: 'CAPABILITY_NOT_SUPPORTED'});
  const harness = createHarness({responses: [disabled]});
  assert.equal(await harness.client.probe(), false);
  assert.equal(harness.storage[bridgeModule.STATE_KEY].mode, 'legacy');
  assert.equal(await harness.client.probe(), false);
  assert.equal(harness.calls.length, 1);

  const unavailable = Object.assign(new Error('offline'), {status: 502, code: 'TEAM_SERVER_UNAVAILABLE', retryable: true});
  const failed = createHarness({responses: [unavailable]});
  await assert.rejects(failed.client.probe(), error => error.code === 'TEAM_SERVER_UNAVAILABLE');
  assert.equal(failed.storage[bridgeModule.STATE_KEY], undefined);
});

test('probe thành công bật canonical mode và cache trong TTL', async () => {
  const harness = createHarness({responses: [{contract_version: 'bridge_api_v1'}]});
  assert.equal(await harness.client.probe(), true);
  assert.equal(harness.storage[bridgeModule.STATE_KEY].mode, 'v1');
  assert.equal(await harness.client.probe(), true);
  assert.equal(harness.calls.length, 1);
});

test('canonical writes luôn có idempotency key ổn định', async () => {
  const harness = createHarness({responses: [{id: 'listing-1'}, {id: 'job-1'}, {id: 'result-1'}]});
  await harness.client.saveMarketplaceListing({
    marketplace: 'etsy', external_id: '100', raw_payload: {captured_at: '2026-08-15T00:00:00.000Z'}
  });
  await harness.client.claimJob('job-1', 'install-1');
  await harness.client.saveResult({jobId: 'job-1', kind: 'listing', body: {marketplace: 'etsy'}}, 'install-1');
  assert.deepEqual(harness.calls.map(call => call.path), [
    '/api/bridge/v1/marketplace/listings',
    '/api/bridge/v1/jobs/job-1/claim',
    '/api/bridge/v1/jobs/job-1/result'
  ]);
  for (const call of harness.calls) {
    assert.match(call.options.headers['Idempotency-Key'], /^ext-v1:/);
  }
  assert.match(harness.calls[0].options.headers['Idempotency-Key'], /^ext-v1:listing-v2:/);
});

test('hai listing result khác nhau không dùng trùng idempotency key', async () => {
  const harness = createHarness({responses: [{}, {}]});
  await harness.client.saveResult({jobId: 'job-1', kind: 'listing', body: {marketplace: 'etsy'}}, 'install-1');
  await harness.client.saveResult({jobId: 'job-1', kind: 'listing', body: {marketplace: 'amazon'}}, 'install-1');
  assert.notEqual(
    harness.calls[0].options.headers['Idempotency-Key'],
    harness.calls[1].options.headers['Idempotency-Key']
  );
});

test('runtime mới không chứa Team token hoặc gọi trực tiếp server team', () => {
  const background = fs.readFileSync(path.resolve(__dirname, '../background-source.js'), 'utf8');
  const worker = fs.readFileSync(path.resolve(__dirname, '../service-worker.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../manifest.json'), 'utf8'));
  assert.equal(background.includes('X-Podhub-Team-Token'), false);
  assert.equal(background.includes('ex.podhub.space'), false);
  assert.match(background, /delete safe\.team_access_token/);
  assert.match(background, /\/api\/extension\/config\?bridge_gateway=1/);
  assert.match(worker, /importScripts\('bridge-v1-client\.js', 'background-source\.js'\)/);
  assert.equal(manifest.background.service_worker, 'service-worker.js');
  assert.equal(manifest.version, '0.1.9.5');
  assert.match(background, /normalizedKey\.startsWith\('phb_ext_live_'\).*\/api\/extension\/activate/);
  assert.match(background, /normalizedKey\.startsWith\('phb_live_'\).*\/api\/license\/activate/);
  assert.doesNotMatch(background, /apiPost\('\/api\/license\/activate', body\)\.catch/);
  assert.match(background, /apiPost\('\/api\/extension\/marketplace-listings', payload\)/);
  assert.match(background, /pub_marketplace_jobs_revision/);
  assert.match(background, /const result = await api\(module\.list_jobs_path/);
  assert.doesNotMatch(background, /bridge\.listJobs\(/);
  assert.doesNotMatch(background, /bridge\.nextJob\(/);
  const uiFix = fs.readFileSync(path.resolve(__dirname, '../ui-fix.js'), 'utf8');
  assert.match(uiFix, /PUB_LIST_JOBS/);
  assert.match(uiFix, /renderFallbackJobs/);
  assert.match(uiFix, /PUB_START_JOB/);
  assert.match(uiFix, /PUB_DELETE_JOB/);
});

test('service worker source khởi động được với Chrome MV3 API tối thiểu', async () => {
  const saved = {};
  let listener;
  const workerScope = {
    Blob,
    FormData,
    URL,
    URLSearchParams,
    TextEncoder,
    crypto,
    navigator: {userAgent: 'Chrome/140', platform: 'Win32'},
    fetch: async () => new Response(JSON.stringify({success: true, data: {}}), {
      headers: {'content-type': 'application/json'}
    }),
    chrome: {
      storage: {local: {
        get: async keys => Object.fromEntries(keys.map(key => [key, saved[key]])),
        set: async values => Object.assign(saved, values),
        remove: async keys => keys.forEach(key => delete saved[key])
      }},
      runtime: {
        getManifest: () => ({version: '0.1.9.5'}),
        onMessage: {addListener: callback => { listener = callback; }}
      },
      tabs: {create: async () => ({id: 1})}
    }
  };
  workerScope.globalThis = workerScope;
  vm.runInNewContext(source, workerScope, {filename: 'bridge-v1-client.js'});
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '../background-source.js'), 'utf8'),
    workerScope,
    {filename: 'background-source.js'}
  );
  assert.equal(typeof listener, 'function');
  const response = await new Promise(resolve => {
    assert.equal(listener({type: 'PUB_GET_STATE'}, {}, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.active, false);
  assert.equal(response.data.bridge_mode, 'unknown');
});

test('extension key uses the correct endpoint and keeps activation after a temporary config failure', async () => {
  const saved = {};
  const calls = [];
  let listener;
  const workerScope = {
    Blob,
    FormData,
    URL,
    URLSearchParams,
    TextEncoder,
    crypto,
    navigator: {userAgent: 'Chrome/140', platform: 'Win32'},
    fetch: async (url, options = {}) => {
      calls.push({url, options});
      if (url.endsWith('/api/extension/activate')) {
        return new Response(JSON.stringify({success: true, data: {
          access_token: 'test-token',
          user: {username: 'canary'},
          routing: {team_name: 'Fiercetee', api_base_url: 'https://api.fiercetee.com'}
        }}), {
          status: 200,
          headers: {'content-type': 'application/json'}
        });
      }
      if (url.includes('/api/extension/config')) {
        return new Response(JSON.stringify({success: false, error: 'CONFIG_TEMPORARY_ERROR'}), {
          status: 503,
          headers: {'content-type': 'application/json'}
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    chrome: {
      storage: {local: {
        get: async keys => Object.fromEntries(keys.map(key => [key, saved[key]])),
        set: async values => Object.assign(saved, values),
        remove: async keys => keys.forEach(key => delete saved[key])
      }},
      runtime: {
        getManifest: () => ({version: '0.1.9.5'}),
        onMessage: {addListener: callback => { listener = callback; }}
      },
      tabs: {create: async () => ({id: 1})}
    }
  };
  workerScope.globalThis = workerScope;
  vm.runInNewContext(source, workerScope, {filename: 'bridge-v1-client.js'});
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '../background-source.js'), 'utf8'),
    workerScope,
    {filename: 'background-source.js'}
  );

  const response = await new Promise(resolve => {
    assert.equal(listener({type: 'PUB_ACTIVATE', licenseKey: `phb_ext_live_${'a'.repeat(30)}`}, {}, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.config_refreshed, false);
  assert.equal(saved.pub_license_token, 'test-token');
  assert.equal(calls[0].url, 'https://tools.podhub.space/api/extension/activate');
  assert.equal(calls.some(call => call.url.endsWith('/api/license/activate')), false);
});
