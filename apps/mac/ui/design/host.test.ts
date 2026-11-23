import "../infra/polyfill";
import { describe, expect, test } from "nsh/test";

import { followDesignHref, type DesignHost } from "./host";

function stubHost(calls: string[]): DesignHost {
  return {
    openExternal: (url) => {
      calls.push(`external:${url}`);
    },
    openFile: (path) => {
      calls.push(`file:${path}`);
    },
    navigate: (path, options) => {
      calls.push(`nav:${path}:${options?.replace === true ? "replace" : "push"}`);
    },
    saveFile: () => Promise.resolve({ saved: false }),
    renderQr: () => Promise.resolve(undefined),
    toast: () => {},
    getPrefWidth: () => undefined,
    setPrefWidth: () => {},
    formatError: (e) => String(e),
  };
}

describe("design/host", () => {
  test("followDesignHref routes leading-slash paths to navigate and URLs to openExternal", () => {
    const calls: string[] = [];
    const host = stubHost(calls);

    followDesignHref(host, "/issues/42");
    followDesignHref(host, " /settings/general ", { replace: true });
    followDesignHref(host, "https://vibevalley.dev/docs");
    followDesignHref(host, "   ");

    expect(calls).toEqual(["nav:/issues/42:push", "nav:/settings/general:replace", "external:https://vibevalley.dev/docs"]);
  });
});
