(function (root) {
  'use strict';
  function summarize(records) {
    return records.reduce((counts, row) => {
      counts.total++;
      if (String(row['File GCN'] || '').trim()) counts.withGcn++;
      if (String(row['Tình trạng xử lý'] || '').trim() !== 'Đã xử lý') counts.pending++;
      return counts;
    }, { total: 0, withGcn: 0, pending: 0 });
  }
  async function loadReport(url, fetcher = root.fetch.bind(root)) {
    let offset = 0;
    let expectedTotal = null;
    const counts = { total: 0, withGcn: 0, pending: 0 };
    const seen = new Set();
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let result;
      try {
        const response = await fetcher(url, {
          method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ action: 'REPORT', payload: { offset, limit: 500 } }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error('API trả lỗi HTTP ' + response.status);
        try { result = JSON.parse(await response.text()); }
        catch (_) { throw new Error('API không trả JSON. Kiểm tra quyền truy cập và bản triển khai Apps Script.'); }
      } finally { clearTimeout(timer); }
      if (result.success !== true || !Array.isArray(result.data)) throw new Error(result.error || 'API chưa hỗ trợ REPORT.');
      const total = Number(result.total);
      if (!Number.isSafeInteger(total) || total < 0 || Number(result.offset) !== offset) throw new Error('Phân trang API không hợp lệ.');
      if (expectedTotal !== null && total !== expectedTotal) throw new Error('Dữ liệu thay đổi trong khi đọc; hãy cập nhật lại báo cáo.');
      expectedTotal = total;
      if (result.data.length > 500 || offset + result.data.length > total || (!result.data.length && offset < total)) {
        throw new Error('API trả thiếu hoặc sai số lượng hồ sơ.');
      }
      for (const row of result.data) {
        if (row.rowIndex != null) {
          if (seen.has(row.rowIndex)) throw new Error('API trả trùng hồ sơ giữa các trang dữ liệu.');
          seen.add(row.rowIndex);
        }
      }
      const batch = summarize(result.data);
      for (const key of Object.keys(counts)) counts[key] += batch[key];
      offset += result.data.length;
      if (offset === total) return counts;
    }
  }
  root.LandReports = { summarize, loadReport };
  if (typeof module !== 'undefined') module.exports = root.LandReports;
})(typeof window !== 'undefined' ? window : global);
