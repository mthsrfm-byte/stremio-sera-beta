// Protetor de tela: depois de alguns minutos sem mexer no controle, os lançamentos mais vistos
// passam pela tela (fundo em movimento lento, logo, ranking do dia e relógio). Qualquer botão
// volta exatamente de onde parou (a tecla não chega ao app).
import { h, clear } from './dom.js';
import * as store from './store.js';
import { t } from './i18n.js';
import * as hero from '../api/hero.js';
import { cinemaBackground, smallBackground } from './img.js';

const SLIDE_MS = 10000;
const HINT_MS = 6000;
const ITEMS_TTL = 3600000;
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
// Para onde a câmera anda em cada slide (escala final, deslocamento em px).
const MOVES = [
  [1.14, -50, -20],
  [1.12, 50, -24],
  [1.15, -30, 24],
  [1.12, 40, 20],
];

let idleTimer = null;
let el = null;
let items = [];
let itemsAt = 0;
let idx = 0;
let slideTimer = null;
let clockTimer = null;
let front = null;
let back = null;
let parts = null;
let installed = false;
let starting = false;
let generation = 0;
let preloading = null;
let preloadTimer = null;
let swapTimer = null;
let textTimer = null;
let hintTimer = null;
let removeTimer = null;
let retired = null;

function light() { return store.settings().lowMemory !== false; }
function releasePreload() {
  clearTimeout(preloadTimer);
  preloadTimer = null;
  if (preloading) {
    preloading.onload = preloading.onerror = null;
    preloading.src = '';
    preloading = null;
  }
}
function disposeRetired() {
  clearTimeout(removeTimer);
  if (!retired) return;
  retired.front.style.backgroundImage = retired.back.style.backgroundImage = '';
  retired.parts.nextImg.style.backgroundImage = '';
  Array.prototype.forEach.call(retired.el.querySelectorAll('img'), (img) => {
    img.onload = img.onerror = null;
    img.removeAttribute('src');
  });
  if (retired.el.parentNode) retired.el.parentNode.removeChild(retired.el);
  retired = null;
}


export const OPTIONS = [0, 2, 5, 10, 20]; // minutos (0 = desligado)

export function minutes() {
  const v = store.settings().screensaver;
  return typeof v === 'number' ? v : 5;
}

export function install() {
  if (installed) return arm();
  installed = true;
  // Na captura da window: corre antes da navegação do app e engole a tecla que acorda a tela.
  window.addEventListener(
    'keydown',
    (e) => {
      if (el) {
        e.preventDefault();
        e.stopPropagation();
        stop();
        return;
      }
      arm();
    },
    true
  );
  let lastMove = 0;
  document.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - lastMove < 1000) return;
    lastMove = now;
    if (el) stop();
    else arm();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop(false); clearTimeout(idleTimer); }
    else arm();
  });
  arm();
}

export function arm() {
  // Atividade enquanto o catálogo carrega também cancela a abertura, sem capturar a tecla.
  if (starting) { generation++; starting = false; }
  clearTimeout(idleTimer);
  const m = minutes();
  if (m > 0 && !document.hidden) idleTimer = setTimeout(maybeStart, m * 60000);
}

// Vídeo tocando (player, prévias) não é tela parada.
function busy() {
  if (document.hidden) return true;
  // Na TV leve, não cria outro conjunto de fundos durante o player ou a preparação do torrent.
  if (light() && document.querySelector('.player:not(.hidden)')) return true;
  const vids = document.getElementsByTagName('video');
  for (let i = 0; i < vids.length; i++) {
    const v = vids[i];
    if (!v.paused && !v.ended && v.readyState > 2 && v.offsetWidth > 400) return true;
  }
  return false;
}

function maybeStart() {
  if (busy()) return arm();
  start();
}

function loadItems() {
  if (items.length && Date.now() - itemsAt < ITEMS_TTL) return Promise.resolve(items);
  return hero
    .saverItems()
    .then((list) => {
      const counts = {};
      items = list
        .filter((x) => x && x.background)
        .map((x) => {
          counts[x.type] = (counts[x.type] || 0) + 1;
          return Object.assign({ rank: counts[x.type] }, x);
        });
      itemsAt = Date.now();
      return items;
    })
    .catch(() => items);
}

export function start() {
  if (el || starting || document.hidden) return;
  starting = true;
  const token = ++generation;
  loadItems().then((list) => {
    if (token !== generation) return;
    starting = false;
    if (el || !list.length || busy()) return arm();
    disposeRetired();
    build();
    idx = Math.floor(Math.random() * list.length);
    tick();
    show(true);
  });
}

export function stop(rearm) {
  generation++;
  starting = false;
  releasePreload();
  clearTimeout(slideTimer);
  clearInterval(clockTimer);
  clearTimeout(swapTimer);
  clearTimeout(textTimer);
  clearTimeout(hintTimer);
  disposeRetired();
  if (el) {
    retired = { el, front, back, parts };
    el.classList.remove('on');
    el = front = back = parts = null;
    // Mantém o fade de saída e depois solta imagens e referências.
    if (rearm === false) disposeRetired();
    else removeTimer = setTimeout(disposeRetired, 450);
  }
  if (rearm !== false) arm();
}

function build() {
  front = h('div.sv-img');
  back = h('div.sv-img');
  parts = {
    time: h('div.sv-time'),
    date: h('div.sv-date'),
    num: h('div.sv-num'),
    rankTxt: h('div.sv-rank-txt'),
    logoBox: h('div.sv-logo-box'),
    meta: h('div.sv-meta'),
    desc: h('div.sv-desc'),
    info: h('div.sv-info'),
    bars: h('div.sv-bars'),
    nextImg: h('div.sv-next-img'),
    nextName: h('div.sv-next-name'),
  };
  const p = parts;
  clear(p.info);
  p.info.appendChild(h('div.sv-rank', null, [p.num, p.rankTxt]));
  p.info.appendChild(p.logoBox);
  p.info.appendChild(p.meta);
  p.info.appendChild(p.desc);
  items.slice(0, 16).forEach(() => p.bars.appendChild(h('div.sv-bar', null, h('i'))));
  el = h('div.saver', null, [
    h('div.sv-bg', null, [back, front]),
    h('div.sv-shade'),
    h('div.sv-brand', { text: 'SERAFLIX' }),
    h('div.sv-clock', null, [p.time, p.date]),
    p.info,
    h('div.sv-next', null, [p.nextImg, h('div', null, [h('small', { text: t('A seguir') }), p.nextName])]),
    p.bars,
    h('div.sv-hint', { text: t('Aperte qualquer botão para voltar') }),
  ]);
  document.getElementById('app').appendChild(el);
  clock();
  clockTimer = setInterval(clock, 15000);
  const token = generation;
  hintTimer = setTimeout(() => token === generation && el && el.classList.add('hint-off'), HINT_MS);
}

function show(first) {
  // Força o estilo inicial antes de ligar a transição (Chromium antigo junta as duas mudanças).
  void el.offsetWidth;
  if (first) el.classList.add('on');
}

function clock() {
  if (!parts) return;
  const d = new Date();
  parts.time.textContent = d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
  parts.date.textContent = DAYS[d.getDay()] + ', ' + d.getDate() + ' de ' + MONTHS[d.getMonth()];
}

function setTransform(node, v) {
  node.style.webkitTransform = v;
  node.style.transform = v;
}

function tick() {
  if (!el) return;
  releasePreload();
  const token = generation;
  const it = items[idx % items.length];
  const art = light() ? cinemaBackground(it.background) : it.background;
  const img = preloading = new Image();
  let done = false;
  const go = () => {
    if (done || !el || token !== generation) return;
    done = true;
    slide(it, img.naturalWidth ? art : '', token);
    releasePreload();
  };
  img.onload = go;
  img.onerror = go;
  img.src = art;
  preloadTimer = setTimeout(go, 4000);
}

function slide(it, bg, token) {
  const p = parts;
  // Fundo: a camada de trás recebe a imagem nova, começa parada e vai andando; depois troca de lugar.
  const layer = back;
  back = front;
  front = layer;
  const mv = MOVES[idx % MOVES.length];
  layer.style.webkitTransition = 'none';
  layer.style.transition = 'none';
  setTransform(layer, 'scale(1.02) translate(0px, 0px)');
  layer.style.backgroundImage = bg ? 'url("' + bg + '")' : 'none';
  void layer.offsetWidth;
  layer.style.webkitTransition = light() ? 'opacity 0.4s ease' : 'opacity 1.6s ease, -webkit-transform ' + (SLIDE_MS + 2500) + 'ms linear';
  layer.style.transition = light() ? 'opacity 0.4s ease' : 'opacity 1.6s ease, transform ' + (SLIDE_MS + 2500) + 'ms linear';
  layer.classList.add('front');
  back.classList.remove('front');
  setTransform(layer, light() ? 'none' : 'scale(' + mv[0] + ') translate(' + mv[1] + 'px, ' + mv[2] + 'px)');
  const previous = back;
  clearTimeout(swapTimer);
  swapTimer = setTimeout(() => {
    if (token === generation && el && previous !== front) previous.style.backgroundImage = '';
  }, light() ? 450 : 1700);

  // Texto: sai, troca e entra de novo.
  p.info.classList.remove('in');
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    if (!el || token !== generation) return;
    p.num.textContent = String(it.rank);
    p.rankTxt.innerHTML = '';
    p.rankTxt.appendChild(h('b', { text: t('Top 10 de hoje') }));
    p.rankTxt.appendChild(h('span', { text: t(it.type === 'series' ? '#{n} em séries hoje' : '#{n} em filmes hoje', { n: it.rank }) }));
    clear(p.logoBox);
    const name = h('div.sv-title', { text: it.name || '' });
    p.logoBox.appendChild(name);
    if (it.logo) {
      const lg = h('img.sv-logo', { alt: '' });
      lg.onload = () => {
        if (!el || token !== generation) return;
        name.style.display = 'none';
        lg.classList.add('ready');
      };
      lg.onerror = () => lg.parentNode && lg.parentNode.removeChild(lg);
      lg.src = it.logo;
      p.logoBox.insertBefore(lg, name);
    }
    clear(p.meta);
    const bits = [];
    if (it.rating) bits.push(h('span.sv-imdb', null, [h('b', { text: 'IMDb' }), String(it.rating)]));
    const year = String(it.year || '').slice(0, 4);
    if (year) bits.push(h('span', { text: year }));
    const genres = (it.genres || []).slice(0, 3).join(' · ');
    if (genres) bits.push(h('span', { text: genres }));
    if (year && parseInt(year, 10) >= new Date().getFullYear() - 1) bits.unshift(h('span.sv-new', { text: t('Lançamento') }));
    bits.forEach((b) => p.meta.appendChild(b));
    p.desc.textContent = it.description || '';
    void p.info.offsetWidth;
    p.info.classList.add('in');

    const nx = items[(idx + 1) % items.length];
    p.nextImg.style.backgroundImage = nx.background ? 'url("' + smallBackground(nx.background) + '")' : 'none';
    p.nextName.textContent = nx.name || '';
  }, light() ? 180 : 600);

  // Barras estilo stories: as anteriores cheias, a atual enchendo.
  const bars = p.bars.children;
  const cur = idx % items.length;
  for (let i = 0; i < bars.length; i++) {
    const fill = bars[i].firstChild;
    fill.style.webkitTransition = 'none';
    fill.style.transition = 'none';
    fill.style.width = i < cur ? '100%' : '0%';
  }
  if (bars[cur]) {
    const fill = bars[cur].firstChild;
    void fill.offsetWidth;
    fill.style.webkitTransition = 'width ' + SLIDE_MS + 'ms linear';
    fill.style.transition = 'width ' + SLIDE_MS + 'ms linear';
    fill.style.width = '100%';
  }

  idx = (idx + 1) % items.length;
  clearTimeout(slideTimer);
  slideTimer = setTimeout(tick, SLIDE_MS);
}
