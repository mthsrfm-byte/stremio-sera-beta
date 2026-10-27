# Smart Choice . Light

Seleção automática conservadora para a Samsung com o motor torrent embutido.
Uma fonte com muitos seeds ainda pode ser pesada, usar um formato inadequado ou
ter uma contagem desatualizada. O Light combina esses indícios sem iniciar vários
torrents simultâneos para sondar a rede.

## Ordem da decisão

1. Retira do automático fontes sem suporte, 4K, Dolby Vision, REMUX, CAM e samples.
   AV1/VP9 e AVC High10 ficam para a escolha manual; H.264 e HEVC conhecidos são
   preferidos. Áudio anunciado somente como DTS/TrueHD/FLAC também fica manual.
   Uma fonte que anuncia AAC junto de DTS recebe cautela adicional: a etiqueta não
   garante que o áudio padrão seja utilizável no player.
2. Combina disponibilidade informada com a carga estimada do arquivo.
   Para torrents: 20+ seeds são uma referência saudável; 5–19, intermediária;
   quantidade ausente, não verificada; 1–4, último recurso; zero fica manual.
   O benefício da contagem satura em 100; milhares de seeds não compram uma exceção
   ao limite de carga ou de formato.
3. Entre opções de risco semelhante, prefere 1080p; 720p saudável pode vencer um
   1080p fraco ou pesado. Encodes extremamente pequenos perdem preferência para
   não escolher apenas a menor quantidade de bytes.
4. Compatibilidade, faixa de seeds, idioma e continuidade desempatam opções adequadas.
   A ordem de chegada dos addons não decide; a fonte anterior não ignora o perfil.

## Tamanho e duração

| Resolução | Faixa de carga preferida | Teto automático por duração |
| --- | --- | --- |
| 1080p | Até aproximadamente 8 Mbps; abaixo de 1 Mbps perde preferência de qualidade | 12 Mbps |
| 720p | Até aproximadamente 4 Mbps; abaixo de 0,5 Mbps perde preferência de qualidade | 7 Mbps |
| SD | Até aproximadamente 2 Mbps | 4 Mbps |

Usa tamanho por arquivo dividido pela duração. As unidades GB/MB e GiB/MiB são
convertidas corretamente. `behaviorHints.videoSize` tem preferência sobre o texto.
O tamanho de um pack/temporada não é dividido pela duração de um episódio.
Sem duração informada, usa referências de 110 min para filme e 45 min para episódio,
com no máximo 8 GiB/2 GiB respectivamente e menor confiança na estimativa.

Quando os metadados do torrent chegam, o tamanho e nome **reais do arquivo selecionado**
passam novamente pela política antes de entregar a URL ao player. Isso impede que um
pack sem tamanho por episódio burle o perfil. Essa validação vale apenas no automático.

## Recuperação e controle

Os addons são aguardados até responderem ou até 12 s. Respostas posteriores ficam
disponíveis na lista de fontes, mas não substituem um vídeo já escolhido.
Falha ao preparar, decodificar ou iniciar pode tentar até duas alternativas, uma
sessão por vez. Recuperações e próximo episódio recebem o mesmo ranking e sua duração.

Uma fonte recém-falhada é evitada por dez minutos, somente em memória, com retenção
máxima de 64 registros e contexto do vídeo. O mesmo hash/arquivo em outro addon não
conta como uma nova alternativa. Serviço local indisponível não provoca trocas de torrent.
Sem candidato adequado, abre a escolha manual. Fontes fora do Light continuam disponíveis
manualmente, sujeitas aos limites reais do player e do motor.

Seeds e codecs são informações publicadas pelos addons; não certificam a saúde atual.
Bitrate médio não representa picos. A memória total e a estabilidade de reprodução
precisam ser medidas na TV, mesmo que todos os critérios sejam satisfeitos.
