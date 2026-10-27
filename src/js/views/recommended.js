// Abas curadas com destaque no estilo Netflix: "Recomendado" (em alta, true crime, suspense,
// terror) e "Streamings" (novidades de cada serviço). Ao parar num título, o topo troca a arte
// (fade com zoom, sobre uma aurora enquanto a imagem não está pronta); parado mais um pouco, toca o
// trailer com fade de imagem e de som. Um trilho mostra em que categoria você está.
// "Ver tudo" no fim de cada fileira abre a categoria inteira (Recomendado › Suspense).
import { h, clear, loadVisibleImages } from '../lib/dom.js';
import * as nav from '../lib/nav.js';
import { KEY } from '../lib/nav.js';
import { topbar, card, skeletonCards, retrying, rowRetry, toast, pagedGrid } from '../ui.js';
import * as router from '../router.js';
import { openDetails } from './details.js';
import * as reco from '../api/recommend.js';
import { t } from '../lib/i18n.js';
import * as store from '../lib/store.js';

const ROW_LIMIT = 20;
const PREVIEW_MS = 350; // parado no título: troca o destaque
const TRAILER_MS = 3000; // parado mais um pouco: carrega o trailer
const REVEAL_MS = 2000; // trailer tocando há esse tempo sem engasgar: aparece (esconde o começo em baixa e a interface)
const ATTEMPT_MS = 9000; // trailer que não aparece nesse tempo: tenta o próximo
const MAX_TRAILERS = 4; // depois disso desiste e fica só a arte
const AUDIO_FADE_MS = 1600;
const NOCOOKIE = 'www.youtube-nocookie.com';
const YOUTUBE = 'www.youtube.com';

// Abre o título no Seraflix: os addons do Stremio usam o id do IMDb.
export function openItem(it) {
  toast(t('Abrindo {name}...', { name: it.name }), 2000);
  reco
    .imdbId(it)
    .then((imdb) => {
      if (!imdb) return toast(t('Esse ainda não está no catálogo do Stremio.'));
      openDetails(it.mediaType === 'tv' ? 'series' : 'movie', imdb);
    })
    .catch(() => toast(t('Não foi possível abrir')));
}

function metaLine(it) {
  // Sem a nota do TMDB aqui: notas no app são só IMDb e Rotten Tomatoes (na tela de detalhes).
  return [it.year, it.mediaType === 'tv' ? t('Série') : t('Filme')].filter(Boolean).join(' · ');
}

// ---------- Destaque: arte com transição + trailer ----------
function Billboard() {
  // Duas camadas de arte que se revezam (crossfade com zoom) sobre uma aurora animada.
  const bgA = h('div.reco-bg');
  const bgB = h('div.reco-bg');
  const frameBox = h('div.reco-trailer');
  const loading = h('div.reco-loading', null, h('div.spinner.small'));
  const title = h('div.reco-title');
  const meta = h('div.reco-meta');
  const desc = h('div.reco-desc');
  const el = h('div.reco-bill', null, [
    h('div.aurora', null, [h('i.a1'), h('i.a2'), h('i.a3')]),
    bgA,
    bgB,
    frameBox,
    h('div.reco-shade-left'),
    h('div.reco-shade-bottom'),
    loading,
    h('div.reco-info', null, [title, meta, desc]),
  ]);

  let front = bgA;
  let current = null;
  let previewTimer = null;
  let trailerTimer = null;
  let attemptTimer = null;
  let revealTimer = null;
  let fadeTimer = null;
  let token = 0;
  let queue = []; // trailers que ainda dá para tentar
  let attempt = { key: '', host: '' };
  let frameWin = null; // janela do iframe do trailer (para reconhecer as mensagens dele)
  let revealed = false;
  let unmuteAt = 0;
  let preloading = null;
  let alive = true;
  let artTimer = null;

  function stopArt() {
    if (preloading) {
      preloading.onload = preloading.onerror = null;
      preloading.src = '';
      preloading = null;
    }
  }

  function stopTrailer() {
    clearTimeout(trailerTimer);
    clearTimeout(attemptTimer);
    clearTimeout(revealTimer);
    clearInterval(fadeTimer);
    el.classList.remove('playing', 'buffering');
    queue = [];
    frameWin = null;
    revealed = false;
    clear(frameBox); // remove o iframe: para o som e solta a memória
  }

  function show(it) {
    if (!alive) return;
    current = it;
    token++;
    clearTimeout(previewTimer);
    stopArt();
    stopTrailer();
    previewTimer = setTimeout(() => render(it, token), PREVIEW_MS);
  }

  function render(it, tk) {
    if (!alive || tk !== token) return;
    title.textContent = it.name;
    meta.textContent = metaLine(it);
    desc.textContent = it.overview || '';
    setArt(it.backdrop, tk);
    // Um iframe do YouTube compete por RAM e decodificação com o motor torrent na TV.
    if (store.settings().lowMemory === false) trailerTimer = setTimeout(() => playTrailer(it, tk), TRAILER_MS);
  }

  // A arte só entra pronta (pré-carregada): nunca aparece se formando de cima para baixo.
  function setArt(url, tk) {
    if (!url) {
      front.classList.remove('show'); // sem arte: fica a aurora
      return;
    }
    if (store.settings().lowMemory !== false) url = url.replace(/(image\.tmdb\.org\/t\/p\/)\w+\//, '$1w780/');
    stopArt();
    const pre = preloading = new Image();
    pre.onload = () => {
      if (tk !== token) return;
      const back = front === bgA ? bgB : bgA;
      back.style.backgroundImage = 'url("' + url + '")';
      back.classList.remove('show');
      // Dois frames para o navegador pintar a imagem antes de animar.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!alive || tk !== token) return;
          clearTimeout(artTimer);
          const previous = front;
          back.classList.add('show');
          front.classList.remove('show');
          front = back;
          artTimer = setTimeout(() => {
            if (alive && tk === token && previous !== front) previous.style.backgroundImage = '';
          }, 750);
        })
      );
    };
    pre.src = url;
  }

  // ---- Trailer (YouTube) ----
  // O YouTube avisa por postMessage (enablejsapi) o estado do player. O trailer começa sem som e
  // escondido; só aparece depois de REVEAL_MS tocando sem engasgar (passa o começo em baixa
  // resolução e os botões que o YouTube mostra no início), com fade de imagem e de som.
  function onYouTubeMessage(e) {
    if (!frameWin || e.source !== frameWin) return;
    let msg = e.data;
    try {
      if (typeof msg === 'string') msg = JSON.parse(msg);
    } catch (err) {
      return;
    }
    if (!msg) return;
    const state = msg.event === 'onStateChange' ? msg.info : msg.info && msg.info.playerState;
    if (state === 1) onPlaying();
    else if (state === 3) onBuffering();
    else if (state === 2 && unmuteAt && Date.now() - unmuteAt < 2000) {
      // O navegador pausou ao ligar o som sem um clique: segue sem som.
      unmuteAt = 0;
      clearInterval(fadeTimer);
      command('mute');
      command('playVideo');
    } else if (state === 0) stopTrailer(); // acabou: volta para a arte
    if (msg.event === 'onError') onError(msg.info);
  }
  window.addEventListener('message', onYouTubeMessage);

  function onPlaying() {
    el.classList.remove('buffering');
    if (revealed || revealTimer) return;
    command('setPlaybackQuality', ['hd1080']);
    const tk = token;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      if (tk !== token) return;
      reveal();
    }, REVEAL_MS);
  }

  function onBuffering() {
    if (revealed) el.classList.add('buffering'); // travou no meio: mostra o carregando
    else {
      clearTimeout(revealTimer); // ainda escondido: espera tocar liso de novo
      revealTimer = null;
    }
  }

  function reveal() {
    revealed = true;
    clearTimeout(attemptTimer);
    el.classList.add('playing');
    report('tocou (' + attempt.host + ')');
    // Som em fade: liga mudo→volume 0 e sobe até 100.
    command('setVolume', [0]);
    command('unMute');
    unmuteAt = Date.now();
    const steps = 16;
    let i = 0;
    clearInterval(fadeTimer);
    fadeTimer = setInterval(() => {
      i++;
      command('setVolume', [Math.round((100 * i) / steps)]);
      if (i >= steps) clearInterval(fadeTimer);
    }, AUDIO_FADE_MS / steps);
  }

  function onError(code) {
    // 152/153: o YouTube não reconheceu quem está incorporando; tenta o mesmo trailer no youtube.com.
    if ((code === 152 || code === 153) && attempt.host === NOCOOKIE) {
      report('erro ' + code + ', tentando youtube.com');
      return load(attempt.key, YOUTUBE, token);
    }
    report('erro ' + code);
    nextTrailer(token);
  }

  function command(func, args) {
    if (frameWin) frameWin.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [], id: 1, channel: 'widget' }), '*');
  }

  // Diagnóstico do último trailer (aparece em Ajustes → Sobre e depuração).
  function report(what) {
    reco.setTrailerReport((current ? current.name + ': ' : '') + what);
  }

  function playTrailer(it, tk) {
    reco.trailerKeys(it).then((keys) => {
      if (!alive || tk !== token || document.hidden || el.offsetParent === null) return;
      queue = keys.slice(0, MAX_TRAILERS);
      nextTrailer(tk);
    }).catch(() => {});
  }

  // Próximo trailer da fila. Enquanto não aparece, nada muda na tela (a arte fica).
  function nextTrailer(tk) {
    const key = queue.shift();
    if (!key) {
      clearTimeout(attemptTimer);
      frameWin = null;
      clear(frameBox);
      return;
    }
    load(key, NOCOOKIE, tk);
  }

  function load(key, host, tk) {
    clearTimeout(attemptTimer);
    clearTimeout(revealTimer);
    revealTimer = null;
    el.classList.remove('playing', 'buffering');
    revealed = false;
    frameWin = null;
    unmuteAt = 0;
    clear(frameBox);
    if (tk !== token) return;
    attempt = { key: key, host: host };
    attemptTimer = setTimeout(() => {
      if (tk !== token || revealed) return;
      report('não começou em ' + ATTEMPT_MS / 1000 + 's');
      nextTrailer(tk);
    }, ATTEMPT_MS);
    const origin = window.location.protocol + '//' + window.location.host;
    // mute=1: vídeo sem som pode tocar sozinho; vq=hd1080: pede alta definição (o YouTube decide no fim).
    const src =
      'https://' + host + '/embed/' + key +
      '?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&disablekb=1&fs=0&cc_load_policy=0&vq=hd1080&enablejsapi=1&origin=' +
      encodeURIComponent(origin) + '&widget_referrer=' + encodeURIComponent(origin);
    const frame = h('iframe', { src: src, allow: 'autoplay; encrypted-media', referrerpolicy: 'strict-origin-when-cross-origin', tabindex: '-1', frameborder: '0' });
    frame.onload = () => {
      if (tk !== token || !frame.contentWindow) return;
      frameWin = frame.contentWindow;
      // Pede para o player mandar os eventos (o mesmo que a IFrame API do YouTube faz).
      frameWin.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
      command('addEventListener', ['onStateChange']);
      command('addEventListener', ['onError']);
      command('setPlaybackQuality', ['hd1080']);
    };
    frameBox.appendChild(frame);
  }

  function stop() {
    token++;
    clearTimeout(previewTimer);
    clearTimeout(artTimer);
    stopTrailer();
    stopArt();
    bgA.style.backgroundImage = bgB.style.backgroundImage = '';
    bgA.classList.remove('show');
    bgB.classList.remove('show');
  }

  return {
    el: el,
    show: show,
    stop: stop,
    resume: () => current && show(current),
    destroy: () => {
      alive = false;
      stop();
      current = null;
      window.removeEventListener('message', onYouTubeMessage);
    },
  };
}

// ---------- Trilho de categorias ----------
// Mostra todas as categorias da aba, com a atual em destaque, e a frase dela embaixo.
function Rail(defs) {
  const list = h('div.rail-items');
  const caption = h('div.rail-caption');
  const el = h('div.reco-rail', null, [list, caption]);
  let items = [];
  let active = -1;
  function setDefs(d) {
    defs = d;
    clear(list);
    items = defs.map((x) => h('div.rail-item', null, h('span', { text: t(x.short) })));
    items.forEach((x) => list.appendChild(x));
    active = -1;
  }
  function set(i) {
    if (i === active || !defs[i]) return;
    if (items[active]) items[active].classList.remove('on');
    active = i;
    items[i].classList.add('on');
    caption.textContent = t(defs[i].caption);
  }
  setDefs(defs);
  return { el: el, set: set, setDefs: setDefs };
}

// ---------- Fileiras ----------
// Fileira que não carregou: botão "Tentar de novo" que volta o esqueleto e recarrega.
export function showRetry(track, load, onFocus) {
  clear(track);
  track.appendChild(
    rowRetry(() => {
      clear(track);
      track.classList.add('pending');
      skeletonCards().forEach((c) => track.appendChild(c));
      load().then(() => {
        const first = track.querySelector('.card');
        if (first) nav.focus(first);
      });
    }, onFocus)
  );
}

// Só busca fileiras próximas da tela, uma por vez no modo leve. Sair/trocar de serviço
// invalida os resultados e impede que respostas antigas recriem cartões fora de vista.
function rowLoader(rows, built, onFirst) {
  let alive = true;
  let active = 0;
  const tasks = built.map((b) => ({ row: b.row, load: b.load, destroy: b.destroy, state: 'idle' }));
  function run() {
    if (!alive || rows.offsetParent === null) return;
    const light = store.settings().lowMemory !== false;
    const limit = window.innerHeight * (light ? 1.4 : 2.2);
    for (let i = 0; i < tasks.length && active < (light ? 1 : 2); i++) {
      const task = tasks[i];
      if (task.state !== 'idle') continue;
      if (i > 0 && task.row.getBoundingClientRect().top > limit) break;
      task.state = 'loading';
      active++;
      task.load().catch(() => {}).then(() => {
        if (!alive) return;
        active--;
        task.state = 'done';
        if (i === 0 && onFirst) onFirst();
        run();
      });
    }
  }
  return {
    run: run,
    destroy: () => {
      alive = false;
      tasks.forEach((task) => task.destroy && task.destroy());
      tasks.length = 0;
    },
  };
}

function buildRow(def, index, ctx) {
  let alive = true;
  const row = h('div.row.reco-row', { 'data-anchor': '0' });
  // data-trap: no fim da fileira o foco para ali (antes pulava para outra fileira fora da tela).
  const track = h('div.row-track.pending', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' }, skeletonCards());
  row.appendChild(track);
  // Fileiras acima da que está em foco somem (o espaço de cima é do destaque): sem nomes soltos
  // da fileira anterior aparecendo quando se chega na última.
  const focusRow = () => {
    ctx.rail.set(index);
    const all = row.parentNode ? row.parentNode.children : [];
    for (let i = 0; i < all.length; i++) all[i].classList.toggle('past', i < index);
  };
  const failed = () => alive && showRetry(
      track,
      () => load(),
      () => {
        focusRow();
        ctx.billboard.stop();
      }
    );
  const load = () =>
    retrying(() => alive ? def.load(1) : Promise.resolve([]))
      .then((items) => {
        if (!alive) return;
        clear(track);
        track.classList.remove('pending');
        if (!items.length) return failed();
        items.slice(0, store.settings().lowMemory !== false ? 12 : ROW_LIMIT).forEach((it) =>
          track.appendChild(
            card(it, {
              onSelect: () => openItem(it),
              onFocus: () => {
                focusRow();
                ctx.billboard.show(it);
              },
            })
          )
        );
        track.appendChild(
          h(
            'div.card.see-all',
            {
              focusable: true,
              onSelect: () => openCategory(ctx.crumb, def),
              onFocus: () => {
                focusRow();
                ctx.billboard.stop();
              },
            },
            [h('div.poster-wrap', null, h('div.see-all-label', null, [h('b', { text: t('Ver tudo') }), h('span', { text: t(def.title) })]))]
          )
        );
        loadVisibleImages(row);
      })
      .catch(failed);
  return { row: row, load: load, destroy: () => { alive = false; clear(track); } };
}

// Aba curada genérica. cfg: { tabId, crumb, defs }
function CuratedView(cfg) {
  const el = h('div.view.reco');
  const bar = topbar(cfg.tabId, router.goTab);
  const billboard = Billboard();
  const rail = Rail(cfg.defs);
  const rows = h('div.reco-rows.scroll-y', { 'data-scroll-y': '', 'data-pad-y': '40' });
  el.appendChild(billboard.el);
  el.appendChild(h('div.reco-top', null, bar));
  el.appendChild(rail.el);
  el.appendChild(rows);
  const ctx = { billboard: billboard, rail: rail, crumb: cfg.crumb };

  let loaded = false;
  let alive = true;
  let loader = null;
  function load() {
    if (loaded) return;
    loaded = true;
    if (!reco.available()) {
      rows.appendChild(h('div.hint', { text: t('Essa aba precisa da chave do TMDB (Ajustes → Metadados extras).') }));
      return;
    }
    rail.set(0);
    const built = cfg.defs.map((def, i) => buildRow(def, i, ctx));
    built.forEach((b) => rows.appendChild(b.row));
    // Primeira fileira já com destaque no primeiro título.
    loader = rowLoader(rows, built, () => {
      if (!alive || el.offsetParent === null) return;
      // Primeiro item focável da primeira fileira (o cartão, ou o "Tentar de novo" se ela falhou).
      const first = rows.firstChild && rows.firstChild.querySelector('[data-focus]');
      if (first && nav.current() && nav.current().closest('.topbar')) nav.focus(first);
    });
    loader.run();
  }

  // Trailer só com a aba à vista e o app na frente.
  const onVisibility = () => (document.hidden ? billboard.stop() : null);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    el: el,
    onShow: () => {
      load();
      if (loader) loader.run();
      const cur = nav.current();
      if (cur && cur.classList.contains('card') && !cur.classList.contains('see-all')) billboard.resume();
    },
    onHide: () => billboard.stop(),
    onScroll: () => loader && loader.run(),
    freeMemory: () => {
      if (loader) loader.destroy();
      loader = null;
      clear(rows);
      loaded = false;
      billboard.stop();
    },
    destroy: () => {
      alive = false;
      if (loader) loader.destroy();
      billboard.destroy();
      document.removeEventListener('visibilitychange', onVisibility);
      if (bar.__destroy) bar.__destroy();
    },
  };
}

export function RecommendedView() {
  return CuratedView({ tabId: 'recommended', crumb: 'Recomendado', defs: reco.ROWS });
}

// ---------- Streamings: trilho de logos no topo e uma "home" para cada serviço ----------
// Passar pelos logos troca a home (novidades, filmes, séries, aclamados); "Ver tudo" de Filmes ou
// Séries percorre o catálogo inteiro do serviço.
const SWITCH_MS = 450;

// Logo do serviço: esqueleto com brilho até carregar inteiro.
function providerLogo(p) {
  const im = h('img', { alt: p.name });
  im.onload = () => {
    im.classList.add('ready');
    if (im.parentNode) im.parentNode.classList.add('img-loaded');
  };
  im.onerror = () => im.parentNode && im.parentNode.classList.add('img-loaded');
  im.src = p.logo;
  return im;
}

export function StreamingsView() {
  const el = h('div.view.reco.streamings');
  const bar = topbar('streamings', router.goTab);
  const billboard = Billboard();
  const rail = Rail([]);
  const rows = h('div.reco-rows.scroll-y', { 'data-scroll-y': '', 'data-pad-y': '40' });
  const logos = reco.STREAMINGS.map((p) =>
    h('div.provider', { focusable: true, title: p.name, onFocus: () => scheduleSwitch(p), onSelect: () => switchTo(p, true) }, [
      h('div.provider-logo', null, providerLogo(p)),
      h('div.provider-name', { text: p.name }),
    ])
  );
  const providerRail = h('div.provider-rail', { 'data-group': '', 'data-trap': '' }, logos);
  el.appendChild(billboard.el);
  el.appendChild(h('div.reco-top', null, [bar, providerRail]));
  el.appendChild(rail.el);
  el.appendChild(rows);

  let current = null;
  let switchTimer = null;
  let loader = null;
  let alive = true;
  let generation = 0;

  function scheduleSwitch(p) {
    if (!alive) return;
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => switchTo(p), SWITCH_MS);
  }

  function switchTo(p, enterRows) {
    if (!alive) return;
    clearTimeout(switchTimer);
    if (current === p) {
      if (enterRows) focusFirstCard();
      return;
    }
    const my = ++generation;
    if (loader) loader.destroy();
    current = p;
    logos.forEach((l, i) => l.classList.toggle('on', reco.STREAMINGS[i] === p));
    billboard.stop();
    rail.setDefs(p.rows);
    rail.set(0);
    // Troca de serviço: as fileiras novas sobem e aparecem num fade (só opacity/transform, leve na TV).
    rows.classList.add('sw');
    clear(rows);
    rows.scrollTop = 0;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (alive && my === generation) rows.classList.remove('sw');
    }));
    const ctx = { billboard: billboard, rail: rail, crumb: 'Streamings › ' + p.name };
    const built = p.rows.map((def, i) => buildRow(def, i, ctx));
    built.forEach((b) => rows.appendChild(b.row));
    loader = rowLoader(rows, built, () => {
      if (!alive || my !== generation || el.offsetParent === null) return;
      // Prévia no destaque: o primeiro título da home do serviço (sem tirar o foco dos logos).
      const first = rows.querySelector('.card');
      const focused = nav.current();
      if (first && first.__focus && focused && !focused.closest('.reco-rows')) first.__focus(first);
      if (enterRows && current === p) focusFirstCard();
    });
    loader.run();
  }

  function focusFirstCard() {
    const first = rows.querySelector('.card');
    if (first) nav.focus(first);
  }

  const onVisibility = () => (document.hidden ? billboard.stop() : null);
  document.addEventListener('visibilitychange', onVisibility);

  // Navegação: a seta ↓ da barra de cima vai para os logos (e não para os filmes lá embaixo),
  // e a ↑ da primeira fileira volta para eles.
  function onKey(e) {
    const cur = nav.current();
    if (!cur) return false;
    const onLogo = () => nav.focus(providerRail.querySelector('.provider.on') || logos[0]);
    if (e.keyCode === KEY.DOWN && cur.closest('.topbar')) {
      onLogo();
      return true;
    }
    if (e.keyCode === KEY.UP && cur.closest('.reco-rows') && cur.closest('.row') === rows.firstChild) {
      onLogo();
      return true;
    }
    return false;
  }

  return {
    el: el,
    onKey: onKey,
    onShow: () => {
      if (!reco.available()) {
        if (!rows.firstChild) rows.appendChild(h('div.hint', { text: t('Essa aba precisa da chave do TMDB (Ajustes → Metadados extras).') }));
        return;
      }
      if (!current) switchTo(reco.STREAMINGS[0]);
      if (loader) loader.run();
      const cur = nav.current();
      if (cur && cur.classList.contains('card') && !cur.classList.contains('see-all')) billboard.resume();
    },
    onHide: () => {
      clearTimeout(switchTimer);
      billboard.stop();
    },
    onScroll: () => loader && loader.run(),
    freeMemory: () => {
      generation++;
      clearTimeout(switchTimer);
      if (loader) loader.destroy();
      loader = null;
      clear(rows);
      current = null;
      billboard.stop();
    },
    destroy: () => {
      alive = false;
      generation++;
      if (loader) loader.destroy();
      clearTimeout(switchTimer);
      billboard.destroy();
      document.removeEventListener('visibilitychange', onVisibility);
      if (bar.__destroy) bar.__destroy();
    },
  };
}

// ---------- Fileira simples (Início): título + frase, cartões e "Ver tudo" ----------
export function simpleRow(def, crumb) {
  if (def.moods) return moodRow(def, crumb);
  let alive = true;
  const row = h('div.row', { 'data-anchor': '30', cls: def.ranked ? 'ranked-row' : '' });
  row.appendChild(h('div.row-title', null, [t(def.title), h('small', { text: t(def.caption) })]));
  const track = h('div.row-track.pending', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' }, skeletonCards());
  row.appendChild(track);
  const failed = () => alive && showRetry(track, () => load());
  const load = () =>
    retrying(() => alive ? def.load(1) : Promise.resolve([]))
      .then((items) => {
        if (!alive) return;
        clear(track);
        track.classList.remove('pending');
        if (!items.length) {
          // "Porque você viu": sem recomendações para esse título, a fileira só não aparece.
          if (def.optional && row.parentNode) return row.parentNode.removeChild(row);
          return failed();
        }
        items.slice(0, def.ranked ? 10 : store.settings().lowMemory !== false ? 12 : ROW_LIMIT).forEach((it, i) => track.appendChild(card(it, { onSelect: () => openItem(it), rank: def.ranked ? i + 1 : 0 })));
        if (!def.ranked)
          track.appendChild(
            h('div.card.see-all', { focusable: true, onSelect: () => openCategory(crumb, def) }, [
              h('div.poster-wrap', null, h('div.see-all-label', null, [h('b', { text: t('Ver tudo') }), h('span', { text: t(def.title) })])),
            ])
          );
        loadVisibleImages(row);
      })
      .catch(failed);
  return { row: row, load: load, destroy: () => { alive = false; clear(track); } };
}

// Explore por clima: blocos coloridos que abrem a categoria inteira.
function moodRow(def, crumb) {
  const row = h('div.row', { 'data-anchor': '30' });
  row.appendChild(h('div.row-title', null, [t(def.title), h('small', { text: t(def.caption) })]));
  const track = h('div.row-track', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' });
  reco.MOODS.forEach((m) =>
    track.appendChild(
      h('div.card.mood', { focusable: true, onSelect: () => openCategory(crumb, m) }, [
        h('div.mood-tile', { style: { background: 'linear-gradient(135deg, ' + m.colors[0] + ' 0%, ' + m.colors[1] + ' 100%)' } }, [
          h('b', { text: t(m.title) }),
          h('span', { text: t(m.caption) }),
        ]),
      ])
    )
  );
  row.appendChild(track);
  return { row: row, load: () => Promise.resolve() };
}

// ---------- Ver tudo (Recomendado › Categoria) ----------
function openCategory(crumb, def) {
  router.push(CategoryView(crumb, def));
}

function CategoryView(crumb, def) {
  let alive = true;
  const el = h('div.view');
  const scroller = h('div.scroll-y', { 'data-scroll-y': '' });
  const header = h('div.reco-crumb', null, [h('span', { text: t(crumb) }), ' › ', h('b', { text: t(def.title) })]);
  const pg = pagedGrid({
    load: (page) => def.load(page).then((items) => alive ? items : []),
    key: (it) => it.mediaType + ':' + it.tmdbId,
    card: (it) => card(it, { onSelect: () => openItem(it) }),
  });
  scroller.appendChild(header);
  scroller.appendChild(pg.el);
  el.appendChild(scroller);
  return {
    el: el,
    onShow: () => pg.start(),
    destroy: () => {
      alive = false;
      if (pg.destroy) pg.destroy();
    },
  };
}
