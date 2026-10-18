// Run with node tests/server-concurrency.test.js. No network or Google account needed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'code.gs'), 'utf8');

function fixture(options) {
  options = options || {};
  const test = {
    rows: options.rows || (options.sheetMissing ? [] : [new Array(24).fill('HEADER')]),
    sheetExists: !options.sheetMissing,
    folders: options.folderMissing ? [] : [{}],
    held: false, acquired: 0, released: 0, flushed: 0,
    insertedSheets: 0, createdFolders: 0, childFolders: [], files: [],
    beforeAcquire: null, onSave: null, onRelease: null,
    failWrite: false, failFlush: false, failWait: false, failFolderSharing: false
  };
  test.properties = {};
  test.cache = {};
  test.githubCalls = [];
  test.nameLookups = 0;
  test.idLookups = 0;
  test.now = Date.now();
  function rootFolder(folder) {
    if (!folder.getId) folder.getId = function () { return 'root-folder'; };
    folder.createFolder = function (name) {
      assert(!test.held, 'PDF group folder creation must not hold the sheet lock');
      const id = 'folder-' + (test.childFolders.length + 1);
      const child = {
        name: name, shared: false,
        getId: function () { return id; },
        getUrl: function () { return 'local-' + id; },
        setSharing: function () {
          assert(!test.held);
          if (test.failFolderSharing) throw new Error('folder sharing unavailable');
          child.shared = true;
        }
      };
      test.childFolders.push(child);
      return child;
    };
    return folder;
  }
  test.folders.forEach(rootFolder);
  function write() {
    assert(test.held, 'Every sheet mutation must hold the script lock');
    if (test.failWrite) { test.failWrite = false; throw new Error('sheet write failed'); }
  }
  const sheet = {
    getLastRow: function () { return test.rows.length; },
    appendRow: function (row) {
      write(); test.rows.push(Array.from(row));
      if (test.failAppendAfterCommit) { test.failAppendAfterCommit = false; throw new Error('append response lost'); }
    },
    getRange: function (row, column, height, width) {
      assert(Number.isInteger(row) && row > 0 && Number.isInteger(column) && column > 0);
      height = height || 1; width = width || 1;
      return {
        getValues: function () {
          return Array.from({ length: height }, function (_, y) {
            return Array.from({ length: width }, function (_, x) {
              const value = (test.rows[row + y - 1] || [])[column + x - 1];
              return value == null ? '' : value;
            });
          });
        },
        setValues: function (values) {
          write();
          values.forEach(function (cells, y) {
            if (!test.rows[row + y - 1]) test.rows[row + y - 1] = [];
            cells.forEach(function (value, x) { test.rows[row + y - 1][column + x - 1] = value; });
          });
        },
        setValue: function (value) { this.setValues([[value]]); }
      };
    }
  };
  const spreadsheet = {
    getSheetByName: function () { return test.sheetExists ? sheet : null; },
    insertSheet: function () {
      assert(test.held, 'Sheet creation must hold the script lock');
      assert(!test.sheetExists, 'Sheet was created twice');
      test.insertedSheets++; test.sheetExists = true; return sheet;
    }
  };
  const context = vm.createContext({
    clockNow: function () { return test.now; },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: function (algorithm, value) { return Array.from(crypto.createHash(algorithm).update(value).digest()); },
      getUuid: function () { return crypto.randomBytes(16).toString('hex'); },
      base64Encode: function (value) { return Buffer.from(value, 'utf8').toString('base64'); },
      formatDate: function (date, zone, pattern) {
        return pattern === 'yyyy-MM-dd' ? date.toISOString().slice(0, 10) : date.toISOString().replace(/[-:.]/g, '');
      }
    },
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (key) { return test.properties[key] || null; },
          setProperty: function (key, value) {
            assert(test.held, 'Request state mutations need a short lock');
            if (test.onPropertyWrite) test.onPropertyWrite(key, value);
            assert(Buffer.byteLength(value, 'utf8') < 9000, 'Script property exceeds the per-value quota');
            test.properties[key] = value;
          },
          deleteProperty: function (key) { assert(test.held); delete test.properties[key]; }
        };
      }
    },
    CacheService: {
      getScriptCache: function () {
        return {
          get: function (key) { return test.cache[key] || null; },
          put: function (key, value) { test.cache[key] = value; },
          remove: function (key) { delete test.cache[key]; }
        };
      }
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: function (text) {
        return { setMimeType: function () { return this; }, getContent: function () { return text; } };
      }
    },
    UrlFetchApp: {
      fetch: function (url, options) {
        test.githubCalls.push({ url: url, options: options });
        return { getResponseCode: function () { return options.method === 'get' ? 200 : 201; } };
      }
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return spreadsheet; },
      flush: function () {
        assert(test.held, 'Pending sheet writes must flush before unlocking');
        test.flushed++;
        if (test.failFlush) { test.failFlush = false; throw new Error('flush failed'); }
      }
    },
    LockService: {
      getScriptLock: function () {
        let acquired = false;
        return {
          waitLock: function () {
            assert(!test.held, 'Nested script locks would block other users');
            if (test.failWait) { test.failWait = false; throw new Error('lock timeout'); }
            if (test.beforeAcquire) {
              const callback = test.beforeAcquire; test.beforeAcquire = null; callback();
            }
            acquired = true; test.held = true; test.acquired++;
          },
          releaseLock: function () {
            assert(acquired && test.held, 'Releasing a lock not owned by this invocation');
            acquired = false; test.held = false; test.released++;
            if (test.onRelease) {
              const callback = test.onRelease; test.onRelease = null; callback();
            }
          }
        };
      }
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'anyone' }, Permission: { VIEW: 'view' },
      getFoldersByName: function () {
        test.nameLookups++;
        const folders = test.folders.slice();
        return { hasNext: function () { return folders.length > 0; }, next: function () { return folders.shift(); } };
      },
      getFolderById: function (id) {
        test.idLookups++;
        const folder = test.folders.concat(test.childFolders).find(function (item) { return item.getId && item.getId() === id; });
        if (!folder) throw new Error('folder missing');
        return folder;
      },
      createFolder: function () {
        assert(test.held, 'Folder creation must hold the script lock');
        assert.strictEqual(test.folders.length, 0, 'Folder was created twice');
        const folder = rootFolder({}); test.folders.push(folder); test.createdFolders++; return folder;
      }
    }
  });
  vm.runInContext('Date.now = function () { return clockNow(); };', context);
  vm.runInContext(source, context);
  context.savePdfToDrive = function (folder, data, name, inheritsSharing) {
    assert(!test.held, 'Slow PDF uploads must not hold the shared script lock');
    const saved = { fileId: 'file-' + (test.files.length + 1), fileUrl: 'local-file-' + (test.files.length + 1) };
    test.files.push({ name: name, data: data, saved: saved, folder: folder, inheritsSharing: inheritsSharing });
    if (test.onSave) test.onSave(name, saved);
    return saved;
  };
  test.server = context;
  return test;
}

function record() {
  const row = new Array(24).fill('');
  row[0] = 1; row[4] = 'original owner';
  row[13] = 'old GCN'; row[14] = 'old CCCD'; row[15] = 'old card number';
  row[16] = 'original.pdf'; row[17] = 'old file id'; row[18] = 'old file URL';
  row[22] = 'old note'; row[23] = 'Chưa xử lý';
  return row;
}

// A request completing during another user's upload must receive a distinct STT and row.
{
  const test = fixture();
  let second;
  test.onSave = function () {
    test.onSave = null;
    second = test.server.saveScanRecord({ fileName: 'second.pdf', hoTenCSD: 'second owner' });
  };
  const first = test.server.saveScanRecord({ fileName: 'first.pdf', hoTenCSD: 'first owner', pdfGCNBase64: 'AA==' });
  assert.strictEqual(second.rowIndex, 2);
  assert.strictEqual(first.rowIndex, 3);
  assert.strictEqual(test.rows[second.rowIndex - 1][4], 'second owner');
  assert.strictEqual(test.rows[first.rowIndex - 1][4], 'first owner');
  assert.deepStrictEqual(test.rows.slice(1).map(function (row) { return row[0]; }), [1, 2]);
  assert.strictEqual(first.fileGCN, 'local-file-1');
  assert.strictEqual(test.acquired, test.released);
}

// Another append immediately after unlocking cannot change the first response's rowIndex.
{
  const test = fixture();
  let second;
  test.onRelease = function () { second = test.server.saveScanRecord({ hoTenCSD: 'second owner' }); };
  const first = test.server.saveScanRecord({ hoTenCSD: 'first owner' });
  assert.strictEqual(first.rowIndex, 2);
  assert.strictEqual(second.rowIndex, 3);
  assert.strictEqual(test.rows[first.rowIndex - 1][4], 'first owner');
}

// Metadata-only records retain all fields and an actual zero page count without creating Drive files.
{
  const test = fixture();
  const result = test.server.saveScanRecord({ pageCount: 0, tenHuyen: 'Trà Cú', tenXaCu: 'Hàm Giang cũ',
    tenXaMoi: 'Hàm Giang', hoTenCSD: 'Nguyễn Văn Không PDF', soHieuToBanDoMoi: '88',
    soThuTuThuaMoi: '999', dienTich: '123.4', loaiMucDichSuDung: 'ONT', soHieuToBanDoCu: '7',
    soThuTuThuaCu: '77', ap: 'Ấp thử', theChap: 'Không', soCCCD: '012345678901', ocrText: 'Ghi chú đầy đủ' });
  const row = test.rows[result.rowIndex - 1];
  assert.deepStrictEqual(row.slice(1, 13), ['Trà Cú', 'Hàm Giang cũ', 'Hàm Giang', 'Nguyễn Văn Không PDF', '88', '999',
    '123.4', 'ONT', '7', '77', 'Ấp thử', 'Không']);
  assert.strictEqual(row[15], '012345678901');
  assert.strictEqual(row[19], '0');
  assert.strictEqual(row[22], 'Ghi chú đầy đủ');
  assert.strictEqual(test.files.length, 0);
  assert(result.serverTiming);
  ['validationMs', 'driveMs', 'sheetMs', 'totalMs'].forEach(function (key) {
    assert(Number.isFinite(result.serverTiming[key]) && result.serverTiming[key] >= 0, 'Invalid server timing: ' + key);
  });
}

// Reread after upload: retain other users' latest notes, status, card number and other PDF.
{
  const test = fixture({ rows: [new Array(24).fill('HEADER'), record()] });
  test.onSave = function () {
    test.onSave = null;
    test.server.updateRecordNotes({ rowIndex: 2, ocrText: 'new note from another user' });
    test.server.updateProcessingStatus({ rowIndex: 2, status: 'Đã xử lý' });
    test.server.saveScanRecord({ rowIndex: 2, fileName: 'other.pdf', pdfCCCDBase64: 'BB==', soCCCD: 'new card number' });
  };
  const result = test.server.saveScanRecord({ rowIndex: 2, fileName: 'gcn.pdf', pdfGCNBase64: 'AA==' });
  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.rowIndex, 2);
  assert.strictEqual(result.fileGCN, 'local-file-1');
  assert.strictEqual(result.fileCCCD, 'local-file-2');
  assert.strictEqual(result.soCCCD, 'new card number');
  assert.strictEqual(result.fileId, 'old file id');
  assert.strictEqual(result.fileUrl, 'old file URL');
  assert.strictEqual(test.rows[1][22], 'new note from another user');
  assert.strictEqual(test.rows[1][23], 'Đã xử lý');
  assert.strictEqual(test.rows[1][0], 1);
  assert.strictEqual(test.rows.length, 2);
  assert.strictEqual(test.acquired, test.released);
}

// Failed optional uploads retain latest links and warnings; original naming/precedence stays intact.
{
  const test = fixture({ rows: [new Array(24).fill('HEADER'), record()] });
  test.onSave = function (name, saved) {
    if (name === 'original-backup.pdf') saved.sharingWarning = 'sharing unavailable';
    if (name === 'card.pdf') throw new Error('card upload failed');
  };
  const result = test.server.saveScanRecord({ rowIndex: 2, fileName: 'gcn.pdf', fileNameOriginal: 'original-backup.pdf',
    fileNameCCCD: 'card.pdf', pdfOriginalBase64: 'AA==', pdfBase64: 'BB==', pdfCCCDBase64: 'CC==' });
  assert.strictEqual(result.originalBackupSaved, true);
  assert.strictEqual(result.fileId, 'file-1');
  assert.strictEqual(result.fileUrl, 'local-file-1');
  assert.strictEqual(result.fileGCN, 'local-file-2');
  assert.strictEqual(result.fileCCCD, 'old CCCD');
  assert.strictEqual(test.rows[1][16], 'original-backup.pdf');
  assert(result.warning.indexOf('sharing unavailable') >= 0);
  assert(result.warning.indexOf('card upload failed') >= 0);
}

// A competing first-run initialization completes while this request waits for the creation lock.
{
  const test = fixture({ sheetMissing: true, folderMissing: true });
  test.beforeAcquire = function () { test.sheetExists = true; test.rows.push(new Array(24).fill('HEADER')); };
  test.server.ensureSheet();
  assert.strictEqual(test.insertedSheets, 0);
  assert.strictEqual(test.rows.length, 1);
  const folder = {};
  test.beforeAcquire = function () { test.folders.push(folder); };
  assert.strictEqual(test.server.ensureFolder(), folder);
  assert.strictEqual(test.createdFolders, 0);
  assert.strictEqual(test.acquired, test.released);
}
{
  const test = fixture({ sheetMissing: true, folderMissing: true });
  test.server.ensureSheet(); test.server.ensureSheet();
  test.server.ensureFolder(); test.server.ensureFolder();
  assert.strictEqual(test.insertedSheets, 1);
  assert.strictEqual(test.createdFolders, 1);
  assert.strictEqual(test.rows[0].length, 24);
  assert.strictEqual(test.acquired, 2);
  assert.strictEqual(test.acquired, test.released);
}

// Release on write, validation or flush failure; a failed acquisition must not release another lock.
['failWrite', 'failFlush'].forEach(function (failure) {
  const test = fixture(); test[failure] = true;
  assert.throws(function () { test.server.saveScanRecord({ hoTenCSD: 'owner' }); }, /failed/);
  assert.strictEqual(test.held, false);
  assert.strictEqual(test.acquired, test.released);
  assert.strictEqual(test.flushed, 1);
  test.server.saveScanRecord({ hoTenCSD: 'next owner' });
  assert.strictEqual(test.held, false);
});
{
  const test = fixture();
  assert.throws(function () { test.server.updateProcessingStatus({ rowIndex: 5, status: 'Đã xử lý' }); });
  assert.throws(function () { test.server.updateRecordNotes({ rowIndex: 5, ocrText: 'note' }); });
  assert.strictEqual(test.acquired, test.released);
  assert.strictEqual(test.held, false);
}
{
  const test = fixture(); test.failWait = true;
  assert.throws(function () { test.server.saveScanRecord({}); }, /lock timeout/);
  assert.strictEqual(test.acquired, 0);
  assert.strictEqual(test.released, 0);
  assert.strictEqual(test.flushed, 0);
  assert.strictEqual(test.rows.length, 1);
}
function parts(prefix) {
  return [
    { fileName: prefix + '_part_001.pdf', base64: 'data:application/pdf;base64,AA==' },
    { fileName: prefix + '_part_002.pdf', base64: 'BB==' }
  ];
}

// Old single-file clients keep file URLs/names; empty part arrays are harmless.
{
  const test = fixture();
  const result = test.server.saveScanRecord({ fileName: 'legacy.pdf', pdfGCNBase64: 'AA==', pdfGCNFiles: [] });
  assert.strictEqual(result.fileGCN, 'local-file-1');
  assert.strictEqual(test.files[0].name, 'legacy.pdf');
  assert.strictEqual(test.childFolders.length, 0);
  assert.strictEqual(result.pdfUploadComplete, true);
  assert.strictEqual(result.pdfPartCounts.gcn, 1);
}

// Every group retains part order and returns only its own complete, shareable folder.
{
  const test = fixture();
  const result = test.server.saveScanRecord({ fileName: 'main.pdf', fileNameOriginal: 'backup.pdf',
    pdfOriginalFiles: parts('original'), pdfGCNFiles: parts('gcn'), pdfCCCDFiles: parts('cccd') });
  assert.strictEqual(test.childFolders.length, 3);
  assert.deepStrictEqual(test.files.map(function (file) { return file.name; }), [
    'original_part_001.pdf', 'original_part_002.pdf', 'gcn_part_001.pdf', 'gcn_part_002.pdf', 'cccd_part_001.pdf', 'cccd_part_002.pdf'
  ]);
  test.files.forEach(function (file, index) { assert.strictEqual(file.folder, test.childFolders[Math.floor(index / 2)]); });
  assert(test.childFolders.every(function (folder) { return folder.shared; }));
  assert(test.files.every(function (file) { return file.inheritsSharing === true; }),
    'Files inherit public view from their successfully shared part folder');
  assert.strictEqual(result.originalBackupSaved, true);
  assert.strictEqual(result.fileId, 'folder-1');
  assert.strictEqual(result.fileUrl, 'local-folder-1');
  assert.strictEqual(result.fileGCN, 'local-folder-2');
  assert.strictEqual(result.fileCCCD, 'local-folder-3');
  assert.strictEqual(test.rows[1][13], 'local-folder-2');
  assert.strictEqual(test.rows[1][14], 'local-folder-3');
  assert.strictEqual(test.rows[1][16], 'backup.pdf');
  assert.strictEqual(result.pdfUploadComplete, true);
  assert.strictEqual(result.incompletePdfGroups.length, 0);
  assert.strictEqual(result.pdfPartCounts.original, 2);
  assert.strictEqual(result.pdfPartCounts.gcn, 2);
  assert.strictEqual(result.pdfPartCounts.cccd, 2);
}

// Two users saving identical names during an upload never share a group folder.
{
  const test = fixture();
  let second;
  test.onSave = function () {
    test.onSave = null;
    second = test.server.saveScanRecord({ fileName: 'same.pdf', pdfGCNFiles: parts('same') });
  };
  const first = test.server.saveScanRecord({ fileName: 'same.pdf', pdfGCNFiles: parts('same') });
  assert.strictEqual(test.childFolders.length, 2);
  assert.notStrictEqual(first.fileGCN, second.fileGCN);
  assert.strictEqual(first.fileGCN, 'local-folder-1');
  assert.strictEqual(second.fileGCN, 'local-folder-2');
  assert.strictEqual(first.rowIndex, 3);
  assert.strictEqual(second.rowIndex, 2);
  assert.strictEqual(test.files.filter(function (file) { return file.folder === test.childFolders[0]; }).length, 2);
  assert.strictEqual(test.files.filter(function (file) { return file.folder === test.childFolders[1]; }).length, 2);
  assert.strictEqual(test.acquired, test.released);
}

// A partial group is not published as complete and never replaces a prior valid link.
{
  const test = fixture({ rows: [new Array(24).fill('HEADER'), record()] });
  test.onSave = function (name) { if (name === 'gcn_part_002.pdf') throw new Error('second part failed'); };
  const result = test.server.saveScanRecord({ rowIndex: 2, pdfGCNFiles: parts('gcn'), pdfCCCDBase64: 'CC==' });
  assert.strictEqual(result.pdfUploadComplete, false);
  assert.strictEqual(result.incompletePdfGroups[0], 'gcn');
  assert.strictEqual(result.fileGCN, 'old GCN');
  assert.strictEqual(test.rows[1][13], 'old GCN');
  assert.strictEqual(result.fileCCCD, 'local-file-3');
  assert.strictEqual(result.pdfPartCounts.gcn, 0);
  assert.strictEqual(result.pdfPartCounts.cccd, 1);
  assert(result.warning.indexOf('1/2') >= 0);
  assert(result.warning.indexOf('gcn_part_002.pdf') >= 0);
  assert(result.message.indexOf('chưa được lưu đầy đủ') >= 0);
}
{
  const test = fixture({ rows: [new Array(24).fill('HEADER'), record()] });
  test.onSave = function (name) { if (name === 'original_part_002.pdf') throw new Error('backup part failed'); };
  const result = test.server.saveScanRecord({ rowIndex: 2, pdfOriginalFiles: parts('original'), pdfGCNBase64: 'CC==' });
  assert.strictEqual(result.originalBackupSaved, false);
  assert.strictEqual(result.pdfUploadComplete, false);
  assert.strictEqual(result.incompletePdfGroups[0], 'original');
  assert.strictEqual(result.fileId, 'old file id');
  assert.strictEqual(result.fileUrl, 'old file URL');
  assert.strictEqual(result.pdfPartCounts.original, 0);
}
{
  const test = fixture(); test.failFolderSharing = true;
  const result = test.server.saveScanRecord({ pdfGCNFiles: parts('gcn') });
  assert.strictEqual(result.pdfUploadComplete, true);
  assert.strictEqual(result.fileGCN, 'local-folder-1');
  assert(result.warning.indexOf('folder sharing unavailable') >= 0);
  assert(test.files.every(function (file) { return file.inheritsSharing === false; }),
    'Individual file sharing remains enabled when sharing the folder fails');
}

// Size is decoded PDF bytes, including correct base64 padding, not JSON/data URI length.
{
  const test = fixture();
  const exact = Buffer.alloc(10000000, 1).toString('base64');
  const files = test.server.normalizePdfUploadGroup(null, 'data:application/pdf;base64,' + exact, 'exact.pdf', 'GCN');
  assert.strictEqual(files[0].byteLength, 10000000);
  assert.strictEqual(test.server.normalizePdfUploadGroup(null, 'AAA=', 'two.pdf', 'GCN')[0].byteLength, 2);
  assert.strictEqual(test.server.normalizePdfUploadGroup(null, 'AAAA', 'three.pdf', 'GCN')[0].byteLength, 3);
  assert.strictEqual(test.server.normalizePdfUploadGroup(null, 'AA', 'unpadded.pdf', 'GCN')[0].byteLength, 1);
}

// Reject an oversized LATER group before saving an earlier valid group or creating anything.
{
  const test = fixture({ sheetMissing: true, folderMissing: true });
  const oversized = Buffer.alloc(10000001, 1).toString('base64');
  assert.throws(function () {
    test.server.saveScanRecord({ pdfOriginalBase64: 'AA==', pdfGCNFiles: [
      { fileName: 'small.pdf', base64: 'AA==' }, { fileName: 'large.pdf', base64: oversized }
    ] });
  }, /10 MB.*10000001/);
  assert.strictEqual(test.sheetExists, false);
  assert.strictEqual(test.folders.length, 0);
  assert.strictEqual(test.files.length, 0);
  assert.strictEqual(test.acquired, 0);
  assert.throws(function () { test.server.saveScanRecord({ pdfGCNBase64: oversized }); }, /10 MB/);
  assert.strictEqual(test.acquired, 0);
}

// Malformed later parts also cannot leave an earlier uploaded group behind.
[
  { pdfOriginalBase64: 'AA==', pdfCCCDFiles: [{ fileName: 'one.pdf', base64: 'AA==' }, { fileName: 'two.pdf', base64: 'not base64!' }] },
  { pdfGCNFiles: [{ fileName: 'one.pdf', base64: 'AA==' }, { base64: 'AA==' }] },
  { pdfGCNFiles: 'not an array' },
  { pdfGCNFiles: [{ fileName: 'one.pdf', base64: 'AA==' }] },
  { pdfGCNFiles: parts('gcn'), pdfGCNBase64: 'AA==' }
].forEach(function (payload) {
  const test = fixture({ sheetMissing: true, folderMissing: true });
  assert.throws(function () { test.server.saveScanRecord(payload); });
  assert.strictEqual(test.files.length, 0);
  assert.strictEqual(test.sheetExists, false);
  assert.strictEqual(test.acquired, 0);
});

// Clients can detect an outdated Apps Script before attempting a split upload.
{
  const test = fixture({ sheetMissing: true, folderMissing: true });
  const get = JSON.parse(test.server.doGet().getContent());
  const ping = JSON.parse(test.server.doPost({ postData: { contents: JSON.stringify({ action: 'PING', payload: {} }) } }).getContent());
  [get, ping].forEach(function (reply) {
    assert.strictEqual(reply.success, true);
    assert.strictEqual(reply.pdfUploadVersion, 2);
    assert.strictEqual(reply.supportsPdfParts, true);
    assert.strictEqual(reply.maxPdfBytes, 10000000);
  });
  assert.strictEqual(test.sheetExists, false);
  assert.strictEqual(test.acquired, 0);
}
console.log('PASS: concurrent row ownership, PDF part folders/order/isolation, 10 MB validation before writes, partial failures and lock cleanup');

function retryPayload(overrides) {
  return Object.assign({ saveRequestId: 'save_request_0123456789',
    pdfGroupKeys: { original: 'session:original:1', gcn: 'session:gcn:1' },
    fileName: 'retry.pdf', fileNameOriginal: 'retry-original.pdf',
    hoTenCSD: 'retry owner', createdAt: '2026-10-17T10:00:00.000Z',
    pdfOriginalBase64: 'AA==', pdfGCNBase64: 'BB==' }, overrides || {});
}

// Editing metadata alone keeps the real backup filename and existing Drive links.
{
  const test = fixture({ rows: [new Array(24).fill('HEADER'), record()] });
  const result = test.server.saveScanRecord({ rowIndex: 2, saveRequestId: 'metadata_only_request_0123456789',
    pdfGroupKeys: {}, fileName: 'unused-new-GCN-name.pdf', hoTenCSD: 'updated owner' });
  assert.strictEqual(result.pdfUploadComplete, true);
  assert.strictEqual(test.rows[1][16], 'original.pdf');
  assert.strictEqual(result.fileGCN, 'old GCN');
  assert.strictEqual(result.fileCCCD, 'old CCCD');
  assert.strictEqual(test.files.length, 0);
  assert.strictEqual(test.nameLookups, 0);
}

// A response lost after saving can be retried with all bytes, without extra rows/files.
{
  const test = fixture();
  const payload = retryPayload();
  const first = test.server.saveScanRecord(payload);
  const lockCount = test.acquired;
  const repeated = test.server.saveScanRecord(payload);
  assert.strictEqual(first.pdfUploadComplete, true);
  assert.strictEqual(first.saveRequestId, payload.saveRequestId);
  assert.strictEqual(first.savedPdfGroupKeys.original, 'session:original:1');
  assert.strictEqual(repeated.replayed, true);
  assert.strictEqual(repeated.rowIndex, first.rowIndex);
  assert.strictEqual(test.files.length, 2);
  assert.strictEqual(test.rows.length, 2);
  assert.strictEqual(test.acquired, lockCount + 1, 'Replay only needs its short claim lock');
  assert.strictEqual(test.acquired, test.released);
}

// Retry an interrupted multipart group from its next part; omit acknowledged groups.
{
  const test = fixture();
  let fail = true;
  test.onSave = function (name) {
    if (name === 'gcn_part_002.pdf' && fail) { fail = false; throw new Error('network interrupted'); }
  };
  const payload = retryPayload({ pdfGCNBase64: '', pdfGCNFiles: parts('gcn') });
  const partial = test.server.saveScanRecord(payload);
  assert.strictEqual(partial.pdfUploadComplete, false);
  assert.strictEqual(partial.savedPdfGroupKeys.original, 'session:original:1');
  assert.strictEqual(partial.savedPdfGroupKeys.gcn, undefined);
  assert.strictEqual(test.files.length, 3);
  const result = test.server.saveScanRecord(Object.assign({}, payload, {
    rowIndex: partial.rowIndex, pdfOriginalBase64: ''
  }));
  assert.strictEqual(result.pdfUploadComplete, true);
  assert.strictEqual(result.rowIndex, partial.rowIndex);
  assert.strictEqual(result.originalBackupSaved, true);
  assert.strictEqual(result.pdfPartCounts.original, 1);
  assert.strictEqual(result.pdfPartCounts.gcn, 2);
  assert.strictEqual(test.files.length, 4);
  assert.strictEqual(test.files.filter(function (file) { return file.name === 'gcn_part_001.pdf'; }).length, 1);
  assert.strictEqual(test.childFolders.length, 1, 'Retries reuse only their own part folder');
  assert.strictEqual(test.rows.length, 2);
  assert.strictEqual(test.acquired, test.released);
}

// Retry after an upload succeeded but its caller did not receive the partial response.
{
  const test = fixture();
  let fail = true;
  test.onSave = function (name) {
    if (name === 'retry.pdf' && fail) { fail = false; throw new Error('temporary Drive failure'); }
  };
  const payload = retryPayload();
  const partial = test.server.saveScanRecord(payload);
  assert.strictEqual(partial.pdfUploadComplete, false);
  const completed = test.server.saveScanRecord(payload);
  assert.strictEqual(completed.pdfUploadComplete, true);
  assert.strictEqual(test.files.filter(function (file) { return file.name === 'retry-original.pdf'; }).length, 1);
  assert.strictEqual(test.rows.length, 2);
  assert.strictEqual(completed.rowIndex, partial.rowIndex);
}

// Retrying an old partial save cannot revert links another user has since updated.
{
  const test = fixture();
  let fail = true;
  test.onSave = function (name) {
    if (name === 'retry-card.pdf' && fail) { fail = false; throw new Error('card unavailable'); }
  };
  const payload = retryPayload({ pdfGroupKeys: { original: 'session:original:1', gcn: 'session:gcn:1', cccd: 'session:cccd:1' },
    fileNameCCCD: 'retry-card.pdf', pdfCCCDBase64: 'CC==' });
  const partial = test.server.saveScanRecord(payload);
  assert.strictEqual(partial.pdfUploadComplete, false);
  const other = test.server.saveScanRecord({ rowIndex: partial.rowIndex, fileName: 'newer-gcn.pdf',
    fileNameOriginal: 'newer-original.pdf', pdfOriginalBase64: 'DD==', pdfGCNBase64: 'EE==' });
  const recovered = test.server.saveScanRecord(Object.assign({}, payload, { pdfOriginalBase64: '', pdfGCNBase64: '' }));
  assert.strictEqual(recovered.pdfUploadComplete, true);
  assert.strictEqual(recovered.rowIndex, partial.rowIndex);
  assert.strictEqual(recovered.fileGCN, other.fileGCN, 'A cached prior group must not revert a later user\'s PDF link');
  assert.strictEqual(recovered.fileId, other.fileId);
  assert.strictEqual(recovered.fileUrl, other.fileUrl);
  assert.strictEqual(test.rows[recovered.rowIndex - 1][16], 'newer-original.pdf');
  assert.strictEqual(test.rows.length, 2);
}

// The same request cannot run concurrently; a different user's request remains independent.
{
  const test = fixture();
  const payload = retryPayload();
  let duplicate, other;
  test.onSave = function () {
    test.onSave = null;
    duplicate = test.server.saveScanRecord(payload);
    other = test.server.saveScanRecord(retryPayload({ saveRequestId: 'different_request_0123456789', hoTenCSD: 'other owner' }));
  };
  const first = test.server.saveScanRecord(payload);
  assert.strictEqual(duplicate.success, false);
  assert.strictEqual(duplicate.code, 'SAVE_IN_PROGRESS');
  assert.strictEqual(duplicate.retryAfterMs, 2500);
  assert.notStrictEqual(first.rowIndex, other.rowIndex);
  assert.strictEqual(test.rows.length, 3);
  assert.strictEqual(test.files.length, 4);
  assert.strictEqual(test.acquired, test.released);
}

// Metadata/group revisions need a new ID; missing old state cannot silently omit files.
{
  const test = fixture();
  const payload = retryPayload();
  test.server.saveScanRecord(payload);
  const changed = test.server.saveScanRecord(Object.assign({}, payload, { hoTenCSD: 'different owner' }));
  assert.strictEqual(changed.code, 'SAVE_REQUEST_CHANGED');
  const changedGroup = test.server.saveScanRecord(Object.assign({}, payload, {
    pdfGroupKeys: { original: 'session:original:2', gcn: 'session:gcn:1' }
  }));
  assert.strictEqual(changedGroup.code, 'SAVE_REQUEST_CHANGED');
  const missing = test.server.saveScanRecord(Object.assign({}, payload, {
    saveRequestId: 'unknown_request_0123456789', pdfOriginalBase64: ''
  }));
  assert.strictEqual(missing.code, 'SAVE_RETRY_EXPIRED');
  assert.strictEqual(test.rows.length, 2);
  assert.strictEqual(test.files.length, 2);
  assert.strictEqual(test.acquired, test.released);
}

// A completed append whose response throws is reconciled from the saved row intent.
{
  const test = fixture(); test.failAppendAfterCommit = true;
  const payload = retryPayload();
  assert.throws(function () { test.server.saveScanRecord(payload); }, /append response lost/);
  assert.strictEqual(test.rows.length, 2);
  test.rows[1][19] = Number(test.rows[1][19]); // Sheets may return a numeric string as a number.
  const recovered = test.server.saveScanRecord(payload);
  assert.strictEqual(recovered.rowIndex, 2);
  assert.strictEqual(test.rows.length, 2);
  assert.strictEqual(test.files.length, 2);
  assert.strictEqual(test.held, false);
}

// A journal error after the append preserves its earlier row intent for recovery.
{
  const test = fixture();
  const payload = retryPayload();
  test.onPropertyWrite = function (key, value) {
    if (key.indexOf('SCAN_SAVE_V1_') !== 0 || !JSON.parse(value).rowCommitted) return;
    test.onPropertyWrite = null;
    throw new Error('journal unavailable after append');
  };
  assert.throws(function () { test.server.saveScanRecord(payload); }, /journal unavailable/);
  assert.strictEqual(test.rows.length, 2);
  const recovered = test.server.saveScanRecord(payload);
  assert.strictEqual(recovered.rowIndex, 2);
  assert.strictEqual(test.rows.length, 2);
  assert.strictEqual(test.files.length, 2);
  assert.strictEqual(test.acquired, test.released);
}

// A failed append may leave a row intent that another user later occupies. Never overwrite it.
{
  const test = fixture(); test.failWrite = true;
  const payload = retryPayload();
  assert.throws(function () { test.server.saveScanRecord(payload); }, /sheet write failed/);
  test.server.saveScanRecord({ hoTenCSD: 'other owner' });
  const recovered = test.server.saveScanRecord(payload);
  assert.strictEqual(recovered.rowIndex, 3);
  assert.strictEqual(test.rows[1][4], 'other owner');
  assert.strictEqual(test.rows[2][4], 'retry owner');
  assert.strictEqual(test.files.length, 2);
}

// Flush errors cannot publish a completed replay before the sheet transaction succeeds.
{
  const test = fixture(); test.failFlush = true;
  const payload = retryPayload();
  assert.throws(function () { test.server.saveScanRecord(payload); }, /flush failed/);
  const state = JSON.parse(test.properties['SCAN_SAVE_V1_' + payload.saveRequestId]);
  assert.strictEqual(state.result, undefined);
  assert.strictEqual(state.leaseUntil, 0);
  const recovered = test.server.saveScanRecord(payload);
  assert.strictEqual(recovered.pdfUploadComplete, true);
  assert.strictEqual(recovered.replayed, undefined);
  assert.strictEqual(recovered.rowIndex, 2);
  assert.strictEqual(test.rows.length, 2);
  assert.strictEqual(test.files.length, 2);
}

// Folder cache tolerates stale IDs/permissions and retains the name-search fallback.
{
  const test = fixture();
  const first = test.server.ensureFolder();
  assert.strictEqual(test.nameLookups, 1);
  assert.strictEqual(test.server.ensureFolder(), first);
  assert.strictEqual(test.nameLookups, 1);
  assert.strictEqual(test.idLookups, 1);
  test.cache.SCAN_ROOT_FOLDER_V1 = 'deleted-folder';
  assert.strictEqual(test.server.ensureFolder(), first);
  assert.strictEqual(test.nameLookups, 2);
  assert.strictEqual(test.cache.SCAN_ROOT_FOLDER_V1, 'root-folder');
}

// Keep the journal bounded; active leases are not evicted by unrelated saves.
{
  const test = fixture();
  for (let index = 0; index < 70; index++) {
    const result = test.server.saveScanRecord({ saveRequestId: ('bounded_request_' + String(index).padStart(8, '0')).padEnd(100, '_'),
      hoTenCSD: 'owner ' + index });
    assert.strictEqual(result.success, true);
  }
  const retained = JSON.parse(test.properties.SCAN_SAVE_INDEX_V1);
  assert.strictEqual(retained.length, 64);
  assert.strictEqual(Object.keys(test.properties).filter(function (key) { return key.indexOf('SCAN_SAVE_V1_') === 0; }).length, 64);
  assert.strictEqual(test.acquired, test.released);
}

{
  const test = fixture();
  const ping = JSON.parse(test.server.doPost({ postData: { contents: JSON.stringify({ action: 'PING' }) } }).getContent());
  assert.strictEqual(ping.supportsSaveRetry, true);
  assert.strictEqual(ping.supportsSaveStatus, true);
  assert.strictEqual(ping.saveRequestVersion, 1);
  ['bad id', 'short', 'id_with_disallowed_!'].forEach(function (id) {
    assert.throws(function () { test.server.saveScanRecord(retryPayload({ saveRequestId: id })); }, /Mã lượt lưu/);
  });
  assert.strictEqual(test.files.length, 0);
  assert.strictEqual(test.rows.length, 1);
}

// Status checks are read-only and reveal completed groups during a running save.
{
  const test = fixture();
  const payload = retryPayload();
  let during;
  test.onSave = function (name) {
    if (name !== 'retry.pdf') return;
    const acquisitions = test.acquired;
    const snapshot = JSON.stringify(test.properties);
    during = JSON.parse(test.server.doPost({ postData: { contents: JSON.stringify({
      action: 'SAVE_STATUS', payload: { saveRequestId: payload.saveRequestId }
    }) } }).getContent());
    assert.strictEqual(test.acquired, acquisitions);
    assert.strictEqual(JSON.stringify(test.properties), snapshot);
  };
  const complete = test.server.saveScanRecord(payload);
  assert.strictEqual(during.processing, true);
  assert.strictEqual(during.rowIndex, 0);
  assert.strictEqual(during.pdfUploadComplete, false);
  assert.strictEqual(during.savedPdfGroupKeys.original, 'session:original:1');
  assert.strictEqual(during.savedPdfGroupKeys.gcn, undefined);
  const status = test.server.getSaveRequestStatus({ saveRequestId: payload.saveRequestId });
  assert.strictEqual(status.processing, false);
  assert.strictEqual(status.replayed, true);
  assert.strictEqual(status.rowIndex, complete.rowIndex);
  assert.strictEqual(status.fileGCN, complete.fileGCN);
  assert.strictEqual(status.pdfUploadComplete, true);
  const locks = test.acquired;
  test.now += 25 * 60 * 60 * 1000;
  assert.strictEqual(test.server.getSaveRequestStatus({ saveRequestId: payload.saveRequestId }).code, 'SAVE_RETRY_EXPIRED');
  assert.strictEqual(test.acquired, locks);
}

// A partial response lost on the network can be recovered using only its small ID.
{
  const test = fixture();
  const payload = retryPayload();
  test.onSave = function (name) { if (name === 'retry.pdf') throw new Error('Drive unavailable'); };
  const partial = test.server.saveScanRecord(payload);
  const status = test.server.getSaveRequestStatus({ saveRequestId: payload.saveRequestId });
  assert.strictEqual(status.processing, false);
  assert.strictEqual(status.rowIndex, partial.rowIndex);
  assert.strictEqual(status.savedPdfGroupKeys.original, 'session:original:1');
  assert.strictEqual(status.incompletePdfGroups[0], 'gcn');
  assert.strictEqual(status.originalBackupSaved, true);
}

{
  const test = fixture({ sheetMissing: true, folderMissing: true });
  const status = test.server.getSaveRequestStatus({ saveRequestId: 'unknown_request_0123456789' });
  assert.strictEqual(status.code, 'SAVE_RETRY_EXPIRED');
  assert.strictEqual(test.acquired, 0);
  assert.strictEqual(test.sheetExists, false);
  assert.strictEqual(test.folders.length, 0);
  assert.strictEqual(Object.keys(test.properties).length, 0);
}

// Even at journal capacity no unfinished user's lease may be evicted.
{
  const test = fixture();
  for (let index = 0; index < 64; index++) {
    const claim = test.server.beginSaveRequest({ saveRequestId: ('active_request_' + index).padEnd(100, '_') },
      { original: [], gcn: [], cccd: [] }, '2026-10-17T10:00:00Z');
    assert(claim.state);
  }
  const snapshot = JSON.stringify(test.properties);
  const extra = test.server.beginSaveRequest({ saveRequestId: 'one_more_request_0123456789' },
    { original: [], gcn: [], cccd: [] }, '2026-10-17T10:00:00Z');
  assert.strictEqual(extra.reply.code, 'SAVE_BUSY');
  assert.strictEqual(JSON.stringify(test.properties), snapshot);
  assert(Buffer.byteLength(test.properties.SCAN_SAVE_INDEX_V1, 'utf8') < 9000);
}

// Performance logs require a one-use token issued by a completed save and only contain allowlisted diagnostics.
{
  const test = fixture();
  test.properties.GITHUB_LOG_TOKEN = 'server-secret-token';
  test.properties.GITHUB_LOG_REPOSITORY = 'owner/repository';
  assert.strictEqual(test.server.authorizeGitHubPerformanceLogging().success, true);
  assert.strictEqual(test.githubCalls.length, 1);
  test.githubCalls.length = 0;
  const saved = test.server.saveScanRecord({ hoTenCSD: 'Private owner', pageCount: 0 });
  assert(/^[A-Za-z0-9_-]{20,100}$/.test(saved.performanceLogToken));
  const payload = { logToken: saved.performanceLogToken, page: 'HamGiang', eventId: 'event_0123456789012345',
    result: 'success', totalMs: 1234, requestMs: 900, outputDpi: 300,
    hoTenCSD: 'Private owner', soCCCD: '987654321098',
    ocrText: 'Private note', apiUrl: 'https://secret.invalid' };
  const logged = test.server.writePerformanceLogToGitHub(payload);
  assert.strictEqual(logged.success, true);
  assert.strictEqual(test.githubCalls.length, 1);
  assert(test.githubCalls[0].url.includes('/owner/repository/contents/performance-logs/'));
  assert.strictEqual(test.githubCalls[0].options.headers.Authorization, 'Bearer server-secret-token');
  const body = JSON.parse(test.githubCalls[0].options.payload);
  const content = Buffer.from(body.content, 'base64').toString('utf8');
  assert(content.includes('"totalMs": 1234'));
  assert(content.includes('"outputDpi": 300'));
  ['Private owner', '987654321098', 'Private note', 'secret.invalid', 'server-secret-token'].forEach(function (privateValue) {
    assert(!content.includes(privateValue), 'Private value leaked to GitHub: ' + privateValue);
  });
  assert.strictEqual(test.server.writePerformanceLogToGitHub(payload).success, false, 'A log token is one-use only');
  assert.strictEqual(test.githubCalls.length, 1);
}
console.log('PASS: idempotent save replay, resumable parts/groups, exclusive per-request leases, row/flush recovery and cached folder lookup');
