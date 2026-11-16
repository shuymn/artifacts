// Removes the top-level `fileToken` member from the staged copies of Pencil design files (`.pen`), so that it is never
// committed.
//
// Pencil adds a `fileToken` to a `.pen` file each time it saves it. The member is not part of the design, and the
// secret scan reports it, so the pre-commit hook (lefthook.yml) runs this script on the staged `.pen` files before the
// scan. The script rewrites the index entry only, never the working file: while the hook runs, lefthook hides the
// unstaged part of a partly staged file and restores it afterwards, which a rewritten working file would break.
//
// The member is cut out of the text, so the rest of the file keeps its bytes; the file is parsed before and after, and
// the script fails unless the only difference is the missing member.
//
// Usage: node scripts/strip-pen-file-token.mjs <file.pen>... (paths from the repository root, as lefthook passes them)
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const git = (args, input) =>
  execFileSync("git", ["--literal-pathspecs", ...args], { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// A string member named fileToken; whether it is the top-level one is checked by parsing the result.
const MEMBER = /"fileToken"\s*:\s*"(?:[^"\\]|\\.)*"/g;
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// The text spans whose removal takes out the member at [start, end) with one of its commas.
function spans(text, start, end) {
  const before = text.slice(0, start).trimEnd();
  const after = end + (text.slice(end).length - text.slice(end).trimStart().length);
  const out = [];
  if (before.endsWith(",")) out.push([before.length - 1, end]);
  if (text[after] === ",") {
    const next = after + 1 + (text.slice(after + 1).length - text.slice(after + 1).trimStart().length);
    out.push([start, next]);
  }
  out.push([start, end]);
  return out;
}

function strip(path, text) {
  const design = JSON.parse(text);
  if (!isObject(design) || !Object.hasOwn(design, "fileToken")) return undefined;
  const { fileToken: _token, ...want } = design;
  for (const match of text.matchAll(MEMBER)) {
    for (const [from, to] of spans(text, match.index, match.index + match[0].length)) {
      const out = text.slice(0, from) + text.slice(to);
      try {
        const got = JSON.parse(out);
        if (isDeepStrictEqual(Object.keys(got), Object.keys(want)) && isDeepStrictEqual(got, want)) return out;
      } catch {
        // Not this span.
      }
    }
  }
  throw new Error(`${path}: cannot cut the top-level fileToken out of the text`);
}

for (const path of process.argv.slice(2)) {
  // "<mode> <hash> <stage>\t<path>"; nothing when the path is not in the index (a deleted file).
  const entry = git(["ls-files", "--stage", "-z", "--", path]).split("\0")[0];
  if (!entry) continue;
  const [mode, hash, stage] = entry.slice(0, entry.indexOf("\t")).split(" ");
  if (stage !== "0") continue;
  const text = strip(path, git(["cat-file", "blob", hash]));
  if (text === undefined) continue;
  const stripped = git(["hash-object", "-w", "--stdin"], text).trim();
  git(["update-index", "--cacheinfo", `${mode},${stripped},${path}`]);
}
