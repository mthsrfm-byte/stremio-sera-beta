// Política conservadora e determinística. Seeds e etiquetas vêm dos addons, não de uma sondagem.
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const SAFE_AUDIO = ['aac', 'ac3', 'eac3', 'mp3'];

function minutes(value) {
  if (typeof value === 'number') return value > 0 && value <= 480 ? value : 0;
  const text = String(value || '').trim();
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) + Number(clock[3] || 0) / 60;
  const h = /(\d+(?:[.,]\d+)?)\s*h/i.exec(text);
  const m = /(\d+(?:[.,]\d+)?)\s*(?:min|m\b)/i.exec(text);
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(text);
  if (iso) return Number(iso[1] || 0) * 60 + Number(iso[2] || 0);
  if (h || m) return (h ? Number(h[1].replace(',', '.')) * 60 : 0) + (m ? Number(m[1].replace(',', '.')) : 0);
  return /^\d+(?:[.,]\d+)?$/.test(text) ? Number(text.replace(',', '.')) : 0;
}

export function durationContext(meta, video, isSeries) {
  const sources = [video && video.runtime, meta && meta.runtime];
  let duration = 0;
  for (let i = 0; i < sources.length; i++) {
    const parsed = minutes(sources[i]);
    if (parsed > 0 && parsed <= 480) { duration = parsed; break; }
  }
  return { runtimeMinutes: duration || (isSeries ? 45 : 110), runtimeEstimated: !duration, isSeries: !!isSeries, videoId: video && video.id || meta && meta.id || '' };
}

export function fileBudget(info, context) {
  const ctx = context || {};
  const seconds = (ctx.runtimeMinutes || (ctx.isSeries ? 45 : 110)) * 60;
  const capMbps = info.res === '720p' ? 7 : info.res === 'SD' ? 4 : 12;
  // Sem duração informada, usar limites conservadores de arquivo, sem inventar bitrate exato.
  return ctx.runtimeEstimated !== false
    ? Math.min(capMbps * 1e6 * seconds / 8, ctx.isSeries ? 2 * GIB : 8 * GIB)
    : capMbps * 1e6 * seconds / 8;
}

export function evaluateLight(info, context, torrent) {
  const ctx = context || {};
  const audio = info.audioCodecs || [];
  const safeAudio = audio.some((c) => SAFE_AUDIO.indexOf(c) >= 0);
  if (info.res === '4K' || info.dv || info.remux || info.cam || info.sample || info.avcHigh10) return null;
  // Apenas o automático evita formatos ainda não confiáveis neste player. A escolha manual continua livre.
  if (info.videoCodec === 'av1' || info.videoCodec === 'vp9') return null;
  if (audio.length && !safeAudio) return null;
  if (torrent && info.seeders === 0) return null;

  const size = info.sizeScope === 'file' && info.sizeMb > 0 ? info.sizeMb * MIB : 0;
  if (size && size > fileBudget(info, ctx)) return null;
  const duration = ctx.runtimeMinutes || (ctx.isSeries ? 45 : 110);
  const mbps = size ? size * 8 / (duration * 60 * 1e6) : null;
  const comfortable = info.res === '720p' ? 4 : info.res === 'SD' ? 2 : 8;
  // Link direto é saudável, menos debrid fora do cache ([RD download]): esse ainda vai baixar.
  const health = !torrent ? (info.debrid && !info.cached ? 3 : 0) : info.seeders === null || info.seeders === undefined ? 2 : info.seeders >= 20 ? 0 : info.seeders >= 5 ? 1 : 3;
  const load = !size ? 1 : mbps > comfortable ? 2 : ctx.runtimeEstimated !== false ? 1 : 0;
  const mixedAudio = safeAudio && audio.some((c) => SAFE_AUDIO.indexOf(c) < 0);
  const risk = health + load + (mixedAudio ? 1 : 0);
  let quality = info.res === '1080p' ? 30 : info.res === '720p' ? 20 : info.res === 'SD' ? 5 : 10;
  // Arquivo minúsculo não vence automaticamente um encode moderado por ter etiqueta 1080p.
  if (mbps !== null && ctx.runtimeEstimated === false && ((info.res === '1080p' && mbps < 1) || (info.res === '720p' && mbps < 0.5))) quality -= 16;
  const compatibility = (info.videoCodec === 'h264' || info.videoCodec === 'hevc' ? 2 : 0) + (safeAudio && !mixedAudio ? 1 : 0) + (!info.hdr ? 1 : 0);
  const seeds = torrent && info.seeders !== null ? Math.min(info.seeders, 100) : 0;
  const seedBand = seeds >= 100 ? 3 : seeds >= 40 ? 2 : seeds >= 20 ? 1 : 0;
  const preferred = ctx.audioLangs || [];
  const wantsPortuguese = preferred.some((code) => /^(por|pob|pt|pt-br)$/i.test(code));
  const language = wantsPortuguese ? (info.dub ? 2 : 0) : (info.original ? 1 : 0);
  const cached = info.cached ? 1 : 0;
  return { risk, health, load, quality, compatibility, seedBand, language, mbps, cached,
    ideal: info.res === '1080p' && health === 0 && load === 0 && !mixedAudio };
}

export function compareLight(a, b) {
  // Com o mesmo risco, debrid em cache ([RD+]) vem antes: abre na hora, sem depender de seeders.
  return a.rank.risk - b.rank.risk || (b.rank.cached || 0) - (a.rank.cached || 0) || b.rank.quality - a.rank.quality ||
    b.rank.compatibility - a.rank.compatibility || b.rank.seedBand - a.rank.seedBand ||
    b.rank.language - a.rank.language || Number(b.previous) - Number(a.previous) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
