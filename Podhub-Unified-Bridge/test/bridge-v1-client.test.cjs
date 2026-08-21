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
  assert.match(background, /normalizedKey\.startsWith\('phb_ext_live_'\)/);
  assert.match(background, /apiPost\('\/api\/extension\/activate', body\)/);
  assert.match(background, /normalizedKey\.startsWith\('phb_live_'\)/);
  assert.match(background, /apiPost\('\/api\/license\/activate', body\)/);
  assert.match(background, /const TOOLS_ORIGIN = 'https:\/\/podhub\.space'/);
  assert.doesNotMatch(background, /apiPost\('\/api\/license\/activate', body\)\.catch/);
  assert.match(background, /api\('\/api\/extension\/marketplace-listings', \{method: 'POST', body: data\}\)/);
  assert.match(background, /pub_marketplace_jobs_revision/);
  assert.doesNotMatch(background, /chrome\.tabs\.reload\(/);
  assert.doesNotMatch(background, /chrome\.runtime\.reload\(/);
  assert.match(background, /chrome\.storage\.local\.remove\(\['pub_reload_tab_id'\]\)/);
  assert.match(background, /const result = await api\(appendQuery\(moduleConfig\.list_jobs_path, query\)\)/);
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
        return new Response(JSON.stringify({success: true, data: {access_token: 'test-token', user: {username: 'canary'}}}), {
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
  assert.equal(calls[0].url, 'https://podhub.space/api/extension/activate');
  assert.equal(calls.some(call => call.url.endsWith('/api/license/activate')), false);
});

test('ảnh kết quả được upload dưới dạng raw binary với metadata trên query string', async () => {
  const saved = {pub_license_token: 'test-token'};
  const calls = [];
  const workerScope = {
    Blob,
    FormData,
    URL,
    URLSearchParams,
    TextEncoder,
    Response,
    crypto,
    setTimeout,
    navigator: {userAgent: 'Chrome/140', platform: 'Win32'},
    fetch: async (url, options = {}) => {
      if (String(url).startsWith('data:')) return fetch(url, options);
      calls.push({url: String(url), options});
      return new Response(JSON.stringify({success: true, data: {uploaded: true}}), {
        status: 200,
        headers: {'content-type': 'application/json'}
      });
    },
    chrome: {
      storage: {local: {
        get: async keys => Object.fromEntries(keys.map(key => [key, saved[key]])),
        set: async values => Object.assign(saved, values),
        remove: async keys => keys.forEach(key => delete saved[key])
      }},
      runtime: {
        getManifest: () => ({version: '0.1.9.5'}),
        onMessage: {addListener: () => {}}
      },
      tabs: {query: async () => [], create: async () => ({id: 1})}
    }
  };
  workerScope.globalThis = workerScope;
  vm.runInNewContext(source, workerScope, {filename: 'bridge-v1-client.js'});
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '../background-source.js'), 'utf8'),
    workerScope,
    {filename: 'background-source.js'}
  );

  const result = await workerScope.uploadResult({
    moduleId: 'redesign',
    jobId: 'job-raw-1',
    kind: 'raw_redesign',
    filename: 'design 01.png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    meta: {background_color: 'Black', runner_id: 'runner-1'}
  });

  assert.equal(result.uploaded, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/extension\/redesign-jobs\/job-raw-1\/raw-redesign\?/);
  assert.match(calls[0].url, /filename=design\+01\.png/);
  assert.match(calls[0].url, /background_color=Black/);
  assert.match(calls[0].url, /runner_id=runner-1/);
  assert.equal(calls[0].options.body instanceof Blob, true);
  assert.equal(calls[0].options.body instanceof FormData, false);
  assert.equal(calls[0].options.headers['Content-Type'], 'image/png');
});

test('background tải file ảnh gốc rồi mới upload, không chuyển raw image qua runtime message', async () => {
  const saved = {pub_license_token: 'test-token'};
  const calls = [];
  const sourceUrl = 'https://files.oaiusercontent.com/file-test/generated.png';
  const workerScope = {
    Blob, FormData, URL, URLSearchParams, TextEncoder, Response, crypto, setTimeout,
    navigator: {userAgent: 'Chrome/140', platform: 'Win32'},
    fetch: async (url, options = {}) => {
      calls.push({url: String(url), options});
      if (String(url) === sourceUrl) {
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]), {
          status: 200,
          headers: {'content-type': 'application/octet-stream'}
        });
      }
      return new Response(JSON.stringify({success: true, data: {uploaded: true}}), {
        status: 200,
        headers: {'content-type': 'application/json'}
      });
    },
    chrome: {
      storage: {local: {
        get: async keys => Object.fromEntries(keys.map(key => [key, saved[key]])),
        set: async values => Object.assign(saved, values),
        remove: async keys => keys.forEach(key => delete saved[key])
      }},
      runtime: {getManifest: () => ({version: '0.1.9.5'}), onMessage: {addListener: () => {}}},
      tabs: {query: async () => [], create: async () => ({id: 1})}
    }
  };
  workerScope.globalThis = workerScope;
  vm.runInNewContext(source, workerScope, {filename: 'bridge-v1-client.js'});
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../background-source.js'), 'utf8'), workerScope, {filename: 'background-source.js'});

  const result = await workerScope.uploadResult({
    moduleId: 'clone', jobId: 'job-source-1', kind: 'raw_clone',
    filename: 'clone-result.jpg', sourceUrl
  });

  assert.equal(result.uploaded, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, sourceUrl);
  assert.equal(calls[0].options.credentials, 'include');
  assert.match(calls[1].url, /filename=clone-result\.png/);
  assert.equal(calls[1].options.body.type, 'image/png');
});

test('raw asset được tải qua endpoint extension có token trước khi hiển thị', async () => {
  const saved = {pub_license_token: 'asset-token'};
  const calls = [];
  const workerScope = {
    Blob,
    FormData,
    URL,
    URLSearchParams,
    TextEncoder,
    Response,
    crypto,
    btoa,
    setTimeout,
    navigator: {userAgent: 'Chrome/140', platform: 'Win32'},
    fetch: async (url, options = {}) => {
      calls.push({url: String(url), options});
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: {'content-type': 'image/png', 'X-Podhub-Design-Name': 'raw-test.png'}
      });
    },
    chrome: {
      storage: {local: {
        get: async keys => Object.fromEntries(keys.map(key => [key, saved[key]])),
        set: async values => Object.assign(saved, values),
        remove: async keys => keys.forEach(key => delete saved[key])
      }},
      runtime: {
        getManifest: () => ({version: '0.1.9.5'}),
        onMessage: {addListener: () => {}}
      },
      tabs: {query: async () => [], create: async () => ({id: 1})}
    }
  };
  workerScope.globalThis = workerScope;
  vm.runInNewContext(source, workerScope, {filename: 'bridge-v1-client.js'});
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '../background-source.js'), 'utf8'),
    workerScope,
    {filename: 'background-source.js'}
  );

  const result = await workerScope.fetchAsset({
    source: {asset_id: 'asset-raw-1', url: 'https://broken.invalid/raw.png', name: 'raw.png'}
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://podhub.space/api/extension/assets/asset-raw-1/content');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer asset-token');
  assert.match(calls[0].options.headers['X-Podhub-Request-Id'], /^ext_/);
  assert.match(result.data_url, /^data:image\/png;base64,/);
  assert.equal(result.name, 'raw-test.png');
});

test('raw asset từ tab Done được đưa sang đúng endpoint tạo Mockup', async () => {
  const saved = {pub_license_token: 'queue-token'};
  const calls = [];
  const workerScope = {
    Blob, FormData, URL, URLSearchParams, TextEncoder, Response, crypto, setTimeout,
    navigator: {userAgent: 'Chrome/140', platform: 'Win32'},
    fetch: async (url, options = {}) => {
      calls.push({url: String(url), options});
      return new Response(JSON.stringify({success: true, data: {jobs: [], added: 1}}), {
        status: 200,
        headers: {'content-type': 'application/json'}
      });
    },
    chrome: {
      storage: {local: {
        get: async keys => Object.fromEntries(keys.map(key => [key, saved[key]])),
        set: async values => Object.assign(saved, values),
        remove: async keys => keys.forEach(key => delete saved[key])
      }},
      runtime: {getManifest: () => ({version: '0.1.9.5'}), onMessage: {addListener: () => {}}},
      tabs: {query: async () => [], create: async () => ({id: 1})}
    }
  };
  workerScope.globalThis = workerScope;
  vm.runInNewContext(source, workerScope, {filename: 'bridge-v1-client.js'});
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../background-source.js'), 'utf8'), workerScope, {filename: 'background-source.js'});

  await workerScope.queueRawAssetsForMockup({assetIds: ['raw-asset-1']}, {mockup_products: ['mug_11oz'], mockup_count: 3});

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://podhub.space/api/extension/mockup-jobs/queue-assets');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    asset_ids: ['raw-asset-1'],
    options: {mockup_products: ['mug_11oz'], mockup_count: 3}
  });
});

test('xóa job gọi đúng endpoint hàng đợi, không gọi nhầm endpoint status', async () => {
  const saved = {pub_license_token: 'delete-token'};
  const calls = [];
  const workerScope = {
    Blob, FormData, URL, URLSearchParams, TextEncoder, Response, crypto, setTimeout,
    navigator: {userAgent: 'Chrome/140', platform: 'Win32'},
    fetch: async (url, options = {}) => {
      calls.push({url: String(url), options});
      return new Response(JSON.stringify({success: true, data: {id: 'job-delete-1'}}), {
        status: 200,
        headers: {'content-type': 'application/json'}
      });
    },
    chrome: {
      storage: {local: {
        get: async keys => Object.fromEntries(keys.map(key => [key, saved[key]])),
        set: async values => Object.assign(saved, values),
        remove: async keys => keys.forEach(key => delete saved[key])
      }},
      runtime: {getManifest: () => ({version: '0.1.9.5'}), onMessage: {addListener: () => {}}, reload: () => {}},
      tabs: {query: async () => [], create: async () => ({id: 1})}
    }
  };
  workerScope.globalThis = workerScope;
  vm.runInNewContext(source, workerScope, {filename: 'bridge-v1-client.js'});
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../background-source.js'), 'utf8'), workerScope, {filename: 'background-source.js'});

  await workerScope.deleteJob('redesign', 'job-delete-1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://podhub.space/api/extension/redesign-jobs/job-delete-1');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].url.endsWith('/status'), false);
});

test('parser workflow ưu tiên JSON trong fenced block và giữ nguyên toàn bộ prompt', () => {
  const content = fs.readFileSync(path.resolve(__dirname, '../content.js'), 'utf8');
  const styles = fs.readFileSync(path.resolve(__dirname, '../content.css'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../manifest.json'), 'utf8'));
  assert.match(content, /function jsonValuesFromAssistantText\(text\)/);
  assert.match(content, /function normalizeMockupPlan\(plan, products\)/);
  assert.match(content, /const planned = productPlan\.mockup_prompts\.find/);
  assert.match(content, /await sendPrompt\(String\(planned\.prompt\)\.trim\(\)\)/);
  assert.match(content, /function rememberUploadedResult\(moduleId, job, uploaded, filename, meta = \{\}\)/);
  assert.match(content, /await startJobs\(mockupJobs\.map\(job => \(\{\.\.\.job, run_options: runOptions\}\)\)\)/);
  assert.match(content, /if \(body\?\.status === 'done'\) queueFilter = 'done'/);
  assert.match(content, /const CLONE_PROMPT = `Clone chính xác design từ ảnh này thành flat artwork chính diện/);
  assert.match(content, /const CLONE_REMOVE_BACKGROUND_PROMPT = 'Xóa toàn bộ background khỏi thiết kế này/);
  assert.match(content, /await sendPrompt\(CLONE_PROMPT\)/);
  assert.match(content, /await sendPrompt\(CLONE_REMOVE_BACKGROUND_PROMPT\)/);
  assert.match(content, /if \(options\.clone_with_background === true\)/);
  assert.match(content, /else \{\s*await sendAttachmentOnly\(\)/);
  assert.match(content, /id="pub-clone-with-background"/);
  assert.match(content, /id="pub-clone-remove-background-gpt"/);
  assert.match(content, /data-action="reconnect-extension"/);
  assert.doesNotMatch(content, /setTimeout\(\(\) => location\.reload\(\), 500\)/);
  assert.match(content, /const fenced = \/```\(\?:json\)\?\\s\*\(\[\\s\\S\]\*\?\)```\/gi/);
  assert.match(content, /replace\(\/\[\\u200B-\\u200D\\u2060\\uFEFF\]\/g, ''\)/);
  assert.match(content, /Phân tích artwork đính kèm và lập kế hoạch \$\{count\} mockup/);
  assert.match(content, /Dựa trên kế hoạch vừa lập, tạo mockup \$\{mockupNo\}\/\$\{total\}/);
  assert.match(content, /Tạo listing SEO đầy đủ cho \$\{productId\}/);
  assert.match(content, /function hydrateResultImages\(container\)/);
  assert.match(content, /function assistantImageCandidates\(img\)/);
  assert.match(content, /function imageSourceFallbacks\(primaryUrl\)/);
  assert.match(content, /function captureGptImage\(sourceUrls\)/);
  assert.match(content, /function uploadCapturedImage\(moduleId, id, kind, filename, blob, meta = \{\}\)/);
  assert.match(content, /const MIN_GPT_IMAGE_BYTES = 30 \* 1024/);
  assert.match(content, /body: blob/);
  assert.match(content, /GPT_IMAGE_CONTENT_INVALID/);
  assert.equal(manifest.host_permissions.includes('https://*.oaiusercontent.com/*'), true);
  assert.match(styles, /\.pub-account-status\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(styles, /\.pub-config\.visible\s*\{[\s\S]*?justify-content:\s*flex-start;/);
  assert.match(styles, /\.pub-clone-options\s*\{[\s\S]*?grid-template-columns:\s*1fr 1fr;/);
});
