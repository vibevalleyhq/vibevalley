import { expect, it } from "vite-plus/test";

import { publicHttps, publicIpv4, publicLookup } from "./publicHttp.ts";

it.each([
  "127.0.0.1",
  "10.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.0.1",
  "100.64.0.1",
  "198.18.0.1",
  "224.0.0.1",
  "0.0.0.0",
  "192.0.2.1",
  "198.51.100.1",
  "203.0.113.1",
  "::1",
  "::ffff:127.0.0.1",
  "fd00::1",
])("regression: public downloads never dial %s", (address) => expect(publicIpv4(address)).toBe(false));
it.each(["1.1.1.1", "8.8.8.8", "172.32.0.1"])("public IPv4 %s can be dialed", (address) => expect(publicIpv4(address)).toBe(true));
it.each([
  "http://example.com/a",
  "https://127.1/a",
  "https://2130706433/a",
  "https://[::1]/a",
  "https://user:pass@example.com/a",
  "https://example.com:8080/a",
])("regression: unsafe asset URL %s is refused", (url) => expect(publicHttps(new URL(url))).toBe(false));
it("the connection lookup passes checked addresses directly to the socket and rejects mixed DNS answers", () => {
  const answers = [{ address: "8.8.8.8", family: 4 }];
  const lookup = publicLookup((_host, done) => done(null, answers));
  let calls = 0;
  lookup("public.example", { all: true }, (error, address) => {
    calls++;
    expect(error).toBeNull();
    expect(address).toBe(answers);
  });
  lookup("public.example", {}, (error, address, family) => {
    calls++;
    expect(error).toBeNull();
    expect(address).toBe("8.8.8.8");
    expect(family).toBe(4);
  });
  answers.push({ address: "127.0.0.1", family: 4 });
  lookup("public.example", { all: true }, (error, address) => {
    calls++;
    expect(error).not.toBeNull();
    expect(address).toEqual([]);
  });
  expect(calls).toBe(3);
});
