// Formatos aprendidos nesta TV, por player (AVPlay e o proprietário decodificam diferente).
// Uma falha de formato (não de rede) recai só sobre o que ainda não se provou: perfil de vídeo,
// áudio e contêiner. Algo vira "não funciona" depois de falhar com dois arquivos diferentes, ao menos
// uma vez como o único suspeito; tudo numa fonte vira "funciona" quando ela toca por alguns segundos.
// Assim um 4K HEVC que não abre não condena o HEVC 1080p.
import * as store from './store.js';
import { parseMetadata } from './streammetadata.js';
import { t } from './i18n.js';

const KEY = 'formats';
const MAX_FILES = 4;
const MAX_ENTRIES = 60;

function readAll() {
  const all = store.getDevice(KEY, {});
  return all && typeof all === 'object' ? all : {};
}

function container(info) {
  const m = /\.(mkv|mp4|m4v|avi|ts|webm|mov)\b/i.exec(info.file || '');
  return m ? m[1].toLowerCase().replace('m4v', 'mp4') : '';
}

// Rótulos do que a fonte diz ter. Sem codec conhecido, não há o que aprender sobre o vídeo.
export function features(stream) {
  const info = stream && (stream.__info || parseMetadata(stream));
  if (!info) return [];
  const out = [];
  if (info.videoCodec && info.videoCodec !== 'unknown') {
    out.push('v:' + info.videoCodec + (info.avcHigh10 ? '-10bit' : '') + (info.res === '4K' ? '-4k' : '') + (info.dv ? '-dv' : info.hdr ? '-hdr' : ''));
  }
  (info.audioCodecs || []).forEach((codec) => out.push('a:' + codec));
  const c = container(info);
  if (c) out.push('c:' + c);
  return out.filter((x, i) => out.indexOf(x) === i);
}

function fileKey(stream) {
  const info = stream && (stream.__info || parseMetadata(stream));
  return String(stream.infoHash ? stream.infoHash + ':' + (stream.fileIdx === undefined ? '' : stream.fileIdx) : info && info.file || stream.url || '').slice(0, 160);
}

function trim(table) {
  const keys = Object.keys(table);
  if (keys.length <= MAX_ENTRIES) return;
  keys.sort((a, b) => (table[a].at || 0) - (table[b].at || 0));
  keys.slice(0, keys.length - MAX_ENTRIES).forEach((k) => delete table[k]);
}

// ok: tocou de verdade. Falha só conta quando o player disse que é formato/decodificação.
export function report(stream, player, ok) {
  const list = features(stream);
  if (!list.length || !player) return null;
  const all = readAll();
  const table = all[player] || (all[player] = {});
  const now = Date.now();
  let suspects = [];
  if (ok) {
    list.forEach((f) => { table[f] = { s: 'ok', at: now }; });
  } else {
    suspects = list.filter((f) => !table[f] || table[f].s !== 'ok');
    const file = fileKey(stream);
    suspects.forEach((f) => {
      const entry = table[f] && table[f].s !== 'ok' ? table[f] : { s: 'suspect', files: [], solo: false };
      entry.files = (entry.files || []).filter((x) => x !== file).concat(file).slice(-MAX_FILES);
      if (suspects.length === 1) entry.solo = true;
      entry.at = now;
      if (entry.files.length >= 2 && entry.solo) entry.s = 'bad';
      table[f] = entry;
    });
  }
  trim(table);
  store.setDevice(KEY, all);
  return suspects;
}

export function status(player, feature) {
  const table = readAll()[player] || {};
  return table[feature] ? table[feature].s : '';
}

// 'bad' se algo da fonte já falhou de vez neste player; 'ok' se tudo já tocou; '' sem histórico.
export function verdict(stream, player) {
  const list = features(stream);
  if (!list.length) return '';
  const table = readAll()[player] || {};
  if (list.some((f) => table[f] && table[f].s === 'bad')) return 'bad';
  return list.every((f) => table[f] && table[f].s === 'ok') ? 'ok' : '';
}

export function list(player) {
  const table = readAll()[player] || {};
  return Object.keys(table).map((f) => ({ feature: f, status: table[f].s, files: (table[f].files || []).length, at: table[f].at || 0 }))
    .sort((a, b) => b.at - a.at);
}

// Volta um formato para "sem histórico" (ou todos, sem feature).
export function forget(player, feature) {
  const all = readAll();
  if (!all[player]) return;
  if (feature) delete all[player][feature];
  else delete all[player];
  store.setDevice(KEY, all);
}

const NAMES = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', aac: 'AAC', ac3: 'AC3', eac3: 'E-AC3', mp3: 'MP3', dts: 'DTS', truehd: 'TrueHD', flac: 'FLAC' };
export function label(feature) {
  const parts = String(feature).split(':');
  const kind = parts[0];
  const value = parts.slice(1).join(':').split('-');
  const name = NAMES[value[0]] || value[0].toUpperCase();
  const extra = value.slice(1).map((x) => ({ '10bit': '10-bit', '4k': '4K', dv: 'Dolby Vision', hdr: 'HDR' })[x] || x);
  return t(kind === 'v' ? 'Vídeo' : kind === 'a' ? 'Áudio' : 'Arquivo') + ' ' + [name].concat(extra).join(' ');
}
