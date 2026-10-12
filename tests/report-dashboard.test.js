const assert = require('assert');
if (typeof AbortController === 'undefined') global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
const reports = require('../assets/report-dashboard.js');
const makeRow = index => ({ rowIndex: index + 2,
  'File GCN': index % 2 === 0 ? ' https://example.test/gcn ' : ' ',
  'Tình trạng xử lý': index % 3 === 0 ? 'Đã xử lý' : '' });
const response = body => ({ ok: true, text: async () => JSON.stringify(body) });
(async () => {
  const rows = Array.from({ length: 1203 }, (_, i) => makeRow(i));
  const offsets = [];
  const mock = async (url, options) => {
    const { action, payload } = JSON.parse(options.body);
    assert.strictEqual(action, 'REPORT'); offsets.push(payload.offset);
    return response({ success: true, total: rows.length, offset: payload.offset, data: rows.slice(payload.offset, payload.offset + 500) });
  };
  const counts = await reports.loadReport('test', mock);
  assert.deepStrictEqual(offsets, [0, 500, 1000]);
  assert.deepStrictEqual(counts, { total: 1203, withGcn: 602, pending: 802 });
  assert.deepStrictEqual(await reports.loadReport('test', async () => response({ success: true, total: 0, offset: 0, data: [] })), { total: 0, withGcn: 0, pending: 0 });
  async function rejects(mock, message) {
    let error; try { await reports.loadReport('test', mock); } catch (e) { error = e; }
    assert(error && message.test(error.message));
  }
  await rejects(async () => response({ success: true, total: 3, offset: 0, data: [] }), /thiếu/);
  await rejects(async () => ({ ok: true, text: async () => '<html>Login</html>' }), /JSON/);
  await rejects(async () => response({ success: false, error: 'Unauthorized' }), /Unauthorized/);
  await rejects(async (_, options) => {
    const offset = JSON.parse(options.body).payload.offset;
    return response({ success: true, total: offset === 0 ? 501 : 502, offset, data: [makeRow(0)] });
  }, /thay đổi/);
  await rejects(async (_, options) => {
    const offset = JSON.parse(options.body).payload.offset;
    return response({ success: true, total: 2, offset, data: [makeRow(0)] });
  }, /trùng/);
  console.log('PASS: full pagination, GCN/pending counts, empty report, malformed API, changing totals and duplicate rows');
})().catch(error => { console.error(error); process.exitCode = 1; });
