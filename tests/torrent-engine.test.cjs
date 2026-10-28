'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const createService = require('../remote/torrent-engine.cjs');

function query(port, method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, headers) }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('Range parser accepts suffix/open ranges and rejects invalid/multi ranges', () => {
  assert.deepEqual(Object.assign({}, createService.parseRange('bytes=-10', 100)), { start: 90, end: 99, partial: true });
  assert.deepEqual(Object.assign({}, createService.parseRange('bytes=20-', 100)), { start: 20, end: 99, partial: true });
  for (const value of ['bytes=100-', 'bytes=10-9', 'bytes=0-1,3-4', 'bytes=-0', 'bytes=-', 'bad']) assert.equal(createService.parseRange(value, 100), null);
});

test('bounded store never retains above budget and evictions invalidate exact piece', async () => {
  const evicted = [], reports = [];
  const store = createService.boundedStore(8, index => evicted.push(index), bytes => reports.push(bytes))(4);
  for (let index = 0; index < 4; index++) await new Promise(resolve => store.put(index, Buffer.alloc(4, index), resolve));
  assert.deepEqual(evicted, [0, 1]);
  assert.ok(reports.every(bytes => bytes <= 8));
  await new Promise(resolve => store.get(0, error => { assert.ok(error); resolve(); }));
  await new Promise(resolve => store.close(resolve));
  assert.equal(reports[reports.length - 1], 0);
});

test('episode selection does not choose wrong episode in a season pack', () => {
  const files = [{ name: 'Series.S01E01.mp4', length: 100 }, { name: 'Series.S01E02.mp4', length: 200 }];
  assert.equal(createService.chooseFile(files, { season: 1, episode: 2 }), 1);
  assert.throws(() => createService.chooseFile(files, { season: 1, episode: 3 }));
  assert.equal(createService.chooseFile(files, { fileIdx: 0 }), 0);
});

test('real TCP peers: magnet metadata, byte ranges, cache eviction and backward seek', { timeout: 25000 }, async t => {
  const createTorrent = require('create-torrent');
  const torrentStream = require('torrent-stream');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-torrent-test-'));
  const bytes = crypto.randomBytes(512 * 1024);
  fs.writeFileSync(path.join(dir, 'fixture.mp4'), bytes);
  const torrent = await new Promise((resolve, reject) => createTorrent(bytes, { name: 'fixture.mp4', pieceLength: 16384, announceList: [] }, (error, result) => error ? reject(error) : resolve(result)));
  const seed = torrentStream(torrent, { path: dir, tmp: dir, dht: false, tracker: false, connections: 4 });
  seed.on('error', () => {});
  t.after(() => new Promise(resolve => seed.destroy(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); })));
  await once(seed, 'ready');
  await new Promise(resolve => seed.listen(0, resolve));
  const downloads = [];
  const service = createService({ cacheBytes: 64 * 1024, metadataTimeout: 10000, pieceTimeout: 10000,
    engineOptions: { dht: false, tracker: false }, onEngine: engine => { engine.on('download', index => downloads.push(index)); engine.connect('127.0.0.1:' + seed.port); } });
  t.after(() => service.close());
  const server = http.createServer((req, res) => { if (!service.handle(req, res)) res.end('404'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const start = await query(port, 'POST', '/api/torrent/start', { sessionId: 'seek-test', infoHash: seed.infoHash });
  assert.equal(start.status, 200, start.data.toString());
  const data = JSON.parse(start.data), url = data.url;
  for (const [from, to] of [[0, 100000], [400000, 480000], [0, 50000]]) {
    const result = await query(port, 'GET', url, null, { Range: 'bytes=' + from + '-' + to });
    assert.equal(result.status, 206);
    assert.deepEqual(result.data, bytes.slice(from, to + 1));
    assert.ok(service.status().cacheBytes <= 64 * 1024, JSON.stringify(service.status()));
    if (from === 0 && to === 100000) assert.equal(new Set(downloads).size, downloads.length, 'new pieces are not downloaded twice');
  }
  const invalid = await query(port, 'GET', url, null, { Range: 'bytes=999999-' });
  assert.equal(invalid.status, 416);
  const wrongStop = await query(port, 'POST', '/api/torrent/stop', { sessionId: 'older-video' });
  assert.equal(JSON.parse(wrongStop.data).stopped, false);
  assert.equal(service.status().sessionId, 'seek-test');
  await query(port, 'POST', '/api/torrent/stop', { sessionId: 'seek-test' });
  assert.equal(service.status().active, false);
  assert.equal((await query(port, 'GET', url)).status, 404);
});

test('peer parser bounds frames and isolates malformed messages', () => {
  const make = () => ({ destroyed: 0, destroy() { this.destroyed++; }, _parse(size, parser) { this.size = size; this.parser = parser; } });
  const oversized = make(); createService.guardWire(oversized); oversized._parse(50 * 1024 * 1024, () => {});
  assert.equal(oversized.destroyed, 1);
  const malformed = make(); createService.guardWire(malformed); malformed._parse(8, () => { throw new Error('peer sent short message'); }); malformed.parser(Buffer.alloc(8));
  assert.equal(malformed.destroyed, 1);
});

// Fake engine with per-piece partial data, selections and a manual "download" trigger.
function fakeEngineFactory(state) {
  const EventEmitter = require('events');
  return function () {
    const engine = state.engine = new EventEmitter();
    const pieceLength = state.pieceLength || 16384;
    state.partial = new Map(); state.selected = []; state.discarded = []; state.have = new Set();
    engine.files = [{ name: 'partial.mp4', offset: 0, length: state.fileLength || 1024 * 1024, deselect() {} }];
    engine.torrent = { pieceLength };
    engine.bitfield = { get: index => state.have.has(index) };
    engine.swarm = { wires: [], downloaded: 0, _peers: {}, downloadSpeed() { return 0; } };
    engine.connect = engine.destroy = function () {};
    engine.store = { get(index, cb) { setImmediate(() => state.have.has(index) ? cb(null, Buffer.alloc(pieceLength, index % 256)) : cb(new Error('missing'))); } };
    engine.partialBytes = () => Array.from(state.partial.values()).reduce((a, b) => a + b, 0);
    engine.pieceProgress = index => state.have.has(index) ? pieceLength : state.partial.get(index) || 0;
    engine.forgetPiece = (index, resetPartial) => { if (resetPartial) { state.discarded.push(index); state.partial.delete(index); } };
    engine.select = function (from, to, priority, notify) {
      state.selected.push({ index: from, priority, notify });
      if (priority === 1 && !state.partial.has(from)) state.partial.set(from, 8192);
      engine.emit('selected', from, priority);
    };
    engine.deselect = function (from, to, priority, notify) {
      const i = state.selected.findIndex(x => x.index === from && x.priority === priority && x.notify === notify);
      if (i >= 0) state.selected.splice(i, 1);
    };
    engine.complete = index => { state.partial.delete(index); state.have.add(index); engine.emit('download', index); };
    setImmediate(() => engine.emit('ready'));
    return engine;
  };
}

async function fakeService(t, state, options) {
  const service = createService(Object.assign({ engineFactory: fakeEngineFactory(state) }, options));
  t.after(() => service.close());
  const server = http.createServer((req, res) => service.handle(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const response = await query(port, 'POST', '/api/torrent/start', { sessionId: 'fake-' + Math.random().toString(36).slice(2), infoHash: 'a'.repeat(40) });
  return { service, port, url: JSON.parse(response.data).url };
}

async function waitFor(fn) {
  for (let tries = 0; !fn() && tries < 200; tries++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(fn(), 'condition reached');
}

test('aborted ranges keep a bounded number of partial pieces for the next Range', { timeout: 5000 }, async t => {
  const state = {};
  const { service, port, url } = await fakeService(t, state);
  for (let n = 0; n < 6; n++) {
    const selected = once(state.engine, 'selected');
    const req = http.get({ hostname: '127.0.0.1', port, path: url, headers: { Range: 'bytes=' + (n * 16384) + '-' } });
    req.on('error', () => {});
    await selected;
    req.destroy();
    await waitFor(() => !state.selected.some(x => x.priority === 1));
    assert.ok(state.partial.size <= 2, 'at most two cancelled partial pieces are kept');
    assert.ok(service.status().partialBytes <= 2 * 8192);
  }
  assert.deepEqual(state.discarded, [0, 1, 2, 3]);
  // Asking again for a kept piece reuses its partial data instead of downloading it from zero.
  const selected = once(state.engine, 'selected');
  const req = http.get({ hostname: '127.0.0.1', port, path: url, headers: { Range: 'bytes=' + (5 * 16384) + '-' } });
  req.on('error', () => {});
  await selected;
  assert.equal(state.discarded.indexOf(5), -1);
  req.destroy();
});

test('a piece that keeps receiving data is not failed by the deadline', { timeout: 5000 }, async t => {
  const state = {};
  const { port, url } = await fakeService(t, state, { pieceTimeout: 120 });
  const growing = setInterval(() => state.partial.set(0, (state.partial.get(0) || 0) + 100), 20);
  t.after(() => clearInterval(growing));
  const result = query(port, 'GET', url, null, { Range: 'bytes=0-100' });
  await new Promise(resolve => setTimeout(resolve, 400));
  clearInterval(growing);
  state.engine.complete(0);
  const response = await result;
  assert.equal(response.status, 206);
  assert.equal(response.data.length, 101);
});

test('a piece without new data fails after the deadline and its partial is discarded', { timeout: 5000 }, async t => {
  const state = {};
  const { service, port, url } = await fakeService(t, state, { pieceTimeout: 120 });
  await query(port, 'GET', url, null, { Range: 'bytes=0-100' }).catch(() => null);
  await waitFor(() => state.discarded.indexOf(0) >= 0);
  assert.ok(/sem dados/.test(service.status().error));
});

test('delivered pieces start a read-ahead that fits the cache, and a seek drops it', { timeout: 5000 }, async t => {
  const state = {};
  const { port, url } = await fakeService(t, state, { cacheBytes: () => 4 * 16384 });
  state.have.add(0);
  await query(port, 'GET', url, null, { Range: 'bytes=0-100' });
  assert.deepEqual(state.selected.filter(x => x.priority === 0).map(x => x.index), [1, 2]);
  state.engine.complete(1);
  assert.deepEqual(state.selected.filter(x => x.priority === 0).map(x => x.index), [2]);
  state.have.add(40);
  await query(port, 'GET', url, null, { Range: 'bytes=' + (40 * 16384) + '-' + (40 * 16384 + 10) });
  assert.deepEqual(state.selected.filter(x => x.priority === 0).map(x => x.index), [41, 42]);
});

test('cache size can follow free memory at each start', { timeout: 5000 }, async t => {
  const state = {};
  let budget = 12 * 1024 * 1024;
  const { service } = await fakeService(t, state, { cacheBytes: () => budget });
  assert.equal(service.status().cacheLimit, 12 * 1024 * 1024);
  budget = NaN;
  assert.equal(createService({ cacheBytes: () => budget }).status().cacheLimit, 8 * 1024 * 1024);
});

test('addon trackers are merged with the defaults, deduplicated and capped', () => {
  const merged = createService.mergeTrackers(['tracker:udp://a.example:1/announce', 'dht:abc', 'tracker:udp://tracker.opentrackr.org:1337/announce', 'javascript:alert(1)']);
  assert.equal(merged[0], 'udp://a.example:1/announce');
  assert.equal(merged.filter(x => /opentrackr/.test(x)).length, 1);
  assert.ok(createService.DEFAULT_TRACKERS.every(x => merged.indexOf(x) >= 0));
  assert.ok(merged.every(x => /^(udp|https?):\/\//.test(x)));
  const many = Array.from({ length: 40 }, (_, i) => 'udp://t' + i + '.example:1/announce');
  assert.ok(createService.mergeTrackers(many).length <= 20);
  assert.ok(createService.DEFAULT_TRACKERS.every(x => createService.mergeTrackers(many).indexOf(x) >= 0), 'defaults survive a long addon list');
});

test('content types match the container', () => {
  assert.equal(createService.mime('a.mp4'), 'video/mp4');
  assert.equal(createService.mime('a.avi'), 'video/x-msvideo');
  assert.equal(createService.mime('a.MOV'), 'video/quicktime');
  assert.equal(createService.mime('a.mkv'), 'video/x-matroska');
});

async function realPeer(t, cacheBytes, size, extra) {
  const createTorrent = require('create-torrent');
  const torrentStream = require('torrent-stream');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-torrent-test-'));
  const bytes = crypto.randomBytes(size);
  fs.writeFileSync(path.join(dir, 'fixture.mp4'), bytes);
  const torrent = await new Promise((resolve, reject) => createTorrent(bytes, { name: 'fixture.mp4', pieceLength: 16384, announceList: [] }, (error, result) => error ? reject(error) : resolve(result)));
  const seed = torrentStream(torrent, { path: dir, tmp: dir, dht: false, tracker: false, connections: 4 });
  seed.on('error', () => {});
  t.after(() => new Promise(resolve => seed.destroy(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); })));
  await once(seed, 'ready');
  await new Promise(resolve => seed.listen(0, resolve));
  const ctx = { downloads: [], engine: null, bytes };
  const service = createService(Object.assign({ cacheBytes, metadataTimeout: 10000, pieceTimeout: 10000,
    engineOptions: { dht: false, tracker: false }, onEngine: engine => { ctx.engine = engine; engine.on('download', index => ctx.downloads.push(index)); engine.connect('127.0.0.1:' + seed.port); } }, extra || {}));
  t.after(() => service.close());
  const server = http.createServer((req, res) => { if (!service.handle(req, res)) res.end('404'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  ctx.port = server.address().port; ctx.service = service;
  const start = await query(ctx.port, 'POST', '/api/torrent/start', { sessionId: 'real-' + cacheBytes, infoHash: seed.infoHash });
  assert.equal(start.status, 200, start.data.toString());
  ctx.url = JSON.parse(start.data).url;
  return ctx;
}

for (const pieces of [2, 3, 5]) {
  test('sequential read with a ' + pieces + '-piece cache downloads every piece once and leaks no selection', { timeout: 25000 }, async t => {
    const ctx = await realPeer(t, pieces * 16384, 256 * 1024);
    const result = await query(ctx.port, 'GET', ctx.url, null, {});
    assert.ok(result.data.equals(ctx.bytes), 'len ' + result.data.length);
    assert.equal(new Set(ctx.downloads).size, ctx.downloads.length, 'dupes: ' + ctx.downloads.join(','));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(ctx.engine.selection.map(s => s.from + ':' + s.priority).join(','), '', 'no selection left');
    assert.ok(ctx.service.status().cacheBytes <= pieces * 16384);
  });
}

test('chunked sequential Range requests (player style) download every piece once', { timeout: 25000 }, async t => {
  const ctx = await realPeer(t, 3 * 16384, 256 * 1024);
  for (let from = 0; from < 256 * 1024; from += 10000) {
    const to = Math.min(256 * 1024 - 1, from + 9999);
    const result = await query(ctx.port, 'GET', ctx.url, null, { Range: 'bytes=' + from + '-' + to });
    assert.deepEqual(result.data, ctx.bytes.slice(from, to + 1));
  }
  assert.equal(new Set(ctx.downloads).size, ctx.downloads.length, 'dupes: ' + ctx.downloads.join(','));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(ctx.engine.selection.map(s => s.from + ':' + s.priority).join(','), '', 'no selection left');
});

test('overlapping Range requests (new opened before old closed) stay correct', { timeout: 25000 }, async t => {
  const ctx = await realPeer(t, 3 * 16384, 256 * 1024);
  const first = new Promise(resolve => { const r = http.get({ hostname: '127.0.0.1', port: ctx.port, path: ctx.url, headers: { Range: 'bytes=0-' } }, res => { res.on('data', () => {}); res.on('error', () => resolve()); res.on('close', resolve); }); r.on('error', () => resolve()); });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await query(ctx.port, 'GET', ctx.url, null, { Range: 'bytes=100000-200000' });
  assert.deepEqual(second.data, ctx.bytes.slice(100000, 200001));
  await first;
  const third = await query(ctx.port, 'GET', ctx.url, null, { Range: 'bytes=0-50000' });
  assert.deepEqual(third.data, ctx.bytes.slice(0, 50001));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(ctx.engine.selection.filter(s => s.priority === 1).map(s => s.from).join(','), '', 'no read selection left');
  assert.ok(ctx.engine.selection.length <= 2, JSON.stringify(ctx.engine.selection.map(s => s.from + ':' + s.priority)));
});
