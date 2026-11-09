import { readFile } from 'node:fs/promises';
import { getDocumentProxy } from 'unpdf';
import { textResult, DOCUMENT_LIMITS } from './document-common.mjs';

// PDF.js 6 uses BinaryDataFactory for both CMaps and standard fonts. Resolve
// only bundled assets, never a URL or source path supplied by a document.
class BundledBinaryDataFactory {
  async fetch({ kind, filename }) {
    const directory = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : undefined;
    if (!directory || !/^[a-z\d_.-]+$/i.test(filename) || filename.includes('..')) throw Error('PDF 请求了不支持的字体资源。');
    return new Uint8Array(await readFile(new URL(`./pdf-assets/${directory}/${filename}`, import.meta.url)));
  }
}
export async function pdfText(bytes) {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      BinaryDataFactory: BundledBinaryDataFactory, useWorkerFetch: false,
      useSystemFonts: false, useWasm: false, isEvalSupported: false,
      disableFontFace: true, enableXfa: false, isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false, maxImageSize: 1, verbosity: 0,
      cMapUrl: 'bundled/', cMapPacked: true, standardFontDataUrl: 'bundled/',
    });
    const out = textResult('pdf'); let empty = 0;
    for (let number = 1; number <= Math.min(pdf.numPages, DOCUMENT_LIMITS.units); number++) {
      const page = await pdf.getPage(number); let text = ''; let lastY;
      const stream = page.streamTextContent({ disableNormalization: false, includeMarkedContent: false });
      const reader = stream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            const y = item.transform?.[5];
            if (lastY !== undefined && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
            text += item.str + (item.hasEOL ? '\n' : ' '); lastY = y;
            if (text.length > DOCUMENT_LIMITS.textChars) { out.result.truncated = true; break; }
          }
          if (out.result.truncated) { await reader.cancel(); break; }
        }
      } finally { reader.releaseLock(); page.cleanup(); }
      if (!text.trim()) empty++;
      out.add(`第 ${number} 页`, text);
      if (out.result.truncated) break;
    }
    if (pdf.numPages > DOCUMENT_LIMITS.units) out.result.truncated = true;
    out.result.totalPages = pdf.numPages;
    if (empty) out.warn(`${empty} 页未提取到文字，可能为空白或扫描图片；未进行 OCR。`);
    out.warn('PDF 按页提取已有文字层；多栏、表格阅读顺序和缺少字形映射的文字可能不完整。');
    return out.result;
  } catch (error) {
    if (error?.name === 'PasswordException') throw Error('PDF 已加密，请在原应用解密后读取；插件不接收或保存密码。');
    throw Error('PDF 文字提取失败：文件可能损坏或结构不受支持。');
  } finally { await pdf?.loadingTask.destroy(); }
}
