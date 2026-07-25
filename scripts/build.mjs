import {chmod, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {build} from 'esbuild';

const outputs = ['dist/cli.mjs', 'dist/haochen-onefile.mjs'];
const shebang = '#!/usr/bin/env node';
const shared = {
  entryPoints: ['src/cli/index.tsx'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: false,
  sourcemap: false,
  legalComments: 'inline',
  banner: {js: shebang},
};

await rm('dist', {recursive: true, force: true});
await mkdir('dist', {recursive: true});

await build({
  ...shared,
  outfile: outputs[0],
  packages: 'external',
});

await build({
  ...shared,
  outfile: outputs[1],
  packages: 'bundle',
  banner: {
    js: [
      shebang,
      'import {createRequire as __haochenCreateRequire} from "node:module";',
      'const require = __haochenCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

for (const file of outputs) {
  const source = await readFile(file, 'utf8');
  const body = source.replace(/^(?:#![^\n]*(?:\n|$))+/, '');
  await writeFile(file, `${shebang}\n${body}`);
  await chmod(file, 0o755);
}
