import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { ArtifactId } from "@vibevalley/protocol/schema";

import { show } from "#/base/format.ts";
import { arg, command, group, opt } from "#/infra/command.ts";
import { ask } from "#/infra/farm.ts";

const artifactLine = (a: T.Artifact) =>
  [a.id, a.title, a.body, `@${a.byName}`, a.issue === undefined ? "" : `issue ${a.issue}`].filter((x) => x !== "").join("  ");
const artifactArg = arg.decoded("artifact", ArtifactId, "cli.arg.artifact");

export const artifactCommand = group("artifact", t("cli.group.artifact.about"), [
  command("list", {
    about: t("cli.command.artifact.list"),
    examples: [{ command: "vibevalley artifact list --issue 12", description: t("cli.example.artifactList.about") }],
    params: { issue: opt.text("issue", "cli.flag.issue") },
    run: async (o, ctx) => {
      const issue = o.issue;
      const all = await ask(ctx, (api) => api.artifact.list(issue ? { issue: issue.replace(/^#/u, "") } : {}));
      show(ctx, all, (as) => as.map(artifactLine).join("\n"));
    },
  }),
  command("show", {
    about: t("cli.command.artifact.show"),
    examples: [{ command: "vibevalley artifact show a1", description: t("cli.example.artifactShow.about") }],
    params: { artifact: artifactArg },
    run: async (o, ctx) => show(ctx, await ask(ctx, (api) => api.artifact.get({ id: o.artifact })), artifactLine),
  }),
  command("read", {
    about: t("cli.command.artifact.read"),
    examples: [{ command: "vibevalley artifact read a1", description: t("cli.example.artifactRead.about") }],
    params: { artifact: artifactArg },
    run: async (o, ctx) => show(ctx, await ask(ctx, (api) => api.artifact.content.get({ id: o.artifact })), (x) => x.content),
  }),
]);
