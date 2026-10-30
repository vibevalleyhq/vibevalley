// Checks on the components' source that the type checker cannot make.

import { expect, test } from "vite-plus/test";

const sources = import.meta.glob<string>("../src/**/*.tsx", { query: "?raw", import: "default", eager: true });

test("no element spreads a call's result: next to {...rest} it re-reads children and rebuilds them, losing the focus", () => {
  const found = Object.entries(sources).flatMap(([file, text]) =>
    [...text.matchAll(/\{\.\.\.(?!omit\()[\w.]+\(.*?\)\}/gu)].map((m) => `${file.replace("../src/", "")}: ${m[0]}`),
  );
  expect(found).toEqual([]);
});
