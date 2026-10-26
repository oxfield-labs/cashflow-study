import { CONFIG } from './config.js';
import { createStorage } from './storage.js';
import * as Q from './questions.js';
import { buildStimulus, chartSVG, won, wonPlain, pct } from './stimulus.js';

// ---------- URL 파라미터 ----------
const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'lab' ? 'lab' : 'online'; // lab = Phase 2(아이트래킹, 연구자 동석)
const PID = (params.get('pid') || '').trim() || null;
const STAGE = ['pre', 'exp'].includes(params.get('stage')) && MODE === 'lab' ? params.get('stage') : 'all';
const APP_VERSION = 'pilot-0.4';
const DEBUG = params.get('debug') === '1';
// ?design=1 : 디자인 검토용. 모든 값이 채워진 상태로 처음부터 끝까지 같은 흐름을 눌러 볼 수 있다. C형 화면 고정, 저장·이어하기 없음.
const DESIGN = params.get('design') === '1';
const SHOW_AOI = params.get('aoi') === '1';
const FORCE_GROUP = (MODE === 'lab' || DEBUG) && ['A', 'B', 'C'].includes(params.get('g')) ? params.get('g') : null;
const MIN_EXPOSURE = (DEBUG || DESIGN) && params.get('min') !== null ? Number(params.get('min')) : DESIGN ? 6 : CONFIG.MIN_EXPOSURE_SEC;

// 미리보기: ?preview=A|B|C 로 열면 해당 자극물만 보여 주고 아무것도 저장하지 않는다 (디자인 확인, 아이트래커 보정용)
const PREVIEW = ['A', 'B', 'C'].includes(params.get('preview')) ? params.get('preview') : null;
const nullStore = { kind: 'null', startSession: async () => ({ id: 'preview', group: PREVIEW || 'C' }), savePart: async () => true, logEvents: async () => true, flush: async () => {} };
// ?local=1 : 서버(Supabase)에 아무것도 보내지 않는 리허설 모드. 로컬에서 문구·화면을 고치며 시험할 때 운영 DB에 시험 데이터가 쌓이지 않도록 쓴다.
const FORCE_LOCAL = params.get('local') === '1';
const store = PREVIEW || DESIGN ? nullStore : createStorage(FORCE_LOCAL ? { ...CONFIG, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' } : CONFIG);
const root = document.getElementById('app');

// ---------- 상태 ----------
const S = {
  id: null,
  group: null,
  stepIdx: 0,
  screen: {},
  pre: {},
  asset: { amount: null, interests: [], name: '' }, // name은 화면 인사말에만 쓰고 저장하지 않는다
  post: {},
  orders: {}, // 쪽별 문항 표시 순서
  timing: {},
  events: [],
  stim: null,
  stimState: { view: 'home', homeMs: 0, chartMs: 0, statusEntries: 0, enteredAt: null },
  code: null,
};

function stepList() {
  const s = [];
  if (STAGE !== 'exp') s.push('consent');
  if (STAGE !== 'exp' && MODE === 'online') s.push('screening');
  if (STAGE === 'exp') s.push('labstart');
  if (STAGE !== 'pre') s.push('guide');
  if (STAGE !== 'exp') Q.PRE_PAGES.forEach((p) => s.push(p.id));
  if (STAGE === 'pre') {
    s.push('endpre');
    return s;
  }
  s.push('asset', 'prestim', 'stimulus', 'poststart', ...Q.POST_PAGES.map((p) => p.id), 'end');
  return s;
}
const STEPS = PREVIEW ? ['asset', 'stimulus', 'endprev'] : stepList();

// 디자인 검토용 기본값 (DESIGN 모드에서만 사용, 저장되지 않음)
if (DESIGN) {
  S.id = 'design';
  S.group = 'C';
  S.screen = { S1: 27, S2: '예', S3: '예', S4: '아니오' };
  const fillItems = (items, b) =>
    items.forEach((it) => {
      b[it.id] =
        it.type === 'likert' ? (it.id === 'AC1' ? 7 : 5) : it.type === 'yesno' ? '예' : it.type === 'number' ? (it.id === 'M3' ? 12 : 3) : it.options[0];
    });
  Q.PRE_PAGES.forEach((pg) => fillItems(pg.items, S.pre));
  Q.POST_PAGES.forEach((pg) => fillItems(pg.items, S.post));
  S.asset = { amount: 3_000_000, interests: ['overseas'], name: '민지' };
  S.stim = buildStimulus('C', 3_000_000, new Date(), CONFIG.END_MONTH);
}

// ---------- 유틸 ----------
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = (t) => esc(t).replace(/\n/g, '<br>');
// 문항 문구 안의 **강조** 표시를 하이라이트로 바꾼다 (문구 자체는 바뀌지 않는다)
const fmt = (t) => nl2br(t).replace(/\*\*(.+?)\*\*/g, '<mark class="hl">$1</mark>');
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function deviceInfo() {
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    lang: navigator.language,
    viewport: { w: innerWidth, h: innerHeight },
    screen: { w: screen.width, h: screen.height },
    dpr: devicePixelRatio,
    touch: navigator.maxTouchPoints,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tz_offset_min: new Date().getTimezoneOffset(),
    mode: MODE,
    stage: STAGE,
    app_version: APP_VERSION,
  };
}
function log(type, data = {}) {
  S.events.push({ ts: Date.now(), step: currentStepId(), type, ...data });
}
async function flushEvents() {
  if (!S.id || !S.events.length) return;
  const batch = S.events.splice(0, S.events.length);
  await store.logEvents(S.id, batch);
}
const currentStepId = () => STEPS[S.stepIdx];

// ---------- 단계(phase) 표시 ----------
const PRE_IDS = new Set(Q.PRE_PAGES.map((p) => p.id));
const POST_IDS = new Set(Q.POST_PAGES.map((p) => p.id));
function phaseOf(id) {
  if (id === 'guide') return 'guide';
  if (PRE_IDS.has(id) || id === 'asset') return 'pre';
  if (id === 'prestim') return 'view';
  if (id === 'poststart' || POST_IDS.has(id)) return 'post';
  return null; // 동의·스크리닝·자극물 화면·종료에는 표시하지 않는다 (자극물 화면은 어떤 요소도 더하지 않음)
}
const PHASES = [
  { id: 'guide', label: '안내' },
  { id: 'pre', label: STAGE === 'exp' ? '금액 입력' : '사전 질문' },
  { id: 'view', label: '화면 보기' },
  { id: 'post', label: '설문' },
];
function phaseBar(id) {
  if (PREVIEW) return '';
  const cur = phaseOf(id);
  if (!cur) return '';
  const vis = PHASES.filter((p) => STEPS.some((sid) => phaseOf(sid) === p.id));
  const ci = vis.findIndex((p) => p.id === cur);
  // 뒤로 가기 버튼과 같은 줄 오른쪽에: 현재 단계 이름 + 짧은 막대 4개 (자세한 단계 이름은 현재 것만)
  return `<div class="phases" role="group" aria-label="진행 단계"><span class="pcur">${esc(vis[ci]?.label || '')}</span><ol>${vis
    .map((p, i) => `<li class="${i < ci ? 'done' : i === ci ? 'on' : ''}" ${i === ci ? 'aria-current="step"' : ''}><i></i><span class="sr">${esc(p.label)}</span></li>`)
    .join('')}</ol></div>`;
}

// ---------- 화면 골격 ----------
function frame(inner, { back = false, progress = true, wide = false } = {}) {
  const total = STEPS.length - 1;
  const p = Math.min(1, S.stepIdx / Math.max(1, total - 1));
  const pb = phaseBar(currentStepId());
  root.innerHTML = `
    <div class="shell ${wide ? 'wide' : ''}">
      <div class="topbar">
        ${back ? '<button class="iconbtn" id="back" aria-label="이전">' + ICON.back + '</button>' : '<span></span>'}
        ${pb || (progress ? `<div class="progress" aria-hidden="true"><i style="width:${Math.round(p * 100)}%"></i></div>` : '')}
      </div>
      <main class="screen">${inner}</main>
    </div>`;
  scrollTo(0, 0);
}

const ICON = {
  mail: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>',
  clock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  lock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l7 7 7-7"/></svg>',
  bell: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>',
  trend: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
  up: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  coin: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M9 12h6"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
};

// ---------- 폼 컴포넌트 ----------
function itemHTML(item) {
  const t = `<p class="q-text">${fmt(item.text)}</p>`;
  if (item.type === 'likert') {
    const l = item.labels || Q.LIKERT_LABELS;
    const btns = [1, 2, 3, 4, 5, 6, 7]
      .map((v) => `<label class="lk"><input type="radio" name="${item.id}" value="${v}"><span>${v}</span></label>`)
      .join('');
    return `<section class="q" data-qid="${item.id}">${t}<div class="likert">${btns}</div>
      <div class="lk-labels"><span>${nl2br(l[0])}</span><span>${nl2br(l[6])}</span></div></section>`;
  }
  if (item.type === 'choice' || item.type === 'yesno') {
    const opts = item.type === 'yesno' ? ['예', '아니오'] : item.options;
    const cls = item.type === 'yesno' ? 'choices two' : 'choices';
    return `<section class="q" data-qid="${item.id}">${t}<div class="${cls}">${opts
      .map((o) => `<label class="ch"><input type="radio" name="${item.id}" value="${esc(o)}"><span>${esc(o)}</span></label>`)
      .join('')}</div></section>`;
  }
  if (item.type === 'number') {
    return `<section class="q" data-qid="${item.id}">${t}<div class="numwrap">
      <input class="num" type="text" inputmode="${item.decimal ? 'decimal' : 'numeric'}" name="${item.id}" autocomplete="off" placeholder="숫자를 입력해 주세요">
      <span class="unit">${esc(item.unit || '')}</span></div></section>`;
  }
  return '';
}

function readItem(item, scope) {
  if (item.type === 'number') {
    const raw = scope.querySelector(`input[name="${item.id}"]`).value.replace(/,/g, '').trim();
    if (raw === '' || isNaN(Number(raw))) return null;
    const v = Number(raw);
    if (item.min !== undefined && v < item.min) return null;
    if (item.max !== undefined && v > item.max) return null;
    return v;
  }
  const c = scope.querySelector(`input[name="${item.id}"]:checked`);
  if (!c) return null;
  return item.type === 'likert' ? Number(c.value) : c.value;
}

function restore(item, scope, store_) {
  const v = store_[item.id];
  if (v === undefined || v === null) return;
  if (item.type === 'number') scope.querySelector(`input[name="${item.id}"]`).value = v;
  else {
    const el = [...scope.querySelectorAll(`input[name="${item.id}"]`)].find((i) => i.value === String(v));
    if (el) el.checked = true;
  }
}

function collectItems(items, scope) {
  const out = {};
  let firstMissing = null;
  for (const it of items) {
    const v = readItem(it, scope);
    out[it.id] = v;
    const box = scope.querySelector(`[data-qid="${it.id}"]`);
    box.classList.toggle('missing', v === null);
    if (v === null && !firstMissing) firstMissing = box;
  }
  return { out, firstMissing };
}

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- 단계 이동 ----------
function enterStep() {
  S.timing[currentStepId()] = S.timing[currentStepId()] || { ms: 0, visits: 0 };
  S.timing[currentStepId()].visits++;
  S._enter = performance.now();
  log('step_enter');
  persist();
  RENDER[currentStepId()]?.();
}
function leaveStep() {
  const t = S.timing[currentStepId()];
  if (t && S._enter) t.ms += Math.round(performance.now() - S._enter);
  log('step_leave');
}
async function go(delta) {
  leaveStep();
  S.stepIdx = Math.max(0, Math.min(STEPS.length - 1, S.stepIdx + delta));
  history.pushState({ s: S.stepIdx }, '');
  if (PREVIEW) {
  S.id = 'preview';
  S.group = PREVIEW;
}
enterStep();
}
const next = () => go(1);
const prev = () => go(-1);
function nextBtn(label = '다음', id = 'next') {
  return `<div class="actions"><button class="btn primary" id="${id}">${label}</button></div>`;
}
function bindBack() {
  document.getElementById('back')?.addEventListener('click', prev);
}

// 일러스트: 파랑·민트의 단순한 기하 도형이 겹치는 아이콘 스타일 (직접 만든 도형. 겹친 부분만 그라데이션). 대문·탈락·종료 화면에서 쓴다.
const ILLUS = {
  welcome: `<svg class="illus" viewBox="0 0 220 160" aria-hidden="true"><defs><linearGradient id="grw" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f5bf5"/><stop offset="1" stop-color="#44e29a"/></linearGradient><clipPath id="cpw"><rect x="62" y="12" width="76" height="136" rx="20"/></clipPath></defs><g fill="#44e29a"><circle cx="148" cy="106" r="42"/></g><g fill="#2f5bf5"><rect x="62" y="12" width="76" height="136" rx="20"/></g><g clip-path="url(#cpw)" fill="url(#grw)" opacity=".92"><circle cx="148" cy="106" r="42"/></g><rect x="78" y="34" width="44" height="9" rx="4.5" fill="#fff"/><rect x="78" y="52" width="30" height="9" rx="4.5" fill="#fff"/><rect x="78" y="70" width="44" height="9" rx="4.5" fill="#fff" opacity=".9"/><rect x="88" y="132" width="24" height="6" rx="3" fill="#fff"/><circle cx="34" cy="38" r="7" fill="#44e29a"/><circle cx="188" cy="40" r="5" fill="#2f5bf5"/></svg>`,
  pre: `<svg class="illus" viewBox="0 0 220 160" aria-hidden="true"><defs><linearGradient id="grp" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f5bf5"/><stop offset="1" stop-color="#44e29a"/></linearGradient><clipPath id="cpp"><path d="M86 42Q76 36 76 48L76 112Q76 124 86 118L148 86Q158 80 148 74Z"/></clipPath></defs><g fill="#44e29a"><circle cx="138" cy="86" r="48"/></g><g fill="#2f5bf5"><path d="M86 42Q76 36 76 48L76 112Q76 124 86 118L148 86Q158 80 148 74Z"/></g><g clip-path="url(#cpp)" fill="url(#grp)" opacity=".92"><circle cx="138" cy="86" r="48"/></g><circle cx="190" cy="34" r="6" fill="#44e29a"/><circle cx="26" cy="120" r="5" fill="#2f5bf5"/></svg>`,
  out: `<svg class="illus" viewBox="0 0 220 160" aria-hidden="true"><defs><linearGradient id="gro" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f5bf5"/><stop offset="1" stop-color="#44e29a"/></linearGradient><clipPath id="cpo"><path d="M80 128C34 98 28 66 44 50C58 36 78 42 80 60C86 42 106 36 120 50C136 66 128 98 80 128Z"/></clipPath></defs><g fill="#44e29a"><path transform="translate(58 14)" d="M80 128C34 98 28 66 44 50C58 36 78 42 80 60C86 42 106 36 120 50C136 66 128 98 80 128Z"/></g><g fill="#2f5bf5"><path d="M80 128C34 98 28 66 44 50C58 36 78 42 80 60C86 42 106 36 120 50C136 66 128 98 80 128Z"/></g><g clip-path="url(#cpo)" fill="url(#gro)" opacity=".92"><path transform="translate(58 14)" d="M80 128C34 98 28 66 44 50C58 36 78 42 80 60C86 42 106 36 120 50C136 66 128 98 80 128Z"/></g><circle cx="190" cy="30" r="6" fill="#2f5bf5"/><circle cx="24" cy="124" r="5" fill="#44e29a"/></svg>`,
  done: `<svg class="illus" viewBox="0 0 220 160" aria-hidden="true"><defs><linearGradient id="grd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f5bf5"/><stop offset="1" stop-color="#44e29a"/></linearGradient><clipPath id="cpd"><rect x="40" y="26" width="104" height="104" rx="28"/></clipPath></defs><g fill="#44e29a"><circle cx="146" cy="104" r="46"/></g><g fill="#2f5bf5"><rect x="40" y="26" width="104" height="104" rx="28"/></g><g clip-path="url(#cpd)" fill="url(#grd)" opacity=".92"><circle cx="146" cy="104" r="46"/></g><path d="M68 80L92 104L128 56" stroke="#fff" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="26" cy="40" r="6" fill="#44e29a"/><circle cx="196" cy="30" r="5" fill="#2f5bf5"/></svg>`,
};

// 대문(웰컴) 화면: 딱딱한 동의서 이전에 연구가 어떤 것인지 가볍게 알려 주고 시작을 누르게 한다.
function renderWelcome() {
  const lab = MODE === 'lab';
  frame(
    `<section class="welcome">
       <div class="wl-hero">${ILLUS.welcome}</div>
       <p class="wl-kicker">${esc(CONFIG.STUDY_TITLE)}</p>
       <h1 class="wl-title">안녕하세요.<br>연구에 관심 가져 주셔서<br>감사합니다</h1>
       <p class="wl-sub">${lab ? '연구자와 함께 진행하는 현장 참여입니다.' : '모바일 금융 앱 화면을 보고 느끼는 점을 알아보는 연구예요.'}</p>
       ${inappNotice()}
       <ul class="wl-facts">
         <li><span>${ICON.clock}</span>약 ${CONFIG.TARGET_MIN}~${CONFIG.TARGET_MAX}분이면 끝나요</li>
         <li><span>${ICON.lock}</span>응답은 익명으로만 사용돼요</li>
         <li><span>${ICON.check}</span>언제든 그만두실 수 있어요</li>
       </ul>
       <button class="btn primary wl-btn" id="welcome-go">시작하기</button>
       <p class="wl-foot">다음 화면에서 연구 안내를 확인하고 동의하실 수 있어요</p>
     </section>`,
    { progress: false }
  );
  document.getElementById('openext')?.addEventListener('click', () => (location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href)));
  document.getElementById('welcome-go').addEventListener('click', () => {
    S._welcomed = true;
    renderConsent();
  });
}

// ---------- 동의 / 스크리닝 ----------
function renderConsent() {
  const done = (() => {
    try {
      return !!localStorage.getItem('cfx_participated');
    } catch {
      return false;
    }
  })();
  if (done && !DEBUG && !DESIGN && MODE === 'online') {
    frame(`<h1 class="h1">이미 참여하셨어요</h1><p class="lead">이 브라우저에서 이미 연구에 참여하신 기록이 있습니다. 한 분당 한 번만 참여할 수 있어 중복 참여는 어렵습니다. 감사합니다.</p>`, { progress: false });
    return;
  }
  try {
    if (!DEBUG && !DESIGN && MODE === 'online' && localStorage.getItem('cfx_screenedout')) return renderScreenedOut();
  } catch {}
  const lab = MODE === 'lab';
  if (!S._welcomed) return renderWelcome();
  frame(
    `<h1 class="h1">연구 참여 안내와 동의</h1>
     <p class="lead">${lab ? '연구자와 함께 진행하는 현장 참여입니다.' : '아래 내용을 읽고 동의해 주세요.'}</p>
     <div class="card flat consent">
       <p>본 조사는 모바일 금융 앱 화면을 보고 자산 상태를 어떻게 판단하는지 알아보는 학술 연구입니다.</p>
       <ul>
         <li>소요 시간은 약 ${CONFIG.TARGET_MAX}분입니다.</li>
         <li>응답은 익명으로 처리되며 연구 목적으로만 사용됩니다. 이름과 같은 개인 식별 정보는 저장하지 않습니다.</li>
         <li>입력하신 금액은 화면 구성에만 쓰이며 실제 금융 정보와 연동되지 않습니다.</li>
         <li>언제든 중단할 수 있고, 중단해도 불이익은 없습니다.</li>
         ${lab ? '<li>시선 추적 장비로 화면을 보는 동안의 시선이 기록됩니다.</li>' : ''}
       </ul>
       <dl class="rinfo">
         <dt>연구자 :</dt><dd>${esc(CONFIG.RESEARCHER_CONTACT)}</dd>
         <dt>연락처 :</dt><dd>${mailHTML()}</dd>
         <dt>생명윤리위원회 심의 :</dt><dd>${esc(CONFIG.IRB_NUMBER)}</dd>
       </dl>
     </div>
     ${lab && PID ? `<p class="small muted">참가자 ID: <b>${esc(PID)}</b></p>` : ''}
     <label class="agree"><input type="checkbox" id="agree"><span class="box">${ICON.check}</span><span>${lab ? '현장에서 서면 동의를 받았음을 확인합니다 (연구자 확인).' : '위 내용을 읽었으며 연구 참여에 동의합니다.'}</span></label>
     <div class="actions"><button class="btn primary" id="next" disabled>동의하고 시작하기</button></div>`,
    { progress: false, back: true }
  );
  document.getElementById('back')?.addEventListener('click', () => {
    S._welcomed = false;
    renderConsent();
  });
  const agree = document.getElementById('agree');
  const btn = document.getElementById('next');
  document.getElementById('openext')?.addEventListener('click', () => (location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href)));
  if (DESIGN) {
    agree.checked = true;
    btn.disabled = false;
  }
  agree.addEventListener('change', () => (btn.disabled = !agree.checked));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '준비 중…';
    try {
      const r = await store.startSession({ mode: MODE, pid: PID, forceGroup: FORCE_GROUP, device: deviceInfo() });
      S.id = r.id;
      S.group = r.group;
      log('consent', { agreed: true });
      await store.savePart(S.id, 'screen', { consent: true, consent_ts: new Date().toISOString() }, 'consented');
      next();
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      btn.textContent = '동의하고 시작하기';
      toast('연결에 문제가 있어요. 잠시 후 다시 눌러 주세요.');
    }
  });
}

function renderScreening() {
  frame(
    `<h1 class="h1">참여 조건 확인</h1><p class="lead">몇 가지만 확인할게요.</p>
     <form id="f">${Q.SCREENING.map(itemHTML).join('')}</form>${nextBtn()}`,
    { back: false }
  );
  const f = document.getElementById('f');
  Q.SCREENING.forEach((it) => restore(it, f, S.screen));
  const markDone = () => {
    for (const it of Q.SCREENING) {
      const box = f.querySelector(`[data-qid="${it.id}"]`);
      const ok = readItem(it, f) !== null;
      box.classList.toggle('done', ok);
      if (ok) box.classList.remove('missing');
    }
  };
  f.addEventListener('input', markDone);
  f.addEventListener('change', markDone);
  f.addEventListener('keyup', markDone);
  markDone();
  document.getElementById('next').addEventListener('click', async () => {
    const { out, firstMissing } = collectItems(Q.SCREENING, f);
    if (firstMissing) {
      firstMissing.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return toast('답하지 않은 문항이 있어요.');
    }
    Object.assign(S.screen, out);
    const passed = Q.SCREENING.every((it) => it.pass(out[it.id]));
    await store.savePart(S.id, 'screen', { ...S.screen, consent: true, passed }, passed ? 'screened' : 'screened_out');
    if (!passed) {
      clearSaved();
      leaveStep();
      try {
        if (!DESIGN) localStorage.setItem('cfx_screenedout', '1'); // 같은 브라우저에서 답을 바꿔 다시 들어오는 것을 막는다
      } catch {}
      renderScreenedOut();
      await flushEvents();
      return;
    }
    next();
  });
}

// 참여 조건에 맞지 않을 때: 개인 평가처럼 들리지 않게 쓰고, 어떤 문항 때문인지는 알리지 않는다. 링크 복사로 주변의 해당자에게 공유를 청한다.
function renderScreenedOut() {
  frame(
    `${ILLUS.out}<h1 class="h1 center">관심 가져 주셔서<br>감사합니다</h1>
     <div class="card flat consent">
       <p>이번 연구는 연구 설계상 정해진 대상을 모집하고 있어, 이번에는 함께하기 어렵습니다.</p>
       <p><b>대상</b><br>${esc(CONFIG.TARGET_DESC)}</p>
       <p>주변에 해당되는 분이 계시다면 링크를 공유해 주세요.</p>
     </div>
     <div class="actions"><button class="btn primary" id="copylink">링크 복사</button></div>`,
    { progress: false }
  );
  document.getElementById('copylink').addEventListener('click', () => copyText(location.origin + location.pathname, '링크를 복사했어요.'));
}
function mailHTML() {
  const m = esc(CONFIG.RESEARCHER_EMAIL);
  return `<a class="mail-link" href="mailto:${m}">${ICON.mail}<span>${m}</span></a>`;
}
function contactHTML() {
  return `${esc(CONFIG.RESEARCHER_CONTACT)} ${mailHTML()}`;
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    t.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(t);
    t.select();
    try {
      document.execCommand('copy');
      toast(msg);
    } catch {
      toast('복사하지 못했어요. 직접 선택해 복사해 주세요.');
    }
    t.remove();
  }
}

function renderLabStart() {
  frame(
    `<h1 class="h1">실험을 시작합니다</h1>
     <p class="lead">참가자 ID <b>${esc(PID || '(미지정)')}</b></p>
     <p class="muted">사전 설문은 이미 마친 상태입니다. 연구자의 안내에 따라 진행해 주세요.</p>
     <label class="agree"><input type="checkbox" id="agree"><span class="box">${ICON.check}</span><span>현장에서 서면 동의를 받았음을 확인합니다 (연구자 확인).</span></label>
     <div class="actions"><button class="btn primary" id="next" disabled>시작하기</button></div>`,
    { progress: false }
  );
  const agree = document.getElementById('agree');
  const btn = document.getElementById('next');
  agree.addEventListener('change', () => (btn.disabled = !agree.checked));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await store.startSession({ mode: MODE, pid: PID, forceGroup: FORCE_GROUP, device: deviceInfo() });
      S.id = r.id;
      S.group = r.group;
      await store.savePart(S.id, 'screen', { consent: true, consent_ts: new Date().toISOString(), stage: 'exp' }, 'consented');
      next();
    } catch (e) {
      btn.disabled = false;
      toast('연결에 문제가 있어요. 다시 눌러 주세요.');
    }
  });
}

// ---------- 실험 안내 (화면 1) ----------
function flowCard() {
  const has = (f) => STEPS.some(f);
  const rows = [];
  if (has((id) => PRE_IDS.has(id))) rows.push(['사전 질문', `기본 정보와 금융 경험 (${Q.PRE_PAGES.length}쪽)`]);
  if (has((id) => id === 'asset')) rows.push(['금액 입력', '가상 화면에 쓰일 투자 금액']);
  if (has((id) => id === 'stimulus')) rows.push(['화면 보기', '가상의 투자 앱 화면을 둘러봅니다']);
  if (has((id) => POST_IDS.has(id))) rows.push(['설문', `짧은 설문 (${Q.POST_PAGES.length}쪽) 후 종료`]);
  return `<section class="flowcard" aria-label="진행 순서"><h2>진행 순서</h2><ol>${rows
    .map((r, i) => `<li><span class="fn">${i + 1}</span><b>${esc(r[0])}</b><em>${esc(r[1])}</em></li>`)
    .join('')}</ol></section>`;
}

function renderGuide() {
  const lab = MODE === 'lab';
  const items = [
    ['자연스러운 화면 탐색', '정해진 정답은 없습니다. 평소 모바일 앱을 사용하시듯 자유롭게 시선을 이동하며 탐색해 주세요.'],
    ['가상 금융 시뮬레이션', '화면에 표시되는 자산 및 변동 내역은 연구용 가상 데이터이며 실제 금융 정보와는 무관합니다.'],
    lab
      ? ['예상 소요 시간 및 집중 안내', `실험은 약 ${CONFIG.TARGET_MIN}~${CONFIG.TARGET_MAX}분 정도 소요되며,\n시선 추적 장비의 안정적인 기록을 위해\n머리의 움직임을 최소화해 주세요.`]
      : ['예상 소요 시간 및 진행 안내', `약 ${CONFIG.TARGET_MIN}~${CONFIG.TARGET_MAX}분 걸리며, 중간에 나가지 말고 한 번에 마쳐 주세요.\n뒤로 가기나 새로고침은 하지 말아 주세요.`],
  ];
  frame(
    `<h1 class="h1">원활한 실험 진행을 위해<br>안내사항을 확인해 주세요</h1>
     ${flowCard()}
     <ol class="guide">${items
       .map(
         (it) => `<li><div><h3>${esc(it[0])}</h3><p>${nl2br(it[1])}</p></div></li>`
       )
       .join('')}</ol>${nextBtn('확인했어요')}`,
    { back: false }
  );
  document.getElementById('next').addEventListener('click', next);
}

// ---------- 설문 쪽 (사전/사후 공통) ----------
function renderSurveyPage(page, bucket, { saveAs, doneStatus, back }) {
  if (!S.orders[page.id]) S.orders[page.id] = (page.shuffle ? shuffle(page.items) : page.items).map((i) => i.id);
  const items = S.orders[page.id].map((id) => page.items.find((i) => i.id === id)).filter((i) => !(MODE === 'lab' && i.id === 'AC1'));
  const isPre = bucket === S.pre;
  const pages = isPre ? Q.PRE_PAGES : Q.POST_PAGES;
  const pageNo = pages.findIndex((p) => p.id === page.id) + 1;
  const hasLikert = items.some((i) => i.type === 'likert');
  const guideHTML = `<div class="guidebox">
      ${page.guide ? `<p>${fmt(page.guide)}</p>` : ''}
      ${hasLikert ? '<p class="legend"><b>1~7</b> 중 하나를 눌러 주세요. 숫자가 클수록 <b>오른쪽 설명</b>에 가깝습니다.</p>' : ''}
    </div>`;
  frame(
    `<div class="titlerow"><h1 class="h1">${esc(page.title)}</h1><div class="tmeta"><span class="eyebrow">${pageNo}/${pages.length}</span></div></div>
     ${page.intro ? `<p class="lead">${fmt(page.intro)}</p>` : ''}
     ${page.guide || hasLikert ? guideHTML : ''}
     <form id="f">${items.map(itemHTML).join('')}</form>
     <div class="actions"><button class="btn primary withcount" id="next"><span>다음</span><span class="bc"><b id="cnt">0</b> / ${items.length}</span></button></div>`,
    { back }
  );
  bindBack();
  const f = document.getElementById('f');
  items.forEach((it) => restore(it, f, bucket));
  const refresh = () => {
    let n = 0;
    for (const it of items) {
      const ok = readItem(it, f) !== null;
      const box = f.querySelector(`[data-qid="${it.id}"]`);
      box.classList.toggle('done', ok);
      if (ok) {
        n++;
        box.classList.remove('missing');
      }
    }
    for (const it of items) {
      const v = readItem(it, f);
      if (v !== null) bucket[it.id] = v;
    }
    persist();
    document.getElementById('cnt').textContent = n;
    document.getElementById('next').classList.toggle('full', n === items.length);
  };
  f.addEventListener('input', refresh);
  f.addEventListener('change', refresh);
  refresh();
  document.getElementById('next').addEventListener('click', async () => {
    const { out, firstMissing } = collectItems(items, f);
    if (firstMissing) {
      firstMissing.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const k = f.querySelectorAll('.q.missing').length;
      return toast(`답하지 않은 문항이 ${k}개 있어요.`);
    }
    Object.assign(bucket, out);
    const payload = { ...bucket, _order: { ...(bucket._order || {}), [page.id]: S.orders[page.id] } };
    bucket._order = payload._order;
    const lastPre = isPre && page.id === Q.PRE_PAGES[Q.PRE_PAGES.length - 1].id;
    const lastPost = !isPre && page.id === Q.POST_PAGES[Q.POST_PAGES.length - 1].id;
    leaveStep();
    await store.savePart(S.id, saveAs, payload, lastPre ? 'pre_done' : lastPost ? 'post_done' : null);
    if (lastPost) await store.savePart(S.id, 'timing', S.timing, null);
    S.stepIdx++;
    history.pushState({ s: S.stepIdx }, '');
    flushEvents();
    enterStep();
  });
}

// ---------- 전환 안내 (화면 보기 직전 / 직후) ----------
// 모든 집단에 같은 문구를 보여 준다. 차트·수익률·수치에 대한 언급은 일부러 넣지 않는다 (주의를 특정 요소로 유도하지 않기 위해).
function renderPreStim() {
  // 진입 직전 화면: 밝은 톤은 유지하되 큰 일러스트와 다른 구성으로 '곧 화면 보기가 시작된다'는 인지를 준다.
  frame(
    `<section class="pre-go">
       <div class="pg-top"><span class="pg-tag">${esc(PHASES[2].label)}</span><span class="pg-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
       ${ILLUS.pre}
       <h1 class="pg-title">곧 가상의 투자 앱<br>화면이 시작됩니다</h1>
       <p class="pg-sub">아래 세 가지만 기억해 주세요</p>
       <ol class="pg-list">
         <li><span>1</span><div><b>자유롭게 둘러보기</b><p>평소 앱을 쓰시듯 살펴보세요. 정답은 없습니다.</p></div></li>
         <li><span>2</span><div><b>‘다음’ 버튼</b><p>충분히 살펴보면 화면 아래에 켜집니다.</p></div></li>
         <li><span>3</span><div><b>이어서 설문</b><p>화면을 본 뒤 짧은 설문이 이어집니다.</p></div></li>
       </ol>
       <p class="pg-note">넘어간 뒤에는 이 화면으로 돌아올 수 없어요</p>
       <button class="btn primary pg-btn" id="next">화면 보기 시작</button>
     </section>`,
    { progress: false, wide: true }
  );
  document.getElementById('next').addEventListener('click', next);
}

function renderPostStart() {
  const n = Q.POST_PAGES.reduce((a, p) => a + p.items.filter((i) => !(MODE === 'lab' && i.id === 'AC1')).length, 0);
  frame(
    `<div class="eyebrow">화면 보기 완료</div>
     <h1 class="h1">화면 보기가 끝났어요.<br><mark class="hl">이제 설문 단계</mark>입니다</h1>
     <p class="lead">방금 보신 화면을 떠올리며 답해 주세요. 앞 화면으로 돌아가 다시 볼 수는 없어요.</p>
     <section class="flowcard"><ol>
       <li><span class="fn">✓</span><b>화면 보기</b><em>완료</em></li>
       <li class="cur"><span class="fn">▶</span><b>설문</b><em>${Q.POST_PAGES.length}쪽 · 문항 ${n}개</em></li>
       <li><span class="fn">·</span><b>종료</b><em>설문을 마치면 끝납니다</em></li>
     </ol></section>
     <p class="note">정답은 없습니다. 떠오르는 대로 솔직하게 답해 주시면 됩니다.</p>
     ${nextBtn('설문 시작')}`
  );
  document.getElementById('next').addEventListener('click', next);
}

// ---------- 투자 금액 입력 (화면 2) ----------
function renderAsset() {
  const a = S.asset;
  frame(
    `<h1 class="h1">현재 투자 중인 총 자산을<br>입력해 주세요</h1>
     <p class="note">입력하신 금액은 가상 금융 시뮬레이션을 위해서만 사용됩니다.<br>실제 금융 데이터가 연동되거나 저장되지 않으니 안심하세요.</p>
     <label class="fld"><span>이름</span><input id="name" class="inp" type="text" maxlength="12" placeholder="이름을 입력해주세요" autocomplete="off" value="${esc(a.name)}"></label>
     <label class="fld"><span>현재 총 투자 자산</span>
       <div class="inp amt"><input id="amount" type="text" inputmode="numeric" placeholder="0" autocomplete="off" value="${a.amount ? wonPlain(a.amount) : ''}"><em>원</em></div></label>
     <p class="hint" id="amt-hint">${wonPlain(Q.ASSET_MIN)}원 이상 ${wonPlain(Q.ASSET_MAX)}원 이하로 입력해 주세요.</p>
     <div class="quick">${Q.QUICK_ADD.map((q, i) => `<button type="button" class="chip" data-add="${q.v}">${q.label}</button>`).join('')}</div>
     <p class="label2">주요 관심 투자 분야 (다중 선택 가능)</p>
     <div class="interests">${Q.INTERESTS.map(
       (o) => `<label class="intr"><input type="checkbox" value="${o.id}" ${a.interests.includes(o.id) ? 'checked' : ''}>
         <div><h3>${esc(o.title)}</h3><p>${esc(o.desc)}</p></div><span class="ring">${ICON.check}</span></label>`
     ).join('')}</div>
     ${nextBtn('다음')}`,
    { back: true }
  );
  bindBack();
  const amt = document.getElementById('amount');
  const hint = document.getElementById('amt-hint');
  const read = () => Number(amt.value.replace(/[^0-9]/g, '')) || 0;
  const fmt = () => {
    const v = read();
    amt.value = v ? wonPlain(v) : '';
    hint.classList.remove('err');
  };
  amt.addEventListener('input', fmt);
  document.querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => {
      amt.value = wonPlain(Math.min(Q.ASSET_MAX, read() + Number(b.dataset.add)));
      hint.classList.remove('err');
    })
  );
  document.getElementById('next').addEventListener('click', async () => {
    const v = read();
    const name = document.getElementById('name').value.trim();
    const interests = [...document.querySelectorAll('.intr input:checked')].map((i) => i.value);
    if (!name) return toast('이름을 입력해 주세요.');
    if (v < Q.ASSET_MIN || v > Q.ASSET_MAX) {
      hint.classList.add('err');
      return toast('투자 금액 범위를 확인해 주세요.');
    }
    if (!interests.length) return toast('관심 분야를 하나 이상 선택해 주세요.');
    S.asset = { amount: v, interests, name };
    S.stim = buildStimulus(S.group, v, new Date(), CONFIG.END_MONTH);
    leaveStep();
    // 이름은 저장하지 않는다 (화면 인사말에만 사용)
    await store.savePart(S.id, 'asset', { amount: v, interests }, 'asset_done');
    S.stepIdx++;
    history.pushState({ s: S.stepIdx }, '');
    if (PREVIEW) {
  S.id = 'preview';
  S.group = PREVIEW;
}
enterStep();
  });
}

// ---------- 자극물 (화면 3 홈 → 화면 4 자산 현황) ----------
const NEWS = [
  ['글로벌', '마켓데일리 · 15분 전', '美 연준, 기준금리 동결 시사... 기술주 일제히 반등'],
  ['마이데이터', '머니리포트 · 1시간 전', 'Cashflow, AI 기반 맞춤 포트폴리오 진단 서비스 정식 오픈'],
  ['배당/채권', '투자뉴스랩 · 3시간 전', '고배당 ETF로 몰리는 투자금... 월배당 상품 인기 지속'],
];
const PICKS = [
  ['A', '#111', 'Apple', 'AAPL', '272,400원', '+2.45%'],
  ['T', '#e03131', 'Tesla', 'TSLA', '284,500원', '+4.12%'],
  ['S', '#1c4ed8', '삼성전자', '005930', '79,800원', '+0.76%'],
];

function assetCard(st, { cta = false } = {}) {
  return `<section class="card asset-card">
    <div class="row between"><span class="lbl">내 자산</span><span class="badge"><i></i>마이데이터 실시간</span></div>
    <div class="big">${won(st.current)}</div>
    <div class="sub"><span class="coin">${ICON.coin}</span>원금 ${won(st.N)}<span class="sep">·</span><span class="up">${ICON.up} +${won(st.gain)} (+${pct(st.gainPct)})</span></div>
    ${cta ? `<button class="cta" id="open-status">${ICON.trend}<span>내 자산 현황 보기</span>${ICON.chev}</button>` : ''}
  </section>`;
}

function renderStimulus() {
  S.stimState.view = 'home';
  // 짧은 로딩(약 0.5초): 이제 가상 앱 화면으로 들어간다는 것을 느끼게 한다. 모든 집단 동일, 내용 언급 없음.
  frame(`<div class="enter-load" role="status" aria-live="polite"><span class="spin" aria-hidden="true"></span><p>화면을 불러오는 중…</p></div>`, { progress: false, wide: true });
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => {
    if (currentStepId() === 'stimulus' && S.stimState.view === 'home' && document.querySelector('.enter-load')) showHome();
  }, DESIGN || DEBUG ? 500 : 600);
}
let enterTimer = null;

function showHome() {
  const st = S.stim;
  S.stimState.view = 'home';
  S.stimState.enteredAt = performance.now();
  frame(
    `<div class="home">
      <header class="home-head"><div class="logo"><span class="lc">C</span><span class="lf">f</span><b>${esc(CONFIG.APP_NAME)}</b></div><button class="bellbtn" aria-label="알림">${ICON.bell}</button></header>
      <h1 class="greet">${esc(S.asset.name)}님,<br><span>오늘의 자산 현황을 확인하세요</span></h1>
      ${assetCard(st, { cta: true })}
      <section class="card div-row"><span><i class="gdot"></i>예상 연간 배당금</span><b>${won(st.dividend)}</b></section>
      <div class="sec-h"><div><h2>맞춤 추천 상품</h2><p>선택하신 투자 성향에 맞춘 인기 종목</p></div>${ICON.chev}</div>
      <div class="list">${PICKS.map(
        (p) => `<div class="card pick"><span class="av" style="background:${p[1]}">${p[0]}</span><div class="nm"><b>${esc(p[2])}</b><small>${esc(p[3])}</small></div><div class="pr"><b>${p[4]}</b><span class="up">${p[5]}</span></div></div>`
      ).join('')}</div>
      <div class="sec-h"><div><h2>주요 시장 뉴스</h2><p>실시간 금융 시장 핵심 이슈 브리핑</p></div>${ICON.chev}</div>
      <div class="list">${NEWS.map(
        (n) => `<div class="card news"><div class="meta"><span class="tag">${esc(n[0])}</span><small>${esc(n[1])}</small></div><p>${esc(n[2])}</p></div>`
      ).join('')}</div>
    </div>`,
    { progress: false, wide: true }
  );
  const openBtn = document.getElementById('open-status');
  openBtn.addEventListener('click', () => {
    S.stimState.homeMs += performance.now() - S.stimState.enteredAt;
    showStatus();
  });
  // 진입과 동시에 버튼이 눌러 볼 수 있는 곳임을 부드럽게 알려 준다 (차트·수익률 등 내용은 언급하지 않는다. 모든 집단 동일).
  openBtn.classList.add('nudge');
  openBtn.parentElement.insertAdjacentHTML('beforeend', '<span class="cta-tip" aria-hidden="true">눌러서 이동해 보세요</span>');
  log('cta_nudge');
  attachStimLogging();
}

let tickTimer = null;
function showStatus() {
  const st = S.stim;
  const ss = S.stimState;
  ss.view = 'status';
  S.exposed = true;
  ss.statusEntries++;
  ss.enteredAt = performance.now();
  ss.visibleSince = document.visibilityState === 'visible' ? performance.now() : null;
  const chart = chartSVG(st);
  const need = MIN_EXPOSURE * 1000;
  frame(
    `<div class="status ${SHOW_AOI ? 'show-aoi' : ''}">
      <header class="sub-head"><button class="iconbtn" id="sback" aria-label="이전">${ICON.back}</button><h1>내 자산 현황</h1><span></span></header>
      ${assetCard(st)}
      <section class="chart-card" id="chart-card" data-aoi="chart">${chart.svg}</section>
      <div class="tabs" role="tablist">${['1D', '1W', '1M', '6M', '1Y', 'ALL']
        .map((t) => `<button class="tab ${t === '6M' ? 'on' : ''}" data-tab="${t}" ${t === '6M' ? 'aria-selected="true"' : ''}>${t}</button>`)
        .join('')}</div>
      <div class="sec-h plain"><h2>월간 평가액 리포트</h2><small>단위 (원)</small></div>
      <div class="list">${st.monthly
        .map(
          (m, i) => `<div class="card rep" data-m="${m.month}">
            <div class="rep-top"><span class="mdot">${m.month}</span>
              <div class="rt"><b>${m.month}월 월간 평가액</b><small>누적 수익률 +${pct(m.cumRet)}</small></div>
              <div class="rv"><b>${wonPlain(m.value)}원</b><span class="up">+${wonPlain(m.delta)}원</span></div></div>
            <button class="det" data-det="${m.month}">상세 내역 ${ICON.down}</button>
            <div class="det-body" hidden><div><span>원금</span><b>${wonPlain(m.principal)}원</b></div><div><span>평가손익</span><b class="up">+${wonPlain(m.gain)}원</b></div><div><span>월 증가분</span><b class="up">+${wonPlain(m.delta)}원</b></div></div>
          </div>`
        )
        .join('')}</div>
      <div class="nextbar hold" id="nextbar" aria-hidden="true"><button class="btn primary" id="snext" disabled>다음</button></div>
    </div>`,
    { progress: false, wide: true }
  );
  document.getElementById('sback').addEventListener('click', () => {
    pauseChartClock();
    log('status_back');
    showHome();
  });
  document.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      log('tab_click', { tab: b.dataset.tab });
      if (b.dataset.tab !== '6M') toast('이번 화면에서는 6M만 볼 수 있어요.'); // 눌렀는데 반응이 없어 헷갈리는 것을 막는다
    })
  );
  document.querySelectorAll('.det').forEach((b) =>
    b.addEventListener('click', () => {
      const body = b.parentElement.querySelector('.det-body');
      body.hidden = !body.hidden;
      log('detail_toggle', { month: b.dataset.det, open: !body.hidden });
    })
  );
  attachStimLogging();
  measureAOI(chart.geometry);
  startChartClock(need);
  document.getElementById('snext').addEventListener('click', finishStimulus);
}

function pauseChartClock() {
  const ss = S.stimState;
  if (ss.visibleSince) {
    ss.chartMs += performance.now() - ss.visibleSince;
    ss.visibleSince = null;
  }
  clearInterval(tickTimer);
}
function currentChartMs() {
  const ss = S.stimState;
  return ss.chartMs + (ss.visibleSince ? performance.now() - ss.visibleSince : 0);
}
function startChartClock(need) {
  // 최소 노출 시간이 지나기 전에는 남은 시간을 숫자로 보여 주지 않는다 (시계를 보게 하거나 '그 시간만큼 보라'는 신호가 되는 것을 피함).
  //  - CONFIG.NEXT_STYLE = 'reveal'(기본): 시간이 되면 하단에서 '다음' 버튼이 부드럽게 올라온다. 앱에서 콘텐츠가 준비되면 버튼이 나타나는 것과 같은 느낌.
  //  - CONFIG.NEXT_STYLE = 'fill': 버튼이 처음부터 보이고 비활성인 동안 안쪽이 서서히 차오른다.
  const btn = document.getElementById('snext');
  const bar = document.getElementById('nextbar');
  const style = CONFIG.NEXT_STYLE === 'fill' ? 'fill' : 'reveal';
  let first = true;
  const upd = () => {
    const done = need <= 0 ? 1 : Math.min(1, currentChartMs() / need);
    const ready = done >= 1;
    btn.disabled = !ready;
    if (style === 'fill') {
      bar.classList.remove('hold');
      bar.removeAttribute('aria-hidden');
      btn.style.setProperty('--p', Math.round(done * 100) + '%');
      btn.classList.toggle('timed', !ready);
    } else {
      if (ready && first) bar.classList.add('instant'); // 이미 시간을 채우고 다시 들어온 경우엔 애니메이션 없이 바로 보여 준다
      bar.classList.toggle('hold', !ready);
      if (ready) bar.removeAttribute('aria-hidden');
      else bar.setAttribute('aria-hidden', 'true');
    }
    first = false;
    if (S.stimState.view === 'status' && ++upd.n % 20 === 0) persist();
  };
  upd.n = 0;
  upd();
  clearInterval(tickTimer);
  tickTimer = setInterval(upd, 100);
}

// AOI(관심 영역) 좌표를 문서 기준(px)으로 기록한다. 아이트래커 좌표와 맞출 때 쓴다.
function measureAOI(geom) {
  requestAnimationFrame(() => {
    const rects = {};
    document.querySelectorAll('[data-aoi]').forEach((el) => {
      const r = el.getBoundingClientRect();
      rects[el.dataset.aoi] = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
    });
    S.stimState.aoi = {
      viewport: { w: innerWidth, h: innerHeight },
      scroll: { x: scrollX, y: scrollY },
      doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      rects,
      chart: geom,
    };
    log('aoi', { aoi: S.stimState.aoi });
  });
}

let stimBound = false;
function attachStimLogging() {
  if (stimBound) return;
  stimBound = true;
  let lastScroll = 0;
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (currentStepId() !== 'stimulus') return;
      const t = e.target.closest?.('[data-aoi],button,.card,svg') || e.target;
      log('touch', {
        view: S.stimState.view,
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        px: Math.round(e.pageX),
        py: Math.round(e.pageY),
        sy: Math.round(scrollY),
        tgt: t.dataset?.aoi || t.id || t.className?.baseVal || t.className || t.tagName,
      });
    },
    true
  );
  window.addEventListener(
    'scroll',
    () => {
      if (currentStepId() !== 'stimulus') return;
      const now = performance.now();
      if (now - lastScroll < 150) return;
      lastScroll = now;
      const c = document.getElementById('chart-card')?.getBoundingClientRect();
      log('scroll', { view: S.stimState.view, sy: Math.round(scrollY), chart_top: c ? Math.round(c.top) : null, chart_h: c ? Math.round(c.height) : null, vh: innerHeight });
    },
    { passive: true }
  );
}

async function finishStimulus() {
  pauseChartClock();
  const ss = S.stimState;
  const st = S.stim;
  leaveStep();
  const meta = {
    group: st.group,
    amount: st.N,
    axis: { lo: st.lo, hi: st.hi, ticks: st.ticks },
    series: st.series.map((p) => ({ label: p.label, value: Math.round(p.value) })),
    months: st.months,
    occupancy: st.occupancy,
    lie_factor: st.lieFactor,
    min_exposure_sec: MIN_EXPOSURE,
    chart_ms: Math.round(ss.chartMs),
    home_ms: Math.round(ss.homeMs),
    status_entries: ss.statusEntries,
    aoi: ss.aoi || null,
    viewport_end: { w: innerWidth, h: innerHeight },
  };
  await store.savePart(S.id, 'stimulus', meta, 'stimulus_done');
  await flushEvents();
  S.stepIdx++;
  history.pushState({ s: S.stepIdx }, '');
  if (PREVIEW) {
  S.id = 'preview';
  S.group = PREVIEW;
}
enterStep();
}

document.addEventListener('visibilitychange', () => {
  log('visibility', { state: document.visibilityState });
  const ss = S.stimState;
  if (currentStepId() === 'stimulus' && ss.view === 'status') {
    if (document.visibilityState === 'hidden' && ss.visibleSince) {
      ss.chartMs += performance.now() - ss.visibleSince;
      ss.visibleSince = null;
    } else if (document.visibilityState === 'visible' && !ss.visibleSince) {
      ss.visibleSince = performance.now();
    }
  }
});

// ---------- 종료 ----------
function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

async function renderEnd() {
  S.code = S.code || makeCode();
  const lab = MODE === 'lab';
  frame(
    `${ILLUS.done}<h1 class="h1 center">참여해 주셔서 감사합니다</h1>
     <div class="card flat debrief">
       <p>시간 내어 참여해 주셔서 진심으로 감사드립니다. 응답은 익명으로 이 연구의 분석에만 사용되며, 다른 목적으로는 쓰이지 않습니다.</p>
       <p>화면에 나온 금액과 수익은 입력하신 금액으로 만든 <b>가상 자료</b>이며 실제 투자 성과와 무관합니다. 연구 목적과 결과는 자료 수집이 모두 끝난 뒤 이메일로 요청하시면 알려 드립니다.</p>
     </div>
     ${CONFIG.SHOW_COMPLETION_CODE ? `<div class="codebox"><small>참여 코드</small><b id="code">${S.code}</b><button class="btn ghost" id="copycode" type="button">코드 복사</button></div>` : ''}
     <div class="card flat withdraw">
       <h2>응답을 철회하고 싶다면</h2>
       <p>${esc(CONFIG.WITHDRAW_DEADLINE)}까지 연구자(${contactHTML()})에게 <b>참여 코드</b>와 함께 요청하시면, 해당 응답을 분석에서 제외하고 삭제합니다. 이름 등은 저장하지 않아 코드로만 찾을 수 있으니 코드를 꼭 보관해 주세요.</p>
       ${CONFIG.SHOW_COMPLETION_CODE ? `<a class="btn ghost" id="withdraw" href="mailto:${esc(CONFIG.RESEARCHER_EMAIL)}?subject=${encodeURIComponent('[철회 요청] 참여 코드 ' + S.code)}&body=${encodeURIComponent('참여 코드: ' + S.code + '\n위 코드의 응답을 연구에서 제외하고 삭제해 주세요.')}">이메일로 철회 요청</a>` : ''}
     </div>
     ${store.kind === 'local' ? '<div class="devbox"><p><b>로컬 모드</b>: 데이터가 이 브라우저에만 저장되어 있습니다.</p><button class="btn ghost" id="dl">데이터 내려받기 (JSON)</button> <button class="btn ghost" id="clr">로컬 데이터 지우기</button></div>' : ''}
     ${lab ? '<p class="muted">연구자에게 종료를 알려 주세요.</p>' : '<p class="muted">이 창은 닫으셔도 됩니다.</p>'}`,
    { progress: false }
  );
  document.getElementById('copycode')?.addEventListener('click', () => copyText(S.code, '참여 코드를 복사했어요.'));
  if (store.kind === 'local') {
    document.getElementById('dl').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(store.exportAll(), null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'cashflow_local_data.json';
      a.click();
    });
    document.getElementById('clr').addEventListener('click', () => {
      store.clear();
      toast('지웠어요.');
    });
  }
  window.__cfxDone = false;
  await store.savePart(S.id, 'timing', S.timing, null);
  await store.savePart(S.id, 'meta', { code: S.code, resumes: S.resumes || 0, app_version: APP_VERSION }, 'completed');
  clearSaved();
  await flushEvents();
  await store.flush();
  try {
    if (!DESIGN) localStorage.setItem('cfx_participated', new Date().toISOString());
  } catch {}
  window.__cfxDone = true;
}

async function renderEndPre() {
  frame(`<h1 class="h1">사전 설문이 끝났습니다</h1><p class="lead">참여해 주셔서 감사합니다. 실험 당일에는 연구자의 안내에 따라 이어서 진행해 주세요.</p>`, { progress: false });
  await store.savePart(S.id, 'timing', S.timing, 'pre_done');
  await flushEvents();
  await store.flush();
}


// ---------- 이어하기 (메신저 인앱 브라우저가 닫혀도 같은 링크로 다시 열면 이어서 진행) ----------
// 진행 상태를 이 기기의 브라우저에 저장해 두고, 다시 열면 같은 세션으로 이어 간다. 응답 자체는 쪽마다 이미 서버에 저장되어 있다.
// 규칙: ① 온라인 참여자만(현장 참가자는 연구자가 관리) ② 자극물 화면을 본 뒤에는 '처음부터 다시'를 허용하지 않는다(두 가지 화면에 노출되는 것을 막기 위해)
//       ③ 앱 버전이 바뀌었거나 7일이 지났으면 이어하기를 쓰지 않는다.
const SAVE_KEY = 'cfx_resume_v1';
const RESUMABLE = MODE === 'online' && !DEBUG && !PREVIEW && !DESIGN;
function clearSaved() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {}
}
function persist() {
  if (!RESUMABLE || !S.id || STEPS.indexOf(currentStepId()) < STEPS.indexOf('guide')) return;
  const sid = currentStepId();
  if (sid === 'end') return;
  const ss = S.stimState;
  try {
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        v: 1, ver: APP_VERSION, t: Date.now(), id: S.id, group: S.group, stepId: sid,
        screen: S.screen, pre: S.pre, asset: S.asset, post: S.post, orders: S.orders, timing: S.timing, stim: S.stim, code: S.code,
        resumes: S.resumes || 0, exposed: !!S.exposed,
        stimState: { homeMs: ss.homeMs, statusEntries: ss.statusEntries, chartMs: sid === 'stimulus' ? currentChartMs() : ss.chartMs },
      })
    );
  } catch {}
}
function loadSaved() {
  if (!RESUMABLE) return null;
  try {
    const r = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (!r || r.v !== 1 || r.ver !== APP_VERSION || Date.now() - r.t > 7 * 86400000) return null;
    if (localStorage.getItem('cfx_participated')) return null;
    const idx = STEPS.indexOf(r.stepId);
    return idx >= STEPS.indexOf('guide') && idx >= 0 ? { ...r, idx } : null;
  } catch {
    return null;
  }
}
const STEP_LABEL = (id) => (id === 'guide' ? '안내' : PRE_IDS.has(id) || id === 'asset' ? '사전 질문' : POST_IDS.has(id) || id === 'poststart' ? '설문' : '화면 보기');
function renderResume(r) {
  frame(
    `<h1 class="h1">이어서 진행할까요?</h1>
     <p class="lead">지난번에 <b>‘${esc(STEP_LABEL(r.stepId))}’</b> 단계까지 진행하셨어요. 입력하신 내용은 그대로 남아 있습니다.</p>
     ${r.exposed ? '<p class="note">화면을 이미 보셨기 때문에 처음부터 다시 참여할 수는 없어요. 이어서 진행해 주세요.</p>' : ''}
     <div class="actions"><div class="actwrap solo"><button class="btn primary" id="resume">이어서 하기</button>${r.exposed ? '' : '<button class="btn ghost" id="restart" style="margin-top:8px;width:100%">처음부터 다시 하기</button>'}</div></div>`,
    { progress: false }
  );
  document.getElementById('resume').addEventListener('click', () => {
    Object.assign(S, { id: r.id, group: r.group, screen: r.screen || {}, pre: r.pre || {}, asset: r.asset || S.asset, post: r.post || {}, orders: r.orders || {}, timing: r.timing || {}, stim: r.stim, code: r.code, exposed: !!r.exposed, resumes: (r.resumes || 0) + 1 });
    Object.assign(S.stimState, { homeMs: r.stimState?.homeMs || 0, chartMs: r.stimState?.chartMs || 0, statusEntries: r.stimState?.statusEntries || 0 });
    S.stepIdx = r.idx;
    history.pushState({ s: S.stepIdx }, '');
    log('resume', { from: r.stepId, n: S.resumes });
    enterStep();
  });
  document.getElementById('restart')?.addEventListener('click', () => {
    clearSaved();
    S.stepIdx = 0;
    enterStep();
  });
}
// 창이 닫히거나 숨겨질 때 한 번 더 저장
addEventListener('pagehide', persist);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && persist());

// 메신저(인앱) 브라우저 안내
const INAPP = /KAKAOTALK|NAVER\(inapp|Line\/|Instagram|FBAN|FBAV|DaumApps/i.test(navigator.userAgent);
const IS_KAKAO = /KAKAOTALK/i.test(navigator.userAgent);
function inappNotice() {
  if (!INAPP || MODE !== 'online') return '';
  return `<div class="inapp"><b>메신저 안에서 열려 있어요</b><p>화면을 아래로 내리면 창이 닫힐 수 있어요. 더 안정적으로 진행하려면 기본 브라우저(Safari·Chrome)로 열어 주세요. 닫히더라도 같은 링크를 다시 열면 이어서 할 수 있습니다.</p>${
    IS_KAKAO ? '<button class="btn ghost" id="openext" type="button">기본 브라우저로 열기</button>' : '<p class="small">오른쪽 위·아래의 메뉴(⋯)에서 ‘다른 브라우저로 열기’를 눌러 주세요.</p>'
  }</div>`;
}

// ---------- 라우팅 ----------
const RENDER = {
  consent: renderConsent,
  screening: renderScreening,
  labstart: renderLabStart,
  guide: renderGuide,
  asset: renderAsset,
  prestim: renderPreStim,
  stimulus: renderStimulus,
  poststart: renderPostStart,
  end: renderEnd,
  endprev: () => frame(`<h1 class="h1">미리보기 끝</h1><p class="lead">Type ${PREVIEW} 화면을 확인했습니다. 아무것도 저장되지 않았습니다.</p>`, { progress: false }),
  endpre: renderEndPre,
};
Q.PRE_PAGES.forEach((p, i) => {
  RENDER[p.id] = () => renderSurveyPage(p, S.pre, { saveAs: 'pre', back: i > 0 });
});
Q.POST_PAGES.forEach((p) => {
  RENDER[p.id] = () => renderSurveyPage(p, S.post, { saveAs: 'post', back: false });
});

// 뒤로 가기/새로고침 방지 (자극물 이후 되돌아가기 불가)
history.replaceState({ s: 0 }, '');
history.pushState({ s: 0 }, '');
window.addEventListener('popstate', () => history.pushState({ s: S.stepIdx }, ''));
window.addEventListener('beforeunload', (e) => {
  if (!DESIGN && S.id && currentStepId() !== 'end' && currentStepId() !== 'endpre') {
    e.preventDefault();
    e.returnValue = '';
  }
});

if (DEBUG) {
  window.__cfx = { S, STEPS, store, go };
}
if (PREVIEW) {
  S.id = 'preview';
  S.group = PREVIEW;
}
if (DESIGN) {
  // 검토용 이동 칩: 단계 사이를 오가며 동선을 확인한다 (참가자 화면에는 나타나지 않음)
  const chip = document.createElement('div');
  chip.style.cssText = 'position:fixed;top:-2px;left:50%;transform:translateX(-50%);z-index:99;opacity:.92;white-space:nowrap;width:max-content;scale:.78;display:flex;gap:4px;align-items:center;background:rgba(17,24,39,.82);color:#fff;border-radius:999px;padding:3px 6px;font:600 11px/1 system-ui,sans-serif';
  chip.innerHTML = '<button id="dz-p" aria-label="이전 단계" style="all:unset;cursor:pointer;padding:4px 7px">‹</button><span id="dz-l"></span><button id="dz-n" aria-label="다음 단계" style="all:unset;cursor:pointer;padding:4px 7px">›</button><button id="dz-o" style="all:unset;cursor:pointer;padding:4px 7px;border-left:1px solid #fff5">탈락</button><button id="dz-r" style="all:unset;cursor:pointer;padding:4px 7px;border-left:1px solid #fff5">처음</button>';
  document.body.appendChild(chip);
  document.getElementById('dz-p').onclick = () => go(-1);
  document.getElementById('dz-n').onclick = () => go(1);
  document.getElementById('dz-o').onclick = () => renderScreenedOut();
  document.getElementById('dz-r').onclick = () => (location.href = location.pathname + '?design=1');
  setInterval(() => (document.getElementById('dz-l').textContent = `검토 ${S.stepIdx + 1}/${STEPS.length} ${currentStepId()}`), 300);
}
const SAVED = loadSaved();
if (SAVED) renderResume(SAVED);
else enterStep();
