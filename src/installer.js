import * as defaultFs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const VALID_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VALID_SHA256 = /^[a-f0-9]{64}$/;

function installerError(message, code, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function assertValidPetDefinition(pet) {
  if (!pet || typeof pet !== "object") {
    throw installerError("Pet definition is missing.", "INVALID_PET_DEFINITION");
  }

  if (!VALID_SLUG.test(pet.slug ?? "") || pet.slug !== pet.id) {
    throw installerError(
      "Pet slug and id must be the same lowercase, URL-safe value.",
      "INVALID_PET_DEFINITION",
    );
  }

  if (!VALID_SHA256.test(pet.spritesheetSha256 ?? "")) {
    throw installerError(
      "The bundled spritesheet SHA-256 must be 64 lowercase hexadecimal characters.",
      "INVALID_EXPECTED_HASH",
    );
  }

  if (!pet.manifestPath || !pet.spritesheetPath) {
    throw installerError(
      "Pet definition is missing source asset paths.",
      "INVALID_PET_DEFINITION",
    );
  }
}

export function resolveCodexHome({
  env = process.env,
  homedir = os.homedir,
} = {}) {
  const configured = env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".codex");
}

export async function hashFile(filePath, fsImpl = defaultFs) {
  const bytes = await fsImpl.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(filePath, fsImpl) {
  let text;
  try {
    text = await fsImpl.readFile(filePath, "utf8");
  } catch (error) {
    throw installerError(
      `Could not read ${filePath}: ${error.message}`,
      "MANIFEST_READ_FAILED",
      error,
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw installerError(
      `Invalid JSON in ${filePath}: ${error.message}`,
      "INVALID_MANIFEST_JSON",
      error,
    );
  }
}

function validateManifest(manifest, pet, manifestPath) {
  const problems = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    problems.push("must contain a JSON object");
  } else {
    if (manifest.id !== pet.id) problems.push(`id must be ${pet.id}`);
    if (manifest.displayName !== pet.displayName) {
      problems.push(`displayName must be ${pet.displayName}`);
    }
    if (manifest.spriteVersionNumber !== 2) {
      problems.push("spriteVersionNumber must be 2");
    }
    if (manifest.spritesheetPath !== "spritesheet.webp") {
      problems.push("spritesheetPath must be spritesheet.webp");
    }
  }

  if (problems.length > 0) {
    throw installerError(
      `Invalid pet manifest at ${manifestPath}: ${problems.join("; ")}.`,
      "INVALID_MANIFEST",
    );
  }
}

async function assertRegularFile(filePath, fsImpl) {
  let metadata;
  try {
    metadata = await fsImpl.lstat(filePath);
  } catch (error) {
    throw installerError(
      `Required file is missing or unreadable: ${filePath}`,
      "ASSET_NOT_FOUND",
      error,
    );
  }

  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw installerError(
      `Required path is not a regular file: ${filePath}`,
      "INVALID_ASSET_TYPE",
    );
  }
}

async function validateSourcePackage(pet, fsImpl) {
  assertValidPetDefinition(pet);
  await assertRegularFile(pet.manifestPath, fsImpl);
  await assertRegularFile(pet.spritesheetPath, fsImpl);

  const manifest = await readJson(pet.manifestPath, fsImpl);
  validateManifest(manifest, pet, pet.manifestPath);

  const actualHash = await hashFile(pet.spritesheetPath, fsImpl);
  if (actualHash !== pet.spritesheetSha256) {
    throw installerError(
      `Bundled spritesheet failed integrity verification: expected ${pet.spritesheetSha256}, received ${actualHash}.`,
      "SOURCE_HASH_MISMATCH",
    );
  }

  return manifest;
}

async function pathExists(filePath, fsImpl) {
  try {
    await fsImpl.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function installedPackageMatches(targetPath, sourceManifest, pet, fsImpl) {
  try {
    const targetMetadata = await fsImpl.lstat(targetPath);
    if (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink()) {
      return false;
    }

    const manifestPath = path.join(targetPath, "pet.json");
    const spritesheetPath = path.join(targetPath, "spritesheet.webp");
    await assertRegularFile(manifestPath, fsImpl);
    await assertRegularFile(spritesheetPath, fsImpl);

    const installedManifest = await readJson(manifestPath, fsImpl);
    validateManifest(installedManifest, pet, manifestPath);

    if (!isDeepStrictEqual(installedManifest, sourceManifest)) return false;
    return (await hashFile(spritesheetPath, fsImpl)) === pet.spritesheetSha256;
  } catch {
    return false;
  }
}

async function validateStagedPackage(stagingPath, sourceManifest, pet, fsImpl) {
  const manifestPath = path.join(stagingPath, "pet.json");
  const spritesheetPath = path.join(stagingPath, "spritesheet.webp");
  const stagedManifest = await readJson(manifestPath, fsImpl);
  validateManifest(stagedManifest, pet, manifestPath);

  if (!isDeepStrictEqual(stagedManifest, sourceManifest)) {
    throw installerError(
      "The staged pet manifest differs from the bundled manifest.",
      "STAGING_VALIDATION_FAILED",
    );
  }

  const stagedHash = await hashFile(spritesheetPath, fsImpl);
  if (stagedHash !== pet.spritesheetSha256) {
    throw installerError(
      "The staged spritesheet failed integrity verification.",
      "STAGING_VALIDATION_FAILED",
    );
  }
}

function backupTimestamp(now) {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function chooseBackupPath(targetPath, fsImpl, now) {
  const base = `${targetPath}.backup-${backupTimestamp(now)}`;
  let candidate = base;
  let suffix = 1;

  while (await pathExists(candidate, fsImpl)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

export async function installPet(
  pet,
  {
    force = false,
    codexHome,
    env = process.env,
    homedir = os.homedir,
    fsImpl = defaultFs,
    now = () => new Date(),
  } = {},
) {
  const sourceManifest = await validateSourcePackage(pet, fsImpl);
  const resolvedCodexHome = codexHome
    ? path.resolve(codexHome)
    : resolveCodexHome({ env, homedir });
  const petsPath = path.join(resolvedCodexHome, "pets");
  const targetPath = path.join(petsPath, pet.slug);

  await fsImpl.mkdir(petsPath, { recursive: true });

  const targetAlreadyExists = await pathExists(targetPath, fsImpl);
  if (targetAlreadyExists) {
    const unchanged = await installedPackageMatches(
      targetPath,
      sourceManifest,
      pet,
      fsImpl,
    );

    if (unchanged) {
      return { status: "unchanged", targetPath, backupPath: undefined };
    }

    if (!force) {
      throw installerError(
        `${targetPath} already exists and differs from this package. Re-run with --force to back it up and install ${pet.displayName}.`,
        "INSTALL_CONFLICT",
      );
    }
  }

  let stagingPath = await fsImpl.mkdtemp(path.join(petsPath, `.${pet.slug}.tmp-`));
  let backupPath;

  try {
    await fsImpl.copyFile(
      pet.manifestPath,
      path.join(stagingPath, "pet.json"),
    );
    await fsImpl.copyFile(
      pet.spritesheetPath,
      path.join(stagingPath, "spritesheet.webp"),
    );
    await validateStagedPackage(stagingPath, sourceManifest, pet, fsImpl);

    if (targetAlreadyExists) {
      backupPath = await chooseBackupPath(targetPath, fsImpl, now());
      await fsImpl.rename(targetPath, backupPath);
    }

    try {
      await fsImpl.rename(stagingPath, targetPath);
      stagingPath = undefined;
    } catch (installError) {
      if (backupPath) {
        try {
          await fsImpl.rename(backupPath, targetPath);
          backupPath = undefined;
        } catch (rollbackError) {
          throw installerError(
            `Installation failed and the previous ${pet.displayName} install could not be restored. The backup remains at ${backupPath}.`,
            "INSTALL_ROLLBACK_FAILED",
            new AggregateError([installError, rollbackError]),
          );
        }
      }

      throw installerError(
        `Could not install ${pet.displayName} at ${targetPath}: ${installError.message}`,
        "INSTALL_FAILED",
        installError,
      );
    }

    return { status: "installed", targetPath, backupPath };
  } finally {
    if (stagingPath) {
      await fsImpl.rm(stagingPath, { recursive: true, force: true });
    }
  }
}
