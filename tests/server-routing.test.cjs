'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { build } = require('esbuild');

const HASH = '0123456789abcdef0123456789abcdef01234567';
const LOCAL = 'http://127.0.0.1:8094/api/torrent/';

async function harness(options) {
  const o = options || {};
  const calls = [];
  const settings = Object.assign({ nativeTorrent: true, serverUrl: '' }, o.settings);
  const mock = {
    settings,
    t: (message, args) => Object.keys(args || {}).reduce((s, key) => s.split('{' + key + '}').join(String(args[key])), message),
    getTvIp: () => Promise.resolve('192.0.2.100'),
    getJSON: (url, opts) => {
      calls.push({ method: 'GET', url, opts });
      return Promise.resolve().then(() => o.request ? o.request('GET', url, null, opts) : {});
    },
    postJSON: (url, body, opts) => {
      calls.push({ method: 'POST', url, body, opts });
      return Promise.resolve().then(() => o.request ? o.request('POST', url, body, opts) : { sessionId: body.sessionId, url: LOCAL + 'stream/' + body.sessionId + '/0' });
    },
  };
  const result = await build({
    entryPoints: [path.join(__dirname, '../src/js/api/server.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [{
      name: 'routing-test-dependencies',
      setup(b) {
        b.onResolve({ filter: /\.\.\/lib\/(http|store|tv|i18n|platform)\.js$/ }, args => ({ path: args.path, namespace: 'mock' }));
        b.onLoad({ filter: /.*/, namespace: 'mock' }, args => {
          if (args.path.endsWith('/http.js')) return { contents: 'export const getJSON = __harness.getJSON; export const postJSON = __harness.postJSON;' };
          if (args.path.endsWith('/store.js')) return { contents: 'export const settings = () => __harness.settings;' };
          if (args.path.endsWith('/tv.js')) return { contents: 'export const getTvIp = __harness.getTvIp;' };
          if (args.path.endsWith('/i18n.js')) return { contents: 'export const t = __harness.t;' };
          return { contents: 'export const IS_WEB = ' + !!o.isWeb + ';' };
        });
      },
    }],
  });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, __harness: mock, Promise, Date, Math });
  return { api: module.exports, calls, settings };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('native torrents remain playable without advertising external server availability', async () => {
  const { api, calls } = await harness();
  assert.equal(api.nativeEnabled(), true);
  assert.equal(api.isTorrent({ infoHash: HASH }), true);
  assert.equal(api.needsServer({ infoHash: HASH }), false);
  assert.equal(api.isAvailable(), false);
  const media = await api.toPlayable({ infoHash: HASH, fileIdx: 2, sources: ['tracker:udp://tracker.example.test:80'] }, { season: 1, episode: 3 }, { sessionId: 'test-local' });
  assert.deepEqual(plain(media), { url: LOCAL + 'stream/test-local/0', viaServer: false, viaNative: true, sessionId: 'test-local' });
  assert.deepEqual(plain(calls[0].body), { infoHash: HASH, fileIdx: 2, sources: ['tracker:udp://tracker.example.test:80'], season: 1, episode: 3, sessionId: 'test-local' });
  assert.equal(calls[0].url, LOCAL + 'start');
  assert.equal(api.isAvailable(), false);
});

test('HTTP URL takes precedence over informational torrent hash', async () => {
  const { api, calls } = await harness();
  const stream = { url: 'https://media.example.test/video.mp4', infoHash: HASH };
  assert.equal(api.isTorrent(stream), false);
  assert.equal(api.needsServer(stream), false);
  const media = await api.toPlayable(stream);
  assert.equal(media.url, stream.url);
  assert.equal(media.viaNative, false);
  assert.equal(calls.length, 0);
});

test('disabling native mode preserves external torrent creation and explicit file index', async () => {
  const { api, calls } = await harness({ settings: { nativeTorrent: false, serverUrl: '192.0.2.10' }, request: () => ({ guessedFileIdx: 5 }) });
  assert.equal(api.needsServer({ infoHash: HASH }), true);
  const media = await api.toPlayable({ infoHash: HASH, fileIdx: 1, sources: ['udp://tracker.example.test:80'] });
  assert.equal(media.viaServer, true);
  assert.match(media.url, /^http:\/\/192\.0\.2\.10:11470\/0123/);
  assert.ok(media.url.includes('/1?'));
  assert.equal(calls[0].body.guessFileIdx, false);
  assert.equal(calls.some(c => c.url.startsWith(LOCAL)), false);
});

test('web build never attempts the Samsung local torrent engine', async () => {
  const { api, calls } = await harness({ isWeb: true });
  assert.equal(api.nativeEnabled(), false);
  assert.equal(api.needsServer({ infoHash: HASH }), true);
  await assert.rejects(api.toPlayable({ infoHash: HASH }), /servidor Stremio externo/);
  assert.equal(calls.length, 0);
});

test('magnet converts base32 and preserves trackers while rejecting invalid hash', async () => {
  const { api, calls } = await harness();
  await api.toPlayable({ url: 'magnet:?xt=urn:btih:' + 'A'.repeat(32) + '&tr=udp%3A%2F%2Ftracker.example.test%3A80&tr=%ZZ' }, null, { sessionId: 'magnet-test' });
  assert.equal(calls[0].body.infoHash, '0'.repeat(40));
  assert.deepEqual(plain(calls[0].body.sources), ['tracker:udp://tracker.example.test:80']);
  await assert.rejects(api.toPlayable({ url: 'magnet:?xt=urn:btih:not-a-valid-hash' }), /inválido/);
  assert.equal(calls.filter(c => c.url.endsWith('/start')).length, 1);
});

test('proxy headers keep their external-server requirement', async () => {
  const { api, settings, calls } = await harness();
  const stream = { url: 'https://media.example.test/video.mp4', behaviorHints: { proxyHeaders: { request: { Referer: 'https://example.test/' } } } };
  assert.equal(api.needsServer(stream), true);
  await assert.rejects(api.toPlayable(stream), /exige proxy/);
  settings.serverUrl = '192.0.2.20';
  const media = await api.toPlayable(stream);
  assert.equal(media.viaServer, true);
  assert.equal(media.viaNative, false);
  assert.match(media.url, /^http:\/\/192\.0\.2\.20:11470\/proxy\//);
  assert.equal(calls.length, 0);
});

test('cancelled late start stops only its own session', async () => {
  let resolveOld;
  const { api, calls } = await harness({ request: (method, url, body) => {
    if (url.endsWith('/stop')) return { ok: true };
    if (body.sessionId === 'old') return new Promise(resolve => { resolveOld = resolve; });
    return { sessionId: body.sessionId, url: LOCAL + 'stream/' + body.sessionId + '/0' };
  } });
  let current = true;
  const old = api.toPlayable({ infoHash: HASH }, null, { sessionId: 'old', isCurrent: () => current });
  const rejected = assert.rejects(old, error => error.cancelled === true);
  await Promise.resolve();
  current = false;
  const latest = await api.toPlayable({ infoHash: HASH }, null, { sessionId: 'new' });
  resolveOld({ sessionId: 'old', url: LOCAL + 'stream/old/0' });
  await rejected;
  await Promise.resolve();
  assert.equal(latest.sessionId, 'new');
  const stops = calls.filter(c => c.url.endsWith('/stop'));
  assert.ok(stops.length > 0);
  assert.ok(stops.every(c => c.body.sessionId === 'old'));
  const before = calls.length;
  await api.stopNative('');
  assert.equal(calls.length, before);
});

test('local media never goes to external ffprobe or OpenSubtitles hash endpoints', async () => {
  const { api, calls } = await harness({ settings: { serverUrl: '192.0.2.10' } });
  await api.check();
  assert.equal(api.isAvailable(), true);
  const count = calls.length;
  const url = LOCAL + 'stream/current/0';
  assert.equal(api.isNativeMediaUrl(url), true);
  assert.equal(await api.tracks(url), null);
  assert.equal(await api.opensubHash(url), null);
  assert.equal(calls.length, count);
});

function deferred() {
  let resolve;
  const promise = new Promise(ok => { resolve = ok; });
  return { promise, resolve };
}
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function playerHarness() {
  const fs = require('node:fs');
  const requests = [];
  const stopped = [];
  const events = [];
  const elements = [];
  let nextId = 0;
  let timerId = 0;
  const stream = { infoHash: HASH };
  const second = { infoHash: 'abcdef0123456789abcdef0123456789abcdef0123' };
  let view;
  let currentMenu;
  function element(tag, props, children) {
    const el = {
      tag, props: props || {}, style: {}, children: [], currentTime: 0, duration: NaN, paused: true,
      buffered: { length: 0 },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      addEventListener() {}, removeEventListener() {},
      getAttribute(key) { return this[key] || null; },
      removeAttribute(key) { delete this[key]; },
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }, load() {},
    };
    if (props && props.style) Object.assign(el.style, props.style);
    if (Array.isArray(children)) children.forEach(child => el.appendChild(child));
    elements.push(el);
    return el;
  }
  const clear = el => { el.children = []; };
  const settings = { nativeTorrent: true, lowMemory: true, subtitleLangs: [], audioLangs: [] };
  const noop = () => {};
  const context = vm.createContext({
    Promise, Date, Math, console,
    h: element, clear,
    nav: { KEY: { STOP: 413 }, current: () => null, focus: noop, topLayer: () => ({ root: view.el }), pushLayer: () => ({}), popLayer: noop },
    subs: { Renderer: () => ({ clear: noop, set: noop, update: noop, setOffset: noop, offset: () => 0, active: () => false }) },
    substyle: { apply: noop },
    subpick: { videoInfo: () => Promise.resolve({}), extra: () => ({}), rank: () => [] },
    store: { settings: () => settings, get: (key, fallback) => fallback, set: noop },
    log: { info: noop, warn: noop },
    getJSON: () => Promise.resolve({}), getText: () => Promise.resolve(''), clearCache: () => events.push('clear-cache'),
    si: { parse: () => ({}), summary: () => '', rememberStream: noop },
    hlsplay: { isHls: () => false },
    calendar: { startingWithin: () => [] },
    server: {
      nativeEnabled: () => true,
      isTorrent: value => !!value.infoHash,
      isAvailable: () => false,
      needsServer: () => false,
      createNativeSessionId: () => 'player-' + (++nextId),
      stopNative: id => { stopped.push(id); return Promise.resolve(); },
      toPlayable: (value, series, options) => {
        events.push('start-' + options.sessionId);
        const d = deferred();
        requests.push({ value, options, ...d });
        return d.promise;
      },
    },
    addons: { fetchSubtitles: () => Promise.resolve([]) }, stremio: { saveProgress: noop }, skip: {},
    hero: { logo: () => '', background: () => '' },
    menu: (title, items, options) => { currentMenu = options; },
    toast: noop, fmtTime: () => '', timeHM: () => '', choiceDialog: noop, eventTime: () => '',
    isFavorite: () => false, toggleFavorite: () => Promise.resolve(),
    router: { tabView: id => ({ freeMemory: () => events.push('free-' + id) }), pop: noop },
    sortedVideos: () => [], openDetails: noop,
    t: value => value, IS_WEB: false, __KAI_DEVLOG__: '',
    Image: function () { return element('image'); },
    requestAnimationFrame: fn => fn(),
    setTimeout: () => ++timerId, clearTimeout: noop, setInterval: () => ++timerId, clearInterval: noop,
    document: { createTextNode: value => value, getElementById: () => element('app') },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/js/views/player.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  new vm.Script(source, { filename: 'player.js' }).runInContext(context);
  view = context.PlayerView({ meta: { id: 'dev', type: 'movie', name: 'Test' }, video: { id: 'dev' }, stream, streams: [stream, second] });
  const video = elements.find(el => el.tag === 'video');
  const sourceButton = elements.find(el => el.props.html && el.props.html.includes('Fontes'));
  return {
    view, video, requests, stopped, events,
    switchSource() { sourceButton.props.onSelect(); currentMenu.onPick(1); },
  };
}

test('player releases background memory before starting native torrent and scopes teardown', async () => {
  const h = playerHarness();
  h.view.onShow();
  assert.deepEqual(h.events.slice(0, 5), ['free-home', 'free-recommended', 'free-streamings', 'clear-cache', 'start-player-1']);
  assert.equal(h.requests.length, 1);
  h.view.destroy();
  assert.deepEqual(h.stopped, ['player-1']);
  h.requests[0].resolve({ url: LOCAL + 'stream/player-1/0', viaNative: true, sessionId: 'player-1' });
  await tick();
  assert.equal(h.video.src, undefined, 'late metadata must not restart a destroyed player');
  assert.ok(h.stopped.every(id => id === 'player-1'));
});

test('switching native source ignores old metadata and does not stop the new session', async () => {
  const h = playerHarness();
  h.view.onShow();
  h.switchSource();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].options.isCurrent(), false);
  assert.equal(h.requests[1].options.isCurrent(), true);
  assert.deepEqual(h.stopped, ['player-1']);
  h.requests[1].resolve({ url: LOCAL + 'stream/player-2/0', viaNative: true, sessionId: 'player-2' });
  await tick();
  assert.equal(h.video.src, LOCAL + 'stream/player-2/0');
  h.requests[0].resolve({ url: LOCAL + 'stream/player-1/0', viaNative: true, sessionId: 'player-1' });
  await tick();
  assert.equal(h.video.src, LOCAL + 'stream/player-2/0');
  assert.ok(h.stopped.every(id => id === 'player-1'));
  h.view.destroy();
  assert.equal(h.stopped[h.stopped.length - 1], 'player-2');
});
