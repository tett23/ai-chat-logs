import { expect, test } from "bun:test";
import { createImportGate } from "../src/import-gate.ts";

test("I5 keeps one import running across screens and notifies both buttons", async () => {
  const gate = createImportGate();
  const browseButton: boolean[] = [];
  const adminButton: boolean[] = [];
  gate.subscribe((running) => browseButton.push(running));
  gate.subscribe((running) => adminButton.push(running));
  let release!: (value: string) => void;
  let starts = 0;
  const first = gate.run(() => {
    starts++;
    return new Promise<string>((resolve) => { release = resolve; });
  });
  expect(gate.running()).toBe(true);
  expect(await gate.run(async () => { starts++; return "second"; })).toEqual({ started: false });
  expect(starts).toBe(1);
  release("first");
  expect(await first).toEqual({ started: true, value: "first" });
  expect(gate.running()).toBe(false);
  expect(browseButton).toEqual([false, true, false]);
  expect(adminButton).toEqual([false, true, false]);
});

test("I6 clears the running state after cancellation or failure", async () => {
  const gate = createImportGate();
  let starts = 0;
  expect(await gate.run(async () => { starts++; return null; })).toEqual({ started: true, value: null });
  expect(starts).toBe(1);
  expect(gate.running()).toBe(false);
  await expect(gate.run(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  expect(gate.running()).toBe(false);
});
