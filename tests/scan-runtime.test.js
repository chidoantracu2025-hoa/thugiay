// Run with node tests/scan-runtime.test.js. Resource ownership and caches use synthetic objects only.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'assets/scan-runtime.js'), 'utf8');

function environment() {
  const canvases = [], encodes = [], bitmaps = [], created = [], revoked = [], cacheClears = [], bitmapCalls = [];
  const configuration = { failEncode: -1, nullContext: false, failBitmapOptions: false, failBitmap: false, encodeSizes: [] };
  function canvas(width, height) {
    const value = { width: width || 1, height: height || 1, draws: [] };
    const context = { drawImage() { value.draws.push(Array.prototype.slice.call(arguments)); },
      save() { value.saved = (value.saved || 0) + 1; }, restore() { value.restored = (value.restored || 0) + 1; },
      fillRect() { value.whiteFill = { operation: context.globalCompositeOperation, fillStyle: context.fillStyle }; } };
    value.getContext = () => configuration.nullContext ? null : context;
    value.toBlob = (callback, type, quality) => {
      const index = encodes.length;
      encodes.push({ canvas: value, width: value.width, height: value.height, type, quality });
      callback(index === configuration.failEncode ? null : { type,
        size: configuration.encodeSizes[index] === undefined ? 1000 + index : configuration.encodeSizes[index], width: value.width, height: value.height });
    };
    canvases.push(value);
    return value;
  }
  const window = {
    document: { createElement: () => canvas(1, 1) },
    URL: {
      createObjectURL(blob) { const url = 'blob:runtime-test/' + (created.length + 1); created.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    createImageBitmap(blob, options) {
      bitmapCalls.push({ blob, options });
      if (configuration.failBitmap || configuration.failBitmapOptions && options) return Promise.reject(new Error('decode failed'));
      const bitmap = { width: blob.width || 4032, height: blob.height || 3024, closed: 0, close() { this.closed++; } };
      bitmaps.push(bitmap);
      return Promise.resolve(bitmap);
    },
    DocumentPdfExporter: { clearCache(item) { cacheClears.push(item); } }
  };
  vm.runInNewContext(runtimeSource, { window });
  return { api: window.ScanRuntime, window, canvas, canvases, encodes, bitmaps, bitmapCalls,
    created, revoked, cacheClears, configuration };
}

async function expectFailure(operation, pattern) {
  let failure = null;
  try { await operation(); } catch (error) { failure = error; }
  assert(failure && pattern.test(failure.message), 'Expected a failure matching ' + pattern);
}

async function testOriginalStorageAndDisposal() {
  const env = environment();
  const original = env.canvas(8000, 6000), processed = env.canvas(6614, 4677);
  const cameraBlob = { type: 'image/jpeg', size: 8000000, width: 8000, height: 6000 };
  const item = { canvas: processed };
  const result = await env.api.storeOriginal(item, original, cameraBlob);
  assert.strictEqual(result, item);
  assert.strictEqual(item.originalBlob, cameraBlob, 'Actual camera/upload bytes are retained without a second JPEG encode.');
  assert.strictEqual(item.originalCanvas, undefined, 'Compressed originals do not retain a full native RGBA canvas.');
  assert.strictEqual(item.originalWidth, 8000);
  assert.strictEqual(item.originalHeight, 6000);
  assert.strictEqual(item.revision, 1);
  assert.strictEqual(env.encodes.length, 2, 'Only the two display previews are encoded.');
  assert(env.encodes.every(encode => encode.type === 'image/jpeg' && encode.quality === .88));
  assert(env.encodes.every(encode => Math.max(encode.width, encode.height) <= 1000));
  assert(env.encodes.every(encode => encode.canvas.width === 0 && encode.canvas.height === 0), 'Preview canvases are promptly released.');
  assert.strictEqual(original.width, 8000, 'The caller retains ownership of the capture source until it chooses to release it.');
  assert.strictEqual(env.created.length, 2);
  const urls = [item.originalPreviewUrl, item.processedPreviewUrl];
  env.api.disposeItem(item);
  assert.deepStrictEqual(env.revoked, urls);
  assert.strictEqual(processed.width, 0);
  assert.strictEqual(processed.height, 0);
  assert.strictEqual(item.originalBlob, null);
  assert.strictEqual(env.cacheClears[0], item, 'Deleting an image invalidates its exporter cache.');
  assert.strictEqual(original.width, 8000, 'Disposing an item does not destroy an unowned capture canvas.');

  const frameEnv = environment();
  const frame = frameEnv.canvas(1920, 1080), frameItem = { canvas: frameEnv.canvas(1600, 1100) };
  await frameEnv.api.storeOriginal(frameItem, frame);
  assert.strictEqual(frameEnv.encodes[0].canvas, frame);
  assert.strictEqual(frameEnv.encodes[0].quality, .98, 'Video-frame fallback encodes its original once at high quality.');
  assert.strictEqual(frameEnv.encodes.length, 3);
}

async function testStorageFailureKeepsOriginal() {
  const env = environment();
  const original = env.canvas(4032, 3024), item = { canvas: env.canvas(3600, 2500) };
  env.configuration.failEncode = 1;
  const originalBlob = { type: 'image/jpeg', size: 4000000 };
  await env.api.storeOriginal(item, original, originalBlob);
  assert.strictEqual(item.originalBlob, originalBlob);
  assert.strictEqual(item.originalCanvas, original, 'An encoder failure preserves a usable original rather than losing the image.');
  assert(/bộ nhớ/.test(item.storageWarning));
  assert.strictEqual(env.created.length, 1);
  assert.deepStrictEqual(env.revoked, [env.created[0].url], 'Any completed preview URL is revoked if the later preview fails.');
  assert(env.encodes.every(encode => encode.canvas.width === 0 && encode.canvas.height === 0));
  env.api.disposeItem(item);
  assert.strictEqual(original.width, 0);
  assert.strictEqual(item.canvas.width, 0);
}

async function testDocumentProcessedBlobStorage() {
  const env = environment();
  const original = env.canvas(8000, 6000), processed = env.canvas(6614, 4677);
  const originalBlob = { type: 'image/jpeg', size: 7000000 };
  const item = { type: 'document', canvas: processed, processingQuality: { dpi: 400 } };
  await env.api.storeOriginal(item, original, originalBlob);
  assert.strictEqual(env.encodes.length, 3, 'A document encodes two small previews and its processed JPEG exactly once.');
  assert.strictEqual(env.encodes[2].canvas, processed);
  assert.strictEqual(env.encodes[2].quality, .96);
  assert.strictEqual(item.processedQuality, .96);
  assert.strictEqual(item.processedCanonical, true, 'The PDF exporter may embed these validated JPEG bytes directly.');
  assert.strictEqual(item.processedDpi, 400);
  assert.deepStrictEqual([item.processedWidth, item.processedHeight], [6614, 4677]);
  assert.deepStrictEqual(processed.whiteFill, { operation: 'destination-over', fillStyle: '#ffffff' },
    'Transparent processed pixels become white without overwriting existing text or stamp pixels.');
  assert.strictEqual(processed.saved, processed.restored);
  assert.strictEqual(item.canvas, null);
  assert.strictEqual(processed.width, 0, 'The full processed RGBA allocation is released immediately after encoding.');
  assert.strictEqual(original.width, 8000, 'The separate original remains owned by the capture caller.');
  assert.strictEqual(item.originalBlob, originalBlob);
  assert(item.originalPreviewUrl && item.processedPreviewUrl, 'Display previews remain usable after the processed canvas is released.');
  const beforeLoadCanvases = env.canvases.length;
  const loaded = await env.api.loadSource(item, false);
  assert.strictEqual(env.bitmapCalls[0].blob, item.processedBlob);
  assert.strictEqual(loaded.canvas, env.bitmaps[0], 'Review or PDF fallback can decode the compressed processed image directly.');
  assert.deepStrictEqual([loaded.canvas.width, loaded.canvas.height], [6614, 4677]);
  assert.strictEqual(env.canvases.length, beforeLoadCanvases, 'Reloading a processed JPEG creates no full-size canvas.');
  loaded.release();
  assert.strictEqual(loaded.canvas.closed, 1);
  assert.strictEqual(env.encodes.length, 3, 'Reloading does not recompress the processed image.');
  env.api.disposeItem(item);
  assert.strictEqual(item.processedBlob, null);
  assert.strictEqual(item.originalBlob, null);

  const cardEnv = environment(), cardCanvas = cardEnv.canvas(1348, 850);
  const card = { type: 'cccd-front', canvas: cardCanvas };
  await cardEnv.api.storeOriginal(card, cardEnv.canvas(4032, 3024), originalBlob);
  assert.strictEqual(card.canvas, cardCanvas, 'Small CCCD canvases remain immediately available for QR/OCR.');
  assert.strictEqual(cardEnv.encodes.length, 2);
  assert.strictEqual(card.processedBlob, undefined);
}

async function testDocumentProcessedQualityRetriesAndFailures() {
  const env = environment();
  env.configuration.encodeSizes[2] = 10500000;
  env.configuration.encodeSizes[3] = 9500000;
  const item = { type: 'document', canvas: env.canvas(4960, 3507), processingQuality: { dpi: 300 } };
  await env.api.storeOriginal(item, env.canvas(6400, 4800), { type: 'image/jpeg', size: 5000000 });
  assert.deepStrictEqual(env.encodes.slice(2).map(encode => encode.quality), [.96, .94], 'Only an oversized processed JPEG tries a lower quality.');
  assert.strictEqual(item.processedQuality, .94);
  assert.strictEqual(item.processedBlob.size, 9500000);
  assert.strictEqual(item.processedDpi, 300);
  assert.strictEqual(item.canvas, null);

  const largeEnv = environment();
  largeEnv.configuration.encodeSizes[2] = 12000000;
  largeEnv.configuration.encodeSizes[3] = 11000000;
  largeEnv.configuration.encodeSizes[4] = 10500000;
  const large = { type: 'document', canvas: largeEnv.canvas(6614, 4677) };
  await largeEnv.api.storeOriginal(large, largeEnv.canvas(8000, 6000), { type: 'image/jpeg', size: 8000000 });
  assert.deepStrictEqual(largeEnv.encodes.slice(2).map(encode => encode.quality), [.96, .94, .92]);
  assert.strictEqual(large.processedQuality, .92, 'The quality floor is never lowered further to conceal an oversized page.');
  assert.strictEqual(large.processedBlob.size, 10500000, 'An oversized page is retained for review; the final exporter will enforce its exact PDF limit.');
  assert.strictEqual(large.canvas, null);
  assert(large.originalBlob, 'The captured original is never discarded by a PDF-size problem.');

  const failed = environment(), processed = failed.canvas(6614, 4677);
  failed.configuration.failEncode = 2;
  const fallback = { type: 'document', canvas: processed };
  await failed.api.storeOriginal(fallback, failed.canvas(8000, 6000), { type: 'image/jpeg', size: 8000000 });
  assert.strictEqual(fallback.canvas, processed);
  assert.strictEqual(processed.width, 6614, 'A failed processed JPEG encode leaves its canvas usable.');
  assert.strictEqual(fallback.processedBlob, undefined);
  assert.strictEqual(fallback.processedCanonical, undefined);
  assert(/Ảnh đã xử lý/.test(fallback.storageWarning));
  assert(fallback.originalBlob);

  const previewFail = environment(), retainedOriginal = previewFail.canvas(8000, 6000);
  previewFail.configuration.failEncode = 0;
  const retained = { type: 'document', canvas: previewFail.canvas(6614, 4677) };
  await previewFail.api.storeOriginal(retained, retainedOriginal, { type: 'image/jpeg', size: 8000000 });
  assert.strictEqual(retained.originalCanvas, retainedOriginal, 'A failed preview retains the original fallback even when processed JPEG storage succeeds.');
  assert.strictEqual(retainedOriginal.width, 8000);
  assert(retained.processedBlob && retained.canvas === null);
  previewFail.api.disposeItem(retained);
  assert.strictEqual(retainedOriginal.width, 0);
}

async function testSourceOwnershipAndDecodeErrors() {
  const env = environment();
  const processed = env.canvas(3000, 2200), original = env.canvas(4032, 3024);
  const existing = { canvas: processed, originalCanvas: original };
  const normal = await env.api.loadSource(existing, false);
  const legacy = await env.api.loadSource(existing, true);
  assert.strictEqual(normal.canvas, processed);
  assert.strictEqual(legacy.canvas, original);
  assert.strictEqual(legacy.release, undefined, 'Legacy retained canvases remain owned by their item.');
  assert.strictEqual(env.bitmaps.length, 0);
  const blob = { width: 5000, height: 3500 };
  const decoded = await env.api.loadSource({ originalBlob: blob }, true);
  assert.deepStrictEqual([decoded.canvas.width, decoded.canvas.height], [5000, 3500]);
  assert.strictEqual(env.bitmapCalls[0].blob, blob);
  assert.strictEqual(env.bitmapCalls[0].options.imageOrientation, 'from-image');
  assert.strictEqual(decoded.canvas, env.bitmaps[0], 'The decoder returns a usable ImageBitmap without a full native canvas copy.');
  assert.strictEqual(env.bitmaps[0].closed, 0, 'The bitmap remains usable until its consumer releases it.');
  assert.strictEqual(env.canvases.length, 2, 'Only the pre-existing processed/legacy canvases exist.');
  decoded.release();
  assert.strictEqual(decoded.canvas.closed, 1);
  assert.strictEqual(processed.width, 3000);
  assert.strictEqual(original.width, 4032);
  await expectFailure(() => env.api.loadSource({}, true), /Thiếu ảnh gốc/);

  const fallback = environment();
  fallback.configuration.failBitmapOptions = true;
  const fallbackSource = await fallback.api.loadSource({ originalBlob: blob }, true);
  assert.strictEqual(fallback.bitmapCalls.length, 2, 'Browsers that reject orientation options get a compatible decode retry.');
  assert.strictEqual(fallback.bitmapCalls[1].options, undefined);
  assert.strictEqual(fallback.bitmaps[0].closed, 0);
  fallbackSource.release();
  assert.strictEqual(fallback.bitmaps[0].closed, 1);

  const failed = environment();
  failed.window.createImageBitmap = undefined;
  failed.window.Image = function () {
    const image = { width: 1200, height: 850 };
    Object.defineProperty(image, 'src', { set() { image.onload(); } });
    return image;
  };
  failed.configuration.nullContext = true;
  await expectFailure(() => failed.api.loadSource({ originalBlob: blob }, true), /bộ nhớ/);
  assert.strictEqual(failed.revoked[0], failed.created[0].url, 'Failed fallback allocation does not retain a decode URL.');
  assert(failed.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  const direct = environment();
  const bitmapSource = { width: 8000, height: 6000, closed: 0, close() { this.closed++; } };
  direct.api.releaseCanvas(bitmapSource);
  assert.strictEqual(bitmapSource.closed, 1, 'The generic release helper closes ImageBitmap sources as well as canvases.');
}

async function testImageFallbackAndBlobEncoding() {
  const env = environment();
  env.window.createImageBitmap = undefined;
  let nextFails = false;
  env.window.Image = function () {
    const image = { width: 1200, height: 850 };
    Object.defineProperty(image, 'src', { set() { if (nextFails) image.onerror(); else image.onload(); } });
    return image;
  };
  const image = await env.api.decodeBlob({ size: 10 });
  assert.strictEqual(image.width, 1200);
  assert.strictEqual(env.revoked[0], env.created[0].url, 'Image-element fallback revokes its decode URL after success.');
  nextFails = true;
  await expectFailure(() => env.api.decodeBlob({ size: 10 }), /Không đọc được ảnh gốc/);
  assert.strictEqual(env.revoked[1], env.created[1].url, 'Image-element fallback revokes its URL after failure.');

  let settings;
  const blob = { size: 1234, type: 'image/jpeg' };
  const converted = await env.api.canvasBlob({ convertToBlob(options) { settings = options; return Promise.resolve(blob); } }, .96);
  assert.strictEqual(converted, blob);
  assert.strictEqual(settings.type, 'image/jpeg');
  assert.strictEqual(settings.quality, .96);
  await expectFailure(() => env.api.canvasBlob({}), /chưa hỗ trợ/);
  const noBlob = env.canvas(10, 10);
  env.configuration.failEncode = env.encodes.length;
  await expectFailure(() => env.api.canvasBlob(noBlob), /Không đủ bộ nhớ/);
}

function testPhotoSettings() {
  const api = environment().api;
  assert.strictEqual(Object.keys(api.choosePhotoSettings({}, 'document')).length, 0);
  const sensor = { imageWidth: { min: 640, max: 12000, step: 8 }, imageHeight: { min: 480, max: 9000, step: 8 } };
  for (const type of ['document', 'cccd-front', 'cccd-back']) {
    const settings = api.choosePhotoSettings(sensor, type);
    const limit = type === 'document' ? 42000000 : 8000000;
    const edge = type === 'document' ? 8000 : 3600;
    assert(settings.imageWidth * settings.imageHeight <= limit);
    assert(Math.max(settings.imageWidth, settings.imageHeight) <= edge);
    assert.strictEqual((settings.imageWidth - 640) % 8, 0);
    assert.strictEqual((settings.imageHeight - 480) % 8, 0);
    assert(settings.imageWidth >= 640 && settings.imageHeight >= 480, 'Capture settings respect hardware minima.');
  }
  const economy = api.choosePhotoSettings(sensor, 'document', 300);
  assert(economy.imageWidth * economy.imageHeight <= 26000000);
  assert(Math.max(economy.imageWidth, economy.imageHeight) <= 6400, 'Explicit 300 dpi uses a smaller still-photo sensor mode where supported.');
  const small = api.choosePhotoSettings({ imageWidth: { max: 4032 }, imageHeight: { max: 3024 } }, 'document');
  assert.deepStrictEqual([small.imageWidth, small.imageHeight], [4032, 3024], 'A smaller camera is never enlarged to an unavailable sensor mode.');
  const fixed = api.choosePhotoSettings({ imageWidth: { min: 8000, max: 8000 }, imageHeight: { min: 6000, max: 6000 } }, 'document');
  assert.deepStrictEqual([fixed.imageWidth, fixed.imageHeight], [8000, 6000], 'A fixed-size sensor must return a supported mode; later processing applies the DPI cap.');
}

async function testPdfCache() {
  const api = environment().api, state = {}, first = { canvas: {} }, second = { canvas: {} };
  let generations = 0;
  function producer(byteLength) {
    return async () => { generations++; return [{ byteLength, marker: generations }]; };
  }
  const initial = await api.cachedPdf(state, [first], false, producer(5000000));
  const hit = await api.cachedPdf(state, [first], false, producer(5000000));
  assert.strictEqual(hit, initial);
  assert.strictEqual(generations, 1, 'Unchanged PDFs are reused without another export.');
  first.revision = 2;
  const revised = await api.cachedPdf(state, [first], false, producer(5000000));
  assert.notStrictEqual(revised, initial, 'A revision invalidates cached bytes.');
  first.canvas = {};
  const replaced = await api.cachedPdf(state, [first], false, producer(5000000));
  assert.notStrictEqual(replaced, revised, 'Replacing the source canvas invalidates the cache.');
  const originals = await api.cachedPdf(state, [first], true, producer(5000000));
  assert.notStrictEqual(originals, replaced, 'Original and processed PDFs have independent cache keys.');
  first.originalBlob = {};
  const changedOriginal = await api.cachedPdf(state, [first], true, producer(5000000));
  assert.notStrictEqual(changedOriginal, originals, 'Replacing an original Blob invalidates its PDF cache.');
  await api.cachedPdf(state, [first, second], false, producer(5000000));
  const reordered = await api.cachedPdf(state, [second, first], false, producer(5000000));
  assert(reordered && generations === 7, 'Page membership and order are part of the cache key.');
  const priorCount = generations;
  first.processingQuality = { dpi: 300 };
  const lowerDpi = await api.cachedPdf(state, [second, first], false, producer(5000000));
  assert.notStrictEqual(lowerDpi, reordered, 'Changing a stored processing DPI invalidates previously exported bytes.');
  assert.strictEqual(generations, priorCount + 1);
  first.processedBlob = {};
  const blobSource = await api.cachedPdf(state, [second, first], false, producer(5000000));
  assert.notStrictEqual(blobSource, lowerDpi, 'A processed Blob is part of the cache source identity.');
  first.type = 'document';
  const changedType = await api.cachedPdf(state, [second, first], false, producer(5000000));
  assert.notStrictEqual(changedType, blobSource, 'Changing the physical document type invalidates cached PDF placement.');
  assert(state.pdfCache.reduce((sum, entry) => sum + entry.byteLength, 0) <= 24000000, 'The retained PDF bytes obey their memory bound.');

  const largeState = {};
  await api.cachedPdf(largeState, [first], false, producer(25000000));
  assert.strictEqual(largeState.pdfCache.length, 0, 'An oversized result is returned without retaining it in RAM.');
  let failed = false;
  await expectFailure(() => api.cachedPdf(largeState, [first], false, async () => { failed = true; throw new Error('export failed'); }), /export failed/);
  assert(failed && largeState.pdfCache.length === 0, 'Failed exports never populate the cache.');
}

(async () => {
  await testOriginalStorageAndDisposal();
  await testStorageFailureKeepsOriginal();
  await testDocumentProcessedBlobStorage();
  await testDocumentProcessedQualityRetriesAndFailures();
  await testSourceOwnershipAndDecodeErrors();
  await testImageFallbackAndBlobEncoding();
  testPhotoSettings();
  await testPdfCache();
  console.log('Scan runtime: Blob preservation, preview/source ownership, error cleanup, bounded PDF cache and photo settings passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
