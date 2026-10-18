// Run with node tests/camera-lifecycle.test.js. Deferred camera permissions use mocks, never hardware.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const files = ['TraCu.html', 'LongHiep.html', 'TapSon.html', 'LuuNghiepAnh.html', 'DaiAn.html', 'HamGiang.html'];

function code(name, source) {
  const start = source.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert(start >= 0, name);
  const end = source.slice(start + 1).search(/\n    (?:async )?function /);
  return source.slice(start, end < 0 ? source.length : start + 1 + end);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stream(label) {
  const track = { label: label || 'color', stopped: 0, stop() { this.stopped++; },
    getSettings() { return { deviceId: label || 'color' }; } };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function harness(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const settings = source.match(/<details class="api-settings mt-8" id="cameraSettings">([\s\S]*?)<\/details>/);
  assert(settings, file + ': camera settings must be collapsible');
  assert(!/<details[^>]*\sopen(?:\s|>)/.test(settings[0]), file + ': camera settings should be collapsed initially');
  ['cameraSelect', 'scanMode', 'qualityDpi', 'captureProfile'].forEach(function (id) {
    assert(settings[1].includes('id="' + id + '"'), file + ': collapsed settings missing ' + id);
  });
  const nodes = {}, events = {}, requests = [], alerts = [], statuses = [], captured = [], canvases = [], timers = new Map();
  let nextTimer = 0;
  const configuration = { play: null, cameras: [], decoded: null, failScan: false, keepSource: false, fallbackCalls: 0 };
  const state = { stream: null, saving: false, processing: false, cameraOpenGeneration: 0,
    cameraWanted: false, detectionFrame: 0, cameraIdleTimer: 0, pendingRetakeId: null,
    documentPages: [], cccdPhotos: [], qualityDpi: 400, captureProfile: 'fast' };
  function node(id) {
    if (!nodes[id]) nodes[id] = { value: '', disabled: true, style: {}, textContent: '', innerHTML: '',
      classList: { add() {}, remove() {} }, play() { return configuration.play || Promise.resolve(); }, pause() {},
      videoWidth: 1920, videoHeight: 1080, readyState: 2 };
    return nodes[id];
  }
  const document = { hidden: false, getElementById: node, querySelector: () => node('overlay'),
    addEventListener(name, callback) { events[name] = callback; }, createElement() {
      const canvas = { width: 1, height: 1, getContext: () => ({ drawImage() {} }) };
      canvases.push(canvas); return canvas;
    } };
  const window = { ScanRuntime: {
    choosePhotoSettings() { return {}; },
    releaseCanvas(value) { if (value && value.close) value.close(); else if (value) { value.width = 0; value.height = 0; } },
    disposeItem(item) { if (item.originalCanvas) this.releaseCanvas(item.originalCanvas); this.releaseCanvas(item.canvas); },
    async storeOriginal(item, sourceImage, blob) {
      if (configuration.keepSource) item.originalCanvas = sourceImage;
      item.originalBlob = blob;
      return item;
    }
  }, DocumentPdfExporter: { clearCache() {} } };
  const context = vm.createContext({ document, window, state, console, scanGeneration: 0, identityGeneration: 0,
    navigator: { mediaDevices: { getUserMedia(options) { const next = deferred(); requests.push({ options, next }); return next.promise; } } },
    clearTimeout(id) { timers.delete(id); }, setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, alert(message) { alerts.push(message); },
    setStatus(message, tone) { statuses.push({ message, tone }); },
    identityQueue: Promise.resolve(), performance: { now: () => 1 },
    getApiUrl: () => 'https://example.invalid/mock-api',
    buildPdfFileName: () => 'mock-gcn.pdf', buildCccdPdfFileName: () => 'mock-cccd.pdf', buildOriginalBackupFileName: () => 'mock-original.pdf',
    refreshCameras: async () => configuration.cameras,
    armCameraIdle() {}, scanCameraPreview() {}, closeScanReview() {}, renderRecordFiles() {},
    appendSavePerformanceLog() {},
    waitForCameraFrame: async () => {},
    raiseFallbackCaptureResolution: async () => { configuration.fallbackCalls++; },
    decodeImageFile: async () => {
      if (configuration.decoded instanceof Error) throw configuration.decoded;
      return configuration.decoded && configuration.decoded.promise || configuration.decoded;
    },
    prepareScanAsync: async sourceImage => {
      captured.push(sourceImage);
      if (configuration.failScan) throw new Error('synthetic scan failure');
      return { canvas: { width: 3000, height: 2200 }, detected: true, method: 'opencv', dpi: 400 };
    },
    createScanId: () => 'mock-scan', addScanItem: item => state.documentPages.push(item), replaceScanItem() {}, autoReadCccdNumber() {}
  });
  vm.runInContext(['startCamera', 'createCameraConstraints', 'stopCamera', 'playCameraVideo', 'cameraPromise', 'raiseFallbackCaptureResolution', 'isLikelyMonochromeCamera', 'capturePage', 'saveCurrentRecord', 'clearForm']
    .map(name => code(name, source)).join('\n'), context);
  const visibilityStart = source.indexOf("    document.addEventListener('visibilitychange'");
  assert(visibilityStart >= 0);
  const visibilityEnd = source.indexOf('\n    });', visibilityStart);
  vm.runInContext(source.slice(visibilityStart, visibilityEnd + '\n    });'.length), context);
  return { context, document, state, nodes, node, requests, alerts, statuses, captured, canvases, configuration, timers,
    async flush() { for (let index = 0; index < 24; index++) await Promise.resolve(); },
    hide() { document.hidden = true; events.visibilitychange(); },
    enablePhoto(bitmap) {
      configuration.decoded = bitmap;
      const photoBlob = { size: 4000000, type: 'image/jpeg' };
      function ImageCapture() { this.getPhotoCapabilities = async () => ({}); this.takePhoto = async () => photoBlob; }
      window.ImageCapture = ImageCapture; context.ImageCapture = ImageCapture;
      return photoBlob;
    }
  };
}

async function testPendingPermissions(file) {
  const stopped = harness(file);
  const start = stopped.context.startCamera();
  assert.strictEqual(stopped.requests.length, 1);
  stopped.context.stopCamera();
  const old = stream();
  stopped.requests[0].next.resolve(old);
  await start;
  assert(old.track.stopped >= 1, file + ': a late permission result releases its stream after Stop.');
  assert.strictEqual(stopped.state.stream, null);
  assert.strictEqual(stopped.node('video').srcObject, null);
  assert.strictEqual(stopped.node('btnCapturePage').disabled, true);
  assert.strictEqual(stopped.alerts.length, 0);

  const hidden = harness(file);
  const opening = hidden.context.startCamera();
  hidden.hide();
  const hiddenStream = stream();
  hidden.requests[0].next.resolve(hiddenStream);
  await opening;
  assert(hiddenStream.track.stopped >= 1, file + ': permission resolving in a hidden tab cannot restart the camera.');
  assert.strictEqual(hidden.state.stream, null);

  const reset = harness(file);
  const beforeReset = reset.context.startCamera();
  reset.context.clearForm();
  const resetStream = stream();
  reset.requests[0].next.resolve(resetStream);
  await beforeReset;
  assert(resetStream.track.stopped >= 1, file + ': clearing the form cancels an outstanding permission request.');
  assert.strictEqual(reset.state.stream, null);
}

async function testNewRequestOwnership(file) {
  const env = harness(file);
  const first = env.context.startCamera();
  env.context.stopCamera();
  const second = env.context.startCamera();
  const current = stream('current');
  env.requests[1].next.resolve(current);
  await second;
  assert.strictEqual(env.state.stream, current);
  const previous = stream('previous');
  env.requests[0].next.resolve(previous);
  await first;
  assert(previous.track.stopped >= 1);
  assert.strictEqual(current.track.stopped, 0, file + ': the canceled request must never stop a newer camera stream.');
  assert.strictEqual(env.state.stream, current);
  assert.strictEqual(env.node('video').srcObject, current);
  assert.strictEqual(env.node('btnCapturePage').disabled, false);
  assert.strictEqual(env.requests[1].options.video.frameRate.max, 15);
  assert.strictEqual(env.requests[1].options.video.width.ideal, 1920, 'Unsupported ImageCapture uses a sharper fallback preview.');
}

async function testCancelDuringPlayAndColorFallback(file) {
  const playing = harness(file), playback = deferred();
  playing.configuration.play = playback.promise;
  const opening = playing.context.startCamera();
  const current = stream();
  playing.requests[0].next.resolve(current);
  await playing.flush();
  assert.strictEqual(playing.state.stream, current);
  playing.hide();
  playback.resolve();
  await opening;
  assert(current.track.stopped >= 1);
  assert.strictEqual(playing.state.stream, null);

  const fallback = harness(file);
  fallback.configuration.cameras = [{ deviceId: 'mono', label: 'mono' }, { deviceId: 'color', label: 'color' }];
  const starting = fallback.context.startCamera();
  fallback.requests[0].next.resolve(stream('mono'));
  await fallback.flush();
  assert.strictEqual(fallback.requests.length, 2, 'A monochrome camera requests the available color camera.');
  fallback.context.stopCamera();
  const delayedColor = stream('color');
  fallback.requests[1].next.resolve(delayedColor);
  await starting;
  assert(delayedColor.track.stopped >= 1, file + ': cancellation also owns a delayed color-camera replacement.');
  assert.strictEqual(fallback.state.stream, null);

  const timeout = harness(file), neverPlays = deferred();
  timeout.configuration.play = neverPlays.promise;
  const awaitingPlay = timeout.context.startCamera();
  const timeoutStream = stream();
  timeout.requests[0].next.resolve(timeoutStream);
  await timeout.flush();
  const playbackTimer = Array.from(timeout.timers.values()).filter(timer => timer.delay === 5000)[0];
  assert(playbackTimer, 'A non-emitting camera stream has a playback timeout.');
  playbackTimer.callback();
  await awaitingPlay;
  assert(timeoutStream.track.stopped >= 1, file + ': a playback timeout releases the stream rather than leaving the camera running.');
  assert.strictEqual(timeout.state.stream, null);
  assert.strictEqual(timeout.node('btnStartCamera').disabled, false);
  assert(timeout.alerts.some(message => /chưa phát được hình/.test(message)));
}

async function testCaptureTimeoutAndFallbackResolution(file) {
  const env = harness(file), pending = deferred();
  const timeoutResult = env.context.cameraPromise(pending.promise, 12000, 'timeout kiểm thử').then(() => '', error => error.message);
  const timeout = Array.from(env.timers.values()).find(timer => timer.delay === 12000);
  assert(timeout, file + ': takePhoto/getPhotoCapabilities can be bounded by a timeout.');
  timeout.callback();
  assert.strictEqual(await timeoutResult, 'timeout kiểm thử');

  const video = { videoWidth: 1920, videoHeight: 1080 };
  const track = { getCapabilities: () => ({ width: { max: 3840 }, height: { max: 2160 } }),
    getSettings: () => ({ width: video.videoWidth, height: video.videoHeight }),
    applyConstraints: async constraints => {
      assert.strictEqual(constraints.width.ideal, 3840);
      assert.strictEqual(constraints.height.ideal, 2160);
      video.videoWidth = 3840; video.videoHeight = 2160;
    } };
  const result = await env.context.raiseFallbackCaptureResolution(track, video);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { width: 3840, height: 2160 },
    file + ': fallback reports actual dimensions after the track changes.');
}

function bitmap() { return { width: 8000, height: 6000, closed: 0, close() { this.closed++; } }; }

async function testCaptureErrorsAndOwnership(file) {
  const failed = harness(file), image = bitmap();
  failed.state.stream = stream();
  failed.enablePhoto(image);
  failed.configuration.failScan = true;
  await failed.context.capturePage('document');
  assert.strictEqual(failed.captured[0], image, file + ': the still bitmap is processed directly without a full native canvas.');
  assert.strictEqual(image.closed, 1, file + ': scan errors still release the captured bitmap.');
  assert.strictEqual(failed.canvases.length, 0);
  assert.strictEqual(failed.state.processing, false);
  assert.strictEqual(failed.state.stream, null);

  const decoder = harness(file);
  decoder.state.stream = stream();
  decoder.enablePhoto(new Error('synthetic decode failure'));
  await decoder.context.capturePage('document');
  assert.strictEqual(decoder.configuration.fallbackCalls, 0, 'A failed still-image decode never substitutes an ended low-resolution video stream.');
  assert.strictEqual(decoder.captured.length, 0);
  assert(decoder.alerts.some(message => /camera hệ thống/.test(message)));

  const retained = harness(file), original = bitmap();
  retained.state.stream = stream();
  retained.enablePhoto(original);
  retained.configuration.keepSource = true;
  await retained.context.capturePage('document');
  assert.strictEqual(retained.state.documentPages[0].originalCanvas, original);
  assert.strictEqual(original.closed, 0, 'An original retained for encoder compatibility remains usable after capture.');
  retained.context.clearForm();
  assert.strictEqual(original.closed, 1, 'Reset releases that retained original.');

  const reset = harness(file), decode = deferred(), late = bitmap();
  reset.state.stream = stream();
  reset.enablePhoto(decode);
  const pending = reset.context.capturePage('document');
  await reset.flush();
  reset.context.clearForm();
  decode.resolve(late);
  await pending;
  assert.strictEqual(late.closed, 1, 'A bitmap decoded after form reset is closed before any processing.');
  assert.strictEqual(reset.captured.length, 0);
}

async function testSaveCancelsPendingPermission(file) {
  const env = harness(file), apiCalls = [];
  env.state.documentPages.push({ id: 'already-saved-image', canvas: { width: 3000, height: 2200 } });
  env.context.makeSaveAttempt = payload => ({ id: 'metadata-save', payload, groups: {}, plannedKeys: {},
    acknowledged: {}, complete: false, uncertain: false, retrySupported: true });
  env.context.apiRequest = async (action, payload) => {
    apiCalls.push({ action, payload });
    return { success: true, rowIndex: 2, pdfUploadComplete: true };
  };
  env.context.applySaveResult = (attempt, result) => { attempt.complete = true; env.state.selectedRowIndex = result.rowIndex; };
  const opening = env.context.startCamera();
  assert.strictEqual(env.requests.length, 1, 'The camera permission is pending before saving.');
  assert.strictEqual(env.state.stream, null);
  await env.context.saveCurrentRecord();
  assert.strictEqual(apiCalls.length, 1, file + ': a fast metadata save completes while camera permission is still pending.');
  assert.strictEqual(apiCalls[0].action, 'SAVE_SCAN');
  assert.strictEqual(env.state.saving, false, 'Saving has already finished before the camera permission resolves.');
  assert.strictEqual(env.state.selectedRowIndex, 2);
  const late = stream('permission-after-save');
  env.requests[0].next.resolve(late);
  await opening;
  assert(late.track.stopped >= 1, file + ': saving invalidates the pending open token even after state.saving becomes false.');
  assert.strictEqual(env.state.stream, null, file + ': finishing a save never revives a pending camera stream.');
  assert.strictEqual(env.node('video').srcObject, null);
  assert.strictEqual(env.alerts.length, 0);
}

(async () => {
  for (const file of files) {
    await testPendingPermissions(file);
    await testNewRequestOwnership(file);
    await testCancelDuringPlayAndColorFallback(file);
    await testCaptureTimeoutAndFallbackResolution(file);
    await testCaptureErrorsAndOwnership(file);
    await testSaveCancelsPendingPermission(file);
  }
  console.log('Camera lifecycle: all six pages cancel permission/play/color races, preserve newer streams and release capture bitmaps.');
})().catch(error => { console.error(error); process.exitCode = 1; });
