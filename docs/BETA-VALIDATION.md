# Validação da beta

Referência de hardware: Samsung UN50AU7700GXZD, firmware 2310.0, Tizen 6.0.
O diagnóstico enviado pelo usuário mostrou Node 12.4.0 e 98 MB livres naquele instante.

## Verificado no desenvolvimento

- Testes de interface: carregamento limitado, respostas atrasadas, foco, cache,
  descarte de telas, restauração da aba e troca de HLS durante download do script.
- Testes do player: modo local/external/web, magnet, cancelamento por sessão e
  liberação de recursos antes de iniciar o torrent.
- Motor: torrent gerado de dados aleatórios, seeder TCP local real, metadados via
  magnet, bytes HTTP Range, evicção e seek para trecho descartado. Testes também
  cobrem arquivos de episódios, frames inválidos e cancelamento de peças parciais.
- Serviço compilado executado em sandbox VM com apenas dependências nativas.
- Os mesmos testes do motor executados em **Node 12.4.0**, incluindo bundle isolado.
- Interface compilada analisada como JavaScript ES5 pelo Acorn.
- Dependências de execução com lockfile fixo e substituições compatíveis com Node 12
  para `ws` e `ip`; não se deve remover o lockfile ou atualizar esse motor sem repetir os testes.

Na revisão 1.3.1, o Smart Choice . Light é testado com múltiplos addons, informações
incompletas, packs, fontes lembradas, erros e tamanho real do arquivo. A UI tem testes
para descarte e reativação de imagens, tarefas atrasadas e atividade durante a preparação
do protetor de tela. Os critérios completos estão em [SMART-CHOICE-LIGHT.md](SMART-CHOICE-LIGHT.md).

O JavaScript da interface continua próximo da metade do tamanho da base original,
mesmo após acrescentar a política Light. Tamanho de arquivo não mede o uso de RAM.
O serviço torrent é separado. As artes de destaque são limitadas a uma resolução
intermediária para preservar nitidez; algumas substituem thumbnails antes menores.
A economia vem principalmente de liberar imagens/camadas ocultas e tarefas antigas,
e não de reduzir indiscriminadamente a qualidade de toda imagem.

## Teste que falta na Samsung

1. Adicionar `mthsrfm-byte/stremio-sera-beta` no TizenBrew e entrar na conta.
2. Manter **Modo leve** e **Torrent na própria TV (experimental)** ligados.
3. Começar com fonte 720p/1080p compatível, com peers disponíveis.
4. Desligar o Mac e verificar início, pausa, avanço/retrocesso e reprodução prolongada.
5. Em Ajustes, conferir **Estado do torrent local** e o diagnóstico de memória.

Nenhum teste de desenvolvimento mede a memória de vídeo da Samsung ou comprova
que todos os torrents/formatos funcionarão. O motor local não faz conversão de codecs.

## Comandos

```sh
npm ci --ignore-scripts
npm test
npm run build
node tests/node12-service-smoke.cjs
node tools/build-engine-test.mjs /tmp/sera-engine-test.cjs
# Usar o executável Node 12.4.0 nestes dois comandos:
node tests/node12-service-smoke.cjs
SERA_ENGINE_BUNDLE=/tmp/sera-engine-test.cjs node tests/torrent-engine-node12.cjs
```

Os testes de peers precisam abrir sockets de loopback. O workflow da TV repete
o build e os testes de Node 12.4.0; a publicação web é manual e exige configuração própria.
