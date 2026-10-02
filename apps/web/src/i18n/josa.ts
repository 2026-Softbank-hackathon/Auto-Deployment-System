/**
 * 한국어 조사 고르기 (#322). 이름을 문장에 넣을 때 "을(를)"처럼 둘 다 적지 않고, 앞말의 마지막 글자에 맞는 쪽을 붙인다.
 *   한글   — 받침이 있으면 앞쪽(을 · 은 · 이), 없으면 뒤쪽(를 · 는 · 가)
 *   숫자   — 읽는 소리로 판단 (0 영 · 1 일 · 3 삼 · 6 육 · 7 칠 · 8 팔 은 받침 있음)
 *   그 밖  — 영문 이름 · 파일 이름 등은 읽는 법을 알 수 없어 받침 없는 쪽으로 둔다
 * 뒤에 붙은 괄호 · 따옴표 · 공백은 건너뛰고 판단한다.
 */
export type JosaPair = '을/를' | '은/는' | '이/가';

const DIGITS_WITH_FINAL = new Set(['0', '1', '3', '6', '7', '8']);

function hasFinalConsonant(word: string): boolean {
  const last = word.replace(/[\s)\]}"'’”.]+$/u, '').slice(-1);
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  return DIGITS_WITH_FINAL.has(last);
}

/** 앞말에 조사를 붙여 돌려준다. 예: withJosa('배포 #87', '을/를') → '배포 #87을' */
export function withJosa(word: string, pair: JosaPair): string {
  const [withFinal, withoutFinal] = pair.split('/');
  return `${word}${hasFinalConsonant(word) ? withFinal : withoutFinal}`;
}
