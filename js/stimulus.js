// 자극물(자산 성장 곡선) 생성 로직. 순수 함수만 두어 Node에서도 검증할 수 있게 했다.
// 사용자가 입력한 투자 금액 N을 기준으로 6개월 동안 +12% 상승하는 같은 데이터를 만들고,
// 집단(A/B/C)에 따라 Y축 범위만 바꾼다. (프로포절 5-1 표)

// 월말 누적 수익률(원금 대비). 시작점 0 + 1~6월. 6월 +12.00%, 5월 +8.50%(→ 6월 월간 증가분 +3.5%p).
export const CUM_RETURNS = [0, 0.01, 0.025, 0.04, 0.06, 0.085, 0.12];

// Y축 범위를 N의 배수로 정의 → N의 크기와 무관하게 화면 점유율이 수학적으로 고정된다.
export const GROUPS = {
  A: { key: 'A', name: 'Type A (통제)', lo: 0.0, hi: 1.2, occupancy: 0.1, lieFactor: 1.0 },
  B: { key: 'B', name: 'Type B (실험 1)', lo: 0.8, hi: 1.2, occupancy: 0.3, lieFactor: 3.0 },
  C: { key: 'C', name: 'Type C (실험 2)', lo: 1.0, hi: 1.12, occupancy: 1.0, lieFactor: 10.0 },
};

export const DIVIDEND_RATE = 0.038; // 예상 연간 배당금 = 입력 금액의 3.8% (1,000원 단위 반올림)

export function won(v) {
  return Math.round(v).toLocaleString('ko-KR') + '원';
}
export function wonPlain(v) {
  return Math.round(v).toLocaleString('ko-KR');
}
export function pct(v, digits = 2) {
  return (v * 100).toFixed(digits) + '%';
}

// 마지막 월(가장 최근 월) = 참여 시점의 직전 달. 6개월치 월 이름을 만든다.
export function monthLabels(now = new Date(), endMonth = null) {
  let end = endMonth ?? now.getMonth(); // getMonth(): 0~11 → 직전 달의 1~12 값과 같다
  if (end === 0) end = 12;
  const out = [];
  for (let i = 5; i >= 0; i--) {
    let m = end - i;
    while (m <= 0) m += 12;
    out.push(m);
  }
  return out; // 오래된 달 → 최신 달
}

function ticksFor(lo, hi, step) {
  const first = Math.ceil(lo / step - 1e-9) * step;
  const ticks = [];
  for (let v = first; v <= hi + 1e-6; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

// 눈금이 4~6개가 되는 가장 '둥근' 간격을 고른다 (1·2·2.5·5 × 10^k).
export function niceTicks(lo, hi) {
  const range = hi - lo;
  const base = Math.pow(10, Math.floor(Math.log10(range / 5)));
  let best = null;
  for (const k of [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50]) {
    const step = base * k;
    const ticks = ticksFor(lo, hi, step);
    const n = ticks.length;
    if (n >= 4 && n <= 6) {
      const score = Math.abs(n - 5) + (k === 1 || k === 2 || k === 5 || k === 10 ? 0 : 0.3);
      if (!best || score < best.score) best = { step, ticks, score };
    }
  }
  if (!best) {
    // 4~6개가 안 되면 6개 이하 중 가장 많은 것
    for (const k of [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50]) {
      const step = base * k;
      const ticks = ticksFor(lo, hi, step);
      if (ticks.length <= 6 && (!best || ticks.length > best.ticks.length)) best = { step, ticks };
    }
  }
  return { ticks: best.ticks, step: best.step };
}

// 축 눈금 표기: 1억 이상 → '1.2억', 그 외 → '1,120만'
export function axisLabel(v) {
  if (v === 0) return '0';
  if (v >= 1e8) return trim(v / 1e8, 2) + '억';
  return trim(v / 1e4, 1).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '만';
}
function trim(x, d) {
  return String(parseFloat(x.toFixed(d)));
}

export function buildStimulus(group, N, now = new Date(), endMonth = null) {
  const g = GROUPS[group];
  if (!g) throw new Error('unknown group ' + group);
  const months = monthLabels(now, endMonth);
  const exact = CUM_RETURNS.map((r) => N * (1 + r)); // 그래프는 오차 없는 값으로 그린다
  const values = exact.map((v) => Math.round(v)); // 화면 표시용 원 단위 값
  const series = values.map((v, i) => ({
    i,
    value: exact[i],
    shown: v,
    ret: CUM_RETURNS[i],
    label: i === 0 ? '시작' : months[i - 1] + '월',
  }));
  const lo = N * g.lo;
  const hi = N * g.hi;
  const { ticks } = niceTicks(lo, hi);
  const current = values[values.length - 1];
  const monthly = [];
  for (let i = 6; i >= 1; i--) {
    monthly.push({
      month: months[i - 1],
      value: values[i],
      cumRet: CUM_RETURNS[i],
      delta: values[i] - values[i - 1],
      principal: N,
      gain: values[i] - N,
    });
  }
  return {
    group,
    N,
    lo,
    hi,
    ticks,
    series,
    monthly,
    current,
    gain: current - N,
    gainPct: (current - N) / N,
    dividend: Math.round((N * DIVIDEND_RATE) / 1000) * 1000,
    occupancy: g.occupancy,
    lieFactor: g.lieFactor,
    months,
  };
}

// SVG 차트. 모든 집단이 같은 크기·색·눈금 개수·격자를 쓰고 Y축 범위만 다르다.
export function chartSVG(stim, width = 380, height = 260) {
  const padL = 56,
    padR = 14,
    padT = 16,
    padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const y = (v) => padT + ((stim.hi - v) / (stim.hi - stim.lo)) * plotH;
  const x = (i) => padL + (i / (stim.series.length - 1)) * plotW;

  const pts = stim.series.map((p) => [x(p.i), y(p.value)]);
  const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');

  const grid = stim.ticks
    .map(
      (t) =>
        `<line class="grid" x1="${padL}" x2="${padL + plotW}" y1="${y(t).toFixed(2)}" y2="${y(t).toFixed(2)}"/>`
    )
    .join('');
  const yl = stim.ticks
    .map(
      (t) =>
        `<text class="ytick" x="${padL - 8}" y="${(y(t) + 4).toFixed(2)}" text-anchor="end">${axisLabel(t)}</text>`
    )
    .join('');
  const xl = stim.series
    .filter((p) => p.i > 0)
    .map(
      (p) =>
        `<text class="xtick" x="${x(p.i).toFixed(2)}" y="${height - 8}" text-anchor="middle">${p.label}</text>`
    )
    .join('');
  const last = pts[pts.length - 1];

  // 같은 구조로 그려 AOI 영역을 측정한다 (data-aoi: 시선 분석용 영역 표시)
  const lineMinY = Math.min(...pts.map((p) => p[1]));
  const lineMaxY = Math.max(...pts.map((p) => p[1]));
  const pad = 8;
  const slope = {
    x: padL - pad,
    y: lineMinY - pad,
    w: plotW + 2 * pad,
    h: lineMaxY - lineMinY + 2 * pad,
  };
  return {
    svg:
      `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="자산 성장 곡선">` +
      `<rect class="plotbg" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" rx="2"/>` +
      grid +
      `<g>${yl}</g>` +
      xl +
      `<path class="line" d="${path}"/>` +
      `<circle class="dot" cx="${last[0].toFixed(2)}" cy="${last[1].toFixed(2)}" r="4"/>` +
      `<rect data-aoi="slope" class="aoi-rect" x="${slope.x.toFixed(2)}" y="${slope.y.toFixed(2)}" width="${slope.w.toFixed(
        2
      )}" height="${slope.h.toFixed(2)}" fill="none" pointer-events="none"/>` +
      `<rect data-aoi="plot" class="aoi-rect" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" pointer-events="none"/>` +
      `<rect data-aoi="axis" class="aoi-rect" x="0" y="${padT - 6}" width="${padL - 4}" height="${plotH + 12}" fill="none" pointer-events="none"/>` +
      `</svg>`,
    geometry: { width, height, padL, padR, padT, padB, plotW, plotH },
    // 화면 점유율 검증용: 12% 상승이 플롯 높이에서 차지하는 비율
    occupancyPx: (y(stim.series[0].value) - y(stim.series[stim.series.length - 1].value)) / plotH,
  };
}
