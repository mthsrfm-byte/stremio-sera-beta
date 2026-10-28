'use strict';
// Review harness: player.js with real event dispatch and manually fired timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const fs = require('node:fs');

async function tick() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function harness(o) {
  const opts = o || {};
  const elements = [];
  const timers = new Map();
  let timerId = 0;
  const calls = { report: [], markFailed: [], probe: [], layers: 0, toPlayable: [] };
  function element(tag, props, children) {
    const listeners = {};
    const el = {
      tag, props: props || {}, style: {}, children: [], currentTime: 0, duration: NaN, paused: true, readyState: 0,
      buffered: { length: 0 }, error: null,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(child) { this.children.push(child); return child; },
      insertBefore(child) { this.children.push(child); return child; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener(type, fn) { const l = listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
      fire(type) { (listeners[type] || []).slice().forEach(fn => fn({ type })); },
      getAttribute(key) { return this[key] || null; },
      setAttribute(key, v) { this[key] = v; },
      removeAttribute(key) { delete this[key]; },
      pause() { if (!this.paused) { this.paused = true; this.fire('pause'); } }, play() { this.paused = false; return Promise.resolve(); }, load() {},
    };
    if (props && props.style) Object.assign(el.style, props.style);
    if (Array.isArray(children)) children.forEach(child => child && el.appendChild(child));
    elements.push(el);
    return el;
  }
  const settings = { nativeTorrent: true, lowMemory: true, subtitleLangs: [], audioLangs: [], skipMode: 'off' };
  const noop = () => {};
  const first = opts.first || { url: 'https://cdn.example/a.mkv', name: 'A', addon: 'X' };
  const second = { url: 'https://cdn.example/b.mkv', name: 'B', addon: 'X' };
  let menuOpts = null;
  const context = vm.createContext({
    Promise, Date, Math, console, isFinite, Number, String, Object, Array, JSON, RegExp, Error,
    h: element, clear: el => { el.children = []; }, KEY: { STOP: 413, PAUSE: 19, PLAY: 415, PLAYPAUSE: 10252, ENTER: 13, BACK: 10009 },
    nav: { KEY: { STOP: 413, PAUSE: 19, PLAY: 415, PLAYPAUSE: 10252, ENTER: 13 }, current: () => null, focus: noop, topLayer: () => ({ root: null }), pushLayer: () => { calls.layers++; return {}; }, popLayer: noop },
    subs: { Renderer: () => ({ clear: noop, set: noop, update: noop, setOffset: noop, offset: () => 0, active: () => false }) },
    substyle: { apply: noop },
    subpick: { videoInfo: () => Promise.resolve(null), extra: () => ({}), rank: () => [] },
    store: { settings: () => settings, get: (key, fallback) => fallback, set: noop },
    log: { info: noop, warn: noop },
    getJSON: () => Promise.resolve({}), getText: () => Promise.resolve(''), clearCache: noop,
    si: { parse: () => ({}), summary: () => 's', rememberStream: noop, choiceContext: () => ({}), choiceLabel: 'L', markFailed: s => calls.markFailed.push(s), wasTried: (value, list) => list.indexOf(value) >= 0,
      smartPick: list => (list[0] ? { stream: list[0] } : null), lightFileError: () => '' },
    hlsplay: { isHls: () => false },
    avplayer: { playerName: () => 'html5', create: () => element('video') },
    formats: { report: (s, p, ok) => calls.report.push([s.name, ok]), verdict: () => '' },
    notice: { probe: (u) => { calls.probe.push(u); return Promise.resolve(null); }, NOTICE_MAX_SECONDS: 120, accountWide: () => false, sameAccount: () => false, message: k => 'notice:' + k },
    calendar: { startingWithin: () => [] },
    server: {
      nativeEnabled: () => false, isTorrent: v => !!v.infoHash, isAvailable: () => false, needsServer: () => false,
      createNativeSessionId: () => 's', stopNative: () => Promise.resolve(),
      toPlayable: (value) => { calls.toPlayable.push(value.name); return Promise.resolve({ url: value.url, viaServer: false }); },
      check: () => Promise.resolve({ ok: true }), nativeStatus: () => Promise.resolve(null), streamProgress: () => Promise.resolve(null),
      baseUrl: () => '',
    },
    addons: { fetchSubtitles: () => Promise.resolve([]), isTubeStream: () => false, CINEMETA: 'x', fetchStreams: () => Promise.resolve([]) },
    stremio: { saveProgress: noop }, skip: { getSegments: () => Promise.resolve([]) },
    hero: { logo: () => '', background: () => '' },
    menu: (title, items, options) => { menuOpts = options; },
    toast: noop, fmtTime: () => '', timeHM: () => '', choiceDialog: (...a) => { calls.dialog = a; }, eventTime: () => '',
    isFavorite: () => false, toggleFavorite: () => Promise.resolve(),
    router: { tabView: () => null, pop: noop }, sortedVideos: () => [], openDetails: noop,
    t: value => value, IS_WEB: false, __KAI_DEVLOG__: '',
    Image: function () { return element('image'); },
    requestAnimationFrame: fn => fn(),
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++timerId, clearInterval: noop,
    document: { createTextNode: v => v, getElementById: () => element('app'), documentElement: element('html'), body: element('body') },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/js/views/player.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  new vm.Script(source, { filename: 'player.js' }).runInContext(context);
  const view = context.PlayerView(Object.assign({ meta: { id: 'tt1', type: 'movie', name: 'Test' }, video: { id: 'tt1' }, stream: first, streams: [first, second] }, opts.view || {}));
  const video = elements.find(el => el.tag === 'video');
  const sourceButton = elements.find(el => el.props.html && el.props.html.includes('Fontes'));
  return {
    view, video, calls, timers, context,
    fireTimers(ms) { Array.from(timers.entries()).filter(([, t]) => t.ms === ms).forEach(([id, t]) => { timers.delete(id); t.fn(); }); },
    play(seconds) { video.paused = false; for (let i = 0; i < seconds * 4; i++) { video.currentTime += 0.25; video.fire('timeupdate'); } },
    switchSource() { sourceButton.props.onSelect(); menuOpts.onPick(1); },
  };
}

test('REVIEW user pause carried into a new source blocks the slow prompt forever', async () => {
  const h = harness();
  h.view.onShow();
  await tick();
  h.play(3);
  h.view.onKey(19); // KEY.PAUSE by the viewer
  h.switchSource(); // picks another source while paused; it autoplays (not paused) but never starts
  await tick();
  h.video.paused = false;
  const before = h.calls.layers;
  for (let i = 0; i < 3; i++) h.fireTimers(45000);
  await tick();
  assert.ok(h.calls.layers > before, 'slow prompt must appear for a new source that never starts');
});

test('REVIEW a legit short episode (under 2 min) is treated as a debrid notice and skipped', async () => {
  const h = harness({ view: { meta: { id: 'tt2', type: 'series', name: 'Shorts' }, video: { id: 'tt2:1:1', season: 1, episode: 1 }, isSeries: true } });
  h.view.onShow();
  await tick();
  h.video.duration = 110; h.video.readyState = 4;
  h.play(3);
  await tick();
  assert.equal(h.calls.markFailed.length, 0, 'short real episode must not be marked failed: ' + JSON.stringify(h.calls));
});

test('REVIEW a short clip whose title should last 45 min is still a debrid notice', async () => {
  const h = harness({ view: { meta: { id: 'tt3', type: 'series', name: 'Long' }, video: { id: 'tt3:1:1', season: 1, episode: 1 }, isSeries: true } });
  h.context.si.choiceContext = () => ({ runtimeMinutes: 45, runtimeEstimated: false });
  h.view.onShow();
  await tick();
  h.video.duration = 60; h.video.readyState = 4;
  h.play(3);
  await tick();
  assert.equal(h.calls.markFailed.length, 1);
  assert.deepEqual(h.calls.toPlayable, ['A', 'B']);
});

test('REVIEW a short real episode still advances on ended', async () => {
  const h = harness({ view: { meta: { id: 'tt2', type: 'series', name: 'Shorts' }, video: { id: 'tt2:1:1', season: 1, episode: 1 }, isSeries: true } });
  let popped = 0; h.context.router.pop = () => popped++;
  h.view.onShow();
  await tick();
  h.video.duration = 100;
  h.play(3);
  await tick();
  h.video.fire('ended');
  await tick();
  assert.equal(popped, 1);
  assert.deepEqual(h.calls.report, [['A', true]]);
});
