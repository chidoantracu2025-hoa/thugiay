// Run with node tests/land-scan.test.js. No browser or personal data required.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'HamGiang.html'), 'utf8');
function functionCode(name, source = html) {
  const start = source.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert(start >= 0, name);
  const tail = source.slice(start + 1);
  const end = tail.search(/\n    (?:async )?function /);
  return source.slice(start, end < 0 ? source.length : start + 1 + end);
}

function qualityHarness(source) {
  const images = [], scratch = [];
  let pageBytes = 0;
  function canvas(width = 1, height = 1, content = '') {
    const value = { width, height, content };
    value.getContext = () => ({
      fillRect() {},
      drawImage(image) { value.content = image.content; },
      getImageData() { return {}; }
    });
    value.toDataURL = (type, quality) => {
      images.push({ width: value.width, height: value.height, type, quality, content: value.content });
      return 'data:' + type + ';base64,' + Buffer.from(value.content).toString('base64');
    };
    return value;
  }
  class PDF {
    constructor(options) { this.pages = []; this.addPage(options.format, options.orientation); this.internal = { pageSize: {
      getWidth: () => this.width, getHeight: () => this.height } }; }
    addPage(format, orientation) {
      const size = format === 'a3' ? [297, 420] : [210, 297];
      this.width = size[orientation === 'landscape' ? 1 : 0];
      this.height = size[orientation === 'landscape' ? 0 : 1];
      this.pages.push({ format, orientation });
    }
    addImage(data, type, x, y, width, height, alias, compression) {
      assert(width <= this.width + 1e-8 && height <= this.height + 1e-8, 'Images fit inside their physical PDF pages.');
      assert(Math.abs(x - (this.width - width) / 2) < 1e-8, 'Images are horizontally centered.');
      assert(Math.abs(y - (this.height - height) / 2) < 1e-8, 'Images are vertically centered.');
      Object.assign(this.pages[this.pages.length - 1], { data, type, width, height, compression });
    }
    output(type) {
      assert.strictEqual(type, 'arraybuffer', 'PDF limits use the actual final bytes.');
      const encoded = Buffer.from(JSON.stringify(this.pages) + '\n');
      const bytes = new Uint8Array(Math.max(encoded.length, pageBytes * this.pages.length));
      bytes.set(encoded);
      return bytes.buffer;
    }
  }
  function Mat() {}
  Mat.prototype.delete = function () {};
  const cv = {
    Mat,
    matFromImageData: () => new Mat(),
    matFromArray: () => new Mat(),
    getPerspectiveTransform: () => new Mat(),
    Size: function (width, height) { this.width = width; this.height = height; },
    warpPerspective() {},
    imshow() {}
  };
  const state = {
    scanMode: 'auto', opencvReady: false,
    scanner: { extractPaper: (image, width, height) => canvas(width, height, image.content) }
  };
  let bounds;
  const document = { createElement: () => { const value = canvas(); scratch.push(value); return value; } };
  const window = { document, jspdf: { jsPDF: PDF }, cv,
    setTimeout: callback => callback(), btoa: value => Buffer.from(value, 'binary').toString('base64') };
  const context = vm.createContext({ document, window, state,
    detectDocumentBounds: () => bounds,
    correctDocumentLighting() {}, yieldToInterface: () => Promise.resolve(), setStatus() {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/pdf-export.js'), 'utf8'), context);
  const names = ['preparePdfImage', 'createLocalPdf', 'buildPdfParts', 'buildPdfFromScans', 'buildOriginalBackupPdf', 'fitScanDimensions',
    'extractDocumentWithJscanify', 'warpDocumentPerspective', 'prepareScan'];
  vm.runInContext(names.map(name => functionCode(name, source)).join('\n'), context);
  return {
    context, images, scratch, canvas,
    setBounds(value) { bounds = value; },
    setPageBytes(value) { pageBytes = value; }
  };
}

function inspectPdfPart(part) {
  const bytes = Buffer.from(part.dataUri.split(',')[1], 'base64');
  assert.strictEqual(bytes.length, part.byteLength, 'The upload contains exactly the validated PDF bytes.');
  assert(bytes.length <= 10000000, 'Each PDF is no larger than 10 MB.');
  return JSON.parse(bytes.slice(0, bytes.indexOf(10)).toString());
}

async function assertNativeQuality(file) {
  const harness = qualityHarness(fs.readFileSync(path.join(root, file), 'utf8'));
  const context = harness.context;
  const dimensions = value => [value.width, value.height];
  for (const limit of [undefined, 0, -1, Infinity, NaN, 10000]) {
    assert.deepStrictEqual(dimensions(context.fitScanDimensions(6000, 4243, limit)), [6000, 4243], file + ': native resolution is the default.');
  }
  assert.deepStrictEqual(dimensions(context.fitScanDimensions(6000, 4243, 2400)), [2400, 1697], file + ': an explicit preview limit is respected.');
  assert.deepStrictEqual(dimensions(context.fitScanDimensions(1200, 849, 2400)), [1200, 849], file + ': small images are never upscaled.');

  const source = harness.canvas(6600, 4800, 'source');
  const bounds = { x: 100, y: 100, width: 6200, height: 4300, detected: true, method: 'fallback' };
  harness.setBounds(bounds);
  assert.deepStrictEqual(dimensions(context.prepareScan(source).canvas), [6200, 4300], file + ': default cropping preserves the cropped image pixels.');
  assert.deepStrictEqual(dimensions(context.prepareScan(source, { targetLongEdge: 3100 }).canvas), [3100, 2150]);
  const corners = [{ x: 100, y: 100 }, { x: 6300, y: 100 }, { x: 6300, y: 4400 }, { x: 100, y: 4400 }];
  for (const method of ['jscanify', 'opencv']) {
    harness.setBounds(Object.assign({}, bounds, { method, corners }));
    assert.deepStrictEqual(dimensions(context.prepareScan(source).canvas), [6200, 4300], file + ': ' + method + ' preserves native perspective-corrected dimensions.');
    assert.deepStrictEqual(dimensions(context.prepareScan(source, { targetLongEdge: 3100 }).canvas), [3100, 2150]);
  }

  const scans = [
    { type: 'document', canvas: harness.canvas(6000, 4243, 'landscape-processed'), originalCanvas: harness.canvas(7200, 5100, 'landscape-original') },
    { type: 'document', canvas: harness.canvas(4243, 6000, 'portrait-processed'), originalCanvas: harness.canvas(5100, 7200, 'portrait-original') },
    { type: 'cccd-front', canvas: harness.canvas(1600, 1009, 'card-processed'), originalCanvas: harness.canvas(3200, 2018, 'card-original') },
    { type: 'cccd-back', canvas: harness.canvas(1009, 1600, 'vertical-card-processed'), originalCanvas: harness.canvas(2018, 3200, 'vertical-card-original') },
    { type: 'document', canvas: harness.canvas(1200, 849, 'small-processed'), originalCanvas: harness.canvas(1200, 849, 'small-original') }
  ];
  const localPdf = await context.createLocalPdf(scans);
  assert.strictEqual(typeof localPdf, 'string', file + ': the single-PDF compatibility helper still returns a data URI.');
  const localPages = JSON.parse(Buffer.from(localPdf.split(',')[1], 'base64').toString().trim());
  assert.deepStrictEqual(harness.images.map(dimensions), [[6000, 4243], [4243, 6000], [1347, 850], [850, 1347], [1200, 849]],
    file + ': export respects 400 dpi at the actual page/card size and never upscales smaller sources.');
  assert.deepStrictEqual(harness.images.map(image => image.content), scans.map(item => item.canvas.content), file + ': normal PDFs use processed images.');
  assert(harness.images.every(image => image.type === 'image/jpeg' && image.quality === 0.98), file + ': normal PDF images use high quality JPEG.');
  assert(localPages.every(image => image.type === 'JPEG'), file + ': jsPDF receives JPEG images.');
  assert.deepStrictEqual(localPages.map(page => [page.format, page.orientation]), [
    ['a3', 'landscape'], ['a3', 'portrait'], ['a4', 'portrait'], ['a4', 'portrait'], ['a3', 'landscape']
  ]);
  const card = localPages[2], verticalCard = localPages[3];
  assert(Math.abs(card.width - 85.6) < 0.01 && card.height <= 53.98 + 1e-8, file + ': horizontal CCCD keeps its physical dimensions.');
  assert(Math.abs(verticalCard.height - 85.6) < 0.01 && verticalCard.width <= 53.98 + 1e-8, file + ': vertical CCCD keeps its physical dimensions.');

  const priorImages = harness.images.length;
  const backup = await context.buildOriginalBackupPdf(scans);
  assert.strictEqual(backup.length, 1);
  const backupPages = inspectPdfPart(backup[0]);
  assert.strictEqual(backup[0].pageCount, scans.length);
  assert.strictEqual(backup[0].dpi, 400);
  assert.strictEqual(backup[0].quality, 0.98);
  assert.deepStrictEqual(backupPages.map(page => [page.format, page.orientation]), localPages.map(page => [page.format, page.orientation]));
  const originals = harness.images.slice(priorImages);
  assert.strictEqual(originals.length, scans.length);
  assert.deepStrictEqual(originals.map(dimensions), [[6603, 4677], [4677, 6603], [1347, 850], [850, 1347], [1200, 849]],
    file + ': original backups also use the 400 dpi ceiling rather than unlimited native pixels.');
  assert.deepStrictEqual(originals.map(image => image.content), scans.map(item => item.originalCanvas.content), file + ': backups use original rather than processed pixels.');
  assert(originals.every(image => image.type === 'image/jpeg' && image.quality === 0.98));

  const explicit = context.preparePdfImage(harness.canvas(10000, 5000, 'dpi-ceiling'), 254, 127);
  assert.deepStrictEqual([explicit.pixelWidth, explicit.pixelHeight], [4000, 2000], file + ': the compatibility image helper delegates to the 400 dpi exporter.');
  assert.strictEqual(harness.images[harness.images.length - 1].quality, 0.98);

  // The core exporter suite covers byte boundaries/retries; this verifies that each page's adapters keep every part.
  harness.setPageBytes(6000000);
  const parts = await context.buildPdfFromScans(scans.slice(0, 2));
  assert.strictEqual(parts.length, 2, file + ': the saving helper returns all PDF parts.');
  assert.deepStrictEqual(Array.from(parts, part => part.pageCount), [1, 1]);
  assert.deepStrictEqual(Array.from(parts, part => inspectPdfPart(part)[0].orientation), ['landscape', 'portrait']);
  let multiError = null;
  try { await context.createLocalPdf(scans.slice(0, 2)); } catch (error) { multiError = error; }
  assert(multiError && /nhiều PDF/.test(multiError.message), file + ': the single-PDF helper must not silently drop additional parts.');
  assert.deepStrictEqual(scans.map(item => dimensions(item.canvas)), [[6000, 4243], [4243, 6000], [1600, 1009], [1009, 1600], [1200, 849]],
    file + ': PDF preparation never changes the stored scan canvases.');
}
async function assertNativeCamera(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const video = { width: 320, height: 240, videoWidth: 4032, videoHeight: 3024 };
  const draws = [], added = [];
  const makeCanvas = () => ({ width: 1, height: 1, getContext: () => ({ drawImage: (...args) => draws.push(args) }) });
  const scanCanvas = makeCanvas();
  const state = { processing: false, saving: false, pendingRetakeId: null, stream: null, documentPages: [], cccdPhotos: [] };
  const context = vm.createContext({ state, window: {}, scanGeneration: 0,
    document: { getElementById: id => id === 'video' ? video : scanCanvas, createElement: makeCanvas },
    prepareScanAsync: async (canvas, options) => {
      assert.deepStrictEqual([canvas.width, canvas.height], [4032, 3024]);
      assert.strictEqual(options.targetLongEdge, undefined, 'Camera scans must not impose an output cap.');
      return { canvas, detected: true, method: 'opencv' };
    },
    createScanId: () => 'camera-test', addScanItem: item => added.push(item), setStatus() {},
    alert: message => { throw new Error(message); }
  });
  vm.runInContext(functionCode('capturePage', source), context);
  await context.capturePage('document');
  assert.strictEqual(draws[0][0], video, file + ': video fallback draws the actual video source.');
  assert.strictEqual(added.length, 1);
  assert.deepStrictEqual([added[0].originalCanvas.width, added[0].originalCanvas.height], [4032, 3024]);
  assert.strictEqual(state.processing, false, file + ': capture releases the processing state.');
}

const ocrContext = vm.createContext({});
vm.runInContext(functionCode('extractConfidentCccdNumber'), ocrContext);
assert.strictEqual(ocrContext.extractConfidentCccdNumber({ confidence: 30,
  lines: [{ text: 'So: 000 000 000 000', confidence: 92 }] }), '000000000000');
assert.strictEqual(ocrContext.extractConfidentCccdNumber({ confidence: 95, text: '0000000000000' }), '');
assert.strictEqual(ocrContext.extractConfidentCccdNumber({ confidence: 95, text: '000000000000 0' }), '');
assert.strictEqual(ocrContext.extractConfidentCccdNumber({ words: [
  { text: '000000000000', confidence: 90 }, { text: '111111111111', confidence: 90 }] }), '');
assert.strictEqual(ocrContext.extractConfidentCccdNumber({ confidence: 30, text: '000000000000' }), '');
const qrContext = vm.createContext({ importScripts() {}, self: {} });
vm.runInContext(fs.readFileSync(path.join(root, 'assets/cccd-qr-worker.js'), 'utf8'), qrContext);
const payload = '000000000000|000000000|TEST PERSON|01011990|X|TEST ADDRESS|01012020';
assert.strictEqual(qrContext.parseCccdQr(payload), '000000000000');
for (const invalid of ['https://example.org/000000000000', '000000000000', '1234567890123|old|name|date|sex|address']) {
  assert.strictEqual(qrContext.parseCccdQr(invalid), '');
}
(async () => {
  for (const file of ['HamGiang.html', 'TraCu.html', 'LongHiep.html', 'TapSon.html', 'LuuNghiepAnh.html', 'DaiAn.html']) {
    await assertNativeQuality(file);
    await assertNativeCamera(file);
  }
  const gs = fs.readFileSync(path.join(root, 'code.gs'), 'utf8');
  const rows = [], savedNames = [];
  const server = vm.createContext({ ensureSheet: () => ({ getLastRow: () => 1, appendRow: row => rows.push(row) }),
    withScriptLock: callback => callback(), MAX_PDF_BYTES: 10000000,
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
  console.log('PASS: QR/OCR, native scans/camera, 400 dpi JPEG PDF adapters and split parts under 10 MB, page/card dimensions and legacy save response');
})().catch(error => { console.error(error); process.exitCode = 1; });
