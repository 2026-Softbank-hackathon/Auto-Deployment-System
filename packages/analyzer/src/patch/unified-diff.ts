/**
 * packages/analyzer/src/patch/unified-diff.ts
 *
 * 수정안 화면에 보여 줄 unified diff (git diff 와 같은 모양) — 줄 단위 LCS.
 * 사용자 앱 소스 몇 개 파일이라 O(n·m) 로 충분하다. 너무 크면 전체 교체 hunk 하나로 보여 준다.
 */

const MAX_LCS_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; line: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_LCS_CELLS) {
    return [...a.map((line) => ({ kind: "-" as const, line })), ...b.map((line) => ({ kind: "+" as const, line }))];
  }
  // lcs[i][j] = a[i..] 와 b[j..] 의 LCS 길이
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ kind: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++]! });
  while (j < m) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

/**
 * before(null 이면 새 파일) → after 의 unified diff. 같으면 빈 문자열.
 */
export function createUnifiedDiff(
  path: string,
  before: string | null,
  after: string,
  context = 3,
): string {
  if (before === after) return "";
  const a = splitLines(before ?? "");
  const b = splitLines(after);
  const ops = diffLines(a, b);

  // 바뀐 줄 앞뒤 context 줄만 남겨 hunk 로 묶는다
  const changed = ops.map((op) => op.kind !== " ");
  const keep = ops.map((_, index) => {
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) {
      if (changed[k]) return true;
    }
    return false;
  });

  const header = [
    before === null ? "--- /dev/null" : `--- a/${path}`,
    `+++ b/${path}`,
  ];
  const hunks: string[] = [];
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  while (index < ops.length) {
    if (!keep[index]) {
      if (ops[index]!.kind !== "+") oldLine++;
      if (ops[index]!.kind !== "-") newLine++;
      index++;
      continue;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    const body: string[] = [];
    while (index < ops.length && keep[index]) {
      const op = ops[index]!;
      body.push(`${op.kind}${op.line}`);
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
      index++;
    }
    const oldCount = oldLine - oldStart;
    const newCount = newLine - newStart;
    hunks.push(
      `@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`,
      ...body,
    );
  }
  return [...header, ...hunks].join("\n") + "\n";
}

/** diff 에서 더한 줄 · 뺀 줄 수 */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}
