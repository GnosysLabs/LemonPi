import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildUpdaterManifest } from "./create-updater-manifest.mjs";

const repository = "GnosysLabs/LemonPi";
const tag = "v0.1.0";
const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
const assetNames = [
  "LemonPi_0.1.0_aarch64.app.tar.gz",
  "LemonPi_0.1.0_x64.app.tar.gz",
  "lemonpi_0.1.0_amd64.AppImage",
  "LemonPi_0.1.0_x64-setup.exe",
];

function fixture() {
  const assets = assetNames.flatMap((name, index) => [
    { name, browser_download_url: `${prefix}${name}` },
    { name: `${name}.sig`, browser_download_url: `${prefix}${name}.sig` },
  ]);
  const signatures = Object.fromEntries(assetNames.map((name, index) => [`${name}.sig`, `signature-${index}`]));
  return { assets, signatures };
}

describe("updater manifest", () => {
  it("maps signed GitHub Release artifacts to every supported Tauri platform", () => {
    const { assets, signatures } = fixture();
    const manifest = buildUpdaterManifest({
      version: "0.1.0",
      tag,
      repository,
      assets,
      signatures,
      publishedAt: "2026-08-02T12:00:00.000Z",
    });

    assert.equal(manifest.version, "0.1.0");
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-x86_64",
      "windows-x86_64",
    ]);
    assert.deepEqual(manifest.platforms["windows-x86_64"], {
      url: `${prefix}LemonPi_0.1.0_x64-setup.exe`,
      signature: "signature-3",
    });
  });

  it("refuses a release missing a signed target artifact", () => {
    const { assets, signatures } = fixture();
    assert.throws(
      () => buildUpdaterManifest({
        version: "0.1.0",
        tag,
        repository,
        assets: assets.filter((asset) => !asset.name.includes("AppImage")),
        signatures,
      }),
      /linux-x86_64/,
    );
  });
});
