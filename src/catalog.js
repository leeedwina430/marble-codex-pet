import { fileURLToPath } from "node:url";

export const MARBLE_SPRITESHEET_SHA256 =
  "4ff62fe39d2db6a4dbabb36cdc3b57fc7cab8cf993752608c680a461bd4bbe21";

const marble = Object.freeze({
  slug: "marble",
  id: "marble",
  displayName: "Marble",
  version: "1.0.0",
  manifestPath: fileURLToPath(new URL("../marble/pet.json", import.meta.url)),
  spritesheetPath: fileURLToPath(
    new URL("../marble/spritesheet.webp", import.meta.url),
  ),
  spritesheetSha256: MARBLE_SPRITESHEET_SHA256,
});

const catalog = new Map([[marble.slug, marble]]);

export function getPet(slug) {
  return catalog.get(slug);
}

export function listPets() {
  return [...catalog.values()];
}
