import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDocumentParser } from '../src/document-reader.mjs';
import { nativeOCR } from '../src/image-ocr.mjs';
import { zipFixture } from './document-fixtures.mjs';
const parser = createDocumentParser();
const image = () => readFile(new URL('./fixtures/ocr-source.png', import.meta.url));
const scan = () => readFile(new URL('./fixtures/ocr-scan.pdf', import.meta.url));
const text = r => r.sections.map(s => s.text).join('\n');
const mac = { skip: process.platform !== 'darwin' ? 'macOS Vision required' : false };

test('macOS image OCR recognizes Chinese and English and reports its limits', mac, async () => {
  const result = await parser.parse(await image(), 'source.png');
  assert.equal(result.format, 'image-ocr'); assert.match(text(result), /数据库课程/); assert.match(text(result), /SELECT student FROM course/);
  assert.ok(result.warnings.some(w => w.includes('不等于模型看到了原图')));
});
test('scanned PDF automatically falls back to local OCR and supports explicit pages', mac, async () => {
  const bytes = await scan(); const auto = await parser.parse(bytes, 'scan.pdf');
  assert.equal(auto.format, 'pdf-ocr'); assert.match(text(auto), /数据库课程/); assert.equal(auto.totalPages, 1);
  const explicit = await parser.parse(bytes, 'scan.pdf', { ocr: true, page: 1 });
  assert.match(text(explicit), /SELECT student/);
  await assert.rejects(parser.parse(bytes, 'scan.pdf', { ocr: true, page: 2 }), /页码/);
});
test('JPEG and multipage TIFF retain readable text and correct frame ranges', mac, async () => {
  const jpeg = await readFile(new URL('./fixtures/ocr-source.jpg', import.meta.url));
  assert.match(text(await parser.parse(jpeg, 'source.jpg')), /数据库课程/);
  const tiff = await readFile(new URL('./fixtures/ocr-pages.tiff', import.meta.url));
  const second = await parser.parse(tiff, 'pages.tiff', { page: 2 });
  assert.equal(second.totalPages, 2); assert.equal(second.truncated, true); assert.match(text(second), /第二页课件/);
});
test('long scans explicitly report unread pages and can OCR the last requested page', mac, async () => {
  const bytes = await readFile(new URL('./fixtures/ocr-four-pages.pdf', import.meta.url));
  const first = await parser.parse(bytes, 'four.pdf');
  assert.equal(first.sections.length, 3); assert.equal(first.totalPages, 4); assert.equal(first.truncated, true);
  assert.ok(first.warnings.some(w => w.includes('第 1 至 3 页')));
  const last = await parser.parse(bytes, 'four.pdf', { ocr: true, page: 4 });
  assert.match(last.sections[0].location, /第 4 页/); assert.match(text(last), /第二页课件/);
});
test('ZIP images use the same bounded OCR helper and cannot choose a source path', mac, async () => {
  const bytes = zipFixture([['images/source.png', await image()]]);
  const listing = await parser.parse(bytes, 'images.zip', { operation: 'list' });
  assert.equal(listing.entries[0].supported, true);
  assert.match(text(await parser.parse(bytes, 'images.zip', { entry: 'images/source.png' })), /数据库课程/);
  await assert.rejects(parser.parse(bytes, 'images.zip', { entry: '../outside.png' }));
});
test('malformed images, invalid pages and cancelled OCR return explicit errors', mac, async () => {
  await assert.rejects(parser.parse(Buffer.from('not an image'), 'bad.png'), /图片/);
  await assert.rejects(parser.parse(await image(), 'source.png', { page: 0 }), /page/);
  const controller = new AbortController();
  const pending = nativeOCR(await image(), {}, controller.signal);
  controller.abort(Error('cancel OCR fixture'));
  await assert.rejects(pending, /cancel OCR fixture/);
});
