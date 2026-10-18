// Run with node tests/save-performance.test.js. Remote best-effort logging; no network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const pages = ['DaiAn.html', 'HamGiang.html', 'LongHiep.html', 'LuuNghiepAnh.html', 'TapSon.html', 'TraCu.html'];

function loggingSource(html) {
  const start = html.indexOf('    function appendSavePerformanceLog(');
  const end = html.indexOf('\n    const state =', start);
  assert(start >= 0 && end > start, 'Missing performance logging block');
  return html.slice(start, end);
}

async function runPage(page) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  assert(!html.includes('savePerformanceSummary'), page + ': logging UI must be removed');
  assert(!html.includes('downloadSavePerformanceLog'), page + ': download control must be removed');
  assert(!html.includes("localStorage.setItem(SAVE_PERFORMANCE"), page + ': performance log must not use local storage');
  const requests = [];
  const context = vm.createContext({
    SCAN_PAGE_ID: page.replace('.html', ''),
    ScanSession: { createId: () => 'event_0123456789012345' },
    navigator: { connection: { effectiveType: '4g', downlink: 5.5, rtt: 90 }, deviceMemory: 4, hardwareConcurrency: 8 },
    getApiUrl: () => 'https://example.invalid/apps-script',
    fetch: (url, options) => { requests.push({ url, options }); return Promise.resolve({ ok: true }); },
    Date, Number, JSON, String, Boolean, Object, Math, Promise
  });
  vm.runInContext(loggingSource(html), context);
  const safe = context.appendSavePerformanceLog({ result: 'success', performanceLogToken: 'token_01234567890123456789',
    pdfBytesSent: 123456, exportMs: 110, requestMs: 220, totalMs: 330,
    serverTiming: { validationMs: 1, driveMs: 180, sheetMs: 20, totalMs: 201 },
    hoTenCSD: 'Không được gửi', soCCCD: '012345678901', ocrText: 'Nội dung riêng', apiUrl: 'https://secret.invalid' });
  await Promise.resolve();
  assert.strictEqual(requests.length, 1, page + ': one background log request expected');
  assert.strictEqual(requests[0].options.keepalive, true);
  const request = JSON.parse(requests[0].options.body);
  assert.strictEqual(request.action, 'LOG_PERFORMANCE');
  assert.strictEqual(request.payload.logToken, 'token_01234567890123456789');
  assert.strictEqual(request.payload.page, page.replace('.html', ''));
  ['hoTenCSD', 'soCCCD', 'ocrText', 'apiUrl'].forEach(key => assert(!Object.prototype.hasOwnProperty.call(request.payload, key), page + ': leaked ' + key));
  assert(!JSON.stringify(request).includes('Không được gửi'));
  assert(!Object.prototype.hasOwnProperty.call(safe, 'logToken'), 'token must not be retained in returned telemetry');

  requests.length = 0;
  context.appendSavePerformanceLog({ result: 'error', totalMs: 10 });
  assert.strictEqual(requests.length, 0, 'events without a server-issued token are not sent');
  context.fetch = () => { throw new Error('offline'); };
  assert.doesNotThrow(() => context.appendSavePerformanceLog({ result: 'success', performanceLogToken: 'token_01234567890123456789' }));
}

(async () => {
  for (const page of pages) await runPage(page);
  console.log('PASS: six-page invisible GitHub log dispatch, privacy allowlist, server token requirement and failure tolerance');
})().catch(error => { console.error(error); process.exitCode = 1; });
