import yauzl from 'yauzl';
import { crc32 } from 'node:zlib';
import { DOCUMENT_LIMITS } from './document-common.mjs';

export function safeArchiveName(name) {
  return typeof name === 'string' && name.length <= 2048 && !/[\\\u0000-\u001f]/.test(name) && !/^(?:\/|[a-z]:)/i.test(name) && name.split('/').every(part => part !== '..' && part !== '.');
}
export async function openArchive(bytes) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (err, result) => err ? reject(err) : resolve(result)));
  const entries = []; const names = new Map(); let expanded = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', entry => {
        try {
          if (entries.length >= DOCUMENT_LIMITS.entries) throw Error('ZIP 文件条目超过 1500 项。');
          if (!safeArchiveName(entry.fileName)) throw Error('ZIP 包含项目外路径或不安全的条目名称。');
          if (names.has(entry.fileName)) throw Error('ZIP 存在重复条目，无法确定要读取的版本。');
          expanded += entry.uncompressedSize;
          if (!Number.isSafeInteger(expanded) || expanded > DOCUMENT_LIMITS.expandedBytes) throw Error('ZIP 展开大小超过 64 MiB。');
          entries.push(entry); names.set(entry.fileName, entry); zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
    return { entries, close: () => zip.close(),
      async read(name) {
        const entry = names.get(name); if (!entry) throw Error('压缩包内没有这个文档条目。');
        if ((entry.generalPurposeBitFlag & 1) || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw Error('不读取加密 ZIP 条目或符号链接。');
        if (entry.uncompressedSize > DOCUMENT_LIMITS.entryBytes || entry.uncompressedSize > Math.max(65536, entry.compressedSize * 300)) throw Error('ZIP 条目过大或压缩比例异常。');
        const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (err, result) => err ? reject(err) : resolve(result)));
        const chunks = []; let size = 0; let checksum = 0;
        for await (const chunk of stream) {
          size += chunk.length; if (size > DOCUMENT_LIMITS.entryBytes || size > entry.uncompressedSize) { stream.destroy(); throw Error('ZIP 条目实际大小超过限制。'); }
          checksum = crc32(chunk, checksum); chunks.push(chunk);
        }
        if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw Error('ZIP 条目损坏，校验未通过。');
        return Buffer.concat(chunks, size);
      },
    };
  } catch (error) { zip.close(); throw error; }
}
