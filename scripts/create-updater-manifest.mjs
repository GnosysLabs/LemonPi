import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"];

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

export function buildUpdaterManifest({ version, tag, repository, assets, signatures, publishedAt = new Date().toISOString() }) {
  if (!version || !tag || !repository) throw new Error("version, tag, and repository are required.");
  const expectedUrlPrefix = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`;
  const platforms = {};

  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") continue;
    const platform = platformForAssetName(asset.name);
    if (!platform) continue;
    if (!asset.browser_download_url.startsWith(expectedUrlPrefix)) {
      throw new Error(`Updater asset ${asset.name} is not hosted by the expected GitHub release.`);
    }
    if (platforms[platform]) throw new Error(`Found multiple updater assets for ${platform}.`);
    const signature = signatures[`${asset.name}.sig`]?.trim();
    if (!signature) throw new Error(`Missing signature for updater asset ${asset.name}.`);
    platforms[platform] = { url: asset.browser_download_url, signature };
  }

  const missing = REQUIRED_PLATFORMS.filter((platform) => !platforms[platform]);
  if (missing.length > 0) throw new Error(`Release is missing updater artifacts for: ${missing.join(", ")}.`);

  return {
    version,
    notes: `LemonPi v${version}`,
    pub_date: publishedAt,
    platforms,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required.`);
  return process.argv[index + 1];
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
  const manifest = buildUpdaterManifest({ version, tag, repository, assets, signatures });
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
