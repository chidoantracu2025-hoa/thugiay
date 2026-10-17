// Run with node tests/scan-session.test.js. Uses no browser or personal data.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');

function bitmap() {
  return { width: 100, height: 200, closed: 0, close() { this.closed++; } };
}

function clientEnvironment() {
  const workers = [];
  const timers = new Map();
  let nextTimer = 0;
  class Worker {
    constructor(url) { this.url = url; this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(data, transfer) {
      if (this.failPost) throw new Error('Transfer failed');
      this.messages.push({ data, transfer });
    }
    terminate() { this.terminated = true; }
    reply(data) { this.onmessage({ data }); }
  }
  const window = { Worker };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/scan-session.js'), 'utf8'), {
    window,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return { api: window.ScanSession, workers, timers, window };
}

async function testClientIsolation() {
  const { api, workers, timers } = clientEnvironment();
  assert.notStrictEqual(api.createId(), api.createId(), 'Every tab session gets a distinct ID');
  const first = api.createWorkerClient('scan.js', { sessionId: 'tab-a' });
  const second = api.createWorkerClient('scan.js', { sessionId: 'tab-b' });
  assert.notStrictEqual(workers[0], workers[1], 'Tabs never share a Worker');
  const firstResult = first.request({ mode: 'opencv' });
  const secondResult = second.request({ mode: 'fallback' });
  assert.strictEqual(workers[0].messages[0].data.id, 1);
  assert.strictEqual(workers[1].messages[0].data.id, 1);
  const wrongSession = bitmap();
  workers[0].reply({ sessionId: 'tab-b', id: 1, bitmap: wrongSession });
  assert.strictEqual(wrongSession.closed, 1, 'A reply belonging to another session is released');
  assert.strictEqual(timers.size, 2, 'A wrong session cannot settle another request');
  workers[1].reply({ sessionId: 'tab-b', id: 1, detected: false });
  assert.strictEqual((await secondResult).detected, false);
  workers[0].reply({ sessionId: 'tab-a', id: 1, detected: true });
  assert.strictEqual((await firstResult).detected, true, 'Other sessions can finish in either order');

  const active = first.request({ mode: 'opencv' });
  const payload = { mode: 'all', options: { documentType: 'document' } };
  const queued = first.request(payload);
  payload.mode = 'fallback';
  payload.options.documentType = 'cccd-front';
  assert.strictEqual(workers[0].messages.length, 2, 'Only one request per Worker is dispatched at a time');
  const earlyReply = bitmap();
  workers[0].reply({ sessionId: 'tab-a', id: 3, bitmap: earlyReply });
  assert.strictEqual(earlyReply.closed, 1, 'An out-of-order reply cannot resolve a queued request');
  workers[0].reply({ sessionId: 'tab-a', id: 2, method: 'opencv' });
  await active;
  assert.strictEqual(workers[0].messages.length, 3);
  assert.strictEqual(workers[0].messages[2].data.mode, 'all');
  assert.strictEqual(workers[0].messages[2].data.options.documentType, 'document');
  const duplicate = bitmap();
  workers[0].reply({ sessionId: 'tab-a', id: 2, bitmap: duplicate });
  assert.strictEqual(duplicate.closed, 1, 'A duplicate result cannot replace the current scan');
  workers[0].reply({ sessionId: 'tab-a', id: 3, method: 'all' });
  assert.strictEqual((await queued).method, 'all');
  assert.strictEqual(timers.size, 0);
  first.dispose();
  second.dispose();
}

async function testCleanup() {
  const env = clientEnvironment();
  const client = env.api.createWorkerClient('scan.js', { sessionId: 'dispose', timeoutMs: 60000 });
  const active = client.request({ bitmap: bitmap() });
  const queuedBitmap = bitmap();
  const queued = client.request({ bitmap: queuedBitmap }, [queuedBitmap]);
  assert.strictEqual(env.timers.size, 1, 'Time spent waiting in the queue does not use the processing timeout');
  assert.strictEqual(Array.from(env.timers.values())[0].ms, 60000);
  client.dispose();
  assert.strictEqual(await active, null);
  assert.strictEqual(await queued, null);
  assert.strictEqual(queuedBitmap.closed, 1, 'Queued images are released on disposal');
  assert.strictEqual(env.workers[0].terminated, true);
  assert.strictEqual(client.available, false);
  assert.strictEqual(env.timers.size, 0);
  const late = bitmap();
  env.workers[0].reply({ sessionId: 'dispose', id: 1, bitmap: late });
  assert.strictEqual(late.closed, 1, 'Replies after disposal are released');
  const unavailable = bitmap();
  assert.strictEqual(await client.request({ bitmap: unavailable }), null);
  assert.strictEqual(unavailable.closed, 1);

  const timed = env.api.createWorkerClient('scan.js', { sessionId: 'timeout' });
  const timeoutActive = timed.request({});
  const timeoutQueued = timed.request({});
  Array.from(env.timers.values())[0].fn();
  assert.strictEqual(await timeoutActive, null);
  assert.strictEqual(await timeoutQueued, null);
  assert.strictEqual(timed.available, false, 'A timed out Worker stops before the main thread fallback starts');

  const failed = env.api.createWorkerClient('scan.js', { sessionId: 'post-failure' });
  env.workers[2].failPost = true;
  const failedBitmap = bitmap();
  assert.strictEqual(await failed.request({ bitmap: failedBitmap }, [failedBitmap]), null);
  assert.strictEqual(failedBitmap.closed, 1, 'A failed transfer releases its image');
  assert.strictEqual(failed.available, false);

  const broken = env.api.createWorkerClient('scan.js', { sessionId: 'worker-error' });
  const brokenResult = broken.request({});
  env.workers[3].onerror(new Error('Worker failed'));
  assert.strictEqual(await brokenResult, null);
  assert.strictEqual(broken.available, false);
  assert.strictEqual(env.timers.size, 0);

  env.window.Worker = undefined;
  const unsupported = env.api.createWorkerClient('scan.js');
  assert.strictEqual(unsupported.available, false);
  assert.strictEqual(await unsupported.request({}), null);
}

async function testScanWorkerQueue() {
  const replies = [];
  const settings = [];
  let releaseOpenCv;
  const cv = new Promise(resolve => { releaseOpenCv = resolve; });
  class OffscreenCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() {} }; }
    transferToImageBitmap() { return bitmap(); }
  }
  const self = { cv, postMessage(data) { replies.push(data); } };
  const context = vm.createContext({ self, OffscreenCanvas, importScripts() {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/document-scan-worker.js'), 'utf8'), context);
  context.capture = (mode, options) => { settings.push({ mode, documentType: options.documentType }); };
  vm.runInContext('prepareScan = function(source, options, mode) { capture(mode, options); if (options.fail) throw new Error("Fixture failure"); return {canvas: source, detected: true, method: mode}; };', context);
  const first = { id: 1, sessionId: 'worker-a', bitmap: bitmap(), mode: 'fallback', options: { documentType: 'document', fail: true } };
  const second = { id: 2, sessionId: 'worker-b', bitmap: bitmap(), mode: 'all', options: { documentType: 'cccd-front' } };
  const legacy = { id: 3, bitmap: bitmap(), mode: 'invalid', options: { documentType: 'document' } };
  self.onmessage({ data: first });
  self.onmessage({ data: second });
  self.onmessage({ data: legacy });
  first.mode = 'opencv';
  second.options.documentType = 'changed-after-send';
  assert.strictEqual(replies.length, 0);
  releaseOpenCv({ Mat() {}, findContours() {} });
  await vm.runInContext('scanQueue', context);
  assert.strictEqual(replies.length, 3, 'One failed scan must not stop the next requests');
  assert.strictEqual(replies[0].sessionId, 'worker-a');
  assert(replies[0].error.includes('Fixture failure'));
  assert.strictEqual(replies[1].sessionId, 'worker-b');
  assert.strictEqual(replies[1].method, 'all');
  assert.strictEqual(replies[2].id, 3);
  assert.strictEqual(replies[2].sessionId, undefined, 'Direct legacy Worker callers remain supported');
  assert.strictEqual(replies[2].method, 'opencv', 'Unrecognized modes use OpenCV');
  assert.strictEqual(settings[0].mode, 'fallback', 'Each queued scan captures its own mode before awaiting OpenCV');
  assert.strictEqual(settings[1].documentType, 'cccd-front', 'Later changes cannot replace queued options');
  assert.strictEqual(first.bitmap.closed, 1);
  assert.strictEqual(second.bitmap.closed, 1);
  assert.strictEqual(legacy.bitmap.closed, 1);

  let failedOutput;
  self.postMessage = data => {
    if (data.id === 4 && data.bitmap) {
      failedOutput = data.bitmap;
      throw new Error('Output transfer failed');
    }
    replies.push(data);
  };
  self.onmessage({ data: { id: 4, sessionId: 'transfer-error', bitmap: bitmap(), mode: 'opencv' } });
  self.onmessage({ data: { id: 5, sessionId: 'after-error', bitmap: bitmap(), mode: 'fallback' } });
  await vm.runInContext('scanQueue', context);
  assert.strictEqual(failedOutput.closed, 1, 'An output that could not be transferred is released');
  assert.strictEqual(replies[3].bitmap, undefined, 'Error replies do not include a closed bitmap');
  assert(replies[3].error.includes('Output transfer failed'));
  assert.strictEqual(replies[4].id, 5, 'A failed output transfer cannot poison the request queue');
}

function testQrEnvelope() {
  const replies = [];
  const context = vm.createContext({ importScripts() {}, jsQR: () => ({ data: '000000000000||TEST|01011990|X|ADDRESS' }),
    self: { postMessage(data) { replies.push(data); } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/cccd-qr-worker.js'), 'utf8'), context);
  context.self.onmessage({ data: { sessionId: 'qr-a', id: 1, width: 1, height: 1, buffer: new ArrayBuffer(4) } });
  context.self.onmessage({ data: { id: 1, width: 1, height: 1, buffer: new ArrayBuffer(4) } });
  assert.strictEqual(replies[0].sessionId, 'qr-a');
  assert.strictEqual(replies[0].number, '000000000000');
  assert.strictEqual(replies[1].sessionId, undefined);
}

(async () => {
  await testClientIsolation();
  await testCleanup();
  await testScanWorkerQueue();
  testQrEnvelope();
  console.log('PASS: isolated Worker sessions, request queues/mode snapshots, stale reply rejection, cleanup and legacy Worker compatibility');
})().catch(error => { console.error(error); process.exitCode = 1; });
