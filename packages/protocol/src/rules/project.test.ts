import { expect, test } from "vite-plus/test";

import { githubRepository } from "./project";

test("a GitHub repository's home URL, and nothing else that could reach git", () => {
  expect(githubRepository(" https://github.com/botiverse/raft-source.git/ ")).toEqual({
    name: "raft-source",
    url: "https://github.com/botiverse/raft-source.git",
  });
  for (const input of [
    "file:///tmp/repo",
    "git@github.com:a/b.git",
    "https://github.com.evil/x/y",
    "https://u:secret@github.com/x/y",
    "https://github.com/x/y/tree/main",
    "--upload-pack=bad",
    "https://github.com/x/..",
  ])
    expect(githubRepository(input)).toBeUndefined();
});
