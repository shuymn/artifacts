// Removes the top-level `fileToken` member from Pencil design files (`.pen`) so that it is never committed.
//
// Pencil adds a `fileToken` to a `.pen` file each time it saves it. The member is not part of the design, and the
// secret scan reports it, so the pre-commit hook (lefthook.yml) runs this script on the staged `.pen` files before the
// scan and stages the result. Pencil writes the file as JSON indented by two spaces without a final newline, which
// `JSON.stringify` writes the same way, so the member is the only change. Files without it are left untouched.
//
// Usage: node scripts/strip-pen-file-token.mjs <file.pen>...
import { readFileSync, writeFileSync } from "node:fs";

for (const path of process.argv.slice(2)) {
  const design = JSON.parse(readFileSync(path, "utf8"));
  if (typeof design !== "object" || design === null || !Object.hasOwn(design, "fileToken")) continue;
  delete design.fileToken;
  writeFileSync(path, JSON.stringify(design, null, 2));
}
