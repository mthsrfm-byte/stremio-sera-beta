// Ponto de entrada do Seraflix (Samsung Tizen, via TizenBrew).
import './polyfills.js';
import { log } from './lib/log.js';
import { t, init as initI18n } from './lib/i18n.js';
import * as nav from './lib/nav.js';
import { loadVisibleImages } from './lib/dom.js';
import * as store from './lib/store.js';
import * as stremio from './api/stremio.js';
import * as server from './api/server.js';
import * as addons from './api/addons.js';
import * as router from './router.js';
import { HomeView } from './views/home.js';
import { RecommendedView, StreamingsView } from './views/recommended.js';
import { NsfwView } from './views/nsfw.js';
import { SearchView } from './views/search.js';
import { LibraryView } from './views/library.js';
import { SettingsView } from './views/settings.js';
import { maybeShowWizard } from './views/wizard.js';
import { toast } from './ui.js';
import * as update from './api/update.js';
import * as sendToTv from './api/sendToTv.js';
import * as calendar from './api/calendar.js';
import { openDetails } from './views/details.js';
import * as profiles from './views/profiles.js';
import { applyTheme } from './lib/theme.js';
import { openLogin } from './views/login.js';
import { registerTizenKeys, IS_WEB } from './lib/platform.js';
import * as intro from './lib/intro.js';
import * as screensaver from './lib/screensaver.js';
import * as webkeys from './lib/webkeys.js';
import { ensureWebapis } from './lib/avplayer.js';

// Abertura (logo + som): o app só aparece depois dela, mesmo que carregue antes.
let introDone = Promise.resolve();

function boot() {
  const s = store.settings();
  ensureWebapis();
  initI18n();
  applyTheme(s);
  document.body.classList.toggle('low-memory', s.lowMemory !== false);
  introDone = intro.play(s.introSound !== false);
  if (s.devlogUrl) log.setRemote(s.devlogUrl);
  log.info('Iniciando', navigator.userAgent);

  registerTizenKeys();
  nav.install();
  if (IS_WEB) webkeys.install(); // F e duplo clique no vídeo: tela cheia (só no navegador)
  // Imagens e fileiras sob demanda depois que a rolagem para (segurar a seta não recalcula a cada passo).
  nav.setSmooth(s.lowMemory === false && s.smoothScroll);
  let scrollTimer = null;
  nav.onScroll((node) => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const v = router.currentView();
      loadVisibleImages(v ? v.el : node.closest('.view') || node);
      if (v && v.onScroll) v.onScroll();
    }, 120);
  });

  router.registerTab('home', HomeView);
  router.registerTab('recommended', RecommendedView);
  router.registerTab('search', SearchView);
  router.registerTab('library', LibraryView);
  router.registerTab('settings', SettingsView);
  router.registerTab('streamings', StreamingsView);
  router.registerTab('nsfw', NsfwView);

  // "Quem está assistindo?" (com mais de um perfil) antes de carregar a conta.
  if (profiles.needsPicker()) {
    // A abertura toca inteira e depois vem o "Quem está assistindo?".
    introDone.then(() => {
      const bootEl = document.getElementById('boot');
      if (bootEl) bootEl.style.display = 'none';
      profiles.showPicker(() => {
        intro.showStatic();
        start();
      });
    });
  } else start();

  // Ao voltar do segundo plano, revalida o servidor do PC.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) server.check();
  });
}

// Carrega o perfil escolhido: conta, biblioteca, addons e a tela inicial.
function start() {
  stremio.reloadProfile();
  const s = store.settings();
  applyTheme(s);
  document.body.classList.toggle('low-memory', s.lowMemory !== false);
  log.info('Perfil', store.activeProfile().name);

  // Atualiza a conta em segundo plano; a tela inicial abre com o cache.
  if (stremio.isLoggedIn()) {
    stremio.refreshUser().catch(() => {});
    stremio.getLibrary().catch(() => {});
  }

  Promise.all([server.check(), addons.load().catch(() => null), introDone]).then(() => {
    router.goTab('home');
    intro.finish(); // a abertura some em fade por cima da tela inicial já pronta
    // Pedidos do controle no celular ("Mandar para a TV").
    if (!IS_WEB) sendToTv.start(openFromPhone);
    calendar.start(); // agenda do Google (se tiver link em Ajustes)
    screensaver.install(); // lançamentos passando na tela depois de uns minutos parado
    if (profiles.isNewProfilePendingLogin() && !stremio.isLoggedIn()) {
      // Perfil novo: entra na conta Stremio deste perfil (para ter o histórico próprio).
      profiles.clearNewProfileFlag();
      openLogin(() => {
        Promise.all([stremio.refreshUser().catch(() => {}), addons.load(true), stremio.getLibrary()]).then(() => {
          const home = router.tabView('home');
          if (home && home.reload) home.reload();
        });
      });
    } else maybeShowWizard();
    // Avisa se saiu versão nova no GitHub (instala em Ajustes → Procurar atualização).
    if (!IS_WEB) {
      setTimeout(() => {
        update
          .check()
          .then((info) => info.isNew && toast(t('Tem Seraflix novo saindo do forno! Ajustes → Procurar atualização'), 7000))
          .catch(() => {});
      }, 8000);
    }
  });
}

// Abre o filme/série escolhido no celular. Se um vídeo estiver tocando, fecha o player antes
// pelo mesmo caminho do Voltar (salva o ponto onde parou); senão ele continuaria tocando por baixo.
function openFromPhone(req) {
  const cur = router.currentView();
  if (cur && cur.el && cur.el.classList.contains('player')) {
    if (cur.onBack) cur.onBack();
    else router.pop();
  }
  toast(t('Pedido do celular: {name}', { name: req.name || t('abrindo...') }));
  openDetails(req.type, req.id, req.play && req.type === 'movie' ? { autoStreams: true } : {});
}

// Fontes do app baixadas antes de qualquer coisa aparecer: sem isso a abertura e os títulos
// piscam (aparecem na fonte reserva e trocam quando a Bricolage Grotesque chega).
// Limite de 3s: se algo der errado, o app abre mesmo assim.
const FONTS = ['600', '700', '800'].map((w) => w + " 40px 'Bricolage Grotesque'").concat(['400', '500', '600', '700'].map((w) => w + " 24px 'Geist'"));

// Navegador antigo da TV pode não ter document.fonts, dar erro ou nunca responder: o app abre
// de qualquer jeito (no máximo 3s depois), com um setTimeout simples que não depende de Promise.
function ready() {
  // A classe vem daqui (não do HTML): se o index.html e o app.js chegarem de versões diferentes
  // pela atualização, a tela nunca fica escondida de vez.
  document.body.classList.add('fonts-pending');
  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    document.body.classList.remove('fonts-pending');
    boot();
  };
  setTimeout(go, 3000);
  try {
    if (!document.fonts || typeof document.fonts.load !== 'function') return go();
    let left = FONTS.length;
    const one = () => --left <= 0 && go();
    FONTS.forEach((f) => {
      try {
        const p = document.fonts.load(f, 'Seraflix ÁÉçã');
        if (p && typeof p.then === 'function') p.then(one, one);
        else one();
      } catch (e) {
        one();
      }
    });
  } catch (e) {
    go();
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
else ready();
