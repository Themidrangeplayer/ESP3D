'use strict';
/* Headless smoke test for phone-app/js/app.js using a fake DOM/clock. */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

let clock = 0;
let taskId = 1;
let tasks = [];
let frames = 0;

class FakeEl {
  constructor(id) {
    this.id = id;
    this.listeners = new Map();
    this.dataset = {};
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.classes = new Set();
    this.classList = {
      add: c => this.classes.add(c),
      remove: c => this.classes.delete(c),
      contains: c => this.classes.has(c),
    };
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    const base = { preventDefault() {}, stopPropagation() {} };
    for (const fn of this.listeners.get(type) || []) fn({ ...base, ...event });
  }
  setPointerCapture() {}
}

const ids = [
  'phoneStatus', 'bleStatus', 'pad', 'padFeedback',
  'sensitivity', 'sensitivityValue', 'scrollSensitivity',
  'scrollSensitivityValue', 'naturalScroll', 'hapticsEnabled',
  'hapticIntensity', 'hapticIntensityValue', 'connectionAlerts',
  'hapticTest', 'hapticNote', 'left', 'right', 'middle',
];

const elements = new Map(ids.map(id => [id, new FakeEl(id)]));
const documentListeners = new Map();

const document = {
  hidden: false,
  getElementById: id => elements.get(id) || null,
  addEventListener: (type, fn) => {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(fn);
  },
};
const windowListeners = new Map();
const window = {
  addEventListener: (type, fn) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(fn);
  },
};

let wsInstance = null;
class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWS.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    wsInstance = this;
  }
  send(message) { this.sent.push(message); }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
}

const vibrations = [];

const sandbox = {
  console,
  document,
  window,
  location: { hostname: '192.168.4.1', protocol: 'http:' },
  WebSocket: FakeWS,
  navigator: { vibrate: p => { vibrations.push(p); return true; } },
  performance: { now: () => clock },
  localStorage: {
    store: new Map(),
    getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
    setItem(k, v) { this.store.set(k, v); },
  },
  fetch: () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ble: true, wifiClients: 1 }),
  }),
  setTimeout: (fn, ms) => {
    const t = { id: taskId++, at: clock + (ms || 0), fn, kind: 't' };
    tasks.push(t);
    return t.id;
  },
  clearTimeout: id => { tasks = tasks.filter(t => t.id !== id); },
  setInterval: () => 0,
  requestAnimationFrame: fn => {
    const t = { id: taskId++, at: clock + 16, fn, kind: 'f' };
    tasks.push(t);
    return t.id;
  },
  cancelAnimationFrame: id => { tasks = tasks.filter(t => t.id !== id); },
  Math,
  Number,
  JSON,
  Promise,
  Error,
  String,
  Object,
  Array,
  Set,
  Map,
  isFinite,
  isNaN,
};

vm.createContext(sandbox);

const source = fs.readFileSync('phone-app/js/app.js', 'utf8');
vm.runInContext(source, sandbox, { filename: 'app.js' });

function advance(ms) {
  const target = clock + ms;
  let guard = 0;
  while (true) {
    tasks.sort((a, b) => a.at - b.at || a.id - b.id);
    const task = tasks[0];
    if (!task || task.at > target) break;
    if (++guard > 50000) throw new Error('task explosion');
    tasks.shift();
    clock = task.at;
    if (task.kind === 'f') { frames++; task.fn(clock); } else { task.fn(); }
  }
  clock = target;
}

function ev(id, x, y) {
  return { pointerId: id, clientX: x, clientY: y, pointerType: 'touch' };
}

const pad = elements.get('pad');
const sent = () => wsInstance.sent.slice();
const clearSent = () => { wsInstance.sent.length = 0; };

// Open the link.
wsInstance.readyState = FakeWS.OPEN;
wsInstance.onopen();
advance(20);

// ---- 1. one-finger tap = left click -------------------------------------
clearSent();
pad.dispatch('pointerdown', ev(1, 200, 200));
advance(80);
pad.dispatch('pointerup', ev(1, 200, 200));
advance(40);
assert(sent().includes('B L 1'), 'left press missing: ' + sent());
assert(sent().includes('B L 0'), 'left release missing: ' + sent());
assert.strictEqual(elements.get('padFeedback').textContent, 'LEFT CLICK');
assert(vibrations.length > 0, 'left haptic missing');
console.log('PASS  one-finger tap -> left click');

// ---- 2. movement is coalesced and total delta is preserved ---------------
clearSent();
pad.dispatch('pointerdown', ev(2, 100, 100));
pad.dispatch('pointermove', ev(2, 160, 120));
advance(60);
pad.dispatch('pointerup', ev(2, 160, 120));
advance(30);
const moves = sent().filter(m => m.startsWith('M '));
assert(moves.length >= 1, 'movement missing');
const totalX = moves.reduce((sum, m) => sum + Number(m.split(' ')[1]), 0);
const totalY = moves.reduce((sum, m) => sum + Number(m.split(' ')[2]), 0);
assert(totalX > 100 && totalY > 0, `movement too small: ${moves}`);
assert(!sent().some(m => m.startsWith('B L')), 'movement wrongly clicked');
console.log(`PASS  movement coalesced (${moves.length} msg, dx=${totalX}, dy=${totalY})`);

// ---- 3. two-finger tap = right click ------------------------------------
clearSent();
pad.dispatch('pointerdown', ev(10, 100, 100));
advance(20);
pad.dispatch('pointerdown', ev(11, 180, 100));
advance(80);
pad.dispatch('pointerup', ev(10, 100, 100));
pad.dispatch('pointerup', ev(11, 180, 100));
advance(40);
assert(sent().includes('B R 1'), 'right press missing: ' + sent());
assert(sent().includes('B R 0'), 'right release missing: ' + sent());
assert(sent().filter(m => m.startsWith('M ')).length === 0, 'tap moved cursor');
console.log('PASS  two-finger tap -> right click');

// ---- 4. three-finger tap = middle click ---------------------------------
clearSent();
pad.dispatch('pointerdown', ev(20, 100, 100));
pad.dispatch('pointerdown', ev(21, 150, 100));
pad.dispatch('pointerdown', ev(22, 200, 100));
advance(80);
pad.dispatch('pointerup', ev(20, 100, 100));
pad.dispatch('pointerup', ev(21, 150, 100));
pad.dispatch('pointerup', ev(22, 200, 100));
advance(40);
assert(sent().includes('B M 1'), 'middle press missing: ' + sent());
assert(sent().includes('B M 0'), 'middle release missing: ' + sent());
console.log('PASS  three-finger tap -> middle click');

// ---- 5. two-finger vertical drag = vertical scroll ----------------------
clearSent();
pad.dispatch('pointerdown', ev(30, 100, 100));
pad.dispatch('pointerdown', ev(31, 180, 100));
advance(10);
pad.dispatch('pointermove', ev(30, 100, 140));
pad.dispatch('pointermove', ev(31, 180, 140));
advance(120);
pad.dispatch('pointerup', ev(30, 100, 140));
pad.dispatch('pointerup', ev(31, 180, 140));
advance(40);
const scrolls = sent().filter(m => m.startsWith('S '));
assert(scrolls.length >= 1, 'scroll missing: ' + sent());
assert(scrolls.every(m => Number(m.split(' ')[1]) > 0), 'natural scroll direction wrong: ' + scrolls);
assert(!sent().some(m => m.startsWith('B R')), 'scroll wrongly clicked');
console.log(`PASS  two-finger drag -> scroll (${scrolls.join(', ')})`);

// ---- 6. horizontal drag never sends H while unsupported -----------------
clearSent();
pad.dispatch('pointerdown', ev(40, 100, 100));
pad.dispatch('pointerdown', ev(41, 100, 180));
advance(10);
pad.dispatch('pointermove', ev(40, 180, 100));
pad.dispatch('pointermove', ev(41, 180, 180));
advance(120);
pad.dispatch('pointerup', ev(40, 180, 100));
pad.dispatch('pointerup', ev(41, 180, 180));
advance(20);
assert(!sent().some(m => m.startsWith('H ')), 'H command sent without firmware support');
console.log('PASS  horizontal drag does not fake H scroll');

// ---- 7. held physical button suppresses pad tap -------------------------
clearSent();
const leftButton = elements.get('left');
leftButton.dispatch('pointerdown', ev(50, 10, 10));
assert.strictEqual(sent().filter(m => m === 'B L 1').length, 1);
clearSent();
pad.dispatch('pointerdown', ev(51, 200, 200));
advance(60);
pad.dispatch('pointerup', ev(51, 200, 200));
advance(40);
assert(!sent().some(m => m.startsWith('B L')), 'pad tap overrode held button');
leftButton.dispatch('pointerup', ev(50, 10, 10));
assert(sent().includes('B L 0'), 'physical button release missing');
console.log('PASS  held physical button suppresses pad tap');

// ---- 8. slow sub-pixel motion is not discarded --------------------------
clearSent();
pad.dispatch('pointerdown', ev(60, 100, 100));
for (let i = 1; i <= 30; i++) {
  pad.dispatch('pointermove', ev(60, 100 + i * 0.25, 100));
  advance(16);
}
pad.dispatch('pointerup', ev(60, 107.5, 100));
advance(40);
const slowTotal = sent()
  .filter(m => m.startsWith('M '))
  .reduce((sum, m) => sum + Number(m.split(' ')[1]), 0);
assert(slowTotal >= 7, `sub-pixel movement lost: dx=${slowTotal}`);
console.log(`PASS  sub-pixel movement preserved (dx=${slowTotal} for 7.5 px raw)`);

console.log('\nAll headless checks passed.');
