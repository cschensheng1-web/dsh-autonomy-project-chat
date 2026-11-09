import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createVideoParser, videoRange, timedText } from '../src/video-reader.mjs';
import { createProjectReader, parseReadProgram } from '../src/project-files.mjs';

const mac = { skip: process.platform !== 'darwin' ? 'macOS media dependencies required' : false };
const fixtureBytes = name => fs.readFile(new URL('./fixtures/' + name, import.meta.url));
const parser = createVideoParser();

test('video ranges and subtitles preserve real time offsets with bounded output', () => {
  assert.deepEqual(videoRange(500, {}), { start: 0, end: 120, count: 4 });
  assert.deepEqual(videoRange(500, { start_seconds: 120, end_seconds: 240, frame_count: 2 }), { start: 120, end: 240, count: 2 });
  for (const options of [{ start_seconds: -1 }, { start_seconds: 500 }, { end_seconds: 400 }, { end_seconds: 0 }, { frame_count: 7 }, { frame_count: 1.2 }]) assert.throws(() => videoRange(500, options));
  const cues = timedText('WEBVTT\n\n00:00.000 --> 00:02.500\n转写文字\n\n00:03.000 --> 00:05.000\n第二段', { start: 10, end: 13 }, 10);
  assert.deepEqual(cues.cues, [{ startSeconds: 10, endSeconds: 12.5, text: '转写文字' }]);
  assert.equal(timedText('00:00:00,000 --> 00:00:02,000\n' + '字'.repeat(20000), { start: 0, end: 10 }).truncated, true);
});
test('video PTC admits one owned JSON call and rejects command/model overrides', () => {
  const code = 'return await tools.autonomy_read_video({"file_path":"lesson.mp4","start_seconds":10,"frame_count":2});';
  assert.equal(parseReadProgram({ code }).name, 'autonomy_read_video');
  assert.equal(parseReadProgram({ code, sandbox_permissions: 'require_escalated' }), undefined);
  assert.equal(parseReadProgram({ code: code + ' await tools.bash({});' }), undefined);
  assert.equal(parseReadProgram({ code: 'return await tools.autonomy_read_video({"file_path":process.env.HOME});' }), undefined);
});
test('local video pipeline returns Chinese speech, timestamped frames and OCR without changing input', mac, async () => {
  const bytes = await fixtureBytes('video-lesson.mp4'); const hash = createHash('sha256').update(bytes).digest('hex');
  const result = await parser.parse(bytes, { frame_count: 2, language: 'zh' });
  assert.equal(result.speechStatus, 'transcribed'); assert.equal(result.hasAudio, true);
  assert.match(result.transcript.map(c => c.text).join(''), /数据库课程/);
  assert.ok(result.transcript.every(c => c.startSeconds >= 0 && c.endSeconds > c.startSeconds));
  assert.equal(result.frames.length, 2); assert.ok(result.frames[1].timeSeconds > result.frames[0].timeSeconds);
  assert.ok(result.frames.every(f => f.image[0] === 0xff && f.image[1] === 0xd8));
  assert.match(result.frames[0].ocrText, /数据库课程/); assert.equal(result.truncated, true);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
});
test('embedded subtitles, missing speech model and no-audio videos have explicit coverage status', mac, async () => {
  const subtitles = await parser.parse(await fixtureBytes('video-subtitled.mkv'), { frame_count: 1, transcribe_audio: false });
  assert.match(subtitles.subtitles.map(c => c.text).join(''), /学生信息表/);
  assert.equal(subtitles.speechStatus, 'not-requested');
  const noAudio = await parser.parse(await fixtureBytes('video-no-audio.mp4'), { frame_count: 1 });
  assert.equal(noAudio.hasAudio, false); assert.equal(noAudio.speechStatus, 'no-audio'); assert.deepEqual(noAudio.transcript, []);
  const missing = await createVideoParser({ whisperModelPath: '/private/tmp/dsh-nonexistent-test-model.bin' }).parse(await fixtureBytes('video-lesson.mp4'), { frame_count: 1 });
  assert.equal(missing.speechStatus, 'unavailable'); assert.deepEqual(missing.transcript, []);
  assert.ok(missing.warnings.some(w => w.includes('未找到')));
});
test('malformed files/playlists and cancellation fail before publishing partial results', mac, async () => {
  await assert.rejects(parser.parse(Buffer.from('#EXTM3U\nhttps://invalid.example/private.mp4'), {}), /播放列表|视频格式/);
  const controller = new AbortController(); const pending = createVideoParser().parse(await fixtureBytes('video-lesson.mp4'), { frame_count: 1 }, controller.signal);
  const timer = setTimeout(() => controller.abort(Error('cancel synthetic video')), 50);
  try { await assert.rejects(pending, /cancel synthetic video/); } finally { clearTimeout(timer); }
  assert.equal((await createVideoParser().parse(await fixtureBytes('video-no-audio.mp4'), { frame_count: 1 })).speechStatus, 'no-audio');
});

async function project(t) {
  const temp = await fs.mkdtemp('/private/tmp/dsh-video-reader-test-'); const root = path.join(temp, 'project'); await fs.mkdir(root);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const backend = {
    resolve: async (name, options = {}) => ({ targetKey: await fs.realpath(path.resolve(options.cwd ?? root, name)) }),
    processPath: ref => ref.targetKey,
    contains: (a, b) => { const local = path.relative(a.targetKey, b.targetKey); return !path.isAbsolute(local) && local !== '..' && !local.startsWith('../'); },
    stat: async ref => { const s = await fs.stat(ref.targetKey); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size }; },
    readBytes: ref => fs.readFile(ref.targetKey),
    listDir: async ref => (await fs.readdir(ref.targetKey, { withFileTypes: true })).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
  };
  const agent = { ctx: { fs: backend, workingDirectory: { ensure: async () => root } } };
  const reader = createProjectReader(agent); t.after(() => reader.dispose());
  return { root, temp, backend, reader, exec: { agent, signal: new AbortController().signal } };
}
test('project video reads same-name SRT and preserves project/symlink/credential boundaries', mac, async t => {
  const f = await project(t); const bytes = await fixtureBytes('video-no-audio.mp4');
  await fs.writeFile(path.join(f.root, 'lesson.mp4'), bytes);
  await fs.writeFile(path.join(f.root, 'lesson.srt'), '1\n00:00:00,000 --> 00:00:05,000\n项目内的字幕来源\n');
  const result = await f.reader.video({ file_path: 'lesson.mp4', frame_count: 1, include_images: false }, f.exec);
  assert.match(result.subtitles[0].text, /项目内/); assert.deepEqual(result.subtitleSources, ['lesson.srt']); assert.equal(result.imagesAttached, false);
  await fs.writeFile(path.join(f.temp, 'outside.mp4'), bytes); await fs.symlink(path.join(f.temp, 'outside.mp4'), path.join(f.root, 'alias.mp4'));
  await assert.rejects(f.reader.video({ file_path: 'alias.mp4' }, f.exec), /项目外/);
  await assert.rejects(f.reader.video({ file_path: 'lesson.mp4', subtitle_path: '../outside.mp4' }, f.exec), /项目外/);
  await fs.writeFile(path.join(f.root, '.env.mp4'), bytes);
  await assert.rejects(f.reader.video({ file_path: '.env.mp4' }, f.exec), /凭据|私有/);
  await assert.rejects(f.reader.read({ file_path: 'lesson.mp4' }, f.exec), /autonomy_read_video/);
});
test('video source path is rechecked before processing and oversized files never launch decoders', async t => {
  const f = await project(t); await fs.writeFile(path.join(f.root, 'lesson.mp4'), 'fixture');
  const original = f.backend.readBytes;
  f.backend.readBytes = async ref => { const bytes = await original(ref); await fs.rename(path.join(f.root, 'lesson.mp4'), path.join(f.temp, 'moved.mp4')); await fs.symlink(path.join(f.temp, 'moved.mp4'), path.join(f.root, 'lesson.mp4')); return bytes; };
  await assert.rejects(f.reader.video({ file_path: 'lesson.mp4' }, f.exec), /项目外|路径/);
  const large = path.join(f.root, 'large.mp4'); await fs.writeFile(large, ''); await fs.truncate(large, 256 * 1024 * 1024 + 1);
  await assert.rejects(f.reader.video({ file_path: 'large.mp4' }, f.exec), /256 MiB/);
});
