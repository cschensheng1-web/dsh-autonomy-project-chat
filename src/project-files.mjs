import { isAbsolute, relative, sep } from 'node:path';
import { createDocumentParser } from './document-reader.mjs';
import { DOCUMENT_LIMITS } from './document-common.mjs';
import { decodeText } from './document-common.mjs';
import { createVideoParser, isVideoName, VIDEO_LIMITS, timedText } from './video-reader.mjs';

export const PROJECT_READ_TOOLS = ['autonomy_read_file', 'autonomy_list_files', 'autonomy_search_text', 'autonomy_list_archive', 'autonomy_read_video'];
// PTC transports may invoke exactly one owned read tool using JSON literals.
// No loops, imports, variables, templates, comments or escalation arguments.
export function parseReadProgram(args) {
  if (!args || typeof args !== 'object' || Object.keys(args).some(key => !['code', 'description'].includes(key)) || typeof args.code !== 'string' || args.code.length > 8192) return;
  const match = /^\s*return\s+await\s+tools\.(autonomy_(?:read_file|list_files|search_text|list_archive|read_video))\((\{[\s\S]*\})\);?\s*$/.exec(args.code);
  if (!match) return;
  let value;
  try { value = JSON.parse(match[2]); } catch { return; }
  if (!value || Array.isArray(value) || Object.entries(value).some(([key, val]) => ['__proto__', 'constructor', 'prototype'].includes(key) || !['string', 'number', 'boolean'].includes(typeof val))) return;
  return { name: match[1], arguments: value };
}
const MAX_BYTES = DOCUMENT_LIMITS.inputBytes;
const MAX_TEXT = 24000;
const MAX_ENTRIES = 400;
const MAX_SCANNED = 2500;
const MAX_SEARCH_FILES = 80;
const secretName = name => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|(?:credentials|secrets|tokens?)\.(?:json|ya?ml|toml))$/i.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
const blockedDirectory = name => ['.git', '.ssh', '.aws', '.gnupg', '.azure', '.kube'].includes(name.toLowerCase());
const hiddenInSearch = name => blockedDirectory(name) || ['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build'].includes(name);
function safeRelative(path) {
  return path.split(/[\\/]/).filter(Boolean).every(part => !secretName(part) && !blockedDirectory(part));
}
function abort(signal) { signal?.throwIfAborted(); }
function boundedInteger(value, fallback, maximum) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw Error(`参数必须是 1 到 ${maximum} 的整数。`);
  return result;
}

// This capability reads through DSH's composed filesystem, resolves every target,
// and checks canonical containment. It does not call native read tools behind
// autonomy's guard, use a shell, fetch URLs, or copy a private project database.
export function createProjectReader(agent, context = agent.ctx, config = {}) {
  const parser = createDocumentParser();
  const videoParser = createVideoParser(config);
  async function rootFor(exec) {
    if (exec?.agent && exec.agent !== agent) throw Error('此读取能力只属于当前会话。');
    const signal = exec?.signal;
    abort(signal);
    const ctx = context;
    const cwd = await ctx.workingDirectory.ensure(agent, signal);
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw Error('当前 Chat 没有可读取的本地项目目录。');
    const root = await ctx.fs.resolve(cwd, { signal });
    const physical = ctx.fs.processPath(root);
    if (typeof physical !== 'string' || !isAbsolute(physical) || blockedDirectory(physical.split(/[\\/]/).at(-1))) throw Error('当前项目目录不适合只读 Chat。');
    const info = await ctx.fs.stat(root, signal);
    if (info?.type !== 'directory') throw Error('当前项目目录不存在，请先在 DSH 中打开项目。');
    return { ctx, root, physical, signal };
  }
  async function targetFor(scope, requested = '.') {
    if (typeof requested !== 'string' || requested.length > 4096 || /[\u0000-\u001f]/.test(requested)) throw Error('请提供项目内的有效文件路径。');
    if (!safeRelative(requested)) throw Error('只读 Chat 不读取凭据文件或私有配置目录，请改选项目资料。');
    abort(scope.signal);
    const target = await scope.ctx.fs.resolve(requested, { cwd: scope.physical, signal: scope.signal });
    if (!scope.ctx.fs.contains(scope.root, target)) throw Error('只读 Chat 仅能读取当前项目内的文件，项目外路径和外部符号链接已阻止。');
    const actual = scope.ctx.fs.processPath(target);
    if (typeof actual !== 'string' || !isAbsolute(actual)) throw Error('文件没有可验证的本地项目路径。');
    const local = relative(scope.physical, actual);
    if (local === '..' || local.startsWith('..' + sep) || isAbsolute(local) || !safeRelative(local)) throw Error('只读 Chat 不读取项目外路径或凭据文件。');
    return { target, path: local.split(sep).join('/') || '.', actual };
  }
  async function readDocument(scope, resolved, options = {}) {
    const info = await scope.ctx.fs.stat(resolved.target, scope.signal);
    if (info?.type !== 'file') throw Error('请选择项目中的文档文件。');
    if (typeof info.size === 'number' && info.size > MAX_BYTES) throw Error('文件超过 32 MiB，请选择较小的文档。');
    const bytes = await scope.ctx.fs.readBytes(resolved.target, scope.signal, MAX_BYTES);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw Error('文件内容超出只读 Chat 的读取范围。');
    const before = await targetFor(scope, resolved.path);
    if (before.actual !== resolved.actual) throw Error('读取期间文件路径发生变化，请重新读取。');
    const result = await parser.parse(bytes, resolved.path, options, scope.signal);
    // Re-resolve before publishing to reject a changed symlink or directory.
    const fresh = await targetFor(scope, resolved.path);
    if (fresh.actual !== resolved.actual) throw Error('读取期间文件路径发生变化，请重新读取。');
    abort(scope.signal);
    return result;
  }
  async function walk(scope, requested, recursive, maximum) {
    const start = await targetFor(scope, requested);
    if ((await scope.ctx.fs.stat(start.target, scope.signal))?.type !== 'directory') throw Error('请选择项目中的目录。');
    const queue = [{ ...start, depth: 0 }]; const visited = new Set(); const entries = [];
    let scanned = 0; let truncated = false;
    while (queue.length) {
      abort(scope.signal);
      const current = queue.shift();
      if (visited.has(current.actual)) continue;
      visited.add(current.actual);
      const children = await scope.ctx.fs.listDir(current.target, scope.signal);
      for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++scanned > MAX_SCANNED) { truncated = true; break; }
        if (!entry.name || /[\\/\u0000-\u001f]/.test(entry.name) || entry.name === '.' || entry.name === '..' || secretName(entry.name) || hiddenInSearch(entry.name)) continue;
        let child;
        try { child = await targetFor(scope, current.path === '.' ? entry.name : current.path + '/' + entry.name); }
        catch (error) { abort(scope.signal); continue; }
        const info = await scope.ctx.fs.stat(child.target, scope.signal);
        if (!info || !['file', 'directory'].includes(info.type)) continue;
        entries.push({ path: child.path, type: info.type });
        if (recursive && info.type === 'directory') {
          if (current.depth < 5) queue.push({ ...child, depth: current.depth + 1 }); else truncated = true;
        }
        if (entries.length >= maximum) { truncated = true; break; }
      }
      if (truncated && (entries.length >= maximum || scanned > MAX_SCANNED)) break;
    }
    return { path: start.path, entries, truncated };
  }
  return {
    async video(args, exec) {
      const admitted = ['file_path', 'start_seconds', 'end_seconds', 'frame_count', 'transcribe_audio', 'language', 'include_images', 'subtitle_path'];
      if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(key => !admitted.includes(key))) throw Error('视频读取不接受命令、模型路径、权限升级或其他额外参数。');
      if (typeof args.file_path !== 'string') throw Error('请提供项目内的视频文件路径。');
      for (const key of ['include_images', 'transcribe_audio']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw Error(`${key} 必须是布尔值。`);
      for (const key of ['start_seconds', 'end_seconds', 'frame_count']) if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isFinite(args[key]))) throw Error(`${key} 必须是有效数字。`);
      if (args.language !== undefined && !['auto', 'zh', 'en'].includes(args.language)) throw Error('language 目前支持 auto、zh 或 en。');
      if (args.subtitle_path !== undefined && typeof args.subtitle_path !== 'string') throw Error('请提供项目内的字幕路径。');
      const scope = await rootFor(exec); const resolved = await targetFor(scope, args.file_path);
      if (!isVideoName(resolved.path)) throw Error('请提供项目内的 MP4/MOV/M4V、MKV/WebM 或 AVI 文件。');
      const info = await scope.ctx.fs.stat(resolved.target, scope.signal);
      if (info?.type !== 'file' || info.size > VIDEO_LIMITS.bytes) throw Error('请选择不超过 256 MiB 的项目视频文件。');
      const bytes = await scope.ctx.fs.readBytes(resolved.target, scope.signal, VIDEO_LIMITS.bytes);
      if (!(bytes instanceof Uint8Array) || bytes.length > VIDEO_LIMITS.bytes) throw Error('视频超过 256 MiB 读取上限。');
      const checkPath = async () => { const fresh = await targetFor(scope, resolved.path); if (fresh.actual !== resolved.actual) throw Error('视频路径在读取期间发生变化，请重新读取。'); abort(scope.signal); };
      await checkPath();
      if (args.subtitle_path !== undefined) await targetFor(scope, args.subtitle_path);
      const options = Object.fromEntries(['start_seconds', 'end_seconds', 'frame_count', 'transcribe_audio', 'language'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
      const result = await videoParser.parse(bytes, options, scope.signal);
      await checkPath();
      const warnings = [...result.warnings]; const sources = []; const captions = [];
      let captionChars = 0;
      const append = cues => { for (const cue of cues) {
        if (captions.length >= 200 || captionChars >= 8000) break;
        if (captions.some(c => c.startSeconds === cue.startSeconds && c.endSeconds === cue.endSeconds && c.text === cue.text)) continue;
        const text = cue.text.slice(0, 8000 - captionChars); captions.push({ ...cue, text }); captionChars += text.length;
      } };
      append(result.subtitles); if (result.subtitles.length) sources.push('内嵌字幕');
      const base = resolved.path.slice(0, resolved.path.lastIndexOf('.'));
      for (const requested of args.subtitle_path ? [args.subtitle_path] : [base + '.srt', base + '.vtt']) {
        let sidecar;
        try { sidecar = await targetFor(scope, requested); } catch (error) { if (args.subtitle_path) throw error; continue; }
        try {
          const metadata = await scope.ctx.fs.stat(sidecar.target, scope.signal);
          if (metadata?.type !== 'file' || metadata.size > 2 * 1024 * 1024) throw Error('字幕文件过大或不是普通文件。');
          const data = await scope.ctx.fs.readBytes(sidecar.target, scope.signal, 2 * 1024 * 1024);
          if (data.length > 2 * 1024 * 1024) throw Error('字幕文件过大。');
          const parsed = timedText(decodeText(data, sidecar.path).text, { start: result.rangeStartSeconds, end: result.rangeEndSeconds });
          const fresh = await targetFor(scope, sidecar.path); if (fresh.actual !== sidecar.actual) throw Error('字幕路径在读取期间改变。');
          append(parsed.cues); if (parsed.cues.length) sources.push(sidecar.path);
          if (parsed.truncated) warnings.push('字幕超出返回上限，已截取部分内容。');
        } catch (error) { abort(scope.signal); if (args.subtitle_path) throw error; warnings.push('同名字幕文件未能可靠读取。'); }
      }
      if (captionChars >= 8000 || captions.length >= 200) warnings.push('字幕达到本次返回上限，未返回全部字幕。');
      const frames = result.frames.map(({ image, ...frame }) => frame);
      let imagesAttached = false;
      if (args.include_images !== false && frames.length) {
        const attachments = scope.ctx.get?.('attachments');
        if (attachments?.saveImages) {
          await checkPath();
          try {
            const refs = await attachments.saveImages(result.frames.map(frame => ({ data: frame.image, mediaType: 'image/jpeg', name: `video-${frame.timeLabel.replaceAll(':', '-')}.jpg` })));
            if (refs.length !== frames.length) throw Error('附件数量不匹配。');
            refs.forEach((attachment, index) => { frames[index].attachment = attachment; }); imagesAttached = true;
          } catch { abort(scope.signal); warnings.push('关键帧图片未能交给模型，当前返回转写、字幕和 OCR 文字，不能据此声称看到了原图。'); }
        } else warnings.push('当前 DSH 未提供图片附件服务，只返回转写、字幕和画面文字。');
      }
      await checkPath();
      return { path: resolved.path, format: 'video', durationSeconds: result.durationSeconds, rangeStartSeconds: result.rangeStartSeconds, rangeEndSeconds: result.rangeEndSeconds, hasAudio: result.hasAudio, speechStatus: result.speechStatus, transcript: result.transcript, subtitles: captions.sort((a, b) => a.startSeconds - b.startSeconds), subtitleSources: sources, frames, imagesAttached, imageContextOnly: Boolean(exec?.parent), warnings, truncated: true };
    },
    async read(args, exec) {
      const offset = boundedInteger(args.offset, 1, 10000000);
      const limit = boundedInteger(args.limit, 200, 400);
      const scope = await rootFor(exec);
      const resolved = await targetFor(scope, args.file_path);
      if (isVideoName(resolved.path)) throw Error('视频请调用 autonomy_read_video，可直接在 Chat 中读取语音、字幕和关键帧，无需切换 Agent。');
      const options = { ...(args.archive_entry === undefined ? {} : { entry: args.archive_entry }), ...(args.ocr === undefined ? {} : { ocr: args.ocr }), ...(args.page === undefined ? {} : { page: args.page }) };
      const document = await readDocument(scope, resolved, options);
      if (document.format === 'zip') {
        const listing = JSON.stringify(document.entries.slice(0, 150), null, 2);
        return { path: resolved.path, format: 'zip', text: listing.slice(0, MAX_TEXT), totalLines: 0, offset: 1, warnings: document.warnings, truncated: document.entries.length > 150 || listing.length > MAX_TEXT };
      }
      const value = document.sections.map(s => (s.location ? `[${s.location}]\n` : '') + s.text).join('\n\n');
      const lines = value.split(/\r?\n/); const selected = [];
      let chars = 0; let lineTruncated = false;
      for (let index = offset - 1; index < Math.min(lines.length, offset - 1 + limit); index++) {
        const line = `${index + 1}: ${lines[index]}`;
        if (chars + line.length > MAX_TEXT) {
          if (!selected.length) selected.push(line.slice(0, MAX_TEXT - 16) + ' … [本行截断]');
          lineTruncated = true;
          break;
        }
        selected.push(line); chars += line.length + 1;
      }
      const warnings = [...document.warnings];
      if (!value.trim()) warnings.push('未提取到可读正文，不能根据空结果推断文件内容。');
      return { path: resolved.path, ...(args.archive_entry === undefined ? {} : { archiveEntry: args.archive_entry }), format: document.format, ...(document.totalPages === undefined ? {} : { totalPages: document.totalPages }), ...(document.encoding ? { encoding: document.encoding } : {}), text: selected.join('\n'), totalLines: lines.length, offset, warnings, truncated: document.truncated || lineTruncated || offset - 1 + selected.length < lines.length };
    },
    async archive(args, exec) {
      const scope = await rootFor(exec); const resolved = await targetFor(scope, args.file_path);
      const limit = boundedInteger(args.limit, 150, 400);
      const document = await readDocument(scope, resolved, { operation: 'list' });
      return { path: resolved.path, entries: document.entries.slice(0, limit), warnings: document.warnings, truncated: document.truncated || document.entries.length > limit };
    },
    async list(args, exec) {
      const scope = await rootFor(exec);
      return walk(scope, args.path ?? '.', args.recursive === true, boundedInteger(args.limit, 150, MAX_ENTRIES));
    },
    async search(args, exec) {
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200) throw Error('请提供 1 到 200 字的普通搜索文字。');
      const scope = await rootFor(exec);
      const listing = await walk(scope, args.path ?? '.', true, MAX_ENTRIES);
      const candidates = listing.entries.filter(entry => entry.type === 'file');
      const matches = []; let filesRead = 0; let skipped = 0; let incomplete = false; const issues = [];
      const query = args.query.toLocaleLowerCase();
      const maximum = boundedInteger(args.limit, 30, 50);
      for (const file of candidates.slice(0, MAX_SEARCH_FILES)) {
        abort(scope.signal);
        if (isVideoName(file.path)) { skipped++; if (issues.length < 8) issues.push({ path: file.path, reason: '视频需用 autonomy_read_video 按时间段读取，目录文字搜索不自动扫描整段视频。' }); continue; }
        let document; const resolved = await targetFor(scope, file.path);
        try { document = await readDocument(scope, resolved); filesRead++; }
        catch (error) { abort(scope.signal); skipped++; if (issues.length < 8) issues.push({ path: file.path, reason: error.message }); continue; }
        const documents = [];
        if (document.format === 'zip') {
          const candidates = document.entries.filter(e => e.supported);
          for (const entry of candidates.slice(0, 12)) {
            try { documents.push({ document: await readDocument(scope, resolved, { entry: entry.path }), archiveEntry: entry.path }); }
            catch (error) { abort(scope.signal); skipped++; if (issues.length < 8) issues.push({ path: file.path + ':' + entry.path, reason: error.message }); }
          }
          if (candidates.length > 12) issues.push({ path: file.path, reason: '搜索只读取 ZIP 内前 12 个受支持文档。' });
        } else documents.push({ document });
        for (const item of documents) {
          if (item.document.truncated) { incomplete = true; if (issues.length < 8) issues.push({ path: file.path, reason: '文档达到提取上限，仅搜索已提取部分。' }); }
          if (!item.document.sections.some(s => s.text.trim())) { incomplete = true; if (issues.length < 8) issues.push({ path: file.path, reason: '此文档没有提取到可搜索的正文；可能是扫描件。' }); }
          const content = item.document.sections.map(s => (s.location ? `[${s.location}]\n` : '') + s.text).join('\n\n');
          let location;
          for (const [index, line] of content.split(/\r?\n/).entries()) {
            if (line.startsWith('[') && line.endsWith(']')) location = line.slice(1, -1);
            if (line.toLocaleLowerCase().includes(query)) matches.push({ path: file.path, ...(item.archiveEntry ? { archiveEntry: item.archiveEntry } : {}), ...(location ? { location } : {}), line: index + 1, text: line.slice(0, 500) });
            if (matches.length >= maximum) break;
          }
          if (matches.length >= maximum) break;
        }
        if (matches.length >= maximum) break;
      }
      return { matches, filesRead, skipped, issues, truncated: incomplete || listing.truncated || candidates.length > MAX_SEARCH_FILES || matches.length >= maximum || issues.length > 0 };
    },
    dispose() { parser.dispose(); videoParser.dispose(); },
  };
}

const field = (type, description, required = false) => ({ type, description, ...required ? { required: true } : {} });
const stringValue = { type: 'string', required: true };
const integerValue = { type: 'integer', required: true };
const booleanValue = { type: 'boolean', required: true };
const object = properties => ({
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(Object.entries(properties).map(([name, value]) => {
    const copy = { ...value }; if (typeof copy.required === 'boolean') delete copy.required; return [name, copy];
  })),
  required: Object.entries(properties).filter(([, value]) => value.required === true).map(([name]) => name),
});
export function registerProjectReadTools(agent, ctx = agent.ctx, config = {}) {
  const reader = createProjectReader(agent, ctx, config); const owned = new Map(); const disposers = [];
  const add = (name, description, parameters, properties, execute, render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]) => {
    disposers.push(ctx.tools.register({ name, description, parameters: object(parameters), output: { schema: object(properties), render }, isConcurrencySafe: () => name !== 'autonomy_read_video', execute }));
    owned.set(name, ctx.tools.get(name, agent));
  };
  try {
    const cue = object({ startSeconds: { type: 'number', required: true }, endSeconds: { type: 'number', required: true }, text: stringValue });
    add('autonomy_read_video', '只读项目内视频：自动使用本机 FFmpeg、Whisper 离线模型、OCR 提取指定时间段的语音转写、字幕和关键帧；支持MP4/MOV/M4V、MKV/WebM、AVI。无需切换Agent。默认前120秒、4帧，每次最多180秒/6帧。关键帧可交给支持视觉的当前模型。时间点近似；遵守speechStatus、warnings与truncated，不能把抽样称为完整观看。', { file_path: field('string', '项目内视频路径，不接受网址。', true), start_seconds: field('number', '起始秒数，默认0。'), end_seconds: field('number', '结束秒数，默认起点后120秒；每次跨度最多180秒。'), frame_count: field('number', '均匀抽取1到6帧，默认4。'), transcribe_audio: field('boolean', '默认true：调用主机已有whisper-cli和离线模型转写音轨。'), language: { ...field('string', '语音语言：auto自动检测、zh中文、en英文。'), enum: ['auto', 'zh', 'en'] }, include_images: field('boolean', '默认true：将关键帧交给DSH图片管线；false仅返回语音/字幕/OCR文字。图片输入会按所选模型计量。'), subtitle_path: field('string', '可选项目内SRT/VTT路径；默认读取视频同名字幕和内嵌字幕。') }, { path: stringValue, format: stringValue, durationSeconds: { type: 'number', required: true }, rangeStartSeconds: { type: 'number', required: true }, rangeEndSeconds: { type: 'number', required: true }, hasAudio: booleanValue, speechStatus: stringValue, transcript: { type: 'array', required: true, items: cue }, subtitles: { type: 'array', required: true, items: cue }, subtitleSources: { type: 'array', required: true, items: { type: 'string' } }, frames: { type: 'array', required: true, items: object({ timeSeconds: { type: 'number', required: true }, timeLabel: stringValue, ocrText: stringValue, attachment: { type: 'object', additionalProperties: true } }) }, imagesAttached: booleanValue, imageContextOnly: booleanValue, warnings: { type: 'array', required: true, items: { type: 'string' } }, truncated: booleanValue }, reader.video, (_args, value) => {
      const visible = { ...value, frames: value.frames.map(({ attachment, ...frame }) => frame) }; delete visible.imageContextOnly;
      const text = value.imageContextOnly && value.imagesAttached ? `视频 ${value.path}，范围 ${value.rangeStartSeconds} 至 ${value.rangeEndSeconds} 秒。转写、字幕和OCR见本次run_code返回值；以下为对应抽样画面。` : JSON.stringify(visible, null, 2);
      const content = [{ type: 'text', text }];
      for (const frame of value.frames) if (frame.attachment) content.push({ type: 'text', text: `抽样关键帧，约 ${frame.timeLabel}` }, { type: 'image', attachment: frame.attachment });
      return content;
    });
    add('autonomy_read_file', '只读当前项目的文档正文：Word(doc/docx)、PPT(ppt/pptx，含备注)、PDF文字层、Excel、OpenDocument、EPUB、RTF、HTML及UTF-8/UTF-16/GB18030文本。自动按格式解析，不用切到Agent。按提取后的行号分段，保留页/幻灯片/章节标记；图片(PNG/JPEG/WebP/TIFF/HEIC等)自动在本机OCR；纯扫描PDF自动识别前3页，指定ocr:true和page可逐页读取。OCR有错漏，不等于视觉理解；不能读加密或损坏文件。ZIP用archive_entry指定包内文档，不在磁盘解压。', { file_path: field('string', '相对于当前项目的文件路径。', true), archive_entry: field('string', '可选：ZIP 内文档或图片的完整条目路径，先用 autonomy_list_archive 查看。'), ocr: field('boolean', 'PDF指定页需OCR时设true，默认先提取文字层；图片自动OCR。'), page: field('number', 'OCR时读取第几页/帧，1到600；PDF搭配ocr:true，TIFF等多页图片可直接指定。'), offset: field('number', '提取正文的起始行，从 1 开始；不是原文档排版行。'), limit: field('number', '最多 400 行，默认 200；单次最多约 24,000 字符。') }, { path: stringValue, archiveEntry: field('string', '包内条目'), format: stringValue, totalPages: field('integer', 'PDF或多帧图片的总页数'), encoding: field('string', '纯文字编码'), text: stringValue, offset: integerValue, totalLines: integerValue, warnings: { type: 'array', required: true, items: { type: 'string' } }, truncated: booleanValue }, reader.read);
    add('autonomy_list_files', '只读列出当前项目内的文件目录，寻找资料。项目外符号链接、凭据与依赖目录会跳过；不会运行命令。', { path: field('string', '相对项目的目录，默认当前项目。'), recursive: field('boolean', '是否有限递归，默认 false。'), limit: field('number', '最多 400 项，默认 150。') }, { path: stringValue, entries: { type: 'array', required: true, items: object({ path: stringValue, type: stringValue }) }, truncated: booleanValue }, reader.list);
    add('autonomy_list_archive', '只读查看ZIP内的文档目录、文件大小和格式支持情况。不展开到磁盘，不读取加密条目、符号链接或凭据。可用read_file的archive_entry读取其中的文档；数据库MDF/LDF不是文档正文。', { file_path: field('string', '项目内ZIP路径。', true), limit: field('number', '最多400项，默认150。') }, { path: stringValue, entries: { type: 'array', required: true, items: object({ path: stringValue, size: integerValue, type: stringValue, supported: booleanValue, encrypted: booleanValue }) }, warnings: { type: 'array', required: true, items: { type: 'string' } }, truncated: booleanValue }, reader.archive);
    add('autonomy_search_text', '在当前项目的文本、Word、PPT、PDF文字层等文档正文中搜索普通文字。ZIP内最多搜索12个文档；只做有上限的检索，注意issues和truncated。标明提取后的文件行号、页或幻灯片位置；不修改文件、不运行命令。', { query: field('string', '需要查找的普通文字，不超过 200 字。', true), path: field('string', '相对项目的搜索目录，默认当前项目。'), limit: field('number', '最多 50 个匹配，默认 30。') }, { matches: { type: 'array', required: true, items: object({ path: stringValue, archiveEntry: field('string', '包内条目'), location: field('string', '页或章节'), line: integerValue, text: stringValue }) }, filesRead: integerValue, skipped: integerValue, issues: { type: 'array', required: true, items: object({ path: stringValue, reason: stringValue }) }, truncated: booleanValue }, reader.search);
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error; }
  const admitted = toolSet => ctx.tools.schemas(agent, toolSet).filter(schema => owned.has(schema.name) && ctx.tools.get(schema.name, agent, toolSet) === owned.get(schema.name));
  const ptcSchema = () => ctx.tools.selectExecutor(agent).describe([]).schemas.find(schema => schema.name === 'run_code');
  return {
    allows(exec) {
      if (exec.agent !== agent) return false;
      if (owned.has(exec.name)) return ctx.tools.get(exec.name, agent, exec.toolSet) === owned.get(exec.name);
      if (exec.name !== 'run_code' || exec.parent !== undefined || !ptcSchema()) return false;
      const parsed = parseReadProgram(exec.arguments);
      return parsed !== undefined && owned.has(parsed.name) && ctx.tools.get(parsed.name, agent, exec.toolSet) === owned.get(parsed.name);
    },
    presentation(context) {
      const tools = admitted(context?.toolSet); const transport = tools.length && ptcSchema();
      if (!transport) return { tools, sections: [] };
      const guidance = 'Read-only Chat transport: call run_code ONLY as `return await tools.TOOL_NAME(JSON_OBJECT);`, with one of the project-read tools below. Use strict JSON with double-quoted keys and scalar values. No other statements, variables, comments, loops, imports, timeout or sandbox arguments are permitted. Example: return await tools.autonomy_read_file({"file_path":"README.md"});\nAvailable read capabilities (names and JSON parameter schemas):\n' + JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
      return { tools: [{ ...transport, description: 'Invoke exactly one project-read capability with a fixed JSON-literal call. No arbitrary code or execution.', parameters: object({ code: field('string', guidance, true), description: field('string', 'Describe the project read.', true) }) }], sections: [{ name: 'autonomy:project-read-transport', order: 41, text: guidance }] };
    },
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose(); owned.clear(); reader.dispose(); },
  };
}
