// docs/adr/0004: a minimal .env parser shared by the Bun CLIs and ecosystem.config.cjs (Node.js).
// CommonJS so that pm2 can require it. No variable or ~ expansion, no multi-line values.
"use strict";

const { readFileSync } = require("node:fs");

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOUBLE_ESCAPES = { n: "\n", '"': '"', "\\": "\\" };

const fail = (lineNo, message) => {
  throw new Error(`line ${lineNo}: ${message}`);
};

// Only whitespace or a # comment may follow a closing quote.
const checkRest = (rest, lineNo) => {
  if (!/^\s*(#.*)?$/.test(rest)) fail(lineNo, "unexpected characters after the closing quote");
};

const parseDoubleQuoted = (body, lineNo) => {
  const close = /^((?:[^"\\]|\\.)*)"/.exec(body);
  if (!close) fail(lineNo, "unterminated double quote");
  checkRest(body.slice(close[0].length), lineNo);
  return close[1].replace(/\\(.)/g, (whole, c) => DOUBLE_ESCAPES[c] ?? whole);
};

const parseSingleQuoted = (body, lineNo) => {
  const close = body.indexOf("'");
  if (close < 0) fail(lineNo, "unterminated single quote");
  checkRest(body.slice(close + 1), lineNo);
  return body.slice(0, close);
};

const parseValue = (raw, lineNo) => {
  const value = raw.trim();
  if (value.startsWith('"')) return parseDoubleQuoted(value.slice(1), lineNo);
  if (value.startsWith("'")) return parseSingleQuoted(value.slice(1), lineNo);
  return value.replace(/\s#.*$/, "").trimEnd();
};

const parseLine = (line, lineNo) => {
  const body = line.trim().replace(/^export\s+/, "");
  const eq = body.indexOf("=");
  if (eq < 0) fail(lineNo, "expected NAME=VALUE");
  const name = body.slice(0, eq).trim();
  if (!NAME.test(name)) fail(lineNo, `invalid name: ${name}`);
  return [name, parseValue(body.slice(eq + 1), lineNo)];
};

const isSkipped = (line) => {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
};

// Returns [name, value] pairs; a later pair overrides an earlier one with the same name.
const parseDotenv = (text) => {
  const pairs = text
    .split("\n")
    .map((line, i) => [line.replace(/\r$/, ""), i + 1])
    .filter(([line]) => !isSkipped(line))
    .map(([line, lineNo]) => parseLine(line, lineNo));
  return [...new Map(pairs)];
};

// Pairs whose names are not already set in env.
const pickUnset = (env, pairs) => pairs.filter(([name]) => env[name] === undefined);

const readIfExists = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
};

// Sets variables from the file at path into env without overriding existing ones.
const loadDotenv = (path, env) => {
  const text = readIfExists(path);
  if (text === null) return;
  const pairs = (() => {
    try {
      return parseDotenv(text);
    } catch (e) {
      throw new Error(`${path}: ${e.message}`);
    }
  })();
  for (const [name, value] of pickUnset(env, pairs)) env[name] = value;
};

module.exports = { parseDotenv, pickUnset, loadDotenv };
