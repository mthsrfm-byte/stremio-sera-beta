// AVPlay, o player nativo da Samsung, com a cara de um <video>: o player do app usa os mesmos
// eventos (loadedmetadata, playing, waiting, timeupdate, pause, ended, error) e propriedades
// (currentTime, duration, paused, audioTracks, src). Com ele a TV mostra as faixas de áudio e as
// legendas embutidas do arquivo, sem servidor no PC, e o app escolhe o buffer antes de tocar.
// Contornos da Samsung adaptados do StremioK (MIT, Kepler75): espera curta entre fechar e reabrir,
// suspender/restaurar com o app em segundo plano, desfazer o salto que o player dá depois de uma
// pausa e tolerar o erro passageiro logo depois de um avanço.
import * as store from './store.js';

export const PLAYERS = { avplay: 'AVPlay (Samsung)', html5: 'Proprietário (atual)' };

function api() {
  return typeof window !== 'undefined' && window.webapis && window.webapis.avplay ? window.webapis.avplay : null;
}

export function available() {
  return !!api();
}

// 'avplay' quando escolhido (ou padrão) e disponível nesta TV; senão o player proprietário (<video>).
export function playerName() {
  const choice = store.settings().player;
  return choice !== 'html5' && available() ? 'avplay' : 'html5';
}

// Algumas instalações só expõem webapis depois de carregar o script da própria TV.
export function ensureWebapis() {
  if (typeof window === 'undefined' || window.webapis || !window.tizen) return;
  try {
    const s = document.createElement('script');
    s.src = '$WEBAPIS/webapis/webapis.js';
    document.head.appendChild(s);
  } catch (e) { /* sem webapis: fica o player proprietário */ }
}

const SETTLE_MS = 300; // a TV costuma recusar abrir logo depois de fechar um vídeo que tocava
const SEEK_GRACE_MS = 6000;
const JUMP_SLACK_MS = 3000;
const SEEK_STUCK_MS = 12000; // sem retorno do seekTo: segue pelo tempo que a TV informar
const BUFFER_TIMEOUT_S = 60; // padrão da TV é 20 s: pouco para torrent começar
// Buffer: segundos carregados antes de começar e antes de voltar depois de esvaziar.
export const BUFFERS = { normal: null, more: [8, 10], most: [15, 20] };

// A TV às vezes manda WebAPIException com name genérico (UnknownError) e o código no message.
function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return [err.name, err.message, err.code].filter(Boolean).join(' ') || String(err);
}

function errorCode(err) {
  const text = errorText(err);
  if (/NOT_SUPPORTED|UNSUPPORTED|CODEC|FORMAT|DRM|CORRUPT/i.test(text)) return 4;
  if (/CONNECTION|NETWORK|INVALID_URI|TIMEOUT|HTTP|SOCKET|DISCONNECT/i.test(text)) return 2;
  return 3;
}

// extra_info vem como JSON, mas nem sempre limpo; o idioma chega como language ou track_lang.
function trackInfo(raw) {
  const text = String(raw || '');
  let info = {};
  try { info = JSON.parse(text) || {}; } catch (e) {
    const grab = (k) => { const m = new RegExp('"?' + k + '"?\\s*:\\s*"?([^",}]*)').exec(text); return m ? m[1].trim() : ''; };
    info = { language: grab('language'), track_lang: grab('track_lang'), channels: grab('channels'), fourCC: grab('fourCC'), label: grab('label') };
  }
  return {
    lang: String(info.language || info.track_lang || '').trim(),
    channels: Number(info.channels) || 0,
    codec: String(info.fourCC || info.codec || '').trim(),
    label: String(info.label || '').trim(),
  };
}

export function create() {
  const av = api();
  const host = document.createElement('div');
  host.className = 'av-host';
  const plane = document.createElement('object');
  plane.setAttribute('type', 'application/avplayer');
  plane.className = 'av-plane';
  host.appendChild(plane);

  let src = '';
  let token = 0;
  let ready = false;
  let paused = true;
  let ended = false;
  let cur = 0;
  let dur = NaN;
  let error = null;
  let wantPlay = false;
  let autoplay = false;
  let pendingSeek = null;
  let seekingTo = null;
  let lastSeekAt = 0;
  let recovering = false;
  let openedOnce = false;
  let suspended = false;
  let volume = 1;
  let muted = false;
  // Salto depois de pausa
  let pausedOnce = false;
  let lastTickMs = -1;
  let lastTickWall = 0;
  let lastJumpTo = -1;
  let onSubtitle = null;
  let textIndex = null;
  // Escolhas de faixa que sobrevivem a uma reabertura (travamento, volta do segundo plano).
  let wantText = null;
  let wantAudio = null;
  let tracksApplied = false;
  let seekTimer = null;

  function fire(type) {
    let e;
    try {
      e = document.createEvent('Event');
      e.initEvent(type, false, false);
    } catch (err) {
      e = new Event(type);
    }
    host.dispatchEvent(e);
  }

  function screenSaver(on) {
    try {
      const ac = window.webapis.appcommon;
      const noop = () => {};
      ac.setScreenSaver(on ? ac.AppCommonScreenSaverState.SCREEN_SAVER_ON : ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF, noop, noop);
    } catch (e) { /* TV sem appcommon */ }
  }

  function state() {
    try { return av.getState(); } catch (e) { return 'NONE'; }
  }

  function closeAv() {
    token++;
    const had = ready || state() !== 'NONE';
    ready = false;
    seekingTo = null;
    pendingSeek = null;
    suspended = false;
    clearTimeout(seekTimer);
    try { av.stop(); } catch (e) { /* já parado */ }
    try { av.close(); } catch (e) { /* já fechado */ }
    if (!paused) {
      paused = true;
      screenSaver(true);
    }
    return had;
  }

  function setError(err) {
    error = { code: errorCode(err), message: errorText(err) || 'AVPlay' };
    ready = false;
    paused = true;
    screenSaver(true);
    fire('error');
  }

  function applyBuffer() {
    const buf = BUFFERS[store.settings().playerBuffer || 'normal'];
    if (!buf) return;
    try {
      av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', buf[0]);
      av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', buf[1]);
    } catch (e) { /* firmware sem ajuste de buffer */ }
  }

  function open(url) {
    const settle = closeAv() || openedOnce;
    const mine = token;
    cur = 0;
    dur = NaN;
    error = null;
    ended = false;
    pausedOnce = false;
    lastTickMs = -1;
    lastJumpTo = -1;
    textIndex = null;
    tracksApplied = false;
    wantPlay = autoplay;
    if (!url) return;
    const go = () => {
      if (mine !== token || src !== url) return;
      openedOnce = true;
      try {
        av.open(url);
        applyBuffer();
        try { av.setTimeoutForBuffering(BUFFER_TIMEOUT_S); } catch (e) { /* firmware sem ajuste */ }
        av.setListener(listener(mine));
        fire('loadstart');
        av.prepareAsync(() => {
          if (mine !== token) return;
          ready = true;
          try { av.setDisplayRect(0, 0, 1920, 1080); } catch (e) { /* plano já ocupa a tela */ }
          try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) { /* padrão da TV */ }
          let ms = 0;
          try { ms = av.getDuration(); } catch (e) { ms = 0; }
          dur = ms > 0 ? ms / 1000 : Infinity;
          fire('loadedmetadata');
          fire('durationchange');
          fire('loadeddata');
          if (pendingSeek !== null) {
            const target = pendingSeek;
            pendingSeek = null;
            seek(target);
          }
          fire('canplay');
          if (wantPlay) doPlay();
        }, (err) => {
          if (mine === token) setError(err);
        });
      } catch (e) {
        if (mine === token) setError(e);
      }
    };
    if (settle) setTimeout(go, SETTLE_MS);
    else go();
  }

  function listener(mine) {
    return {
      onbufferingstart: () => { if (mine === token) fire('waiting'); },
      onbufferingprogress: () => {},
      onbufferingcomplete: () => {
        if (mine !== token) return;
        fire('canplay');
        if (!paused) fire('playing');
      },
      oncurrentplaytime: (ms) => {
        if (mine !== token) return;
        // O seekTo não respondeu, mas a TV já está no ponto pedido: o avanço terminou.
        if (seekingTo !== null) {
          if (Math.abs(ms / 1000 - seekingTo) < 3 && Date.now() - lastSeekAt > 1500) finishSeek(mine, ms);
          return;
        }
        if (fixJump(ms)) return;
        if (!tracksApplied) applyTracks();
        cur = ms / 1000;
        fire('timeupdate');
      },
      onstreamcompleted: () => {
        if (mine !== token) return;
        ended = true;
        cur = isFinite(dur) ? dur : cur;
        if (!paused) {
          paused = true;
          screenSaver(true);
          fire('pause');
        }
        fire('ended');
      },
      onerror: (err) => {
        if (mine !== token) return;
        // Logo depois de um avanço alguns arquivos dão um erro passageiro: tenta seguir tocando.
        if (Date.now() - lastSeekAt < SEEK_GRACE_MS && !recovering) {
          recovering = true;
          try { av.play(); } catch (e) { /* segue para o erro se não voltar */ }
          setTimeout(() => { recovering = false; }, 4000);
          return;
        }
        setError(err);
      },
      onerrormsg: (id, msg) => {
        if (mine === token && error && msg) error.message = errorText(id) + ' ' + String(msg).slice(0, 300);
      },
      onsubtitlechange: (duration, text) => {
        if (mine === token && onSubtitle && textIndex !== null) onSubtitle(String(text || ''), Number(duration) || 0);
      },
      onevent: () => {},
      ondrmevent: () => {},
    };
  }

  // Depois de pausas, o player às vezes pula para onde estaria se nunca tivesse pausado. Um salto
  // à frente maior que o tempo que passou volta para onde estava; o mesmo salto duas vezes seguidas
  // (um buraco real no arquivo) passa.
  function fixJump(ms) {
    const now = Date.now();
    const prev = lastTickMs;
    const wall = now - lastTickWall;
    lastTickMs = ms;
    lastTickWall = now;
    if (!pausedOnce || prev < 0 || now - lastSeekAt < SEEK_GRACE_MS) return false;
    const jump = ms - prev;
    if (jump <= wall + JUMP_SLACK_MS) return false;
    if (lastJumpTo >= 0 && Math.abs(ms - lastJumpTo) < 2000) {
      lastJumpTo = -1;
      return false;
    }
    lastJumpTo = ms;
    lastTickMs = prev;
    seek(prev / 1000, true);
    return true;
  }

  // Faixas escolhidas antes de uma reabertura: aplicadas quando a TV já está tocando.
  function applyTracks() {
    tracksApplied = true;
    if (wantAudio !== null) selectAudio(wantAudio);
    if (wantText !== null && onSubtitle) selectText(wantText);
  }

  function finishSeek(mine, ms) {
    if (mine !== token || seekingTo === null) return;
    clearTimeout(seekTimer);
    seekingTo = null;
    cur = ms / 1000;
    lastTickMs = ms;
    lastTickWall = Date.now();
    fire('seeked');
    fire('timeupdate');
    // A Samsung pede esperar o retorno do seekTo antes de outra chamada: o play espera aqui.
    if (wantPlay && paused) doPlay();
  }

  function seek(seconds, internal) {
    const ms = Math.max(0, Math.floor(seconds * 1000));
    if (!ready) {
      pendingSeek = seconds;
      cur = seconds;
      return;
    }
    const mine = token;
    lastSeekAt = internal ? lastSeekAt : Date.now();
    seekingTo = seconds;
    ended = false;
    fire('seeking');
    const done = () => finishSeek(mine, ms);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(done, SEEK_STUCK_MS);
    try {
      av.seekTo(ms, done, done);
    } catch (e) {
      done();
    }
  }

  function doPlay() {
    wantPlay = true;
    if (!ready || seekingTo !== null) return;
    const st = state();
    if (st === 'PLAYING' && !paused) return;
    try { av.play(); } catch (e) { return; }
    const wasPaused = paused;
    paused = false;
    ended = false;
    lastTickWall = Date.now();
    screenSaver(false);
    if (wasPaused) fire('play');
    fire('playing');
  }

  function doPause() {
    wantPlay = false;
    if (!ready || paused) {
      paused = true;
      return;
    }
    try { av.pause(); } catch (e) { /* estado já mudou */ }
    paused = true;
    pausedOnce = true;
    screenSaver(true);
    fire('pause');
  }

  // Segundo plano: a TV suspende o player; ao voltar, restaura ou reabre no mesmo ponto.
  function onVisibility() {
    if (!ready) return;
    if (document.hidden) {
      // Como no StremioK: pausa antes de suspender; na volta fica pausado (OK continua).
      if (!paused) doPause();
      try { av.suspend(); suspended = true; } catch (e) { suspended = false; }
      return;
    }
    if (!suspended) return;
    suspended = false;
    try {
      av.restore();
      try { av.setDisplayRect(0, 0, 1920, 1080); } catch (e) { /* plano já ocupa a tela */ }
      // restore() sem bPrepare retoma sozinho em alguns firmwares: mantém o estado que o app mostra.
      if (paused && state() === 'PLAYING') { try { av.pause(); } catch (e) { /* segue */ } }
    } catch (e) {
      const at = cur;
      const play = !paused;
      autoplay = play;
      open(src);
      pendingSeek = at;
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  function audioList() {
    if (!ready) return [];
    let all = [];
    let current = -1;
    try { all = av.getTotalTrackInfo() || []; } catch (e) { all = []; }
    try {
      (av.getCurrentStreamInfo() || []).forEach((x) => { if (x.type === 'AUDIO') current = Number(x.index); });
    } catch (e) { /* sem faixa atual */ }
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const tr = all[i];
      if (!tr || tr.type !== 'AUDIO') continue;
      const index = Number(tr.index);
      const info = trackInfo(tr.extra_info);
      const track = { index: index, language: info.lang, label: info.label, codec: info.codec, channels: info.channels };
      Object.defineProperty(track, 'enabled', {
        get: () => index === current,
        set: (on) => {
          if (!on || index === current) return;
          wantAudio = index;
          if (selectAudio(index)) current = index;
        },
      });
      out.push(track);
    }
    return out;
  }

  function selectAudio(index) {
    try { av.setSelectTrack('AUDIO', index); } catch (e) {
      try { av.setSelectTrack('AUDIO', String(index)); } catch (e2) { return false; }
    }
    return true;
  }

  function selectText(index) {
    try { av.setSilentSubtitle(false); } catch (e) { /* segue */ }
    try { av.setSelectTrack('TEXT', index); } catch (e) {
      try { av.setSelectTrack('TEXT', String(index)); } catch (e2) { return false; }
    }
    textIndex = index;
    return true;
  }

  function textList() {
    if (!ready) return [];
    let all = [];
    try { all = av.getTotalTrackInfo() || []; } catch (e) { all = []; }
    return all.filter((tr) => tr && (tr.type === 'TEXT' || tr.type === 'SUBTITLE')).map((tr) => {
      const info = trackInfo(tr.extra_info);
      return { index: Number(tr.index), lang: info.lang, label: info.label, codec: info.codec };
    });
  }

  const props = {
    src: { get: () => src, set: (url) => { src = String(url || ''); open(src); } },
    currentTime: { get: () => (seekingTo !== null ? seekingTo : cur), set: (v) => seek(Number(v) || 0) },
    duration: { get: () => dur },
    paused: { get: () => paused },
    ended: { get: () => ended },
    error: { get: () => error },
    readyState: { get: () => (ready ? 4 : 0) },
    networkState: { get: () => (src ? 2 : 0) },
    buffered: { get: () => ({ length: 0, start: () => 0, end: () => 0 }) },
    autoplay: { get: () => autoplay, set: (v) => { autoplay = !!v; if (autoplay && src) wantPlay = true; } },
    volume: { get: () => volume, set: (v) => { volume = Number(v); } },
    // Volume e mudo ficam com o controle da TV (só o teclado do navegador usa estes).
    muted: { get: () => muted, set: (v) => { muted = !!v; } },
    audioTracks: { get: () => audioList() },
    isAvPlay: { value: true },
  };
  Object.keys(props).forEach((k) => Object.defineProperty(host, k, Object.assign({ configurable: true }, props[k])));

  host.play = () => { doPlay(); return Promise.resolve(); };
  host.pause = () => doPause();
  host.load = () => { if (src) open(src); else closeAv(); };
  const baseGet = host.getAttribute.bind(host);
  const baseRemove = host.removeAttribute.bind(host);
  host.getAttribute = (name) => (name === 'src' ? (src || null) : baseGet(name));
  host.removeAttribute = (name) => {
    if (name !== 'src') return baseRemove(name);
    src = '';
    closeAv();
  };
  // Faixas embutidas de legenda: a TV entrega cada fala na hora certa (onSubtitle).
  host.avTextTracks = () => textList();
  host.avSelectText = (index, cb) => {
    onSubtitle = cb || null;
    if (index === null || index === undefined) {
      textIndex = null;
      wantText = null;
      try { av.setSilentSubtitle(true); } catch (e) { /* sem legenda */ }
      return true;
    }
    wantText = index;
    return selectText(index);
  };
  host.avDestroy = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    src = '';
    onSubtitle = null;
    wantText = null;
    wantAudio = null;
    closeAv();
    try { av.setListener({}); } catch (e) { /* solta os retornos deste vídeo */ }
  };
  return host;
}
