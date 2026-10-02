# 2026-10-02 실서비스 배포 테스트 결과

## 결과 요약

- 테스트 시나리오: 13종
- 반복 실행: 35회
- 요청: 64건
- 접수: 61건
- 동일 프로젝트 잠금에 따른 HTTP 409: 3건
- 실제 배포: 61건
- 시나리오 판정과 일치: 60건
- 추가 확인 필요: On-Prem 동시 배포 DNS 오류 1건

종합 결과는 [`20261002-comprehensive/report.md`](./20261002-comprehensive/report.md)와 [`summary.csv`](./20261002-comprehensive/summary.csv)에서 확인한다. 공유용 시각 자료는 같은 폴더의 PDF와 PNG다.

## 실행한 시나리오

| 분류 | 반복·요청 |
|---|---:|
| 공개 Health | 20회 |
| AWS 신규 이미지 | 2회 |
| AWS 동일 이미지 재배포 | 3회 |
| On-Prem 신규 이미지 | 3회 |
| On-Prem 동일 이미지 재배포 | 3회 |
| AWS 2건 동시 | 6건 |
| AWS + On-Prem 동시 | 6건 |
| 동일 프로젝트 잠금 | 접수 3건·409 3건 |
| On-Prem → AWS | 3건 |
| AWS → On-Prem | 3건 |
| 검증 실패·롤백 | 3건 |
| On-Prem 2건 동시 | 6건 |
| AWS 3 + On-Prem 2 동시 | 10건 |
| 5분 지속 요청 | 10건 |

AWS 신규 이미지 첫 실행은 테스트 수집기 준비 중 수동 승인 대기가 포함돼 시간 기준선에서 제외했다. 테스트 프로젝트와 보조 Agent를 만들기 위한 초기화 실행도 시나리오 통계에서 제외했다.

## 결과 보존 범위

| 종합 파일 | 내용 |
|---|---|
| `summary.json` | 실행별 조건과 배포·단계·락·검증 결과를 합친 기계 판독 데이터 |
| `summary.csv` | 시나리오별 반복·성공률·중앙값·P95 요약 |
| `report.md`, `report.html` | 사람이 검토하기 위한 종합 보고서 |
| `agent-restart-evidence.json` | Agent 재시작 전후 런타임과 Health 증거 |
| PDF, PNG | 팀 공유용 시각화 자료 |

실행별 원본 폴더는 로컬 또는 CI Artifact에 보존하고 Git에는 커밋하지 않는다. 대용량 k6 point와 콘솔 원문, API 토큰, DB 접속 정보도 커밋하지 않는다.

## 확인된 결과

- 공개 Health 20/20 성공, P95 144ms
- 혼합 5건 동시 요청 10/10 성공
- 5분 지속 요청 10/10 성공, API P95 156ms, 배포 완료 P95 30.54초
- AWS ↔ On-Prem 전환 6/6 성공, 동일 `linux/amd64` image digest 사용
- 동일 프로젝트 동시 요청은 각 반복에서 1건 접수·1건 HTTP 409, 완료 후 전체 `env_locks` 0개
- 검증 실패 후보 3/3 `health_check_failed`, 기존 서비스 Health HTTP 200 유지
- On-Prem 2건 동시 배포는 5/6 성공. 배포 #142는 Agent 실행 완료 후 검증 hostname에서 DNS 오류 8회 발생
- Agent 재시작 시 컨테이너 2/2 유지, 재시작 후 Health HTTP 200. Agent 정지 중 public URL은 HTTP 530
