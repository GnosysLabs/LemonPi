import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildUpdaterManifest, MANUAL_REQUIRED_PLATFORMS } from "./create-updater-manifest.mjs";

export const RELEASE_VERSION = "0.1.2";
export const RELEASE_TAG = "v0.1.2";
export const RELEASE_REPOSITORY = "GnosysLabs/LemonPi";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireDirectory(path, label) {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`${label} must be an existing directory.`);
  return resolved;
}

function requireAsset(directory, expectedName, pattern, label) {
  const candidates = readdirSync(directory).filter((name) => pattern.test(name));
  if (candidates.length !== 1 || candidates[0] !== expectedName) {
    throw new Error(`${label} must contain exactly ${expectedName}.`);
  }
  const path = join(directory, expectedName);
  if (!statSync(path).isFile() || statSync(path).size === 0) throw new Error(`${label} is empty: ${expectedName}.`);
  return path;
}

function checksumText(directory, names) {
  return names
    .slice()
    .sort()
    .map((name) => `${sha256(join(directory, name))}  ${name}`)
    .join("\n") + "\n";
}

export function verifyChecksumFile(directory) {
  const lines = readFileSync(join(directory, "SHA256SUMS.txt"), "utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("SHA256SUMS.txt is empty.");
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^/]+)$/.exec(line);
    if (!match) throw new Error(`Invalid checksum entry: ${line}`);
    const [, expected, name] = match;
    const path = join(directory, name);
    if (!existsSync(path) || sha256(path) !== expected) throw new Error(`Checksum mismatch for ${name}.`);
  }
}

export function assembleDesktopRelease({ macosDirectory, windowsDirectory, outputDirectory, publishedAt, version = RELEASE_VERSION, tag = RELEASE_TAG, repository = RELEASE_REPOSITORY }) {
  if (version !== RELEASE_VERSION || tag !== RELEASE_TAG || repository !== RELEASE_REPOSITORY) {
    throw new Error(`This release assembler only accepts ${REPOSITORY_LABEL()}.`);
  }
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) throw new Error("publishedAt must be a valid RFC 3339 timestamp.");
  const macos = requireDirectory(macosDirectory, "macOS artifact directory");
  const windows = requireDirectory(windowsDirectory, "Windows artifact directory");
  const output = resolve(outputDirectory);
  if (output === macos || output === windows) throw new Error("Release staging directory must differ from source artifact directories.");

  const macZipName = `LemonPi_${version}_macOS-Apple-Silicon.zip`;
  const macUpdaterName = `LemonPi_${version}_macOS-Apple-Silicon_aarch64.app.tar.gz`;
  const windowsInstallerName = `LemonPi_${version}_x64-setup.exe`;
  const macZip = requireAsset(macos, macZipName, /^LemonPi_.+_macOS-Apple-Silicon\.zip$/, "macOS artifact directory");
  const macUpdater = requireAsset(macos, macUpdaterName, /^LemonPi_.+_macOS-Apple-Silicon_aarch64\.app\.tar\.gz$/, "macOS artifact directory");
  const macSignature = requireAsset(macos, `${macUpdaterName}.sig`, /^LemonPi_.+_macOS-Apple-Silicon_aarch64\.app\.tar\.gz\.sig$/, "macOS artifact directory");
  const windowsInstaller = requireAsset(windows, windowsInstallerName, /^LemonPi_.+_x64-setup\.exe$/, "Windows artifact directory");
  const windowsSignature = requireAsset(windows, `${windowsInstallerName}.sig`, /^LemonPi_.+_x64-setup\.exe\.sig$/, "Windows artifact directory");

  if (existsSync(output)) {
    if (!statSync(output).isDirectory() || readdirSync(output).length > 0) throw new Error("Release staging directory must be absent or empty.");
    rmdirSync(output);
  }
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), ".lemonpi-release-"));
  try {
    for (const [source, name] of [
      [macZip, macZipName],
      [macUpdater, macUpdaterName],
      [macSignature, `${macUpdaterName}.sig`],
      [windowsInstaller, windowsInstallerName],
      [windowsSignature, `${windowsInstallerName}.sig`],
    ]) cpSync(source, join(staging, name));

    const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
    const manifest = buildUpdaterManifest({
      version,
      tag,
      repository,
      publishedAt,
      requiredPlatforms: MANUAL_REQUIRED_PLATFORMS,
      assets: [
        { name: macUpdaterName, browser_download_url: `${prefix}${macUpdaterName}` },
        { name: windowsInstallerName, browser_download_url: `${prefix}${windowsInstallerName}` },
      ],
      signatures: {
        [`${macUpdaterName}.sig`]: readFileSync(macSignature, "utf8"),
        [`${windowsInstallerName}.sig`]: readFileSync(windowsSignature, "utf8"),
      },
    });
    writeFileSync(join(staging, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const checksummed = [macZipName, macUpdaterName, `${macUpdaterName}.sig`, windowsInstallerName, `${windowsInstallerName}.sig`, "latest.json"];
    writeFileSync(join(staging, "SHA256SUMS.txt"), checksumText(staging, checksummed));
    verifyChecksumFile(staging);
    renameSync(staging, output);
  } catch (error) {
    if (existsSync(staging)) rmdirSync(staging, { recursive: true });
    throw error;
  }

  return {
    output,
    files: readdirSync(output).sort(),
    manifest: JSON.parse(readFileSync(join(output, "latest.json"), "utf8")),
  };
}

function REPOSITORY_LABEL() {
  return `${RELEASE_REPOSITORY} ${RELEASE_TAG}`;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required.`);
  return process.argv[index + 1];
}

function main() {
  const result = assembleDesktopRelease({
    macosDirectory: argument("--macos-directory"),
    windowsDirectory: argument("--windows-directory"),
    outputDirectory: argument("--output-directory"),
    publishedAt: argument("--published-at"),
  });
  console.log(result.output);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
