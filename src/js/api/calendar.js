// Google Agenda (ou qualquer agenda iCal) na TV: hoje e amanhã na home, ícone na barra e aviso no
// vídeo quando um evento vai começar. O link é o "endereço secreto no formato iCal" da agenda,
// colado em Ajustes e guardado só nesta TV. O serviço da TV baixa o arquivo (o Google não libera
// CORS para o app) e aqui ele é lido e os eventos repetidos são expandidos.
import { getText } from '../lib/http.js';
import * as store from '../lib/store.js';
import { log } from '../lib/log.js';
import { IS_WEB } from '../lib/platform.js';

const SERVICE = 'http://127.0.0.1:8095/api/cal?u=';
const REFRESH_MS = 5 * 60 * 1000;
// Cor de cada agenda (na ordem dos links em Ajustes).
const COLORS = ['#3347FF', '#F2A33A', '#3FB68B', '#E0559B'];

let events = []; // eventos de hoje e amanhã, em ordem
let loadedAt = 0;
let failedAt = 0; // última tentativa que falhou de todo (antes de ter agenda nenhuma)
let timer = null;
let inFlight = null;
const listeners = [];

// Link embutido no build (segredo CALENDAR_ICAL_URL do GitHub); o de Ajustes, se tiver, vale no lugar.
export const BUILTIN = typeof __KAI_CALENDAR__ !== 'undefined' ? __KAI_CALENDAR__ : '';

export function urls() {
  return String(store.settings().calendarUrl || BUILTIN || '')
    .split(/[\s,]+/)
    .filter((u) => /^(https?|webcal):\/\//i.test(u))
    .map((u) => u.replace(/^webcal:/i, 'https:'));
}

export function enabled() {
  return !IS_WEB && urls().length > 0;
}

// Ainda baixando a primeira vez (a home mostra os cartões em carregamento).
export function loading() {
  return enabled() && !loadedAt && !failedAt;
}

// Falhou de todo e ainda não tem agenda nenhuma.
export function failed() {
  return enabled() && !loadedAt && !!failedAt;
}

export function onChange(fn) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function changed() {
  listeners.slice().forEach((fn) => {
    try {
      fn();
    } catch (e) {
      /* ignore */
    }
  });
}

// Liga a atualização a cada 5 minutos (e já busca agora). Chamado de novo quando o link muda.
export function start() {
  clearInterval(timer);
  timer = null;
  if (!enabled()) {
    if (events.length) {
      events = [];
      changed();
    }
    return;
  }
  refresh();
  timer = setInterval(refresh, REFRESH_MS);
}

export function refresh() {
  if (!enabled()) return Promise.resolve([]);
  if (inFlight) return inFlight;
  const list = urls();
  inFlight = Promise.all(
    list.map((u, i) =>
      getText(SERVICE + encodeURIComponent(u), { timeout: 30000, quiet: true, maxBytes: 12 * 1024 * 1024 }).then(
        (text) => parse(text, COLORS[i % COLORS.length]),
        (e) => {
          log.warn('Agenda: não baixou', e.message);
          return null;
        }
      )
    )
  ).then((all) => {
    inFlight = null;
    // Falhou tudo: mantém o que já tinha (a rede da TV às vezes engasga).
    if (all.every((x) => x === null)) {
      if (loadedAt) return events;
      failedAt = Date.now();
      changed();
      return events;
    }
    events = all
      .filter(Boolean)
      .reduce((acc, x) => acc.concat(x), [])
      .sort((a, b) => a.start - b.start || (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0));
    loadedAt = Date.now();
    failedAt = 0;
    changed();
    return events;
  });
  return inFlight;
}

export function lastUpdate() {
  return loadedAt;
}

// Quanto tempo um evento que já acabou continua na lista (depois disso, some).
const KEEP_ENDED_MS = 60 * 60000;

// { today: [...], tomorrow: [...] } com os eventos de cada dia (os de dia todo primeiro).
// De hoje, só o que ainda não acabou + o último que acabou, se acabou há menos de 1 hora.
export function days() {
  const now = Date.now();
  const t0 = dayStart(new Date());
  const t1 = addDays(t0, 1);
  const t2 = addDays(t0, 2);
  const on = (a, b) => events.filter((e) => e.start < b && e.end > a).sort((x, y) => (y.allDay ? 1 : 0) - (x.allDay ? 1 : 0) || x.start - y.start);
  const ended = on(t0, t1).filter((e) => e.end.getTime() <= now);
  const lastEnded = ended.reduce((a, b) => (!a || b.end > a.end ? b : a), null);
  const today = on(t0, t1).filter((e) => e.end.getTime() > now);
  if (lastEnded && now - lastEnded.end.getTime() <= KEEP_ENDED_MS) today.push(lastEnded);
  today.sort((x, y) => (y.allDay ? 1 : 0) - (x.allDay ? 1 : 0) || x.start - y.start);
  return { today: today, tomorrow: on(t1, t2) };
}

// Próximo evento com horário que começa dentro de `ms` (para o ponto no ícone e o aviso no vídeo).
export function startingWithin(ms) {
  const now = Date.now();
  return events.filter((e) => !e.allDay && e.start.getTime() > now && e.start.getTime() - now <= ms);
}

// ---------- Leitura do iCal ----------

function unfold(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

function unescape(v) {
  return String(v || '')
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

// Descrição: mantém as quebras de linha (\n), que o título não usa.
function unescapeText(v) {
  return String(v || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\([,;\\])/g, '$1')
    .trim()
    .slice(0, 800);
}

// Convidado ou organizador: nome (CN), e-mail e resposta (PARTSTAT) quando tiver.
function person(p) {
  const email = String(p.value || '').replace(/^mailto:/i, '').trim();
  const name = String(p.params.CN || '').replace(/^"|"$/g, '').trim();
  return { name: name || email.split('@')[0], email: email, status: (p.params.PARTSTAT || '').toUpperCase() };
}

// "DTSTART;TZID=America/Sao_Paulo:20261027T190000" → { name, params, value }
function prop(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const head = line.slice(0, i).split(';');
  const params = {};
  head.slice(1).forEach((p) => {
    const j = p.indexOf('=');
    if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1);
  });
  return { name: head[0].toUpperCase(), params: params, value: line.slice(i + 1) };
}

// Data do iCal. Com "Z" é UTC; com TZID ou sem nada, o horário vale como está (a TV fica no mesmo
// fuso da agenda: o navegador antigo da TV não converte fusos por nome).
function icsDate(p) {
  const v = p.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const allDay = p.params.VALUE === 'DATE' || !m[4];
  if (allDay) return { date: new Date(+m[1], +m[2] - 1, +m[3]), allDay: true };
  if (m[7]) return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))), allDay: false };
  return { date: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)), allDay: false };
}

function duration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
}

export function parse(text, color) {
  const lines = unfold(text);
  let calName = '';
  const raw = [];
  let cur = null;
  lines.forEach((line) => {
    if (line === 'BEGIN:VEVENT') cur = { exdates: [] };
    else if (line === 'END:VEVENT') {
      if (cur) raw.push(cur);
      cur = null;
    } else {
      const p = prop(line);
      if (!p) return;
      if (!cur) {
        if (p.name === 'X-WR-CALNAME') calName = unescape(p.value);
        return;
      }
      if (p.name === 'SUMMARY') cur.title = unescape(p.value);
      else if (p.name === 'LOCATION') cur.location = unescape(p.value);
      else if (p.name === 'UID') cur.uid = p.value;
      else if (p.name === 'DESCRIPTION') cur.description = unescapeText(p.value);
      else if (p.name === 'ORGANIZER') cur.organizer = person(p);
      else if (p.name === 'ATTENDEE') (cur.attendees = cur.attendees || []).push(person(p));
      else if (p.name === 'STATUS') cur.status = p.value.toUpperCase();
      else if (p.name === 'DTSTART') cur.start = icsDate(p);
      else if (p.name === 'DTEND') cur.end = icsDate(p);
      else if (p.name === 'DURATION') cur.duration = duration(p.value);
      else if (p.name === 'RRULE') cur.rrule = p.value;
      else if (p.name === 'RECURRENCE-ID') cur.recurrenceId = icsDate(p);
      else if (p.name === 'EXDATE')
        p.value.split(',').forEach((v) => {
          const d = icsDate({ value: v, params: p.params });
          if (d) cur.exdates.push(d.date.getTime());
        });
    }
  });

  const from = dayStart(new Date());
  const to = addDays(from, 2);
  // Ocorrências trocadas uma a uma (RECURRENCE-ID) saem da série e entram como evento próprio.
  const moved = {};
  raw.forEach((e) => {
    if (e.uid && e.recurrenceId) (moved[e.uid] = moved[e.uid] || []).push(e.recurrenceId.date.getTime());
  });
  const out = [];
  raw.forEach((e) => {
    if (!e.start || e.status === 'CANCELLED') return;
    const len = e.end ? e.end.date - e.start.date : e.duration || (e.start.allDay ? 86400000 : 0);
    const skip = e.exdates.concat((!e.recurrenceId && e.uid && moved[e.uid]) || []);
    const starts = e.rrule && !e.recurrenceId ? expand(e.start.date, e.rrule, from, to, len) : [e.start.date];
    starts.forEach((s) => {
      if (skip.indexOf(s.getTime()) >= 0) return;
      const end = new Date(s.getTime() + Math.max(len, 0));
      if (s >= to || (end <= from && !(len === 0 && s >= from))) return;
      out.push({
        title: e.title || '(sem título)',
        location: e.location || '',
        start: s,
        end: len > 0 ? end : new Date(s.getTime() + 1),
        allDay: e.start.allDay,
        calendar: calName,
        color: color,
        description: e.description || '',
        organizer: e.organizer || null,
        attendees: e.attendees || [],
      });
    });
  });
  return out;
}

// ---------- Eventos repetidos (RRULE) ----------
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function dayStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
}

function daysBetween(a, b) {
  return Math.round((dayStart(b) - dayStart(a)) / 86400000);
}

// Dia do mês da n-ésima (ou -1: última) ocorrência do dia da semana `wd` naquele mês.
function nthWeekday(year, month, wd, n) {
  if (n > 0) {
    const first = new Date(year, month, 1).getDay();
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(year, month + 1, 0);
  return lastDay.getDate() - ((lastDay.getDay() - wd + 7) % 7) + (n + 1) * 7;
}

// Início de cada ocorrência que pode cair entre from e to (o horário vem do primeiro evento).
export function expand(start, rrule, from, to, len) {
  const r = {};
  rrule.split(';').forEach((kv) => {
    const p = kv.split('=');
    r[p[0].toUpperCase()] = p[1] || '';
  });
  const freq = r.FREQ;
  const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const count = parseInt(r.COUNT, 10) || 0;
  const until = r.UNTIL ? icsDate({ value: r.UNTIL, params: {} }) : null;
  const byDay = (r.BYDAY || '')
    .split(',')
    .filter(Boolean)
    .map((x) => {
      const m = x.match(/^([+-]?\d+)?([A-Z]{2})$/);
      return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS.indexOf(m[2]) } : null;
    })
    .filter((x) => x && x.wd >= 0);
  const byMonthDay = (r.BYMONTHDAY || '').split(',').filter(Boolean).map((x) => parseInt(x, 10));

  function matches(d) {
    const dd = daysBetween(start, d);
    if (dd < 0) return false;
    if (freq === 'DAILY') return dd % interval === 0 && (!byDay.length || byDay.some((b) => b.wd === d.getDay()));
    if (freq === 'WEEKLY') {
      // Semanas contadas a partir da segunda-feira da semana do primeiro evento.
      const weekOf = (x) => addDays(dayStart(x), -((x.getDay() + 6) % 7));
      const weeks = Math.round(daysBetween(weekOf(start), weekOf(d)) / 7);
      const days = byDay.length ? byDay.map((b) => b.wd) : [start.getDay()];
      return weeks % interval === 0 && days.indexOf(d.getDay()) >= 0;
    }
    if (freq === 'MONTHLY') {
      const months = (d.getFullYear() - start.getFullYear()) * 12 + d.getMonth() - start.getMonth();
      if (months % interval !== 0) return false;
      if (byDay.length) return byDay.some((b) => b.wd === d.getDay() && (b.n === 0 || nthWeekday(d.getFullYear(), d.getMonth(), b.wd, b.n) === d.getDate()));
      const monthDays = byMonthDay.length ? byMonthDay : [start.getDate()];
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      return monthDays.some((md) => (md > 0 ? md : last + md + 1) === d.getDate());
    }
    if (freq === 'YEARLY') {
      const years = d.getFullYear() - start.getFullYear();
      return years % interval === 0 && d.getMonth() === start.getMonth() && d.getDate() === start.getDate();
    }
    return false;
  }

  const out = [];
  // Sem COUNT, só os dias perto da janela importam; com COUNT, conta desde o primeiro.
  const spanDays = Math.ceil(Math.max(len, 0) / 86400000) + 1;
  let day = count ? dayStart(start) : dayStart(addDays(from, -spanDays) > start ? addDays(from, -spanDays) : start);
  let n = 0;
  for (let guard = 0; guard < 20000 && day < to; guard++, day = addDays(day, 1)) {
    if (!matches(day)) continue;
    const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), start.getHours(), start.getMinutes(), start.getSeconds());
    if (until && s > until.date) break;
    n++;
    if (count && n > count) break;
    if (s.getTime() + Math.max(len, 1) > from.getTime()) out.push(s);
  }
  return out;
}
