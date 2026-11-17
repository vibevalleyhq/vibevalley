# @vibevalley/home

A farm's home on disk, as the Node scripts and Go tools on this machine find it. Node only; no network.

| What | Where |
|---|---|
| The home | `VIBEVALLEY_HOME`, else `~/.vibevalley` |
| Where its server listens | `server.json`: written by `vibe-server` while it runs, read by the CLI (`vibe`) and scripts (`announced`), which skip one whose process is gone |
| Its language | `settings.json`'s `locale`, read by programs that speak before reaching the server (`savedLocale`) |
| The server the CLI signed in to | `auth.json` (`0600`): its address, the device key and the device's id, written on login (`keepSignIn`), read by subsequent calls (`signedIn`), removed on logout (`forgetSignIn`) |
