# 로컬 성능 테스트 결과

`run.sh`가 실행별 폴더를 생성한다. API 토큰은 기록하지 않는다.

공유할 실행은 `tests/performance/archive-run.sh <실행 폴더>`로 `docs/performance-results/`에 요약 산출물을 복사한다. 대용량 `k6-points.json`과 상세 로그는 로컬 또는 CI Artifact에 보존한다.
