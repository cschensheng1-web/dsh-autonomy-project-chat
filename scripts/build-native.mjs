import { readFile, writeFile, mkdir, mkdtemp, rm, rename, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sha = data => createHash('sha256').update(data).digest('hex');
const source = 'src/native/OCR.swift'; const directory = 'lib/native'; const executable = directory + '/dsh-ocr-macos';
const sourceHash = sha(await readFile(source));
try {
  const meta = JSON.parse(await readFile(directory + '/build.json', 'utf8'));
  if (meta.sourceSHA256 === sourceHash && meta.binarySHA256 === sha(await readFile(executable))) { console.log('Native OCR helper matches source.'); process.exit(0); }
} catch {}
if (process.platform !== 'darwin') throw Error('Build the macOS OCR helper on a Mac before packaging.');
await mkdir(directory, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'dsh-ocr-build-'));
try {
  for (const arch of ['arm64', 'x86_64']) execFileSync('/usr/bin/swiftc', ['-O', '-whole-module-optimization', '-target', arch + '-apple-macosx13.0', '-module-cache-path', join(temp, 'cache'), source, '-o', join(temp, arch)], { stdio: 'inherit' });
  execFileSync('/usr/bin/lipo', ['-create', join(temp, 'arm64'), join(temp, 'x86_64'), '-output', executable + '.pending'], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', executable + '.pending'], { stdio: 'inherit' });
  await chmod(executable + '.pending', 0o755); await rename(executable + '.pending', executable);
  await writeFile(directory + '/build.json', JSON.stringify({ sourceSHA256: sourceHash, binarySHA256: sha(await readFile(executable)), architectures: ['arm64', 'x86_64'], minimumMacOS: '13.0' }, null, 2) + '\n');
  console.log('Built universal macOS OCR helper.');
} finally { await rm(temp, { recursive: true, force: true }); }
