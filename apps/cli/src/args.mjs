/** --k v / --k=v / --k(값 없으면 true). 같은 플래그를 반복하면 마지막 값. 값이 "-" 로 시작해도 --flag 다음이면 값으로 본다. */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const eq = arg.indexOf("=");
    if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[arg.slice(2)] = argv[++i];
    else flags[arg.slice(2)] = true;
  }
  return { positionals, flags };
}

/** 값 없이 쓰는 전역 플래그 — 뒤에 오는 위치 인자를 값으로 삼키지 않게 먼저 뺀다 */
export const BOOLEAN_FLAGS = ["json", "yes", "help", "version"];

export function splitBooleanFlags(argv) {
  const rest = [];
  const flags = {};
  for (const arg of argv) {
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (name && BOOLEAN_FLAGS.includes(name)) flags[name] = true;
    else if (arg === "-y") flags.yes = true;
    else if (arg === "-h") flags.help = true;
    else rest.push(arg);
  }
  return { rest, flags };
}
