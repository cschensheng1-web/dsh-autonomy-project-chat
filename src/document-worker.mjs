import { parentPort, workerData } from 'node:worker_threads';
import { openArchive, safeArchiveName } from './document-zip.mjs';
import { wordXml, presentationXml, spreadsheetXml, openDocument, epub } from './document-office.mjs';
import { oleContainer, legacyWord, legacyPresentation, legacySpreadsheet } from './document-binary.mjs';
import { DOCUMENT_LIMITS, DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS, extension, decodeText, htmlText, rtfText, textResult } from './document-common.mjs';

globalThis.fetch = async () => { throw Error('文档解析器不访问网络。'); };
const privateName = name => name.split('/').some(part => /^(?:\.git|\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|(?:credentials|secrets|tokens?)\.(?:json|ya?ml|toml))$/i.test(part) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part));
const isZip = bytes => bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75 && [3, 5, 7].includes(bytes[2]);
const isOle = bytes => bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
function entryInfo(entry) {
  const symlink = ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000;
  const encrypted = Boolean(entry.generalPurposeBitFlag & 1);
  const directory = entry.fileName.endsWith('/');
  const supported = !symlink && !encrypted && !directory && DOCUMENT_EXTENSIONS.has(extension(entry.fileName));
  return { path: entry.fileName, size: entry.uncompressedSize, type: directory ? 'directory' : symlink ? 'symlink' : 'file', supported, encrypted };
}
async function parse(bytes, name, options = {}) {
  if (bytes.length > DOCUMENT_LIMITS.inputBytes) throw Error('文件超过 32 MiB。');
  const ext = extension(name);
  if (options.operation === 'list' && !isZip(bytes)) throw Error('请选择 ZIP 压缩包。');
  if (isZip(bytes)) {
    const zip = await openArchive(bytes);
    try {
      if (options.operation === 'list') return { format: 'zip', entries: zip.entries.filter(e => !privateName(e.fileName)).map(entryInfo), warnings: ['仅列出包内文件；不在磁盘解压，不读取凭据条目。'], truncated: false };
      if (options.entry !== undefined) {
        if (!safeArchiveName(options.entry) || privateName(options.entry)) throw Error('不能读取此 ZIP 条目路径或凭据文件。');
        const data = await zip.read(options.entry);
        if (isZip(data) && extension(options.entry) === 'zip') throw Error('不递归展开嵌套压缩包，请选择其中的文档。');
        const result = await parse(data, options.entry, { ocr: options.ocr, page: options.page });
        if (result.format === 'zip') throw Error('不递归展开嵌套压缩包。');
        return result;
      }
      const has = path => zip.entries.some(e => e.fileName === path);
      if (has('word/document.xml')) return await wordXml(zip);
      if (has('ppt/presentation.xml')) return await presentationXml(zip);
      if (has('xl/workbook.xml')) return await spreadsheetXml(zip);
      if (has('xl/workbook.bin')) { const result = await legacySpreadsheet(bytes); result.format = 'xlsb'; return result; }
      if (has('mimetype')) {
        const mime = (await zip.read('mimetype')).toString('utf8');
        if (mime === 'application/epub+zip') return await epub(zip);
        if (/opendocument\.(?:text|presentation|spreadsheet)(?:-template)?$/.test(mime)) return await openDocument(zip, mime.includes('presentation') ? 'odp' : mime.includes('spreadsheet') ? 'ods' : 'odt');
      }
      if (has('META-INF/container.xml')) return await epub(zip);
      return { format: 'zip', entries: zip.entries.filter(e => !privateName(e.fileName)).map(entryInfo), warnings: ['这是压缩包目录。用 autonomy_read_file 的 archive_entry 指定包内文档，或用 autonomy_list_archive 查看。'], truncated: false };
    } finally { zip.close(); }
  }
  if (options.entry !== undefined) throw Error('archive_entry 只能用于 ZIP 压缩包。');
  if (isOle(bytes)) {
    const ole = oleContainer(bytes);
    if (ole.stream('WordDocument')) return legacyWord(bytes, ole);
    if (ole.stream('PowerPoint Document')) return legacyPresentation(ole);
    if (ole.stream('Workbook') || ole.stream('Book')) return legacySpreadsheet(bytes);
    throw Error('这个旧版二进制容器不是受支持的 Word、PPT 或 Excel 文档。');
  }
  const image = IMAGE_EXTENSIONS.has(ext);
  const pdf = bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  if (image || pdf && options.ocr) return { ocrInput: { bytes, kind: pdf ? 'pdf' : 'image', page: options.page ?? 1, limit: 1 } };
  if (pdf) {
    const result = await (await import('./document-pdf.mjs')).pdfText(bytes);
    if (process.platform === 'darwin' && !result.sections.some(s => s.text.trim())) return { ocrInput: { bytes, kind: 'pdf', page: options.page ?? 1, limit: options.page === undefined ? 3 : 1 } };
    return result;
  }
  if (options.ocr) throw Error('此文档不能直接 OCR；请提供图片或 PDF 页面。');
  const out = textResult(ext || 'text');
  if (/^\s*\{\\rtf\d/.test(bytes.subarray(0, 40).toString('latin1'))) { out.result.format = 'rtf'; out.add('正文', rtfText(bytes)); }
  else if (['html', 'htm', 'xhtml'].includes(ext)) { const body = htmlText(bytes, name); out.result.encoding = body.encoding; out.add('正文', body.text); }
  else {
    if (['doc', 'dot', 'ppt', 'pps', 'pot', 'pdf', 'xls', 'xlsb', 'docx', 'pptx', 'xlsx', 'zip', 'mdf', 'ldf'].includes(ext)) throw Error('文件头与文档格式不匹配，或这是数据库/二进制文件，不能作为正文读取。');
    const body = decodeText(bytes, name); out.result.encoding = body.encoding;
    out.result.sections.push({ location: '', text: body.text.slice(0, DOCUMENT_LIMITS.textChars) });
    out.result.truncated = body.text.length > DOCUMENT_LIMITS.textChars;
  }
  return out.result;
}

try {
  const result = await parse(Buffer.from(workerData.bytes), workerData.name, workerData.options);
  parentPort.postMessage({ result });
} catch (error) {
  // Do not expose parser stack traces, local resource paths or document data.
  const safe = /文件|文档|正文|文字|编码|ZIP|PPT|Word|PDF|XML|RTF|EPUB|32 MiB|archive_entry/.test(error?.message ?? '') && (error?.message?.length ?? 0) < 250;
  parentPort.postMessage({ error: safe ? error.message : '文档解析失败，文件可能损坏、加密或采用暂不支持的格式。' });
}
