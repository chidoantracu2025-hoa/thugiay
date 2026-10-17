// Run with Node 10+: node tests/pdf-export.test.js. No network or private documents.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/pdf-export.js'), 'utf8');
const CAP = 10000000;

function harness(options) {
  options = options || {};
  const scratch = [], encodings = [], outputs = [], placements = [];
  let syncEncodings = 0;
  const canvas = (width, height, label) => ({ width, height, label });
  function createCanvas() {
    const value = canvas(1, 1, '');
    value.events = [];
    value.getContext = (type, settings) => {
      assert.strictEqual(type, '2d');
      assert.strictEqual(settings.alpha, false);
      const context = {
        fillRect(x, y, width, height) { value.events.push(['fill', context.fillStyle, x, y, width, height]); },
        drawImage(image, x, y, width, height) {
          assert.strictEqual(context.imageSmoothingQuality, 'high');
          value.label = image.label;
          value.events.push(['draw', image.label, x, y, width, height]);
        }
      };
      return context;
    };
    function encode(type, quality) {
      assert.deepStrictEqual(value.events.map(event => event[0]), ['fill', 'draw']);
      assert.strictEqual(value.events[0][1], '#ffffff');
      assert.strictEqual(type, 'image/jpeg');
      const image = { label: value.label, quality, pixelWidth: value.width, pixelHeight: value.height };
      encodings.push(image);
      if (options.encodeError) throw new Error('simulated canvas error');
      const metadata = Buffer.from(JSON.stringify(image));
      const byteLength = options.imageBytes ? options.imageBytes(image) : 1000;
      const bytes = new Uint8Array(Math.max(byteLength, metadata.length + 1));
      bytes.set(metadata);
      return bytes;
    }
    value.toDataURL = (type, quality) => {
      syncEncodings++;
      return 'data:image/jpeg;base64,' + Buffer.from(encode(type, quality)).toString('base64');
    };
    if (!options.syncOnly) value.toBlob = (callback, type, quality) => {
      const bytes = encode(type, quality);
      Promise.resolve().then(() => callback({ type, size: bytes.byteLength,
        arrayBuffer: () => Promise.resolve(bytes.buffer) }));
    };
    scratch.push(value);
    return value;
  }
  class PDF {
    constructor(settings) {
      this.pages = [];
      this.addPage(settings.format, settings.orientation);
      this.internal = { pageSize: { getWidth: () => this.width, getHeight: () => this.height } };
    }
    addPage(format, orientation) {
      const size = format === 'a3' ? [297, 420] : [210, 297];
      this.width = size[orientation === 'landscape' ? 1 : 0];
      this.height = size[orientation === 'landscape' ? 0 : 1];
      this.pages.push({ format, orientation });
    }
    addImage(data, type, x, y, width, height, alias) {
      assert.strictEqual(type, 'JPEG');
      assert(ArrayBuffer.isView(data), 'Saving passes JPEG bytes directly to jsPDF without Base64 strings.');
      assert(/^scan_image_\d+$/.test(alias), 'Explicit image aliases bypass expensive, partial jsPDF byte hashes.');
      assert(width <= this.width + 1e-9 && height <= this.height + 1e-9);
      assert(Math.abs(x - (this.width - width) / 2) < 1e-9);
      assert(Math.abs(y - (this.height - height) / 2) < 1e-9);
      const bytes = Buffer.from(data);
      const end = bytes.indexOf(0);
      const image = JSON.parse(bytes.slice(0, end < 0 ? bytes.length : end).toString());
      const current = this.pages[this.pages.length - 1];
      current.image = image;
      current.byteLength = bytes.length;
      placements.push({ format: current.format, orientation: current.orientation, image, width, height, alias });
    }
    output(type) {
      assert.strictEqual(type, 'arraybuffer');
      const overhead = typeof options.overhead === 'function' ? options.overhead(this.pages.length) :
        options.overhead === undefined ? 1024 : options.overhead;
      const byteLength = overhead + this.pages.reduce((sum, page) => sum + page.byteLength, 0);
      const buffer = new ArrayBuffer(byteLength);
      const labels = Buffer.from(JSON.stringify(this.pages.map(page => page.image.label)));
      new Uint8Array(buffer).set(labels);
      outputs.push({ byteLength, labels: this.pages.map(page => page.image.label) });
      return buffer;
    }
  }
  const window = { document: { createElement: tag => {
    assert.strictEqual(tag, 'canvas');
    return createCanvas();
  } }, jspdf: { jsPDF: PDF }, setTimeout: callback => callback(),
  btoa: value => Buffer.from(value, 'binary').toString('base64'),
  atob: value => Buffer.from(value, 'base64').toString('binary') };
  vm.runInNewContext(source, { window });
  return { api: window.DocumentPdfExporter, canvas, scratch, encodings, outputs, placements,
    syncCount: () => syncEncodings };
}

function inspectPart(part) {
  const bytes = Buffer.from(part.dataUri.split(',')[1], 'base64');
  assert.strictEqual(bytes.length, part.byteLength);
  assert(bytes.length <= CAP);
  return JSON.parse(bytes.slice(0, bytes.indexOf(0)).toString());
}

function assertReleased(test) {
  assert(test.scratch.every(canvas => canvas.width === 0 && canvas.height === 0),
    'Temporary canvases release their backing store.');
}

function canonicalBlob(label, quality, width, height, byteLength) {
  const bytes = new Uint8Array(byteLength || 2048);
  bytes.set(Buffer.from(JSON.stringify({ label, quality, pixelWidth: width, pixelHeight: height })));
  return { type: 'image/jpeg', size: bytes.byteLength, reads: 0,
    arrayBuffer() { this.reads++; return Promise.resolve(bytes.buffer); } };
}

async function rejects(action, pattern) {
  let error;
  try { await action(); } catch (caught) { error = caught; }
  assert(error && pattern.test(error.message), error && error.message);
}

async function main() {
  let test = harness();
  const native = test.canvas(10000, 5000, 'dense');
  const image = test.api.prepareImage(native, 254, 127);
  assert.deepStrictEqual([image.pixelWidth, image.pixelHeight], [4000, 2000]);
  assert.deepStrictEqual([native.width, native.height], [10000, 5000]);
  const small = test.api.prepareImage(test.canvas(1000, 500, 'small'), 254, 127);
  assert.deepStrictEqual([small.pixelWidth, small.pixelHeight], [1000, 500]);
  assert.strictEqual(image.widthMm, 254);
  assert.strictEqual(image.heightMm, 127);
  assertReleased(test);

  test = harness();
  const storedBlob = canonicalBlob('canonical-stored', .94, 1200, 1700);
  const storedItem = { type: 'document', canvas: null, processedBlob: storedBlob,
    processedWidth: 1200, processedHeight: 1700, processedQuality: .94, processedCanonical: true,
    processingQuality: { dpi: 400 }, revision: 1 };
  const storedParts = await test.api.exportPdfParts([storedItem], { loadSource: () => {
    throw new Error('A canonical JPEG below the DPI ceiling must never decode.');
  } });
  assert.deepStrictEqual(inspectPart(storedParts[0]), ['canonical-stored']);
  assert.strictEqual(storedParts[0].quality, .94, 'Parts report the actual stored JPEG quality rather than the default encoder quality.');
  assert.strictEqual(test.encodings.length, 0, 'Previously encoded canonical documents embed without JPEG recompression.');
  assert.strictEqual(test.scratch.length, 0, 'Canonical JPEGs do not allocate a full-size temporary canvas.');
  await test.api.exportPdfParts([storedItem]);
  assert.strictEqual(storedBlob.reads, 1, 'Canonical JPEG bytes are cached for an unchanged item.');
  storedItem.processedBlob = canonicalBlob('canonical-replaced', .94, 1200, 1700);
  const replaced = await test.api.exportPdfParts([storedItem]);
  assert.deepStrictEqual(inspectPart(replaced[0]), ['canonical-replaced'], 'Replacing the stored JPEG invalidates its byte cache.');

  test = harness();
  let orientationLoads = 0;
  const ambiguous = { type: 'document', processedBlob: canonicalBlob('not-proven-canonical', .96, 1700, 1200),
    processedWidth: 1700, processedHeight: 1200, processedQuality: .96 };
  const oriented = await test.api.exportPdfParts([ambiguous], { loadSource: () => {
    orientationLoads++;
    return { canvas: test.canvas(1200, 1700, 'decoded-orientation') };
  } });
  assert.strictEqual(orientationLoads, 1, 'Unverified JPEG orientation always follows the decode path.');
  assert.deepStrictEqual(inspectPart(oriented[0]), ['decoded-orientation']);
  assert.strictEqual(test.placements[0].orientation, 'portrait');

  test = harness();
  const native300 = { type: 'document', processedBlob: canonicalBlob('already-300dpi', .96, 4960, 3507),
    processedWidth: 4960, processedHeight: 3507, processedQuality: .96, processedDpi: 300, processedCanonical: true };
  const native300Parts = await test.api.exportPdfParts([native300], { loadSource: () => {
    throw new Error('An already compliant 300 dpi JPEG must embed directly.');
  } });
  assert.strictEqual(native300Parts[0].dpi, 300);
  assert.strictEqual(test.encodings.length, 0);

  test = harness();
  let processedLoads = 0, processedReleases = 0;
  const highDpiItem = { type: 'document', canvas: null,
    processedBlob: canonicalBlob('stored-400dpi', .92, 4677, 6614),
    processedWidth: 4677, processedHeight: 6614, processedQuality: .92, processedCanonical: true,
    processingQuality: { dpi: 300 } };
  const reduced = await test.api.exportPdfParts([highDpiItem], { loadSource: () => {
    processedLoads++;
    return { canvas: test.canvas(4677, 6614, 'resampled-300dpi'), release: () => { processedReleases++; } };
  } });
  assert.strictEqual(processedLoads, 1, 'Changing a 400 dpi JPEG to 300 dpi decodes and downsamples instead of embedding oversized pixels.');
  assert.strictEqual(processedReleases, 1);
  assert.strictEqual(reduced[0].quality, .92, 'A new encode cannot claim to restore the higher quality lost in a stored JPEG.');
  assert.strictEqual(reduced[0].dpi, 300);
  test.placements.forEach(page => {
    assert(page.image.pixelWidth <= page.width / 25.4 * 300 + 1e-8);
    assert(page.image.pixelHeight <= page.height / 25.4 * 300 + 1e-8);
  });
  assertReleased(test);

  test = harness({ imageBytes: value => value.quality > .94 ? CAP + 100 : CAP - 2048 });
  let oversizedLoads = 0;
  const oversizedItem = { type: 'document', canvas: null,
    processedBlob: canonicalBlob('canonical-too-big', .96, 1200, 1700, CAP + 100),
    processedWidth: 1200, processedHeight: 1700, processedQuality: .96, processedCanonical: true };
  const compressedAgain = await test.api.exportPdfParts([oversizedItem], { loadSource: () => {
    oversizedLoads++;
    return { canvas: test.canvas(1200, 1700, 'canonical-retry') };
  } });
  assert.strictEqual(oversizedLoads, 1);
  assert.deepStrictEqual(test.encodings.map(value => value.quality), [.94], 'Oversized canonical JPEG retries start below its stored quality.');
  assert.strictEqual(compressedAgain[0].quality, .94);
  inspectPart(compressedAgain[0]);
  assertReleased(test);

  test = harness();
  const scans = [
    { type: 'document', canvas: test.canvas(8000, 11314, 'portrait') },
    { type: 'document', canvas: test.canvas(11314, 8000, 'landscape') },
    { type: 'cccd-front', canvas: test.canvas(4000, 2522, 'card') },
    { type: 'cccd-back', canvas: test.canvas(2522, 4000, 'vertical-card') }
  ];
  const parts = await test.api.exportPdfParts(scans);
  assert.strictEqual(parts.length, 1);
  assert.deepStrictEqual(inspectPart(parts[0]), ['portrait', 'landscape', 'card', 'vertical-card']);
  assert.strictEqual(test.outputs.length, 1, 'A normal four-page document is assembled once, not rebuilt after every page.');
  assert.strictEqual(test.syncCount(), 0, 'Saving uses asynchronous Blob encoding.');
  assert.strictEqual(new Set(test.placements.map(page => page.alias)).size, 4,
    'Distinct pages always receive distinct image aliases, even when leading JPEG bytes match.');
  assert.deepStrictEqual(test.placements.map(page => [page.format, page.orientation]), [
    ['a3', 'portrait'], ['a3', 'landscape'], ['a4', 'portrait'], ['a4', 'portrait']
  ]);
  test.placements.forEach(page => {
    assert(page.image.pixelWidth <= page.width / 25.4 * 400 + 1e-8);
    assert(page.image.pixelHeight <= page.height / 25.4 * 400 + 1e-8);
  });
  assert(test.placements[2].width <= 85.6 && test.placements[2].height <= 53.98);
  assert(test.placements[3].width <= 53.98 && test.placements[3].height <= 85.6);
  assert.strictEqual(parts[0].quality, 0.96);
  assert.strictEqual(parts[0].dpi, 400);
  await test.api.exportPdfParts(scans);
  assert.strictEqual(test.encodings.length, 4, 'Retrying an unchanged export reuses encoded JPEGs.');
  scans[0].revision = 1;
  await test.api.exportPdfParts(scans);
  assert.strictEqual(test.encodings.length, 5, 'Only a revised page is re-encoded.');
  test.api.clearCache(scans[1]);
  await test.api.exportPdfParts(scans);
  assert.strictEqual(test.encodings.length, 6);
  assertReleased(test);

  test = harness({ imageBytes: () => 5200000 });
  const cachePages = ['cache-a', 'cache-b', 'cache-c', 'cache-d', 'cache-e'].map(label =>
    ({ type: 'document', canvas: test.canvas(1200, 1700, label) }));
  await test.api.exportPdfParts(cachePages);
  assert.strictEqual(test.encodings.length, 5);
  await test.api.exportPdfParts([cachePages[4]]);
  assert.strictEqual(test.encodings.length, 5, 'Recent JPEGs remain reusable within the byte budget.');
  await test.api.exportPdfParts([cachePages[0]]);
  assert.strictEqual(test.encodings.length, 6, 'The oldest JPEG is evicted when encoded cache bytes exceed 24 MiB.');
  assertReleased(test);

  test = harness({ imageBytes: () => 5000000 });
  const splitScans = ['one', 'two', 'three'].map(label => ({ type: 'document', canvas: test.canvas(1200, 1700, label) }));
  const split = await test.api.exportPdfParts(splitScans);
  assert.strictEqual(split.length, 3);
  assert.deepStrictEqual(Array.from(split, inspectPart), [['one'], ['two'], ['three']]);
  assert.strictEqual(test.outputs.length, 3);
  assert.deepStrictEqual(test.encodings.map(value => value.quality), [0.96, 0.96, 0.96]);
  assertReleased(test);

  test = harness({ imageBytes: () => 3000000, overhead: 1100000 });
  const fallback = await test.api.exportPdfParts(['a', 'b', 'c'].map(label => ({ type: 'document', canvas: test.canvas(1000, 1400, label) })));
  assert.deepStrictEqual(Array.from(fallback, inspectPart), [['a', 'b'], ['c']],
    'Unexpected final PDF overhead triggers exact validation and an ordered split.');
  assert.strictEqual(test.encodings.length, 3, 'Final validation never re-encodes pages during regrouping.');

  test = harness({ imageBytes: () => CAP - 1024 });
  const boundary = await test.api.exportPdfParts([{ type: 'document', canvas: test.canvas(1200, 1700, 'exact') }]);
  assert.strictEqual(boundary[0].byteLength, CAP);
  assert.strictEqual(test.outputs.length, 1, 'An oversized estimate reuses the exact validated single-page PDF.');
  inspectPart(boundary[0]);

  test = harness({ imageBytes: value => value.quality > 0.94 ? CAP + 100 : CAP - 2048 });
  const retried = await test.api.exportPdfParts([{ type: 'document', canvas: test.canvas(9000, 6000, 'retry') }]);
  assert.strictEqual(retried[0].quality, 0.94);
  assert.deepStrictEqual(test.encodings.map(value => value.quality), [0.96, 0.94]);
  assert(test.encodings.every(value => value.pixelWidth === test.encodings[0].pixelWidth &&
    value.pixelHeight === test.encodings[0].pixelHeight));
  inspectPart(retried[0]);
  assertReleased(test);

  test = harness({ imageBytes: () => CAP + 100 });
  await rejects(() => test.api.exportPdfParts([{ type: 'document', canvas: test.canvas(9000, 6000, 'too-big') }]),
    /Trang 1.*10 MB.*400 dpi.*92%/);
  assert.deepStrictEqual(test.encodings.map(value => value.quality), [0.96, 0.94, 0.92]);
  assertReleased(test);

  test = harness();
  let loads = 0, releases = 0;
  const originalScan = { type: 'document', originalBlob: {}, processingQuality: { dpi: 300 } };
  const originalOptions = { original: true, loadSource: async (item, original) => {
    assert.strictEqual(item, originalScan);
    assert.strictEqual(original, true);
    loads++;
    return { canvas: test.canvas(10000, 5000, 'original'), release: () => { releases++; } };
  } };
  const original = await test.api.exportPdfParts([originalScan], originalOptions);
  assert.deepStrictEqual(inspectPart(original[0]), ['original']);
  assert.strictEqual(original[0].dpi, 300);
  assert(test.encodings[0].pixelWidth <= 420 / 25.4 * 300);
  await test.api.exportPdfParts([originalScan], originalOptions);
  assert.strictEqual(loads, 1, 'Original Blob retries skip decoding as well as JPEG encoding.');
  assert.strictEqual(releases, 1);
  originalScan.originalBlob = {};
  await test.api.exportPdfParts([originalScan], originalOptions);
  assert.strictEqual(loads, 2, 'Replacing a source Blob invalidates the image cache.');
  test.api.reset();
  await test.api.exportPdfParts([originalScan], originalOptions);
  assert.strictEqual(loads, 3);
  assertReleased(test);

  test = harness({ encodeError: true });
  let errorRelease = 0;
  await rejects(() => test.api.exportPdfParts([{ type: 'document' }], { loadSource: () =>
    ({ canvas: test.canvas(1000, 1400, 'error'), release: () => { errorRelease++; } }) }), /simulated canvas error/);
  assert.strictEqual(errorRelease, 1, 'Decoded source ownership is released after failures.');
  assertReleased(test);

  test = harness({ syncOnly: true });
  const legacy = await test.api.exportPdfParts([{ type: 'document', canvas: test.canvas(1200, 1700, 'legacy') }]);
  assert.deepStrictEqual(inspectPart(legacy[0]), ['legacy']);
  assert.strictEqual(test.syncCount(), 1);

  test = harness();
  const simultaneous = await Promise.all(['session-a', 'session-b'].map(label => test.api.exportPdfParts([
    { type: 'document', canvas: test.canvas(1200, 1700, label) }
  ])));
  assert.deepStrictEqual(simultaneous.map(result => inspectPart(result[0])), [['session-a'], ['session-b']]);
  assertReleased(test);
  console.log('PASS: canonical JPEG reuse without decode/re-encode, async JPEG bytes, linear PDF assembly, bounded/revision cache, Blob lifecycle, 300/400 dpi, exact 10 MB split/retries and isolated exports');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
