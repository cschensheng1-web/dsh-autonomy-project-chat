import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { createDocumentParser } from '../src/document-reader.mjs';
import { zipFixture, wordFixture, presentationFixture, spreadsheetFixture, openDocumentFixture, epubFixture, pdfFixture, legacyPptFixture } from './document-fixtures.mjs';
const parser = createDocumentParser();
const parse = (bytes, name, options) => parser.parse(bytes, name, options);
const text = result => result.sections.map(s => s.text).join('\n');

test('Word XML extracts paragraphs and footnotes, excluding deleted text/macros', async () => {
  const r = await parse(wordFixture(), 'source.docx');
  assert.equal(r.format, 'docx'); assert.match(text(r), /中文项目资料\t保留文字/); assert.match(text(r), /脚注说明/);
  assert.doesNotMatch(text(r), /删除的秘密|NEVER EXECUTE/); assert.equal(r.sections[1].location, '脚注');
});
test('PPTX follows slide order and includes speaker notes without following external links', async () => {
  const r = await parse(presentationFixture(), 'slides.pptx');
  assert.deepEqual(r.sections.map(s => s.location), ['第 1 张幻灯片', '第 1 张备注', '第 2 张幻灯片']);
  assert.equal(r.sections[0].text, '第一张内容'); assert.match(text(r), /讲解备注/);
});
test('PDF extracts two pages and Chinese using only bundled CMaps/fonts', async () => {
  const r = await parse(pdfFixture(), 'source.pdf');
  assert.equal(r.totalPages, 2); assert.match(r.sections[0].text, /First page/); assert.match(r.sections[0].text, /中文/); assert.match(r.sections[1].text, /Second page/);
});
test('XLSX preserves shared/inline rich text, addresses and unevaluated formulas', async () => {
  const r = await parse(spreadsheetFixture(), 'table.xlsx');
  assert.match(text(r), /A1: 中文/); assert.match(text(r), /B1: 合并/); assert.match(text(r), /C1: 3 \[公式: =1\+2\]/);
});
for (const kind of ['text', 'presentation', 'spreadsheet']) test(`OpenDocument ${kind} extracts Chinese`, async () => {
  assert.match(text(await parse(openDocumentFixture(kind), 'source.odt')), /开放文档中文正文/);
});
test('EPUB respects spine order and strips script text', async () => {
  const r = await parse(epubFixture(), 'book.epub');
  assert.equal(r.sections[0].text, '第一章中文'); assert.equal(r.sections[1].text, '第二章'); assert.doesNotMatch(text(r), /NEVER_EVALUATE/);
});
test('legacy Word reads Chinese in a genuine macOS-generated .doc', async t => {
  if (process.platform !== 'darwin') { t.skip('Fixture generator requires macOS textutil'); return; }
  const source = '旧版中文 Word\n第二段资料\n';
  const r = spawnSync('/usr/bin/textutil', ['-convert', 'doc', '-format', 'txt', '-encoding', 'UTF-8', '-stdin', '-stdout'], { input: source });
  assert.equal(r.status, 0, r.stderr.toString()); assert.match(text(await parse(r.stdout, 'legacy.doc')), /旧版中文 Word/);
});
test('legacy PPT uses latest persist references and never exposes obsolete save records', async () => {
  const r = await parse(legacyPptFixture(), 'legacy.ppt');
  assert.equal(r.sections.length, 1); assert.equal(r.sections[0].text, '当前中文幻灯片'); assert.doesNotMatch(text(r), /DELETED|ORPHAN/);
});
test('real converted legacy PPT and XLS retain Chinese, notes and cached formulas', async () => {
  const slides = await parse(await readFile(new URL('./fixtures/legacy-slides.ppt', import.meta.url)), 'legacy.ppt');
  assert.match(slides.sections[0].text, /中文测试第1页/); assert.match(slides.sections[1].text, /中文测试第2页/);
  assert.match(text(slides), /备注说明1/); assert.match(text(slides), /备注说明2/);
  const table = await parse(await readFile(new URL('./fixtures/legacy-table.xls', import.meta.url)), 'legacy.xls');
  assert.match(text(table), /中文单元格/); assert.match(text(table), /C1: 43 \[公式: =B1\+1\]/);
});
for (const bookType of ['xls', 'xlsb']) test(`${bookType} extracts Chinese cell text and stored values`, async () => {
  const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet([['中文资料', 42]]); sheet.C1 = { t: 'n', f: '1+2', v: 3 }; sheet['!ref'] = 'A1:C1'; XLSX.utils.book_append_sheet(book, sheet, '项目');
  const r = await parse(XLSX.write(book, { type: 'buffer', bookType }), 'source.' + bookType);
  assert.match(text(r), /中文资料/); assert.match(text(r), /C1: 3/);
});
test('RTF decodes Unicode and GBK hex while excluding binary objects/field instructions', async () => {
  const bytes = Buffer.from("{\\rtf1\\ansi\\ansicpg936 中文 {\\object SECRET_OBJECT}\\u20013?\\u25991? \\'d6\\'d0\\'ce\\'c4\\par {\\field{\\*\\fldinst SECRET_FIELD}{\\fldrslt 正文}}}", 'latin1');
  const r = await parse(bytes, 'source.rtf'); assert.match(text(r), /中文 中文/); assert.doesNotMatch(text(r), /SECRET_OBJECT|SECRET_FIELD/);
});
test('UTF-16, GB18030 and plain source whitespace are preserved', async () => {
  assert.equal(text(await parse(Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from('中文', 'utf16le')]), 'a.txt')), '中文');
  assert.equal(text(await parse(Buffer.from([0xd6,0xd0,0xce,0xc4]), 'a.txt')), '中文');
  assert.equal(text(await parse(Buffer.from('  code\n    nested\n'), 'a.py')), '  code\n    nested\n');
});
test('HTML removes scripts/styles and retains text structure', async () => {
  assert.equal(text(await parse(Buffer.from('<html><head><title>SECRET</title></head><body><p>中文</p><script>SECRET_SCRIPT</script><p>正文</p></body></html>'), 'a.html')), '中文\n\n正文');
});
test('ZIP lists and reads a named document in memory, with explicit database types', async () => {
  const bytes = zipFixture([['folder/source.docx', wordFixture()], ['database.mdf', Buffer.from([0,1,2])], ['.env', 'SECRET']]);
  const list = await parse(bytes, 'files.zip', { operation: 'list' }); assert.equal(list.entries.length, 2); assert.equal(list.entries[1].supported, false);
  assert.match(text(await parse(bytes, 'files.zip', { entry: 'folder/source.docx' })), /中文项目资料/);
  await assert.rejects(parse(bytes, 'files.zip', { entry: '.env' }), /凭据/);
  await assert.rejects(parse(bytes, 'files.zip', { entry: 'database.mdf' }), /数据库/);
});
test('ZIP rejects traversal, duplicates, CRC corruption, encryption, symlinks and bombs', async () => {
  await assert.rejects(parse(zipFixture([['../escape.txt', 'escape']]), 'bad.zip'));
  await assert.rejects(parse(zipFixture([['a.txt', 'one'], ['a.txt', 'two']]), 'bad.zip'), /重复/);
  for (const option of [{ badCrc: true }, { encrypted: true }, { symlink: true }]) await assert.rejects(parse(zipFixture([['a.txt', 'sample', option]]), 'bad.zip', { entry: 'a.txt' }));
  await assert.rejects(parse(zipFixture([['a.txt', 'x'.repeat(100000)]]), 'bad.zip', { entry: 'a.txt' }), /压缩比例/);
  await assert.rejects(parse(zipFixture([['a.txt', 'x', { size: 65 * 1024 * 1024 }]]), 'bad.zip'), /64 MiB/);
  await assert.rejects(parse(zipFixture([['inner.zip', zipFixture([['a.txt', 'x']])]]), 'bad.zip', { entry: 'inner.zip' }), /嵌套/);
});
test('XML entity declarations, malformed documents and unknown binaries fail explicitly', async () => {
  await assert.rejects(parse(zipFixture([['word/document.xml', '<!DOCTYPE x [<!ENTITY xx "secret">]><x>&xx;</x>']]), 'bad.docx'), /DTD/);
  await assert.rejects(parse(Buffer.from('%PDF-1.7\0bad'), 'bad.pdf'), /PDF/);
  await assert.rejects(parse(Buffer.from([0,1,2,3,4]), 'bad.bin'), /编码|二进制/);
});
test('input limits, aborts and changed bytes cannot return stale cached text', async () => {
  await assert.rejects(parse(Buffer.alloc(32 * 1024 * 1024 + 1), 'too-large.txt'), /32 MiB/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(parser.parse(wordFixture(), 'a.docx', {}, controller.signal));
  assert.equal(text(await parse(Buffer.from('first'), 'a.txt')), 'first'); assert.equal(text(await parse(Buffer.from('second'), 'a.txt')), 'second');
});
