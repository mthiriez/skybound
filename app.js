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
  place: document.getElementById('place'),
  placeCity: document.getElementById('placeCity'),
  placeStreet: document.getElementById('placeStreet'),
  throttle: document.getElementById('throttle'),
  thrFill: document.getElementById('thrFill'),
  thrKnob: document.getElementById('thrKnob'),
  thrVal: document.getElementById('thrVal'),
  knob: document.getElementById('knob'),
  rotate: document.getElementById('rotate'),
  error: document.getElementById('error'),
  errorMsg: document.getElementById('errorMsg')
};

/* ---------- géographie ---------- */
const R = 6378137;
const WORLD = 2 * Math.PI * R;
const CENTER = { lat: 50.6366, lon: 3.0633 };      // Grand-Place de Lille
const ORTHO_Z = 14, ORTHO_TILES = 6;                // 6x6 tuiles -> texture 1536 px
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
let elevLittleEndian = null;
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
  // Le BIL de l'IGN est en petit-boutiste (vérifié en ligne : altitudes 13 à 38 m
  // autour de Lille). On garde une détection sur la moyenne pour rester robuste
  // si l'IGN change un jour de convention.
  if (elevLittleEndian === null) {
    let beSum = 0, beOk = 0, leSum = 0, leOk = 0;
    for (let k = 0; k < 512; k++) {
      const off = ((k * 2731) % 65536) * 4;
      const a = dv.getFloat32(off, false);
      const b = dv.getFloat32(off, true);
      if (isFinite(a) && a > -500 && a < 3200) { beSum += a; beOk++; }
      if (isFinite(b) && b > -500 && b < 3200) { leSum += b; leOk++; }
    }
    const beMean = beOk ? beSum / beOk : 1e9;
    const leMean = leOk ? leSum / leOk : 1e9;
    elevLittleEndian = leOk >= beOk || leMean < 1e8;
    console.info('[SKYBOUND] relief petit-boutiste=' + elevLittleEndian + ' moyBE=' + Math.round(beMean) + ' moyLE=' + Math.round(leMean));
  }
  const f = new Float32Array(256 * 256);
  for (let i = 0; i < f.length; i++) {
    let v = dv.getFloat32(i * 4, elevLittleEndian);
    if (!isFinite(v) || v < -500 || v > 3200) v = 0;
    f[i] = v;
  }
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
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
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
  let hMin = 1e9, hMax = -1e9;
  for (let k = 0; k < heightGrid.length; k++) {
    if (heightGrid[k] < hMin) hMin = heightGrid[k];
    if (heightGrid[k] > hMax) hMax = heightGrid[k];
  }
  if (hMax > 3200 || hMin < -600) throw new Error('Relief incohérent (' + Math.round(hMin) + ' à ' + Math.round(hMax) + ' m) : format de tuile inattendu');
  console.info('[SKYBOUND] relief de la zone : ' + Math.round(hMin) + ' à ' + Math.round(hMax) + ' m');

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

/* ---------- couche détail haute résolution (suit l'avion) ---------- */
const DETAIL_Z = 17;                  // ~0,76 m/px à la latitude de Lille
const DETAIL_N = 5;                   // 5x5 tuiles
const DETAIL_PX = DETAIL_N * 256;
// Attention : les coordonnées du monde sont en mètres Mercator (comme les tuiles),
// pas en mètres au sol. Une tuile z17 mesure 305,75 m Mercator (soit ~194 m au sol
// à la latitude de Lille) : c'est cette valeur qu'il faut utiliser pour dimensionner
// la fenêtre, sinon l'image est écrasée d'un facteur cos(latitude) et se superpose
// en fantôme au fond large.
const DETAIL_SPAN = DETAIL_N * (WORLD / Math.pow(2, DETAIL_Z));   // ~1 529 m Mercator
const DETAIL_RES_SOL = 156543.033928041 * Math.cos(CENTER.lat * Math.PI / 180) / Math.pow(2, DETAIL_Z); // ~0,76 m/px au sol
const DETAIL_SEG = 48;

const detailCv = document.createElement('canvas');
detailCv.width = detailCv.height = DETAIL_PX;
const detailCtx = detailCv.getContext('2d');
detailCtx.fillStyle = '#3a4038';
detailCtx.fillRect(0, 0, DETAIL_PX, DETAIL_PX);
const detailTex = new THREE.CanvasTexture(detailCv);
detailTex.colorSpace = THREE.SRGBColorSpace;
detailTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
detailTex.minFilter = THREE.LinearMipmapLinearFilter;
detailTex.magFilter = THREE.LinearFilter;
detailTex.generateMipmaps = true;

/* masque radial : la fenêtre nette se fond dans la photo large */
const fadeCv = document.createElement('canvas');
fadeCv.width = fadeCv.height = 256;
(function () {
  const g = fadeCv.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  const grad = g.createRadialGradient(128, 128, 30, 128, 128, 127);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.58, '#ffffff');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
}());
const fadeTex = new THREE.CanvasTexture(fadeCv);

let detailMesh = null;
let detailColC = null, detailRowC = null, detailBusy = false, detailPending = false, detailTick = 0;
const detailCache = new Map();

function detailTile(col, row) {
  const key = col + '/' + row;
  let job = detailCache.get(key);
  if (!job) {
    job = loadImage(orthoUrl(DETAIL_Z, col, row)).catch(() => null);
    detailCache.set(key, job);
    if (detailCache.size > 220) detailCache.delete(detailCache.keys().next().value);
  }
  return job;
}

function buildDetailMesh() {
  const n = DETAIL_SEG + 1;
  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const idx = new Uint32Array(DETAIL_SEG * DETAIL_SEG * 6);
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const u = ix / DETAIL_SEG, v = iy / DETAIL_SEG;
      const k = iy * n + ix;
      pos[k * 3] = (u - 0.5) * DETAIL_SPAN;
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = (v - 0.5) * DETAIL_SPAN;
      uv[k * 2] = u;
      uv[k * 2 + 1] = 1 - v;
    }
  }
  let o = 0;
  for (let iy = 0; iy < DETAIL_SEG; iy++) {
    for (let ix = 0; ix < DETAIL_SEG; ix++) {
      const a = iy * n + ix, b = a + 1, c = a + n, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.MeshLambertMaterial({
    map: detailTex, alphaMap: fadeTex, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
  });
  detailMesh = new THREE.Mesh(geo, mat);
  detailMesh.frustumCulled = false;
  scene.add(detailMesh);
  return detailMesh;
}

function positionDetail() {
  if (!detailMesh || detailColC === null) return;
  const span = WORLD / Math.pow(2, DETAIL_Z);
  const cxw = (detailColC + 0.5) * span - WORLD / 2;
  const cyw = WORLD / 2 - (detailRowC + 0.5) * span;
  detailMesh.position.set(cxw - CX, 3.0, -(cyw - CY));
  const attr = detailMesh.geometry.getAttribute('position');
  const n2 = DETAIL_SEG + 1;
  for (let iy = 0; iy < n2; iy++) {
    for (let ix = 0; ix < n2; ix++) {
      const k = iy * n2 + ix;
      const wx = cxw + (ix / DETAIL_SEG - 0.5) * DETAIL_SPAN;
      const my = cyw - (iy / DETAIL_SEG - 0.5) * DETAIL_SPAN;
      attr.array[k * 3 + 1] = sampleElevation(wx / R * 180 / Math.PI, latOfMercY(my));
    }
  }
  attr.needsUpdate = true;
  detailMesh.geometry.computeBoundingSphere();
}

async function refreshDetail(wx, wy) {
  const span = WORLD / Math.pow(2, DETAIL_Z);
  const colC = Math.floor((wx + WORLD / 2) / span);
  const rowC = Math.floor((WORLD / 2 - wy) / span);
  if (colC === detailColC && rowC === detailRowC) return;
  if (detailBusy) { detailPending = true; return; }
  detailBusy = true;
  detailColC = colC; detailRowC = rowC;
  const half = (DETAIL_N - 1) / 2;
  const jobs = [];
  for (let j = 0; j < DETAIL_N; j++) {
    for (let i = 0; i < DETAIL_N; i++) {
      const ix = i, iy = j;
      jobs.push(detailTile(colC - half + i, rowC - half + j).then(img => {
        detailCtx.fillStyle = '#3a4038';
        detailCtx.fillRect(ix * 256, iy * 256, 256, 256);
        if (img) detailCtx.drawImage(img, ix * 256, iy * 256, 256, 256);
      }));
    }
  }
  await Promise.all(jobs);
  detailTex.needsUpdate = true;
  positionDetail();
  detailBusy = false;
  if (detailPending) {
    detailPending = false;
    const px = flight.pos.x, pz = flight.pos.z;
    refreshDetail(CX + px, CY - pz);
  }
}

/* ---------- bâtiments réels : BD TOPO IGN ---------- */
// Empreintes et hauteurs réelles, extrudées sur le relief. Chargement par tuiles
// autour de l'avion, une requête à la fois (l'API WFS de l'IGN tolère 1 appel/s).
const BLD_SIZE = 600;          // côté d'une tuile, en mètres Mercator
const BLD_RADIUS = 1;          // 3 x 3 tuiles autour de l'avion (~2,1 km)
const BLD_MAX_CACHE = 40;
const BLD_QUEUE_MS = 1100;     // intervalle minimum entre deux requêtes

const bldMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true });
const bldGroup = new THREE.Group();
scene.add(bldGroup);
const bldTiles = new Map();     // clé -> { mesh, ids }
const bldOwner = new Map();     // cleabs -> clé de tuile (évite les doublons de bord)
const bldQueue = [];
let bldBusy = false, bldLastReq = 0, bldCenter = null;

function bldTileCoords(wx, wy) {
  return [Math.floor((wx + WORLD / 2) / BLD_SIZE), Math.floor((WORLD / 2 - wy) / BLD_SIZE)];
}

function bldHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

// Geo -> coordonnées du monde (mètres Mercator, origine au centre de la zone)
function geoToWorld(lon, lat) {
  const mx = R * lon * Math.PI / 180;
  const my = R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  return [mx - CX, -(my - CY)];
}

function bldGeometry(features, col, row) {
  const pos = [], nrm = [], col3 = [], ids = [];
  const x0 = col * BLD_SIZE - WORLD / 2, yTop = WORLD / 2 - row * BLD_SIZE;
  let kept = 0;

  const pushQuad = (ax, az, bx, bz, y0, y1, nx, nz, cr, cg, cb) => {
    // deux triangles, normale horizontale donnée
    pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz,
             ax, y0, az, bx, y1, bz, ax, y1, az);
    for (let k = 0; k < 6; k++) { nrm.push(nx, 0, nz); col3.push(cr, cg, cb); }
  };

  for (let f = 0; f < features.length; f++) {
    const ft = features[f];
    const pr = ft.properties || {};
    if (bldOwner.has(pr.cleabs) && bldOwner.get(pr.cleabs) !== col + ':' + row) continue;
    if (pr.etat_de_l_objet && pr.etat_de_l_objet !== 'En service') continue;
    if (!ft.geometry) continue;
    const rings = [];
    if (ft.geometry.type === 'Polygon') {
      rings.push(ft.geometry.coordinates[0]);
    } else if (ft.geometry.type === 'MultiPolygon') {
      for (let i = 0; i < ft.geometry.coordinates.length; i++) rings.push(ft.geometry.coordinates[i][0]);
    } else continue;

    let h = Number(pr.hauteur);
    if (!isFinite(h) || h <= 0) {
      const a = Number(pr.altitude_maximale_toit), b = Number(pr.altitude_minimale_sol);
      h = (isFinite(a) && isFinite(b) && a > b) ? a - b : 6;
    }
    h = Math.max(2.2, Math.min(120, h));

    const tone = bldHash(String(pr.cleabs || f));
    const wr = 0.30 + tone * 0.10, wg = 0.30 + tone * 0.09, wb = 0.31 + tone * 0.08;   // murs
    const rr = 0.42 + tone * 0.11, rg = 0.40 + tone * 0.10, rb = 0.37 + tone * 0.09;   // toits

    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      if (!ring || ring.length < 4) continue;
      const pts = [];
      let sx = 0, sz = 0;
      for (let i = 0; i < ring.length; i++) {
        const w = geoToWorld(ring[i][0], ring[i][1]);
        pts.push(w); sx += w[0]; sz += w[1];
      }
      const cx = sx / pts.length, cz = sz / pts.length;
      // altitude du sol sous le bâtiment, prise sur notre relief (cohérent avec le maillage)
      const lonC = (cx + CX) / R * 180 / Math.PI;
      const latC = latOfMercY(CY - cz);
      const y0 = sampleElevation(lonC, latC);
      const y1 = y0 + h;

      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        pushQuad(a[0], a[1], b[0], b[1], y0, y1, dz / len, -dx / len, wr, wg, wb);
      }
      // toit : triangulation de l'empreinte
      const contour = pts.slice(0, -1).map((q) => new THREE.Vector2(q[0], q[1]));
      let tris = [];
      try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { tris = []; }
      for (let t = 0; t < tris.length; t++) {
        const tri = tris[t];
        const A = contour[tri[0].a !== undefined ? 0 : tri[0]], B = contour[tri[1]], C = contour[tri[2]];
        if (!A || !B || !C) continue;
        pos.push(A.x, y1, A.y, B.x, y1, B.y, C.x, y1, C.y);
        for (let k = 0; k < 3; k++) { nrm.push(0, 1, 0); col3.push(rr, rg, rb); }
      }
      kept++;
    }
    if (pr.cleabs) { ids.push(pr.cleabs); bldOwner.set(pr.cleabs, col + ':' + row); }
  }

  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col3, 3));
  g.computeBoundingSphere();
  return { geometry: g, ids: ids, count: kept };
}

function bldDisposeTile(key) {
  const t = bldTiles.get(key);
  if (!t) return;
  bldGroup.remove(t.mesh);
  t.mesh.geometry.dispose();
  for (let i = 0; i < t.ids.length; i++) if (bldOwner.get(t.ids[i]) === key) bldOwner.delete(t.ids[i]);
  bldTiles.delete(key);
}

function bldRequest(col, row) {
  const key = col + ':' + row;
  if (bldTiles.has(key)) return;
  bldTiles.set(key, { mesh: null, ids: [], loading: true });
  const lonMin = (col * BLD_SIZE - WORLD / 2) / R * 180 / Math.PI;
  const lonMax = ((col + 1) * BLD_SIZE - WORLD / 2) / R * 180 / Math.PI;
  const latMax = latOfMercY(WORLD / 2 - row * BLD_SIZE);
  const latMin = latOfMercY(WORLD / 2 - (row + 1) * BLD_SIZE);
  const url = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature'
    + '&TYPENAMES=BDTOPO_V3:batiment&SRSNAME=EPSG:4326&OUTPUTFORMAT=application/json&COUNT=3000'
    + '&PROPERTYNAME=cleabs,hauteur,geometrie'
    + '&BBOX=' + [latMin, lonMin, latMax, lonMax].map((v) => v.toFixed(6)).join(',');
  bldBusy = true;
  fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const entry = bldTiles.get(key);
      if (!entry || !j || !j.features) { if (entry) bldTiles.delete(key); return; }
      const built = bldGeometry(j.features, col, row);
      if (!built) { bldTiles.delete(key); return; }
      const mesh = new THREE.Mesh(built.geometry, bldMaterial);
      mesh.frustumCulled = true;
      bldGroup.add(mesh);
      bldTiles.set(key, { mesh: mesh, ids: built.ids });
    })
    .catch(() => { if (bldTiles.get(key) && !bldTiles.get(key).mesh) bldTiles.delete(key); })
    .finally(() => { bldBusy = false; });
}

function bldTick() {
  if (bldBusy) return;
  const now = performance.now();
  if (now - bldLastReq < BLD_QUEUE_MS) return;
  const [col, row] = bldTileCoords(CX + flight.pos.x, CY - flight.pos.z);
  if (col !== bldCenter) {
    // purge des tuiles sorties du rayon
    bldTiles.forEach((v, key) => {
      const parts = key.split(':');
      const c = Number(parts[0]), r = Number(parts[1]);
      if (Math.abs(c - col) > BLD_RADIUS + 1 || Math.abs(r - row) > BLD_RADIUS + 1) bldDisposeTile(key);
    });
    bldCenter = col;
  }
  let best = null, bestD = 1e9;
  for (let du = -BLD_RADIUS; du <= BLD_RADIUS; du++) {
    for (let dv = -BLD_RADIUS; dv <= BLD_RADIUS; dv++) {
      const c = col + du, r = row + dv, key = c + ':' + r;
      if (bldTiles.has(key)) continue;
      const d = du * du + dv * dv;
      if (d < bestD) { bestD = d; best = [c, r]; }
    }
  }
  if (!best) return;
  bldLastReq = now;
  bldRequest(best[0], best[1]);
}

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

/* ---------- commande de vitesse ---------- */
const SPD_MIN = 150, SPD_MAX = 380;
let targetKmh = 252;
function drawThrottle() {
  const p = (targetKmh - SPD_MIN) / (SPD_MAX - SPD_MIN);
  UI.thrFill.style.width = (p * 100).toFixed(1) + '%';
  UI.thrKnob.style.left = (p * 100).toFixed(1) + '%';
  UI.thrVal.textContent = Math.round(targetKmh);
}
function setThrottleFromX(clientX) {
  const r = UI.throttle.getBoundingClientRect();
  const pad = 14;
  const p = Math.max(0, Math.min(1, (clientX - r.left - pad) / Math.max(1, r.width - pad * 2)));
  targetKmh = SPD_MIN + p * (SPD_MAX - SPD_MIN);
  drawThrottle();
}
let thrPointer = null;
UI.throttle.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  thrPointer = e.pointerId;
  try { UI.throttle.setPointerCapture(e.pointerId); } catch (err) {}
  setThrottleFromX(e.clientX);
  initAudio();
}, { passive: false });
UI.throttle.addEventListener('pointermove', (e) => {
  if (thrPointer !== e.pointerId) return;
  e.preventDefault();
  setThrottleFromX(e.clientX);
}, { passive: false });
UI.throttle.addEventListener('pointerup', () => { thrPointer = null; });
UI.throttle.addEventListener('pointercancel', () => { thrPointer = null; });
drawThrottle();

window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'Shift') boosting = true;
  if (e.key === '+' || e.key === '=') { targetKmh = Math.min(SPD_MAX, targetKmh + 15); drawThrottle(); }
  if (e.key === '-') { targetKmh = Math.max(SPD_MIN, targetKmh - 15); drawThrottle(); }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].indexOf(e.key) >= 0) e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
  if (e.key === 'Shift') boosting = false;
});

/* ---------- localisation : ville et voie survolées ---------- */
let geoAccum = 9, geoBusy = false, geoShown = '';
let geoLastX = 1e9, geoLastZ = 1e9;
function showPlace(city, sub) {
  const key = city + '|' + sub;
  if (key === geoShown) return;
  geoShown = key;
  UI.placeCity.textContent = city || '—';
  UI.placeStreet.textContent = sub || '';
  UI.place.classList.remove('hidden');
}
function scheduleGeo(dt) {
  geoAccum += dt;
  // une requête toutes les 2,5 s au plus : l'API IGN limite à 1 appel/seconde
  if (geoAccum < 2.5 || geoBusy) return;
  const x = flight.pos.x, z = flight.pos.z;
  const moved = Math.hypot(x - geoLastX, z - geoLastZ);
  if (geoShown && moved < 300) return;
  geoAccum = 0;
  geoLastX = x; geoLastZ = z;
  const lon = (CX + x) / R * 180 / Math.PI;
  const lat = latOfMercY(CY - z);
  geoBusy = true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4500);
  fetch('https://data.geopf.fr/geocodage/reverse?lon=' + lon.toFixed(5) + '&lat=' + lat.toFixed(5) + '&index=address&limit=1', { signal: ctl.signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const f = j && j.features && j.features[0];
      if (!f || !f.properties) return;
      const pr = f.properties;
      const city = pr.city || pr.municipality || '';
      const sub = pr.district || pr.street || pr.name || '';
      showPlace(city, sub);
    })
    .catch(() => {})
    .finally(() => { clearTimeout(timer); geoBusy = false; });
}

/* ---------- modèle de vol ---------- */
function updateFlight(dt) {
  const kx = ((keys['arrowright'] || keys['d']) ? 1 : 0) - ((keys['arrowleft'] || keys['a']) ? 1 : 0);
  const ky = ((keys['arrowdown'] || keys['s']) ? 1 : 0) - ((keys['arrowup'] || keys['w']) ? 1 : 0);
  const ix = Math.max(-1, Math.min(1, stickX + kx));
  const iy = Math.max(-1, Math.min(1, stickY + ky));

  const targetSpeed = (boosting ? Math.max(targetKmh + 80, 360) : targetKmh) / 3.6;
  flight.speed += (targetSpeed - flight.speed) * Math.min(1, dt * (boosting ? 1.8 : 0.9));

  flight.heading += ix * 0.62 * dt;
  const pitchTarget = iy * 0.5;
  flight.pitch += (pitchTarget - flight.pitch) * Math.min(1, dt * 3.0);
  flight.roll += ((-ix * 0.55) - flight.roll) * Math.min(1, dt * 4.0);

  const climb = Math.sin(flight.pitch) * flight.speed;
  const sink = Math.max(0, 38 - flight.speed) * 0.6;
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
  UI.hdg.textContent = Math.round(deg) % 360;
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
    scheduleGeo(dt);
    bldTick();
    audioUpdate();
    detailTick += dt;
    if (detailTick > 0.5) {
      detailTick = 0;
      refreshDetail(CX + flight.pos.x, CY - flight.pos.z);
    }
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
UI.go.addEventListener('click', startFlight);UI.start.addEventListener('click', () => {
  if (!UI.go.disabled && state !== 'flying') startFlight();
});

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
    window.__skyProgress('Détail haute résolution…', 0.97);
    buildDetailMesh();
    await refreshDetail(CX, CY - 3200);
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
