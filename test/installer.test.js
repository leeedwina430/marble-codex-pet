import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { installPet, resolveCodexHome } from "../src/installer.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "marble-installer-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "source", "marble");
  const codexHome = path.join(root, "codex-home");
  await fs.mkdir(sourcePath, { recursive: true });

  const manifest = {
    id: "marble",
    displayName: "Marble",
    description: "Fixture pet",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  };
  const spritesheet = Buffer.from("deterministic marble spritesheet fixture");
  const spritesheetSha256 = createHash("sha256")
    .update(spritesheet)
    .digest("hex");
  const manifestPath = path.join(sourcePath, "pet.json");
  const spritesheetPath = path.join(sourcePath, "spritesheet.webp");

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(spritesheetPath, spritesheet);

  const pet = {
    slug: "marble",
    id: "marble",
    displayName: "Marble",
    version: "1.0.0",
    manifestPath,
    spritesheetPath,
    spritesheetSha256,
  };

  return { root, codexHome, manifest, spritesheet, pet };
}

test("resolveCodexHome honors CODEX_HOME and otherwise uses ~/.codex", () => {
  assert.equal(
    resolveCodexHome({ env: { CODEX_HOME: "/tmp/custom-codex" } }),
    path.resolve("/tmp/custom-codex"),
  );
  assert.equal(
    resolveCodexHome({ env: {}, homedir: () => "/tmp/example-home" }),
    "/tmp/example-home/.codex",
  );
});

test("installs a validated v2 pet into CODEX_HOME/pets/marble", async (t) => {
  const data = await fixture(t);
  const result = await installPet(data.pet, { codexHome: data.codexHome });

  assert.equal(result.status, "installed");
  assert.equal(result.targetPath, path.join(data.codexHome, "pets", "marble"));
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(result.targetPath, "pet.json"), "utf8")),
    data.manifest,
  );
  assert.deepEqual(
    await fs.readFile(path.join(result.targetPath, "spritesheet.webp")),
    data.spritesheet,
  );
});

test("an identical existing install is idempotent", async (t) => {
  const data = await fixture(t);
  await installPet(data.pet, { codexHome: data.codexHome });
  const second = await installPet(data.pet, { codexHome: data.codexHome });

  assert.equal(second.status, "unchanged");
  assert.equal(second.backupPath, undefined);
  const petEntries = await fs.readdir(path.join(data.codexHome, "pets"));
  assert.deepEqual(petEntries, ["marble"]);
});

test("a changed existing install is refused without --force", async (t) => {
  const data = await fixture(t);
  const first = await installPet(data.pet, { codexHome: data.codexHome });
  const installedSpritesheet = path.join(first.targetPath, "spritesheet.webp");
  await fs.writeFile(installedSpritesheet, "locally modified");

  await assert.rejects(
    () => installPet(data.pet, { codexHome: data.codexHome }),
    (error) => error.code === "INSTALL_CONFLICT",
  );
  assert.equal(await fs.readFile(installedSpritesheet, "utf8"), "locally modified");
});

test("--force keeps a timestamped backup before replacing", async (t) => {
  const data = await fixture(t);
  const first = await installPet(data.pet, { codexHome: data.codexHome });
  await fs.writeFile(
    path.join(first.targetPath, "spritesheet.webp"),
    "locally modified",
  );

  const result = await installPet(data.pet, {
    codexHome: data.codexHome,
    force: true,
    now: () => new Date("2026-07-19T12:34:56.789Z"),
  });

  assert.equal(result.status, "installed");
  assert.match(result.backupPath, /marble\.backup-2026-07-19T12-34-56-789Z$/);
  assert.equal(
    await fs.readFile(path.join(result.backupPath, "spritesheet.webp"), "utf8"),
    "locally modified",
  );
  assert.deepEqual(
    await fs.readFile(path.join(result.targetPath, "spritesheet.webp")),
    data.spritesheet,
  );
});

test("a failed force replacement rolls the previous install back", async (t) => {
  const data = await fixture(t);
  const first = await installPet(data.pet, { codexHome: data.codexHome });
  const installedSpritesheet = path.join(first.targetPath, "spritesheet.webp");
  await fs.writeFile(installedSpritesheet, "must survive rollback");

  const failingFs = {
    ...fs,
    async rename(from, to) {
      if (path.basename(from).startsWith(".marble.tmp-") && to === first.targetPath) {
        const error = new Error("simulated atomic rename failure");
        error.code = "EIO";
        throw error;
      }
      return fs.rename(from, to);
    },
  };

  await assert.rejects(
    () => installPet(data.pet, {
      codexHome: data.codexHome,
      force: true,
      fsImpl: failingFs,
    }),
    (error) => error.code === "INSTALL_FAILED",
  );

  assert.equal(await fs.readFile(installedSpritesheet, "utf8"), "must survive rollback");
  assert.deepEqual(await fs.readdir(path.join(data.codexHome, "pets")), ["marble"]);
});

test("invalid source hashes fail before the destination is created", async (t) => {
  const data = await fixture(t);
  data.pet.spritesheetSha256 = "0".repeat(64);

  await assert.rejects(
    () => installPet(data.pet, { codexHome: data.codexHome }),
    (error) => error.code === "SOURCE_HASH_MISMATCH",
  );
  await assert.rejects(() => fs.lstat(data.codexHome), { code: "ENOENT" });
});

test("a malformed expected release hash is rejected", async (t) => {
  const data = await fixture(t);
  data.pet.spritesheetSha256 = "not-a-valid-sha256";

  await assert.rejects(
    () => installPet(data.pet, { codexHome: data.codexHome }),
    (error) => error.code === "INVALID_EXPECTED_HASH",
  );
});

test("a non-v2 source manifest is rejected before installation", async (t) => {
  const data = await fixture(t);
  const invalidManifest = { ...data.manifest, spriteVersionNumber: 1 };
  await fs.writeFile(
    data.pet.manifestPath,
    `${JSON.stringify(invalidManifest, null, 2)}\n`,
  );

  await assert.rejects(
    () => installPet(data.pet, { codexHome: data.codexHome }),
    (error) => error.code === "INVALID_MANIFEST",
  );
  await assert.rejects(() => fs.lstat(data.codexHome), { code: "ENOENT" });
});
