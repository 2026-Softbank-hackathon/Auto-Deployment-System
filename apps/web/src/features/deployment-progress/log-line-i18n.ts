/**
 * 서버가 남기는 단계 로그는 한국어 고정 문구다(apps/worker 의 stepLog.line).
 * 진행 탭의 "지금" 줄은 화면 언어를 따라야 하므로, 알려진 문구만 일본어로 옮긴다.
 * 모르는 한국어 문구는 일본어 화면에서 보여 주지 않는다(null). Terraform 출력처럼 한글이 없는 줄은 그대로 둔다.
 * 로그 탭은 서버 로그 원문을 그대로 보여 주므로 여기를 거치지 않는다.
 */
const jaRules: ReadonlyArray<readonly [RegExp, string]> = [
  [/^분석 시작$/, '分析を開始'],
  [/^소스 압축 해제 완료$/, 'ソースの展開が完了'],
  [/^이전 분석 결과 재사용 \((.*)\)$/, '以前の分析結果を再利用 ($1)'],
  [/^분석 완료 — 서비스 (\d+)개, 경고 (\d+)개, IR 유효$/, '分析完了 — サービス $1件、警告 $2件、IR 有効'],
  [/^분석 완료 — 서비스 (\d+)개, 경고 (\d+)개, IR 검증 실패$/, '分析完了 — サービス $1件、警告 $2件、IR 検証失敗'],
  [/^대상 확인 대기$/, 'デプロイ先の確認待ち'],
  [/^분석 실패: (.*)$/, '分析に失敗: $1'],
  [/^빌드 준비$/, 'ビルドの準備'],
  [/^컨테이너 이미지 빌드 및 Registry push$/, 'コンテナイメージのビルドと Registry への push'],
  [/^이미지 digest 확정: (.*)$/, 'イメージ digest 確定: $1'],
  [/^빌드 실패: (.*)$/, 'ビルドに失敗: $1'],
  [/^검증용 DNS 사전 준비 완료$/, '検証用 DNS の事前準備が完了'],
  [/^Terraform init · validate · plan · apply 시작$/, 'Terraform init · validate · plan · apply を開始'],
  [/^Terraform apply 완료, origin endpoint를 수집했습니다\.$/, 'Terraform apply 完了、origin endpoint を取得しました'],
  [/^On-Prem Agent Job 저장 완료, Agent 실행을 기다립니다\.$/, 'On-Prem Agent Job を保存、Agent の実行を待っています'],
  [/^인프라 적용 완료, 롤아웃 및 헬스체크 검증을 시작합니다\.$/, 'インフラの適用が完了、ロールアウトとヘルスチェックの検証を開始します'],
  [/^프로비저닝 실패: (.*)$/, 'プロビジョニングに失敗: $1'],
];

const HANGUL = /[가-힣]/;

/** 시각을 뗀 로그 한 줄을 화면 언어로. 보여 줄 수 없으면 null. */
export function localizeLogLine(text: string, locale: string): string | null {
  if (!locale.startsWith('ja')) return text;
  for (const [pattern, replacement] of jaRules) if (pattern.test(text)) return text.replace(pattern, replacement);
  return HANGUL.test(text) ? null : text;
}
