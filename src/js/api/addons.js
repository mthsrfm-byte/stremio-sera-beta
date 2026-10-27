// Protocolo de addons do Stremio: catálogos, metadados, streams e legendas via HTTP/JSON.
import { cachedJSON, getJSON } from '../lib/http.js';
import * as stremio from './stremio.js';
import * as store from '../lib/store.js';
import { log } from '../lib/log.js';
import { t } from '../lib/i18n.js';
import { startPinnedService } from './tizenbrew.js';
import { IS_WEB } from '../lib/platform.js';

export const CINEMETA = 'https://v3-cinemeta.strem.io/manifest.json';
export const OPENSUBTITLES = 'https://opensubtitles-v3.strem.io/manifest.json';

let addons = null; // [{ transportUrl, manifest, base }]
const listeners = [];

// Avisa quando a lista de addons muda (ex.: a da conta chegou depois do cache).
// Devolve a função que cancela o aviso.
export function onChange(fn) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function changed(list) {
  addons = list;
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      /* ignore */
    }
  });
  return list;
}

function normalize(list) {
  return (list || [])
    .filter((a) => a && a.transportUrl && a.manifest)
    .filter((a) => /^https?:/.test(a.transportUrl))
    .map((a) => ({
      transportUrl: a.transportUrl,
      manifest: a.manifest,
      base: a.transportUrl.replace(/\/manifest\.json(\?.*)?$/, ''),
      query: (a.transportUrl.match(/\/manifest\.json(\?.*)$/) || [])[1] || '',
    }));
}

function defaultAddons() {
  const urls = [CINEMETA, OPENSUBTITLES].concat(store.settings().localAddons || []);
  return Promise.all(
    urls.map((u) =>
      getJSON(u)
        .then((m) => ({ transportUrl: u, manifest: m }))
        .catch(() => null)
    )
  ).then((list) => list.filter(Boolean));
}

// Addons que o serviço do Seraflix na TV serve (XVideos e Pornhub pedidos pela própria TV).
// Entram sozinhos quando o serviço responde; fora da TV (PC, testes) simplesmente não aparecem.
// Porta própria dos addons (8095): versões antigas do serviço que o TizenBrew ainda tenha rodando
// (ele só as desliga quando a TV reinicia) ficam nas portas velhas e não atrapalham.
// SERVICE_MIN: versão do serviço que este app espera (o /api/version dele); mais velha, pede a nova.
const TUBES = ['xv', 'ph'];
const TUBE_PORT = 8095;
const SERVICE_MIN = 12;
let tubes = null; // null: ainda procurando; [] ou lista: já respondeu
let tubeTries = 0;
// 'searching' | 'ok' | 'old' (serviço antigo, sem os addons) | 'off' (serviço não responde)
let tubeState = 'searching';

export function tubeStatus() {
  return tubeState;
}

// Fonte de um dos addons do serviço da TV (XVideos/Pornhub): cada vídeo vem com opções de
// reserva (direto e pelo serviço), e o player tenta a próxima sozinho quando uma não abre.
export function isTubeStream(s) {
  return !!(s && tubes && tubes.some((a) => a.manifest && a.manifest.name === s.addon));
}

function withTubes(list) {
  if (!tubes || !tubes.length) return list;
  return list.concat(tubes.filter((t) => !list.some((a) => a.transportUrl === t.transportUrl)));
}

function fetchTube(name) {
  const u = 'http://127.0.0.1:' + TUBE_PORT + '/' + name + '/manifest.json';
  return getJSON(u, { timeout: 3000, quiet: true }).then(
    (m) => (m && m.id ? { transportUrl: u, manifest: m } : null),
    () => null
  );
}

function serviceVersion() {
  return getJSON('http://127.0.0.1:' + TUBE_PORT + '/api/version', { timeout: 3000, quiet: true }).then(
    (v) => (v && v.version) || 0,
    () => 0
  );
}

// O serviço da TV pode ligar depois do app (TizenBrew): procura de novo a cada poucos segundos,
// e mais devagar depois, para a aba NSFW aparecer sem precisar recarregar o app.
let tubeTimer = null;
function attachTubes() {
  if (IS_WEB) return; // os addons NSFW vêm do serviço da TV (127.0.0.1); no navegador não existe
  if ((tubes && tubes.length) || tubeTimer) return;
  tubeTimer = true; // uma procura por vez
  Promise.all([serviceVersion()].concat(TUBES.map(fetchTube))).then((list) => {
    const version = list.shift();
    // Serviço mais velho que o app espera: não usa (os vídeos não tocariam) e pede o novo.
    const found = version >= SERVICE_MIN ? normalize(list.filter(Boolean)) : [];
    tubeTries++;
    tubeTimer = null;
    if (found.length) {
      tubes = found;
      tubeState = 'ok';
      if (addons) changed(withTubes(addons));
      return;
    }
    tubes = [];
    // O serviço responde mas não tem os addons: é a versão antiga ainda rodando.
    const before = tubeState;
    const anyOld = version > 0 || list.some(Boolean);
    getJSON('http://127.0.0.1:8094/api/ip', { timeout: 3000, quiet: true })
      .then(
        () => (tubeState = 'old'),
        () => (tubeState = anyOld ? 'old' : 'off')
      )
      .then(() => {
        // Serviço velho (cache do CDN) ou parado: pede ao TizenBrew a versão exata do GitHub.
        if (tubeState === 'old' || tubeTries >= 3) startPinnedService();
      })
      .then(() => tubeState !== before && addons && changed(addons));
    tubeTimer = setTimeout(() => {
      tubeTimer = null;
      attachTubes();
    }, tubeTries < 20 ? 4000 : 30000);
  });
}

export function load(force) {
  attachTubes();
  if (addons && !force) return Promise.resolve(addons);
  if (stremio.isLoggedIn()) {
    const cached = stremio.cachedAddons();
    const fresh = stremio.getAddonCollection().then((list) => changed(withTubes(normalize(list))));
    if (cached && cached.length && !force) {
      addons = withTubes(normalize(cached));
      fresh.catch((e) => log.warn('Addons: usando cache', e.message));
      return Promise.resolve(addons);
    }
    return fresh.catch(() => {
      addons = withTubes(normalize(cached || []));
      return addons;
    });
  }
  return defaultAddons().then((list) => changed(withTubes(normalize(list))));
}

export function list() {
  return addons || [];
}

function resourceMatch(addon, resource, type, id) {
  const m = addon.manifest;
  const resources = m.resources || [];
  for (let i = 0; i < resources.length; i++) {
    const r = resources[i];
    const name = typeof r === 'string' ? r : r.name;
    if (name !== resource) continue;
    const types = (typeof r === 'object' && r.types) || m.types || [];
    if (type && types.length && types.indexOf(type) < 0) continue;
    const prefixes = (typeof r === 'object' && r.idPrefixes) || m.idPrefixes;
    if (id && prefixes && prefixes.length && !prefixes.some((p) => id.indexOf(p) === 0)) continue;
    return true;
  }
  return false;
}

export function withResource(resource, type, id) {
  return list().filter((a) => resourceMatch(a, resource, type, id));
}

function url(addon, resource, type, id, extra) {
  let path = '/' + resource + '/' + encodeURIComponent(type) + '/' + encodeURIComponent(id);
  if (extra) {
    const parts = Object.keys(extra)
      .filter((k) => extra[k] !== undefined && extra[k] !== null && extra[k] !== '')
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(extra[k]));
    if (parts.length) path += '/' + parts.join('&');
  }
  return addon.base + path + '.json' + addon.query;
}

// ---------- Conteúdo adulto (aba NSFW) ----------
// Addon adulto: o próprio manifest diz (behaviorHints.adult), o nome/descrição entrega, ou a
// pessoa marcou à mão em Ajustes. O conteúdo dele só aparece na aba NSFW.
const ADULT_RE = /porn|xxx|nsfw|hentai|onlyfans|\badult[oa]?s?\b|\b18\+|erotic|er[oó]tic|\bsex[oy]?\b|brazzers|xvideos|xhamster|redtube|youporn|spankbang|eporner|chaturbate/i;
// Categorias que só catálogo adulto tem: duas ou mais delas entregam o addon.
const ADULT_GENRES = /^(anal|blowjob|milf|creampie|cumshot|gangbang|threesome|squirt|deepthroat|handjob|big tits|big ass|bbw|pov|bdsm|fisting|hardcore|interracial|lesbian|masturbation|orgy|pornstar|stepmom|step mom|teen \(18\+\)|cuckold)$/i;

function adultGenres(m) {
  let n = 0;
  (m.catalogs || []).forEach((c) =>
    (c.extra || []).forEach((e) => {
      if (e.name === 'genre') (e.options || []).forEach((o) => ADULT_GENRES.test(String(o).trim()) && n++);
    })
  );
  return n >= 2;
}

export function adultByManifest(addon) {
  const m = addon.manifest || {};
  if (m.behaviorHints && m.behaviorHints.adult) return true;
  // A descrição só conta com termos inequívocos: addons de anime citam "NSFW"/"hentai" como opção.
  return ADULT_RE.test([m.id, m.name].join(' ')) || /porn|xxx/i.test(m.description || '') || adultGenres(m);
}

export function isAdult(addon) {
  const s = store.settings();
  const id = addon.manifest && addon.manifest.id;
  if ((s.sfwAddons || []).indexOf(id) >= 0) return false;
  return (s.nsfwAddons || []).indexOf(id) >= 0 || adultByManifest(addon);
}

// Ordem na aba NSFW: Pornhub e XVideos (os do serviço da TV) primeiro, depois os outros na ordem da conta.
const ADULT_FIRST = ['seraflix.pornhub', 'seraflix.xvideos'];
export function adultAddons() {
  const rank = (a) => {
    const i = ADULT_FIRST.indexOf(a.manifest && a.manifest.id);
    return i < 0 ? ADULT_FIRST.length : i;
  };
  return list()
    .filter(isAdult)
    .map((a, i) => ({ a: a, i: i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map((x) => x.a);
}

// Aba NSFW fica sempre disponível; só some se o perfil desativar em Ajustes. No navegador não
// existe: os addons adultos vêm do serviço da TV.
export function nsfwEnabled() {
  return !IS_WEB && store.settings().nsfwTab !== false;
}

// Prefixos de id dos addons adultos ("tt" do IMDb fica de fora: é de filme comum).
function adultPrefixes() {
  const out = [];
  adultAddons().forEach((a) => {
    const m = a.manifest;
    const lists = [m.idPrefixes || []].concat((m.resources || []).map((r) => (typeof r === 'object' && r.idPrefixes) || []));
    lists.forEach((l) => l.forEach((p) => p && p !== 'tt' && out.indexOf(p) < 0 && out.push(p)));
  });
  return out;
}

// Ids abertos pela aba NSFW: cobre addon adulto sem idPrefixes (o id não diz de onde veio).
let adultIds = null;
function seenIds() {
  if (!adultIds) adultIds = store.get('nsfwIds', []) || [];
  return adultIds;
}

export function markAdult(id) {
  const list = seenIds();
  if (!id || list.indexOf(id) >= 0) return;
  list.push(id);
  if (list.length > 2000) list.splice(0, list.length - 2000);
  store.set('nsfwIds', list);
}

// Item (biblioteca, continuar assistindo) que veio de um addon adulto.
export function isAdultId(id) {
  const s = String(id || '');
  return seenIds().indexOf(s) >= 0 || adultPrefixes().some((p) => s.indexOf(p) === 0);
}

// Catálogos de um addon adulto, separados em fileiras (sem extra obrigatório) e busca.
export function adultCatalogs(addon) {
  return (addon.manifest.catalogs || []).map((cat) => ({ addon: addon, catalog: cat }));
}

export function isBoardable(cat) {
  const extras = cat.extra || [];
  return !(extras.some((e) => e.isRequired) || (cat.extraRequired && cat.extraRequired.length));
}

export function supportsSearch(cat) {
  return (cat.extra || []).some((e) => e.name === 'search') || (cat.extraSupported || []).indexOf('search') >= 0;
}

// Gêneros/categorias que o catálogo aceita como filtro (extra "genre" com opções).
export function genreOptions(cat) {
  const g = (cat.extra || []).filter((e) => e.name === 'genre')[0];
  return (g && g.options) || cat.genres || [];
}

// Catálogos que aparecem na tela inicial (sem "extra" obrigatório), como no Stremio.
export function boardCatalogs() {
  const out = [];
  list().forEach((addon) => {
    if (isAdult(addon)) return;
    (addon.manifest.catalogs || []).forEach((cat) => {
      const extras = cat.extra || [];
      const required = extras.some((e) => e.isRequired) || (cat.extraRequired && cat.extraRequired.length);
      if (required) return;
      // Fora da tela inicial: canais (YouTube etc.), TV e filmes de domínio público.
      const label = (addon.manifest.name || '') + ' ' + (cat.name || '') + ' ' + (cat.id || '');
      if (cat.type === 'channel' || cat.type === 'tv' || /youtube|public ?domain/i.test(label)) return;
      out.push({ addon: addon, catalog: cat });
    });
  });
  return out;
}

export function searchCatalogs() {
  const out = [];
  list().forEach((addon) => {
    if (isAdult(addon)) return;
    (addon.manifest.catalogs || []).forEach((cat) => {
      const extras = cat.extra || [];
      const supports = extras.some((e) => e.name === 'search') || (cat.extraSupported || []).indexOf('search') >= 0;
      if (supports) out.push({ addon: addon, catalog: cat });
    });
  });
  return out;
}

export function catalogTitle(entry) {
  const typeName = { movie: t('Filmes'), series: t('Séries'), anime: t('Animes'), channel: t('Canais'), tv: 'TV' }[entry.catalog.type] || entry.catalog.type;
  const name = entry.catalog.name || entry.catalog.id;
  return name + ' · ' + typeName;
}

export function fetchCatalog(entry, extra) {
  // Timeout menor: addon lento não segura a fila de fileiras.
  return cachedJSON(url(entry.addon, 'catalog', entry.catalog.type, entry.catalog.id, extra), 15 * 60000, { timeout: 12000 }).then(
    (r) => (r && r.metas) || []
  );
}

export function fetchMeta(type, id) {
  const sources = withResource('meta', type, id);
  if (!sources.length) return Promise.reject(new Error(t('Nenhum addon fornece detalhes para {id}', { id: id })));
  // Tenta na ordem de instalação; o primeiro que responder com meta vence.
  let i = 0;
  let lastErr = null;
  const next = () => {
    // Mostra o motivo real (falha de rede, tempo esgotado...) em vez de um genérico.
    if (i >= sources.length) throw lastErr || new Error(t('Detalhes não encontrados'));
    const a = sources[i++];
    const u = url(a, 'meta', type, id);
    // Falha de rede: tenta o mesmo addon mais uma vez antes de passar para o próximo.
    return cachedJSON(u, 30 * 60000)
      .catch((e) => (e && e.status >= 400 ? Promise.reject(e) : new Promise((ok) => setTimeout(ok, 1200)).then(() => cachedJSON(u, 30 * 60000))))
      .then((r) => {
        if (r && r.meta) return r.meta;
        return next();
      })
      .catch((e) => {
        if (!lastErr || (e && e.status === 0)) lastErr = e;
        return next();
      });
  };
  return next();
}

// Streams de todos os addons em paralelo; onAddon é chamado à medida que chegam.
export function fetchStreams(type, id, onAddon) {
  const sources = withResource('stream', type, id);
  return Promise.all(
    sources.map((a) =>
      getJSON(url(a, 'stream', type, id), { timeout: 30000 })
        .then((r) => {
          const streams = ((r && r.streams) || []).map((s) => Object.assign({ addon: a.manifest.name || a.manifest.id }, s));
          if (onAddon) onAddon(a, streams);
          return streams;
        })
        .catch((e) => {
          if (onAddon) onAddon(a, [], e);
          return [];
        })
    )
  ).then((all) => all.reduce((acc, x) => acc.concat(x), []));
}

// onAddon(lista) é chamado a cada addon que responde, para não esperar o mais lento.
export function fetchSubtitles(type, id, extra, onAddon) {
  const sources = withResource('subtitles', type, id);
  return Promise.all(
    sources.map((a) =>
      getJSON(url(a, 'subtitles', type, id, extra), { timeout: 15000 })
        .then((r) => ((r && r.subtitles) || []).map((s) => Object.assign({ addon: a.manifest.name }, s)))
        .catch(() => [])
        .then((list) => {
          if (onAddon) onAddon(list);
          return list;
        })
    )
  ).then((all) => all.reduce((acc, x) => acc.concat(x), []));
}
