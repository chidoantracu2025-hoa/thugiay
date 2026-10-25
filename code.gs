const SHEET_NAME = 'Du_Lieu';
const DRIVE_FOLDER_NAME = 'Ho_So_Dat_Dai';
const MAX_PDF_BYTES = 10000000;
const SAVE_REQUEST_PREFIX = 'SCAN_SAVE_V1_';
const SAVE_REQUEST_INDEX = 'SCAN_SAVE_INDEX_V1';
const SAVE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const SAVE_REQUEST_LEASE_MS = 7 * 60 * 1000;
const DAILY_REPORT_SPREADSHEET_ID = '1UzdjhtSRRD9yO0h-UJxQzkVjoeoEB-WqMzeLO6x6HKs';
const DAILY_REPORT_SHEET_NAME = 'Trang tính1';

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
      case 'SAVE_STATUS':
        return jsonResponse(getSaveRequestStatus(payload));
      case 'LOG_PERFORMANCE':
        return jsonResponse(writePerformanceLogToGitHub(payload));
      case 'UPDATE_NOTES':
        return jsonResponse(updateRecordNotes(payload));
      case 'LIST':
        return jsonResponse(listRecords(payload));
      case 'REPORT':
        return jsonResponse(reportRecords(payload));
      case 'SAVE_DAILY_REPORT':
        return jsonResponse(saveDailyReport(payload));
      case 'GET_DAILY_REPORTS':
        return jsonResponse(getDailyReports(payload));
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

function dailyReportSheet_() {
  const ss = SpreadsheetApp.openById(DAILY_REPORT_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(DAILY_REPORT_SHEET_NAME) || ss.insertSheet(DAILY_REPORT_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Ngày', 'STT', 'Cán bộ thực hiện', 'Địa bàn', 'SL thực hiện', 'Ghi chú', 'Cập nhật lúc']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function dailyReportDate_(value) {
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function saveDailyReport(payload) {
  const date = dailyReportDate_(payload.date);
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const sheet = dailyReportSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const values = sheet.getDataRange().getValues();
    for (let row = values.length - 1; row >= 1; row--) {
      const cellDate = values[row][0] instanceof Date
        ? Utilities.formatDate(values[row][0], Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(values[row][0]).slice(0, 10);
      if (cellDate === date) sheet.deleteRow(row + 1);
    }
    const now = new Date();
    const output = rows.map((item, index) => [
      date, index + 1, String(item.person || ''), String(item.area || ''), Number(item.count || 0), String(item.note || ''), now
    ]);
    if (output.length) sheet.getRange(sheet.getLastRow() + 1, 1, output.length, output[0].length).setValues(output);
    return { success: true, date: date, savedRows: output.length };
  } finally {
    lock.releaseLock();
  }
}

function getDailyReports(payload) {
  const sheet = dailyReportSheet_();
  const values = sheet.getDataRange().getValues();
  const from = dailyReportDate_(payload.from);
  const to = dailyReportDate_(payload.to || from);
  const rows = values.slice(1).map(row => {
    const date = row[0] instanceof Date
      ? Utilities.formatDate(row[0], Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(row[0]).slice(0, 10);
    return { date: date, stt: row[1], person: row[2], area: row[3], count: Number(row[4] || 0), note: row[5] };
  }).filter(row => row.date >= from && row.date <= to);
  return { success: true, rows: rows };
}

function pdfUploadCapabilities() {
  return { pdfUploadVersion: 2, supportsPdfParts: true, maxPdfBytes: MAX_PDF_BYTES,
    supportsSaveRetry: true, supportsSaveStatus: true, saveRequestVersion: 1 };
}

function issuePerformanceLogToken(saveRequestId) {
  if (typeof CacheService === 'undefined') return '';
  const token = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('PERF_LOG_' + token, normalizeValue(saveRequestId), 600);
  return token;
}

function safePerformanceNumber(value) {
  const number = Number(value);
  return isFinite(number) && number >= 0 ? Math.min(number, 24 * 60 * 60 * 1000) : 0;
}

function sanitizePerformanceLog(payload) {
  const timing = payload && payload.serverTiming && typeof payload.serverTiming === 'object' ? payload.serverTiming : null;
  const network = payload && payload.network && typeof payload.network === 'object' ? payload.network : {};
  const device = payload && payload.device && typeof payload.device === 'object' ? payload.device : {};
  return {
    version: 3,
    receivedAt: new Date().toISOString(),
    capturedAt: normalizeValue(payload && payload.at).slice(0, 32),
    page: normalizeValue(payload && payload.page).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
    eventId: normalizeValue(payload && payload.eventId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100),
    result: normalizeValue(payload && payload.result).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
    errorCode: normalizeValue(payload && payload.errorCode).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48),
    update: Boolean(payload && payload.update),
    documentPages: Math.floor(safePerformanceNumber(payload && payload.documentPages)),
    cccdPages: Math.floor(safePerformanceNumber(payload && payload.cccdPages)),
    pdfBytesSent: Math.floor(safePerformanceNumber(payload && payload.pdfBytesSent)),
    exportMs: safePerformanceNumber(payload && payload.exportMs),
    requestMs: safePerformanceNumber(payload && payload.requestMs),
    totalMs: safePerformanceNumber(payload && payload.totalMs),
    outputDpi: Number(payload && payload.outputDpi) === 200 ? 200 : (Number(payload && payload.outputDpi) === 300 ? 300 : (Number(payload && payload.outputDpi) === 400 ? 400 : 0)),
    serverTiming: timing ? {
      validationMs: safePerformanceNumber(timing.validationMs), driveMs: safePerformanceNumber(timing.driveMs),
      sheetMs: safePerformanceNumber(timing.sheetMs), totalMs: safePerformanceNumber(timing.totalMs)
    } : null,
    network: {
      effectiveType: normalizeValue(network.effectiveType).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16),
      downlinkMbps: safePerformanceNumber(network.downlinkMbps), rttMs: safePerformanceNumber(network.rttMs)
    },
    device: { memoryGb: safePerformanceNumber(device.memoryGb), logicalCores: safePerformanceNumber(device.logicalCores) }
  };
}

function writePerformanceLogToGitHub(payload) {
  const token = normalizeValue(payload && payload.logToken);
  const cache = typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null;
  if (!cache || !/^[A-Za-z0-9_-]{20,100}$/.test(token) || cache.get('PERF_LOG_' + token) === null) {
    return { success: false, error: 'Phiên ghi log không hợp lệ hoặc đã hết hạn.' };
  }
  cache.remove('PERF_LOG_' + token);
  const properties = PropertiesService.getScriptProperties();
  const githubToken = normalizeValue(properties.getProperty('GITHUB_LOG_TOKEN'));
  const repository = normalizeValue(properties.getProperty('GITHUB_LOG_REPOSITORY')) || 'chidoantracu2025-hoa/thugiay';
  const branch = normalizeValue(properties.getProperty('GITHUB_LOG_BRANCH')) || 'main';
  const prefix = normalizeValue(properties.getProperty('GITHUB_LOG_PATH_PREFIX')) || 'performance-logs';
  if (!githubToken || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    return { success: false, error: 'Chưa cấu hình nơi lưu log GitHub.' };
  }
  const log = sanitizePerformanceLog(payload);
  const now = new Date();
  const day = Utilities.formatDate(now, 'UTC', 'yyyy-MM-dd');
  const stamp = Utilities.formatDate(now, 'UTC', "yyyyMMdd'T'HHmmssSSS'Z'");
  const fileName = [stamp, log.page || 'unknown', log.eventId || Utilities.getUuid().replace(/-/g, '')].join('_') + '.json';
  const path = (prefix + '/' + day + '/' + fileName).split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const response = UrlFetchApp.fetch('https://api.github.com/repos/' + repository + '/contents/' + path, {
    method: 'put', muteHttpExceptions: true, contentType: 'application/json',
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + githubToken,
      'X-GitHub-Api-Version': '2022-11-28' },
    payload: JSON.stringify({ message: 'log: save performance ' + day, content: Utilities.base64Encode(JSON.stringify(log, null, 2)), branch: branch })
  });
  const status = response.getResponseCode();
  return status === 201 ? { success: true } : { success: false, error: 'GitHub HTTP ' + status };
}

// Run this once from the Apps Script editor after configuring Script Properties.
// Google will request the external-request permission needed by UrlFetchApp.
function authorizeGitHubPerformanceLogging() {
  const properties = PropertiesService.getScriptProperties();
  const githubToken = normalizeValue(properties.getProperty('GITHUB_LOG_TOKEN'));
  const repository = normalizeValue(properties.getProperty('GITHUB_LOG_REPOSITORY')) || 'chidoantracu2025-hoa/thugiay';
  if (!githubToken) throw new Error('Chưa cấu hình GITHUB_LOG_TOKEN trong Script Properties.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('GITHUB_LOG_REPOSITORY không hợp lệ.');
  const response = UrlFetchApp.fetch('https://api.github.com/repos/' + repository, {
    method: 'get', muteHttpExceptions: true,
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + githubToken,
      'X-GitHub-Api-Version': '2022-11-28' }
  });
  const status = response.getResponseCode();
  if (status !== 200) throw new Error('Không kết nối được repository GitHub. HTTP ' + status);
  return { success: true, repository: repository, message: 'Đã cấp quyền và kết nối GitHub thành công.' };
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
  // Folder lookup by ID is cheaper than a Drive name search on every save. The
  // short-lived cache is only a hint: deleted/inaccessible folders are re-resolved.
  const cache = typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null;
  const cacheKey = 'SCAN_ROOT_FOLDER_V1';
  if (cache && typeof DriveApp.getFolderById === 'function') {
    const id = cache.get(cacheKey);
    if (id) {
      try {
        const cached = DriveApp.getFolderById(id);
        if (!cached.isTrashed || !cached.isTrashed()) return cached;
      } catch (ignored) {}
      cache.remove(cacheKey);
    }
  }
  function remember(folder) {
    if (cache && typeof folder.getId === 'function') cache.put(cacheKey, folder.getId(), 21600);
    return folder;
  }
  const folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  if (folders.hasNext()) return remember(folders.next());
  return withScriptLock(function () {
    const current = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
    return remember(current.hasNext() ? current.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME));
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
  const operationStartedAt = Date.now();
  const fileName = normalizeValue(payload && payload.fileName ? payload.fileName : `Ho_So_Dat_Dai_${Date.now()}.pdf`);
  const rowIndex = Number(payload && payload.rowIndex ? payload.rowIndex : 0);
  const pdfOriginalBase64 = normalizeValue(payload && payload.pdfOriginalBase64);
  const originalFileName = normalizeValue(payload && (payload.fileNameOriginal || payload.originalFileName)) || fileName;
  const rawPageCount = payload && payload.pageCount !== undefined && payload.pageCount !== null ? Number(payload.pageCount) : 1;
  const requestedPageCount = isFinite(rawPageCount) && rawPageCount >= 0 ? Math.floor(rawPageCount) : 1;
  const requestedCreatedAt = normalizeValue(payload && payload.createdAt ? new Date(payload.createdAt).toISOString() : new Date().toISOString());

  const pdfGCNBase64 = normalizeValue(payload && (payload.pdfGCNBase64 || payload.pdfBase64));
  const pdfCCCDBase64 = normalizeValue(payload && payload.pdfCCCDBase64);
  const baseName = fileName.replace(/\.pdf$/i, '');
  const cccdFileName = normalizeValue(payload && payload.fileNameCCCD) || `${baseName.replace(/_GCN_\d+$/i, '')}_CCCD_${Date.now()}.pdf`;
  // Validate the entire request before creating folders, uploading any PDF or writing rows.
  const originalFiles = normalizePdfUploadGroup(payload && payload.pdfOriginalFiles, pdfOriginalBase64, originalFileName, 'bản gốc');
  const gcnFiles = normalizePdfUploadGroup(payload && payload.pdfGCNFiles, pdfGCNBase64, fileName, 'GCN');
  const cccdFiles = normalizePdfUploadGroup(payload && payload.pdfCCCDFiles, pdfCCCDBase64, cccdFileName, 'CCCD');
  const groups = { original: originalFiles, gcn: gcnFiles, cccd: cccdFiles };
  const retry = payload && payload.saveRequestId ? beginSaveRequest(payload, groups, requestedCreatedAt) : null;
  if (retry && retry.reply) return retry.reply;
  try {
    const sheet = ensureSheet();
    const driveWarnings = [];
    const uploaded = {};
    const incompletePdfGroups = [];
    let folder = null;
    const driveStartedAt = Date.now();

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
      const prior = retry && retry.state.groups[group.key];
      if (prior && prior.result) {
        uploaded[group.key] = prior.result;
        if (prior.result.sharingWarning) driveWarnings.push(prior.result.sharingWarning);
        continue;
      }
      if (!group.files.length) continue;
      if (!folder) { incompletePdfGroups.push(group.key); continue; }
      try {
        const saved = savePdfUploadGroup(folder, group.files, group.fileName, prior, retry ? function (progress) {
          retry.state.groups[group.key] = Object.assign(prior, progress);
          checkpointSaveRequest(retry);
        } : null);
        if (prior) { prior.result = saved; checkpointSaveRequest(retry); }
        if (saved.sharingWarning) driveWarnings.push(saved.sharingWarning);
        uploaded[group.key] = saved;
      } catch (error) {
        incompletePdfGroups.push(group.key);
        driveWarnings.push('Chưa lưu đầy đủ PDF ' + group.label + ' lên Drive: ' + error.toString());
      }
    }
    const driveFinishedAt = Date.now();

    const sheetStartedAt = Date.now();
    const result = withScriptLock(function () {
      // Another request may have edited this row while Drive was receiving the PDFs.
      const lastRow = sheet.getLastRow();
      let effectiveRowIndex = retry && retry.state.rowIndex ? retry.state.rowIndex : rowIndex;
      let existingRow = effectiveRowIndex >= 2 && effectiveRowIndex <= lastRow
        ? sheet.getRange(effectiveRowIndex, 1, 1, HEADER_ROW.length).getValues()[0] : [];
      // A failed append/flush can leave an allocated row intent. Reuse it only if
      // the actual row matches the checkpoint; never overwrite a competing append.
      if (retry && !retry.state.rowCommitted && retry.state.rowSignature && existingRow.length &&
          saveRequestRowDigest(existingRow) !== retry.state.rowSignature) {
        effectiveRowIndex = 0; existingRow = [];
      }
      const isUpdate = existingRow.length > 0;
      const savedRowIndex = isUpdate ? effectiveRowIndex : lastRow + 1;
      function applyUpload(key) {
        return uploaded[key] && (!retry || !isUpdate || !retry.state.groups[key].appliedToRow);
      }
      let fileId = isUpdate ? normalizeValue(existingRow[17]) : '';
      let fileUrl = isUpdate ? normalizeValue(existingRow[18]) : '';
      if (applyUpload('original')) {
        fileId = uploaded.original.fileId;
        fileUrl = uploaded.original.fileUrl;
      } else if (!(retry ? retry.state.groups.original : originalFiles.length)) {
        for (const saved of [applyUpload('gcn') ? uploaded.gcn : null, applyUpload('cccd') ? uploaded.cccd : null]) {
          if (!saved) continue;
          if (!fileId) fileId = saved.fileId || '';
          if (!fileUrl) fileUrl = saved.fileUrl || '';
        }
      }
      const fileGCN = applyUpload('gcn') ? uploaded.gcn.fileUrl : (isUpdate ? normalizeValue(existingRow[13]) : '');
      const fileCCCD = applyUpload('cccd') ? uploaded.cccd.fileUrl : (isUpdate ? normalizeValue(existingRow[14]) : '');
      const soCCCD = normalizeValue(payload && payload.soCCCD) || (isUpdate ? normalizeValue(existingRow[15]) : '');
      const hasNewPdf = ['original', 'gcn', 'cccd'].some(function (key) { return Boolean(applyUpload(key)); });
      const storedFileName = applyUpload('original') ? originalFileName
        : (isUpdate && (!hasNewPdf || uploaded.original) ? normalizeValue(existingRow[16]) : fileName);
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
        storedFileName, fileId, fileUrl,
        String(requestedPageCount), retry ? retry.state.createdAtValue : requestedCreatedAt, 'mobile-app',
        normalizeValue(payload && payload.ocrText) || (isUpdate ? normalizeValue(existingRow[22]) : ''),
        isUpdate ? normalizeProcessingStatus(existingRow[23]) : 'Chưa xử lý'
      ];
      if (retry) {
        retry.state.rowIndex = savedRowIndex;
        retry.state.rowSignature = saveRequestRowDigest(row);
        retry.state.rowCommitted = false;
        checkpointSaveRequest(retry, true);
      }
      if (isUpdate) sheet.getRange(savedRowIndex, 1, 1, HEADER_ROW.length).setValues([row]);
      else sheet.appendRow(row);
      if (retry) { retry.state.rowCommitted = true; checkpointSaveRequest(retry, true); }
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
          original: uploaded.original ? (retry ? retry.state.groups.original.count : originalFiles.length) : 0,
          gcn: uploaded.gcn ? (retry ? retry.state.groups.gcn.count : gcnFiles.length) : 0,
          cccd: uploaded.cccd ? (retry ? retry.state.groups.cccd.count : cccdFiles.length) : 0
        },
        rowIndex: savedRowIndex
      };
    }, true);
    const sheetFinishedAt = Date.now();
    result.serverTiming = {
      validationMs: Math.max(0, driveStartedAt - operationStartedAt),
      driveMs: Math.max(0, driveFinishedAt - driveStartedAt),
      sheetMs: Math.max(0, sheetFinishedAt - sheetStartedAt),
      totalMs: Math.max(0, sheetFinishedAt - operationStartedAt)
    };
    result.performanceLogToken = issuePerformanceLogToken(retry ? retry.state.id : 'legacy-save');
    if (retry) {
      Object.keys(uploaded).forEach(function (key) { retry.state.groups[key].appliedToRow = true; });
      result.saveRequestId = retry.state.id;
      result.savedPdfGroupKeys = {};
      Object.keys(retry.state.groups).forEach(function (key) {
        if (retry.state.groups[key].result) result.savedPdfGroupKeys[key] = retry.state.groups[key].key;
      });
      if (result.pdfUploadComplete) { retry.state.result = result; delete retry.state.lastResult; }
      else retry.state.lastResult = result;
      checkpointSaveRequest(retry);
    }
    return result;
  } finally {
    if (retry) releaseSaveRequest(retry);
  }
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

function saveRequestDigest(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(function (value) { return ('0' + ((value + 256) % 256).toString(16)).slice(-2); }).join('');
}

function saveRequestRowDigest(row) {
  // Sheets may return a numeric cell as a number after receiving a numeric
  // string. Compare their values rather than JavaScript storage types.
  return saveRequestDigest(JSON.stringify(row.map(function (value) {
    return value && typeof value.toISOString === 'function' ? value.toISOString() : normalizeValue(value);
  })));
}

function getSaveRequestStatus(payload) {
  const id = normalizeValue(payload && payload.saveRequestId);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) throw new Error('Mã lượt lưu không hợp lệ.');
  const raw = PropertiesService.getScriptProperties().getProperty(SAVE_REQUEST_PREFIX + id);
  let state = null;
  try { state = raw ? JSON.parse(raw) : null; } catch (ignored) {}
  if (!state || Date.now() - state.updatedAt > SAVE_REQUEST_TTL_MS) {
    return { success: false, code: 'SAVE_RETRY_EXPIRED', saveRequestId: id,
      error: 'Không còn thông tin lượt lưu này. Hãy gửi lại đầy đủ ảnh.' };
  }
  if (state.result) return Object.assign({}, state.result, { replayed: true, processing: false });
  const result = Object.assign({}, state.lastResult || {}, {
    success: true, saveRequestId: id, savedPdfGroupKeys: {}, incompletePdfGroups: [],
    pdfUploadComplete: false, processing: state.leaseUntil > Date.now(),
    rowIndex: state.lastResult ? state.lastResult.rowIndex : 0
  });
  Object.keys(state.groups).forEach(function (key) {
    if (state.groups[key].result) result.savedPdfGroupKeys[key] = state.groups[key].key;
    else result.incompletePdfGroups.push(key);
  });
  if (result.processing) result.retryAfterMs = 2500;
  return result;
}

function beginSaveRequest(payload, groups, createdAtValue) {
  const id = normalizeValue(payload.saveRequestId);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) throw new Error('Mã lượt lưu không hợp lệ.');
  const keys = payload.pdfGroupKeys || {};
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('Mã nhóm PDF không hợp lệ.');
  Object.keys(keys).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(groups, key) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(String(keys[key]))) {
      throw new Error('Mã nhóm PDF ' + key + ' không hợp lệ.');
    }
  });
  const metadata = {};
  ['fileName', 'fileNameOriginal', 'originalFileName', 'fileNameCCCD', 'pageCount', 'createdAt',
    'tenHuyen', 'tenXaCu', 'tenXaMoi', 'hoTenCSD', 'soHieuToBanDoMoi', 'soThuTuThuaMoi',
    'dienTich', 'loaiMucDichSuDung', 'soHieuToBanDoCu', 'soThuTuThuaCu', 'ap', 'theChap',
    'soCCCD', 'ocrText'].forEach(function (key) { metadata[key] = normalizeValue(payload[key]); });
  const fingerprint = saveRequestDigest(JSON.stringify(metadata));
  const now = Date.now();
  const properties = PropertiesService.getScriptProperties();
  return withScriptLock(function () {
    const propertyKey = SAVE_REQUEST_PREFIX + id;
    let state = null;
    const raw = properties.getProperty(propertyKey);
    if (raw) { try { state = JSON.parse(raw); } catch (ignored) {} }
    if (state && now - state.updatedAt > SAVE_REQUEST_TTL_MS) state = null;
    if (state && (state.fingerprint !== fingerprint ||
        (Number(payload.rowIndex || 0) !== state.requestedRowIndex && Number(payload.rowIndex || 0) !== state.rowIndex))) {
      return { reply: { success: false, code: 'SAVE_REQUEST_CHANGED', saveRequestId: id,
        error: 'Nội dung hồ sơ đã thay đổi. Hãy tạo lượt lưu mới.' } };
    }
    const groupKeys = Object.keys(groups);
    for (let index = 0; index < groupKeys.length; index++) {
      const key = groupKeys[index];
      const files = groups[key];
      const prior = state && state.groups[key];
      const explicitKey = keys[key] ? String(keys[key]) : '';
      const signature = files.length ? saveRequestDigest(JSON.stringify(files.map(function (file) {
        return [file.fileName, file.byteLength];
      }))) : '';
      if (prior && ((explicitKey && explicitKey !== prior.key) || (signature && signature !== prior.signature))) {
        return { reply: { success: false, code: 'SAVE_REQUEST_CHANGED', saveRequestId: id,
          error: 'Ảnh PDF đã thay đổi. Hãy tạo lượt lưu mới.' } };
      }
      if ((!prior && explicitKey && !files.length) || (prior && !prior.result && !files.length)) {
        return { reply: { success: false, code: 'SAVE_RETRY_EXPIRED', saveRequestId: id,
          error: 'Chưa có dữ liệu PDF ' + key + ' của lượt lưu này. Hãy gửi lại đầy đủ ảnh.' } };
      }
      if (state && !prior && files.length) {
        return { reply: { success: false, code: 'SAVE_REQUEST_CHANGED', saveRequestId: id,
          error: 'Danh sách PDF đã thay đổi. Hãy tạo lượt lưu mới.' } };
      }
    }
    if (state && state.result) return { reply: Object.assign({}, state.result, { replayed: true }) };
    if (state && state.leaseUntil > now) {
      return { reply: { success: false, code: 'SAVE_IN_PROGRESS', saveRequestId: id, retryAfterMs: 2500,
        error: 'Lượt lưu này vẫn đang xử lý trên Google. Vui lòng chờ rồi thử lại.' } };
    }
    if (!state) {
      state = { id: id, fingerprint: fingerprint, requestedRowIndex: Number(payload.rowIndex || 0),
        createdAtValue: createdAtValue, updatedAt: now, rowIndex: 0, rowCommitted: false, groups: {} };
      groupKeys.forEach(function (key) {
        if (!groups[key].length) return;
        const signature = saveRequestDigest(JSON.stringify(groups[key].map(function (file) { return [file.fileName, file.byteLength]; })));
        state.groups[key] = { key: keys[key] ? String(keys[key]) : signature, signature: signature,
          count: groups[key].length, nextIndex: 0 };
      });
    }
    // Bound retained state, leaving room under the Script Properties store limit.
    // Active leases are never evicted, so simultaneous users keep separate state.
    let entries = readSaveRequestIndex(properties);
    entries = entries.filter(function (entry) { return entry.id !== id; });
    const retained = [];
    entries.forEach(function (entry) {
      if (now - entry.at > SAVE_REQUEST_TTL_MS && !(entry.activeUntil > now)) {
        properties.deleteProperty(SAVE_REQUEST_PREFIX + entry.id);
      } else retained.push({ id: entry.id, at: entry.at, activeUntil: entry.activeUntil || 0 });
    });
    retained.sort(function (a, b) { return a.at - b.at; });
    while (retained.length >= 64) {
      const candidate = retained.findIndex(function (entry) { return !(entry.activeUntil > now); });
      if (candidate < 0) return { reply: { success: false, code: 'SAVE_BUSY', retryAfterMs: 2500,
        error: 'Có nhiều lượt lưu đồng thời. Vui lòng thử lại sau ít giây.' } };
      properties.deleteProperty(SAVE_REQUEST_PREFIX + retained[candidate].id);
      retained.splice(candidate, 1);
    }
    const owner = Utilities.getUuid();
    state.leaseOwner = owner;
    state.leaseUntil = now + SAVE_REQUEST_LEASE_MS;
    state.updatedAt = now;
    properties.setProperty(propertyKey, serializeSaveRequestState(state));
    retained.push({ id: id, at: now, activeUntil: state.leaseUntil });
    writeSaveRequestIndex(properties, retained);
    return { state: state, owner: owner, properties: properties, propertyKey: propertyKey };
  });
}

function checkpointSaveRequest(retry, lockHeld) {
  function write() {
    const raw = retry.properties.getProperty(retry.propertyKey);
    const current = raw ? JSON.parse(raw) : null;
    if (!current || current.leaseOwner !== retry.owner) throw new Error('Lượt lưu đã hết phiên. Hãy thử lại.');
    retry.state.updatedAt = Date.now();
    retry.state.leaseUntil = retry.state.updatedAt + SAVE_REQUEST_LEASE_MS;
    retry.properties.setProperty(retry.propertyKey, serializeSaveRequestState(retry.state));
  }
  if (lockHeld) write();
  else withScriptLock(write);
}

function serializeSaveRequestState(state) {
  // Exception details can repeat across many parts. Keep the response intact,
  // but bound retained warnings so a long Drive error cannot exceed the journal
  // service's per-value storage limit and prevent the next retry from completing.
  return JSON.stringify(state, function (key, value) {
    if ((key === 'warning' || key === 'sharingWarning') && typeof value === 'string') {
      return value.slice(0, key === 'warning' ? 400 : 160);
    }
    return value;
  });
}

function readSaveRequestIndex(properties) {
  let entries = [];
  try { entries = JSON.parse(properties.getProperty(SAVE_REQUEST_INDEX) || '[]'); } catch (ignored) {}
  return entries.map(function (entry) {
    return Array.isArray(entry) ? { id: entry[0], at: entry[1], activeUntil: entry[2] || 0 } : entry;
  });
}

function writeSaveRequestIndex(properties, entries) {
  // Compact tuples keep all 64 entries under the per-property byte limit even
  // when clients use the maximum permitted 100-character request IDs.
  properties.setProperty(SAVE_REQUEST_INDEX, JSON.stringify(entries.map(function (entry) {
    return [entry.id, entry.at, entry.activeUntil || 0];
  })));
}

function releaseSaveRequest(retry) {
  withScriptLock(function () {
    const raw = retry.properties.getProperty(retry.propertyKey);
    const current = raw ? JSON.parse(raw) : null;
    if (!current || current.leaseOwner !== retry.owner) return;
    // Use the persisted checkpoint after an error, so failed writes cannot erase
    // the last successful part or accidentally mark an unflushed row complete.
    current.leaseOwner = '';
    current.leaseUntil = 0;
    current.updatedAt = Date.now();
    retry.properties.setProperty(retry.propertyKey, serializeSaveRequestState(current));
    const entries = readSaveRequestIndex(retry.properties);
    entries.forEach(function (entry) {
      if (entry.id === current.id) { entry.at = current.updatedAt; entry.activeUntil = 0; }
    });
    writeSaveRequestIndex(retry.properties, entries);
  });
}

function savePdfUploadGroup(parent, files, fileName, resume, onProgress) {
  const multipart = files.length > 1;
  // A request owns its own folder; only retries of that request may reuse it.
  let folder = parent;
  let nextIndex = resume ? resume.nextIndex || 0 : 0;
  if (multipart) {
    if (resume && resume.folderId) {
      try { folder = DriveApp.getFolderById(resume.folderId); }
      catch (ignored) { folder = null; nextIndex = 0; }
    } else folder = null;
    if (!folder) folder = parent.createFolder(fileName.replace(/\.pdf$/i, '') + '_CAC_PHAN_' + Date.now());
  }
  const warnings = [];
  let inheritsSharing = false;
  if (multipart) {
    try {
      folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      inheritsSharing = true;
    }
    catch (error) { warnings.push('Không thể chia sẻ công khai thư mục các phần PDF: ' + error.toString()); }
  }
  let saved = resume && resume.lastSaved ? resume.lastSaved : null;
  if (onProgress) onProgress({ folderId: multipart ? folder.getId() : '', nextIndex: nextIndex });
  for (let index = nextIndex; index < files.length; index++) {
    try {
      saved = savePdfToDrive(folder, files[index].base64, files[index].fileName, inheritsSharing);
      if (saved.sharingWarning) warnings.push(saved.sharingWarning);
      if (onProgress) onProgress({ nextIndex: index + 1, lastSaved: saved });
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

function savePdfToDrive(folder, pdfBase64, fileName, inheritsSharing) {
  const clean = String(pdfBase64 || '').replace(/^data:.*;base64,/, '').trim();
  if (!clean) throw new Error('PDF Base64 rỗng');
  const bytes = Utilities.base64Decode(clean);
  if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF vượt giới hạn 10 MB.');
  const blob = Utilities.newBlob(bytes, 'application/pdf', fileName);
  const file = folder.createFile(blob);
  let sharingWarning = '';

  // New files inherit a successfully shared part folder's public view access.
  // Keep individual sharing for single files and folder-sharing failures.
  if (!inheritsSharing) {
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {
      sharingWarning = 'Không thể chia sẻ công khai file: ' + e.toString();
    }
  }

  return {
    fileId: file.getId(),
    fileUrl: file.getUrl(),
    sharingWarning: sharingWarning || undefined
  };
}
