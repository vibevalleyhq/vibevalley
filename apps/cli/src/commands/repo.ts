import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { show } from "#/base/format.ts";
import { arg, command, group, opt } from "#/infra/command.ts";
import { ask, change } from "#/infra/farm.ts";

const repoLine = (p: T.RepoSummary) => [p.name, p.path, p.git ? "git" : "", p.pullRequest.available ? "pr" : ""].filter((x) => x !== "").join("  ");

export const repoCommand = group("repo", t("cli.group.repo.about"), [
  group("pr", t("cli.repo.publish"), [
    command("submit", {
      about: t("cli.repo.publish"),
      examples: [
        {
          command: "vibevalley repo pr submit --cwd /path/to/repo --branch feat/topic --sha <full-sha> --base main --title <title> --body <body> --dry-run",
          description: t("cli.repo.publish"),
        },
      ],
      params: {
        cwd: opt.required("cwd"),
        branch: opt.required("branch"),
        sha: opt.required("sha"),
        base: opt.required("base"),
        title: opt.required("title"),
        body: opt.required("body"),
      },
      run: async (o, ctx) => {
        const result = await ask(ctx, (api) => api.repo.pr.submit({ ...o, dryRun: ctx.flags.dryRun }));
        show(ctx, result, (r) =>
          r.url ? r.url + "\n" + t("cli.repo.check", { check: r.check }) : t("cli.repo.preview", { branch: r.branch, sha: r.sha, base: r.base }),
        );
      },
    }),
  ]),
  command("list", {
    about: t("cli.command.repo.list"),
    examples: [{ command: "vibevalley repo list", description: t("cli.example.repoList.about") }],
    run: async (_, ctx) => show(ctx, await ask(ctx, (api) => api.repo.list()), (ps) => ps.map(repoLine).join("\n")),
  }),
  command("create", {
    about: t("cli.command.repo.create"),
    examples: [{ command: "vibevalley repo create web --repo https://github.com/me/web", description: t("cli.example.repoCreate.about") }],
    params: { name: arg.text("name", "cli.arg.repoName"), repo: opt.text("repo", "cli.flag.repo") },
    run: (o, ctx) => {
      const github = o.repo;
      return change(ctx, {
        name: "repo create",
        does: (api) => api.repo.create({ name: o.name, ...(github === undefined ? {} : { github }) }),
        said: (p) => repoLine(p),
      });
    },
  }),
]);
