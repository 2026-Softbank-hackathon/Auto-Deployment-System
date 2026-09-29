# 열린 항목 · 알려진 불일치

## A. 문서 간 불일치 (코드 착수 전에 수정)
| # | 위치 | 현재 | 고쳐야 할 상태 | 근거 |
|---|---|---|---|---|
| A-1 | architecture.md 5.3 상태 머신, 02_state.mmd | 접수 단계에서 락 획득, 환경 확정 대기 상태 없음 | `awaiting_target_confirmation` 추가, 락은 환경 확정 직후 획득 | D-15, ERD v2 deployments.state |
| A-2 | architecture.md 5.2 원클릭 배포, 01_deploy.mmd | 4번 "대상 환경 락 획득"이 접수 직후 | 환경 확정(14) 뒤로 이동 | D-15 |
| A-3 | architecture.md 3.2/4.10/4.15, architecture_v3 다이어그램(Redis 카드) | Redis = 작업 큐 · 이벤트 스트림 | 작업 큐는 Postgres, Redis는 이벤트 스트림·캐시 | D-11 |
| A-4 | architecture.md 7장 데이터 모델 | 11개 테이블 초안 | docs/erd/ v2 (33 테이블)로 대체 | ERD v2 |
| A-5 | architecture.md 4.17 관계 매트릭스 | 오케스트레이터 → Redis(작업 큐) | 오케스트레이터 → Postgres(jobs) | D-11 |
| A-6 | functional-spec.md 27장 매핑 | USR-05 누락, S·X 11개 미매핑 | USR-05 → API 서버·워커 풀, S·X는 architecture.md 4장 기능 ID 참조 | 세션 검증 |
| A-7 | 데이터 사전 v1 대비 | approvals 소유 API 서버 | 오케스트레이터 | D-26 |

## B. 운영진 확인 필요 (#term1_all_question)
- ₩300,000 지원에 AI API 비용 포함 여부
- 온프레미스 배포 결과도 "누구나 접근 가능" 조건 적용 여부
- "앱 업로드" 범위: 파일 업로드만 / Git 연동 허용
- 킥오프 이전 코드·기존 오픈소스(Defang, Coolify 등) 재사용 허용 범위
- 클라우드 지원금 정산 방식(사전 비용 부담)
- 현장 네트워크(와이파이, 포트)
- 본선 주제·팀 재편성 여부

## C. 리스크
- 필수(M) 기능 약 100개 → 데모에서 실제로 보여줄 것 / 설계로만 보여줄 것 구분 필요
- 라이브 데모 시간(관리형 DB 생성 수 분) → 사전 프로비저닝
- macOS VM은 Apple 하드웨어에서만 → arm64 이미지 + 팀원 맥북
- LLM 코드 수정 품질 → 검증 워커 + 규칙 기반 대체 경로
- 샌드박스 보안 수준 결정 필요

## D. ERD Cloud
- 사용자가 ERD Cloud에 v1(28 테이블)을 수동 입력함(논리명 한글/물리명 영문). ERD Cloud SQL 가져오기는 이름 하나를 논리·물리 양쪽에 복사하고, MySQL `COMMENT`는 논리명으로 읽지 않음(확인됨). Oracle/PostgreSQL `COMMENT ON` 매핑은 미확인.
- v2 반영분은 docs/erd/ERD_변경목록_v2.md 참고 (새 테이블 5, 수정 11, 관계선 추가 23)
