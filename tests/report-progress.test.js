const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'baocaotiendo.html'), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).find(source => source.trim());
assert(script, 'The progress report must contain its application script.');

// The application remains private in production. Expose its actual functions only
// inside this VM so these checks do not duplicate the filtering implementation.
const instrumented = script.replace(/\}\)\(\);\s*$/, `
globalThis.progressTest = { state, compute, addRule, rules, getConfig, setLoaded, runReport };
})();`);
assert.notStrictEqual(instrumented, script, 'The test must expose the application closure.');

const voidTags = new Set(['input', 'meta', 'link', 'br', 'hr', 'img']);

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toLowerCase();
    this.ownerDocument = document;
    this.parentElement = null;
    this.childNodes = [];
    this.attributes = {};
    this.listeners = new Map();
    this.className = '';
    this._value = null;
    this._text = '';
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classList.contains(name) : Boolean(force);
        this.classList[enabled ? 'add' : 'remove'](name);
        return enabled;
      }
    };
  }
  get children() { return this.childNodes.filter(child => child.tagName !== '#text'); }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get options() { return this.querySelectorAll('option'); }
  get value() {
    if (this.tagName === 'select') {
      const options = this.options;
      if (this._value === null) return options.length ? options[0].value : '';
      return options.some(option => option.value === this._value) ? this._value : '';
    }
    return this._value === null ? (this.tagName === 'option' ? this.textContent : '') : this._value;
  }
  set value(value) { this._value = String(value); }
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(value) { this.replaceChildren(); parseMarkup(String(value), this); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'value') this.value = value;
    if (['disabled', 'checked', 'hidden'].includes(name)) this[name] = true;
  }
  append(...children) {
    for (const child of children) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      this.childNodes.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) {
    this.childNodes.forEach(child => { child.parentElement = null; });
    this.childNodes = [];
    this._text = '';
    this.append(...children);
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  add(option) { this.append(option); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    event.target = this;
    if (this['on' + event.type]) this['on' + event.type](event);
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    const matchesPart = (element, part) => {
      const checked = part.endsWith(':checked');
      if (checked) part = part.slice(0, -8);
      if (checked && !element.checked) return false;
      if (part.startsWith('.')) return element.classList.contains(part.slice(1));
      if (part.startsWith('#')) return element.attributes.id === part.slice(1);
      return element.tagName === part.toLowerCase();
    };
    const matches = element => {
      if (!matchesPart(element, parts[parts.length - 1])) return false;
      let parent = element.parentElement;
      for (let index = parts.length - 2; index >= 0; index--) {
        while (parent && !matchesPart(parent, parts[index])) parent = parent.parentElement;
        if (!parent) return false;
        parent = parent.parentElement;
      }
      return true;
    };
    const result = [];
    const visit = element => {
      for (const child of element.children) {
        if (matches(child)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

function parseMarkup(markup, root) {
  const stack = [root];
  for (const token of markup.match(/<!--[^]*?-->|<![^>]*>|<[^>]*>|[^<]+/g) || []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (!token.startsWith('<')) {
      const text = root.ownerDocument.createTextNode(token);
      stack[stack.length - 1].append(text);
      continue;
    }
    const match = token.match(/^<([\w-]+)([\s\S]*?)\/?\s*>$/);
    if (!match) continue;
    const element = root.ownerDocument.createElement(match[1]);
    for (const attribute of match[2].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
      element.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    stack[stack.length - 1].append(element);
    if (!voidTags.has(element.tagName) && !token.endsWith('/>')) stack.push(element);
  }
}

function boot(saved = []) {
  const document = {
    createElement: tag => new Element(tag, document),
    createTextNode(value) { const element = new Element('#text', document); element.textContent = value; return element; },
    getElementById: id => document.root.querySelector('#' + id),
    querySelectorAll: selector => document.root.querySelectorAll(selector)
  };
  document.root = document.createElement('document');
  parseMarkup(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ''), document.root);
  document.head = document.root.querySelector('head');
  const storage = new Map(saved);
  const context = {
    console, document, URL, URLSearchParams, Intl, Date, setTimeout, clearTimeout,
    Option: function Option(text, value) {
      const option = document.createElement('option');
      option.textContent = text;
      option.value = value;
      return option;
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(instrumented, context, { filename: 'baocaotiendo.html' });
  assert(context.progressTest, 'The application functions must be available to this test.');
  return { ...context.progressTest, storage, element: id => document.getElementById(id) };
}

const plain = value => JSON.parse(JSON.stringify(value));
const source = { id: 'progress-test', gid: '0' };
const records = [
  ['A', '2026-10-17T00:48:42.687Z', '10', 'alpha'],
  ['A', '2026-10-17T12:00:00.000Z', '20', 'beta'],
  ['A', '2026-10-18T09:00:00.000Z', '30', 'alpha'],
  ['B', 'prefix 2026-10-17T04:00:00.000Z', '40', 'alpha'],
  ['B', '2026-10-17T06:00:00.000Z', '50', 'alpha'],
  ['B', '2026-10-18T11:00:00.000Z', '60', 'alpha'],
  ['B', '', '70', 'alpha']
];
const table = {
  cols: ['Nhóm', 'Thời điểm', 'Số lượng', 'Ghi chú'].map(label => ({ label })),
  rows: records.map(row => ({ c: row.map(v => ({ v })) }))
};

const app = boot();
app.setLoaded(table, source);
const compute = (op, match, field = '1', rows = records) => app.compute(rows, { op, match, field });
assert.strictEqual(compute('count_contains', '2026-10-17'), 4, 'A partial date matches complete timestamps and embedded text.');
assert.strictEqual(compute('count_startswith', '2026-10-17'), 3, 'A prefix excludes timestamps embedded later in an unrelated value.');
assert.strictEqual(compute('count_startswith', '2026-10-17T'), 3, 'The user can include the ISO T separator.');
assert.strictEqual(compute('count_contains', '  2026-10-17t  '), 4, 'Queries are trimmed and case insensitive.');
assert.strictEqual(compute('count_contains', '2026-10-19'), 0);
for (const op of ['count_contains', 'count_startswith']) {
  assert.strictEqual(compute(op, '   '), 0, 'Blank matching text must not count every row.');
  assert.strictEqual(compute(op, undefined), 0, 'Missing matching text is safe for older configurations.');
  assert.strictEqual(compute(op, '2026', ''), 0, 'Text counts require a selected field.');
  assert.strictEqual(compute(op, 'cafe', '0', [['Café'], [null], [undefined], ['']]), 1, 'Text matching keeps existing accent normalization and handles empty cells.');
}
assert.strictEqual(compute('count_contains', '[x]*', '0', [['a.b [x]*'], ['xxx']]), 1, 'Matching text is literal rather than a regular expression.');
assert.strictEqual(compute('count', '', ''), 7);
assert.strictEqual(compute('nonempty', '', '1'), 6);
assert.strictEqual(compute('sum', '', '2'), 280);
assert.strictEqual(compute('avg', '', '2'), 40);
assert.strictEqual(compute('min', '', '2'), 10);
assert.strictEqual(compute('max', '', '2'), 70);

app.element('rules').replaceChildren();
app.addRule('count_contains', '1', ' 2026-10-17 ');
const firstRule = app.element('rules').lastElementChild;
const matchingInput = firstRule.querySelector('.metric-match');
const matchingWrap = firstRule.querySelector('.metric-match-wrap');
const operation = firstRule.querySelector('.metric-op');
assert(operation.options.some(option => option.value === 'count_contains'), 'The operation menu must offer contains matching.');
assert(operation.options.some(option => option.value === 'count_startswith'), 'The operation menu must offer prefix matching.');
assert(!matchingInput.disabled && !matchingWrap.hidden && !matchingWrap.classList.contains('hidden'), 'Text operations expose an enabled query field.');
assert.strictEqual(app.rules()[0].match, '2026-10-17');
assert(app.rules()[0].label.includes('2026-10-17'), 'Automatic metric labels identify the matching value.');
operation.value = 'sum';
operation.dispatchEvent({ type: 'change' });
assert(matchingInput.disabled && (matchingWrap.hidden || matchingWrap.classList.contains('hidden')), 'Numeric operations hide and disable the query field.');
operation.value = 'count_contains';
operation.dispatchEvent({ type: 'change' });
assert(!matchingInput.disabled && !matchingWrap.hidden && !matchingWrap.classList.contains('hidden'));

app.addRule('count_startswith', '1', '2026-10-17T');
app.element('rules').lastElementChild.querySelector('.metric-label').value = 'Theo ngày đăng ký';
app.addRule('sum', '2');
app.runReport();
assert.deepStrictEqual(plain(app.state.summary), [['Tất cả', '4', '3', '280']], 'An ungrouped report contains one total row for all metrics.');
app.element('group1').value = '0';
app.element('dateCol').value = '1';
app.runReport();
assert.deepStrictEqual(plain(app.state.summary), [['A', '2', '2', '60'], ['B', '2', '1', '220']], 'Each metric filters independently inside each group.');
assert.deepStrictEqual(plain(app.state.cumulative), [
  ['2026-10-17', '3', '3', '3', '3', '80', '80'],
  ['2026-10-18', '0', '3', '0', '3', '90', '170']
], 'Daily counts and cumulative counts use the same metric matching semantics.');
assert.strictEqual(app.state.details.length, 7, 'Per-metric matching must preserve the globally selected detail rows.');

app.element('searchAll').value = 'alpha';
app.element('dateFrom').value = '2026-10-17';
app.element('dateTo').value = '2026-10-17';
app.runReport();
assert.deepStrictEqual(plain(app.state.summary), [['A', '1', '1', '10'], ['B', '1', '1', '50']], 'Text counts respect the intersection of global search and date filters.');
assert.deepStrictEqual(plain(app.state.cumulative), [['2026-10-17', '2', '2', '2', '2', '60', '60']]);
assert.strictEqual(app.state.details.length, 2);
app.element('saveCfg').onclick();
const saved = JSON.parse([...app.storage.values()][0]);
assert.strictEqual(saved.config.rules[0].match, '2026-10-17');
assert.strictEqual(saved.config.rules[1].match, '2026-10-17T');
assert.strictEqual(saved.config.rules[0].customLabel, '');
assert.strictEqual(saved.config.rules[1].customLabel, 'Theo ngày đăng ký');
const reloaded = boot([...app.storage]);
reloaded.setLoaded(table, source);
assert.deepStrictEqual(plain(reloaded.getConfig()), plain(app.getConfig()), 'Saving and reloading restores matching values, operations and existing filters.');
assert.deepStrictEqual(plain(reloaded.state.summary), plain(app.state.summary));
assert.deepStrictEqual(plain(reloaded.state.cumulative), plain(app.state.cumulative));
const reloadedRules = reloaded.element('rules').children;
assert.strictEqual(reloadedRules[0].querySelector('.metric-label').value, '', 'Reloading preserves automatic naming rather than freezing the generated title.');
assert.strictEqual(reloadedRules[1].querySelector('.metric-label').value, 'Theo ngày đăng ký', 'An explicit custom title survives reloading.');
reloadedRules[0].querySelector('.metric-match').value = '2026-10-18';
reloaded.runReport();
assert(reloaded.rules()[0].label.includes('2026-10-18'), 'Automatic titles follow matching-value changes after reloading.');
assert.strictEqual(reloaded.state.summaryHeaders[1], reloaded.rules()[0].label);
assert.strictEqual(reloaded.state.summaryHeaders[2], 'Theo ngày đăng ký');

const oldSaved = plain(saved);
oldSaved.config.rules = [{ op: 'sum', field: '2', label: 'Tổng cũ', running: true }];
const oldStorage = [[...app.storage.keys()][0], JSON.stringify(oldSaved)];
const old = boot([oldStorage]);
old.setLoaded(table, source);
assert.strictEqual(old.rules()[0].op, 'sum');
assert.strictEqual(old.rules()[0].match, '', 'Legacy metrics without a match value remain compatible.');
assert.strictEqual(old.rules()[0].label, 'Tổng cũ', 'Legacy titles remain available when customLabel was not saved.');
assert.deepStrictEqual(plain(old.state.summary), [['A', '10'], ['B', '50']]);

console.log('PASS: progress-report substring/prefix metrics, literal and normalized matching, independent groups/cumulative totals, global filters, query controls and config compatibility');
