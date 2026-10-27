// Pilha de telas. Cada tela: { el, layer, onShow, onHide, onBack, destroy }.
import * as nav from './lib/nav.js';
import { platformBack } from './lib/tv.js';
import { IS_WEB } from './lib/platform.js';
import { confirmDialog } from './ui.js';
import { loadVisibleImages, unloadImages } from './lib/dom.js';
import { t } from './lib/i18n.js';

const stack = [];
const app = () => document.getElementById('app');
const tabs = {}; // telas principais reutilizadas (início, busca, biblioteca, ajustes)

function show(view) {
  view.el.classList.remove('hidden');
  if (view.layer) {
    nav.popLayer(view.layer);
  }
  view.layer = nav.pushLayer(view.el, {
    onBack: () => back(),
    onKey: view.onKey,
  });
  // Aba recém-aberta pela barra: foco na própria aba (antes ia para "Início", que parecia a ativa),
  // a não ser que a tela peça outro ponto de partida (data-autofocus, ex.: campo da Busca).
  const activeTab = view.tabId && !view.el.querySelector('[data-autofocus]') && view.el.querySelector('.topbar .tab.active');
  if (view.restoreFocus && view.el.contains(view.restoreFocus) && document.body.contains(view.restoreFocus)) nav.focus(view.restoreFocus, { noScroll: true });
  else if (activeTab) nav.focus(activeTab, { noScroll: true }); // aba recém-aberta: foco na própria aba
  else nav.focusFirst(view.el);
  if (view.onShow) view.onShow();
  loadVisibleImages(view.el);
}

function hide(view) {
  view.restoreFocus = nav.current();
  if (view.layer) nav.popLayer(view.layer);
  view.layer = null;
  view.el.classList.add('hidden');
  if (view.onHide) view.onHide();
  // Tela fora de vista não segura imagens na memória (a TV tem pouca RAM).
  unloadImages(view.el);
}

export function push(view) {
  const prev = stack[stack.length - 1];
  if (prev) hide(prev);
  if (!view.el.parentNode) app().appendChild(view.el);
  stack.push(view);
  show(view);
}

export function pop() {
  if (stack.length <= 1) return false;
  const view = stack.pop();
  hide(view);
  if (!view.keepAlive) {
    if (view.destroy) view.destroy();
    if (view.el.parentNode) view.el.parentNode.removeChild(view.el);
  }
  show(stack[stack.length - 1]);
  return true;
}

export function back() {
  const view = stack[stack.length - 1];
  if (view && view.onBack && view.onBack() === true) return;
  if (stack.length > 1) {
    pop();
    return;
  }
  // Voltar numa aba (inclusive a NSFW) leva ao Início com o foco no botão da casinha.
  if (view && view.tabId && view.tabId !== 'home') {
    goTab('home');
    const homeBtn = tabs.home && tabs.home.el.querySelector('.topbar .tab[data-tab="home"]');
    if (homeBtn) nav.focus(homeBtn, { noScroll: true });
    return;
  }
  if (IS_WEB) return; // no navegador não há "sair do app": fechar a aba é com o usuário
  confirmDialog(t('Sair do Stremio Kai?'), t('Sair'), () => platformBack());
}

// Troca de aba principal: limpa a pilha e mostra a aba (mantida viva).
export function goTab(id) {
  // Trocar de aba não precisa reexibir cada detalhe intermediário. pop() chamava
  // onShow() nessas telas e disparava novas buscas só para ocultá-las em seguida.
  while (stack.length > 1) {
    const leaving = stack.pop();
    hide(leaving);
    leaving.restoreFocus = null;
    if (!leaving.keepAlive) {
      if (leaving.destroy) leaving.destroy();
      if (leaving.el.parentNode) leaving.el.parentNode.removeChild(leaving.el);
    }
  }
  const cur = stack[0];
  if (cur && cur.tabId === id) {
    // A aba-base estava escondida enquanto os detalhes/player estavam na pilha.
    if (!cur.layer || cur.el.classList.contains('hidden')) show(cur);
    return;
  }
  let view = tabs[id];
  if (!view) {
    view = registry[id]();
    view.tabId = id;
    view.keepAlive = true;
    tabs[id] = view;
  }
  if (cur) {
    hide(cur);
    stack.length = 0;
    // Só a tela inicial fica viva; as outras abas são recriadas ao voltar (economiza memória).
    if (cur.tabId !== 'home') dropTab(cur.tabId);
  }
  if (!view.el.parentNode) app().appendChild(view.el);
  stack.push(view);
  show(view);
}

const registry = {};
export function registerTab(id, factory) {
  registry[id] = factory;
}

export function tabView(id) {
  return tabs[id] || null;
}

export function currentView() {
  return stack[stack.length - 1] || null;
}

export function dropTab(id) {
  const v = tabs[id];
  if (!v) return;
  delete tabs[id];
  v.restoreFocus = null;
  if (v.destroy) v.destroy();
  if (v.el.parentNode && stack.indexOf(v) < 0) v.el.parentNode.removeChild(v.el);
  if (v.layer) nav.popLayer(v.layer);
}
