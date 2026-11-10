# @vibevalley/home

A farm's home on disk, as every program on this machine finds it: the server that uses it, the command line and the
desktop app. Node only; no network.

| What | Where |
|---|---|
| The home | `VIBEVALLEY_HOME`, else `~/.vibevalley`; a desktop channel's is `~/.vibevalley<suffix>` (`apps/desktop/src/channel.ts`) |
| Where its server listens | `server.json`: written by the server while it runs (`announce`), read by the command line (`announced`), which skips one whose process is gone |
| Its language | `settings.json`'s `locale` (the server's settings, `apps/server/src/setting`), read by the programs that speak before they reach the server (`savedLocale`) |
| The server the command line signed in to | `auth.json` (`0600`): its address, the device key and the device's id, written by `vibevalley auth login` (`keepSignIn`), read by every command after (`signedIn`), removed by `auth logout` (`forgetSignIn`) |
| The desktop app's socket | `desktop.sock` (`controlSocketOf`): the command line asks the app over it (`desktopControl`, `@vibevalley/protocol/host`) |

The server's own lock (`.vibevalley.lock`) stays in `apps/server/src/infra/lease.ts`: nothing else reads it.
