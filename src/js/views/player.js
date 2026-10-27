// Player: <video> nativo da TV (decodificação por hardware), legendas próprias, faixas via Luna.
import { h, clear } from '../lib/dom.js';
import * as nav from '../lib/nav.js';
import { KEY } from '../lib/nav.js';
import * as subs from '../lib/subs.js';
import * as subpick from '../lib/subpick.js';
import * as substyle from '../lib/substyle.js';
import * as store from '../lib/store.js';
import { log } from '../lib/log.js';
import { getText, getJSON, clearCache } from '../lib/http.js';
import * as si from '../lib/streaminfo.js';
import * as hlsplay from '../lib/hlsplay.js';
import * as calendar from '../api/calendar.js';
import * as server from '../api/server.js';
import * as addons from '../api/addons.js';
import * as stremio from '../api/stremio.js';
import * as skip from '../api/skip.js';
import * as hero from '../api/hero.js';
import { menu, toast, fmtTime, timeHM, choiceDialog, eventTime, isFavorite, toggleFavorite } from '../ui.js';
import * as router from '../router.js';
import { sortedVideos, openDetails } from './details.js';
import { t } from '../lib/i18n.js';
import { IS_WEB } from '../lib/platform.js';

const HIDE_MS = 5000;
const SLOW_MS = 40000; // sem começar a tocar depois disso: oferece outro provedor
const SLOW_COUNTDOWN = 5;
const SAVE_MS = 15000;
const LANG_NAMES = {
  por: 'Português (Portugal)', pob: 'Português (BR)', pt: 'Português', 'pt-br': 'Português (BR)', eng: 'Inglês', en: 'Inglês',
  spa: 'Espanhol', es: 'Espanhol', jpn: 'Japonês', ja: 'Japonês', fre: 'Francês', fra: 'Francês', fr: 'Francês',
  ger: 'Alemão', deu: 'Alemão', de: 'Alemão', ita: 'Italiano', it: 'Italiano', kor: 'Coreano', ko: 'Coreano',
  chi: 'Chinês', zho: 'Chinês', rus: 'Russo', ara: 'Árabe', hin: 'Hindi', und: 'Indefinido',
};

function langName(code) {
  if (!code) return t('Desconhecido');
  const name = LANG_NAMES[String(code).toLowerCase()];
  return name ? t(name) : code;
}

// Ajuste de sincronia lembrado por vídeo (e pela legenda em que foi feito): ao continuar depois,
// a mesma legenda já volta no tempo certo.
const SYNC_KEY = 'subSync';
function savedSync(videoId) {
  return (store.get(SYNC_KEY, {}) || {})[videoId] || null;
}
function saveSync(videoId, subId, off) {
  const all = store.get(SYNC_KEY, {}) || {};
  if (!off || !subId) delete all[videoId];
  else all[videoId] = { sub: subId, off: off, at: Date.now() };
  const ids = Object.keys(all);
  if (ids.length > 150) {
    ids.sort((a, b) => all[a].at - all[b].at);
    ids.slice(0, ids.length - 150).forEach((k) => delete all[k]);
  }
  store.set(SYNC_KEY, all);
}

// +1,5 s / −0,3 s / 0,0 s
function fmtOff(v) {
  const r = Math.round(v * 10) / 10;
  return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(1).replace('.', ',') + ' s';
}

function isPt(lang) {
  return /^(pob|por|pt|pt-br|pt-pt|ptbr)$/i.test(lang || '');
}

// Eventos da agenda que já avisaram (não repete o aviso ao trocar de vídeo).
const calendarSeen = {};

export function openPlayer(opts) {
  router.push(PlayerView(opts));
}

function PlayerView(opts) {
  const meta = opts.meta;
  let video = opts.video;
  let stream = opts.stream;
  const settings = store.settings();

  const videoEl = h('video', { preload: 'auto' });
  // No navegador, clicar no vídeo pausa e toca (como nos players da web).
  if (IS_WEB) videoEl.addEventListener('click', () => togglePlay());
  const subsEl = h('div.subs');
  const titleEl = h('div.p-title');
  const clockEl = h('div.p-clock');
  const posEl = h('div.pos');
  const bufEl = h('div.buf');
  const knobEl = h('div.knob');
  const seekLabel = h('div.seek-label');
  const previewImg = h('div.seek-preview-img');
  const preview = h('div.seek-preview', null, previewImg);
  const bar = h('div.p-bar', { focusable: true, onSelect: () => togglePlay() }, [bufEl, posEl, knobEl, preview, seekLabel]);
  const curTimeEl = h('span');
  const durEl = h('span');
  const playBtn = h('div.btn', { focusable: true, onSelect: () => togglePlay() });
  const audioBtn = h('div.btn', { focusable: true, html: '<span class="ico">♫</span>' + t('Áudio'), onSelect: () => audioMenu() });
  const subsBtn = h('div.btn', { focusable: true, html: '<span class="ico">≡</span>' + t('Legendas'), onSelect: () => subsMenu() });
  const srcBtn = h('div.btn', { focusable: true, html: '<span class="ico">⇄</span>' + t('Fontes'), onSelect: () => sourcesMenu() });
  const nextBtn = h('div.btn', { focusable: true, html: '<span class="ico">⏭</span>' + t('Próximo'), onSelect: () => playNext() });
  // Favoritar sem sair do vídeo (filmes e séries: biblioteca da conta; adultos: só nesta TV).
  const favItem = { id: meta.id, type: meta.type, name: meta.name, poster: meta.poster, posterShape: meta.posterShape };
  const favBtn = h('div.btn', { focusable: true, onSelect: () => toggleFavorite(favItem).then(paintFav) });
  function paintFav() {
    const on = isFavorite(favItem);
    favBtn.innerHTML = on ? '<span class="ico fav">♥</span>' + t('Favoritado') : '<span class="ico">♡</span>' + t('Favoritar');
  }
  paintFav();
  if (meta.id === 'dev') favBtn.style.display = 'none';
  // Retomou sozinho (Smart Choice): atalho para começar do zero, visível nos primeiros minutos.
  const restartBtn = h('div.btn', { focusable: true, html: '<span class="ico">↺</span>' + t('Do início'), onSelect: () => restart() });
  restartBtn.style.display = opts.startTime > 30000 ? '' : 'none';
  const buttons = h('div.p-buttons', { 'data-group': '' }, [playBtn, restartBtn, audioBtn, subsBtn, srcBtn, favBtn, nextBtn]);
  const spinner = h('div.p-center', null, h('div.spinner'));
  const msgEl = h('div.p-msg');
  const skipFill = h('i');
  const skipBtn = h('div.btn', { focusable: true, onSelect: () => doSkip() });
  const skipBox = h('div.p-skip', null, [skipBtn, h('div.bar', null, skipFill)]);
  const overlay = h('div.p-overlay', null, [
    h('div.p-top', null, [titleEl, clockEl]),
    h('div.p-bottom', null, [bar, h('div.p-times', null, [curTimeEl, h('div.spacer'), durEl]), buttons]),
  ]);
  // Abertura: arte do título, logo e o que está acontecendo, até o vídeo começar a tocar.
  const introBg = h('div.pi-bg');
  const introLogo = h('img.pi-logo', { alt: '' });
  const introTitle = h('div.pi-title', { text: meta.name || '' });
  const introSub = h('div.pi-sub');
  const introStatus = h('div.pi-main');
  const introCaption = h('div.pi-caption');
  // Tudo no canto esquerdo: título (destaque) em cima, e o carregamento (secundário) logo abaixo.
  const intro = h('div.p-intro', null, [
    introBg,
    h('div.pi-shade'),
    h('div.pi-info', null, [
      introLogo,
      introTitle,
      introSub,
      h('div.pi-status-row', null, [h('div.pi-ring'), h('div.pi-texts', null, [introStatus, introCaption])]),
    ]),
  ]);
  const el = h('div.view.player.intro-on', null, [videoEl, subsEl, overlay, skipBox, spinner, msgEl, intro]);

  const renderer = subs.Renderer(subsEl);
  substyle.apply(subsEl, settings);

  let alive = true;
  let controlsOn = false;
  let hideTimer = null;
  let ticker = null;
  let saveTimer = null;
  let watchTimer = null;
  let statusTimer = null;
  let mediaUrl = '';
  let viaServer = false;
  let viaNative = false;
  let autoSelecting = !!opts.pick;
  let nativeSessionId = '';
  let startGeneration = 0;
  let slowProbeTimer = null;
  const playingWaiters = [];
  let lastTick = 0;
  let watchedDelta = 0;
  let pendingStart = opts.startTime || 0;
  let seekTarget = null;
  let seekCommitTimer = null;
  let seekRepeats = 0;
  let embedded = null; // { audio: [], subs: [] } do servidor
  let addonSubs = null;
  let fileInfo = null;
  let currentSub = { kind: 'off' };
  let currentAudio = null;
  let triedTranscode = false;
  let slowTimer = null;
  let slowModal = null;
  let syncUi = false; // painel de sincronia da legenda aberto: pausar não mostra os controles
  const tried = opts.stream ? [opts.stream] : [];

  const lightContext = () => si.choiceContext(meta, video, opts.isSeries);
  const seriesInfo = () => (opts.isSeries ? { season: video.season, episode: video.episode } : null);

  // Logo do título no canto (o nome escrito fica de reserva quando não tem logo, ex.: vídeos adultos).
  function setTitle() {
    clear(titleEl);
    const name = h('span.p-name', { text: meta.name || '' });
    titleEl.appendChild(name);
    const logoUrl = meta.logo || (/^tt\d+/.test(meta.id) ? hero.logo(meta.id) : '');
    if (logoUrl) {
      const img = h('img.p-logo', { alt: '' });
      img.onload = () => {
        img.classList.add('ready');
        name.style.display = 'none';
      };
      img.onerror = () => img.parentNode && img.parentNode.removeChild(img);
      img.src = logoUrl;
      titleEl.insertBefore(img, name);
    }
    if (opts.isSeries) titleEl.appendChild(h('small', { text: 'T' + video.season + ' E' + video.episode + ' · ' + (video.namePt || video.name || video.title || '') }));
    nextBtn.style.display = opts.isSeries && nextVideo() ? '' : 'none';
  }

  function nextVideo() {
    const vids = sortedVideos(meta);
    const i = vids.findIndex((v) => v.id === video.id);
    return i >= 0 && i + 1 < vids.length ? vids[i + 1] : null;
  }

  // ---------- Carregamento ----------
  function releaseNative() {
    const sessionId = nativeSessionId;
    nativeSessionId = '';
    if (sessionId) server.stopNative(sessionId);
  }

  function start() {
    const generation = ++startGeneration;
    const selectedStream = stream;
    releaseNative();
    playingWaiters.slice().forEach((done) => done());
    clearTimeout(slowProbeTimer);
    // Libera imagens, trailers e respostas dos catálogos ANTES de criar o motor torrent.
    freeBackgroundMemory();
    dropSource();
    try {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch (e) { /* player antigo pode não permitir load sem src */ }
    mediaUrl = '';
    viaServer = false;
    viaNative = false;
    hasPlayed = false;
    gaveUp = false;
    recoveries = 0;
    stuckSince = 0;
    slowExtensions = 0;
    setTitle();
    if (!selectedStream) return waitForPick();
    const local = server.nativeEnabled() && server.isTorrent(selectedStream);
    const sessionId = local ? server.createNativeSessionId() : '';
    nativeSessionId = sessionId;
    const current = () => alive && generation === startGeneration && stream === selectedStream;
    const choiceCtx = lightContext();
    armSlow(local ? 70000 : SLOW_MS);
    showSpinner(true);
    message('');
    if (local) introStatus.textContent = t('Preparando torrent na própria TV');
    embedded = null;
    tracksPromise = null;
    addonSubs = null;
    renderer.clear();
    currentSub = { kind: 'off' };
    segments = [];
    segmentsLoaded = false;
    hideSkip();
    server
      .toPlayable(selectedStream, seriesInfo(), {
        sessionId: sessionId, isCurrent: current,
        validateFile: autoSelecting ? (file) => si.lightFileError(selectedStream, file, choiceCtx) : null,
      })
      .then((res) => {
        if (!current()) {
          if (res.sessionId) server.stopNative(res.sessionId);
          return;
        }
        mediaUrl = res.url;
        viaServer = res.viaServer;
        viaNative = !!res.viaNative;
        nativeSessionId = res.sessionId || '';
        log.info('Tocando', mediaUrl);
        // Só src + autoplay evita abrir a mesma fonte duas vezes no player da Samsung.
        setSource(mediaUrl);
        armSlow();
        loadSubtitles();
        // Faixas embutidas só quando o usuário abre o menu; o torrent local não executa ffprobe.
      })
      .catch((e) => {
        if (!current() || e.cancelled) return;
        releaseNative();
        // Uma fonte pode falhar já nos metadados (por exemplo, peças grandes para a TV).
        // Falha do serviço inteiro não é motivo para iniciar outros torrents.
        if (!e.unavailable) {
          si.markFailed(selectedStream, lightContext());
          const next = autoFallback();
          if (next) {
            failedNotes.push(e.message);
            toast(t('Tentando outra fonte pelo Smart Choice . Light'), 3500);
            autoSelecting = true;
            switchTo(next);
            return;
          }
        }
        fail(e.message);
      });
  }

  // Põe a URL no <video>: HLS (.m3u8) pelo hls.js, o resto direto. O resto continua só src +
  // autoplay, como o player oficial do Stremio para TV.
  let hlsCtl = null;
  let sourceUrl = '';
  let sourceToken = 0;
  function setSource(url) {
    dropSource();
    const token = ++sourceToken;
    sourceUrl = url;
    videoEl.autoplay = true;
    if (!hlsplay.isHls(url)) {
      videoEl.src = url;
      return;
    }
    hlsplay
      .attach(videoEl, url, (why) => {
        if (alive && token === sourceToken) playbackError(null, why);
      }, () => alive && token === sourceToken)
      .then((ctl) => {
        if (!alive || token !== sourceToken) return ctl && ctl.destroy();
        if (ctl) hlsCtl = ctl;
        else videoEl.src = url; // sem hls.js aqui: tenta o <video> mesmo
      });
  }
  function dropSource() {
    sourceToken++;
    sourceUrl = '';
    if (hlsCtl) hlsCtl.destroy();
    hlsCtl = null;
  }

  // ---------- Aviso da agenda ----------
  // Evento começando em até 5 min: cartão no canto com o X já focado (OK ou Voltar fecha) que some
  // sozinho em 15 s. Enquanto ele está na tela, outra tecla só fecha o aviso.
  const NOTICE_MS = 15000;
  let calTimer = null;
  let calNotice = null;
  function checkCalendar() {
    if (!alive || calNotice) return;
    const e = calendar.startingWithin(5 * 60000).filter((x) => !calendarSeen[x.title + '|' + x.start.getTime()])[0];
    if (!e) return;
    calendarSeen[e.title + '|' + e.start.getTime()] = true;
    const min = Math.max(1, Math.round((e.start.getTime() - Date.now()) / 60000));
    const fill = h('i');
    const closeBtn = h('div.cal-close', { focusable: true, title: t('Fechar aviso'), html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>', onSelect: () => closeNotice() });
    const box = h('div.cal-notice', null, [
      h('div.cal-notice-top', null, [
        h('span.cal-notice-ico', { html: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/></svg>' }),
        h('span.cal-notice-when', { text: t('Começa em {n} min', { n: min }) }),
        closeBtn,
      ]),
      h('div.cal-notice-title', { text: e.title }),
      h('div.cal-notice-sub', null, [h('i', { style: { background: e.color } }), [eventTime(e, true), e.location].filter(Boolean).join(' · ')]),
      h('div.cal-notice-hint', { text: t(IS_WEB ? 'Enter fecha · some sozinho em 15 s' : 'OK fecha · some sozinho em 15 s') }),
      h('div.cal-notice-bar', null, fill),
    ]);
    el.appendChild(box);
    const layer = nav.pushLayer(box, {
      onBack: () => closeNotice(),
      onKey: (ev) => {
        if (ev.keyCode === KEY.ENTER || ev.keyCode === KEY.BACK || ev.keyCode === KEY.ESC || ev.keyCode === KEY.BACKSPACE) return false;
        closeNotice();
        return true;
      },
    });
    nav.focus(closeBtn);
    const timer = setTimeout(() => closeNotice(), NOTICE_MS);
    setTimeout(() => (fill.style.width = '0%'), 50); // a barra esvazia até o aviso sumir
    calNotice = { box: box, layer: layer, timer: timer };
  }
  function closeNotice() {
    if (!calNotice) return;
    clearTimeout(calNotice.timer);
    nav.popLayer(calNotice.layer);
    if (calNotice.box.parentNode) calNotice.box.parentNode.removeChild(calNotice.box);
    calNotice = null;
  }

  function restart() {
    restartBtn.style.display = 'none';
    try {
      videoEl.currentTime = 0;
    } catch (e) {
      pendingStart = 0;
    }
    if (nav.current() === restartBtn) nav.focus(playBtn);
  }

  // Smart Choice: o player abre na hora e a fonte chega depois (os addons ainda estão respondendo).
  function waitForPick() {
    showSpinner(true);
    (opts.pick || Promise.resolve(null)).then((s) => {
      if (!alive || stream) return;
      if (!s) {
        router.pop();
        return;
      }
      stream = s;
      autoSelecting = true;
      tried.push(s);
      const info = si.parse(s);
      introStatus.textContent = t('Preparando o vídeo');
      introCaption.innerHTML = '<b>✦</b>' + si.choiceLabel + ' · ' + escapeHtml(si.summary(info) || info.addon);
      start();
    });
  }

  let tracksPromise = null;
  function loadEmbeddedTracks() {
    if (viaNative || !server.isAvailable()) return Promise.resolve(null);
    if (!tracksPromise) {
      const forUrl = mediaUrl;
      tracksPromise = server
        .tracks(mediaUrl)
        .then((tracks) => {
          if (!alive || !tracks || forUrl !== mediaUrl) return null;
          embedded = tracks;
          log.info('Faixas embutidas', JSON.stringify(tracks));
          return tracks;
        })
        .catch(() => {
          tracksPromise = null;
          return null;
        });
    }
    return tracksPromise;
  }

  // Pede as legendas já com hash/tamanho/nome do arquivo, para os addons devolverem as casadas.
  // A escolha automática espera todos os addons (ou 6s), para não ficar com a primeira que chegar.
  let subsSettled = false;
  function loadSubtitles() {
    const forVideo = video;
    const forUrl = mediaUrl;
    const forStream = stream;
    addonSubs = null;
    subsSettled = false;
    // Torrent pelo PC: o hash lê o fim do arquivo e faria o servidor baixar essa parte antes do
    // começo. Espera o vídeo começar (ou 60s) para não atrasar o play.
    const ready = viaServer && !hasPlayed ? untilPlaying(60000) : Promise.resolve();
    ready
      .then(() => alive && forVideo === video && forUrl === mediaUrl ? subpick.videoInfo(forStream, forUrl, server) : null)
      .then((info) => {
        if (!alive || !info || forVideo !== video || forUrl !== mediaUrl) return;
        fileInfo = info;
        const settle = () => {
          if (!alive || forVideo !== video || forUrl !== mediaUrl || subsSettled) return;
          subsSettled = true;
          if (!addonSubs) addonSubs = [];
          autoPick();
        };
        setTimeout(settle, 6000);
        addons
          .fetchSubtitles(meta.type, video.id, subpick.extra(info), (list) => {
            if (!alive || forVideo !== video || forUrl !== mediaUrl) return;
            addonSubs = (addonSubs || []).concat(list);
          })
          .then(settle, settle);
      });
  }

  function untilPlaying(maxMs) {
    return new Promise((ok) => {
      const done = () => {
        videoEl.removeEventListener('playing', done);
        clearTimeout(timer);
        const i = playingWaiters.indexOf(done);
        if (i >= 0) playingWaiters.splice(i, 1);
        ok();
      };
      const timer = setTimeout(done, maxMs);
      playingWaiters.push(done);
      videoEl.addEventListener('playing', done);
    });
  }

  // Seleção automática no estilo do Smart Track Selector do Kai (versão leve).
  // Legenda: prefere a dos addons (arquivo pequeno à parte, não mexe no vídeo). Faixas embutidas
  // só são lidas se o usuário pediu um áudio preferido, e só depois de o vídeo estar rodando.
  let autoDone = { sub: false, audio: false };
  function autoPick() {
    const prefSubs = (settings.subtitleLangs || []).map((x) => x.toLowerCase());
    const prefAudio = (settings.audioLangs || []).map((x) => x.toLowerCase());
    if (!autoDone.audio && prefAudio.length && embedded && embedded.audio.length > 1) {
      autoDone.audio = true;
      const already = embedded.audio[0] && prefAudio.indexOf(String(embedded.audio[0].lang).toLowerCase()) >= 0;
      if (!already) {
        const idx = embedded.audio.findIndex((tr) => prefAudio.indexOf(String(tr.lang).toLowerCase()) >= 0);
        if (idx > 0) selectEmbeddedAudio(idx);
      }
    }
    if (autoDone.sub || !settings.subtitlesAuto || !prefSubs.length || !subsSettled) return;
    autoDone.sub = true;
    const ranked = subpick.rank(addonSubs, prefSubs, fileInfo || {}, seriesInfo()).slice(0, 8);
    // A legenda que já foi sincronizada neste vídeo vai na frente.
    const saved = savedSync(video.id);
    const savedAt = saved ? ranked.findIndex((x) => (x.id || x.url) === saved.sub) : -1;
    if (savedAt > 0) ranked.unshift(ranked.splice(savedAt, 1)[0]);
    if (ranked.length) whenDuration(() => tryAutoSub(ranked, 0, mediaUrl));
  }

  // A duração do vídeo é o que permite conferir a legenda; espera os metadados (até 15s).
  function whenDuration(fn) {
    if (isFinite(videoEl.duration) && videoEl.duration > 0) return fn();
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      videoEl.removeEventListener('loadedmetadata', go);
      if (alive) fn();
    };
    videoEl.addEventListener('loadedmetadata', go);
    setTimeout(go, 15000);
  }

  // Testa as candidatas em ordem e liga a primeira que passa na conferência. Legenda de Portugal
  // rotulada como BR fica de reserva enquanto houver outra candidata.
  function tryAutoSub(ranked, i, forUrl, ptBackup) {
    if (!alive || forUrl !== mediaUrl || currentSub.kind !== 'off') return; // usuário já escolheu algo
    if (i >= ranked.length) {
      if (ptBackup) {
        useAddonCues(ptBackup.sub, ptBackup.cues);
        toast(t('Só achei legenda em português de Portugal.'), 4000);
        return;
      }
      // Nenhuma passou: volta ao padrão do app (a primeira no idioma preferido) e avisa que dá para trocar.
      log.warn('Nenhuma legenda passou na conferência; usando a padrão');
      selectAddonSub(ranked[0], true);
      toast(t('Legenda pode não bater com este arquivo. Troque no menu de legendas.'), 5000);
      return;
    }
    const s = ranked[i];
    loadAddonCues(s)
      .then((cues) => {
        if (!alive || forUrl !== mediaUrl || currentSub.kind !== 'off') return;
        const check = subpick.plausible(cues, videoEl.duration);
        if (!check.ok) {
          log.info('Legenda recusada', s.addon, s.lang, check.why);
          return tryAutoSub(ranked, i + 1, forUrl, ptBackup);
        }
        if (wantsBr() && subVariant[s.id || s.url] === 'pt') {
          log.info('Legenda de Portugal; procurando uma do Brasil', s.addon, s.lang);
          return tryAutoSub(ranked, i + 1, forUrl, ptBackup || { sub: s, cues: cues });
        }
        useAddonCues(s, cues);
      })
      .catch(() => tryAutoSub(ranked, i + 1, forUrl, ptBackup));
  }

  // Baixa a legenda, corrige a velocidade (25 x 23,976 fps) e descobre se é PT do Brasil ou de Portugal.
  const subVariant = {};
  function loadAddonCues(s) {
    return subs.load(s.url, server.subtitlesProxy(s.url)).then((cues) => {
      const fix = subpick.fixFps(cues, videoEl.duration);
      if (fix) {
        log.info('Legenda em outra velocidade; reescalada', fix.factor.toFixed(4));
        cues = fix.cues;
      }
      if (isPt(s.lang)) subVariant[s.id || s.url] = subpick.ptVariant(cues);
      return cues;
    });
  }

  function useAddonCues(s, cues) {
    currentSub = { kind: 'addon', id: s.id || s.url };
    renderer.set(cues);
    applySavedOffset();
  }

  function wantsBr() {
    const p = (settings.subtitleLangs || []).map((x) => x.toLowerCase());
    const idx = (l) => (p.indexOf(l) < 0 ? 99 : p.indexOf(l));
    const br = Math.min(idx('pob'), idx('pt-br'));
    return br < 99 && br < idx('por');
  }

  function subLabel(s) {
    const v = subVariant[s.id || s.url];
    if (v === 'pt') return t('Português (Portugal)');
    if (v === 'br') return t('Português (BR)');
    return langName(s.lang);
  }

  function subKey() {
    if (currentSub.kind === 'addon') return currentSub.id;
    if (currentSub.kind === 'embedded') return 'emb' + currentSub.index;
    return '';
  }

  function applySavedOffset() {
    const saved = savedSync(video.id);
    renderer.setOffset(saved && saved.sub === subKey() ? saved.off : 0);
    renderer.update(videoEl.currentTime);
  }

  // Áudio preferido configurado: lê as faixas uma vez, 20s depois de o vídeo começar.
  function scheduleAudioPick() {
    if (viaNative || !(settings.audioLangs || []).length || !server.isAvailable()) return;
    setTimeout(() => {
      if (alive && hasPlayed) loadEmbeddedTracks().then(() => autoPick());
    }, 20000);
  }

  // ---------- Eventos do vídeo ----------
  videoEl.addEventListener('loadedmetadata', () => {
    if (pendingStart > 0) {
      try {
        videoEl.currentTime = pendingStart / 1000;
        autoResume = true;
      } catch (e) {
        /* ignore */
      }
      pendingStart = 0;
    }
    updateTimes();
    loadSegments();
  });
  videoEl.addEventListener('playing', () => {
    hideIntro();
    clearTimeout(slowTimer);
    closeSlow();
    if (!hasPlayed) {
      scheduleAudioPick();
      // Abriu: é esta a fonte que o Smart Choice tenta primeiro ao continuar depois.
      if (meta.id !== 'dev') si.rememberStream(video.id, stream);
    }
    hasPlayed = true;
    showSpinner(false);
    message('');
    updatePlayBtn();
    scheduleHide();
  });
  videoEl.addEventListener('pause', () => {
    updatePlayBtn();
    if (!syncUi) showControls();
    saveProgress();
  });
  videoEl.addEventListener('waiting', () => showSpinner(true));
  videoEl.addEventListener('canplay', () => showSpinner(false));
  videoEl.addEventListener('timeupdate', () => {
    if (restartBtn.style.display !== 'none' && videoEl.currentTime * 1000 > (opts.startTime || 0) + 300000) restartBtn.style.display = 'none';
    const now = Date.now();
    if (!videoEl.paused && lastTick) {
      const d = now - lastTick;
      if (d > 0 && d < 3000) watchedDelta += d;
    }
    lastTick = now;
    renderer.update(videoEl.currentTime);
    if (controlsOn) updateTimes();
  });
  videoEl.addEventListener('ended', () => {
    saveProgress();
    if (opts.isSeries && nextVideo()) playNext();
    else router.pop();
  });
  videoEl.addEventListener('error', () => {
    const err = videoEl.error;
    // Sem src (fonte sendo trocada ou o hls.js soltando o <video>) não é erro do vídeo.
    if (!sourceUrl || !videoEl.getAttribute('src')) return;
    playbackError(err && err.code);
  });

  // Erro do <video> (código 1–4) ou do hls.js (why: o que ele disse). Um aviso por fonte.
  let errorToken = -1;
  function playbackError(code, why) {
    log.warn('Erro de vídeo', code || why, mediaUrl);
    if (!alive || errorToken === sourceToken) return;
    errorToken = sourceToken;
    const failed = stream;
    const generation = startGeneration;
    errorDetails(code, why).then((details) => {
      if (!alive || generation !== startGeneration || failed !== stream) return;
      si.markFailed(failed, lightContext());
      const next = autoFallback();
      if (next) {
        failedNotes.push(details);
        const what = addons.isTubeStream(next) ? String(next.name || '').split('\n').join(' ') : si.summary(si.parse(next)) || si.parse(next).addon;
        toast(si.parse(failed).dv ? t('Dolby Vision não abre na TV. Tentando: {what}', { what: what }) : t('Tentando: {what}', { what: what }), 4000);
        autoSelecting = true;
        switchTo(next);
        return;
      }
      if (failedNotes.length) details = failedNotes.concat(details).join('\n');
      if (!viaNative && !triedTranscode && server.isAvailable()) {
        fail(t('A TV não conseguiu tocar este arquivo diretamente.'), true, details);
      } else fail(t('A TV não conseguiu tocar este arquivo (formato ou codec não suportado).'), false, details);
    });
  }

  // Uma tentativa inicial e no máximo duas alternativas por episódio/seleção manual.
  // A saúde e a carga continuam valendo nas recuperações; não prende a mesma resolução.
  const failedNotes = [];
  let autoTries = 0;
  function autoFallback() {
    if (autoTries >= 2) return null;
    const rest = (opts.streams || []).filter((candidate) => !si.wasTried(candidate, tried));
    let next = null;
    if (addons.isTubeStream(stream)) {
      // As opções do mesmo vídeo de site são variantes diretas do próprio addon.
      next = rest.find((candidate) => candidate.addon === stream.addon) || null;
    } else {
      const pick = si.smartPick(rest, server.isAvailable(), lightContext());
      next = pick && pick.stream;
    }
    if (!next) return null;
    autoTries++;
    return next;
  }

  // Linha de diagnóstico do aviso de erro: código do player, de onde veio o link e, se o vídeo
  // passou pelo serviço da TV, o que o site respondeu para ele. Uma foto da tela já diz onde quebrou.
  const MEDIA_ERR = { 1: 'cancelado', 2: 'rede', 3: 'decodificação', 4: 'formato/endereço não suportado' };
  function errorDetails(code, why) {
    let host = '';
    let target = '';
    try {
      const px = /^http:\/\/127\.0\.0\.1:\d+\/px\/[^?]*\?u=([^&]+)/.exec(mediaUrl);
      target = px ? decodeURIComponent(px[1]) : mediaUrl;
      host = (target.match(/^https?:\/\/([^/]+)/) || [])[1] || '';
    } catch (e) {
      /* ignore */
    }
    const parts = [why || t('erro {c}', { c: (code || '?') + (MEDIA_ERR[code] ? ' (' + MEDIA_ERR[code] + ')' : '') })];
    // HLS que caiu no <video> porque o hls.js não carregou: o motivo de verdade é esse.
    if (!why && hlsplay.isHls(sourceUrl) && !hlsCtl && hlsplay.unavailable) parts[0] += ' · ' + hlsplay.unavailable;
    parts.push((stream && stream.name ? String(stream.name).split('\n').join(' ') + ' · ' : '') + (host || '?') + (target !== mediaUrl ? ' ' + t('via TV') : ''));
    if (target === mediaUrl) return Promise.resolve(parts.join(' · '));
    return getJSON(mediaUrl.replace(/\/px\/.*$/, '/api/pxlog'), { timeout: 3000, quiet: true })
      .then((list) => {
        const last = (Array.isArray(list) ? list : []).slice(-3);
        if (last.length) parts.push(t('site respondeu') + ' ' + last.map((x) => x.status + (x.error ? ' ' + x.error : '') + ' (' + x.file + ')').join(', '));
        return parts.join(' · ');
      })
      .catch(() => parts.concat(t('serviço da TV não respondeu')).join(' · '));
  }

  // ---------- Pular abertura / recapitulação / encerramento ----------
  let segments = [];
  let segmentsLoaded = false;
  let activeSeg = null;
  const doneSegs = {};

  function loadSegments() {
    if (segmentsLoaded || store.settings().skipMode === 'off') return;
    segmentsLoaded = true;
    const forVideo = video;
    skip
      .getSegments(meta, video, videoEl.duration)
      .then((list) => {
        if (alive && forVideo === video) segments = list;
      })
      .catch(() => {});
  }

  function segLabel(seg) {
    if (seg.type === 'intro') return t('Pular abertura');
    if (seg.type === 'recap') return t('Pular recapitulação');
    return opts.isSeries && nextVideo() ? t('Próximo episódio') : t('Pular encerramento');
  }

  function segKey(seg) {
    return video.id + ':' + seg.type + ':' + seg.start;
  }

  function checkSkip() {
    if (!segments.length || seekTarget !== null) return;
    const pos = videoEl.currentTime;
    const seg = segments.find((x) => pos >= x.start && pos < x.end - 0.5) || null;
    if (seg !== activeSeg) {
      activeSeg = seg;
      if (!seg || doneSegs[segKey(seg)]) {
        hideSkip();
        if (seg) activeSeg = null;
        return;
      }
      if (store.settings().skipMode === 'auto') {
        doSkip();
        return;
      }
      skipBtn.innerHTML = '<span class="ico">⏭</span>' + segLabel(seg);
      skipBox.classList.add('show');
      if (controlsOn) nav.focus(skipBtn, { noScroll: true });
    }
    if (activeSeg) skipFill.style.width = Math.max(0, Math.min(100, ((pos - activeSeg.start) / (activeSeg.end - activeSeg.start)) * 100)) + '%';
  }

  function hideSkip() {
    skipBox.classList.remove('show');
    if (nav.current() === skipBtn) nav.focus(bar, { noScroll: true });
  }

  function dismissSkip() {
    if (activeSeg) doneSegs[segKey(activeSeg)] = true;
    activeSeg = null;
    hideSkip();
  }

  function doSkip() {
    const seg = activeSeg;
    if (!seg) return;
    doneSegs[segKey(seg)] = true;
    activeSeg = null;
    hideSkip();
    if (seg.type === 'outro' && opts.isSeries && nextVideo()) {
      playNext();
      return;
    }
    const d = videoEl.duration;
    try {
      videoEl.currentTime = Math.min(seg.end, isFinite(d) ? d - 1 : seg.end);
    } catch (e) {
      /* ignore */
    }
    if (store.settings().skipMode === 'auto') toast(seg.type === 'intro' ? t('Abertura pulada') : seg.type === 'recap' ? t('Recapitulação pulada') : t('Encerramento pulado'));
  }

  // ---------- Diagnóstico e recuperação de travamentos ----------
  function bufferedInfo() {
    try {
      const b = videoEl.buffered;
      const out = [];
      for (let i = 0; i < b.length; i++) out.push(b.start(i).toFixed(0) + '-' + b.end(i).toFixed(0));
      return out.join(',');
    } catch (e) {
      return '?';
    }
  }

  function diag(ev) {
    log.info(
      'video',
      ev,
      't=' + videoEl.currentTime.toFixed(1),
      'dur=' + (isFinite(videoEl.duration) ? videoEl.duration.toFixed(0) : '?'),
      'ready=' + videoEl.readyState,
      'net=' + videoEl.networkState,
      'buf=' + bufferedInfo()
    );
  }
  ['waiting', 'stalled', 'suspend', 'abort', 'emptied', 'seeking', 'seeked', 'ended', 'loadeddata'].forEach((ev) =>
    videoEl.addEventListener(ev, () => diag(ev))
  );

  // O player da TV às vezes para de pedir dados no meio de arquivos longos via HTTP
  // e fica "carregando" para sempre. Se o tempo não anda por 15s sem pausa, reabre o stream no mesmo ponto.
  let lastT = -1;
  let hasPlayed = false; // só vigia depois que o vídeo começou (o torrent pode demorar a iniciar)
  let gaveUp = false;
  let autoResume = false;
  videoEl.addEventListener('seeked', () => {
    if (autoResume) {
      autoResume = false;
      const p = videoEl.play();
      if (p && p.catch) p.catch(() => {});
    }
  });

  function stuckMenu(pos) {
    showSpinner(false);
    menu(
      t('O vídeo parou de carregar'),
      [
        { label: t('Tentar de novo'), sub: t('Reabre o vídeo em {time}', { time: fmtTime(pos) }), value: 'retry', checked: true },
        { label: t('Escolher outra fonte'), value: 'src' },
        { label: t('Voltar'), value: 'back' },
      ],
      {
        center: true,
        onPick: (v) => {
          if (v === 'retry') {
            gaveUp = false;
            recoveries = 0;
            reopenAt(pos);
          } else if (v === 'src') sourcesMenu();
          else router.pop();
        },
      }
    );
  }

  // Memória: pede para a tela inicial soltar as fileiras enquanto o vídeo toca.
  function freeBackgroundMemory() {
    ['home', 'recommended', 'streamings'].forEach((id) => {
      const view = router.tabView(id);
      if (view && view.freeMemory) view.freeMemory();
    });
    if (settings.lowMemory !== false) clearCache();
  }
  let stuckSince = 0;
  let recoveries = 0;
  let lastRecoveryAt = 0;
  function watchdog() {
    if (!alive || gaveUp || !hasPlayed || !mediaUrl || videoEl.paused || seekTarget !== null || videoEl.ended) {
      stuckSince = 0;
      return;
    }
    const pos = videoEl.currentTime;
    if (Math.abs(pos - lastT) > 0.05) {
      lastT = pos;
      stuckSince = 0;
      if (Date.now() - lastRecoveryAt > 120000) recoveries = 0;
      return;
    }
    if (!stuckSince) {
      stuckSince = Date.now();
      return;
    }
    const stuckFor = Date.now() - stuckSince;
    if (stuckFor > 15000) {
      stuckSince = 0;
      if (recoveries >= 3) {
        diag('travado-desisti');
        gaveUp = true; // para de vigiar até o usuário escolher (antes reabria o aviso sem parar)
        stuckMenu(pos);
        return;
      }
      recoveries++;
      lastRecoveryAt = Date.now();
      diag('travado-recuperando#' + recoveries);
      reopenAt(pos);
    }
  }

  function reopenAt(pos) {
    const generation = startGeneration;
    showSpinner(true);
    toast(t('Reconectando ao vídeo...'));
    pendingStart = Math.max(0, pos - 1) * 1000;
    const src = sourceUrl || mediaUrl;
    try {
      videoEl.pause();
      dropSource();
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch (e) {
      /* ignore */
    }
    // Reabre do zero: o ponto certo é aplicado no loadedmetadata e o play vem depois do seek.
    setTimeout(() => {
      if (!alive || generation !== startGeneration) return;
      hasPlayed = false;
      setSource(src);
    }, 300);
  }

  // Erro: um painel só, com o motivo legível (sem endereço técnico no meio) e as saídas em botões.
  function fail(text, offerTranscode, details) {
    gaveUp = true;
    if (viaNative || nativeSessionId) {
      releaseNative();
      dropSource();
      try { videoEl.pause(); } catch (e) { /* ignore */ }
    }
    hideIntro();
    clearTimeout(slowTimer);
    closeSlow();
    showSpinner(false);
    clear(msgEl);
    const reason = String(text || '').replace(/[.!\s]+$/, '').replace(/https?:\/\/\S+/g, (u) => (/:11470\b/.test(u) ? t('o servidor do PC') : t('o servidor')));
    const torrent = server.isTorrent(stream);
    const local = torrent && server.nativeEnabled();
    const tip = local
      ? t('O torrent local depende de peers disponíveis, memória e um formato compatível com a TV. Tente outra fonte.')
      : torrent
        ? t('Esse torrent pode estar sem seeders ou o servidor externo está lento para começar. Tente outra fonte.')
        : t('Tente outra fonte (de preferência MP4/MKV com H.264 ou HEVC e áudio AAC/AC3).');
    const buttons = [{ label: '<span class="ico">⇄</span>' + t('Escolher outra fonte'), primary: true, onSelect: () => sourcesMenu() }];
    if (offerTranscode) buttons.push({ label: t('Converter no PC'), onSelect: () => transcode() });
    buttons.push({ label: t('Voltar'), onSelect: () => router.pop() });
    choiceDialog(t('Problema na reprodução'), reason.charAt(0).toUpperCase() + reason.slice(1) + '. ' + tip + (details ? '\n\n' + t('Detalhes') + ': ' + details : ''), buttons);
  }

  function transcode() {
    if (viaNative) return toast(t('O torrent local não converte codecs. Escolha outra fonte compatível com a TV.'));
    triedTranscode = true;
    const base = server.baseUrl();
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const q = ['mediaURL=' + encodeURIComponent(mediaUrl)];
    ['h264', 'h265', 'hevc'].forEach((c) => q.push('videoCodecs=' + c));
    ['aac', 'mp3', 'ac3', 'eac3'].forEach((c) => q.push('audioCodecs=' + c));
    q.push('maxAudioChannels=6');
    const url = base + 'hlsv2/' + id + '/master.m3u8?' + q.join('&');
    pendingStart = videoEl.currentTime * 1000 || pendingStart;
    showSpinner(true);
    message('');
    log.info('Transcodificando', url);
    setSource(url);
  }

  // ---------- Controles ----------
  function togglePlay() {
    if (videoEl.paused) videoEl.play();
    else videoEl.pause();
    showControls();
  }

  function updatePlayBtn() {
    playBtn.innerHTML = videoEl.paused ? '<span class="ico">▶</span>' + t('Tocar') : '<span class="ico">❚❚</span>' + t('Pausar');
  }

  function updateTimes() {
    const d = videoEl.duration;
    const pos = seekTarget !== null ? seekTarget : videoEl.currentTime;
    const pct = d > 0 && isFinite(d) ? Math.min(100, (pos / d) * 100) : 0;
    posEl.style.width = pct + '%';
    knobEl.style.left = pct + '%';
    seekLabel.style.left = pct + '%';
    curTimeEl.textContent = fmtTime(pos);
    durEl.textContent = isFinite(d) ? fmtTime(d) : '--:--';
    try {
      const b = videoEl.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= videoEl.currentTime + 1 && b.end(i) >= videoEl.currentTime) {
          bufEl.style.width = (d > 0 ? Math.min(100, (b.end(i) / d) * 100) : 0) + '%';
        }
      }
    } catch (e) {
      /* ignore */
    }
    // Relógio + horário de término (player-clock-eta do Kai).
    const now = new Date();
    clear(clockEl);
    clockEl.appendChild(document.createTextNode(timeHM(now)));
    if (d > 0 && isFinite(d)) {
      const end = new Date(now.getTime() + Math.max(0, d - videoEl.currentTime) * 1000);
      clockEl.appendChild(h('small', { text: t('Termina às {time}', { time: timeHM(end) }) }));
    }
  }

  function showControls(focusEl) {
    if (!controlsOn) {
      controlsOn = true;
      el.classList.add('controls-on');
      updateTimes();
      updatePlayBtn();
      // Com um painel por cima (sincronia, menus), o foco fica lá.
      const mine = nav.topLayer() && nav.topLayer().root === el;
      if (mine && (!nav.current() || !overlay.contains(nav.current()))) nav.focus(focusEl || bar);
    } else if (focusEl) nav.focus(focusEl);
    scheduleHide();
  }

  function hideControls() {
    controlsOn = false;
    el.classList.remove('controls-on');
    clearTimeout(hideTimer);
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!videoEl.paused && seekTarget === null && nav.topLayer() && nav.topLayer().root === el) hideControls();
    }, HIDE_MS);
  }

  let introOn = true;
  function setupIntro() {
    requestAnimationFrame(() => requestAnimationFrame(() => introOn && intro.classList.add('in')));
    const art = settings.lowMemory !== false ? '' : meta.background || hero.background(meta.id);
    if (art) {
      const pre = new Image();
      pre.onload = () => introOn && (introBg.style.backgroundImage = 'url("' + art + '")') && introBg.classList.add('show');
      pre.src = art;
    }
    introTitle.style.display = 'none';
    introLogo.onerror = () => {
      introLogo.style.display = 'none';
      introTitle.style.display = '';
    };
    introLogo.src = meta.logo || hero.logo(meta.id);
    introSub.textContent = opts.isSeries ? 'T' + video.season + ' E' + video.episode + ' · ' + (video.namePt || video.name || video.title || '') : '';
    introStatus.textContent = stream ? t('Preparando o vídeo') : t('Escolhendo a melhor fonte');
    introCaption.innerHTML = stream ? '' : '<b>✦</b>' + si.choiceLabel;
  }

  function hideIntro() {
    if (!introOn) return;
    introOn = false;
    intro.classList.remove('in');
    // Controles e círculo voltam junto com o fim do fade.
    setTimeout(() => el.classList.remove('intro-on'), 600);
    // Depois do fade, solta a arte (1920x1080 pesa na memória da TV).
    setTimeout(() => {
      introBg.style.backgroundImage = '';
      intro.style.display = 'none';
    }, 900);
  }

  function showSpinner(on) {
    spinner.style.display = on ? '' : 'none';
  }

  function message(text) {
    msgEl.textContent = introOn ? '' : text;
    if (introOn && text) introStatus.textContent = text;
  }

  // Busca acumulada: segurar a seta acelera (10s → 30s → 60s).
  function seekBy(dir) {
    const d = videoEl.duration;
    if (!(d > 0) || !isFinite(d)) return;
    if (seekTarget === null) {
      seekTarget = videoEl.currentTime;
      seekRepeats = 0;
    }
    seekRepeats++;
    const step = seekRepeats > 15 ? 60 : seekRepeats > 5 ? 30 : 10;
    seekTarget = Math.max(0, Math.min(d - 2, seekTarget + dir * step));
    bar.classList.add('seeking');
    seekLabel.textContent = fmtTime(seekTarget);
    showControls(bar);
    updateTimes();
    const withPreview = showPreview(seekTarget, d);
    clearTimeout(seekCommitTimer);
    // Com prévia, espera um pouco mais antes de pular: dá tempo de ver o quadro (o do PC demora mais).
    seekCommitTimer = setTimeout(commitSeek, withPreview === 'pc' ? 1800 : withPreview ? 1400 : 700);
  }

  // Prévia ao avançar/voltar: o quadro daquele ponto, das miniaturas da linha do tempo que o
  // addon manda junto com a fonte (stream.thumbs; hoje XVideos e Pornhub). Cada folha é uma
  // imagem em grade; o quadro é recortado com background-position, sem decodificar vídeo.
  const PREVIEW_W = 320;
  const PREVIEW_H = 180;
  const sheetCache = {};
  function showPreview(time, duration) {
    const th = stream && stream.thumbs;
    if (!th || !th.urls || !th.urls.length || !(th.every > 0) || !(th.cols > 0) || !(th.rows > 0)) return pcPreview(time, duration);
    preview.classList.remove('pc');
    const per = th.cols * th.rows;
    let i = Math.floor(time / th.every);
    let sheet = Math.floor(i / per);
    if (sheet >= th.urls.length) {
      sheet = th.urls.length - 1;
      i = sheet * per + per - 1;
    }
    const cell = i % per;
    const url = th.urls[sheet];
    // Folhas vizinhas já vão baixando (avançar segurando a seta passa por várias).
    [sheet - 1, sheet, sheet + 1].forEach((n) => {
      const u = th.urls[n];
      if (!u || sheetCache[u]) return;
      const img = new Image();
      img.src = u;
      sheetCache[u] = img;
    });
    previewImg.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
    previewImg.style.backgroundSize = th.cols * PREVIEW_W + 'px ' + th.rows * PREVIEW_H + 'px';
    previewImg.style.backgroundPosition = -(cell % th.cols) * PREVIEW_W + 'px ' + -Math.floor(cell / th.cols) * PREVIEW_H + 'px';
    // Acompanha o ponto na barra sem sair das bordas.
    const w = bar.offsetWidth || 1;
    const x = Math.max(PREVIEW_W / 2, Math.min(w - PREVIEW_W / 2, (time / duration) * w));
    preview.style.left = x + 'px';
    preview.classList.add('on');
    return true;
  }

  // Fontes sem miniaturas do site (filmes, séries, TPB...): o servidor do PC tira o quadro com o
  // ffmpeg (thumb.jpg do stremio-service), pedido só quando a posição para de mudar. Leva 1–3 s,
  // então o quadro anterior fica na tela até o novo chegar. Sem o PC, não tem prévia.
  let pcTimer = null;
  let pcWanted = '';
  function pcPreview(time, duration) {
    const src = mediaUrl;
    if (viaNative || settings.lowMemory !== false || !server.isAvailable() || !/^https?:/.test(src) || !(duration > 0)) {
      preview.classList.remove('on');
      return false;
    }
    const w = bar.offsetWidth || 1;
    preview.style.left = Math.max(PREVIEW_W / 2, Math.min(w - PREVIEW_W / 2, (time / duration) * w)) + 'px';
    preview.classList.add('on');
    preview.classList.add('pc');
    if (!pcWanted) previewImg.style.backgroundImage = '';
    clearTimeout(pcTimer);
    pcTimer = setTimeout(() => {
      // O stremio-service decodifica o "from" duas vezes: vai codificado duas vezes.
      const url = server.baseUrl() + 'thumb.jpg?from=' + encodeURIComponent(encodeURIComponent(src)) + '&at=' + Math.round(time);
      pcWanted = url;
      preview.classList.add('loading');
      const img = new Image();
      img.onload = () => {
        if (pcWanted !== url) return;
        previewImg.style.backgroundImage = 'url("' + url + '")';
        preview.classList.remove('loading');
      };
      img.onerror = () => pcWanted === url && preview.classList.remove('loading');
      img.src = url;
    }, 300);
    return 'pc';
  }

  function commitSeek() {
    if (seekTarget === null) return;
    try {
      videoEl.currentTime = seekTarget;
    } catch (e) {
      /* ignore */
    }
    seekTarget = null;
    bar.classList.remove('seeking');
    preview.classList.remove('on');
    clearTimeout(pcTimer);
    pcWanted = '';
    if (videoEl.paused) videoEl.play();
    scheduleHide();
  }

  function cancelSeek() {
    clearTimeout(seekCommitTimer);
    seekTarget = null;
    bar.classList.remove('seeking');
    preview.classList.remove('on');
    clearTimeout(pcTimer);
    pcWanted = '';
    updateTimes();
  }

  // ---------- Faixas ----------
  function selectEmbeddedAudio(index) {
    const native = videoEl.audioTracks;
    if (native && native.length > index) {
      for (let i = 0; i < native.length; i++) native[i].enabled = i === index;
      currentAudio = index;
      return;
    }
    toast(t('Troca de áudio indisponível agora.'));
  }

  // Legenda embutida: se o arquivo já está 100% no PC, o servidor extrai a faixa (WebVTT, blocos
  // de 10s) e o app desenha no estilo Kai, sem os códigos ASS crus ({\an8}) do player da TV.
  // Com o torrent ainda baixando, não extrai: o ffmpeg leria o arquivo e roubaria a prioridade do download.
  function selectEmbeddedSub(index) {
    renderer.clear();
    server.streamProgress(mediaUrl).then((p) => {
      if (!alive) return;
      if (p !== null && p >= 0.999) extractedSub(index);
      else nativeEmbeddedSub(index);
    });
  }

  function extractedSub(index) {
    const cs = { kind: 'embedded', index: index, extracted: true, sid: 'kai' + Math.random().toString(36).slice(2), segs: {}, cues: [], busy: false };
    currentSub = cs;
    applySavedOffset();
    ensureSegments();
  }

  function ensureSegments() {
    const cs = currentSub;
    if (!cs.extracted || cs.busy || !alive) return;
    const n = Math.floor(videoEl.currentTime / 10) + 1;
    const k = !cs.segs[n] ? n : !cs.segs[n + 1] ? n + 1 : 0;
    if (!k) return;
    cs.segs[k] = 'loading';
    cs.busy = true; // um bloco por vez
    const url = server.baseUrl() + 'hlsv2/' + cs.sid + '/subtitle' + cs.index + '/segment' + k + '.vtt?mediaURL=' + encodeURIComponent(mediaUrl);
    getText(url, { timeout: 30000, quiet: true })
      .then((txt) => {
        if (currentSub !== cs) return;
        const seen = {};
        cs.cues.forEach((c) => (seen[c.start + '|' + c.text] = true));
        subs.parse(txt).forEach((c) => {
          if (!seen[c.start + '|' + c.text]) cs.cues.push(c);
        });
        cs.cues.sort((a, b) => a.start - b.start);
        renderer.set(cs.cues);
        renderer.update(videoEl.currentTime);
      })
      .catch(() => delete cs.segs[k])
      .then(() => (cs.busy = false));
  }

  // Sem o arquivo inteiro no PC não dá para extrair a faixa; o player HTML5 da TV não mostra
  // legenda embutida sozinho (falta o player nativo da Samsung, AVPlay).
  function nativeEmbeddedSub() {
    toast(t(viaNative ? 'No torrent local, escolha uma legenda externa dos addons.' : 'Essa legenda embutida só aparece com o arquivo inteiro baixado no servidor externo. Tente uma legenda dos addons.'), 5000);
  }

  function selectAddonSub(s, silent) {
    currentSub = { kind: 'addon', id: s.id || s.url };
    loadAddonCues(s)
      .then((cues) => {
        if (!alive || currentSub.id !== (s.id || s.url)) return;
        useAddonCues(s, cues);
        if (!silent) toast(t('Legenda: {lang}', { lang: subLabel(s) }));
      })
      .catch(() => toast(t('Não foi possível baixar a legenda.')));
  }

  // Menus de faixas: lê as faixas embutidas só agora, quando o usuário pede.
  function withTracks(open) {
    if (embedded || viaNative || !server.isAvailable()) return open();
    toast(t('Lendo as faixas do arquivo...'), 2500);
    loadEmbeddedTracks().then(() => alive && open());
  }

  function audioMenu() {
    withTracks(openAudioMenu);
  }

  function openAudioMenu() {
    const native = videoEl.audioTracks;
    let list = [];
    if (native && native.length) {
      for (let i = 0; i < native.length; i++) {
        list.push({ label: langName(native[i].language) + (native[i].label ? ' · ' + native[i].label : ''), value: i, checked: native[i].enabled });
      }
    } else if (embedded && embedded.audio.length) {
      list = embedded.audio.map((tr, i) => ({
        label: langName(tr.lang) + (tr.label ? ' · ' + tr.label : ''),
        sub: [tr.codec, tr.channels ? t('{n} canais', { n: tr.channels }) : ''].filter(Boolean).join(' · '),
        value: i,
        checked: currentAudio === null ? i === 0 : currentAudio === i,
      }));
    }
    menu(t('Áudio'), list, {
      empty: viaNative ? t('A TV não expõe outras faixas nesta fonte. Tente uma fonte no idioma desejado.') : server.isAvailable() ? t('Só uma faixa de áudio.') : t('Para listar as faixas, conecte o servidor externo em Ajustes.'),
      onPick: (i) => selectEmbeddedAudio(i),
    });
  }

  function subsMenu() {
    withTracks(openSubsMenu);
  }

  function openSubsMenu() {
    const opts2 = [];
    if (renderer.active()) {
      const off = renderer.offset();
      opts2.push({ label: t('Sincronizar legenda'), sub: off ? t('Ajuste atual: {n}', { n: fmtOff(off) }) : t('Automático ou manual'), value: { kind: 'sync' } });
    }
    opts2.push({ label: t('Desligada'), value: { kind: 'off' }, checked: currentSub.kind === 'off' });
    if (embedded && embedded.subs.length) {
      embedded.subs.forEach((tr, i) =>
        /PGS|VOBSUB|DVD/i.test(tr.codec || '') ? null : opts2.push({
          label: langName(tr.lang) + (tr.label ? ' · ' + tr.label : ''),
          sub: t('Embutida no arquivo') + (tr.codec ? ' · ' + tr.codec : ''),
          value: { kind: 'embedded', index: i },
          checked: currentSub.kind === 'embedded' && currentSub.index === i,
        })
      );
    }
    const pref = (settings.subtitleLangs || []).map((x) => x.toLowerCase());
    // Melhores candidatas primeiro (mesma ordem da escolha automática); o resto vem depois.
    const best = subpick.rank(addonSubs, pref, fileInfo || {}, seriesInfo());
    const sorted = best.concat((addonSubs || []).filter((s) => best.indexOf(s) < 0));
    sorted.slice(0, 60).forEach((s) =>
      opts2.push({
        label: subLabel(s),
        sub: s.addon || 'Addon',
        value: { kind: 'addon', sub: s },
        checked: currentSub.kind === 'addon' && currentSub.id === (s.id || s.url),
      })
    );
    opts2.push({ label: t('Tamanho: {n}%', { n: store.settings().subtitleSize || 100 }), value: { kind: 'size' } });
    menu(t('Legendas'), opts2, {
      empty: addonSubs === null ? t('Carregando legendas...') : t('Nenhuma legenda.'),
      onPick: (v) => {
        if (v.kind === 'off' || v.kind === 'embedded' || v.kind === 'addon') autoDone.sub = true;
        if (v.kind === 'off') {
          renderer.clear();
          currentSub = { kind: 'off' };
        } else if (v.kind === 'embedded') selectEmbeddedSub(v.index);
        else if (v.kind === 'addon') selectAddonSub(v.sub);
        else if (v.kind === 'sync') syncMenu();
        else if (v.kind === 'size') sizeMenu();
      },
    });
  }

  // ---------- Sincronia da legenda ----------
  function syncMenu() {
    const off = renderer.offset();
    const list = [
      { label: t('Automático'), sub: t('Pause quando alguém começa a falar e escolha a fala'), value: 'auto' },
      { label: t('Manual'), sub: t('Ajuste fino com as setas do controle'), value: 'manual' },
    ];
    if (off) list.push({ label: t('Zerar ajuste'), sub: t('Agora: {n}', { n: fmtOff(off) }), value: 'zero' });
    menu(t('Sincronizar legenda'), list, {
      onPick: (v) => {
        if (v === 'auto') autoSync();
        else if (v === 'manual') manualSync();
        else {
          setSync(0);
          toast(t('Legenda de volta ao tempo original.'));
        }
      },
    });
  }

  function setSync(v) {
    v = Math.round(v * 10) / 10;
    renderer.setOffset(v);
    renderer.update(videoEl.currentTime);
    if (meta.id !== 'dev') saveSync(video.id, subKey(), v);
  }

  function syncHint(v) {
    const r = Math.round(v * 10) / 10;
    const n = Math.abs(r).toFixed(1).replace('.', ',');
    if (!r) return t('No tempo original do arquivo');
    return r > 0 ? t('A legenda aparece {n} s depois', { n: n }) : t('A legenda aparece {n} s antes', { n: n });
  }

  // Manual: painel no alto da tela (a legenda continua visível embaixo) e as setas mexem ao vivo.
  function manualSync() {
    hideControls();
    const before = renderer.offset();
    let cur = before;
    const val = h('div.ss-val');
    const hint = h('div.ss-hint');
    const knob = h('div.ss-knob');
    // Setas desenhadas: a fonte da TV não tem os símbolos.
    const arrow = (d) => '<svg viewBox="0 0 24 24"><path d="' + d + '"/></svg>';
    const LR = arrow('M15 5l-7 7 7 7') + arrow('M9 5l7 7-7 7');
    const UD = arrow('M5 15l7-7 7 7') + arrow('M5 9l7 7 7-7');
    const keyHint = (k, label) => h('span.ss-key', null, [h('b', { html: k }), label]);
    const box = h('div.sub-sync', null, [
      h('div.ss-title', { text: t('Sincronizar legenda') }),
      val,
      hint,
      h('div.ss-track', null, [h('div.ss-mid'), knob, h('span.ss-end.l', { text: t('antes') }), h('span.ss-end.r', { text: t('depois') })]),
      h('div.ss-keys', null, [keyHint(LR, '0,5 s'), keyHint(UD, '0,1 s'), keyHint(IS_WEB ? 'Enter' : 'OK', t('salvar')), keyHint(IS_WEB ? 'Esc' : t('Voltar'), t('desfazer'))]),
    ]);
    function draw() {
      val.textContent = fmtOff(cur);
      val.className = 'ss-val' + (cur > 0.05 ? ' later' : cur < -0.05 ? ' sooner' : '');
      hint.textContent = syncHint(cur);
      knob.style.left = 50 + Math.max(-10, Math.min(10, cur)) * 5 + '%';
      renderer.setOffset(cur);
      renderer.update(videoEl.currentTime);
    }
    function close(save) {
      syncUi = false;
      nav.popLayer(layer);
      if (box.parentNode) box.parentNode.removeChild(box);
      if (save) {
        setSync(cur);
        toast(t('Legenda ajustada: {n}', { n: fmtOff(cur) }));
      } else {
        renderer.setOffset(before);
        renderer.update(videoEl.currentTime);
      }
    }
    el.appendChild(box);
    syncUi = true;
    const layer = nav.pushLayer(box, {
      onBack: () => close(false),
      onKey: (ev) => {
        const k = ev.keyCode;
        if (k === KEY.BACK || k === KEY.ESC || k === KEY.BACKSPACE) return false;
        if (k === KEY.LEFT) cur -= 0.5;
        else if (k === KEY.RIGHT) cur += 0.5;
        else if (k === KEY.UP) cur += 0.1;
        else if (k === KEY.DOWN) cur -= 0.1;
        else if (k === KEY.ENTER) {
          close(true);
          return true;
        } else if (k === KEY.PLAYPAUSE || k === KEY.PLAY || k === KEY.PAUSE) {
          if (k === KEY.PAUSE) videoEl.pause();
          else if (k === KEY.PLAY) videoEl.play();
          else togglePlay();
          hideControls();
          return true;
        } else return true;
        cur = Math.max(-60, Math.min(60, Math.round(cur * 10) / 10));
        draw();
        return true;
      },
    });
    draw();
  }

  // Automático: com o vídeo parado no instante em que alguém começa a falar, mostra as falas
  // da legenda por perto e o usuário aponta qual é. Ajuste = agora − início daquela fala.
  function autoSync() {
    const all = renderer.cues();
    if (!all.length) return toast(t('Escolha uma legenda primeiro.'));
    syncUi = true;
    videoEl.pause();
    hideControls();
    const now = videoEl.currentTime;
    const at = now - renderer.offset(); // "agora" no relógio da legenda
    const dist = (c) => Math.abs(c.start - at);
    let near = all.filter((c) => c.start >= at - 90 && c.start <= at + 90);
    if (near.length < 6) near = all.slice().sort((a, b) => dist(a) - dist(b)).slice(0, 12);
    if (near.length > 40) near = near.slice().sort((a, b) => dist(a) - dist(b)).slice(0, 40);
    near.sort((a, b) => a.start - b.start);
    let closest = 0;
    near.forEach((c, i) => {
      if (dist(c) < dist(near[closest])) closest = i;
    });
    const rel = (d) => {
      if (Math.abs(d) < 0.3) return t('na legenda: agora');
      const n = Math.abs(d) < 10 ? Math.abs(d).toFixed(1).replace('.', ',') : String(Math.round(Math.abs(d)));
      return d > 0 ? t('na legenda: daqui a {n} s', { n: n }) : t('na legenda: há {n} s', { n: n });
    };
    const list = h('div.modal-list.sync-list', { 'data-scroll-y': '', 'data-pad-y': '120' });
    const items = near.map((c) =>
      h('div.opt.sync-opt', { focusable: true, onSelect: () => pick(c) }, [
        h('span.so-text', { html: c.text.replace(/\n/g, '<br>') }),
        h('small', { text: rel(c.start - at) }),
      ])
    );
    items.forEach((it) => list.appendChild(it));
    const box = h('div.modal-box.sync-box', null, [
      h('h3', { text: t('Qual fala começa agora?') }),
      h('p.modal-text', { text: t('Pausado em {time}. Escolha a fala que começa exatamente neste momento.', { time: fmtTime(now) }) }),
      list,
    ]);
    const modal = h('div.modal.sync-modal', null, box);
    document.getElementById('app').appendChild(modal);
    const layer = nav.pushLayer(modal, { onBack: () => close() });
    nav.focus(items[closest]);
    function close() {
      syncUi = false;
      nav.popLayer(layer);
      if (modal.parentNode) modal.parentNode.removeChild(modal);
    }
    function pick(c) {
      close();
      setSync(now - c.start);
      toast(t('Legenda sincronizada ({n})', { n: fmtOff(renderer.offset()) }), 4000);
      videoEl.play();
    }
  }

  function sizeMenu() {
    const vals = [70, 85, 100, 115, 130, 150];
    const cur = store.settings().subtitleSize || 100;
    menu(
      t('Tamanho da legenda'),
      vals.map((v) => ({ label: v + '%', value: v, checked: v === cur })),
      {
        onPick: (v) => {
          const next = store.saveSettings({ subtitleSize: v });
          substyle.apply(subsEl, next);
        },
      }
    );
  }

  function sourcesMenu() {
    const list = (opts.streams || []).map((s, i) => ({
      label: ((s.name || s.addon || '') + '').replace(/\n/g, ' '),
      sub: ((s.title || s.description || '') + '').replace(/\n/g, ' · '),
      value: i,
      checked: s === stream,
    }));
    menu(t('Fontes'), list, {
      onPick: (i) => {
        const s = opts.streams[i];
        if (!s || s === stream) return;
        if (server.needsServer(s) && !server.isAvailable()) return toast(t('Essa fonte precisa de um servidor Stremio externo.'));
        autoSelecting = false;
        autoTries = 0; // uma escolha explícita do usuário inicia outro orçamento de recuperação
        switchTo(s);
      },
    });
  }

  // Troca de fonte no mesmo ponto do vídeo.
  function switchTo(s) {
    saveProgress();
    if (videoEl.currentTime > 1) pendingStart = videoEl.currentTime * 1000;
    stream = s;
    slowExtensions = 0;
    if (!si.wasTried(s, tried)) tried.push(s);
    triedTranscode = false;
    autoDone = { sub: false, audio: false };
    start();
  }

  // ---------- Demorando para carregar: oferece outro provedor ----------
  function armSlow(delay) {
    clearTimeout(slowTimer);
    closeSlow();
    slowTimer = setTimeout(() => {
      if (alive && !hasPlayed) checkSlow();
    }, typeof delay === 'number' ? delay : SLOW_MS);
  }

  // Se o torrent ainda está recebendo dados, espera um pouco antes de trocar de fonte.
  let slowExtensions = 0;
  function checkSlow() {
    const generation = startGeneration;
    const sessionId = nativeSessionId;
    if ((!viaServer && !viaNative) || slowExtensions >= 3) return slowPrompt();
    const progress = viaNative
      ? () => server.nativeStatus().then((r) => {
          if (!r || r.sessionId !== sessionId) return null;
          return typeof r.downloadedBytes === 'number' ? r.downloadedBytes : typeof r.downloaded === 'number' ? r.downloaded : null;
        }, () => null)
      : () => server.streamProgress(mediaUrl);
    progress().then((p1) => {
      if (!alive || generation !== startGeneration || hasPlayed) return;
      slowProbeTimer = setTimeout(() => {
        progress().then((p2) => {
          if (!alive || generation !== startGeneration || hasPlayed) return;
          if (p1 !== null && p2 !== null && p2 > p1) {
            slowExtensions++;
            message(viaNative ? t('O torrent está recebendo dados na própria TV...') : t('Ainda baixando no servidor externo ({pct}% do arquivo)...', { pct: Math.round(p2 * 100) }));
            clearTimeout(slowTimer);
            slowTimer = setTimeout(() => alive && generation === startGeneration && !hasPlayed && checkSlow(), 20000);
          } else slowPrompt();
        });
      }, 4000);
    });
  }

  function closeSlow() {
    if (!slowModal) return;
    clearInterval(slowModal.timer);
    nav.popLayer(slowModal.layer);
    if (slowModal.el.parentNode) slowModal.el.parentNode.removeChild(slowModal.el);
    slowModal = null;
  }

  function slowPrompt() {
    closeSlow();
    let left = SLOW_COUNTDOWN;
    const goBtn = h('div.btn.primary', { focusable: true, onSelect: () => (closeSlow(), tryAnother()) });
    const waitBtn = h('div.btn', { focusable: true, text: t('Esperar mais'), onSelect: () => armSlow() });
    const label = () => (goBtn.textContent = t('Tentar outro ({n}s)', { n: left }));
    label();
    const box = h('div.modal-box.center.slow-box', null, [
      h('h3', { text: t('Está demorando… tentar outro provedor?') }),
      h('p.modal-text', { text: t('Se você não escolher nada, tento outra fonte sozinho.') }),
      h('div.modal-actions', { 'data-group': '' }, [goBtn, waitBtn]),
    ]);
    const modal = h('div.modal', null, box);
    el.appendChild(modal);
    const layer = nav.pushLayer(modal, { onBack: () => armSlow() });
    nav.focus(goBtn);
    const timer = setInterval(() => {
      left--;
      if (left > 0) return label();
      closeSlow();
      tryAnother();
    }, 1000);
    slowModal = { el: modal, layer: layer, timer: timer };
  }

  // Antes de trocar, confere a conexão: se a internet (ou o servidor do PC, no torrent) caiu,
  // trocar de fonte não adianta.
  function connectionOk() {
    const net = getJSON(addons.CINEMETA, { timeout: 7000 }).then(
      () => true,
      () => false
    );
    const local = server.nativeEnabled() && server.isTorrent(stream);
    const srv = local
      ? server.nativeStatus().then((r) => !!r && r.supported !== false && r.available !== false, () => false)
      : server.needsServer(stream) ? server.check().then((r) => !!(r && r.ok), () => false) : Promise.resolve(true);
    return Promise.all([net, srv]).then((r) => ({ internet: r[0], server: r[1] }));
  }

  function tryAnother() {
    const generation = startGeneration;
    showSpinner(true);
    message(t('Testando a conexão...'));
    connectionOk().then((c) => {
      if (!alive || generation !== startGeneration || hasPlayed) return;
      if (!c.internet || !c.server) {
        message('');
        showSpinner(false);
        menu(
          !c.internet ? t('A internet da TV parece fora do ar') : server.nativeEnabled() && server.isTorrent(stream) ? t('O motor torrent local da TV não está respondendo') : t('O servidor externo não está respondendo'),
          [
            { label: t('Esperar e tentar de novo'), sub: t('Reabre a mesma fonte'), value: 'retry', checked: true },
            { label: t('Escolher outra fonte'), value: 'src' },
            { label: t('Voltar'), value: 'back' },
          ],
          {
            center: true,
            onPick: (v) => {
              if (v === 'retry') switchTo(stream);
              else if (v === 'src') sourcesMenu();
              else router.pop();
            },
          }
        );
        return;
      }
      // A conexão está presente, mas a fonte não progrediu: não a reutiliza no automático.
      si.markFailed(stream, lightContext());
      const next = autoFallback();
      if (!next) {
        message('');
        fail(t('Nenhuma outra fonte adequada ao Smart Choice . Light para tentar. Escolha manualmente.'));
        return;
      }
      const pick = { stream: next };
      const info = si.parse(pick.stream);
      toast(t('Tentando: {what}', { what: si.summary(info) || info.addon }), 3500);
      autoSelecting = true;
      switchTo(pick.stream);
    });
  }

  // Cada episódio recebe uma nova avaliação; bingeGroup não passa por cima do perfil Light.
  function playNext() {
    const generation = startGeneration;
    const nv = nextVideo();
    if (!nv) return;
    saveProgress();
    showSpinner(true);
    message(t('Procurando o próximo episódio...'));
    addons.fetchStreams(meta.type, nv.id).then((list) => {
      if (!alive || generation !== startGeneration) return;
      const pick = si.smartPick(list, server.isAvailable(), si.choiceContext(meta, nv, opts.isSeries));
      if (pick) {
        video = nv;
        stream = pick.stream;
        autoSelecting = true;
        opts.streams = list;
        tried.length = 0;
        tried.push(stream);
        autoTries = 0;
        failedNotes.length = 0;
        pendingStart = 0;
        triedTranscode = false;
        autoDone = { sub: false, audio: false };
        start();
      } else {
        router.pop();
        openDetails(meta.type, meta.id, { videoId: nv.id, autoStreams: true, manualStreams: true });
      }
    }).catch(() => {
      if (alive && generation === startGeneration) fail(t('Não foi possível buscar as fontes do próximo episódio.'));
    });
  }

  // ---------- Progresso ----------
  function saveProgress() {
    const d = videoEl.duration;
    if (!(d > 0) || !isFinite(d) || !videoEl.currentTime) return;
    const delta = watchedDelta;
    watchedDelta = 0;
    if (meta.id === 'dev') return; // teste de desenvolvimento: não mexe na biblioteca
    stremio.saveProgress(meta, video.id, videoEl.currentTime * 1000, d * 1000, delta);
  }

  // ---------- Teclas ----------
  function onKey(e) {
    const k = e.keyCode;
    const cur = nav.current();
    switch (k) {
      case KEY.PLAY:
        videoEl.play();
        showControls();
        return true;
      case KEY.SPACE: // teclado: espaço e K tocam/pausam (como no YouTube)
      case 75:
        togglePlay();
        return true;
      case 77: // M: silencia
        videoEl.muted = !videoEl.muted;
        return true;
      case KEY.PAUSE:
        videoEl.pause();
        return true;
      case KEY.PLAYPAUSE:
        togglePlay();
        return true;
      case KEY.STOP:
        close();
        return true;
      case KEY.FF:
        seekBy(1);
        return true;
      case KEY.RW:
        seekBy(-1);
        return true;
      case KEY.BACK:
      case KEY.ESC:
      case KEY.BACKSPACE:
        if (seekTarget !== null) cancelSeek();
        else if (activeSeg && !controlsOn) dismissSkip();
        else if (controlsOn && !videoEl.paused) hideControls();
        else close();
        return true;
    }
    if (!controlsOn && activeSeg) {
      if (k === KEY.ENTER) {
        doSkip();
        return true;
      }
    }
    if (!controlsOn) {
      if (IS_WEB && (k === KEY.UP || k === KEY.DOWN)) {
        // Teclado: seta para cima/baixo mexe no volume (sem abrir a barra).
        videoEl.muted = false;
        videoEl.volume = Math.max(0, Math.min(1, videoEl.volume + (k === KEY.UP ? 0.1 : -0.1)));
        toast(t('Volume {n}%', { n: Math.round(videoEl.volume * 100) }), 1200);
        return true;
      }
      if (k === KEY.LEFT) seekBy(-1);
      else if (k === KEY.RIGHT) seekBy(1);
      else if (k === KEY.ENTER) togglePlay();
      else if (k === KEY.DOWN) showControls(playBtn);
      else showControls(bar);
      return true;
    }
    scheduleHide();
    if (cur === bar) {
      if (k === KEY.LEFT) {
        seekBy(-1);
        return true;
      }
      if (k === KEY.RIGHT) {
        seekBy(1);
        return true;
      }
      if (k === KEY.UP) {
        hideControls();
        return true;
      }
    }
    return false;
  }

  function close() {
    saveProgress();
    router.pop();
  }

  return {
    el: el,
    onKey: onKey,
    onShow: () => {
      if (!ticker) {
        setupIntro();
        start();
        ticker = setInterval(() => {
          if (controlsOn) updateTimes();
          renderer.update(videoEl.currentTime);
          checkSkip();
          if (currentSub.extracted) ensureSegments();
        }, 250);
        saveTimer = setInterval(() => {
          if (!videoEl.paused) saveProgress();
        }, SAVE_MS);
        watchTimer = setInterval(watchdog, 2000);
        calTimer = setInterval(checkCalendar, 20000);
        setTimeout(checkCalendar, 3000);
        // Build de desenvolvimento: estado do buffer a cada 10s no log remoto.
        if (__KAI_DEVLOG__) statusTimer = setInterval(() => !videoEl.paused && diag('status'), 10000);
      }
      showControls(bar);
    },
    onBack: () => {
      close();
      return true;
    },
    destroy: () => {
      alive = false;
      startGeneration++;
      releaseNative();
      playingWaiters.slice().forEach((done) => done());
      clearTimeout(slowProbeTimer);
      clearTimeout(pcTimer);
      pcWanted = '';
      renderer.clear();
      clearInterval(ticker);
      clearInterval(saveTimer);
      clearInterval(watchTimer);
      clearInterval(calTimer);
      closeNotice();
      clearInterval(statusTimer);
      clearTimeout(hideTimer);
      clearTimeout(seekCommitTimer);
      clearTimeout(slowTimer);
      closeSlow();
      try {
        videoEl.pause();
        dropSource();
        videoEl.removeAttribute('src');
        videoEl.load();
      } catch (e) {
        /* ignore */
      }
    },
  };
}

function escapeHtml(x) {
  return String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
