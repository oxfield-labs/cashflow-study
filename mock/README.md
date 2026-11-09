# 목업 운영 규칙 (mock/)

- 주소: `<배포 주소>/mock/` (예: https://oxfield-labs.github.io/cashflow-study/mock/)
- 목업은 실험 앱과 **같은 파일**(js/app.js, questions.js, stimulus.js, config.js, css/style.css)을 씁니다. 문구·문항·화면·설정(CONFIG)을 고치면 목업에도 자동으로 같이 바뀝니다. 목업 전용 문구는 없습니다.
- 목업과 운영의 차이는 `mock/app.html` 의 `window.__MOCK = true` 한 줄입니다. 켜지면: 서버·브라우저 저장소에 쓰지 않음(메모리만), 개발용 옵션(?design, ?preview, ?g 등) 허용, 마감일 무시(엣지 케이스 버튼으로만 확인).
- 운영 `index.html` 에는 `__MOCK` 이 없어서 위 분기가 모두 꺼져 있고 `ALLOW_DEV_MODES` 도 false 입니다.
- 본 실험 전 갱신 순서: config.js 의 CLOSE_AT, IRB_NUMBER, PILOT_NOTICE('') 를 고치면 운영·목업이 함께 바뀝니다. 목업의 '연구 구조' 표에서 확인하세요.
- 수정 후 점검: 목업 '전체 흐름 검토'에서 화면을 훑고, A/B/C 전환과 엣지 케이스를 확인한 뒤 push.
