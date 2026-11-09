import { SaxesParser } from 'saxes';
import { Parser as HtmlParser } from 'htmlparser2';

export const DOCUMENT_LIMITS = Object.freeze({ inputBytes: 32 * 1024 * 1024, entryBytes: 16 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024, entries: 1500, textChars: 2_000_000, units: 600, xmlElements: 500000 });
export const TEXT_EXTENSIONS = new Set('txt md markdown csv tsv json jsonl yaml yml xml html htm xhtml log sql tex rst ini cfg conf srt vtt c cpp h hpp py js jsx ts tsx java sh css r vue go rs rb toml properties'.split(' '));
export const IMAGE_EXTENSIONS = new Set('png jpg jpeg webp gif bmp tif tiff heic heif'.split(' '));
export const DOCUMENT_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS, ...'doc docx docm dot dotx dotm ppt pptx pptm pps ppsx pot potx pdf xls xlsx xlsm xlsb xlt xltx ods odt odp ott otp rtf epub'.split(' ')]);
export const extension = name => String(name).split('.').at(-1).toLowerCase();
export function cleanText(text) { return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\x07/g, '\t').replace(/[\v\f]/g, '\n').replace(/[\u0000-\u0008\u000e-\u001f]/g, '').replace(/\n[ \t]+/g, '\n').trim(); }
export function textResult(format) {
  const result = { format, sections: [], warnings: [], truncated: false }; let chars = 0;
  return { result, warn: value => { if (!result.warnings.includes(value)) result.warnings.push(value); },
    add(location, input) {
      const value = cleanText(input); if (!value) return;
      const room = DOCUMENT_LIMITS.textChars - chars;
      if (room <= 0) { result.truncated = true; return; }
      const text = value.slice(0, room);
      result.sections.push({ location, text }); chars += text.length;
      if (text.length < value.length) result.truncated = true;
    },
  };
}
export function decodeText(bytes, name = '', xml = false) {
  const data = Buffer.from(bytes); let encodings;
  if (data[0] === 0xff && data[1] === 0xfe) encodings = ['utf-16le'];
  else if (data[0] === 0xfe && data[1] === 0xff) encodings = ['utf-16be'];
  else if (data.length > 8 && [0, 2, 4, 6].every(i => data[i] === 0)) encodings = ['utf-16be'];
  else if (data.length > 8 && [1, 3, 5, 7].every(i => data[i] === 0)) encodings = ['utf-16le'];
  else encodings = ['utf-8', ...(!xml && TEXT_EXTENSIONS.has(extension(name)) ? ['gb18030'] : [])];
  for (const encoding of encodings) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(data);
      if (text.includes('\0') || (text.match(/[\u0001-\u0008\u000e-\u001f]/g)?.length ?? 0) > Math.max(2, text.length / 100)) continue;
      return { text, encoding };
    } catch {}
  }
  throw Error('文件不是可识别的文字编码或受支持的文档，不能把二进制数据当作正文。');
}
export function xmlEvents(bytes, handlers = {}) {
  const source = decodeText(bytes, '', true).text;
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw Error('文档 XML 包含不支持的 DTD 或实体声明。');
  const parser = new SaxesParser({ xmlns: true }); let elements = 0; let depth = 0;
  parser.on('opentag', node => {
    if (++elements > DOCUMENT_LIMITS.xmlElements || ++depth > 256) throw Error('文档 XML 结构超出解析上限。');
    handlers.open?.(node);
  });
  parser.on('closetag', node => { handlers.close?.(node); depth--; });
  parser.on('text', text => handlers.text?.(text));
  parser.on('cdata', text => handlers.text?.(text));
  parser.on('error', error => { throw error; });
  parser.write(source).close();
}
export function attr(node, local) { return Object.values(node.attributes).find(a => a.local === local)?.value; }
export function xmlBody(bytes) {
  let text = ''; let inText = 0; let skip = 0; const stack = [];
  xmlEvents(bytes, {
    open(node) {
      const ignored = ['del', 'instrText', 'tracked-changes', 'script', 'style'].includes(node.local);
      stack.push({ ignored, text: ['t', 'p', 'h', 'span', 'a', 'v'].includes(node.local) });
      if (ignored) skip++;
      if (stack.at(-1).text) inText++;
      if (!skip && ['tab', 'tab-stop'].includes(node.local)) text += '\t';
      if (!skip && ['br', 'line-break'].includes(node.local)) text += '\n';
      if (node.local === 's' && !skip) text += ' '.repeat(Math.min(Number(attr(node, 'c') ?? 1) || 1, 100));
    },
    text(value) { if (!skip && inText) text += value; },
    close(node) {
      const state = stack.pop();
      if (!skip && ['p', 'h', 'tr', 'table-row'].includes(node.local)) text += '\n';
      if (!skip && ['tc', 'table-cell'].includes(node.local)) text += '\t';
      if (state.text) inText--; if (state.ignored) skip--;
    },
  });
  return cleanText(text);
}
export function htmlText(bytes, name = 'document.html') {
  const { text, encoding } = decodeText(bytes, name); let result = ''; let skip = 0;
  const ignored = new Set(['script', 'style', 'head', 'template', 'noscript']);
  const blocks = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'li', 'tr', 'section', 'article', 'pre', 'blockquote', 'br']);
  const parser = new HtmlParser({
    onopentag(tag) { if (ignored.has(tag)) skip++; if (!skip && blocks.has(tag)) result += '\n'; },
    ontext(value) { if (!skip) result += value; },
    onclosetag(tag) { if (ignored.has(tag)) skip--; if (!skip && blocks.has(tag)) result += '\n'; if (!skip && ['td', 'th'].includes(tag)) result += '\t'; },
  }, { decodeEntities: true });
  parser.end(text); return { text: cleanText(result), encoding };
}

// Text-only RTF interpreter: destinations containing binary objects, pictures,
// metadata and field instructions are discarded; no field is evaluated.
export function rtfText(bytes) {
  const source = Buffer.from(bytes).toString('latin1');
  if (!/^\s*\{\\rtf\d/.test(source)) throw Error('不是有效的 RTF 文档。');
  let state = { skip: false, uc: 1, encoding: 'windows-1252' }; const stack = []; let output = ''; let fallback = 0; let pending = [];
  const destinations = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objdata', 'fldinst', 'datastore', 'themedata', 'colorschememapping', 'xmlnstbl']);
  const flush = () => { if (pending.length && !state.skip) output += new TextDecoder(state.encoding).decode(Uint8Array.from(pending)); pending = []; };
  const emit = value => { flush(); if (!state.skip) output += value; };
  for (let i = 0; i < source.length;) {
    const char = source[i++];
    if (char === '{') { flush(); if (stack.length >= 256) throw Error('RTF 嵌套层级过多。'); stack.push(state); state = { ...state }; continue; }
    if (char === '}') { flush(); if (!stack.length) throw Error('RTF 分组结构损坏。'); state = stack.pop(); continue; }
    if (char !== '\\') { if (!/[\r\n]/.test(char)) { if (fallback) fallback--; else if (!state.skip) pending.push(char.charCodeAt(0)); } continue; }
    const symbol = source[i];
    if (symbol === "'") {
      const hex = source.slice(i + 1, i + 3); if (!/^[0-9a-f]{2}$/i.test(hex)) throw Error('RTF 转义无效。');
      if (fallback) fallback--; else if (!state.skip) pending.push(parseInt(hex, 16)); i += 3; continue;
    }
    flush();
    if (['\\', '{', '}'].includes(symbol)) { i++; if (fallback) fallback--; else emit(symbol); continue; }
    if (symbol === '*') { state.skip = true; i++; continue; }
    if (!/[a-z]/i.test(symbol ?? '')) { if (symbol === '~') emit(' '); else if (symbol === '_') emit('-'); i++; continue; }
    const match = /^([a-z]+)(-?\d+)? ?/i.exec(source.slice(i)); if (!match) continue; i += match[0].length;
    const word = match[1].toLowerCase(); const number = Number(match[2]);
    if (destinations.has(word)) { state.skip = true; continue; }
    if (word === 'bin') { if (!Number.isSafeInteger(number) || number < 0 || i + number > source.length) throw Error('RTF 二进制长度无效。'); i += number; continue; }
    if (word === 'ansicpg') { state.encoding = number === 65001 ? 'utf-8' : [936, 54936].includes(number) ? 'gb18030' : number === 950 ? 'big5' : 'windows-' + number; try { new TextDecoder(state.encoding); } catch { throw Error('RTF 的文字编码暂不支持。'); } }
    else if (word === 'uc') state.uc = Math.min(Math.max(number || 0, 0), 16);
    else if (word === 'u') { emit(String.fromCharCode(number & 65535)); fallback = state.uc; }
    else if (['par', 'line', 'page', 'sect', 'row'].includes(word)) emit('\n');
    else if (['tab', 'cell'].includes(word)) emit('\t');
    else if (word === 'emdash') emit('—'); else if (word === 'endash') emit('–');
    else if (word === 'bullet') emit('•');
  }
  flush(); if (stack.length) throw Error('RTF 分组结构未结束。'); return cleanText(output);
}
