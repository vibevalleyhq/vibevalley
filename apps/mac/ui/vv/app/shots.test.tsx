// Pictures of the workbench on the fixture: run with `--target gpui` (the
// host VibeValley renders with); headless it only checks the pages came up.
import "../polyfill";
import { expect, open, test } from "nsh/test";

const shots: { name: string; route: string; scheme: "light" | "dark"; width: number }[] = [
  { name: "issues-light", route: "/issues", scheme: "light", width: 1200 },
  { name: "issues-dark", route: "/issues", scheme: "dark", width: 1200 },
  { name: "issues-narrow", route: "/issues", scheme: "light", width: 560 },
  { name: "issue-open-light", route: "/issues/i18", scheme: "light", width: 1200 },
  { name: "catalog-light", route: "/catalog/bear-farmer-down", scheme: "light", width: 1400 },
  { name: "catalog-dark", route: "/catalog/machine-tractor", scheme: "dark", width: 1400 },
  { name: "catalog-mid", route: "/catalog/bear-farmer-down", scheme: "light", width: 1100 },
  { name: "catalog-narrow", route: "/catalog", scheme: "light", width: 560 },
  { name: "catalog-cursors", route: "/catalog/cursors", scheme: "light", width: 1200 },
  { name: "catalog-sounds", route: "/catalog/sounds", scheme: "light", width: 1200 },
  { name: "notes-days", route: "/pkm", scheme: "light", width: 1400 },
  { name: "notes-page", route: "/pkm/vibevalley-原生移植", scheme: "light", width: 1400 },
  { name: "notes-page-dark", route: "/pkm/vibevalley-原生移植", scheme: "dark", width: 1100 },
  { name: "notes-narrow", route: "/pkm/vibevalley-原生移植", scheme: "light", width: 600 },
  { name: "catalog-sounds-dark", route: "/catalog/sounds", scheme: "dark", width: 800 },
  { name: "library-light", route: "/library", scheme: "light", width: 1400 },
  { name: "library-dark", route: "/library", scheme: "dark", width: 1400 },
  { name: "library-make-image", route: "/library?make=image", scheme: "light", width: 1400 },
  { name: "library-make-speech", route: "/library?make=speech", scheme: "dark", width: 1400 },
  { name: "library-make-audio", route: "/library?make=audio", scheme: "light", width: 1400 },
];

for (const s of shots) {
  test(s.name, async () => {
    const app = await open("./story.tsx", { width: s.width, height: 720, colorScheme: s.scheme, platform: "macos", host: { params: { route: s.route } } });
    expect(app.count("id:rail")).toBe(1);
    try {
      await app.screenshot(`vv/app/shots/${s.name}.png`);
    } catch (e) {
      // headless runs draw nothing; on a host, say why there is no picture
      console.log(`no picture of ${s.name}: ${String(e)}`);
    }
  });
}
