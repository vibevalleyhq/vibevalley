import "../infra/polyfill";
import { describe, expect, test } from "nsh/test";

import { resolveIconColor } from "./Icon";
import { tone } from "./tone";

describe("design/Icon", () => {
  test("explicit tone overrides iconTone fallback for status icons", () => {
    expect(tone("page")).not.toBe(tone("leaf"));
    expect(tone("page")).not.toBe(tone("berry"));
    expect(tone("page")).not.toBe(tone("wheat"));

    expect(resolveIconColor({ name: "check", tone: "page" })).toBe(tone("page"));
    expect(resolveIconColor({ name: "cross", tone: "page" })).toBe(tone("page"));
    expect(resolveIconColor({ name: "warn", tone: "page" })).toBe(tone("page"));
  });

  test("explicit color takes precedence over tone and iconTone", () => {
    const custom = tone("accent");
    expect(resolveIconColor({ name: "check", color: custom })).toBe(custom);
    expect(resolveIconColor({ name: "cross", color: custom, tone: "page" })).toBe(custom);
  });

  test("omitting tone and color keeps iconTone fallback and defaults others to ink", () => {
    expect(resolveIconColor({ name: "check" })).toBe(tone("leaf"));
    expect(resolveIconColor({ name: "cross" })).toBe(tone("berry"));
    expect(resolveIconColor({ name: "warn" })).toBe(tone("wheat"));
    expect(resolveIconColor({ name: "copy" })).toBe(tone("ink"));
    expect(resolveIconColor({ name: "copy", tone: "muted" })).toBe(tone("muted"));
  });
});
