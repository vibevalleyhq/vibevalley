import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lanDevices, addLanDevice, seenLanDevice } from "../../db/generated/lan_device.sql.ts";
import { lanOpen, setLanOpen } from "../../db/generated/lan.sql.ts";
import { testDatabase } from "../testing/layers.ts";

describe("the database", () => {
  it.effect("has the schema, and the generated queries run on it", () =>
    Effect.gen(function* () {
      yield* setLanOpen({ open: true });
      expect((yield* lanOpen()).open).toBe(true);
      yield* addLanDevice({ id: "d1", name: "手机", key_hash: "h", paired_at: 1_700_000_000_123 });
      yield* seenLanDevice({ last_seen: 1_700_000_000_456, id: "d1" });
      expect(yield* lanDevices()).toEqual([{ id: "d1", name: "手机", key_hash: "h", paired_at: 1_700_000_000_123, last_seen: 1_700_000_000_456 }]);
    }).pipe(Effect.provide(testDatabase())),
  );
});
