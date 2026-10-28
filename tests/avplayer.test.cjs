'use strict';
// AVPlay com cara de <video>, formatos aprendidos e avisos de debrid, sem TV: um webapis.avplay
// simulado registra as chamadas e o teste dispara os retornos da TV.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { buildSync } = require('esbuild');

function bundle(file, mocks) {
  const dir = path.join(__dirname, '../src/js/lib');
  const source = require('fs').readFileSync(path.join(dir, file), 'utf8')
    .replace("import * as store from './store.js';", 'const store = __mock.store;')
    .replace("import { t } from './i18n.js';", 'const t = __mock.t;');
  const built = buildSync({ stdin: { contents: source, resolveDir: dir }, bundle: true, format: 'cjs', platform: 'node', write: false });
  const device = mocks.device || new Map();
  const mock = Object.assign({
    store: { settings: () => mocks.settings || {}, getDevice: (k, f) => device.has(k) ? device.get(k) : f, setDevice: (k, v) => device.set(k, v) },
    t: (s, a) => Object.keys(a || {}).reduce((x, k) => x.split('{' + k + '}').join(String(a[k])), s),
  }, mocks);
  const module = { exports: {} };
  const ctx = Object.assign({ module, Date, Math, JSON, Promise, setTimeout, clearTimeout, Event, __mock: mock }, mocks.globals || {});
  vm.runInNewContext(built.outputFiles[0].text, ctx);
  return module.exports;
}

// Elemento mínimo com eventos de verdade (EventTarget do Node).
function fakeDocument() {
  const docListeners = {};
  function element(tag) {
    const target = new EventTarget();
    const attrs = {};
    return Object.assign(target, {
      tag, className: '', children: [],
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
      removeAttribute(k) { delete attrs[k]; },
    });
  }
  return {
    hidden: false,
    createElement: element,
    // Sem createEvent antigo: o módulo cai no new Event(), que o EventTarget do Node aceita.
    createEvent: () => { throw new Error('legacy createEvent not available'); },
    addEventListener: (name, fn) => { (docListeners[name] = docListeners[name] || []).push(fn); },
    removeEventListener: (name, fn) => { docListeners[name] = (docListeners[name] || []).filter((x) => x !== fn); },
    fire: (name) => (docListeners[name] || []).forEach((fn) => fn()),
    listeners: docListeners,
  };
}

function fakeAvplay() {
  const calls = [];
  let state = 'NONE';
  const av = {
    calls, listener: null, prepared: null, duration: 5400000, tracks: [], current: [], seekTimes: [],
    open(url) { calls.push(['open', url]); state = 'IDLE'; },
    close() { calls.push(['close']); state = 'NONE'; },
    stop() { calls.push(['stop']); if (state !== 'NONE') state = 'IDLE'; },
    setListener(l) { this.listener = l; },
    prepareAsync(ok, fail) { calls.push(['prepare']); this.prepared = { ok: () => { state = 'READY'; ok(); }, fail }; },
    play() { calls.push(['play']); state = 'PLAYING'; },
    pause() { calls.push(['pause']); state = 'PAUSED'; },
    seekTo(ms, ok) { calls.push(['seek', ms]); this.seekTimes.push(ms); ok(); },
    getState: () => state,
    getDuration() { return this.duration; },
    setDisplayRect() {}, setDisplayMethod() {},
    setBufferingParam(...args) { calls.push(['buffer'].concat(args)); },
    getTotalTrackInfo() { return this.tracks; },
    getCurrentStreamInfo() { return this.current; },
    setSelectTrack(type, index) { calls.push(['track', type, index]); },
    setSilentSubtitle(on) { calls.push(['silent', on]); },
    suspend() { calls.push(['suspend']); }, restore() { calls.push(['restore']); },
  };
  return av;
}

function avHarness(settings) {
  const av = fakeAvplay();
  const document = fakeDocument();
  const window = { webapis: { avplay: av, appcommon: { setScreenSaver() {}, AppCommonScreenSaverState: {} } } };
  const api = bundle('avplayer.js', { settings: Object.assign({ player: 'avplay', playerBuffer: 'normal' }, settings), device: new Map(), globals: { window, document } });
  const el = api.create();
  const events = [];
  ['loadedmetadata', 'canplay', 'playing', 'play', 'pause', 'waiting', 'timeupdate', 'seeking', 'seeked', 'ended', 'error'].forEach((name) => el.addEventListener(name, () => events.push(name)));
  return { api, av, el, events, document };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('AVPlay opens on src, reports metadata, seeks before playing and plays with autoplay', async () => {
  const { av, el, events } = avHarness();
  el.autoplay = true;
  el.addEventListener('loadedmetadata', () => { el.currentTime = 600; });
  el.src = 'http://127.0.0.1:8094/api/torrent/stream/s/0';
  assert.deepEqual(av.calls.slice(-2), [['open', 'http://127.0.0.1:8094/api/torrent/stream/s/0'], ['prepare']]);
  assert.equal(el.readyState, 0);
  assert.ok(Number.isNaN(el.duration));
  av.prepared.ok();
  assert.equal(el.duration, 5400);
  assert.equal(el.readyState, 4);
  assert.deepEqual(av.seekTimes, [600000]);
  assert.ok(events.indexOf('loadedmetadata') < events.indexOf('playing'));
  assert.equal(el.paused, false);
  assert.equal(av.calls.filter((c) => c[0] === 'play').length, 1);
  assert.equal(el.getAttribute('src'), 'http://127.0.0.1:8094/api/torrent/stream/s/0');
});

test('AVPlay time, pause, buffering and end map to the same events as <video>', () => {
  const { av, el, events } = avHarness();
  el.autoplay = true;
  el.src = 'http://x/video.mkv';
  av.prepared.ok();
  av.listener.oncurrentplaytime(12500);
  assert.equal(el.currentTime, 12.5);
  av.listener.onbufferingstart();
  av.listener.onbufferingcomplete();
  el.pause();
  assert.equal(el.paused, true);
  av.listener.onstreamcompleted();
  assert.equal(el.ended, true);
  assert.deepEqual(events.filter((e) => ['waiting', 'pause', 'ended'].indexOf(e) >= 0), ['waiting', 'pause', 'ended']);
});

test('AVPlay errors carry a <video>-like code: format, network or decode', () => {
  for (const [name, code] of [['PLAYER_ERROR_NOT_SUPPORTED_FILE', 4], ['PLAYER_ERROR_CONNECTION_FAILED', 2], ['PLAYER_ERROR_GENEREIC', 3]]) {
    const { av, el, events } = avHarness();
    el.src = 'http://x/a.mkv';
    av.prepared.fail({ name });
    assert.equal(el.error.code, code);
    assert.ok(el.error.message.indexOf(name) >= 0);
    assert.equal(events[events.length - 1], 'error');
  }
});

test('a transient error right after a seek resumes instead of failing', () => {
  const { av, el, events } = avHarness();
  el.autoplay = true;
  el.src = 'http://x/a.mkv';
  av.prepared.ok();
  el.currentTime = 30;
  av.listener.onerror('PLAYER_ERROR_SEEK_FAILED');
  assert.equal(events.indexOf('error'), -1);
  assert.equal(av.calls[av.calls.length - 1][0], 'play');
});

test('reopening waits for the TV to settle, and removing src closes the player', async () => {
  const { av, el } = avHarness();
  el.src = 'http://x/a.mkv';
  av.prepared.ok();
  el.src = 'http://x/b.mkv';
  assert.deepEqual(av.calls.slice(-2), [['stop'], ['close']], 'old stream closed at once');
  assert.equal(av.calls.filter((c) => c[0] === 'open').length, 1, 'new open waits');
  await wait(350);
  assert.deepEqual(av.calls[av.calls.length - 2], ['open', 'http://x/b.mkv']);
  el.removeAttribute('src');
  assert.equal(el.getAttribute('src'), null);
  assert.equal(av.calls[av.calls.length - 1][0], 'close');
});

test('late callbacks from a replaced stream are ignored', async () => {
  const { av, el, events } = avHarness();
  el.src = 'http://x/a.mkv';
  const old = av.prepared;
  const oldListener = av.listener;
  el.src = 'http://x/b.mkv';
  await wait(350);
  old.ok();
  oldListener.onerror('PLAYER_ERROR_GENEREIC');
  assert.equal(events.indexOf('loadedmetadata'), -1);
  assert.equal(events.indexOf('error'), -1);
});

test('audio tracks come from the file and switching selects the TV track', () => {
  const { av, el } = avHarness();
  el.src = 'http://x/a.mkv';
  av.tracks = [
    { type: 'VIDEO', index: 0, extra_info: '{}' },
    { type: 'AUDIO', index: 1, extra_info: '{"language":"eng","channels":"6","fourCC":"ac3"}' },
    { type: 'AUDIO', index: 2, extra_info: '{track_lang:"por", channels:2}' },
    { type: 'TEXT', index: 3, extra_info: '{"track_lang":"pob"}' },
  ];
  av.current = [{ type: 'AUDIO', index: 1 }];
  assert.equal(el.audioTracks.length, 0, 'nothing before the stream is ready');
  av.prepared.ok();
  const tracks = el.audioTracks;
  assert.deepEqual(plain(tracks.map((x) => [x.language, x.channels, x.enabled])), [['eng', 6, true], ['por', 2, false]]);
  tracks[1].enabled = true;
  assert.deepEqual(av.calls[av.calls.length - 1], ['track', 'AUDIO', 2]);
  assert.deepEqual(plain(el.avTextTracks().map((x) => [x.index, x.lang])), [[3, 'pob']]);
  const lines = [];
  assert.equal(el.avSelectText(3, (text, ms) => lines.push([text, ms])), true);
  av.listener.onsubtitlechange(1500, 'Olá');
  assert.deepEqual(lines, [['Olá', 1500]]);
  el.avSelectText(null);
  av.listener.onsubtitlechange(1500, 'depois de desligar');
  assert.equal(lines.length, 1);
});

test('a forward jump after a pause is taken back once, a repeated one passes', () => {
  const { av, el } = avHarness();
  el.autoplay = true;
  el.src = 'http://x/a.mkv';
  av.prepared.ok();
  av.listener.oncurrentplaytime(100000);
  el.pause();
  el.play();
  const before = av.seekTimes.length;
  av.listener.oncurrentplaytime(400000);
  assert.equal(av.seekTimes.length, before + 1, 'jump undone');
  assert.equal(av.seekTimes[av.seekTimes.length - 1], 100000);
  assert.equal(el.currentTime, 100);
});

test('buffer setting is applied before preparing and the app falls back without AVPlay', () => {
  const { av, el } = avHarness({ playerBuffer: 'most' });
  el.src = 'http://x/a.mkv';
  assert.deepEqual(av.calls.filter((c) => c[0] === 'buffer').map((c) => c[3]), [15, 20]);
  const none = bundle('avplayer.js', { settings: { player: 'avplay' }, device: new Map(), globals: { window: {}, document: fakeDocument() } });
  assert.equal(none.available(), false);
  assert.equal(none.playerName(), 'html5');
  const chosen = bundle('avplayer.js', { settings: { player: 'html5' }, device: new Map(), globals: { window: { webapis: { avplay: {} } }, document: fakeDocument() } });
  assert.equal(chosen.playerName(), 'html5');
});

test('leaving the app suspends AVPlay and coming back restores it', () => {
  const { av, el, document } = avHarness();
  el.src = 'http://x/a.mkv';
  av.prepared.ok();
  document.hidden = true; document.fire('visibilitychange');
  document.hidden = false; document.fire('visibilitychange');
  assert.deepEqual(av.calls.slice(-2), [['suspend'], ['restore']]);
  el.avDestroy();
  assert.equal((document.listeners.visibilitychange || []).length, 0);
});

test('play waits for the seek callback, and a seek without callback ends when the TV reaches the point', () => {
  const { av, el, events } = avHarness();
  let pendingOk = null;
  av.seekTo = function (ms, ok) { av.calls.push(['seek', ms]); pendingOk = ok; };
  el.autoplay = true;
  el.addEventListener('loadedmetadata', () => { el.currentTime = 600; });
  el.src = 'http://x/a.mkv';
  av.prepared.ok();
  assert.equal(av.calls.filter((c) => c[0] === 'play').length, 0, 'no play while the seek is pending');
  pendingOk();
  assert.equal(av.calls.filter((c) => c[0] === 'play').length, 1);
  assert.ok(events.indexOf('seeked') < events.indexOf('playing'));
  // Sem retorno do seekTo: a TV informando o ponto pedido encerra o avanço.
  el.currentTime = 1200;
  assert.equal(el.currentTime, 1200);
  const realNow = Date.now;
  Date.now = () => realNow() + 2000;
  try { av.listener.oncurrentplaytime(1200500); } finally { Date.now = realNow; }
  assert.equal(events.filter((e) => e === 'seeked').length, 2);
  av.listener.oncurrentplaytime(1201000);
  assert.equal(el.currentTime, 1201);
  el.avDestroy();
});

test('background pauses before suspending and chosen tracks come back after a reopen', async () => {
  const { av, el, document } = avHarness();
  av.tracks = [{ index: 1, type: 'AUDIO', extra_info: '{"language":"eng"}' }, { index: 2, type: 'AUDIO', extra_info: '{"language":"por"}' }, { index: 3, type: 'TEXT', extra_info: '{"track_lang":"por"}' }];
  av.current = [{ type: 'AUDIO', index: 1 }];
  el.autoplay = true;
  el.src = 'http://x/a.mkv';
  av.prepared.ok();
  el.audioTracks[1].enabled = true;
  el.avSelectText(3, () => {});
  document.hidden = true; document.fire('visibilitychange');
  assert.deepEqual(av.calls.slice(-2), [['pause'], ['suspend']]);
  assert.equal(el.paused, true);
  document.hidden = false; document.fire('visibilitychange');
  el.load();
  await wait(350);
  av.prepared.ok();
  av.calls.length = 0;
  av.listener.oncurrentplaytime(1000);
  assert.deepEqual(av.calls.filter((c) => c[0] === 'track'), [['track', 'AUDIO', 2], ['track', 'TEXT', 3]]);
  el.avDestroy();
});

test('a generic error name still reads the AVPlay code from the message', () => {
  const { av, el } = avHarness();
  el.src = 'http://x/a.mkv';
  av.prepared.fail({ name: 'UnknownError', message: 'PLAYER_ERROR_CONNECTION_FAILED' });
  assert.equal(el.error.code, 2);
});

// ---------- Formatos aprendidos ----------
function formatsApi() {
  return bundle('formats.js', { settings: {}, device: new Map(), globals: {} });
}
const file = (name, extra) => Object.assign({ name: 'Addon', title: name, behaviorHints: { filename: name } }, extra);

test('a format becomes not working only after two different files, once as the only suspect', () => {
  const f = formatsApi();
  const a = file('Movie.1080p.x265.HDR.AAC.mkv');
  assert.deepEqual(plain(f.features(a)), ['v:hevc-hdr', 'a:aac', 'c:mkv']);
  f.report(a, 'avplay', false);
  assert.equal(f.verdict(a, 'avplay'), '', 'one failure with three suspects is not enough');
  f.report(file('Other.1080p.x264.AAC.mkv'), 'avplay', true);
  assert.equal(f.status('avplay', 'a:aac'), 'ok');
  f.report(a, 'avplay', false);
  assert.equal(f.status('avplay', 'v:hevc-hdr'), 'suspect', 'the same file again is still one file');
  f.report(file('Second.1080p.x265.HDR.AAC.mkv'), 'avplay', false);
  assert.equal(f.status('avplay', 'v:hevc-hdr'), 'bad', 'second file, video profile the only unproven feature');
  assert.equal(f.status('avplay', 'a:aac'), 'ok', 'a proven feature is never blamed');
  assert.equal(f.verdict(file('Next.1080p.x265.HDR.AAC.mkv'), 'avplay'), 'bad');
  assert.equal(f.verdict(file('Next.1080p.x265.AAC.mkv'), 'avplay'), '', 'HEVC without HDR is a different profile');
});

test('the only unproven feature of two failing files is marked, and proven ones are never blamed', () => {
  const f = formatsApi();
  f.report(file('Ok.1080p.x264.AAC.mkv'), 'avplay', true);
  f.report(file('Ok2.1080p.x264.DTS.mp4'), 'avplay', true);
  f.report(file('Bad.1080p.x264.AAC.DTS-HD.mkv'), 'avplay', false);
  f.report(file('Bad.1080p.x264.TrueHD.mkv'), 'avplay', false);
  f.report(file('Bad2.1080p.x264.TrueHD.mkv'), 'avplay', false);
  assert.equal(f.status('avplay', 'a:truehd'), 'bad');
  assert.equal(f.status('avplay', 'v:h264'), 'ok');
  assert.equal(f.verdict(file('Any.720p.x264.TrueHD.mkv'), 'avplay'), 'bad');
  assert.equal(f.verdict(file('Any.720p.x264.TrueHD.mkv'), 'html5'), '', 'players learn separately');
  assert.equal(f.verdict(file('Any.720p.x264.AAC.mkv'), 'avplay'), 'ok');
  f.forget('avplay', 'a:truehd');
  assert.equal(f.status('avplay', 'a:truehd'), '');
  f.forget('avplay');
  assert.equal(f.list('avplay').length, 0);
});

test('streams without known codecs teach nothing', () => {
  const f = formatsApi();
  assert.equal(f.report({ name: 'x', title: 'no info' }, 'avplay', false), null);
  assert.equal(f.list('avplay').length, 0);
});

// ---------- Avisos de debrid ----------
function noticeApi() {
  return bundle('notice.js', { settings: {}, device: new Map(), globals: {} });
}

test('debrid notice videos are recognised by their whole file name only', () => {
  const n = noticeApi();
  assert.equal(n.classify('https://torrentio.strem.fun/videos/failed_access_v2.mp4'), 'access');
  assert.equal(n.classify('https://torrentio.strem.fun/videos/limits_exceeded_v2.mp4?x=1'), 'limit');
  assert.equal(n.classify('https://x/videos/failed_infringement_v2.mp4'), 'refused');
  assert.equal(n.classify('https://x/videos/downloading_v2.mp4'), 'downloading');
  assert.equal(n.classify('https://x/videos/failed_unexpected_v2.mp4'), 'failed');
  assert.equal(n.classify('https://x/videos/no_matching_file_v2.mp4'), 'failed');
  for (const real of ['Limitless.2011.1080p.mkv', 'Terror.Error.mkv', 'Downloading.Nancy.2019.mp4', 'failed.mkv']) {
    assert.equal(n.classify('https://cdn/' + real), null, real);
  }
});

test('the debrid service comes from the source tag and account notices group its links', () => {
  const n = noticeApi();
  const rd = { addon: 'Torrentio', name: 'Torrentio\n[RD+] 1080p' };
  const rd2 = { addon: 'Torrentio', name: '[RD⚡] Torrentio 4K' };
  const tb = { addon: 'Torrentio', name: '[TB⚡] 1080p' };
  assert.equal(n.serviceOf(rd).name, 'Real-Debrid');
  assert.equal(n.serviceOf(tb).tag, 'TB');
  assert.equal(n.sameAccount(rd, rd2), true);
  assert.equal(n.sameAccount(rd, tb), false);
  assert.equal(n.sameAccount(rd, { addon: 'Other', name: '[RD+]' }), false);
  assert.equal(n.accountWide('access'), true);
  assert.equal(n.accountWide('downloading'), false);
  assert.ok(n.message('access', rd).indexOf('Real-Debrid') === 0);
});
