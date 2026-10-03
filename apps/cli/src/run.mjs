import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { parseArgs, splitBooleanFlags } from "./args.mjs";
import { baseUrl, clearConfig, DEFAULT_BASE_URL, loadCachedManifest, loadConfig, saveCachedManifest, saveConfig, token } from "./config.mjs";
import { followDeployment } from "./follow.mjs";
import { api, CliError } from "./http.mjs";
import { displayWidth, printResult } from "./output.mjs";
import { ask, confirm } from "./prompt.mjs";
import { pick, renderBody, renderPath, renderQuery } from "./template.mjs";
import { zipDirectory } from "./zip.mjs";

export const VERSION = "0.1.0";

/** 서버에서 명령 목록을 받는다. 서버에 닿지 못하면 마지막으로 받은 목록을 쓴다 */
async function loadManifest() {
  try {
    const manifest = await api("/cli/manifest");
    saveCachedManifest(manifest);
    return manifest;
  } catch (error) {
    const cached = loadCachedManifest();
    if (cached && !(error instanceof CliError && error.exitCode === 2)) {
      console.error(`(Could not fetch the command list; using the cached one: ${error.message})`);
      return cached;
    }
    throw error;
  }
}

function usageOf(command) {
  const parts = [command.name];
  for (const arg of command.args.filter((item) => item.positional !== undefined).sort((a, b) => a.positional - b.positional)) {
    parts.push(arg.required ? `<${arg.name}>` : `[${arg.name}]`);
  }
  for (const arg of command.args.filter((item) => item.flag)) {
    const value = arg.enum ? arg.enum.join("|") : arg.name;
    parts.push(arg.required ? `--${arg.flag} <${value}>` : `[--${arg.flag} <${value}>]`);
  }
  return parts.join(" ");
}

function printHelp(manifest) {
  console.log(`camellia ${VERSION} — CLI for the camellia deploy platform (${baseUrl()})\n`);
  console.log("Usage: camellia <command> [args] [--flags]\n");
  const builtins = [
    ["login [--url <url>] [--token <token>]", "Log in with your console account (stores a token only)"],
    ["logout", "Remove the stored token"],
    ["whoami", "Show the server and login status"],
  ];
  const rows = [
    ...builtins,
    ...(manifest?.commands ?? []).map((command) => [usageOf(command), command.description]),
  ];
  const width = Math.min(60, Math.max(...rows.map(([usage]) => displayWidth(usage))));
  for (const [usage, description] of rows) {
    const gap = Math.max(2, width - displayWidth(usage) + 2);
    console.log(`  ${usage}${" ".repeat(gap)}${description}`);
  }
  console.log("\nGlobal flags: --json (raw response), --yes (skip confirmation), --help");
  if (!manifest) console.log("\nLog in to see the commands provided by the server (apps, deploy, logs, ...).");
}

/** 입력한 단어로 가장 긴 이름이 맞는 명령을 고른다 ("env set" 이 "env" 보다 먼저) */
function matchCommand(manifest, words) {
  let best = null;
  for (const command of manifest.commands) {
    const parts = command.name.split(" ");
    if (parts.every((part, index) => words[index] === part) && (!best || parts.length > best.name.split(" ").length)) best = command;
  }
  return best;
}

const resolverCache = new Map();

async function resolveValue(manifest, resolverName, input) {
  const resolver = manifest.resolvers[resolverName];
  if (!resolver) throw new CliError(`Unknown resolver: ${resolverName}`);
  if (!resolverCache.has(resolverName)) resolverCache.set(resolverName, pick(await api(resolver.list), resolver.items) ?? []);
  const items = resolverCache.get(resolverName);
  if (input === undefined) {
    if (!resolver.defaultWhere) return undefined;
    return items.find((item) => Object.entries(resolver.defaultWhere).every(([key, value]) => item[key] === value));
  }
  const text = String(input);
  const found = items.find((item) => resolver.match.some((field) => String(item[field] ?? "") === text))
    ?? items.find((item) => resolver.match.some((field) => String(item[field] ?? "").toLowerCase() === text.toLowerCase()));
  if (!found) throw new CliError(`${resolver.label} '${text}' not found. ${resolver.hint}`);
  return found;
}

function readSource(path) {
  const full = resolvePath(path);
  if (!existsSync(full)) throw new CliError(`${path} does not exist`);
  if (statSync(full).isDirectory()) {
    const { buffer, fileCount } = zipDirectory(full);
    console.error(`  Packed ${basename(full)} (${fileCount} files, ${(buffer.length / 1024).toFixed(0)} KB)`);
    return { buffer, filename: `${basename(full) || "source"}.zip` };
  }
  if (!full.toLowerCase().endsWith(".zip")) throw new CliError("Source must be a folder or a .zip file");
  return { buffer: readFileSync(full), filename: basename(full) };
}

/** 인자를 검사하고 템플릿 문맥을 만든다 */
async function buildContext(manifest, command, positionals, flags) {
  const context = {};
  for (const arg of command.args) {
    let value = arg.positional !== undefined ? positionals[arg.positional] : flags[arg.flag];
    if (value === true && arg.type !== "boolean") throw new CliError(`--${arg.flag} needs a value`);
    if (value === undefined && arg.required) {
      throw new CliError(`${arg.positional !== undefined ? `<${arg.name}>` : `--${arg.flag}`} is required\n  Usage: camellia ${usageOf(command)}`);
    }
    if (value !== undefined && arg.enum && !arg.enum.includes(String(value))) {
      throw new CliError(`${arg.flag ? `--${arg.flag}` : arg.name} must be one of ${arg.enum.join(" | ")}`);
    }
    if (value !== undefined && arg.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new CliError(`${arg.name} must be a number`);
      value = number;
    }
    if (value !== undefined && arg.type === "boolean") value = value === true || value === "true";
    if (arg.resolver) {
      const resolved = await resolveValue(manifest, arg.resolver, value);
      context[arg.name] = resolved ? { resolved, valueField: manifest.resolvers[arg.resolver].value } : undefined;
      continue;
    }
    if (value !== undefined && arg.type === "source") value = readSource(String(value));
    context[arg.name] = value;
  }
  return context;
}

function multipartForm(body) {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value && typeof value === "object" && "buffer" in value) form.append(key, new Blob([value.buffer], { type: "application/zip" }), value.filename);
    else form.append(key, String(value));
  }
  return form;
}

async function runCommand(manifest, command, positionals, flags) {
  const context = await buildContext(manifest, command, positionals, flags);
  if (command.confirm && !flags.yes) {
    const ok = await confirm(`${command.confirm} Continue?`);
    if (!ok) throw new CliError("Cancelled. Add --yes to skip the confirmation.");
  }

  let path;
  try {
    path = renderPath(command.request.path, context) + renderQuery(command.request.query, context);
  } catch (error) {
    throw new CliError(`Cannot build the request: ${error.message}`);
  }
  const body = command.request.body ? renderBody(command.request.body, context) : undefined;
  const options = { method: command.request.method };
  if (command.request.multipart) options.form = multipartForm(body ?? {});
  else if (body !== undefined) options.body = body;

  let result;
  if (command.output.kind === "text" && !flags.json) {
    const response = await api(path, { ...options, raw: true });
    result = response.status === 204 ? "" : await response.text();
  } else {
    result = await api(path, options);
  }

  if (flags.json && !command.follow) console.log(JSON.stringify(result, null, 2));
  else if (!flags.json) printResult(command.output, result);

  if (command.follow?.deployment) {
    const id = pick(result, command.follow.deployment);
    if (id === undefined || id === null) throw new CliError("The response has no deployment ID");
    return followDeployment(manifest.followers.deployment, String(id), { yes: Boolean(flags.yes), json: Boolean(flags.json) });
  }
  return 0;
}

async function login(flags) {
  const url = typeof flags.url === "string" ? flags.url.replace(/\/+$/, "") : (loadConfig().baseUrl || DEFAULT_BASE_URL);
  if (typeof flags.token === "string") {
    saveConfig({ baseUrl: url, token: flags.token });
    console.log(`Token saved (${url})`);
    return 0;
  }
  console.log(`Log in to ${url} with your console account. The password is not stored; only a 30-day token is.`);
  const user = typeof flags.user === "string" ? flags.user : (await ask("Username: ")).trim();
  const password = process.env.CAMELLIA_PASSWORD ?? (await ask("Password: ", { hidden: true }));
  let response;
  try {
    response = await fetch(`${url}/api/v1/cli/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`, accept: "application/json" },
    });
  } catch (error) {
    throw new CliError(`Cannot reach the server (${url}): ${error?.cause?.message ?? error?.message ?? error}`);
  }
  if (response.status === 401) throw new CliError("Wrong username or password.", 2);
  if (!response.ok) throw new CliError(`Login failed (HTTP ${response.status})`);
  const session = await response.json();
  saveConfig({ baseUrl: url, token: session.token, expiresAt: session.expiresAt });
  console.log(`Logged in. Token expires at ${session.expiresAt}`);
  return 0;
}

export async function main(argv) {
  const { rest, flags: globalFlags } = splitBooleanFlags(argv);
  const { positionals, flags: parsed } = parseArgs(rest);
  const flags = { ...parsed, ...globalFlags };

  if (flags.version) { console.log(VERSION); return 0; }
  const [first] = positionals;
  if (first === "login") return login(flags);
  if (first === "logout") { clearConfig(); console.log("Token removed."); return 0; }
  if (first === "whoami") {
    const config = loadConfig();
    console.log(`Server: ${baseUrl()}`);
    console.log(token() ? `Logged in${config.expiresAt ? ` (token expires ${config.expiresAt})` : ""}` : "Not logged in. Run camellia login.");
    return 0;
  }

  if (!token()) {
    printHelp(null);
    return first && first !== "help" ? 2 : 0;
  }
  const manifest = await loadManifest();
  if (!first || first === "help" || flags.help && !matchCommand(manifest, positionals)) { printHelp(manifest); return 0; }

  const command = matchCommand(manifest, positionals);
  if (!command) throw new CliError(`Unknown command: ${positionals.join(" ")}\n  Run camellia help to list commands.`);
  if (flags.help) {
    console.log(`camellia ${usageOf(command)}\n\n${command.description}\n`);
    for (const arg of command.args) console.log(`  ${arg.flag ? `--${arg.flag}` : `<${arg.name}>`}  ${arg.description}${arg.required ? " (required)" : ""}`);
    return 0;
  }
  return runCommand(manifest, command, positionals.slice(command.name.split(" ").length), flags);
}
