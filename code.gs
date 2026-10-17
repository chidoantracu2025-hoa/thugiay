const SHEET_NAME = 'Du_Lieu';
const DRIVE_FOLDER_NAME = 'Ho_So_Dat_Dai';
const MAX_PDF_BYTES = 10000000;

const HEADER_ROW = [
  'STT', 'Tên huyện', 'Tên xã cũ', 'Tên xã mới', 'Họ Tên CSD',
  'Số hiệu tờ bản đồ mới', 'Số thứ tự thửa mới', 'Diện tích', 'Loại mục đích sử dụng',
  'Số hiệu tờ bản đồ cũ', 'Số thứ tự thửa cũ', 'Ấp', 'Thế chấp',
  'File GCN', 'File CCCD', 'Số CCCD', 'fileName', 'fileId',
  'fileUrl', 'pageCount', 'createdAt', 'source', 'Ghi chú', 'Tình trạng xử lý'
];

function doGet() {
  return jsonResponse(Object.assign({
    success: true,
    message: 'Google Apps Script API đang hoạt động mượt mà.',
    sheet: SHEET_NAME,
    folder: DRIVE_FOLDER_NAME
  }, pdfUploadCapabilities()));
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const data = JSON.parse(raw);
    const action = String(data.action || '').toUpperCase();
    const payload = data.payload || data || {};

    switch (action) {
      case 'PING':
        return jsonResponse(Object.assign({ success: true, message: 'API OK' }, pdfUploadCapabilities()));
      case 'SEARCH':
        return jsonResponse(searchRecords(payload));
      case 'SAVE_SCAN':
        return jsonResponse(saveScanRecord(payload));
      case 'UPDATE_NOTES':
        return jsonResponse(updateRecordNotes(payload));
      case 'LIST':
        return jsonResponse(listRecords(payload));
      case 'REPORT':
        return jsonResponse(reportRecords(payload));
      case 'UPDATE_PROCESSING_STATUS':
        return jsonResponse(updateProcessingStatus(payload));
      default:
        return jsonResponse({ success: false, error: 'Action không hợp lệ: ' + action });
    }
  } catch (error) {
    return jsonResponse({ success: false, error: error && error.toString ? error.toString() : String(error) });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function pdfUploadCapabilities() {
  return { pdfUploadVersion: 2, supportsPdfParts: true, maxPdfBytes: MAX_PDF_BYTES };
}

function withScriptLock(callback, flushSpreadsheet) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    try {
      if (flushSpreadsheet) SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  }
}

function ensureSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet && sheet.getLastRow() > 0) return sheet;
  return withScriptLock(function () {
    const current = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (!current.getLastRow()) current.appendRow(HEADER_ROW);
    return current;
  }, true);
}

function ensureFolder() {
  const folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return withScriptLock(function () {
    const current = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
    return current.hasNext() ? current.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME);
  });
}

function normalizeValue(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeProcessingStatus(value) {
  return normalizeValue(value) === 'Đã xử lý' ? 'Đã xử lý' : 'Chưa xử lý';
}

function normalizeSearchText(value) {
  return normalizeValue(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowToObject(row, rowIndex) {
  return {
    rowIndex: rowIndex,
    STT: row[0] || (rowIndex - 1),
    'Tên huyện': row[1] || '',
    'Tên xã cũ': row[2] || '',
    'Tên xã mới': row[3] || '',
    'Họ Tên CSD': row[4] || '',
    'Số hiệu tờ bản đồ mới': row[5] || '',
    'Số thứ tự thửa mới': row[6] || '',
    'Diện tích': row[7] || '',
    'Loại mục đích sử dụng': row[8] || '',
    'Số hiệu tờ bản đồ cũ': row[9] || '',
    'Số thứ tự thửa cũ': row[10] || '',
    'Ấp': row[11] || '',
    'Thế chấp': row[12] || '',
    'File GCN': row[13] || '',
    'File CCCD': row[14] || '',
    'Số CCCD': row[15] || '',
    fileName: row[16] || '',
    fileId: row[17] || '',
    fileUrl: row[18] || '',
    pageCount: row[19] || 0,
    createdAt: row[20] || '',
    source: row[21] || '',
    'Ghi chú': row[22] || '',
    ocrText: row[22] || '',
    'Tình trạng xử lý': normalizeProcessingStatus(row[23])
  };
}

// HÀM TÌM KIẾM BỔ SUNG: Tìm theo tờ/thửa mới HOẶC tờ/thửa cũ
function searchRecords(payload) {
  const query = normalizeSearchText(payload && payload.query);
  const paramName = normalizeSearchText(payload && (payload.name || payload.hoTenCSD));
  const paramToMoi = normalizeSearchText(payload && (payload.soHieuToBanDoMoi || payload.searchMapSheet));
  const paramThuaMoi = normalizeSearchText(payload && (payload.soThuTuThuaMoi || payload.searchPlot));
  const paramToCu = normalizeSearchText(payload && (payload.soHieuToBanDoCu || payload.searchMapSheetOld));
  const paramThuaCu = normalizeSearchText(payload && (payload.soThuTuThuaCu || payload.searchPlotOld));

  const requestedLimit = Number(payload && payload.limit ? payload.limit : 30);
  const limit = Math.max(1, Math.min(100, isFinite(requestedLimit) ? requestedLimit : 30));
  const sheet = ensureSheet();
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return { success: true, count: 0, data: [] };
  }

  const values = sheet.getRange(2, 1, lastRow - 1, HEADER_ROW.length).getValues();
  const rows = values.map((row, index) => rowToObject(row, index + 2));

  // Trả về dữ liệu mới nhất nếu không truyền tham số lọc
  if (!query && !paramName && !paramToMoi && !paramThuaMoi && !paramToCu && !paramThuaCu) {
    const filtered = rows.slice(-limit).reverse();
    return { success: true, count: filtered.length, data: filtered };
  }

  const queryTokens = query ? query.split(' ').filter(Boolean) : [];

  const filtered = rows.filter((row) => {
    const nameNorm = normalizeSearchText(row['Họ Tên CSD']);
    const mapSheetNorm = normalizeSearchText(row['Số hiệu tờ bản đồ mới']);
    const plotNorm = normalizeSearchText(row['Số thứ tự thửa mới']);
    const mapSheetOldNorm = normalizeSearchText(row['Số hiệu tờ bản đồ cũ']);
    const plotOldNorm = normalizeSearchText(row['Số thứ tự thửa cũ']);

    // 1. Kiểm tra tham số trường cụ thể
    if (paramName || paramToMoi || paramThuaMoi || paramToCu || paramThuaCu) {
      if (paramName && nameNorm.indexOf(paramName) === -1) {
        return false;
      }
      if (paramToMoi && mapSheetNorm !== paramToMoi) {
        return false;
      }
      if (paramThuaMoi && plotNorm !== paramThuaMoi) {
        return false;
      }
      if (paramToCu && mapSheetOldNorm !== paramToCu) {
        return false;
      }
      if (paramThuaCu && plotOldNorm !== paramThuaCu) {
        return false;
      }
    }

    // 2. Tìm kiếm theo từ khóa chung (query)
    if (query) {
      const fullHaystackNorm = normalizeSearchText([
        row['Họ Tên CSD'],
        row['Số hiệu tờ bản đồ mới'],
        row['Số thứ tự thửa mới'],
        row['Số hiệu tờ bản đồ cũ'],
        row['Số thứ tự thửa cũ'],
        row['Số CCCD'],
        row['Tên huyện'],
        row['Tên xã mới'],
        row['Tên xã cũ'],
        row['Ấp'],
        row['Ghi chú']
      ].join(' '));

      if (fullHaystackNorm.indexOf(query) >= 0) {
        return true;
      }

      const matchNameTokens = queryTokens.length > 0 && queryTokens.every(token => nameNorm.indexOf(token) >= 0);
      if (matchNameTokens) {
        return true;
      }

      const isMapOrPlotMatch = queryTokens.length > 0 && queryTokens.every(token => 
        mapSheetNorm.indexOf(token) >= 0 || 
        plotNorm.indexOf(token) >= 0 ||
        mapSheetOldNorm.indexOf(token) >= 0 ||
        plotOldNorm.indexOf(token) >= 0
      );

      if (!isMapOrPlotMatch && !paramName && !paramToMoi && !paramThuaMoi && !paramToCu && !paramThuaCu) {
        return false;
      }
    }

    return true;
  }).slice(-limit).reverse();

  return { success: true, count: filtered.length, data: filtered };
}

function listRecords(payload) {
  return searchRecords({ query: '', limit: payload && payload.limit ? payload.limit : 20 });
}

function reportRecords(payload) {
  const sheet = ensureSheet();
  const lastRow = sheet.getLastRow();
  const total = Math.max(0, lastRow - 1);
  
  const requestedOffset = Number(payload && payload.offset ? payload.offset : 0);
  const requestedLimit = Number(payload && payload.limit ? payload.limit : 500);
  const offset = Math.max(0, Math.min(total, isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0));
  const limit = Math.max(1, Math.min(500, isFinite(requestedLimit) ? Math.floor(requestedLimit) : 500));
  const count = Math.min(limit, total - offset);

  if (count <= 0) {
    return { success: true, total: Number(total), offset: Number(offset), data: [] };
  }

  const values = sheet.getRange(offset + 2, 1, count, HEADER_ROW.length).getValues();
  const data = values.map((row, index) => {
    const record = rowToObject(row, offset + index + 2);
    return {
      rowIndex: record.rowIndex,
      STT: record.STT,
      'Tên huyện': record['Tên huyện'],
      'Tên xã mới': record['Tên xã mới'] || record['Tên xã cũ'],
      'Họ Tên CSD': record['Họ Tên CSD'],
      'Số hiệu tờ bản đồ mới': record['Số hiệu tờ bản đồ mới'],
      'Số thứ tự thửa mới': record['Số thứ tự thửa mới'],
      'Số hiệu tờ bản đồ cũ': record['Số hiệu tờ bản đồ cũ'],
      'Số thứ tự thửa cũ': record['Số thứ tự thửa cũ'],
      'Diện tích': record['Diện tích'],
      'File GCN': record['File GCN'],
      fileUrl: record.fileUrl,
      createdAt: record.createdAt,
      'Tình trạng xử lý': record['Tình trạng xử lý']
    };
  });

  return { success: true, total: Number(total), offset: Number(offset), data: data };
}

function updateProcessingStatus(payload) {
  const sheet = ensureSheet();
  const rowIndex = Number(payload && payload.rowIndex ? payload.rowIndex : 0);
  const status = normalizeValue(payload && payload.status);
  const statusColumn = HEADER_ROW.indexOf('Tình trạng xử lý') + 1;

  return withScriptLock(function () {
    if (!Number.isInteger(rowIndex) || rowIndex < 2 || rowIndex > sheet.getLastRow()) {
      throw new Error('Vui lòng chọn hồ sơ cần cập nhật tình trạng xử lý.');
    }
    if (status !== 'Đã xử lý' && status !== 'Chưa xử lý') {
      throw new Error('Tình trạng xử lý không hợp lệ.');
    }
    sheet.getRange(rowIndex, statusColumn).setValue(status);
    return { success: true, rowIndex: rowIndex, status: status };
  }, true);
}

function updateRecordNotes(payload) {
  const sheet = ensureSheet();
  const rowIndex = Number(payload && payload.rowIndex ? payload.rowIndex : 0);
  const notes = normalizeValue(payload && payload.ocrText);
  return withScriptLock(function () {
    if (rowIndex < 2 || rowIndex > sheet.getLastRow()) {
      throw new Error('Vui lòng chọn hồ sơ cần cập nhật ghi chú trước.');
    }
    sheet.getRange(rowIndex, HEADER_ROW.indexOf('Ghi chú') + 1, 1, 1).setValue(notes);
    return {
      success: true,
      message: 'Đã lưu ghi chú thành công.',
      rowIndex: rowIndex,
      ocrText: notes
    };
  }, true);
}

function saveScanRecord(payload) {
  const fileName = normalizeValue(payload && payload.fileName ? payload.fileName : `Ho_So_Dat_Dai_${Date.now()}.pdf`);
  const rowIndex = Number(payload && payload.rowIndex ? payload.rowIndex : 0);
  const pdfOriginalBase64 = normalizeValue(payload && payload.pdfOriginalBase64);
  const originalFileName = normalizeValue(payload && (payload.fileNameOriginal || payload.originalFileName)) || fileName;
  const requestedPageCount = Number(payload && payload.pageCount ? payload.pageCount : 1);
  const requestedCreatedAt = normalizeValue(payload && payload.createdAt ? new Date(payload.createdAt).toISOString() : new Date().toISOString());

  const pdfGCNBase64 = normalizeValue(payload && (payload.pdfGCNBase64 || payload.pdfBase64));
  const pdfCCCDBase64 = normalizeValue(payload && payload.pdfCCCDBase64);
  const baseName = fileName.replace(/\.pdf$/i, '');
  const cccdFileName = normalizeValue(payload && payload.fileNameCCCD) || `${baseName.replace(/_GCN_\d+$/i, '')}_CCCD_${Date.now()}.pdf`;
  // Validate the entire request before creating folders, uploading any PDF or writing rows.
  const originalFiles = normalizePdfUploadGroup(payload && payload.pdfOriginalFiles, pdfOriginalBase64, originalFileName, 'bản gốc');
  const gcnFiles = normalizePdfUploadGroup(payload && payload.pdfGCNFiles, pdfGCNBase64, fileName, 'GCN');
  const cccdFiles = normalizePdfUploadGroup(payload && payload.pdfCCCDFiles, pdfCCCDBase64, cccdFileName, 'CCCD');
  const sheet = ensureSheet();
  const driveWarnings = [];
  const uploaded = {};
  const incompletePdfGroups = [];
  let folder = null;

  if (originalFiles.length || gcnFiles.length || cccdFiles.length) {
    try { 
      folder = ensureFolder(); 
    } catch (e) { 
      driveWarnings.push('Lỗi thư mục Drive: ' + e.toString()); 
    }
  }

  // File uploads are independent for each request and must not hold the sheet lock.
  for (const group of [
    { key: 'original', label: 'bản gốc', files: originalFiles, fileName: originalFileName },
    { key: 'gcn', label: 'GCN', files: gcnFiles, fileName: fileName },
    { key: 'cccd', label: 'CCCD', files: cccdFiles, fileName: cccdFileName }
  ]) {
    if (!group.files.length) continue;
    if (!folder) { incompletePdfGroups.push(group.key); continue; }
    try {
      const saved = savePdfUploadGroup(folder, group.files, group.fileName);
      if (saved.sharingWarning) driveWarnings.push(saved.sharingWarning);
      uploaded[group.key] = saved;
    } catch (error) {
      incompletePdfGroups.push(group.key);
      driveWarnings.push('Chưa lưu đầy đủ PDF ' + group.label + ' lên Drive: ' + error.toString());
    }
  }

  return withScriptLock(function () {
    // Another request may have edited this row while Drive was receiving the PDFs.
    const lastRow = sheet.getLastRow();
    const isUpdate = rowIndex >= 2 && rowIndex <= lastRow;
    const existingRow = isUpdate ? sheet.getRange(rowIndex, 1, 1, HEADER_ROW.length).getValues()[0] : [];
    const savedRowIndex = isUpdate ? rowIndex : lastRow + 1;
    let fileId = isUpdate ? normalizeValue(existingRow[17]) : '';
    let fileUrl = isUpdate ? normalizeValue(existingRow[18]) : '';
    if (uploaded.original) {
      fileId = uploaded.original.fileId;
      fileUrl = uploaded.original.fileUrl;
    } else if (!originalFiles.length) {
      for (const saved of [uploaded.gcn, uploaded.cccd]) {
        if (!saved) continue;
        if (!fileId) fileId = saved.fileId || '';
        if (!fileUrl) fileUrl = saved.fileUrl || '';
      }
    }
    const fileGCN = uploaded.gcn ? uploaded.gcn.fileUrl : (isUpdate ? normalizeValue(existingRow[13]) : '');
    const fileCCCD = uploaded.cccd ? uploaded.cccd.fileUrl : (isUpdate ? normalizeValue(existingRow[14]) : '');
    const soCCCD = normalizeValue(payload && payload.soCCCD) || (isUpdate ? normalizeValue(existingRow[15]) : '');
    const row = [
      isUpdate ? existingRow[0] : lastRow,
      normalizeValue(payload && payload.tenHuyen),
      normalizeValue(payload && payload.tenXaCu),
      normalizeValue(payload && payload.tenXaMoi),
      normalizeValue(payload && payload.hoTenCSD),
      normalizeValue(payload && payload.soHieuToBanDoMoi),
      normalizeValue(payload && payload.soThuTuThuaMoi),
      normalizeValue(payload && payload.dienTich),
      normalizeValue(payload && payload.loaiMucDichSuDung),
      normalizeValue(payload && payload.soHieuToBanDoCu),
      normalizeValue(payload && payload.soThuTuThuaCu),
      normalizeValue(payload && payload.ap),
      normalizeValue(payload && payload.theChap),
      fileGCN, fileCCCD, soCCCD,
      uploaded.original ? originalFileName : fileName, fileId, fileUrl,
      String(requestedPageCount), requestedCreatedAt, 'mobile-app',
      normalizeValue(payload && payload.ocrText) || (isUpdate ? normalizeValue(existingRow[22]) : ''),
      isUpdate ? normalizeProcessingStatus(existingRow[23]) : 'Chưa xử lý'
    ];
    if (isUpdate) sheet.getRange(rowIndex, 1, 1, HEADER_ROW.length).setValues([row]);
    else sheet.appendRow(row);
    return {
      success: true,
      message: incompletePdfGroups.length
        ? 'Đã lưu thông tin hồ sơ; một số nhóm PDF chưa được lưu đầy đủ.'
        : (isUpdate ? 'Đã cập nhật hồ sơ.' : 'Đã lưu hồ sơ mới.'),
      warning: driveWarnings.length > 0 ? driveWarnings.join('\n') : undefined,
      fileUrl: fileUrl,
      fileId: fileId,
      fileGCN: fileGCN,
      fileCCCD: fileCCCD,
      soCCCD: soCCCD,
      updated: isUpdate,
      originalBackupSaved: Boolean(uploaded.original),
      pdfUploadComplete: incompletePdfGroups.length === 0,
      incompletePdfGroups: incompletePdfGroups,
      pdfPartCounts: {
        original: uploaded.original ? originalFiles.length : 0,
        gcn: uploaded.gcn ? gcnFiles.length : 0,
        cccd: uploaded.cccd ? cccdFiles.length : 0
      },
      rowIndex: savedRowIndex
    };
  }, true);
}

function normalizePdfUploadGroup(parts, legacyBase64, legacyFileName, label) {
  let files = [];
  if (parts != null) {
    if (!Array.isArray(parts)) throw new Error('Danh sách PDF ' + label + ' không hợp lệ.');
    if (parts.length) {
      if (parts.length < 2 || legacyBase64) throw new Error('Nhóm PDF ' + label + ' phải có ít nhất hai phần và không gửi kèm PDF đơn.');
      files = parts;
    }
  }
  if (!files.length && legacyBase64) files = [{ base64: legacyBase64, fileName: legacyFileName }];
  return files.map(function (file, index) {
    if (!file || typeof file.base64 !== 'string' || !normalizeValue(file.fileName)) {
      throw new Error('Thiếu dữ liệu hoặc tên phần PDF ' + label + ' số ' + (index + 1) + '.');
    }
    const clean = file.base64.replace(/^data:[^,]*;base64,/i, '').replace(/\s/g, '');
    const padded = clean.indexOf('=') >= 0;
    if (!clean || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1 || (padded && clean.length % 4 !== 0)) {
      throw new Error('Dữ liệu Base64 của PDF ' + label + ' số ' + (index + 1) + ' không hợp lệ.');
    }
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    const byteLength = Math.floor(clean.length * 3 / 4) - padding;
    if (byteLength > MAX_PDF_BYTES) {
      throw new Error('PDF ' + label + ' số ' + (index + 1) + ' vượt 10 MB (' + byteLength + ' byte). Hãy chia thành các PDF nhỏ hơn.');
    }
    return { base64: clean, fileName: normalizeValue(file.fileName), byteLength: byteLength };
  });
}

function savePdfUploadGroup(parent, files, fileName) {
  const multipart = files.length > 1;
  // Always create a fresh folder: simultaneous requests must never mix their parts.
  const folder = multipart ? parent.createFolder(fileName.replace(/\.pdf$/i, '') + '_CAC_PHAN_' + Date.now()) : parent;
  const warnings = [];
  if (multipart) {
    try { folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
    catch (error) { warnings.push('Không thể chia sẻ công khai thư mục các phần PDF: ' + error.toString()); }
  }
  let saved = null;
  for (let index = 0; index < files.length; index++) {
    try {
      saved = savePdfToDrive(folder, files[index].base64, files[index].fileName);
      if (saved.sharingWarning) warnings.push(saved.sharingWarning);
    } catch (error) {
      throw new Error('Đã lưu ' + index + '/' + files.length + ' phần; lỗi ở ' + files[index].fileName + ': ' + error.toString());
    }
  }
  return {
    fileId: multipart ? folder.getId() : saved.fileId,
    fileUrl: multipart ? folder.getUrl() : saved.fileUrl,
    sharingWarning: warnings.length ? warnings.join('\n') : undefined
  };
}

function savePdfToDrive(folder, pdfBase64, fileName) {
  const clean = String(pdfBase64 || '').replace(/^data:.*;base64,/, '').trim();
  if (!clean) throw new Error('PDF Base64 rỗng');
  const bytes = Utilities.base64Decode(clean);
  if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF vượt giới hạn 10 MB.');
  const blob = Utilities.newBlob(bytes, 'application/pdf', fileName);
  const file = folder.createFile(blob);
  let sharingWarning = '';

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    sharingWarning = 'Không thể chia sẻ công khai file: ' + e.toString();
  }

  return { 
    fileId: file.getId(), 
    fileUrl: file.getUrl(),
    sharingWarning: sharingWarning || undefined
  };
}
