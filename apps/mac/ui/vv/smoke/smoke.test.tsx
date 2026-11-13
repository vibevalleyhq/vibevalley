import { expect, open, test } from "nsh/test";
test("vendored packages load", async () => {
  const app = await open("./main.tsx");
  expect(app.texts()).toContain("等你看");
  expect(app.texts()).toContain("6 function");
  expect(app.spanStyle("text:等你看").fontSize).toBe(13);
  expect(app.spanStyle("text:等你看").color).toBe("#1c1917ff");
});
test("dark tokens", async () => {
  const app = await open("./main.tsx", { colorScheme: "dark" });
  expect(app.spanStyle("text:等你看").color).toBe("#ecebe8ff");
});
