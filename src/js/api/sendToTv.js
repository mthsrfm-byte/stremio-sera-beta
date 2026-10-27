// "Mandar para a TV": o controle no celular escolhe um filme ou série e o serviço do Seraflix na TV
// (remote/tv-service.js) guarda o pedido. Aqui o app pergunta por ele de tempos em tempos e abre.
import { getJSON } from '../lib/http.js';

const URL = 'http://127.0.0.1:8094/api/pending';
const FAST = 2500;
const SLOW = 15000; // serviço fora do ar: pergunta menos

let timer = null;

export function start(onOpen) {
  if (timer) return;
  const tick = () => {
    if (document.hidden) {
      timer = setTimeout(tick, FAST);
      return;
    }
    getJSON(URL, { timeout: 2000, quiet: true })
      .then((r) => {
        if (r && r.open) onOpen(r.open);
        timer = setTimeout(tick, FAST);
      })
      .catch(() => (timer = setTimeout(tick, SLOW)));
  };
  timer = setTimeout(tick, FAST);
}
