// Run with node tests/pdf-save.test.js. Uses production save functions with no network or real PDFs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
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
  return { dataUri: 'data:application/pdf;base64,' + id, byteLength: byteLength || 1000, pageCount: 1, quality: 0.98, dpi: 400 };
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
  const documents = [{ id: 'document-1', type: 'document' }];
  const cards = [{ id: 'front-1', type: 'cccd-front' }, { id: 'back-1', type: 'cccd-back' }];
  const state = { documentPages: documents, cccdPhotos: cards, selectedRowIndex: options.rowIndex || null, saving: false, processing: false };
  const test = { nodes: nodes, state: state, exports: [], calls: [], alerts: [], statuses: [], renders: [], noteSaves: 0 };
  const plans = options.plans || [[part('original')], [part('gcn')], [part('cccd')]];
  const context = vm.createContext({
    state: state,
    identityQueue: Promise.resolve(),
    document: { getElementById: node },
    window: { DocumentPdfExporter: {
      MAX_PDF_BYTES: MAX_BYTES,
      exportPdfParts: async function (scans, exportOptions) {
        const index = test.exports.length;
        test.exports.push({ ids: Array.from(scans).map(function (scan) { return scan.id; }), original: exportOptions.original });
        if (options.onExport) await options.onExport(index, test);
        const result = plans[index];
        if (result instanceof Error) throw result;
        assert(Array.isArray(result), 'Unexpected extra export stage');
        return result;
      }
    } },
    getApiUrl: function () { return node('webAppUrl').value; },
    apiRequest: async function (action, payload, url) {
      const call = { action: action, payload: payload, url: url }; test.calls.push(call);
      if (action === 'PING') return options.capabilities || { supportsPdfParts: true, pdfUploadVersion: 2, maxPdfBytes: MAX_BYTES };
      assert.strictEqual(action, 'SAVE_SCAN');
      if (options.onSave) return options.onSave(test.calls.filter(function (request) { return request.action === 'SAVE_SCAN'; }).length, call, test);
      return { success: true, fileGCN: 'https://example.invalid/gcn', fileCCCD: 'https://example.invalid/cccd',
        fileId: 'original-id', originalBackupSaved: true, pdfUploadComplete: true, rowIndex: 20 };
    },
    alert: function (text) { test.alerts.push(text); },
    setStatus: function (text, tone) { test.statuses.push({ text: text, tone: tone }); },
    renderRecordFiles: function (files) { test.renders.push(files); },
    saveNoteOnly: function () { test.noteSaves++; }
  });
  vm.runInContext([
    'buildPdfParts', 'buildPdfFromScans', 'buildOriginalBackupPdf', 'pdfUploadFields',
    'buildPdfFileName', 'buildCccdPdfFileName', 'buildOriginalBackupFileName',
    'buildRecordFileNameParts', 'normalizeFileNamePart', 'saveCurrentRecord'
  ].map(function (name) { return functionCode(html, name); }).join('\n'), context);
  test.save = context.saveCurrentRecord;
  test.fields = context.pdfUploadFields;
  test.documents = documents;
  test.cards = cards;
  return test;
}

function saves(test) { return test.calls.filter(function (call) { return call.action === 'SAVE_SCAN'; }); }
function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
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
  // A one-file group stays a scalar, retaining compatibility without duplicate part fields.
  {
    const test = fixture(html);
    await test.save();
    assert.strictEqual(test.calls.length, 1);
    assert.strictEqual(test.calls[0].action, 'SAVE_SCAN');
    const payload = test.calls[0].payload;
    assert.strictEqual(payload.pdfOriginalBase64, part('original').dataUri);
    assert.strictEqual(payload.pdfGCNBase64, part('gcn').dataUri);
    assert.strictEqual(payload.pdfCCCDBase64, part('cccd').dataUri);
    ['pdfOriginalFiles', 'pdfGCNFiles', 'pdfCCCDFiles'].forEach(function (key) { assert(!has(payload, key)); });
    assert.strictEqual(payload.pageCount, 3);
    assert.deepStrictEqual(test.exports.map(function (stage) { return stage.original; }), [true, false, false]);
    assert.deepStrictEqual(test.exports.map(function (stage) { return stage.ids; }), [
      ['document-1', 'front-1', 'back-1'], ['document-1'], ['front-1', 'back-1']
    ]);
    assert.strictEqual(test.state.selectedRowIndex, null);
    resetAfter(test); imagesRetained(test);
  }

  // All multipart names keep their order and zero padding; PING precedes the only write.
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
      assert(!has(payload, group[1]), 'Multipart group must not duplicate its first part as a scalar');
      const base = group[2].replace(/\.pdf$/i, '');
      const digits = String(group[3].length).length;
      group[3].forEach(function (source, index) {
        assert.strictEqual(payload[group[0]][index].base64, source.dataUri);
        assert.strictEqual(payload[group[0]][index].fileName,
          base + '_phan_' + String(index + 1).padStart(digits, '0') + '_tren_' + group[3].length + '.pdf');
      });
    });
    resetAfter(test);
  }

  // A server lacking either capability is blocked before SAVE_SCAN; the images stay available.
  for (const capabilities of [{}, { supportsPdfParts: false, pdfUploadVersion: 2 }, { supportsPdfParts: true, pdfUploadVersion: 1 }]) {
    const test = fixture(html, { capabilities: capabilities, plans: [[part('a'), part('b')], [part('g')], [part('c')]] });
    await test.save();
    assert.deepStrictEqual(test.calls.map(function (call) { return call.action; }), ['PING']);
    assert.strictEqual(saves(test).length, 0);
    assert(test.alerts[0].indexOf('chưa hỗ trợ PDF chia phần') >= 0);
    resetAfter(test); imagesRetained(test);
  }

  // A failure in the LAST export cannot leave an uploaded original or GCN behind.
  {
    const test = fixture(html, { plans: [[part('original')], [part('gcn')], new Error('last group cannot fit')] });
    await test.save();
    assert.strictEqual(test.exports.length, 3);
    assert.strictEqual(test.calls.length, 0);
    assert(test.alerts[0].indexOf('last group cannot fit') >= 0);
    resetAfter(test); imagesRetained(test);
  }

  // Adapter validation rejects oversized or malformed lengths before any API call.
  for (const byteLength of [MAX_BYTES + 1, 0, 1.5, NaN]) {
    const invalid = part('oversized'); invalid.byteLength = byteLength;
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

  // Values, target row, filenames, page lists and endpoint all describe the initial record.
  {
    const test = fixture(html, { rowIndex: 7, onExport: function (index, current) {
      if (index) return;
      ['tenHuyen', 'tenXaCu', 'tenXaMoi', 'hoTenCSD', 'soHieuToBanDoMoi', 'soThuTuThuaMoi', 'ocrText'].forEach(function (key) {
        current.nodes[key].value = 'changed while exporting';
      });
      current.nodes.webAppUrl.value = 'https://example.invalid/changed-api';
      current.state.selectedRowIndex = 99;
      current.state.documentPages = [{ id: 'another-document' }];
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
  {
    const test = fixture(html, { plans: [[part('a'), part('b')], [part('g')], [part('c')]], onExport: function (_, current) {
      current.nodes.webAppUrl.value = 'https://example.invalid/changed-api';
    } });
    await test.save();
    assert.strictEqual(test.calls[0].url, 'https://example.invalid/initial-api');
    assert.strictEqual(test.calls[1].url, 'https://example.invalid/initial-api');
  }

  // An incomplete backend result retains the exact row for the user's retry instead of appending.
  {
    const test = fixture(html, { onSave: function (attempt) {
      if (attempt === 1) return { success: true, pdfUploadComplete: false, rowIndex: 42,
        warning: 'missing GCN part', fileCCCD: 'https://example.invalid/saved-card' };
      return { success: true, pdfUploadComplete: true, updated: true, rowIndex: 42, fileGCN: 'https://example.invalid/complete' };
    } });
    await test.save();
    assert.strictEqual(test.state.selectedRowIndex, 42);
    assert(test.nodes.btnSaveRecord.textContent.indexOf('Lưu lại') >= 0);
    assert(test.alerts[0].indexOf('missing GCN part') >= 0);
    assert.strictEqual(test.statuses[test.statuses.length - 1].tone, 'error');
    resetAfter(test); imagesRetained(test);
    // Each retry exports a fresh set; emulate another exporter run with the same staged results.
    test.exports.length = 0;
    await test.save();
    assert.strictEqual(saves(test).length, 2);
    assert.strictEqual(saves(test)[1].payload.rowIndex, 42);
    assert.strictEqual(test.state.selectedRowIndex, null);
    resetAfter(test); imagesRetained(test);
  }

  // No endpoint or an already-busy page cannot produce a network write.
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
}

(async function () {
  for (const page of pages) {
    try { await verifyPage(page); }
    catch (error) { error.message = page + ': ' + error.message; throw error; }
  }
  console.log('PASS: all six PDF save flows, scalar/parts payloads, capability gating, staged failures, snapshots and same-row retry');
})().catch(function (error) { console.error(error); process.exitCode = 1; });
