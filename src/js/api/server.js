// Dois caminhos separados: torrent experimental dentro da TV e servidor Stremio externo.
// Só o servidor externo fornece proxy, ffprobe e conversão de codecs.
import { getJSON, postJSON } from '../lib/http.js';
import * as store from '../lib/store.js';
import { getTvIp } from '../lib/tv.js';
import { t } from '../lib/i18n.js';
import { IS_WEB } from '../lib/platform.js';

let status = { ok: false, checkedAt: 0, url: '' };
const NATIVE_BASE = 'http://127.0.0.1:8094/api/torrent/';
let nativeSequence = 0;

export function nativeEnabled() {
  return !IS_WEB && store.settings().nativeTorrent !== false;
}

// Uma URL HTTP que também inclui infoHash continua sendo uma fonte direta.
export function isTorrent(stream) {
  if (!stream) return false;
  if (typeof stream.url === 'string') return /^magnet:/i.test(stream.url);
  return typeof stream.infoHash === 'string';
}

export function isNativeMediaUrl(url) {
  return /^http:\/\/127\.0\.0\.1:8094\/api\/torrent\/stream\//.test(String(url || ''));
}

export function createNativeSessionId() {
  nativeSequence++;
  return 'tv-' + Date.now().toString(36) + '-' + nativeSequence.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function nativeStatus() {
  return getJSON(NATIVE_BASE + 'status', { timeout: 4000, quiet: true });
}

// Nunca usa stop sem dono: uma resposta atrasada não pode encerrar a sessão nova.
export function stopNative(sessionId) {
  if (!sessionId) return Promise.resolve(null);
  return postJSON(NATIVE_BASE + 'stop', { sessionId: sessionId }, { timeout: 4000, quiet: true }).catch(() => null);
}

function cancelled() {
  const e = new Error(t('Preparação do torrent cancelada'));
  e.cancelled = true;
  return e;
}

function nativeTorrent(infoHash, fileIdx, sources, seriesInfo, options) {
  const o = options || {};
  const sessionId = o.sessionId || createNativeSessionId();
  const current = () => !o.isCurrent || o.isCurrent();
  if (!current()) return Promise.reject(cancelled());
  const body = { infoHash: infoHash, sources: sources || [], sessionId: sessionId };
  if (fileIdx !== null && fileIdx !== undefined && isFinite(fileIdx)) body.fileIdx = Number(fileIdx);
  if (seriesInfo && isFinite(seriesInfo.season)) body.season = Number(seriesInfo.season);
  if (seriesInfo && isFinite(seriesInfo.episode)) body.episode = Number(seriesInfo.episode);
  return postJSON(NATIVE_BASE + 'start', body, { timeout: 70000, quiet: true })
    .then((r) => {
      if (!current()) throw cancelled();
      if (r && typeof r.url === 'string' && r.url.indexOf('/api/torrent/stream/') === 0) r.url = 'http://127.0.0.1:8094' + r.url;
      if (!r || !r.url || !r.sessionId || r.sessionId !== sessionId || !isNativeMediaUrl(r.url)) {
        throw new Error(t('Resposta inválida do motor torrent local. Atualize a beta.'));
      }
      if (o.validateFile) {
        const reason = o.validateFile({ name: r.name, length: r.length });
        if (reason) throw new Error(reason);
      }
      return { url: r.url, viaServer: false, viaNative: true, sessionId: sessionId };
    })
    .catch((e) => {
      stopNative(sessionId);
      if (!current() || e.cancelled) throw cancelled();
      const detail = e.timeout
        ? t('Tempo esgotado ao buscar peers e preparar o vídeo. Tente outra fonte.')
        : e.status === 0 || e.status === 404
          ? t('O serviço da TV não respondeu. Abra a beta pelo TizenBrew ou atualize o módulo.')
          : e.detail || e.message;
      const wrapped = new Error(t('Torrent local: {msg}', { msg: detail }));
      wrapped.status = e.status;
      wrapped.timeout = e.timeout;
      wrapped.unavailable = !e.timeout && (e.status === 0 || e.status === 404);
      throw wrapped;
    });
}

export function baseUrl() {
  let u = (store.settings().serverUrl || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//.test(u)) u = 'http://' + u;
  if (!/:\d+/.test(u.replace(/^https?:\/\//, ''))) u = u.replace(/\/$/, '') + ':11470';
  return u.replace(/\/$/, '') + '/';
}

export function check(urlOverride) {
  const u = urlOverride || baseUrl();
  if (!u) {
    status = { ok: false, checkedAt: Date.now(), url: '' };
    return Promise.resolve(status);
  }
  return getJSON(u + 'settings', { timeout: 4000, quiet: true })
    .then((r) => {
      status = { ok: true, checkedAt: Date.now(), url: u, version: r && r.values && r.values.serverVersion };
      return status;
    })
    .catch(() => {
      status = { ok: false, checkedAt: Date.now(), url: u };
      return status;
    });
}

export function isAvailable() {
  return status.ok && status.url === baseUrl();
}

export function lastStatus() {
  return status;
}

// Procura o servidor na mesma sub-rede da TV (x.x.x.1–254), em lotes.
export function scan(onProgress) {
  return getTvIp().then((ip) => {
    const prefix = ip.split('.').slice(0, 3).join('.') + '.';
    const hosts = [];
    for (let i = 1; i < 255; i++) if (prefix + i !== ip) hosts.push(prefix + i);
    let found = null;
    let done = 0;
    const batch = 24;
    const runBatch = (start) => {
      if (found || start >= hosts.length) return Promise.resolve(found);
      const slice = hosts.slice(start, start + batch);
      return Promise.all(
        slice.map((h) =>
          getJSON('http://' + h + ':11470/settings', { timeout: 1500, quiet: true })
            .then(() => {
              if (!found) found = h;
            })
            .catch(() => {})
            .then(() => {
              done++;
              if (onProgress) onProgress(done, hosts.length);
            })
        )
      ).then(() => runBatch(start + batch));
    };
    return runBatch(0);
  });
}

function parseMagnet(uri) {
  const m = uri.match(/(?:[?&])xt=urn:btih:([a-zA-Z0-9]+)/i);
  if (!m) return null;
  let hash = m[1];
  if (/^[a-z2-7]{32}$/i.test(hash)) hash = base32ToHex(hash);
  if (!/^[a-f0-9]{40}$/i.test(hash)) return null;
  const trackers = [];
  uri.replace(/[?&]tr=([^&]+)/g, (_, tracker) => {
    try { trackers.push('tracker:' + decodeURIComponent(tracker)); } catch (e) { /* tracker inválido não descarta o magnet */ }
    return '';
  });
  return { infoHash: hash.toLowerCase(), sources: trackers };
}

function base32ToHex(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  s.toUpperCase()
    .split('')
    .forEach((c) => {
      const v = alphabet.indexOf(c);
      if (v >= 0) bits += ('00000' + v.toString(2)).slice(-5);
    });
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.substr(i, 4), 2).toString(16);
  return hex;
}

function torrentUrl(base, infoHash, fileIdx, sources) {
  let u = base + encodeURIComponent(infoHash) + '/' + encodeURIComponent(fileIdx);
  if (sources && sources.length) {
    u += '?' + sources.map((s) => 'tr=' + encodeURIComponent(s)).join('&');
  }
  return u;
}

function createTorrent(base, infoHash, fileIdx, sources, seriesInfo) {
  const hasIdx = fileIdx !== null && fileIdx !== undefined && isFinite(fileIdx);
  if ((!sources || !sources.length) && hasIdx) return Promise.resolve(torrentUrl(base, infoHash, fileIdx, []));
  const body = { torrent: { infoHash: infoHash } };
  if (sources && sources.length) {
    const all = ['dht:' + infoHash].concat(sources.map((s) => (/^(tracker|dht):/.test(s) ? s : 'tracker:' + s)));
    body.peerSearch = { sources: all.filter((s, i) => all.indexOf(s) === i), min: 40, max: 200 };
  }
  if (!hasIdx) {
    body.guessFileIdx = {};
    if (seriesInfo && isFinite(seriesInfo.season)) body.guessFileIdx.season = seriesInfo.season;
    if (seriesInfo && isFinite(seriesInfo.episode)) body.guessFileIdx.episode = seriesInfo.episode;
  } else body.guessFileIdx = false;
  return postJSON(base + encodeURIComponent(infoHash) + '/create', body, { timeout: 30000 }).then((r) =>
    torrentUrl(base, infoHash, hasIdx ? fileIdx : r && r.guessedFileIdx, body.peerSearch ? body.peerSearch.sources : [])
  );
}

function proxyUrl(base, streamUrl, reqHeaders, resHeaders) {
  // Sem new URL(): o do Chromium 38 é incompleto e o polyfill pesa demais.
  const m = streamUrl.match(/^(https?:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?/);
  if (!m) return streamUrl;
  const parts = ['d=' + encodeURIComponent(m[1])];
  Object.keys(reqHeaders || {}).forEach((k) => parts.push('h=' + encodeURIComponent(k + ':' + reqHeaders[k])));
  Object.keys(resHeaders || {}).forEach((k) => parts.push('r=' + encodeURIComponent(k + ':' + resHeaders[k])));
  return base + 'proxy/' + parts.join('&') + (m[2] || '/') + (m[3] || '');
}

// URL passando pelo proxy do servidor com CORS liberado (para APIs que bloqueiam o app).
export function corsProxyUrl(url) {
  const base = isAvailable() ? baseUrl() : '';
  const m = url.match(/^(https?:\/\/[^/?#]+)(.*)$/);
  if (!base || !m) return null;
  return base + 'proxy/d=' + encodeURIComponent(m[1]) + '&r=' + encodeURIComponent('Access-Control-Allow-Origin:*') + (m[2] || '/');
}

// Tenta direto; se a rede/CORS falhar e houver servidor no PC, tenta pelo proxy.
export function getJSONViaProxy(url, opts) {
  return getJSON(url, Object.assign({ quiet: true }, opts)).catch((e) => {
    const p = corsProxyUrl(url);
    if (!p || (e.status && e.status !== 0)) throw e;
    return getJSON(p, Object.assign({ quiet: true }, opts));
  });
}

// Só as fontes que realmente dependem do servidor externo ficam indisponíveis sem ele.
export function needsServer(stream) {
  if (!stream) return false;
  if (isTorrent(stream)) return !nativeEnabled();
  return !!(typeof stream.url === 'string' && stream.behaviorHints && stream.behaviorHints.proxyHeaders);
}

export function isPlayableType(stream) {
  return !!stream && (typeof stream.url === 'string' || typeof stream.infoHash === 'string');
}

// Converte a fonte numa URL e preserva a identidade da sessão local para encerrá-la depois.
export function toPlayable(stream, seriesInfo, options) {
  if (!stream) return Promise.reject(new Error(t('Tipo de link não suportado na TV')));
  const base = baseUrl();
  if (isTorrent(stream)) {
    const mg = typeof stream.url === 'string' ? parseMagnet(stream.url) : { infoHash: stream.infoHash, sources: stream.sources || [] };
    if (!mg || !/^[a-f0-9]{40}$/i.test(mg.infoHash || '')) return Promise.reject(new Error(t('Torrent ou magnet inválido')));
    const hash = mg.infoHash.toLowerCase();
    const index = typeof stream.url === 'string' ? null : stream.fileIdx;
    if (nativeEnabled()) return nativeTorrent(hash, index, mg.sources, seriesInfo, options);
    if (!base) return Promise.reject(new Error(t('Ative o torrent local na beta ou configure um servidor Stremio externo.')));
    return createTorrent(base, hash, index, mg.sources, seriesInfo).then((url) => ({ url: url, viaServer: true, viaNative: false }));
  }
  if (typeof stream.url === 'string') {
    const ph = stream.behaviorHints && stream.behaviorHints.proxyHeaders;
    if (ph) {
      if (!base) return Promise.reject(new Error(t('Esta fonte exige proxy: configure um servidor Stremio externo.')));
      return Promise.resolve({ url: proxyUrl(base, stream.url, ph.request, ph.response), viaServer: true, viaNative: false });
    }
    return Promise.resolve({ url: stream.url, viaServer: false, viaNative: false });
  }
  return Promise.reject(new Error(t('Tipo de link não suportado na TV')));
}

// Faixas embutidas (áudio/legenda) do arquivo, lidas pelo servidor com ffprobe.
export function tracks(mediaUrl) {
  if (isNativeMediaUrl(mediaUrl)) return Promise.resolve(null);
  const base = baseUrl();
  if (!base) return Promise.resolve(null);
  return getJSON(base + 'tracks/' + encodeURIComponent(mediaUrl), { timeout: 20000, quiet: true }).then((list) => {
    const arr = Array.isArray(list) ? list : [];
    return {
      audio: arr.filter((tk) => tk && tk.type === 'audio'),
      subs: arr.filter((tk) => tk && tk.type === 'text'),
    };
  });
}

// Quanto do arquivo do torrent já está no PC (0–1). Links diretos (debrid/HTTP) não têm: null.
export function streamProgress(mediaUrl) {
  if (isNativeMediaUrl(mediaUrl)) return Promise.resolve(null);
  const m = String(mediaUrl || '').match(/\/([a-f0-9]{40})\/(\d+)/i);
  const base = baseUrl();
  if (!m || !base) return Promise.resolve(null);
  return getJSON(base + m[1] + '/' + m[2] + '/stats.json', { timeout: 5000, quiet: true })
    .then((r) => (r && typeof r.streamProgress === 'number' ? r.streamProgress : null))
    .catch(() => null);
}

// Hash OpenSubtitles do arquivo (64 KB do começo e do fim), calculado pelo servidor do PC.
export function opensubHash(mediaUrl) {
  if (isNativeMediaUrl(mediaUrl)) return Promise.resolve(null);
  const base = baseUrl();
  if (!base) return Promise.resolve(null);
  return getJSON(base + 'opensubHash?videoUrl=' + encodeURIComponent(mediaUrl), { timeout: 5000, quiet: true }).then(
    (r) => (r && r.result) || null
  );
}

// Converte legendas externas para VTT pelo servidor (contorna CORS/codificação).
export function subtitlesProxy(subUrl) {
  const base = baseUrl();
  return base ? base + 'subtitles.vtt?from=' + encodeURIComponent(subUrl) : null;
}
