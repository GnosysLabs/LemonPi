import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_REQUIRED_PLATFORMS = Object.freeze([
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "windows-x86_64",
]);
export const MANUAL_REQUIRED_PLATFORMS = Object.freeze(["darwin-aarch64", "windows-x86_64"]);

const KNOWN_PLATFORMS = new Set(DEFAULT_REQUIRED_PLATFORMS);

function requiredPlatforms(value = DEFAULT_REQUIRED_PLATFORMS) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("requiredPlatforms must be a non-empty array.");
  const platforms = value.map((platform) => typeof platform === "string" ? platform.trim() : "");
  if (platforms.some((platform) => !KNOWN_PLATFORMS.has(platform))) {
    throw new Error(`Unknown required platform: ${platforms.find((platform) => !KNOWN_PLATFORMS.has(platform)) ?? "invalid value"}.`);
  }
  if (new Set(platforms).size !== platforms.length) throw new Error("requiredPlatforms must not contain duplicates.");
  return platforms;
}

function architectureFromAssetName(name) {
  if (/(?:^|[_-])(?:aarch64|arm64)(?:[_.-]|$)/i.test(name)) return "aarch64";
  if (/(?:^|[_-])(?:x86_64|x64|amd64)(?:[_.-]|$)/i.test(name)) return "x86_64";
  throw new Error(`Could not identify the architecture of updater asset ${name}.`);
}

function platformForAssetName(name) {
  const operatingSystem = name.endsWith(".app.tar.gz")
    ? "darwin"
    : name.endsWith(".AppImage")
      ? "linux"
      : name.endsWith(".exe")
        ? "windows"
        : undefined;
  return operatingSystem ? `${operatingSystem}-${architectureFromAssetName(name)}` : undefined;
}

export function buildUpdaterManifest({
  version,
  tag,
  repository,
  assets,
  signatures,
  requiredPlatforms: requestedPlatforms,
  publishedAt = new Date().toISOString(),
}) {
  if (!version || !tag || !repository) throw new Error("version, tag, and repository are required.");
  if (!Array.isArray(assets)) throw new Error("assets must be an array.");
  if (!signatures || typeof signatures !== "object" || Array.isArray(signatures)) throw new Error("signatures must be an object.");
  const platforms = requiredPlatforms(requestedPlatforms);
  const required = new Set(platforms);
  const expectedUrlPrefix = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`;
  const entries = {};

  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") continue;
    const platform = platformForAssetName(asset.name);
    if (!platform) continue;
    if (!required.has(platform)) throw new Error(`Unexpected updater artifact for platform ${platform}: ${asset.name}.`);
    if (!asset.browser_download_url.startsWith(expectedUrlPrefix)) {
      throw new Error(`Updater asset ${asset.name} is not hosted by the expected GitHub release.`);
    }
    if (entries[platform]) throw new Error(`Found multiple updater assets for ${platform}.`);
    const signature = signatures[`${asset.name}.sig`];
    if (typeof signature !== "string" || !signature.trim()) throw new Error(`Missing signature for updater asset ${asset.name}.`);
    entries[platform] = { url: asset.browser_download_url, signature: signature.trim() };
  }

  const missing = platforms.filter((platform) => !entries[platform]);
  if (missing.length > 0) throw new Error(`Release is missing updater artifacts for: ${missing.join(", ")}.`);

  return {
    version,
    notes: `LemonPi v${version}`,
    pub_date: publishedAt,
    platforms: entries,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required.`);
  return process.argv[index + 1];
}

function selectedPlatforms() {
  const modeIndex = process.argv.indexOf("--platform-set");
  if (modeIndex < 0) return DEFAULT_REQUIRED_PLATFORMS;
  const mode = process.argv[modeIndex + 1];
  if (mode === "all") return DEFAULT_REQUIRED_PLATFORMS;
  if (mode === "manual") return MANUAL_REQUIRED_PLATFORMS;
  throw new Error("--platform-set must be all or manual.");
}

async function main() {
  const version = argument("--version");
  const tag = argument("--tag");
  const repository = argument("--repository");
  const assetsPath = argument("--release-assets");
  const signatureDirectory = argument("--signature-directory");
  const outputPath = argument("--output");
  const assets = JSON.parse(readFileSync(resolve(assetsPath), "utf8"));
  if (!Array.isArray(assets)) throw new Error("The GitHub release assets payload must be an array.");

  const signatures = Object.fromEntries(
    assets
      .filter((asset) => typeof asset?.name === "string" && asset.name.endsWith(".sig"))
      .map((asset) => {
        const path = resolve(signatureDirectory, asset.name);
        if (!existsSync(path)) throw new Error(`Signature asset ${asset.name} was not downloaded.`);
        return [asset.name, readFileSync(path, "utf8")];
      }),
  );
  const manifest = buildUpdaterManifest({
    version,
    tag,
    repository,
    assets,
    signatures,
    requiredPlatforms: selectedPlatforms(),
  });
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
