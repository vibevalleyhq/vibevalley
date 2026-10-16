// Ported from packages/core/src/session.ts: how long a command waits for the call to come up (CONNECT_WAIT_MS).

/// How long a sentence waits for the call (the day) to come up before it is dropped.
const connectWait = Duration(seconds: 20);
