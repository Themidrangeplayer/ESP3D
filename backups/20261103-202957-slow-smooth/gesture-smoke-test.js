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
    this.onpointerrawupdate = null;
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
  'hapticTest', 'hapticNote',
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
assert(totalX > 80 && totalY > 20, `movement too small: ${moves}`);
assert(!sent().some(m => m.startsWith('B L')), 'movement wrongly clicked');
console.log(`PASS  movement fixed-gain (${moves.length} msg, dx=${totalX}, dy=${totalY})`);

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
assert(scrolls.every(m => Number(m.split(' ')[1]) < 0), 'natural scroll direction wrong: ' + scrolls);
assert(!sent().some(m => m.startsWith('B R')), 'scroll wrongly clicked');
console.log(`PASS  two-finger drag -> scroll follows finger (${scrolls.join(', ')})`);

// ---- 5b. a paused release must not coast --------------------------------
const pausedCount = sent().filter(m => m.startsWith('S ')).length;
advance(600);
assert.strictEqual(
  sent().filter(m => m.startsWith('S ')).length,
  pausedCount,
  'paused release still coasted'
);
console.log('PASS  paused scroll release does not coast');

// ---- 5c. fast swipe coasts and gradually stops --------------------------
clearSent();
pad.dispatch('pointerdown', ev(32, 100, 100));
pad.dispatch('pointerdown', ev(33, 180, 100));
advance(8);
for (let i = 1; i <= 4; i++) {
  const y = 100 + i * 25;
  pad.dispatch('pointermove', ev(32, 100, y));
  pad.dispatch('pointermove', ev(33, 180, y));
  advance(16);
}
pad.dispatch('pointerup', ev(32, 100, 200));
pad.dispatch('pointerup', ev(33, 180, 200));

const directScroll = sent()
  .filter(m => m.startsWith('S '))
  .reduce((sum, m) => sum + Math.abs(Number(m.split(' ')[1])), 0);

advance(1200);

const coasted = sent().filter(m => m.startsWith('S '));
const totalScroll = coasted.reduce(
  (sum, m) => sum + Math.abs(Number(m.split(' ')[1])),
  0
);

assert(totalScroll > directScroll, `no momentum: ${directScroll} -> ${totalScroll}`);
assert(coasted.every(m => Number(m.split(' ')[1]) < 0), 'momentum direction wrong');
console.log(`PASS  fast swipe coasts (${directScroll} -> ${totalScroll} units)`);

advance(2500);
const settledCount = sent().filter(m => m.startsWith('S ')).length;
advance(800);
assert.strictEqual(
  sent().filter(m => m.startsWith('S ')).length,
  settledCount,
  'momentum did not gradually stop'
);
console.log('PASS  momentum gradually stops');

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

// ---- 7. hold still -> left button latches and drags ----------------------
clearSent();
pad.dispatch('pointerdown', ev(50, 200, 200));
advance(460);
assert(sent().includes('B L 1'), 'hold did not press left: ' + sent());
assert.strictEqual(elements.get('padFeedback').textContent, 'DRAG');
clearSent();
pad.dispatch('pointermove', ev(50, 260, 230));
advance(40);
const dragMoves = sent().filter(m => m.startsWith('M '));
assert(dragMoves.length >= 1, 'drag movement missing: ' + sent());
pad.dispatch('pointerup', ev(50, 260, 230));
advance(40);
assert(sent().includes('B L 0'), 'drag release missing: ' + sent());
assert(!sent().some(m => m === 'B L 1'), 'drag caused a second press');
console.log('PASS  hold to drag presses and releases left button');

// ---- 8. moving before the hold delay does not latch a drag --------------
clearSent();
pad.dispatch('pointerdown', ev(55, 200, 200));
pad.dispatch('pointermove', ev(55, 240, 200));
advance(400);
assert(!sent().some(m => m === 'B L 1'), 'early movement latched a drag');
pad.dispatch('pointerup', ev(55, 240, 200));
advance(40);
console.log('PASS  early movement cancels hold-to-drag');

// ---- 9. slow sub-pixel motion is not discarded --------------------------
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
assert(slowTotal >= 10, `sub-pixel movement lost: dx=${slowTotal}`);
console.log(`PASS  sub-pixel movement preserved (dx=${slowTotal} for 7.5 px raw)`);

// ---- 10. pointermove + pointerrawupdate duplicates must not double-count --
clearSent();
pad.dispatch('pointerdown', ev(70, 100, 100));
pad.dispatch('pointermove', ev(70, 120, 100));
pad.dispatch('pointerrawupdate', ev(70, 120, 100));
pad.dispatch('pointermove', ev(70, 140, 100));
pad.dispatch('pointerrawupdate', ev(70, 140, 100));
pad.dispatch('pointerup', ev(70, 140, 100));
advance(40);
const dupTotal = sent()
  .filter(m => m.startsWith('M '))
  .reduce((sum, m) => sum + Number(m.split(' ')[1]), 0);
assert.strictEqual(dupTotal, 60, `duplicate events doubled movement: ${dupTotal}`);
console.log(`PASS  raw update duplicates are not double-counted (dx=${dupTotal})`);

console.log('\nAll headless checks passed.');
