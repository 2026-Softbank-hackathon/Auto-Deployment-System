/**
 * apps/worker/src/log-messages.ts
 *
 * 단계 로그 문구 (#147). 워커가 남기는 고정 문구는 여기 키로만 쓴다.
 * 로그 한 줄에는 한국어 문구와 함께 키 · 값을 붙여 두고(formatLogText), 웹은 키로 현재 언어 문구를 고른다.
 *   "[ISO 시각] 빌드 실패: BUILD_FAILED #i18n{"k":"build.failed","p":{"code":"BUILD_FAILED"}}"
 * 웹 사전: apps/web/src/i18n/log-lines.ts (한국어 · 일본어). 키를 더하면 거기도 같이 더한다 (tests/log-messages.test.ts 가 확인).
 * 도구 출력 · 오류 상세처럼 그대로 보여 줄 줄은 문자열로 넘긴다 (키 없음 → 원문 그대로).
 */

export const LOG_MESSAGES = {
  // analyze
  "analyze.start": "분석 시작",
  "analyze.cacheReuse": "이전 분석 결과 재사용 (source_version {sourceVersionId})",
  "analyze.unzipped": "소스 압축 해제 완료",
  "analyze.doneValid": "분석 완료 — 서비스 {services}개, 경고 {warnings}개, IR 유효",
  "analyze.doneInvalid": "분석 완료 — 서비스 {services}개, 경고 {warnings}개, IR 검증 실패",
  "analyze.awaitTarget": "대상 확인 대기",
  "analyze.awaitPatch": "코드 수정안 승인 대기 — AWS 는 PostgreSQL, 온프레미스는 SQLite 로 실행됩니다",
  "analyze.failed": "분석 실패: {error}",
  "analyze.staticProfile": "정적 사이트라 AWS 에서는 서버 없이 S3 웹사이트로 배포합니다 (aws-static-basic).",
  "analyze.lambdaFallback":
    "이 앱은 서버리스(Lambda)로 실행할 수 없어 컨테이너로 배포합니다 — 공개 HTTP 서비스 하나이고 DB 같은 추가 리소스가 없어야 합니다.",
  "analyze.profileSet": "분석 결과에 맞춰 배포 프로필을 {profile} 로 정했습니다.",
  "analyze.patchStart": "SQLite 사용 감지 — PostgreSQL 도 쓰는 코드 수정안을 만드는 중 (AI)",
  "analyze.patchSkipped": "수정안을 만들지 못함 — {code}: {detail}",
  "analyze.patchReady": "수정안 준비 완료 — 파일 {count}개 ({files})",

  // build
  "build.reuseImage": "빌드 생략 — 배포 #{deployment}의 이미지 재사용: {digest}",
  "build.profileSet": "IR 에 맞춰 배포 프로필을 {profile} 로 정했습니다.",
  "build.ready": "빌드 준비",
  "build.image": "컨테이너 이미지 빌드 및 Registry push",
  "build.staticImage": "정적 사이트 이미지(nginx + 빌드 결과) 빌드 및 Registry push",
  "build.digest": "이미지 digest 확정: {digest}",
  "build.failed": "빌드 실패: {code}",

  // provision
  "provision.dnsPrepared": "검증용 DNS 사전 준비 완료",
  "provision.agentJobSaved": "On-Prem Agent Job 저장 완료, Agent 실행을 기다립니다.",
  "provision.staticHasDatabase":
    "이 환경에는 이전 배포 때 만든 PostgreSQL(RDS)이 있어 정적 사이트(S3)로 바꾸면 DB 가 지워집니다. 앱을 삭제한 뒤 다시 배포하세요.",
  "provision.databaseCreate": "PostgreSQL(RDS) 추가 모듈 사용 — 처음 만들 때는 DB 생성에 5~10분 걸립니다.",
  "provision.serverlessHasDatabase":
    "이 환경에는 컨테이너 배포 때 만든 PostgreSQL(RDS)이 있어 서버리스로 바꾸면 DB 가 지워집니다. 컨테이너로 배포하세요.",
  "provision.databaseKeep": "이 환경에 만든 PostgreSQL(RDS)을 유지합니다 (이번 버전은 DB 를 쓰지 않음).",
  "provision.lambdaDone": "Lambda 배포 완료, 헬스체크 검증을 시작합니다.",
  "provision.ecsDone": "ECS 롤아웃 완료, 헬스체크 검증을 시작합니다.",
  "provision.failed": "프로비저닝 실패: {code}",
  "provision.egressIpUnknown": "워커 공인 IP 를 확인하지 못했습니다. S3 직접 검증이 거부될 수 있습니다.",
  "provision.staticSite": "정적 사이트 — 서버 없이 S3 웹사이트 호스팅 (버킷 {bucket})",
  "provision.staticReuse": "인프라 변경 없음 — Terraform 생략 (직전 성공 배포 #{deployment} 출력값 재사용)",
  "provision.staticExtract": "이미지 {digest} 에서 정적 파일을 꺼내 S3 에 올립니다.",
  "provision.staticSynced": "정적 파일 동기화 완료, S3 웹사이트 endpoint 검증을 시작합니다.",
  "provision.terraformStart": "Terraform 실행 시작",
  "provision.terraformApplied": "Terraform apply 완료, origin endpoint를 수집했습니다.",
  "provision.refreshSkipped":
    "이미지만 바뀌어 상태 재조회 생략 — 직전 성공 배포 #{deployment} 와 인프라 입력이 같아 -refresh=false 로 plan·apply 를 한 번에 실행합니다.",
  "provision.refreshFirst": "전체 상태 재조회로 plan → apply 를 실행합니다 (이 환경의 첫 Terraform 배포).",
  "provision.refreshLastFailed": "전체 상태 재조회로 plan → apply 를 실행합니다 (직전 배포 #{deployment} 가 성공하지 않음).",
  "provision.refreshInputsChanged": "전체 상태 재조회로 plan → apply 를 실행합니다 (인프라 입력 변경).",

  // Terraform CLI
  "terraform.validateSkipped": "validate 생략 (profile 파일이 직전 성공 때와 같음)",
  "terraform.combinedApply": "plan·apply 한 번에 (이미지만 바뀐 재배포, -refresh=false)",
  "terraform.tempWorkspace": "같은 작업 폴더를 다른 작업이 쓰고 있어 임시 폴더에서 실행합니다.",
  "terraform.initFirst": "작업 폴더 init (첫 실행)",
  "terraform.initCorrupted": "작업 폴더 init (작업 폴더 손상)",
  "terraform.initConfigChanged": "작업 폴더 init (profile · backend 설정 변경)",
  "terraform.workspaceReused": "작업 폴더 재사용, init 생략",
  "terraform.reinit": "작업 폴더가 Terraform 과 맞지 않아 다시 init 합니다.",
  "terraform.stepDone": "terraform {step} 완료 ({seconds}초)",
  "terraform.staleLock": "이전 워커가 남긴 Terraform state 락({lock}, {created})을 해제합니다.",

  // ECS 롤아웃
  "ecs.start": "ECS 롤아웃 확인 시작 (서비스 {service}, {interval}초 간격)",
  "ecs.taskPlacing": "새 태스크 배치 대기 (0/{desired})",
  "ecs.taskStarting": "새 태스크 시작 중 — {states} ({running}/{desired})",
  "ecs.taskRunning": "새 태스크 실행 ({running}/{desired})",
  "ecs.healthFailing": "헬스체크 실패 중: {reason} ({healthy}/{desired} 통과)",
  "ecs.healthPassed": "헬스체크 통과 ({healthy}/{desired})",
  "ecs.healthChecking": "타깃 등록, 헬스체크 진행 중 ({healthy}/{desired} 통과)",
  "ecs.doneDeployment": "롤아웃 완료 ({seconds}초) — ECS 배포 완료",
  "ecs.doneHealthy": "롤아웃 완료 ({seconds}초) — 새 태스크가 타깃 그룹에서 healthy",
  "ecs.waiting": "롤아웃 대기 중 ({seconds}초 경과)",

  // Lambda 롤아웃
  "lambda.start": "Lambda 갱신 확인 시작 (함수 {function}:{alias}, {interval}초 간격)",
  "lambda.pending": "함수 준비 중 (State Pending) — Lambda 가 이미지를 가져와 준비합니다",
  "lambda.updating": "갱신 진행 중 (State {state}, LastUpdateStatus {update})",
  "lambda.done": "Lambda 갱신 완료 ({seconds}초) — 버전 {version}, 이미지 {digest}",
  "lambda.waiting": "Lambda 갱신 대기 중 ({seconds}초 경과)",

  // 정적 사이트 S3 동기화
  "static.extracted": "이미지에서 정적 파일 {count}개를 꺼냈습니다.",
  "static.synced": "S3 동기화 완료 — 올림 {uploaded} · 그대로 {unchanged} · 지움 {deleted}",

  // verify
  "verify.originReused": "주소 연결 그대로 — 갱신 생략",
} as const;

export type LogKey = keyof typeof LOG_MESSAGES;
export type LogParams = Record<string, string | number>;
export type LogMessage = { key: LogKey; params?: LogParams };
/** 단계 로그 한 줄: 키로 쓴 문구, 또는 원문 그대로 보여 줄 문자열(도구 출력 · 오류 상세) */
export type LogText = string | LogMessage;

/** 로그 줄 끝에 붙는 키 · 값 표시. 웹이 이 뒤의 JSON 을 읽는다 */
export const LOG_I18N_MARKER = " #i18n";

/** 값의 줄바꿈은 공백으로 — 로그는 한 줄 단위로 읽는다 */
export function logMessage(key: LogKey, params?: LogParams): LogMessage {
  if (!params) return { key };
  const oneLine = Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      typeof value === "string" ? value.replace(/\s*\r?\n\s*/g, " ") : value,
    ]),
  );
  return { key, params: oneLine };
}

/** 한국어 문구. 없는 값은 {이름} 그대로 둔다 */
export function renderLogText(text: LogText): string {
  if (typeof text === "string") return text;
  return LOG_MESSAGES[text.key].replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = text.params?.[name];
    return value === undefined ? whole : String(value);
  });
}

/** 로그 파일 · SSE 에 쓰는 내용 (시각 제외). 키로 쓴 문구는 한국어 문구 뒤에 키 · 값을 붙인다 */
export function formatLogText(text: LogText): string {
  if (typeof text === "string") return text;
  const tag = text.params ? { k: text.key, p: text.params } : { k: text.key };
  return `${renderLogText(text)}${LOG_I18N_MARKER}${JSON.stringify(tag)}`;
}
