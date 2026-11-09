import { posix } from 'node:path';
import { attr, xmlEvents, xmlBody, htmlText, textResult, DOCUMENT_LIMITS } from './document-common.mjs';

const byName = (a, b) => a.fileName.localeCompare(b.fileName, 'en', { numeric: true });
const has = (zip, name) => zip.entries.some(e => e.fileName === name);
const reference = node => Object.values(node.attributes).find(a => a.local === 'id' && a.prefix)?.value;
function internalPath(base, target) {
  try { target = decodeURIComponent(target ?? ''); } catch { throw Error('文档内部链接编码无效。'); }
  if (!target || /^[a-z][a-z\d+.-]*:|^\/\/|\\|[\u0000-\u001f]/i.test(target)) throw Error('文档内部链接路径无效。');
  // A leading slash denotes a package-root part URI, not a filesystem path.
  const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(base), target));
  if (path === '..' || path.startsWith('../')) throw Error('文档内部链接超出容器范围。');
  return path;
}
async function relationships(zip, source) {
  const result = new Map();
  const name = posix.join(posix.dirname(source), '_rels', posix.basename(source) + '.rels');
  if (!has(zip, name)) return result;
  xmlEvents(await zip.read(name), { open(node) {
    if (node.local !== 'Relationship' || attr(node, 'TargetMode') === 'External') return;
    const id = attr(node, 'Id'); const target = attr(node, 'Target');
    if (id && target) result.set(id, { path: internalPath(source, target), type: attr(node, 'Type') ?? '' });
  } });
  return result;
}
export async function wordXml(zip) {
  const out = textResult('docx');
  out.add('正文', xmlBody(await zip.read('word/document.xml')));
  const extras = zip.entries.filter(e => /^word\/(?:footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/.test(e.fileName)).sort(byName);
  for (const item of extras) {
    const name = posix.basename(item.fileName, '.xml');
    const location = name === 'footnotes' ? '脚注' : name === 'endnotes' ? '尾注' : name === 'comments' ? '批注' : name.startsWith('header') ? '页眉 ' + name.slice(6) : '页脚 ' + name.slice(6);
    out.add(location, xmlBody(await zip.read(item.fileName)));
  }
  out.warn('Word 的行号对应提取正文，不代表排版页码；图片、公式图形及嵌入对象未转成文字。');
  return out.result;
}
export async function presentationXml(zip) {
  const out = textResult('pptx'); const source = 'ppt/presentation.xml';
  const rels = await relationships(zip, source); const ids = [];
  xmlEvents(await zip.read(source), { open(node) { if (node.local === 'sldId') ids.push(reference(node)); } });
  let slides = ids.map(id => rels.get(id)?.path);
  if (!slides.length || slides.some(name => !name || !has(zip, name))) {
    slides = zip.entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.fileName)).sort(byName).map(e => e.fileName);
    out.warn('演示文稿的页序关系缺失，已按幻灯片文件编号读取。');
  }
  for (const [index, name] of slides.entries()) {
    if (index >= DOCUMENT_LIMITS.units) { out.result.truncated = true; break; }
    out.add(`第 ${index + 1} 张幻灯片`, xmlBody(await zip.read(name)));
    const slideRels = await relationships(zip, name);
    for (const rel of slideRels.values()) {
      if (rel.type.endsWith('/notesSlide') && has(zip, rel.path)) out.add(`第 ${index + 1} 张备注`, xmlBody(await zip.read(rel.path)));
      if (rel.type.endsWith('/chart') && has(zip, rel.path)) out.add(`第 ${index + 1} 张图表缓存文字`, xmlBody(await zip.read(rel.path)));
    }
  }
  out.warn('已提取幻灯片中的文字、表格和备注；图片中的字、部分 SmartArt 与嵌入对象不属于可直接提取的正文。');
  return out.result;
}
export async function spreadsheetXml(zip) {
  const out = textResult('xlsx'); const shared = []; let value = ''; let inSi = false; let inT = false;
  if (has(zip, 'xl/sharedStrings.xml')) xmlEvents(await zip.read('xl/sharedStrings.xml'), {
    open(n) { if (n.local === 'si') { inSi = true; value = ''; } if (n.local === 't') inT = true; },
    text(t) { if (inSi && inT) value += t; },
    close(n) { if (n.local === 't') inT = false; if (n.local === 'si') { shared.push(value); inSi = false; } },
  });
  const sheets = []; const rels = await relationships(zip, 'xl/workbook.xml');
  xmlEvents(await zip.read('xl/workbook.xml'), { open(n) { if (n.local === 'sheet') sheets.push({ name: attr(n, 'name'), path: rels.get(reference(n))?.path }); } });
  for (const [index, sheet] of sheets.entries()) {
    if (index >= DOCUMENT_LIMITS.units) { out.result.truncated = true; break; }
    if (!sheet.path || !has(zip, sheet.path)) { out.warn('部分工作表缺少有效的内部链接。'); continue; }
    let text = ''; let cell; let capture; let content = ''; let formula = '';
    xmlEvents(await zip.read(sheet.path), {
      open(n) { if (n.local === 'c') { cell = { ref: attr(n, 'r') ?? '', type: attr(n, 't') }; content = ''; formula = ''; } if (['v', 't', 'f'].includes(n.local)) capture = n.local; },
      text(t) { if (cell && capture) { if (capture === 'f') formula += t; else content += t; } },
      close(n) {
        if (n.local === capture) capture = undefined;
        if (n.local === 'c' && cell) {
          const rendered = cell.type === 's' ? shared[Number(content)] ?? '[缺少字符串]' : content;
          if (rendered || formula) text += `${cell.ref}: ${rendered}${formula ? ` [公式: =${formula}]` : ''}\t`;
          cell = undefined; content = ''; formula = '';
        }
        if (n.local === 'row') text += '\n';
      },
    });
    out.add('工作表 ' + (sheet.name ?? index + 1), text);
  }
  out.warn('单元格位置按原表标记；公式仅作为文字展示，缓存值可能过期，未执行计算。');
  return out.result;
}
export async function openDocument(zip, format) {
  const out = textResult(format); let text = ''; let inText = 0; let skip = 0; let number = 0; let location = '正文'; const stack = [];
  xmlEvents(await zip.read('content.xml'), {
    open(n) {
      const unit = format === 'odp' && n.local === 'page' || format === 'ods' && n.local === 'table';
      if (unit) { number++; if (text.trim()) out.add(location, text); text = ''; location = format === 'odp' ? `第 ${number} 张幻灯片` : '工作表 ' + (attr(n, 'name') ?? number); }
      const ignored = ['tracked-changes', 'annotation'].includes(n.local);
      const capture = ['p', 'h'].includes(n.local); stack.push({ ignored, capture, unit });
      if (ignored) skip++; if (capture) inText++;
      if (!skip && n.local === 'tab') text += '\t';
      if (!skip && n.local === 'line-break') text += '\n';
      if (!skip && n.local === 's') text += ' '.repeat(Math.min(Number(attr(n, 'c') ?? 1) || 1, 100));
    },
    text(value) { if (!skip && inText) text += value; },
    close(n) {
      const s = stack.pop();
      if (!skip && ['p', 'h', 'table-row'].includes(n.local)) text += '\n';
      if (!skip && n.local === 'table-cell') text += '\t';
      if (s.capture) inText--; if (s.ignored) skip--;
      if (s.unit) { out.add(location, text); text = ''; }
    },
  });
  out.add(location, text); out.warn('已提取文档文字和表格文字；图形、重复空白单元格及排版效果不完整保留。');
  return out.result;
}
export async function epub(zip) {
  const out = textResult('epub'); let root;
  xmlEvents(await zip.read('META-INF/container.xml'), { open(n) { if (n.local === 'rootfile' && !root) root = attr(n, 'full-path'); } });
  if (!root || !has(zip, root)) throw Error('EPUB 缺少有效的书籍目录。');
  const manifest = new Map(); const spine = [];
  xmlEvents(await zip.read(root), { open(n) {
    if (n.local === 'item' && attr(n, 'id') && attr(n, 'href') && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(attr(n, 'href'))) manifest.set(attr(n, 'id'), internalPath(root, attr(n, 'href').split('#')[0]));
    if (n.local === 'itemref') spine.push(attr(n, 'idref'));
  } });
  for (const [index, id] of spine.entries()) {
    if (index >= DOCUMENT_LIMITS.units) { out.result.truncated = true; break; }
    const name = manifest.get(id); if (!name || !has(zip, name)) { out.warn('部分章节缺失，未读取外部链接。'); continue; }
    out.add(`章节 ${index + 1} (${name})`, htmlText(await zip.read(name), name).text);
  }
  return out.result;
}
