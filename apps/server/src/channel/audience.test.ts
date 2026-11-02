import { describe, expect, it } from "vite-plus/test";

import { Follows } from "./model.ts";

describe("channel follows", () => {
  it("loads and updates who follows each thread", () => {
    const follows = new Follows();
    follows.load([{ channel_id: "t", participant_id: "w3" }]);
    follows.followed("t", "w1");
    follows.followed("t", "w3");
    expect(follows.followers("t")).toEqual(["w1", "w3"]);
    expect(follows.followers("other")).toEqual([]);
  });

  it("forgets a session that left", () => {
    const follows = new Follows();
    follows.load([
      { channel_id: "t", participant_id: "w3" },
      { channel_id: "u", participant_id: "w3" },
      { channel_id: "u", participant_id: "w1" },
    ]);
    follows.left("w3");
    expect([follows.followers("t"), follows.followers("u")]).toEqual([[], ["w1"]]);
  });
});
