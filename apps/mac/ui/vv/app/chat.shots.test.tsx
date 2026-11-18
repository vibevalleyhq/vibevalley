// Pictures of the chat page, settings and the switcher on the fixture
// (story.tsx, in-page transport): run with `--target gpui` (the host VibeValley
// renders with) or `--target macos` while the screen is locked; headless
// it only checks the pages came up.
import "../polyfill";
import { expect, open, test } from "nsh/test";

const shots: { name: string; route: string; scheme: "light" | "dark"; width: number; id: string }[] = [
  { name: "chat-light", route: "/chat", scheme: "light", width: 1200, id: "chat-page" },
  { name: "chat-dark", route: "/chat", scheme: "dark", width: 1200, id: "chat-page" },
  { name: "chat-narrow", route: "/chat", scheme: "light", width: 560, id: "chat-page" },
  { name: "chat-thread-light", route: "/chat/t-login", scheme: "light", width: 1400, id: "thread-pane" },
  { name: "settings-general-light", route: "/settings/general", scheme: "light", width: 1200, id: "settings-nav" },
  { name: "settings-accounts-dark", route: "/settings/accounts", scheme: "dark", width: 1200, id: "settings-nav" },
  { name: "settings-memory-light", route: "/settings/memory", scheme: "light", width: 1200, id: "settings-nav" },
  { name: "settings-about-narrow", route: "/settings/about", scheme: "light", width: 560, id: "settings-nav" },
];

test("chat-lightbox", async () => {
  const app = await open("./story.tsx", { width: 1200, height: 720, colorScheme: "dark", platform: "macos", host: { params: { route: "/chat" } } });
  await app.wait(1500);
  // The attachments sit above the fold: scroll the log up to them.
  await app.scroll("id:embed", -500);
  await app.wait(300);
  await app.press("id:attachment-login.png");
  await app.wait(800);
  expect(app.count("id:lightbox-name")).toBe(1);
  try {
    await app.screenshot("vv/app/shots/chat-lightbox.png");
  } catch (e) {
    console.log(`no picture of chat-lightbox: ${String(e)}`);
  }
});

for (const s of shots) {
  test(s.name, async () => {
    const app = await open("./story.tsx", { width: s.width, height: 720, colorScheme: s.scheme, platform: "macos", host: { params: { route: s.route } } });
    await app.wait(1500);
    expect(app.count(`id:${s.id}`)).toBe(1);
    try {
      await app.screenshot(`vv/app/shots/${s.name}.png`);
    } catch (e) {
      // headless runs draw nothing; on a host, say why there is no picture
      console.log(`no picture of ${s.name}: ${String(e)}`);
    }
  });
}
