import { expect, test } from "vite-plus/test";

import { BizCode } from "@vibevalley/protocol/api";

import { keptLog } from "#/infra/log.ts";
import { png } from "#/modules/media/testdata/png.ts";
import { makeAttachment } from "#/platform/attachment/attachment.ts";
import { makeProvider } from "#/platform/provider/provider.ts";
import { makeSetting } from "#/platform/setting/setting.ts";
import { testConfig, testDb } from "#/testing/layers.ts";
import * as q from "#db/media_remote_file.sql.ts";

import { makeInputs } from "./inputs.ts";
import { makeRemoteFiles } from "./remoteFiles.ts";
import { heldTime, never, vendor } from "./testing.ts";

const notIn = (value: unknown, secret: string) => {
  expect(JSON.stringify(value)).not.toContain(secret);
};
const failure = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable("it was not refused"),
    (e: unknown) => e,
  );
async function* chunks(...parts: readonly Uint8Array[]) {
  for (const part of parts) yield part;
}

const key = "isolated-test-key";
const bytes = png();
const uploaded = { id: "file-one", object: "file", bytes: bytes.length, created_at: 1, filename: "accepted.png", purpose: "image", status: "processed" };

/** The library, a Provider whose accounts' calls go to the given vendor, and an input task-a holds; remote files over them. */
const fixture = async (http: typeof fetch) => {
  const config = testConfig();
  const db = await testDb(config);
  const held = heldTime();
  const log = keptLog();
  const attachment = await makeAttachment({ config, clock: held.time, db });
  const setting = await makeSetting({ config, clock: held.time, log });
  const provider = await makeProvider({ setting, fetch: http, clock: held.time, log });
  const inputs = makeInputs({ db, clock: held.time, log, attachment });
  const input = await inputs.create({ kind: "image", mime: "image/png", name: "private-user-filename.png", size: bytes.length });
  await inputs.upload(input.id, chunks(bytes));
  await inputs.pin([input.id], "task-a", async () => undefined);
  await provider.update({
    revision: 0,
    connections: [{ id: "moss-a", name: "MOSS", adapter: "moss", enabled: true, key }],
    dictation: null,
    image: null,
    understanding: null,
    speech: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
    live: null,
  });
  /** The account a task binds. */
  const account = await provider.account({ connection: "moss-a", model: "moss-vl-1.0" });
  const make = () => makeRemoteFiles({ db, clock: held.time, log }, inputs);
  return {
    db,
    clock: held.time,
    adjust: held.adjust,
    input,
    account,
    remote: make(),
    make,
    [Symbol.asyncDispose]: async () => {
      await setting.close();
      await db.close();
    },
  };
};

test("a real disk-backed input is uploaded once, recorded without its key, and explicitly cleaned", async () => {
  const calls: string[] = [];
  const http = vendor(async (request) => {
    calls.push(request.method);
    expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
    if (request.method === "POST") {
      // oxlint-disable-next-line typescript/no-deprecated -- a test reading back the multipart body the vendor would get
      const file = (await request.formData()).get("file");
      if (!(file instanceof File)) throw new Error("Expected disk-backed file");
      expect(file.name).toMatch(/^vv-[0-9a-f-]+\.png$/u);
      expect(file.name).not.toContain("private-user");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
      return Response.json({ ...uploaded, filename: file.name });
    }
    return Response.json({ id: "file-one", object: "file", deleted: true });
  });
  await using f = await fixture(http);
  const { remote, input, account } = f;
  expect(await Promise.all([remote.upload("task-a", input.id, account), remote.upload("task-a", input.id, account)])).toEqual(["file-one", "file-one"]);
  expect(await remote.upload("task-a", input.id, account)).toBe("file-one");
  const rows = await remote.list("task-a");
  expect(rows).toHaveLength(1);
  notIn(rows, key);
  expect(rows[0]).toMatchObject({ phase: "ready", remote_id: "file-one", revision: 1 });
  await remote.remove("task-a", input.id, { ...account, revision: 2 });
  await remote.remove("task-a", input.id, account);
  expect(calls).toEqual(["POST", "DELETE"]);
  expect(await failure(remote.upload("task-a", input.id, account))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect((await remote.list("task-a"))[0]?.phase).toBe("deleted");
});

test.each([400, 503])("an upload returning %s is never resubmitted, including after restart", async (status) => {
  let calls = 0;
  const http = vendor(() => {
    calls++;
    return Response.json({ error: "private response" }, { status });
  });
  await using f = await fixture(http);
  const { remote, input, account } = f;
  const error = await failure(remote.upload("task-a", input.id, account));
  notIn(error, "private response");
  const restarted = f.make();
  await restarted.restore();
  expect(await failure(restarted.upload("task-a", input.id, account))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect((await restarted.list("task-a"))[0]?.phase).toBe(status === 400 ? "rejected" : "unknown");
  if (status === 400) await restarted.remove("task-a", input.id, account);
  else expect(await failure(restarted.remove("task-a", input.id, account))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(calls).toBe(1);
});

test.each(["cancel", "timeout"])("regression: %s during remote upload records an unknown result", async (action) => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  let calls = 0;
  const http = vendor((request) => {
    calls++;
    start();
    return never(request.signal);
  });
  await using f = await fixture(http);
  const { remote, input, account } = f;
  const stop = new AbortController();
  const upload = failure(remote.upload("task-a", input.id, account, stop.signal));
  await started;
  if (action === "cancel") {
    stop.abort();
    await upload;
  } else {
    await f.adjust(300_000);
    expect(await upload).toMatchObject({ bizCode: BizCode.MediaRefused });
  }
  expect((await remote.list("task-a"))[0]?.phase).toBe("unknown");
  expect(await failure(remote.upload("task-a", input.id, account))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(calls).toBe(1);
});

test("a task without a retained input cannot upload another task's local file", async () => {
  const http = vendor(() => {
    throw new Error("Unretained input must not reach the network");
  });
  await using f = await fixture(http);
  const { remote, input, account } = f;
  expect(await failure(remote.upload("other-task", input.id, account))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await remote.list("other-task")).toEqual([]);
});

test("changed credentials or connection cannot access or delete a recorded upload", async () => {
  let calls = 0;
  const http = vendor(() => {
    calls++;
    return Response.json(uploaded);
  });
  await using f = await fixture(http);
  const { remote, input, account } = f;
  await remote.upload("task-a", input.id, account);
  for (const replacement of [
    { ...account, fingerprint: "another key's fingerprint" },
    { ...account, connection: "other-account" },
  ]) {
    await failure(remote.upload("task-a", input.id, replacement));
    await failure(remote.remove("task-a", input.id, replacement));
  }
  expect(await remote.upload("task-a", input.id, { ...account, revision: 42 })).toBe("file-one");
  expect(calls).toBe(1);
});

test("failed deletion persists its intent and an explicit retry accepts an already absent file", async () => {
  const calls: string[] = [];
  let deletion = 500;
  const http = vendor((request) => {
    calls.push(request.method);
    return request.method === "POST" ? Response.json(uploaded) : Response.json({}, { status: deletion });
  });
  await using f = await fixture(http);
  const { remote, input, account } = f;
  await remote.upload("task-a", input.id, account);
  await failure(remote.remove("task-a", input.id, account));
  expect((await remote.list("task-a"))[0]?.phase).toBe("deleting");
  const restarted = f.make();
  await restarted.restore();
  expect(calls).toEqual(["POST", "DELETE"]);
  deletion = 404;
  await restarted.remove("task-a", input.id, account);
  expect((await restarted.list("task-a"))[0]?.phase).toBe("deleted");
  expect(calls).toEqual(["POST", "DELETE", "DELETE"]);
});

test("startup marks an interrupted submission unknown without performing network requests", async () => {
  let calls = 0;
  const http = vendor(() => {
    calls++;
    return Response.json(uploaded);
  });
  await using f = await fixture(http);
  const { remote, input, account } = f;
  await remote.upload("task-a", input.id, account);
  const row = (await remote.list("task-a"))[0];
  if (!row) throw new Error("Missing fixture row");
  await q.changeRemoteFile(f.db.sql, { id: row.id, phase: "uploading", remote_id: null, now: f.clock.now() });
  const restarted = f.make();
  await restarted.restore();
  expect((await restarted.list("task-a"))[0]?.phase).toBe("unknown");
  await failure(restarted.upload("task-a", input.id, account));
  await failure(restarted.remove("task-a", input.id, account));
  expect(calls).toBe(1);
});
