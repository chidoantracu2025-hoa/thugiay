// Run with node tests/server-concurrency.test.js. No network or Google account needed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
  function rootFolder(folder) {
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
    appendRow: function (row) { write(); test.rows.push(Array.from(row)); },
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
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: function (text) {
        return { setMimeType: function () { return this; }, getContent: function () { return text; } };
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
        const folders = test.folders.slice();
        return { hasNext: function () { return folders.length > 0; }, next: function () { return folders.shift(); } };
      },
      createFolder: function () {
        assert(test.held, 'Folder creation must hold the script lock');
        assert.strictEqual(test.folders.length, 0, 'Folder was created twice');
        const folder = rootFolder({}); test.folders.push(folder); test.createdFolders++; return folder;
      }
    }
  });
  vm.runInContext(source, context);
  context.savePdfToDrive = function (folder, data, name) {
    assert(!test.held, 'Slow PDF uploads must not hold the shared script lock');
    const saved = { fileId: 'file-' + (test.files.length + 1), fileUrl: 'local-file-' + (test.files.length + 1) };
    test.files.push({ name: name, data: data, saved: saved, folder: folder });
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
