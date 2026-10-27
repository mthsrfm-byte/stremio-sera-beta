// Ajustes: conta, servidor do PC, Hero Banner, tema, legendas, addons e depuração.
import { h, clear } from '../lib/dom.js';
import * as nav from '../lib/nav.js';
import * as store from '../lib/store.js';
import { log } from '../lib/log.js';
import { deviceInfo } from '../lib/tv.js';
import { IS_WEB } from '../lib/platform.js';
import * as substyle from '../lib/substyle.js';
import * as update from '../api/update.js';
import * as phoneRemote from '../api/phoneRemote.js';
import * as stremio from '../api/stremio.js';
import * as server from '../api/server.js';
import * as addons from '../api/addons.js';
import * as hero from '../api/hero.js';
import * as extras from '../api/extras.js';
import * as calendar from '../api/calendar.js';
import * as reco from '../api/recommend.js';
import * as intro from '../lib/intro.js';
import * as screensaver from '../lib/screensaver.js';
import { getJSON, recentErrors } from '../lib/http.js';
import { topbar, toast, menu, confirmDialog, refreshProfileChips, refreshTabs } from '../ui.js';
import * as router from '../router.js';
import { openLogin } from './login.js';
import { avatar, switchProfile, createProfile } from './profiles.js';
import { t } from '../lib/i18n.js';
import * as pinLock from './pin.js';
import { themeOf, applyTheme } from '../lib/theme.js';

const SUB_LANGS = [
  { label: 'Português (BR) e Português', value: ['pob', 'por', 'pt', 'pt-br'] },
  { label: 'Inglês', value: ['eng', 'en'] },
  { label: 'Espanhol', value: ['spa', 'es'] },
  { label: 'Nenhum (não ligar sozinho)', value: [] },
];
const AUDIO_LANGS = [
  { label: 'Original do arquivo', value: [] },
  { label: 'Português (dublado) quando houver', value: ['por', 'pt', 'pob'] },
  { label: 'Inglês quando houver', value: ['eng', 'en'] },
  { label: 'Japonês quando houver', value: ['jpn', 'ja'] },
];

// Addons úteis que o app aproveita (Anime Kitsu: catálogos de anime e IDs do calendário/AniSkip).
const RECOMMENDED = [
  { id: 'community.anime.kitsu', name: 'Anime Kitsu', url: 'https://anime-kitsu.strem.fun/manifest.json', desc: 'Catálogos e detalhes de animes (usado pelo calendário)' },
  { id: 'org.stremio.opensubtitlesv3', name: 'OpenSubtitles v3', url: 'https://opensubtitles-v3.strem.io/manifest.json', desc: 'Legendas em português para quase tudo' },
];

export function SettingsView() {
  const el = h('div.view');
  const scroller = h('div.scroll-y', { 'data-scroll-y': '' });
  const bar = topbar('settings', router.goTab);
  const body = h('div.settings');
  scroller.appendChild(bar);
  scroller.appendChild(body);
  el.appendChild(scroller);

  let device = '';
  deviceInfo()
    .then((d) => {
      device = [d.modelName, d.firmwareVersion].filter(Boolean).join(' · ');
    })
    .catch(() => {});

  function row(label, sub, value, onSelect, extra) {
    return h('div.set-row', { focusable: true, onSelect: onSelect }, [
      h('div.label', null, [label, sub ? h('small', { text: sub }) : null]),
      extra || h('div.value', { text: value || '' }),
    ]);
  }

  // QR code do controle pelo celular, grande no meio da tela.
  function showPhoneRemote() {
    toast(t('Gerando o QR code...'));
    phoneRemote
      .remoteUrl()
      .then((url) => {
        const box = h('div.modal-box.center.qr-box', null, [
          h('h3', { text: t('Controle no celular') }),
          h('p.modal-text', { text: t('Aponte a câmera do celular (na mesma Wi-Fi) para o código. O controle abre direto, sem digitar nada.') }),
          h('img.qr-big', { src: phoneRemote.qrDataUrl(url, 10), alt: url }),
          h('p.qr-url', { text: url }),
          h('div.modal-actions', null, [h('div.btn.primary', { focusable: true, 'data-autofocus': '', text: t('Fechar'), onSelect: () => close() })]),
        ]);
        const modal = h('div.modal', null, box);
        document.getElementById('app').appendChild(modal);
        const layer = nav.pushLayer(modal, { onBack: () => close() });
        nav.focusFirst(modal);
        function close() {
          nav.popLayer(layer);
          if (modal.parentNode) modal.parentNode.removeChild(modal);
        }
      })
      .catch(() => toast(t('Não consegui descobrir o IP da TV. Veja em Configurações → Geral → Rede.'), 6000));
  }

  // Diagnóstico de rede: testa cada servidor que o app usa e mostra os últimos erros.
  function showNetworkCheck() {
    const list = h('div.diag-list');
    const box = h('div.modal-box.center.diag-box', null, [
      h('h3', { text: t('Teste de conexão') }),
      h('p.modal-text', { text: t(IS_WEB ? 'Relógio deste aparelho: {now}' : 'Relógio da TV: {now}', { now: new Date().toLocaleString('pt-BR') }) }),
      list,
      h('div.modal-actions', null, [h('div.btn.primary', { focusable: true, 'data-autofocus': '', text: t('Fechar'), onSelect: () => close() })]),
    ]);
    const modal = h('div.modal', null, box);
    document.getElementById('app').appendChild(modal);
    const layer = nav.pushLayer(modal, { onBack: () => close() });
    nav.focusFirst(modal);
    function close() {
      nav.popLayer(layer);
      if (modal.parentNode) modal.parentNode.removeChild(modal);
    }
    function line(name) {
      const res = h('span.diag-res', { text: t('testando...') });
      list.appendChild(h('div.diag-line', null, [h('span.diag-name', { text: name }), res]));
      return res;
    }
    function test(name, run) {
      const res = line(name);
      const t0 = Date.now();
      return run().then(
        () => {
          res.textContent = '✓ ' + (Date.now() - t0) + ' ms';
          res.className = 'diag-res ok';
        },
        (e) => {
          res.textContent = '✗ ' + (e.timeout ? t('tempo esgotado') : e.status ? 'HTTP ' + e.status : t('falha de rede')) + ' (' + (Date.now() - t0) + ' ms)';
          res.className = 'diag-res bad';
        }
      );
    }
    const image = (src) =>
      new Promise((ok, fail) => {
        const im = new Image();
        im.onload = ok;
        im.onerror = () => fail({ status: 0 });
        im.src = src + '?t=' + Date.now();
      });
    const tests = [
      [t('TMDB (fileiras e busca de títulos)'), () => extras.tmdbPing()],
      [t('Imagens do TMDB (pôsteres)'), () => image('https://image.tmdb.org/t/p/w92/rK1KljqmbvO9HQa1PBFLILWah72.png')],
      [t('Cinemeta (detalhes dos títulos)'), () => getJSON('https://v3-cinemeta.strem.io/manifest.json', { timeout: 10000, quiet: true })],
    ];
    addons.list().forEach((a) => {
      if (!/^https?:/.test(a.transportUrl || '') || /cinemeta/.test(a.transportUrl)) return;
      tests.push([t('Addon: {name}', { name: a.manifest.name || a.manifest.id }), () => getJSON(a.transportUrl, { timeout: 10000, quiet: true })]);
    });
    // Um por vez: assim o tempo de cada um é o dele mesmo.
    tests
      .reduce((p, x) => p.then(() => test(x[0], x[1])), Promise.resolve())
      .then(() => {
        const errs = recentErrors();
        list.appendChild(h('div.diag-head', { text: errs.length ? t('Últimos erros do app') : t('Nenhum erro de rede registrado desde que o app abriu.') }));
        errs.slice(0, 8).forEach((e) => {
          const ago = Math.round((Date.now() - e.at) / 60000);
          list.appendChild(h('div.diag-err', { text: e.msg + ' · ' + e.ms + ' ms · ' + t('há {n} min', { n: ago }) + ' · ' + e.url.slice(0, 70) }));
        });
      });
  }

  let updateStatus = '';

  function checkForUpdate() {
    toast(t('Procurando atualização...'));
    update
      .check()
      .then((info) => {
        const when = update.formatDate(info.date);
        if (!info.isNew) {
          updateStatus = t('Tudo em dia. Última publicada em {date}', { date: when });
          render();
          return toast(t('Você já está na versão mais nova.'));
        }
        updateStatus = t('Versão nova de {date} disponível', { date: when });
        render();
        menu(
          t('Atualização disponível'),
          [
            {
              label: t('Instalar agora'),
              sub: t('Publicada em {date}', { date: when }) + (info.message ? ' · ' + info.message : '') + ' · ' + update.shortCommit(info.commit),
              value: 'install',
            },
            { label: t('Agora não'), value: 'later' },
          ],
          {
            center: true,
            onPick: (v) => {
              if (v !== 'install') return;
              toast(t('Atualizando... já volto!'), 8000);
              update.install(info);
            },
          }
        );
      })
      .catch((e) => toast(t('Não foi possível verificar: {msg}', { msg: e.message }), 5000));
  }

  function installFromUrl(url, name) {
    if (!stremio.isLoggedIn()) return toast(t('Entre na conta primeiro'));
    confirmDialog(t('Instalar {name} na sua conta Stremio?', { name: name }), t('Instalar'), () => {
      toast(t('Instalando...'));
      stremio
        .installAddon(url)
        .then((m) => addons.load(true).then(() => m))
        .then((m) => {
          router.dropTab('home');
          toast(t('{name} instalado na sua conta', { name: m.name || 'Addon' }));
          render();
        })
        .catch((e) => toast(t('Não foi possível instalar: {msg}', { msg: e.message }), 5000));
    });
  }

  // NSFW: a aba própria (por perfil) e quais addons contam como adultos.
  function nsfwSection(list) {
    const s = store.settings();
    const adult = list.filter(addons.isAdult);
    // Mexer nas opções NSFW também pede o PIN (uma vez por sessão).
    const guarded = (fn) => () => pinLock.requirePin(fn);
    body.appendChild(
      row(t('Mostrar aba NSFW'), t('Conteúdo adulto fica só nela, fora do Início, Busca e Biblioteca'), '', guarded(() => {
        store.saveSettings({ nsfwTab: store.settings().nsfwTab === false });
        refreshTabs();
        router.dropTab('nsfw');
        render();
      }), toggle(s.nsfwTab !== false))
    );
    const pinInput = h('input.input', { type: 'password', placeholder: t('Novo PIN (4 a 8 números)') });
    pinInput.__submit = (v) => {
      const p = v.trim();
      if (!/^\d{4,8}$/.test(p)) return toast(t('O PIN precisa ter de 4 a 8 números'));
      store.saveSettings({ nsfwPin: p });
      pinInput.value = '';
      toast(t('PIN da aba NSFW trocado'));
    };
    body.appendChild(
      h('div.set-row', { focusable: true, onSelect: guarded(() => nav.select(pinInput)) }, [
        h('div.label', null, [t('PIN da aba NSFW'), h('small', { text: t('Pedido ao entrar na aba; vale até o app fechar ou ir para segundo plano') })]),
        pinInput,
      ])
    );
    body.appendChild(
      row(t('Addons adultos'), t('Detectados sozinhos; marque ou desmarque à mão'), adult.length ? t('{n} addon(s)', { n: adult.length }) : t('nenhum'), guarded(() =>
        menu(
          t('Addons adultos'),
          list.map((a) => ({ label: a.manifest.name || a.manifest.id, sub: addons.adultByManifest(a) ? t('Detectado como adulto') : '', value: a.manifest.id, checked: addons.isAdult(a) })),
          {
            onPick: (id) => {
              const a = list.filter((x) => x.manifest.id === id)[0];
              const cur = store.settings();
              const without = (arr) => (arr || []).filter((x) => x !== id);
              const nowAdult = !addons.isAdult(a);
              // Marca à mão só o que difere da detecção automática.
              const auto = addons.adultByManifest(a);
              store.saveSettings({
                nsfwAddons: nowAdult && !auto ? without(cur.nsfwAddons).concat(id) : without(cur.nsfwAddons),
                sfwAddons: !nowAdult && auto ? without(cur.sfwAddons).concat(id) : without(cur.sfwAddons),
              });
              router.dropTab('home');
              router.dropTab('nsfw');
              refreshTabs();
              render();
            },
          }
        )
      ))
    );
  }

  // Teste do serviço da TV (remote/tv-service.js): cada item com ✓/✗ e um veredito no fim.
  function torrentTest() {
    toast(t('Testando a TV... leva até 40 segundos'), 6000);
    getJSON('http://127.0.0.1:8094/api/torrent-test', { timeout: 45000, quiet: true })
      .then((r) => {
        const yes = (ok) => (ok ? '✓ ' : '✗ ');
        const nodeMajor = parseInt(String(r.node || 'v0').slice(1), 10) || 0;
        const available = typeof r.memAvailableMB === 'number' ? r.memAvailableMB : null;
        const disk = r.disk || {};
        const writable = Object.keys(disk).filter((d) => disk[d] === true);
        const lines = [
          { label: yes(nodeMajor >= 12) + 'Node ' + r.node, sub: nodeMajor >= 12 ? t('Compatível com o motor experimental da beta') : t('O motor desta beta precisa de Node 12 ou mais recente') },
          { label: t('Memória livre: {n} MB', { n: r.memFreeMB }), sub: t('de {n} MB · {c} núcleos', { n: r.memTotalMB, c: r.cpus }) },
          { label: available === null ? t('Memória disponível: não informada pelo sistema') : t('Memória disponível: {n} MB', { n: available }), sub: t('Inclui cache que o sistema pode recuperar; não garante estabilidade') },
          { label: t('Processo do serviço: {n} MB', { n: r.processRssMB || 0 }), sub: t('Memória do processo compartilhado com o TizenBrew') },
          { label: yes(r.udp && r.udp.ok) + t('UDP (trackers e DHT)'), sub: r.udp && r.udp.ok ? r.udp.ms + ' ms' : (r.udp && r.udp.why) || '-' },
          { label: yes(r.tcp && r.tcp.ok) + t('TCP de saída (peers)'), sub: r.tcp && r.tcp.ok ? r.tcp.ms + ' ms' : (r.tcp && r.tcp.why) || '-' },
          { label: yes(r.speed && r.speed.ok) + t('Download: {n} Mbps', { n: (r.speed && r.speed.mbps) || 0 }), sub: r.speed && r.speed.ok ? t('{mb} MB em {s} s', { mb: r.speed.MB, s: r.speed.s }) : (r.speed && r.speed.why) || '-' },
          { label: yes(writable.length > 0) + t('Gravar no disco'), sub: writable.length ? writable.join(', ') : t('nenhuma pasta gravável') },
        ];
        const viable = nodeMajor >= 12 && r.tcp && r.tcp.ok;
        lines.push({ label: viable ? t('Condições básicas presentes: teste a reprodução') : t('Há limitações de versão ou rede a verificar'), sub: t('Este diagnóstico não baixa um torrent real nem garante reprodução estável.') });
        log.info('Teste de torrent na TV', JSON.stringify(r));
        menu(t('Torrent na TV'), lines, {});
      })
      .catch(() => toast(t('O serviço da TV não respondeu. Abra o Seraflix pelo TizenBrew e tente de novo.'), 6000));
  }

  function toggle(on) {
    return h('div.toggle', { cls: on ? 'on' : '' }, h('i'));
  }

  function render() {
    const s = store.settings();
    const keep = nav.current();
    const keepIndex = keep ? Array.prototype.indexOf.call(body.querySelectorAll('.set-row'), keep) : -1;
    clear(body);

    // ---- Atualizações (direto do GitHub, sem fechar o app; na web o site já é atualizado sozinho) ----
    if (!IS_WEB) {
      body.appendChild(h('div.set-section', { text: t('Atualizações') }));
      body.appendChild(row(t('Procurar atualização'), updateStatus || t('Busca a versão mais nova no GitHub ({repo})', { repo: update.REPO }), '', () => checkForUpdate()));
      const b = update.BUILD;
      body.appendChild(
        row(
          t('Versão instalada'),
          b.date ? t('Publicada em {date}', { date: update.formatDate(b.date) }) + (b.message ? ' · ' + b.message : '') : t('Build local'),
          'v' + update.VERSION + (b.commit ? ' · ' + update.shortCommit(b.commit) : ''),
          null
        )
      );
    }
    if (device && !IS_WEB) body.appendChild(row(t('TV'), '', device, null));

    // ---- Perfil (cada perfil tem sua conta Stremio, histórico e preferências) ----
    const prof = store.activeProfile();
    const allProfiles = store.profiles();
    body.appendChild(h('div.set-section', { text: t('Perfil') }));
    const nameInput = h('input.input', { type: 'text', value: prof.name });
    nameInput.__submit = (v) => {
      const name = v.trim();
      if (!name) return;
      store.updateProfile(prof.id, { name: name });
      refreshProfileChips();
      toast(t('Nome do perfil salvo'));
      render();
    };
    body.appendChild(
      h('div.set-row', { focusable: true, onSelect: () => nav.select(nameInput) }, [
        h('div.label', null, [avatar(prof, 'small'), ' ' + t('Nome do perfil'), h('small', { text: t('Este perfil usa a conta Stremio abaixo') })]),
        nameInput,
      ])
    );
    body.appendChild(
      row(t('Cor do perfil'), '', '', () =>
        menu(
          t('Cor do perfil'),
          store.COLORS.map((c, i) => ({ label: [t('Roxo'), t('Rosa'), t('Verde-água'), t('Laranja'), t('Azul'), t('Vermelho'), t('Verde'), t('Cinza')][i], value: c, checked: c === prof.color })),
          {
            onPick: (c) => {
              store.updateProfile(prof.id, { color: c });
              refreshProfileChips();
              render();
            },
          }
        ),
        h('div.avatar.small', { style: { backgroundColor: prof.color }, text: ' ' })
      )
    );
    if (allProfiles.length > 1) {
      body.appendChild(
        row(t('Trocar de perfil'), t('{n} perfis nesta TV', { n: allProfiles.length }), '', () =>
          menu(
            t('Trocar de perfil'),
            allProfiles.map((p) => ({ label: p.name, value: p.id, checked: p.id === prof.id })),
            { onPick: (id) => id !== prof.id && switchProfile(id) }
          )
        )
      );
    }
    body.appendChild(row(t('Adicionar perfil'), t('Para outra pessoa, com outra conta Stremio'), '', () => createProfile()));
    if (allProfiles.length > 1) {
      body.appendChild(
        row(t('Perguntar "Quem está assistindo?" ao abrir'), '', '', () => {
          store.saveSettings({ askProfile: !store.settings().askProfile });
          render();
        }, toggle(s.askProfile))
      );
      body.appendChild(
        row(t('Apagar este perfil'), t('Remove deste aparelho a conta e as preferências do perfil (a conta Stremio continua existindo)'), '', () =>
          confirmDialog(t('Apagar o perfil "{name}" desta TV?', { name: prof.name }), t('Apagar'), () => {
            store.removeProfile(prof.id);
            switchProfile(store.activeProfile().id);
          })
        )
      );
    }

    body.appendChild(h('div.set-section', { text: t('Conta Stremio') }));
    if (stremio.isLoggedIn()) {
      const u = stremio.user();
      body.appendChild(row(t('Conectado'), t('Addons e biblioteca sincronizados com a conta'), (u && u.email) || t('conta Stremio'), null));
      body.appendChild(
        row(t('Atualizar addons e biblioteca'), t('Busca de novo a lista de addons instalados'), '', () => {
          Promise.all([addons.load(true), stremio.getLibrary()])
            .then(() => {
              toast(t('Atualizado'));
              router.dropTab('home');
            })
            .catch((e) => toast(t('Erro: {msg}', { msg: e.message })));
        })
      );
      body.appendChild(
        row(t('Sair da conta'), '', '', () =>
          confirmDialog(t('Sair da conta Stremio?'), t('Sair'), () => {
            stremio.logout();
            addons.load(true).then(() => {
              router.dropTab('home');
              render();
            });
          })
        )
      );
    } else {
      body.appendChild(
        row(t('Entrar na conta'), t('Traz seus addons (Torrentio, debrid...) e a biblioteca'), '', () =>
          openLogin(() => {
            Promise.all([stremio.refreshUser().catch(() => {}), addons.load(true), stremio.getLibrary()]).then(() => {
              router.dropTab('home');
              render();
            });
          })
        )
      );
    }

    body.appendChild(h('div.set-section', { text: t('Seraflix Beta') }));
    body.appendChild(row(t('Modo leve'), t('Reduz imagens, buffers e carregamentos; desliga trailers automáticos. Ativo por padrão nesta beta.'), '', () => {
      const light = s.lowMemory === false;
      store.saveSettings({ lowMemory: light });
      document.body.classList.toggle('low-memory', light);
      ['home', 'recommended', 'streamings', 'search', 'library', 'nsfw'].forEach((id) => router.dropTab(id));
      render();
    }, toggle(s.lowMemory !== false)));
    if (!IS_WEB) {
      body.appendChild(row(t('Torrent na própria TV (experimental)'), t('Um torrent por vez, sem Mac e sem debrid. O formato do vídeo e do áudio precisa ser compatível com a Samsung.'), '', () => {
        store.saveSettings({ nativeTorrent: s.nativeTorrent === false });
        render();
      }, toggle(s.nativeTorrent !== false)));
      body.appendChild(row(t('Estado do torrent local'), t('Mostra peers, cache e memória do motor; nenhum vídeo é iniciado por este botão.'), '', () => {
        server.nativeStatus().then((r) => menu(t('Torrent local'), [
          { label: r.supported === false ? t('Versão do Node incompatível') : t('Motor disponível'), sub: r.error || r.state || '' },
          { label: t('Peers: {n}', { n: r.peers || 0 }), sub: r.file || r.filename || '' },
          { label: t('Cache: {n} MB', { n: Math.round((r.cacheBytes || 0) / 1048576) }), sub: t('O cache tem limite; isso não é o consumo total do processo.') },
          { label: t('Memória do serviço: {n} MB', { n: r.processRssMB || 0 }), sub: t('Para o diagnóstico completo, use o teste abaixo.') },
        ], {})).catch(() => toast(t('Abra a beta pelo TizenBrew para iniciar o serviço da TV.'), 6000));
      }));
    }
    body.appendChild(h('div.set-section', { text: t('Servidor externo (opcional)') }));
    const st = server.lastStatus();
    const stText = !s.serverUrl ? t('não configurado') : st.ok && st.url === server.baseUrl() ? t('conectado ✓') : t('sem resposta');
    const urlInput = h('input.input', { type: 'text', value: s.serverUrl || '', placeholder: 'ex.: 192.168.0.10' });
    urlInput.__submit = (v) => {
      store.saveSettings({ serverUrl: v.trim() });
      server.check().then((r) => {
        toast(r.ok ? t('Servidor conectado') : t('Servidor não respondeu em {url}', { url: server.baseUrl() }));
        render();
      });
    };
    body.appendChild(
      h('div.set-row', { focusable: true, onSelect: () => nav.select(urlInput) }, [
        h('div.label', null, [t('Endereço do PC'), h('small', { text: t('Rode o stremio-service no PC (porta 11470). Status: {s}', { s: stText }) })]),
        urlInput,
      ])
    );
    body.appendChild(
      row(t('Procurar na rede'), t('Varre a rede local atrás do servidor'), '', () => {
        toast(t('Procurando servidor na rede...'), 20000);
        server
          .scan()
          .then((ip) => {
            if (!ip) return toast(t('Nenhum servidor encontrado. Ele está aberto no PC?'));
            store.saveSettings({ serverUrl: ip });
            return server.check().then(() => {
              toast(t('Servidor encontrado em {ip}', { ip: ip }));
              render();
            });
          })
          .catch((e) => toast(t('Falha na busca: {msg}', { msg: e.message })));
      })
    );
    body.appendChild(
      row(t('Testar conexão'), '', '', () =>
        server.check().then((r) => {
          toast(r.ok ? t('Servidor OK') + (r.version ? ' (v' + r.version + ')' : '') : t('Sem resposta de {url}', { url: server.baseUrl() || '-' }));
          render();
        })
      )
    );
    if (!IS_WEB) body.appendChild(row(t('Testar torrent na TV (sem o PC)'), t('Mede se a própria TV aguenta baixar torrent: Node, memória, rede e disco'), '', () => torrentTest()));

    body.appendChild(h('div.set-section', { text: t('Aparência (Kai)') }));
    const heroName = t((hero.SOURCES.find((x) => x.id === s.heroSource) || hero.SOURCES[0]).name);
    body.appendChild(
      row(t('Hero Banner'), t('Destaques no topo da tela inicial'), heroName, () =>
        menu(
          t('Fonte do Hero Banner'),
          hero.SOURCES.map((x) => ({ label: t(x.name), value: x.id, checked: x.id === s.heroSource })),
          {
            onPick: (v) => {
              store.saveSettings({ heroSource: v });
              router.dropTab('home');
              render();
            },
          }
        )
      )
    );
    body.appendChild(
      row(t('Modo claro'), t('Creme de dia, escuro de noite'), '', () => {
        store.saveSettings({ theme: themeOf(store.settings()) === 'light' ? 'dark' : 'light' });
        applyTheme(store.settings());
        render();
      }, toggle(themeOf(s) === 'light'))
    );
    body.appendChild(
      row(t('Rolagem animada'), t('Mais bonita, porém mais pesada na TV'), '', () => {
        const on = !store.settings().smoothScroll;
        store.saveSettings({ smoothScroll: on });
        nav.setSmooth(on);
        render();
      }, toggle(s.smoothScroll))
    );
    const ssMin = screensaver.minutes();
    body.appendChild(
      row(t('Protetor de tela'), t(IS_WEB ? 'Os lançamentos passando na tela quando você fica sem mexer' : 'Os lançamentos passando na tela quando o controle fica parado'), ssMin ? t('{n} min', { n: ssMin }) : t('Desligado'), () =>
        menu(
          t('Protetor de tela'),
          screensaver.OPTIONS.map((m) => ({ label: m ? t('Depois de {n} min parado', { n: m }) : t('Desligado'), value: m, checked: m === ssMin })).concat([
            { label: t('Ver agora'), sub: t('Mostra o protetor de tela já'), value: 'now' },
          ]),
          {
            onPick: (v) => {
              if (v === 'now') return setTimeout(() => screensaver.start(), 300);
              store.saveSettings({ screensaver: v });
              screensaver.arm();
              render();
            },
          }
        )
      )
    );
    body.appendChild(
      row(t('Som de abertura'), t('O clique com acorde quando o Seraflix abre'), '', () => {
        const on = store.settings().introSound === false;
        store.saveSettings({ introSound: on });
        if (on) intro.playSound(); // toca para você ouvir
        render();
      }, toggle(s.introSound !== false))
    );

    body.appendChild(h('div.set-section', { text: t('Reprodução') }));
    body.appendChild(
      row(t('Smart Choice'), t('Ao escolher um episódio, já abre a melhor fonte: original + dublado, boa qualidade e bem semeada'), '', () => {
        store.saveSettings({ smartChoice: store.settings().smartChoice === false });
        render();
      }, toggle(s.smartChoice !== false))
    );

    body.appendChild(h('div.set-section', { text: t('Legendas e áudio') }));
    const subName = (SUB_LANGS.find((x) => JSON.stringify(x.value) === JSON.stringify(s.subtitleLangs)) || { label: (s.subtitleLangs || []).join(', ') }).label;
    body.appendChild(
      row(t('Idioma da legenda'), t('Escolhida sozinha ao abrir o vídeo'), t(subName), () =>
        menu(t('Idioma da legenda'), SUB_LANGS.map((x) => ({ label: t(x.label), value: x.value, checked: x.label === subName })), {
          onPick: (v) => {
            store.saveSettings({ subtitleLangs: v });
            render();
          },
        })
      )
    );
    body.appendChild(
      row(t('Ligar legenda automaticamente'), t('Se o áudio não estiver no seu idioma'), '', () => {
        store.saveSettings({ subtitlesAuto: !store.settings().subtitlesAuto });
        render();
      }, toggle(s.subtitlesAuto))
    );
    const audName = (AUDIO_LANGS.find((x) => JSON.stringify(x.value) === JSON.stringify(s.audioLangs)) || AUDIO_LANGS[0]).label;
    body.appendChild(
      row(t('Áudio preferido'), t('Precisa do servidor do PC para ler as faixas'), t(audName), () =>
        menu(t('Áudio preferido'), AUDIO_LANGS.map((x) => ({ label: t(x.label), value: x.value, checked: x.label === audName })), {
          onPick: (v) => {
            store.saveSettings({ audioLangs: v });
            render();
          },
        })
      )
    );

    // ---- Aparência da legenda (padrão Kai: Nata Sans, negrito, contorno fino + sombra) ----
    body.appendChild(h('div.set-section', { text: t('Aparência da legenda') }));
    const preview = h('div.subs', null, h('span', { html: t('Oi. Meu nome é Peter Parker.') + '\n<i>' + t('Você não lembra de mim...') + '</i>' }));
    substyle.apply(preview, s);
    body.appendChild(h('div.sub-preview', null, preview));
    const lb = substyle.labels(s);
    const choose = (title, sub, list, key, value, label) =>
      body.appendChild(
        row(title, sub, t(String(label)), () =>
          menu(title, list.map((x) => ({ label: t(String(x.label)), value: x.id, checked: x.id === value })), {
            onPick: (v) => {
              const patch = {};
              patch[key] = v;
              store.saveSettings(patch);
              render();
            },
          })
        )
      );
    choose(t('Fonte'), t('Vale para legendas de addons (OpenSubtitles etc.)'), substyle.FONTS, 'subtitleFont', s.subtitleFont, lb.font);
    choose(t('Estilo'), t('Contorno, sombra ou caixa de fundo'), substyle.STYLES, 'subtitleStyle', s.subtitleStyle, lb.style);
    choose(t('Cor do texto'), '', substyle.COLORS, 'subtitleColor', s.subtitleColor, lb.color);
    choose(
      t('Tamanho'),
      '',
      substyle.SIZES.map((v) => ({ id: v, label: v + '%' })),
      'subtitleSize',
      s.subtitleSize || 100,
      (s.subtitleSize || 100) + '%'
    );
    choose(t('Posição'), t('Distância da borda de baixo'), substyle.POSITIONS, 'subtitlePosition', s.subtitlePosition, lb.position);
    body.appendChild(
      row(t('Negrito'), t('O Kai usa negrito'), '', () => {
        store.saveSettings({ subtitleBold: store.settings().subtitleBold === false });
        render();
      }, toggle(s.subtitleBold !== false))
    );
    body.appendChild(
      h('div.hint', { style: { padding: '6px 4px 0' }, text: t('Legendas embutidas no arquivo são desenhadas pela própria TV: só cor, tamanho, posição e caixa se aplicam a elas.') })
    );

    // ---- Player ----
    body.appendChild(h('div.set-section', { text: t('Player') }));
    choose(
      t('Pular abertura e encerramento'),
      t('IntroDB (séries e filmes) e AniSkip (animes)'),
      [
        { id: 'prompt', label: t('Mostrar botão "Pular"') },
        { id: 'auto', label: t('Pular automaticamente') },
        { id: 'off', label: t('Desligado') },
      ],
      'skipMode',
      s.skipMode,
      { prompt: t('Mostrar botão'), auto: t('Automático'), off: t('Desligado') }[s.skipMode] || t('Mostrar botão')
    );

    // ---- Metadados (opcional, como no Kai) ----
    body.appendChild(h('div.set-section', { text: t('Metadados extras (opcional)') }));
    const keyRow = (title, sub, key, placeholder) => {
      const builtin = !!extras.BUILTIN_KEYS[key];
      if (builtin) sub += ' · ' + t('já vem embutida, só preencha para usar outra');
      const input = h('input.input', { type: 'text', value: s[key] || '', placeholder: builtin ? t('Embutida no app') : placeholder });
      input.__submit = (v) => {
        const patch = {};
        patch[key] = v.trim();
        store.saveSettings(patch);
        toast(v.trim() ? t('Chave salva') : t('Chave removida'));
        render();
      };
      body.appendChild(
        h('div.set-row', { focusable: true, onSelect: () => nav.select(input) }, [
          h('div.label', null, [title, h('small', { text: sub })]),
          input,
        ])
      );
    };
    keyRow(t('Chave TMDB'), t('Sinopses e títulos em PT-BR, logos e elenco com fotos (grátis em themoviedb.org)'), 'tmdbKey', 'API key (v3)');
    keyRow(t('Chave MDBList'), t('Notas do Rotten Tomatoes, Metacritic, Trakt e Letterboxd (grátis em mdblist.com)'), 'mdblistKey', 'API key');

    // ---- Agenda ----
    if (!IS_WEB) {
      body.appendChild(h('div.set-section', { text: t('Google Agenda') }));
      const calInput = h('input.input', { type: 'text', value: s.calendarUrl || '', placeholder: calendar.BUILTIN ? t('Embutido no app') : 'https://calendar.google.com/calendar/ical/…/basic.ics' });
      calInput.__submit = (v) => {
        store.saveSettings({ calendarUrl: v.trim() });
        calendar.start();
        toast(v.trim() ? t('Agenda ligada') : t('Agenda desligada'));
        render();
      };
      body.appendChild(
        h('div.set-row', { focusable: true, onSelect: () => nav.select(calInput) }, [
          h('div.label', null, [
            t('Link da agenda (iCal)'),
            h('small', {
              text:
                t('Google Agenda › Configurações › sua agenda › "Endereço secreto no formato iCal". Dá para colar pelo controle no celular. Vários links: separe com espaço.') +
                (calendar.BUILTIN ? ' · ' + t('já vem embutido, só preencha para usar outro') : ''),
            }),
          ]),
          calInput,
        ])
      );
    }

    body.appendChild(h('div.set-section', { text: t('Addons') }));
    const list = addons.list();
    body.appendChild(
      row(t('Addons ativos'), stremio.isLoggedIn() ? t('Gerencie pela sua conta em web.stremio.com') : t('Sem conta: Cinemeta, OpenSubtitles e os adicionados aqui'), t('{n} addon(s)', { n: list.length }), () =>
        menu(t('Addons ativos'), list.map((a) => ({ label: a.manifest.name || a.manifest.id, sub: a.transportUrl })), {})
      )
    );
    if (!IS_WEB) nsfwSection(list); // os addons adultos vêm do serviço da TV
    // Addons recomendados (só aparecem se ainda não estiverem instalados).
    RECOMMENDED.filter((r) => !list.some((a) => a.transportUrl === r.url || (a.manifest && a.manifest.id === r.id))).forEach((r) =>
      body.appendChild(row(t('Instalar {name}', { name: r.name }), t(r.desc), '', () => installFromUrl(r.url, r.name)))
    );
    const addInput = h('input.input', { type: 'text', placeholder: 'https://.../manifest.json' });
    addInput.__submit = (v) => {
      const u = v.trim();
      if (!/^https?:\/\/.+manifest\.json/.test(u)) return toast(t('Cole a URL do manifest.json do addon'));
      if (stremio.isLoggedIn()) return installFromUrl(u, t('o addon'));
      const cur = store.settings().localAddons || [];
      store.saveSettings({ localAddons: cur.concat([u]) });
      addons.load(true).then(() => {
        router.dropTab('home');
        toast(t('Addon adicionado'));
        render();
      });
    };
    body.appendChild(
      h('div.set-row', { focusable: true, onSelect: () => nav.select(addInput) }, [
        h('div.label', null, [t('Adicionar addon por URL'), h('small', { text: stremio.isLoggedIn() ? t('Instala na sua conta Stremio') : t('Fica só nesta TV') })]),
        addInput,
      ])
    );

    // ---- Controle pelo celular (só na TV: o serviço do Seraflix roda nela) ----
    if (!IS_WEB) {
      body.appendChild(h('div.set-section', { text: t('Controle no celular') }));
      body.appendChild(row(t('Abrir o controle no celular'), t('Mostra um QR code: é só apontar a câmera'), '', () => showPhoneRemote()));
    }


    body.appendChild(h('div.set-section', { text: t('Sobre e depuração') }));
    body.appendChild(row(t('Testar conexão'), t(IS_WEB ? 'Coisas não carregam? Veja qual servidor este aparelho não alcança' : 'Coisas não carregam? Veja qual servidor a TV não alcança'), '', () => showNetworkCheck()));
    body.appendChild(row(t('Último trailer'), t('Resultado do trailer na aba Recomendado'), reco.getTrailerReport() || t('nenhum ainda'), null));
    const logInput = h('input.input', { type: 'text', value: s.devlogUrl || '', placeholder: 'http://IP-DO-PC:8099/log' });
    logInput.__submit = (v) => {
      store.saveSettings({ devlogUrl: v.trim() });
      log.setRemote(v.trim());
      log.info(t('Log remoto ligado'));
      toast(v.trim() ? t('Enviando logs para o PC') : t('Log remoto desligado'));
    };
    if (!IS_WEB) body.appendChild(
      h('div.set-row', { focusable: true, onSelect: () => nav.select(logInput) }, [
        h('div.label', null, [t('Log remoto'), h('small', { text: t('npm run logs no PC') })]),
        logInput,
      ])
    );

    const rows = body.querySelectorAll('.set-row');
    if (keepIndex >= 0 && rows[keepIndex]) nav.focus(rows[keepIndex]);
  }

  render();

  return {
    el: el,
    onShow: () => {
      server.check().then(() => render());
    },
    destroy: () => bar.__destroy && bar.__destroy(),
  };
}
