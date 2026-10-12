// Run with node tests/land-scan.test.js. No browser or personal data required.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'HamGiang.html'), 'utf8');
function functionCode(name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert(start >= 0, name);
  const tail = html.slice(start + 1);
  const end = tail.search(/\n    (?:async )?function /);
  return html.slice(start, end < 0 ? html.length : start + 1 + end);
}
const images = [];
const pages = [];
function canvas() {
  return { width: 1, height: 1, getContext() { return { fillRect() {}, drawImage() {} }; },
    toDataURL(type, quality) { images.push({ width: this.width, height: this.height, type, quality }); return 'data:image/jpeg;base64,AA=='; } };
}
class PDF {
  constructor(options) { this.addPage(options.format, options.orientation); this.internal = { pageSize: {
    getWidth: () => this.width, getHeight: () => this.height } }; }
  addPage(format, orientation) {
    const size = format === 'a3' ? [297, 420] : [210, 297];
    this.width = size[orientation === 'landscape' ? 1 : 0];
    this.height = size[orientation === 'landscape' ? 0 : 1];
    pages.push({ format, orientation });
  }
  addImage(data, type, x, y, width, height) { assert(width <= this.width && height <= this.height); }
  output() { return 'data:application/pdf;base64,AA=='; }
}
const context = vm.createContext({ document: { createElement: canvas }, window: { jspdf: { jsPDF: PDF } },
  PDF_DPI: 200, yieldToInterface: () => Promise.resolve() });
vm.runInContext(functionCode('preparePdfImage') + '\n' + functionCode('createLocalPdf'), context);
const qrContext = vm.createContext({ importScripts() {}, self: {} });
vm.runInContext(fs.readFileSync(path.join(root, 'assets/cccd-qr-worker.js'), 'utf8'), qrContext);
const payload = '000000000000|000000000|TEST PERSON|01011990|X|TEST ADDRESS|01012020';
assert.strictEqual(qrContext.parseCccdQr(payload), '000000000000');
for (const invalid of ['https://example.org/000000000000', '000000000000', '1234567890123|old|name|date|sex|address']) {
  assert.strictEqual(qrContext.parseCccdQr(invalid), '');
}
(async () => {
  await context.createLocalPdf([
    { type: 'document', canvas: { width: 6000, height: 4243 } },
    { type: 'document', canvas: { width: 4243, height: 6000 } },
    { type: 'cccd-front', canvas: { width: 1600, height: 1009 } },
    { type: 'document', canvas: { width: 1200, height: 849 } }
  ]);
  assert(images[0].width <= 3308 && images[0].height <= 2338);
  assert(images[1].height <= 3308 && images[1].width <= 2338);
  assert(images[2].width <= 674 && images[2].height <= 425);
  assert.strictEqual(images[3].width, 1200); // Never upscale a low resolution source.
  assert.strictEqual(pages[0].orientation, 'landscape');
  assert.strictEqual(pages[1].orientation, 'portrait');
  const gs = fs.readFileSync(path.join(root, 'code.gs'), 'utf8');
  const rows = [], savedNames = [];
  const server = vm.createContext({ ensureSheet: () => ({ getLastRow: () => 1, appendRow: row => rows.push(row) }),
    ensureFolder: () => ({}), normalizeValue: value => value == null ? '' : String(value).trim(),
    savePdfToDrive: (folder, base64, name) => { savedNames.push(name); return { fileId: String(savedNames.length), fileUrl: 'local-test' }; },
    normalizeProcessingStatus: () => 'Chưa xử lý' });
  vm.runInContext(gs.slice(gs.indexOf('function saveScanRecord('), gs.indexOf('function savePdfToDrive(')), server);
  const result = server.saveScanRecord({ fileName: 'TEST_GCN.pdf', fileNameOriginal: 'TEST_BAN_GOC.pdf',
    pdfOriginalBase64: 'AA==', pdfGCNBase64: 'AA==', soCCCD: '000000000000' });
  assert.strictEqual(savedNames[0], 'TEST_BAN_GOC.pdf');
  assert.strictEqual(rows[0][16], 'TEST_BAN_GOC.pdf');
  assert.strictEqual(result.originalBackupSaved, true);
  assert.strictEqual(result.soCCCD, '000000000000');
  assert.strictEqual(result.fileId, '1');
  assert.strictEqual(result.updated, false);
  console.log('PASS: QR payload validation, PDF 200 dpi/no upscale/orientation, original filename and save response');
})().catch(error => { console.error(error); process.exitCode = 1; });
