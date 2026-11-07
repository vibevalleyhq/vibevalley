import { expect, test, vi } from "vite-plus/test";

import { browserHistory, internalUrl, linkHref, memoryHistory, updateSearch } from "./history";

test("memory history preserves search/hash, replace and forward/back semantics", () => {
  const history = memoryHistory("/issues?repo=one#top");
  const changed = vi.fn();
  const stop = history.subscribe(changed);
  history.navigate("/farm");
  history.navigate("/farm");
  history.back();
  expect(history.read().href).toBe("/issues?repo=one#top");
  history.forward();
  expect(history.read().href).toBe("/farm");
  history.navigate("/repos", { replace: true });
  history.back();
  history.navigate("/chat");
  history.forward();
  expect(history.read().href).toBe("/chat");
  stop();
  changed.mockClear();
  history.back();
  expect(changed).not.toHaveBeenCalled();
});

test("regression: consecutive search edits merge the latest history rather than a stale reactive snapshot", () => {
  const history = memoryHistory("/issues?keep=x&tag=one&tag=two#detail");
  history.navigate(updateSearch(history.read(), { repo: "a/b" }), { replace: true });
  history.navigate(updateSearch(history.read(), { agent: "worker", tag: ["three", "four"] }), { replace: true });
  expect(history.read().href).toBe("/issues?keep=x&repo=a%2Fb&agent=worker&tag=three&tag=four#detail");
  history.navigate(updateSearch(history.read(), { repo: undefined }));
  expect(new URLSearchParams(history.read().search).has("repo")).toBe(false);
  expect(new URLSearchParams(history.read().search).getAll("tag")).toEqual(["three", "four"]);
});

test("navigation refuses external and executable URLs, but resolves same-origin relative links", () => {
  const base = "https://local.test/one/two";
  for (const to of ["javascript:alert(1)", "data:text/html,x", "https://other.test/", "//other.test/"]) expect(internalUrl(to, base)).toBeUndefined();
  expect(internalUrl("../three?q=one#anchor", base)?.href).toBe("https://local.test/three?q=one#anchor");
  expect(() => memoryHistory().navigate("https://other.test/")).toThrow("within the application");
});

test("regression: links resolve against the router path and never render executable schemes", () => {
  const base = "https://local.test/demo/one";
  expect(linkHref("?tag=one#top", base)).toBe("/demo/one?tag=one#top");
  expect(linkHref("../two", base)).toBe("/two");
  expect(linkHref("https://outside.test/", base)).toBe("https://outside.test/");
  expect(linkHref("mailto:help@example.com", base)).toBe("mailto:help@example.com");
  expect(linkHref("javascript:alert(1)", base)).toBeUndefined();
  expect(linkHref("data:text/html,x", base)).toBeUndefined();
});

test("memory histories do not share entries or subscribers", () => {
  const first = memoryHistory();
  const second = memoryHistory("/chat");
  first.navigate("/farm");
  expect(second.read().href).toBe("/chat");
});

test("browser history attaches and releases one pair of listeners for its subscribers", () => {
  const browser = new EventTarget();
  const add = vi.spyOn(browser, "addEventListener");
  const remove = vi.spyOn(browser, "removeEventListener");
  const history = browserHistory(
    Object.assign(browser, {
      location: new URL("http://router.local/"),
      history: { back: vi.fn(), forward: vi.fn(), replaceState: vi.fn(), pushState: vi.fn() },
    }),
  );
  const first = vi.fn();
  const second = vi.fn();
  const offFirst = history.subscribe(first);
  const offSecond = history.subscribe(second);
  expect(add).toHaveBeenCalledTimes(2);
  browser.dispatchEvent(new Event("popstate"));
  browser.dispatchEvent(new Event("hashchange"));
  expect(first).toHaveBeenCalledTimes(2);
  offFirst();
  expect(remove).not.toHaveBeenCalled();
  browser.dispatchEvent(new Event("popstate"));
  expect(first).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledTimes(3);
  offSecond();
  expect(remove).toHaveBeenCalledTimes(2);
});
