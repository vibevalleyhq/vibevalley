// The app answers host.pixelDir and host.pixelManifest itself; stories and
// tests read the art from the checkout (never bundled into App.tsx).
import sprites from "../../../../../assets/pixel/sprites.json";

export const responses: Record<string, unknown> = {
  "host.pixelDir": { path: decodeURI(new URL("../../../../../assets/pixel", import.meta.url).pathname) },
  // Returned via thunk so JSON.stringify(responses) in fixtures.test.ts omits the 105 KB manifest.
  "host.pixelManifest": () => sprites,
  "host.playSound": null,
};
