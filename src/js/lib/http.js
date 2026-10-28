// XHR com Promise: o Chromium 38 não tem fetch().
import { log } from './log.js';
import { t } from './i18n.js';

// Últimos erros de rede (para o diagnóstico em Ajustes), sem chaves nem parâmetros.
const netErrors = [];
export function recentErrors() {
  return netErrors.slice();
}
function shortUrl(url) {
  return String(url).split('?')[0].replace(/^https?:\/\//, '');
}

// Teto por resposta: um addon ou servidor quebrado não enche a memória da TV com uma resposta só.
// JSON até 4 MB (o meta de séries longas passa de 1 MB), texto (legendas) até 5 MB.
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

function tooLarge(url, max) {
  const err = new Error(t('Resposta grande demais de {url} (mais de {mb} MB)', { url: url, mb: Math.round(max / 1048576) }));
  err.status = 0;
  err.tooLarge = true;
  return err;
}

export function request(method, url, body, opts) {
  const o = opts || {};
  const started = Date.now();
  const max = o.maxBytes || (o.raw ? MAX_TEXT_BYTES : MAX_JSON_BYTES);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let aborted = false;
    const abortLarge = () => {
      if (aborted) return;
      aborted = true;
      try { xhr.abort(); } catch (e) { /* já encerrado */ }
      reject(tooLarge(url, max));
    };
    xhr.open(method, url, true);
    xhr.timeout = o.timeout || 20000;
    if (body !== undefined && body !== null) xhr.setRequestHeader('Content-Type', 'application/json');
    if (o.headers) for (const k in o.headers) xhr.setRequestHeader(k, o.headers[k]);
    // O tamanho anunciado já recusa antes de baixar; o progresso corta quem não anuncia ou mente.
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 2) return;
      const declared = Number(xhr.getResponseHeader('Content-Length'));
      if (declared > max) abortLarge();
    };
    xhr.onprogress = (e) => {
      if (e && e.loaded > max) abortLarge();
    };
    xhr.onload = () => {
      if (aborted) return;
      // responseText já descompactado: uma resposta gzip pequena não vira dezenas de MB.
      if (xhr.responseText && xhr.responseText.length > max) return abortLarge();
      if (xhr.status >= 200 && xhr.status < 300) {
        // Usado pelo cache sem serializar de novo objetos grandes na thread da TV.
        if (o._onResponseSize) o._onResponseSize(xhr.responseText.length * 2);
        if (o.raw) return resolve(xhr.responseText);
        try {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : null);
        } catch (e) {
          reject(new Error(t('JSON inválido de {url}', { url: url })));
        }
      } else {
        const err = new Error(t('HTTP {code} em {url}', { code: xhr.status, url: url }));
        err.status = xhr.status;
        try {
          const detail = JSON.parse(xhr.responseText || '{}');
          if (detail && typeof detail.error === 'string') err.detail = detail.error.slice(0, 240);
        } catch (e) { /* resposta sem JSON: mantém o erro HTTP */ }
        reject(err);
      }
    };
    xhr.onerror = () => {
      if (aborted) return;
      const err = new Error(t('Falha de rede em {url}', { url: url }));
      err.status = 0;
      reject(err);
    };
    xhr.ontimeout = () => {
      if (aborted) return;
      const err = new Error(t('Tempo esgotado em {url}', { url: url }));
      err.status = 0;
      err.timeout = true;
      reject(err);
    };
    xhr.send(body !== undefined && body !== null ? JSON.stringify(body) : null);
  }).catch((err) => {
    err.ms = Date.now() - started;
    if (!/127\.0\.0\.1|localhost/.test(url)) {
      netErrors.unshift({ at: Date.now(), url: shortUrl(url), msg: err.tooLarge ? 'resposta grande demais' : err.timeout ? 'tempo esgotado' : err.status ? 'HTTP ' + err.status : err.status === 0 ? 'falha de rede' : 'resposta inválida', ms: err.ms });
      if (netErrors.length > 12) netErrors.pop();
    }
    if (!o.quiet) log.warn(err.message);
    throw err;
  });
}

export function getJSON(url, opts) {
  return request('GET', url, null, opts);
}

export function postJSON(url, body, opts) {
  return request('POST', url, body, opts);
}

export function getText(url, opts) {
  return request('GET', url, null, Object.assign({ raw: true }, opts));
}

// Cache LRU com validade e orçamento: poucas respostas grandes também podem esgotar a TV.
// O tamanho do JSON serve de orçamento de retenção, não de medida exata do heap.
const cache = new Map();
const CACHE_LIMIT = 24;
const CACHE_BYTES = 2 * 1024 * 1024;
let cacheBytes = 0;

function removeCached(url) {
  const item = cache.get(url);
  if (!item) return;
  cacheBytes -= item.bytes;
  cache.delete(url);
}

function trimCache(now) {
  cache.forEach((item, url) => { if (now >= item.expires) removeCached(url); });
  while (cache.size > CACHE_LIMIT || cacheBytes > CACHE_BYTES) removeCached(cache.keys().next().value);
}

export function clearCache() {
  cache.clear();
  cacheBytes = 0;
}

export function cachedJSON(url, ttlMs, opts) {
  const now = Date.now();
  trimCache(now);
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    cache.set(url, hit);
    return hit.p;
  }
  const entry = { expires: now + (ttlMs || 600000), bytes: 0, p: null };
  let responseBytes = 0;
  const p = getJSON(url, Object.assign({}, opts, { _onResponseSize: (bytes) => { responseBytes = bytes; } })).then((value) => {
    if (cache.get(url) === entry) {
      entry.bytes = responseBytes;
      cacheBytes += responseBytes;
      trimCache(Date.now());
    }
    return value;
  }).catch((e) => {
    // Uma requisição velha pode falhar depois de a URL já ter sido recarregada.
    if (cache.get(url) === entry) removeCached(url);
    throw e;
  });
  entry.p = p;
  cache.set(url, entry);
  trimCache(now);
  return p;
}
