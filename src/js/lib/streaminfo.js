// Lê o texto de uma fonte (nome/título do addon, ex.: Torrentio) e tira o que importa:
// resolução, HDR, Dolby Vision, áudio dublado/original, seeders e tamanho. Também escolhe a
// fonte do "Smart Choice".
import * as server from '../api/server.js';
import * as store from './store.js';

import { parseMetadata, resolution } from './streammetadata.js';
import { durationContext, evaluateLight, compareLight } from './smartlight.js';
import * as formats from './formats.js';
import { playerName } from './avplayer.js';
export { resolution };
export const choiceLabel = 'Smart Choice . Light';

export function parse(s) {
  if (s.__info) return s.__info;
  const info = parseMetadata(s);
  try { Object.defineProperty(s, '__info', { value: info, enumerable: false }); } catch (e) { /* immutable addon object */ }
  return info;
}

export function sizeText(mb) {
  if (!mb) return '';
  return mb >= 1024 ? (mb / 1024).toFixed(mb >= 10240 ? 0 : 1) + ' GB' : Math.round(mb) + ' MB';
}

// Intensidade do sinal (1 a 4 barras) pelo número de seeders.
export function signal(seeders) {
  if (seeders === null || seeders === undefined) return 0;
  if (seeders >= 100) return 4;
  if (seeders >= 20) return 3;
  if (seeders >= 5) return 2;
  return 1;
}

export function signalSvg(level) {
  let bars = '';
  for (let i = 0; i < 4; i++) {
    const hgt = 5 + i * 4;
    bars += '<rect x="' + i * 6 + '" y="' + (20 - hgt) + '" width="4" height="' + hgt + '" rx="1.2" class="' + (i < level ? 'on' : 'off') + '"/>';
  }
  return '<svg class="sig" width="22" height="20" viewBox="0 0 22 20">' + bars + '</svg>';
}

// ---------- Fonte da última vez ----------
// Ao parar no meio e continuar depois, o Smart Choice tenta a mesma fonte (mesmo torrent/arquivo).
// A chave não usa a URL (links de debrid trocam a cada pedido): torrent pelo hash + arquivo,
// o resto pelo addon + nome + primeira linha do título.
function torrentId(s) {
  if (!s || !server.isTorrent(s)) return null;
  let hash = s.infoHash;
  if (!hash && typeof s.url === 'string') {
    const match = /[?&]xt=urn(?::|%3a)btih(?::|%3a)([a-z0-9]+)/i.exec(s.url);
    if (match) hash = match[1];
  }
  hash = String(hash || '').toLowerCase();
  if (/^[a-z2-7]{32}$/.test(hash)) {
    let bits = '';
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    hash.split('').forEach((c) => { bits += ('00000' + alphabet.indexOf(c).toString(2)).slice(-5); });
    hash = '';
    for (let i = 0; i < bits.length; i += 4) hash += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return /^[a-f0-9]{40}$/.test(hash) ? { hash, index: s.fileIdx === undefined || s.fileIdx === null ? '' : String(s.fileIdx) } : null;
}

export function streamKey(s) {
  if (!s) return '';
  const torrent = torrentId(s);
  if (torrent) return 'h:' + torrent.hash + ':' + torrent.index;
  return 'n:' + (s.addon || '') + '|' + String(s.name || '').replace(/\s+/g, ' ') + '|' + String(s.title || s.description || '').split('\n')[0];
}

export function wasTried(s, tried) {
  const id = torrentId(s);
  return (tried || []).some((other) => {
    const otherId = torrentId(other);
    if (id && otherId) return id.hash === otherId.hash && (!id.index || !otherId.index || id.index === otherId.index);
    if (s && other && typeof s.url === 'string' && typeof other.url === 'string') return s.url === other.url;
    return streamKey(s) === streamKey(other);
  });
}

const LAST_KEY = 'lastStream';
export function rememberStream(videoId, s) {
  const key = streamKey(s);
  if (!videoId || !key) return;
  const all = store.get(LAST_KEY, {}) || {};
  all[videoId] = { key: key, at: Date.now() };
  // Guarda só os 300 mais recentes.
  const ids = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  ids.slice(300).forEach((id) => delete all[id]);
  store.set(LAST_KEY, all);
}

export function rememberedStream(videoId, list) {
  const last = (store.get(LAST_KEY, {}) || {})[videoId];
  if (!last) return null;
  return (list || []).filter((s) => streamKey(s) === last.key)[0] || null;
}

export function canPlay(s, serverOk) {
  return server.isPlayableType(s) && (!server.needsServer(s) || serverOk);
}

// Falhas ficam somente nesta sessão, por dez minutos e com retenção limitada.
const failures = [];
function recentFailures(context) {
  const now = Date.now();
  for (let i = failures.length - 1; i >= 0; i--) if (failures[i].until <= now) failures.splice(i, 1);
  return failures.filter((entry) => !entry.videoId || entry.videoId === (context && context.videoId)).map((entry) => entry.stream);
}

export function markFailed(stream, context) {
  failures.push({ stream: { infoHash: stream.infoHash, fileIdx: stream.fileIdx, url: stream.url, name: stream.name, addon: stream.addon, title: stream.title }, videoId: context && context.videoId || '', until: Date.now() + 10 * 60000 });
  if (failures.length > 64) failures.shift();
}

export function choiceContext(meta, video, isSeries) {
  return Object.assign(durationContext(meta, video, isSeries), { audioLangs: store.settings().audioLangs || [] });
}

// Uma mesma política atende início, continuação, troca automática e próximo episódio.
export function smartPick(list, serverOk, context) {
  const ctx = context || choiceContext(null, null, false);
  const previous = ctx.videoId ? rememberedStream(ctx.videoId, list) : null;
  const failed = recentFailures(ctx);
  const player = playerName();
  const candidates = [];
  (list || []).forEach((stream) => {
    if (!stream || !canPlay(stream, serverOk) || wasTried(stream, failed)) return;
    if (server.isTorrent(stream) && !torrentId(stream)) return;
    let rank = evaluateLight(parse(stream), ctx, server.isTorrent(stream));
    // O que esta TV já mostrou não tocar fica para a escolha manual; o que já tocou ganha confiança.
    const learned = rank ? formats.verdict(stream, player) : '';
    if (learned === 'bad') rank = null;
    else if (learned === 'ok') rank = Object.assign({}, rank, { compatibility: rank.compatibility + 2 });
    if (rank) candidates.push({ stream, rank, key: streamKey(stream) + (server.isTorrent(stream) ? '' : '|' + (stream.url || '')), previous: previous && streamKey(stream) === streamKey(previous) });
  });
  candidates.sort(compareLight);
  const best = candidates[0];
  return best ? { stream: best.stream, ideal: best.rank.ideal, rank: best.rank } : null;
}

// Os metadados reais chegam antes de entregar a URL ao player; pacotes não burlam o teto por arquivo.
export function lightFileError(stream, file, context) {
  const original = parse(stream);
  const actual = parseMetadata({ title: file.name || original.file, behaviorHints: { filename: file.name || original.file, videoSize: file.length } });
  const merged = Object.assign({}, original, actual, {
    res: actual.res || original.res,
    videoCodec: actual.videoCodec === 'unknown' ? original.videoCodec : actual.videoCodec,
    audioCodecs: actual.audioCodecs.length ? actual.audioCodecs : original.audioCodecs,
    dv: actual.dv || original.dv, hdr: actual.hdr || original.hdr, remux: actual.remux || original.remux,
    seeders: original.seeders,
  });
  return evaluateLight(merged, context || choiceContext(null, null, false), server.isTorrent(stream))
    ? '' : choiceLabel + ': este arquivo excede o perfil automático de resolução, formato ou tamanho. Tente outra fonte ou escolha manualmente.';
}

export function summary(info) {
  return [info.res, info.dv ? 'Dolby Vision' : info.hdr ? 'HDR' : '', info.dub ? (info.original ? 'Original + Dublado' : 'Dublado') : '', info.seeders !== null ? info.seeders + ' seeders' : '']
    .filter(Boolean)
    .join(' · ');
}
