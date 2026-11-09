import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { DOCUMENT_LIMITS, extension } from './document-common.mjs';
import { nativeOCR, isImage } from './image-ocr.mjs';

const workerUrl = new URL(import.meta.url.endsWith('/src/document-reader.mjs') ? '../lib/parser/document-worker.js' : './parser/document-worker.js', import.meta.url);
let active = 0;
const queue = [];
function acquire(signal) {
  signal?.throwIfAborted();
  if (active < 2) { active++; return Promise.resolve(); }
  if (queue.length >= 8) throw Error('文档解析任务较多，请稍后再试。');
  return new Promise((resolve, reject) => {
    const item = { resolve: () => { signal?.removeEventListener('abort', cancel); active++; resolve(); } };
    const cancel = () => { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); reject(signal.reason); };
    signal?.addEventListener('abort', cancel, { once: true }); queue.push(item);
  });
}
function release() { active--; queue.shift()?.resolve(); }
async function run(bytes, name, options, signal) {
  await acquire(signal);
  try {
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl, { workerData: { bytes, name, options }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 }, stdout: true, stderr: true });
      // Parser warnings can contain document text. Consume them without logging.
      worker.stdout.resume(); worker.stderr.resume(); let settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        void worker.terminate().finally(() => error ? reject(error) : resolve(value));
      };
      const cancel = () => finish(signal.reason ?? Error('文档读取已取消。'));
      const timer = setTimeout(() => finish(Error('文档解析超过 30 秒，已停止；可尝试较小的文档。')), 30000);
      signal?.addEventListener('abort', cancel, { once: true });
      worker.once('message', value => finish(value.error ? Error(value.error) : undefined, value.result));
      worker.once('error', () => finish(Error('文档解析进程失败或超出内存限制。')));
      worker.once('exit', () => { if (!settled) finish(Error('文档解析进程提前退出。')); });
    });
  } finally { release(); }
}
export function createDocumentParser() {
  const cache = new Map(); let total = 0;
  return {
    async parse(bytes, name, options = {}, signal) {
      if (bytes.byteLength > DOCUMENT_LIMITS.inputBytes) throw Error('文件超过 32 MiB。');
      signal?.throwIfAborted();
      const key = createHash('sha256').update(bytes).update('\0' + extension(name) + '\0' + JSON.stringify(options)).digest('hex');
      if (cache.has(key)) { const value = cache.get(key); cache.delete(key); cache.set(key, value); return value.result; }
      const pdf = Buffer.from(bytes).subarray(0, 1024).includes(Buffer.from('%PDF-'));
      const image = isImage(bytes, name);
      if (options.page !== undefined && (!Number.isSafeInteger(options.page) || options.page < 1 || options.page > 600)) throw Error('page 必须是 1 到 600 的整数。');
      if (options.ocr && !pdf && !image && !options.entry) throw Error('ocr:true 仅用于图片或 PDF 页面；Word/PPT 中的嵌入图片尚未识别。');
      const ocr = async (request, input = bytes) => { await acquire(signal); try { return await nativeOCR(input, request, signal); } finally { release(); } };
      let result;
      if (options.operation !== 'list' && !options.entry && (image || options.ocr && pdf)) result = await ocr({ kind: pdf ? 'pdf' : 'image', page: options.page ?? 1 });
      else {
        result = await run(bytes, name, options, signal);
        if (result.ocrInput) {
          const { bytes: input, ...request } = result.ocrInput;
          result = await ocr(request, input);
        }
      }
      signal?.throwIfAborted();
      const size = JSON.stringify(result).length * 2;
      if (size <= 8 * 1024 * 1024) {
        cache.set(key, { result, size }); total += size;
        while (cache.size > 4 || total > 8 * 1024 * 1024) { const first = cache.keys().next().value; total -= cache.get(first).size; cache.delete(first); }
      }
      return result;
    },
    dispose() { cache.clear(); total = 0; },
  };
}
