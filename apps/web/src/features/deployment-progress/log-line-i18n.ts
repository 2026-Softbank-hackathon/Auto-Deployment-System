/**
 * 서버가 남기는 단계 로그는 한국어 문구다 (apps/worker 의 stepLog.line · ecs-rollout · terraform-cli).
 * 진행 탭에서 코로가 이 로그를 말풍선으로 읽어 주는데, 화면 언어를 따라야 하므로 알려진 문구만 일본어로 옮긴다.
 * 모르는 한국어 문구는 일본어 화면에서 보여 주지 않는다(null). 한글이 없는 줄은 그대로 둔다.
 * 로그 탭은 서버 로그 원문을 그대로 보여 주므로 여기를 거치지 않는다.
 */
const jaRules: ReadonlyArray<readonly [RegExp, string]> = [
  [/^분석 시작$/, '分析を開始'],
  [/^소스 압축 해제 완료$/, 'ソースの展開が完了'],
  [/^이전 분석 결과 재사용 \((.*)\)$/, '以前の分析結果を再利用 ($1)'],
  [/^분석 완료 — 서비스 (\d+)개, 경고 (\d+)개, IR 유효$/, '分析完了 — サービス $1件、警告 $2件、IR 有効'],
  [/^분석 완료 — 서비스 (\d+)개, 경고 (\d+)개, IR 검증 실패$/, '分析完了 — サービス $1件、警告 $2件、IR 検証失敗'],
  [/^대상 확인 대기$/, 'デプロイ先の確認待ち'],
  [/^빌드 준비$/, 'ビルドの準備'],
  [/^컨테이너 이미지 빌드 및 Registry push$/, 'コンテナイメージのビルドと Registry への push'],
  [/^이미지 digest 확정: (.*)$/, 'イメージ digest 確定: $1'],
  [/^빌드 생략 — 배포 #(\d+)의 이미지 재사용: (.*)$/, 'ビルドを省略 — デプロイ #$1 のイメージを再利用'],
  [/^검증용 DNS 사전 준비 완료$/, '検証用 DNS の事前準備が完了'],
  [/^On-Prem Agent Job 저장 완료, Agent 실행을 기다립니다\.$/, 'エージェントに作業を渡しました。実行を待っています'],
  [/^Terraform 실행 시작$/, 'Terraform の実行を開始'],
  [/^작업 폴더 init \((.*)\)$/, '作業フォルダーを init'],
  [/^작업 폴더 재사용, init 생략$/, '作業フォルダーを再利用、init を省略'],
  [/^validate 생략 .*$/, 'validate を省略'],
  [/^plan·apply 한 번에 .*$/, 'plan と apply を一度に実行 (イメージだけの更新)'],
  [/^terraform (\w+) 완료 \(([\d.]+)초\)$/, 'terraform $1 完了 ($2秒)'],
  [/^Terraform apply 완료, origin endpoint를 수집했습니다\.$/, 'Terraform apply 完了'],
  [/^ECS 롤아웃 확인 시작 .*$/, 'ECS ロールアウトの確認を開始'],
  [/^새 태스크 배치 대기 \((\d+)\/(\d+)\)$/, '新しいタスクの配置待ち ($1/$2)'],
  [/^새 태스크 시작 중 — .* \((\d+)\/(\d+)\)$/, '新しいタスクを起動中 ($1/$2)'],
  [/^새 태스크 실행 \((\d+)\/(\d+)\)$/, '新しいタスクが実行中 ($1/$2)'],
  [/^타깃 등록, 헬스체크 진행 중 \((\d+)\/(\d+) 통과\)$/, 'ターゲット登録、ヘルスチェック中 ($1/$2 成功)'],
  [/^헬스체크 통과 \((\d+)\/(\d+)\)$/, 'ヘルスチェック成功 ($1/$2)'],
  [/^롤아웃 대기 중 \((\d+)초 경과\)$/, 'ロールアウト待ち ($1秒経過)'],
  [/^롤아웃 완료 \((\d+)초\) — .*$/, 'ロールアウト完了 ($1秒)'],
  [/^ECS 롤아웃 완료, 헬스체크 검증을 시작합니다\.$/, 'ECS ロールアウト完了、ヘルスチェックの検証を開始します'],
];

/** 말풍선에 그대로 내보내기에는 길거나 덜 중요한 부분을 줄인다 (한국어 화면) */
const koRules: ReadonlyArray<readonly [RegExp, string]> = [
  [/^이미지 digest 확정: .*$/, '이미지 digest 확정'],
  [/^빌드 생략 — 배포 #(\d+)의 이미지 재사용: .*$/, '빌드 생략 — 배포 #$1의 이미지 재사용'],
  [/^ECS 롤아웃 확인 시작 .*$/, 'ECS 롤아웃 확인 시작'],
  [/^작업 폴더 init \(.*\)$/, '작업 폴더 init'],
  [/^Terraform apply 완료, origin endpoint를 수집했습니다\.$/, 'Terraform apply 완료'],
];

const HANGUL = /[가-힣]/;
/** 실패 · 오류 줄은 말풍선에 올리지 않는다 (실패 원인 탭이 다룬다) */
const SKIP = /실패|Error|error/;

/** 로그 한 줄("[시각] 내용")을 말풍선에 쓸 문장으로. 보여 줄 수 없으면 null. */
export function logLineForBubble(line: string, locale: string): string | null {
  const text = line.replace(/^\[[^\]]+\]\s*/, '').trim();
  if (!text || text.length > 90 || SKIP.test(text)) return null;
  if (!locale.startsWith('ja')) {
    for (const [pattern, replacement] of koRules) if (pattern.test(text)) return text.replace(pattern, replacement);
    return text;
  }
  for (const [pattern, replacement] of jaRules) if (pattern.test(text)) return text.replace(pattern, replacement);
  return HANGUL.test(text) ? null : text;
}
