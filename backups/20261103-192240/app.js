const phoneStatus = document.getElementById('phoneStatus');
const bleStatus = document.getElementById('bleStatus');
const pad = document.getElementById('pad');

let ws = null;
let last = null;
let sensitivity = 1.5;

function connect() {
  ws = new WebSocket('ws://192.168.4.1:81/');

  ws.onopen = () => {
    phoneStatus.textContent = 'PHONE CONNECTED';
  };

  ws.onclose = () => {
    phoneStatus.textContent = 'PHONE DISCONNECTED';
    setTimeout(connect, 1500);
  };

  ws.onerror = () => ws.close();
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(message);
  }
}

async function updateStatus() {
  try {
    const response = await fetch('/status');
    const data = await response.json();
    bleStatus.textContent = data.ble ? 'BLE: CONNECTED' : 'BLE: WAITING';
  } catch {
    bleStatus.textContent = 'BLE: UNKNOWN';
  }
}

connect();
updateStatus();
setInterval(updateStatus, 1500);

pad.addEventListener('pointerdown', event => {
  last = { x: event.clientX, y: event.clientY };
  pad.setPointerCapture(event.pointerId);
});

pad.addEventListener('pointermove', event => {
  if (!last) return;

  const dx = Math.round((event.clientX - last.x) * sensitivity);
  const dy = Math.round((event.clientY - last.y) * sensitivity);

  last = { x: event.clientX, y: event.clientY };

  if (dx || dy) send(`M ${dx} ${dy}`);
});

function stopMoving() {
  last = null;
}

pad.addEventListener('pointerup', stopMoving);
pad.addEventListener('pointercancel', stopMoving);

function setupButton(id, code) {
  const element = document.getElementById(id);

  element.addEventListener('pointerdown', event => {
    event.preventDefault();
    element.classList.add('active');
    send(`B ${code} 1`);
  });

  function release() {
    element.classList.remove('active');
    send(`B ${code} 0`);
  }

  element.addEventListener('pointerup', release);
  element.addEventListener('pointercancel', release);
  element.addEventListener('lostpointercapture', release);
}

setupButton('left', 'L');
setupButton('right', 'R');
setupButton('middle', 'M');

document.getElementById('scrollUp').onclick = () => send('S 3');
document.getElementById('scrollDown').onclick = () => send('S -3');

document.getElementById('sensitivity').addEventListener('input', event => {
  sensitivity = Number(event.target.value);
  document.getElementById('sensitivityValue').textContent =
    sensitivity.toFixed(1) + '×';
});
