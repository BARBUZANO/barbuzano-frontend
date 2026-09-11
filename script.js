const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');

let width, height, dpr;
let bgGradient = null;

const ACCENT = '#4F7358';       // verde base (oscuro) de la línea en reposo
const ACCENT_LIGHT = '#9ED6AC'; // verde claro del barrido
const ACCENT_SOFT = 'rgba(79, 115, 88, 0.55)';

function resize() {
  dpr = window.devicePixelRatio || 1;
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, ACCENT_SOFT);
  bgGradient.addColorStop(0.45, 'rgba(79, 115, 88, 0.30)');
  bgGradient.addColorStop(0.8, 'rgba(79, 115, 88, 0.10)');
  bgGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  if (series) fullCurve = buildFullCurve(series, width, height);
  if (candleSeries) candles = buildCandles(candleSeries, width, height);
}

window.addEventListener('resize', resize);

// ---- Serie de datos tipo cotización (fija, no se regenera) ----
const POINTS = 42;
const SEGMENTS_PER_POINT = 14;

function nextValue(prev) {
  const drift = 0.006;
  const noise = (Math.random() - 0.45) * 0.09;
  return Math.min(0.92, Math.max(0.15, prev + drift + noise));
}

function buildSeries(length, seed = 0.42) {
  const arr = [];
  let value = seed;
  for (let i = 0; i < length; i++) {
    value = nextValue(value);
    arr.push(value);
  }
  return arr;
}

const series = buildSeries(POINTS);

// ---- Velas decorativas (puramente estéticas, no leen la serie principal) ----
const CANDLE_COUNT = 22;
const candleSeries = buildSeries(CANDLE_COUNT + 1, 0.5);
let candles = null;

function buildCandles(seriesArr, w, h) {
  const slot = w / CANDLE_COUNT;
  const bodyWidth = slot * 0.5;
  const list = [];

  for (let i = 0; i < CANDLE_COUNT; i++) {
    const open = seriesArr[i];
    const close = seriesArr[i + 1];
    const wick = 0.02 + Math.random() * 0.04;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    const cx = slot * i + slot / 2;

    list.push({
      x: cx,
      bodyWidth,
      up: close >= open,
      yOpen: h - open * h,
      yClose: h - close * h,
      yHigh: h - high * h,
      yLow: h - low * h
    });
  }
  return list;
}

function drawCandles(list) {
  ctx.save();
  for (const c of list) {
    const color = c.up ? ACCENT : '#8A8A85';
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c.x, c.yHigh);
    ctx.lineTo(c.x, c.yLow);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.16;
    const top = Math.min(c.yOpen, c.yClose);
    const bodyHeight = Math.max(2, Math.abs(c.yClose - c.yOpen));
    ctx.fillRect(c.x - c.bodyWidth / 2, top, c.bodyWidth, bodyHeight);
  }
  ctx.restore();
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function pointAt(arr, i) {
  return arr[Math.min(arr.length - 1, Math.max(0, i))];
}

// Precalcula toda la curva suavizada de una vez (fluidez: nada de recálculo por fotograma).
const EDGE_PAD = 6; // margen para que el punto final no quede recortado por el borde del canvas

function buildFullCurve(seriesArr, w, h) {
  const pts = [];
  const n = seriesArr.length;
  const usableWidth = w - EDGE_PAD * 2;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pointAt(seriesArr, i - 1);
    const p1 = pointAt(seriesArr, i);
    const p2 = pointAt(seriesArr, i + 1);
    const p3 = pointAt(seriesArr, i + 2);
    for (let s = 0; s < SEGMENTS_PER_POINT; s++) {
      const t = s / SEGMENTS_PER_POINT;
      const y = catmullRom(p0, p1, p2, p3, t);
      const globalT = (i + t) / (n - 1);
      pts.push({ x: EDGE_PAD + globalT * usableWidth, y: h - y * h });
    }
  }
  const last = pointAt(seriesArr, n - 1);
  pts.push({ x: w - EDGE_PAD, y: h - last * h });
  return pts;
}

let fullCurve = null;

// ---- Utilidad: interpolar entre dos colores hex ----
function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return [
    parseInt(v.substring(0, 2), 16),
    parseInt(v.substring(2, 4), 16),
    parseInt(v.substring(4, 6), 16)
  ];
}
const RGB_ACCENT = hexToRgb(ACCENT);
const RGB_LIGHT = hexToRgb(ACCENT_LIGHT);

function lerpColor(rgbA, rgbB, t) {
  const r = Math.round(rgbA[0] + (rgbB[0] - rgbA[0]) * t);
  const g = Math.round(rgbA[1] + (rgbB[1] - rgbA[1]) * t);
  const b = Math.round(rgbA[2] + (rgbB[2] - rgbA[2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function drawFill(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(pts[pts.length - 1].x, height);
  ctx.lineTo(pts[0].x, height);
  ctx.closePath();
  ctx.fillStyle = bgGradient;
  ctx.fill();

  // Halo suave justo por encima de la línea: evita que la luz "corte" en seco
  // contra el negro cuando la curva está en su punto más alto.
  ctx.save();
  ctx.shadowColor = 'rgba(79, 115, 88, 0.85)';
  ctx.shadowBlur = 22;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = 'rgba(79, 115, 88, 0.5)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

// Malla muy sutil de fondo, para leer el gráfico como un chart real y no una simple línea.
const GRID_ROWS = 4;
const GRID_COLS = 8;

function drawGrid() {
  ctx.save();
  ctx.strokeStyle = 'rgba(245, 245, 240, 0.06)';
  ctx.lineWidth = 1;

  for (let r = 1; r < GRID_ROWS; r++) {
    const y = Math.round((height / GRID_ROWS) * r) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  for (let c = 1; c < GRID_COLS; c++) {
    const x = Math.round((width / GRID_COLS) * c) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  ctx.restore();
}

function strokeCurve(pts, color, count = pts.length) {
  if (count < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < count; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawTip(pt, color) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

// ---- Fases de animación ----
// Fase 1 (0 - 1700ms): calibración — núcleo, anillos en cascada, arco rotando.
// Fase 2 (1700 - 3500ms): trazado progresivo de la curva.
// Fase 3 (en adelante): curva estática con respiración + barrido de color en bucle.

const PULSE_END = 1700;
const DRAW_END = PULSE_END + 1800;

// Barrido: fase rápida de izquierda a derecha en verde claro,
// luego degradado lento de vuelta al verde oscuro, y vuelta a empezar.
const SWEEP_MS = 700;
const FADE_MS = 3200;
const CYCLE_MS = SWEEP_MS + FADE_MS;

let startTime = null;

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }

function drawPulse(t) {
  const cx = width / 2;
  const cy = height / 2;
  const eased = easeOutCubic(t);
  const coreRadius = 4 + eased * 5;

  const ringCount = 3;
  for (let i = 0; i < ringCount; i++) {
    const offset = i / ringCount;
    let ringT = (t * 1.6 - offset) % 1;
    if (ringT < 0) ringT += 1;
    if (t < offset * 0.4) continue;

    const radius = 8 + easeOutCubic(ringT) * 46;
    const alpha = (1 - ringT) * 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = ACCENT;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const arcRadius = 22 + eased * 6;
  const rotation = t * Math.PI * 5;
  ctx.beginPath();
  ctx.arc(cx, cy, arcRadius, rotation, rotation + Math.PI * 0.6);
  ctx.strokeStyle = ACCENT;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;

  const breathe = Math.sin(t * Math.PI * 8) * 0.6;
  ctx.beginPath();
  ctx.arc(cx, cy, coreRadius + breathe, 0, Math.PI * 2);
  ctx.fillStyle = ACCENT;
  ctx.fill();
}

function frame(now) {
  if (startTime === null) startTime = now;
  const elapsed = now - startTime;
  ctx.clearRect(0, 0, width, height);

  if (elapsed < PULSE_END) {
    drawPulse(elapsed / PULSE_END);

  } else if (elapsed < DRAW_END) {
    const t = easeInOutSine((elapsed - PULSE_END) / (DRAW_END - PULSE_END));
    const revealCount = Math.max(2, Math.round(t * fullCurve.length));
    const pts = fullCurve.slice(0, revealCount);
    drawGrid();
    drawFill(pts);
    strokeCurve(pts, ACCENT);
    drawTip(pts[pts.length - 1], ACCENT);
    drawCandles(candles);

  } else {
    // --- Reposo: respiración suave + barrido de color en bucle ---
    const restElapsed = elapsed - DRAW_END;
    const loopT = restElapsed / 1000;
    const pts = fullCurve.map((p, i) => ({
      x: p.x,
      y: p.y + Math.sin(loopT * 1.3 + i * 0.15) * (height * 0.004)
    }));

    drawGrid();
    drawFill(pts);

    const cycleT = restElapsed % CYCLE_MS;

    if (cycleT < SWEEP_MS) {
      // Base en verde oscuro, y por encima el barrido claro avanzando de izquierda a derecha.
      strokeCurve(pts, ACCENT);
      const sweepT = easeOutCubic(cycleT / SWEEP_MS);
      const sweepCount = Math.max(2, Math.round(sweepT * pts.length));
      strokeCurve(pts, ACCENT_LIGHT, sweepCount);
      drawTip(pts[pts.length - 1], sweepCount >= pts.length ? ACCENT_LIGHT : ACCENT);
    } else {
      // Toda la curva ya está en verde claro; se degrada lentamente al verde oscuro.
      const fadeT = (cycleT - SWEEP_MS) / FADE_MS;
      const color = lerpColor(RGB_LIGHT, RGB_ACCENT, fadeT);
      strokeCurve(pts, color);
      drawTip(pts[pts.length - 1], color);
    }

    drawCandles(candles);
  }

  requestAnimationFrame(frame);
}

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

resize();

if (prefersReducedMotion) {
  drawGrid();
  drawFill(fullCurve);
  strokeCurve(fullCurve, ACCENT);
  drawTip(fullCurve[fullCurve.length - 1], ACCENT);
  drawCandles(candles);
} else {
  requestAnimationFrame(frame);
}

// ============================================
// LÓGICA DE AUTENTICACIÓN (CLOUDFLARE WORKER)
// ============================================

const WORKER_URL =
    'https://barbuzano-auth-worker.barbuzano.workers.dev';

document.addEventListener('DOMContentLoaded', () => {
    const loginBtn = document.getElementById('login-btn');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');

    // Comprobar que existen los elementos del formulario
    if (!loginBtn || !usernameInput || !passwordInput) {
        console.warn(
            'No se encontraron los elementos del formulario de login en el DOM.'
        );
        return;
    }

    loginBtn.addEventListener('click', async (e) => {
        e.preventDefault();

        // Evitar enviar el formulario y recargar la página
        const username = usernameInput.value.trim();
        const password = passwordInput.value;

        // Comprobar que se han rellenado los campos
        if (!username || !password) {
            alert('Por favor, rellena todos los campos.');
            return;
        }

        // Feedback visual en el botón
        const originalText = loginBtn.textContent;

        loginBtn.textContent = 'Accediendo...';
        loginBtn.disabled = true;

        try {
            // Realizar petición al Cloudflare Worker
            const response = await fetch(
                `${WORKER_URL}/api/login`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        username,
                        password,
                    }),
                }
            );

            const data = await response.json();

            // Comprobar respuesta del servidor
            if (!response.ok) {
                alert(
                    `Error: ${
                        data.error || 'Credenciales incorrectas'
                    }`
                );
            } else {
                alert(
                    `¡Bienvenido de nuevo, ${data.user.username}!`
                );

                // Aquí puedes redirigir al panel
                // o guardar el estado de sesión.

                // Ejemplo:
                // window.location.href = '/dashboard.html';
            }

        } catch (error) {
            console.error(
                'Error en la petición de login:',
                error
            );

            alert(
                'No se pudo conectar con el servidor de autenticación.'
            );

        } finally {
            // Restaurar el botón a su estado original
            loginBtn.textContent = originalText;
            loginBtn.disabled = false;
        }
    });
});
