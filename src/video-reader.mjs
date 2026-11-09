import { spawn } from 'node:child_process';
import { access, stat, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { nativeOCR } from './image-ocr.mjs';

export const VIDEO_EXTENSIONS = new Set('mp4 mov m4v mkv webm avi'.split(' '));
export const VIDEO_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, seconds: 180, defaultSeconds: 120, frames: 6, timeoutMs: 180000 });
export const isVideoName = name => VIDEO_EXTENSIONS.has(String(name).split('.').at(-1).toLowerCase());
let active = false; const queue = [];
async function acquire(signal) {
  signal?.throwIfAborted();
  if (!active) { active = true; return; }
  if (queue.length >= 4) throw Error('视频处理任务较多，请稍后再试。');
  await new Promise((resolve, reject) => {
    const item = { start() { signal?.removeEventListener('abort', cancel); resolve(); } };
    const cancel = () => { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); reject(signal.reason); };
    signal?.addEventListener('abort', cancel, { once: true }); queue.push(item);
  });
}
function release() { if (queue.length) queue.shift().start(); else active = false; }

// Only fixed executables in standard installation directories are admitted.
// No shell, project executables, URLs, arbitrary flags or model paths supplied
// by the LLM are ever dispatched.
export async function findVideoDependencies(modelPath = '') {
  async function find(name) {
    for (const directory of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
      const path = join(directory, name); try { await access(path, constants.X_OK); return path; } catch {}
    }
  }
  const [ffmpeg, ffprobe, whisper] = await Promise.all([find('ffmpeg'), find('ffprobe'), find('whisper-cli')]);
  if (!ffmpeg || !ffprobe) throw Error('视频读取需要本机 FFmpeg/ffprobe。请先在主机安装依赖，Chat 不会自行安装或联网下载。');
  const candidates = modelPath ? [modelPath] : ['large-v3-turbo', 'large-v3-turbo-q5_0', 'small', 'base'].map(name => join(homedir(), '.cache/whisper-models', 'ggml-' + name + '.bin'));
  let model;
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try { const info = await stat(path); if (info.isFile() && info.size >= 1024 * 1024 && info.size <= 4 * 1024 ** 3) { model = path; break; } } catch {}
  }
  return { ffmpeg, ffprobe, whisper, model };
}

function command(executable, args, { signal, cwd, maximum = 4 * 1024 * 1024, timeout = 15000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, env: { HOME: homedir(), TMPDIR: cwd ?? tmpdir(), PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let failure;
    const stop = error => { failure ??= error; child.kill('SIGKILL'); };
    const cancel = () => stop(signal.reason ?? Error('视频处理已取消。'));
    const timer = setTimeout(() => stop(Error('视频处理步骤超过时间上限，请缩短时间段。')), timeout);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    signal?.addEventListener('abort', cancel, { once: true });
    child.stderr.resume(); // Decoder/ASR logs can contain paths and private text.
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maximum) stop(Error('视频处理结果超过大小上限。')); else chunks.push(chunk); });
    child.once('error', () => { cleanup(); reject(Error('本机视频处理程序无法启动，请检查依赖安装。')); });
    child.once('close', code => { cleanup(); if (failure) reject(failure); else if (code !== 0) reject(Error('视频处理程序拒绝了此文件或编码，无法可靠读取。')); else resolve(Buffer.concat(chunks, size)); });
  });
}
function container(bytes) {
  const data = Buffer.from(bytes);
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'matroska';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'AVI ') return 'avi';
  if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(data.subarray(4, 8).toString())) return 'mov';
  throw Error('视频格式未识别。当前支持 MP4/MOV/M4V、MKV/WebM 和 AVI 容器，不接受播放列表、网络地址或伪装文件。');
}
const inputOptions = kind => ['-protocol_whitelist', 'file,pipe', '-format_whitelist', kind, '-f', kind,
  ...(kind === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-probesize', '8388608', '-analyzeduration', '5000000'];
const ffmpegOptions = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '67108864', '-threads', '1', '-filter_threads', '1'];
export function videoRange(duration, options = {}) {
  const start = options.start_seconds ?? 0;
  const end = Math.min(options.end_seconds ?? start + VIDEO_LIMITS.defaultSeconds, duration);
  const count = options.frame_count ?? 4;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw Error('视频时长无效或超过 24 小时。');
  if (!Number.isFinite(start) || start < 0 || start >= duration || !Number.isFinite(end) || end <= start) throw Error('请提供视频内有效的起止秒数。');
  if (end - start > VIDEO_LIMITS.seconds) throw Error('每次最多处理 180 秒，请按时间段继续读取。');
  if (!Number.isSafeInteger(count) || count < 1 || count > VIDEO_LIMITS.frames) throw Error('frame_count 必须是 1 到 6 的整数。');
  return { start, end, count };
}
export function timeLabel(value) {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  return [Math.floor(milliseconds / 3600000), Math.floor(milliseconds / 60000) % 60, Math.floor(milliseconds / 1000) % 60].map(n => String(n).padStart(2, '0')).join(':') + '.' + String(milliseconds % 1000).padStart(3, '0');
}
function seconds(value) {
  const match = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000;
}
export function timedText(source, range, offset = 0) {
  const cues = []; let chars = 0; let truncated = false;
  for (const block of String(source).replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n'); const index = lines.findIndex(line => line.includes('-->')); if (index < 0) continue;
    const times = lines[index].split('-->'); const a = seconds(times[0]), b = seconds(times[1]?.trim().split(/\s+/)[0] ?? '');
    if (a === undefined || b === undefined || b < a) continue;
    const startSeconds = a + offset, endSeconds = b + offset;
    if (endSeconds < range.start || startSeconds >= range.end) continue;
    const original = lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000e-\u001f]/g, '').trim();
    if (!original) continue;
    const text = original.slice(0, Math.min(3000, 12000 - chars));
    if (text) cues.push({ startSeconds, endSeconds, text }); chars += text.length;
    if (text.length < original.length || cues.length >= 200 || chars >= 12000) { truncated = true; break; }
  }
  return { cues, truncated };
}
function silentWav(bytes) {
  for (let index = 12; index + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(index + 4); const start = index + 8;
    if (bytes.toString('ascii', index, index + 4) === 'data') {
      const end = Math.min(bytes.length, start + size); let peak = 0;
      for (let i = start; i + 1 < end; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
      return peak < 8;
    }
    index = start + size + (size % 2);
  }
  return false;
}
async function transcribe(dependencies, input, kind, temp, range, options, signal) {
  const { ffmpeg, whisper, model } = dependencies;
  if (!whisper || !model) return { status: 'unavailable', cues: [], warnings: ['本机未找到 whisper-cli 或离线模型，音轨尚未转写；可配置 videoWhisperModelPath，未调用云端替代服务。'] };
  const language = options.language ?? 'auto';
  if (!['auto', 'zh', 'en'].includes(language)) throw Error('language 目前支持 auto、zh 或 en。');
  const wave = join(temp, 'audio.wav'); const output = join(temp, 'transcript');
  await command(ffmpeg, [...ffmpegOptions, ...inputOptions(kind), '-ss', String(range.start), '-i', input, '-t', String(range.end - range.start), '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-fs', '8388608', wave], { signal, cwd: temp });
  if ((await stat(wave)).size > 8 * 1024 * 1024) throw Error('视频音频片段超过大小上限。');
  const audio = await readFile(wave);
  if (silentWav(audio)) return { status: 'silent', cues: [], warnings: ['所选时间段的音轨近乎静音，未生成语音转写。'] };
  await command(whisper, ['-m', model, '-f', wave, '-l', language, '-t', '4', '-bo', '1', '-bs', '1', '-nf', '-sns', '-oj', '-of', output, '-np'], { signal, cwd: temp, timeout: 120000, maximum: 1024 * 1024 });
  const file = output + '.json'; if ((await stat(file)).size > 4 * 1024 * 1024) throw Error('语音转写结果过大。');
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(data.transcription)) throw Error('本机转写返回格式不受支持。');
  const source = data.transcription.map(row => {
    const a = Number.isFinite(row.offsets?.from) ? row.offsets.from / 1000 : seconds(row.timestamps?.from ?? '');
    const b = Number.isFinite(row.offsets?.to) ? row.offsets.to / 1000 : seconds(row.timestamps?.to ?? '');
    return a === undefined || b === undefined ? '' : `${timeLabel(a)} --> ${timeLabel(b)}\n${String(row.text ?? '')}`;
  }).join('\n\n');
  const result = timedText(source, range, range.start);
  return { status: result.cues.length ? 'transcribed' : 'no-text', ...result, warnings: ['语音在本机使用已有 Whisper 模型转写；识别文字和时间点可能有误，未进行说话人身份判断。'] };
}

export function createVideoParser(config = {}) {
  const cache = new Map(); let bytesCached = 0;
  return {
    async parse(bytes, options = {}, signal) {
      if (!(bytes instanceof Uint8Array) || bytes.length > VIDEO_LIMITS.bytes) throw Error('视频文件超过 256 MiB 或内容无效。');
      signal?.throwIfAborted();
      const key = createHash('sha256').update(bytes).update(JSON.stringify(options)).digest('hex');
      if (cache.has(key)) return cache.get(key).result;
      const kind = container(bytes); const dependencies = await findVideoDependencies(config.whisperModelPath);
      await acquire(signal); const deadline = AbortSignal.timeout(VIDEO_LIMITS.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let temp;
      try {
        combined.throwIfAborted(); temp = await mkdtemp(join(tmpdir(), 'dsh-chat-video-'));
        const input = join(temp, 'input.media'); await writeFile(input, bytes, { mode: 0o600, signal: combined });
        const raw = await command(dependencies.ffprobe, ['-v', 'error', '-max_alloc', '67108864', ...inputOptions(kind), '-show_entries', 'format=duration,format_name:stream=index,codec_type,codec_name,width,height,duration,avg_frame_rate', '-of', 'json', input], { signal: combined, cwd: temp, maximum: 1024 * 1024 });
        const metadata = JSON.parse(raw.toString('utf8')); const streams = metadata.streams ?? [];
        if (streams.length > 32) throw Error('视频轨道数量过多。');
        const video = streams.find(s => s.codec_type === 'video');
        if (!video || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) || video.width <= 0 || video.height <= 0 || video.width * video.height > 40_000_000) throw Error('没有可读取的画面轨道，或视频画面超过 4000 万像素。');
        const duration = Number(metadata.format?.duration ?? video.duration); const range = videoRange(duration, options);
        const hasAudio = streams.some(s => s.codec_type === 'audio'); const warnings = ['仅处理指定时间段并均匀抽样关键帧，可能遗漏动作、瞬时画面和画外信息；不能据此声称完整观看视频。'];
        let captions = { cues: [], truncated: false };
        const subtitle = streams.find(s => s.codec_type === 'subtitle' && ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'].includes(s.codec_name));
        if (subtitle) {
          try {
            const raw = await command(dependencies.ffmpeg, [...ffmpegOptions, ...inputOptions(kind), '-i', input, '-map', `0:${subtitle.index}`, '-c:s', 'srt', '-f', 'srt', 'pipe:1'], { signal: combined, cwd: temp });
            captions = timedText(raw.toString('utf8'), range);
          } catch { combined.throwIfAborted(); warnings.push('内嵌字幕未能提取，未将缺失字幕当作视频无语音。'); }
        }
        let speech = { status: hasAudio ? 'not-requested' : 'no-audio', cues: [], warnings: [] };
        if (hasAudio && options.transcribe_audio !== false) {
          try { speech = await transcribe(dependencies, input, kind, temp, range, options, combined); }
          catch { combined.throwIfAborted(); speech = { status: 'failed', cues: [], warnings: ['本机语音转写未完成；当前结果不包含该时间段的完整语音。可缩短时间段重试。'] }; }
        }
        warnings.push(...speech.warnings);
        if (speech.truncated) warnings.push('语音文字超过返回上限，请缩短时间段继续读取。');
        if (captions.truncated) warnings.push('内嵌字幕超过返回上限，请缩短时间段继续读取。');
        const frames = [];
        const rate = /^(\d+)\/(\d+)$/.exec(video.avg_frame_rate ?? '');
        const fps = rate && Number(rate[2]) > 0 ? Number(rate[1]) / Number(rate[2]) : 25;
        const visualEnd = Math.min(range.end, Number(video.duration) || duration);
        const lastFrame = Math.max(range.start, visualEnd - 1 / Math.max(0.1, fps));
        for (let index = 0; index < range.count; index++) {
          combined.throwIfAborted();
          const time = range.count === 1 ? (range.start + lastFrame) / 2 : range.start + (lastFrame - range.start) * index / (range.count - 1);
          let image;
          try { image = await command(dependencies.ffmpeg, [...ffmpegOptions, ...inputOptions(kind), '-ss', String(time), '-i', input, '-map', `0:${video.index}`, '-frames:v', '1', '-an', '-sn', '-dn', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'], { signal: combined, cwd: temp }); }
          catch { combined.throwIfAborted(); warnings.push(`约 ${timeLabel(time)} 的关键帧未能解码。`); continue; }
          if (!image.length) { warnings.push(`约 ${timeLabel(time)} 的关键帧未能读取。`); continue; }
          let ocrText = '';
          try { ocrText = (await nativeOCR(image, {}, combined)).sections.map(s => s.text).join('\n').slice(0, 2000); }
          catch { combined.throwIfAborted(); warnings.push(`约 ${timeLabel(time)} 的画面文字识别未完成。`); }
          frames.push({ timeSeconds: Math.round(time * 1000) / 1000, timeLabel: timeLabel(time), ocrText, image });
        }
        const result = { durationSeconds: duration, rangeStartSeconds: range.start, rangeEndSeconds: range.end, hasAudio, speechStatus: speech.status, transcript: speech.cues, subtitles: captions.cues, frames, warnings, truncated: true };
        const size = frames.reduce((n, f) => n + f.image.length + f.ocrText.length * 2, 0) + JSON.stringify({ transcript: speech.cues, subtitles: captions.cues }).length * 2;
        if (size <= 16 * 1024 * 1024) {
          cache.set(key, { result, size }); bytesCached += size;
          while (cache.size > 2 || bytesCached > 16 * 1024 * 1024) { const first = cache.keys().next().value; bytesCached -= cache.get(first).size; cache.delete(first); }
        }
        return result;
      } catch (error) {
        if (deadline.aborted && !signal?.aborted) throw Error('视频处理超过 180 秒，请缩短时间段。');
        throw error;
      } finally { try { if (temp) await rm(temp, { recursive: true, force: true }); } finally { release(); } }
    },
    dispose() { cache.clear(); bytesCached = 0; },
  };
}
