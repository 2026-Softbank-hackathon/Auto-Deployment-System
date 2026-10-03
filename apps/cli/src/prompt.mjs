import { createInterface } from "node:readline";

/** 한 줄 입력. hidden 이면 입력한 글자를 화면에 찍지 않는다 (비밀번호) */
export function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // readline 이 입력을 다시 찍는 자리를 막는다 — 질문만 보이고 글자는 보이지 않는다
      rl._writeToOutput = (text) => { if (text.includes(question)) rl.output.write(text); };
    }
    rl.question(question, (answer) => {
      if (hidden) process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

export async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const answer = (await ask(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
