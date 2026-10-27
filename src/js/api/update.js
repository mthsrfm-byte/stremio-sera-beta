// Atualização pelo GitHub, sem sair do app. O TizenBrew serve o Seraflix em
// http://127.0.0.1:8081/module/<gh/dono/repo>/dist/index.html e busca cada arquivo no jsDelivr na hora.
// Para atualizar: lê o último commit da main, confere o build.json daquele commit (gerado pela
// GitHub Action) e recarrega o app apontando para esse commit exato, sem esperar o cache do jsDelivr.
import { getJSON } from '../lib/http.js';

export const REPO = 'mthsrfm-byte/stremio-sera-beta';
export const REPO_URL = 'https://github.com/' + REPO;
export const VERSION = __KAI_VERSION__;

// O build que está rodando agora: { commit, date, message } (vazio em builds locais sem git).
export const BUILD = {
  commit: __KAI_COMMIT__,
  date: __KAI_BUILD_DATE__,
  message: __KAI_COMMIT_MSG__,
};

const MODULE_PREFIX = '/module/';

// "27/10/2026 às 14:05" (sem Intl, que o Chromium antigo da TV não tem completo).
export function formatDate(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' : '') + n;
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' às ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function shortCommit(sha) {
  return String(sha || '').slice(0, 7);
}

// Última versão publicada: { sha, commit, date, message, version, isNew }.
// sha é o commit da main (o da dist/); commit/date/message vêm do build.json dele.
export function check() {
  return getJSON('https://api.github.com/repos/' + REPO + '/commits/main', {
    timeout: 15000,
    quiet: true,
    headers: { Accept: 'application/vnd.github+json' },
  }).then((c) =>
    getJSON('https://cdn.jsdelivr.net/gh/' + REPO + '@' + c.sha + '/dist/build.json', { timeout: 15000, quiet: true }).then((b) => ({
      sha: c.sha,
      commit: b.commit,
      date: b.date,
      message: b.message,
      version: b.version,
      isNew: !!b.commit && b.commit !== BUILD.commit,
    }))
  );
}

// Limpa o cache do jsDelivr da main (para a próxima abertura pelo TizenBrew já vir nova)
// e recarrega o app no commit exato da versão nova.
export function install(info) {
  ['package.json', 'dist/index.html', 'dist/app.js', 'dist/app.css', 'dist/build.json'].forEach((f) => {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', 'https://purge.jsdelivr.net/gh/' + REPO + '/' + f, true);
      x.send();
    } catch (e) {
      // sem rede para o purge: o reload abaixo ainda funciona
    }
  });
  setTimeout(() => {
    const loc = window.location;
    if (loc.pathname.indexOf(MODULE_PREFIX) === 0) {
      const rest = loc.pathname.slice(MODULE_PREFIX.length);
      const file = rest.slice(rest.indexOf('/') + 1); // dist/index.html
      loc.href = loc.protocol + '//' + loc.host + MODULE_PREFIX + encodeURIComponent('gh/' + REPO + '@' + info.sha) + '/' + file;
    } else {
      loc.reload();
    }
  }, 1500);
}
