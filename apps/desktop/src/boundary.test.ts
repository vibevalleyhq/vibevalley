import { describe, expect, it } from "vite-plus/test";

import { navigationOf, pageWebPreferences, revealable } from "./boundary";

describe("what the page may do to this machine", () => {
  it("runs sandboxed, isolated from the preload, without Node", () => {
    expect(pageWebPreferences("/p.cjs")).toEqual({ preload: "/p.cjs", contextIsolation: true, sandbox: true, nodeIntegration: false });
  });

  it("stays on the server's origin, opens web links in the browser, and goes nowhere else", () => {
    const server = "http://127.0.0.1:8787";
    expect(navigationOf("http://127.0.0.1:8787/farm", server)).toBe("stay");
    expect(navigationOf("http://127.0.0.1:9999/", server)).toBe("browser");
    expect(navigationOf("https://vibevalley.dev", server)).toBe("browser");
    expect(navigationOf("file:///etc/passwd", server)).toBe("block");
    expect(navigationOf("javascript:alert(1)", server)).toBe("block");
    expect(navigationOf("not a url", server)).toBe("block");
    expect(navigationOf("http://127.0.0.1:8787/", undefined)).toBe("browser");
  });

  it("shows only a path under one of its roots", () => {
    const roots = ["/Users/me", "/Volumes/farm"];
    expect(revealable("/Users/me/.vibevalley/vibevalley.yaml", roots)).toBe(true);
    expect(revealable("/Users/me", roots)).toBe(true);
    expect(revealable("/Volumes/farm/db", roots)).toBe(true);
    expect(revealable("/Users/me/../other/secret", roots)).toBe(false);
    expect(revealable("/Users/meagain/x", roots)).toBe(false);
    expect(revealable("/etc/passwd", roots)).toBe(false);
    expect(revealable("relative/path", roots)).toBe(false);
    expect(revealable("/Users/me/a\0b", roots)).toBe(false);
  });
});
