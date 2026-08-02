import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildUpdaterManifest,
  DEFAULT_REQUIRED_PLATFORMS,
  MANUAL_REQUIRED_PLATFORMS,
} from "./create-updater-manifest.mjs";

const repository = "GnosysLabs/LemonPi";
const tag = "v0.1.1";
const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
const assetNames = [
  "LemonPi_0.1.1_aarch64.app.tar.gz",
  "LemonPi_0.1.1_x64.app.tar.gz",
  "lemonpi_0.1.1_amd64.AppImage",
  "LemonPi_0.1.1_x64-setup.exe",
];

function fixture(names = assetNames) {
  const assets = names.flatMap((name, index) => [
    { name, browser_download_url: `${prefix}${name}` },
    { name: `${name}.sig`, browser_download_url: `${prefix}${name}.sig` },
  ]);
  const signatures = Object.fromEntries(names.map((name, index) => [`${name}.sig`, `signature-${index}`]));
  return { assets, signatures };
}

function manifest(input = {}) {
  return buildUpdaterManifest({
    version: "0.1.1",
    tag,
    repository,
    publishedAt: "2026-08-02T12:00:00.000Z",
    ...fixture(),
    ...input,
  });
}

describe("updater manifest", () => {
  it("maps every signed fallback platform by default", () => {
    const result = manifest();
    assert.deepEqual(DEFAULT_REQUIRED_PLATFORMS, ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]);
    assert.deepEqual(Object.keys(result.platforms).sort(), [...DEFAULT_REQUIRED_PLATFORMS].sort());
    assert.deepEqual(result.platforms["windows-x86_64"], {
      url: `${prefix}LemonPi_0.1.1_x64-setup.exe`,
      signature: "signature-3",
    });
  });

  it("builds an exact signed macOS ARM and Windows x64 manual manifest", () => {
    const names = [assetNames[0], assetNames[3]];
    const result = manifest({ ...fixture(names), requiredPlatforms: MANUAL_REQUIRED_PLATFORMS });
    assert.deepEqual(Object.keys(result.platforms).sort(), ["darwin-aarch64", "windows-x86_64"]);
  });

  it("refuses missing required artifacts and signatures", () => {
    const names = [assetNames[0], assetNames[3]];
    const { assets, signatures } = fixture(names);
    assert.throws(
      () => manifest({ assets: assets.filter((asset) => !asset.name.includes("setup.exe")), signatures, requiredPlatforms: MANUAL_REQUIRED_PLATFORMS }),
      /windows-x86_64/,
    );
    delete signatures[`${assetNames[3]}.sig`];
    assert.throws(
      () => manifest({ assets, signatures, requiredPlatforms: MANUAL_REQUIRED_PLATFORMS }),
      /Missing signature/,
    );
  });

  it("refuses duplicate platforms, foreign URLs, unexpected manual assets, and invalid platform sets", () => {
    const { assets, signatures } = fixture([assetNames[0], assetNames[3]]);
    assert.throws(
      () => manifest({ assets: [...assets, { name: "LemonPi_0.1.1_arm64.app.tar.gz", browser_download_url: `${prefix}LemonPi_0.1.1_arm64.app.tar.gz` }], signatures, requiredPlatforms: MANUAL_REQUIRED_PLATFORMS }),
      /multiple updater assets/,
    );
    assert.throws(
      () => manifest({ assets: [{ ...assets[0], browser_download_url: "https://example.test/LemonPi_0.1.1_aarch64.app.tar.gz" }, ...assets.slice(1)], signatures, requiredPlatforms: MANUAL_REQUIRED_PLATFORMS }),
      /expected GitHub release/,
    );
    assert.throws(
      () => manifest({ ...fixture(), requiredPlatforms: MANUAL_REQUIRED_PLATFORMS }),
      /Unexpected updater artifact/,
    );
    assert.throws(
      () => manifest({ requiredPlatforms: ["windows-x86_64", "windows-x86_64"] }),
      /must not contain duplicates/,
    );
  });

  it("accepts only the explicit all or manual CLI platform modes", () => {
    const directory = mkdtempSync(join(tmpdir(), "lemonpi-manifest-test-"));
    try {
      const { assets, signatures } = fixture([assetNames[0], assetNames[3]]);
      const assetsPath = join(directory, "assets.json");
      const signaturesDirectory = join(directory, "signatures");
      const outputPath = join(directory, "latest.json");
      writeFileSync(assetsPath, JSON.stringify(assets));
      mkdirSync(signaturesDirectory);
      for (const [name, signature] of Object.entries(signatures)) writeFileSync(join(signaturesDirectory, name), signature);
      const argumentsFor = (output, platformSet) => [
        "scripts/create-updater-manifest.mjs",
        "--version", "0.1.1",
        "--tag", tag,
        "--repository", repository,
        "--release-assets", assetsPath,
        "--signature-directory", signaturesDirectory,
        "--output", output,
        "--platform-set", platformSet,
      ];
      execFileSync(process.execPath, argumentsFor(outputPath, "manual"));
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(outputPath, "utf8")).platforms).sort(), ["darwin-aarch64", "windows-x86_64"]);

      const all = fixture();
      const allAssetsPath = join(directory, "all-assets.json");
      writeFileSync(allAssetsPath, JSON.stringify(all.assets));
      for (const [name, signature] of Object.entries(all.signatures)) writeFileSync(join(signaturesDirectory, name), signature);
      const allOutputPath = join(directory, "all.json");
      execFileSync(process.execPath, [
        "scripts/create-updater-manifest.mjs",
        "--version", "0.1.1",
        "--tag", tag,
        "--repository", repository,
        "--release-assets", allAssetsPath,
        "--signature-directory", signaturesDirectory,
        "--output", allOutputPath,
        "--platform-set", "all",
      ]);
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(allOutputPath, "utf8")).platforms).sort(), [...DEFAULT_REQUIRED_PLATFORMS].sort());
      assert.throws(
        () => execFileSync(process.execPath, argumentsFor(join(directory, "invalid.json"), "partial"), { stdio: "pipe" }),
        /platform-set/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
