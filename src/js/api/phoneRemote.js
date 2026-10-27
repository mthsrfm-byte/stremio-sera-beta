// Controle pelo celular: o serviço do Seraflix (remote/tv-service.js) serve o controle em
// http://IP-DA-TV:8094. Aqui o app descobre esse endereço e desenha o QR code para a câmera.
import qrcode from 'qrcode-generator';
import { getJSON } from '../lib/http.js';
import { getTvIp } from '../lib/tv.js';

const PORT = 8094;

// O serviço sabe o IP de verdade (pelas interfaces de rede da TV); se ele não responder,
// tenta pelo app (webapis/WebRTC).
export function remoteUrl() {
  return getJSON('http://127.0.0.1:' + PORT + '/api/ip', { timeout: 3000, quiet: true })
    .then((r) => r.ip)
    .catch(() => null)
    .then((ip) => ip || getTvIp())
    .then((ip) => 'http://' + ip + ':' + PORT + '/');
}

// QR code como imagem (data URL), em preto no branco para qualquer câmera ler.
export function qrDataUrl(text, cellSize) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cellSize || 8, 2);
}
