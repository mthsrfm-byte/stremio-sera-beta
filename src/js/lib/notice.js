// Vídeos de aviso do debrid: quando o serviço não entrega o arquivo, addons como o Torrentio
// redirecionam para um clipe curto (failed_access.mp4, limits_exceeded.mp4, downloading.mp4...).
// A TV toca o clipe ou recusa; nos dois casos o app diz o que houve. Ideia do StremioK (MIT).
import { t } from './i18n.js';

// Abaixo disso um filme ou episódio é aviso, não o vídeo (não marca assistido nem segue a série).
export const NOTICE_MAX_SECONDS = 120;

const SERVICES = { RD: 'Real-Debrid', AD: 'AllDebrid', PM: 'Premiumize', TB: 'TorBox', DL: 'Debrid-Link', ED: 'EasyDebrid', OC: 'Offcloud', PK: 'PikPak' };

// O serviço pela etiqueta da fonte: [RD+], [RD⚡], [TB⚡], RD download...
export function serviceOf(stream) {
  const text = String((stream && stream.name) || '') + ' ' + String((stream && (stream.title || stream.description)) || '').split('\n')[0];
  const m = /\[(RD|AD|PM|TB|DL|ED|OC|PK)(?:\+|⚡|\s|\])/.exec(text) || /\b(RD|AD|PM|TB|DL|ED|OC|PK)\+/.exec(text);
  if (m) return { tag: m[1], name: SERVICES[m[1]] };
  const named = /real[ -]?debrid|alldebrid|premiumize|torbox|debrid[ -]?link|easydebrid|offcloud/i.exec(text);
  if (!named) return null;
  const key = named[0].toLowerCase().replace(/[ -]/g, '');
  const tag = { realdebrid: 'RD', alldebrid: 'AD', premiumize: 'PM', torbox: 'TB', debridlink: 'DL', easydebrid: 'ED', offcloud: 'OC' }[key];
  return { tag: tag, name: SERVICES[tag] };
}

// Pelo nome do arquivo para onde o link levou.
export function classify(url) {
  // Só nomes inteiros de aviso: um filme chamado "Limitless" ou "Terror" não pode virar aviso.
  const file = String(url || '').split('?')[0].split('/').pop().toLowerCase();
  const m = /^(failed_[a-z_]+?|limits?_exceeded|downloading|no_matching_file|blocked_access|access_denied)(?:_v\d+)?\.(?:mp4|mkv|webm)$/.exec(file);
  if (!m) return null;
  const name = m[1];
  if (/access|denied/.test(name)) return 'access';
  if (/limit/.test(name)) return 'limit';
  if (/infringement|blocked/.test(name)) return 'refused';
  if (name === 'downloading') return 'downloading';
  return 'failed';
}

export function message(kind, stream) {
  const svc = serviceOf(stream);
  const name = svc ? svc.name : t('O serviço debrid');
  const addon = stream && stream.addon ? ' (' + stream.addon + ')' : '';
  if (kind === 'access') return t('{svc} recusou o acesso{addon}: confira a chave no addon', { svc: name, addon: addon });
  if (kind === 'limit') return t('{svc}: o limite da conta foi atingido por agora', { svc: name });
  if (kind === 'refused') return t('{svc} não entrega este arquivo', { svc: name });
  if (kind === 'downloading') return t('{svc} ainda está baixando este arquivo: tente mais tarde', { svc: name });
  if (kind === 'short') return t('Essa fonte ainda não está pronta (o serviço debrid está preparando o arquivo): tente outra ou esta mais tarde');
  return t('{svc} não conseguiu abrir este arquivo', { svc: name });
}

// Avisos sobre a conta valem para os outros links do mesmo addon pelo mesmo serviço.
export function accountWide(kind) {
  return kind === 'access' || kind === 'limit';
}

export function sameAccount(a, b) {
  if (!a || !b || a.addon !== b.addon) return false;
  const sa = serviceOf(a);
  const sb = serviceOf(b);
  return !!sa && !!sb && sa.tag === sb.tag;
}

// Lê só para onde o link leva (o endereço final após os redirecionamentos) e desiste em seguida,
// sem baixar o vídeo. Sem CORS no destino, não dá para saber: devolve null.
export function probe(url, timeoutMs) {
  if (!/^https?:\/\//i.test(String(url || '')) || /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let xhr;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { xhr.abort(); } catch (e) { /* já encerrado */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs || 6000);
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Range', 'bytes=0-0');
      xhr.onreadystatechange = () => {
        if (xhr.readyState >= 2) finish(classify(xhr.responseURL || '') || null);
      };
      xhr.onerror = () => finish(null);
      xhr.send(null);
    } catch (e) {
      finish(null);
    }
  });
}
