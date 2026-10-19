// Run with Node 10+: node tests/a4-document-detector.test.js. Synthetic pixels only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'assets/a4-document-detector.js'), 'utf8');
const context = { self: {}, console };
vm.runInNewContext(source, context);
const detector = context.self.A4DocumentDetector;

function image(width, height, pixel) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = pixel(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = 255;
    }
  }
  return { cols: width, rows: height, data };
}

{
  const width = 160, height = 120;
  const sourceImage = image(width, height, (x, y) => {
    if (x >= 20 && x < 140 && y >= 25 && y < 100) return x < 80 ? [238, 236, 225] : [205, 38, 58];
    return [25 + (x % 9), 125 + (y % 13), 63 + (x % 7)];
  });
  const mask = { data: new Uint8Array(width * height) };
  assert.strictEqual(detector.fillBackgroundContrastMask(sourceImage, mask), true);
  assert.strictEqual(mask.data[10 * width + 10], 0, 'The coloured support surface is removed.');
  assert.strictEqual(mask.data[50 * width + 40], 255, 'The white half of a document is retained.');
  assert.strictEqual(mask.data[50 * width + 110], 255, 'The red half of the same document is retained.');
}

{
  const sourceImage = image(80, 60, () => [180, 180, 180]);
  const mask = { data: new Uint8Array(80 * 60) };
  assert.strictEqual(detector.fillBackgroundContrastMask(sourceImage, mask), false,
    'A neutral border does not trigger the coloured-background fallback.');
}

console.log('A4/A3 detector: mixed white/red paper is retained over a coloured support surface.');
