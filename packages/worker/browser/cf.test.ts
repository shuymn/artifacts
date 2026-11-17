// The browser tests' pin of `request.cf` (cf.ts), in Node: the file it writes, and that undoing it, after a run or a
// failed write, gives the variable back its previous value and leaves no directory behind.
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { CF_PATH_VARIABLE, pinCf, type CfFiles } from "./cf.ts";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const ELSEWHERE = "/elsewhere/cf.json";

describe("pinCf", () => {
  it.each([
    ["deletes the variable, which was unset,", {}],
    ["gives the variable back its value", { [CF_PATH_VARIABLE]: ELSEWHERE }],
  ])("writes the zone alone, then %s and removes the directory", async (_case, before: NodeJS.ProcessEnv) => {
    const env = { ...before };
    const unpin = await pinCf("Asia/Tokyo", env);
    const path = env[CF_PATH_VARIABLE] ?? "";
    expect(path).not.toBe(ELSEWHERE);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ timezone: "Asia/Tokyo" });
    await unpin();
    expect(env).toEqual(before);
    expect(await exists(dirname(path))).toBe(false);
  });

  it.each([
    ["unset", {}],
    ["set", { [CF_PATH_VARIABLE]: ELSEWHERE }],
  ])(
    "removes the directory and leaves the variable %s when the write fails",
    async (_case, before: NodeJS.ProcessEnv) => {
      const env = { ...before };
      const made: string[] = [];
      const files: CfFiles = {
        mkdtemp: async (prefix) => {
          const directory = await mkdtemp(prefix);
          made.push(directory);
          return directory;
        },
        writeFile: () => Promise.reject(new Error("disk full")),
        rm,
      };
      await expect(pinCf("Asia/Tokyo", env, files)).rejects.toThrow("disk full");
      expect(env).toEqual(before);
      expect(made).toHaveLength(1);
      expect(await Promise.all(made.map(exists))).toEqual([false]);
    },
  );

  it("gives the variable back even when removing the directory fails", async () => {
    const env: NodeJS.ProcessEnv = {};
    const unpin = await pinCf("Asia/Tokyo", env, { mkdtemp, writeFile, rm: () => Promise.reject(new Error("busy")) });
    const path = env[CF_PATH_VARIABLE] ?? "";
    await expect(unpin()).rejects.toThrow("busy");
    expect(env).toEqual({});
    await rm(dirname(path), { recursive: true, force: true });
  });
});
