import { describe, expect, test } from "vite-plus/test";

import { starterEntriesForType } from "@vibevalley/artifact/starters";
import { setLocale } from "@vibevalley/i18n";
import { ArtifactTypeValues, userId } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { messageLine } from "#/modules/session/prompts.ts";
import { world } from "#/testing/world.ts";

const user = { from: userId, by: userId };

describe("structured artifact types and entry store", () => {
  test("lists all 7 artifact types and serves progressive-disclosure guides in zh and en", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;

    try {
      setLocale("zh");
      const listedZh = await artifacts.listTypes();
      expect(listedZh.map((x) => x.type)).toEqual([...ArtifactTypeValues]);
      expect(listedZh.find((x) => x.type === "slides")?.references).toEqual(["craft", "format", "layout"]);
      expect(listedZh.find((x) => x.type === "dashboard")?.references).toEqual(["design-defaults", "features"]);

      for (const type of ArtifactTypeValues) {
        const guide = await artifacts.readType({ type });
        expect(guide.type).toBe(type);
        expect(guide.content.length).toBeGreaterThan(80);
      }

      const craftZh = await artifacts.readType({ type: "slides", reference: "craft" });
      expect(craftZh.reference).toBe("craft");
      expect(craftZh.content).toContain("tabular-nums");

      setLocale("en");
      const guideEn = await artifacts.readType({ type: "whiteboard" });
      expect(guideEn.content).toContain("elements/");
      expect(/[\p{Script=Han}]/u.test(guideEn.content)).toBe(false);

      const badRef = await artifacts.readType({ type: "slides", reference: "nonexistent" }).catch((e: unknown) => e);
      expect(badRef).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    } finally {
      setLocale("zh");
    }
  });

  test("creates all 7 artifact types, filters by artifactType, and summarizes store entries", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;

    const docs = await artifacts.create(user, { title: "架构纪要", artifactType: "docs", content: "# 目标\n\n保持清晰。" });
    expect(docs).toMatchObject({ body: "blocks", artifactType: "docs", isDefault: false });

    for (const type of ["slides", "dashboard", "motion", "whiteboard", "design", "design-system"] as const) {
      const made = await artifacts.create(user, {
        title: `样例-${type}`,
        artifactType: type,
        entries: starterEntriesForType(type, `样例-${type}`),
      });
      expect(made).toMatchObject({ body: "store", artifactType: type, seq: 1, isDefault: false });
      const summary = await artifacts.content(made.id);
      expect(summary.body).toBe("store");
      expect(summary.content).toContain(`type: ${type}`);
    }

    const onlyDashboards = await artifacts.list({ artifactType: "dashboard" });
    expect(onlyDashboards.map((a) => a.artifactType)).toEqual(["dashboard"]);
  });

  test("executes set, patch, copy, delete atomically with ifRev optimistic concurrency and sanitizes inputs", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;

    const png = await farm.attachment.keep(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "logo.png", "image/png");
    const board = await artifacts.create(user, {
      title: "系统拓扑",
      artifactType: "whiteboard",
      entries: [
        { op: "set", path: "board/meta", kind: "json", value: JSON.stringify({ title: "系统拓扑", background: "dots" }) },
        {
          op: "set",
          path: "elements/api",
          kind: "json",
          value: JSON.stringify({ id: "api", type: "shape", shape: "rect", x: 100, y: 120, w: 180, h: 80, label: "Gateway" }),
        },
      ],
    });
    expect(board.seq).toBe(1);

    const batch2 = await artifacts.batchEntries(user, {
      id: board.id,
      writes: [
        { op: "patch", path: "elements/api", ifRev: 1, value: JSON.stringify({ x: 240, label: null, note: "Moved" }) },
        { op: "copy", from: "elements/api", path: "elements/api-copy" },
        { op: "set", path: "assets/logo.png", kind: "asset", value: png.id },
        {
          op: "set",
          path: "elements/diagram",
          kind: "json",
          value: JSON.stringify({
            id: "diagram",
            type: "svg",
            x: 40,
            y: 40,
            w: 200,
            h: 120,
            svg: '<svg viewBox="0 0 100 100" onload="evil()"><script>alert(1)</script><rect width="80" height="40"/></svg>',
          }),
        },
      ],
    });
    expect(batch2.seq).toBe(2);

    const apiEntry = await artifacts.getEntry({ id: board.id, path: "elements/api" });
    expect(apiEntry.rev).toBe(2);
    expect(JSON.parse(apiEntry.value ?? "{}")).toMatchObject({ id: "api", x: 240, y: 120, note: "Moved" });
    expect(JSON.parse(apiEntry.value ?? "{}")).not.toHaveProperty("label");

    const copied = await artifacts.getEntry({ id: board.id, path: "elements/api-copy" });
    expect(JSON.parse(copied.value ?? "{}")).toMatchObject({ x: 240, note: "Moved" });

    const assetEntry = await artifacts.getEntry({ id: board.id, path: "assets/logo.png" });
    expect(assetEntry).toMatchObject({ kind: "asset", attachmentId: png.id, mime: "image/png" });

    const svgEntry = await artifacts.getEntry({ id: board.id, path: "elements/diagram" });
    expect(svgEntry.value).not.toContain("<script");
    expect(svgEntry.value).not.toContain("onload");

    const conflict = await artifacts.batchEntries(user, {
      id: board.id,
      writes: [
        { op: "set", path: "elements/should-not-exist", kind: "json", value: JSON.stringify({ id: "x", type: "text", x: 0, y: 0, text: "no" }) },
        { op: "patch", path: "elements/api", ifRev: 1, value: JSON.stringify({ x: 999 }) },
      ],
    });
    expect(conflict).toMatchObject({
      applied: false,
      seq: 2,
      conflicts: [expect.objectContaining({ path: "elements/api", expectedRev: 1, actualRev: 2 })],
    });

    const afterConflict = await artifacts.listEntries({ id: board.id, includeValues: false });
    expect(afterConflict.seq).toBe(2);
    expect(afterConflict.entries.some((e) => e.path === "elements/should-not-exist")).toBe(false);

    const batch3 = await artifacts.batchEntries(user, {
      id: board.id,
      writes: [{ op: "delete", path: "elements/api-copy", ifRev: 1 }],
    });
    expect(batch3.seq).toBe(3);
    expect(batch3.applied).toBe(true);
    const afterDelete = await artifacts.listEntries({ id: board.id, includeValues: false });
    expect(afterDelete.entries.some((e) => e.path === "elements/api-copy")).toBe(false);

    for (const badWrite of [
      { op: "set" as const, path: "../escape.json", value: "{}" },
      { op: "set" as const, path: "elements/bad", kind: "json" as const, value: "{not-json" },
      { op: "set" as const, path: "project/slides/01.html", value: '<script src="https://evil.example/x.js"></script><p>hi</p>' },
      { op: "set" as const, path: "assets/missing.png", kind: "asset" as const, value: "missing-attachment-id" },
    ]) {
      const err = await artifacts.batchEntries(user, { id: board.id, writes: [badWrite] }).catch((e: unknown) => e);
      expect(err).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    }
  });

  test("maintains a single standing default design-system and injects its CSS tokens into rendered views", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;

    const nonDsDefault = await artifacts.create(user, { title: "不是设计体系", artifactType: "slides", isDefault: true }).catch((e: unknown) => e);
    expect(nonDsDefault).toMatchObject({ bizCode: BizCode.ArtifactRefused });

    const ds1 = await artifacts.create(user, {
      title: "田野体系一",
      artifactType: "design-system",
      isDefault: true,
      entries: [
        {
          op: "set",
          path: "project/tokens.json",
          kind: "json",
          value: JSON.stringify({
            color: [{ id: "brand-primary", value: { light: "#2f6f4e", dark: "#58b383" } }],
          }),
        },
      ],
    });
    expect(ds1.isDefault).toBe(true);
    expect((await artifacts.readType({ type: "slides" })).defaultArtifactId).toBe(ds1.id);

    const ds2 = await artifacts.create(user, {
      title: "田野体系二",
      artifactType: "design-system",
      isDefault: true,
      entries: [
        {
          op: "set",
          path: "project/tokens.json",
          kind: "json",
          value: JSON.stringify({
            color: [{ id: "brand-primary", value: { light: "#b85d19", dark: "#f0944d" } }],
          }),
        },
      ],
    });
    expect(ds2.isDefault).toBe(true);
    expect((await artifacts.get(ds1.id)).isDefault).toBe(false);

    const deck = await artifacts.create(
      { from: userId, by: "fox" },
      {
        title: "季度汇报",
        artifactType: "slides",
        entries: starterEntriesForType("slides", "季度汇报"),
        note: "初稿完成",
      },
    );
    const lastMessage = (await farm.channel.history(farm.channel.defaultChannel())).at(-1);
    expect(lastMessage?.artifact).toMatchObject({
      id: deck.id,
      body: "store",
      artifactType: "slides",
      version: 1,
      note: "初稿完成",
    });

    const viewNormal = await artifacts.renderView(deck.id, { theme: "dark", origin: "http://127.0.0.1:8787" });
    expect(viewNormal.html).toContain("--color-brand-primary:#f0944d;");
    expect(viewNormal.headers["content-security-policy"]).toContain("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;");
    expect(viewNormal.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(viewNormal.headers["content-security-policy"]).toContain("connect-src 'none'");

    const viewPrint = await artifacts.renderView(deck.id, { theme: "light", print: true, origin: "http://127.0.0.1:8787" });
    expect(viewPrint.headers["content-security-policy"]).toContain("allow-modals;");
  });

  test("streams entry changes over followEntries and fences <artifact-view-context> on channel messages", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;

    const dash = await artifacts.create(user, {
      title: "营收看板",
      artifactType: "dashboard",
      entries: starterEntriesForType("dashboard", "营收看板"),
    });

    const abort = new AbortController();
    const stream = artifacts.followEntries(dash.id, 0, abort.signal)[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.value).toMatchObject({ _tag: "Entries", seq: 1 });

    const nextPromise = stream.next();
    await artifacts.batchEntries(user, {
      id: dash.id,
      writes: [{ op: "patch", path: "dash/params", value: JSON.stringify({ region: "CN" }) }],
    });
    const second = await nextPromise;
    expect(second.value).toMatchObject({ _tag: "Entries", seq: 2 });
    abort.abort();
    await stream.return?.();

    const general = farm.channel.defaultChannel();
    await farm.channel.say({
      channel: general,
      text: "帮我把第三页改成架构图",
      sendKey: "view-ctx-1",
      viewContext: {
        artifactId: dash.id,
        artifactType: "slides",
        title: "季度汇报",
        slideId: "s03",
        slideIndex: 2,
      },
    });
    const readBack = await farm.channel.read(userId, { target: "" });
    const latest = readBack.messages.at(-1);
    expect(latest?.viewContext).toMatchObject({ artifactId: dash.id, slideId: "s03", slideIndex: 2 });
    const line = messageLine(latest!);
    expect(line).toContain("<artifact-view-context>");
    expect(line).toContain('"slideId":"s03"');
    expect(line).toContain("</artifact-view-context>");
  });
});
