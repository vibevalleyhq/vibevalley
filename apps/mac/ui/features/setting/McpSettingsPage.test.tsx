import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { McpHostInfo, McpListResult } from "@vibevalley/protocol";

import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

const sampleList: McpListResult = {
  serverName: "vibevalley",
  stdioCommand: "vibevalley",
  stdioArgs: ["mcp"],
  httpUrl: "http://127.0.0.1:8790/mcp",
  hosts: [
    {
      id: "antigravity",
      label: "Antigravity",
      installed: true,
      configPath: "/Users/test/.gemini/config/mcp_config.json",
      status: { kind: "notInstalled" },
      supportsStdio: true,
      supportsHttp: true,
      stdioSnippet: '{"mcpServers":{"vibevalley":{"command":"vibevalley","args":["mcp"]}}}',
      httpSnippet: '{"mcpServers":{"vibevalley":{"serverUrl":"http://127.0.0.1:8790/mcp"}}}',
    },
    {
      id: "claude",
      label: "Claude Code",
      installed: true,
      configPath: "/Users/test/.claude.json",
      status: { kind: "installed", transport: "stdio" },
      supportsStdio: true,
      supportsHttp: true,
      stdioSnippet: '{"mcpServers":{"vibevalley":{"type":"stdio","command":"vibevalley","args":["mcp"]}}}',
      httpSnippet: '{"mcpServers":{"vibevalley":{"type":"http","url":"http://127.0.0.1:8790/mcp"}}}',
    },
    {
      id: "codex",
      label: "Codex",
      installed: true,
      configPath: "/Users/test/.codex/config.toml",
      status: { kind: "outdated", current: "stdio", reason: "transport changed" },
      supportsStdio: true,
      supportsHttp: true,
      stdioSnippet: '[mcp_servers.vibevalley]\ncommand = "vibevalley"\nargs = ["mcp"]',
      httpSnippet: '[mcp_servers.vibevalley]\nurl = "http://127.0.0.1:8790/mcp"',
    },
    {
      id: "cursor",
      label: "Cursor",
      installed: false,
      configPath: "/Users/test/.cursor/mcp.json",
      status: { kind: "notInstalled" },
      supportsStdio: true,
      supportsHttp: true,
      stdioSnippet: '{"mcpServers":{"vibevalley":{"command":"vibevalley","args":["mcp"]}}}',
      httpSnippet: '{"mcpServers":{"vibevalley":{"url":"http://127.0.0.1:8790/mcp"}}}',
    },
  ],
};

test("McpSettingsPage lists all 4 OAR hosts, switches transport, installs, uninstalls, and copies snippet", async () => {
  setLocale("en");
  let hosts: McpHostInfo[] = sampleList.hosts.map((h) => ({ ...h }));

  const fake = fakeHost(scenarios.typical, { route: "/settings/mcp", locale: "en" });
  fake.respond("runtime.mcp.list", () => ({ ...sampleList, hosts }));
  fake.respond("runtime.mcp.install", (payload: unknown) => {
    const input = payload as { host: McpHostInfo["id"]; transport?: "stdio" | "streamableHttp" };
    const nextTransport = input.transport ?? "stdio";
    hosts = hosts.map((h) => (h.id === input.host ? { ...h, status: { kind: "installed", transport: nextTransport } } : h));
    const found = hosts.find((h) => h.id === input.host);
    if (!found) throw new Error("missing host");
    return found;
  });
  fake.respond("runtime.mcp.uninstall", (payload: unknown) => {
    const input = payload as { host: McpHostInfo["id"] };
    hosts = hosts.map((h) => (h.id === input.host ? { ...h, status: { kind: "notInstalled" } } : h));
    const found = hosts.find((h) => h.id === input.host);
    if (!found) throw new Error("missing host");
    return found;
  });

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:mcp-host-antigravity") === 1);
  expect(app.count("id:mcp-host-claude")).toBe(1);
  expect(app.count("id:mcp-host-codex")).toBe(1);
  expect(app.count("id:mcp-host-cursor")).toBe(1);
  expect(app.shows("id:mcp-status-antigravity >> text:Not installed")).toBe(true);
  expect(app.shows("id:mcp-status-claude >> text:Installed (stdio)")).toBe(true);
  expect(app.shows("id:mcp-status-codex >> text:Outdated (stdio)")).toBe(true);

  await app.press("id:mcp-transport-streamableHttp");
  await fake.pumpUntil(app, () => app.texts().some((line) => line.includes("serverUrl")));
  expect(app.texts().some((line) => line.includes("http://127.0.0.1:8790/mcp"))).toBe(true);

  await app.press("id:mcp-install-antigravity");
  await fake.pumpUntil(app, () => app.shows("id:mcp-status-antigravity >> text:Installed (streamableHttp)"));
  expect(fake.calls.find((c) => c.op === "runtime.mcp.install")?.payload).toEqual({
    host: "antigravity",
    transport: "streamableHttp",
  });

  await app.press("id:mcp-uninstall-claude");
  await fake.pumpUntil(app, () => app.shows("id:mcp-status-claude >> text:Not installed"));
  expect(fake.calls.find((c) => c.op === "runtime.mcp.uninstall")?.payload).toEqual({ host: "claude" });

  await app.press("id:mcp-copy-codex");
  await app.waitUntil(() => (app.clipboard() ?? "").includes("http://127.0.0.1:8790/mcp"));
});
