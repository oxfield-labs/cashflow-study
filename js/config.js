// 배포 전에 이 파일만 고치면 된다. (docs/DEPLOY.md 참고)
// SUPABASE_URL / SUPABASE_ANON_KEY 를 비워 두면 "로컬 모드"로 동작한다: 응답이 이 브라우저에만 저장되므로 리허설 용도로만 쓴다.
// anon 키는 공개되어도 되는 키다. (테이블은 RLS로 잠겨 있고 RPC 3개만 열려 있다.) service_role 키는 절대 여기에 넣지 말 것.
export const CONFIG = {
  SUPABASE_URL: 'https://xiwvncqeqhcnrqmhnrli.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhpd3ZuY3FlcWhjbnJxbWhucmxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5Mzg1NzEsImV4cCI6MjEwODUxNDU3MX0.khtovY0eUDCSk_Uko3EwwDqlMZEUz5feRF2XkBULZK4',

  STUDY_TITLE: '모바일 금융 앱 화면 인식 연구',
  APP_NAME: 'Cashflow',
  IRB_NUMBER: '심의 준비 중', // 심의(또는 면제) 확인 후 번호로 교체
  PILOT_NOTICE: '이 설문은 시스템과 문항을 점검하는 파일럿입니다. 이번 응답은 실제 연구 자료로 활용되지 않습니다.', // 본 실험 때는 빈 문자열('')로 바꾸면 동의 화면에서 사라진다
  CLOSE_AT: '2026-11-03T19:00:00+09:00', // 파일럿 접수 마감(이 시각 이후 접속하면 종료 안내만 보인다). 본 실험 때는 ''로 비운다
  RESEARCHER_EMAIL: 'oooks83@gmail.com', // 철회 요청 메일 주소 (종료 화면의 '이메일로 철회 요청' 버튼)
  WITHDRAW_DEADLINE: '자료 분석이 시작되기 전', // 이 날짜 이후에는 분석이 시작되어 철회가 어렵다
  TARGET_DESC: '만 19~39세, 최근 금융 앱을 이용해 보신 분', // 참여 조건 탈락 화면에 쓰는 대상 안내 (일반적 범위만. 어떤 문항 때문인지는 알리지 않는다)

  // 개발용 모드(?debug=1, ?design=1) 허용 여부. 운영(파일럿·본 실험)에서는 반드시 false. 로컬 서버(localhost)에서는 이 값과 무관하게 열린다.
  ALLOW_DEV_MODES: false,

  SHOW_COMPLETION_CODE: true, // 패널·크라우드 모집에서 '참여 확인'용 코드가 필요 없으면 false

  NEXT_STYLE: 'fill', // 자극물 화면의 '다음' 버튼: 'reveal'(시간이 되면 부드럽게 등장) | 'fill'(처음부터 보이고 안쪽이 차오름)
  MIN_EXPOSURE_SEC: 20, // 자극물 최소 노출 시간(초). 파일럿에서 조정
  TARGET_MIN: 5, // 안내문에 쓰는 예상 소요 시간(분)
  TARGET_MAX: 10,

  // 자극물 표시 월. null이면 참여 시점의 직전 달을 마지막 달로 사용
  END_MONTH: null,
};
