// Normalização dos indícios publicados pelos addons. Não mede peers nem garante codecs.
const FLAG_RE = /\uD83C[\uDDE6-\uDDFF]\uD83C[\uDDE6-\uDDFF]/g;
const ICONS_RE = /[☀-➿️]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD00-\uDFFF]/g;
const MIB = 1024 * 1024;

function number(value) {
  if (typeof value === 'number') return isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const result = Number(text);
  return isFinite(result) ? result : null;
}

function seedCount(value) {
  if (typeof value === 'number') return isFinite(value) && value >= 0 && Math.floor(value) === value && value <= Number.MAX_SAFE_INTEGER ? value : null;
  if (typeof value !== 'string') return null;
  let text = value.trim();
  const suffix = /\s*([km])$/i.exec(text);
  if (suffix) {
    text = text.slice(0, suffix.index).trim();
    if (!/^\d+(?:[.,]\d+)?$/.test(text)) return null;
    const count = Number(text.replace(',', '.')) * (suffix[1].toLowerCase() === 'k' ? 1000 : 1000000);
    return isFinite(count) && count <= Number.MAX_SAFE_INTEGER ? Math.round(count) : null;
  }
  if (/^\d{1,3}(?:,\d{3})+$/.test(text) || /^\d{1,3}(?:\.\d{3})+$/.test(text)) text = text.replace(/[.,]/g, '');
  if (!/^\d+$/.test(text)) return null;
  const count = Number(text);
  return isFinite(count) && count <= Number.MAX_SAFE_INTEGER ? count : null;
}

function seeds(stream, hints, text) {
  const structured = [stream.seeders, hints.seeders];
  for (let i = 0; i < structured.length; i++) {
    const count = seedCount(structured[i]);
    if (count !== null) return count;
  }
  // 👥 e "peers" podem incluir leechers: não os convertemos em seeds.
  const pattern = /(?:👤|\bseed(?:er)?s?\b\s*[:=]?|\bS\s*:)\s*([-+]?\d[\d.,]*(?:\s*[km])?)(?![\d.,a-z])/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const count = seedCount(match[1]);
    if (count !== null) return count;
  }
  return null;
}

function decimal(text, unit) {
  // GB/TB de filmes frequentemente têm três casas decimais, não milhares.
  if (/^[GT]/i.test(unit) && /^\d+[.,]\d+$/.test(text)) return Number(text.replace(',', '.'));
  // Um ponto/vírgula seguido por 1–2 dígitos é decimal; grupos de 3 podem ser milhares.
  if (/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(text)) {
    const last = /[.,](\d{1,2})$/.exec(text);
    if (last) return Number(text.slice(0, last.index).replace(/[.,]/g, '') + '.' + last[1]);
    return Number(text.replace(/[.,]/g, ''));
  }
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) return null;
  return Number(text.replace(',', '.'));
}

function size(text) {
  const pattern = /(?:^|[^\d.,-])(\d[\d.,]*)\s*(TB|TiB|GB|GiB|MB|MiB)\b/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const amount = decimal(match[1], match[2]);
    if (amount === null || !isFinite(amount) || amount <= 0) continue;
    const unit = match[2].toLowerCase();
    const multiplier = { tb: 1e12 / MIB, tib: 1024 * 1024, gb: 1e9 / MIB, gib: 1024, mb: 1e6 / MIB, mib: 1 }[unit];
    const result = amount * multiplier;
    return isFinite(result) ? result : 0;
  }
  return 0;
}

function lowQuality(text) {
  return /\b(?:hdcam|camrip|hdts|tsrip|telesync|telecine)\b|[[(]\s*(?:CAM|TS)\s*[\])]|\b(?:CAM|TS)\b(?=[ ._-]+(?:x26[45]|h[ .]?26[45]|aac|ac3|multi|dub|pt)\b)/i.test(text);
}

export function resolution(text) {
  const value = String(text || '').replace(/_/g, ' ');
  if (/2160p|\b4k\b|\buhd\b/i.test(value)) return '4K';
  if (/1080p|\bfhd\b|\b1080\b/i.test(value)) return '1080p';
  if (/720p|\bhd\b/i.test(value)) return '720p';
  if (/480p|\bsd\b|\bdvdrip\b/i.test(value) || lowQuality(value)) return 'SD';
  return '';
}

function videoCodec(text) {
  text = String(text || '').replace(/_/g, ' ');
  const found = [];
  if (/\b(?:x264|h[ ._-]?264|avc1?)\b/i.test(text)) found.push('h264');
  if (/\b(?:x265|h[ ._-]?265|hevc)\b/i.test(text)) found.push('hevc');
  if (/\bav1\b/i.test(text)) found.push('av1');
  if (/\bvp9\b/i.test(text)) found.push('vp9');
  return found.length === 1 ? found[0] : 'unknown';
}

function audioCodecs(text) {
  text = String(text || '').replace(/_/g, ' ');
  const list = [];
  const withoutEac3 = text.replace(/\be[ ._-]?ac[ ._-]?3\b|\bddp(?=\b|\d)|\bdd\+|dolby[ ._-]+digital[ ._-]+plus/gi, ' ');
  if (/\b(?:aac|he[ ._-]?aac)\b/i.test(text)) list.push('aac');
  if (/\b(?:e[ ._-]?ac[ ._-]?3|ddp)(?=\b|\d)|\bdd\+|dolby[ ._-]+digital[ ._-]+plus/i.test(text)) list.push('eac3');
  if (/\bac[ ._-]?3\b|\bdd(?=\d)|\bdd\b(?!\+)|dolby[ ._-]+digital\b(?![ ._-]+plus)/i.test(withoutEac3)) list.push('ac3');
  if (/\bmp3\b/i.test(text)) list.push('mp3');
  if (/\bdts(?:[ ._-]?hd)?\b/i.test(text)) list.push('dts');
  if (/\btrue[ ._-]?hd\b/i.test(text)) list.push('truehd');
  if (/\bflac\b/i.test(text)) list.push('flac');
  return list;
}

function packed(text) {
  return /\b(?:season[ ._-]*pack|complete|complet[ao]|pack[ ._-]?size|box[ ._-]?set|batch)\b|(?:^|[^a-z0-9])s\d{1,2}(?![ ._-]*e\d|\d)|\b(?:season|temporada)[ ._-]+\d+\b(?![ ._-]*(?:episode|epis[oó]dio|ep|e)[ ._-]*\d+)/i.test(text);
}

export function parseMetadata(input) {
  const stream = input || {};
  const hints = stream.behaviorHints || {};
  const name = String(stream.name || stream.addon || '');
  const title = String(stream.title || stream.description || '');
  const filename = String(hints.filename || stream.filename || '');
  const text = (name + '\n' + title + '\n' + filename).replace(/_/g, ' ');
  const flags = text.match(FLAG_RE) || [];
  const dub = flags.indexOf('🇧🇷') >= 0 || flags.indexOf('🇵🇹') >= 0 ||
    /dublad[oa]|\bdub(?:lagem)?[ ._-]?(?:pt|br)\b|\bpt[ ._-]?br\b|\bnacional\b|portugu[eê]s|\bdual\b[^\n]*\b(?:pt|br|por)\b|\b(?:pt|br|por)\b[^\n]*\bdual\b/i.test(text);
  let sizeMb = 0;
  let sizeScope = 'unknown';
  const sizes = [hints.videoSize, stream.videoSize];
  for (let i = 0; i < sizes.length; i++) {
    const bytes = number(sizes[i]);
    if (bytes !== null && bytes > 0) { sizeMb = bytes / MIB; sizeScope = 'file'; break; }
  }
  if (!sizeMb) {
    const packBytes = number(hints.packSize === undefined ? stream.packSize : hints.packSize);
    sizeMb = packBytes !== null && packBytes > 0 ? packBytes / MIB : size(text);
    sizeScope = sizeMb ? (packed(text) || (packBytes !== null && packBytes > 0) ? 'pack' : 'file') : 'unknown';
  }
  const fromFilename = videoCodec(filename);
  const fileAudio = audioCodecs(filename);
  const selectedFile = filename || title.split('\n')[0];
  const cam = lowQuality(text);
  const codec = fromFilename !== 'unknown' ? fromFilename : videoCodec(text);
  return {
    res: resolution(filename) || resolution(text),
    dv: /dolby[ ._-]?vision|\bdovi\b|\bdv\b/i.test(text),
    hdr: /hdr/i.test(text),
    remux: /remux/i.test(text),
    dub,
    original: !dub || /\bdual\b|\bmulti\b|dual.?[aá]udio/i.test(text) || flags.some((flag) => flag !== '🇧🇷' && flag !== '🇵🇹'),
    seeders: seeds(stream, hints, text),
    sizeMb,
    sizeScope,
    cached: /\[[A-Z]{2,3}\+\]|\binstant\b|⚡/i.test(name),
    // Fonte de debrid ([RD+], [RD download], [AD]...). Sem o "+" ainda não está no debrid: abrir só
    // manda baixar, e o vídeo não toca na hora.
    debrid: /\[(?:RD|AD|PM|DL|DLX|TB|ED|OC)[+\] ]/.test(name),
    addon: name.split('\n')[0].replace(/\[[A-Z]{2,3}\+?\]/g, '').trim(),
    file: (filename || title.split('\n')[0]).replace(ICONS_RE, '').replace(FLAG_RE, '').replace(/\s{2,}/g, ' ').trim(),
    videoCodec: codec,
    avcHigh10: codec === 'h264' && /\b(?:hi10p|high[ ._-]?10|10[ ._-]?bit)\b/i.test(text),
    audioCodecs: fileAudio.length ? fileAudio : audioCodecs(text),
    lowQuality: cam,
    cam,
    sample: sizeMb > 0 && sizeMb < 350 && /(?:^|[ ._-])sample(?:[ ._-]|$)/i.test(selectedFile),
  };
}
