import { CONFIG } from './config.js';
import { createStorage } from './storage.js';
import * as Q from './questions.js';
import { buildStimulus, chartSVG, won, wonPlain, pct } from './stimulus.js';

// ---------- URL 파라미터 ----------
const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'lab' ? 'lab' : 'online'; // lab = Phase 2(아이트래킹, 연구자 동석)
const PID = (params.get('pid') || '').trim() || null;
const STAGE = ['pre', 'exp'].includes(params.get('stage')) && MODE === 'lab' ? params.get('stage') : 'all';
const APP_VERSION = 'pilot-1.1'; // 1.0: 자극물 확정본(애니메이션·곡선·눈금·버튼 방식 고정). 1.1: 사후 문항 중립화·순서 변경, T2 추가, 금융 지식 문항 맨 끝. 바꾸면 버전을 올린다.
// 개발용 모드(?debug=1, ?design=1)는 로컬 서버이거나 CONFIG.ALLOW_DEV_MODES가 true일 때만 켜진다. 운영 주소에서는 URL을 알아도 열리지 않는다.
const DEV_OK = ['localhost', '127.0.0.1'].includes(location.hostname) || CONFIG.ALLOW_DEV_MODES === true;
const DEBUG = DEV_OK && params.get('debug') === '1';
// ?design=1 : 디자인 검토용. 모든 값이 채워진 상태로 처음부터 끝까지 같은 흐름을 눌러 볼 수 있다. C형 화면 고정, 저장·이어하기 없음.
const DESIGN = DEV_OK && params.get('design') === '1';
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
  // late 쪽(금융 지식)은 사전 설문만 하는 세션(stage=pre)에서는 원래 자리에, 사전·실험을 한 번에 하는 세션에서는 사후 문항 뒤에 둔다.
  if (STAGE === 'pre') {
    Q.PRE_PAGES.forEach((p) => s.push(p.id));
    s.push('endpre');
    return s;
  }
  if (STAGE !== 'exp') Q.PRE_PAGES.filter((p) => !p.late).forEach((p) => s.push(p.id));
  s.push('asset', 'prestim', 'stimulus', 'poststart', ...Q.POST_PAGES.map((p) => p.id));
  if (STAGE !== 'exp') Q.PRE_PAGES.filter((p) => p.late).forEach((p) => s.push(p.id));
  s.push('end');
  return s;
}
const STEPS = PREVIEW ? ['asset', 'stimulus', 'endprev'] : stepList();

// 디자인 검토용 기본값 (DESIGN 모드에서만 사용, 저장되지 않음)
if (DESIGN) {
  S.id = 'design';
  S.group = ['A', 'B', 'C'].includes(params.get('g')) ? params.get('g') : 'C';
  S.screen = { S1: 27, S2: '예', S3: '예', S4: '아니오' };
  const fillItems = (items, b) =>
    items.forEach((it) => {
      b[it.id] =
        it.type === 'likert' ? (it.id === 'AC1' ? 7 : 5) : it.type === 'yesno' ? '예' : it.type === 'number' ? (it.id === 'M3' ? 12 : 3) : it.options[0];
    });
  Q.PRE_PAGES.forEach((pg) => fillItems(pg.items, S.pre));
  Q.POST_PAGES.forEach((pg) => fillItems(pg.items, S.post));
  S.asset = { amount: 3_000_000, interests: (params.get('i') || 'overseas').split(','), name: '민지' }; // ?i=domestic,alt 로 관심 분야별 홈 추천을 확인
  S.stim = buildStimulus(S.group, 3_000_000, new Date(), CONFIG.END_MONTH);
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
// 선택·다음 버튼에 아주 짧은 진동(지원하는 기기만). 화면에는 영향이 없다.
function tick() {
  try {
    navigator.vibrate?.(8);
  } catch {}
}
document.addEventListener('change', (e) => e.target.matches?.('input[type=radio],input[type=checkbox]') && tick());
document.addEventListener('click', (e) => e.target.closest?.('.btn.primary:not(:disabled),.tab,.chip') && tick());

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
// 자극물 뒤에 묻는 쪽(사후 문항 + 뒤로 옮긴 금융 지식)
const AFTER_STIM = new Set(STEPS.slice(STEPS.indexOf('stimulus') + 1));
const SURVEY_STEPS = STEPS.filter((id) => PRE_IDS.has(id) || POST_IDS.has(id));
const BEFORE_STIM_PRE = SURVEY_STEPS.filter((id) => PRE_IDS.has(id) && !AFTER_STIM.has(id));
const LAST_PRE = BEFORE_STIM_PRE[BEFORE_STIM_PRE.length - 1] || null; // 이 쪽을 마치면 pre_done
const LAST_SURVEY = STEPS.includes('end') ? SURVEY_STEPS[SURVEY_STEPS.length - 1] : null; // 이 쪽을 마치면 post_done
function phaseOf(id) {
  if (id === 'guide') return 'guide';
  if (AFTER_STIM.has(id) && (PRE_IDS.has(id) || POST_IDS.has(id))) return 'post';
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
// 오른쪽 위 진행 표시: 전체 실험에서 어디쯤인지를 원형 링 하나로 보여 준다. (문항 진행은 본문의 가는 막대가 따로 맡는다)
// 현재 단계 이름(안내·사전 질문·설문 등)이 있는 화면에서는 링 옆에 함께 적는다.
function phaseBar(id) {
  if (PREVIEW) return '';
  const cur = phaseOf(id);
  const label = cur ? PHASES.find((p) => p.id === cur)?.label || '' : '';
  return ringHTML(label);
}
// 진행률은 '문항 수'로 가중한다: 문항이 많은 쪽은 쪽 안에서 한 문항씩 차오르고, 안내·금액 입력·화면 보기는 각 1로 센다. (쪽 단위로 세면 8%에서 갑자기 15%로 뛰는 것처럼 보인다)
function stepWeight(id) {
  if (id === 'screening') return Q.SCREENING.length;
  const page = [...Q.PRE_PAGES, ...Q.POST_PAGES].find((p) => p.id === id);
  if (page) return page.items.filter((i) => !(MODE === 'lab' && i.id === 'AC1')).length;
  return 1;
}
function ringFraction(within = 0) {
  const body = STEPS.filter((id) => id !== 'end'); // 종료 화면은 제외
  const sum = (arr) => arr.reduce((a, id) => a + stepWeight(id), 0);
  const total = Math.max(1, sum(body));
  return Math.min(1, Math.max(0, (sum(body.slice(0, S.stepIdx)) + within) / total));
}
const RING_R = 14;
const RING_C = 2 * Math.PI * RING_R;
function setRing(within) {
  const el = document.querySelector('.ring .rf');
  if (el) el.style.strokeDashoffset = (RING_C * (1 - ringFraction(within))).toFixed(2);
}
function ringHTML(label) {
  const p = ringFraction(0);
  return `<div class="ringwrap" role="progressbar" aria-label="전체 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p * 100)}">${label ? `<span class="pcur">${esc(label)}</span>` : ''}<svg class="ring" width="24" height="24" viewBox="0 0 36 36" aria-hidden="true"><circle class="rt" cx="18" cy="18" r="${RING_R}"/><circle class="rf" cx="18" cy="18" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" style="stroke-dashoffset:${(RING_C * (1 - p)).toFixed(2)}" transform="rotate(-90 18 18)"/></svg></div>`;
}

// ---------- 화면 골격 ----------
// 화면/문항이 바뀌면 항상 맨 위부터 보이게 한다 (iOS·인앱 브라우저에서 스크롤 값이 남는 문제 방지)
try { history.scrollRestoration = 'manual'; } catch (e) {}
function toTop() {
  const go = () => {
    scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.querySelectorAll('.shell,.screen').forEach((e) => { e.scrollTop = 0; });
  };
  go();
  requestAnimationFrame(go);
  setTimeout(go, 80);
}

function frame(inner, { back = false, progress = true, wide = false } = {}) {
  const total = STEPS.length - 1;
  const p = Math.min(1, S.stepIdx / Math.max(1, total - 1));
  const pb = phaseBar(currentStepId());
  root.innerHTML = `
    <div class="shell ${wide ? 'wide' : ''}">
      <div class="topbar">
        ${back ? '<button class="iconbtn" id="back" aria-label="이전">' + ICON.back + '</button>' : '<span></span>'}
        ${pb || (progress ? ringHTML('') : '')}
      </div>
      <main class="screen">${inner}</main>
    </div>`;
  toTop();
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

// ---------- 한 문항씩 보여 주는 질문 러너 (설문 쪽·참여 조건 확인 공통) ----------
// 한 화면에 한 문항만 크게 보여 읽기 부담을 줄인다. 답을 고르면 '다음' 버튼이 켜지고, 버튼을 눌러야 넘어간다(실수로 눌러 넘어가는 것을 막고, 답을 바꿀 수 있게 한다).
// 저장 구조(bucket[문항ID])와 문항 순서(S.orders)는 이전과 같고, 문항별 응답 시간만 이벤트로 더 남긴다.
function runQuestions({ items, bucket, eyebrow, intro, guide, back, lastLabel = '다음', onDone, onEach }) {
  const firstLikert = items.findIndex((i) => i.type === 'likert');
  frame(
    `<div class="qwrap">
       <div class="qtop"><span class="qeyebrow">${esc(eyebrow)}</span><span class="qcount"><b id="qi">1</b> / ${items.length}</span></div>
       <div class="qbar" aria-hidden="true"><i id="qbar"></i></div>
       ${intro ? `<p class="qintro">${fmt(intro)}</p>` : ''}
       <form id="f">${items.map(itemHTML).join('')}</form>
       <p class="qhint" id="qhint" hidden></p>
     </div>
     <div class="actions" id="qact"><button class="btn primary" id="next" disabled>다음</button></div>`,
    { back: true }
  );
  const f = document.getElementById('f');
  const qs = [...f.querySelectorAll('.q')];
  const btn = document.getElementById('next');
  const act = document.getElementById('qact');
  const hint = document.getElementById('qhint');
  const backBtn = document.getElementById('back');
  items.forEach((it) => restore(it, f, bucket));
  let idx = items.findIndex((it) => readItem(it, f) === null);
  if (idx < 0) idx = DESIGN ? 0 : items.length - 1; // 검토 모드는 값이 채워져 있어도 첫 문항부터 보여 준다
  let shownAt = 0;
  let timer = null;
  const last = () => idx === items.length - 1;
  const show = (i) => {
    clearTimeout(timer);
    idx = i;
    qs.forEach((q, k) => q.classList.toggle('active', k === i));
    document.getElementById('qi').textContent = i + 1;
    setRing(i);
    document.getElementById('qbar').style.width = Math.round((i / items.length) * 100) + '%';
    const it = items[i];
    const answered = readItem(it, f) !== null;
    act.classList.remove('off');
    btn.textContent = last() ? lastLabel : '다음';
    btn.disabled = !answered;
    const parts = [];
    if (i === 0 && guide) parts.push(fmt(guide));
    if (i === firstLikert && it.type === 'likert') parts.push('<b>1~7</b> 중 하나를 눌러 주세요. 숫자가 클수록 <b>오른쪽 설명</b>에 가깝습니다.');
    hint.innerHTML = parts.join('<br>');
    hint.hidden = !parts.length;
    backBtn.style.visibility = i === 0 && !back ? 'hidden' : '';
    shownAt = performance.now();
    toTop();
    if (it.type === 'number') setTimeout(() => qs[i].querySelector('input')?.focus({ preventScroll: true }), 60);
  };
  const advance = async () => {
    if (onEach) {
      const v = readItem(items[idx], f);
      if (v !== null && (await onEach(items[idx], v))) return; // true면 여기서 멈춘다 (예: 참여 조건 불충족 시 바로 종료 화면)
    }
    if (last()) return finish();
    show(idx + 1);
  };
  const finish = async () => {
    const { out, firstMissing } = collectItems(items, f);
    if (firstMissing) {
      const k = items.findIndex((it) => readItem(it, f) === null);
      show(k);
      return toast('답하지 않은 문항이 있어요.');
    }
    btn.disabled = true;
    await onDone(out);
  };
  const onAnswer = (e) => {
    const it = items[idx];
    const v = readItem(it, f);
    qs[idx].classList.toggle('done', v !== null);
    if (v === null) {
      btn.disabled = true;
      return;
    }
    bucket[it.id] = v;
    persist();
    btn.disabled = false;
    if (e.type === 'change' && it.type !== 'number') {
      log('answer', { id: it.id, ms: Math.round(performance.now() - shownAt) });
    }
  };
  f.addEventListener('change', onAnswer);
  f.addEventListener('input', (e) => e.target.type === 'text' && onAnswer(e));
  f.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!btn.disabled) advance();
    }
  });
  btn.addEventListener('click', advance);
  backBtn.addEventListener('click', () => {
    if (idx > 0) show(idx - 1);
    else prev();
  });
  items.forEach((it, k) => qs[k].classList.toggle('done', readItem(it, f) !== null));
  show(idx);
}

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

// 대문(웰컴) 화면: 딱딱한 동의서 이전에 연구가 어떤 것인지 가볍게 알려 주고 시작을 누르게 한다.
function renderWelcome() {
  const lab = MODE === 'lab';
  frame(
    `<section class="welcome">
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
  document.getElementById('openext')?.addEventListener('click', openExternal);
  document.getElementById('welcome-go').addEventListener('click', () => {
    S._welcomed = true;
    renderConsent();
  });
}

// ---------- 동의 / 스크리닝 ----------
function renderAlready() {
  frame(`<h1 class="h1">이미 참여하셨어요</h1><p class="lead">이 브라우저에서 이미 연구에 참여하신 기록이 있습니다. 한 분당 한 번만 참여할 수 있어 중복 참여는 어렵습니다. 감사합니다. 주변에 참여할 수 있는 분이 계시다면 링크를 공유해 주세요.</p>
    <div class="actions"><div class="actwrap solo"><button class="btn primary" id="copylink" type="button">링크 복사</button></div></div>`, { progress: false });
  document.getElementById('copylink').addEventListener('click', () => copyText(location.origin + location.pathname, '링크를 복사했어요.'));
}

function renderConsent() {
  const done = (() => {
    try {
      return !!localStorage.getItem('cfx_participated');
    } catch {
      return false;
    }
  })();
  if (done && !DEBUG && !DESIGN && MODE === 'online') {
    renderAlready();
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
     <div class="consent">
       <p class="cs-intro">모바일 금융 앱 화면을 보고 <b>자산 상태를 어떻게 판단하는지</b> 알아보는 학술 연구입니다.</p>
       <ul class="cs-list">
         <li><span class="ci">${ICON.clock}</span><div><b>소요 시간</b><p>약 ${CONFIG.TARGET_MIN}~${CONFIG.TARGET_MAX}분</p></div></li>
         <li><span class="ci">${ICON.lock}</span><div><b>익명 처리</b><p>응답은 연구 목적으로만 쓰이며, 이름 같은 개인 식별 정보는 저장하지 않습니다.</p></div></li>
         <li><span class="ci">${ICON.coin}</span><div><b>가상 데이터</b><p>입력하신 금액으로 가상 화면을 만듭니다. 금액은 익명 응답과 함께 분석에만 쓰이며, 실제 계좌나 금융 정보와 연동되지 않습니다.</p></div></li>
         <li><span class="ci">${ICON.check}</span><div><b>자유로운 중단</b><p>언제든 그만둘 수 있고, 중단해도 불이익이 없습니다.</p></div></li>
         ${lab ? `<li><span class="ci">${ICON.trend}</span><div><b>시선 기록</b><p>시선 추적 장비로 화면을 보는 동안의 시선이 기록됩니다.</p></div></li>` : ''}
       </ul>
       <dl class="rinfo">
         <dt>연구자</dt><dd>${esc(CONFIG.RESEARCHER_CONTACT)}</dd>
         <dt>연락처</dt><dd>${mailHTML()}</dd>
         <dt>생명윤리위원회 심의</dt><dd>${esc(CONFIG.IRB_NUMBER)}</dd>
       </dl>
     </div>
     ${lab && PID ? `<p class="small muted">참가자 ID: <b>${esc(PID)}</b></p>` : ''}
     <div class="actions consent-act"><div class="actwrap">
       <label class="agree"><input type="checkbox" id="agree"><span class="box">${ICON.check}</span><span>${lab ? '현장에서 서면 동의를 받았음을 확인합니다 (연구자 확인).' : '위 내용을 읽었으며 연구 참여에 동의합니다.'}</span></label>
       <button class="btn primary" id="next" disabled>동의하고 시작하기</button>
     </div></div>`,
    { progress: false, back: true }
  );
  document.getElementById('back')?.addEventListener('click', () => {
    S._welcomed = false;
    renderConsent();
  });
  const agree = document.getElementById('agree');
  const btn = document.getElementById('next');
  document.getElementById('openext')?.addEventListener('click', openExternal);
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
  runQuestions({
    items: Q.SCREENING,
    bucket: S.screen,
    eyebrow: '참여 조건 확인',
    intro: '몇 가지만 확인할게요.',
    back: false,
    lastLabel: '확인했어요',
    // 조건에 맞지 않는 값을 '다음'으로 확정하는 즉시 참여 불가 화면을 보여 준다 (남은 문항은 묻지 않는다)
    onEach: async (it, v) => {
      if (it.pass(v)) return false;
      S.screen[it.id] = v;
      await screenOut();
      return true;
    },
    onDone: async (out) => {
      Object.assign(S.screen, out);
      await store.savePart(S.id, 'screen', { ...S.screen, consent: true, passed: true }, 'screened');
      next();
    },
  });
  async function screenOut() {
    await store.savePart(S.id, 'screen', { ...S.screen, consent: true, passed: false }, 'screened_out');
    clearSaved();
    leaveStep();
    try {
      if (!DESIGN) localStorage.setItem('cfx_screenedout', '1'); // 같은 브라우저에서 답을 바꿔 다시 들어오는 것을 막는다
    } catch {}
    renderScreenedOut();
    await flushEvents();
  }
}

// 참여 조건에 맞지 않을 때: 개인 평가처럼 들리지 않게 쓰고, 어떤 문항 때문인지는 알리지 않는다. 링크 복사로 주변의 해당자에게 공유를 청한다.
function renderScreenedOut() {
  frame(
    `<h1 class="h1 center">관심 가져 주셔서<br>감사합니다</h1>
     <div class="consent">
       <ul class="cs-list">
         <li><span class="ci">${ICON.check}</span><div><b>이번에는 함께하기 어려워요</b><p>이번 연구는 연구 설계상 정해진 대상을 모집하고 있습니다.</p></div></li>
         <li><span class="ci">${ICON.lock}</span><div><b>모집 대상</b><p>${esc(CONFIG.TARGET_DESC)}</p></div></li>
         <li><span class="ci">${ICON.mail}</span><div><b>공유해 주세요</b><p>주변에 해당되는 분이 계시다면 링크를 공유해 주세요.</p></div></li>
       </ul>
     </div>
     <div class="actions"><div class="actwrap solo"><button class="btn primary" id="copylink">링크 복사</button></div></div>`,
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
  const preN = STEPS.filter((id) => PRE_IDS.has(id) && !AFTER_STIM.has(id)).length;
  const postN = STEPS.filter((id) => AFTER_STIM.has(id) && (PRE_IDS.has(id) || POST_IDS.has(id))).length;
  if (preN) rows.push(['사전 질문', `기본 정보와 금융 경험 (${preN}쪽)`]);
  if (has((id) => id === 'asset')) rows.push(['금액 입력', '가상 화면에 쓰일 투자 금액']);
  if (has((id) => id === 'stimulus')) rows.push(['화면 보기', '가상의 투자 앱 화면을 둘러봅니다']);
  if (postN) rows.push(['설문', `짧은 설문 (${postN}쪽) 후 종료`]);
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
     <ul class="cs-list guide">${items
       .map(
         (it, i) => `<li><span class="ci">${[ICON.trend, ICON.lock, ICON.clock][i]}</span><div><b>${esc(it[0])}</b><p>${nl2br(it[1])}</p></div></li>`
       )
       .join('')}</ul>${nextBtn('확인했어요')}`,
    { back: false }
  );
  document.getElementById('next').addEventListener('click', next);
}

// ---------- 설문 쪽 (사전/사후 공통) ----------
function renderSurveyPage(page, bucket, { saveAs, doneStatus, back }) {
  // fixed 문항은 쪽 맨 앞에 정해진 순서로 두고, 나머지만 섞는다
  if (!S.orders[page.id]) {
    const fixed = page.items.filter((i) => i.fixed);
    const rest = page.items.filter((i) => !i.fixed);
    S.orders[page.id] = [...fixed, ...(page.shuffle ? shuffle(rest) : rest)].map((i) => i.id);
  }
  const items = S.orders[page.id].map((id) => page.items.find((i) => i.id === id)).filter((i) => !(MODE === 'lab' && i.id === 'AC1'));
  const isPre = bucket === S.pre;
  runQuestions({
    items,
    bucket,
    eyebrow: page.title,
    intro: page.intro,
    guide: page.guide,
    back,
    lastLabel: '다음',
    onDone: async (out) => {
      Object.assign(bucket, out);
      const payload = { ...bucket, _order: { ...(bucket._order || {}), [page.id]: S.orders[page.id] } };
      bucket._order = payload._order;
      const lastPre = page.id === LAST_PRE || (STAGE === 'pre' && isPre && page.id === Q.PRE_PAGES[Q.PRE_PAGES.length - 1].id);
      const lastPost = page.id === LAST_SURVEY;
      leaveStep();
      await store.savePart(S.id, saveAs, payload, lastPre ? 'pre_done' : lastPost ? 'post_done' : null);
      if (lastPost) await store.savePart(S.id, 'timing', S.timing, null);
      S.stepIdx++;
      history.pushState({ s: S.stepIdx }, '');
      flushEvents();
      enterStep();
    },
  });
}

// ---------- 전환 안내 (화면 보기 직전 / 직후) ----------
// 모든 집단에 같은 문구를 보여 준다. 차트·수익률·수치에 대한 언급은 일부러 넣지 않는다 (주의를 특정 요소로 유도하지 않기 위해).
function renderPreStim() {
  // 진입 직전 화면: 밝은 톤은 유지하되 큰 일러스트와 다른 구성으로 '곧 화면 보기가 시작된다'는 인지를 준다.
  frame(
    `<section class="pre-go">
       <div class="pg-top"><span class="pg-tag">${esc(PHASES[2].label)}</span></div>
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
  const after = STEPS.filter((id) => AFTER_STIM.has(id) && (PRE_IDS.has(id) || POST_IDS.has(id)));
  const n = after.reduce((a, id) => a + stepWeight(id), 0);
  frame(
    `<div class="eyebrow">화면 보기 완료</div>
     <h1 class="h1">화면 보기가 끝났어요.<br><mark class="hl">이제 설문 단계</mark>입니다</h1>
     <p class="lead">방금 보신 화면을 떠올리며 답해 주세요. 앞 화면으로 돌아가 다시 볼 수는 없어요.</p>
     <section class="flowcard"><ol>
       <li><span class="fn">✓</span><b>화면 보기</b><em>완료</em></li>
       <li class="cur"><span class="fn">▶</span><b>설문</b><em>${after.length}쪽 · 문항 ${n}개</em></li>
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
     <p class="note">입력하신 금액으로 가상 화면을 만들어요. 금액은 익명 응답과 함께 분석에만 쓰이고, 실제 계좌나 금융 데이터와는 연동되지 않습니다. 이름은 저장하지 않아요.</p>
     <label class="fld"><span>이름 또는 닉네임</span><input id="name" class="inp" type="text" maxlength="12" placeholder="화면에 부를 이름을 입력해 주세요" autocomplete="off" value="${esc(a.name)}"></label>
     <label class="fld"><span>현재 총 투자 자산</span>
       <div class="inp amt"><input id="amount" type="text" inputmode="numeric" placeholder="0" autocomplete="off" value="${a.amount ? wonPlain(a.amount) : ''}"><em>원</em></div></label>
     <p class="hint" id="amt-hint">${Q.koWon(Q.ASSET_MIN)} 이상 ${Q.koWon(Q.ASSET_MAX)} 이하로 입력해 주세요.</p>
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
    if (!name) return toast('이름 또는 닉네임을 입력해 주세요.');
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
  // 뉴스는 시장 방향(상승·하락)을 암시하지 않는 중립 문구만 쓴다 (낙관·비관 점화 방지, 모든 집단 동일)
  ['글로벌', '마켓데일리 · 15분 전', '美 연준, 다음 달 통화정책회의 일정 발표... 시장은 결과 주시'],
  ['마이데이터', '머니리포트 · 1시간 전', 'Cashflow, AI 기반 맞춤 포트폴리오 진단 서비스 정식 오픈'],
  ['배당/채권', '투자뉴스랩 · 3시간 전', '월배당 ETF, 분배금 지급 구조와 세금 정리'],
];
// 선택한 관심 분야에 따라 홈의 '맞춤 추천 상품'이 달라진다. 분기 규칙은 세 집단이 같고(집단은 무작위 배정), 모두 소폭 상승으로 보여 자극물의 수익 방향과 맞춘다.
const PICK_POOL = {
  overseas: [
    ['A', '#111', 'Apple', 'AAPL', '272,400원', '+2.45%'],
    ['T', '#e03131', 'Tesla', 'TSLA', '284,500원', '+4.12%'],
    ['N', '#2b8a3e', 'NVIDIA', 'NVDA', '198,300원', '+1.87%'],
  ],
  domestic: [
    ['S', '#1c4ed8', '삼성전자', '005930', '79,800원', '+0.76%'],
    ['H', '#e8590c', 'SK하이닉스', '000660', '231,500원', '+1.92%'],
    ['N', '#2f9e44', 'NAVER', '035420', '212,000원', '+1.35%'],
  ],
  savings: [
    ['예', '#12b886', '12개월 정기예금', '시중은행 최고금리', '연 3.45%', '+0.10%p'],
    ['적', '#228be6', '24개월 자유적금', '우대금리 포함', '연 3.80%', '+0.05%p'],
    ['P', '#7950f2', 'CMA 파킹통장', '수시입출금', '연 2.10%', '+0.03%p'],
  ],
  alt: [
    ['₿', '#f59f00', '비트코인', 'BTC', '98,420,000원', '+3.08%'],
    ['E', '#5c7cfa', '이더리움', 'ETH', '4,512,000원', '+2.61%'],
    ['G', '#c9a227', 'KRX 금', '금현물', '142,300원', '+0.94%'],
  ],
};
function picksFor(interests) {
  const sel = (interests && interests.length ? interests : ['overseas']).filter((k) => PICK_POOL[k]);
  const out = [];
  for (let r = 0; out.length < 3 && r < 3; r++) sel.forEach((k) => out.length < 3 && PICK_POOL[k][r] && out.push(PICK_POOL[k][r]));
  return out;
}

function assetCard(st, { cta = false, flat = false } = {}) {
  if (flat)
    return `<section class="asset-flat">
    <div class="row between"><span class="lbl">내 자산</span><span class="badge"><i></i>마이데이터 실시간</span></div>
    <div class="big">${won(st.current)}</div>
    <div class="sub"><span>원금 ${won(st.N)}</span><span class="sep">·</span><span class="up">${ICON.up} +${won(st.gain)} (+${pct(st.gainPct)})</span></div>
  </section>`;
  return `<section class="hero">
    <div class="row between"><span class="lbl">내 자산</span><span class="badge"><i></i>마이데이터 실시간</span></div>
    <div class="big">${won(st.current)}</div>
    <div class="sub"><span>원금 ${won(st.N)}</span><span class="sep">·</span><span class="up">${ICON.up} +${won(st.gain)} (+${pct(st.gainPct)})</span></div>
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
      <section class="div-row"><span><i class="gdot"></i>예상 연간 배당금</span><b>${won(st.dividend)}</b></section>
      <div class="sec-h"><div><h2>맞춤 추천 상품</h2><p>선택하신 투자 성향에 맞춘 인기 종목</p></div>${ICON.chev}</div>
      <div class="list">${picksFor(S.asset.interests).map(
        (p) => `<div class="pick"><span class="av" style="background:${p[1]}">${p[0]}</span><div class="nm"><b>${esc(p[2])}</b><small>${esc(p[3])}</small></div><div class="pr"><b>${p[4]}</b><span class="up">${p[5]}</span></div></div>`
      ).join('')}</div>
      <div class="sec-h"><div><h2>주요 시장 뉴스</h2><p>실시간 금융 시장 핵심 이슈 브리핑</p></div>${ICON.chev}</div>
      <div class="list">${NEWS.map(
        (n) => `<div class="news"><div class="meta"><span class="tag">${esc(n[0])}</span><small>${esc(n[1])}</small></div><p>${esc(n[2])}</p></div>`
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
  const chart = chartSVG(st, undefined, undefined, { extras: params.get('extra') === '1' });
  const need = MIN_EXPOSURE * 1000;
  frame(
    `<div class="status ${SHOW_AOI ? 'show-aoi' : ''}">
      <header class="sub-head"><button class="iconbtn" id="sback" aria-label="이전">${ICON.back}</button><h1>내 자산 현황</h1><span></span></header>
      ${assetCard(st, { flat: true })}
      <section class="chart-card" id="chart-card" data-aoi="chart">${chart.svg}</section>
      <div class="tabs" role="tablist">${['1D', '1W', '1M', '6M', '1Y', 'ALL']
        .map((t) => `<button class="tab ${t === '6M' ? 'on' : ''}" data-tab="${t}" ${t === '6M' ? 'aria-selected="true"' : ''}>${t}</button>`)
        .join('')}</div>
      <div class="sec-h plain"><h2>월간 평가액 리포트</h2><small>단위 (원)</small></div>
      <div class="list">${st.monthly
        .map(
          (m, i) => `<div class="rep" data-m="${m.month}">
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
      btn.textContent = ready ? '다음' : '화면을 둘러보세요'; // 숫자(남은 시간)는 보여 주지 않는다
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
    `<div class="donebadge" aria-hidden="true">${ICON.check}</div><h1 class="h1 center">참여해 주셔서 감사합니다</h1>
     <div class="consent debrief">
       <ul class="cs-list">
         <li><span class="ci">${ICON.lock}</span><div><b>익명으로 분석돼요</b><p>시간 내어 참여해 주셔서 감사합니다. 응답은 익명으로 이 연구의 분석에만 사용되며, 다른 목적으로는 쓰이지 않습니다.</p></div></li>
         <li><span class="ci">${ICON.coin}</span><div><b>화면의 금액은 가상이에요</b><p>화면에 나온 금액과 수익은 입력하신 금액으로 만든 <b>가상 자료</b>이며 실제 투자 성과와 무관합니다. 연구 목적과 결과는 자료 수집이 모두 끝난 뒤 이메일로 요청하시면 알려 드립니다.</p></div></li>
       </ul>
     </div>
     ${CONFIG.SHOW_COMPLETION_CODE ? `<div class="codebox"><small>참여 코드</small><b id="code">${S.code}</b><button class="btn ghost" id="copycode" type="button">코드 복사</button></div>` : ''}
     <div class="withdraw">
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
const STEP_LABEL = (id) => (id === 'guide' ? '안내' : phaseOf(id) === 'post' || id === 'poststart' ? '설문' : PRE_IDS.has(id) || id === 'asset' ? '사전 질문' : '화면 보기');
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

// 메신저(인앱) 브라우저 안내: 짧은 문구 + '브라우저에서 열기' 버튼 하나
const UA = navigator.userAgent;
const INAPP = /KAKAOTALK|NAVER\(inapp|Line\/|Instagram|FBAN|FBAV|DaumApps|everytimeApp|BAND\//i.test(UA);
const IS_KAKAO = /KAKAOTALK/i.test(UA);
const IS_LINE = /Line\//i.test(UA);
const IS_ANDROID = /Android/i.test(UA);
const IS_IOS = /iPhone|iPad|iPod/i.test(UA);
function inappNotice() {
  if (!INAPP || MODE !== 'online') return '';
  return `<div class="inapp"><b>메신저 안에서 열려 있어요</b><p>창이 닫히지 않게 브라우저에서 열어 주세요.</p><button class="btn ghost" id="openext" type="button">브라우저에서 열기</button></div>`;
}
// 앱마다 외부 브라우저로 여는 방법이 다르다. 열리지 않으면(화면이 그대로면) 링크를 복사해 붙여 넣도록 안내한다.
function openExternal() {
  const url = location.href;
  const u = new URL(url);
  if (IS_KAKAO) location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(url);
  else if (IS_LINE) {
    u.searchParams.set('openExternalBrowser', '1');
    location.href = u.toString();
  } else if (IS_ANDROID) location.href = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
  else if (IS_IOS) location.href = 'x-safari-' + url; // iOS 17 이상: Safari로 연다
  setTimeout(() => {
    if (document.visibilityState === 'visible') copyText(location.origin + location.pathname, '링크를 복사했어요. 브라우저 주소창에 붙여 넣어 주세요.');
  }, 1500);
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
Q.PRE_PAGES.forEach((p) => {
  // 사전 쪽은 바로 앞이 사전 쪽일 때만 뒤로 갈 수 있다. 자극물 뒤로 옮긴 쪽은 되돌아갈 수 없다.
  RENDER[p.id] = () => renderSurveyPage(p, S.pre, { saveAs: 'pre', back: !AFTER_STIM.has(p.id) && PRE_IDS.has(STEPS[STEPS.indexOf(p.id) - 1]) });
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
