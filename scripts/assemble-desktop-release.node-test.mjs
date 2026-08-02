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
  macZip: `LemonPi_${RELEASE_VERSION}_aarch64.app.zip`,
  macUpdater: `LemonPi_${RELEASE_VERSION}_aarch64.app.tar.gz`,
  windowsInstaller: `LemonPi_${RELEASE_VERSION}_x64-setup.exe`,
};

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
        "LemonPi_0.1.1_x64-setup.exe",
        "LemonPi_0.1.1_x64-setup.exe.sig",
        "SHA256SUMS.txt",
        "latest.json",
      ].sort());
      assert.deepEqual(Object.keys(result.manifest.platforms).sort(), ["darwin-aarch64", "windows-x86_64"]);
      assert.equal(result.manifest.version, RELEASE_VERSION);
      assert.match(readFileSync(join(paths.output, "SHA256SUMS.txt"), "utf8"), new RegExp(names.windowsInstaller));
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
      assert.throws(() => assemble(missing), /exactly LemonPi_0.1.1_x64-setup.exe.sig/);
      writeFileSync(join(duplicate.macos, "LemonPi_0.1.0_aarch64.app.tar.gz"), "wrong version");
      assert.throws(() => assemble(duplicate), /exactly LemonPi_0.1.1_aarch64.app.tar.gz/);
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
      rmSync(duplicate.root, { recursive: true, force: true });
    }
  });

  it("rejects incorrect version, tag, repository, source path, and tampered staging", () => {
    const paths = fixture();
    try {
      assert.throws(() => assemble(paths, { version: "0.1.2" }), /only accepts/);
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

  it("keeps release identity constants fixed for the first public baseline", () => {
    assert.equal(RELEASE_VERSION, "0.1.1");
    assert.equal(RELEASE_TAG, "v0.1.1");
    assert.equal(RELEASE_REPOSITORY, "GnosysLabs/LemonPi");
  });
});
