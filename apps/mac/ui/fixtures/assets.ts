// The app answers host.assetsDir itself; stories and tests read the Papertrails art from the checkout.
export const responses: Record<string, unknown> = {
  "host.assetsDir": { path: decodeURI(new URL("../../../../assets", import.meta.url).pathname) },
  "host.playSound": null,
};
