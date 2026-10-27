// Tela inicial: Hero Banner rotativo + "Continuar assistindo" + fileiras escolhidas no TMDB
// (em alta, novidades dos streamings, aclamados...). Sem chave do TMDB, usa os catálogos dos addons.
import { h, clear, loadVisibleImages } from '../lib/dom.js';
import * as nav from '../lib/nav.js';
import { KEY } from '../lib/nav.js';
import * as addons from '../api/addons.js';
import * as stremio from '../api/stremio.js';
import * as hero from '../api/hero.js';
import { topbar, card, spinnerLine, skeletonCards, retrying, agendaPanel, eventDetail, dayLabel, eventTime, eventSoon } from '../ui.js';
import * as calendar from '../api/calendar.js';
import * as router from '../router.js';
import { openDetails } from './details.js';
import { t } from '../lib/i18n.js';
import * as reco from '../api/recommend.js';
import { simpleRow, showRetry } from './recommended.js';
import { genreName } from '../lib/genres.js';
import * as store from '../lib/store.js';
import { cinemaBackground } from '../lib/img.js';

const ROTATE_MS = 8000;

export function HomeView() {
  const el = h('div.view.home-view');
  const scroller = h('div.scroll-y', { 'data-scroll-y': '' });
  const bar = topbar('home', router.goTab);
  const heroUi = buildHero();
  const calRow = h('div.row.cal-row', { 'data-anchor': '30' });
  const cwRow = h('div.row', { 'data-anchor': '30' });
  const rows = h('div.rows');
  scroller.appendChild(bar);
  scroller.appendChild(heroUi.el);
  scroller.appendChild(calRow);
  scroller.appendChild(cwRow);
  scroller.appendChild(rows);
  el.appendChild(scroller);

  let loadedBoard = false;
  let alive = true;
  let boardToken = 0;

  function renderContinue() {
    clear(cwRow);
    const items = stremio.continueWatching().filter((it) => !addons.isAdultId(it._id)).slice(0, 20);
    if (!items.length) {
      cwRow.style.display = 'none';
      return;
    }
    cwRow.style.display = '';
    cwRow.appendChild(h('div.row-title', { text: t('Continuar assistindo') }));
    const track = h('div.row-track', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' });
    items.forEach((it) => {
      const s = it.state;
      const ep = episodeLabel(s.video_id, it._id);
      const bg = /^tt\d+/.test(it._id) ? hero.background(it._id) : it.poster;
      track.appendChild(
        card(
          { name: it.name, poster: it.poster },
          {
            wide: true,
            image: bg,
            title: it.name + (ep ? ' · ' + ep : ''),
            progress: s.duration ? s.timeOffset / s.duration : 0,
            onSelect: () => openDetails(it.type, it._id, { videoId: s.video_id, autoStreams: true }),
          }
        )
      );
    });
    cwRow.appendChild(track);
    loadVisibleImages(cwRow);
  }

  // Sua agenda: cartões pequenos de hoje e de amanhã, cada dia com o seu rótulo. Abre o painel.
  function renderAgenda() {
    clear(calRow);
    if (!calendar.enabled()) {
      calRow.style.display = 'none';
      return;
    }
    calRow.style.display = '';
    calRow.appendChild(h('div.row-title', null, [t('Sua agenda')]));
    const track = h('div.row-track.cal-track', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' });
    if (calendar.loading()) {
      // Primeira busca: cartões com brilho no lugar, do mesmo tamanho dos de verdade.
      for (let i = 0; i < 4; i++) track.appendChild(h('div.cal-card.skel'));
      calRow.appendChild(track);
      return;
    }
    if (calendar.failed()) {
      track.appendChild(h('div.cal-card.empty', { focusable: true, text: t('Não consegui baixar a agenda. Toque para tentar de novo.'), onSelect: () => calendar.refresh() }));
      calRow.appendChild(track);
      return;
    }
    const d = calendar.days();
    const today = new Date();
    const now = Date.now();
    const group = (label, date, events) => {
      const cards = events.map((e) => {
        const soon = eventSoon(e);
        const sub = e.location || e.calendar || '';
        return h('div.cal-card', { focusable: true, cls: (e.end.getTime() <= now ? 'past' : '') + (soon ? ' soon' : ''), onSelect: () => eventDetail(e) }, [
          h('div.cal-card-top', null, [h('span.cal-card-time', null, [h('i', { style: { background: e.color } }), eventTime(e)]), soon ? h('span.cal-badge', { text: soon }) : null]),
          h('div.cal-card-title', { text: e.title }),
          h('div.cal-card-sub', { text: e.end.getTime() <= now ? t('Terminou') + (sub ? ' · ' + sub : '') : sub }),
        ]);
      });
      if (!cards.length) cards.push(h('div.cal-card.empty', { focusable: true, onSelect: () => agendaPanel(), text: t('Nada na agenda') }));
      return h('div.cal-group', null, [h('div.cal-day', null, [h('b', { text: label }), dayLabel(date, true)]), h('div.cal-cards', null, cards)]);
    };
    track.appendChild(group(t('HOJE'), today, d.today));
    track.appendChild(h('div.cal-sep'));
    track.appendChild(group(t('AMANHÃ'), new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1), d.tomorrow));
    calRow.appendChild(track);
  }
  const offCalendar = calendar.onChange(() => {
    // Não redesenha com o foco dentro da fileira (o cartão focado sumiria).
    if (!calRow.contains(nav.current())) renderAgenda();
  });

  // Fileiras sob demanda: só busca o catálogo quando a fileira chega perto da tela,
  // no máximo 2 ao mesmo tempo. Antes eram todas de uma vez e a TV ficava sem memória.
  let pending = [];
  let active = 0;

  function loadNearby() {
    if (!alive || el.offsetParent === null) return;
    const light = store.settings().lowMemory !== false;
    const limit = window.innerHeight * (light ? 1.4 : 2.2);
    const generation = boardToken;
    for (let i = 0; i < pending.length && active < (light ? 1 : 2); i++) {
      const p = pending[i];
      if (p.state !== 'idle') continue;
      if (!p.row.parentNode) {
        p.state = 'done';
        continue;
      }
      if (p.row.getBoundingClientRect().top > limit) break;
      p.state = 'loading';
      active++;
      p.load().catch(() => {}).then(() => {
        if (!alive || generation !== boardToken) return;
        p.state = 'done';
        active--;
        loadNearby();
      });
    }
  }

  function releaseRows() {
    boardToken++;
    pending.forEach((p) => p.destroy && p.destroy());
    pending = [];
    active = 0;
    clear(rows);
  }

  function renderBoard() {
    loadedBoard = true;
    releaseRows();
    const generation = boardToken;
    if (reco.available()) {
      // Depois do Top 10, até duas fileiras "Porque você viu X" com o que a pessoa assistiu por último.
      const defs = reco.HOME_ROWS.slice();
      const seeds = recentlyWatched().slice(0, 2);
      seeds.forEach((it, i) => defs.splice(1 + i, 0, reco.becauseYouWatched(it._id, it.name)));
      pending = defs.map((def) => {
        const r = simpleRow(def, 'Início');
        rows.appendChild(r.row);
        return Object.assign(r, { state: 'idle' });
      });
      loadNearby();
      return;
    }
    rows.appendChild(spinnerLine(t('Carregando catálogos...')));
    addons
      .load()
      .then(() => {
        if (!alive || generation !== boardToken) return;
        clear(rows);
        const cats = addons.boardCatalogs();
        if (!cats.length) rows.appendChild(h('div.row-empty', { text: t('Nenhum catálogo. Entre na sua conta em Ajustes.') }));
        pending = cats.map((c) => Object.assign(buildRow(c, rows), { state: 'idle' }));
        loadNearby();
      })
      .catch((e) => {
        if (!alive || generation !== boardToken) return;
        clear(rows);
        rows.appendChild(h('div.row-empty', { text: t('Erro ao carregar addons: {msg}', { msg: e.message }) }));
      });
  }

  heroUi.load();

  const view = {
    el: el,
    onShow: () => {
      renderAgenda();
      renderContinue();
      if (!loadedBoard) renderBoard();
      else loadNearby(); // fileiras que ficaram esperando enquanto a tela estava escondida
      heroUi.resume();
      loadVisibleImages(el);
    },
    onHide: () => heroUi.pause(),
    onScroll: () => loadNearby(),
    // Chamado quando um vídeo começa: solta as fileiras (o catálogo volta do cache ao retornar).
    freeMemory: () => {
      view.restoreFocus = null;
      releaseRows();
      loadedBoard = false;
    },
    onKey: (e) => heroUi.onKey(e),
    reload: () => {
      heroUi.load();
      renderBoard();
    },
    destroy: () => {
      alive = false;
      releaseRows();
      offCalendar();
      heroUi.destroy();
      if (bar.__destroy) bar.__destroy();
    },
  };
  return view;
}

// Títulos (com id do IMDb) que a pessoa assistiu por último, do mais recente.
function recentlyWatched() {
  return stremio
    .cachedLibrary()
    .filter((it) => /^tt\d+$/.test(it._id) && it.name && it.state && it.state.lastWatched && (it.type === 'movie' || it.type === 'series'))
    .sort((a, b) => String(b.state.lastWatched).localeCompare(String(a.state.lastWatched)));
}

function episodeLabel(videoId, metaId) {
  if (!videoId || videoId === metaId) return '';
  const m = String(videoId).match(/:(\d+):(\d+)$/);
  return m ? 'T' + m[1] + ' E' + m[2] : '';
}

const ROW_LIMIT = 20;

function buildRow(entry, parent) {
  let alive = true;
  const row = h('div.row', { 'data-anchor': '30' });
  const title = h('div.row-title', null, [entry.catalog.name || entry.catalog.id, h('small', { text: typeLabel(entry.catalog.type) + ' · ' + (entry.addon.manifest.name || '') })]);
  const track = h('div.row-track.pending', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' }, skeletonCards());
  row.appendChild(title);
  row.appendChild(track);
  parent.appendChild(row);
  const failed = () => alive && showRetry(track, () => load());
  const load = () =>
    retrying(() => alive ? addons.fetchCatalog(entry) : Promise.resolve([]))
      .then((metas) => {
        if (!alive) return;
        clear(track);
        track.classList.remove('pending');
        if (!metas.length) {
          // Catálogo de addon vazio de verdade: some (não é falha de rede).
          if (row.parentNode) parent.removeChild(row);
          return;
        }
        metas.slice(0, store.settings().lowMemory !== false ? 12 : ROW_LIMIT).forEach((m) => {
          track.appendChild(
            card(m, {
              onSelect: () => openDetails(m.type || entry.catalog.type, m.id),
            })
          );
        });
        loadVisibleImages(row);
      })
      .catch(failed);
  return { row: row, load: load, destroy: () => { alive = false; clear(track); } };
}

function typeLabel(type) {
  return { movie: t('Filmes'), series: t('Séries'), anime: t('Animes'), channel: t('Canais'), tv: 'TV' }[type] || type;
}

// ---------- Hero Banner ----------
function buildHero() {
  // Divs com background-image (tamanho fixo): a imagem só aparece pronta, já no tamanho final.
  const bgA = h('div.hero-bg');
  const bgB = h('div.hero-bg');
  const logo = h('img.hero-logo', { alt: '' });
  const title = h('div.hero-title');
  const meta = h('div.hero-meta');
  const desc = h('div.hero-desc');
  const dots = h('div.hero-dots');
  const watchBtn = h('div.btn.primary', { focusable: true, html: '<span class="ico">▶</span>' + t('Assistir'), onSelect: () => open(true) });
  const infoBtn = h('div.btn', { focusable: true, html: '<span class="ico">ⓘ</span>' + t('Detalhes'), onSelect: () => open(false) });
  const buttons = h('div.hero-buttons', { 'data-group': '' }, [watchBtn, infoBtn]);
  buttons.__last = watchBtn; // entrar no banner sempre pelo "Assistir"
  const el = h('div.hero', { 'data-anchor': '0' }, [
    h('div.aurora', null, [h('i.a1'), h('i.a2'), h('i.a3')]), // fundo vivo enquanto a arte não chega
    bgA,
    bgB,
    h('div.hero-shade-left'),
    h('div.hero-shade-bottom'),
    h('div.hero-info', null, [logo, title, meta, desc, buttons, dots]),
  ]);

  let items = [];
  let index = 0;
  let timer = null;
  let front = bgA;
  let paused = true;
  let bgToken = 0;
  let loadToken = 0;
  let alive = true;
  let preloading = null;
  let fadeTimer = null;

  function open(play) {
    const it = items[index];
    if (it) openDetails(it.type, it.id, { autoStreams: play });
  }

  function render() {
    if (!alive || paused) return;
    const it = items[index];
    if (!it) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const back = front === bgA ? bgB : bgA;
    if (preloading) { preloading.onload = preloading.onerror = null; preloading.src = ''; }
    const artUrl = store.settings().lowMemory !== false ? cinemaBackground(it.background) : it.background;
    const pre = preloading = new Image();
    const releasePreload = () => {
      if (preloading === pre) preloading = null;
      pre.onload = pre.onerror = null;
      pre.src = '';
    };
    pre.onerror = releasePreload;
    const token = ++bgToken;
    pre.onload = () => {
      if (token !== bgToken) return;
      back.style.backgroundImage = 'url("' + artUrl + '")';
      // Dois frames para o fundo ser pintado antes do fade.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!alive || paused || token !== bgToken) return;
          clearTimeout(fadeTimer);
          const previous = front;
          back.classList.add('show');
          front.classList.remove('show');
          front = back;
          releasePreload();
          fadeTimer = setTimeout(() => {
            if (alive && !paused && token === bgToken && previous !== front) previous.style.backgroundImage = '';
          }, 750);
        })
      );
    };
    pre.src = artUrl;
    title.textContent = it.name;
    title.style.display = 'none';
    logo.style.display = '';
    logo.onerror = () => {
      logo.style.display = 'none';
      title.style.display = '';
    };
    logo.src = it.logo;
    const parts = [];
    if (it.year) parts.push(it.year);
    if (it.runtime) parts.push(it.runtime);
    if (it.genres && it.genres.length) parts.push(it.genres.slice(0, 3).map(genreName).join(', '));
    meta.innerHTML = (it.rating ? '<span class="imdb-mini">IMDb</span> ' + escapeHtml(it.rating) + ' · ' : '') + escapeHtml(parts.join(' · '));
    desc.textContent = it.description || '';
    clear(dots);
    items.forEach((_, i) => dots.appendChild(h('span', { cls: i === index ? 'on' : '' })));
    // Pré-carrega o próximo fundo.
    const nx = items[(index + 1) % items.length];
    if (nx && store.settings().lowMemory === false) new Image().src = nx.background;
  }

  function schedule() {
    clearTimeout(timer);
    if (!alive || paused || items.length < 2 || store.settings().lowMemory !== false) return;
    timer = setTimeout(() => {
      index = (index + 1) % items.length;
      render();
      schedule();
    }, ROTATE_MS);
  }

  function go(delta) {
    if (!items.length) return;
    index = (index + delta + items.length) % items.length;
    render();
    schedule();
  }

  return {
    el: el,
    load: () => {
      const generation = ++loadToken;
      return hero
        .load()
        .then((list) => {
          if (!alive || generation !== loadToken) return;
          items = list.slice(0, 12);
          index = 0;
          render();
          schedule();
        })
        .catch(() => {
          if (!alive || generation !== loadToken) return;
          items = [];
          render();
        });
    },
    // Fora de vista, o banner solta os fundos (2 imagens 1920x1080 ≈ 16 MB na memória).
    pause: () => {
      paused = true;
      clearTimeout(timer);
      clearTimeout(fadeTimer);
      bgToken++;
      if (preloading) { preloading.onload = preloading.onerror = null; preloading.src = ''; preloading = null; }
      bgA.style.backgroundImage = '';
      bgB.style.backgroundImage = '';
      bgA.classList.remove('show');
      bgB.classList.remove('show');
      logo.removeAttribute('src');
    },
    resume: () => {
      paused = false;
      if (items.length) render();
      schedule();
    },
    destroy: () => {
      alive = false;
      loadToken++;
      bgToken++;
      clearTimeout(timer);
      clearTimeout(fadeTimer);
      if (preloading) { preloading.onload = preloading.onerror = null; preloading.src = ''; preloading = null; }
      bgA.style.backgroundImage = bgB.style.backgroundImage = '';
      logo.removeAttribute('src');
      items = [];
    },
    // Esquerda no primeiro botão / direita no último: troca o destaque.
    onKey: (e) => {
      const cur = nav.current();
      if (!cur || !buttons.contains(cur)) return false;
      if (e.keyCode === KEY.LEFT && cur === watchBtn) {
        go(-1);
        return true;
      }
      if (e.keyCode === KEY.RIGHT && cur === infoBtn) {
        go(1);
        return true;
      }
      return false;
    },
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
