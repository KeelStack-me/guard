import { describe, expect, it } from "vitest";
import { canonicalizeIntent, fingerprintIntent } from "../intent.js";

describe("intent utilities", () => {
  it("canonicalizes supported values deterministically", async () => {
    expect(canonicalizeIntent({ b: 2, a: [true, null, undefined] })).toBe('{"a":[true,null,"__undefined__"],"b":2}');
    expect(canonicalizeIntent(1n)).toBe('"1n"');
    expect(canonicalizeIntent(new Date("2020-01-01T00:00:00.000Z"))).toBe('"2020-01-01T00:00:00.000Z"');
    expect(await fingerprintIntent({ a: 1 })).toBe(await fingerprintIntent({ a: 1 }));
  });

  it("rejects invalid intent values", () => {
    expect(() => canonicalizeIntent(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalizeIntent(Symbol("x"))).toThrow(TypeError);
  });
});
