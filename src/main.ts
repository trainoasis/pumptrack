// pumptrack — a tiny-wings-style prototype. Canvas 2D, no deps.
import { initAudio, updateAudio, playYay } from './audio';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud')!;

let W = 0, H = 0;
const resize = (): void => { W = canvas.width = innerWidth; H = canvas.height = innerHeight; };
resize();
addEventListener('resize', resize);

// --- Levels ------------------------------------------------------------------
// A level's terrain is a sum of sines. Each component: [amplitude, freq, phase].
// Launch threshold at a crest: s² > gAir / (A·f²).
type Sine = readonly [amplitude: number, frequency: number, phase: number];
interface Level { readonly name: string; readonly terrain: readonly Sine[]; }

const LEVELS: readonly Level[] = [
  { name: 'Pump basics',  terrain: [[95, 0.0060, 1.70]] },
  // Two incommensurate frequencies — crests vary in height and steepness
  // because the sines drift in and out of phase along x.
  { name: 'Varied waves', terrain: [[95, 0.0060, 1.70], [28, 0.0105, 1.90]] },
];
let currentLevel = 0;
const BASELINE = 260;

const terrainY = (x: number): number => {
  let y = BASELINE;
  for (const [A, f, p] of LEVELS[currentLevel].terrain) y += A * Math.sin(f * x + p);
  return y;
};
const terrainSlope = (x: number): number => {
  let s = 0;
  for (const [A, f, p] of LEVELS[currentLevel].terrain) s += A * f * Math.cos(f * x + p);
  return s;
};
const terrainYpp = (x: number): number => {
  let s = 0;
  for (const [A, f, p] of LEVELS[currentLevel].terrain) s -= A * f * f * Math.sin(f * x + p);
  return s;
};
const terrainCurvature = (x: number): number => {
  const yp = terrainSlope(x), ypp = terrainYpp(x);
  return ypp / Math.pow(1 + yp * yp, 1.5);
};

// --- Ball --------------------------------------------------------------------
interface Ball { x: number; y: number; vx: number; vy: number; r: number; grounded: boolean; }
const ball: Ball = { x: 40, y: 0, vx: 340, vy: 0, r: 12, grounded: false };

let bestSpeed = 0, maxDist = 0, stallT = 0, gameOver = false;
let wheelAngle = 0;
let prevBallX = 40;
// Track continuous airborne time so we only "yay" real jumps, not hop-skips.
let airborneT = 0;
let yayPlayed = false;
const YAY_MIN_AIR = 0.35;  // seconds of continuous air before we count it a "real" jump

const reset = (): void => {
  ball.x = 40; ball.vx = 340; ball.vy = 0;
  ball.y = terrainY(ball.x) + 60;
  ball.grounded = false;
  bestSpeed = 0; maxDist = 0; stallT = 0;
  gameOver = false;
  wheelAngle = 0;
  prevBallX = ball.x;
  airborneT = 0;
  yayPlayed = false;
};
reset();

// --- Input -------------------------------------------------------------------
let diving = false;
const setDive = (v: boolean): void => { diving = v; };
// Clicks/taps on UI controls (e.g. the level picker) must not trigger dive.
const isUiTarget = (t: EventTarget | null): boolean =>
  !!(t && (t as HTMLElement).tagName === 'BUTTON');
// Audio needs a user gesture to start; initAudio() is idempotent + resumes.
const ensureAudio = (): void => { initAudio(); };

addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.code === 'Space') {
    e.preventDefault();
    ensureAudio();
    if (gameOver) { reset(); return; }
    setDive(true);
  }
  if (e.code === 'KeyR') reset();
});
addEventListener('keyup', (e: KeyboardEvent) => {
  if (e.code === 'Space') { e.preventDefault(); setDive(false); }
});
addEventListener('mousedown', (e: MouseEvent) => {
  if (isUiTarget(e.target)) return;
  ensureAudio();
  if (gameOver) { reset(); return; }
  setDive(true);
});
addEventListener('mouseup', () => setDive(false));
addEventListener('touchstart', (e: TouchEvent) => {
  if (isUiTarget(e.target)) return;
  e.preventDefault();
  ensureAudio();
  if (gameOver) { reset(); return; }
  setDive(true);
}, { passive: false });
addEventListener('touchend', (e: TouchEvent) => {
  e.preventDefault();
  setDive(false);
}, { passive: false });

// --- Physics constants -------------------------------------------------------
// Tiny-Wings-style gravity: gentle default so the ball FLOATS when you're
// not pressing, strong dive when you are. Grounded also responds to dive —
// pressing on a downhill pumps extra speed; pressing on an uphill costs you.
const G_AIR_FLOAT   = 420;
const G_AIR_DIVE    = 2400;
const G_GROUND      = 900;
const G_GROUND_DIVE = 1700;
const FRICTION      = 0.004;
const STALL_SPD     = 40;
const STALL_TIME    = 1.2;

// Fixed timestep keeps physics deterministic across framerates.
const FIXED_DT = 1 / 240;
let acc = 0, lastT = performance.now() / 1000;

// Smoothed camera zoom. Zooms out while airborne so you can see where you'll land.
let currentZoom = 1;

// Biker sprite — body (no wheels) and wheel loaded separately so wheels can
// spin independently of the frame + rider.
const bikerBody = new Image();
let bikerBodyReady = false;
bikerBody.addEventListener('load', () => { bikerBodyReady = true; });
bikerBody.src = '/biker.svg';

const bikerWheel = new Image();
let bikerWheelReady = false;
bikerWheel.addEventListener('load', () => { bikerWheelReady = true; });
bikerWheel.src = '/wheel.svg';

// biker.svg viewBox; wheels axles in viewBox coords.
const BIKER_VB_W = 80;
const BIKER_VB_H = 60;
const WHEEL_VB_R = 11;
const REAR_AXLE_VB  = { x: 16, y: 46 };
const FRONT_AXLE_VB = { x: 64, y: 46 };

const BIKER_W = 120;
const BIKER_H = 90;
let currentBikerAngle = 0;

function step(dt: number): void {
  if (gameOver) return;
  const gAir    = diving ? G_AIR_DIVE    : G_AIR_FLOAT;
  const gGround = diving ? G_GROUND_DIVE : G_GROUND;

  if (ball.grounded) {
    const g = gGround;
    const slope = terrainSlope(ball.x);
    const L  = Math.sqrt(1 + slope * slope);
    const tx = 1 / L, ty = slope / L;

    // Speed along tangent (+x forward)
    let s = ball.vx * tx + ball.vy * ty;
    // Gravity projected onto tangent: (0,-g) · (tx,ty) = -g*ty
    s += (-g * ty) * dt;
    s -= FRICTION * s * dt;
    if (s < 0) s = 0;

    ball.x += s * tx * dt;
    ball.y  = terrainY(ball.x);
    const slope2 = terrainSlope(ball.x);
    const L2 = Math.sqrt(1 + slope2 * slope2);
    ball.vx = s / L2;
    ball.vy = s * slope2 / L2;

    // Launch: at a crest (concave-down) the ball leaves the ground when
    // required centripetal s²·|κ| exceeds gravity's normal component g·cosθ = g/L.
    // Test against airborne gravity — matches the floaty airtime feel.
    const k = terrainCurvature(ball.x);
    if (k < 0 && s * s * (-k) > gAir / L2) {
      ball.grounded = false;
    }
  } else {
    ball.vy -= gAir * dt;
    ball.x  += ball.vx * dt;
    ball.y  += ball.vy * dt;

    const gy = terrainY(ball.x);
    if (ball.y <= gy) {
      // Landing: project velocity onto slope tangent (no bounce). Matching
      // the slope preserves speed; mismatched sheds the normal component.
      ball.y = gy;
      ball.grounded = true;

      const slope = terrainSlope(ball.x);
      const L  = Math.sqrt(1 + slope * slope);
      const tx = 1 / L, ty = slope / L;
      let s = ball.vx * tx + ball.vy * ty;
      if (s < 0) s = 0;
      ball.vx = s * tx;
      ball.vy = s * ty;
    }
  }

  const spd = Math.hypot(ball.vx, ball.vy);
  if (spd > bestSpeed) bestSpeed = spd;
  if (ball.x > maxDist) maxDist = ball.x;

  if (spd < STALL_SPD) stallT += dt; else stallT = 0;
  if (stallT > STALL_TIME) gameOver = true;

  // Real-jump detection: only fire yay after YAY_MIN_AIR of continuous airtime,
  // and only once per jump. Tiny hop-skips never cross the threshold.
  if (!ball.grounded) {
    airborneT += dt;
    if (!yayPlayed && airborneT >= YAY_MIN_AIR) {
      playYay();
      yayPlayed = true;
    }
  } else {
    airborneT = 0;
    yayPlayed = false;
  }
}

// --- Rendering ---------------------------------------------------------------
function draw(): void {
  const spd = Math.hypot(ball.vx, ball.vy);

  // Zoom: grounded → 1.0, airborne → eases to 0.6 based on altitude above midline.
  let targetZoom = 1.0;
  if (!ball.grounded) {
    const h = Math.max(0, ball.y - BASELINE);
    const altN = Math.min(1, h / 350);
    targetZoom = 1.0 - altN * 0.40;
  }
  currentZoom += (targetZoom - currentZoom) * 0.05;
  const zoom = currentZoom;

  // Transform: sx = (wx - camX) * zoom + W/2 ; sy = (camY - wy) * zoom + H/2
  const camX = ball.x - (W * 0.30 - W / 2) / zoom;
  // Anchor vertically to the terrain midline so the view doesn't bob.
  const camYGround = BASELINE + (H * 0.78 - H / 2) / zoom;
  const camYBall   = ball.y - (H / 2 - H * 0.25) / zoom;
  const camY = Math.max(camYGround, camYBall);

  const toSX = (wx: number): number => (wx - camX) * zoom + W / 2;
  const toSY = (wy: number): number => (camY - wy) * zoom + H / 2;

  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#122a4d');
  sky.addColorStop(1, '#f4a259');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Terrain
  const worldHalfW = (W / 2) / zoom;
  const xStart = camX - worldHalfW - 10;
  const xEnd   = camX + worldHalfW + 10;
  const STEP = Math.max(2, 4 / zoom);

  ctx.fillStyle = '#2d1b3d';
  ctx.beginPath();
  ctx.moveTo(toSX(xStart), H);
  for (let x = xStart; x <= xEnd; x += STEP) ctx.lineTo(toSX(x), toSY(terrainY(x)));
  ctx.lineTo(toSX(xEnd), H);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#ff6b6b';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = xStart; x <= xEnd; x += STEP) {
    const sx = toSX(x), sy = toSY(terrainY(x));
    if (x === xStart) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.stroke();

  // Biker — orientation follows slope while rolling, velocity while airborne.
  // atan2(-vy, vx) works for both cases: on the ground vy = slope·vx, so the
  // same formula gives -atan(slope).
  const bsx = toSX(ball.x), bsy = toSY(ball.y);
  const v = Math.hypot(ball.vx, ball.vy);
  const targetAngle = v > 5 ? Math.atan2(-ball.vy, ball.vx) : currentBikerAngle;
  currentBikerAngle += (targetAngle - currentBikerAngle) * 0.20;

  // Wheels spin proportional to traveled distance (dx ≈ arc length).
  // Wheel radius in world units = vb-radius × (BIKER_W / vb-width).
  const wheelRWorld = WHEEL_VB_R * (BIKER_W / BIKER_VB_W);
  wheelAngle += (ball.x - prevBallX) / wheelRWorld;
  prevBallX = ball.x;

  if (bikerBodyReady) {
    const w = BIKER_W * zoom;
    const h = BIKER_H * zoom;
    const scaleX = w / BIKER_VB_W;
    const scaleY = h / BIKER_VB_H;
    // Axle positions inside the translated, rotated biker frame.
    const rearX  = -w / 2 + REAR_AXLE_VB.x  * scaleX;
    const rearY  = -h     + REAR_AXLE_VB.y  * scaleY;
    const frontX = -w / 2 + FRONT_AXLE_VB.x * scaleX;
    const frontY = -h     + FRONT_AXLE_VB.y * scaleY;
    const wheelR = WHEEL_VB_R * scaleX;

    ctx.save();
    ctx.translate(bsx, bsy);
    ctx.rotate(currentBikerAngle);

    // Body (frame + rider, no wheels)
    ctx.drawImage(bikerBody, -w / 2, -h, w, h);

    // Wheels — rotate each around its own axle
    if (bikerWheelReady) {
      const drawWheel = (cx: number, cy: number): void => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(wheelAngle);
        ctx.drawImage(bikerWheel, -wheelR, -wheelR, wheelR * 2, wheelR * 2);
        ctx.restore();
      };
      drawWheel(rearX, rearY);
      drawWheel(frontX, frontY);
    }
    ctx.restore();
  } else {
    // Fallback while SVG is loading.
    const br = ball.r * zoom;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(bsx, bsy, br, 0, Math.PI * 2);
    ctx.fill();
  }

  hud.textContent =
    `L${currentLevel + 1}  speed ${spd.toFixed(0)}   best ${bestSpeed.toFixed(0)}   ` +
    `dist ${(maxDist / 10).toFixed(0)}m   zoom ${zoom.toFixed(2)}   ` +
    `${ball.grounded ? 'ROLL' : 'FLY'}${diving ? ' ▼' : ''}`;

  if (gameOver) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 56px ui-monospace, Menlo, monospace';
    ctx.fillText('GAME OVER', W / 2, H / 2 - 30);
    ctx.font = '14px ui-monospace, Menlo, monospace';
    ctx.fillText(
      `distance ${(maxDist / 10).toFixed(0)}m   best speed ${bestSpeed.toFixed(0)}`,
      W / 2, H / 2 + 20
    );
    ctx.fillStyle = '#ffd23f';
    ctx.fillText('press SPACE to restart', W / 2, H / 2 + 50);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
}

// --- Level picker ------------------------------------------------------------
{
  const picker = document.createElement('div');
  picker.style.cssText =
    'position:fixed;top:8px;right:12px;font-size:12px;' +
    'background:rgba(0,0,0,0.5);padding:6px 8px;border-radius:4px;color:#eee;' +
    'font-family:ui-monospace,Menlo,monospace;';
  picker.innerHTML =
    '<div style="opacity:0.6;margin-bottom:4px">LEVEL</div>' +
    LEVELS.map((l, i) =>
      `<button data-level="${i}" style="display:block;width:160px;margin:2px 0;padding:4px 8px;` +
      `background:#222;color:#eee;border:1px solid #444;cursor:pointer;` +
      `font:inherit;text-align:left">${i + 1}. ${l.name}</button>`
    ).join('');
  document.body.appendChild(picker);

  const buttons = picker.querySelectorAll<HTMLButtonElement>('button');
  const paint = (): void => {
    buttons.forEach(b => {
      b.style.background = Number(b.dataset.level) === currentLevel ? '#555' : '#222';
    });
  };
  picker.addEventListener('click', (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn || btn.dataset.level === undefined) return;
    currentLevel = Number(btn.dataset.level);
    reset();
    paint();
    btn.blur();
  });
  paint();
}

// --- Main loop ---------------------------------------------------------------
function frame(): void {
  const now = performance.now() / 1000;
  let dt = now - lastT; lastT = now;
  if (dt > 0.1) dt = 0.1;
  acc += dt;
  while (acc >= FIXED_DT) { step(FIXED_DT); acc -= FIXED_DT; }
  draw();
  updateAudio(ball.grounded, Math.hypot(ball.vx, ball.vy));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
