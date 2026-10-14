const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const reports = require('../assets/report-dashboard.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'baocao.html'), 'utf8');
function matches(pattern) {
  const result = []; let match;
  while ((match = pattern.exec(html))) result.push(match);
  return result;
}
const scripts = matches(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)
  .map(match => match[1]).filter(source => source.trim());
const ids = ['HamGiang', 'TraCu', 'LongHiep', 'TapSon', 'LuuNghiepAnh', 'DaiAn'];
const storageKey = id => `landReport:${id}:csvUrl`;
const sheetUrl = id => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;
const defaults = ids.reduce((result, id) => { result[id] = sheetUrl('default-' + id); return result; }, {});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.value = '';
    this.disabled = false;
    this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  focus() {}
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function boot({ saved = [], blockedStorage = false, configured = defaults, defer } = {}) {
  const elements = new Map(matches(/\bid="([^"]+)"/g).map(match => [match[1], new Element()]));
  elements.get('recordFilter').value = 'collectedPending';
  const storage = new Map(saved);
  const calls = [], pending = [], listeners = new Map();
  const localStorage = {
    getItem(key) { if (blockedStorage) throw new Error('Storage unavailable'); return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { if (blockedStorage) throw new Error('Storage unavailable'); storage.set(key, String(value)); },
    removeItem(key) { if (blockedStorage) throw new Error('Storage unavailable'); storage.delete(key); }
  };
  function resultFor(input) {
    const total = input.includes('custom') ? 7 : 1;
    return { counts: { total, withGcn: 0, pending: total }, records: [] };
  }
  const context = {
    console, URL, URLSearchParams, Intl, Date, Map, Promise,
    localStorage,
    LAND_REPORT_DEFAULT_CSV: { ...configured },
    document: {
      getElementById(id) {
        assert(elements.has(id), 'Missing element #' + id);
        return elements.get(id);
      },
      createElement: tag => new Element(tag)
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    LandReports: {
      ...reports,
      loadReport(input) {
        reports.csvUrl(input);
        calls.push(input);
        if (defer && defer(input, calls.length)) {
          return new Promise((resolve, reject) => pending.push({ input, resolve: () => resolve(resultFor(input)), reject }));
        }
        return Promise.resolve(resultFor(input));
      }
    }
  };
  context.window = context;
  vm.createContext(context);
  scripts.forEach(source => vm.runInContext(source, context, { filename: 'baocao.html' }));
  await settle();
  const element = id => elements.get(id);
  return {
    storage, calls, pending, element,
    async save(input) { element('csvUrl').value = input; element('saveCsv').onclick(); await settle(); },
    async reset() { element('resetCsv').onclick(); await settle(); },
    async select(index) { element('tabs').children[index].onclick(); await settle(); },
    async storageEvent(key) { listeners.get('storage')({ key }); await settle(); }
  };
}

(async () => {
  assert(/<script\s+src="\.\/assets\/report-config\.js"/.test(html), 'The dashboard must load the deployed default-source configuration.');
  const fresh = await boot();
  assert.deepStrictEqual(fresh.calls, Object.values(defaults), 'Fresh visitors automatically load all six configured sources.');
  assert.strictEqual(fresh.element('csvUrl').value, defaults.HamGiang);
  assert.strictEqual(fresh.element('total').textContent, '6');
  assert(/mặc định/i.test(fresh.element('csvSource').textContent));

  const customHamGiang = sheetUrl('custom-HamGiang');
  await fresh.save(customHamGiang);
  assert.strictEqual(fresh.storage.get(storageKey('HamGiang')), customHamGiang);
  assert.strictEqual(fresh.calls.slice(-1)[0], customHamGiang);
  assert.strictEqual(fresh.element('total').textContent, '12');
  const reloaded = await boot({ saved: [...fresh.storage] });
  assert.strictEqual(reloaded.calls[0], customHamGiang, 'A saved visitor override survives a page reload.');
  assert.strictEqual(reloaded.element('csvUrl').value, customHamGiang);
  assert(/tùy chỉnh/i.test(reloaded.element('csvSource').textContent));

  const priorCalls = reloaded.calls.length;
  await reloaded.save('https://example.test/not-a-sheet.csv');
  assert.strictEqual(reloaded.storage.get(storageKey('HamGiang')), customHamGiang, 'Invalid input must not overwrite the working source.');
  assert.strictEqual(reloaded.calls.length, priorCalls, 'Invalid input must not trigger loading.');
  assert.strictEqual(reloaded.element('total').textContent, '12', 'Invalid input keeps existing reports available.');

  await reloaded.reset();
  assert(!reloaded.storage.has(storageKey('HamGiang')), 'Reset removes the visitor override rather than saving a stale default.');
  assert.strictEqual(reloaded.calls.slice(-1)[0], defaults.HamGiang);
  assert.strictEqual(reloaded.element('csvUrl').value, defaults.HamGiang);
  assert.strictEqual(reloaded.element('total').textContent, '6');

  await reloaded.select(1);
  const customTraCu = sheetUrl('custom-TraCu');
  await reloaded.save(customTraCu);
  assert.strictEqual(reloaded.storage.get(storageKey('TraCu')), customTraCu);
  assert(!reloaded.storage.has(storageKey('HamGiang')), 'Changing one commune must not change another.');
  await reloaded.select(0);
  assert.strictEqual(reloaded.element('csvUrl').value, defaults.HamGiang);
  await reloaded.select(1);
  await reloaded.save('   ');
  assert(!reloaded.storage.has(storageKey('TraCu')), 'Saving a blank value restores the shared default.');
  assert.strictEqual(reloaded.calls.slice(-1)[0], defaults.TraCu);

  const legacy = await boot({ saved: [[storageKey('HamGiang'), '  '], [storageKey('TraCu'), '']] });
  assert.deepStrictEqual(legacy.calls, Object.values(defaults), 'Legacy blank settings must not mask deployed defaults.');

  const partial = await boot({ configured: { HamGiang: defaults.HamGiang } });
  assert.deepStrictEqual(partial.calls, [defaults.HamGiang], 'An unconfigured commune must not prevent other reports from loading.');
  assert.strictEqual(partial.element('total').textContent, '1');
  await partial.select(1);
  assert.strictEqual(partial.element('csvUrl').value, '');
  assert(/chưa.*mặc định/i.test(partial.element('csvSource').textContent));
  await partial.save(customTraCu);
  assert.strictEqual(partial.element('total').textContent, '8', 'Visitors can configure communes that have no deployed default.');
  await partial.reset();
  assert.strictEqual(partial.element('total').textContent, '1');
  assert.strictEqual(partial.element('csvUrl').value, '');

  const blocked = await boot({ blockedStorage: true });
  assert.deepStrictEqual(blocked.calls, Object.values(defaults), 'Unavailable storage must not stop initial reports.');
  await blocked.save(customHamGiang);
  assert.strictEqual(blocked.calls.slice(-1)[0], customHamGiang, 'Visitors can use a temporary override when storage is unavailable.');
  await blocked.select(1);
  await blocked.select(0);
  assert.strictEqual(blocked.element('csvUrl').value, customHamGiang);
  assert(/tạm|phiên|không.*lưu|lần mở trang/i.test(blocked.element('csvSource').textContent), 'Temporary preferences must be explained to the visitor.');
  await blocked.reset();
  assert.strictEqual(blocked.calls.slice(-1)[0], defaults.HamGiang);
  assert.strictEqual(blocked.element('csvUrl').value, defaults.HamGiang);

  const crossTab = await boot();
  crossTab.storage.set(storageKey('TraCu'), customTraCu);
  await crossTab.storageEvent(storageKey('TraCu'));
  assert.strictEqual(crossTab.calls.length, 7, 'A per-commune storage update reloads only that commune.');
  assert.strictEqual(crossTab.calls.slice(-1)[0], customTraCu);
  crossTab.storage.clear();
  await crossTab.storageEvent(null);
  assert.deepStrictEqual(crossTab.calls.slice(-6), Object.values(defaults), 'Clearing browser settings refreshes all default sources.');
  assert.strictEqual(crossTab.element('total').textContent, '6');

  const delayed = await boot({ defer: input => input === customHamGiang });
  await delayed.save(customHamGiang);
  assert.strictEqual(delayed.pending.length, 1);
  await delayed.reset();
  assert.strictEqual(delayed.element('total').textContent, '6');
  delayed.pending[0].resolve();
  await settle();
  assert.strictEqual(delayed.element('total').textContent, '6', 'An old request must not replace data loaded after a preference change.');
  assert.strictEqual(delayed.element('csvUrl').value, defaults.HamGiang);

  console.log('PASS: shared defaults/autoload, browser overrides/reload/reset, blank and invalid inputs, blocked storage, source isolation, cross-tab updates and stale-load protection');
})().catch(error => { console.error(error); process.exitCode = 1; });
