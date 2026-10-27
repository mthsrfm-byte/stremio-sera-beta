// Conversa com o TizenBrew (WebSocket em 127.0.0.1:8081, o mesmo que a tela dele usa).
// O TizenBrew baixa o serviço do Seraflix Beta do jsDelivr sem versão, e o cache do CDN pode entregar
// um arquivo velho por horas. Aqui pedimos para ele ligar o serviço num commit exato: o novo
// assume a porta dos addons da beta (8095) mesmo com o antigo ainda rodando.
import { getJSON } from '../lib/http.js';
import { log } from '../lib/log.js';
import { REPO, BUILD } from './update.js';

const START_SERVICE = 6; // Events.StartService do TizenBrew
const SERVICE_FILE = 'remote/tv-service.js';
let asked = false;

function latestSha() {
  return getJSON('https://api.github.com/repos/' + REPO + '/commits/main', {
    timeout: 10000,
    quiet: true,
    headers: { Accept: 'application/vnd.github+json' },
  }).then(
    (c) => (c && c.sha) || BUILD.commit,
    () => BUILD.commit
  );
}

// Uma vez por abertura do app. Fora da TV (PC) o WebSocket só falha, sem efeito.
export function startPinnedService() {
  if (asked || typeof WebSocket === 'undefined') return;
  asked = true;
  latestSha().then((sha) => {
    if (!sha) return;
    try {
      const ws = new WebSocket('ws://127.0.0.1:8081');
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: START_SERVICE, payload: { fullName: 'gh/' + REPO + '@' + sha, serviceFile: SERVICE_FILE } }));
        log.info('TizenBrew: serviço pedido no commit', sha.slice(0, 7));
        setTimeout(() => ws.close(), 1000);
      };
      ws.onerror = () => {};
    } catch (e) {
      // sem TizenBrew: nada a fazer
    }
  });
}
