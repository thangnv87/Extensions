const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const outputDir = path.resolve(__dirname, '../Podhub-GPTs-Bridge-Obfuscated');

test('bản Tools mã hóa kích hoạt đúng server và lưu access token', async () => {
  const saved = {};
  const calls = [];
  let listener;
  const workerScope = {
    Blob,
    FormData,
    Response,
    URL,
    URLSearchParams,
    TextEncoder,
    crypto,
    navigator: {userAgent: 'Chrome/140', platform: 'Win32'},
    fetch: async (url, options = {}) => {
      calls.push({url, options});
      if (url.endsWith('/api/extension/activate')) {
        return new Response(JSON.stringify({
          success: true,
          data: {access_token: 'tools-test-token', user: {username: 'tools-canary'}}
        }), {status: 200, headers: {'content-type': 'application/json'}});
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

  vm.runInNewContext(
    fs.readFileSync(path.join(outputDir, 'bridge-v1-client.js'), 'utf8'),
    workerScope,
    {filename: 'bridge-v1-client.js'}
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(outputDir, 'background-source.js'), 'utf8'),
    workerScope,
    {filename: 'background-source.js'}
  );

  const response = await new Promise(resolve => {
    assert.equal(listener({type: 'PUB_ACTIVATE', licenseKey: `phb_ext_live_${'a'.repeat(30)}`}, {}, resolve), true);
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.config_refreshed, false);
  assert.equal(saved.pub_license_token, 'tools-test-token');
  assert.equal(calls[0].url, 'https://tools.podhub.space/api/extension/activate');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls.some(call => call.url.startsWith('https://api.fiercetee.com')), false);
  assert.equal(calls.some(call => call.url.startsWith('https://podhub.space')), false);
});
