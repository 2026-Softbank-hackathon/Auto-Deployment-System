import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://console.camellia-deploy.app";

export const configDir = () => process.env.CAMELLIA_CONFIG_DIR || join(homedir(), ".camellia");
const configFile = () => join(configDir(), "config.json");
const manifestFile = () => join(configDir(), "manifest.json");

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeJsonFile(path, value) {
  mkdirSync(configDir(), { recursive: true });
  // 토큰이 들어 있으니 본인만 읽게 둔다 (Windows 에서는 무시됨)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export const loadConfig = () => readJsonFile(configFile()) ?? {};
export const saveConfig = (config) => writeJsonFile(configFile(), config);
export const clearConfig = () => rmSync(configFile(), { force: true });

export const baseUrl = () => (process.env.CAMELLIA_URL || loadConfig().baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
export const token = () => process.env.CAMELLIA_TOKEN || loadConfig().token || null;

export const loadCachedManifest = () => readJsonFile(manifestFile());
export const saveCachedManifest = (manifest) => writeJsonFile(manifestFile(), manifest);
