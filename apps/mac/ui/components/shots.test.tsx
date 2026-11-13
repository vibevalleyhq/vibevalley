// Pictures of every story in light and dark: `nsh test --target macos
// components/shots.test.tsx` writes them to components/shots/ (git-ignored).
import { open, test } from "nsh/test";

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
      await app.screenshot(`components/shots/${s.id}-${scheme}.png`);
    });
  }
}
