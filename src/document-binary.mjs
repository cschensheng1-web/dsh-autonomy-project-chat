import CFB from 'cfb';
import WordExtractor from 'word-extractor';
import { textResult, DOCUMENT_LIMITS } from './document-common.mjs';

export function oleContainer(bytes) {
  const cfb = CFB.read(Buffer.from(bytes), { type: 'buffer' });
  const stream = name => {
    const item = CFB.find(cfb, name);
    return item?.content && Buffer.from(item.content);
  };
  if (stream('EncryptedPackage') || stream('EncryptionInfo')) throw Error('文档已加密，请在原应用解密后读取；插件不接收或保存密码。');
  return { stream };
}
export async function legacyWord(bytes, ole) {
  const fib = ole.stream('WordDocument');
  if (!fib || fib.length < 12) throw Error('Word 文档头损坏。');
  if (fib.readUInt16LE(10) & 0x8100) throw Error('旧版 Word 文档已加密或混淆，不能读取。');
  const doc = await new WordExtractor().extract(Buffer.from(bytes));
  const out = textResult('doc');
  for (const [location, method] of [['正文', 'getBody'], ['脚注', 'getFootnotes'], ['尾注', 'getEndnotes'], ['页眉', 'getHeaders'], ['页脚', 'getFooters'], ['批注', 'getAnnotations'], ['文本框', 'getTextboxes']]) {
    out.add(location, doc[method]({ filterUnicode: false, includeFooters: false }));
  }
  out.warn('旧版 Word 已按正文区域提取文字；位置不是排版页码，图片和嵌入对象未转成文字。');
  return out.result;
}

// [MS-PPT] 2.1.2: resolve the latest persist directory before reading live
// document/slide records. Scanning TextAtoms across the stream would expose
// obsolete/deleted content from incremental saves and is deliberately avoided.
export function legacyPresentation(ole) {
  const bytes = ole.stream('PowerPoint Document'); const current = ole.stream('Current User');
  if (!bytes || !current || current.length < 20) throw Error('PPT 缺少有效的当前编辑目录，无法可靠读取。');
  if (current.readUInt32LE(12) !== 0xe391c05f) throw Error('PPT 已加密或当前用户记录不受支持。');
  let records = 0;
  function record(offset, end = bytes.length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > end || ++records > 500000) throw Error('PPT 记录越界或结构过大。');
    const flags = bytes.readUInt16LE(offset); const length = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + length > end) throw Error('PPT 记录长度损坏。');
    return { type: bytes.readUInt16LE(offset + 2), version: flags & 15, instance: flags >>> 4, start: offset + 8, end: offset + 8 + length, length };
  }
  function children(parent, visit, depth = 0) {
    if (depth > 80) throw Error('PPT 嵌套结构过深。');
    for (let offset = parent.start; offset < parent.end;) {
      const item = record(offset, parent.end); visit(item, depth); offset = item.end;
    }
  }
  const persist = new Map(); const edits = new Set(); let editOffset = current.readUInt32LE(16); let docId;
  while (editOffset) {
    if (edits.has(editOffset) || edits.size >= 1000) throw Error('PPT 编辑历史目录损坏或过长。');
    edits.add(editOffset); const edit = record(editOffset);
    if (edit.type !== 4085 || edit.length < 28) throw Error('PPT 当前编辑记录无效。');
    if (edit.length >= 32 && bytes.readUInt32LE(edit.start + 28)) throw Error('PPT 文档已加密，不能读取。');
    docId ??= bytes.readUInt32LE(edit.start + 16);
    const directory = record(bytes.readUInt32LE(edit.start + 12));
    if (![6001, 6002].includes(directory.type)) throw Error('PPT 对象目录无效。');
    for (let offset = directory.start; offset < directory.end;) {
      if (offset + 4 > directory.end) throw Error('PPT 对象目录损坏。');
      const entry = bytes.readUInt32LE(offset); offset += 4;
      const first = entry & 0xfffff; const count = entry >>> 20;
      if (!count || offset + count * 4 > directory.end) throw Error('PPT 对象目录计数无效。');
      for (let i = 0; i < count; i++, offset += 4) if (!persist.has(first + i)) persist.set(first + i, bytes.readUInt32LE(offset));
    }
    editOffset = bytes.readUInt32LE(edit.start + 8);
  }
  const docOffset = persist.get(docId); if (docOffset === undefined) throw Error('PPT 没有可解析的当前文档。');
  const doc = record(docOffset); if (doc.type !== 1000) throw Error('PPT 当前文档容器无效。');
  const out = textResult('ppt'); const slides = []; const notes = [];
  const textOf = item => item.type === 4000 ? bytes.subarray(item.start, item.end).toString('utf16le') : item.type === 4008 ? bytes.subarray(item.start, item.end).toString('latin1') : '';
  const collect = (container, depth = 0) => {
    const values = [];
    children(container, item => {
      if ([4000, 4008].includes(item.type)) values.push(textOf(item));
      else if (item.version === 15 || item.type === 0xf00d) values.push(...collect(item, depth + 1));
    }, depth);
    return values;
  };
  children(doc, list => {
    if (list.type !== 4080 || ![0, 2].includes(list.instance)) return;
    let slide;
    children(list, item => {
      if (item.type === 1011) {
        if (item.length < 4) throw Error('PPT 幻灯片引用无效。');
        slide = { id: bytes.readUInt32LE(item.start), text: [] };
        (list.instance === 0 ? slides : notes).push(slide);
      } else if (slide && [4000, 4008].includes(item.type)) slide.text.push(textOf(item));
    });
  });
  function emit(items, kind) {
    for (const [index, slide] of items.entries()) {
      if (index >= DOCUMENT_LIMITS.units) { out.result.truncated = true; break; }
      const offset = persist.get(slide.id);
      if (offset === undefined) { out.warn('部分幻灯片缺少当前对象引用。'); continue; }
      const live = record(offset);
      if (live.type !== (kind === '幻灯片' ? 1006 : 1008)) throw Error('PPT 幻灯片对象类型无效。');
      const text = [...new Set([...slide.text, ...collect(live)].filter(Boolean))].join('\n');
      out.add(`第 ${index + 1} 张${kind}`, text);
    }
  }
  emit(slides, '幻灯片'); emit(notes, '备注');
  out.warn('旧版 PPT 按当前保存版本提取文字；备注按备注列表顺序编号，图片、图形和嵌入对象可能缺字。');
  return out.result;
}

export async function legacySpreadsheet(bytes) {
  const XLSX = await import('xlsx');
  XLSX.set_cptable(await import('xlsx/dist/cpexcel.full.mjs'));
  const workbook = XLSX.read(Buffer.from(bytes), { type: 'buffer', cellFormula: true, cellHTML: false, cellStyles: false, bookVBA: false, bookDeps: false, sheetRows: 20000 });
  const out = textResult('xls');
  for (const [index, name] of workbook.SheetNames.entries()) {
    if (index >= DOCUMENT_LIMITS.units) { out.result.truncated = true; break; }
    const sheet = workbook.Sheets[name]; let text = ''; let count = 0;
    for (const key of Object.keys(sheet)) {
      if (key.startsWith('!')) continue;
      if (++count > 150000 || text.length > DOCUMENT_LIMITS.textChars) { out.result.truncated = true; break; }
      const cell = sheet[key]; const value = cell.w ?? cell.v ?? '';
      text += `${key}: ${value}${cell.f ? ` [公式: =${cell.f}]` : ''}\n`;
    }
    if (sheet['!fullref'] && sheet['!fullref'] !== sheet['!ref']) out.result.truncated = true;
    out.add('工作表 ' + name, text);
  }
  out.warn('按单元格提取文字和现有缓存值；未执行宏、公式或外部数据连接。每张表最多读取 20,000 行。');
  return out.result;
}
