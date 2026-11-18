// The changes review's check of a patch before DiffView draws it.
import "../polyfill";
import { expect, test } from "nsh/test";

import { wellFormed } from "../web/features/issue/views/CloseDialog";

test("a patch whose hunks have the lines their headers count is well formed; one cut short is not", () => {
  expect(wellFormed("@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n e\n")).toBe(true);
  expect(wellFormed("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n")).toBe(true);
  expect(wellFormed("@@ -10,7 +10,11 @@ export function session() {\n a\n+b\n")).toBe(false);
  expect(wellFormed("just text")).toBe(false);
});
