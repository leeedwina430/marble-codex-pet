import os from "node:os";
import { getPet, listPets } from "./catalog.js";
import { installPet, resolveCodexHome } from "./installer.js";

export const USAGE = `Usage:
  codex-pets list
  codex-pets add marble [--force]

Commands:
  list              List pets bundled with this installer.
  add marble            Install Marble into CODEX_HOME/pets/marble.
  add marble --force    Back up a changed existing install, then install Marble.
`;

function cliError(message, code = "INVALID_ARGUMENTS") {
  const error = new Error(`${message}\n\n${USAGE}`);
  error.code = code;
  return error;
}

function writeLine(stream, line = "") {
  stream.write(`${line}\n`);
}

export async function runCli(
  argv,
  {
    stdout = process.stdout,
    env = process.env,
    homedir = os.homedir,
    getPetBySlug = getPet,
    getPetList = listPets,
    install = installPet,
  } = {},
) {
  const [command, ...args] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    stdout.write(USAGE);
    return { status: "help" };
  }

  if (command === "list") {
    if (args.length !== 0) {
      throw cliError("The list command does not accept arguments.");
    }

    for (const pet of getPetList()) {
      writeLine(stdout, `${pet.slug}\t${pet.displayName}`);
    }
    return { status: "listed" };
  }

  if (command !== "add") {
    throw cliError(`Unknown command: ${command}`);
  }

  const [slug, ...flags] = args;
  if (!slug) throw cliError("The add command requires a pet name.");

  const unknownFlags = flags.filter((flag) => flag !== "--force");
  if (unknownFlags.length > 0) {
    throw cliError(`Unknown option: ${unknownFlags[0]}`);
  }
  if (flags.filter((flag) => flag === "--force").length > 1) {
    throw cliError("The --force option may be supplied only once.");
  }

  const pet = getPetBySlug(slug);
  if (!pet) throw cliError(`Unknown pet: ${slug}`, "UNKNOWN_PET");

  const codexHome = resolveCodexHome({ env, homedir });
  const result = await install(pet, {
    force: flags.includes("--force"),
    codexHome,
    env,
    homedir,
  });

  if (result.status === "unchanged") {
    writeLine(stdout, `${pet.displayName} is already installed and unchanged at ${result.targetPath}`);
  } else {
    writeLine(stdout, `Installed ${pet.displayName} at ${result.targetPath}`);
    if (result.backupPath) {
      writeLine(stdout, `Previous install backed up to ${result.backupPath}`);
    }
  }

  writeLine(stdout, "Open Codex Settings > Pets and refresh the pet list.");
  return result;
}
