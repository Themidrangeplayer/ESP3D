#pragma once
#include <Arduino.h>

const char INDEX_HTML[] PROGMEM = R"ESP3D(
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#101319">
<title>ESP3D Controller</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
  <div class="brand">ESP3D</div>
  <div class="subtitle">WIRELESS CONTROL SYSTEM</div>
</header>

<div class="connection">
  <span id="phoneStatus">Connecting to ESP32...</span>
  <span id="bleStatus">BLE: Checking...</span>
</div>

<main>
  <div class="section-title">MOUSE CONTROL</div>
  <div id="pad" class="touchpad">
    <div class="pad-label">TOUCHPAD</div>
    <div class="pad-hint">Move your finger to control the cursor</div>
  </div>

  <div class="button-row">
    <button id="left">LEFT</button>
    <button id="right">RIGHT</button>
    <button id="middle">MIDDLE</button>
  </div>

  <div class="section-title">SCROLL</div>
  <div class="button-row">
    <button id="scrollUp">▲ UP</button>
    <button id="scrollDown">▼ DOWN</button>
  </div>

  <div class="section-title">SENSITIVITY</div>
  <div class="sensitivity">
    <input id="sensitivity" type="range" min="0.5" max="4" step="0.1" value="1.5">
    <span id="sensitivityValue">1.5×</span>
  </div>
</main>

<footer>ESP3D · LOCAL WIRELESS CONTROL</footer>
<script src="/app.js"></script>
</body>
</html>

)ESP3D";

const char STYLE_CSS[] PROGMEM = R"ESP3D(
*{box-sizing:border-box}
body{
 margin:0;background:#101319;color:#edf2fa;
 font-family:Arial,sans-serif;touch-action:pan-y;
}
header{
 padding:23px;text-align:center;
 border-bottom:1px solid #303744;
}
.brand{font-size:27px;font-weight:bold;letter-spacing:3px}
.subtitle{color:#929eaf;font-size:11px;margin-top:7px;letter-spacing:2px}
.connection{
 display:flex;justify-content:space-around;gap:8px;
 margin:17px auto;padding:12px;width:92%;
 border-radius:14px;background:#202833;
 color:#91e6b4;font-size:12px;flex-wrap:wrap;
}
main{padding:12px 18px;max-width:600px;margin:auto}
.section-title{
 color:#8794a7;font-size:11px;letter-spacing:2px;
 margin:22px 3px 12px;
}
.touchpad{
 height:280px;background:#1b222d;
 border:1px solid #394456;border-radius:22px;
 display:flex;flex-direction:column;
 align-items:center;justify-content:center;
 user-select:none;touch-action:none;
}
.pad-label{font-size:16px;letter-spacing:3px;color:#dce6f5}
.pad-hint{font-size:12px;color:#8492a6;margin-top:12px}
.button-row{display:flex;gap:10px;margin-top:12px}
button{
 flex:1;background:#252e3c;border:1px solid #414e61;
 color:white;border-radius:14px;padding:18px 8px;
 font-size:13px;font-weight:bold;touch-action:none;
}
button:active,button.active{background:#425875}
.sensitivity{display:flex;align-items:center;gap:15px}
input{flex:1;accent-color:#78a9ff}
#sensitivityValue{min-width:35px;color:#a9c8ff}
footer{text-align:center;color:#657184;font-size:11px;padding:25px}
</EOF>

# JAVASCRIPT
cat > phone-app/js/app.js <<'EOF'
const phoneStatus=document.getElementById('phoneStatus');
const bleStatus=document.getElementById('bleStatus');
const pad=document.getElementById('pad');

let ws=null;
let last=null;
let sensitivity=1.5;

function connect(){
  ws=new WebSocket('ws://192.168.4.1:81/');

  ws.onopen=()=>{
    phoneStatus.textContent='PHONE CONNECTED';
  };

  ws.onclose=()=>{
    phoneStatus.textContent='PHONE DISCONNECTED';
    setTimeout(connect,1500);
  };

  ws.onerror=()=>ws.close();
}

function send(message){
  if(ws && ws.readyState===WebSocket.OPEN){
    ws.send(message);
  }
}

async function updateStatus(){
  try{
    const response=await fetch('/status');
    const data=await response.json();
    bleStatus.textContent=data.ble
      ? 'BLE: CONNECTED'
      : 'BLE: WAITING';
  }catch{
    bleStatus.textContent='BLE: UNKNOWN';
  }
}

connect();
updateStatus();
setInterval(updateStatus,1500);

pad.addEventListener('pointerdown',event=>{
  last={x:event.clientX,y:event.clientY};
  pad.setPointerCapture(event.pointerId);
});

pad.addEventListener('pointermove',event=>{
  if(!last)return;

  const dx=Math.round((event.clientX-last.x)*sensitivity);
  const dy=Math.round((event.clientY-last.y)*sensitivity);

  last={x:event.clientX,y:event.clientY};

  if(dx||dy)send(`M ${dx} ${dy}`);
});

function stopMoving(){last=null}
pad.addEventListener('pointerup',stopMoving);
pad.addEventListener('pointercancel',stopMoving);

function setupButton(id,code){
  const element=document.getElementById(id);

  element.addEventListener('pointerdown',event=>{
    event.preventDefault();
    element.classList.add('active');
    send(`B ${code} 1`);
  });

  function release(){
    element.classList.remove('active');
    send(`B ${code} 0`);
  }

  element.addEventListener('pointerup',release);
  element.addEventListener('pointercancel',release);
  element.addEventListener('lostpointercapture',release);
}

setupButton('left','L');
setupButton('right','R');
setupButton('middle','M');

document.getElementById('scrollUp').onclick=()=>send('S 3');
document.getElementById('scrollDown').onclick=()=>send('S -3');

document.getElementById('sensitivity').addEventListener('input',event=>{
  sensitivity=Number(event.target.value);
  document.getElementById('sensitivityValue').textContent=
    sensitivity.toFixed(1)+'×';
});

)ESP3D";

const char APP_JS[] PROGMEM = R"ESP3D(
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

)ESP3D";

