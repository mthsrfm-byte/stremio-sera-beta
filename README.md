# Seraflix Beta

Versão experimental independente do [Seraflix estável](https://github.com/mthsrfm-byte/stremio-sera), para TVs Samsung Tizen. O foco desta beta é reduzir a carga de memória e testar torrents na própria TV, sem debrid e sem computador ligado na rede.

**A execução de torrents precisa ser validada na TV real.** O teste de rede e memória não comprova reprodução estável. Esta versão não promete eliminar todos os travamentos, nem aumenta a memória disponível na televisão.

## Instalar sem substituir a versão estável

No TizenBrew, adicione o módulo do GitHub:

```
mthsrfm-byte/stremio-sera-beta
```

O módulo aparece como **Seraflix Beta**. A beta usa outro repositório de atualização e guarda contas, perfis e preferências em um espaço próprio. Entre na sua conta Stremio novamente; as preferências locais da instalação estável não são migradas.

A biblioteca e o progresso da conta continuam sendo sincronizados com o Stremio. Se usar a mesma conta nas duas versões, essas informações da conta serão compartilhadas.

## Perfil leve

O modo de memória reduzida vem ligado por padrão. Ele reduz tarefas de fundo e a carga de elementos que competem com a reprodução. A prioridade é reservar recursos para o vídeo e, no modo local, para o motor torrent.

O layout, os fades de banners e pôsteres e o destaque do foco continuam. Imagens fora da tela, pré-carregamentos e camadas antigas são liberados; no modo leve, efeitos contínuos e filtros grandes são reduzidos. As artes de destaque usam uma resolução limitada própria, sem baixar o original.

As fontes ainda precisam ser compatíveis com o player da Samsung. Uma TV Samsung não ganha suporte a Dolby Vision, novos codecs ou mais memória por usar esta beta. Quando uma fonte não abrir, tente outra versão do arquivo e outra faixa de áudio quando disponível.

## Smart Choice . Light

A seleção automática compara saúde informada dos seeds, carga por duração e compatibilidade.
Prefere 1080p moderado, permite 720p mais saudável e deixa fontes pesadas/inadequadas para
escolha manual. Não mantém uma fonte anterior ruim só por ter sido usada antes.
O tamanho real do arquivo é validado ao preparar um torrent, inclusive em packs.
Veja os [critérios e limites](docs/SMART-CHOICE-LIGHT.md).

## Torrents na própria TV

O modo local é experimental e é destinado ao serviço do TizenBrew executado dentro da Samsung, com Node.js compatível. Não usa WebAssembly ou um motor executado no navegador.

O motor limita conexões, cache e sessões para conviver com a pouca memória da TV. Ele requer Node 12 ou mais recente e atende um torrent por vez. A reprodução local não oferece a conversão de vídeo/áudio do servidor Stremio externo. Legendas externas dos addons continuam dependendo da disponibilidade e das permissões de rede da fonte.

O aparelho usado como referência para a investigação é a **Samsung UN50AU7700GXZD (2021, Tizen 6.0)**. O diagnóstico fornecido nessa TV mostrou Node 12.4.0, cerca de 98 MB de memória livre, TCP/UDP funcionando e gravação permitida. Esses valores são uma fotografia daquele momento, não uma reserva de memória garantida.

Para uma validação útil:

1. Abra a beta pelo TizenBrew e confirme que o serviço local iniciou.
2. Use um torrent autorizado de teste, com vídeo compatível e boa disponibilidade de peers.
3. Com o Mac desligado, teste início, pausa, avanço/retrocesso e reprodução prolongada.
4. Verifique o consumo de memória e o encerramento da sessão ao sair do player.

O teste **“Testar torrent na TV (sem o PC)”** avalia condições básicas; o resultado não substitui esse teste de reprodução.

## Alternativa: servidor externo

É possível continuar usando um servidor Stremio em outro equipamento. Desligue **Torrent na própria TV (experimental)** em Ajustes e configure o endereço do servidor externo. O [servidor oficial em Docker](https://github.com/Stremio/server-docker) pode ser executado em equipamento Linux compatível, como NAS, mini PC ou Raspberry Pi; esse equipamento precisa permanecer ligado.

Fontes HTTP diretas compatíveis podem tocar sem servidor. Alguns links exigem proxy, e recursos como conversão de codecs e leitura de certas faixas embutidas dependem do servidor externo.

## Desenvolvimento

Requer Node.js para preparar o pacote:

```
npm ci --ignore-scripts
npm test
npm run build
```

O pacote da TV é gerado em `dist/`. O serviço é compilado de `remote/tv-service-source.cjs` para `remote/tv-service.js`, incluindo o motor e dependências num arquivo que o TizenBrew carrega sem instalar pacotes na TV. O código do navegador continua compilado para Chromium antigo; o serviço da TV tem suas próprias exigências de runtime.

O build web é separado e exige uma senha:

```
KAI_WEB_PASSWORD='sua-senha' npm run build:web
```

O motor torrent local depende do serviço da TV; publicar a interface no GitHub Pages não transfere esse motor para a nuvem.

Os segredos de GitHub Actions da versão estável não são copiados automaticamente para este repositório. Chaves opcionais de TMDB e MDBList devem ser configuradas separadamente, se necessárias. Valores embutidos num pacote público podem ser lidos por terceiros.

## Créditos e licença

Este projeto é um remix não oficial, sem ligação com Stremio, Samsung ou os autores dos projetos de origem. O app não hospeda conteúdo; reproduz fontes entregues pelos addons da conta do usuário.

- [Seraflix estável](https://github.com/mthsrfm-byte/stremio-sera)
- [Stremio](https://www.stremio.com/)
- [Stremio Kai](https://github.com/allecsc/Stremio-Kai)
- [Stremio Kai Timeworn](https://github.com/creachec/Stremio-Kai-Timeworn)
- [TizenBrew](https://github.com/reisxd/TizenBrew)

[GPL-3.0](LICENSE), preservando a licença da base.
