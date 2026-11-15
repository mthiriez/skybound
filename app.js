import * as THREE from './vendor/three.module.min.js';

/* =====================  SKYBOUND — étape 1  ===================== 
   Terrain réel : photos BD ORTHO + relief RGE ALTI (IGN Géoplateforme).
   Tout est chargé côté navigateur, sans serveur ni clé. */

const UI = {
  alt: document.getElementById('alt'),
  spd: document.getElementById('spd'),
  hdg: document.getElementById('hdg'),
  fps: document.getElementById('fps'),
  start: document.getElementById('start'),
  status: document.getElementById('status'),
  bar: document.getElementById('bar').firstElementChild,
  go: document.getElementById('go'),
  pauseOverlay: document.getElementById('pauseOverlay'),
  resume: document.getElementById('resume'),
  pause: document.getElementById('pause'),
  boost: document.getElementById('boost'),
  knob: document.getElementById('knob'),
  rotate: document.getElementById('rotate'),
  error: document.getElementById('error'),
  errorMsg: document.getElementById('errorMsg')
};

/* ---------- géographie ---------- */
const R = 6378137;
const WORLD = 2 * Math.PI * R;
const CENTER = { lat: 50.6366, lon: 3.0633 };      // Grand-Place de Lille
const ORTHO_Z = 14, ORTHO_TILES = 8;                // 8x8 tuiles -> texture 2048 px
const ELEV_Z = 12;                                  // relief WGS84G
const GRID = 320;                                   // sommets par côté

const mercXOf = lon => lon * Math.PI / 180 * R;
const mercYOf = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R;
const latOfMercY = y => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;

const orthoN = Math.pow(2, ORTHO_Z);
const orthoSpan = WORLD / orthoN;
const txC = Math.floor((CENTER.lon + 180) / 360 * orthoN);
const tyC = Math.floor((1 - Math.log(Math.tan(CENTER.lat * Math.PI / 180) + 1 / Math.cos(CENTER.lat * Math.PI / 180)) / Math.PI) / 2 * orthoN);
const tx0 = txC - ORTHO_TILES / 2, ty0 = tyC - ORTHO_TILES / 2;
const B = {
  x0: tx0 * orthoSpan - WORLD / 2,
  x1: (tx0 + ORTHO_TILES) * orthoSpan - WORLD / 2,
  yTop: WORLD / 2 - ty0 * orthoSpan,
  yBot: WORLD / 2 - (ty0 + ORTHO_TILES) * orthoSpan
};
const CX = mercXOf(CENTER.lon), CY = mercYOf(CENTER.lat);
const SPAN_X = B.x1 - B.x0;
const SPAN_Y = B.yTop - B.yBot;

const elevDeg = 180 / Math.pow(2, ELEV_Z);

/* ---------- chargement des données ---------- */
const WMTS = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0';
function orthoUrl(z, col, row) {
  return WMTS + '&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM'
    + '&TILEMATRIX=' + z + '&TILEROW=' + row + '&TILECOL=' + col + '&FORMAT=image/jpeg';
}
function elevUrl(col, row) {
  return WMTS + '&LAYER=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLE=normal'
    + '&TILEMATRIXSET=WGS84G_6_14&TILEMATRIX=' + ELEV_Z + '&TILEROW=' + row + '&TILECOL=' + col
    + '&FORMAT=image/x-bil;bits=32';
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Tuile indisponible : ' + url));
    img.src = url;
  });
}

const elevTiles = new Map();
async function loadElevTile(col, row) {
  const key = col + ':' + row;
  if (elevTiles.has(key)) return elevTiles.get(key);
  const res = await fetch(elevUrl(col, row));
  if (!res.ok) throw new Error('Relief ' + col + '/' + row + ' : HTTP ' + res.status);
  let buf = await res.arrayBuffer();
  // L'IGN sert ces tuiles avec Content-Encoding: deflate ; le navigateur décompresse
  // normalement tout seul. On couvre le cas où il ne le fait pas.
  if (buf.byteLength < 256 * 256 * 4 && typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('deflate');
      const stream = new Blob([buf]).stream().pipeThrough(ds);
      buf = await new Response(stream).arrayBuffer();
    } catch (e) { /* on garde les octets d'origine */ }
  }
  if (buf.byteLength < 256 * 256 * 4) throw new Error('Relief ' + col + '/' + row + ' : tuile incomplète (' + buf.byteLength + ' octets)');
  const dv = new DataView(buf);
  const f = new Float32Array(256 * 256);
  for (let i = 0; i < f.length; i++) f[i] = dv.getFloat32(i * 4, false);
  elevTiles.set(key, f);
  return f;
}

function sampleElevation(lon, lat) {
  const fc = (lon + 180) / elevDeg, fr = (90 - lat) / elevDeg;
  const col = Math.floor(fc), row = Math.floor(fr);
  const t = elevTiles.get(col + ':' + row);
  if (!t) return 0;
  let px = (fc - col) * 256 - 0.5, py = (fr - row) * 256 - 0.5;
  px = Math.max(0, Math.min(255, px));
  py = Math.max(0, Math.min(255, py));
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1);
  const dx = px - x0, dy = py - y0;
  const v00 = t[y0 * 256 + x0], v10 = t[y0 * 256 + x1];
  const v01 = t[y1 * 256 + x0], v11 = t[y1 * 256 + x1];
  return (v00 * (1 - dx) + v10 * dx) * (1 - dy) + (v01 * (1 - dx) + v11 * dx) * dy;
}

async function buildTerrainTexture() {
  const size = ORTHO_TILES * 256;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#1a2433';
  g.fillRect(0, 0, size, size);
  let done = 0, failed = 0;
  const total = ORTHO_TILES * ORTHO_TILES;
  const jobs = [];
  for (let iy = 0; iy < ORTHO_TILES; iy++) {
    for (let ix = 0; ix < ORTHO_TILES; ix++) {
      const col = tx0 + ix, row = ty0 + iy;
      jobs.push(loadImage(orthoUrl(ORTHO_Z, col, row)).then(img => {
        g.drawImage(img, ix * 256, iy * 256, 256, 256);
      }).catch(() => { failed++; }).then(() => {
        done++;
        if (window.__skyProgress) window.__skyProgress('Photos aériennes ' + done + '/' + total, done / total * 0.75);
      }));
    }
  }
  await Promise.all(jobs);
  if (failed > total * 0.4) throw new Error('Trop de tuiles aériennes indisponibles (' + failed + '/' + total + ')');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

async function loadElevationForBounds() {
  const corners = [
    [B.x0, B.yTop], [B.x1, B.yTop], [B.x0, B.yBot], [B.x1, B.yBot]
  ].map(([x, y]) => ({
    lon: x / R * 180 / Math.PI,
    lat: latOfMercY(y)
  }));
  const cols = corners.map(c => Math.floor((c.lon + 180) / elevDeg));
  const rows = corners.map(c => Math.floor((90 - c.lat) / elevDeg));
  const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
  const r0 = Math.min.apply(null, rows), r1 = Math.max.apply(null, rows);
  const list = [];
  for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) list.push([c, r]);
  let done = 0;
  await Promise.all(list.map(([c, r]) => loadElevTile(c, r).catch(() => null).then(() => {
    done++;
    if (window.__skyProgress) window.__skyProgress('Relief ' + done + '/' + list.length, 0.75 + done / list.length * 0.25);
  })));
  if (elevTiles.size === 0) throw new Error('Le relief IGN n\'a pas pu être chargé');
}

/* ---------- hauteurs pour les collisions ---------- */
const heightGrid = new Float32Array((GRID + 1) * (GRID + 1));
function terrainHeightAt(wx, wz) {
  const u = (wx + SPAN_X / 2) / SPAN_X;
  const v = (wz + SPAN_Y / 2) / SPAN_Y;
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const gx = u * GRID, gy = v * GRID;
  const x0 = Math.min(GRID - 1, Math.floor(gx)), y0 = Math.min(GRID - 1, Math.floor(gy));
  const fx = gx - x0, fy = gy - y0;
  const i0 = y0 * (GRID + 1) + x0;
  const h00 = heightGrid[i0], h10 = heightGrid[i0 + 1];
  const h01 = heightGrid[i0 + GRID + 1], h11 = heightGrid[i0 + GRID + 2];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
}

function buildTerrainMesh(texture) {
  const n = GRID + 1;
  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const idx = new Uint32Array(GRID * GRID * 6);
  for (let iy = 0; iy < n; iy++) {
    const v = iy / GRID;
    const my = B.yTop - v * SPAN_Y;
    const lat = latOfMercY(my);
    for (let ix = 0; ix < n; ix++) {
      const u = ix / GRID;
      const mx = B.x0 + u * SPAN_X;
      const lon = mx / R * 180 / Math.PI;
      const h = sampleElevation(lon, lat);
      const k = iy * n + ix;
      pos[k * 3] = mx - CX;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = -(my - CY);
      uv[k * 2] = u;
      uv[k * 2 + 1] = 1 - v;
      heightGrid[k] = h;
    }
  }
  let o = 0;
  for (let iy = 0; iy < GRID; iy++) {
    for (let ix = 0; ix < GRID; ix++) {
      const a = iy * n + ix, b = a + 1, c = a + n, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/* ---------- scène 3D ---------- */
const canvas = document.getElementById('view');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  UI.errorMsg.textContent = 'WebGL indisponible sur ce navigateur : ' + e.message;
  UI.error.classList.remove('hidden');
  throw e;
}
let DPR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(DPR);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xb9cbdd, 0.00005);
const camera = new THREE.PerspectiveCamera(62, 1, 3, 30000);

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: new THREE.Color(0x1b3762) }, bottom: { value: new THREE.Color(0xd7e5f3) } },
  vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y * 1.3 + 0.12, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }'
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 24, 16), skyMat);
sky.frustumCulled = false;
scene.add(sky);

scene.add(new THREE.HemisphereLight(0xbdd7ff, 0x4a4436, 0.9));
const sun = new THREE.DirectionalLight(0xffe3bb, 1.3);
sun.position.set(-2600, 1900, -1200);
scene.add(sun);

/* ---------- avion (design original) ---------- */
function buildAircraft() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf3f6f9, roughness: 0.42, metalness: 0.12 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x232c3a, roughness: 0.55 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.4, emissive: 0x3a1400 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.92, 6.4, 6, 12), white);
  body.rotation.x = Math.PI / 2;
  g.add(body);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.92, 2.1, 12), white);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -4.75;
  g.add(nose);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(11.2, 0.3, 2.15), white);
  wing.position.set(0, -0.1, 0.35);
  g.add(wing);

  const wingTipL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 2.15), accent);
  wingTipL.position.set(-5.5, -0.1, 0.35);
  g.add(wingTipL);
  const wingTipR = wingTipL.clone();
  wingTipR.position.x = 5.5;
  g.add(wingTipR);

  const stab = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.22, 1.0), white);
  stab.position.set(0, 0.32, 3.15);
  g.add(stab);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.26, 1.9, 1.35), accent);
  fin.position.set(0, 1.05, 3.15);
  g.add(fin);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.78, 12, 10), dark);
  canopy.scale.set(0.95, 0.8, 1.9);
  canopy.position.set(0, 0.72, -1.5);
  g.add(canopy);

  const engL = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.9, 10), dark);
  engL.rotation.x = Math.PI / 2;
  engL.position.set(-2.7, -0.42, 0.6);
  g.add(engL);
  const engR = engL.clone();
  engR.position.x = 2.7;
  g.add(engR);

  return g;
}
const aircraft = buildAircraft();
scene.add(aircraft);

/* ---------- état de vol ---------- */
const flight = {
  pos: new THREE.Vector3(0, 420, 3200),
  heading: 0, pitch: 0, roll: 0, speed: 66,
  shake: 0
};
const MAX_ALT = 3200, MIN_CLEAR = 9;

let stickX = 0, stickY = 0, boosting = false;
let state = 'loading';
const keys = Object.create(null);

/* ---------- audio ---------- */
let AC = null, eng = null, engGain = null, windGain = null, master = null;
function initAudio() {
  if (AC) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    AC = new Ctx();
    master = AC.createGain(); master.gain.value = 0.5; master.connect(AC.destination);
    eng = AC.createOscillator(); eng.type = 'sawtooth'; eng.frequency.value = 80;
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    engGain = AC.createGain(); engGain.gain.value = 0;
    eng.connect(lp); lp.connect(engGain); engGain.connect(master);
    eng.start();
    const len = Math.floor(AC.sampleRate * 2);
    const buf = AC.createBuffer(1, len, AC.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = AC.createBufferSource(); src.buffer = buf; src.loop = true;
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
    windGain = AC.createGain(); windGain.gain.value = 0;
    src.connect(bp); bp.connect(windGain); windGain.connect(master);
    src.start();
  } catch (e) { AC = null; }
}
function audioUpdate() {
  if (!AC) return;
  const t = AC.currentTime;
  const f = 62 + flight.speed * 1.25 + (boosting ? 22 : 0);
  try {
    eng.frequency.setTargetAtTime(f, t, 0.15);
    engGain.gain.setTargetAtTime(state === 'flying' ? 0.055 : 0.0, t, 0.2);
    windGain.gain.setTargetAtTime(state === 'flying' ? Math.min(0.09, flight.speed / 1400) : 0, t, 0.25);
  } catch (e) {}
}

/* ---------- entrées ---------- */
let pointerId = null, originX = 0, originY = 0;

function setKnob(dx, dy) {
  const max = 34;
  const kx = Math.max(-max, Math.min(max, dx * 40));
  const ky = Math.max(-max, Math.min(max, dy * 40));
  UI.knob.style.transform = 'translate(' + kx + 'px,' + ky + 'px)';
}

canvas.addEventListener('pointerdown', (e) => {
  if (state !== 'flying') return;
  e.preventDefault();
  initAudio();
  pointerId = e.pointerId;
  originX = e.clientX; originY = e.clientY;
  setKnob(0, 0);
}, { passive: false });

canvas.addEventListener('pointermove', (e) => {
  if (pointerId !== e.pointerId || state !== 'flying') return;
  e.preventDefault();
  const dx = (e.clientX - originX) / 90;
  const dy = (e.clientY - originY) / 90;
  stickX = Math.max(-1, Math.min(1, dx));
  stickY = Math.max(-1, Math.min(1, dy));
  setKnob(dx, dy);
}, { passive: false });

function endPointer(e) {
  if (pointerId !== null && e && e.pointerId !== undefined && e.pointerId !== pointerId) return;
  pointerId = null; stickX = 0; stickY = 0; setKnob(0, 0);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', endPointer);

function boostOn(e) { e.preventDefault(); e.stopPropagation(); boosting = true; UI.boost.classList.add('on'); initAudio(); }
function boostOff(e) { if (e) e.preventDefault(); boosting = false; UI.boost.classList.remove('on'); }
UI.boost.addEventListener('pointerdown', boostOn, { passive: false });
UI.boost.addEventListener('pointerup', boostOff);
UI.boost.addEventListener('pointercancel', boostOff);
UI.boost.addEventListener('pointerleave', boostOff);

window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'Shift') boosting = true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].indexOf(e.key) >= 0) e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
  if (e.key === 'Shift') boosting = false;
});

/* ---------- modèle de vol ---------- */
function updateFlight(dt) {
  const kx = ((keys['arrowright'] || keys['d']) ? 1 : 0) - ((keys['arrowleft'] || keys['a']) ? 1 : 0);
  const ky = ((keys['arrowdown'] || keys['s']) ? 1 : 0) - ((keys['arrowup'] || keys['w']) ? 1 : 0);
  const ix = Math.max(-1, Math.min(1, stickX + kx));
  const iy = Math.max(-1, Math.min(1, stickY + ky));

  const targetSpeed = boosting ? 104 : 70;
  flight.speed += (targetSpeed - flight.speed) * Math.min(1, dt * (boosting ? 1.8 : 0.9));

  flight.heading += ix * 0.62 * dt;
  const pitchTarget = iy * 0.5;
  flight.pitch += (pitchTarget - flight.pitch) * Math.min(1, dt * 3.0);
  flight.roll += ((-ix * 0.55) - flight.roll) * Math.min(1, dt * 4.0);

  const climb = Math.sin(flight.pitch) * flight.speed;
  const sink = Math.max(0, 70 - flight.speed) * 0.6;
  flight.pos.y += (climb - sink) * dt;
  if (flight.pos.y > MAX_ALT) flight.pos.y = MAX_ALT;

  flight.pos.x += Math.sin(flight.heading) * flight.speed * dt;
  flight.pos.z -= Math.cos(flight.heading) * flight.speed * dt;

  const halfX = SPAN_X / 2 - 250, halfZ = SPAN_Y / 2 - 250;
  if (flight.pos.x > halfX) flight.pos.x = halfX;
  if (flight.pos.x < -halfX) flight.pos.x = -halfX;
  if (flight.pos.z > halfZ) flight.pos.z = halfZ;
  if (flight.pos.z < -halfZ) flight.pos.z = -halfZ;

  const gh = terrainHeightAt(flight.pos.x, flight.pos.z);
  if (flight.pos.y < gh + MIN_CLEAR) {
    flight.pos.y = gh + MIN_CLEAR;
    if (flight.pitch < 0.06) flight.pitch = 0.06;
    flight.speed *= 0.992;
    flight.shake = 0.55;
  }
  flight.shake = Math.max(0, flight.shake - dt * 1.6);

  aircraft.position.copy(flight.pos);
  aircraft.rotation.set(flight.pitch, -flight.heading, flight.roll, 'YXZ');
}

const camFwd = new THREE.Vector3();
const camDesired = new THREE.Vector3();
const camLook = new THREE.Vector3();

function updateCamera(dt) {
  const h = flight.heading;
  camFwd.set(Math.sin(h), 0, -Math.cos(h));
  camDesired.copy(flight.pos).addScaledVector(camFwd, -24);
  camDesired.y += 7.2;
  const k = state === 'flying' ? (1 - Math.exp(-dt * 4.5)) : 1;
  camera.position.lerp(camDesired, k);
  if (flight.shake > 0.01) {
    camera.position.x += (Math.random() - 0.5) * flight.shake * 2.4;
    camera.position.y += (Math.random() - 0.5) * flight.shake * 2.4;
  }
  camLook.copy(flight.pos).addScaledVector(camFwd, 46);
  camLook.y += 2;
  camera.lookAt(camLook);
  sky.position.copy(camera.position);
}

/* ---------- interface ---------- */
let hudTick = 0;
function updateHud(dt) {
  hudTick += dt;
  if (hudTick < 0.1) return;
  hudTick = 0;
  UI.alt.textContent = Math.round(flight.pos.y);
  UI.spd.textContent = Math.round(flight.speed * 3.6);
  let deg = flight.heading * 180 / Math.PI;
  deg = (deg % 360 + 360) % 360;
  UI.hdg.textContent = Math.round(deg);
}

/* ---------- boucle ---------- */
let last = 0, frames = 0, fpsTime = 0, fpsValue = 0, slow = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!last) last = ts;
  let dt = (ts - last) / 1000;
  last = ts;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  if (dt > 0.05) dt = 0.05;

  if (state === 'flying') {
    updateFlight(dt);
    updateHud(dt);
    audioUpdate();
  }
  updateCamera(dt);
  renderer.render(scene, camera);

  frames++; fpsTime += dt;
  if (fpsTime >= 0.5) {
    fpsValue = Math.round(frames / fpsTime);
    UI.fps.textContent = fpsValue;
    frames = 0; fpsTime = 0;
    if (state === 'flying') {
      if (fpsValue < 28) { slow++; } else { slow = Math.max(0, slow - 1); }
      if (slow >= 6 && DPR > 1.05) { DPR = Math.max(1, DPR - 0.25); renderer.setPixelRatio(DPR); slow = 0; }
    }
  }
}

/* ---------- redimensionnement ---------- */
function resize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  UI.rotate.style.display = (h > w) ? 'flex' : 'none';
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 150));

/* ---------- cycle de vie ---------- */
function startFlight() {
  initAudio();
  if (AC && AC.state === 'suspended') AC.resume();
  flight.pos.set(0, 420, 3200);
  flight.heading = 0; flight.pitch = 0; flight.roll = 0; flight.speed = 66;
  flight.shake = 0;
  const gh = terrainHeightAt(0, 3200);
  flight.pos.y = Math.max(360, gh + 340);
  camera.position.set(flight.pos.x, flight.pos.y + 7, flight.pos.z + 24);
  state = 'flying';
  UI.start.classList.add('hidden');
  UI.pauseOverlay.classList.add('hidden');
}
UI.go.addEventListener('click', startFlight);

UI.pause.addEventListener('click', () => {
  if (state !== 'flying') return;
  state = 'paused';
  boosting = false;
  UI.boost.classList.remove('on');
  UI.pauseOverlay.classList.remove('hidden');
});
UI.resume.addEventListener('click', () => {
  UI.pauseOverlay.classList.add('hidden');
  state = 'flying';
  last = 0;
  if (AC && AC.state === 'suspended') AC.resume();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'flying') {
    state = 'paused';
    boosting = false;
    UI.boost.classList.remove('on');
    UI.pauseOverlay.classList.remove('hidden');
  }
  last = 0;
});
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

/* ---------- démarrage ---------- */
window.__skyProgress = function (msg, frac) {
  UI.status.textContent = msg;
  UI.bar.style.width = Math.round(frac * 100) + '%';
};

async function boot() {
  resize();
  requestAnimationFrame(frame);
  try {
    window.__skyProgress('Photos aériennes de Lille…', 0.02);
    const tex = await buildTerrainTexture();
    window.__skyProgress('Relief RGE ALTI…', 0.78);
    await loadElevationForBounds();
    window.__skyProgress('Assemblage du terrain…', 0.96);
    const terrain = buildTerrainMesh(tex);
    scene.add(terrain);
    const gh = terrainHeightAt(0, 3200);
    flight.pos.y = Math.max(360, gh + 340);
    camera.position.set(0, flight.pos.y + 7, 3224);
    camera.lookAt(0, flight.pos.y, 0);
    UI.bar.style.width = '100%';
    UI.status.textContent = 'Prêt · survol de Lille et sa métropole';
    UI.go.disabled = false;
    state = 'ready';
  } catch (err) {
    console.error(err);
    UI.status.textContent = 'Chargement impossible';
    UI.errorMsg.textContent = 'Les données IGN n\'ont pas pu être chargées (' + err.message + '). Vérifie la connexion puis recharge la page.';
    UI.error.classList.remove('hidden');
  }
}
boot();
