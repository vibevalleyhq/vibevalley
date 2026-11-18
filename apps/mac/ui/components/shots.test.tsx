// Pictures of every story in light and dark: `nsh test --target macos
// components/shots.test.tsx` writes them to components/shots/ (git-ignored);
// headless it only checks each story came up.
import { expect, open, test } from "nsh/test";

import { stories } from "./Gallery";

for (const s of stories) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${s.id} ${scheme}`, async () => {
      const app = await open("./stories/main.tsx", {
        width: 720,
        height: 1100,
        colorScheme: scheme,
        host: { params: { story: s.id, width: 680 } },
      });
      await app.wait(600);
      expect(app.texts().length).toBeGreaterThan(0);
      try {
        await app.screenshot(`components/shots/${s.id}-${scheme}.png`);
      } catch (e) {
        // headless runs draw nothing; on a host, say why there is no picture
        console.log(`no picture of ${s.id} ${scheme}: ${String(e)}`);
      }
    });
  }
}
