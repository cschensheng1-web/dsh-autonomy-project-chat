import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, readdir, cp, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['scripts/build-native.mjs'], { stdio: 'inherit' });
await mkdir('lib/parser', { recursive: true });
const options = { bundle: true, format: 'esm', platform: 'node', target: 'node24', legalComments: 'eof', metafile: true };
const parser = await build({ ...options, entryPoints: ['src/document-worker.mjs'], outdir: 'lib/parser', splitting: true, chunkNames: '[name]-[hash]', minify: true,
  supported: { 'template-literal': false },
  banner: { js: "import {createRequire as __dshCreateRequire} from 'node:module'; const require=__dshCreateRequire(import.meta.url);" } });
for (const directory of ['cmaps', 'standard_fonts']) {
  const destination = 'lib/parser/pdf-assets/' + directory;
  await cp('node_modules/pdfjs-dist/' + directory, destination, { recursive: true });
  for (const file of (await readdir(destination)).filter(name => /^license/i.test(name))) {
    const content = await readFile(join(destination, file), 'utf8');
    await writeFile(join(destination, file), content.replace(/[ \t]+$/gm, ''));
  }
}
const currentOutputs = new Set(Object.keys(parser.metafile.outputs).map(file => resolve(file)));
for (const file of await readdir('lib/parser')) if (file.endsWith('.js') && !currentOutputs.has(resolve('lib/parser', file))) await unlink(join('lib/parser', file));
if (process.argv.includes('--parsers-only')) { console.log('Built document worker, chunks and PDF text assets.'); process.exit(0); }
const host = await build({ ...options, entryPoints: ['src/index.mjs'], outfile: 'lib/index.js', write: false,
  banner: { js: '/* Community adaptation of dsh-autonomy 0.1.5 (MIT); see LICENSE and NOTICE. */' } });
await writeFile('lib/index.js.pending', host.outputFiles[0].text.replace(/^[ \t]+$/gm, ''));
await copyFile('src/client.cjs', 'lib/client.cjs');
const roots = new Set();
for (const input of [...Object.keys(parser.metafile.inputs), ...Object.keys(host.metafile.inputs)]) {
  if (!input.includes('node_modules/')) continue;
  let dir = dirname(resolve(input));
  while (dir.includes('/node_modules/')) {
    try { const meta = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); if (meta.name) { roots.add(dir); break; } } catch {}
    dir = dirname(dir);
  }
}
roots.add(resolve('node_modules/pdfjs-dist'));
const notices = [];
for (const root of [...roots].sort()) {
  const meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const files = (await readdir(root)).filter(name => /^(?:license|copying)(?:\.|$)/i.test(name));
  if (!files.length && meta.name === 'saxes') {
    notices.push(`${meta.name}@${meta.version} (upstream LICENSE; npm omits it)\n${await readFile('scripts/licenses/saxes.txt', 'utf8')}`);
    continue;
  }
  if (!files.length) throw Error('Missing dependency license: ' + meta.name);
  for (const file of files) notices.push(`${meta.name}@${meta.version} (${relative('.', root)}/${file})\n${await readFile(join(root, file), 'utf8')}`);
}
for (const [directory, prefix] of [['node_modules/unpdf/dist/licenses', 'unpdf embedded PDF.js/decoder licenses'], ['node_modules/pdfjs-dist/standard_fonts', 'PDF standard font licenses'], ['node_modules/pdfjs-dist/cmaps', 'PDF CMap license'], ['node_modules/xlsx/dist', 'SheetJS embedded component licenses']]) {
  for (const name of (await readdir(directory)).filter(n => /^license/i.test(n)).sort()) notices.push(`${prefix}: ${name}\n${await readFile(join(directory, name), 'utf8')}`);
}
await writeFile('THIRD-PARTY-NOTICES.txt', notices.join('\n\n---\n\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n');
await rename('lib/index.js.pending', 'lib/index.js');
console.log('Built standalone host, client and bounded document workers; no runtime npm installation.');
