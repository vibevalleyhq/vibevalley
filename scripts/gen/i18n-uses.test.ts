import { expect, test } from "vite-plus/test";

import { messageUses } from "./i18n-uses";

test("regression: Rust formatted catalog keys keep their translated family", () => {
  const uses = messageUses("scene.rs", 't(&format!("web.farm.native.{key}"), &[]);\nt(&format!("shared.status.{}", status), &[])');
  expect(uses.map(({ key, prefix, line }) => ({ key, prefix, line }))).toEqual([
    { key: "web.farm.native.", prefix: true, line: 1 },
    { key: "shared.status.", prefix: true, line: 2 },
  ]);
});

test("explicit Rust locale calls remain exact references, including missing keys", () => {
  expect(messageUses("scene.rs", 't_in("en", "web.farm.missing", &[])').map(({ key, prefix }) => ({ key, prefix }))).toEqual([
    { key: "web.farm.missing", prefix: false },
  ]);
});

test("TypeScript literal and template calls retain their scope", () => {
  expect(messageUses("view.tsx", 't("web.issue.title"); t(`web.issue.status.${status}`)').map(({ key, prefix }) => ({ key, prefix }))).toEqual([
    { key: "web.issue.title", prefix: false },
    { key: "web.issue.status.", prefix: true },
  ]);
});

test("formatted filenames do not keep translation namespaces alive", () => {
  expect(messageUses("app.rs", 'format!("server.json: {error}"); format!("frame-{id}.png")')).toEqual([]);
});
