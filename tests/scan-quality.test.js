// Run with node tests/scan-quality.test.js. Synthetic pixels only; no personal documents or network.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '..', 'assets/scan-quality.js'), 'utf8');

function environment() {
  const canvases = [];
  function canvas(width, height, image) {
    const value = { width: width || 1, height: height || 1, reads: [], writes: [], draws: [], image };
    function pixels() {
      if (!value.image || value.image.length !== value.width * value.height * 4) {
        value.image = new Uint8ClampedArray(value.width * value.height * 4);
        value.image.fill(255);
      }
      return value.image;
    }
    value.getContext = () => ({
      drawImage(input, sx, sy, sw, sh, dx, dy, dw, dh) {
        value.draws.push(Array.prototype.slice.call(arguments));
        if (!input.image) return;
        if (arguments.length === 5) { dw = sw; dh = sh; sw = input.width; sh = input.height; sx = sy = 0; }
        const destination = pixels();
        for (let y = 0; y < value.height; y++) {
          for (let x = 0; x < value.width; x++) {
            const from = (Math.min(input.height - 1, Math.floor(sy + y * sh / dh)) * input.width +
              Math.min(input.width - 1, Math.floor(sx + x * sw / dw))) * 4;
            const to = (y * value.width + x) * 4;
            for (let channel = 0; channel < 4; channel++) destination[to + channel] = input.image[from + channel];
          }
        }
      },
      getImageData(x, y, width, height) {
        value.reads.push({ x, y, width, height });
        const data = new Uint8ClampedArray(width * height * 4), input = pixels();
        for (let row = 0; row < height; row++) {
          data.set(input.subarray(((y + row) * value.width + x) * 4,
            ((y + row) * value.width + x + width) * 4), row * width * 4);
        }
        return { data, width, height };
      },
      putImageData(image, x, y) {
        value.writes.push({ x, y, width: image.width, height: image.height });
        pixels().set(image.data, (y * value.width + x) * 4);
      }
    });
    canvases.push(value);
    return value;
  }
  const window = { document: { createElement: () => canvas(1, 1) } };
  vm.runInNewContext(source, { window });
  return { api: window.ScanQuality, canvas, canvases };
}

function rgba(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = typeof color === 'function' ? color(x, y) : color;
      const index = (y * width + x) * 4;
      data[index] = value[0]; data[index + 1] = value[1]; data[index + 2] = value[2]; data[index + 3] = 255;
    }
  }
  return data;
}

function cvMock() {
  const mats = [];
  const calls = [];
  function Mat() { this.data = new Uint8Array(0); this.deleted = false; mats.push(this); }
  Mat.prototype.delete = function () { this.deleted = true; };
  const cv = {
    Mat, mats, calls,
    Size: function (width, height) { this.width = width; this.height = height; },
    matFromImageData(image) { const mat = new Mat(); mat.image = image; calls.push(['input', image.width, image.height]); return mat; },
    matFromArray(rows, columns, type, data) { const mat = new Mat(); mat.data = data; calls.push(['points', data]); return mat; },
    cvtColor(input, output) {
      const pixels = input.image.data;
      output.data = new Uint8Array(pixels.length / 4);
      for (let p = 0; p < output.data.length; p++) output.data[p] = pixels[p * 4];
    },
    GaussianBlur(input, output) { output.data = input.data.slice(); },
    resize(input, output, size) { output.data = new Uint8Array(size.width * size.height); output.data.fill(80); },
    getPerspectiveTransform() { return new Mat(); },
    warpPerspective() { if (cv.failWarp) throw new Error('synthetic warp failure'); },
    imshow() {}
  };
  return cv;
}

function testDpiPolicy() {
  const api = environment().api;
  const sourceImage = { width: 10000, height: 8000 };
  const bounds = { x: 0, y: 0, width: 9000, height: 6364 };
  const result = api.outputPolicy(sourceImage, bounds);
  assert.strictEqual(result.dpi, 400);
  assert(result.limited && result.optimized);
  assert(result.pixelWidth <= 420 / 25.4 * 400 && result.pixelHeight <= 297 / 25.4 * 400,
    'The A3 physical placement limits pixels before full-resolution processing.');
  assert(result.pixelWidth * result.pixelHeight < bounds.width * bounds.height * 0.55,
    'A large camera image avoids processing more than 45 percent of its source pixels.');
  assert.strictEqual(result.quality.detailAssessment, 'unverified');
  assert.strictEqual(sourceImage.width, 10000);
  const portrait = api.outputPolicy(sourceImage, { width: bounds.height, height: bounds.width });
  assert.strictEqual(portrait.pixelWidth, result.pixelHeight);
  assert.strictEqual(portrait.pixelHeight, result.pixelWidth);

  const small = api.outputPolicy({ width: 2400, height: 1697 });
  assert.strictEqual(small.pixelWidth, 2400, 'Smaller images are never enlarged to claim a higher DPI.');
  assert.strictEqual(small.pixelHeight, 1697);
  assert(small.quality.lowResolution && small.quality.warnings.length);
  assert(small.effectiveDpi < 150);
  const card = api.outputPolicy(sourceImage, { width: 6000, height: 3784 }, { documentType: 'cccd-front' });
  assert(card.pixelWidth <= 85.6 / 25.4 * 400 && card.pixelHeight <= 53.98 / 25.4 * 400);
  const a4 = api.outputPolicy(sourceImage, bounds, { documentFormat: 'a4' });
  assert(a4.pixelWidth <= 297 / 25.4 * 400 && a4.pixelHeight <= 210 / 25.4 * 400);

  const explicit = api.outputPolicy(sourceImage, bounds, { targetLongEdge: 3100 });
  assert.strictEqual(explicit.targetLongEdge, 3100, 'Explicit legacy preview limits remain stable.');
  const native = api.outputPolicy(sourceImage, bounds, { optimize: false });
  assert.strictEqual(native.pixelWidth, bounds.width);
  assert.strictEqual(native.pixelHeight, bounds.height);
  const economy = api.outputPolicy(sourceImage, bounds, { dpi: 300 });
  assert.strictEqual(economy.dpi, 300);
  assert.strictEqual(economy.quality.dpiSelection, 'explicit');
  assert(economy.pixelWidth * economy.pixelHeight < result.pixelWidth * result.pixelHeight * 0.57);
  const fakeConfidence = api.outputPolicy(sourceImage, bounds, { qualityEvidence: { laplacian: 5000, readableAt300: true } });
  assert.strictEqual(fakeConfidence.dpi, 400, 'High contrast/sharpness alone cannot justify discarding small text detail.');
  const verified = { source: 'verified-text-sampling', regionCount: 5, allRegionsClear: true,
    minGlyphHeightAt300: 14, minStrokeWidthAt300: 1.5, minContrast: 64 };
  assert.strictEqual(api.outputPolicy(sourceImage, bounds, { qualityEvidence: verified }).dpi, 300);
  assert.strictEqual(api.outputPolicy(sourceImage, bounds, { dpi: 400, qualityEvidence: verified }).dpi, 400,
    'An explicit 400 dpi preference is never lowered by an automatic quality hint.');
  for (const failed of [
    { regionCount: 4 }, { allRegionsClear: false }, { minGlyphHeightAt300: 13.9 },
    { minStrokeWidthAt300: 1.4 }, { minContrast: 63 }
  ]) {
    assert.strictEqual(api.outputPolicy(sourceImage, bounds, { qualityEvidence: Object.assign({}, verified, failed) }).dpi, 400);
  }
  for (const dpi of [300, 400]) {
    for (const size of [[9000, 6364], [6364, 9000], [12000, 8000], [8000, 12000], [3600, 2500], [2480, 3508]]) {
      const policy = api.outputPolicy({ width: size[0], height: size[1] }, null, { dpi });
      const scale = Math.min(1, policy.targetLongEdge / Math.max(size[0], size[1]));
      const actualWidth = Math.max(1, Math.round(size[0] * scale));
      const actualHeight = Math.max(1, Math.round(size[1] * scale));
      const pageWidth = size[0] >= size[1] ? 420 : 297;
      const pageHeight = size[0] >= size[1] ? 297 : 420;
      const placement = Math.min(pageWidth / size[0], pageHeight / size[1]);
      assert(actualWidth <= Math.floor(size[0] * placement / 25.4 * dpi) &&
        actualHeight <= Math.floor(size[1] * placement / 25.4 * dpi),
      'Rounded actual output stays inside the ' + dpi + ' dpi ceiling; its stored JPEG needs no second resample.');
    }
  }
}

function testLightingClassification() {
  const api = environment().api;
  const width = 200, height = 150;
  const regular = rgba(width, height, (x, y) => y % 20 < 2 && x % 7 < 4 ? [25, 25, 25] : [220, 220, 220]);
  const regularProfile = api.lightingProfileFromPixels(regular, width, height);
  assert.strictEqual(regularProfile.needsCorrection, false, 'Even bright paper with dark text bypasses full-page correction.');
  assert.strictEqual(api.lightingProfileFromPixels(rgba(width, height, [225, 202, 205]), width, height).needsCorrection, false,
    'An evenly lit pink certificate is not unnecessarily whitened.');
  assert(api.lightingProfileFromPixels(rgba(width, height, [100, 100, 100]), width, height).needsCorrection,
    'An underexposed page remains eligible for correction.');
  const shadow = api.lightingProfileFromPixels(rgba(width, height, x => x < width / 2 ? [150, 150, 150] : [230, 230, 230]), width, height);
  assert(shadow.needsCorrection && shadow.unevenness >= 70, 'A large shadow is detected without a full-size pixel pass.');
  assert.strictEqual(api.lightingProfileFromPixels(null, width, height).assessment, 'unavailable');
  const lut = api.gainLookup(200);
  assert.strictEqual(lut.length, 256);
  for (let value = 0; value < 256; value++) {
    assert(Math.abs(lut[value] - Math.max(0.78, Math.min(1.28, Math.pow(200 / Math.max(32, value), 0.65)))) < 0.000001);
  }
}

function testBoundedLightingAndInk() {
  const env = environment(), cv = cvMock();
  const bright = env.canvas(1200, 850, rgba(1200, 850, [220, 220, 220]));
  const skipped = env.api.correctLighting(bright, cv);
  assert.strictEqual(skipped.applied, false);
  assert.strictEqual(cv.calls.length, 0, 'Even lighting avoids all OpenCV matrices and full-page reads.');
  assert.strictEqual(bright.reads.length, 0);
  assert(env.canvases.slice(1).every(canvas => canvas.width === 0 && canvas.height === 0), 'The lighting probe is promptly released.');

  const width = 800, height = 610;
  const pixels = rgba(width, height, (x, y) => x < 15 && y < 15 ? [160, 20, 20] : [100, 100, 100]);
  const dark = env.canvas(width, height, pixels);
  const applied = env.api.correctLighting(dark, cv);
  assert(applied.applied, 'A dark document is corrected.');
  assert(dark.reads.length === 3 && dark.reads.every(read => read.height <= 256), 'Full-page RGBA copies are replaced by bounded strips.');
  assert.strictEqual(dark.image[0], 160);
  assert.strictEqual(dark.image[1], 20, 'Saturated stamp colors remain unchanged.');
  const neutral = (100 * width + 100) * 4;
  assert(dark.image[neutral] > 100 && dark.image[neutral] <= 128, 'Neutral paper brightens conservatively.');
  assert(cv.mats.every(mat => mat.deleted), 'Every OpenCV matrix is released.');
  assert(env.canvases.filter(canvas => canvas !== bright && canvas !== dark).every(canvas => canvas.width === 0 && canvas.height === 0));
}

function testWarpMemoryAndCleanup() {
  const env = environment(), cv = cvMock();
  const sourceImage = env.canvas(8000, 6000);
  const corners = [{ x: 2200, y: 1700 }, { x: 6200, y: 1800 }, { x: 6000, y: 4400 }, { x: 2000, y: 4200 }];
  const target = env.api.warpPerspective(sourceImage, corners, { width: 1000, height: 700 }, cv);
  assert.deepStrictEqual([target.width, target.height], [1000, 700]);
  const input = cv.calls.filter(call => call[0] === 'input')[0];
  assert(input[1] * input[2] < 1200000, 'Only the cropped, oversampled image enters OpenCV, instead of the 48 MP source.');
  assert(cv.mats.every(mat => mat.deleted));
  const scratch = env.canvases.filter(canvas => canvas !== sourceImage && canvas !== target);
  assert(scratch.every(canvas => canvas.width === 0 && canvas.height === 0));
  const points = cv.calls.filter(call => call[0] === 'points')[0][1];
  assert(points[0] < 100 && points[1] < 5, 'Corners are translated/scaled consistently with the cropped input.');

  const failEnv = environment(), failCv = cvMock();
  failCv.failWarp = true;
  const failedSource = failEnv.canvas(8000, 6000);
  assert.throws(() => failEnv.api.warpPerspective(failedSource, corners, { width: 1000, height: 700 }, failCv), /synthetic warp failure/);
  assert(failCv.mats.every(mat => mat.deleted));
  assert(failEnv.canvases.filter(canvas => canvas !== failedSource).every(canvas => canvas.width === 0 && canvas.height === 0),
    'Failed warps release the destination and temporary canvas as well.');
}

async function testPreviewWorker() {
  const replies = [], calls = [], canvases = [], bitmaps = [];
  class OffscreenCanvas {
    constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
    getContext() { return { drawImage() {} }; }
    transferToImageBitmap() { return { width: this.width, height: this.height }; }
  }
  const self = { cv: { Mat() {}, findContours() {} }, postMessage(data) { replies.push(data); } };
  const context = vm.createContext({ self, OffscreenCanvas, importScripts() {},
    capture(kind, options) { calls.push({ kind, options }); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets/document-scan-worker.js'), 'utf8'), context);
  vm.runInContext('detectDocumentWithOpenCv = function(source, unused, options) { capture("preview", options); if (options.fail) throw new Error("preview failed"); return {x:10,y:20,width:300,height:200,detected:true,method:"opencv"}; };' +
    'detectDocumentByColorFallback = function(source) { capture("fallback", {}); return {x:0,y:0,width:source.width,height:source.height,detected:false}; };' +
    'prepareScan = function(source, options) { capture("scan", options); return {canvas:source,detected:true,method:"opencv",dpi:400,effectiveDpi:300,quality:{detailAssessment:"unverified"}}; };', context);
  function send(id, options) {
    const bitmap = { width: 480, height: 320, closed: 0, close() { this.closed++; } };
    bitmaps.push(bitmap);
    self.onmessage({ data: Object.assign({ id, sessionId: 'preview-session', bitmap, options: {} }, options) });
  }
  send(1, { action: 'PREVIEW', mode: 'opencv' });
  send(2, { action: 'PREVIEW', mode: 'fallback' });
  send(3, { action: 'PREVIEW', mode: 'opencv', options: { fail: true } });
  send(4, { mode: 'opencv' });
  await vm.runInContext('scanQueue', context);
  assert.strictEqual(replies.length, 4, 'A preview failure cannot interrupt later captures.');
  assert.strictEqual(replies[0].bounds.width, 300);
  assert.strictEqual(replies[0].bitmap, undefined, 'Preview returns geometry only, without allocating a corrected output.');
  assert.strictEqual(replies[0].sessionId, 'preview-session');
  assert.strictEqual(calls[0].options.fast, true);
  assert.strictEqual(calls[0].options.maxDimension, 480);
  assert.strictEqual(calls.filter(call => call.kind === 'scan').length, 1, 'Preview never runs warp or lighting correction.');
  assert(/preview failed/.test(replies[2].error));
  assert.strictEqual(replies[3].dpi, 400);
  assert.strictEqual(replies[3].quality.detailAssessment, 'unverified');
  assert(bitmaps.every(bitmap => bitmap.closed === 1), 'Every preview/capture input bitmap closes exactly once.');
  assert(canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'Every Worker scratch canvas is released after replying.');
}

async function testDirectBitmapWorker() {
  const replies = [], canvases = [], observations = [];
  class ImageBitmap {
    constructor(width, height) { this.width = width; this.height = height; this.closed = 0; }
    close() { this.closed++; }
  }
  class OffscreenCanvas {
    constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
    getContext() { return { drawImage() {} }; }
    transferToImageBitmap() { return new ImageBitmap(this.width, this.height); }
  }
  const self = { cv: { Mat() {}, findContours() {} }, postMessage(data) { replies.push(data); },
    ScanQuality: { warpPerspective(input, corners, output) { observations.push({ input, output }); return output; } } };
  const context = vm.createContext({ self, ImageBitmap, OffscreenCanvas, importScripts() {},
    observe(input) { observations.push(input); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets/document-scan-worker.js'), 'utf8'), context);
  vm.runInContext('prepareScan = function(source) { observe(source); return {canvas:new OffscreenCanvas(2000,1400),detected:true,method:"opencv",dpi:400}; };', context);
  const bitmap = new ImageBitmap(8000, 6000);
  self.onmessage({ data: { id: 1, sessionId: 'large-source', bitmap, mode: 'all' } });
  await vm.runInContext('scanQueue', context);
  assert.strictEqual(observations[0], bitmap, 'A large transferred ImageBitmap is processed directly.');
  assert.strictEqual(canvases.length, 1, 'There is no full native OffscreenCanvas copy before processing.');
  assert.strictEqual(bitmap.closed, 1, 'The direct bitmap closes after processing finishes.');
  assert.strictEqual(replies[0].bitmap.width, 2000);
  assert(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  context.bitmapSource = new ImageBitmap(8000, 6000);
  const result = vm.runInContext('extractDocumentWithJscanify(bitmapSource, [{x:100,y:100},{x:6100,y:100},{x:6100,y:4100},{x:100,y:4100}], 3000)', context);
  assert.strictEqual(result.width, 3000);
  assert.strictEqual(result.height, 2000, 'jscanify-selected corners use the bounded warp for direct ImageBitmap input.');
  assert.strictEqual(observations[1].input, context.bitmapSource);
}

(async () => {
  testDpiPolicy();
  testLightingClassification();
  testBoundedLightingAndInk();
  testWarpMemoryAndCleanup();
  await testPreviewWorker();
  await testDirectBitmapWorker();
  console.log('Scan quality: DPI policy, lighting skip/LUT/strips, color/cleanup, bounded warps, direct bitmaps and lightweight Worker preview passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
