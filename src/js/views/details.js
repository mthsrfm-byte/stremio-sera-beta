// Detalhes: informações à esquerda; à direita, episódios (séries) ou fontes (streams).
import { h, clear, loadVisibleImages } from '../lib/dom.js';
import * as nav from '../lib/nav.js';
import * as addons from '../api/addons.js';
import * as stremio from '../api/stremio.js';
import * as server from '../api/server.js';
import * as hero from '../api/hero.js';
import { toast, spinnerLine, menu, fmtTime, choiceDialog } from '../ui.js';
import * as router from '../router.js';
import { openPlayer } from './player.js';
import * as extras from '../api/extras.js';
import { smallThumb } from '../lib/img.js';
import { t } from '../lib/i18n.js';
import { log } from '../lib/log.js';
import * as si from '../lib/streaminfo.js';
import * as nsfwSaved from '../lib/nsfwSaved.js';
import * as store from '../lib/store.js';
import { genreName } from '../lib/genres.js';
import { openFilmography } from './filmography.js';

// Logos das notas (SVG pequeno, sem depender de imagem externa).
const IMDB_SVG =
  '<svg class="imdb-logo" viewBox="0 0 64 32" aria-label="IMDb"><rect width="64" height="32" rx="5" fill="#F5C518"/>' +
  '<text x="32" y="23" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-size="18" fill="#000">IMDb</text></svg>';
const RT_SVG =
  '<svg viewBox="0 0 32 32" aria-label="Rotten Tomatoes"><circle cx="16" cy="18" r="12" fill="#FA320A"/>' +
  '<path d="M16 6c-2-3-6-3-8-1 3 0 5 1 6 3-3-1-6 0-7 2 3-1 6 0 8 1 2-1 5-2 8-1-1-2-4-3-7-2 1-2 3-3 6-3-2-2-6-2-6 1z" fill="#00912D"/>' +
  '<ellipse cx="11" cy="15" rx="3" ry="2" fill="#fff" opacity="0.35"/></svg>';

// Foto do elenco: esqueleto com brilho até a foto chegar inteira; sem foto, só o círculo.
function castPhoto(url) {
  const ph = h('div.ph');
  if (!url) {
    ph.classList.add('img-loaded');
    return ph;
  }
  const im = h('img', { alt: '' });
  im.onload = () => {
    im.classList.add('ready');
    ph.classList.add('img-loaded');
  };
  im.onerror = () => {
    im.style.display = 'none';
    ph.classList.add('img-loaded');
  };
  im.src = url;
  ph.appendChild(im);
  return ph;
}

// Bandeira do Brasil desenhada (a fonte da TV não tem emoji de bandeira).
const BR_FLAG =
  '<svg class="flag" width="24" height="17" viewBox="0 0 24 17"><rect width="24" height="17" rx="3" fill="#009C3B"/><path d="M12 2.2 21.4 8.5 12 14.8 2.6 8.5z" fill="#FFDF00"/><circle cx="12" cy="8.5" r="3.6" fill="#002776"/></svg>';

export function openDetails(type, id, opts) {
  router.push(DetailsView(type, id, opts || {}));
}

export function sortedVideos(meta) {
  return (meta.videos || [])
    .filter((v) => v && v.id)
    .slice()
    .sort((a, b) => {
      const sa = a.season === 0 ? 9999 : a.season || 0;
      const sb = b.season === 0 ? 9999 : b.season || 0;
      return sa - sb || (a.episode || 0) - (b.episode || 0);
    });
}

function DetailsView(type, id, opts) {
  const el = h('div.view');
  const bg = h('img.details-bg', { alt: '' });
  const info = h('div.details-info', null, spinnerLine(t('Carregando...')));
  const panel = h('div.details-panel');
  el.appendChild(bg);
  el.appendChild(h('div.details-shade'));
  el.appendChild(info);
  el.appendChild(panel);

  let meta = null;
  let mode = 'none';
  let season = null;
  let streamsVideo = null;
  let alive = true;
  let watchBtn = null;
  let libBtn = null;
  let tmdbInfo = null;

  const isSeries = () => meta && sortedVideos(meta).length > 0 && meta.type !== 'movie';

  function movieVideoId() {
    return (meta.behaviorHints && meta.behaviorHints.defaultVideoId) || meta.id;
  }

  function nextUpVideo() {
    const vids = sortedVideos(meta);
    const li = stremio.libraryItem(meta.id);
    if (li && li.state && li.state.video_id) {
      const i = vids.findIndex((v) => v.id === li.state.video_id);
      if (i >= 0) return vids[i];
    }
    return vids.filter((v) => v.season !== 0 && !isUpcoming(v))[0] || vids[0];
  }

  function renderInfo() {
    clear(info);
    const logo = h('img.details-logo', { alt: '' });
    const title = h('div.details-title', { text: meta.name });
    title.style.display = 'none';
    logo.onerror = () => {
      logo.style.display = 'none';
      title.style.display = '';
    };
    logo.src = meta.logo || hero.logo(meta.id);
    const parts = [];
    if (meta.releaseInfo || meta.year) parts.push(meta.releaseInfo || meta.year);
    if (meta.runtime) parts.push(meta.runtime);
    if (isSeries()) {
      const seasons = uniqueSeasons().filter((s) => s !== 0);
      if (seasons.length) parts.push(t(seasons.length > 1 ? '{n} temporadas' : '{n} temporada', { n: seasons.length }));
    }
    const metaLine = h('div.details-meta', { text: parts.join('  ·  ') });
    const ratingsEl = h('div.ratings');
    renderRatings(ratingsEl, { imdb: meta.imdbRating ? String(meta.imdbRating) : null, critic: null, audience: null }, true);
    const genres = h(
      'div.details-genres',
      null,
      (meta.genres || meta.genre || []).slice(0, 5).map((g) => h('span', { text: genreName(g) }))
    );
    const desc = h('div.details-desc', { text: meta.description || '' });
    const cast = (meta.cast || []).slice(0, 5);
    const director = (meta.director || []).slice(0, 2);
    // Texto vindo do addon entra como texto, nunca como HTML (um addon malicioso não injeta código).
    const castLine = h('div.details-cast', null, [
      director.length ? h('b', { text: t('Direção: ') }) : null,
      director.length ? director.join(', ') + '   ' : null,
      cast.length ? h('b', { text: t('Elenco: ') }) : null,
      cast.length ? cast.join(', ') : null,
    ]);

    watchBtn = h('div.btn.primary', { focusable: true, 'data-autofocus': '', onSelect: onWatch });
    libBtn = h('div.btn', { focusable: true, onSelect: toggleLibrary });
    updateButtons();
    info.appendChild(logo);
    info.appendChild(title);
    info.appendChild(metaLine);
    info.appendChild(ratingsEl);
    if (isAdult() && meta.stats) info.appendChild(adultStats(meta.stats));
    info.appendChild(genres);
    info.appendChild(desc);
    // Botões antes do elenco: o foco começa no Assistir e o elenco fica logo abaixo, para explorar.
    info.appendChild(h('div.details-buttons', { 'data-group': '' }, [watchBtn, libBtn]));
    info.appendChild(castLine);
    loadExtras({ logo: logo, title: title, desc: desc, castLine: castLine, ratingsEl: ratingsEl });
  }

  // IMDb com o logo; Rotten Tomatoes num só selo: crítica à esquerda do tomate, público à direita.
  // Sem nota: "--". loading: as do Rotten Tomatoes ainda estão chegando (mostra "··").
  function renderRatings(el, r, loading) {
    clear(el);
    if (r.imdb) el.appendChild(h('span.rating.imdb', { html: IMDB_SVG }, h('span.rv', { text: r.imdb })));
    if (isAdult()) return; // vídeo adulto não tem nota no Rotten Tomatoes: o selo só mostraria "--"
    const pct = (v) => (v === null || v === undefined ? (loading ? '··' : '--') : v + '%');
    el.appendChild(
      h('span.rating.rt', { title: t('Rotten Tomatoes: crítica e público') }, [
        h('span.rv', { cls: r.critic === null ? 'none' : '', text: pct(r.critic) }),
        h('span.rt-logo', { html: RT_SVG }),
        h('span.rv', { cls: r.audience === null ? 'none' : '', text: pct(r.audience) }),
      ])
    );
  }

  // Notas extras e dados em PT-BR (TMDB/MDBList opcionais, AniList sem chave).
  function loadExtras(ui) {
    extras
      .ratings(meta)
      .then((r) => alive && renderRatings(ui.ratingsEl, r))
      .catch(() => alive && renderRatings(ui.ratingsEl, { imdb: meta.imdbRating ? String(meta.imdbRating) : null, critic: null, audience: null }));
    if (!extras.hasTmdb()) return;
    tmdbReady = extras
      .localized(meta)
      .then((loc) => loc, () => null);
    tmdbReady
      .then((loc) => {
        if (!alive || !loc) return;
        tmdbInfo = loc;
        if (loc.overview) ui.desc.textContent = loc.overview;
        if (loc.title) ui.title.textContent = loc.title;
        if (loc.logo) {
          ui.logo.style.display = '';
          ui.title.style.display = 'none';
          ui.logo.src = loc.logo;
        }
        if (loc.cast.length) {
          const row = h(
            'div.cast-row',
            { 'data-group': '' },
            loc.cast.slice(0, 7).map((c) =>
              h('div.cast', { focusable: !!c.id, onSelect: () => openFilmography(c) }, [
                castPhoto(c.photo),
                h('div.nm', { text: c.name }),
                h('div.ch', { text: c.character }),
              ])
            )
          );
          ui.castLine.parentNode.replaceChild(row, ui.castLine);
        }
        if (mode === 'episodes') localizeEpisodes();
      })
      .catch(() => {});
  }

  // Episódio em PT-BR pelo TMDB; guarda em video.namePt (o player usa no título).
  let tmdbReady = null;
  function ptEpisode(v) {
    if (!extras.hasTmdb() || !v || v.season === undefined) return Promise.resolve(null);
    return (tmdbReady || Promise.resolve(tmdbInfo))
      .then((info) => (info && info.tmdbType === 'tv' ? extras.seasonPt(info.tmdbId, v.season) : null))
      .then((map) => {
        const ep = map && map[v.episode];
        if (ep && ep.name) v.namePt = ep.name;
        return ep || null;
      })
      .catch(() => null);
  }

  // Troca títulos/sinopses dos episódios visíveis pelos do TMDB em PT-BR.
  function localizeEpisodes() {
    if (!tmdbInfo || tmdbInfo.tmdbType !== 'tv' || season === null) return;
    const forSeason = season;
    extras
      .seasonPt(tmdbInfo.tmdbId, season)
      .then((map) => {
        if (!alive || mode !== 'episodes' || forSeason !== season) return;
        Array.prototype.forEach.call(panel.querySelectorAll('.episode'), (row) => {
          const ep = map[row.__episode];
          if (!ep) return;
          if (ep.name) {
            row.querySelector('.ep-title').lastChild.textContent = row.__episode + '. ' + ep.name;
            if (row.__video) row.__video.namePt = ep.name;
          }
          if (ep.overview) row.querySelector('.ep-desc').textContent = ep.overview;
        });
      })
      .catch(() => {});
  }

  function updateButtons() {
    const li = stremio.libraryItem(meta.id);
    let label = t('Assistir');
    if (li && li.state && li.state.timeOffset > 0) {
      const ep = isSeries() ? sortedVideos(meta).find((v) => v.id === li.state.video_id) : null;
      label = t('Continuar') + (ep ? ' T' + ep.season + 'E' + ep.episode : '');
    }
    watchBtn.innerHTML = '<span class="ico">▶</span>' + label;
    // Adulto: "Salvar" guarda só neste aparelho (aba NSFW), em vez de ir para a biblioteca da conta.
    // Favoritar: filmes e séries vão para a biblioteca da conta; vídeos adultos ficam só nesta TV.
    const fav = isAdult() ? nsfwSaved.has(meta.id) : stremio.isInLibrary(meta.id);
    libBtn.classList.toggle('faved', fav);
    libBtn.innerHTML = fav ? '<span class="ico fav">♥</span>' + t('Favoritado') : '<span class="ico">♡</span>' + t('Favoritar');
  }

  // Vídeo adulto: os números que dizem se o vídeo é bom (aprovação, curtidas, visualizações, duração).
  function adultStats(st) {
    const box = (label, value, extra) =>
      h('div.astat', { cls: extra || '' }, [h('span.astat-label', { text: label }), h('b.astat-value', { text: value })]);
    const items = [];
    if (st.approval) {
      const a = box(t('Aprovação'), st.approval + '%', st.approval >= 85 ? 'hot' : '');
      a.appendChild(h('div.astat-bar', null, h('i', { style: { width: Math.min(100, st.approval) + '%' } })));
      items.push(a);
    }
    if (st.likes) items.push(box(t('Curtidas'), st.likes));
    if (st.views) items.push(box(t('Visualizações'), st.views));
    if (st.duration) items.push(box(t('Duração'), st.duration));
    return h('div.adult-stats', null, [st.channel ? h('div.astat-channel', { text: st.channel }) : null, h('div.astat-row', null, items)]);
  }

  function isAdult() {
    return addons.isAdultId(meta.id);
  }

  function onWatch() {
    if (isSeries()) {
      const v = nextUpVideo();
      if (v) watch(v);
    } else {
      watch({ id: movieVideoId(), title: meta.name });
    }
  }

  function toggleLibrary() {
    if (isAdult()) {
      const on = nsfwSaved.toggle(meta);
      updateButtons();
      toast(on ? t('♥ Favoritado') : t('Tirado dos favoritos'));
      return;
    }
    const inLib = stremio.isInLibrary(meta.id);
    stremio.setInLibrary(meta, !inLib).then(() => {
      updateButtons();
      toast(inLib ? t('Tirado dos favoritos') : t('♥ Favoritado'));
    });
  }

  function uniqueSeasons() {
    const out = [];
    sortedVideos(meta).forEach((v) => {
      const s = v.season || 0;
      if (out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  // ---------- Episódios ----------
  function showEpisodes(focusVideoId) {
    mode = 'episodes';
    clear(panel);
    const seasons = uniqueSeasons();
    if (season === null) {
      const nu = nextUpVideo();
      season = nu ? nu.season || 0 : seasons[0];
    }
    panel.appendChild(h('div.panel-head', null, h('h2', { text: t('Episódios') })));
    const chips = h(
      'div.seasons',
      { 'data-scroll-x': '', 'data-group': '', 'data-pad': '60' },
      seasons.map((s) =>
        h('div.chip', {
          focusable: true,
          cls: s === season ? 'active' : '',
          text: s === 0 ? t('Especiais') : t('Temporada {n}', { n: s }),
          onSelect: () => {
            season = s;
            showEpisodes();
            const first = panel.querySelector('.episode');
            if (first) nav.focus(first);
          },
        })
      )
    );
    panel.appendChild(chips);
    const list = h('div.list', { 'data-scroll-y': '', 'data-pad-y': '120', 'data-group': '', 'data-vertical': '' });
    list.style.top = '190px';
    const li = stremio.libraryItem(meta.id);
    let focusEl = null;
    sortedVideos(meta)
      .filter((v) => (v.season || 0) === season)
      .forEach((v) => {
        const thumb = h('div.thumb');
        if (v.thumbnail) {
          const im = h('img', { alt: '' });
          im.setAttribute('data-lazy', smallThumb(v.thumbnail));
          im.onerror = () => {
            im.style.display = 'none';
            thumb.classList.add('img-loaded'); // sem imagem: para o esqueleto
          };
          thumb.appendChild(im);
        } else thumb.classList.add('img-loaded');
        let sub = t('Episódio {n}', { n: v.episode || '?' });
        if (v.released) sub += ' · ' + formatDate(v.released);
        const inProgress = li && li.state && li.state.video_id === v.id && li.state.timeOffset > 0;
        if (inProgress) sub += ' · ' + t('parou em {time}', { time: fmtTime(li.state.timeOffset / 1000) });
        const soon = isUpcoming(v);
        const row = h('div.episode', { focusable: true, cls: soon ? 'upcoming' : '', onSelect: () => (soon ? toast(t('Esse episódio ainda não saiu. Estreia em {date}.', { date: formatDate(v.released) })) : watch(v)) }, [
          thumb,
          h('div.ep-info', null, [
            h('div.ep-title', null, [soon ? h('span.soon-tag', { text: t('Em breve') }) : null, (v.episode ? v.episode + '. ' : '') + (v.name || v.title || t('Episódio'))]),
            h('div.ep-sub', { text: sub }),
            h('div.ep-desc', { text: v.overview || v.description || '' }),
          ]),
        ]);
        row.__episode = v.episode;
        row.__video = v;
        if (v.id === focusVideoId || (!focusVideoId && inProgress)) focusEl = row;
        list.appendChild(row);
      });
    panel.appendChild(list);
    // Ao entrar na lista, cai no episódio em andamento (ou no primeiro), não no mais próximo.
    list.__last = focusEl || list.firstChild;
    localizeEpisodes();
    loadVisibleImages(panel, 300);
    if (focusEl && focusVideoId) setTimeout(() => nav.focus(focusEl), 0);
  }

  // ---------- Fontes (como no Kai do PC: filtro por addon, debrid primeiro) ----------
  function addonRank(a) {
    const n = (a.manifest.name || '') + ' ' + a.transportUrl;
    if (/realdebrid|alldebrid|premiumize|debridlink|torbox|easydebrid|offcloud|\bRD\b/i.test(n)) return 0;
    if (/torrentio/i.test(n)) return 1;
    return 2;
  }

  // Addons de streams na ordem de prioridade (debrid, Torrentio, o resto).
  function streamAddons(video) {
    return addons
      .withResource('stream', meta.type, video.id)
      .map((a, i) => ({ a: a, i: i }))
      .sort((x, y) => addonRank(x.a) - addonRank(y.a) || x.i - y.i)
      .map((x) => x.a);
  }

  const smartOn = () => store.settings().smartChoice !== false;

  // Assistir um episódio/filme: com Smart Choice vai direto para o player (sem a lista de fontes);
  // sem ele, mostra a lista.
  function watch(video) {
    if (smartOn() && streamAddons(video).length) smartPlay(video);
    else showStreams(video, true);
  }

  // Smart Choice: o player abre na hora e recebe a fonte quando os addons responderem (no máximo
  // ~12s). As fontes vão chegando em "all", na ordem de prioridade, para o menu Fontes do player.
  function smartPlay(video) {
    const srcs = streamAddons(video);
    const per = srcs.map(() => null);
    const all = [];
    let resolve = null;
    const pick = new Promise((ok) => (resolve = ok));
    let done = false;
    const serverReady = server.isAvailable() ? Promise.resolve(true) : server.check().then((r) => !!(r && r.ok), () => false);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      serverReady.then((ok) => {
        // Continuando: a mesma fonte da última vez, se ela ainda veio; senão, a escolha de sempre.
        const last = si.rememberedStream(video.id, all);
        if (last && si.canPlay(last, ok)) return resolve(last);
        const p = si.smartPick(all, ok);
        resolve(p ? p.stream : null);
      });
    };
    const timer = setTimeout(finish, 12000);
    serverReady
      .then(() =>
        addons.fetchStreams(meta.type, video.id, (addon, streams) => {
          per[srcs.indexOf(addon)] = streams;
          all.length = 0;
          per.forEach((l) => l && l.forEach((x) => all.push(x)));
          // A fonte da última vez já chegou: não precisa esperar os outros addons.
          if (si.rememberedStream(video.id, all)) finish();
        })
      )
      .then(finish, finish);
    // Nada tocável: volta com a lista aberta para escolher na mão e diz o porquê.
    pick.then((st) => {
      if (st || !alive) return;
      showStreams(video, true);
      const torrentsOnly = all.length && all.every((x) => server.needsServer(x));
      setTimeout(
        () =>
          toast(
            !all.length
              ? t('Nenhuma fonte encontrada para este título.')
              : torrentsOnly && !server.isAvailable()
                ? t('As fontes deste título são torrent: precisam do servidor do PC ligado.')
                : t('Nenhuma fonte deste título abre na TV.'),
            6000
          ),
        400
      );
    });
    play(video, null, all, pick);
  }

  function runtimeMinutes() {
    const r = String(meta.runtime || '');
    const hMatch = r.match(/(\d+)\s*h/i);
    const mMatch = r.match(/(\d+)\s*min/i);
    const mins = (hMatch ? parseInt(hMatch[1], 10) * 60 : 0) + (mMatch ? parseInt(mMatch[1], 10) : 0);
    return mins || (isSeries() ? 45 : 110);
  }

  // Taxa estimada do arquivo (tamanho ÷ duração): só aparece quando pesa no Wi-Fi da TV (~34 Mbps).
  function heavyMbps(info) {
    if (!info.sizeMb) return 0;
    const mbps = Math.round((info.sizeMb * 8) / (runtimeMinutes() * 60));
    return mbps > 30 ? mbps : 0;
  }

  function showStreams(video, focusFirst) {
    panel.style.display = '';
    mode = 'streams';
    streamsVideo = video;
    clear(panel);
    const headText = (name) => 'T' + video.season + 'E' + video.episode + ' · ' + (name || '');
    const head = isSeries() ? headText(video.namePt || video.name || video.title) : t('Fontes');
    const filterBtn = h('div.btn.small', { focusable: true, text: t('Todos ▾'), onSelect: () => filterMenu() });
    const headEl = h('h2', { text: head });
    panel.appendChild(h('div.panel-head', { 'data-group': '' }, [headEl, filterBtn]));
    if (isSeries() && !video.namePt)
      ptEpisode(video).then((ep) => {
        if (ep && ep.name && streamsVideo === video) headEl.textContent = headText(ep.name);
      });
    const sub = h('div.panel-sub');
    const barFill = h('i');
    panel.appendChild(sub);
    const loadBar = h('div.load-bar', null, barFill);
    panel.appendChild(loadBar);
    const list = h('div.list', { 'data-scroll-y': '', 'data-pad-y': '120', 'data-group': '', 'data-vertical': '' });
    list.style.top = '178px';
    panel.appendChild(list);
    const srcs = streamAddons(video);
    if (!srcs.length) {
      list.appendChild(h('div.loading-line', { text: t('Nenhum addon de streams instalado (ex.: Torrentio). Instale pela sua conta Stremio.') }));
      return;
    }
    // Um grupo por addon, já na ordem de prioridade; os streams entram no grupo certo ao chegar.
    const groups = srcs.map((a) => {
      const el = h('div.stream-group');
      list.appendChild(el);
      return { addon: a, el: el, count: 0, done: false, streams: [] };
    });
    const loadingLine = spinnerLine(t('Buscando fontes nos addons...'));
    list.appendChild(loadingLine);
    let filter = 'all';
    let pendingCount = srcs.length;
    const all = [];
    let autoFocused = null;
    let serverOk = server.isAvailable();
    function status() {
      const srv = server.nativeEnabled() ? t('Torrent na própria TV · experimental') : serverOk ? t('Servidor externo conectado') : t('Servidor externo não conectado: só links diretos');
      sub.textContent = srv + (pendingCount > 0 ? '  ·  ' + t('{n} addon(s) ainda carregando', { n: pendingCount }) : '  ·  ' + t('{n} fontes', { n: all.length }));
      barFill.style.width = Math.round(((srcs.length - pendingCount) / srcs.length) * 100) + '%';
      loadBar.classList.toggle('done', pendingCount <= 0);
      const g = groups.find((x) => x.addon.transportUrl === filter);
      filterBtn.textContent = (g ? g.addon.manifest.name : filter === 'dub' ? t('Dublados') : t('Todos')) + ' ▾';
    }

    function firstVisibleItem() {
      const items = list.querySelectorAll('.stream');
      for (let i = 0; i < items.length; i++) if (items[i].offsetParent !== null && !items[i].classList.contains('disabled')) return items[i];
      return null;
    }

    function applyFilter() {
      groups.forEach((g) => (g.el.style.display = filter === 'all' || filter === 'dub' || filter === g.addon.transportUrl ? '' : 'none'));
      list.classList.toggle('only-dub', filter === 'dub');
      list.scrollTop = 0;
      status();
      const first = firstVisibleItem();
      if (first) nav.focus(first);
    }

    function filterMenu() {
      const dubs = all.filter((x) => si.parse(x).dub).length;
      const opts = [
        { label: t('Todos'), sub: t('{n} fontes', { n: all.length }), value: 'all', checked: filter === 'all' },
        { label: t('Só dublados em português'), sub: t('{n} fontes', { n: dubs }), value: 'dub', checked: filter === 'dub' },
      ].concat(
        groups.map((g) => ({
          label: g.addon.manifest.name || g.addon.manifest.id,
          sub: g.done ? t('{n} fontes', { n: g.count }) : t('carregando...'),
          value: g.addon.transportUrl,
          checked: filter === g.addon.transportUrl,
        }))
      );
      menu(t('Mostrar fontes de'), opts, {
        onPick: (v) => {
          filter = v;
          applyFilter();
        },
      });
    }

    status();
    (serverOk ? Promise.resolve() : server.check().then((r) => (serverOk = r.ok)))
      .then(() => {
        status();
        return addons.fetchStreams(meta.type, video.id, (addon, streams) => {
          if (!alive || streamsVideo !== video) return;
          pendingCount--;
          const g = groups.find((x) => x.addon === addon);
          if (g) {
            g.done = true;
            g.count = streams.length;
            g.streams = streams;
            streams.forEach((s) => g.el.appendChild(streamItem(s, video, serverOk, all)));
            // "all" segue a ordem da tela (addon de maior prioridade primeiro), não a de chegada:
            // é nela que o Smart Choice e o player procuram a próxima fonte.
            all.length = 0;
            groups.forEach((x) => x.streams.forEach((s) => all.push(s)));
          }
          // Mantém o foco na primeira fonte (a de maior prioridade) enquanto o usuário não mexer.
          if (focusFirst && (!autoFocused || nav.current() === autoFocused)) {
            const first = firstVisibleItem();
            if (first) {
              autoFocused = first;
              nav.focus(first);
            }
          }
          if (pendingCount <= 0) {
            if (loadingLine.parentNode) list.removeChild(loadingLine);
            if (!all.length) list.appendChild(h('div.loading-line', { text: t('Nenhuma fonte encontrada.') }));
          }
          status();
        });
      })
      .catch(() => {});
  }

  // Fonte enxuta: nome do arquivo e só o que decide a escolha (qualidade, HDR/DV, dublado,
  // sinal de seeders, tamanho). Sem a fileira de bandeirinhas.
  function streamItem(s, video, serverOk, all) {
    const playableType = server.isPlayableType(s);
    const needs = server.needsServer(s);
    const disabled = !playableType || (needs && !serverOk);
    const info = si.parse(s);
    const tags = [];
    if (info.res) tags.push(h('span.s-tag.res', { cls: info.res === '4K' ? 'uhd' : '', text: info.res }));
    // A Samsung não tem Dolby Vision: o arquivo DV pode nem abrir (o Smart Choice deixa por último).
    if (info.dv) tags.push(h('span.s-tag.dv', { text: t('Dolby Vision · pode não abrir') }));
    else if (info.hdr) tags.push(h('span.s-tag.hdr', { text: 'HDR' }));
    if (info.dub) tags.push(h('span.s-tag.dub', { html: BR_FLAG + (info.original ? t('Original + Dublado') : t('Dublado')) }));
    if (info.remux) tags.push(h('span.s-tag', { text: 'REMUX' }));
    const heavy = heavyMbps(info);
    if (heavy) tags.push(h('span.s-tag.warn', { text: t('Pesado · ~{n} Mbps', { n: heavy }) }));
    if (!playableType) tags.push(h('span.s-tag.warn', { text: t('Não suportado na TV') }));
    else if (needs && !serverOk) tags.push(h('span.s-tag.warn', { text: t('Precisa de servidor externo') }));
    const stats = h('div.s-stats', null, [
      info.seeders !== null ? h('span.s-seed', { cls: 'lv' + si.signal(info.seeders), html: si.signalSvg(si.signal(info.seeders)) + '<b>' + info.seeders + '</b>' }) : null,
      info.cached ? h('span.s-seed.lv4', { html: si.signalSvg(4) + '<b>' + t('Instantâneo') + '</b>' }) : null,
      info.sizeMb ? h('span.s-size', { text: si.sizeText(info.sizeMb) }) : null,
      h('span.s-src', { text: info.addon + (server.isTorrent(s) ? ' · ' + t(server.nativeEnabled() ? 'torrent na TV' : 'torrent') : playableType ? ' · ' + t('direto') : '') }),
    ]);
    return h(
      'div.stream',
      {
        focusable: true,
        cls: (disabled ? 'disabled' : '') + (info.dub ? ' dub' : ''),
        onSelect: () => {
          if (!playableType) return toast(t('Esse tipo de fonte não abre na TV.'));
          if (needs && !serverOk) return toast(t('Esta fonte precisa do servidor externo. Configure em Ajustes.'), 5000);
          play(video, s, all);
        },
      },
      [h('div.s-body', null, [h('div.s-title', { text: info.file || (s.title || s.description || '').split('\n')[0] }), h('div.s-tags', null, tags), stats])]
    );
  }

  // stream null + pick: o player abre já e espera a fonte do Smart Choice.
  function play(video, stream, all, pick) {
    const li = stremio.libraryItem(meta.id);
    const resumeMs = li && li.state && li.state.video_id === video.id ? li.state.timeOffset : 0;
    const start = (ms) => openPlayer({ meta: meta, video: video, stream: stream, pick: pick, streams: all, startTime: ms, isSeries: isSeries() });
    if (resumeMs > 30000 && pick) {
      // Smart Choice: entra direto continuando; o player oferece "Do início".
      start(resumeMs);
    } else if (resumeMs > 30000) {
      choiceDialog(t('Continuar de onde parou?'), isSeries() ? 'T' + video.season + 'E' + video.episode + ' · ' + (video.namePt || video.name || '') : meta.name, [
        { label: '<span class="ico">▶</span>' + t('Continuar de {time}', { time: fmtTime(resumeMs / 1000) }), primary: true, onSelect: () => start(resumeMs) },
        { label: '<span class="ico">↺</span>' + t('Do início'), onSelect: () => start(0) },
      ]);
    } else start(0);
  }

  function isUpcoming(v) {
    const d = v && v.released ? new Date(v.released).getTime() : NaN;
    return !isNaN(d) && d > Date.now();
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
  }

  addons
    .load()
    .then(() =>
      addons.fetchMeta(type, id).catch((e) => {
        // Sem addon de detalhes (comum nos adultos): usa o item do catálogo e segue para as fontes.
        if (opts.fallbackMeta) return Object.assign({ type: type }, opts.fallbackMeta, { id: id });
        throw e;
      })
    )
    .then((m) => {
      if (!alive) return;
      meta = m;
      if (!meta.type) meta.type = type;
      bg.onerror = () => (bg.style.display = 'none');
      // Fundo como imagem sob demanda: é liberado quando o player abre por cima.
      bg.setAttribute('data-lazy', meta.background || hero.background(meta.id));
      loadVisibleImages(el);
      renderInfo();
      if (isSeries()) {
        if (opts.videoId) {
          const v = sortedVideos(meta).find((x) => x.id === opts.videoId);
          if (v) season = v.season || 0;
          if (v && opts.autoStreams) {
            watch(v);
            return;
          }
        }
        showEpisodes(opts.videoId);
        if (opts.autoStreams) {
          const v = nextUpVideo();
          if (v) watch(v);
          return;
        }
      } else {
        // Smart Choice: sem lista de fontes à vista (nem ao voltar do player); trocar é no player.
        if (smartOn()) panel.style.display = 'none';
        if (opts.autoStreams) watch({ id: movieVideoId(), title: meta.name });
        else if (!smartOn()) showStreams({ id: movieVideoId(), title: meta.name }, false);
      }
      if (!opts.autoStreams) nav.focus(watchBtn);
    })
    .catch((e) => {
      if (!alive) return;
      log.warn('Detalhes falharam', type, id, e && e.message);
      clear(info);
      info.appendChild(h('div.details-title', { text: t('Não foi possível abrir') }));
      info.appendChild(h('div.details-desc', { text: (e && e.message) || '' }));
      info.appendChild(
        h('div.details-buttons', { 'data-group': '' }, [
          h('div.btn.primary', {
            focusable: true,
            'data-autofocus': '',
            text: t('Tentar de novo'),
            onSelect: () => {
              router.pop();
              openDetails(type, id, opts);
            },
          }),
          h('div.btn', { focusable: true, text: t('Voltar'), onSelect: () => router.pop() }),
        ])
      );
      nav.focusFirst(el);
    });

  const view = {
    el: el,
    onShow: () => {
      if (meta && watchBtn) updateButtons();
      loadVisibleImages(panel, 300);
    },
    onBack: () => {
      if (mode === 'streams' && !isSeries() && smartOn()) {
        panel.style.display = 'none';
        mode = 'none';
        nav.focus(watchBtn);
        return true;
      }
      if (mode === 'streams' && isSeries()) {
        const v = streamsVideo;
        showEpisodes(v && v.id);
        return true;
      }
      return false;
    },
    destroy: () => {
      alive = false;
    },
  };
  return view;
}
