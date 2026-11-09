import { crc32, deflateRawSync } from 'node:zlib';
import CFB from 'cfb';

export function zipFixture(entries) {
  const data = []; const directory = []; let offset = 0;
  for (const item of entries) {
    const [name, input, options = {}] = item;
    const source = Buffer.from(input); const filename = Buffer.from(name); const compressed = deflateRawSync(source);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800 | (options.encrypted ? 1 : 0), 6); header.writeUInt16LE(8, 8);
    const checksum = options.badCrc ? crc32(source) ^ 1 : crc32(source);
    header.writeUInt32LE(checksum >>> 0, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(options.size ?? source.length, 22); header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); header.copy(central, 8, 6, 28); central.writeUInt32LE(options.symlink ? 0xa1ff0000 : 0, 38); central.writeUInt32LE(offset, 42);
    data.push(header, filename, compressed); directory.push(central, filename); offset += header.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, central, end]);
}
export const wordFixture = () => zipFixture([
  ['word/document.xml', '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>中文项目资料</w:t></w:r><w:tab/><w:r><w:t>保留文字</w:t></w:r></w:p><w:del><w:r><w:t>删除的秘密</w:t></w:r></w:del><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>'],
  ['word/footnotes.xml', '<w:footnotes xmlns:w="urn:word"><w:footnote><w:p><w:r><w:t>脚注说明</w:t></w:r></w:p></w:footnote></w:footnotes>'],
  ['word/vbaProject.bin', 'NEVER EXECUTE MACROS'],
]);
export const presentationFixture = () => zipFixture([
  ['ppt/presentation.xml', '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="201" r:id="second"/><p:sldId id="202" r:id="first"/></p:sldIdLst></p:presentation>'],
  ['ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="second" Target="slides/slide2.xml"/><Relationship Id="first" Target="slides/slide1.xml"/></Relationships>'],
  ['ppt/slides/slide1.xml', '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>第二张中文</a:t></a:r></a:p></p:sld>'],
  ['ppt/slides/slide2.xml', '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>第一张内容</a:t></a:r></a:p></p:sld>'],
  ['ppt/slides/_rels/slide2.xml.rels', '<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide2.xml" Type="urn:office/notesSlide"/><Relationship Id="external" Target="https://invalid.example/private" Type="urn:office/notesSlide" TargetMode="External"/></Relationships>'],
  ['ppt/notesSlides/notesSlide2.xml', '<notes xmlns:a="urn:a"><a:p><a:r><a:t>讲解备注</a:t></a:r></a:p></notes>'],
]);
export const spreadsheetFixture = () => zipFixture([
  ['xl/workbook.xml', '<workbook xmlns:r="urn:r"><sheets><sheet name="资料" sheetId="1" r:id="sheet"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="sheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>'],
  ['xl/sharedStrings.xml', '<sst><si><r><t>中</t></r><r><t>文</t></r></si></sst>'],
  ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><r><t>合</t></r><r><t>并</t></r></is></c><c r="C1"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>'],
]);
export function openDocumentFixture(kind = 'text') {
  return zipFixture([['mimetype', 'application/vnd.oasis.opendocument.' + kind], ['content.xml', '<office:document-content xmlns:office="urn:o" xmlns:text="urn:t" xmlns:draw="urn:d" xmlns:table="urn:table"><office:body><draw:page><table:table table:name="项目"><table:table-row><table:table-cell><text:p>开放文档中文正文</text:p></table:table-cell></table:table-row></table:table></draw:page></office:body></office:document-content>']]);
}
export const epubFixture = () => zipFixture([
  ['mimetype', 'application/epub+zip'], ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="book/package.opf"/></rootfiles></container>'],
  ['book/package.opf', '<package><manifest><item id="a" href="one.xhtml"/><item id="b" href="two.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>'],
  ['book/one.xhtml', '<html><body><p>第二章</p><script>NEVER_EVALUATE</script></body></html>'], ['book/two.xhtml', '<html><body><p>第一章中文</p></body></html>'],
]);
export function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
    'BT /F1 12 Tf 30 340 Td (First page) Tj /F2 12 Tf 0 -30 Td <4e2d6587> Tj ET',
    'BT /F1 12 Tf 30 340 Td (Second page) Tj ET',
  ];
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(output)); if (i >= 7) obj = `<< /Length ${Buffer.byteLength(obj)} >>\nstream\n${obj}\nendstream`; output += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
export function legacyPptFixture() {
  const record = (type, body = Buffer.alloc(0), version = 0, instance = 0) => { const h = Buffer.alloc(8); h.writeUInt16LE((instance << 4) | version); h.writeUInt16LE(type, 2); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
  const text = value => record(4000, Buffer.from(value, 'utf16le'));
  const slide = value => record(1006, text(value), 15);
  const doc = value => { const ref = Buffer.alloc(20); ref.writeUInt32LE(2); return record(1000, record(4080, Buffer.concat([record(1011, ref), text(value)]), 15), 15); };
  const data = []; let size = 0;
  const append = b => { const n = size; data.push(b); size += b.length; return n; };
  const directory = (d, s) => { const b = Buffer.alloc(12); b.writeUInt32LE((2 << 20) | 1); b.writeUInt32LE(d, 4); b.writeUInt32LE(s, 8); return record(6002, b); };
  const edit = (previous, dir) => { const b = Buffer.alloc(28); b.writeUInt32LE(previous, 8); b.writeUInt32LE(dir, 12); b.writeUInt32LE(1, 16); return record(4085, b); };
  const oldDoc = append(doc('DELETED_OLD_TEXT')); const oldSlide = append(slide('DELETED_OLD_TEXT'));
  const oldDir = append(directory(oldDoc, oldSlide)); const oldEdit = append(edit(0, oldDir));
  const newDoc = append(doc('当前中文幻灯片')); const newSlide = append(slide('当前中文幻灯片'));
  append(text('ORPHAN_DELETED_TEXT'));
  const newDir = append(directory(newDoc, newSlide)); const newEdit = append(edit(oldEdit, newDir));
  const cu = Buffer.alloc(28); cu.writeUInt32LE(20); cu.writeUInt32LE(0xe391c05f, 4); cu.writeUInt32LE(newEdit, 8);
  const cfb = CFB.utils.cfb_new(); CFB.utils.cfb_add(cfb, 'PowerPoint Document', Buffer.concat(data)); CFB.utils.cfb_add(cfb, 'Current User', record(4086, cu));
  return CFB.write(cfb, { type: 'buffer' });
}
