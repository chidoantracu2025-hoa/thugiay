// Run with node tests/pdf-save.test.js. Production six-page save flows; no network or real PDFs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'assets/scan-runtime.js'), 'utf8');
const pages = ['DaiAn.html', 'HamGiang.html', 'LongHiep.html', 'LuuNghiepAnh.html', 'TapSon.html', 'TraCu.html'];
const MAX_BYTES = 10000000;

function functionCode(html, name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert(start >= 0, 'Missing function ' + name);
  const tail = html.slice(start + 1);
  const end = tail.search(/\n    (?:async )?function /);
  return html.slice(start, end < 0 ? html.indexOf('  </script>', start) : start + 1 + end);
}
function part(id, byteLength) {
  return { dataUri: 'data:application/pdf;base64,' + id, byteLength: byteLength || 1000, pageCount: 1, quality: 0.96, dpi: 400 };
}
function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function saves(test) { return test.calls.filter(function (call) { return call.action === 'SAVE_SCAN'; }); }
function success(call, overrides) {
  return Object.assign({ success: true, fileGCN: 'https://example.invalid/gcn', fileCCCD: 'https://example.invalid/cccd',
    fileId: 'original-id', originalBackupSaved: true, pdfUploadComplete: true, rowIndex: 20,
    saveRequestId: call.payload.saveRequestId, savedPdfGroupKeys: Object.assign({}, call.payload.pdfGroupKeys) }, overrides || {});
}
function image(id, type) {
  return { id: id, type: type, revision: 1, canvas: { width: 3508, height: 4961 },
    originalCanvas: { width: 4000, height: 6000 }, processingQuality: { dpi: 400 } };
}
function fixture(html, options) {
  options = options || {};
  const nodes = {};
  function node(id) {
    if (!nodes[id]) nodes[id] = { value: id + ' initial', disabled: false, textContent: '' };
    return nodes[id];
  }
  node('webAppUrl').value = 'https://example.invalid/initial-api';
  node('btnSaveRecord');
  const documents = options.noImages || options.onlyCards ? [] : [image('document-1', 'document')];
  const cards = options.noImages ? [] : [image('front-1', 'cccd-front'), image('back-1', 'cccd-back')];
  const state = { documentPages: documents, cccdPhotos: cards, selectedRowIndex: options.rowIndex || null,
    saving: false, processing: false, stream: options.cameraOpen ? {} : null };
  const test = { nodes: nodes, state: state, exports: [], calls: [], alerts: [], statuses: [], renders: [],
    performanceLogs: [], noteSaves: 0, cameraStops: 0 };
  const plans = options.plans || [[part('original')], [part('gcn')], [part('cccd')]];
  let identifier = 0, tick = 0;
  const context = vm.createContext({
    state: state, identityQueue: Promise.resolve(), performance: { now: function () { return ++tick; } },
    scanSessionId: 'scan_session_0123456789',
    ScanSession: { createId: function () { return 'save_request_' + String(++identifier).padStart(12, '0'); } },
    document: { getElementById: node },
    window: { DocumentPdfExporter: {
      MAX_PDF_BYTES: MAX_BYTES,
      exportPdfParts: async function (scans, exportOptions) {
        const index = test.exports.length;
        test.exports.push({ ids: Array.from(scans).map(function (scan) { return scan.id; }), original: exportOptions.original });
        assert.strictEqual(typeof exportOptions.loadSource, 'function', 'Exporter must load compressed originals only when needed');
        const loaded = await exportOptions.loadSource(scans[0], exportOptions.original);
        assert.strictEqual(loaded.canvas, exportOptions.original ? scans[0].originalCanvas : scans[0].canvas);
        if (options.onExport) await options.onExport(index, test);
        const result = plans[index];
        if (result instanceof Error) throw result;
        assert(Array.isArray(result), 'Unexpected extra export stage ' + index);
        return result;
      }
    } },
    getApiUrl: function () { return node('webAppUrl').value; },
    apiRequest: async function (action, payload, url) {
      const call = { action: action, payload: payload, url: url }; test.calls.push(call);
      if (action === 'PING') return options.capabilities || { supportsPdfParts: true, pdfUploadVersion: 2,
        maxPdfBytes: MAX_BYTES, supportsSaveRetry: true, supportsSaveStatus: true, saveRequestVersion: 1 };
      if (action === 'SAVE_STATUS') {
        if (options.onStatus) return options.onStatus(call, test);
        throw new Error('Old deployed API has no SAVE_STATUS action');
      }
      assert.strictEqual(action, 'SAVE_SCAN');
      if (options.onSave) return options.onSave(saves(test).length, call, test);
      return success(call);
    },
    stopCamera: function () { test.cameraStops++; state.stream = null; },
    alert: function (text) { test.alerts.push(text); },
    setStatus: function (text, tone) { test.statuses.push({ text: text, tone: tone }); },
    renderRecordFiles: function (files) { test.renders.push(files); },
    appendSavePerformanceLog: function (entry) { test.performanceLogs.push(Object.assign({}, entry)); return entry; },
    saveNoteOnly: function () { test.noteSaves++; }
  });
  vm.runInContext(runtime, context);
  vm.runInContext([
    'buildPdfParts', 'buildPdfFromScans', 'buildOriginalBackupPdf', 'pdfUploadFields',
    'buildPdfFileName', 'buildCccdPdfFileName', 'buildOriginalBackupFileName', 'buildRecordFileNameParts',
    'normalizeFileNamePart', 'scanGroupKey', 'makeSaveAttempt', 'applySaveResult', 'saveCurrentRecord'
  ].map(function (name) { return functionCode(html, name); }).join('\n'), context);
  test.save = context.saveCurrentRecord;
  test.fields = context.pdfUploadFields; test.node = node;
  test.documents = documents; test.cards = cards;
  return test;
}
function resetAfter(test) {
  assert.strictEqual(test.state.saving, false);
  assert.strictEqual(test.nodes.btnSaveRecord.disabled, false);
}
function imagesRetained(test) {
  assert.strictEqual(test.state.documentPages, test.documents);
  assert.strictEqual(test.state.cccdPhotos, test.cards);
  assert.strictEqual(test.documents.length, 1);
  assert.strictEqual(test.cards.length, 2);
}

async function verifyPage(page) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  // Single PDFs retain the scalar contract; pause the camera and keep the saved row.
  {
    const test = fixture(html, { cameraOpen: true });
    await test.save();
    assert.deepStrictEqual(test.calls.map(function (call) { return call.action; }), ['SAVE_SCAN']);
    const payload = saves(test)[0].payload;
    assert.strictEqual(payload.pdfOriginalBase64, part('original').dataUri);
    assert.strictEqual(payload.pdfGCNBase64, part('gcn').dataUri);
    assert.strictEqual(payload.pdfCCCDBase64, part('cccd').dataUri);
    ['pdfOriginalFiles', 'pdfGCNFiles', 'pdfCCCDFiles'].forEach(function (key) { assert(!has(payload, key)); });
    assert.strictEqual(Object.keys(payload.pdfGroupKeys).length, 3);
    assert(/^[A-Za-z0-9_-]{16,100}$/.test(payload.saveRequestId));
    assert.strictEqual(payload.pageCount, 3);
    assert.deepStrictEqual(test.exports.map(function (stage) { return stage.original; }), [true, false, false]);
    assert.deepStrictEqual(test.exports.map(function (stage) { return stage.ids; }), [
      ['document-1', 'front-1', 'back-1'], ['document-1'], ['front-1', 'back-1']
    ]);
    assert.strictEqual(test.cameraStops, 1);
    assert.strictEqual(test.state.selectedRowIndex, 20);
    assert.strictEqual(test.state.lastSaveTiming.pdfBytesSent, 3000);
    assert.strictEqual(test.performanceLogs[0].result, 'success');
    assert.strictEqual(test.performanceLogs[0].pdfBytesSent, 3000);
    ['exportMs', 'requestMs', 'totalMs'].forEach(function (key) {
      assert(Number.isFinite(test.performanceLogs[0][key]) && test.performanceLogs[0][key] >= 0);
    });
    await test.save();
    assert.strictEqual(test.calls.length, 1, 'An unchanged second click must not append or upload again');
    assert.strictEqual(test.exports.length, 3);
    assert.strictEqual(test.performanceLogs[1].result, 'unchanged');
    resetAfter(test); imagesRetained(test);
  }

  // Multipart names retain page order and zero padding; PING precedes the only write.
  {
    const originals = Array.from({ length: 12 }, function (_, index) { return part('original-' + index); });
    const test = fixture(html, { plans: [originals, [part('gcn-1'), part('gcn-2')], [part('cccd-1'), part('cccd-2')]] });
    await test.save();
    assert.deepStrictEqual(test.calls.map(function (call) { return call.action; }), ['PING', 'SAVE_SCAN']);
    const payload = saves(test)[0].payload;
    [
      ['pdfOriginalFiles', 'pdfOriginalBase64', payload.fileNameOriginal, originals],
      ['pdfGCNFiles', 'pdfGCNBase64', payload.fileName, [part('gcn-1'), part('gcn-2')]],
      ['pdfCCCDFiles', 'pdfCCCDBase64', payload.fileNameCCCD, [part('cccd-1'), part('cccd-2')]]
    ].forEach(function (group) {
      assert(!has(payload, group[1]), 'Multipart must not duplicate its first part as a scalar');
      const base = group[2].replace(/\.pdf$/i, '');
      const digits = String(group[3].length).length;
      group[3].forEach(function (source, index) {
        assert.strictEqual(payload[group[0]][index].base64, source.dataUri);
        assert.strictEqual(payload[group[0]][index].fileName,
          base + '_phan_' + String(index + 1).padStart(digits, '0') + '_tren_' + group[3].length + '.pdf');
      });
    });
    assert.strictEqual(test.state.selectedRowIndex, 20);
    resetAfter(test);
  }

  // Old APIs without multipart support cannot receive a partial/unsupported write.
  for (const capabilities of [{}, { supportsPdfParts: false, pdfUploadVersion: 2 }, { supportsPdfParts: true, pdfUploadVersion: 1 }]) {
    const test = fixture(html, { capabilities: capabilities, plans: [[part('a'), part('b')], [part('g')], [part('c')]] });
    await test.save();
    assert.deepStrictEqual(test.calls.map(function (call) { return call.action; }), ['PING']);
    assert.strictEqual(saves(test).length, 0);
    assert(test.alerts[0].indexOf('chưa hỗ trợ PDF chia phần') >= 0);
    resetAfter(test); imagesRetained(test);
  }

  // Even a failure in the final export stage cannot leave an uploaded backup or GCN.
  {
    const test = fixture(html, { plans: [[part('original')], [part('gcn')], new Error('last group cannot fit')] });
    await test.save();
    assert.strictEqual(test.exports.length, 3);
    assert.strictEqual(test.calls.length, 0);
    assert(test.alerts[0].indexOf('last group cannot fit') >= 0);
    assert.strictEqual(test.state.saveAttempt.uncertain, false);
    resetAfter(test); imagesRetained(test);
  }
  for (const byteLength of [MAX_BYTES + 1, 0, 1.5, NaN]) {
    const invalid = part('invalid'); invalid.byteLength = byteLength;
    const test = fixture(html, { plans: [[part('original')], [invalid], [part('cccd')]] });
    await test.save();
    assert.strictEqual(test.calls.length, 0);
    assert(test.alerts[0].indexOf('10 MB') >= 0);
    resetAfter(test); imagesRetained(test);
  }
  {
    const test = fixture(html);
    assert.strictEqual(test.fields([part('exact', MAX_BYTES)], 'exact.pdf', 'single', 'parts').single, part('exact').dataUri);
    const empty = test.fields([], 'empty.pdf', 'single', 'parts');
    assert.strictEqual(empty.single, ''); assert(!has(empty, 'parts'));
  }

  // Metadata, row, names, pages and endpoint describe the initial record throughout export.
  {
    const test = fixture(html, { rowIndex: 7, onExport: function (index, current) {
      if (index) return;
      ['tenHuyen', 'tenXaCu', 'tenXaMoi', 'hoTenCSD', 'soHieuToBanDoMoi', 'soThuTuThuaMoi', 'ocrText'].forEach(function (key) {
        current.nodes[key].value = 'changed while exporting';
      });
      current.nodes.webAppUrl.value = 'https://example.invalid/changed-api';
      current.state.selectedRowIndex = 99;
      current.state.documentPages = [image('another-document', 'document')];
      current.state.cccdPhotos = [];
    } });
    await test.save();
    const call = saves(test)[0];
    assert.strictEqual(call.url, 'https://example.invalid/initial-api');
    assert.strictEqual(call.payload.rowIndex, 7);
    assert.strictEqual(call.payload.pageCount, 3);
    ['tenHuyen', 'tenXaCu', 'tenXaMoi', 'hoTenCSD', 'soHieuToBanDoMoi', 'soThuTuThuaMoi', 'ocrText'].forEach(function (key) {
      assert.strictEqual(call.payload[key], key + ' initial');
    });
    assert(call.payload.fileName.indexOf('hoTenCSD_initial') >= 0);
    assert(call.payload.fileNameOriginal.indexOf('changed') < 0);
    assert.deepStrictEqual(test.exports[1].ids, ['document-1']);
    assert.deepStrictEqual(test.exports[2].ids, ['front-1', 'back-1']);
    resetAfter(test);
  }

  // Acknowledged groups are omitted on retry; the remaining PDF comes from cache.
  {
    const test = fixture(html, { onSave: function (attempt, call) {
      return success(call, attempt === 1 ? { pdfUploadComplete: false, rowIndex: 42, warning: 'missing GCN part',
        savedPdfGroupKeys: { original: call.payload.pdfGroupKeys.original, cccd: call.payload.pdfGroupKeys.cccd } }
        : { rowIndex: 42, updated: true });
    } });
    await test.save();
    const first = saves(test)[0].payload;
    assert.strictEqual(test.state.selectedRowIndex, 42);
    assert(test.nodes.btnSaveRecord.textContent.indexOf('Lưu tiếp') >= 0);
    assert(test.alerts[0].indexOf('missing GCN part') >= 0);
    resetAfter(test); imagesRetained(test);
    await test.save();
    const retry = saves(test)[1].payload;
    assert.strictEqual(retry.saveRequestId, first.saveRequestId);
    assert.strictEqual(retry.rowIndex, first.rowIndex, 'New backend resolves the original row from its request journal');
    assert.strictEqual(retry.createdAt, first.createdAt);
    assert.strictEqual(retry.fileNameOriginal, first.fileNameOriginal);
    assert(!has(retry, 'pdfOriginalBase64')); assert(!has(retry, 'pdfCCCDBase64'));
    assert.strictEqual(retry.pdfGCNBase64, first.pdfGCNBase64);
    assert.strictEqual(Object.keys(retry.pdfGroupKeys).length, 3);
    assert.strictEqual(test.exports.length, 3, 'Retry must not re-encode unchanged pages');
    assert.strictEqual(test.state.selectedRowIndex, 42);
    resetAfter(test); imagesRetained(test);
  }

  // Deployed v2 APIs receive full cached PDFs and the exact saved row on partial retries.
  {
    const test = fixture(html, { onSave: function (attempt) {
      return { success: true, pdfUploadComplete: attempt > 1, rowIndex: 42, updated: attempt > 1 };
    } });
    await test.save(); await test.save();
    const retry = saves(test)[1].payload;
    assert.strictEqual(retry.rowIndex, 42, 'Legacy retry must update its saved row rather than append');
    ['pdfOriginalBase64', 'pdfGCNBase64', 'pdfCCCDBase64'].forEach(function (key) { assert(has(retry, key)); });
    assert.strictEqual(test.exports.length, 3);
    assert.strictEqual(test.state.selectedRowIndex, 42);
    resetAfter(test);
  }

  // A lost response is checked with a small SAVE_STATUS before any retransmission.
  {
    const test = fixture(html, { onSave: function () { throw new Error('response lost'); },
      onStatus: function (call, current) {
        return success(saves(current)[0], { saveRequestId: call.payload.saveRequestId, processing: false, rowIndex: 64 });
      } });
    await test.save();
    assert.strictEqual(test.state.saveAttempt.uncertain, true);
    await test.save();
    assert.deepStrictEqual(test.calls.map(function (call) { return call.action; }), ['SAVE_SCAN', 'SAVE_STATUS']);
    assert.strictEqual(test.state.selectedRowIndex, 64);
    assert.strictEqual(test.state.saveAttempt.complete, true);
    assert.strictEqual(test.exports.length, 3);
    resetAfter(test); imagesRetained(test);
  }
  {
    const test = fixture(html, { onSave: function (attempt, call) {
      if (attempt === 1) throw new Error('partial response lost');
      return success(call, { rowIndex: 65 });
    }, onStatus: function (call, current) {
      const keys = saves(current)[0].payload.pdfGroupKeys;
      return { success: true, saveRequestId: call.payload.saveRequestId, processing: false,
        rowIndex: 65, pdfUploadComplete: false, savedPdfGroupKeys: { original: keys.original, cccd: keys.cccd } };
    } });
    await test.save(); await test.save();
    assert.deepStrictEqual(test.calls.map(function (call) { return call.action; }), ['SAVE_SCAN', 'SAVE_STATUS', 'SAVE_SCAN']);
    const retry = saves(test)[1].payload;
    assert(!has(retry, 'pdfOriginalBase64')); assert(!has(retry, 'pdfCCCDBase64'));
    assert(has(retry, 'pdfGCNBase64'));
    assert.strictEqual(test.exports.length, 3);
    assert.strictEqual(test.state.selectedRowIndex, 65);
    resetAfter(test);
  }
  for (const condition of ['processing', 'expired']) {
    const test = fixture(html, { onSave: function () { throw new Error('response lost'); }, onStatus: function (call) {
      if (condition === 'expired') throw Object.assign(new Error('expired'), { code: 'SAVE_RETRY_EXPIRED' });
      return { success: true, saveRequestId: call.payload.saveRequestId, processing: true, pdfUploadComplete: false };
    } });
    await test.save(); await test.save();
    assert.strictEqual(saves(test).length, 1, 'A running/unknown prior save must not be blindly repeated');
    assert.strictEqual(test.exports.length, 3);
    assert.strictEqual(test.state.saveAttempt.uncertain, true);
    resetAfter(test); imagesRetained(test);
  }

  // Editing metadata reuses the saved PDFs; changing an image rebuilds only affected groups.
  {
    const test = fixture(html);
    await test.save();
    const first = saves(test)[0].payload;
    test.nodes.hoTenCSD.value = 'corrected owner';
    await test.save();
    const metadata = saves(test)[1].payload;
    assert.notStrictEqual(metadata.saveRequestId, first.saveRequestId);
    assert.strictEqual(metadata.rowIndex, 20);
    assert.strictEqual(metadata.hoTenCSD, 'corrected owner');
    assert.strictEqual(Object.keys(metadata.pdfGroupKeys).length, 0);
    ['pdfOriginalBase64', 'pdfGCNBase64', 'pdfCCCDBase64', 'pdfOriginalFiles', 'pdfGCNFiles', 'pdfCCCDFiles'].forEach(function (key) {
      assert(!has(metadata, key), 'Metadata edits must not resend PDF data');
    });
    assert.strictEqual(test.exports.length, 3);
    assert.strictEqual(test.state.lastSaveTiming.pdfBytesSent, 0);
    assert.strictEqual(test.state.selectedRowIndex, 20);
    const metadataAttempt = test.state.saveAttempt;
    await test.save();
    assert.strictEqual(saves(test).length, 2, 'An unchanged click after metadata edit must not start another transaction');
    assert.strictEqual(test.state.saveAttempt, metadataAttempt);
    assert.strictEqual(test.exports.length, 3);
    resetAfter(test);
  }
  // A metadata edit after an append uses the saved row as its canonical identity.
  // If the response is lost, status recovery and retry retain that exact ID/row.
  {
    const test = fixture(html, { onSave: function (attempt, call) {
      if (attempt === 2) throw new Error('metadata response lost');
      return success(call, { rowIndex: 30 });
    }, onStatus: function (call) {
      return { success: true, saveRequestId: call.payload.saveRequestId, processing: false,
        pdfUploadComplete: false, rowIndex: 30, savedPdfGroupKeys: {} };
    } });
    await test.save();
    const appended = saves(test)[0].payload;
    assert.strictEqual(test.state.selectedRowIndex, 30);
    test.nodes.hoTenCSD.value = 'corrected owner after append';
    await test.save();
    const edited = saves(test)[1].payload;
    assert.notStrictEqual(edited.saveRequestId, appended.saveRequestId);
    assert.strictEqual(edited.rowIndex, 30);
    assert.strictEqual(test.state.saveAttempt.uncertain, true);
    await test.save();
    const retry = saves(test)[2].payload;
    assert.deepStrictEqual(test.calls.map(function (call) { return call.action; }),
      ['SAVE_SCAN', 'SAVE_SCAN', 'SAVE_STATUS', 'SAVE_SCAN']);
    assert.strictEqual(test.calls[2].payload.saveRequestId, edited.saveRequestId);
    assert.strictEqual(retry.saveRequestId, edited.saveRequestId);
    assert.strictEqual(retry.rowIndex, 30);
    assert.strictEqual(retry.createdAt, edited.createdAt);
    assert.strictEqual(retry.fileNameOriginal, edited.fileNameOriginal);
    assert.strictEqual(Object.keys(retry.pdfGroupKeys).length, 0);
    assert.strictEqual(test.exports.length, 3);
    await test.save();
    assert.strictEqual(saves(test).length, 3, 'Recovered metadata attempt must also deduplicate unchanged clicks');
    assert.strictEqual(test.state.selectedRowIndex, 30);
    resetAfter(test); imagesRetained(test);
  }
  // Editing metadata and a page after an append may partially save. Continue the
  // same update transaction instead of generating a new ID from its selected row.
  {
    const test = fixture(html, { plans: [[part('original')], [part('gcn')], [part('cccd')],
      [part('original-corrected')], [part('gcn-corrected')]], onSave: function (attempt, call) {
      return success(call, attempt === 2 ? { rowIndex: 30, pdfUploadComplete: false,
        savedPdfGroupKeys: { original: call.payload.pdfGroupKeys.original } } : { rowIndex: 30 });
    } });
    await test.save();
    test.nodes.hoTenCSD.value = 'corrected owner with revised page';
    test.documents[0].revision++;
    await test.save();
    const edited = saves(test)[1].payload;
    assert.strictEqual(edited.rowIndex, 30);
    assert.strictEqual(test.state.saveAttempt.complete, false);
    await test.save();
    const retry = saves(test)[2].payload;
    assert.strictEqual(retry.saveRequestId, edited.saveRequestId);
    assert.strictEqual(retry.rowIndex, 30);
    assert.strictEqual(retry.createdAt, edited.createdAt);
    assert(!has(retry, 'pdfOriginalBase64'));
    assert(!has(retry, 'pdfCCCDBase64'));
    assert.strictEqual(retry.pdfGCNBase64, edited.pdfGCNBase64);
    assert.strictEqual(test.exports.length, 5);
    await test.save();
    assert.strictEqual(saves(test).length, 3);
    assert.strictEqual(test.state.selectedRowIndex, 30);
    resetAfter(test); imagesRetained(test);
  }
  {
    const test = fixture(html, { plans: [[part('original')], [part('gcn')], [part('cccd')], [part('original-new')], [part('gcn-new')]] });
    await test.save();
    test.documents[0].revision++;
    await test.save();
    const changed = saves(test)[1].payload;
    assert.strictEqual(Object.keys(changed.pdfGroupKeys).length, 2);
    assert(has(changed, 'pdfOriginalBase64')); assert(has(changed, 'pdfGCNBase64'));
    assert(!has(changed, 'pdfCCCDBase64'));
    assert.strictEqual(test.exports.length, 5);
    assert.deepStrictEqual(test.exports.slice(3).map(function (stage) { return stage.original; }), [true, false]);
    resetAfter(test);
  }

  // Missing endpoint/busy pages cannot write; a photo-free form saves every field through SAVE_SCAN.
  {
    const test = fixture(html); test.nodes.webAppUrl.value = '';
    await test.save();
    assert.strictEqual(test.calls.length, 0); assert.strictEqual(test.exports.length, 0); resetAfter(test);
  }
  {
    const test = fixture(html); test.state.processing = true;
    await test.save();
    assert.strictEqual(test.calls.length, 0); assert.strictEqual(test.exports.length, 0); resetAfter(test);
  }
  {
    const test = fixture(html, { onlyCards: true, plans: [[part('original-cards')], [part('cccd-only')]] });
    test.node('soCCCD').value = '012345678901';
    test.node('hoTenCSD').value = 'Chỉ có CCCD';
    await test.save();
    const payload = saves(test)[0].payload;
    assert.strictEqual(payload.pageCount, 2);
    assert.strictEqual(payload.soCCCD, '012345678901');
    assert.strictEqual(payload.hoTenCSD, 'Chỉ có CCCD');
    assert(has(payload, 'pdfOriginalBase64'));
    assert(has(payload, 'pdfCCCDBase64'));
    assert(!has(payload, 'pdfGCNBase64'));
    assert.deepStrictEqual(Object.keys(payload.pdfGroupKeys).sort(), ['cccd', 'original']);
    assert.deepStrictEqual(test.exports.map(function (stage) { return stage.original; }), [true, false]);
    assert.strictEqual(test.performanceLogs[0].result, 'success');
    assert.strictEqual(test.performanceLogs[0].pdfBytesSent, 2000);
    resetAfter(test);
  }
  {
    const test = fixture(html, { noImages: true });
    test.node('hoTenCSD').value = 'Nguyễn Văn Không PDF';
    test.node('soCCCD').value = '012345678901';
    test.node('soHieuToBanDoMoi').value = '88';
    test.node('soThuTuThuaMoi').value = '999';
    test.node('dienTich').value = '123.4';
    test.node('ocrText').value = 'Ghi chú không có ảnh';
    await test.save();
    assert.strictEqual(test.noteSaves, 0);
    assert.strictEqual(test.calls.length, 1);
    const payload = saves(test)[0].payload;
    assert.strictEqual(payload.hoTenCSD, 'Nguyễn Văn Không PDF');
    assert.strictEqual(payload.soCCCD, '012345678901');
    assert.strictEqual(payload.soHieuToBanDoMoi, '88');
    assert.strictEqual(payload.soThuTuThuaMoi, '999');
    assert.strictEqual(payload.dienTich, '123.4');
    assert.strictEqual(payload.ocrText, 'Ghi chú không có ảnh');
    assert.strictEqual(payload.pageCount, 0);
    assert.deepStrictEqual(Object.keys(payload.pdfGroupKeys), []);
    ['pdfOriginalBase64', 'pdfGCNBase64', 'pdfCCCDBase64', 'pdfOriginalFiles', 'pdfGCNFiles', 'pdfCCCDFiles'].forEach(function (key) {
      assert(!has(payload, key), 'A metadata-only save must not add an empty PDF field.');
    });
    assert.strictEqual(test.exports.length, 0);
    assert.strictEqual(test.performanceLogs[0].result, 'success');
    assert.strictEqual(test.performanceLogs[0].pdfBytesSent, 0);
    resetAfter(test);
  }
}

(async function () {
  for (const page of pages) {
    try { await verifyPage(page); }
    catch (error) { error.message = page + ': ' + error.message; throw error; }
  }
  console.log('PASS: six-page PDF staging/cache, partial/group retry, lost-response status, legacy same-row fallback, metadata-only updates and camera pause');
})().catch(function (error) { console.error(error); process.exitCode = 1; });
