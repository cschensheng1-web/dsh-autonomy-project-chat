import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IMAGE_EXTENSIONS } from './document-common.mjs';
const executable = fileURLToPath(new URL(import.meta.url.endsWith('/src/image-ocr.mjs') ? '../lib/native/dsh-ocr-macos' : './native/dsh-ocr-macos', import.meta.url));
export function isImage(bytes, name) {
  return IMAGE_EXTENSIONS.has(String(name).split('.').at(-1).toLowerCase()) || Buffer.from(bytes).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff);
}
export function nativeOCR(bytes, { kind = 'image', page = 1, limit = 1 } = {}, signal) {
  if (process.platform !== 'darwin') return Promise.reject(Error('图片 OCR 需要 macOS 13 或以上；当前平台尚未实现。'));
  signal?.throwIfAborted();
  if (!Number.isInteger(page) || page < 1 || page > 600) throw Error('OCR page 必须是 1 到 600 的整数。');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [kind, String(page), String(limit)], { shell: false, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = []; let size = 0; let failure;
    const stop = error => { failure ??= error; child.kill('SIGKILL'); };
    const cancel = () => stop(signal.reason ?? Error('图片识别已取消。'));
    const timer = setTimeout(() => stop(Error('本机 OCR 超过 30 秒，已停止，请选择更少页面或较小图片。')), 30000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    signal?.addEventListener('abort', cancel, { once: true });
    child.stderr.resume(); // Do not log framework messages, which can contain private data.
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) stop(Error('OCR 结果超过返回上限。')); else output.push(chunk); });
    child.stdin.on('error', () => {});
    child.once('error', () => { cleanup(); reject(Error('本机 OCR 助手无法启动，请检查插件安装是否完整及系统是否允许运行。')); });
    child.once('close', code => {
      cleanup(); if (failure) { reject(failure); return; }
      try { const result = JSON.parse(Buffer.concat(output).toString('utf8')); if (result.error) throw Error(result.error); if (code !== 0 || !Array.isArray(result.sections)) throw Error('本机 OCR 返回了无效结果。'); if (result.format === 'image-ocr' && result.totalPages > 1) result.truncated = true; resolve(result); }
      catch (error) { reject(error instanceof SyntaxError ? Error('本机 OCR 返回结果不完整。') : error); }
    });
    child.stdin.end(bytes);
  });
}
