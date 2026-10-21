const assert = require('assert');
if (typeof AbortController === 'undefined') global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
const reports = require('../assets/report-dashboard.js');
const header = 'STT,Họ Tên CSD,File GCN,Tình trạng xử lý';
const csv = '\uFEFF' + header + '\r\n1,"Nguyễn, Văn ""A""",https://example.test/gcn,Chưa xử lý\r\n2,"Tên\ntrên hai dòng",,Đã xử lý\r\n3,Người B, ,\r\n\r\n';
const rows = reports.parseCsv(csv);
assert.strictEqual(rows.length, 3);
assert.strictEqual(rows[0]['Họ Tên CSD'], 'Nguyễn, Văn "A"');
assert.strictEqual(rows[1]['Họ Tên CSD'], 'Tên\ntrên hai dòng');
assert.deepStrictEqual(reports.summarize(rows), { total: 3, withGcn: 1, pending: 2 });
assert.strictEqual(rows.filter(row => reports.hasGcn(row) && reports.isPending(row)).length, 1);
assert.strictEqual(reports.parseCsv(header + '\n').length, 0);
assert.throws(() => reports.parseCsv('<html>Login</html>'), /HTML/);
assert.throws(() => reports.parseCsv('Other\n1'), /thiếu cột/);
assert.throws(() => reports.parseCsv(header + '\n1,"unclosed'), /dấu nháy/);
assert.throws(() => reports.parseCsv(header + '\n1,name'), /số cột/);
const published = 'https://docs.google.com/spreadsheets/d/e/2PACX-test/pub?output=csv&gid=123&single=true';
assert.strictEqual(reports.csvUrl(published), published);
assert.strictEqual(reports.csvUrl('https://docs.google.com/spreadsheets/d/test-id/edit#gid=42'), 'https://docs.google.com/spreadsheets/d/test-id/export?format=csv&gid=42');
assert.throws(() => reports.csvUrl('https://script.google.com/macros/s/test/exec'), /Google Sheet/);
const searchable = {
  'Họ Tên CSD': 'Nguyễn Thị Hồng Ánh',
  'Số hiệu tờ bản đồ mới': '12A',
  'Số thứ tự thửa mới': '345',
  'Số hiệu tờ bản đồ cũ': '07-B',
  'Số thứ tự thửa cũ': '891'
};
assert.strictEqual(reports.normalizeSearchText('Đặng Ánh'), 'dang anh');
assert.strictEqual(reports.matchesRecordFilters(searchable, { name: 'thi hong' }), true);
assert.strictEqual(reports.matchesRecordFilters(searchable, { name: 'hong a' }), true);
assert.strictEqual(reports.matchesRecordFilters(searchable, { name: 'van' }), false);
assert.strictEqual(reports.matchesRecordFilters(searchable, { newSheet: '2a', oldPlot: '89' }), true);
assert.strictEqual(reports.matchesRecordFilters(searchable, { newSheet: '12', oldPlot: '999' }), false);
assert.strictEqual(reports.matchesRecordFilters(searchable, { all: '07-b' }), true);
assert.strictEqual(reports.matchesRecordFilters(searchable, { all: '12a 345' }), true);
assert.strictEqual(reports.matchesRecordFilters(searchable, { all: 'khong co' }), false);
(async () => {
  const result = await reports.loadReport(published, async (url, options) => {
    assert.strictEqual(url, published); assert.strictEqual(options.method, 'GET'); assert.strictEqual(options.credentials, 'omit'); assert.strictEqual(options.body, undefined);
    return { ok: true, text: async () => csv };
  });
  assert.strictEqual(result.records.length, 3);
  assert.strictEqual(result.counts.withGcn, 1);
  const large = header + '\n' + Array.from({ length: 1203 }, (_, i) => `${i + 1},Person,link,Chưa xử lý`).join('\n');
  assert.strictEqual(reports.summarize(reports.parseCsv(large)).total, 1203);
  console.log('PASS: CSV quoting/BOM/newlines, validation, URL conversion, GET-only loading, counts and collected-pending filter');
})().catch(error => { console.error(error); process.exitCode = 1; });
