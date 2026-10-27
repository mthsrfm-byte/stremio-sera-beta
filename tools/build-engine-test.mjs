// Mesmo alvo/dependências do serviço; permite validar o motor isolado no sandbox Node da TV.
import { build } from 'esbuild';
import path from 'node:path';
import os from 'node:os';
const outfile = process.argv[2] || path.join(os.tmpdir(), 'sera-engine-test.cjs');
await build({
  entryPoints: ['remote/torrent-engine.cjs'], outfile, bundle: true,
  platform: 'node', format: 'cjs', target: ['node12'],
  external: ['bufferutil', 'utf-8-validate'], legalComments: 'eof',
});
console.log('Motor para teste: ' + outfile);
