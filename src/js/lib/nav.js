// Navegação espacial pelo controle remoto (setas/OK/voltar) e pelo ponteiro do Magic Remote.
// Elementos navegáveis têm [data-focus]. Fileiras usam [data-group] para lembrar a última posição.
// Contêineres com [data-scroll-x] / [data-scroll-y] rolam para manter o foco visível.
import { $$ } from './dom.js';
import { isTizen, IS_WEB } from './platform.js';

const TIZEN = isTizen();

export const KEY = {
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  ENTER: 13,
  SPACE: 32,
  BACK: 10009, // Samsung Return (no PC: Esc ou Backspace)
  ESC: 27,
  BACKSPACE: 8,
  PLAY: 415,
  PAUSE: 19,
  PLAYPAUSE: TIZEN ? 10252 : 179,
  STOP: 413,
  FF: 417,
  RW: 412,
  RED: 403,
  GREEN: 404,
  YELLOW: 405,
  BLUE: 406,
  CH_UP: TIZEN ? 427 : 33,
  CH_DOWN: TIZEN ? 428 : 34,
};

const layers = [];
let scrollHook = null;
let pointerMode = false;
// Rolagem animada redesenha a tela a cada quadro (caro no Chromium 38 da TV); padrão: instantânea.
let smooth = false;

export function setSmooth(on) {
  smooth = !!on;
}

function top() {
  return layers[layers.length - 1] || null;
}

function isVisible(el) {
  if (!el || el.offsetParent === null) return false;
  if (el.hasAttribute('disabled')) return false;
  return true;
}

function candidates(root) {
  return $$('[data-focus]', root).filter(isVisible);
}

function center(r) {
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}

function pick(list, cur, dir) {
  const cr = cur.getBoundingClientRect();
  const cc = center(cr);
  const tol = 8;
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    const r = el.getBoundingClientRect();
    let primary;
    let secondary;
    if (dir === 'right') {
      if (r.left < cr.right - tol && center(r).x <= cc.x + tol) continue;
      if (center(r).x <= cc.x) continue;
      primary = Math.max(0, r.left - cr.right);
      secondary = overlap(r.top, r.bottom, cr.top, cr.bottom) ? 0 : Math.abs(center(r).y - cc.y);
    } else if (dir === 'left') {
      if (center(r).x >= cc.x) continue;
      if (r.right > cr.left + tol && center(r).x >= cc.x - tol) continue;
      primary = Math.max(0, cr.left - r.right);
      secondary = overlap(r.top, r.bottom, cr.top, cr.bottom) ? 0 : Math.abs(center(r).y - cc.y);
    } else if (dir === 'down') {
      if (r.top < cr.bottom - tol) continue;
      primary = Math.max(0, r.top - cr.bottom);
      secondary = overlap(r.left, r.right, cr.left, cr.right) ? Math.abs(r.left - cr.left) / 10 : Math.abs(center(r).x - cc.x);
    } else {
      if (r.bottom > cr.top + tol) continue;
      primary = Math.max(0, cr.top - r.bottom);
      secondary = overlap(r.left, r.right, cr.left, cr.right) ? Math.abs(r.left - cr.left) / 10 : Math.abs(center(r).x - cc.x);
    }
    const score = primary + secondary * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function overlap(a1, a2, b1, b2) {
  return Math.min(a2, b2) - Math.max(a1, b1) > 4;
}

// Rolagem curta animada; cancela a anterior no mesmo contêiner.
function animateScroll(node, prop, target) {
  if (node.__anim) cancelAnimationFrame(node.__anim);
  const start = node[prop];
  const delta = target - start;
  if (!smooth || Math.abs(delta) < 2) {
    node[prop] = target;
    if (scrollHook) scrollHook(node);
    return;
  }
  const dur = 160;
  const t0 = Date.now();
  const step = () => {
    const k = Math.min(1, (Date.now() - t0) / dur);
    node[prop] = start + delta * (1 - Math.pow(1 - k, 3));
    if (k < 1) node.__anim = requestAnimationFrame(step);
    else {
      node.__anim = null;
      if (scrollHook) scrollHook(node);
    }
  };
  node.__anim = requestAnimationFrame(step);
}

export function ensureVisible(el) {
  let node = el.parentNode;
  while (node && node.nodeType === 1) {
    if (node.hasAttribute('data-scroll-x')) {
      const pad = parseInt(node.getAttribute('data-pad') || '96', 10);
      const er = el.getBoundingClientRect();
      const nr = node.getBoundingClientRect();
      let target = node.scrollLeft;
      if (er.left < nr.left + pad) target -= nr.left + pad - er.left;
      else if (er.right > nr.right - pad) target += er.right - (nr.right - pad);
      target = Math.max(0, Math.min(target, node.scrollWidth - node.clientWidth));
      if (target !== node.scrollLeft) animateScroll(node, 'scrollLeft', target);
    }
    if (node.hasAttribute('data-scroll-y')) {
      const pad = parseInt(node.getAttribute('data-pad-y') || '140', 10);
      const er = el.getBoundingClientRect();
      const nr = node.getBoundingClientRect();
      let target = node.scrollTop;
      const anchor = el.closest('[data-anchor]');
      if (anchor && node.contains(anchor)) {
        // Fileiras: alinha o topo da fileira, como na tela inicial do Stremio.
        const ar = anchor.getBoundingClientRect();
        target += ar.top - nr.top - parseInt(anchor.getAttribute('data-anchor') || '0', 10);
      } else if (er.top < nr.top + pad) target -= nr.top + pad - er.top;
      else if (er.bottom > nr.bottom - pad) target += er.bottom - (nr.bottom - pad);
      target = Math.max(0, Math.min(target, node.scrollHeight - node.clientHeight));
      if (target !== node.scrollTop) animateScroll(node, 'scrollTop', target);
    }
    node = node.parentNode;
  }
}

export function focus(el, opts) {
  const layer = top();
  // Respostas assíncronas de uma tela antiga nunca podem roubar o foco da atual.
  if (!layer || !el || !layer.root.contains(el)) return;
  const prev = layer.current;
  if (prev && prev !== el) {
    prev.classList.remove('focused');
    if (prev.__blur) prev.__blur();
  }
  layer.current = el;
  el.classList.add('focused');
  const group = el.closest('[data-group]');
  if (group) group.__last = el;
  if (!(opts && opts.noScroll)) ensureVisible(el);
  if (el.__focus && prev !== el) el.__focus(el);
}

export function current() {
  const layer = top();
  return layer ? layer.current : null;
}

export function focusFirst(root) {
  const layer = top();
  if (!layer) return;
  const scope = root || layer.root;
  const pref = $$('[data-autofocus]', scope).filter(isVisible)[0];
  const el = pref || candidates(scope)[0];
  if (el) focus(el);
}

// Subindo para a barra de cima: a aba da tela atual (Início, Favoritos, Biblioteca...). Na NSFW,
// o foco não fica no cadeado: vai para o Início.
function topbarTarget(bar) {
  const active = bar.querySelector('.tab.active');
  if (active && active.getAttribute('data-tab') !== 'nsfw' && isVisible(active)) return active;
  const home = bar.querySelector('.tab[data-tab="home"]');
  return home && isVisible(home) ? home : null;
}

export function move(dir) {
  const layer = top();
  if (!layer) return false;
  const cur = layer.current;
  if (!cur || !document.body.contains(cur) || !isVisible(cur)) {
    focusFirst();
    return true;
  }
  // Telas com [data-stay] (categorias da NSFW) não mandam o foco para a barra de cima: subir na
  // última fileira fica nela. Quem sai é o Voltar.
  const stay = cur.closest('[data-stay]') && !cur.closest('.topbar');
  const group = cur.closest('[data-group]');
  const horizontal = dir === 'left' || dir === 'right';
  if (group && horizontal === !group.hasAttribute('data-vertical')) {
    // Esquerda/direita normalmente ficam na fileira: não mede centenas de capas
    // das outras fileiras a cada tecla (cada offsetParent/rect pode forçar layout).
    const inGroup = candidates(group).filter((e) => e !== cur);
    const g = pick(inGroup, cur, dir);
    if (g) {
      focus(g);
      return true;
    }
    if (group.hasAttribute('data-trap')) return false;
  }
  const all = candidates(layer.root).filter((e) => e !== cur && !(stay && e.closest('.topbar')));
  let best = pick(all, cur, dir);
  if (!best) return false;
  const bg = best.closest('[data-group]');
  if (bg && bg !== group) {
    if (bg.classList.contains('topbar')) best = topbarTarget(bg) || best;
    // Fileira (rolagem na horizontal) chegando de cima ou de baixo: sempre o primeiro item dela.
    else if (!horizontal && bg.hasAttribute('data-scroll-x')) best = all.filter((e) => bg.contains(e))[0] || best;
    else if (bg.__last && bg.contains(bg.__last) && isVisible(bg.__last)) best = bg.__last;
  }
  focus(best);
  return true;
}

export function select(el) {
  const target = el || current();
  if (!target) return;
  if (target.tagName === 'INPUT') {
    target.focus();
    return;
  }
  if (target.__select) target.__select(target);
}

// Camadas: cada tela/modal empilha a sua; o foco fica preso na de cima.
export function pushLayer(root, handlers) {
  const layer = Object.assign({ root: root, current: null }, handlers || {});
  layers.push(layer);
  return layer;
}

export function popLayer(layer) {
  const i = layers.indexOf(layer);
  if (i >= 0) layers.splice(i, 1);
  if (layer && layer.root) {
    $$('[data-scroll-x], [data-scroll-y]', layer.root).forEach((node) => {
      if (node.__anim) cancelAnimationFrame(node.__anim);
      node.__anim = null;
    });
  }
  const t = top();
  if (t && t.current) {
    if (t.root.contains(t.current)) t.current.classList.add('focused');
    else t.current = null;
  }
}

export function topLayer() {
  return top();
}

export function onScroll(fn) {
  scrollHook = fn;
}

export function isPointerMode() {
  return pointerMode;
}

function onKeyDown(e) {
  const layer = top();
  if (!layer) return;
  const code = e.keyCode;
  const active = document.activeElement;
  const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  if (typing) {
    // 65376/65385: "Concluído"/"Cancelar" do teclado na tela da Samsung (não mandam Enter).
    if (code === KEY.ENTER || code === 65376) {
      e.preventDefault();
      active.blur();
      if (active.__submit) active.__submit(active.value);
    } else if (code === KEY.BACK || code === KEY.ESC || code === 65385) {
      e.preventDefault();
      active.blur();
    } else if (code === KEY.UP || code === KEY.DOWN) {
      active.blur();
    } else return;
  }
  if (code >= 37 && code <= 40 && pointerMode) pointerMode = false;
  if (layer.onKey && layer.onKey(e) === true) {
    e.preventDefault();
    return;
  }
  switch (code) {
    case KEY.LEFT:
      move('left');
      break;
    case KEY.RIGHT:
      move('right');
      break;
    case KEY.UP:
      move('up');
      break;
    case KEY.DOWN:
      move('down');
      break;
    case KEY.ENTER:
    case KEY.SPACE: // no navegador, a barra de espaço também aperta o item em foco
      select();
      break;
    case KEY.BACK:
    case KEY.ESC:
    case KEY.BACKSPACE:
      if (layer.onBack) layer.onBack();
      break;
    default:
      return;
  }
  e.preventDefault();
}

function onMouseOver(e) {
  const layer = top();
  if (!layer) return;
  pointerMode = true;
  const el = e.target.closest ? e.target.closest('[data-focus]') : null;
  if (el && layer.root.contains(el) && el !== layer.current) focus(el, { noScroll: true });
}

function onClick(e) {
  const layer = top();
  if (!layer) return;
  const el = e.target.closest ? e.target.closest('[data-focus]') : null;
  if (el && layer.root.contains(el)) {
    focus(el, { noScroll: true });
    select(el);
  }
}

let wheelLock = 0;
function onWheel(e) {
  const now = Date.now();
  if (now - wheelLock < 120) return;
  wheelLock = now;
  move(e.deltaY > 0 ? 'down' : 'up');
}

// No navegador a roda rola o que está embaixo do ponteiro (como em qualquer site): fileira na
// horizontal (ou Shift + roda), lista na vertical. O foco continua onde estava.
function onWebWheel(e) {
  const layer = top();
  const track = e.target.closest ? e.target.closest('[data-scroll-x]') : null;
  // Fora de uma lista (ex.: em cima, sobre o destaque), rola a lista principal da tela.
  const box = (e.target.closest ? e.target.closest('[data-scroll-y]') : null) || (layer && layer.root.querySelector('[data-scroll-y]'));
  if (track && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
    e.preventDefault();
    track.scrollLeft += e.deltaX || e.deltaY;
  } else if (box) {
    e.preventDefault();
    box.scrollTop += e.deltaY;
    if (scrollHook) scrollHook(box);
  }
}

export function install() {
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mouseover', onMouseOver);
  document.addEventListener('click', onClick);
  if (IS_WEB) document.addEventListener('wheel', onWebWheel, { passive: false });
  else document.addEventListener('mousewheel', onWheel);
}
