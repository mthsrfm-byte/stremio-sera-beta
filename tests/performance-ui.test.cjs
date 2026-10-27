// Behavioral tests for TV lifecycle/concurrency without a browser or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, globals) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const context = vm.createContext({ Promise, console, setTimeout, clearTimeout, ...globals });
  new vm.Script(source, { filename: file }).runInContext(context);
  return context;
}

function deferred() {
  let resolve;
  const promise = new Promise((ok) => { resolve = ok; });
  return { promise, resolve };
}
async function tick() { for (let n = 0; n < 8; n++) await Promise.resolve(); }

function node(tag, props, children) {
  const el = {
    tag, props: props || {}, children: [], parentNode: null, offsetParent: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get firstChild() { return this.children[0] || null; },
    appendChild(child) { this.children.push(child); if (child && typeof child === 'object') child.parentNode = this; return child; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
    querySelector: () => null,
    contains(child) { return this === child || this.children.some((c) => c && typeof c.contains === 'function' && c.contains(child)); },
  };
  const append = (child) => {
    if (Array.isArray(child)) child.forEach(append);
    else if (child != null) el.appendChild(child);
  };
  append(children);
  return el;
}
function find(el, tag) {
  if (el.tag === tag) return el;
  for (const child of el.children || []) {
    if (child && typeof child === 'object') { const found = find(child, tag); if (found) return found; }
  }
  return null;
}
function searchHarness() {
  const requests = [];
  const cats = Array.from({ length: 6 }, (_, n) => ({ catalog: { id: String(n), type: 'movie' } }));
  const context = load('src/js/views/search.js', {
    h: node,
    clear: (el) => { el.children = []; },
    loadVisibleImages() {},
    nav: { focus() {} }, router: { goTab() {} }, openDetails() {},
    topbar: () => node('bar'), card: (meta) => node('card', { meta }), skeletonCards: () => [],
    t: (value) => value,
    store: { settings: () => ({ lowMemory: true }) },
    addons: {
      load: () => Promise.resolve(), searchCatalogs: () => cats, catalogTitle: () => '',
      fetchCatalog: (entry) => { const d = deferred(); requests.push({ entry, ...d }); return d.promise; },
    },
  });
  const view = context.SearchView();
  const input = find(view.el, 'input.input');
  const results = find(view.el, 'div.rows');
  return { view, input, results, requests };
}

test('search limits concurrent addon calls and clearing a query rejects late results', async () => {
  const h = searchHarness();
  h.input.__submit('movie');
  await tick();
  assert.equal(h.requests.length, 2);
  h.requests[0].resolve([{ id: 'first', name: 'First' }]);
  await tick();
  assert.equal(h.requests.length, 3);
  h.input.__submit('');
  assert.equal(h.results.children.length, 1);
  assert.equal(h.results.children[0].tag, 'div.hint');
  h.requests[1].resolve([{ id: 'late', name: 'Late' }]);
  h.requests[2].resolve([{ id: 'late2', name: 'Late2' }]);
  await tick();
  assert.equal(h.requests.length, 3, 'old query must not schedule more work');
  assert.equal(h.results.children.length, 1, 'old results must not repopulate cleared query');
});

test('destroyed search does not rebuild DOM or schedule more addon calls', async () => {
  const h = searchHarness();
  h.input.__submit('movie');
  await tick();
  const count = h.results.children.length;
  h.view.destroy();
  h.requests.forEach((req) => req.resolve([{ id: 'late', name: 'Late' }]));
  await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.results.children.length, count);
});

test('row queue loads only nearby rows and resumes after scrolling', async () => {
  const context = load('src/js/views/recommended.js', {
    window: { innerHeight: 100 }, store: { settings: () => ({ lowMemory: true }) },
  });
  const rows = { offsetParent: {} };
  const positions = [0, 200, 300];
  const waiting = Array.from({ length: 3 }, deferred);
  const started = [];
  const queue = context.rowLoader(rows, positions.map((_, i) => ({
    row: { getBoundingClientRect: () => ({ top: positions[i] }) },
    load: () => { started.push(i); return waiting[i].promise; },
  })));
  queue.run();
  assert.deepEqual(started, [0]);
  waiting[0].resolve();
  await tick();
  assert.deepEqual(started, [0]);
  positions[1] = 90;
  queue.run();
  assert.deepEqual(started, [0, 1]);
  rows.offsetParent = null;
  positions[2] = 100;
  waiting[1].resolve();
  await tick();
  assert.deepEqual(started, [0, 1]);
  rows.offsetParent = {};
  queue.run();
  assert.deepEqual(started, [0, 1, 2]);
  queue.destroy();
  waiting[2].resolve();
});

test('discarded row queue invalidates pending completion and releases every row', async () => {
  const context = load('src/js/views/recommended.js', {
    window: { innerHeight: 100 }, store: { settings: () => ({ lowMemory: true }) },
  });
  const waiting = deferred();
  let completed = 0;
  let disposed = 0;
  let started = 0;
  const queue = context.rowLoader({ offsetParent: {} }, Array.from({ length: 3 }, () => ({
    row: { getBoundingClientRect: () => ({ top: 0 }) },
    load: () => { started++; return waiting.promise; },
    destroy: () => { disposed++; },
  })), () => { completed++; });
  queue.run();
  queue.destroy();
  waiting.resolve();
  await tick();
  assert.equal(disposed, 3);
  assert.equal(started, 1);
  assert.equal(completed, 0);
});

test('stalled HLS script loader times out and releases script element/handlers', async () => {
  const timers = [];
  const head = { appendChild(el) { el.parentNode = this; }, removeChild(el) { el.parentNode = null; } };
  const created = [];
  const context = load('src/js/lib/hlsplay.js', {
    t: (value) => value, store: { settings: () => ({ lowMemory: true }) }, window: {},
    document: { head, createElement: () => { const el = {}; created.push(el); return el; } },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
  });
  const result = context.loadScript('unreachable.js');
  const rejected = assert.rejects(result, /tempo esgotado/);
  timers[0]();
  await rejected;
  assert.equal(created[0].parentNode, null);
  assert.equal(created[0].onload, null);
  assert.equal(created[0].onerror, null);
});

test('late HLS script cannot attach an old source over the current video', async () => {
  const created = [];
  const head = { appendChild(el) { el.parentNode = this; }, removeChild(el) { el.parentNode = null; } };
  let instances = 0;
  let attachments = 0;
  function Hls() { instances++; }
  Hls.isSupported = () => true;
  Hls.Events = { ERROR: 'error' };
  Hls.prototype.on = () => {};
  Hls.prototype.loadSource = () => {};
  Hls.prototype.attachMedia = (video) => { attachments++; video.src = 'old-source'; };
  Hls.prototype.destroy = () => {};
  const window = {};
  const context = load('src/js/lib/hlsplay.js', {
    t: (value) => value, store: { settings: () => ({ lowMemory: true }) }, window,
    document: { head, createElement: () => { const el = {}; created.push(el); return el; } },
  });
  const video = { src: 'old-pending-source' };
  let current = true;
  const pending = context.attach(video, 'old.m3u8', () => {}, () => current);
  current = false;
  video.src = 'new-source';
  window.Hls = Hls;
  created[0].onload();
  assert.equal(await pending, null);
  assert.equal(instances, 0);
  assert.equal(attachments, 0);
  assert.equal(video.src, 'new-source');
  const ctl = await context.attach(video, 'current.m3u8', () => {}, () => true);
  assert.equal(instances, 1);
  assert.equal(attachments, 1);
  ctl.destroy();
});

test('horizontal navigation measures only its row and rejects focus from an old screen', () => {
  const queried = [];
  const group = {
    items: [], __last: null,
    hasAttribute: (key) => key === 'data-trap',
    contains: (el) => group.items.includes(el),
  };
  const makeItem = (left) => ({
    offsetParent: {}, parentNode: null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ left, right: left + 20, top: 0, bottom: 20 }),
    closest: (selector) => selector === '[data-group]' ? group : null,
    classList: { add() {}, remove() {} },
  });
  const current = makeItem(0);
  const next = makeItem(30);
  group.items.push(current, next);
  const root = { contains: (el) => group.contains(el), items: [current, next] };
  const context = load('src/js/lib/nav.js', {
    isTizen: () => false, IS_WEB: false,
    $$: (selector, scope) => { queried.push(scope); return scope.items; },
    document: { body: { contains: () => true } }, cancelAnimationFrame() {},
  });
  context.pushLayer(root);
  context.focus(current, { noScroll: true });
  assert.equal(context.move('right'), true);
  assert.equal(context.current(), next);
  assert.deepEqual(queried, [group]);
  context.focus(makeItem(60), { noScroll: true });
  assert.equal(context.current(), next);
});

test('modal focus stays isolated and closing it restores the underlying screen', () => {
  const context = load('src/js/lib/nav.js', {
    isTizen: () => false, IS_WEB: false, $$: () => [], cancelAnimationFrame() {},
  });
  const first = node('first');
  const next = node('next');
  first.closest = next.closest = () => null;
  const background = node('background', null, [first, next]);
  context.pushLayer(background);
  context.focus(first, { noScroll: true });
  const option = node('option');
  option.closest = () => null;
  const overlay = node('overlay', null, option);
  const modal = context.pushLayer(overlay);
  context.focus(option, { noScroll: true });
  context.focus(next, { noScroll: true });
  assert.equal(context.current(), option, 'late background work must not move focus out of menu');
  context.popLayer(modal);
  assert.equal(context.current(), first);
  context.focus(next, { noScroll: true });
  assert.equal(context.current(), next);
});

function httpHarness() {
  const requests = [];
  let clock = 0;
  class XHR {
    constructor() { requests.push(this); }
    open(method, url) { this.url = url; }
    setRequestHeader() {}
    send() {}
    succeed(value) { this.status = 200; this.responseText = JSON.stringify(value); this.onload(); }
    fail() { this.onerror(); }
  }
  const context = load('src/js/lib/http.js', {
    XMLHttpRequest: XHR, Date: { now: () => clock }, log: { warn() {} }, t: (value) => value,
  });
  return { context, requests, setClock: (now) => { clock = now; } };
}

test('metadata cache evicts least recently used entries instead of accumulating catalogs', async () => {
  const { context: c, requests } = httpHarness();
  const first = c.cachedJSON('first');
  requests[0].succeed({ title: 'First' });
  await first;
  for (let i = 0; i < 23; i++) {
    const p = c.cachedJSON('other-' + i);
    requests[requests.length - 1].succeed({ title: String(i) });
    await p;
  }
  assert.equal(c.cachedJSON('first'), first, 'touching first keeps it recently used');
  const extra = c.cachedJSON('extra');
  requests[requests.length - 1].succeed({ title: 'Extra' });
  await extra;
  assert.equal(c.cachedJSON('first'), first);
  const count = requests.length;
  const replaced = c.cachedJSON('other-0');
  assert.equal(requests.length, count + 1, 'oldest catalog is fetched again after eviction');
  requests[requests.length - 1].succeed({ title: 'Refetched' });
  await replaced;
});

test('metadata cache limits retention of large responses even below the item limit', async () => {
  const { context: c, requests } = httpHarness();
  const first = c.cachedJSON('large-1');
  requests[0].succeed({ text: 'x'.repeat(600000) });
  await first;
  const second = c.cachedJSON('large-2');
  requests[1].succeed({ text: 'y'.repeat(600000) });
  await second;
  assert.equal(c.cachedJSON('large-2'), second);
  const refetch = c.cachedJSON('large-1');
  assert.notEqual(refetch, first);
  assert.equal(requests.length, 3);
  requests[2].succeed({ text: '' });
  await refetch;
});

test('expired failed request cannot evict a newer successful request for the same URL', async () => {
  const { context: c, requests, setClock } = httpHarness();
  const first = c.cachedJSON('same', 1);
  const rejected = assert.rejects(first);
  setClock(2);
  const next = c.cachedJSON('same', 100);
  requests[0].fail();
  await rejected;
  assert.equal(c.cachedJSON('same', 100), next);
  requests[1].succeed({ title: 'New' });
  await next;
});

test('clearing cache for playback prevents late metadata responses from repopulating it', async () => {
  const { context: c, requests } = httpHarness();
  const pending = c.cachedJSON('pending');
  c.clearCache();
  requests[0].succeed({ title: 'Late' });
  await pending;
  const next = c.cachedJSON('pending');
  assert.notEqual(next, pending);
  assert.equal(requests.length, 2);
  requests[1].succeed({ title: 'Next' });
  await next;
});

test('discarded NSFW catalog row ignores its pending response', async () => {
  const waiting = deferred();
  let madeCards = 0;
  const context = load('src/js/views/nsfw.js', {
    h: node, clear: (el) => { el.children = []; }, skeletonCards: () => [],
    retrying: (fn) => fn(), t: (value) => value, tr: { genre: (value) => value },
    addons: { fetchCatalog: () => waiting.promise },
    store: { settings: () => ({ lowMemory: true }) },
    card: () => { madeCards++; return node('card'); }, loadVisibleImages() {},
  });
  const row = context.catalogRow({ catalog: { id: 'test' }, addon: { manifest: { name: 'Test' } } }, node('parent'));
  const pending = row.load();
  row.destroy();
  waiting.resolve([{ id: 'late', name: 'Late' }]);
  await pending;
  assert.equal(madeCards, 0);
});

test('destroyed NSFW view does not render when addon discovery finishes late', async () => {
  const waiting = deferred();
  const context = load('src/js/views/nsfw.js', {
    h: node, clear: (el) => { el.children = []; }, t: (value) => value,
    topbar: () => node('bar'), router: { goTab() {} },
    store: { get: () => null },
    addons: { load: () => waiting.promise, onChange: () => () => {} },
  });
  const view = context.NsfwView();
  const body = find(view.el, 'div.rows');
  view.onShow();
  view.destroy();
  waiting.resolve();
  await tick();
  assert.equal(body.children.length, 0);
});

test('switching tabs destroys stacked details without showing intermediate screens', () => {
  const host = node('host');
  const context = load('src/js/router.js', {
    document: { getElementById: () => host, body: { contains: () => true } },
    nav: { current: () => null, pushLayer: () => ({}), popLayer() {}, focusFirst() {} },
    loadVisibleImages() {}, unloadImages() {},
  });
  const makeView = () => ({ el: node('view'), shows: 0, destroyed: 0,
    onShow() { this.shows++; }, destroy() { this.destroyed++; },
  });
  const home = makeView();
  const first = makeView();
  const second = makeView();
  const library = makeView();
  context.registerTab('home', () => home);
  context.registerTab('library', () => library);
  context.goTab('home');
  context.push(first);
  context.push(second);
  context.goTab('library');
  assert.equal(home.shows, 1);
  assert.equal(first.shows, 1);
  assert.equal(second.shows, 1);
  assert.equal(first.destroyed, 1);
  assert.equal(second.destroyed, 1);
  assert.equal(library.shows, 1);
});

test('returning to the same base tab restores it after discarding stacked details', () => {
  const host = node('host');
  const context = load('src/js/router.js', {
    document: { getElementById: () => host, body: { contains: () => true } },
    nav: { current: () => null, pushLayer: () => ({}), popLayer() {}, focusFirst() {} },
    loadVisibleImages() {}, unloadImages() {},
  });
  const makeView = () => ({ el: node('view'), shows: 0, destroyed: 0,
    onShow() { this.shows++; }, destroy() { this.destroyed++; },
  });
  const home = makeView();
  const detail = makeView();
  context.registerTab('home', () => home);
  context.goTab('home');
  context.push(detail);
  assert.equal(home.layer, null);
  context.goTab('home');
  assert.equal(context.currentView(), home);
  assert.ok(home.layer, 'the restored base tab must own a navigation layer');
  assert.equal(home.shows, 2);
  assert.equal(detail.destroyed, 1);
  context.goTab('home');
  assert.equal(home.shows, 2, 'reselecting an already visible tab must not reload it');
});
