const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const html = fs.readFileSync('index.html', 'utf8');

function createClient(fetch) {
  const elements = { mempoolInput: { value: 'https://mempool.space/testnet/api' } };
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, performance, crypto: webcrypto, Date });
  const constants = html.slice(html.indexOf('    const TXID_RE ='), html.indexOf('    const HEADLINE_PADDING_MAX'));
  const client = html.slice(html.indexOf('    let mempoolPrimary ='), html.indexOf('    async function fetchFeedText'));
  vm.runInContext(`
    ${constants.replace('10_000', '40')}
    const $ = id => elements[id];
    const norm = v => typeof v === 'string' ? v.trim() : '';
    const unique = arr => [...new Set(arr.filter(Boolean))];
    ${html.slice(html.indexOf('    function getMempoolApi()'), html.indexOf('    function parseFeedUrlList'))}
    ${html.slice(html.indexOf('    function b2h('), html.indexOf('    async function sha256hex'))}
    ${client}
    globalThis.client = { mempoolRequest, mempoolJson, broadcastMempoolTx, MEMPOOL_FALLBACKS };
  `, Object.assign(context, { elements }));
  return { ...context.client, elements };
}

function response(status, text = '', headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: key => headers[key] || null }, body: null, text: async () => text };
}

test('fails over on server errors and remembers the working node until the primary changes', async () => {
  const urls = [];
  const client = createClient(async url => {
    urls.push(url);
    return response(urls.length === 1 ? 503 : 200, '{"confirmed":true}');
  });
  assert.equal(client.MEMPOOL_FALLBACKS.length, 47);
  assert.equal((await client.mempoolJson('/status')).confirmed, true);
  await client.mempoolRequest('/next');
  assert.match(urls[0], /^https:\/\/mempool\.space\/testnet\/api/);
  assert.match(urls[1], /^https:\/\/node201\.va1\.mempool\.space\/testnet\/api/);
  assert.match(urls[2], /^https:\/\/node201\.va1\.mempool\.space\/testnet\/api/);
  client.elements.mempoolInput.value = 'https://custom.example/testnet/api/';
  await client.mempoolRequest('/next');
  assert.equal(urls[3], 'https://custom.example/testnet/api/next');
});

test('times out a stalled request and tries the next node', async () => {
  const urls = [];
  const client = createClient((url, options) => {
    urls.push(url);
    if (urls.length > 1) return Promise.resolve(response(200, 'ok'));
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  assert.equal(await client.mempoolRequest('/status'), 'ok');
  assert.match(urls[1], /node201\.va1/);
});

test('shares the burst limit across concurrent requests', async () => {
  const starts = [];
  const client = createClient(async () => {
    starts.push(performance.now());
    return response(200, 'ok');
  });
  await Promise.all(Array.from({ length: 11 }, () => client.mempoolRequest('/status')));
  assert.equal(starts.length, 11);
  assert.ok(starts[10] - starts[9] >= 35, `burst pause was ${starts[10] - starts[9]}ms`);
});

test('backs off after HTTP 429 and retries without switching nodes', async () => {
  const starts = [], urls = [];
  const client = createClient(async url => {
    starts.push(performance.now());
    urls.push(url);
    return starts.length === 1 ? response(429, '', { 'Retry-After': '0' }) : response(200, 'ok');
  });
  assert.equal(await client.mempoolRequest('/status'), 'ok');
  assert.equal(urls[0], urls[1]);
  assert.ok(starts[1] - starts[0] >= 35);
});

test('honors a longer Retry-After for requests already queued', async () => {
  const starts = [];
  const client = createClient(async () => {
    starts.push(performance.now());
    return starts.length === 1 ? response(429, '', { 'Retry-After': '1' }) : response(200, 'ok');
  });
  const first = client.mempoolRequest('/first');
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = client.mempoolRequest('/second');
  await Promise.all([first, second]);
  assert.ok(starts[1] - starts[0] >= 950);
});

test('reports exhaustion after trying every endpoint once', async () => {
  const urls = [];
  const client = createClient(async url => {
    urls.push(url);
    return response(408);
  });
  await assert.rejects(client.mempoolRequest('/status'), /All Mempool Testnet3 endpoints failed.*HTTP 408/);
  assert.equal(new Set(urls).size, 48);
  assert.equal(urls.length, 48);
});

test('does not retry client errors or malformed successful JSON on other nodes', async () => {
  let count = 0;
  const client = createClient(async () => response(++count === 1 ? 400 : 200, 'bad response'));
  await assert.rejects(client.mempoolRequest('/tx'), /HTTP 400.*bad response/);
  await assert.rejects(client.mempoolJson('/status'), /JSON/);
  assert.equal(count, 2);
});

test('recovers the txid when a failed-over broadcast was already accepted', async () => {
  const raw = '01020304';
  let count = 0;
  const client = createClient(async () => ++count === 1
    ? response(503)
    : response(400, 'txn-already-in-mempool'));
  const hash = data => createHash('sha256').update(data).digest();
  const expected = Buffer.from(hash(hash(Buffer.from(raw, 'hex')))).reverse().toString('hex');
  assert.equal(await client.broadcastMempoolTx(raw), expected);
});
