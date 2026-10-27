# Torrent experimental na Samsung

A beta inclui um motor BitTorrent executado no serviço Node do próprio TizenBrew.
Não exige Mac, debrid ou um servidor de torrent em outro equipamento. Precisa de
Node **12 ou mais recente**, rede liberada e um vídeo que o player HTML5 da TV consiga
decodificar. A UN50AU7700 do usuário informou Node 12.4.0; a reprodução física nessa
TV ainda precisa ser validada.

## Limites de execução

- Um torrent e uma leitura HTTP ativos por vez; uma nova faixa Range cancela a anterior.
- Cache de peças verificadas limitado a **8 MiB**, sem arquivos de vídeo no disco.
- Seleciona apenas a peça solicitada pelo player; o arquivo inteiro não é selecionado.
- Até **12 conexões** e **96 candidatos de peers** registrados no swarm.
- Peças maiores que **4 MiB**, metadados maiores que **512 KiB**, mais de **32.768 peças**
  ou **512 arquivos** são recusados para limitar o custo de torrents muito grandes.
- Frames de peers limitados a **64 KiB**; dados inválidos encerram aquele peer.
- Metadados têm prazo de 60 s; leitura sem dados tem prazo de 45 s; sessão sem leitura
  por 10 minutos é encerrada. Depois de uma pausa longa, pode ser necessário reabrir o vídeo.
- Peças removidas do cache têm o bitfield **e o scheduler** reinicializados. Voltar no vídeo
  pode baixar novamente essas peças. Cancelar uma leitura também descarta peças parciais.

**8 MiB é o limite do cache de peças completas**, não da memória total da TV ou do processo.
Sockets, metadados, peças em trânsito, buffers HTTP e o player também usam memória. O RSS
mostrado no diagnóstico pertence ao processo Node compartilhado do TizenBrew.

O motor é uma adaptação de `torrent-stream@1.2.1` (MIT), vendorizada em
`remote/torrent-stream.cjs`. As alterações estão no arquivo fonte e a licença é mantida
no bundle gerado. A troca de metadados BEP9 foi limitada em `torrent-metadata.cjs`.

## API local

O serviço beta atende em `127.0.0.1:8094`. As rotas de torrent aceitam apenas conexões
locais; não expõem o motor para outros dispositivos da rede.

- `GET /api/torrent/status`: capacidades, sessão, peers, cache, parciais, RSS e último erro.
- `POST /api/torrent/start`: `{sessionId, infoHash, fileIdx?, sources?, season?, episode?}`.
  Retorna `{sessionId, url, name, length}` após obter metadados. O `sessionId` do cliente
  permite cancelar a preparação antes de ela terminar.
- `GET`/`HEAD /api/torrent/stream/<sessionId>/<fileIdx>`: HTTP com Range e `206`/`416`.
- `POST /api/torrent/stop`: `{sessionId}`. Uma resposta atrasada de uma sessão antiga
  não encerra um vídeo mais novo. Cancelamentos antecipados são lembrados por até 64 IDs.

Sem `fileIdx`, prefere o maior vídeo e evita arquivos `sample`. Em pacotes de série,
procura `SxxEyy`/`NxYY` e recusa selecionar um episódio diferente quando a identificação
não é possível. Fontes diretas HTTP continuam no caminho normal do aplicativo.

## Limitações

Não há FFmpeg/transcodificação no motor local. Codecs, Dolby Vision, escolha de áudio e
legendas embutidas continuam limitados pelo player da Samsung; prefira uma fonte compatível
e legendas externas. Seeders, conectividade e tamanho das peças influenciam o início e os
seeks. A leitura de uma peça por vez prioriza memória previsível; a velocidade sustentada
para vídeos muito pesados ainda precisa ser medida no hardware.

## Validação reproduzível

`node --test tests/torrent-engine.test.cjs` verifica Range, seleção de episódios,
limite e evicção de cache, descarte de parciais em cancelamentos e proteção do parser.
O teste de integração cria dados aleatórios, gera um torrent, inicia um seeder TCP local,
obtém os metadados por magnet e compara os bytes de faixas do início/fim/início novamente.

`node tests/torrent-engine-node12.cjs` executa os mesmos casos sem depender do test runner
moderno. Foi executado com **Node 12.4.0**. Para validar um bundle isolado, gere o módulo com
esbuild (`platform:node`, `target:node12`, `format:cjs`, `bundle:true`) e informe o caminho em
`SERA_ENGINE_BUNDLE`. O contexto VM desse teste não fornece `global`, `__dirname` nem `exports`,
como no launcher do TizenBrew. Os testes precisam poder abrir sockets de loopback.

Esses testes comprovam o protocolo e a implementação no ambiente de desenvolvimento.
Não substituem testar reprodução, memória, controles e estabilidade prolongada na TV.
