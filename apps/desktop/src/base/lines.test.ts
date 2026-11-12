import { PassThrough } from "node:stream";

import { expect, test } from "vite-plus/test";
import { z } from "zod";

import { jsonLines } from "./lines";

test("each line that is one value of the Schema is heard; every line goes to the log first", async () => {
  const input = new PassThrough();
  const heard: string[] = [];
  const logged: string[] = [];
  const ended = new Promise((resolve) => input.on("end", resolve));
  jsonLines(
    input,
    z.object({ url: z.string() }),
    ({ url }) => heard.push(url),
    (line) => logged.push(line),
  );
  input.end(["starting", '{"url":"http://127.0.0.1:1/"}', '{"url":2}', "[1,", '{"url":"http://a","extra":true}'].join("\n") + "\n");
  await ended;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(heard).toEqual(["http://127.0.0.1:1/", "http://a"]);
  expect(logged).toHaveLength(5);
});
