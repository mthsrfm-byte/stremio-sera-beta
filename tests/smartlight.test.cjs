'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { buildSync } = require('esbuild');

function harness() {
  const storage = new Map();
  const mock = {
    settings: () => ({ audioLangs: [] }), get: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    set: (key, value) => storage.set(key, value),
    isTorrent: (s) => typeof s.url === 'string' ? /^magnet:/i.test(s.url) : typeof s.infoHash === 'string',
    isPlayableType: (s) => !!s && (typeof s.url === 'string' || typeof s.infoHash === 'string'),
    needsServer: () => false,
    player: 'avplay',
    learned: {},
    formats: { verdict: (s, player) => mock.learned[player + ':' + s.infoHash] || '' },
  };
  const source = require('fs').readFileSync(path.join(__dirname, '../src/js/lib/streaminfo.js'), 'utf8')
    .replace("import * as server from '../api/server.js';", 'const server = __mock;')
    .replace("import * as store from './store.js';", 'const store = __mock;')
    .replace("import * as formats from './formats.js';", 'const formats = __mock.formats;')
    .replace("import { playerName } from './avplayer.js';", 'const playerName = () => __mock.player;');
  const built = buildSync({ stdin: { contents: source, resolveDir: path.join(__dirname, '../src/js/lib') }, bundle: true, format: 'cjs', platform: 'node', write: false });
  const module = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, { module, __mock: mock, Date, Math, Map });
  module.exports.__mock = mock;
  return module.exports;
}
const api = harness();
const ctx = api.choiceContext({ runtime: '2h', id: 'movie' }, { id: 'movie' }, false);
function stream(id, options) {
  const o = Object.assign({ resolution: '1080p', seeds: 35, gb: 3, codec: 'x264 AAC' }, options);
  const hints = { filename: 'Movie.' + o.resolution + '.' + o.codec + '.mkv' };
  if (o.gb !== null) hints.videoSize = o.gb * 1e9;
  const s = { infoHash: id.repeat(40), fileIdx: 0, name: 'Test', title: hints.filename, behaviorHints: hints };
  if (o.seeds !== null) s.seeders = o.seeds;
  return s;
}
function pick(list, context) { return api.smartPick(list, false, context || ctx); }

test('healthy moderate 1080p beats huge files and automatic never picks 4K, REMUX or DV', () => {
  const good = stream('a');
  const bad = [stream('b', { gb: 20, seeds: 2000 }), stream('c', { resolution: '4K', seeds: 2000 }), stream('d', { codec: 'REMUX x264 AAC' }), stream('e', { codec: 'DV hevc AAC' })];
  assert.equal(pick(bad.concat(good)).stream, good);
  assert.equal(pick(bad), null);
});
test('healthy 720p beats weak 1080p, but similar healthy candidates prefer 1080p', () => {
  const hd = stream('a', { resolution: '720p', gb: 2, seeds: 100 });
  const weak = stream('b', { seeds: 2 });
  const full = stream('c', { seeds: 30 });
  assert.equal(pick([weak, hd]).stream, hd);
  assert.equal(pick([hd, full]).stream, full);
});
test('unknown seeds are unverified; zero seeds are never an automatic choice', () => {
  const unknown = stream('a', { seeds: null }), zero = stream('b', { seeds: 0 });
  assert.equal(pick([zero, unknown]).stream, unknown);
  assert.equal(pick([zero]), null);
  assert.equal(api.signal(null), 0);
});
test('seed count saturates and cannot compensate higher bitrate risk', () => {
  const modest = stream('a', { seeds: 12, gb: 3 }), big = stream('b', { seeds: 50000, gb: 9 });
  assert.equal(pick([big, modest]).stream, modest);
  const a = stream('a', { seeds: 100 }), b = stream('b', { seeds: 999999 });
  assert.equal(pick([b, a]).stream, a);
});
test('runtime changes the size budget and missing duration uses a bounded fallback', () => {
  const file = stream('a', { gb: 3 });
  assert.equal(pick([file], api.choiceContext({ runtime: '20 min' }, { id: 'short' }, true)), null);
  assert.ok(pick([file], ctx));
  assert.equal(pick([stream('b', { gb: 9 })], api.choiceContext({}, {}, false)), null);
  assert.equal(api.choiceContext({ runtime: 'PT1H30M' }, {}, false).runtimeMinutes, 90);
});
test('season pack size is not treated as a single episode and real file is validated', () => {
  const episode = api.choiceContext({ runtime: '45 min' }, { id: 'show:1:1' }, true);
  const pack = stream('a', { gb: null });
  pack.title = 'Show.S01.Complete.1080p.x264.AAC\n40 GiB\n👤 50';
  pack.behaviorHints.filename = 'Show.S01E01.1080p.x264.AAC.mkv';
  assert.equal(api.parse(pack).sizeScope, 'pack');
  assert.ok(pick([pack], episode));
  assert.equal(api.lightFileError(pack, { name: pack.behaviorHints.filename, length: 900 * 1024 * 1024 }, episode), '');
  assert.match(api.lightFileError(pack, { name: pack.behaviorHints.filename, length: 6e9 }, episode), /excede/);
});
test('known incompatible-only audio and unverified codecs stay manual; AAC mixed is considered with a penalty', () => {
  assert.equal(pick([stream('a', { codec: 'AV1 AAC' }), stream('b', { codec: 'x264 DTS' })]), null);
  const safe = stream('c', { codec: 'x264 AAC' }), mixed = stream('d', { codec: 'x264 AAC DTS' });
  assert.equal(pick([mixed, safe]).stream, safe);
});
test('tiny 1080p does not automatically beat a normal encode; unknown metadata remains eligible', () => {
  const tiny = stream('a', { gb: 0.3, seeds: 100 });
  const normal = stream('b', { gb: 3, seeds: 30 });
  assert.equal(pick([tiny, normal]).stream, normal);
  assert.ok(pick([stream('c', { gb: null, codec: '' })]));
});
test('previous source is only a tie-break and cannot override the Light limits or poor health', () => {
  const fresh = harness();
  const heavy = stream('b', { gb: 20 });
  fresh.rememberStream('movie', heavy);
  const safe = stream('a');
  assert.equal(fresh.smartPick([heavy, safe], false, ctx).stream, safe);
  const equal = stream('c');
  fresh.rememberStream('movie', equal);
  assert.equal(fresh.smartPick([safe, equal], false, ctx).stream, equal);
});
test('order of addons does not change the result and failed duplicate torrents are skipped', () => {
  const fresh = harness(), a = stream('a'), b = stream('b');
  assert.equal(fresh.smartPick([a, b], false, ctx).stream, fresh.smartPick([b, a], false, ctx).stream);
  fresh.markFailed(a, ctx);
  assert.equal(fresh.smartPick([a, b], false, ctx).stream, b);
  assert.ok(fresh.wasTried({ url: 'magnet:?xt=urn:btih:' + a.infoHash.toUpperCase() }, [a]));
  assert.equal(fresh.wasTried(Object.assign({}, a, { fileIdx: 1 }), [a]), false);
});
test('HTTP direct metadata hash is not mistaken for a torrent or penalized for absent seeds', () => {
  const direct = stream('a', { seeds: 0 }); direct.url = 'https://example.test/movie.mkv';
  assert.ok(pick([direct]));
});
test('AVC High10 stays manual while HEVC Main10 remains eligible', () => {
  const avc = stream('a', { codec: 'x264_Hi10P_AAC', seeds: 100 });
  const hevc = stream('b', { codec: 'HEVC_10bit_AAC', seeds: 30 });
  assert.equal(pick([avc, hevc]).stream, hevc);
  assert.equal(pick([stream('c', { codec: 'H.264 10bit AAC' })]), null);
});
test('different HTTP mirrors are not discarded as the same failed torrent', () => {
  const first = { addon: 'Direct', name: '1080p', url: 'https://one.test/video.mp4' };
  const mirror = Object.assign({}, first, { url: 'https://two.test/video.mp4' });
  assert.equal(api.wasTried(mirror, [first]), false);
  assert.equal(api.wasTried(first, [first]), true);
});
test('short videos use their actual duration instead of a film fallback', () => {
  const short = api.choiceContext({ runtime: '3 min' }, { id: 'short' }, false);
  assert.equal(short.runtimeMinutes, 3);
  assert.equal(pick([stream('a', { gb: 1 })], short), null);
});

test('formats learned on this TV leave failing profiles to manual choice and favour proven ones', () => {
  const a = stream('a'), b = stream('b', { seeds: 25 });
  api.__mock.learned = { ['avplay:' + a.infoHash]: 'bad' };
  assert.equal(pick([a, b]).stream, b, 'a profile that failed for good is not picked automatically');
  api.__mock.learned = { ['html5:' + a.infoHash]: 'bad' };
  assert.equal(pick([a, b]).stream, a, 'what fails in the other player does not count for this one');
  const c = stream('c', { seeds: 25 }), d = stream('d', { seeds: 25 });
  api.__mock.learned = { ['avplay:' + d.infoHash]: 'ok' };
  assert.equal(pick([c, d]).stream, d, 'a proven format wins a tie');
  api.__mock.learned = {};
});
