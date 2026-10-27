// Biblioteca da conta Stremio, com filtro por tipo.
import { h, clear, loadVisibleImages } from '../lib/dom.js';
import * as nav from '../lib/nav.js';
import * as stremio from '../api/stremio.js';
import * as addons from '../api/addons.js';
import { topbar, card, spinnerLine } from '../ui.js';
import * as router from '../router.js';
import { openDetails } from './details.js';
import { t } from '../lib/i18n.js';
import * as store from '../lib/store.js';

const FILTERS = [
  { id: 'all', label: 'Tudo' },
  { id: 'movie', label: 'Filmes' },
  { id: 'series', label: 'Séries' },
];

export function LibraryView() {
  const el = h('div.view');
  const scroller = h('div.scroll-y', { 'data-scroll-y': '' });
  const bar = topbar('library', router.goTab);
  const filters = h('div.filters', { 'data-group': '' });
  const grid = h('div.grid');
  scroller.appendChild(bar);
  // Cabeçalho da página: título à esquerda, filtros à direita na mesma linha.
  scroller.appendChild(h('div.page-head', null, [h('h1.page-title', { text: t('Biblioteca') }), filters]));
  scroller.appendChild(grid);
  el.appendChild(scroller);

  let filter = 'all';
  let alive = true;
  let requestToken = 0;

  function renderFilters() {
    clear(filters);
    FILTERS.forEach((f) =>
      filters.appendChild(
        h('div.chip', {
          focusable: true,
          cls: f.id === filter ? 'active' : '',
          text: t(f.label),
          onSelect: () => {
            filter = f.id;
            renderFilters();
            renderGrid();
            nav.focus(filters.children[FILTERS.indexOf(f)]);
          },
        })
      )
    );
  }

  function renderGrid() {
    if (!alive) return;
    clear(grid);
    const items = stremio
      .cachedLibrary()
      .filter((it) => !it.removed && (filter === 'all' || it.type === filter) && !addons.isAdultId(it._id))
      .sort((a, b) => String(b._mtime || '').localeCompare(String(a._mtime || '')));
    if (!items.length) {
      grid.appendChild(h('div.hint', { text: stremio.isLoggedIn() ? t('Sua biblioteca está vazia.') : t('Entre na sua conta em Ajustes para ver a biblioteca.') }));
      return;
    }
    let shown = 0;
    const batchSize = store.settings().lowMemory !== false ? 48 : 96;
    function appendBatch(enter) {
      const start = shown;
      const end = Math.min(items.length, start + batchSize);
      for (; shown < end; shown++) {
        const it = items[shown];
        grid.appendChild(card({ name: it.name, poster: it.poster }, { onSelect: () => openDetails(it.type, it._id) }));
      }
      if (shown < items.length) {
        const more = h('div.btn', { focusable: true, text: t('Carregar mais'), onSelect: () => {
          grid.removeChild(more);
          appendBatch(true);
        } });
        grid.appendChild(more);
      }
      if (enter && grid.children[start]) nav.focus(grid.children[start]);
      loadVisibleImages(el, 300);
    }
    appendBatch(false);
  }

  renderFilters();
  grid.appendChild(spinnerLine(t('Carregando biblioteca...')));

  return {
    el: el,
    onShow: () => {
      const my = ++requestToken;
      renderGrid();
      stremio
        .getLibrary()
        .then(() => { if (alive && my === requestToken) renderGrid(); })
        .catch(() => {});
    },
    destroy: () => {
      alive = false;
      requestToken++;
      if (bar.__destroy) bar.__destroy();
    },
  };
}
