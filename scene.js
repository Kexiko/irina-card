/* ============================================================
   3D-сцена первого экрана: iPhone Duo в глубине
   Один цикл рендера, старт — только после загрузки модели.
   ============================================================ */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const mount = document.getElementById("scene");

/* ---------- Рендерер ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
// на телефонах 3× пиксели слишком тяжело — ограничиваем 2×
// телефон: 2× вместо 3× — почти вдвое меньше пикселей на кадр
const isPhone = () => window.innerWidth < 900;

// «замороженные» размеры вьюпорта: адресная строка на телефоне меняет
// innerHeight во время прокрутки, из-за этого раскладка дёргалась
let VW = window.innerWidth;
let VH = window.innerHeight;
window.addEventListener("resize", () => {
  const w = window.innerWidth, h = window.innerHeight;
  if (Math.abs(w - VW) > 2) { VW = w; VH = h; }            // реальный ресайз/поворот
  else if (Math.abs(h - VH) > 140) { VH = h; }             // сильное изменение высоты
}, { passive: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isPhone() ? 2 : 3));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.style.display = "block";
mount.appendChild(renderer.domElement);

const scene = new THREE.Scene();

/* ---------- Камера ---------- */
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
camera.position.set(0, 0, 5.6);
camera.lookAt(-0.75, 0.15, 0);

/* ---------- Освещение ---------- */
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
pmrem.dispose();

const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
key.position.set(3, 4, 5);
scene.add(key);

const rim = new THREE.DirectionalLight(0xdfe6ff, 1.1);
rim.position.set(-4, 2, -3);
scene.add(rim);

const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(-2, -3, 4);
scene.add(fill);

scene.add(new THREE.AmbientLight(0xfff6ea, 0.35));

/* ---------- Контейнер модели ---------- */
const rig = new THREE.Group();
scene.add(rig);
let modelRef = null;

let ready = false;
let rightHalf = null;
let hingePivot = null;
let halfB = null;
let innerScreenPane = null;
let texRef = null;
let resumeCanvas = null;    // длинная страница, нарисованная кодом
let screenCanvas = null;    // окно, которое видно на экране
let screenTex = null;
let resumeProgress = 0;
let screenTexScale = 2;
let openUnitW = 0;      // ширина раскрытого телефона при scale = 1
let resumeDirty = false;   // экран нужно перерисовать
let pageTex = null;        // длинная текстура страницы резюме

// видимая область экрана (в единицах холста 1024×1463)
const VIS_X = Math.round(1024 * 0.10);
const VIS_Y = Math.round(1463 * 0.10);
const VIS_W = Math.round(1024 * 0.80);
const VIS_H = Math.round(1463 * 0.86);

// UV-окно внутреннего экрана модели
const UV_U0 = 0.114, UV_U1 = 0.903;
const UV_V0 = 0.075, UV_V1 = 0.861;
let lastResumeShift = -1e9;   // чтобы первый кадр всегда отрисовался
let pageQr = [];        // положение QR на странице (единицы страницы)
let qrZones = [];       // то же в координатах экранного холста
let screenMesh = null;  // меш внутреннего экрана
let foldBone = null;      // кость, которой складывается телефон
let foldRest = null;      // её исходный поворот (раскрытое состояние)
let openProg = 0;
let t = 0;
let targetX = 0, targetY = 0, curX = 0, curY = 0;

/* ---------- ЕДИНАЯ раскладка для ПК и телефона ----------
   Телефон не «ставится на глаз»: его размер и положение считаются
   от реального размера фигуры на экране. Поэтому композиция одинаковая
   на любом устройстве — на ПК просто остаётся воздух по краям.
   ------------------------------------------------------- */
const STAGE = {
  phoneOfPerson: 1.20,   // высота телефона = 120% относительно прежнего (было 1.0)
  overlap:       0.14,   // угол телефона заходит за фигуру
  personLeft:    0.22,   // левый край силуэта (плечо)
  cy:            0.50,   // вертикальный центр телефона (доля высоты экрана)
  zoom:          6.0,
};

// Реальные габариты с учётом скелета.
// Box3.setFromObject берёт статичную геометрию и врёт для скиннинга,
// поэтому считаем по вершинам с применением костей.
let boxCacheKey = null;
let boxCacheLocal = null;
let foldKeyNow = 0;

// габариты в системе координат rig — кэшируются по позе
function localBox() {
  if (boxCacheKey === foldKeyNow && boxCacheLocal) return boxCacheLocal;

  rig.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(rig.matrixWorld).invert();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();

  modelRef.traverse(o => {
    if (!o.isMesh) return;
    let vis = o.visible, n = o.parent;
    while (vis && n) { vis = n.visible; n = n.parent; }
    if (!vis) return;

    if (o.isSkinnedMesh) {
      const pos = o.geometry.attributes.position;
      if (!pos) return;
      const step = Math.max(1, Math.floor(pos.count / (isPhone() ? 220 : 500)));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i);
        o.applyBoneTransform(i, v);
        v.applyMatrix4(o.matrixWorld).applyMatrix4(inv);
        box.expandByPoint(v);
      }
    } else {
      const b = new THREE.Box3().setFromObject(o);
      b.applyMatrix4(inv);
      box.union(b);
    }
  });

  boxCacheKey = foldKeyNow;
  boxCacheLocal = box;
  return box;
}

function realBox() {
  const b = localBox().clone();
  rig.updateMatrixWorld(true);
  b.applyMatrix4(rig.matrixWorld);
  return b;
}

const layoutCache = new Map();

// ключ раскладки — по позиции прокрутки (шаг 1/600)
function layoutKey(p) { return Math.round(Math.min(1, Math.max(0, p)) * 600); }

// сохранить результат в кэш
function saveLayout(key) {
  layoutCache.set(key, {
    x: rig.position.x, y: rig.position.y, z: rig.position.z,
    s: rig.scale.x, rx: rig.rotation.x, ry: rig.rotation.y, rz: rig.rotation.z
  });
  rig.userData.baseY = rig.position.y;
}

function placePhone(prog = 0) {
  // одинаковая позиция прокрутки всегда даёт одинаковый результат
  const key = layoutKey(scrollP);
  const cached = layoutCache.get(key);
  if (cached) {
    rig.position.set(cached.x, cached.y, cached.z);
    rig.scale.setScalar(cached.s);
    if (cached.rx !== undefined) {
      rig.rotation.x = cached.rx;
      rig.rotation.y = cached.ry;
      rig.rotation.z = cached.rz;
    }
    rig.updateMatrixWorld(true);
    rig.userData.baseY = cached.y;
    return;
  }

  boxCacheKey = null;   // поза могла измениться — габариты пересчитываем заново
  if (!modelRef) return;
  const base = rig.userData.base;          // координаты хранятся на rig, не на модели
  const personEl = document.querySelector(".person-img");
  if (!base || !personEl) return;

  // меряем фото БЕЗ нашего transform — иначе результат зависит от предыдущего кадра
  const personWrap = personEl.parentElement;
  const savedTransform = personWrap.style.transform;
  personWrap.style.transform = "none";
  const pr = personEl.getBoundingClientRect();
  personWrap.style.transform = savedTransform;

  const vw = VW, vh = VH;

  // если фото ещё не загрузилось, его высота = 0 — раскладку считать нельзя
  if (pr.height < 40) return;

  // желаемая высота телефона на экране — в пикселях.
  // С прокруткой телефон растёт: нужно прочитать приветствие и нажать кнопку.
  const PHONE_ASPECT = 0.72;
  const maxH = Math.min((vw * 0.92) / PHONE_ASPECT, vh * 0.88);
  const grow = 1 + 0.42 * prog;                       // умеренный рост на ПК
  const narrowScreen = vw < 900;
  // на телефоне держим телефон в левой части кадра, иначе его закрывает фигура
  // на телефоне в начале держим его компактно слева, к раскрытию — даём вырасти
  const narrowW = vw * (0.96 + 0.04 * prog) * (1 + 0.08 * (typeof openProg === "number" ? openProg : 0));
  const narrowCap = narrowScreen ? narrowW / PHONE_ASPECT : Infinity;
  // к концу прокрутки телефон встаёт по центру экрана
  const narrowCx  = 0.40 - 0.01 * prog;   // к концу — по центру
  const vertBoost = 1 + 1.05 * (typeof openProg === "number" ? openProg : 0);
  const targetH = Math.min(pr.height * 0.74 * STAGE.phoneOfPerson * grow * vertBoost,
                           maxH * vertBoost, narrowCap * (1 + 0.15 * (typeof openProg === "number" ? openProg : 0)));

  camera.updateMatrixWorld(true);

  // повороты задаём здесь — иначе раскладка считается по другой позе
  {
    const mob = VW < 900;
    const lerp = (a, b, k) => a + (b - a) * k;
    rig.rotation.y = mob ? (0.34 - 0.12 * scrollP) : lerp(0.46, 0.12, scrollP);
    rig.rotation.x = mob ? (0.30 - 0.12 * scrollP) : lerp(0.34, 0.10, scrollP);
    rig.rotation.z = (mob ? lerp(0.12, 0.03, scrollP) : lerp(0.10, 0.00, scrollP))
                     - Math.PI / 2 * (typeof openProg === "number" ? openProg : 0);
  }

  // ВСЕГДА от статичной базы — иначе результат зависит от предыдущего кадра
  rig.position.set(base.x, base.y, -1.30);
  rig.scale.setScalar(modelRef.userData.baseScale);

  // 1) подгоняем масштаб под нужную высоту на экране
  for (let i = 0; i < 3; i++) {
    rig.updateMatrixWorld(true);
    const box = realBox();
    const px = screenBox(box);
    const curH = px.bottom - px.top;
    if (curH < 1) break;
    rig.scale.multiplyScalar(targetH / curH);
  }

  // 2) ПОЗИЦИОНИРОВАНИЕ
  // Для узких экранов считаем точно, в пикселях: наклон телефона делает
  // итеративный подбор неточным, поэтому масштаб и центр задаём напрямую.
  // вертикальный центр телефона в кадре
  const targetCY = narrowScreen
    ? (0.42 - 0.02 * prog)
    : STAGE.cy + (0.5 - STAGE.cy) * prog;

  if (narrowScreen) {
    camera.updateMatrixWorld(true);

    // масштаб считаем от эталона раскрытого телефона — во время
    // раскрытия размер не «дышит», телефон только поворачивается
    rig.scale.setScalar(1);
    rig.updateMatrixWorld(true);
    if (!openUnitW) {
      const px1 = screenBox(realBox());
      openUnitW = Math.max(1, px1.right - px1.left);
    }
    rig.scale.setScalar(narrowW / openUnitW);

    rig.updateMatrixWorld(true);
    const lb = localBox();
    const centerZ = (lb.min.z + lb.max.z) / 2 * rig.scale.z + rig.position.z;
    const depth = Math.abs(camera.position.z - centerZ);
    const visibleH = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * depth;
    const pxPerUnit = VH / visibleH;

    // центрируем по нужной точке кадра
    rig.updateMatrixWorld(true);
    let pxf = screenBox(realBox());
    let dxc = vw * narrowCx - (pxf.left + pxf.right) / 2;
    let dyc = vh * targetCY - (pxf.top + pxf.bottom) / 2;
    rig.position.x += dxc / pxPerUnit;
    rig.position.y -= dyc / pxPerUnit;

    // если не влезает в кадр — уменьшаем один раз и снова центрируем
    rig.updateMatrixWorld(true);
    pxf = screenBox(realBox());
    const wf = pxf.right - pxf.left, hf = pxf.bottom - pxf.top;
    const kFit = Math.min(1, (vw * 0.94) / wf);   // по высоте не сжимаем: телефон может быть выше кадра
    if (kFit < 0.995) {
      rig.scale.multiplyScalar(kFit);
      rig.updateMatrixWorld(true);
      pxf = screenBox(realBox());
      dxc = vw * narrowCx - (pxf.left + pxf.right) / 2;
      dyc = vh * targetCY - (pxf.top + pxf.bottom) / 2;
      rig.position.x += dxc / pxPerUnit;
      rig.position.y -= dyc / pxPerUnit;
    }

    // страховка: телефон не должен вылезать за края экрана (несколько проходов)
    const margin = 8;
    for (let i = 0; i < 3; i++) {
      rig.updateMatrixWorld(true);
      const pxEnd = screenBox(realBox());
      if (pxEnd.left >= margin && pxEnd.right <= vw - margin &&
          pxEnd.top >= margin && pxEnd.bottom <= vh - margin) break;

      let dxEnd = 0, dyEnd = 0;
      if (pxEnd.left < margin) dxEnd = margin - pxEnd.left;
      if (pxEnd.right > vw - margin) dxEnd = (vw - margin) - pxEnd.right;
      if (pxEnd.top < margin) dyEnd = margin - pxEnd.top;
      if (pxEnd.bottom > vh - margin) dyEnd = (vh - margin) - pxEnd.bottom;

      const depthE = Math.abs(camera.position.z - realBox().getCenter(new THREE.Vector3()).z);
      const visHE = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * depthE;
      const kE = vh / visHE;

      rig.position.x += dxEnd / kE;
      rig.position.y -= dyEnd / kE;
    }
    rig.updateMatrixWorld(true);

    saveLayout(key);
    return;
  }

  // 3) ставим телефон к фигуре: правый край уходит за неё
  for (let i = 0; i < 6; i++) {
    rig.updateMatrixWorld(true);
    const px = screenBox(realBox());

    const boxW = px.right - px.left;
    const behindPerson = pr.left + pr.width * STAGE.personLeft + boxW * STAGE.overlap;
    const centered = vw / 2 + boxW / 2;
    // к раскрытию телефон не улетает в центр, а держится ближе к фигуре
    const wantRight = behindPerson + (centered - behindPerson) * prog * 0.30;

    const depth = Math.abs(camera.position.z - realBox().getCenter(new THREE.Vector3()).z);
    const visibleH = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * depth;
    const k2 = vh / visibleH;

    const dxPx = wantRight - px.right;
    const dyPx = vh / 2 - (px.top + px.bottom) / 2;

    if (Math.abs(dxPx) < 1 && Math.abs(dyPx) < 1) break;

    rig.position.x += dxPx / k2;
    rig.position.y -= dyPx / k2;
  }

  // 4) подгоняем в кадр: масштаб по необходимости, положение сохраняем
  for (let i = 0; i < 5; i++) {
    rig.updateMatrixWorld(true);
    const px = screenBox(realBox());
    const w = px.right - px.left, h = px.bottom - px.top;
    const k = Math.min(1, (vw * 0.94) / w, (vh * 0.90) / h);

    if (k < 0.995) rig.scale.multiplyScalar(k);
    rig.updateMatrixWorld(true);

    const px2 = screenBox(realBox());
    const dy = vh / 2 - (px2.top + px2.bottom) / 2;

    if (!(k < 0.995) && Math.abs(dy) < 1) break;

    const depth = Math.abs(camera.position.z - realBox().getCenter(new THREE.Vector3()).z);
    const visibleH = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * depth;
    rig.position.y -= dy / (vh / visibleH);
  }

  saveLayout(key);
}

function visibleWidthAt(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const depth = Math.abs(camera.position.z - box.getCenter(new THREE.Vector3()).z);
  const visibleH = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * depth;
  return visibleH * camera.aspect;
}

// габариты world-box в пикселях экрана
window.__screenBoxPx = () => screenBox(realBox());

function screenBox(box) {
  const vw = VW, vh = VH;
  const pts = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const v = new THREE.Vector3(x, y, z).project(camera);
        pts.push([(v.x * 0.5 + 0.5) * vw, (-v.y * 0.5 + 0.5) * vh]);
      }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { left: Math.min(...xs), right: Math.max(...xs),
           top: Math.min(...ys), bottom: Math.max(...ys) };
}

function resize() {
  const w = mount.clientWidth || VW;
  const h = mount.clientHeight || VH;

  renderer.setSize(w, h, false);
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";

  camera.aspect = w / h;
  camera.position.set(0, 0, STAGE.zoom);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  lastLayoutP = -1;
  readScroll();
  applyScroll();
}

/* ---------- Прокрутка: шаг 1 (фото меньше, телефон крупнее) ---------- */
const heroEl   = document.getElementById("hero");
const personEl = document.getElementById("person");
const hintEl   = document.getElementById("scrollHint");

let scrollP = 0;      // общий прогресс истории
let stepP = 0;        // шаг 1: фото меньше, телефон крупнее
let unfoldP = 0;      // шаг 2: телефон раскрывается (0..1)
let resumeP = 0;      // шаг 3: прокрутка резюме внутри экрана (0..1)
let lastLayoutP = -1;

// Разворот в «книжку» временно выключен: ждём модель с двумя половинами
// одного устройства. Включить = true.
const UNFOLD_ENABLED = true;

const STEP1_END = 0.16;      // фото уменьшается, телефон растёт
const UNFOLD_END = 0.46;    // телефон раскрывается
const SCROLL_START = 0.56;   // пауза после раскрытия: резюме ещё не едет   // начинается прокрутка резюме внутри экрана   // где заканчивается шаг 1

function readScroll() {
  if (!heroEl) return;
  const rect = heroEl.getBoundingClientRect();
  const total = heroEl.offsetHeight - VH;
  scrollP = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 0;

  stepP   = Math.min(1, scrollP / STEP1_END);
  unfoldP = Math.min(1, Math.max(0, (scrollP - STEP1_END) / (UNFOLD_END - STEP1_END)));
  resumeP = Math.min(1, Math.max(0, (scrollP - SCROLL_START) / (0.97 - SCROLL_START)));
}

function applyScroll() {
  readScroll();


  // фото почти не меняет размер: только сдвиг (на телефоне ещё и уменьшается)
  if (personEl) {
    const mob = window.innerWidth < 900;

    // движение непрерывное на всей прокрутке — фото не «замирает»
    const p = scrollP;
    const sc = mob ? (1 - 0.38 * p) : (1 + 0.10 * p);
    const tx = (mob ? 7 : 7) * p;        // vw — вправо
    const ty = (mob ? 2.5 : 4) * p;       // vh
    personEl.style.transform =
      `translate3d(${tx.toFixed(2)}vw, ${ty.toFixed(2)}vh, 0) scale(${sc.toFixed(3)})`;
  }

  // раскрытие телефона: 0 — сложен, 1 — развёрнут
  const eased = unfoldP < 0.5
    ? 2 * unfoldP * unfoldP
    : 1 - Math.pow(-2 * unfoldP + 2, 2) / 2;
  setFold(eased);
  openProg = eased;



  // шаг 3: страница резюме прокручивается внутри экрана
  if (pageTex) setResumeProgress(resumeP);


}
window.addEventListener("scroll", applyScroll, { passive: true });

/* ---------- плавная прокрутка к позиции ---------- */
function smoothScrollTo(target) {
  const from = window.scrollY;
  const dist = target - from;
  if (Math.abs(dist) < 6) return;

  const dur = Math.min(2200, Math.max(700, Math.abs(dist) * 0.9));
  const t0 = performance.now();

  const step = (now) => {
    const t = Math.min(1, (now - t0) / dur);
    const e2 = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    window.scrollTo(0, from + dist * e2);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- «Шашкова Ирина»: в начало истории ---------- */
document.querySelectorAll(".brand").forEach(el => {
  el.style.cursor = "pointer";
  el.addEventListener("click", (e) => {
    e.preventDefault();
    smoothScrollTo(0);
  });
});

/* ---------- «Контакты» в шапке: плавный доезд до финального экрана ---------- */
document.querySelectorAll('a[href="#contacts"]').forEach(link => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    if (!heroEl) return;

    const total = heroEl.offsetHeight - VH;
    if (total <= 0) return;

    smoothScrollTo(total);   // самый низ истории — экран с QR
  });
});

/* ---------- Курсор ---------- */
window.addEventListener("pointermove", (e) => {
  targetX = (e.clientX / window.innerWidth - 0.5) * 2;
  targetY = (e.clientY / window.innerHeight - 0.5) * 2;
}, { passive: true });

/* ---------- Экраны внутри телефона (canvas-текстуры) ---------- */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Главный экран: ВСЯ информация по всей плоскости телефона
function makeFrontScreen() {
  const W = 1024, H = 1400;
  // рисуем в 2-3 раза плотнее — иначе на большом экране текст мылится
  const S = 2;   // двойная плотность: резко и без лишней памяти
  const c = document.createElement("canvas");
  c.width = W * S; c.height = H * S;
  const ctx = c.getContext("2d");
  ctx.scale(S, S);

  // фон как на развороте с резюме
  ctx.fillStyle = "#e9dfca";
  ctx.fillRect(0, 0, W, H);

  const PAD = 96;

  // верхняя строка: статус
  ctx.fillStyle = "#a89c8a";
  ctx.font = "600 30px Manrope, sans-serif";
  // время берём с устройства один раз при загрузке страницы
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, "0") + ":" +
               String(now.getMinutes()).padStart(2, "0");
  ctx.fillText(hhmm, PAD, 120);
  ctx.textAlign = "right";
  ctx.fillText("HR  ЭТО ПРО ЛЮДЕЙ", W - PAD, 120);
  ctx.textAlign = "left";

  // имя — крупно, поднимаем выше (строки «роль» больше нет)
  ctx.fillStyle = "#2b2722";
  ctx.font = "500 182px 'Cormorant Garamond', Georgia, serif";
  ctx.fillText("Шашкова", PAD, 300);
  ctx.fillText("Ирина", PAD, 450);

  // разделитель
  ctx.fillStyle = "rgba(43,39,34,.14)";
  ctx.fillRect(PAD, 520, W - PAD * 2, 2);

  // приветствие — без пометок «заглушка»
  ctx.fillStyle = "#575047";
  ctx.font = "400 55px Manrope, sans-serif";
  const lines = [
    "«Здравствуйте!",
    "Я Ирина — HR-эксперт.",
    "Помогаю компаниям",
    "строить подбор",
    "персонала с нуля,",
    "масштабировать найм и",
    "растить сильные команды.»"
  ];
  lines.forEach((l, i) => ctx.fillText(l, PAD, 590 + i * 74));


  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

// Внутренний экран — трудовая книжка.
// ВАЖНО: меш этого экрана занимает лишь часть текстуры (u 0.114..0.903, v 0.075..0.861),
// поэтому весь контент рисуем внутри «безопасного» прямоугольника, иначе он обрезается.
function makeBackScreen() {
  const W = 1024, H = 1400;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");

  ctx.fillStyle = "#fbf7f0";
  ctx.fillRect(0, 0, W, H);

  const X0 = Math.round(W * 0.125);
  const X1 = Math.round(W * 0.895);
  const Y0 = Math.round(H * 0.15);
  const Y1 = Math.round(H * 0.855);
  const CW = X1 - X0;

  ctx.fillStyle = "#8f6f48";
  ctx.font = "600 30px Manrope, sans-serif";
  ctx.fillText("ЗАГЛУШКА: РАЗДЕЛ", X0, Y0 + 30);

  ctx.fillStyle = "#2b2722";
  ctx.font = "500 62px 'Cormorant Garamond', Georgia, serif";
  ctx.fillText("Трудовая книжка", X0, Y0 + 110);

  const rows = [
    ["2024 — н.в.",   "ЗАГЛУШКА: компания"],
    ["2023 — 2024",   "ЗАГЛУШКА: компания"],
    ["2022 — 2023",   "ЗАГЛУШКА: компания"],
    ["2021 — 2022",   "ЗАГЛУШКА: компания"]
  ];

  const listTop = Y0 + 175;
  const rowH = Math.floor((Y1 - listTop) / rows.length);

  ctx.strokeStyle = "rgba(43,39,34,.14)";
  ctx.lineWidth = 2;

  rows.forEach((r, i) => {
    const y = listTop + i * rowH;
    ctx.beginPath();
    ctx.moveTo(X0, y); ctx.lineTo(X1, y);
    ctx.stroke();

    ctx.fillStyle = "#8f6f48";
    ctx.font = "600 24px Manrope, sans-serif";
    ctx.fillText(r[0], X0, y + 42);

    ctx.fillStyle = "#2b2722";
    ctx.font = "500 40px 'Cormorant Garamond', Georgia, serif";
    ctx.fillText(r[1], X0, y + 92);
  });

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

// Поворот готовой канвы (нужен, т.к. UV внутреннего экрана повёрнуты)
function rotateCanvas(src, deg) {
  const rad = deg * Math.PI / 180;
  const swap = Math.abs(deg % 180) === 90;
  const out = document.createElement("canvas");
  out.width  = swap ? src.height : src.width;
  out.height = swap ? src.width  : src.height;
  const c = out.getContext("2d");
  c.translate(out.width / 2, out.height / 2);
  c.rotate(rad);
  c.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

// Внутренний разворот: трудовая книжка на всю ширину.
// Контент вписан в окно UV (0.114..0.903 × 0.075..0.861), иначе обрезается.
/* ---------- Резюме на экране телефона: длинная страница + прокрутка ---------- */
const RESUME_W = 1024;
const RESUME_H = 6200;      // высота всей «страницы»
const SCREEN_W = 1024;      // экран
const SCREEN_H = 1463;


function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

let resumeContentH = 0;

const PAGE_SCALE = 1.6;     // плотность страницы (резкость текста)

// QR-коды (сгенерированы локально)
const qrTelegram = new Image(); qrTelegram.src = "assets/qr-telegram.png";
const qrSetka = new Image(); qrSetka.src = "assets/qr-setka.png";

function buildResumePage() {
  const c = document.createElement("canvas");
  c.width = RESUME_W * PAGE_SCALE;
  c.height = RESUME_H * PAGE_SCALE;
  const x = c.getContext("2d");
  x.scale(PAGE_SCALE, PAGE_SCALE);

  const L = 82, R = RESUME_W - 82;
  const RED = "#b32d2a";
  const INK = "#1d1a17";
  const MUTE = "#5b5348";
  const H1 = "700 62px Manrope, sans-serif";
  const H2 = "700 35px Manrope, sans-serif";
  const BODY = "400 26px Manrope, sans-serif";
  const SRC = "600 23px Manrope, sans-serif";
  const SERIF = "600 30px 'Cormorant Garamond', Georgia, serif";

  x.fillStyle = "#e9dfca";
  x.fillRect(0, 0, RESUME_W, RESUME_H);

  let y = 116;

  const wrap = (ctx, text, maxW) => {
    const words = text.split(" ");
    const lines = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; }
      else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  };

  // шапка
  x.fillStyle = INK;
  x.font = "700 32px Manrope, sans-serif";
  x.fillText("HR · ПОДБОР", L, y + 34);

  // строка раздела — переносится по ширине листа
  x.fillStyle = MUTE;
  x.font = "600 21px Manrope, sans-serif";
  const subLines = wrap(x, "СИСТЕМА ПОДБОРА ПЕРСОНАЛА · ОТ АУДИТА ДО МАСШТАБИРОВАНИЯ", R - (L + 250));
  if (subLines.length <= 1) {
    x.fillText(subLines[0] || "", L + 250, y + 34);
  } else {
    x.fillText(subLines[0], L + 250, y + 22);
    x.fillText(subLines[1], L + 250, y + 48);
  }


  x.fillRect(L, y + 56, R - L, 2);
  y += 132;

  // ОПЫТ РАБОТЫ
  x.fillStyle = INK;
  x.font = H1;
  x.fillText("ОПЫТ РАБОТЫ", L, y);
  y += 62;

  const jobs = [
    ["2024 — наст. время", "РУКОВОДИТЕЛЬ ОТДЕЛА ПОДБОРА ПЕРСОНАЛА", "Контур"],
    ["2023 — 2024", "РЕГИОНАЛЬНЫЙ РУКОВОДИТЕЛЬ ПО ПОДБОРУ ПЕРСОНАЛА", "Озон · Урал, Сибирь и Дальний Восток, СНГ"],
    ["2022 — 2023", "НАЧАЛЬНИК ОТДЕЛА ПОДБОРА ПЕРСОНАЛА", "МТС"],
    ["2021 — 2022", "РУКОВОДИТЕЛЬ ОТДЕЛА ПОДБОРА ПЕРСОНАЛА", "Контур"]
  ];

  x.strokeStyle = "rgba(29,26,23,.25)";
  x.lineWidth = 1.5;

  for (const [period, role, company] of jobs) {
    x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke();

    // должность — по верхнему краю строки (+15% к кеглю и интерлиньяжу)
    x.textBaseline = "top";
    x.fillStyle = INK;
    x.font = "700 45px Manrope, sans-serif";
    const COL2 = 330;                       // ширина колонки с датами
    const lines = wrap(x, role, R - L - COL2);
    let ly = y + 18;
    lines.forEach(l => { x.fillText(l, L + COL2, ly); ly += 49; });

    // годы — по центру высоты блока должности
    const roleTop = y + 18;
    const roleH = lines.length * 44;
    x.fillStyle = MUTE;
    x.font = "600 30px Manrope, sans-serif";
    x.fillText(period, L, roleTop + (roleH - 27) / 2 - 4);

    x.textBaseline = "alphabetic";

    x.fillStyle = RED;
    x.font = "600 34px 'Cormorant Garamond', Georgia, serif";
    const compLines = wrap(x, "■ " + company, R - (L + COL2));
    compLines.forEach((cl, ci) => x.fillText(cl, L + COL2, ly + 30 + ci * 37));
    ly += (compLines.length - 1) * 37;

    y = ly + 84;
  }

  // УСЛУГИ
  y += 30;
  x.fillStyle = INK;
  x.font = H1;
  x.fillText("УСЛУГИ", L, y);
  x.fillStyle = MUTE;
  x.font = SRC;
  x.textAlign = "right";
  x.fillText("02", R, y - 6);
  x.textAlign = "left";
  y += 58;

  const services = [
    ["АНАЛИЗ СИСТЕМЫ ПОДБОРА", "Оценка воронки, сроков закрытия вакансий, конверсий, стоимости найма."],
    ["ОТДЕЛ ПОДБОРА С НУЛЯ", "Структура, роли, KPI."],
    ["МАСШТАБИРОВАНИЕ НАЙМА", "Подготовка к росту и выходу на новые рынки."],
    ["НАСТРОЙКА ПРОЦЕССОВ", "Регламенты, SLA, стандарты."],
    ["КУРСЫ ПО ПОДБОРУ", "Разработка и запись обучающих программ."],
    ["НАСТАВНИЧЕСТВО", "Для руководителей отдела подбора."],
    ["RETAINER-КОНСАЛТИНГ", "Ежемесячное сопровождение."],
    ["АУДИТ КОМПЕТЕНЦИЙ", "Оценка рекрутеров."]
  ];

  services.forEach(([title, desc], i) => {
    x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.strokeStyle = "rgba(29,26,23,.18)"; x.stroke();

    // номер
    x.fillStyle = RED;
    x.font = "700 30px Manrope, sans-serif";
    x.fillText(String(i + 1).padStart(2, "0"), L, y + 44);

    // название (+15%)
    x.fillStyle = INK;
    x.font = "700 40px Manrope, sans-serif";
    x.fillText(title, L + 76, y + 44);

    // описание (+15%) с переносами по ширине
    x.fillStyle = MUTE;
    x.font = "400 30px Manrope, sans-serif";
    const descLines = wrap(x, desc, R - (L + 76));
    let dy = y + 84;
    descLines.forEach(l => { x.fillText(l, L + 76, dy); dy += 38; });

    y = dy + 26;
  });

  // КЕЙСЫ
  y += 40;
  x.fillStyle = INK;
  x.font = H1;
  x.fillText("КЕЙСЫ", L, y);
  x.fillStyle = MUTE;
  x.font = SRC;
  x.textAlign = "right";
  x.fillText("03 / РЕЗУЛЬТАТЫ", R, y - 6);
  x.textAlign = "left";
  y += 44;

  const cases = [
    ["01", "КОНТУР", "×2", "БЫСТРЕЕ ПОДБОР В КОММЕРЧЕСКОМ БЛОКЕ",
      ["Снижение сроков подбора персонала в коммерческом блоке в 2 раза.",
       "Рост производительности рекрутеров в 3 раза в массовом найме."]],
    ["02", "ОЗОН", "+93%", "НАЙМА НА ЗАКРЕПЛЁННОЙ ТЕРРИТОРИИ",
      ["Введение новых форм занятости, графиков работы и привлечение дополнительных категорий персонала.",
       "Рост эффективности команды на 16%."]],
    ["03", "МТС", "+13%", "ЭФФЕКТИВНОСТЬ РЕКРУТЕРОВ",
      ["Рост эффективности рекрутеров на 13% при снижении количества откликов на 30%."]]
  ];

  for (const [num, company, big, caption, bullets] of cases) {
    // считаем нужную высоту карточки заранее — чтобы ничего не вылезало
    x.font = "400 31px Manrope, sans-serif";
    const bulletLines = [];
    for (const b of bullets) bulletLines.push(...wrap(x, "• " + b, R - L - 500));

    x.font = "600 22px Manrope, sans-serif";
    const capLines = wrap(x, caption, 300);

    const leftH = 184 + capLines.length * 27;
    const rightH = 60 + bulletLines.length * 38 + bullets.length * 10;
    const boxH = Math.max(leftH, rightH) + 42;

    x.strokeStyle = "rgba(29,26,23,.45)";
    x.lineWidth = 2;
    x.strokeRect(L, y, R - L, boxH);

    x.fillStyle = MUTE;
    x.font = "600 29px Manrope, sans-serif";
    x.fillText(num, L + 28, y + 42);

    x.fillStyle = INK;
    x.font = "700 34px Manrope, sans-serif";
    x.fillText(company, L + 100, y + 42);

    // цифра и подпись — по центру своей ячейки (первая строка остаётся слева)
    const colCx = L + 170;
    x.textAlign = "center";

    const blockH = 84 + 38 + capLines.length * 27;
    const availTop = y + 70;
    const availH = boxH - 70 - 26;
    const blockTop = availTop + Math.max(0, (availH - blockH) / 2);

    x.fillStyle = RED;
    x.font = "700 84px Manrope, sans-serif";
    x.fillText(big, colCx, blockTop + 84);

    x.fillStyle = MUTE;
    x.font = "600 22px Manrope, sans-serif";
    capLines.forEach((l, i) => x.fillText(l, colCx, blockTop + 84 + 38 + i * 27));
    x.textAlign = "left";

    x.fillStyle = INK;
    x.font = "400 31px Manrope, sans-serif";

    // правый столбец — по центру высоты карточки
    const bulletsH = bulletLines.length * 38 + (bullets.length - 1) * 10;
    let by = y + (boxH - bulletsH) / 2 + 26;
    for (const b of bullets) {
      const lines = wrap(x, "• " + b, R - L - 500);
      lines.forEach(l => { x.fillText(l, L + 480, by); by += 38; });
      by += 10;
    }

    y += boxH + 30;
  }

  // ---------- финальный экран: линия, вопрос, два QR, печать ----------
  y += 16;
  const SLICE_H = 1573;                    // сколько страницы видно на экране
  const blockTop = y;

  const qrSize = 300;
  const qrGap = (R - L - qrSize * 2) / 3;
  const qrX1 = L + qrGap;
  const qrX2 = L + qrGap * 2 + qrSize;
  const qrY = blockTop + 216;

  const drawQR = (img, qx) => {
    if (!img.complete || !img.naturalWidth) return;
    x.fillStyle = "#ffffff";
    x.fillRect(qx, qrY, qrSize, qrSize);
    x.drawImage(img, qx, qrY, qrSize, qrSize);
    x.strokeStyle = "rgba(29,26,23,.35)";
    x.lineWidth = 2;
    x.strokeRect(qx, qrY, qrSize, qrSize);
  };

  if (qrTelegram) drawQR(qrTelegram, qrX1);
  if (qrSetka) drawQR(qrSetka, qrX2);

  // запоминаем места QR — для кликабельных ссылок
  pageQr = [
    { x: qrX1, y: qrY, w: qrSize, h: qrSize, url: "https://t.me/Irina_Shashkova" },
    { x: qrX2, y: qrY, w: qrSize, h: qrSize, url: "https://set.ki/WX4ziuC" }
  ];

  const capY = qrY + qrSize + 38;
  x.textAlign = "center";
  x.fillStyle = INK;
  x.font = "700 29px Manrope, sans-serif";
  x.fillText("TELEGRAM", qrX1 + qrSize / 2, capY);
  x.fillText("СЕТКА", qrX2 + qrSize / 2, capY);
  x.fillStyle = MUTE;
  x.font = "500 25px Manrope, sans-serif";
  x.fillText("@Irina_Shashkova", qrX1 + qrSize / 2, capY + 34);
  x.fillText("set.ki/WX4ziuC", qrX2 + qrSize / 2, capY + 34);
  x.textAlign = "left";

  // равные зазоры: QR → имя → печать
  const stW = 540, stH = 216;
  const cx = L + (R - L) / 2;

  const qrEnd = capY + 34;                     // низ подписей под QR
  const nameY = qrEnd + 182;                   // имя ниже
  const footLineY = blockTop + SLICE_H - 84;   // линия над нижней строкой
  const stampTop = blockTop + 968;             // печать на прежнем месте

  x.textAlign = "center";
  x.fillStyle = INK;
  x.font = "600 98px 'Cormorant Garamond', Georgia, serif";
  x.fillText("Ирина Шашкова", cx, nameY);

  x.fillStyle = MUTE;
  x.font = "600 26px Manrope, sans-serif";
  x.fillText("HR-ПАРТНЁР ДЛЯ ВАШЕГО БИЗНЕСА", cx, nameY + 50);
  x.textAlign = "left";

  x.save();
  x.translate(cx, stampTop + stH / 2);
  x.rotate(-0.06);
  x.strokeStyle = "rgba(179,45,42,.85)";
  x.lineWidth = 8;
  roundRectPath(x, -stW / 2, -stH / 2, stW, stH, 14);
  x.stroke();
  x.fillStyle = "rgba(179,45,42,.9)";
  x.textAlign = "center";
  x.font = "700 70px Manrope, sans-serif";
  x.fillText("ПОДБОР", 0, -18);
  x.fillText("ПОД КЛЮЧ", 0, 46);
  x.font = "600 25px Manrope, sans-serif";
  x.fillText("ОТ АУДИТА ДО РЕЗУЛЬТАТА", 0, 86);
  x.restore();
  x.textAlign = "left";

  // нижняя строка-подпись
  const footY = footLineY - 34;
  x.fillStyle = "rgba(29,26,23,.25)";
  x.fillRect(L, footY - 40, R - L, 1.5);
  x.fillStyle = MUTE;
  x.font = "600 23px Manrope, sans-serif";
  x.textAlign = "center";
  x.font = "700 29px Manrope, sans-serif";
  x.fillText("ПОДБОР БЕЗ ХАОСА", L + (R - L) / 2, footY);
  x.textAlign = "left";

  // линия и заголовок рисуются поверх блока (сверху)
  x.fillStyle = INK;
  x.fillRect(L, blockTop + 78, R - L, 2);

  x.font = "700 60px Manrope, sans-serif";
  x.textAlign = "center";
  x.fillText("НУЖНА КОНСУЛЬТАЦИЯ?", L + (R - L) / 2, blockTop + 152);
  x.textAlign = "left";


  y = blockTop + SLICE_H;

  resumeContentH = y;

  return c;
}

// Экран показывает «окно» страницы, сдвинутое на progress (0..1)
function setResumeProgress(p) {
  resumeProgress = Math.min(1, Math.max(0, p));
  resumeDirty = true;          // сама отрисовка — раз в кадр, в animate()
}

function redrawResume() {
  if (!resumeDirty) return;
  resumeDirty = false;
  if (!resumeCanvas || !pageTex) return;

  const Ph = pageTex.userData.Ph;          // высота текстуры в пикселях
  const sliceHpx = pageTex.userData.sliceHpx;
  const maxShiftPx = pageTex.userData.maxShiftPx;

  const shiftPx = maxShiftPx * resumeProgress;

  // двигаем только окно выборки — ни перерисовки, ни загрузки текстуры
  pageTex.offset.y = (1 - (shiftPx + sliceHpx) / Ph) - UV_V0 * pageTex.userData.ry;
}

function makeSpreadScreen() {
  // Экран телефона в вертикали: 0,70 (7:10) → холст 1024 × 1463.
  resumeCanvas = buildResumePage();

  const tex = new THREE.CanvasTexture(resumeCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;

  const Ph = resumeCanvas.height;                       // пиксели текстуры
  const scale = VIS_W / RESUME_W;                       // страница по ширине экрана
  const sliceH = VIS_H / scale;                         // видно по высоте (в единицах страницы)
  const contentH = resumeContentH || RESUME_H;

  const sliceHpx = sliceH * PAGE_SCALE;
  const maxShiftPx = Math.max(0, contentH - sliceH) * PAGE_SCALE;

  const rx = -1 / (UV_U1 - UV_U0);                      // горизонталь + отражение
  const ox = 1 - UV_U0 * rx;
  const ry = (sliceHpx / Ph) / (UV_V1 - UV_V0);         // окно по вертикали
  const oy = (1 - (0 + sliceHpx) / Ph) - UV_V0 * ry;    // старт: сверху страницы

  tex.repeat.set(rx, ry);
  tex.offset.set(ox, oy);
  tex.userData = { Ph, sliceHpx, maxShiftPx, ry };

  pageTex = tex;
  screenTex = tex;
  resumeDirty = true;

  return tex;
}

// 0 — телефон сложен, 1 — раскрыт «книжкой»
function setFold(p) {
  foldKeyNow = Math.round(p * 24);
  if (!foldBone || !foldRest) return;
  const angle = Math.PI * (1 - p);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
  foldBone.quaternion.copy(foldRest).premultiply(q);
  foldBone.updateMatrixWorld(true);
}

// Экраны модели разложены по материалам:
//   Screen.001 — внутренний экран (опыт)  → наша «трудовая книжка»
//   Screen.002 — внешний/главный экран    → имя и приветствие
function flipped(tex) {
  // UV экранов этой модели инвертированы по обеим осям (X↔-u, Y↔-v)
  const t = tex.clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // по горизонтали отражаем, по вертикали — обычный порядок
  t.repeat.set(1, -1);
  t.offset.set(0, 1);
  return t;
}

function paintScreens(model, frontTex, backTex) {
  const front = flipped(frontTex);
  const back  = flipped(backTex);

  model.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const names = mats.map(m => (m && m.name) || "");
    const meshName = o.name || "";
    if (names.some(n => /Screen\.002/.test(n)) || /screen/i.test(meshName)) {
      o.material = new THREE.MeshBasicMaterial({ map: front, toneMapped: false });
    } else if (names.some(n => /Screen\.001/.test(n))) {
      o.material = new THREE.MeshBasicMaterial({ map: back, toneMapped: false });
    }
  });
}



/* ---------- Загрузка модели ---------- */
const loader = new GLTFLoader();

loader.load(
  "model2/iPhone_Duo_Rig.glb",
  (gltf) => {
    const model = gltf.scene;

    // --- Новая модель: ОДИН складной корпус со скелетом ---
    // Кости: Duo_Root → Duo_Fold_L + Duo_Half_R. Складываем вращением Duo_Fold_L.
    // Экраны отдельные: Duo_Cover_Screen (снаружи) и Duo_Screen_Flexible (внутри).
    let foldL = null;
    model.traverse(o => { if (o.name === "Duo_Fold_L") foldL = o; });
    foldBone = foldL;

    // В файле есть и риг (скиннинг), и витринные копии без скелета.
    // Оставляем только то, что деформируется костями.
    model.traverse(o => {
      if (o.isMesh && !o.isSkinnedMesh) o.visible = false;
    });

    rig.add(model);

    // текстуры: снаружи — имя/приветствие, внутри — трудовая книжка
    const coverTex = makeFrontScreen();
    // без мипмапов текст на крупном экране остаётся резким
    const sharpen = (t) => {
      // мипмапы возвращают мягкость: без них текст выглядит «звенящим»
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      t.needsUpdate = true;
      return t;
    };
    sharpen(coverTex);
    coverTex.wrapS = coverTex.wrapT = THREE.RepeatWrapping;
    coverTex.repeat.set(1, -1);
    coverTex.offset.set(0, 1);

    const innerTex = sharpen(makeSpreadScreen());

    // Стекло поверх дисплея мылит текст — прячем его, экран остаётся чистым
    model.traverse(o => {
      if (!o.isMesh) return;
      const n = o.name || "";
      const par = (o.parent && o.parent.name) || "";
      const mat = (o.material && o.material.name) || "";
      if (/Glass_Screen|Cover_Screen_Glass|Glass_Screen_Flexible/i.test(n) ||
          /Cover_Screen_Glass|Glass_Screen_Flexible/i.test(par) ||
          /Glass screen/i.test(mat)) {
        o.visible = false;
      }
    });

    // экраны лежат внутри групп с этими именами
    model.traverse(o => {
      if (!o.isMesh) return;
      const self = o.name || "";
      const par  = (o.parent && o.parent.name) || "";
      if (self === "Duo_Cover_Screen" || par === "Duo_Cover_Screen") {
        o.material = new THREE.MeshBasicMaterial({ map: coverTex, toneMapped: false });
      } else if (self === "Duo_Screen_Flexible" || par === "Duo_Screen_Flexible") {
        o.material = new THREE.MeshBasicMaterial({ map: innerTex, toneMapped: false });
        screenMesh = o;   // нужен для кликов по QR
      }
    });

    // стартовое состояние — СЛОЖЕН: считаем габариты и центрируем по нему
    if (foldBone) {
      foldRest = foldBone.quaternion.clone();
      setFold(0);                    // 0 = сложен, 1 = раскрыт
    }
    model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    model.position.sub(center);

    const scale = 2.55 / Math.max(size.y, 0.001);
    rig.scale.setScalar(scale);

    // В СЛОЖЕННОМ ВИДЕ — телефон ЗА ФОТО: чуть крупнее, выше, наклонён.
    rig.rotation.set(0.34, 0.44, 0.10);
    rig.position.set(-1.62, 0.55, -1.30);
    rig.userData.base = { x: -1.62, y: 0.55 };
    modelRef = model;
    model.userData.baseScale = scale;

    // эталон ширины РАСКРЫТОГО телефона (для стабильного масштаба)
    (function measureOpenPhone() {
      const savedFold = foldKeyNow;
      setFold(1);
      boxCacheKey = null;
      rig.rotation.z = -Math.PI / 2;
      rig.scale.setScalar(1);
      rig.updateMatrixWorld(true);
      const b = screenBox(realBox());
      openUnitW = Math.max(1, b.right - b.left);
      rig.rotation.z = 0;
      setFold(0);
      boxCacheKey = null;
      foldKeyNow = savedFold;
    })();

    window.__m = { rig, model, THREE, camera };
    resize();          // пересчитать раскладку уже с моделью
    ready = true;
  },
  undefined,
  (err) => {
    console.warn("Модель не загрузилась:", err);
    mount.classList.add("no-model");
  }
);

/* ---------- Цикл ---------- */
function animate(now) {
  // раскладку обновляем в кадре — иначе она отстаёт на одно событие скролла
  if (ready && Math.abs(scrollP - lastLayoutP) > 0.0005) {
    lastLayoutP = scrollP;
    placePhone(stepP);
  }

  redrawResume();
  updateScreenLinks();
  requestAnimationFrame(animate);
  t = now * 0.001;

  curX += (targetX - curX) * 0.045;
  curY += (targetY - curY) * 0.045;

  if (ready) {
    // с прокруткой телефон поворачивается «лицом» — так текст читается ровнее
    const lerp = (a, b, k) => a + (b - a) * k;
    const mobNow = window.innerWidth < 900;
    // на телефоне наклон меньше: экран почти к зрителю, поэтому текст резче
    const baseY = mobNow ? lerp(0.16, 0.05, scrollP) : lerp(0.46, 0.12, scrollP);
    const baseX = mobNow ? lerp(0.10, 0.04, scrollP) : lerp(0.34, 0.10, scrollP);
    const baseZ = mobNow ? lerp(0.12, 0.03, scrollP) : lerp(0.10, 0.00, scrollP);

    // положение и поза телефона задаются ТОЛЬКО в placePhone —
    // любые добавки здесь «перемешивают» кадры и дают скачки
  }

  renderer.render(scene, camera);
}

resize();
requestAnimationFrame(animate);

/* ---------- ТЕСТОВЫЙ ХУК (временно) ---------- */
window.__testUV = (rx, ry, swap) => {
  const front = makeFrontScreen();
  const back  = makeBackScreen();
  const mk = (tex) => { const t = tex.clone(); t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry); t.offset.set(rx < 0 ? 1 : 0, ry < 0 ? 1 : 0); return t; };
  const f = mk(front), bk = mk(back);
  rig.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const names = mats.map(m => (m && m.name) || "");
    if (names.some(n => /Screen\.002/.test(n))) {
      o.material = new THREE.MeshBasicMaterial({ map: swap ? bk : f });
    } else if (names.some(n => /Screen\.001/.test(n))) {
      o.material = new THREE.MeshBasicMaterial({ map: swap ? f : bk });
    }
  });
};

window.__p = () => ({ scrollP, stepP, unfoldP, openProg, heroH: heroEl ? heroEl.offsetHeight : 0, vh: innerHeight, y: scrollY });

/* ---------- ссылки на финальном экране ---------- */
let linkLayer = null;

function ensureLinkLayer() {
  if (linkLayer) return linkLayer;
  const stage = document.querySelector(".stage");
  if (!stage) return null;
  linkLayer = document.createElement("div");
  linkLayer.className = "screen-links";
  stage.appendChild(linkLayer);
  [["https://t.me/Irina_Shashkova", "Telegram Ирины Шашковой"],
   ["https://set.ki/WX4ziuC", "Профиль на Сетке"]].forEach(([href, title]) => {
    const a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener";
    a.title = title; a.setAttribute("aria-label", title);
    linkLayer.appendChild(a);
  });
  return linkLayer;
}

function updateScreenLinks() {
  const layer = ensureLinkLayer();
  if (!layer) return;

  const show = openProg > 0.95 && resumeProgress > 0.985 && pageQr.length === 2;
  if (!show) { layer.style.display = "none"; return; }

  const box = screenBox(realBox());
  const bw = box.right - box.left, bh = box.bottom - box.top;
  if (bw < 40 || bh < 40) { layer.style.display = "none"; return; }

  // рамка устройства -> область дисплея
  const sLeft = box.left + bw * 0.055;
  const sTop = box.top + bh * 0.035;
  const sW = bw * 0.89;
  const sH = bh * 0.93;

  const scale = VIS_W / RESUME_W;
  const pageH = resumeContentH || RESUME_H;
  const sliceH = VIS_H / scale;
  const shift = Math.max(0, pageH - sliceH) * resumeProgress;

  layer.style.display = "block";

  pageQr.forEach((q, i) => {
    const cx = VIS_X + q.x * scale;
    const cy = VIS_Y + (q.y - shift) * scale;
    const cw = q.w * scale;
    const ch = q.h * scale;

    const a = layer.children[i];
    a.style.left = (sLeft + ((cx - VIS_X) / VIS_W) * sW) + "px";
    a.style.top = (sTop + ((cy - VIS_Y) / VIS_H) * sH) + "px";
    a.style.width = (cw / VIS_W) * sW + "px";
    a.style.height = (ch / VIS_H) * sH + "px";
  });
}
