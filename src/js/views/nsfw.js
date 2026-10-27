// Aba NSFW: tudo que vem dos addons adultos, separado do resto do app.
// Organização por site: no topo, um bloco por site (Pornhub, XVideos e os outros addons; as
// instalações divididas do mesmo addon, como "TPB 4K Porn (1/2)" e "(2/2)", viram um site só) e a
// Busca. Dentro do site: atalhos para as fileiras, Favoritos e Continuar assistindo daquele site,
// Creampie hétero e gay (mais vistos primeiro), as categorias e as demais fileiras.
import { h, clear, loadVisibleImages } from '../lib/dom.js';
import * as nav from '../lib/nav.js';
import { KEY } from '../lib/nav.js';
import * as addons from '../api/addons.js';
import * as stremio from '../api/stremio.js';
import { topbar, card, skeletonCards, retrying, pagedGrid, statsLine } from '../ui.js';
import * as router from '../router.js';
import { openDetails as openDetailsRaw } from './details.js';
import { showRetry } from './recommended.js';
import { t } from '../lib/i18n.js';
import * as tr from '../lib/translate.js';
import * as store from '../lib/store.js';
import * as nsfwSaved from '../lib/nsfwSaved.js';

const ROW_LIMIT = 20;
const ICON_SEARCH = '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>';

// Marca dos sites do serviço da TV (cores dos próprios sites).
const SITE_MARK = {
  'seraflix.pornhub': { text: 'PH', bg: '#FF9000', fg: '#111110' },
  'seraflix.xvideos': { text: 'XV', bg: '#DE2600', fg: '#FFFFFF' },
};

// Sigla do site para quando o addon não tem logo.
function initialsOf(name) {
  const words = String(name || '?')
    .replace(/[^A-Za-z0-9À-ú+ ]/g, ' ')
    .trim()
    .split(/\s+/);
  // Sigla já pronta no nome ("TPB 4K Porn" → "TPB"); senão, as iniciais das duas primeiras palavras.
  if (/^[A-Z0-9]{2,4}$/.test(words[0])) return words[0];
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 3)).toUpperCase();
}

// Nome do site sem a parte da instalação: "TPB 4K Porn (1/2)" → "TPB 4K Porn".
function siteName(a) {
  return String(a.manifest.name || a.manifest.id)
    .replace(/\s*[([]\s*\d+\s*\/\s*\d+\s*[)\]]\s*$/, '')
    .replace(/\s+(?:part|parte|pt\.?)\s*\d+\s*$/i, '')
    .trim();
}

// Sites na ordem dos addons (Pornhub e XVideos primeiro), cada um com as suas instalações.
export function sites() {
  const out = [];
  addons.adultAddons().forEach((a) => {
    const name = siteName(a);
    const id = SITE_MARK[a.manifest.id] ? a.manifest.id : 'site:' + name.toLowerCase();
    let s = out.filter((x) => x.id === id)[0];
    if (!s) {
      s = { id: id, name: name, addons: [], mark: SITE_MARK[a.manifest.id] || null };
      out.push(s);
    }
    s.addons.push(a);
  });
  return out;
}

function sitePrefixes(site) {
  const out = [];
  site.addons.forEach((a) => {
    const m = a.manifest;
    [m.idPrefixes || []].concat((m.resources || []).map((r) => (typeof r === 'object' && r.idPrefixes) || [])).forEach((l) =>
      l.forEach((p) => p && p !== 'tt' && out.indexOf(p) < 0 && out.push(p))
    );
  });
  return out;
}

// O item é deste site? Pelo prefixo do id; addon sem prefixo fica com o que nenhum outro site reclama.
function belongsTo(site, all, id) {
  const mine = sitePrefixes(site);
  if (mine.some((p) => id.indexOf(p) === 0)) return true;
  if (mine.length) return false;
  return !all.some((s) => s !== site && sitePrefixes(s).some((p) => id.indexOf(p) === 0));
}

// Tudo que abre daqui fica marcado como adulto (some do resto do app).
// Muitos addons adultos não têm "meta": os detalhes usam o próprio item do catálogo.
function openDetails(type, id, opts, item) {
  addons.markAdult(id);
  openDetailsRaw(type, id, Object.assign({ fallbackMeta: item || null }, opts));
}

// Cartão do catálogo: capa deitada, qualidade e duração em cima da prévia e, embaixo, os números
// do vídeo (visualizações, aprovação, canal). Sem prévia (capa que não abre), o vídeo sai da fileira.
// Títulos sem censura: o addon costuma escrever "uncensored" no nome.
function isUncensored(m) {
  return /uncensored/i.test(m.name || '');
}

function itemCard(m, entry) {
  const wide = m.posterShape === 'landscape' || (entry && entry.catalog.posterShape === 'landscape');
  const st = m.stats || {};
  const extra = !m.stats && m.releaseInfo ? h('div.card-stats', null, h('span.cs-by', { text: String(m.releaseInfo) })) : null;
  return card(m, {
    wide: wide,
    rich: true,
    image: wide ? m.poster || m.background : undefined,
    dropWithoutImage: true,
    corner: st.quality,
    flag: isUncensored(m) ? 'UNCENSORED' : null,
    duration: st.duration,
    stats: statsLine(st) || extra,
    onSelect: () => openDetails(m.type || entry.catalog.type, m.id, null, m),
  });
}

// Creampie primeiro (hétero, depois gay), depois o resto na ordem do addon.
function catalogOrder(e) {
  const n = (e.catalog.name || e.catalog.id || '') + ' ' + (e.catalog.id || '');
  if (!/creampie/i.test(n)) return 2;
  return /gay/i.test(n) ? 1 : 0;
}

export function NsfwView() {
  const el = h('div.view.nsfw-view', { 'data-stay': '' });
  const scroller = h('div.scroll-y', { 'data-scroll-y': '' });
  const bar = topbar('nsfw', router.goTab);
  const filters = h('div.provider-rail.nsfw-rail.site-rail', { 'data-group': '', 'data-trap': '' });
  const body = h('div.rows');
  scroller.appendChild(bar);
  scroller.appendChild(filters);
  scroller.appendChild(body);
  el.appendChild(scroller);

  // id do site | 'search'. Lembra o último site.
  let scope = store.get('nsfwScope', null);
  let switchTimer = null;
  let pending = [];
  let active = 0;
  let personalSlot = null;
  let alive = true;
  let bodyToken = 0;
  let loadingAddons = false;
  let resumeSearch = null;

  function scopes() {
    const list = sites();
    const out = list.map((s) => ({ id: s.id, label: s.name, sub: siteSub(s), site: s }));
    if (list.some((s) => s.addons.some((a) => addons.adultCatalogs(a).some((e) => addons.supportsSearch(e.catalog)))))
      out.push({ id: 'search', label: t('Buscar'), sub: t('em todos os sites'), icon: ICON_SEARCH });
    return out;
  }

  function siteSub(s) {
    const n = s.addons.reduce((acc, a) => acc + addons.adultCatalogs(a).filter((e) => addons.isBoardable(e.catalog)).length, 0);
    const cats = t(n === 1 ? '{n} catálogo' : '{n} catálogos', { n: n });
    return s.addons.length > 1 ? t('{n} instalações', { n: s.addons.length }) + ' · ' + cats : cats;
  }

  // Marca do site: a dos sites conhecidos, o logo do addon ou as iniciais.
  function siteMark(f) {
    const box = h('div.provider-logo');
    if (f.icon) {
      box.classList.add('img-loaded');
      box.classList.add('icon');
      box.innerHTML = f.icon;
      return box;
    }
    const mark = f.site.mark;
    if (mark) {
      box.classList.add('img-loaded');
      box.appendChild(h('span.mono.site-mark', { text: mark.text, style: { background: mark.bg, color: mark.fg } }));
      return box;
    }
    box.appendChild(h('span.mono', { text: initialsOf(f.label) }));
    const logo = f.site.addons[0].manifest.logo;
    if (logo) {
      const im = h('img', { alt: '' });
      im.onload = () => {
        if (!alive) return;
        im.classList.add('ready');
        box.classList.add('img-loaded');
        box.classList.add('has-img');
      };
      im.onerror = () => box.classList.add('img-loaded');
      im.src = logo;
      box.appendChild(im);
    } else box.classList.add('img-loaded');
    return box;
  }

  function renderFilters() {
    clear(filters);
    const list = scopes();
    if (!list.some((f) => f.id === scope)) scope = list.length ? list[0].id : null;
    list.forEach((f) =>
      filters.appendChild(
        h('div.provider.site-tile', { focusable: true, cls: f.id === scope ? 'on' : '', title: f.label, onFocus: () => scheduleSwitch(f.id), onSelect: () => pick(f.id, true) }, [
          siteMark(f),
          h('div.site-text', null, [h('div.provider-name', { text: f.label }), h('div.site-sub', { text: f.sub })]),
        ])
      )
    );
    if (list.length) filters.appendChild(h('div.nsfw-badge.site-18', { text: '18+' }));
  }

  // Parar o foco num site troca o conteúdo (como em Streamings); OK entra nas fileiras.
  function scheduleSwitch(id) {
    if (!alive) return;
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => pick(id), 700);
  }

  function pick(id, enter) {
    if (!alive) return;
    clearTimeout(switchTimer);
    if (id === scope) {
      const first = enter && body.querySelector('.card, .chip');
      if (first) nav.focus(first);
      return;
    }
    scope = id;
    store.set('nsfwScope', id);
    const idx = scopes()
      .map((f) => f.id)
      .indexOf(id);
    renderFilters();
    renderBody();
    if (filters.children[idx]) nav.focus(filters.children[idx], { noScroll: true });
  }

  // Mesma ideia da tela inicial: só busca o catálogo quando a fileira chega perto, 2 por vez.
  function startLoad(p) {
    if (!alive || p.state !== 'idle') return;
    const generation = bodyToken;
    p.state = 'loading';
    active++;
    p.load().catch(() => {}).then(() => {
      if (!alive || generation !== bodyToken) return;
      p.state = 'done';
      active--;
      loadNearby();
    });
  }

  function loadNearby() {
    if (!alive || el.offsetParent === null) return;
    if (resumeSearch) resumeSearch();
    const light = store.settings().lowMemory !== false;
    const concurrent = light ? 1 : 2;
    const limit = window.innerHeight * (light ? 1.4 : 2.2);
    // Um atalho solicitado pelo usuário tem prioridade sobre a pré-carga.
    pending.forEach((p) => { if (active < concurrent && p.wantFocus && p.state === 'idle') startLoad(p); });
    for (let i = 0; i < pending.length && active < concurrent; i++) {
      const p = pending[i];
      if (p.state !== 'idle') continue;
      if (!p.row.parentNode) {
        p.state = 'done';
        continue;
      }
      if (p.row.getBoundingClientRect().top > limit) break;
      startLoad(p);
    }
  }

  // Atalho: vai para o primeiro vídeo da fileira (carrega na hora se ela ainda não carregou).
  function jumpTo(p) {
    const first = p.row.querySelector('.card');
    if (first) return nav.focus(first);
    p.wantFocus = true;
    loadNearby();
  }

  function releaseBody() {
    bodyToken++;
    pending.forEach((p) => p.destroy && p.destroy());
    pending = [];
    active = 0;
    resumeSearch = null;
    personalSlot = null;
    clear(body);
  }

  function renderBody() {
    releaseBody();
    if (scope === 'search') return renderSearch();
    const all = sites();
    const site = all.filter((s) => s.id === scope)[0];
    if (!site) {
      body.appendChild(h('div.hint', { text: emptyHint() }));
      return;
    }
    const chips = h('div.chip-track.jump-chips', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' });
    body.appendChild(h('div.row.nsfw-jumps', { 'data-anchor': '30' }, chips));
    personalSlot = h('div.nsfw-personal');
    body.appendChild(personalSlot);
    renderPersonal(site, all, chips);

    const entries = [];
    site.addons.forEach((a) =>
      addons.adultCatalogs(a).forEach((e) => {
        if (addons.isBoardable(e.catalog) && !tr.isHiddenCategory(e.catalog.name || e.catalog.id)) entries.push(e);
      })
    );
    // Site sem catálogo de creampie (ex.: TPB): usa a busca dele, se tiver.
    if (!entries.some((e) => catalogOrder(e) < 2)) {
      const searchable = [];
      site.addons.forEach((a) => addons.adultCatalogs(a).forEach((e) => addons.supportsSearch(e.catalog) && searchable.push(e)));
      if (searchable.length) {
        entries.unshift(Object.assign({}, searchable[0], { extra: { search: 'gay creampie' }, title: t('Creampie gay') }));
        entries.unshift(Object.assign({}, searchable[0], { extra: { search: 'creampie' }, title: t('Creampie hétero') }));
      }
    }
    const ordered = entries.map((e, i) => ({ e: e, i: i })).sort((a, b) => (a.e.extra ? (a.e.extra.search === 'creampie' ? 0 : 1) : catalogOrder(a.e)) - (b.e.extra ? (b.e.extra.search === 'creampie' ? 0 : 1) : catalogOrder(b.e)) || a.i - b.i);
    let genresDone = false;
    ordered.forEach((x) => {
      const isCreampie = x.e.extra || catalogOrder(x.e) < 2;
      // Categorias logo depois de Creampie: o atalho mais usado depois deles.
      if (!isCreampie && !genresDone) {
        genresDone = true;
        genreStrip(site, chips);
      }
      const p = Object.assign(catalogRow(x.e, body), { state: 'idle' });
      pending.push(p);
      chips.appendChild(h('div.chip', { focusable: true, text: x.e.title || catName(x.e), onSelect: () => jumpTo(p) }));
    });
    if (!genresDone) genreStrip(site, chips);
    if (scopes().some((f) => f.id === 'search')) chips.appendChild(h('div.chip', { focusable: true, html: ICON_SEARCH + t('Busca'), onSelect: () => pick('search', true) }));
    loadVisibleImages(el);
    loadNearby();
  }

  // Favoritos e Continuar assistindo, só com o que é deste site (refeito ao voltar dos detalhes).
  function renderPersonal(site, all, chips) {
    if (!personalSlot) return;
    clear(personalSlot);
    const mine = (id) => !!id && belongsTo(site, all, id);
    const lib = stremio.cachedLibrary().filter((it) => addons.isAdultId(it._id) && it.name && mine(it._id));
    const watching = lib
      .filter((it) => (!it.removed || it.temp) && it.state && it.state.timeOffset > 0)
      .sort((a, b) => String(b.state.lastWatched || '').localeCompare(String(a.state.lastWatched || '')));
    const favs = nsfwSaved.list().filter((it) => mine(it.id));
    lib.filter((it) => !it.removed && !it.temp && watching.indexOf(it) < 0 && !favs.some((f) => f.id === it._id)).forEach((it) =>
      favs.push({ id: it._id, type: it.type, name: it.name, poster: it.poster, posterShape: it.posterShape })
    );
    const rows = [];
    if (favs.length)
      rows.push(
        staticRow(
          '♥ ' + t('Favoritos'),
          t('{n} vídeo(s)', { n: favs.length }),
          favs.slice(0, 40).map((it) =>
            card(it, { wide: it.posterShape === 'landscape', rich: true, image: it.posterShape === 'landscape' ? it.poster : undefined, onSelect: () => openDetails(it.type, it.id, null, it) })
          )
        )
      );
    if (watching.length)
      rows.push(
        staticRow(
          t('Continuar assistindo'),
          '',
          watching.slice(0, ROW_LIMIT).map((it) => {
            const s = it.state;
            const left = s.duration ? Math.max(1, Math.round((s.duration - s.timeOffset) / 60000)) : 0;
            return card(
              { id: it._id, type: it.type, name: it.name, poster: it.poster },
              {
                wide: true,
                rich: true,
                image: it.background || it.poster,
                duration: left ? t('faltam {n} min', { n: left }) : '',
                progress: s.duration ? s.timeOffset / s.duration : 0,
                onSelect: () => openDetails(it.type, it._id, { videoId: s.video_id, autoStreams: true }, { name: it.name, poster: it.poster }),
              }
            );
          })
        )
      );
    if (chips) {
      const jumps = rows.map((r) =>
        h('div.chip', {
          focusable: true,
          text: r.title,
          onSelect: () => {
            const c = r.row.querySelector('.card');
            if (c) nav.focus(c);
          },
        })
      );
      jumps.reverse().forEach((j) => chips.insertBefore(j, chips.firstChild));
    }
    loadVisibleImages(personalSlot);
  }

  function staticRow(title, sub, cards) {
    const track = h('div.row-track', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' }, cards);
    const row = h('div.row', { 'data-anchor': '30' }, [h('div.row-title', null, [title, sub ? h('small', { text: sub }) : null]), track]);
    personalSlot.appendChild(row);
    return { row: row, title: title };
  }

  // Categorias do site (gêneros dos catálogos), sem repetir, como chips que abrem a grade.
  function genreStrip(site) {
    const seen = {};
    const chips = [];
    site.addons.forEach((a) =>
      addons.adultCatalogs(a).forEach((e) =>
        addons.genreOptions(e.catalog).forEach((g) => {
          if (seen[g] || tr.isHiddenCategory(g)) return;
          seen[g] = true;
          chips.push(h('div.chip', { focusable: true, text: tr.genre(g), onSelect: () => router.push(GridView(e, { genre: g })) }));
        })
      )
    );
    if (!chips.length) return;
    body.appendChild(
      h('div.row.nsfw-genres', { 'data-anchor': '30' }, [
        h('div.row-title', { text: t('Mais categorias') }),
        h('div.chip-track', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' }, chips),
      ])
    );
  }

  // Busca só nos catálogos adultos (a aba Buscar do app não mostra nada daqui).
  function renderSearch() {
    const generation = bodyToken;
    const isCurrent = () => alive && generation === bodyToken;
    const input = h('input.input', { type: 'text', placeholder: t('Buscar...'), focusable: true });
    const go = h('div.btn.primary.search-go', { focusable: true, text: t('Buscar'), onSelect: () => run(input.value) });
    const results = h('div.rows');
    input.__submit = (q) => run(q);
    body.appendChild(h('div.search-box', { 'data-group': '' }, [input, go]));
    body.appendChild(results);
    let token = 0;
    function run(q) {
      if (!isCurrent()) return;
      const my = ++token;
      resumeSearch = null;
      const query = (q || '').trim();
      clear(results);
      if (query.length < 2) return results.appendChild(h('div.hint', { text: t('Digite pelo menos 2 letras e aperte Buscar.') }));
      const cats = [];
      addons.adultAddons().forEach((a) => addons.adultCatalogs(a).forEach((e) => addons.supportsSearch(e.catalog) && cats.push(e)));
      let left = cats.length;
      let found = 0;
      let next = 0;
      let searching = 0;
      const light = store.settings().lowMemory !== false;
      if (!left) results.appendChild(h('div.hint', { text: t('Nenhum addon com busca instalado.') }));
      function fetchNext() {
        if (!isCurrent() || my !== token || el.offsetParent === null) return;
        while (next < cats.length && searching < (light ? 2 : 4)) fetchEntry(cats[next++]);
      }
      function fetchEntry(entry) {
        searching++;
        const track = h('div.row-track', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' });
        const row = h('div.row', { 'data-anchor': '30' }, [h('div.row-title', null, [catName(entry), h('small', { text: siteName(entry.addon) })]), track]);
        addons
          .fetchCatalog(entry, { search: query })
          .then((metas) => {
            if (!isCurrent() || my !== token || !metas.length) return;
            found++;
            metas.slice(0, light ? 12 : 30).forEach((m) => track.appendChild(itemCard(m, entry)));
            results.appendChild(row);
            loadVisibleImages(row);
          })
          .catch(() => {})
          .then(() => {
            searching--;
            if (--left === 0 && isCurrent() && my === token && !found) results.appendChild(h('div.hint', { text: t('Nada encontrado para "{q}".', { q: query }) }));
            fetchNext();
          });
      }
      resumeSearch = fetchNext;
      fetchNext();
    }
    nav.focus(input);
  }

  function render() {
    if (!alive) return;
    lastKey = providersKey();
    // O site do filtro pode ter sido desmarcado em Ajustes.
    if (!scopes().some((f) => f.id === scope)) scope = store.get('nsfwScope', null);
    renderFilters();
    renderBody();
  }

  body.appendChild(h('div.hint', { text: t('Carregando addons...') }));
  let ready = false;

  // Sem site: explica o porquê (o XVideos e o Pornhub vêm do serviço do Seraflix na TV).
  function emptyHint() {
    const st = addons.tubeStatus();
    if (st === 'searching') return t('Procurando os provedores no serviço da TV...');
    if (st === 'old') return t('O serviço da TV está numa versão antiga. Já pedi ao TizenBrew a versão nova; os provedores aparecem aqui em alguns segundos.');
    return t('O serviço do Seraflix na TV não respondeu. Abra o TizenBrew, confira se o Seraflix está na lista de serviços e abra o app de novo. Continuo procurando.');
  }

  // Sites que chegam depois (serviço da TV ligou atrasado) ou mudaram: refaz a aba.
  let lastKey = null;
  const providersKey = () => addons.tubeStatus() + '|' + addons.adultAddons().map((a) => a.manifest.id).join(',');
  const stopWatch = addons.onChange(() => {
    if (!alive || !ready || el.offsetParent === null) return;
    const key = providersKey();
    if (key === lastKey) return;
    const cur = nav.current();
    const hadFocus = cur && el.contains(cur);
    render();
    if (hadFocus) onRail();
  });

  const onRail = () => {
    const target = filters.querySelector('.provider.on') || filters.firstChild;
    if (target) nav.focus(target);
  };

  // Como em Streamings: ↓ da barra de cima vai para os sites, e ↑ do primeiro item do conteúdo volta para eles.
  function onKey(e) {
    const cur = nav.current();
    if (!cur || !filters.firstChild) return false;
    if (e.keyCode === KEY.DOWN && cur.closest('.topbar')) {
      onRail();
      return true;
    }
    if (e.keyCode === KEY.UP && body.contains(cur)) {
      const firstRow = body.querySelector('.chip, .card');
      const top = firstRow ? firstRow.getBoundingClientRect().top : 0;
      if (Math.abs(cur.getBoundingClientRect().top - top) < 10) {
        onRail();
        return true;
      }
    }
    return false;
  }

  return {
    el: el,
    onKey: onKey,
    onShow: () => {
      if (!alive) return;
      if (ready) {
        if (providersKey() !== lastKey) {
          render();
          onRail();
          return;
        }
        if (scope !== 'search') {
          const all = sites();
          const site = all.filter((s) => s.id === scope)[0];
          // Favoritos/Continuar mudam nos detalhes e no player: refaz só essa parte (sem mexer nos atalhos).
          if (site && personalSlot && !personalSlot.contains(nav.current())) renderPersonal(site, all, null);
        }
        return loadNearby();
      }
      if (loadingAddons) return;
      loadingAddons = true;
      addons.load().then(() => {
        if (!alive) return;
        loadingAddons = false;
        ready = true;
        if (el.offsetParent === null) return;
        render();
        onRail(); // a aba abre com o site atual em foco
      }).catch(() => {
        loadingAddons = false;
        if (!alive) return;
        clear(body);
        body.appendChild(h('div.hint', { text: t('Não foi possível carregar os addons.') }));
      });
    },
    onHide: () => clearTimeout(switchTimer),
    onScroll: () => loadNearby(),
    destroy: () => {
      alive = false;
      releaseBody();
      stopWatch();
      clearTimeout(switchTimer);
      if (bar.__destroy) bar.__destroy();
    },
  };
}

// Nome do catálogo em português ("Top Rated" → "Mais bem avaliados").
function catName(entry) {
  return entry.title || tr.genre(entry.catalog.name || entry.catalog.id);
}

function catalogRow(entry, parent) {
  let alive = true;
  const row = h('div.row', { 'data-anchor': '30' });
  const sub = entry.extra && entry.extra.search ? t('busca no {site}', { site: siteName(entry.addon) }) : /creampie/i.test(entry.catalog.name || '') ? t('mais vistos') : siteName(entry.addon);
  const track = h('div.row-track.pending', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' }, skeletonCards());
  row.appendChild(h('div.row-title', null, [catName(entry), h('small', { text: sub })]));
  row.appendChild(track);
  parent.appendChild(row);
  const out = { row: row };
  const load = () =>
    retrying(() => alive ? addons.fetchCatalog(entry, entry.extra) : Promise.resolve([]))
      .then((metas) => {
        if (!alive) return;
        clear(track);
        track.classList.remove('pending');
        if (!metas.length) {
          if (row.parentNode) row.parentNode.removeChild(row);
          return;
        }
        const limit = store.settings().lowMemory !== false ? 12 : ROW_LIMIT;
        metas.slice(0, limit).forEach((m) => track.appendChild(itemCard(m, entry)));
        if (metas.length > limit)
          track.appendChild(
            h('div.card.see-all', { focusable: true, onSelect: () => router.push(GridView(entry, entry.extra || {})) }, [
              h('div.poster-wrap', null, h('div.see-all-label', null, [h('b', { text: t('Ver tudo') }), h('span', { text: catName(entry) })])),
            ])
          );
        loadVisibleImages(row);
        if (out.wantFocus && track.firstChild) nav.focus(track.firstChild);
      })
      .catch(() => alive && showRetry(track, () => load()));
  out.load = load;
  out.destroy = () => { alive = false; clear(track); };
  return out;
}

// Grade com o catálogo inteiro (opcionalmente filtrado por categoria ou busca), paginada pelo "skip".
// Nas categorias de hentai, um subfiltro separa os títulos "uncensored" dos demais.
const UNCENSORED_FILTERS = [
  { id: 'all', label: 'Todos' },
  { id: 'uncensored', label: 'Só uncensored' },
  { id: 'censored', label: 'Sem uncensored' },
];
const FILTER_KEEP = {
  all: () => true,
  uncensored: (m) => isUncensored(m),
  censored: (m) => !isUncensored(m),
};

function GridView(entry, extra) {
  const el = h('div.view.nsfw-view', { 'data-stay': '' });
  const scroller = h('div.scroll-y', { 'data-scroll-y': '' });
  const crumb = [h('span', { text: 'NSFW › ' + siteName(entry.addon) }), ' › ', h('b', { text: extra.genre ? tr.genre(extra.genre) : catName(entry) })];
  const isHentai = /hentai/i.test((extra.genre || '') + ' ' + catName(entry));
  const slot = h('div');
  let mode = 'all';
  let pg = null;
  let alive = true;
  let generation = 0;

  // Busca uma página do catálogo; no filtro, junta páginas até ter o bastante (ou o catálogo acabar).
  function fetcher(my) {
    let skip = 0;
    const keep = FILTER_KEEP[mode];
    return function load() {
      const got = [];
      const step = (tries) => {
        if (!alive || my !== generation) return Promise.resolve([]);
        return addons.fetchCatalog(entry, Object.assign({ skip: skip || undefined }, extra)).then((metas) => {
          if (!alive || my !== generation) return [];
          skip += metas.length;
          metas.forEach((m) => keep(m) && got.push(m));
          if (!metas.length || got.length >= 20 || tries >= 5) return got;
          return step(tries + 1);
        });
      };
      return step(0);
    };
  }

  function build() {
    const my = ++generation;
    if (pg && pg.destroy) pg.destroy();
    const load = fetcher(my);
    pg = pagedGrid({
      load: load,
      key: (m) => m.id,
      card: (m) => itemCard(m, entry),
      onEmpty: () => {
        if (alive && my === generation) pg.el.insertBefore(h('div.hint', { text: t('Nada por aqui.') }), pg.el.firstChild);
      },
    });
    clear(slot);
    slot.appendChild(pg.el);
  }

  scroller.appendChild(h('div.reco-crumb', null, crumb));
  if (isHentai) {
    const chips = UNCENSORED_FILTERS.map((f) =>
      h('div.chip', {
        focusable: true,
        text: t(f.label),
        onSelect: () => {
          if (f.id === mode) return;
          mode = f.id;
          chips.forEach((c, i) => c.classList.toggle('active', UNCENSORED_FILTERS[i].id === mode));
          build();
          pg.start();
        },
      })
    );
    chips.forEach((c, i) => c.classList.toggle('active', UNCENSORED_FILTERS[i].id === mode));
    scroller.appendChild(h('div.row.nsfw-genres', { 'data-anchor': '30' }, [h('div.chip-track', { 'data-scroll-x': '', 'data-group': '', 'data-trap': '' }, chips)]));
  }
  build();
  scroller.appendChild(slot);
  el.appendChild(scroller);
  return {
    el: el,
    onShow: () => pg.start(),
    destroy: () => {
      alive = false;
      generation++;
      if (pg && pg.destroy) pg.destroy();
      pg = null;
      clear(slot);
    },
  };
}
