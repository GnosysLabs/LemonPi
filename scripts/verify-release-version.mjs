import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function cargoVersion() {
  const manifest = readFileSync(resolve("src-tauri/Cargo.toml"), "utf8");
  const match = manifest.match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) throw new Error("Could not read the LemonPi version from src-tauri/Cargo.toml.");
  return match[1];
}

const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : undefined;
if (tagIndex >= 0 && !tag) throw new Error("--tag requires a value.");

const packageVersion = readJson("package.json").version;
const tauriVersion = readJson("src-tauri/tauri.conf.json").version;
const rustVersion = cargoVersion();

if (![packageVersion, tauriVersion, rustVersion].every((version) => typeof version === "string" && version.length > 0)) {
  throw new Error("Every release version must be a non-empty string.");
}
if (new Set([packageVersion, tauriVersion, rustVersion]).size !== 1) {
  throw new Error(`Release version mismatch: package.json=${packageVersion}, tauri.conf.json=${tauriVersion}, Cargo.toml=${rustVersion}.`);
}
if (tag && tag !== `v${packageVersion}`) {
  throw new Error(`Release tag ${tag} must exactly match v${packageVersion}.`);
}

console.log(packageVersion);
