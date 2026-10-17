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
    insertedSheets: 0, createdFolders: 0, files: [],
    beforeAcquire: null, onSave: null, onRelease: null,
    failWrite: false, failFlush: false, failWait: false
  };
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
      getFoldersByName: function () {
        const folders = test.folders.slice();
        return { hasNext: function () { return folders.length > 0; }, next: function () { return folders.shift(); } };
      },
      createFolder: function () {
        assert(test.held, 'Folder creation must hold the script lock');
        assert.strictEqual(test.folders.length, 0, 'Folder was created twice');
        const folder = {}; test.folders.push(folder); test.createdFolders++; return folder;
      }
    }
  });
  vm.runInContext(source, context);
  context.savePdfToDrive = function (folder, data, name) {
    assert(!test.held, 'Slow PDF uploads must not hold the shared script lock');
    const saved = { fileId: 'file-' + (test.files.length + 1), fileUrl: 'local-file-' + (test.files.length + 1) };
    test.files.push({ name: name, data: data, saved: saved });
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
console.log('PASS: concurrent save row/STT ownership, latest fields, unlocked uploads, initialization and lock cleanup');
