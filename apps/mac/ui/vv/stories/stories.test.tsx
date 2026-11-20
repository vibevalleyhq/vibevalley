// Headless checks of the ported pages; `--target macos` also writes
// pictures to vv/stories/shots/ (git-ignored).
import { expect, open, test } from "nsh/test";

const shoot = async (app: Awaited<ReturnType<typeof open>>, name: string) => {
  try {
    await app.screenshot(`vv/stories/shots/${name}.png`);
  } catch {
    // headless runs draw nothing
  }
};

for (const scheme of ["light", "dark"] as const) {
  test(`board ${scheme}`, async () => {
    const app = await open("./main.tsx", { width: 1100, height: 640, colorScheme: scheme, platform: "macos", host: { params: { story: "board" } } });
    const texts = app.texts();
    for (const s of ["待办", "处理中", "等你看", "已关", "修好登录", "进行中满了：同时最多 3 件"]) expect(texts).toContain(s);
    expect(app.count("id:issue-card")).toBe(8);
    await shoot(app, `board-${scheme}`);
  });
}

test("board narrow shows one lane behind tabs", async () => {
  const app = await open("./main.tsx", { width: 420, height: 640, platform: "macos", host: { params: { story: "board" } } });
  expect(app.count("id:issue-card")).toBe(3);
  await app.press("text:处理中");
  expect(app.texts()).toContain("修好登录");
  await shoot(app, "board-narrow");
});

for (const scheme of ["light", "dark"] as const) {
  test(`markdown ${scheme}: highlighted code with its copy button, a long block folded, a Mermaid diagram`, async () => {
    const app = await open("./main.tsx", { width: 760, height: 900, colorScheme: scheme, platform: "macos", host: { params: { story: "markdown" } } });
    await app.wait(800);
    expect(app.count("id:code-block")).toBe(2);
    expect(app.count("id:code-copy")).toBe(2);
    expect(app.count("id:diagram")).toBe(1);
    expect(app.count("id:diagram-error")).toBe(0);
    expect(app.texts()).toContain("修好登录");
    await app.press("id:md-message >> id:code-copy");
    expect(app.clipboard()).toBe("export const expired = (s: Session, now: number) => s.until < now;");
    expect(app.count("id:code-more")).toBe(1);
    await shoot(app, `markdown-${scheme}`);
  });
}
