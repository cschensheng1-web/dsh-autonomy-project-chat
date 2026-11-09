// Offline integration against the installed Mac app. No account or LLM adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as autonomy from '../lib/index.js';
import { parseReadProgram } from '../src/project-files.mjs';
import { wordFixture, zipFixture, pdfFixture } from '../tests/document-fixtures.mjs';
const base = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const require = createRequire(base + '/package.json');
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);
const { Context } = await load('cordis');
const { default: SessionStore, Session, SessionId } = await load('dsh-session');
const { default: SystemPrompt } = await load('dsh-system-prompt');
const { default: ToolRuntime } = await load('dsh-tools');
const { default: AgentRegistry } = await load('dsh-agent');
const { default: Commands } = await load('dsh-commands');
const { default: Projections } = await load('dsh-session-projection');
const { default: LocalFs } = await load('dsh-fs-local');
const { default: LocalAttachments } = await load('dsh-attachment-local');
const { createScope } = await load('dsh-scope');
const Native = await load('dsh-tool-executor-native');
const Ptc = await load('dsh-tool-executor-ptc');
const readNames = ['autonomy_list_archive', 'autonomy_list_files', 'autonomy_read_file', 'autonomy_read_video', 'autonomy_search_text'];
const signal = () => new AbortController().signal;
const events = session => session.snapshotEvents?.() ?? session.events;

async function fixture(t, mode = 'native', config = {}, lateFs = false) {
  const root = await fs.mkdtemp('/private/tmp/dsh-autonomy-integration-');
  const attachmentHome = await fs.mkdtemp('/private/tmp/dsh-autonomy-attachments-');
  await fs.writeFile(path.join(root, 'source.md'), '# 项目来源\n关系数据库遵循约束\n');
  await fs.writeFile(path.join(root, 'source.docx'), wordFixture());
  await fs.writeFile(path.join(root, 'source.pdf'), pdfFixture());
  await fs.copyFile(new URL('../tests/fixtures/ocr-source.png', import.meta.url), path.join(root, 'source.png'));
  await fs.copyFile(new URL('../tests/fixtures/ocr-scan.pdf', import.meta.url), path.join(root, 'scan.pdf'));
  await fs.copyFile(new URL('../tests/fixtures/video-lesson.mp4', import.meta.url), path.join(root, 'lesson.mp4'));
  await fs.writeFile(path.join(root, 'sources.zip'), zipFixture([['inside.docx', wordFixture()]]));
  const ctx = new Context(); const fibers = []; let probes = 0; let programs = 0;
  const mount = async (plugin, config) => { const f = await ctx.plugin(plugin, config); fibers.push(f); return f; };
  t.after(async () => { for (const f of fibers.reverse()) await f.dispose(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(attachmentHome, { recursive: true, force: true }); });
  for (const plugin of [SessionStore, SystemPrompt, ToolRuntime, AgentRegistry, Commands, Projections]) await mount(plugin);
  await mount(LocalAttachments, { dshHome: attachmentHome });
  const attachFs = async () => {
    await mount(LocalFs, { cwd: root });
    ctx.provide('workingDirectory', { ensure: async () => root });
  };
  if (!lateFs) await attachFs();
  ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body',
    resolve: request => ({ ...request, cwd: root, timeoutMs: 1000 }),
    run: async request => {
      programs++;
      const parsed = parseReadProgram({ code: request.program, description: 'offline' });
      const value = parsed ? await request.bindings[0].functions[parsed.name](parsed.arguments) : 'offline program';
      return { value, logs: [] };
    }, release: async () => {} });
  await mount(mode === 'ptc' ? Ptc : Native);
  const definition = name => ({ name, description: 'Offline mutation counter; no real write',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { probes++; return 'offline probe'; } });
  ctx.tools.register(definition('write_probe'));
  // Match the real Desktop host entry for singleton-safe SDK resolution.
  const originalEntry = process.argv[1]; process.argv[1] = base + '/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js';
  let autonomyFiber;
  try { autonomyFiber = await mount(autonomy, config); } finally { process.argv[1] = originalEntry; }
  async function agent(id, seed) {
    const session = Session.create(SessionId(id), seed);
    ctx.sessions.enter(session); ctx.sessions.announce(session);
    const a = { id: session.id, session, options: {}, status: 'idle', inject: message => session.append('user/message', message, { surfaceOp: 'append' }) };
    await mount(Object.assign(inner => { a.ctx = createScope(inner, a).ctx; }, { inject: ['tools'] }));
    ctx.agents.enter(a); ctx.agents.announce(a); return a;
  }
  async function command(a, mode) {
    const args = ctx.commands.execute.length >= 4 ? [a, '/autonomy ' + mode, [], signal()] : [a, '/autonomy ' + mode, signal()];
    const result = await ctx.commands.execute(...args);
    assert.equal(result?.result.kind, 'success', JSON.stringify(result));
  }
  let lastBatch;
  async function execute(a, name, args = {}) {
    const batch = lastBatch = await ctx.tools.execute({ agent: a, calls: [{ type: 'tool-call', id: 'offline-' + Math.random(), name, arguments: JSON.stringify(args) }], signal: signal() });
    return batch.results[0].result;
  }
  return { ctx, root, agent, command, execute, definition, autonomyFiber, attachFs,
    assembly: a => ctx.systemPrompt.assemble({ agent: a, scope: a }), counts: () => ({ probes, programs }), lastBatch: () => lastBatch };
}

for (const executor of ['native', 'ptc']) test(`${executor}: Chat reads real project sources and Agent restores its original executor`, async t => {
  const f = await fixture(t, executor); const a = await f.agent(executor);
  const original = f.ctx.tools.selectExecutor(a);
  const session = a.session;
  await f.command(a, 'chat');
  const assembled = await f.assembly(a);
  assert.deepEqual(assembled.tools.map(t => t.name).sort(), executor === 'ptc' ? ['run_code'] : readNames);
  assert.ok(!assembled.sections.some(s => ['tools:sdk', 'tools:ptc-only', 'tools:code-only'].includes(s.name)));
  const read = args => executor === 'ptc' ? f.execute(a, 'run_code', { code: 'return await tools.autonomy_read_file(' + JSON.stringify(args) + ');', description: 'Read offline fixture' }) : f.execute(a, 'autonomy_read_file', args);
  const result = await read({ file_path: 'source.md' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /2: 关系数据库遵循约束/);
  assert.equal((await read({ file_path: '../outside.txt' })).isError, true);
  a.ctx.tools.register(f.definition('scoped_write_probe'));
  assert.equal((await f.execute(a, 'scoped_write_probe')).isError, true);
  assert.equal((await f.execute(a, 'write_probe')).isError, true);
  assert.equal((await f.execute(a, 'run_code', { code: 'return 1', description: 'offline' })).isError, true);
  assert.equal((await f.execute(a, 'run_code', { code: 'return await tools.write_probe({});', description: 'offline' })).isError, true);
  assert.equal((await f.execute(a, 'run_code', { code: 'return await tools.autonomy_read_file({"file_path":"source.md"});', description: 'offline', sandbox_permissions: 'require_escalated', justification: 'fixture' })).isError, true);
  assert.deepEqual(f.counts(), { probes: 0, programs: executor === 'ptc' ? 2 : 0 });
  assert.match((await read({ file_path: 'source.docx' })).content[0].text, /中文项目资料/);
  assert.match((await read({ file_path: 'source.pdf' })).content[0].text, /中文/);
  assert.match((await read({ file_path: 'source.png' })).content[0].text, /数据库课程/);
  assert.match((await read({ file_path: 'scan.pdf', ocr: true, page: 1 })).content[0].text, /SELECT student/);
  assert.match((await read({ file_path: 'sources.zip', archive_entry: 'inside.docx' })).content[0].text, /脚注说明/);
  const list = executor === 'ptc' ? await f.execute(a, 'run_code', { code: 'return await tools.autonomy_list_archive({"file_path":"sources.zip"});', description: 'List offline archive' }) : await f.execute(a, 'autonomy_list_archive', { file_path: 'sources.zip' });
  assert.notEqual(list.isError, true, JSON.stringify(list)); assert.match(list.content[0].text, /inside.docx/);
  const videoArgs = { file_path: 'lesson.mp4', frame_count: 2, language: 'zh' };
  const video = executor === 'ptc' ? await f.execute(a, 'run_code', { code: 'return await tools.autonomy_read_video(' + JSON.stringify(videoArgs) + ');', description: 'Read synthetic video' }) : await f.execute(a, 'autonomy_read_video', videoArgs);
  assert.notEqual(video.isError, true, JSON.stringify(video));
  assert.match(video.content[0].text, /数据库课程/);
  assert.match(video.content[0].text, /transcribed/);
  if (executor === 'native') assert.equal(video.content.filter(c => c.type === 'image').length, 2, JSON.stringify(video));
  else assert.ok(f.lastBatch().additionalContexts.some(c => c.content?.some(block => block.type === 'image')), JSON.stringify(f.lastBatch()));
  const forbiddenVideoArgs = { ...videoArgs, command: 'write_probe', model_path: '../outside.bin' };
  const forbiddenVideo = executor === 'ptc' ? await f.execute(a, 'run_code', { code: 'return await tools.autonomy_read_video(' + JSON.stringify(forbiddenVideoArgs) + ');', description: 'Refuse extra execution arguments' }) : await f.execute(a, 'autonomy_read_video', forbiddenVideoArgs);
  assert.equal(forbiddenVideo.isError, true);
  await f.command(a, 'agent');
  assert.equal(a.session, session);
  assert.equal(f.ctx.tools.selectExecutor(a), original);
  if (executor === 'native') assert.notEqual((await f.execute(a, 'write_probe')).isError, true);
  else assert.notEqual((await f.execute(a, 'run_code', { code: 'return 1', description: 'offline' })).isError, true);
  assert.equal((await f.execute(a, 'autonomy_read_file', { file_path: 'source.md' })).isError, true);
});

test('session isolation, replayed Chat mode, projection and unload preserve native behavior', async t => {
  const f = await fixture(t); const a = await f.agent('reader'); const b = await f.agent('worker');
  await f.command(a, 'chat');
  assert.deepEqual((await f.assembly(a)).tools.map(t => t.name).sort(), readNames);
  assert.deepEqual((await f.assembly(b)).tools.map(t => t.name), ['write_probe']);
  assert.deepEqual(f.ctx.sessionProjections.snapshot(a.session).values.autonomy, { mode: 'chat', chatReadsProject: true });
  const restored = await f.agent('replayed', events(a.session));
  assert.equal(autonomy.foldAutonomyMode(events(restored.session)), 'chat');
  assert.deepEqual((await f.assembly(restored)).tools.map(t => t.name).sort(), readNames);
  const answer = await f.execute(restored, 'autonomy_search_text', { query: '约束' });
  assert.notEqual(answer.isError, true, JSON.stringify(answer));
  await f.autonomyFiber.dispose();
  assert.deepEqual((await f.assembly(a)).tools.map(t => t.name), ['write_probe']);
  assert.notEqual((await f.execute(a, 'write_probe')).isError, true);
});

test('strict Chat remains available with project reads explicitly disabled', async t => {
  const f = await fixture(t, 'native', { chatReadProjectFiles: false }); const a = await f.agent('strict');
  await f.command(a, 'chat'); assert.deepEqual((await f.assembly(a)).tools, []);
  assert.equal((await f.execute(a, 'autonomy_read_file', { file_path: 'source.md' })).isError, true);
  assert.equal((await f.execute(a, 'write_probe')).isError, true);
  await f.command(a, 'agent'); assert.notEqual((await f.execute(a, 'write_probe')).isError, true);
});

test('saved upstream default guidance is migrated to the new project-reading guidance', async t => {
  const f = await fixture(t, 'native', {
    chatGuidance: 'You are in Chat mode. Answer in text without tools. Switch to Agent when action is needed.',
    denyMessage: 'Chat mode does not allow tool execution. Switch this session to Agent mode to use tools.',
  });
  const a = await f.agent('previous-defaults'); await f.command(a, 'chat');
  const prompt = await f.assembly(a);
  assert.match(prompt.sections.find(s => s.name === 'autonomy:chat').text, /locate and read relevant materials/);
  assert.deepEqual(prompt.tools.map(t => t.name).sort(), readNames);
});

test('policy mounts without profile-root filesystems and acquires read dependencies when available', async t => {
  const f = await fixture(t, 'native', {}, true);
  const a = await f.agent('late-filesystem');
  await f.command(a, 'chat');
  assert.deepEqual((await f.assembly(a)).tools, []);
  assert.equal((await f.execute(a, 'write_probe')).isError, true);
  await f.attachFs();
  assert.deepEqual((await f.assembly(a)).tools.map(t => t.name).sort(), readNames);
  const result = await f.execute(a, 'autonomy_read_file', { file_path: 'source.md' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
});
