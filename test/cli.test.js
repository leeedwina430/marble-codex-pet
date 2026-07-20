import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runCli } from "../src/cli.js";

function captureStream() {
  let output = "";
  return {
    stream: { write(chunk) { output += String(chunk); } },
    text: () => output,
  };
}

const fakePet = Object.freeze({
  slug: "marble",
  id: "marble",
  displayName: "Marble",
});

test("list prints the bundled pet", async () => {
  const output = captureStream();
  const result = await runCli(["list"], {
    stdout: output.stream,
    getPetList: () => [fakePet],
  });

  assert.equal(result.status, "listed");
  assert.equal(output.text(), "marble\tMarble\n");
});

test("help prints usage without invoking the installer", async () => {
  const output = captureStream();
  const result = await runCli(["--help"], { stdout: output.stream });

  assert.equal(result.status, "help");
  assert.match(output.text(), /codex-pets add marble/);
});

test("add marble forwards CODEX_HOME and --force to the installer", async () => {
  const output = captureStream();
  let call;
  const configuredHome = path.resolve("/tmp/marble-cli-test-home");

  await runCli(["add", "marble", "--force"], {
    stdout: output.stream,
    env: { CODEX_HOME: configuredHome },
    getPetBySlug: (slug) => (slug === "marble" ? fakePet : undefined),
    install: async (pet, options) => {
      call = { pet, options };
      return {
        status: "installed",
        targetPath: path.join(configuredHome, "pets", "marble"),
        backupPath: path.join(configuredHome, "pets", "marble.backup-test"),
      };
    },
  });

  assert.equal(call.pet, fakePet);
  assert.equal(call.options.force, true);
  assert.equal(call.options.codexHome, configuredHome);
  assert.match(output.text(), /Installed Marble/);
  assert.match(output.text(), /Previous install backed up/);
});

test("add reports an unchanged install", async () => {
  const output = captureStream();
  await runCli(["add", "marble"], {
    stdout: output.stream,
    env: { CODEX_HOME: "/tmp/marble-cli-unchanged" },
    getPetBySlug: () => fakePet,
    install: async () => ({
      status: "unchanged",
      targetPath: "/tmp/marble-cli-unchanged/pets/marble",
    }),
  });

  assert.match(output.text(), /already installed and unchanged/);
});

test("unknown commands, pets, and flags are rejected", async () => {
  await assert.rejects(() => runCli(["remove", "marble"]), /Unknown command/);
  await assert.rejects(
    () => runCli(["add", "other"], { getPetBySlug: () => undefined }),
    /Unknown pet/,
  );
  await assert.rejects(
    () => runCli(["add", "marble", "--unsafe"], { getPetBySlug: () => fakePet }),
    /Unknown option/,
  );
  await assert.rejects(
    () => runCli(["add", "../marble"], { getPetBySlug: () => undefined }),
    /Unknown pet/,
  );
  await assert.rejects(
    () => runCli(["add", "Marble"], { getPetBySlug: () => undefined }),
    /Unknown pet/,
  );
});
