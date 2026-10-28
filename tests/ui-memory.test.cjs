const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, globals) {
  const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ Promise, Date, Math, console, ...globals });
  new vm.Script(code, { filename: file }).runInContext(context);
  return context;
}
function deferred() { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; }
async function tick() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function node(tag = 'div', props = {}, children) {
  const classes = new Set(tag.split('.').slice(1));
  const attrs = {};
  const el = {
    tag: tag.split('.')[0], children: [], parentNode: null, offsetParent: {}, style: {}, offsetWidth: 10,
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) },
    setAttribute: (name, value) => { attrs[name] = String(value); }, getAttribute: name => attrs[name] || null,
    removeAttribute: name => { delete attrs[name]; },
    get firstChild() { return this.children[0] || null; },
    appendChild(child) { this.children.push(child); if (child && typeof child === 'object') child.parentNode = this; return child; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
    insertBefore(child) { this.children.unshift(child); child.parentNode = this; },
    contains(child) { return this === child || this.children.some(el => el && el.contains && el.contains(child)); },
    addEventListener(name, fn) { this[name] = fn; },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 210, bottom: 315 }),
    querySelectorAll(selector) {
      const result = [];
      const visit = child => {
        if (!child || typeof child !== 'object') return;
        if ((selector === 'img' && child.tag === 'img') ||
            (selector === 'img[data-lazy]' && child.tag === 'img' && child.getAttribute('data-lazy')) ||
            (selector === '[data-scroll-x]' && child.getAttribute('data-scroll-x') !== null)) result.push(child);
        (child.children || []).forEach(visit);
      };
      this.children.forEach(visit); return result;
    },
  };
  const append = child => Array.isArray(child) ? child.forEach(append) : child != null && el.appendChild(child);
  append(children);
  return el;
}

test('lazy images release hidden/removed pixels and restore the loading placeholder', () => {
  const api = load('src/js/lib/dom.js', { window: { innerWidth: 1920, innerHeight: 1080 }, store: { settings: () => ({ lowMemory: true }) }, kitsuInfo: () => null });
  const root = node(), wrap = node(), image = node('img');
  image.setAttribute('data-lazy', 'poster.jpg'); root.appendChild(wrap); wrap.appendChild(image);
  api.loadVisibleImages(root); assert.equal(image.src, 'poster.jpg'); image.load();
  assert.ok(wrap.classList.contains('img-loaded'));
  image.offsetParent = null; api.loadVisibleImages(root);
  assert.notEqual(image.src, 'poster.jpg'); assert.equal(wrap.classList.contains('img-loaded'), false);
  image.offsetParent = {}; api.loadVisibleImages(root); image.load();
  api.clear(root);
  assert.equal(root.children.length, 0); assert.notEqual(image.src, 'poster.jpg');
});

test('a stale Kitsu response cannot reload a hidden/reused card', async () => {
  const waiting = [];
  const api = load('src/js/lib/dom.js', { window: { innerWidth: 1920, innerHeight: 1080 }, store: { settings: () => ({ lowMemory: true }) },
    kitsuInfo: url => ({ id: url }), kitsuSmall: () => { const d = deferred(); waiting.push(d); return d.promise; } });
  const root = node(), image = node('img'); root.appendChild(image); image.setAttribute('data-lazy', 'old');
  api.loadVisibleImages(root); api.unloadImages(root);
  image.setAttribute('data-lazy', 'new'); api.loadVisibleImages(root);
  waiting[0].resolve('old-small.jpg'); await tick();
  assert.notEqual(image.src, 'old-small.jpg'); assert.equal(image.getAttribute('data-lazy'), 'new');
  waiting[1].resolve('new-small.jpg'); await tick(); assert.equal(image.src, 'new-small.jpg');
});

test('light image window releases far posters and reloads them when scrolled back', () => {
  const api = load('src/js/lib/dom.js', { window: { innerWidth: 1920, innerHeight: 1080 }, store: { settings: () => ({ lowMemory: true }) }, kitsuInfo: () => null });
  const root = node(), image = node('img'); root.appendChild(image); image.setAttribute('data-lazy', 'poster.jpg');
  let top = 0; image.getBoundingClientRect = () => ({ top, bottom: top + 315, left: 0, right: 210 });
  api.loadVisibleImages(root); assert.equal(image.src, 'poster.jpg');
  top = 1600; api.loadVisibleImages(root); assert.notEqual(image.src, 'poster.jpg');
  top = 900; api.loadVisibleImages(root); assert.equal(image.src, 'poster.jpg');
});

function saverHarness() {
  const waiting = deferred(), root = node(), listeners = [], timers = new Map(), images = [];
  let next = 0;
  const add = (fn, ms) => { timers.set(++next, { fn, ms }); return next; };
  const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); };
  const doc = { hidden: false, addEventListener: (name, fn) => listeners.push({ target: 'doc', name, fn }),
    querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [], getElementById: () => root };
  const api = load('src/js/lib/screensaver.js', {
    h: node, clear, store: { settings: () => ({ lowMemory: true, screensaver: 5 }) }, t: text => text,
    hero: { saverItems: () => waiting.promise }, cinemaBackground: url => url + '-bounded', smallBackground: url => url + '-thumb',
    window: { addEventListener: (name, fn) => listeners.push({ target: 'window', name, fn }) }, document: doc,
    Image: function () { const image = { src: '', naturalWidth: 780 }; images.push(image); return image; },
    setTimeout: add, clearTimeout: id => timers.delete(id), setInterval: add, clearInterval: id => timers.delete(id),
  });
  function run(ms) {
    for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); }
  }
  return { api, waiting, root, listeners, timers, images, doc, run };
}
const items = [{ name: 'Movie', background: 'movie.jpg', logo: 'logo.png', type: 'movie' }];

test('screensaver installs one listener set and cancellation prevents a late overlay', async () => {
  const h = saverHarness(); h.api.install(); h.api.install();
  assert.equal(h.listeners.length, 3);
  h.api.start(); h.api.start(); h.api.stop(false);
  h.waiting.resolve(items); await tick();
  assert.equal(h.root.children.length, 0); assert.equal(h.images.length, 0);
});

test('activity during screensaver metadata loading cancels the pending overlay without swallowing input', async () => {
  for (const kind of ['keydown', 'mousemove']) {
    const h = saverHarness(); h.api.install(); h.api.start();
    const handler = h.listeners.find(listener => listener.name === kind);
    let consumed = false;
    handler.fn({ preventDefault: () => { consumed = true; }, stopPropagation: () => { consumed = true; } });
    h.waiting.resolve(items); await tick();
    assert.equal(consumed, false, kind + ' must still reach the app');
    assert.equal(h.root.children.length, 0, kind + ' must cancel a pending start');
    assert.equal(h.images.length, 0);
  }
});

test('screensaver preserves fades then releases artwork, thumbnail and preload on stop', async () => {
  const h = saverHarness(); h.api.start(); h.waiting.resolve(items); await tick();
  assert.equal(h.root.children.length, 1); assert.equal(h.images[0].src, 'movie.jpg-bounded');
  h.images[0].onload(); h.run(180);
  assert.equal(h.images[0].src, '', 'preload reference released after CSS takes over');
  const old = h.root.children[0];
  h.api.stop(); assert.equal(h.root.children.length, 1, 'exit keeps its short fade');
  h.run(450); assert.equal(h.root.children.length, 0);
  const imgs = [];
  const collect = el => { if (el.tag === 'div' && el.style.backgroundImage) imgs.push(el.style.backgroundImage); el.children.forEach(child => child && typeof child === 'object' && collect(child)); };
  collect(old); assert.equal(imgs.filter(url => url !== 'none').length, 0);
});

test('screensaver does not create extra artwork while a player is open in light mode', async () => {
  const h = saverHarness(); h.doc.querySelector = () => ({}); h.api.start(); h.waiting.resolve(items); await tick();
  assert.equal(h.root.children.length, 0); assert.equal(h.images.length, 0);
});

test('cinematic artwork stays bounded without turning large banners into thumbnails', () => {
  const api = load('src/js/lib/img.js', {});
  assert.equal(api.cinemaBackground('https://image.tmdb.org/t/p/original/movie.jpg'), 'https://image.tmdb.org/t/p/w780/movie.jpg');
  assert.equal(api.cinemaBackground('https://images.metahub.space/background/small/tt1/img'), 'https://images.metahub.space/background/medium/tt1/img');
  assert.equal(api.smallBackground('https://image.tmdb.org/t/p/original/movie.jpg'), 'https://image.tmdb.org/t/p/w300/movie.jpg');
});
