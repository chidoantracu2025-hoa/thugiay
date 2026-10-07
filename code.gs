const SHEET_NAME = 'Du_Lieu';
const DRIVE_FOLDER_NAME = 'Ho_So_Dat_Dai';

const HEADER_ROW = [
  'STT', 'Tên huyện', 'Tên xã cũ', 'Tên xã mới', 'Họ Tên CSD',
  'Số hiệu tờ bản đồ mới', 'Số thứ tự thửa mới', 'Diện tích', 'Loại mục đích sử dụng',
  'Số hiệu tờ bản đồ cũ', 'Số thứ tự thửa cũ', 'Ấp', 'Thế chấp',
  'File GCN', 'File CCCD', 'Số CCCD', 'fileName', 'fileId',
  'fileUrl', 'pageCount', 'createdAt', 'source', 'Ghi chú', 'Tình trạng xử lý'
];

function doGet() {
  return jsonResponse({
    success: true,
    message: 'Google Apps Script API đang hoạt động mượt mà.',
    sheet: SHEET_NAME,
    folder: DRIVE_FOLDER_NAME
  });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const data = JSON.parse(raw);
    const action = String(data.action || '').toUpperCase();
    const payload = data.payload || data || {};

    switch (action) {
      case 'PING':
        return jsonResponse({ success: true, message: 'API OK' });
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

function ensureSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADER_ROW);
  }
  return sheet;
}

function ensureFolder() {
  const folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME);
}

function normalizeValue(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeProcessingStatus(value) {
  return normalizeValue(value) === 'Đã xử lý' ? 'Đã xử lý' : 'Chưa xử lý';
}

// Chuẩn hóa chuỗi tìm kiếm: chuyển chữ thường, xóa dấu tiếng Việt và khoảng trắng thừa
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

// HÀM TÌM KIẾM NÂNG CẤP: Hỗ trợ linh hoạt theo query chung HOẶC theo từng trường cụ thể (name, soHieuToBanDoMoi, soThuTuThuaMoi)
function searchRecords(payload) {
  const query = normalizeSearchText(payload && payload.query);
  const paramName = normalizeSearchText(payload && (payload.name || payload.hoTenCSD));
  const paramToMoi = normalizeSearchText(payload && payload.soHieuToBanDoMoi);
  const paramThuaMoi = normalizeSearchText(payload && payload.soThuTuThuaMoi);

  const requestedLimit = Number(payload && payload.limit ? payload.limit : 30);
  const limit = Math.max(1, Math.min(100, isFinite(requestedLimit) ? requestedLimit : 30));
  const sheet = ensureSheet();
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return { success: true, count: 0, data: [] };
  }

  const values = sheet.getRange(2, 1, lastRow - 1, HEADER_ROW.length).getValues();
  const rows = values.map((row, index) => rowToObject(row, index + 2));

  // Nếu không nhập bất kỳ tham số tìm kiếm nào, trả về danh sách hồ sơ mới nhất
  if (!query && !paramName && !paramToMoi && !paramThuaMoi) {
    const filtered = rows.slice(-limit).reverse();
    return { success: true, count: filtered.length, data: filtered };
  }

  const queryTokens = query ? query.split(' ').filter(Boolean) : [];

  const filtered = rows.filter((row) => {
    const nameNorm = normalizeSearchText(row['Họ Tên CSD']);
    const mapSheetNorm = normalizeSearchText(row['Số hiệu tờ bản đồ mới']);
    const plotNorm = normalizeSearchText(row['Số thứ tự thửa mới']);

    // 1. Nếu có gửi tham số trường riêng lẻ (name, soHieuToBanDoMoi, soThuTuThuaMoi)
    if (paramName || paramToMoi || paramThuaMoi) {
      if (paramName && nameNorm.indexOf(paramName) === -1) {
        return false;
      }
      if (paramToMoi && mapSheetNorm !== paramToMoi) {
        return false;
      }
      if (paramThuaMoi && plotNorm !== paramThuaMoi) {
        return false;
      }
    }

    // 2. Nếu có gửi từ khóa tìm kiếm chung (query)
    if (query) {
      const fullHaystackNorm = normalizeSearchText([
        row['Họ Tên CSD'],
        row['Số hiệu tờ bản đồ mới'],
        row['Số thứ tự thửa mới'],
        row['Số CCCD'],
        row['Tên huyện'],
        row['Tên xã mới'],
        row['Tên xã cũ'],
        row['Ấp'],
        row['Ghi chú']
      ].join(' '));

      // Khớp 1: Khớp chuỗi trực tiếp
      if (fullHaystackNorm.indexOf(query) >= 0) {
        return true;
      }

      // Khớp 2: Tất cả các từ đều có trong Họ Tên CSD
      const matchNameTokens = queryTokens.length > 0 && queryTokens.every(token => nameNorm.indexOf(token) >= 0);
      if (matchNameTokens) {
        return true;
      }

      // Khớp 3: Khớp kết hợp Tờ / Thửa
      const isMapOrPlotMatch = queryTokens.length > 0 && queryTokens.every(token => 
        mapSheetNorm.indexOf(token) >= 0 || plotNorm.indexOf(token) >= 0
      );

      if (!isMapOrPlotMatch && !paramName && !paramToMoi && !paramThuaMoi) {
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

  if (!Number.isInteger(rowIndex) || rowIndex < 2 || rowIndex > sheet.getLastRow()) {
    throw new Error('Vui lòng chọn hồ sơ cần cập nhật tình trạng xử lý.');
  }
  if (status !== 'Đã xử lý' && status !== 'Chưa xử lý') {
    throw new Error('Tình trạng xử lý không hợp lệ.');
  }

  sheet.getRange(rowIndex, statusColumn).setValue(status);
  return { success: true, rowIndex: rowIndex, status: status };
}

function updateRecordNotes(payload) {
  const sheet = ensureSheet();
  const rowIndex = Number(payload && payload.rowIndex ? payload.rowIndex : 0);
  if (rowIndex < 2 || rowIndex > sheet.getLastRow()) {
    throw new Error('Vui lòng chọn hồ sơ cần cập nhật ghi chú trước.');
  }

  const notes = normalizeValue(payload && payload.ocrText);
  sheet.getRange(rowIndex, HEADER_ROW.indexOf('Ghi chú') + 1, 1, 1).setValue(notes);
  return {
    success: true,
    message: 'Đã lưu ghi chú thành công.',
    rowIndex: rowIndex,
    ocrText: notes
  };
}

function saveScanRecord(payload) {
  const sheet = ensureSheet();
  const fileName = normalizeValue(payload && payload.fileName ? payload.fileName : `Ho_So_Dat_Dai_${Date.now()}.pdf`);
  const rowIndex = Number(payload && payload.rowIndex ? payload.rowIndex : 0);
  const isUpdate = rowIndex >= 2 && rowIndex <= sheet.getLastRow();
  const existingRow = isUpdate ? sheet.getRange(rowIndex, 1, 1, HEADER_ROW.length).getValues()[0] : [];
  
  // Trích xuất các biến Base64 và tham số bổ sung từ payload
  const pdfOriginalBase64 = normalizeValue(payload && payload.pdfOriginalBase64);
  const originalFileName = normalizeValue(payload && payload.originalFileName) || fileName;
  const requestedPageCount = Number(payload && payload.pageCount ? payload.pageCount : 1);
  const requestedCreatedAt = normalizeValue(payload && payload.createdAt ? new Date(payload.createdAt).toISOString() : new Date().toISOString());

  const pdfGCNBase64 = normalizeValue(payload && (payload.pdfGCNBase64 || payload.pdfBase64));
  const pdfCCCDBase64 = normalizeValue(payload && payload.pdfCCCDBase64);
  const driveWarnings = [];
  let folder = null;

 if (pdfOriginalBase64 || pdfGCNBase64 || pdfCCCDBase64) {
    try { 
      folder = ensureFolder(); 
    } catch (e) { 
      driveWarnings.push('Lỗi thư mục Drive: ' + e.toString()); 
    }
  }

  const record = {
    STT: isUpdate ? existingRow[0] : sheet.getLastRow(),
    'Tên huyện': normalizeValue(payload && payload.tenHuyen),
    'Tên xã cũ': normalizeValue(payload && payload.tenXaCu),
    'Tên xã mới': normalizeValue(payload && payload.tenXaMoi),
    'Họ Tên CSD': normalizeValue(payload && payload.hoTenCSD),
    'Số hiệu tờ bản đồ mới': normalizeValue(payload && payload.soHieuToBanDoMoi),
    'Số thứ tự thửa mới': normalizeValue(payload && payload.soThuTuThuaMoi),
    'Diện tích': normalizeValue(payload && payload.dienTich),
    'Loại mục đích sử dụng': normalizeValue(payload && payload.loaiMucDichSuDung),
    'Số hiệu tờ bản đồ cũ': normalizeValue(payload && payload.soHieuToBanDoCu),
    'Số thứ tự thửa cũ': normalizeValue(payload && payload.soThuTuThuaCu),
    'Ấp': normalizeValue(payload && payload.ap),
    'Thế chấp': normalizeValue(payload && payload.theChap),
    'File GCN': isUpdate ? normalizeValue(existingRow[13]) : '',
    'File CCCD': isUpdate ? normalizeValue(existingRow[14]) : '',
    'Số CCCD': normalizeValue(payload && payload.soCCCD) || (isUpdate ? normalizeValue(existingRow[15]) : ''),
    'Tình trạng xử lý': isUpdate ? normalizeProcessingStatus(existingRow[23]) : 'Chưa xử lý',
    fileName: fileName,
    fileId: isUpdate ? normalizeValue(existingRow[17]) : '',
    fileUrl: isUpdate ? normalizeValue(existingRow[18]) : '',
    pageCount: requestedPageCount,
    createdAt: requestedCreatedAt,
    source: 'mobile-app'
  };

  const baseName = fileName.replace(/\.pdf$/i, '');
  const cccdFileName = normalizeValue(payload && payload.fileNameCCCD) || `${baseName.replace(/_GCN_\d+$/i, '')}_CCCD_${Date.now()}.pdf`;
  let originalBackupSaved = false;
  if (pdfOriginalBase64 && folder) {
    try {
      const saved = savePdfToDrive(folder, pdfOriginalBase64, originalFileName, 3 * 1000 * 1000);
      if (saved.sharingWarning) driveWarnings.push(saved.sharingWarning);
      record.fileName = originalFileName;
      record.fileId = saved.fileId;
      record.fileUrl = saved.fileUrl;
      record.pageCount = requestedPageCount;
      record.createdAt = requestedCreatedAt;
      record.source = 'mobile-app';
      originalBackupSaved = true;
    } catch (error) {
      driveWarnings.push('Không lưu được PDF bản gốc lên Drive: ' + error.toString());
    }
  }
  if (pdfGCNBase64 && folder) {
    try {
      const saved = savePdfToDrive(folder, pdfGCNBase64, fileName);
      if (saved.sharingWarning) driveWarnings.push(saved.sharingWarning);
      record['File GCN'] = saved.fileUrl;
      if (!pdfOriginalBase64 && !record.fileUrl) record.fileUrl = saved.fileUrl || '';
      if (!pdfOriginalBase64 && !record.fileId) record.fileId = saved.fileId || '';
    } catch (error) {
      driveWarnings.push('Không lưu được PDF GCN lên Drive: ' + error.toString());
    }
  }
  if (pdfCCCDBase64 && folder) {
    try {
      const saved = savePdfToDrive(folder, pdfCCCDBase64, cccdFileName);
      if (saved.sharingWarning) driveWarnings.push(saved.sharingWarning);
      record['File CCCD'] = saved.fileUrl;
      if (!pdfOriginalBase64 && !record.fileUrl) record.fileUrl = saved.fileUrl || '';
      if (!pdfOriginalBase64 && !record.fileId) record.fileId = saved.fileId || '';
    } catch (error) {
      driveWarnings.push('Không lưu được PDF CCCD lên Drive: ' + error.toString());
    }
  }

  const row = [
    record.STT, record['Tên huyện'], record['Tên xã cũ'], record['Tên xã mới'], record['Họ Tên CSD'],
    record['Số hiệu tờ bản đồ mới'], record['Số thứ tự thửa mới'], record['Diện tích'], record['Loại mục đích sử dụng'],
    record['Số hiệu tờ bản đồ cũ'], record['Số thứ tự thửa cũ'], record['Ấp'], record['Thế chấp'],
    record['File GCN'], record['File CCCD'], record['Số CCCD'], record.fileName, record.fileId,
    record.fileUrl, String(record.pageCount), record.createdAt, record.source,
    normalizeValue(payload && payload.ocrText) || (isUpdate ? normalizeValue(existingRow[22]) : ''),
    record['Tình trạng xử lý']
  ];

  if (isUpdate) {
    sheet.getRange(rowIndex, 1, 1, HEADER_ROW.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  return {
    success: true,
    message: isUpdate ? 'Đã cập nhật hồ sơ.' : 'Đã lưu hồ sơ mới.',
    warning: driveWarnings.join('\n'),
    fileUrl: record.fileUrl,
    rowIndex: isUpdate ? rowIndex : sheet.getLastRow()
  };
}

function savePdfToDrive(folder, pdfBase64, fileName) {
  const clean = String(pdfBase64 || '').replace(/^data:.*;base64,/, '').trim();
  if (!clean) throw new Error('PDF Base64 rỗng');
  const blob = Utilities.newBlob(Utilities.base64Decode(clean), 'application/pdf', fileName);
  const file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {}
  return { fileId: file.getId(), fileUrl: file.getUrl() };
}