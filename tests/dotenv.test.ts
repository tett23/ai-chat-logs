import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDotenv, parseDotenv, pickUnset } from "../src/dotenv.cjs";
import { repoRoot, tempDir, writeFile } from "./helpers.ts";

const parse = (text: string) => Object.fromEntries(parseDotenv(text));

describe("parseDotenv", () => {
  test("reads assignments and skips blank and comment lines", () => {
    expect(parse("A=1\n\n# comment\n  # indented comment\nexport B=2\n")).toEqual({ A: "1", B: "2" });
  });

  test("keeps = in values, allows empty values and trims spaces", () => {
    expect(parse("A=b=c\nB=\n  C  =  d e  \n")).toEqual({ A: "b=c", B: "", C: "d e" });
  });

  test("strips comments after whitespace in unquoted values", () => {
    expect(parse("A=b # comment\nB=b#c\nC=x\t# tab comment\n")).toEqual({ A: "b", B: "b#c", C: "x" });
  });

  test("double-quoted values", () => {
    expect(parse('A="b # c "\nB="l1\\nl2"\nC="q\\"q"\nD="back\\\\slash"\nE="keep\\t"\nF="v" # comment\n')).toEqual({
      A: "b # c ",
      B: "l1\nl2",
      C: 'q"q',
      D: "back\\slash",
      E: "keep\\t",
      F: "v",
    });
  });

  test("single-quoted values are literal", () => {
    expect(parse("A='b\\n $X # c'\n")).toEqual({ A: "b\\n $X # c" });
  });

  test("does not expand variables or ~", () => {
    expect(parse("X=1\nA=$X\nB=${X}\nC=~/db\n")).toEqual({ X: "1", A: "$X", B: "${X}", C: "~/db" });
  });

  test("strips trailing carriage returns", () => {
    expect(parse("A=1\r\nB=\"2\"\r\n")).toEqual({ A: "1", B: "2" });
  });

  test("later assignments win", () => {
    expect(parse("A=1\nA=2\n")).toEqual({ A: "2" });
  });

  test.each([
    ["1A=x", 1],
    ["OK=1\nA-B=x", 2],
    ["OK=1\nOK=2\nnoequals", 3],
    ['A="unterminated', 1],
    ["A='unterminated", 1],
    ['A="v" extra', 1],
  ])("rejects %p with the line number", (text, line) => {
    expect(() => parseDotenv(text)).toThrow(new RegExp(`line ${line}\\b`));
  });
});

type Case = { name: string; input: string; pairs?: [string, string][]; errorLine?: number };
const cases: Case[] = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/dotenv-cases.json"), "utf8"));

// docs/adr/0007: the same cases are checked against the Rust parser of the GUI.
describe("parseDotenv: shared cases", () => {
  test.each(cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    if (c.errorLine === undefined) expect(parseDotenv(c.input)).toEqual(c.pairs ?? []);
    else expect(() => parseDotenv(c.input)).toThrow(new RegExp(`line ${c.errorLine}\\b`));
  });
});

describe("pickUnset", () => {
  test("keeps only names not already set", () => {
    expect(pickUnset({ A: "shell", C: "" }, [["A", "env"], ["B", "env"], ["C", "env"]])).toEqual([["B", "env"]]);
  });
});

describe("loadDotenv", () => {
  test("sets unset variables from the file", () => {
    const path = writeFile(join(tempDir(), ".env"), "A=file\nB=file\n");
    const env: Record<string, string | undefined> = { A: "shell" };
    loadDotenv(path, env);
    expect(env).toEqual({ A: "shell", B: "file" });
  });

  test("does nothing when the file does not exist", () => {
    const env: Record<string, string | undefined> = { A: "shell" };
    loadDotenv(join(tempDir(), "absent.env"), env);
    expect(env).toEqual({ A: "shell" });
  });

  test("reports the path and the line number of a syntax error", () => {
    const path = writeFile(join(tempDir(), ".env"), "A=1\nbad line\n");
    expect(() => loadDotenv(path, {})).toThrow(`${path}: line 2`);
  });
});

describe(".env.example", () => {
  test("has no active assignments", () => {
    expect(parseDotenv(readFileSync(join(repoRoot, ".env.example"), "utf8"))).toEqual([]);
  });
});
