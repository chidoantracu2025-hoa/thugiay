(function (root) {
  'use strict';
  const hasGcn = row => Boolean(String(row['File GCN'] || '').trim());
  const isPending = row => String(row['Tình trạng xử lý'] || '').trim() !== 'Đã xử lý';
  function summarize(records) {
    return records.reduce((counts, row) => {
      counts.total++;
      if (hasGcn(row)) counts.withGcn++;
      if (isPending(row)) counts.pending++;
      return counts;
    }, { total: 0, withGcn: 0, pending: 0 });
  }
  function csvUrl(input) {
    let url;
    try { url = new URL(input); } catch (_) { throw new Error('Link Google Sheet không hợp lệ.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.username || url.password) throw new Error('Nhập link Google Sheet công khai trên docs.google.com.');
    const published = url.pathname.match(/^\/spreadsheets\/d\/e\/([\w-]+)\/(?:pub|pubhtml)\/?$/);
    const sheet = url.pathname.match(/^\/spreadsheets\/d\/([\w-]+)(?:\/(?:edit|view|export|gviz\/tq))?\/?$/);
    const hash = new URLSearchParams(url.hash.slice(1));
    const gid = url.searchParams.get('gid') || hash.get('gid') || '0';
    if (!/^\d+$/.test(gid)) throw new Error('gid của trang tính không hợp lệ.');
    if (published) return `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?output=csv&gid=${gid}&single=true`;
    if (sheet) return `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv&gid=${gid}`;
    throw new Error('Nhập link trang tính Google Sheet hoặc link xuất bản CSV.');
  }
  function parseCsv(text) {
    text = String(text).replace(/^\uFEFF/, '');
    if (/^\s*</.test(text)) throw new Error('Link trả trang HTML. Hãy công khai hoặc xuất bản trang tính dưới dạng CSV.');
    const rows = []; let row = [], field = '', quoted = false, closed = false;
    const pushRow = () => { row.push(field); if (row.some(value => value.trim())) rows.push(row); row = []; field = ''; closed = false; };
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
        else field += char;
      } else if (char === ',' ) { row.push(field); field = ''; closed = false; }
      else if (char === '\r' || char === '\n') { if (char === '\r' && text[i + 1] === '\n') i++; pushRow(); }
      else if (char === '"' && !field && !closed) quoted = true;
      else { if (closed || char === '"') throw new Error('CSV có dấu nháy không hợp lệ.'); field += char; }
    }
    if (quoted) throw new Error('CSV thiếu dấu nháy đóng.');
    if (field || row.length || closed) pushRow();
    if (!rows.length) throw new Error('CSV không có dòng tiêu đề.');
    const headers = rows.shift().map(value => value.trim().normalize('NFC'));
    for (const name of ['File GCN', 'Tình trạng xử lý']) if (!headers.includes(name)) throw new Error('CSV thiếu cột “' + name + '”.');
    if (new Set(headers).size !== headers.length || headers.some(name => !name)) throw new Error('Tiêu đề CSV bị trùng hoặc trống.');
    return rows.map((values, index) => {
      if (values.length !== headers.length) throw new Error('CSV sai số cột tại dòng dữ liệu ' + (index + 2));
      const record = Object.create(null);
      headers.forEach((header, i) => { record[header] = values[i]; });
      return record;
    });
  }
  async function loadReport(input, fetcher = root.fetch.bind(root)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetcher(csvUrl(input), { method: 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('Không tải được CSV (HTTP ' + response.status + '). Kiểm tra quyền công khai của Sheet.');
      const records = parseCsv(await response.text());
      return { counts: summarize(records), records };
    } finally { clearTimeout(timer); }
  }
  root.LandReports = { summarize, loadReport, parseCsv, csvUrl, hasGcn, isPending };
  if (typeof module !== 'undefined') module.exports = root.LandReports;
})(typeof window !== 'undefined' ? window : global);
