import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createProjectReader, parseReadProgram } from '../src/project-files.mjs';
import { wordFixture, presentationFixture, zipFixture } from './document-fixtures.mjs';

async function fixture(t) {
  const temp = await fs.mkdtemp('/private/tmp/dsh-project-reader-');
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  const reads = [];
  const backend = {
    resolve: async (value, opts = {}) => ({ targetKey: await fs.realpath(path.resolve(opts.cwd ?? root, value)) }),
    processPath: target => target.targetKey,
    contains: (a, b) => { const rel = path.relative(a.targetKey, b.targetKey); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); },
    stat: async target => { const s = await fs.stat(target.targetKey); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size }; },
    readBytes: async target => { reads.push(target.targetKey); return fs.readFile(target.targetKey); },
    listDir: async target => (await fs.readdir(target.targetKey, { withFileTypes: true })).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
  };
  let current = root;
  const agent = { ctx: { fs: backend, workingDirectory: { ensure: async () => current } } };
  return { temp, root, reads, backend, agent, reader: createProjectReader(agent), select: value => current = value,
    write: (name, text) => fs.writeFile(path.join(root, name), text), exec: { agent, signal: new AbortController().signal } };
}

test('reads and searches actual project text with source lines and pagination', async t => {
  const f = await fixture(t);
  await f.write('notes.md', '# 项目\n数据库是关系模型\n需要核对约束\n');
  const page = await f.reader.read({ file_path: 'notes.md', offset: 2, limit: 1 }, f.exec);
  assert.equal(page.text, '2: 数据库是关系模型');
  assert.equal(page.path, 'notes.md');
  assert.equal(page.truncated, true);
  const search = await f.reader.search({ query: '关系模型' }, f.exec);
  assert.deepEqual(search.matches, [{ path: 'notes.md', line: 2, text: '数据库是关系模型' }]);
  assert.deepEqual((await f.reader.list({}, f.exec)).entries, [{ path: 'notes.md', type: 'file' }]);
});

test('project selection isolates identical file names without a separate copy', async t => {
  const f = await fixture(t);
  await f.write('notes.txt', 'first project');
  const next = path.join(f.temp, 'another'); await fs.mkdir(next); await fs.writeFile(path.join(next, 'notes.txt'), 'second project');
  assert.match((await f.reader.read({ file_path: 'notes.txt' }, f.exec)).text, /first project/);
  f.select(next);
  assert.match((await f.reader.read({ file_path: 'notes.txt' }, f.exec)).text, /second project/);
});

test('traversal, absolute external paths and external symlinks cannot disclose files', async t => {
  const f = await fixture(t); const outside = path.join(f.temp, 'outside.txt'); await fs.writeFile(outside, 'outside marker');
  await fs.symlink(outside, path.join(f.root, 'alias.txt'));
  for (const file_path of ['../outside.txt', outside, 'alias.txt']) await assert.rejects(f.reader.read({ file_path }, f.exec), /项目外|项目内/);
  assert.equal(f.reads.length, 0);
  assert.deepEqual((await f.reader.list({ recursive: true }, f.exec)).entries, []);
});

test('credential names and aliases are blocked in read, search and listings', async t => {
  const f = await fixture(t);
  await f.write('.env', 'private marker'); await f.write('credentials.json', 'private marker');
  await fs.mkdir(path.join(f.root, '.aws')); await fs.writeFile(path.join(f.root, '.aws/config'), 'private marker');
  await fs.symlink(path.join(f.root, '.env'), path.join(f.root, 'innocent.txt'));
  for (const file_path of ['.env', 'credentials.json', '.aws/config', 'innocent.txt']) await assert.rejects(f.reader.read({ file_path }, f.exec), /凭据|私有/);
  assert.deepEqual((await f.reader.search({ query: 'private marker' }, f.exec)).matches, []);
  assert.deepEqual((await f.reader.list({ recursive: true }, f.exec)).entries, []);
  assert.equal(f.reads.length, 0);
});

test('malformed documents, invalid encodings and oversized files return explicit errors', async t => {
  const f = await fixture(t);
  await f.write('document.pdf', '%PDF-1.4\0fixture'); await f.write('bad.txt', Buffer.from([0xc3, 0x28])); await f.write('large.txt', Buffer.alloc(32 * 1024 * 1024 + 1));
  await assert.rejects(f.reader.read({ file_path: 'document.pdf' }, f.exec), /PDF/);
  await assert.rejects(f.reader.read({ file_path: 'bad.txt' }, f.exec), /编码/);
  await assert.rejects(f.reader.read({ file_path: 'large.txt' }, f.exec), /32 MiB/);
});

test('long text is bounded and visibly marked as incomplete', async t => {
  const f = await fixture(t); await f.write('long.txt', '长'.repeat(30000));
  const result = await f.reader.read({ file_path: 'long.txt' }, f.exec);
  assert.ok(result.text.length <= 24000 && result.text.length > 0);
  assert.equal(result.truncated, true); assert.match(result.text, /本行截断/);
});

test('abort, another session and invalid ranges fail before returning data', async t => {
  const f = await fixture(t); await f.write('notes.txt', 'fixture');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.reader.read({ file_path: 'notes.txt' }, { agent: f.agent, signal: controller.signal }));
  await assert.rejects(f.reader.read({ file_path: 'notes.txt' }, { agent: {} }), /当前会话/);
  await assert.rejects(f.reader.read({ file_path: 'notes.txt', limit: 401 }, f.exec), /整数/);
  await assert.rejects(f.reader.list({ limit: 0 }, f.exec), /整数/);
  await assert.rejects(f.reader.search({ query: '' }, f.exec), /搜索文字/);
});

test('a changed symbolic path cannot publish a stale or external read', async t => {
  const f = await fixture(t); await f.write('notes.txt', 'fixture');
  const original = f.backend.readBytes;
  f.backend.readBytes = async target => { const bytes = await original(target); await fs.rename(path.join(f.root, 'notes.txt'), path.join(f.temp, 'moved.txt')); await fs.symlink(path.join(f.temp, 'moved.txt'), path.join(f.root, 'notes.txt')); return bytes; };
  await assert.rejects(f.reader.read({ file_path: 'notes.txt' }, f.exec), /项目外|路径发生变化/);
});

test('directory and search results respect caller bounds and skip dependencies', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) await f.write(`file${i}.txt`, 'find me\nfind me');
  await fs.mkdir(path.join(f.root, 'node_modules')); await fs.writeFile(path.join(f.root, 'node_modules/private.txt'), 'find me');
  const list = await f.reader.list({ recursive: true, limit: 2 }, f.exec); assert.equal(list.entries.length, 2); assert.equal(list.truncated, true);
  const search = await f.reader.search({ query: 'find me', limit: 2 }, f.exec); assert.equal(search.matches.length, 2); assert.equal(search.truncated, true);
  assert.ok(f.reads.every(name => !name.includes('node_modules')));
});

test('PTC read transport admits one JSON-only read and rejects executable syntax or escalation', () => {
  const code = 'return await tools.autonomy_read_file({"file_path":"notes.md","limit":10});';
  assert.deepEqual(parseReadProgram({ code, description: 'read' }), { name: 'autonomy_read_file', arguments: { file_path: 'notes.md', limit: 10 } });
  for (const value of [
    code + ' await tools.write_probe({});',
    'return await tools.write_probe({});',
    'return await tools.autonomy_read_file({file_path:"notes.md"});',
    'return await tools.autonomy_read_file({"file_path":process.env.HOME});',
    'return await tools.autonomy_read_file({"file_path":`notes.md`});',
    'return await tools.autonomy_read_file({"__proto__":{}});',
    'return await tools.autonomy_read_file({"file_path":"notes.md"}); // comment',
    'const a = {}; return await tools.autonomy_read_file(a);',
  ]) assert.equal(parseReadProgram({ code: value, description: 'read' }), undefined, value);
  assert.equal(parseReadProgram({ code, description: 'read', sandbox_permissions: 'require_escalated' }), undefined);
  assert.equal(parseReadProgram({ code: 'return await tools.autonomy_list_archive({"file_path":"sources.zip"});' }).name, 'autonomy_list_archive');
});

test('project tools parse, paginate and search document text with file and slide locations', async t => {
  const f = await fixture(t); await f.write('notes.docx', wordFixture()); await f.write('slides.pptx', presentationFixture());
  const result = await f.reader.read({ file_path: 'notes.docx', offset: 1, limit: 2 }, f.exec);
  assert.equal(result.format, 'docx'); assert.match(result.text, /1: \[正文\]/); assert.equal(result.truncated, true);
  const search = await f.reader.search({ query: '讲解备注' }, f.exec);
  assert.equal(search.matches[0].path, 'slides.pptx'); assert.equal(search.matches[0].location, '第 1 张备注');
});

test('ZIP tools share project boundaries, hide credentials and search named document members', async t => {
  const f = await fixture(t);
  await f.write('sources.zip', zipFixture([['notes.docx', wordFixture()], ['.env', 'SECRET'], ['credentials.json', 'SECRET']]));
  const list = await f.reader.archive({ file_path: 'sources.zip' }, f.exec);
  assert.equal(list.entries.length, 1); assert.equal(list.entries[0].supported, true);
  assert.match((await f.reader.read({ file_path: 'sources.zip', archive_entry: 'notes.docx' }, f.exec)).text, /中文项目资料/);
  assert.equal((await f.reader.search({ query: '中文项目资料' }, f.exec)).matches[0].archiveEntry, 'notes.docx');
  await assert.rejects(f.reader.read({ file_path: 'sources.zip', archive_entry: '.env' }, f.exec), /凭据/);
  await assert.rejects(f.reader.archive({ file_path: '../sources.zip' }, f.exec));
});
