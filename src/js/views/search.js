// Busca em todos os catálogos de addons que aceitam "search".
import { h, clear, loadVisibleImages } from '../lib/dom.js';
import * as nav from '../lib/nav.js';
import * as addons from '../api/addons.js';
import { topbar, card, skeletonCards } from '../ui.js';
import * as router from '../router.js';
import { openDetails } from './details.js';
import { t } from '../lib/i18n.js';
import * as store from '../lib/store.js';

export function SearchView() {
  const el = h('div.view');
  const scroller = h('div.scroll-y', { 'data-scroll-y': '' });
  const bar = topbar('search', router.goTab);
  const input = h('input.input', { type: 'text', placeholder: t('Buscar filmes e séries...'), focusable: true, 'data-autofocus': '' });
  const go = h('div.btn.primary.search-go', { focusable: true, text: t('Buscar'), onSelect: () => run(input.value) });
  const results = h('div.rows');
  scroller.appendChild(bar);
  scroller.appendChild(h('div.search-box', { 'data-group': '' }, [input, go]));
  scroller.appendChild(results);
  el.appendChild(scroller);

  let token = 0;
  let alive = true;
  let resumeSearch = null;
  input.__submit = (q) => run(q);

  function run(q) {
    const my = ++token;
    resumeSearch = null;
    const query = (q || '').trim();
    clear(results);
    if (query.length < 2) {
      results.appendChild(h('div.hint', { text: t('Digite pelo menos 2 letras e aperte Buscar.') }));
      return;
    }
    results.appendChild(h('div.row', null, [h('div.row-title', { text: t('Buscando "{q}"...', { q: query }) }), h('div.row-track', null, skeletonCards())]));
    addons.load().then(() => {
      if (!alive || my !== token) return;
      clear(results);
      const cats = addons.searchCatalogs();
      if (!cats.length) results.appendChild(h('div.hint', { text: t('Nenhum addon com busca instalado.') }));
      let found = 0;
      let pending = cats.length;
      let next = 0;
      let active = 0;
      const light = store.settings().lowMemory !== false;
      function fetchNext() {
        if (!alive || my !== token || el.offsetParent === null) return;
        while (next < cats.length && active < (light ? 2 : 4)) fetchEntry(cats[next++]);
      }
      function fetchEntry(entry) {
        active++;
        const row = h('div.row', { 'data-anchor': '30' });
        const track = h('div.row-track', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' });
        row.appendChild(h('div.row-title', null, [entry.catalog.name || entry.catalog.id, h('small', { text: addons.catalogTitle(entry).split(' · ').pop() })]));
        row.appendChild(track);
        addons
          .fetchCatalog(entry, { search: query })
          .then((metas) => {
            if (!alive || my !== token || !metas.length) return;
            found++;
            metas.slice(0, light ? 12 : 30).forEach((m) => track.appendChild(card(m, { onSelect: () => openDetails(m.type || entry.catalog.type, m.id) })));
            results.appendChild(row);
            loadVisibleImages(row);
          })
          .catch(() => {})
          .then(() => {
            active--;
            pending--;
            if (alive && my === token && pending === 0 && !found) results.appendChild(h('div.hint', { text: t('Nada encontrado para "{q}".', { q: query }) }));
            fetchNext();
          });
      }
      resumeSearch = fetchNext;
      fetchNext();
    }).catch(() => {
      if (!alive || my !== token) return;
      clear(results);
      results.appendChild(h('div.hint', { text: t('Não foi possível carregar os addons.') }));
    });
  }

  run('');

  return {
    el: el,
    onShow: () => {
      loadVisibleImages(el);
      if (resumeSearch) resumeSearch();
    },
    destroy: () => {
      alive = false;
      token++;
      resumeSearch = null;
      if (bar.__destroy) bar.__destroy();
    },
    focusInput: () => nav.focus(input),
  };
}
