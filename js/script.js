 'use strict';

    /* ============================================================
     * ORIENTATION LOCK
     * ============================================================ */
    async function tryLockLandscape() {
      if (window.innerWidth >= 1024 && window.innerHeight >= 1024) return;
      try {
        if (document.documentElement.requestFullscreen)
          await document.documentElement.requestFullscreen();
        if (screen.orientation && screen.orientation.lock)
          await screen.orientation.lock('landscape');
      } catch(e) {}
    }
    tryLockLandscape();
    document.addEventListener('click', tryLockLandscape, { once: true });

    /* ============================================================
     * STATE
     * ============================================================ */
    const S = {
      mode: 1,
      move:  { sign: '+', value: 0 },
      steer: { sign: '+', value: 0 },
      wheelAngle: 0,
      brake: 0, beam: 0, autoLight: 0, wander: 0, avoid: 0,
      speed: 0,        // integer m/s from ESP32 (signed)
      gyroEnabled: false, gyroSens: 50, gyroDir: null
    };

    /* ============================================================
     * DOM
     * ============================================================ */
    const $  = s => document.querySelector(s);
    const $$ = s => document.querySelectorAll(s);

    const D = {
      spd: ['spd1','spd2','spd3'].map(id => document.getElementById(id)),
      rings:    ['ring1','ring2','ring3'].map(id => document.getElementById(id)),
      connLbl:  $('#connLabel'),
      connSpeed:$('#connSpeed'),
      wifiBars: $('#wifiBars'),
      txDisp:   $('#txDisplay'),
      tabs:     $$('.mode-tab'),
      panels:   $$('.mode-panel'),
      dpadBtns: $$('.dpad-btn[data-dir]'),
      dpadBrk:  $('#dpadBrake'),
      sw:       $('#swImg'),
      swTxt:    $('#wheelAngleTxt'),
      sFwd:     $('#steerFwd'), sBwd: $('#steerBwd'), sBrk: $('#steerBrake'),
      gBeta:    $('#gyroBeta'), gGamma: $('#gyroGamma'),
      gEnBtn:   $('#btnEnableGyro'),
      gBrk:     $('#gyroBrake'), gFwd: $('#gyroFwd'), gBwd: $('#gyroBwd'),
      gSlider:  $('#gyroSlider'), gSensVal: $('#gyroSensVal'),
      btnBeam:  $('#btnBeam'), btnAuto: $('#btnAutoLight'),
      btnWand:  $('#btnWander'), btnAvoid: $('#btnAvoid'),
    };

    /* ============================================================
     * WEBSOCKET
     * ============================================================ */
    let ws = null;
    let wsReconnectTimer = null;
    let wsByteCount = 0;

    setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { wsByteCount = 0; return; }
      const bps = wsByteCount; wsByteCount = 0;
      if (D.connSpeed) D.connSpeed.textContent = bps < 1024 ? bps + ' B/s' : (bps/1024).toFixed(1)+' KB/s';
    }, 1000);

    function setSignalBars(level) {
      if (!D.wifiBars) return;
      D.wifiBars.className = 'wifi-bars' + (level > 0 ? ' sig-' + level : '');
    }

    function setConnected(isConn, rssi) {
      if (D.connLbl) {
        D.connLbl.textContent = isConn ? 'Connected' : 'Offline';
        D.connLbl.classList.toggle('connected', isConn);
      }
      if (!isConn) { setSignalBars(0); if (D.connSpeed) D.connSpeed.textContent = '--'; return; }
      if (rssi == null)       setSignalBars(4);
      else if (rssi >= -55)   setSignalBars(4);
      else if (rssi >= -65)   setSignalBars(3);
      else if (rssi >= -75)   setSignalBars(2);
      else                    setSignalBars(1);
    }

    function connectWebSocket() {
      clearTimeout(wsReconnectTimer);
      ws = new WebSocket('ws://192.168.4.1/ws');

      ws.onopen  = () => { setConnected(true, null); console.log('[RC PILOT] WS connected'); };
      ws.onclose = () => { setConnected(false, null); wsReconnectTimer = setTimeout(connectWebSocket, 3000); };
      ws.onerror = () => { ws.close(); };

      ws.onmessage = (event) => {
        const rx = typeof event.data === 'string' ? event.data : '';
        wsByteCount += rx.length;

        /* ── RX PROTOCOL ───────────────────────────────────────
         * 5-char string from ESP32 (sent every 50ms via ws.textAll)
         *
         *  Char  Index  Meaning
         *  ────  ─────  ───────────────────────────────────────
         *  [0]     0    Sign: '+' = forward/positive
         *                     '-' = reverse/negative
         *  [1]     1    Speed magnitude: ASCII digit '0'–'9' (integer m/s)
         *  [2]     2    Reserved '0'
         *  [3]     3    Reserved '0'
         *  [4]     4    Reserved '0'
         *
         *  ESP32 sends: snprintf(buf,6,"%c%d000", velocityX>=0?'+':'-',
         *                        (int)constrain(fabsf(velocityX),0,9));
         *
         *  Examples:
         *    "+0000"  stopped
         *    "+3000"  moving forward at 3 m/s
         *    "-2000"  reversing at 2 m/s
         *
         *  Decode:
         *    sign  = (rx[0] === '-') ? -1 : 1
         *    mag   = parseInt(rx[1], 10)      // 0–9
         *    speed = sign * mag               // signed integer m/s
         * ─────────────────────────────────────────────────── */
        if (rx.length >= 2) {
          const sign = rx[0] === '-' ? -1 : 1;
          const mag  = parseInt(rx[1], 10);
          if (!isNaN(mag)) {
            S.speed = sign * mag;
            updateSpeeds();
          }
        }

        /* Optional: RSSI appended by ESP32 after the 5 reserved chars */
        if (rx.length >= 9) {
          const rssi = parseInt(rx.substring(5, 9), 10);
          if (!isNaN(rssi) && rssi < 0) setConnected(true, rssi);
          else setConnected(true, null);
        }
      };
    }

    /* ============================================================
     * PROTOCOL ENCODER  encodeSigned4(n) → 4-char string
     * ============================================================ */
    function encodeSigned4(value) {
      const clamped = Math.max(-255, Math.min(255, Math.round(value)));
      return (clamped < 0 ? '-' : '+') + String(Math.abs(clamped)).padStart(3, '0');
    }

    /* ============================================================
     * TX PACKET BUILDER — strict 13-char string
     * ============================================================ */
    function buildTx() {
      const moveSigned  = S.move.sign  === '-' ? -S.move.value  : S.move.value;
      const steerSigned = S.steer.sign === '-' ? -S.steer.value : S.steer.value;
      return encodeSigned4(moveSigned) + encodeSigned4(steerSigned) +
             S.brake + S.beam + S.autoLight + S.wander + S.avoid;
    }

    let lastTx = '';
    function send() {
      const cmd = buildTx();
      if (cmd.length !== 13) { console.error('[RC PILOT] Bad packet:', cmd); return; }
      D.txDisp.textContent = cmd;
      if (cmd === lastTx) return;
      lastTx = cmd;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(cmd);
      else console.log('[RC PILOT] TX ->', cmd);
    }

    /* Update all three speedometers from S.speed (signed integer m/s) */
    function updateSpeeds() {
      const abs   = Math.abs(S.speed);
      const isRev = S.speed < 0;
      const isMov = S.speed !== 0;
      const sign  = isRev ? '-' : '+';

      /* Number in ring */
      D.spd.forEach(el => { if (el) el.textContent = abs; });

      /* Ring colour: cyan = forward, red = reverse, dim = stopped */
      D.rings.forEach(ring => {
        if (!ring) return;
        ring.classList.toggle('moving',  isMov && !isRev);
        ring.classList.toggle('reverse', isRev);
      });

    }

    /* ============================================================
     * WANDER AUTO-DISABLE on any interaction except wander btn
     * ============================================================ */
    function disableWander() {
      if (!S.wander) return;
      S.wander = 0; updateUI(); send();
    }
    ['pointerdown','keydown','touchstart'].forEach(ev => {
      document.addEventListener(ev, e => {
        if (e.target && e.target.closest && e.target.closest('#btnWander')) return;
        disableWander();
      }, { capture: true, passive: true });
    });

    /* ============================================================
     * MODE SWITCH
     * ============================================================ */
    function switchMode(n) {
      S.mode = n;
      D.tabs.forEach(t => t.classList.toggle('active', +t.dataset.mode === n));
      D.panels.forEach((p,i) => p.classList.toggle('active', i+1 === n));
      hardStopMove(); hardStopSteer(); relBrake();
      if (n !== 3) S.gyroDir = null;
    }
    D.tabs.forEach(t => t.addEventListener('click', () => switchMode(+t.dataset.mode)));

    /* ============================================================
     * BRAKE
     * ============================================================ */
    function engBrake() { S.brake = 1; hardStopMove(); S.move.value = 0; S.move.sign = '+'; send(); }
    function relBrake() { S.brake = 0; send(); }

    /* ============================================================
     * MOVEMENT — ramp up / gradual deceleration
     * ============================================================ */
    let moveRampUp   = null;
    let moveRampDown = null;
    let activeMovDir = null;

    function startMove(dir) {
      if (activeMovDir !== null && activeMovDir !== dir) return;
      cancelAnimationFrame(moveRampDown); moveRampDown = null;
      if (moveRampUp !== null && activeMovDir === dir) return;
      clearInterval(moveRampUp); moveRampUp = null;
      activeMovDir = dir;
      S.move.sign = dir === 'forward' ? '+' : '-';
      if (S.mode === 3) S.gyroDir = dir;
      moveRampUp = setInterval(() => {
        if (S.move.value < 255) { S.move.value = Math.min(255, S.move.value + 10); send(); }
        else { clearInterval(moveRampUp); moveRampUp = null; }
      }, 25);
      S.move.value = Math.min(255, S.move.value + 10); send();
    }

    function stopMove(dir) {
      if (dir && activeMovDir !== dir) return;
      clearInterval(moveRampUp); moveRampUp = null;
      activeMovDir = null;
      if (S.mode === 3) S.gyroDir = null;
      const DECAY = 0.88;
      cancelAnimationFrame(moveRampDown);
      (function rampDown() {
        if (S.move.value <= 1) { S.move.value = 0; S.move.sign = '+'; send(); return; }
        S.move.value = Math.floor(S.move.value * DECAY); send();
        moveRampDown = requestAnimationFrame(rampDown);
      })();
    }

    function hardStopMove() {
      clearInterval(moveRampUp); moveRampUp = null;
      cancelAnimationFrame(moveRampDown); moveRampDown = null;
      activeMovDir = null; S.move.value = 0; S.move.sign = '+';
      if (S.mode === 3) S.gyroDir = null; send();
    }

    /* ============================================================
     * STEERING — ramp out / return to centre
     * ============================================================ */
    let steerIv = null, retCenterRAF = null, activeSteerDir = null;

    function startSteer(dir) {
      if (activeSteerDir !== null && activeSteerDir !== dir) return;
      if (activeSteerDir === dir) return;
      cancelAnimationFrame(retCenterRAF); retCenterRAF = null;
      clearInterval(steerIv); steerIv = null;
      activeSteerDir = dir;
      steerIv = setInterval(() => {
        const step = dir === 'right' ? 5 : -5;
        S.wheelAngle = Math.max(-360, Math.min(360, S.wheelAngle + step));
        syncSteer(); send(); updateWheelUI();
      }, 25);
    }

    function stopSteer(dir) {
      if (dir && activeSteerDir !== dir) return;
      clearInterval(steerIv); steerIv = null; activeSteerDir = null; retCenter();
    }

    function hardStopSteer() {
      clearInterval(steerIv); steerIv = null;
      cancelAnimationFrame(retCenterRAF); retCenterRAF = null;
      activeSteerDir = null; S.wheelAngle = 0; syncSteer(); send(); updateWheelUI();
    }

    function syncSteer() {
      S.steer.sign  = S.wheelAngle >= 0 ? '+' : '-';
      S.steer.value = Math.round((Math.abs(S.wheelAngle) / 360) * 255);
    }

    function retCenter() {
      cancelAnimationFrame(retCenterRAF); retCenterRAF = null;
      if (activeSteerDir !== null) return;
      (function step() {
        if (Math.abs(S.wheelAngle) < 0.5) { S.wheelAngle = 0; syncSteer(); send(); updateWheelUI(); return; }
        S.wheelAngle *= 0.88; syncSteer(); send(); updateWheelUI();
        retCenterRAF = requestAnimationFrame(step);
      })();
    }

    function updateWheelUI() {
      if (D.sw)    D.sw.style.transform = `rotate(${S.wheelAngle}deg)`;
      if (D.swTxt) D.swTxt.textContent  = `${Math.round(S.wheelAngle)}\u00B0`;
    }

    /* ============================================================
     * BUTTON GLOW HELPERS
     * ============================================================ */
    const dirBtnMap = {
      forward:  ['.dpad-btn[data-dir="forward"]', '#steerFwd', '#gyroFwd'],
      backward: ['.dpad-btn[data-dir="backward"]', '#steerBwd', '#gyroBwd'],
      left:     ['.dpad-btn[data-dir="left"]'],
      right:    ['.dpad-btn[data-dir="right"]'],
    };
    function setDirGlow(dir, on) {
      (dirBtnMap[dir] || []).forEach(sel => { const el=$(sel); if(el) el.classList.toggle('pressed', on); });
    }

    /* ============================================================
     * D-PAD EVENTS
     * ============================================================ */
    D.dpadBtns.forEach(btn => {
      const dir = btn.dataset.dir;
      const isMove = dir === 'forward' || dir === 'backward';
      btn.addEventListener('pointerdown', e => { e.preventDefault(); setDirGlow(dir,true);  isMove?startMove(dir):startSteer(dir); });
      const up = e => { e.preventDefault(); setDirGlow(dir,false); isMove?stopMove(dir):stopSteer(dir); };
      btn.addEventListener('pointerup',up); btn.addEventListener('pointerleave',up); btn.addEventListener('pointercancel',up);
    });

    (() => {
      const b = D.dpadBrk;
      b.addEventListener('pointerdown', e => { e.preventDefault(); b.classList.add('pressed'); engBrake(); });
      const up = e => { e.preventDefault(); b.classList.remove('pressed'); relBrake(); };
      b.addEventListener('pointerup',up); b.addEventListener('pointerleave',up); b.addEventListener('pointercancel',up);
    })();

    /* ============================================================
     * KEYBOARD
     * ============================================================ */
    const held = new Set();
    document.addEventListener('keydown', e => {
      if (held.has(e.key)) return; held.add(e.key);
      switch(e.key) {
        case 'ArrowUp':    case 'w': case 'W': e.preventDefault(); setDirGlow('forward',true);  startMove('forward');   break;
        case 'ArrowDown':  case 's': case 'S': e.preventDefault(); setDirGlow('backward',true); startMove('backward');  break;
        case 'ArrowLeft':  case 'a': case 'A': e.preventDefault(); setDirGlow('left',true);     startSteer('left');     break;
        case 'ArrowRight': case 'd': case 'D': e.preventDefault(); setDirGlow('right',true);    startSteer('right');    break;
        case ' ': e.preventDefault(); D.dpadBrk.classList.add('pressed'); engBrake(); break;
        case 'b': case 'B': tBeam();  break;
        case 'l': case 'L': tAuto();  break;
        case 'm': case 'M': tWand();  break;
        case 'v': case 'V': tAvoid(); break;
      }
    });
    document.addEventListener('keyup', e => {
      held.delete(e.key);
      switch(e.key) {
        case 'ArrowUp':    case 'w': case 'W': setDirGlow('forward',false);  stopMove('forward');   break;
        case 'ArrowDown':  case 's': case 'S': setDirGlow('backward',false); stopMove('backward');  break;
        case 'ArrowLeft':  case 'a': case 'A': setDirGlow('left',false);     stopSteer('left');     break;
        case 'ArrowRight': case 'd': case 'D': setDirGlow('right',false);    stopSteer('right');    break;
        case ' ': D.dpadBrk.classList.remove('pressed'); relBrake(); break;
      }
    });

    /* ============================================================
     * STEERING WHEEL DRAG
     * ============================================================ */
    let dragging = false, lastDragAng = 0;
    D.sw.addEventListener('pointerdown', e => {
      e.preventDefault();
      clearInterval(steerIv); steerIv = null; activeSteerDir = null;
      cancelAnimationFrame(retCenterRAF); retCenterRAF = null;
      dragging = true; D.sw.classList.add('dragging'); D.sw.setPointerCapture(e.pointerId);
      const r = D.sw.getBoundingClientRect();
      lastDragAng = Math.atan2(e.clientY-(r.top+r.height/2), e.clientX-(r.left+r.width/2))*(180/Math.PI);
    });
    document.addEventListener('pointermove', e => {
      if (!dragging) return;
      const r = D.sw.getBoundingClientRect();
      const cur = Math.atan2(e.clientY-(r.top+r.height/2), e.clientX-(r.left+r.width/2))*(180/Math.PI);
      let d = cur - lastDragAng;
      if (d > 180) d -= 360; if (d < -180) d += 360;
      S.wheelAngle = Math.max(-360, Math.min(360, S.wheelAngle+d));
      lastDragAng = cur; syncSteer(); send(); updateWheelUI();
    });
    document.addEventListener('pointerup', () => { if (!dragging) return; dragging=false; D.sw.classList.remove('dragging'); retCenter(); });

    /* ============================================================
     * STEERING MODE BUTTONS
     * ============================================================ */
    function holdBtn(el, dn, up) {
      el.addEventListener('pointerdown', e => { e.preventDefault(); el.classList.add('pressed'); dn(); });
      const u = e => { e.preventDefault(); el.classList.remove('pressed'); up(); };
      el.addEventListener('pointerup',u); el.addEventListener('pointerleave',u); el.addEventListener('pointercancel',u);
    }
    holdBtn(D.sFwd, () => startMove('forward'),  () => stopMove('forward'));
    holdBtn(D.sBwd, () => startMove('backward'), () => stopMove('backward'));
    holdBtn(D.sBrk, engBrake, relBrake);

    /* ============================================================
     * GYRO MODE
     * ============================================================ */
    function handleOrientation(evt) {
      if (S.mode !== 3 || !S.gyroEnabled) return;
      const beta = evt.beta || 0, gamma = evt.gamma || 0;
      D.gBeta.textContent  = Math.round(beta);
      D.gGamma.textContent = Math.round(gamma);
      const maxTilt = Math.max(5, 55-(S.gyroSens-10)*0.5);
      const clamped = Math.max(-maxTilt, Math.min(maxTilt, beta));
      const mag     = Math.round((Math.abs(clamped)/maxTilt)*255);
      clearInterval(moveRampUp); moveRampUp = null;
      cancelAnimationFrame(moveRampDown); moveRampDown = null;
      if (mag < 8) { S.move.value = 0; S.move.sign = '+'; }
      else {
        S.move.sign  = S.gyroDir ? (S.gyroDir==='forward'?'+':'-') : (clamped>=0?'+':'-');
        S.move.value = mag;
      }
      send();
    }
    D.gEnBtn.addEventListener('click', async () => {
      if (S.gyroEnabled) {
        S.gyroEnabled = false;
        window.removeEventListener('deviceorientation', handleOrientation);
        D.gEnBtn.textContent = 'Enable Gyro'; D.gEnBtn.classList.remove('enabled');
        hardStopMove(); D.gBeta.textContent = '0'; D.gGamma.textContent = '0'; return;
      }
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try { const p = await DeviceOrientationEvent.requestPermission(); if (p !== 'granted') { alert('Gyro permission denied.'); return; } }
        catch(e) { alert('Could not request gyro permission.'); return; }
      }
      if (typeof DeviceOrientationEvent === 'undefined') { alert('Gyroscope not supported.'); return; }
      S.gyroEnabled = true;
      window.addEventListener('deviceorientation', handleOrientation);
      D.gEnBtn.textContent = 'Gyro Active'; D.gEnBtn.classList.add('enabled');
    });
    holdBtn(D.gFwd,
      () => { S.gyroDir='forward';  if(!S.gyroEnabled) startMove('forward');  },
      () => { S.gyroDir=null;       if(!S.gyroEnabled) stopMove('forward');   }
    );
    holdBtn(D.gBwd,
      () => { S.gyroDir='backward'; if(!S.gyroEnabled) startMove('backward'); },
      () => { S.gyroDir=null;       if(!S.gyroEnabled) stopMove('backward');  }
    );
    holdBtn(D.gBrk, engBrake, relBrake);
    D.gSlider.addEventListener('input', e => { S.gyroSens=+e.target.value; D.gSensVal.textContent=S.gyroSens+'%'; });

    /* ============================================================
     * TOGGLE BUTTONS
     * ============================================================ */
    function updateUI() {
      D.btnBeam.classList.toggle('beam-on',   !!S.beam);
      D.btnAuto.classList.toggle('auto-on',   !!S.autoLight);
      D.btnWand.classList.toggle('wander-on', !!S.wander);
      D.btnAvoid.classList.toggle('avoid-on', !!S.avoid);
    }
    function tBeam()  { S.beam      = S.beam      ?0:1; if(S.beam)      S.autoLight=0; updateUI(); send(); }
    function tAuto()  { S.autoLight = S.autoLight ?0:1; if(S.autoLight) S.beam=0;      updateUI(); send(); }
    function tWand()  { S.wander    = S.wander    ?0:1; updateUI(); send(); }
    function tAvoid() { S.avoid     = S.avoid     ?0:1; updateUI(); send(); }
    D.btnBeam.addEventListener('click', tBeam);
    D.btnAuto.addEventListener('click', tAuto);
    D.btnWand.addEventListener('click', tWand);
    D.btnAvoid.addEventListener('click', tAvoid);

    /* ============================================================
     * PREVENT NATIVE GESTURES
     * ============================================================ */
    document.addEventListener('touchmove',     e => e.preventDefault(), { passive: false });
    document.addEventListener('gesturestart',  e => e.preventDefault());
    document.addEventListener('gesturechange', e => e.preventDefault());

    /* ============================================================
     * FULLSCREEN
     * ============================================================ */
    let fullscreenDone = false;
    document.addEventListener('pointerdown', () => {
      if (fullscreenDone) return; fullscreenDone = true;
      const el = document.documentElement;
      if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    }, { once: true });

    /* ============================================================
     * INIT
     * ============================================================ */
    send(); updateSpeeds(); updateUI(); setConnected(false, null);
    connectWebSocket();

    console.log('[RC PILOT] Ready');
    console.log('[RC PILOT] TX 13-char: [0-3]=±move [4-7]=±steer [8]=brk [9]=beam [10]=auto [11]=wand [12]=avoid');
    console.log('[RC PILOT] RX 5-char:  [0]=sign  [1]=m/s(0-9)  [2-4]=reserved');
