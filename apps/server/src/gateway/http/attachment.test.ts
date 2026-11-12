import { describe, expect, test } from "vite-plus/test";

import { attachmentPath } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { app } from "#/testing/http.ts";
import { testConfig } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";

describe("an attachment", () => {
  test("is read back by GET at its path, as what it is, and nothing else is", async () => {
    await using served = await app(testConfig(), 0, undefined, quietApp);
    const { address } = served;
    const files = served.farm.attachment;
    const png = await files.attach({ name: "看这里.png", type: "image/png", data: Buffer.from("not really a png").toString("base64") });
    // The test reads the server as a browser does, through the platform's own fetch.
    const get = (path: string) => fetch(`http://${address}${path}`);
    const res = await get(attachmentPath(png.id));
    expect([res.status, res.headers.get("content-type"), res.headers.get("content-disposition")]).toEqual([
      200,
      "image/png",
      `inline; filename*=UTF-8''${encodeURIComponent("看这里.png")}`,
    ]);
    const text2 = await res.text();
    expect(text2).toBe("not really a png");
    const disposition = (r: Response) => [r.headers.get("content-disposition")?.split(";")[0], r.headers.get("content-security-policy")];
    const pdf = await files.attach({ name: "a.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64") });
    const zip = await files.attach({ name: "a.zip", type: "application/zip", data: Buffer.from("PK").toString("base64") });
    const mp4 = await files.attach({ name: "a.mp4", type: "video/mp4", data: Buffer.from("mp4").toString("base64") });
    const found = await get(attachmentPath(pdf.id));
    expect(disposition(found)).toEqual(["inline", null]);
    const found2 = await get(attachmentPath(mp4.id));
    expect(disposition(found2)).toEqual(["inline", "sandbox"]);
    const found3 = await get(attachmentPath(zip.id));
    expect(disposition(found3)).toEqual(["attachment", "sandbox"]);
    expect((await get(attachmentPath("0".repeat(64)))).status).toBe(404);
    expect((await get(attachmentPath("../vibevalley.yaml"))).status).toBe(404);
    const big = await files
      .attach({ name: "big", type: "application/zip", data: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64") })
      .catch((e: unknown) => e);
    expect(big).toMatchObject({ name: "ApiError", bizCode: BizCode.AttachmentRefused });
  });
});
