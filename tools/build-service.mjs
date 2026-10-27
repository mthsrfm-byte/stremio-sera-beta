// Um único arquivo: o TizenBrew executa o serviço em vm e não instala node_modules na TV.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildService() {
  await build({
    entryPoints: [path.join(root, 'remote/tv-service-source.cjs')],
    outfile: path.join(root, 'remote/tv-service.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node12'],
    minify: true,
    legalComments: 'eof',
    banner: { js: '// Gerado por npm run build:service; edite tv-service-source.cjs e torrent-engine.cjs.\nvar global = typeof globalThis !== \'undefined\' ? globalThis : this;' },
    // ws tenta módulos nativos opcionais e já tem fallback em JavaScript.
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'warning',
  });
  console.log('[service] ' + Math.round(fs.statSync(path.join(root, 'remote/tv-service.js')).size / 1024) + ' KB (Node 12+)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildService();
