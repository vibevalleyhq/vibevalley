// The app answers host.pixelDir itself; stories and pictures read the art
// from the checkout (the repo's assets/, nsh.json
// grants reading it).
export const responses: Record<string, unknown> = {
  "host.pixelDir": { path: decodeURI(new URL("../../../../../assets/pixel", import.meta.url).pathname) },
};
