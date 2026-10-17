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
  const canvas = (width, height, label) => ({ width, height, label });
  function createCanvas() {
    const value = canvas(1, 1, '');
    value.events = [];
    value.getContext = (type, settings) => {
      assert.strictEqual(type, '2d');
      assert.strictEqual(settings.alpha, false, 'JPEG preparation uses an opaque canvas.');
      const context = {
        fillRect(x, y, width, height) {
          value.events.push(['fill', context.fillStyle, x, y, width, height]);
        },
        drawImage(image, x, y, width, height) {
          assert.strictEqual(context.imageSmoothingQuality, 'high');
          value.label = image.label;
          value.events.push(['draw', image.label, x, y, width, height]);
        }
      };
      return context;
    };
    value.toDataURL = (type, quality) => {
      assert.deepStrictEqual(value.events.map(event => event[0]), ['fill', 'draw']);
      assert.strictEqual(value.events[0][1], '#ffffff', 'Transparent regions flatten onto white.');
      assert.strictEqual(type, 'image/jpeg');
      const image = { label: value.label, quality, pixelWidth: value.width, pixelHeight: value.height };
      encodings.push(image);
      if (options.encodeError) throw new Error('simulated canvas error');
      return 'data:image/jpeg;base64,' + Buffer.from(JSON.stringify(image)).toString('base64');
    };
    scratch.push(value);
    return value;
  }
  class PDF {
    constructor(options) {
      this.pages = [];
      this.addPage(options.format, options.orientation);
      this.internal = { pageSize: { getWidth: () => this.width, getHeight: () => this.height } };
    }
    addPage(format, orientation) {
      const size = format === 'a3' ? [297, 420] : [210, 297];
      this.width = size[orientation === 'landscape' ? 1 : 0];
      this.height = size[orientation === 'landscape' ? 0 : 1];
      this.pages.push({ format, orientation });
    }
    addImage(data, type, x, y, width, height) {
      assert.strictEqual(type, 'JPEG');
      assert(width <= this.width + 1e-9 && height <= this.height + 1e-9);
      assert(Math.abs(x - (this.width - width) / 2) < 1e-9);
      assert(Math.abs(y - (this.height - height) / 2) < 1e-9);
      const image = JSON.parse(Buffer.from(data.split(',')[1], 'base64').toString());
      const current = this.pages[this.pages.length - 1];
      current.image = image;
      placements.push({ format: current.format, orientation: current.orientation,
        image, width, height });
    }
    output(type) {
      assert.strictEqual(type, 'arraybuffer', 'The final PDF bytes determine the cap.');
      const imageBytes = this.pages.reduce((sum, page) => sum +
        (options.imageBytes ? options.imageBytes(page.image) : 1000), 0);
      const byteLength = (options.overhead === undefined ? 1024 : options.overhead) + imageBytes;
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
  btoa: value => Buffer.from(value, 'binary').toString('base64') };
  vm.runInNewContext(source, { window });
  return { api: window.DocumentPdfExporter, canvas, scratch, encodings, outputs, placements };
}

function inspectPart(part) {
  const bytes = Buffer.from(part.dataUri.split(',')[1], 'base64');
  assert.strictEqual(bytes.length, part.byteLength, 'Returned Base64 contains the exact measured PDF bytes.');
  assert(bytes.length <= CAP);
  const terminator = bytes.indexOf(0);
  return JSON.parse(bytes.slice(0, terminator).toString());
}

function assertReleased(test) {
  assert(test.scratch.every(canvas => canvas.width === 0 && canvas.height === 0),
    'All temporary canvases release their backing store.');
}

async function main() {
  let test = harness();
  const native = test.canvas(10000, 5000, 'dense');
  const image = test.api.prepareImage(native, 254, 127);
  assert.deepStrictEqual([image.pixelWidth, image.pixelHeight], [4000, 2000],
    'A 10 × 5 inch image exports at the requested 400 dpi ceiling.');
  assert.deepStrictEqual([native.width, native.height], [10000, 5000], 'Sources remain intact.');
  const small = test.api.prepareImage(test.canvas(1000, 500, 'small'), 254, 127);
  assert.deepStrictEqual([small.pixelWidth, small.pixelHeight], [1000, 500], 'Small sources never upscale.');
  assert.strictEqual(image.widthMm, 254);
  assert.strictEqual(image.heightMm, 127);
  assertReleased(test);

  const scans = [
    { type: 'document', canvas: test.canvas(8000, 11314, 'portrait') },
    { type: 'document', canvas: test.canvas(11314, 8000, 'landscape') },
    { type: 'cccd-front', canvas: test.canvas(4000, 2522, 'card') },
    { type: 'cccd-back', canvas: test.canvas(2522, 4000, 'vertical-card') }
  ];
  const parts = await test.api.exportPdfParts(scans);
  assert.strictEqual(parts.length, 1);
  assert.deepStrictEqual(inspectPart(parts[0]), ['portrait', 'landscape', 'card', 'vertical-card']);
  const finalPlacements = test.placements.slice(-4);
  assert.deepStrictEqual(finalPlacements.map(page => [page.format, page.orientation]), [
    ['a3', 'portrait'], ['a3', 'landscape'], ['a4', 'portrait'], ['a4', 'portrait']
  ]);
  finalPlacements.forEach(page => {
    assert(page.image.pixelWidth <= page.width / 25.4 * 400 + 1e-8);
    assert(page.image.pixelHeight <= page.height / 25.4 * 400 + 1e-8);
  });
  assert(finalPlacements[2].width <= 85.6 && finalPlacements[2].height <= 53.98);
  assert(finalPlacements[3].width <= 53.98 && finalPlacements[3].height <= 85.6);
  assert.strictEqual(parts[0].quality, 0.98);
  assert.strictEqual(parts[0].dpi, 400);
  assertReleased(test);

  test = harness({ imageBytes: () => 5000000 });
  const splitScans = ['one', 'two', 'three'].map(label => ({ type: 'document', canvas: test.canvas(1200, 1700, label) }));
  const split = await test.api.exportPdfParts(splitScans);
  assert.strictEqual(split.length, 3, 'PDF metadata counts even when JPEGs total exactly 10 MB.');
  assert.deepStrictEqual(Array.from(split, inspectPart), [['one'], ['two'], ['three']], 'Splitting preserves page order and every page.');
  assert.strictEqual(split.reduce((sum, part) => sum + part.pageCount, 0), 3);
  assert.deepStrictEqual(test.encodings.map(image => image.quality), [0.98, 0.98, 0.98],
    'Splitting reuses cached JPEGs rather than lowering quality or re-encoding pages.');
  assertReleased(test);

  test = harness({ imageBytes: () => CAP - 1024 });
  const boundary = await test.api.exportPdfParts([{ type: 'document', canvas: test.canvas(1200, 1700, 'exact') }]);
  assert.strictEqual(boundary[0].byteLength, CAP, 'Exactly 10,000,000 bytes is permitted.');
  inspectPart(boundary[0]);

  test = harness({ imageBytes: image => image.quality > 0.94 ? CAP + 100 : CAP - 2048 });
  const retried = await test.api.exportPdfParts([{ type: 'document', canvas: test.canvas(9000, 6000, 'retry') }]);
  assert.strictEqual(retried[0].quality, 0.94);
  assert.deepStrictEqual(test.encodings.map(image => image.quality), [0.98, 0.96, 0.94]);
  assert(test.encodings.every(image => image.pixelWidth === test.encodings[0].pixelWidth &&
    image.pixelHeight === test.encodings[0].pixelHeight), 'Quality retries do not further downsample.');
  inspectPart(retried[0]);
  assertReleased(test);

  test = harness({ imageBytes: () => CAP + 100 });
  let rejection;
  try { await test.api.exportPdfParts([{ type: 'document', canvas: test.canvas(9000, 6000, 'too-big') }]); }
  catch (error) { rejection = error; }
  assert(rejection && /Trang 1.*10 MB.*400 dpi.*92%/.test(rejection.message));
  assert.deepStrictEqual(test.encodings.map(image => image.quality), [0.98, 0.96, 0.94, 0.92]);
  assertReleased(test);

  test = harness();
  const original = await test.api.exportPdfParts([{ type: 'document',
    canvas: test.canvas(4000, 3000, 'processed'), originalCanvas: test.canvas(2000, 1000, 'original') }], { original: true });
  assert.deepStrictEqual(inspectPart(original[0]), ['original']);
  assert.deepStrictEqual([test.encodings[0].pixelWidth, test.encodings[0].pixelHeight], [2000, 1000]);
  assertReleased(test);

  test = harness({ encodeError: true });
  try { await test.api.exportPdfParts([{ type: 'document', canvas: test.canvas(4000, 3000, 'error') }]); }
  catch (error) { assert.strictEqual(error.message, 'simulated canvas error'); }
  assertReleased(test);

  test = harness();
  const simultaneous = await Promise.all(['session-a', 'session-b'].map(label => test.api.exportPdfParts([
    { type: 'document', canvas: test.canvas(1200, 1700, label) }
  ])));
  assert.deepStrictEqual(simultaneous.map(parts => inspectPart(parts[0])), [['session-a'], ['session-b']],
    'Concurrent calls keep document ownership isolated.');
  assertReleased(test);
  console.log('PASS: 400 dpi ceiling/native pixels, white JPEG flattening, A3/card placement, exact PDF bytes, ordered 10 MB splitting, quality retries, rejection and per-call isolation');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
