'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(name) {
  return fs.readFileSync(path.join(__dirname, '../src/js/views/' + name + '.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function tick() { for (let i = 0; i < 18; i++) await Promise.resolve(); }
const A = { transportUrl: 'https://a.test/manifest.json' };
const B = { transportUrl: 'https://b.test/manifest.json' };

function collectionHarness() {
  const request = deferred(), all = [], rankingCalls = [], timers = [];
  let callback, alive = true, checks = 0;
  const context = vm.createContext({
    Promise,
    addons: { fetchStreams: (type, id, onAddon) => { callback = onAddon; return request.promise; } },
    server: { nativeEnabled: () => true, isAvailable: () => false, check: () => { checks++; return Promise.resolve({ ok: false }); } },
    si: {
      // Deliberately reject the remembered heavy source; the view cannot bypass ranking.
      rememberedStream: () => ({ id: 'remembered-heavy' }),
      smartPick: (list, serverOk, ctx) => { rankingCalls.push({ list: list.slice(), serverOk, ctx }); return { stream: list.find(s => s.id === 'healthy') }; },
    },
    setTimeout: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout: timer => { timer.cancelled = true; },
  });
  vm.runInContext(source('details'), context);
  return {
    all, request, rankingCalls, timers,
    choose: () => context.chooseLightStream('movie', 'title', [A, B], all, { videoId: 'title', runtimeMinutes: 120 }, () => alive),
    respond: (addon, streams) => callback(addon, streams),
    close: () => { alive = false; }, checks: () => checks,
  };
}

test('Light waits for all addons instead of immediately reopening the remembered source', async () => {
  const h = collectionHarness(), pick = h.choose();
  let resolved = false; pick.then(() => { resolved = true; });
  await tick();
  h.respond(A, [{ id: 'remembered-heavy' }]); await tick();
  assert.equal(resolved, false);
  h.respond(B, [{ id: 'healthy' }]); h.request.resolve();
  assert.equal((await pick).id, 'healthy');
  assert.equal(h.checks(), 0, 'native mode must not wait for an absent PC');
  assert.equal(h.rankingCalls[0].ctx.runtimeMinutes, 120);
  assert.deepEqual(h.rankingCalls[0].list.map(s => s.id), ['remembered-heavy', 'healthy']);
});

test('Light deadline ranks only arrived sources and late addons cannot change playback', async () => {
  const h = collectionHarness(), pick = h.choose(); await tick();
  h.respond(B, [{ id: 'healthy' }]);
  h.timers[0].fn();
  assert.equal((await pick).id, 'healthy');
  h.respond(A, [{ id: 'remembered-heavy' }]); h.request.resolve(); await tick();
  assert.equal(h.rankingCalls.length, 1);
  assert.equal(h.all.length, 2, 'late sources remain available for manual choice/fallback');
});

test('destroyed details cannot rank or reopen playback when addon responses finish', async () => {
  const h = collectionHarness(), pick = h.choose(); await tick();
  h.close(); h.respond(A, [{ id: 'healthy' }]); h.request.resolve();
  assert.equal(await pick, null);
  assert.equal(h.rankingCalls.length, 0);
  assert.equal(h.all.length, 0);
});

const FIRST = { infoHash: 'a'.repeat(40), fileIdx: 0 };
const DUPLICATE = { ...FIRST, addon: 'Other addon' };
const SECOND = { infoHash: 'b'.repeat(40), fileIdx: 0, resolution: '720p' };
const THIRD = { infoHash: 'c'.repeat(40), fileIdx: 0 };
function key(stream) { return stream.infoHash + ':' + stream.fileIdx; }
function playerHarness(options) {
  const o = options || {}, elements = [], requests = [], stopped = [], failed = [], ranking = [], dialogs = [], opened = [];
  let view, menuOptions, timerId = 0, sessionSequence = 0;
  const noop = () => {};
  function element(tag, props, children) {
    const el = {
      tag, props: props || {}, style: {}, children: [], listeners: {}, currentTime: 0, duration: NaN, paused: true,
      buffered: { length: 0 }, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      addEventListener(name, fn) { const previous = this.listeners[name]; this.listeners[name] = previous ? (...args) => { previous(...args); fn(...args); } : fn; }, removeEventListener: noop,
      getAttribute(name) { return this[name] || null; }, removeAttribute(name) { delete this[name]; },
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }, load: noop,
    };
    if (Array.isArray(children)) children.forEach(child => el.appendChild(child));
    elements.push(el); return el;
  }
  const videos = [{ id: 'ep1', season: 1, episode: 1 }, { id: 'ep2', season: 1, episode: 2 }];
  const ctx = vm.createContext({
    Promise, Date, Math, console, h: element, clear: el => { el.children = []; },
    nav: { KEY: { STOP: 413 }, current: () => null, focus: noop, topLayer: () => ({ root: view.el }), pushLayer: () => ({}), popLayer: noop },
    subs: { Renderer: () => ({ clear: noop, set: noop, update: noop, setOffset: noop, offset: () => 0, active: () => false }) },
    substyle: { apply: noop }, subpick: { videoInfo: () => Promise.resolve({}), extra: () => ({}), rank: () => [] },
    store: { settings: () => ({ nativeTorrent: true, lowMemory: true, subtitleLangs: [], audioLangs: [] }), get: (key, fallback) => fallback, set: noop },
    log: { info: noop, warn: noop }, getJSON: () => Promise.resolve({}), getText: () => Promise.resolve(''), clearCache: noop,
    si: { parse: s => ({ res: s.resolution || '1080p' }), summary: () => '', rememberStream: noop,
      choiceLabel: 'Smart Choice . Light', choiceContext: (meta, video) => ({ videoId: video.id, runtimeMinutes: 45 }),
      markFailed: stream => failed.push(stream), wasTried: (stream, tried) => tried.some(s => key(s) === key(stream)),
      lightFileError: () => '', smartPick: (list, ok, context) => { ranking.push({ list: list.slice(), context }); return list.length ? { stream: list[0] } : null; } },
    hlsplay: { isHls: () => false }, calendar: { startingWithin: () => [] },
    server: { nativeEnabled: () => true, isTorrent: stream => !!stream.infoHash, isAvailable: () => false, needsServer: () => false,
      createNativeSessionId: () => 'session-' + (++sessionSequence), stopNative: id => { stopped.push(id); return Promise.resolve(); },
      toPlayable: (stream, series, options) => { const d = deferred(); requests.push({ stream, options, ...d }); return d.promise; } },
    addons: { isTubeStream: () => false, fetchSubtitles: () => Promise.resolve([]), fetchStreams: () => Promise.resolve(o.nextStreams || []) },
    stremio: { saveProgress: noop }, skip: {}, hero: { logo: () => '', background: () => '' },
    menu: (title, items, options) => { menuOptions = options; }, toast: noop, fmtTime: () => '', timeHM: () => '',
    choiceDialog: (...args) => dialogs.push(args), eventTime: () => '', isFavorite: () => false, toggleFavorite: () => Promise.resolve(),
    router: { tabView: () => null, pop: noop }, sortedVideos: () => videos, openDetails: (...args) => opened.push(args), t: value => value,
    IS_WEB: false, __KAI_DEVLOG__: '', Image: function () { return element('image'); }, requestAnimationFrame: fn => fn(),
    setTimeout: () => ++timerId, clearTimeout: noop, setInterval: () => ++timerId, clearInterval: noop,
    document: { createTextNode: value => value, getElementById: () => element('app') },
  });
  vm.runInContext(source('player'), ctx);
  const opts = { meta: { id: 'dev', type: o.isSeries ? 'series' : 'movie', name: 'Test' }, video: o.isSeries ? videos[0] : { id: 'dev' },
    stream: o.automatic ? undefined : FIRST, pick: o.automatic ? Promise.resolve(FIRST) : undefined,
    streams: [FIRST, DUPLICATE, SECOND, THIRD], isSeries: !!o.isSeries };
  view = ctx.PlayerView(opts);
  const video = elements.find(el => el.tag === 'video');
  const button = elements.find(el => el.props.html && el.props.html.includes('Fontes'));
  return { view, video, requests, stopped, failed, ranking, dialogs, opened,
    switchManual(index) { button.props.onSelect(); menuOptions.onPick(index); } };
}

test('metadata failure retries Light sources by identity, can downgrade resolution, and stops after two alternatives', async () => {
  const h = playerHarness({ automatic: true }); h.view.onShow(); await tick();
  h.requests[0].reject(new Error('Torrent excede os limites da TV')); await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].stream, SECOND, 'same hash/file alias must not be retried');
  assert.equal(h.ranking[0].context.videoId, 'dev');
  assert.equal(typeof h.requests[1].options.validateFile, 'function');
  h.requests[1].reject(new Error('Sem dados')); await tick();
  assert.equal(h.requests.length, 3);
  h.requests[2].reject(new Error('Sem metadados')); await tick();
  assert.equal(h.requests.length, 3, 'initial plus only two alternatives');
  assert.equal(h.failed.length, 3);
  assert.ok(h.stopped.includes('session-1') && h.stopped.includes('session-2') && h.stopped.includes('session-3'));
  assert.equal(h.dialogs.length, 1);
  h.view.destroy();
});

test('an unavailable TV service is not treated as a bad torrent and does not start other sessions', async () => {
  const h = playerHarness({ automatic: true }); h.view.onShow(); await tick();
  h.requests[0].reject(Object.assign(new Error('Service unavailable'), { unavailable: true })); await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.failed.length, 0);
  h.view.destroy();
});

test('manual source selection bypasses automatic file validation and ignores stale preparation failures', async () => {
  const h = playerHarness({ automatic: true }); h.view.onShow(); await tick();
  assert.equal(typeof h.requests[0].options.validateFile, 'function');
  h.switchManual(2);
  assert.equal(h.requests[1].options.validateFile, null);
  h.requests[0].reject(new Error('Old source failed')); await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.failed.length, 0);
  h.view.destroy();
});

test('next episode is reranked with its own duration context instead of preserving bingeGroup unconditionally', async () => {
  const heavy = { ...FIRST, behaviorHints: { bingeGroup: 'same' } };
  const healthy = { ...SECOND, behaviorHints: { bingeGroup: 'other' } };
  const h = playerHarness({ isSeries: true, nextStreams: [healthy, heavy] });
  h.view.onShow(); h.video.listeners.ended(); await tick();
  assert.equal(h.ranking[0].context.videoId, 'ep2');
  assert.equal(h.requests[h.requests.length - 1].stream, healthy);
  assert.equal(typeof h.requests[h.requests.length - 1].options.validateFile, 'function');
  h.view.destroy();
});


test('next episode without Light candidates opens the manual list directly', async () => {
  const h = playerHarness({ isSeries: true, nextStreams: [] });
  h.view.onShow(); h.video.listeners.ended(); await tick();
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0][2].videoId, 'ep2');
  assert.equal(h.opened[0][2].manualStreams, true);
  h.view.destroy();
});
