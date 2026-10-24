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

[
  { name: 'blue support', background: (x, y) => [24 + x % 10, 82 + y % 15, 158 + x % 17] },
  { name: 'green woven support', background: (x, y) => [20 + x % 13, 112 + y % 21, 51 + x % 11] }
].forEach(test => {
  const width = 180, height = 140;
  const sourceImage = image(width, height, (x, y) => {
    const left = 24 + Math.floor(y / 35);
    const right = 158 - Math.floor(y / 45);
    const inside = y >= 20 && y < 122 && x >= left && x < right;
    if (!inside) return test.background(x, y);
    // Model an old spread with two paper colours, tears and small holes.
    if ((x > 84 && x < 90 && y > 50 && y < 76) || (x > 120 && x < 126 && y > 92 && y < 99)) {
      return test.background(x, y);
    }
    return x < 90 ? [226 - y % 9, 218 - y % 7, 187 - y % 5] : [196 + y % 12, 34, 48];
  });
  const mask = { data: new Uint8Array(width * height) };
  assert.strictEqual(detector.fillBackgroundContrastMask(sourceImage, mask), true, test.name);
  assert.strictEqual(mask.data[8 * width + 8], 0, test.name + ' is removed');
  assert.strictEqual(mask.data[45 * width + 50], 255, test.name + ' keeps aged white paper');
  assert.strictEqual(mask.data[45 * width + 130], 255, test.name + ' keeps the red cover');
  assert.strictEqual(mask.data[60 * width + 86], 0, test.name + ' leaves a real tear available for morphology cleanup');
});

{
  const sourceImage = image(80, 60, () => [180, 180, 180]);
  const mask = { data: new Uint8Array(80 * 60) };
  assert.strictEqual(detector.fillBackgroundContrastMask(sourceImage, mask), false,
    'A neutral border does not trigger the coloured-background fallback.');
}

{
  const width = 220, height = 160;
  const sourceImage = image(width, height, (x, y) => {
    if (x >= 22 && x < 198 && y >= 18 && y < 142) {
      return x < 110 ? [202, 188, 182] : [188, 80, 86];
    }
    return [154 + (x % 5), 158 + (y % 5), 145 + (x % 4)];
  });
  const mask = { data: new Uint8Array(width * height) };
  assert.strictEqual(detector.fillBorderContrastMask(sourceImage, mask), true,
    'A neutral support surface can still seed a document mask.');
  assert.strictEqual(mask.data[80 * width + 10], 0, 'The neutral border is removed.');
  assert.strictEqual(mask.data[80 * width + 70], 255, 'The pale document page is retained.');
  assert.strictEqual(mask.data[80 * width + 150], 255, 'The coloured document page is retained.');
}

{
  const width = 320, height = 240;
  const sourceImage = image(width, height, (x, y) => {
    if (x >= 20 && x <= 305 && y >= 60 && y <= 180) return x < 160 ? [235, 230, 211] : [205, 38, 50];
    if (y < 22 && x < 90) return [72, 82, 112]; // unrelated object touching the frame
    return [24 + x % 7, 126 + y % 11, 55 + x % 5];
  });
  const canvas = { width, height, getContext: () => ({ getImageData: () => sourceImage }) };
  const rightPage = { x: 160, y: 60, width: 145, height: 120, corners: [
    { x: 160, y: 60 }, { x: 305, y: 62 }, { x: 305, y: 178 }, { x: 160, y: 180 }
  ] };
  const recovered = detector.recoverSpread(canvas, rightPage);
  assert(recovered && recovered.detected, 'The missing half of a two-colour spread is recovered.');
  assert(recovered.x <= 25 && recovered.width >= 275, 'Spread recovery retains both the pale and red pages.');
  assert.strictEqual(recovered.detectionVariant, 'spread-support');
}

{
  const width = 320, height = 240;
  const sourceImage = image(width, height, (x, y) => {
    if (x >= 42 && x <= 286 && y >= 62 && y <= 181) return [224 + x % 5, 219 + y % 4, 203];
    if (y < 120) return [82 + (x * 7 + y * 3) % 35, 80 + (x * 5) % 31, 78 + y % 29];
    return [182 + (x * 3 + y) % 28, 180 + x % 21, 174 + y % 19];
  });
  const canvas = { width, height, getContext: () => ({ getImageData: () => sourceImage }) };
  const rightPage = { x: 162, y: 62, width: 124, height: 119, corners: [
    { x: 162, y: 62 }, { x: 286, y: 64 }, { x: 286, y: 179 }, { x: 162, y: 181 }
  ] };
  const recovered = detector.recoverSpread(canvas, rightPage);
  assert(recovered && recovered.x <= 46 && recovered.width >= 238,
    'Neutral stone/tile support recovers the other half without relying on background hue.');
}

console.log('A4/A3 detector: mixed, aged and torn paper is retained over blue/green support surfaces.');
