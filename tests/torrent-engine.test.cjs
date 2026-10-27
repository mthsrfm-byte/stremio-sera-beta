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
    assert.ok(service.status().cacheBytes <= 64 * 1024);
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

test('repeated aborted ranges discard partial pieces instead of accumulating buffers', { timeout: 5000 }, async t => {
  const EventEmitter = require('events');
  let engine, partial = 0, discarded = 0;
  const service = createService({ engineFactory: function () {
    engine = new EventEmitter();
    engine.files = [{ name: 'partial.mp4', offset: 0, length: 1024 * 1024, deselect() {} }];
    engine.torrent = { pieceLength: 16384 };
    engine.bitfield = { get() { return false; } };
    engine.swarm = { wires: [], downloaded: 0, _peers: {}, downloadSpeed() { return 0; } };
    engine.connect = engine.deselect = engine.destroy = function () {};
    engine.partialBytes = () => partial;
    engine.forgetPiece = (index, resetPartial) => { if (resetPartial) { discarded++; partial = 0; } };
    engine.select = function () { partial += 8192; engine.emit('selected'); };
    setImmediate(() => engine.emit('ready'));
    return engine;
  } });
  t.after(() => service.close());
  const server = http.createServer((req, res) => service.handle(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const response = await query(port, 'POST', '/api/torrent/start', { sessionId: 'partial-test', infoHash: 'a'.repeat(40) });
  const url = JSON.parse(response.data).url;
  for (let n = 0; n < 6; n++) {
    const selected = once(engine, 'selected');
    const req = http.get({ hostname: '127.0.0.1', port, path: url, headers: { Range: 'bytes=' + (n * 16384) + '-' } });
    req.on('error', () => {});
    await selected;
    req.destroy();
    // Wait until the server has received the close, without guessing a fixed delay.
    for (let tries = 0; partial && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(service.status().partialBytes, 0);
  }
  assert.equal(discarded, 6);
});
