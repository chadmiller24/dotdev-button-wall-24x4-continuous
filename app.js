import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ============================================================================
// Spec — 24' x 4' wall built from 3 abutted 8' x 4' panels, with one continuous
// 2" on-centre button field across the panel joints. World units = inches.
// ============================================================================
const FT = 12;
// 30 mm arcade dome — the DXF circle (radius 0.5906" → Ø 1.1812"). Fixed size.
const DIAM = 1.1812, R = DIAM / 2;
const DOME_H = 0.34;

// ---- physical build: 24' x 4' wall, 3 abutted 8' x 4' panels behind one grid ----
// The buttons are no longer laid out as three separate DXF tiles. They are one
// continuous 2" OC field, so the spacing remains 2" across both panel seams.
// Keep the original 19-row vertical layout; then 134 columns is the largest
// continuous 2" field that stays under the 2,560-button supply: 134 x 19 = 2,546.
const OC = 2;                           // on-centre button spacing (in)
const PANEL_COUNT = 3;                  // 3 hardware panels make the 24' wall
const PANEL_W_IN = 96, PANEL_H_IN = 48; // each panel face (8' x 4')
const WALL_MARGIN_X = 11;               // button-centre inset from left/right wall edge (in)
const WALL_MARGIN_Y = 6;                // button-centre inset from top/bottom wall edge (in)
const WALL_ROWS = 19;                   // preserves the previous vertical layout
const PANELS = PANEL_COUNT;             // games partition along these hardware panels

// ---- wall dimensions (fixed for this build; recomputed once at boot) ----
let WALL_W_IN, WALL_H_IN, PITCH, COLS, ROWS, N, gridW, gridH, PANEL_W, PANEL_H;
let PW, WELL_W, WELL_X, CAM_W, CAM_H, FRAME_BYTES, MASK_BYTES;
let PANEL_STARTS = [], PANEL_ENDS = [], PANEL_WIDTHS = [];
function recomputeDims() {
  PITCH = OC;
  WALL_W_IN = PANEL_W_IN * PANEL_COUNT; WALL_H_IN = PANEL_H_IN;   // 288 x 48
  COLS = Math.floor((WALL_W_IN - 2 * WALL_MARGIN_X) / OC) + 1;    // 134
  ROWS = WALL_ROWS;                                               // 19
  N = COLS * ROWS;                                                // 2,546
  gridW = (COLS - 1) * PITCH; gridH = (ROWS - 1) * PITCH;
  PANEL_W = WALL_W_IN; PANEL_H = WALL_H_IN;
  PANEL_STARTS = []; PANEL_ENDS = []; PANEL_WIDTHS = [];
  const x0 = buttonX(0);
  for (let p = 0; p < PANELS; p++) {
    const left = p * PANEL_W_IN - WALL_W_IN / 2;
    const right = (p + 1) * PANEL_W_IN - WALL_W_IN / 2;
    const start = Math.max(0, Math.ceil((left - x0) / OC));
    const end = Math.min(COLS - 1, Math.floor((right - x0) / OC));
    PANEL_STARTS[p] = start; PANEL_ENDS[p] = end; PANEL_WIDTHS[p] = Math.max(0, end - start + 1);
  }
  PW = Math.max(...PANEL_WIDTHS);                                 // 48 for this build
  WELL_W = Math.max(3, Math.min(10, Math.min(...PANEL_WIDTHS) - 1)); WELL_X = 0;
  CAM_W = PW; CAM_H = ROWS;
  FRAME_BYTES = 1 + N * 4; MASK_BYTES = 1 + Math.ceil(N / 8);
}
function buttonX(c) { return WALL_MARGIN_X + c * OC - WALL_W_IN / 2; }
// World (x,y) of the dome at logical column c, row r. The logical grid is a
// dense 134x19 field; panel seams fall between columns, not into 12" gutters.
function buttonXY(c, r) {
  const x = buttonX(c);
  const y = (WALL_MARGIN_Y + (ROWS - 1 - r) * OC) - WALL_H_IN / 2;
  return [x, y];
}
function panelStart(p) { p = Math.min(PANELS - 1, Math.max(0, p | 0)); return PANEL_STARTS[p] ?? 0; }
function panelEnd(p) { p = Math.min(PANELS - 1, Math.max(0, p | 0)); return PANEL_ENDS[p] ?? (COLS - 1); }
function panelWidth(p) { p = Math.min(PANELS - 1, Math.max(0, p | 0)); return PANEL_WIDTHS[p] ?? COLS; }
function panelCenter(p) { return (panelStart(p) + panelEnd(p)) >> 1; }
function wellX(p) { return Math.max(0, (panelWidth(p) - WELL_W) >> 1); }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const idx = (x, y) => y * COLS + x;
const GAMES = ["life", "snake", "tetris", "fireworks", "breakout"];
const SCENES = ["wave", "metaballs", "ticker", "media", "camera", "off"];
const DIM_DEFAULTS = { w: 24, h: 4, pitch: 2 };
recomputeDims();

function updateSpecLine() {
  const el = document.getElementById("spec-line"); if (!el) return;
  el.innerHTML = `24&prime;&times;4&prime; &middot; ${PANEL_COUNT} panels &middot; ${COLS}&times;${ROWS} &middot; 2&Prime; OC continuous &middot; ${N.toLocaleString()} buttons`;
}

// ---- colour helpers (LED colour drives emissive only, in linear space) ----
const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
// Official DotDev '26 palette (from dotdev.shopify.com brand tokens)
const PALETTE = ["#F5572D", "#FF8A1D", "#C9B2FF", "#8FD5F1", "#9BF1B0", "#057C09"]; // red amber lavender sky mint green
function linColor(hex) { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; }
const PAL_LIN = PALETTE.map(linColor);
// game accent colours, mapped onto the brand palette (keys kept stable for the game code)
const C = { white: linColor("#ffffff"), magenta: linColor("#F5572D"), purple: linColor("#C9B2FF"), cyan: linColor("#8FD5F1"), teal: linColor("#9BF1B0"), amber: linColor("#FF8A1D"), green: linColor("#057C09") };

// ============================================================================
// Renderer / scene / camera
// ============================================================================
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
// Render at the device pixel ratio (capped at 2) so the crisp edges — backing
// panel, frame, grid lines, dome edges and the scale figures — aren't pixelated
// on Retina / phone screens. Bloom stays at CSS resolution (see onResize), so
// the per-frame bloom hot path is unaffected and the extra cost stays bounded.
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// environment colours: the dark (non-plywood) backing is now dark green #031E1D
const ENV_GREEN = "#02100f";   // void behind a dark-green wall
const ENV_PLYWOOD = "#0a0a0a"; // neutral dark void for plywood backing
const scene = new THREE.Scene();
scene.background = new THREE.Color(ENV_GREEN);
scene.fog = new THREE.Fog(ENV_GREEN, 700, 2600);
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 6000);
camera.position.set(0, 18, 720);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0); controls.minDistance = 60; controls.maxDistance = 2400; controls.maxPolarAngle = Math.PI * 0.92;

scene.add(new THREE.AmbientLight(0xfff4e6, 0.42));
const key = new THREE.DirectionalLight(0xfff6ea, 0.95); key.position.set(320, 380, 520); scene.add(key);
const fill = new THREE.DirectionalLight(0x9fc6ff, 0.22); fill.position.set(-300, -120, 300); scene.add(fill);

// ---- birch plywood backing ----
function makePlywoodTexture() {
  const cw = 2048, ch = Math.round(cw * (PANEL_H / PANEL_W));
  const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
  const g = cv.getContext("2d");
  const base = g.createLinearGradient(0, 0, 0, ch);
  base.addColorStop(0, "#e4c79b"); base.addColorStop(0.5, "#d9b886"); base.addColorStop(1, "#cfa873");
  g.fillStyle = base; g.fillRect(0, 0, cw, ch);
  for (let i = 0; i < 1400; i++) {
    const y = Math.random() * ch, len = 120 + Math.random() * 900, x = Math.random() * cw, dark = Math.random() < 0.5;
    g.strokeStyle = dark ? `rgba(120,86,52,${0.04 + Math.random() * 0.10})` : `rgba(245,225,190,${0.03 + Math.random() * 0.08})`;
    g.lineWidth = 0.6 + Math.random() * 1.6; g.beginPath();
    const yy = y + (Math.random() - 0.5) * 6; g.moveTo(x, yy);
    g.bezierCurveTo(x + len * 0.33, yy + (Math.random() - 0.5) * 5, x + len * 0.66, yy + (Math.random() - 0.5) * 5, x + len, yy + (Math.random() - 0.5) * 7);
    g.stroke();
  }
  for (let i = 0; i < 10; i++) { const x = Math.random() * cw, y = Math.random() * ch, rr = 3 + Math.random() * 7; const rg = g.createRadialGradient(x, y, 0, x, y, rr); rg.addColorStop(0, "rgba(95,64,38,0.5)"); rg.addColorStop(1, "rgba(95,64,38,0)"); g.fillStyle = rg; g.beginPath(); g.arc(x, y, rr, 0, 7); g.fill(); }
  g.strokeStyle = "rgba(60,42,26,0.08)"; g.lineWidth = 1;
  for (let p = 1; p < PANEL_COUNT; p++) { const x = (p * PANEL_W_IN / PANEL_W) * cw; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ch); g.stroke(); }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}
const backingMat = new THREE.MeshStandardMaterial({ map: makePlywoodTexture(), roughness: 0.82, metalness: 0.0 });
const darkBackingMat = new THREE.MeshStandardMaterial({ color: 0x031e1d, roughness: 0.7, metalness: 0.0 });
// the wall (panels, frame, domes, hit cells, hover ring) is mounted 1 ft off the
// floor; the floor and the scale figures stay grounded
const WALL_RAISE = 12;            // 1 ft, in inches (world units)
const wallGroup = new THREE.Group(); wallGroup.position.y = WALL_RAISE; scene.add(wallGroup);
const backing = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), darkBackingMat); backing.position.z = -0.2; wallGroup.add(backing);
const frame = new THREE.Mesh(new THREE.BoxGeometry(PANEL_W + 4, PANEL_H + 4, 3), new THREE.MeshStandardMaterial({ color: 0x15191e, roughness: 0.5, metalness: 0.6 })); frame.position.z = -2.2; wallGroup.add(frame);
// panel seams — hairline references only; button spacing now carries across them.
const seamMat = new THREE.MeshStandardMaterial({ color: 0x031e1d, roughness: 0.8, metalness: 0.0, transparent: true, opacity: 0.35 });
for (let p = 1; p < PANEL_COUNT; p++) {
  const sx = p * PANEL_W_IN - WALL_W_IN / 2;
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.14, PANEL_H, 0.35), seamMat);
  seam.position.set(sx, 0, -0.24); scene.add(seam);
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 1600), new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1.0 })); floor.rotation.x = -Math.PI / 2; floor.position.set(0, -PANEL_H / 2 - 1, 300); scene.add(floor);

// ---- scale figures: a fresnel-shaded person standing at each end of the wall ----
// (units are inches; a ~5'9" figure beside the 4'-tall wall makes the scale obvious)
const fresnelMat = new THREE.ShaderMaterial({
  uniforms: { uBase: { value: new THREE.Color(0x12151a) }, uRim: { value: new THREE.Color(0xffffff) }, uPower: { value: 2.4 }, uStrength: { value: 0.5 } },
  vertexShader: `
    varying vec3 vN; varying vec3 vV;
    void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
  fragmentShader: `
    uniform vec3 uBase; uniform vec3 uRim; uniform float uPower; uniform float uStrength; varying vec3 vN; varying vec3 vV;
    void main(){ float f = pow(1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), uPower); gl_FragColor = vec4(mix(uBase, uRim, f * uStrength), 1.0); }`,
});
function makePerson() {
  const grp = new THREE.Group();
  const add = (geo, x, y, z, rz) => { const me = new THREE.Mesh(geo, fresnelMat); me.position.set(x, y, z); if (rz) me.rotation.z = rz; grp.add(me); };
  const legGeo = new THREE.CapsuleGeometry(3.4, 27, 6, 14);
  add(legGeo, -5, 17, 0); add(legGeo, 5, 17, 0);                       // legs (feet ~y=0)
  add(new THREE.CapsuleGeometry(7, 14, 8, 18), 0, 45, 0);              // torso
  const armGeo = new THREE.CapsuleGeometry(2.4, 22, 6, 12);
  add(armGeo, -8, 42, 0, -0.18); add(armGeo, 8, 42, 0, 0.18);         // arms (angled inward so the tops meet the shoulders)
  add(new THREE.CylinderGeometry(2.2, 2.4, 4, 12), 0, 58.5, 0);       // neck
  add(new THREE.SphereGeometry(5, 22, 18), 0, 64.5, 0);               // head  (total ~69")
  return grp;
}
// scale figures: true 5'10" people standing on the floor beside the wall (a
// 5'10" person is taller than the 4' wall, so the head sits above the top edge)
const PERSON_TOP_Y = 69.5;        // head crown in group-local inches (head centre 64.5 + r 5)
const PERSON_HEIGHT_IN = 70;      // 5'10"
const PERSON_SCALE = PERSON_HEIGHT_IN / PERSON_TOP_Y;   // model is ~69.5", so ~1.0
const FOOT_Y = -PANEL_H / 2 - 1, PERSON_X = PANEL_W / 2 + 24, PERSON_Z = 34;
const personL = makePerson(); personL.position.set(-PERSON_X, FOOT_Y, PERSON_Z); personL.rotation.y = 0.25; personL.scale.setScalar(PERSON_SCALE); scene.add(personL);
const personR = makePerson(); personR.position.set(PERSON_X, FOOT_Y, PERSON_Z); personR.rotation.y = -0.25; personR.scale.setScalar(PERSON_SCALE); scene.add(personR);

// ---- buttons (instanced domes, emissive-only LED colour) ----
const domeGeo = new THREE.SphereGeometry(R, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
domeGeo.rotateX(Math.PI / 2); domeGeo.scale(1, 1, DOME_H / R); domeGeo.translate(0, 0, 0.05);
const BOOST_BASE = 2.0;
const buttonMat = new THREE.MeshStandardMaterial({ color: 0x9c988d, roughness: 0.42, metalness: 0.0 });
buttonMat.userData.shader = null;
buttonMat.onBeforeCompile = (shader) => {
  shader.uniforms.uBoost = { value: BOOST_BASE };
  shader.fragmentShader = "uniform float uBoost;\n" + shader.fragmentShader
    .replace("#include <color_fragment>", "")
    .replace("vec3 totalEmissiveRadiance = emissive;", "vec3 totalEmissiveRadiance = emissive + vColor * uBoost;");
  buttonMat.userData.shader = shader;
};
const m = new THREE.Matrix4();
// invisible per-button hit material (full-pitch square cells tile the wall edge-to-edge,
// so every point picks its nearest button — no dead gaps, forgiving click/hover area)
const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
// Domes, hit cells and the LED / position / click buffers are (re)built by
// rebuildWall() so the wall size + spacing can change at runtime.
let buttons = null, hitMesh = null, led = new Float32Array(0), buttonPos = new Float32Array(0);
function setLed(i, c, s = 1) { led[i * 3] = c[0] * s; led[i * 3 + 1] = c[1] * s; led[i * 3 + 2] = c[2] * s; }
function buttonWorldXY(i) { return [buttonPos[i * 2], buttonPos[i * 2 + 1]]; }

// ---- hover outline (shows which button you're about to click) ----
const ring = new THREE.Mesh(
  new THREE.RingGeometry(R * 1.55, R * 2.1, 48),
  new THREE.MeshBasicMaterial({ color: 0x8fd5f1, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false, depthTest: false })
);
ring.renderOrder = 999; // draw on top so the outline is always visible
ring.position.z = DOME_H + 0.45; ring.visible = false; wallGroup.add(ring);

// ---- bloom ----
const composer = new EffectComposer(renderer);
// antialias:true on the renderer is a no-op once every frame goes through the
// (non-multisampled) bloom composer, so enable 4x MSAA on the composer's own
// render targets to kill the edge aliasing on the figures and wall.
composer.renderTarget1.samples = 4;
composer.renderTarget2.samples = 4;
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.7, 0.32);
composer.addPass(bloom); composer.addPass(new OutputPass());

// ============================================================================
// Shared state (synced through quick.db)
// ============================================================================
const state = {
  // base = the background scene; game = the optional overlay layer (or null).
  // The two are independent: a game now plays ON TOP of whatever scene is live.
  base: "wave", game: null, brightness: 2.0, bloom: 0.85, wood: true,
  dims: { w: 24, h: 4, pitch: 2 },
  ticker: { text: "DOTDEV · BUILD THE FUTURE OF COMMERCE", speed: 18, color: "#FF8A1D", size: 0.85, weight: 700, font: "Inter", dir: "left" },
  wave: { speed: 0.06, scale: 1.6 },
  metaballs: { speed: 1.0, count: 20, merge: 3.6, grid: false },
  media: null, clicks: [],
};
// default to a black backing (LEDs float on black); plywood is a toggle
state.wood = false;
let applyingRemote = false, saveTimer = null, settingsId = null;
const settingsCol = window.quick ? quick.db.collection("settings") : null;
const mediaCol = window.quick ? quick.db.collection("media") : null;

function scheduleSave() {
  if (applyingRemote || !settingsCol) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 250);
}
async function saveSettings() {
  if (!settingsCol) return;
  try {
    if (settingsId) await settingsCol.update(settingsId, state, { overwrite: true });
    else { const rec = await settingsCol.create({ ...state }); settingsId = rec.id; }
  } catch (e) { console.warn("saveSettings failed", e); }
}
async function initSync() {
  const syncEl = document.getElementById("sync-state");
  if (!settingsCol) { syncEl.textContent = "⚲ local only"; return; }
  try {
    const docs = await settingsCol.orderBy("created_at", "asc").limit(1).find();
    if (docs.length) { settingsId = docs[0].id; applyState(docs[0]); }
    else { const rec = await settingsCol.create({ ...state }); settingsId = rec.id; }
    try {
      settingsCol.subscribe({
        onConnect: () => { syncEl.textContent = "◉ live · shared"; syncEl.classList.add("live"); },
        onUpdate: (doc) => { if (doc.id === settingsId) applyState(doc); },
        onCreate: (doc) => { if (!settingsId) { settingsId = doc.id; applyState(doc); } },
        onError: (e) => console.warn("settings sub error", e),
      });
      syncEl.textContent = "◉ live · shared"; syncEl.classList.add("live");
    } catch (e) { console.warn("settings subscribe unavailable", e); syncEl.textContent = "saved"; }
  } catch (e) { console.warn("initSync failed", e); syncEl.textContent = "⚲ local"; }
}

function packClicks() { const out = []; for (let i = 0; i < N; i++) if (cycleArr[i] >= 0) out.push([i, cycleArr[i]]); return out.slice(0, 1200); }
function applyClicks(arr) { cycleArr.fill(-1); cycleCount = 0; if (Array.isArray(arr)) for (const [i, v] of arr) { if (i >= 0 && i < N) { cycleArr[i] = v; cycleCount++; } } }

function applyState(s) {
  applyingRemote = true;
  try {
    // wall geometry is fixed for this build (24' 3-panel DXF wall) — dims are not synced
    for (const k of ["wave", "metaballs"]) if (s[k]) Object.assign(state[k], s[k]);
    // migrate older docs where a game was stored in `base` (mutually-exclusive era)
    let nextBase = s.base, nextGame = ("game" in s) ? s.game : state.game;
    if (GAMES.includes(nextBase)) { nextGame = nextBase; nextBase = "off"; }
    if (nextBase && SCENES.includes(nextBase)) setBase(nextBase);
    setGame(GAMES.includes(nextGame) ? nextGame : null);
    if (typeof s.brightness === "number") setBrightness(s.brightness);
    if (typeof s.bloom === "number") setBloom(s.bloom);
    if (typeof s.wood === "boolean") setWood(s.wood);
    if (s.ticker) { Object.assign(state.ticker, s.ticker); syncTickerInputs(); buildTicker(); }
    syncSceneInputs();
    if (state.base === "metaballs" && (metaBalls.length !== Math.round(state.metaballs.count) || metaGridMode !== !!state.metaballs.grid)) initMetaballs();
    applyMedia(s.media || null);
  } finally { applyingRemote = false; }
}

// ============================================================================
// Patterns / ticker
// ============================================================================
function palLerp(t) { const n = PAL_LIN.length, f = (((t % 1) + 1) % 1) * n, i = Math.floor(f), fr = f - i; const a = PAL_LIN[i % n], b = PAL_LIN[(i + 1) % n]; return [a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr, a[2] + (b[2] - a[2]) * fr]; }
function gradLerp(arr, t) { t = clamp(t, 0, 0.9999); const f = t * (arr.length - 1), i = Math.floor(f), fr = f - i; const a = arr[i], b = arr[Math.min(i + 1, arr.length - 1)]; return [a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr, a[2] + (b[2] - a[2]) * fr]; }



// ---- metaballs (dynamic: balls roam + bounce off the walls, bond with gooey necks when near; one brand colour at a time, slowly cycling) ----
// Two movement modes: free (bounce off walls at any angle) and grid (glide along grid lines, turning at intersections -> orthogonal/diagonal formations).
const META_BALL_R = 2.8;                        // base disc radius in LED cells (big enough to read as a circle of dots)
const META_SP = 6;                              // grid spacing (cells) used by grid mode
let metaBalls = [], metaGridMode = false, metaNX = 0, metaNY = 0, metaOffX = 0, metaOffY = 0;
let metaCov = new Float32Array(0);
function metaNode(ix, iy) { return [metaOffX + ix * META_SP, metaOffY + iy * META_SP]; }
function metaNeighbors(ix, iy) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue; const nx = ix + dx, ny = iy + dy;
    if (nx >= 0 && nx < metaNX && ny >= 0 && ny < metaNY) out.push({ dx, dy, nx, ny });
  }
  return out;
}
function metaPickTarget(b) {
  const ns = metaNeighbors(b.ix, b.iy); if (!ns.length) return;
  const straight = ns.find(n => n.dx === b.dx && n.dy === b.dy);
  const pick = (straight && Math.random() < 0.68) ? straight : ns[(Math.random() * ns.length) | 0];
  b.dx = pick.dx; b.dy = pick.dy; b.tix = pick.nx; b.tiy = pick.ny;
  b.seg = META_SP * ((pick.dx && pick.dy) ? Math.SQRT2 : 1);
}
function initMetaballs() {
  const n = Math.max(2, Math.round(state.metaballs.count));
  metaGridMode = !!state.metaballs.grid;
  metaBalls = [];
  if (metaGridMode) {
    metaNX = Math.max(2, Math.floor((COLS - 1) / META_SP) + 1);
    metaNY = Math.max(2, Math.floor((ROWS - 1) / META_SP) + 1);
    metaOffX = (COLS - 1 - (metaNX - 1) * META_SP) / 2;
    metaOffY = (ROWS - 1 - (metaNY - 1) * META_SP) / 2;
    for (let i = 0; i < n; i++) {
      const ix = (Math.random() * metaNX) | 0, iy = (Math.random() * metaNY) | 0;
      const b = { ix, iy, tix: ix, tiy: iy, dx: 0, dy: 0, p: Math.random(), seg: META_SP, r: META_BALL_R };
      metaPickTarget(b); metaBalls.push(b);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const r = META_BALL_R * (0.85 + Math.random() * 0.35);
      const ang = Math.random() * Math.PI * 2, sp = 0.5 + Math.random() * 0.8;
      metaBalls.push({ x: r + Math.random() * (COLS - 1 - 2 * r), y: r + Math.random() * (ROWS - 1 - 2 * r), vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r });
    }
  }
}
function stepMetaballs(dt) {
  const sp = Math.max(0.1, state.metaballs.speed);
  if (metaGridMode) {
    const adv = sp * dt * 9;
    for (const b of metaBalls) {
      b.p += adv / b.seg;
      while (b.p >= 1) { b.p -= 1; b.ix = b.tix; b.iy = b.tiy; metaPickTarget(b); }
      const a = metaNode(b.ix, b.iy), t = metaNode(b.tix, b.tiy);
      b.x = a[0] + (t[0] - a[0]) * b.p; b.y = a[1] + (t[1] - a[1]) * b.p;
    }
  } else {
    const step = sp * dt * 10;
    for (const b of metaBalls) {
      b.x += b.vx * step; b.y += b.vy * step;
      const hiX = COLS - 1 - b.r, hiY = ROWS - 1 - b.r;
      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); } else if (b.x > hiX) { b.x = hiX; b.vx = -Math.abs(b.vx); }
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); } else if (b.y > hiY) { b.y = hiY; b.vy = -Math.abs(b.vy); }
    }
  }
}
function stampDisc(cx, cy, r, a) {
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(COLS - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(ROWS - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x - cx, y - cy), cov = clamp(r - d + 0.5, 0, 1) * a, i = y * COLS + x;
    if (cov > metaCov[i]) metaCov[i] = cov;
  }
}
function stampCapsule(x0c, y0c, x1c, y1c, w, a) {
  const minx = Math.max(0, Math.floor(Math.min(x0c, x1c) - w - 1)), maxx = Math.min(COLS - 1, Math.ceil(Math.max(x0c, x1c) + w + 1));
  const miny = Math.max(0, Math.floor(Math.min(y0c, y1c) - w - 1)), maxy = Math.min(ROWS - 1, Math.ceil(Math.max(y0c, y1c) + w + 1));
  const dx = x1c - x0c, dy = y1c - y0c, len2 = dx * dx + dy * dy || 1e-6;
  for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
    let tt = ((x - x0c) * dx + (y - y0c) * dy) / len2; tt = clamp(tt, 0, 1);
    const px = x0c + dx * tt, py = y0c + dy * tt, d = Math.hypot(x - px, y - py), cov = clamp(w - d + 0.5, 0, 1) * a, i = y * COLS + x;
    if (cov > metaCov[i]) metaCov[i] = cov;
  }
}
function drawMetaballs(time) {
  const sp = Math.max(0.1, state.metaballs.speed), merge = state.metaballs.merge;
  // current brand colour: hold one palette colour, then briefly crossfade to the next
  const n = PAL_LIN.length, period = 5 / sp, fc = time / period;
  const ci = ((Math.floor(fc) % n) + n) % n, frac = fc - Math.floor(fc), blend = frac < 0.82 ? 0 : (frac - 0.82) / 0.18;
  const a0 = PAL_LIN[ci], a1 = PAL_LIN[(ci + 1) % n];
  const cr = a0[0] + (a1[0] - a0[0]) * blend, cg = a0[1] + (a1[1] - a0[1]) * blend, cb = a0[2] + (a1[2] - a0[2]) * blend;
  metaCov.fill(0);
  for (const b of metaBalls) stampDisc(b.x, b.y, b.r, 1);
  // gooey neck between any two balls that are close enough — thickens as they near, vanishes as they part
  for (let i = 0; i < metaBalls.length; i++) for (let j = i + 1; j < metaBalls.length; j++) {
    const A = metaBalls[i], B = metaBalls[j], dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy), reach = A.r + B.r + merge;
    if (d < reach) { const t = 1 - d / reach, w = Math.min(A.r, B.r) * (0.3 + 0.55 * t); stampCapsule(A.x, A.y, B.x, B.y, w, 1); }
  }
  for (let i = 0; i < N; i++) { const c = metaCov[i]; led[i * 3] = cr * c; led[i * 3 + 1] = cg * c; led[i * 3 + 2] = cb * c; }
}

// ticker
let tickerCanvas = document.createElement("canvas"), tickerW = 0;
function buildTicker() {
  const h = ROWS, px = Math.max(6, Math.round(h * state.ticker.size));
  const fam = state.ticker.font || "Inter";
  const font = `${state.ticker.weight || 700} ${px}px "${fam}", system-ui, sans-serif`;
  let tmp = document.createElement("canvas"); let cx = tmp.getContext("2d"); cx.font = font;
  const text = (state.ticker.text || " ").replace(/\n+/g, "   ·   ");
  const w = Math.max(1, Math.ceil(cx.measureText(text).width) + 6);
  tmp.width = w; tmp.height = h; cx = tmp.getContext("2d");
  cx.font = font; cx.textAlign = "left"; cx.fillStyle = "#fff";
  // Vertically center the ACTUAL glyph ink box in the h-tall strip (robust for any
  // ROWS / font: "middle" baseline + a fudge drifted once the wall went to 16 rows).
  cx.textBaseline = "alphabetic";
  const m = cx.measureText(text);
  const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
  const baseline = (Number.isFinite(asc) && Number.isFinite(desc))
    ? (h - (asc + desc)) / 2 + asc
    : h / 2 + px * 0.35;
  cx.fillText(text, 3, baseline);
  tickerCanvas = tmp; tickerW = w;
}
const mediaCanvas = document.createElement("canvas"); mediaCanvas.width = COLS; mediaCanvas.height = ROWS;
const mediaCtx = mediaCanvas.getContext("2d", { willReadFrequently: true });
let tickerScroll = 0;
function sampleTicker(dt) {
  if (!tickerW) buildTicker();
  tickerScroll += state.ticker.speed * dt;
  const total = tickerW + COLS;
  if (tickerScroll > total) tickerScroll -= total;
  mediaCtx.clearRect(0, 0, COLS, ROWS);
  mediaCtx.fillStyle = "#000"; mediaCtx.fillRect(0, 0, COLS, ROWS);
  const off = state.ticker.dir === "right" ? (total - tickerScroll) : tickerScroll;
  mediaCtx.drawImage(tickerCanvas, -off, 0);
  mediaCtx.drawImage(tickerCanvas, -off + total, 0);
  const data = mediaCtx.getImageData(0, 0, COLS, ROWS).data;
  const [tr, tg, tb] = linColor(state.ticker.color);
  for (let i = 0; i < N; i++) { const a = data[i * 4] / 255; led[i * 3] = tr * a; led[i * 3 + 1] = tg * a; led[i * 3 + 2] = tb * a; }
}

// ============================================================================
// Games (overlay layers, interactive)
// ============================================================================
let g = null, gameAcc = 0;
const TICK = { life: 110, snake: 75, tetris: 60, fireworks: 33, breakout: 38 };
function startGame(kind) { gameAcc = 0; g = ({ life: newLife, snake: newSnake, tetris: newTetris, fireworks: newFireworks, breakout: newBreakout }[kind])(); }

// ---- 3-panel multiplayer scaffolding (snake / tetris / breakout) ----
// The wall is 3 hardware panels behind one continuous grid. Panel bands are
// computed from the physical seam positions, so this 134-column layout splits
// as 43 / 48 / 43 columns instead of pretending each panel is a separate tile.
const PLAYER_COL = [PAL_LIN[0], PAL_LIN[1], PAL_LIN[3], PAL_LIN[4], PAL_LIN[2]]; // red amber sky mint lavender
function panelOf(x) { for (let p = 0; p < PANELS; p++) if (x >= panelStart(p) && x <= panelEnd(p)) return p; return Math.min(PANELS - 1, Math.max(0, Math.round((x / Math.max(1, COLS - 1)) * (PANELS - 1)))); }
function drawPanelDividers(a) { for (let p = 1; p < PANELS; p++) { const x = panelStart(p) - 1; if (x < 0 || x >= COLS) continue; for (let y = 0; y < ROWS; y++) { const i = idx(x, y) * 3; led[i] += a; led[i + 1] += a; led[i + 2] += a; } } }

const LIFE_GRAD = [C.cyan, C.purple, C.magenta];
function seedLife(a) { a.fill(0); for (let i = 0; i < N; i++) if (Math.random() < 0.22) a[i] = 1; }
function newLife() { const cur = new Uint8Array(N), nxt = new Uint8Array(N), age = new Uint8Array(N); seedLife(cur); return { kind: "life", cur, nxt, age, stale: 0, lastPop: -1 }; }
function stepLife() {
  const { cur, nxt, age } = g; let pop = 0;
  for (let y = 0; y < ROWS; y++) { const yu = (y - 1 + ROWS) % ROWS, yd = (y + 1) % ROWS;
    for (let x = 0; x < COLS; x++) { const xl = (x - 1 + COLS) % COLS, xr = (x + 1) % COLS;
      const n = cur[yu * COLS + xl] + cur[yu * COLS + x] + cur[yu * COLS + xr] + cur[y * COLS + xl] + cur[y * COLS + xr] + cur[yd * COLS + xl] + cur[yd * COLS + x] + cur[yd * COLS + xr];
      const i = y * COLS + x, alive = cur[i] ? (n === 2 || n === 3) : (n === 3);
      nxt[i] = alive ? 1 : 0; if (alive) { pop++; age[i] = cur[i] ? Math.min(age[i] + 1, 30) : 0; } else age[i] = 0; } }
  g.cur = nxt; g.nxt = cur; g.stale = pop === g.lastPop ? g.stale + 1 : 0; g.lastPop = pop;
  if (pop < 8 || g.stale > 60) { seedLife(g.cur); g.age.fill(0); g.stale = 0; g.lastPop = -1; }
}
function drawLife() { const { cur, age } = g; for (let i = 0; i < N; i++) if (cur[i]) setLed(i, gradLerp(LIFE_GRAD, Math.min(age[i], 18) / 18), 0.9); }

function nearestFood(head, foods) { let best = null, bd = 1e9; for (const f of foods) { const d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y); if (d < bd) { bd = d; best = f; } } return best; }
// one snake per panel — 3 independent boards, each AI plays inside its column band
function randEmptyP(p, body) { const x0 = panelStart(p), w = panelWidth(p); let x, y, bad, t = 0; do { x = x0 + ((Math.random() * w) | 0); y = (Math.random() * ROWS) | 0; bad = body.some(s => s.x === x && s.y === y); } while (bad && ++t < 60); return { x, y }; }
function newSnakeOne(p) { const cx = panelCenter(p), cy = ROWS >> 1, body = []; for (let k = 0; k < 5; k++) body.push({ x: Math.max(panelStart(p), cx - k), y: cy }); const s = { p, body, dir: { x: 1, y: 0 }, foods: [] }; s.foods = [randEmptyP(p, body)]; return s; }
function newSnake() { const players = []; for (let p = 0; p < PANELS; p++) players.push(newSnakeOne(p)); return { kind: "snake", players }; }
function snakeSafeP(p, body, nx, ny) { const x0 = panelStart(p), x1 = panelEnd(p); if (nx < x0 || nx > x1 || ny < 0 || ny >= ROWS) return false; for (let k = 0; k < body.length - 1; k++) if (body[k].x === nx && body[k].y === ny) return false; return true; }
function stepSnakeOne(s) {
  const body = s.body, head = body[0];
  if (!s.foods.length) s.foods.push(randEmptyP(s.p, body));
  const target = nearestFood(head, s.foods) || head;
  const opts = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }].filter(d => !(d.x === -s.dir.x && d.y === -s.dir.y));
  opts.sort((a, b) => (Math.abs(head.x + a.x - target.x) + Math.abs(head.y + a.y - target.y)) - (Math.abs(head.x + b.x - target.x) + Math.abs(head.y + b.y - target.y)));
  let chosen = null; for (const d of opts) if (snakeSafeP(s.p, body, head.x + d.x, head.y + d.y)) { chosen = d; break; }
  if (!chosen) return newSnakeOne(s.p);
  s.dir = chosen; const nh = { x: head.x + chosen.x, y: head.y + chosen.y }; body.unshift(nh);
  const fi = s.foods.findIndex(f => f.x === nh.x && f.y === nh.y);
  if (fi >= 0) s.foods.splice(fi, 1); else body.pop();
  return s;
}
function stepSnake() { for (let p = 0; p < g.players.length; p++) g.players[p] = stepSnakeOne(g.players[p]); }
function drawSnake(time) {
  drawPanelDividers(0.05);
  for (let p = 0; p < g.players.length; p++) {
    const s = g.players[p], pc = PLAYER_COL[p], body = s.body;
    for (const f of s.foods) setLed(idx(f.x, f.y), C.white, 0.5 + 0.4 * Math.sin(time * 6 + p));
    for (let k = 0; k < body.length; k++) { const c = body[k]; setLed(idx(c.x, c.y), pc, k === 0 ? 1 : 1 - 0.5 * (k / body.length)); }
  }
}

// Fireworks: rockets rise and burst into falling brand-coloured sparks
function newFireworks() { return { kind: "fireworks", rockets: [], sparks: [], t: 0, next: 0 }; }
function launchRocket(col) { g.rockets.push({ x: clamp(col ?? (2 + Math.random() * (COLS - 4)), 1, COLS - 2), y: ROWS - 1, vy: -(0.7 + Math.random() * 0.35), top: 1 + Math.random() * 5, col: (Math.random() * PAL_LIN.length) | 0 }); }
// burst a shell of sparks centred at (x,y) — shared by auto-bursts and touch
function burstFireworks(x, y, col) {
  col = col == null ? (Math.random() * PAL_LIN.length) | 0 : col;
  const n = 16 + (Math.random() * 14 | 0), spd = 0.5 + Math.random() * 0.45;
  for (let s = 0; s < n; s++) { const a = (s / n) * Math.PI * 2; g.sparks.push({ x, y, vx: Math.cos(a) * spd * (0.6 + Math.random() * 0.6), vy: Math.sin(a) * spd * (0.6 + Math.random() * 0.6), life: 1, col }); }
}
function stepFireworks() {
  g.t += 1;
  if (g.t >= g.next) { g.next = g.t + 8 + (Math.random() * 18 | 0); launchRocket(); }
  for (let k = g.rockets.length - 1; k >= 0; k--) {
    const r = g.rockets[k]; r.y += r.vy; r.vy += 0.012;
    if (r.y <= r.top || r.vy >= 0) {
      burstFireworks(r.x, r.y, r.col);
      g.rockets.splice(k, 1);
    }
  }
  for (let k = g.sparks.length - 1; k >= 0; k--) {
    const s = g.sparks[k]; s.x += s.vx; s.y += s.vy; s.vy += 0.03; s.vx *= 0.96; s.life -= 0.03;
    if (s.life <= 0 || s.y > ROWS) g.sparks.splice(k, 1);
  }
  if (g.sparks.length > 900) g.sparks.splice(0, g.sparks.length - 900);
}
function drawFireworks() {
  for (const r of g.rockets) { const x = clamp(Math.round(r.x), 0, COLS - 1), y = clamp(Math.round(r.y), 0, ROWS - 1); setLed(idx(x, y), C.white, 1); }
  for (const s of g.sparks) { const x = Math.round(s.x), y = Math.round(s.y); if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue; const c = PAL_LIN[s.col]; const a = Math.max(0, s.life); const i = idx(x, y); led[i * 3] += c[0] * a; led[i * 3 + 1] += c[1] * a; led[i * 3 + 2] += c[2] * a; }
}

// ONE shared brick field across the whole wall, but 3 paddles + 3 balls (one per
// panel) so up to three people defend their own band of a common board.
const PADW = 4; // paddle half-width (paddle spans 2*PADW+1 = 9 cells)
function newBall(p) { const cx = panelCenter(p); return { p, x: cx, y: ROWS - 4, vx: (Math.random() < 0.5 ? -1 : 1) * (0.32 + Math.random() * 0.26), vy: -0.6 }; }
function newBreakout() {
  const bricks = new Uint8Array(N); let count = 0;
  for (let y = 1; y <= 3; y++) for (let x = 0; x < COLS; x++) { bricks[idx(x, y)] = 1 + ((y - 1) % 4); count++; }
  const balls = [], paddles = [];
  for (let p = 0; p < PANELS; p++) { paddles.push({ p, x: panelCenter(p) }); balls.push(newBall(p)); }
  return { kind: "breakout", bricks, count, balls, paddles };
}
function stepBreakout() {
  for (const pad of g.paddles) {
    const x0 = panelStart(pad.p), x1 = panelEnd(pad.p);
    let tgt = null, low = -1;
    for (const b of g.balls) if (b.x >= x0 && b.x <= x1 && b.vy > 0 && b.y > low) { low = b.y; tgt = b; }
    if (!tgt) tgt = g.balls[pad.p];
    const want = clamp(tgt.x, x0 + PADW, x1 - PADW);
    pad.x = clamp(pad.x + clamp(want - pad.x, -0.9, 0.9), x0 + PADW, x1 - PADW);
  }
  for (const b of g.balls) {
    b.x += b.vx; b.y += b.vy;
    if (b.x < 0) { b.x = -b.x; b.vx = -b.vx; } if (b.x > COLS - 1) { b.x = 2 * (COLS - 1) - b.x; b.vx = -b.vx; } if (b.y < 0) { b.y = -b.y; b.vy = -b.vy; }
    const cx = clamp(Math.round(b.x), 0, COLS - 1), cy = Math.round(b.y);
    if (cy >= 0 && cy <= ROWS - 2) { const bi = idx(cx, cy); if (g.bricks[bi]) { g.bricks[bi] = 0; g.count--; b.vy = -b.vy; } }
    if (b.y >= ROWS - 2) {
      let caught = false;
      for (const pad of g.paddles) if (Math.abs(b.x - pad.x) <= PADW + 0.6) { b.y = ROWS - 2; b.vy = -Math.abs(b.vy); b.vx += (b.x - pad.x) * 0.08; caught = true; break; }
      if (!caught && b.y > ROWS - 1) Object.assign(b, newBall(b.p));
    }
    b.vx = clamp(b.vx, -0.85, 0.85);
  }
  if (g.count <= 0) g = newBreakout();
}
function drawBreakout() {
  const rowCol = [C.magenta, C.amber, C.cyan, C.purple];
  for (let y = 0; y <= ROWS - 2; y++) for (let x = 0; x < COLS; x++) { const v = g.bricks[idx(x, y)]; if (v) setLed(idx(x, y), rowCol[(v - 1) % 4], 0.9); }
  for (const pad of g.paddles) { const px = Math.round(pad.x), pc = PLAYER_COL[pad.p]; for (let d = -PADW; d <= PADW; d++) setLed(idx(clamp(px + d, 0, COLS - 1), ROWS - 1), pc, 1); }
  for (const b of g.balls) setLed(idx(clamp(Math.round(b.x), 0, COLS - 1), clamp(Math.round(b.y), 0, ROWS - 1)), C.white, 1);
}

// ---- Tetris: 3 independent wells (one per panel), each auto-played ----
// WELL_W is recomputed per-dimensions in recomputeDims(); wellX() centers each well in its panel band.
const TET = {
  I: { c: 3, st: [[[0,1],[1,1],[2,1],[3,1]], [[2,0],[2,1],[2,2],[2,3]]] },
  O: { c: 1, st: [[[1,0],[2,0],[1,1],[2,1]]] },
  T: { c: 2, st: [[[1,0],[0,1],[1,1],[2,1]], [[1,0],[1,1],[2,1],[1,2]], [[0,1],[1,1],[2,1],[1,2]], [[1,0],[0,1],[1,1],[1,2]]] },
  S: { c: 4, st: [[[1,0],[2,0],[0,1],[1,1]], [[1,0],[1,1],[2,1],[2,2]]] },
  Z: { c: 0, st: [[[0,0],[1,0],[1,1],[2,1]], [[2,0],[1,1],[2,1],[1,2]]] },
  J: { c: 3, st: [[[0,0],[0,1],[1,1],[2,1]], [[1,0],[2,0],[1,1],[1,2]], [[0,1],[1,1],[2,1],[2,2]], [[1,0],[1,1],[0,2],[1,2]]] },
  L: { c: 1, st: [[[2,0],[0,1],[1,1],[2,1]], [[1,0],[1,1],[1,2],[2,2]], [[0,1],[1,1],[2,1],[0,2]], [[0,0],[1,0],[1,1],[1,2]]] },
};
const TET_KEYS = Object.keys(TET);
const TET_COL = [PAL_LIN[0], PAL_LIN[1], PAL_LIN[2], PAL_LIN[3], PAL_LIN[4]];
function tetCells(key, rot) { const st = TET[key].st; return st[((rot % st.length) + st.length) % st.length]; }
function tetFits(grid, key, rot, ox, oy) { for (const [cx, cy] of tetCells(key, rot)) { const x = ox + cx, y = oy + cy; if (x < 0 || x >= WELL_W || y >= ROWS) return false; if (y >= 0 && grid[y * WELL_W + x]) return false; } return true; }
function tetDrop(grid, key, rot, ox) { let y = -3; if (!tetFits(grid, key, rot, ox, y)) return null; while (tetFits(grid, key, rot, ox, y + 1)) y++; return y; }
function tetColHeights(grid) { const h = new Array(WELL_W).fill(0); for (let x = 0; x < WELL_W; x++) for (let y = 0; y < ROWS; y++) if (grid[y * WELL_W + x]) { h[x] = ROWS - y; break; } return h; }
function tetScore(grid) {
  let agg = 0, holes = 0, bump = 0, lines = 0;
  const h = tetColHeights(grid);
  for (let x = 0; x < WELL_W; x++) { agg += h[x]; let seen = false; for (let y = 0; y < ROWS; y++) { if (grid[y * WELL_W + x]) seen = true; else if (seen) holes++; } }
  for (let x = 0; x < WELL_W - 1; x++) bump += Math.abs(h[x] - h[x + 1]);
  for (let y = 0; y < ROWS; y++) { let full = true; for (let x = 0; x < WELL_W; x++) if (!grid[y * WELL_W + x]) { full = false; break; } if (full) lines++; }
  return 0.9 * lines - 0.51 * agg - 0.66 * holes - 0.22 * bump;
}
function tetBestPlan(grid, key) {
  let best = null, bestScore = -1e9;
  const rots = TET[key].st.length;
  for (let rot = 0; rot < rots; rot++) for (let ox = -1; ox < WELL_W; ox++) {
    const oy = tetDrop(grid, key, rot, ox); if (oy == null) continue;
    const tmp = grid.slice(); for (const [cx, cy] of tetCells(key, rot)) { const y = oy + cy; if (y >= 0) tmp[y * WELL_W + ox + cx] = 1; }
    const sc = tetScore(tmp) + Math.random() * 0.01;
    if (sc > bestScore) { bestScore = sc; best = { rot, ox }; }
  }
  return best;
}
function tetSpawn(w) {
  const key = TET_KEYS[(Math.random() * TET_KEYS.length) | 0];
  const minCy = Math.min(...tetCells(key, 0).map(c => c[1]));
  const piece = { key, rot: 0, x: ((WELL_W - 4) >> 1), y: -minCy };
  if (!tetFits(w.grid, key, 0, piece.x, piece.y)) { w.grid.fill(0); }
  w.piece = piece; w.plan = tetBestPlan(w.grid, key) || { rot: 0, ox: piece.x };
}
function newWell(p) { const w = { p, grid: new Uint8Array(WELL_W * ROWS), piece: null, plan: null }; tetSpawn(w); return w; }
function newTetris() { const wells = []; for (let p = 0; p < PANELS; p++) wells.push(newWell(p)); return { kind: "tetris", wells }; }
function tetClear(grid) { for (let y = ROWS - 1; y >= 0; ) { let full = true; for (let x = 0; x < WELL_W; x++) if (!grid[y * WELL_W + x]) { full = false; break; } if (full) { for (let yy = y; yy > 0; yy--) for (let x = 0; x < WELL_W; x++) grid[yy * WELL_W + x] = grid[(yy - 1) * WELL_W + x]; for (let x = 0; x < WELL_W; x++) grid[x] = 0; } else y--; } }
function tetLock(w) { const v = TET[w.piece.key].c + 1; for (const [cx, cy] of tetCells(w.piece.key, w.piece.rot)) { const y = w.piece.y + cy; if (y >= 0) w.grid[y * WELL_W + w.piece.x + cx] = v; } tetClear(w.grid); tetSpawn(w); }
function stepWell(w) {
  const pc = w.piece, plan = w.plan;
  if (pc.rot !== plan.rot && tetFits(w.grid, pc.key, plan.rot, pc.x, pc.y)) { pc.rot = plan.rot; return; }
  if (pc.x < plan.ox && tetFits(w.grid, pc.key, pc.rot, pc.x + 1, pc.y)) { pc.x++; return; }
  if (pc.x > plan.ox && tetFits(w.grid, pc.key, pc.rot, pc.x - 1, pc.y)) { pc.x--; return; }
  if (tetFits(w.grid, pc.key, pc.rot, pc.x, pc.y + 1)) { pc.y++; return; }
  tetLock(w);
}
function stepTetris() { for (const w of g.wells) stepWell(w); }
function drawTetris() {
  drawPanelDividers(0.05);
  for (const w of g.wells) {
    const bx = panelStart(w.p) + wellX(w.p);
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < WELL_W; x++) { const v = w.grid[y * WELL_W + x]; if (v) setLed(idx(bx + x, y), TET_COL[(v - 1) % TET_COL.length], 0.92); }
    const pcCol = TET_COL[TET[w.piece.key].c % TET_COL.length];
    for (const [cx, cy] of tetCells(w.piece.key, w.piece.rot)) { const y = w.piece.y + cy; if (y >= 0) setLed(idx(bx + w.piece.x + cx, y), pcCol, 1); }
  }
}

function stepGame() { ({ life: stepLife, snake: stepSnake, tetris: stepTetris, fireworks: stepFireworks, breakout: stepBreakout }[g.kind])(); }
function drawGame(time) { ({ life: drawLife, snake: drawSnake, tetris: drawTetris, fireworks: drawFireworks, breakout: drawBreakout }[g.kind])(time); }
// interactive: pressing a button during a game (a tap/click stands in for a
// hardware button press). Every game now reacts visibly at the touched cell.
function gameInteract(i) {
  if (!g) return;
  const x = i % COLS, y = (i / COLS) | 0;
  if (g.kind === "snake") {
    // drop food at the press for that panel's snake to chase
    const p = panelOf(x); g.players[p].foods.push({ x, y });
  } else if (g.kind === "life") {
    // seed a little cluster of live cells (a single toggle was too subtle)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (Math.random() < 0.7) { const j = idx((x + dx + COLS) % COLS, (y + dy + ROWS) % ROWS); g.cur[j] = 1; g.age[j] = 0; }
    }
  } else if (g.kind === "fireworks") {
    // burst a firework right where you touched
    burstFireworks(x, y);
  } else if (g.kind === "breakout") {
    // launch a fresh ball from the press, heading up into the bricks
    if (g.balls.length < 14) g.balls.push({ p: panelOf(x), x, y: clamp(y, 1, ROWS - 2), vx: (Math.random() < 0.5 ? -1 : 1) * (0.32 + Math.random() * 0.26), vy: -0.6 });
  } else if (g.kind === "tetris") {
    // hard-drop the active piece in the pressed panel's well
    const w = g.wells[panelOf(x)];
    if (w && w.piece) { while (tetFits(w.grid, w.piece.key, w.piece.rot, w.piece.x, w.piece.y + 1)) w.piece.y++; tetLock(w); }
  }
}

// ---- click colour cycle (when no game is active) ----
let cycleArr = new Int8Array(0); let cycleCount = 0;
function cycleClick(i) { if (cycleArr[i] === -1) cycleCount++; let v = cycleArr[i] + 1; if (v >= PALETTE.length) v = 0; cycleArr[i] = v; scheduleWallSave(); }
function clearClicks() { resetWall(); }

// ---- multiplayer button state (persisted + synced via a quick.db `wall` doc) ----
const wallCol = window.quick ? quick.db.collection("wall") : null;
let wallId = null, wallGen = 0, wallTimer = null, wallDirty = false;
const OFFCH = ".";
function encodeWall() { let s = ""; for (let i = 0; i < N; i++) s += cycleArr[i] < 0 ? OFFCH : String(cycleArr[i]); return s; }
function recountCycle() { cycleCount = 0; for (let i = 0; i < N; i++) if (cycleArr[i] >= 0) cycleCount++; }
// full = wipe-then-apply (used for first load + reset); otherwise additive merge (lit cells win, '.' ignored)
function applyWallString(str, full) {
  if (typeof str !== "string" || str.length !== N) return; // ignore docs from a different wall size
  if (full) cycleArr.fill(-1);
  for (let i = 0; i < N; i++) { const ch = str[i]; if (ch !== OFFCH) { const v = ch.charCodeAt(0) - 48; if (v >= 0 && v < PALETTE.length) cycleArr[i] = v; } }
  recountCycle();
}
function applyWallDoc(doc) { if (!doc) return; const g = doc.gen || 0; if (g > wallGen) { wallGen = g; applyWallString(doc.cells || "", true); } else applyWallString(doc.cells || "", false); }
function scheduleWallSave() { if (!wallCol) return; wallDirty = true; clearTimeout(wallTimer); wallTimer = setTimeout(saveWall, 160); }
async function saveWall() {
  if (!wallCol || !wallDirty) return; wallDirty = false;
  const payload = { cells: encodeWall(), gen: wallGen };
  try { if (wallId) await wallCol.update(wallId, payload, { overwrite: true }); else { const r = await wallCol.create(payload); wallId = r.id; } }
  catch (e) { console.warn("saveWall failed", e); }
}
async function resetWall() {
  cycleArr.fill(-1); cycleCount = 0; wallGen++;
  if (!wallCol) return;
  const payload = { cells: encodeWall(), gen: wallGen };
  try { if (wallId) await wallCol.update(wallId, payload, { overwrite: true }); else { const r = await wallCol.create(payload); wallId = r.id; } }
  catch (e) { console.warn("resetWall failed", e); }
}
async function initWall() {
  if (!wallCol) return;
  try {
    const docs = await wallCol.orderBy("created_at", "asc").limit(1).find();
    if (docs.length) { wallId = docs[0].id; wallGen = docs[0].gen || 0; applyWallString(docs[0].cells || "", true); }
    else { const r = await wallCol.create({ cells: encodeWall(), gen: wallGen }); wallId = r.id; }
    try { wallCol.subscribe({ onUpdate: (d) => { if (d.id === wallId) applyWallDoc(d); }, onCreate: (d) => { if (!wallId) { wallId = d.id; applyWallDoc(d); } }, onError: () => {} }); }
    catch (e) { console.warn("wall subscribe unavailable", e); }
  } catch (e) { console.warn("initWall failed", e); }
}

// ---- master render ----
function renderContent(time, dt) {
  const base = state.base;
  // 1) draw the background scene into `led`
  if (base === "media") sampleMedia();
  else if (base === "camera") sampleCamera();
  else if (base === "ticker") sampleTicker(dt);
  else if (base === "metaballs") { stepMetaballs(dt); drawMetaballs(time); }
  else if (base === "wave") { const sp = time * state.wave.speed; const sc = state.wave.scale; for (let i = 0; i < N; i++) { const t = (buttonPos[i * 2] / WALL_W_IN) * sc + (buttonPos[i * 2 + 1] / WALL_H_IN) * 0.35 + sp; const col = palLerp(t), pulse = 0.55 + 0.45 * Math.sin(t * Math.PI * 2 + 1.7); led[i * 3] = col[0] * pulse; led[i * 3 + 1] = col[1] * pulse; led[i * 3 + 2] = col[2] * pulse; } }
  else led.fill(0); // "off" (or unknown)

  // 2) clicked-colour overlay — only when no game owns the wall input
  if (cycleCount > 0 && !state.game) for (let i = 0; i < N; i++) if (cycleArr[i] >= 0) { const c = PAL_LIN[cycleArr[i]]; led[i * 3] = c[0]; led[i * 3 + 1] = c[1]; led[i * 3 + 2] = c[2]; }

  // 3) game overlay, composited ON TOP of the scene
  if (state.game && g) {
    gameAcc += dt * 1000; let steps = 0; const tick = TICK[state.game] || 60;
    while (gameAcc >= tick && steps < 5) { stepGame(); gameAcc -= tick; steps++; }
    drawGame(time);
  }

  buttons.instanceColor.needsUpdate = true;
}

// ============================================================================
// Media + gallery
// ============================================================================
let videoEl = null, imageEl = null, mediaKind = null, fitMode = "cover", currentMediaUrl = null;
let galleryItems = [];
const ppBtn = document.getElementById("media-playpause");
const PAUSE_SVG = '<svg viewBox="0 0 16 16"><rect x="4.5" y="3" width="2.5" height="10" fill="currentColor" stroke="none"/><rect x="9" y="3" width="2.5" height="10" fill="currentColor" stroke="none"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 16 16"><path d="M5 3l8 5-8 5z" fill="currentColor" stroke="none"/></svg>';
const mediaNameEl = () => null;
function setMediaName(t) { /* shown in gallery; dock keeps compact */ }

function clearMediaEls() { if (videoEl) { videoEl.pause(); videoEl.src = ""; videoEl.load?.(); videoEl = null; } imageEl = null; mediaKind = null; }
function sourceRect(sw, sh) { const tarAR = COLS / ROWS, srcAR = sw / sh; if (fitMode === "stretch") return [0, 0, sw, sh]; if (fitMode === "cover") { if (srcAR > tarAR) { const w = sh * tarAR; return [(sw - w) / 2, 0, w, sh]; } const h = sw / tarAR; return [0, (sh - h) / 2, sw, h]; } if (srcAR > tarAR) { const h = sw / tarAR; return [0, (sh - h) / 2, sw, h]; } const w = sh * tarAR; return [(sw - w) / 2, 0, w, sh]; }
function sampleMedia() {
  let src = null, sw = 0, sh = 0;
  if (mediaKind === "video" && videoEl && videoEl.readyState >= 2) { src = videoEl; sw = videoEl.videoWidth; sh = videoEl.videoHeight; }
  else if (mediaKind === "image" && imageEl) { src = imageEl; sw = imageEl.naturalWidth; sh = imageEl.naturalHeight; }
  if (!src || !sw) { led.fill(0); return; }
  mediaCtx.clearRect(0, 0, COLS, ROWS);
  if (fitMode !== "stretch") { mediaCtx.fillStyle = "#000"; mediaCtx.fillRect(0, 0, COLS, ROWS); }
  if (fitMode === "contain") { const tarAR = COLS / ROWS, srcAR = sw / sh; let dw = COLS, dh = ROWS; if (srcAR > tarAR) dh = COLS / srcAR; else dw = ROWS * srcAR; mediaCtx.drawImage(src, 0, 0, sw, sh, (COLS - dw) / 2, (ROWS - dh) / 2, dw, dh); }
  else { const [rx, ry, rw, rh] = sourceRect(sw, sh); mediaCtx.drawImage(src, rx, ry, rw, rh, 0, 0, COLS, ROWS); }
  const data = mediaCtx.getImageData(0, 0, COLS, ROWS).data;
  for (let i = 0; i < N; i++) { const p = i * 4; led[i * 3] = SRGB_TO_LIN[data[p]]; led[i * 3 + 1] = SRGB_TO_LIN[data[p + 1]]; led[i * 3 + 2] = SRGB_TO_LIN[data[p + 2]]; }
}
const PLACEHOLDER = { url: "/placeholder.png", mtype: "image", name: "DotDev demo" };
function playMedia(url, type, name) {
  clearMediaEls();
  currentMediaUrl = url;
  if (type === "video") { const v = document.createElement("video"); v.src = url; v.loop = true; v.muted = true; v.playsInline = true; v.crossOrigin = "anonymous"; v.play().catch(() => {}); videoEl = v; mediaKind = "video"; ppBtn.disabled = false; ppBtn.innerHTML = PAUSE_SVG; }
  else { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => { imageEl = img; }; img.src = url; mediaKind = "image"; ppBtn.disabled = true; }
  state.media = { url, mtype: type, name };
  renderGallery();
}
function loadMediaItem(url, type, name) { playMedia(url, type, name); setBase("media"); scheduleSave(); }
function applyMedia(mediaObj) {
  if (!mediaObj) { if (state.media || currentMediaUrl) { state.media = null; if (state.base === "media") setBase("wave"); clearMediaEls(); currentMediaUrl = null; renderGallery(); } return; }
  if (mediaObj.url !== currentMediaUrl) { playMedia(mediaObj.url, mediaObj.mtype, mediaObj.name); }
  else { state.media = mediaObj; }
}
async function handleUpload(file) {
  if (!file) return;
  const type = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : null;
  if (!type) return;
  const objUrl = URL.createObjectURL(file);
  loadMediaItem(objUrl, type, file.name);
  scheduleSave();
  if (!mediaCol) return;
  try {
    const up = await quick.fs.uploadFile(file, { strategy: "hybrid" });
    const order = galleryItems.length ? Math.max(...galleryItems.map(i => i.order)) + 1 : 0;
    const rec = await mediaCol.create({ url: up.url, name: file.name, mtype: type, order });
    // swap the live media to the persistent URL so reloads/other viewers can play it
    state.media = { url: up.url, mtype: type, name: file.name }; currentMediaUrl = up.url; scheduleSave();
    await loadGallery();
  } catch (e) { console.warn("upload failed", e); }
}
async function loadGallery() { if (!mediaCol) { renderGallery(); return; } try { galleryItems = await mediaCol.orderBy("order", "asc").find(); } catch (e) { console.warn(e); galleryItems = []; } renderGallery(); }
const galleryGrid = document.getElementById("gallery-grid"), galleryEmpty = document.getElementById("gallery-empty");
function renderGallery() {
  galleryItems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  galleryGrid.innerHTML = "";
  if (galleryEmpty) galleryEmpty.style.display = galleryItems.length ? "none" : "";
  galleryItems.forEach((it, i) => {
    const card = document.createElement("div"); card.className = "gcard" + (state.media && state.media.url === it.url ? " playing" : "");
    const thumb = document.createElement("div"); thumb.className = "thumb";
    if (it.mtype === "video") { const v = document.createElement("video"); v.src = it.url; v.muted = true; v.preload = "metadata"; v.playsInline = true; thumb.appendChild(v); }
    else { const im = document.createElement("img"); im.src = it.url; thumb.appendChild(im); }
    thumb.title = "Load on the wall";
    thumb.addEventListener("click", () => loadMediaItem(it.url, it.mtype, it.name));
    const nm = document.createElement("span"); nm.className = "gname"; nm.textContent = it.name || it.mtype; nm.title = it.name || "";
    const ctrls = document.createElement("div"); ctrls.className = "gctrls";
    ctrls.append(
      mkIcon("↑", "Move up", () => reorder(i, -1)),
      mkIcon("↓", "Move down", () => reorder(i, 1)),
      mkIcon("✕", "Delete", () => delMedia(it), "del")
    );
    card.append(thumb, nm, ctrls); galleryGrid.appendChild(card);
  });
}
function mkIcon(txt, title, fn, cls = "") { const b = document.createElement("button"); b.className = "gicon " + cls; b.textContent = txt; b.title = title; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); return b; }
async function reorder(i, dir) {
  const j = i + dir; if (j < 0 || j >= galleryItems.length) return;
  const a = galleryItems[i], b = galleryItems[j]; const ao = a.order ?? i, bo = b.order ?? j; a.order = bo; b.order = ao;
  renderGallery();
  if (mediaCol) { try { await mediaCol.update([{ id: a.id, order: a.order }, { id: b.id, order: b.order }]); } catch (e) { console.warn(e); } }
}
async function delMedia(it) {
  galleryItems = galleryItems.filter(x => x.id !== it.id); renderGallery();
  if (mediaCol) { try { await mediaCol.delete(it.id); } catch (e) { console.warn(e); } }
}
function subscribeGallery() { if (!mediaCol) return; try { mediaCol.subscribe({ onCreate: loadGallery, onUpdate: loadGallery, onDelete: loadGallery, onError: () => {} }); } catch (e) { console.warn("gallery subscribe unavailable", e); } }

// ============================================================================
// Camera scene — each viewer's webcam is downsampled to low-res colour data
// (one panel wide x full height), written to quick.db, and composited across the 3 panels.
// Only the colour data is shared, never the raw video feed.
// ============================================================================
const SID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
const camCol = window.quick ? quick.db.collection("cameras") : null;
// CAM_W / CAM_H recomputed in recomputeDims() (one panel wide x full height)
const camSampleCanvas = document.createElement("canvas"); camSampleCanvas.width = CAM_W; camSampleCanvas.height = CAM_H;
const camCtx = camSampleCanvas.getContext("2d", { willReadFrequently: true });
const camMap = Object.create(null); // key -> { bytes:Uint8Array(CAM_W*CAM_H*3), at }
let camStream = null, camVideo = null, camOn = false, camTimer = null, camDocId = null;
function b64encode(bytes) { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function b64decode(str) { const bin = atob(str); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function setCamStatus(t) { const e = document.getElementById("cam-status"); if (e) e.textContent = t; }
function updateCamToggle() { const b = document.getElementById("cam-toggle"); if (!b) return; b.classList.toggle("active", camOn); const l = b.querySelector(".lbl"); if (l) l.textContent = camOn ? "Disable camera" : "Enable camera"; }
async function enableCam() {
  if (camOn) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setCamStatus("camera unsupported"); return; }
  try { camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 160, height: 120, facingMode: "user" }, audio: false }); }
  catch (e) { setCamStatus("camera blocked"); return; }
  camVideo = document.createElement("video"); camVideo.srcObject = camStream; camVideo.muted = true; camVideo.playsInline = true;
  try { await camVideo.play(); } catch (e) {}
  camOn = true; setCamStatus("camera on · sharing"); updateCamToggle();
  camTimer = setInterval(sampleAndSendCam, 160);
}
function disableCam() {
  if (!camOn && !camStream) return;
  camOn = false;
  if (camTimer) { clearInterval(camTimer); camTimer = null; }
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  camVideo = null; delete camMap[SID];
  if (camCol && camDocId) { camCol.delete(camDocId).catch(() => {}); camDocId = null; }
  setCamStatus("camera off"); updateCamToggle();
}
function sampleAndSendCam() {
  if (!camVideo || camVideo.readyState < 2) return;
  const vw = camVideo.videoWidth, vh = camVideo.videoHeight; if (!vw) return;
  const tarAR = CAM_W / CAM_H, srcAR = vw / vh; let sx, sy, sw2, sh2;
  if (srcAR > tarAR) { sh2 = vh; sw2 = vh * tarAR; sx = (vw - sw2) / 2; sy = 0; } else { sw2 = vw; sh2 = vw / tarAR; sx = 0; sy = (vh - sh2) / 2; }
  camCtx.save(); camCtx.translate(CAM_W, 0); camCtx.scale(-1, 1); // mirror (selfie)
  camCtx.drawImage(camVideo, sx, sy, sw2, sh2, 0, 0, CAM_W, CAM_H); camCtx.restore();
  const d = camCtx.getImageData(0, 0, CAM_W, CAM_H).data;
  const bytes = new Uint8Array(CAM_W * CAM_H * 3);
  for (let i = 0, j = 0; i < CAM_W * CAM_H; i++) { bytes[j++] = d[i * 4]; bytes[j++] = d[i * 4 + 1]; bytes[j++] = d[i * 4 + 2]; }
  camMap[SID] = { bytes, at: Date.now() };
  if (!camCol) return;
  const cells = b64encode(bytes);
  if (camDocId && camDocId !== "pending") camCol.update(camDocId, { cells }).catch(() => {});
  else if (!camDocId) { camDocId = "pending"; camCol.create({ sid: SID, cells }).then(r => { camDocId = r.id; }).catch(() => { camDocId = null; }); }
}
function ingestCam(doc) {
  if (!doc || !doc.cells) return;
  if (doc.sid === SID) { if (doc.id) camDocId = doc.id; return; } // my own echo; I render from local bytes
  try { camMap[doc.id] = { bytes: b64decode(doc.cells), at: Date.now() }; } catch (e) {}
}
function subscribeCameras() {
  if (!camCol) return;
  camCol.find().then(docs => { for (const d of docs) ingestCam(d); }).catch(() => {});
  try { camCol.subscribe({ onCreate: ingestCam, onUpdate: ingestCam, onDelete: (id) => { delete camMap[id]; }, onError: () => {} }); }
  catch (e) { console.warn("camera subscribe unavailable", e); }
}
function sampleCamera() {
  led.fill(0);
  const now = Date.now();
  const active = [];
  for (const k in camMap) { const c = camMap[k]; if (c && c.bytes && now - c.at < 6000) active.push(c); }
  if (!active.length) return;
  for (let p = 0; p < PANELS; p++) {
    const cam = active[p % active.length], b = cam.bytes, x0 = panelStart(p), w = panelWidth(p);
    for (let y = 0; y < ROWS; y++) for (let cx = 0; cx < w; cx++) {
      const sx = Math.min(CAM_W - 1, Math.floor((cx / Math.max(1, w)) * CAM_W));
      const x = x0 + cx; if (x >= COLS) continue;
      const s = (y * CAM_W + sx) * 3, i = idx(x, y);
      led[i * 3] = SRGB_TO_LIN[b[s]]; led[i * 3 + 1] = SRGB_TO_LIN[b[s + 1]]; led[i * 3 + 2] = SRGB_TO_LIN[b[s + 2]];
    }
  }
}
document.getElementById("cam-toggle").addEventListener("click", () => { if (camOn) disableCam(); else enableCam(); });
window.addEventListener("beforeunload", () => { if (camCol && camDocId && camDocId !== "pending") camCol.delete(camDocId).catch(() => {}); });

// ============================================================================
// Pointer: orbit on drag, hover = outline only, click/tap = game / colour cycle
// ============================================================================
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downPos = null, downTime = 0, dragging = false;
function pickInstance(cx, cy) { ndc.x = (cx / window.innerWidth) * 2 - 1; ndc.y = -(cy / window.innerHeight) * 2 + 1; raycaster.setFromCamera(ndc, camera); const hit = raycaster.intersectObject(hitMesh, false)[0]; return hit ? hit.instanceId : -1; }
let lastHover = -1;
function paintAction(i) {
  // a live game owns the wall input; otherwise clicks cycle the dot colour
  if (state.game) gameInteract(i);
  else cycleClick(i);
}
canvas.addEventListener("pointerdown", (e) => {
  downPos = { x: e.clientX, y: e.clientY }; dragging = false;
});
canvas.addEventListener("pointermove", (e) => {
  const pressed = e.buttons !== 0;
  if (pressed && downPos) { const dx = e.clientX - downPos.x, dy = e.clientY - downPos.y; if (dx * dx + dy * dy > 16) dragging = true; }
  if (pressed) { ring.visible = false; lastHover = -1; return; } // pressing = orbit; hide the outline
  // hover only: outline the button under the cursor so you can see what you'll click (no painting)
  const i = pickInstance(e.clientX, e.clientY);
  if (i >= 0) { const [x, y] = buttonWorldXY(i); ring.position.set(x, y, DOME_H + 0.45); ring.visible = true; lastHover = i; }
  else { ring.visible = false; lastHover = -1; }
});
canvas.addEventListener("pointerleave", () => { ring.visible = false; lastHover = -1; });
canvas.addEventListener("pointerup", (e) => {
  // a click/tap (not a drag-orbit) is what actually presses the button
  if (!dragging) { const i = pickInstance(e.clientX, e.clientY); if (i >= 0) paintAction(i); }
  downPos = null; dragging = false;
});
canvas.addEventListener("pointercancel", () => { downPos = null; dragging = false; });

// ============================================================================
// UI wiring + setters (each setter updates state + UI; scheduleSave broadcasts)
// ============================================================================
// scene = the background layer (wave / metaballs / ticker / media / camera / off)
function setBase(b) {
  if (!SCENES.includes(b)) return;
  state.base = b;
  document.querySelectorAll("[data-base]").forEach(el => el.classList.toggle("active", el.dataset.base === b));
  if (b === "ticker") buildTicker();
  if (b === "metaballs" && !metaBalls.length) initMetaballs();
  if (b === "media" && !mediaKind) playMedia(PLACEHOLDER.url, PLACEHOLDER.mtype, PLACEHOLDER.name);
  if (b === "media") { if (videoEl) videoEl.play().catch(() => {}); }
  else if (videoEl) videoEl.pause();
  if (b !== "camera") disableCam();
  updateSettingsPanel();
  scheduleSave();
}
// game = the optional overlay layer; null turns it off. Plays ON TOP of the scene.
function setGame(name) {
  const next = GAMES.includes(name) ? name : null;
  state.game = next;
  if (next) { if (!g || g.kind !== next) startGame(next); } else { g = null; }
  document.querySelectorAll("[data-game]").forEach(el => el.classList.toggle("active", el.dataset.game === next));
  updateHint();
  scheduleSave();
}
function updateHint() {
  const el = document.getElementById("hint-inline"); if (!el) return;
  el.textContent = state.game
    ? `click a button = play ${state.game} · drag = orbit · scroll = zoom`
    : "click a button = cycle dotdev colour · drag = orbit · scroll = zoom";
}
function setBrightness(v) { state.brightness = v; const sl = document.getElementById("brightness"); if (sl.value != v) sl.value = v; if (buttonMat.userData.shader) buttonMat.userData.shader.uniforms.uBoost.value = v; scheduleSave(); }
function setBloom(v) { state.bloom = v; const sl = document.getElementById("bloom"); if (sl.value != v) sl.value = v; bloom.strength = v; scheduleSave(); }
function setWood(on) { state.wood = on; backing.material = on ? backingMat : darkBackingMat; const env = on ? ENV_PLYWOOD : ENV_GREEN; scene.background.set(env); scene.fog.color.set(env); const b = document.getElementById("toggle-wood"); b.classList.toggle("active", on); const l = b.querySelector(".lbl"); if (l) l.textContent = on ? "Plywood" : "Green"; b.title = on ? "Plywood backing (click for dark green)" : "Dark green backing (click for plywood)"; scheduleSave(); }

document.querySelectorAll("[data-base]").forEach(el => el.addEventListener("click", () => setBase(el.dataset.base)));
// game chips toggle the overlay on/off (click the active one again to stop)
document.querySelectorAll("[data-game]").forEach(el => el.addEventListener("click", () => setGame(state.game === el.dataset.game ? null : el.dataset.game)));

document.getElementById("clear-clicks").addEventListener("click", clearClicks);
document.getElementById("load-media").addEventListener("click", () => document.getElementById("file-input").click());
document.getElementById("file-input").addEventListener("change", (e) => { if (e.target.files[0]) handleUpload(e.target.files[0]); });
document.getElementById("media-fit").addEventListener("change", (e) => { fitMode = e.target.value; });
ppBtn.addEventListener("click", () => { if (!videoEl) return; if (videoEl.paused) { videoEl.play(); ppBtn.innerHTML = PAUSE_SVG; } else { videoEl.pause(); ppBtn.innerHTML = PLAY_SVG; } });

let currentView = "angle";
function fitCamera(spherical) {
  currentView = spherical;
  const halfH = PANEL_H / 2, halfW = PANEL_W / 2, vFov = THREE.MathUtils.degToRad(camera.fov);
  const dist = Math.max(halfH / Math.tan(vFov / 2), halfW / (Math.tan(vFov / 2) * camera.aspect)) * 1.12;
  controls.target.set(0, 0, 0);
  if (spherical === "angle") { const az = THREE.MathUtils.degToRad(-26), el = THREE.MathUtils.degToRad(13); camera.position.set(Math.sin(az) * Math.cos(el) * dist * 1.05, Math.sin(el) * dist * 1.05, Math.cos(az) * Math.cos(el) * dist * 1.05); }
  else camera.position.set(0, 0, dist);
  controls.update();
  frameView();
}
document.getElementById("view-front").addEventListener("click", () => fitCamera("front"));
document.getElementById("view-angle").addEventListener("click", () => fitCamera("angle"));
document.getElementById("toggle-wood").addEventListener("click", () => setWood(!state.wood));
document.getElementById("brightness").addEventListener("input", (e) => setBrightness(parseFloat(e.target.value)));
document.getElementById("bloom").addEventListener("input", (e) => setBloom(parseFloat(e.target.value)));
// ---- bottom panel: collapse via grip; all sections laid out at once ----
const panelEl = document.getElementById("panel");
const gripEl = document.getElementById("grip");
gripEl.addEventListener("click", () => { panelEl.classList.toggle("collapsed"); requestAnimationFrame(frameView); scheduleSavePrefs(); });
panelEl.addEventListener("transitionend", (e) => { if (e.propertyName === "height" || e.propertyName === "max-height") frameView(); });

// ---- per-viewer view prefs: orbit camera + drawer open/close, remembered in quick.db ----
// Intentionally per-viewer (keyed by a stable browser id), NOT part of the shared
// `settings` doc: orbiting your camera or collapsing your panel shouldn't move
// everyone else's view. Restored on load; saved (debounced) on change.
const prefsCol = window.quick ? quick.db.collection("viewprefs") : null;
let prefsId = null, prefsTimer = null, prefsLoaded = false, applyingPrefs = false;
function viewerId() {
  let id = null;
  try { id = localStorage.getItem("dotdev-viewer-id"); } catch (e) {}
  if (!id) { id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : "v" + Date.now() + Math.random().toString(36).slice(2); try { localStorage.setItem("dotdev-viewer-id", id); } catch (e) {} }
  return id;
}
const VIEWER = viewerId();
function camSnapshot() { return { pos: [camera.position.x, camera.position.y, camera.position.z], target: [controls.target.x, controls.target.y, controls.target.z], view: currentView }; }
function scheduleSavePrefs() {
  if (applyingPrefs || !prefsLoaded || !prefsCol) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(savePrefs, 500);
}
async function savePrefs() {
  if (!prefsCol) return;
  const payload = { viewer: VIEWER, cam: camSnapshot(), collapsed: panelEl.classList.contains("collapsed") };
  try {
    if (prefsId) await prefsCol.update(prefsId, payload, { overwrite: true });
    else { const r = await prefsCol.create(payload); prefsId = r.id; }
  } catch (e) { console.warn("savePrefs failed", e); }
}
function applyPrefs(p) {
  applyingPrefs = true;
  try {
    if (typeof p.collapsed === "boolean") panelEl.classList.toggle("collapsed", p.collapsed);
    if (p.cam && Array.isArray(p.cam.pos) && Array.isArray(p.cam.target)) {
      camera.position.set(p.cam.pos[0], p.cam.pos[1], p.cam.pos[2]);
      controls.target.set(p.cam.target[0], p.cam.target[1], p.cam.target[2]);
      if (typeof p.cam.view === "string") currentView = p.cam.view;
      controls.update();
    }
  } finally { applyingPrefs = false; }
  requestAnimationFrame(frameView);
}
async function initPrefs() {
  if (!prefsCol) { prefsLoaded = true; return; }
  try {
    const docs = await prefsCol.where({ viewer: VIEWER }).orderBy("created_at", "desc").limit(1).find();
    if (docs.length) { prefsId = docs[0].id; applyPrefs(docs[0]); }
  } catch (e) { console.warn("initPrefs failed", e); }
  prefsLoaded = true;
}
// orbit/zoom/pan + the Front/Angle view buttons all move the camera, which fires
// OrbitControls 'change'; one debounced hook captures every settled camera pose.
controls.addEventListener("change", scheduleSavePrefs);

// ---- inline mode-settings (inside the Scenes section) ----
const spanelTicker = document.getElementById("spanel-ticker");
const spanelMedia = document.getElementById("spanel-media");
const spanelCamera = document.getElementById("spanel-camera");
const spanelWave = document.getElementById("spanel-wave");
const spanelMetaballs = document.getElementById("spanel-metaballs");
// per-scene setting sliders -> live state
function wireRange(id, set) { const el = document.getElementById(id); if (el) el.addEventListener("input", () => { set(parseFloat(el.value)); scheduleSave(); }); }
wireRange("wave-speed", v => state.wave.speed = v); wireRange("wave-scale", v => state.wave.scale = v);
wireRange("meta-speed", v => state.metaballs.speed = v); wireRange("meta-count", v => { state.metaballs.count = v; initMetaballs(); }); wireRange("meta-merge", v => state.metaballs.merge = v);
const metaGridBtn = document.getElementById("meta-grid");
function syncMetaGrid() { if (!metaGridBtn) return; const on = !!state.metaballs.grid; metaGridBtn.classList.toggle("active", on); const l = metaGridBtn.querySelector(".lbl"); if (l) l.textContent = on ? "Grid" : "Free"; metaGridBtn.title = on ? "Moving along grid lines (click for free roam)" : "Free roam / bounce (click to move along grid lines)"; }
if (metaGridBtn) metaGridBtn.addEventListener("click", () => { state.metaballs.grid = !state.metaballs.grid; syncMetaGrid(); initMetaballs(); scheduleSave(); });
function setRange(id, v) { const el = document.getElementById(id); if (el && v != null) el.value = v; }
function syncSceneInputs() {
  setRange("wave-speed", state.wave.speed); setRange("wave-scale", state.wave.scale);
  setRange("meta-speed", state.metaballs.speed); setRange("meta-count", state.metaballs.count); setRange("meta-merge", state.metaballs.merge); syncMetaGrid();
}
const MODES_WITH_SETTINGS = { wave: spanelWave, metaballs: spanelMetaballs, ticker: spanelTicker, media: spanelMedia, camera: spanelCamera };
function updateSettingsPanel() {
  for (const m in MODES_WITH_SETTINGS) { const sub = MODES_WITH_SETTINGS[m]; if (sub) sub.hidden = state.base !== m; }
}

const tickerTextEl = document.getElementById("ticker-text"), tickerSpeedEl = document.getElementById("ticker-speed"), tickerSizeEl = document.getElementById("ticker-size"), tickerWeightEl = document.getElementById("ticker-weight"), tickerFontEl = document.getElementById("ticker-font"), tickerDirEl = document.getElementById("ticker-dir"), tickerSpeedVal = document.getElementById("ticker-speed-val");
function ensureTickerFont() { const px = Math.max(6, Math.round(ROWS * state.ticker.size)); const f = `${state.ticker.weight || 700} ${px}px "${state.ticker.font || "Inter"}"`; if (document.fonts && document.fonts.load) document.fonts.load(f).then(buildTicker).catch(buildTicker); else buildTicker(); }
function syncTickerInputs() { tickerTextEl.value = state.ticker.text; tickerSpeedEl.value = state.ticker.speed; tickerSpeedVal.textContent = state.ticker.speed; tickerSizeEl.value = String(state.ticker.size); tickerWeightEl.value = String(state.ticker.weight || 700); if (tickerFontEl) tickerFontEl.value = state.ticker.font || "Inter"; if (tickerDirEl) tickerDirEl.value = state.ticker.dir || "left"; document.querySelectorAll(".tsw").forEach(s => s.classList.toggle("active", s.dataset.color === state.ticker.color)); }
tickerTextEl.addEventListener("input", () => { state.ticker.text = tickerTextEl.value; buildTicker(); scheduleSave(); });
tickerSpeedEl.addEventListener("input", () => { state.ticker.speed = parseInt(tickerSpeedEl.value, 10); tickerSpeedVal.textContent = tickerSpeedEl.value; scheduleSave(); });
tickerSizeEl.addEventListener("change", () => { state.ticker.size = parseFloat(tickerSizeEl.value); ensureTickerFont(); scheduleSave(); });
tickerWeightEl.addEventListener("change", () => { state.ticker.weight = parseInt(tickerWeightEl.value, 10); ensureTickerFont(); scheduleSave(); });
if (tickerFontEl) tickerFontEl.addEventListener("change", () => { state.ticker.font = tickerFontEl.value; ensureTickerFont(); scheduleSave(); });
if (tickerDirEl) tickerDirEl.addEventListener("change", () => { state.ticker.dir = tickerDirEl.value; scheduleSave(); });
const tickerSwatches = document.getElementById("ticker-swatches");
["#ffffff", ...PALETTE].forEach(hex => { const s = document.createElement("button"); s.className = "tsw"; s.style.background = hex; s.dataset.color = hex; s.title = hex; s.addEventListener("click", () => { state.ticker.color = hex; syncTickerInputs(); scheduleSave(); }); tickerSwatches.appendChild(s); });

// ---- drag + drop ----
const dropzone = document.getElementById("dropzone"); let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); dragDepth++; dropzone.classList.add("show"); } });
window.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropzone.classList.remove("show"); });
window.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; dropzone.classList.remove("show"); const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("video/") || f.type.startsWith("image/")); if (f) handleUpload(f); });

// ============================================================================
// Raw output frame  +  external preview window.
// Per the vendor protocol (§4) this is exactly the PIXEL_FRAME we'd push to the
// wall: RGBA8, row-major from top-left, W*H*4 bytes. We light-correct (apply the
// same brightness boost the wall renders with, then linear->sRGB, clamp to 8-bit)
// so the preview matches what the buttons actually emit.
// ============================================================================
const outCanvas = document.createElement("canvas"); outCanvas.width = COLS; outCanvas.height = ROWS;
const outCtx = outCanvas.getContext("2d");
let outImg = outCtx.createImageData(COLS, ROWS);
// FRAME_BYTES (0x10 tag + RGBA8 payload) / MASK_BYTES (0x02 tag + bitmask) recomputed in recomputeDims()
function lin2srgb255(l) { l = l < 0 ? 0 : l > 1 ? 1 : l; const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055; return (s * 255 + 0.5) | 0; }
function buildOutputFrame() {
  const boost = state.brightness, d = outImg.data;
  for (let i = 0; i < N; i++) { const p = i * 4, q = i * 3; d[p] = lin2srgb255(led[q] * boost); d[p + 1] = lin2srgb255(led[q + 1] * boost); d[p + 2] = lin2srgb255(led[q + 2] * boost); d[p + 3] = 255; }
  outCtx.putImageData(outImg, 0, 0);
}

let previewWin = null, previewCanvas = null, previewHud = null;
const previewBtn = () => document.getElementById("open-preview");
function closePreviewRefs() { previewWin = null; previewCanvas = null; previewHud = null; const b = previewBtn(); if (b) b.classList.remove("active"); }
function openPreview() {
  if (previewWin && !previewWin.closed) { previewWin.focus(); return; }
  const win = window.open("", "wall-output-preview", "width=840,height=110");
  if (!win) { alert("Popup blocked — allow popups for this site, then click Output again."); return; }
  previewWin = win;
  win.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wall output · raw PIXEL_FRAME</title><style>html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:"JetBrains Mono",ui-monospace,monospace}#px{display:block;width:100vw;height:100vh;image-rendering:pixelated}#hud{position:fixed;left:9px;bottom:7px;font-size:10px;letter-spacing:.05em;color:#9bf1b0;mix-blend-mode:difference;pointer-events:none;white-space:nowrap}#dz{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(5,124,9,.22);border:2px dashed #9bf1b0;color:#9bf1b0;font-size:14px;letter-spacing:.12em;text-transform:uppercase}#dz.show{display:flex}</style></head><body><canvas id="px"></canvas><div id="hud"></div><div id="dz">drop image / video onto the wall</div></body></html>`);
  win.document.close();
  previewCanvas = win.document.getElementById("px");
  previewHud = win.document.getElementById("hud");
  const dz = win.document.getElementById("dz");
  const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  // Drops on the preview drive the MAIN wall (same handler as the main window).
  win.addEventListener("dragenter", (e) => { if (isFiles(e)) { e.preventDefault(); dz.classList.add("show"); } });
  win.addEventListener("dragover", (e) => { if (isFiles(e)) e.preventDefault(); });
  win.addEventListener("dragleave", (e) => { if (!e.relatedTarget) dz.classList.remove("show"); });
  win.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("show"); const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith("video/") || x.type.startsWith("image/")); if (f) handleUpload(f); });
  win.addEventListener("pagehide", closePreviewRefs);
  const b = previewBtn(); if (b) b.classList.add("active");
  pumpPreview();
}
// Driven from the main render loop: copies the latest output frame into the popup,
// stretched to fill the window (re-fills on resize, raw/pixelated). The preview is
// as live as the sim — keep both windows visible side-by-side for smooth updates.
function pumpPreview() {
  if (!previewWin) return;
  if (previewWin.closed) { closePreviewRefs(); return; }
  buildOutputFrame();
  const cv = previewCanvas; if (!cv) return;
  const w = Math.max(1, previewWin.innerWidth | 0), h = Math.max(1, previewWin.innerHeight | 0);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d"); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(outCanvas, 0, 0, COLS, ROWS, 0, 0, w, h);
  if (previewHud) previewHud.textContent = `RAW OUTPUT · ${COLS}×${ROWS} · PIXEL_FRAME ${FRAME_BYTES.toLocaleString()} B · ≤30 Hz`;
}

// ---- protocol schematic overlay ----
const schematicEl = document.getElementById("schematic");
function openSchematic() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("sch-geom", `${COLS}×${ROWS}`);
  set("sch-cols", COLS); set("sch-rows", ROWS); set("sch-n", N.toLocaleString());
  set("sch-frame", `${FRAME_BYTES.toLocaleString()} B`);
  set("sch-mask", `${MASK_BYTES.toLocaleString()} B`);
  if (schematicEl) { schematicEl.hidden = false; }
}
function closeSchematic() { if (schematicEl) schematicEl.hidden = true; }
if (schematicEl) {
  document.getElementById("open-preview")?.addEventListener("click", openPreview);
  document.getElementById("open-schematic")?.addEventListener("click", openSchematic);
  document.getElementById("sch-close")?.addEventListener("click", closeSchematic);
  schematicEl.addEventListener("click", (e) => { if (e.target === schematicEl) closeSchematic(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !schematicEl.hidden) closeSchematic(); });
}

// ---- wall builder: (re)build domes + hit cells + buffers for the current dims ----
function rebuildWall() {
  if (buttons) { wallGroup.remove(buttons); buttons.dispose(); }
  if (hitMesh) { wallGroup.remove(hitMesh); hitMesh.geometry.dispose(); hitMesh.dispose(); }
  led = new Float32Array(N * 3);
  buttonPos = new Float32Array(N * 2);
  cycleArr = new Int8Array(N).fill(-1); cycleCount = 0;
  metaCov = new Float32Array(N); metaBalls = [];
  // domes (LED colour lives in instanceColor = led)
  buttons = new THREE.InstancedMesh(domeGeo, buttonMat, N);
  buttons.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  buttons.instanceColor = new THREE.InstancedBufferAttribute(led, 3);
  buttons.instanceColor.setUsage(THREE.DynamicDrawUsage);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c, [x, y] = buttonXY(c, r);
    buttonPos[i * 2] = x; buttonPos[i * 2 + 1] = y; m.makeTranslation(x, y, 0); buttons.setMatrixAt(i, m);
  }
  buttons.instanceMatrix.needsUpdate = true; wallGroup.add(buttons);
  // full-pitch hit cells (shared hitMat; geometry depends on spacing so it's rebuilt)
  hitMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(PITCH, PITCH), hitMat, N);
  for (let i = 0; i < N; i++) { m.makeTranslation(buttonPos[i * 2], buttonPos[i * 2 + 1], DOME_H + 0.4); hitMesh.setMatrixAt(i, m); }
  hitMesh.instanceMatrix.needsUpdate = true; wallGroup.add(hitMesh);
  // resize the physical props + reposition the scale figures
  backing.geometry.dispose(); backing.geometry = new THREE.PlaneGeometry(PANEL_W, PANEL_H);
  frame.geometry.dispose(); frame.geometry = new THREE.BoxGeometry(PANEL_W + 4, PANEL_H + 4, 3);
  floor.position.y = -PANEL_H / 2 - 1;
  const footY = -PANEL_H / 2 - 1, px = PANEL_W / 2 + 24;
  personL.position.set(-px, footY, 34); personL.scale.setScalar(PERSON_SCALE); personR.position.set(px, footY, 34); personR.scale.setScalar(PERSON_SCALE);
  // resize sampling / output canvases
  mediaCanvas.width = COLS; mediaCanvas.height = ROWS;
  camSampleCanvas.width = CAM_W; camSampleCanvas.height = CAM_H;
  outCanvas.width = COLS; outCanvas.height = ROWS; outImg = outCtx.createImageData(COLS, ROWS);
  // re-seed dimension-sized content
  if (state.base === "metaballs") initMetaballs();
  if (state.game) startGame(state.game);
  lastHover = -1; ring.visible = false;
  updateSpecLine();
}

// ---- wall size ----
// The wall is a fixed 24' 3-panel continuous-grid build (see recomputeDims), so
// there are no live size controls; the Display section shows a static spec readout.
function syncDimInputs() { /* no editable size inputs in this build */ }

// ---- resize + loop ----
// keep the wall framed in the space ABOVE the bottom UI cluster (so UI never covers it)
function frameView() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  // lift the wall into the space above the bottom panel so the UI never covers it
  const ph = panelEl ? panelEl.offsetHeight : 0;
  if (ph > 4) camera.setViewOffset(w, h, 0, ph / 2, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
function onResize() { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h); composer.setSize(w, h); bloom.setSize(w, h); frameView(); }
window.addEventListener("resize", onResize);

const clock = new THREE.Clock(); let lastT = 0, frames = 0, fpsT = 0;
const fpsEl = document.getElementById("fps");
function animate() { requestAnimationFrame(animate); const t = clock.getElapsedTime(), dt = Math.min(t - lastT, 0.1); lastT = t; controls.update(); renderContent(t, dt); composer.render(); pumpPreview(); frames++; const now = performance.now(); if (now - fpsT > 1000) { fpsEl.textContent = `${frames} fps`; frames = 0; fpsT = now; } }

// ---- boot ----
syncTickerInputs();
{ const b = document.getElementById("toggle-wood"); b.classList.toggle("active", state.wood); const l = b.querySelector(".lbl"); if (l) l.textContent = state.wood ? "Plywood" : "Green"; b.title = state.wood ? "Plywood backing (click for dark green)" : "Dark green backing (click for plywood)"; }
if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildTicker);
buildTicker();
syncDimInputs();
rebuildWall();
fitCamera("angle");
updateSettingsPanel();
updateHint();
animate();
// Keep the loader up until the initial quick.db settings + camera prefs are
// fetched and applied, so the wall appears in its final layout with no shift.
const hideLoader = () => document.getElementById("loading").classList.add("hide");
initSync().then(initPrefs).finally(hideLoader);
setTimeout(hideLoader, 4000); // safety: never stay stuck on the loader if the DB stalls
loadGallery();
subscribeGallery();
initWall();
subscribeCameras();
