/**
 * 서버 단계 로그 문구 (#147).
 * 워커는 고정 문구를 키로 남기고, 한 줄 끝에 키 · 값을 붙인다 (apps/worker/src/log-messages.ts):
 *   "[ISO 시각] 빌드 실패: BUILD_FAILED #i18n{"k":"build.failed","p":{"code":"BUILD_FAILED"}}"
 * 화면은 키로 현재 언어 문구를 고른다. 모르는 키 · 키 없는 줄(Terraform 출력 · 오류 상세 등)은 서버 원문 그대로.
 * 한국어 문구는 워커와 같아야 한다 (apps/worker/tests/log-messages.test.ts 가 확인).
 */

export const logLinesKo = {
  'analyze.start': '분석 시작',
  'analyze.cacheReuse': '이전 분석 결과 재사용 (source_version {sourceVersionId})',
  'analyze.unzipped': '소스 압축 해제 완료',
  'analyze.doneValid': '분석 완료 — 서비스 {services}개, 경고 {warnings}개, IR 유효',
  'analyze.doneInvalid': '분석 완료 — 서비스 {services}개, 경고 {warnings}개, IR 검증 실패',
  'analyze.awaitTarget': '대상 확인 대기',
  'analyze.awaitPatch': '코드 수정안 승인 대기 — AWS 는 PostgreSQL, 온프레미스는 SQLite 로 실행됩니다',
  'analyze.failed': '분석 실패: {error}',
  'analyze.staticProfile': '정적 사이트라 AWS 에서는 서버 없이 S3 웹사이트로 배포합니다 (aws-static-basic).',
  'analyze.lambdaFallback': '이 앱은 서버리스(Lambda)로 실행할 수 없어 컨테이너로 배포합니다 — 공개 HTTP 서비스 하나이고 DB 같은 추가 리소스가 없어야 합니다.',
  'analyze.profileSet': '분석 결과에 맞춰 배포 프로필을 {profile} 로 정했습니다.',
  'analyze.patchStart': 'SQLite 사용 감지 — PostgreSQL 도 쓰는 코드 수정안을 만드는 중 (AI)',
  'analyze.patchSkipped': '수정안을 만들지 못함 — {code}: {detail}',
  'analyze.patchReady': '수정안 준비 완료 — 파일 {count}개 ({files})',

  'build.reuseImage': '빌드 생략 — 배포 #{deployment}의 이미지 재사용: {digest}',
  'build.profileSet': 'IR 에 맞춰 배포 프로필을 {profile} 로 정했습니다.',
  'build.ready': '빌드 준비',
  'build.image': '컨테이너 이미지 빌드 및 Registry push',
  'build.staticImage': '정적 사이트 이미지(nginx + 빌드 결과) 빌드 및 Registry push',
  'build.digest': '이미지 digest 확정: {digest}',
  'build.failed': '빌드 실패: {code}',

  'provision.dnsPrepared': '검증용 DNS 사전 준비 완료',
  'provision.agentJobSaved': 'On-Prem Agent Job 저장 완료, Agent 실행을 기다립니다.',
  'provision.staticHasDatabase': '이 환경에는 이전 배포 때 만든 PostgreSQL(RDS)이 있어 정적 사이트(S3)로 바꾸면 DB 가 지워집니다. 앱을 삭제한 뒤 다시 배포하세요.',
  'provision.databaseCreate': 'PostgreSQL(RDS) 추가 모듈 사용 — 처음 만들 때는 DB 생성에 5~10분 걸립니다.',
  'provision.serverlessHasDatabase': '이 환경에는 컨테이너 배포 때 만든 PostgreSQL(RDS)이 있어 서버리스로 바꾸면 DB 가 지워집니다. 컨테이너로 배포하세요.',
  'provision.databaseKeep': '이 환경에 만든 PostgreSQL(RDS)을 유지합니다 (이번 버전은 DB 를 쓰지 않음).',
  'provision.lambdaDone': 'Lambda 배포 완료, 헬스체크 검증을 시작합니다.',
  'provision.ecsDone': 'ECS 롤아웃 완료, 헬스체크 검증을 시작합니다.',
  'provision.failed': '프로비저닝 실패: {code}',
  'provision.egressIpUnknown': '워커 공인 IP 를 확인하지 못했습니다. S3 직접 검증이 거부될 수 있습니다.',
  'provision.staticSite': '정적 사이트 — 서버 없이 S3 웹사이트 호스팅 (버킷 {bucket})',
  'provision.staticReuse': '인프라 변경 없음 — Terraform 생략 (직전 성공 배포 #{deployment} 출력값 재사용)',
  'provision.staticExtract': '이미지 {digest} 에서 정적 파일을 꺼내 S3 에 올립니다.',
  'provision.staticSynced': '정적 파일 동기화 완료, S3 웹사이트 endpoint 검증을 시작합니다.',
  'provision.terraformStart': 'Terraform 실행 시작',
  'provision.terraformApplied': 'Terraform apply 완료, origin endpoint를 수집했습니다.',
  'provision.refreshSkipped': '이미지만 바뀌어 상태 재조회 생략 — 직전 성공 배포 #{deployment} 와 인프라 입력이 같아 -refresh=false 로 plan·apply 를 한 번에 실행합니다.',
  'provision.refreshFirst': '전체 상태 재조회로 plan → apply 를 실행합니다 (이 환경의 첫 Terraform 배포).',
  'provision.refreshLastFailed': '전체 상태 재조회로 plan → apply 를 실행합니다 (직전 배포 #{deployment} 가 성공하지 않음).',
  'provision.refreshInputsChanged': '전체 상태 재조회로 plan → apply 를 실행합니다 (인프라 입력 변경).',

  'terraform.validateSkipped': 'validate 생략 (profile 파일이 직전 성공 때와 같음)',
  'terraform.combinedApply': 'plan·apply 한 번에 (이미지만 바뀐 재배포, -refresh=false)',
  'terraform.tempWorkspace': '같은 작업 폴더를 다른 작업이 쓰고 있어 임시 폴더에서 실행합니다.',
  'terraform.initFirst': '작업 폴더 init (첫 실행)',
  'terraform.initCorrupted': '작업 폴더 init (작업 폴더 손상)',
  'terraform.initConfigChanged': '작업 폴더 init (profile · backend 설정 변경)',
  'terraform.workspaceReused': '작업 폴더 재사용, init 생략',
  'terraform.reinit': '작업 폴더가 Terraform 과 맞지 않아 다시 init 합니다.',
  'terraform.stepDone': 'terraform {step} 완료 ({seconds}초)',
  'terraform.staleLock': '이전 워커가 남긴 Terraform state 락({lock}, {created})을 해제합니다.',

  'ecs.start': 'ECS 롤아웃 확인 시작 (서비스 {service}, {interval}초 간격)',
  'ecs.taskPlacing': '새 태스크 배치 대기 (0/{desired})',
  'ecs.taskStarting': '새 태스크 시작 중 — {states} ({running}/{desired})',
  'ecs.taskRunning': '새 태스크 실행 ({running}/{desired})',
  'ecs.healthFailing': '헬스체크 실패 중: {reason} ({healthy}/{desired} 통과)',
  'ecs.healthPassed': '헬스체크 통과 ({healthy}/{desired})',
  'ecs.healthChecking': '타깃 등록, 헬스체크 진행 중 ({healthy}/{desired} 통과)',
  'ecs.doneDeployment': '롤아웃 완료 ({seconds}초) — ECS 배포 완료',
  'ecs.doneHealthy': '롤아웃 완료 ({seconds}초) — 새 태스크가 타깃 그룹에서 healthy',
  'ecs.forcedNewDeployment': '이미지가 그대로라 바뀐 설정이 없어요 — 새 태스크로 다시 띄웁니다',
  'ecs.oldTargetsRemoved': '이전 태스크 {count}개를 타깃 그룹에서 뺐어요 — 지금부터 새 버전만 응답',
  'ecs.oldTargetsKept': '이전 태스크를 타깃 그룹에서 빼지 못했어요 (ECS 가 곧 내림): {reason}',
  'ecs.waiting': '롤아웃 대기 중 ({seconds}초 경과)',

  'lambda.start': 'Lambda 갱신 확인 시작 (함수 {function}:{alias}, {interval}초 간격)',
  'lambda.pending': '함수 준비 중 (State Pending) — Lambda 가 이미지를 가져와 준비합니다',
  'lambda.updating': '갱신 진행 중 (State {state}, LastUpdateStatus {update})',
  'lambda.done': 'Lambda 갱신 완료 ({seconds}초) — 버전 {version}, 이미지 {digest}',
  'lambda.waiting': 'Lambda 갱신 대기 중 ({seconds}초 경과)',

  'static.extracted': '이미지에서 정적 파일 {count}개를 꺼냈습니다.',
  'static.synced': 'S3 동기화 완료 — 올림 {uploaded} · 그대로 {unchanged} · 지움 {deleted}',

  'verify.originReused': '주소 연결 그대로 — 갱신 생략',
};

export type LogLineKey = keyof typeof logLinesKo;

/** 일본어 — 네이티브 확인 전. 한국어로만 된 값(분석기의 사유 설명 등)은 일본어 문구에서 뺐다 */
export const logLinesJa: Record<LogLineKey, string> = {
  'analyze.start': '分析開始',
  'analyze.cacheReuse': '以前の分析結果を再利用 (source_version {sourceVersionId})',
  'analyze.unzipped': 'ソースの展開完了',
  'analyze.doneValid': '分析完了 — サービス {services}件、警告 {warnings}件、IR 有効',
  'analyze.doneInvalid': '分析完了 — サービス {services}件、警告 {warnings}件、IR 検証失敗',
  'analyze.awaitTarget': 'デプロイ先の確認待ち',
  'analyze.awaitPatch': 'コード修正案の承認待ち — AWS では PostgreSQL、オンプレミスでは SQLite で動作します',
  'analyze.failed': '分析失敗: {error}',
  'analyze.staticProfile': '静的サイトのため、AWS ではサーバーなしで S3 ウェブサイトとしてデプロイします (aws-static-basic)。',
  'analyze.lambdaFallback': 'このアプリはサーバーレス(Lambda)で実行できないため、コンテナでデプロイします — 公開 HTTP サービスが1つで、DB などの追加リソースがないことが条件です。',
  'analyze.profileSet': '分析結果に合わせてデプロイプロファイルを {profile} にしました。',
  'analyze.patchStart': 'SQLite の使用を検出 — PostgreSQL にも対応するコード修正案を作成中 (AI)',
  'analyze.patchSkipped': '修正案を作成できませんでした — {code}',
  'analyze.patchReady': '修正案の準備完了 — ファイル {count}件 ({files})',

  'build.reuseImage': 'ビルド省略 — デプロイ #{deployment} のイメージを再利用: {digest}',
  'build.profileSet': 'IR に合わせてデプロイプロファイルを {profile} にしました。',
  'build.ready': 'ビルド準備',
  'build.image': 'コンテナイメージのビルドと Registry への push',
  'build.staticImage': '静的サイトイメージ(nginx + ビルド結果)のビルドと Registry への push',
  'build.digest': 'イメージ digest 確定: {digest}',
  'build.failed': 'ビルド失敗: {code}',

  'provision.dnsPrepared': '検証用 DNS の事前準備完了',
  'provision.agentJobSaved': 'On-Prem Agent Job を保存しました。Agent の実行を待っています。',
  'provision.staticHasDatabase': 'この環境には以前のデプロイで作成した PostgreSQL(RDS) があり、静的サイト(S3)に切り替えると DB が削除されます。アプリを削除してから再度デプロイしてください。',
  'provision.databaseCreate': 'PostgreSQL(RDS) 追加モジュールを使用 — 初回は DB の作成に 5〜10分かかります。',
  'provision.serverlessHasDatabase': 'この環境にはコンテナのデプロイで作成した PostgreSQL(RDS) があり、サーバーレスに切り替えると DB が削除されます。コンテナでデプロイしてください。',
  'provision.databaseKeep': 'この環境に作成した PostgreSQL(RDS) を維持します (このバージョンは DB を使いません)。',
  'provision.lambdaDone': 'Lambda のデプロイ完了。ヘルスチェックの検証を開始します。',
  'provision.ecsDone': 'ECS のロールアウト完了。ヘルスチェックの検証を開始します。',
  'provision.failed': 'プロビジョニング失敗: {code}',
  'provision.egressIpUnknown': 'ワーカーのパブリック IP を確認できませんでした。S3 への直接検証が拒否される可能性があります。',
  'provision.staticSite': '静的サイト — サーバーなしで S3 ウェブサイトホスティング (バケット {bucket})',
  'provision.staticReuse': 'インフラ変更なし — Terraform を省略 (直前に成功したデプロイ #{deployment} の出力値を再利用)',
  'provision.staticExtract': 'イメージ {digest} から静的ファイルを取り出して S3 にアップロードします。',
  'provision.staticSynced': '静的ファイルの同期完了。S3 ウェブサイト endpoint の検証を開始します。',
  'provision.terraformStart': 'Terraform 実行開始',
  'provision.terraformApplied': 'Terraform apply 完了。origin endpoint を取得しました。',
  'provision.refreshSkipped': 'イメージだけの変更のため状態の再取得を省略 — 直前に成功したデプロイ #{deployment} とインフラ入力が同じなので、-refresh=false で plan·apply を一度に実行します。',
  'provision.refreshFirst': '状態をすべて再取得して plan → apply を実行します (この環境で初めての Terraform デプロイ)。',
  'provision.refreshLastFailed': '状態をすべて再取得して plan → apply を実行します (直前のデプロイ #{deployment} が成功していません)。',
  'provision.refreshInputsChanged': '状態をすべて再取得して plan → apply を実行します (インフラ入力の変更)。',

  'terraform.validateSkipped': 'validate 省略 (profile ファイルが前回の成功時と同じ)',
  'terraform.combinedApply': 'plan·apply を一度に (イメージだけ変わった再デプロイ、-refresh=false)',
  'terraform.tempWorkspace': '同じ作業フォルダーを別の処理が使用中のため、一時フォルダーで実行します。',
  'terraform.initFirst': '作業フォルダー init (初回実行)',
  'terraform.initCorrupted': '作業フォルダー init (作業フォルダーの破損)',
  'terraform.initConfigChanged': '作業フォルダー init (profile · backend 設定の変更)',
  'terraform.workspaceReused': '作業フォルダーを再利用、init 省略',
  'terraform.reinit': '作業フォルダーが Terraform と合わないため、もう一度 init します。',
  'terraform.stepDone': 'terraform {step} 完了 ({seconds}秒)',
  'terraform.staleLock': '以前のワーカーが残した Terraform state ロック({lock}, {created})を解除します。',

  'ecs.start': 'ECS ロールアウトの確認開始 (サービス {service}、{interval}秒間隔)',
  'ecs.taskPlacing': '新しいタスクの配置待ち (0/{desired})',
  'ecs.taskStarting': '新しいタスクを起動中 — {states} ({running}/{desired})',
  'ecs.taskRunning': '新しいタスクが実行中 ({running}/{desired})',
  'ecs.healthFailing': 'ヘルスチェック失敗中: {reason} ({healthy}/{desired} 合格)',
  'ecs.healthPassed': 'ヘルスチェック合格 ({healthy}/{desired})',
  'ecs.healthChecking': 'ターゲット登録済み、ヘルスチェック中 ({healthy}/{desired} 合格)',
  'ecs.doneDeployment': 'ロールアウト完了 ({seconds}秒) — ECS デプロイ完了',
  'ecs.doneHealthy': 'ロールアウト完了 ({seconds}秒) — 新しいタスクがターゲットグループで healthy',
  'ecs.forcedNewDeployment': 'イメージが同じため設定の変更はありません — 新しいタスクで起動し直します',
  'ecs.oldTargetsRemoved': '以前のタスク {count} 個をターゲットグループから外しました — 以降は新しいバージョンのみ応答',
  'ecs.oldTargetsKept': '以前のタスクをターゲットグループから外せませんでした (ECS がまもなく停止): {reason}',
  'ecs.waiting': 'ロールアウト待機中 ({seconds}秒経過)',

  'lambda.start': 'Lambda の更新確認開始 (関数 {function}:{alias}、{interval}秒間隔)',
  'lambda.pending': '関数を準備中 (State Pending) — Lambda がイメージを取得して準備しています',
  'lambda.updating': '更新中 (State {state}, LastUpdateStatus {update})',
  'lambda.done': 'Lambda の更新完了 ({seconds}秒) — バージョン {version}、イメージ {digest}',
  'lambda.waiting': 'Lambda の更新待機中 ({seconds}秒経過)',

  'static.extracted': 'イメージから静的ファイルを {count}件取り出しました。',
  'static.synced': 'S3 同期完了 — アップロード {uploaded} · 変更なし {unchanged} · 削除 {deleted}',

  'verify.originReused': 'アドレスの接続はそのまま — 更新を省略',
};

const MARKER = ' #i18n';

export interface LogTag { key: string; params: Record<string, string | number> }

/** 한 줄에서 [시각] · 서버 원문 · 키를 나눈다. 키가 없거나 읽을 수 없으면 tag = null */
function splitLine(line: string): { time: string; text: string; tag: LogTag | null } {
  const time = /^\[[^\]]*\] /.exec(line)?.[0] ?? '';
  const body = line.slice(time.length);
  const at = body.lastIndexOf(MARKER);
  if (at < 0) return { time, text: body, tag: null };
  try {
    const raw = JSON.parse(body.slice(at + MARKER.length)) as { k?: unknown; p?: unknown };
    if (typeof raw.k !== 'string') return { time, text: body, tag: null };
    const params = raw.p && typeof raw.p === 'object' ? raw.p as Record<string, string | number> : {};
    return { time, text: body.slice(0, at), tag: { key: raw.k, params } };
  } catch {
    return { time, text: body, tag: null };
  }
}

/** 로그 한 줄의 키 · 값 (키로 쓴 줄만) */
export function readLogTag(line: string): LogTag | null {
  return splitLine(line).tag;
}

/** 로그 한 줄을 현재 언어로. 모르는 키 · 키 없는 줄은 서버 원문(키 표시만 뗌) */
export function localizeLogLine(line: string, templates: Record<string, string>): string {
  const { time, text, tag } = splitLine(line);
  const template = tag ? templates[tag.key] : undefined;
  if (!tag || template === undefined) return `${time}${text}`;
  return time + template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = tag.params[name];
    return value === undefined ? whole : String(value);
  });
}

/** 여러 줄 로그를 한 줄씩 현재 언어로 */
export function localizeLogText(text: string, templates: Record<string, string>): string {
  return text.split('\n').map((line) => localizeLogLine(line, templates)).join('\n');
}
