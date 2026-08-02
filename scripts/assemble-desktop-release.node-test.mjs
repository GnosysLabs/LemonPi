import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assembleDesktopRelease,
  RELEASE_REPOSITORY,
  RELEASE_TAG,
  RELEASE_VERSION,
  verifyChecksumFile,
} from "./assemble-desktop-release.mjs";

const names = {
  macZip: `LemonPi_${RELEASE_VERSION}_macOS-Apple-Silicon.zip`,
  macUpdater: `LemonPi_${RELEASE_VERSION}_macOS-Apple-Silicon_aarch64.app.tar.gz`,
  windowsInstaller: `LemonPi_${RELEASE_VERSION}_x64-setup.exe`,
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lemonpi-assemble-test-"));
  const macos = join(root, "macos");
  const windows = join(root, "windows");
  mkdirSync(macos);
  mkdirSync(windows);
  for (const name of [names.macZip, names.macUpdater, `${names.macUpdater}.sig`]) writeFileSync(join(macos, name), `mac-${name}`);
  for (const name of [names.windowsInstaller, `${names.windowsInstaller}.sig`]) writeFileSync(join(windows, name), `windows-${name}`);
  return { root, macos, windows, output: join(root, "staging") };
}

function assemble(paths, overrides = {}) {
  return assembleDesktopRelease({
    macosDirectory: paths.macos,
    windowsDirectory: paths.windows,
    outputDirectory: paths.output,
    publishedAt: "2026-08-02T12:00:00.000Z",
    ...overrides,
  });
}

describe("two-platform desktop release assembly", () => {
  it("stages only the signed macOS ARM and Windows x64 contract with verified checksums", () => {
    const paths = fixture();
    try {
      const result = assemble(paths);
      assert.deepEqual(result.files, [
        names.macUpdater,
        `${names.macUpdater}.sig`,
        names.macZip,
        names.windowsInstaller,
        `${names.windowsInstaller}.sig`,
        "SHA256SUMS.txt",
        "latest.json",
      ].sort());
      assert.deepEqual(Object.keys(result.manifest.platforms).sort(), ["darwin-aarch64", "windows-x86_64"]);
      assert.equal(result.manifest.version, RELEASE_VERSION);
      assert.deepEqual(result.manifest.platforms["darwin-aarch64"], {
        url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${RELEASE_TAG}/${names.macUpdater}`,
        signature: `mac-${names.macUpdater}.sig`,
      });
      assert.deepEqual(result.manifest.platforms["windows-x86_64"], {
        url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${RELEASE_TAG}/${names.windowsInstaller}`,
        signature: `windows-${names.windowsInstaller}.sig`,
      });
      assert.match(readFileSync(join(paths.output, "SHA256SUMS.txt"), "utf8"), new RegExp(escapeRegExp(names.windowsInstaller)));
      verifyChecksumFile(paths.output);
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("rejects missing and duplicate accepted artifacts", () => {
    const missing = fixture();
    const duplicate = fixture();
    try {
      rmSync(join(missing.windows, `${names.windowsInstaller}.sig`));
      assert.throws(() => assemble(missing), new RegExp(`exactly ${escapeRegExp(`${names.windowsInstaller}.sig`)}`));
      writeFileSync(join(duplicate.macos, "LemonPi_0.1.1_macOS-Apple-Silicon_aarch64.app.tar.gz"), "wrong version");
      assert.throws(() => assemble(duplicate), new RegExp(`exactly ${escapeRegExp(names.macUpdater)}`));
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
      rmSync(duplicate.root, { recursive: true, force: true });
    }
  });

  it("rejects incorrect version, tag, repository, source path, and tampered staging", () => {
    const paths = fixture();
    try {
      assert.throws(() => assemble(paths, { version: "0.1.1" }), /only accepts/);
      assert.throws(() => assemble(paths, { tag: "v0.1.0" }), /only accepts/);
      assert.throws(() => assemble(paths, { repository: "example/LemonPi" }), /only accepts/);
      assert.throws(() => assemble(paths, { macosDirectory: join(paths.root, "missing") }), /macOS artifact directory/);

      assemble(paths);
      writeFileSync(join(paths.output, names.macZip), "tampered");
      assert.throws(() => verifyChecksumFile(paths.output), /Checksum mismatch/);
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("pins the v0.1.2 identity and exact platform asset names", () => {
    assert.equal(RELEASE_VERSION, "0.1.2");
    assert.equal(RELEASE_TAG, "v0.1.2");
    assert.equal(RELEASE_REPOSITORY, "GnosysLabs/LemonPi");
    assert.equal(names.macZip, "LemonPi_0.1.2_macOS-Apple-Silicon.zip");
    assert.equal(names.macUpdater, "LemonPi_0.1.2_macOS-Apple-Silicon_aarch64.app.tar.gz");
    assert.match(names.macUpdater, /_aarch64\.app\.tar\.gz$/);
    assert.equal(names.windowsInstaller, "LemonPi_0.1.2_x64-setup.exe");
  });

  it("rejects legacy macOS names rather than accepting them as candidate artifacts", () => {
    const paths = fixture();
    try {
      rmSync(join(paths.macos, names.macZip));
      writeFileSync(join(paths.macos, "LemonPi_0.1.2_aarch64.app.zip"), "legacy mac zip");
      assert.throws(() => assemble(paths), new RegExp(`exactly ${escapeRegExp(names.macZip)}`));
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });
});
