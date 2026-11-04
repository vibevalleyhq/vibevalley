# apps/cli

`vibevalley`, the command line: for the agents on this machine first (Claude Code, Codex, the helpers) and for people
too. One command is one thing to do with the farm, typed with effect/cli and asking the server through the generated
`VibeValleyApi`; it loads none of the server. How it reads and why: [development](docs/development.md#只用命令行派一个活),
[the core](docs/subsystems/core.md).

```
src/main.ts        the root: the groups below, the global flags (--server, --dry-run, --format), how help and failures are said
src/farm.ts        what every task command stands on: ask (the typed client), show (text or --format json), change (--dry-run),
                   pick (a thing by its name)
src/issue.ts       issue list|show|new|edit|work|say|answer|accept|reject|stop|cancel|reopen|diff|log
src/channel.ts     channel list|read|say|search
src/pkm.ts         the notes: pkm capture|today|search|radar|page list|get|edit
src/project.ts     project, agent, session, runtime list|refresh
src/notes.ts       memory, cron, artifact
src/app.ts         the desktop app's own abilities, over its socket in the farm's home (@vibevalley/home)
src/doctor.ts      this machine's farm: found, reachable, the app, the runtimes, the keys, connecting to this machine
src/api.ts         every endpoint as it is: api list (with its input's JSON Schema), api call <op>, api state, api events
src/reach.ts       which command reaches each endpoint, or only api (a Record over every op: a new one does not compile without it)
src/chat.ts        `vibevalley` alone and `runtime chat`: the server's conversation program, handed this terminal (VIBEVALLEY_CHAT)
src/guide/         `vibevalley guide`, per language
src/output.ts      stdout for the result, the failure as one JSON line on stderr, exit codes by kind
src/testing.ts     a run in the process against a whole farm (@vibevalley/server/testing)
src/testdata/      the golden answers: help, typical mistakes, refusals and dry runs (vp run golden:update cli)
```

## Rules

- **A command is a thing to do, not an endpoint.** A new endpoint gets a line in `reach.ts`: the command that uses it,
  or `api`.
- **Text first, the protocol's shape with `--format json`.** A line leads with the name to use next (`#12`, `#general`).
- **Every command has a description and an example** (`main.test.ts` holds it); the words are in
  `packages/i18n/locales/<lang>/cli.json`.
- **Nothing of the server is imported** but its test farm in the tests: what the server knows is asked over HTTP, and
  the home's files are `@vibevalley/home`'s.
- Run it from the repository with `vp run --filter @vibevalley/cli start <command…>`; the desktop app bundles it
  (`vp pack`, dist/) with its guide beside it (src/assets.ts) and installs it as `vibevalley` (`-beta`, `-alpha`).
