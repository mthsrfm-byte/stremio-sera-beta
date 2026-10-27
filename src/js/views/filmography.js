// Perfil de quem está no elenco: à esquerda foto, idade, nascimento, Instagram (com QR code para
// abrir no celular) e a bio em português; à direita a filmografia em grade de capas, com filtro
// Tudo / Filmes / Séries e ordem cronológica (mais recentes ou mais antigos primeiro).
import { h, clear, loadVisibleImages } from '../lib/dom.js';
import * as nav from '../lib/nav.js';
import { KEY } from '../lib/nav.js';
import * as router from '../router.js';
import * as extras from '../api/extras.js';
import { qrDataUrl } from '../api/phoneRemote.js';
import { spinnerLine } from '../ui.js';
import { openItem } from './recommended.js';
import { t } from '../lib/i18n.js';
import * as store from '../lib/store.js';
import { smallPoster } from '../lib/img.js';

// Ícones das redes (traço em currentColor, como os da barra).
const NET_ICON = {
  instagram: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="0.9" fill="currentColor" stroke="none"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24"><path d="M14 3.5v11a3.75 3.75 0 1 1-3.75-3.75"/><path d="M14 3.5c.6 2.6 2.5 4.4 5.5 4.6"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M4 4l16 16"/><path d="M20 4L4 20"/></svg>',
};

export function openFilmography(person) {
  if (!person || !person.id) return;
  router.push(FilmographyView(person));
}

const FILTERS = [
  { id: 'all', label: 'Tudo' },
  { id: 'movie', label: 'Filmes' },
  { id: 'tv', label: 'Séries' },
];

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function parseDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}

function longDate(p) {
  return p.d + ' de ' + MONTHS[p.m - 1] + ' de ' + p.y;
}

function ageAt(b, until) {
  let age = until.y - b.y;
  if (until.m < b.m || (until.m === b.m && until.d < b.d)) age--;
  return age;
}

// "48 anos · nasceu em 25 de junho de 1975" / "morreu em ... aos 70 anos".
function lifeLine(info) {
  const b = parseDate(info.birthday);
  if (!b) return '';
  const dd = parseDate(info.deathday);
  if (dd) return t('Nasceu em {born} · morreu em {died}, aos {n} anos', { born: longDate(b), died: longDate(dd), n: ageAt(b, dd) });
  const now = new Date();
  const age = ageAt(b, { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
  return t('{n} anos · nasceu em {born}', { n: age, born: longDate(b) });
}

// Personagem sem as marcações em inglês do TMDB.
function role(character) {
  return String(character || '')
    .replace(/\(uncredited\)/i, '(não creditado)')
    .replace(/\(voice\)/i, '(voz)')
    .replace(/\bHimself\b|\bHerself\b/, 'Si mesmo')
    .trim();
}

function FilmographyView(person) {
  const el = h('div.view.filmo');
  const ambient = h('div.fp-ambient');
  const photo = h('div.fp-photo');
  const nameEl = h('h1.fp-name', { text: person.name });
  const lifeEl = h('div.fp-life');
  const placeEl = h('div.fp-place');
  const socialEl = h('div.fp-social', { 'data-group': '' });
  const bioEl = h('div.fp-bio', { focusable: true, onSelect: () => showBio() });
  const side = h('div.fp-side', null, [
    h('div.fp-head', null, [photo, h('div.fp-id', null, [nameEl, lifeEl, placeEl, socialEl])]),
    bioEl,
  ]);

  const countEl = h('span.fp-count');
  const chips = h('div.fp-chips', { 'data-group': '' });
  const grid = h('div.fp-grid');
  const scroller = h('div.fp-scroll', { 'data-scroll-y': '', 'data-pad-y': '60' }, grid);
  const panel = h('div.fp-panel', null, [h('div.fp-title', null, [t('Filmografia'), countEl]), chips, scroller]);
  el.appendChild(ambient);
  el.appendChild(side);
  el.appendChild(panel);

  let items = null;
  let info = null;
  let filter = 'all';
  let newestFirst = true;
  let alive = true;

  setPhoto(person.photo ? person.photo.replace('/w185/', store.settings().lowMemory !== false ? '/w185/' : '/h632/') : null);
  bioEl.appendChild(spinnerLine(t('Carregando bio...')));

  function setPhoto(url) {
    clear(photo);
    if (!url) {
      photo.classList.add('img-loaded');
      return;
    }
    const im = h('img', { alt: '' });
    im.onload = () => {
      photo.classList.add('img-loaded');
      im.classList.add('ready');
    };
    im.onerror = () => (im.style.display = 'none');
    im.src = url;
    photo.appendChild(im);
    // Fundo: a própria foto em miniatura esticada (fica desfocada sem custar um blur na TV).
    ambient.style.backgroundImage = 'url("' + url.replace(/\/(h632|w185)\//, '/w45/') + '")';
  }

  function renderInfo() {
    lifeEl.textContent = lifeLine(info);
    placeEl.textContent = info.place ? t('De {place}', { place: info.place }) : '';
    clear(socialEl);
    if (info.instagram) {
      const handle = String(info.instagram).replace(/^@/, '');
      const url = 'https://instagram.com/' + handle;
      socialEl.appendChild(
        h('div.fp-insta', { focusable: true, onSelect: () => showQr('@' + handle, url) }, [
          h('img.fp-qr', { src: qrDataUrl(url, 4), alt: '' }),
          h('div', null, [h('b', { html: NET_ICON.instagram + '<span></span>' }), h('small', { text: t('Aponte a câmera do celular') })]),
        ])
      );
    }
    // Instagram ganha o QR na tela; as outras redes viram botões com o ícone (o QR abre ao apertar).
    const insta = socialEl.querySelector('.fp-insta b span');
    if (insta) insta.textContent = '@' + String(info.instagram).replace(/^@/, '');
    const others = [];
    if (info.tiktok) others.push({ icon: NET_ICON.tiktok, label: '@' + info.tiktok, title: 'TikTok @' + info.tiktok, url: 'https://tiktok.com/@' + info.tiktok });
    if (info.twitter) others.push({ icon: NET_ICON.x, label: '@' + info.twitter, title: 'X @' + info.twitter, url: 'https://x.com/' + info.twitter });
    if (others.length) {
      const nets = h('div.fp-nets');
      others.forEach((o) => {
        const chip = h('div.chip.fp-net', { focusable: true, html: o.icon + '<span></span>', onSelect: () => showQr(o.title, o.url) });
        chip.lastChild.textContent = o.label;
        nets.appendChild(chip);
      });
      socialEl.appendChild(nets);
    }
    clear(bioEl);
    if (info.bio) {
      bioEl.appendChild(h('div.fp-bio-text', { text: info.bio }));
      if (info.bioTranslated) bioEl.appendChild(h('div.fp-bio-note', { text: t('Traduzido automaticamente do inglês') }));
    } else {
      bioEl.appendChild(h('div.fp-bio-text.none', { text: t('Sem biografia no TMDB.') }));
    }
  }

  // QR grande para abrir o perfil no celular.
  function showQr(title, url) {
    const box = h('div.modal-box.center.qr-box', null, [
      h('h3', { text: title }),
      h('p.modal-text', { text: t('Aponte a câmera do celular para abrir o perfil.') }),
      h('img.qr-big', { src: qrDataUrl(url, 10), alt: url }),
      h('p.qr-url', { text: url.replace(/^https:\/\//, '') }),
    ]);
    modal(box);
  }

  // Bio inteira num painel que rola com ↑/↓.
  function showBio() {
    if (!info || !info.bio) return;
    const text = h('div.fp-bio-full', { text: info.bio });
    const box = h('div.modal-box.center.fp-bio-box', null, [h('h3', { text: person.name }), text]);
    modal(box, (e) => {
      if (e.keyCode === KEY.DOWN) text.scrollTop += 160;
      else if (e.keyCode === KEY.UP) text.scrollTop -= 160;
      else return false;
      return true;
    });
  }

  function modal(box, onKey) {
    const m = h('div.modal', null, box);
    document.getElementById('app').appendChild(m);
    const close = () => {
      nav.popLayer(layer);
      if (m.parentNode) m.parentNode.removeChild(m);
    };
    const layer = nav.pushLayer(m, {
      onBack: close,
      onKey: (e) => {
        if (onKey && onKey(e)) return true;
        if (e.keyCode === KEY.ENTER) {
          close();
          return true;
        }
        return false;
      },
    });
  }

  function renderChips() {
    clear(chips);
    FILTERS.forEach((f) =>
      chips.appendChild(
        h('div.chip', {
          focusable: true,
          cls: f.id === filter ? 'active' : '',
          text: t(f.label),
          onSelect: () => {
            filter = f.id;
            refresh();
          },
        })
      )
    );
    chips.appendChild(
      h('div.chip.fp-order', {
        focusable: true,
        text: newestFirst ? t('↓ Mais recentes') : t('↑ Mais antigos'),
        onSelect: () => {
          newestFirst = !newestFirst;
          refresh();
        },
      })
    );
  }

  function refresh() {
    const idx = Array.prototype.indexOf.call(chips.children, nav.current());
    renderChips();
    renderGrid();
    if (idx >= 0) nav.focus(chips.children[idx]);
  }

  function renderGrid() {
    if (!alive) return;
    clear(grid);
    scroller.scrollTop = 0;
    const shown = items.filter((it) => filter === 'all' || it.mediaType === filter);
    if (newestFirst) shown.reverse();
    countEl.textContent = t('{n} títulos', { n: shown.length });
    if (!shown.length) {
      grid.appendChild(h('div.hint', { text: t('Nada por aqui.') }));
      return;
    }
    let count = 0;
    const batchSize = store.settings().lowMemory !== false ? 48 : 96;
    function appendBatch(enter) {
      const start = count;
      const batch = shown.slice(count, count + batchSize);
      count += batch.length;
      batch.forEach((it) => {
      const poster = h('div.fp-poster');
      const im = h('img', { alt: '' });
      if (it.poster) im.setAttribute('data-lazy', smallPoster(it.poster));
      im.onerror = () => {
        im.style.display = 'none';
        poster.classList.add('img-loaded');
        poster.appendChild(h('div.ph', { text: it.name }));
      };
      poster.appendChild(im);
      poster.appendChild(h('span.fp-year', { text: it.year }));
      if (it.mediaType === 'tv') poster.appendChild(h('span.fp-kind', { text: t('Série') }));
      grid.appendChild(
        h('div.fp-item', { focusable: true, onSelect: () => openItem(it) }, [
          poster,
          h('div.fp-item-name', { text: it.name }),
          h('div.fp-item-role', { text: role(it.character) }),
        ])
      );
      });
      if (count < shown.length) {
        const more = h('div.btn', { focusable: true, text: t('Carregar mais'), onSelect: () => {
          grid.removeChild(more);
          appendBatch(true);
        } });
        grid.appendChild(more);
      }
      if (enter && grid.children[start]) nav.focus(grid.children[start]);
      loadVisibleImages(panel, 300);
    }
    appendBatch(false);
  }

  grid.appendChild(spinnerLine(t('Carregando filmografia...')));
  extras
    .personCredits(person.id)
    .then((list) => {
      if (!alive) return;
      items = list;
      renderChips();
      renderGrid();
      const first = grid.querySelector('.fp-item');
      if (first && router.currentView() === view) {
        entered = true;
        nav.focus(first);
      }
    })
    .catch(() => {
      if (!alive) return;
      clear(grid);
      grid.appendChild(h('div.hint', { text: t('Não foi possível carregar a filmografia.') }));
    });
  extras
    .personInfo(person.id)
    .then((i) => {
      if (!alive) return;
      info = i;
      if (i.photo && !person.photo) setPhoto(i.photo);
      renderInfo();
    })
    .catch(() => {
      if (!alive) return;
      clear(bioEl);
      bioEl.appendChild(h('div.fp-bio-text.none', { text: t('Não foi possível carregar a bio.') }));
    });

  // Entra direto na primeira capa (a lista pode ter chegado antes de a tela aparecer).
  let entered = false;
  const view = {
    el: el,
    onShow: () => {
      loadVisibleImages(panel, 600);
      const first = grid.querySelector('.fp-item');
      if (!entered && first) {
        entered = true;
        nav.focus(first);
      }
    },
    onScroll: () => loadVisibleImages(panel, 600),
    destroy: () => {
      alive = false;
      items = null;
      info = null;
      clear(photo);
      clear(grid);
      ambient.style.backgroundImage = '';
    },
  };
  return view;
}
