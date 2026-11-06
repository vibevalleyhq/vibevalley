import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { cli, farm } from "./testing.ts";

const json = (text: string): unknown => JSON.parse(text);

describe("the hand-written commands", () => {
  it.live("note, read, search and edit the notes as Markdown, the endpoint's JSON with --format json", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const at = (...args: string[]) => [...args, "--server", server];
      expect((yield* cli(at("pkm", "page", "save", "Garden"), "- bulbs\n")).code).toBe(0);

      const noted = yield* cli(at("pkm", "capture", "--page", "Garden"), "tomatoes\n  basil\n");
      expect([noted.code, noted.out]).toEqual([0, "记进了「Garden」"]);
      const today = yield* cli(at("pkm", "capture", "call", "the", "vet"));
      expect(today.code).toBe(0);
      const journal = yield* cli(at("pkm", "journal", "show"));
      expect(journal.out).toContain("call the vet #inbox");

      // Shown as its outline; exported for people, the title on top and a top block with blocks under it as a heading.
      expect((yield* cli(at("pkm", "page", "show", "garden"))).out).toBe("# Garden\n\n- bulbs\n- tomatoes\n  - basil");
      const page = yield* cli(at("pkm", "page", "export", "garden"));
      expect(page.out).toBe("# Garden\n\n- bulbs\n### tomatoes\n\n- basil");
      const asJson = yield* cli(at("pkm", "page", "show", "garden", "--format", "json"));
      expect(json(asJson.out)).toMatchObject({ page: { slug: "garden" } });

      const found = yield* cli(at("pkm", "search", "basil"));
      expect(found.out).toBe("Garden › tomatoes: basil");

      // The editor is a command line that the file is added to, as $EDITOR is.
      const edited = yield* cli(at("pkm", "page", "edit", "Garden"), "", { EDITOR: "perl -pi -e 's/bulbs/bulbs and soil/'" });
      expect([edited.code, edited.out]).toEqual([0, "存好了「Garden」"]);
      expect((yield* cli(at("pkm", "page", "export", "garden"))).out).toBe("# Garden\n\n- bulbs and soil\n### tomatoes\n\n- basil");

      // A page that is not there names the closest.
      const wrong = yield* cli(at("pkm", "capture", "--page", "Gardens", "x"));
      expect([wrong.code, wrong.failure?.tag]).toEqual([4, "Missing"]);
      expect(wrong.failure?.message).toContain("Garden");
    }),
  );

  it.live("doctor says each part of the farm, and app says there is no desktop app to ask", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const doctor = yield* cli(["doctor", "--server", server], "", { VIBEVALLEY_HOME: "/nonexistent-home" });
      const checks = json(doctor.out) as { check: string; ok: boolean }[];
      expect(checks.map((c) => c.check)).toEqual(["farm", "server", "app", "runtimes", "model", "lan"]);
      expect(checks.find((c) => c.check === "app")).toMatchObject({ ok: true, open: false });

      const app = yield* cli(["app", "status"], "", { VIBEVALLEY_HOME: "/nonexistent-home" });
      expect([app.code, app.failure?.tag]).toEqual([5, "AppNotOpen"]);

      const gone = yield* cli(["doctor", "--server", "http://127.0.0.1:9"]);
      expect(gone.code).toBe(5);
      expect((json(gone.out) as { check: string; ok: boolean }[]).map((c) => [c.check, c.ok])).toEqual([
        ["farm", true],
        ["server", false],
      ]);
    }),
  );
});
