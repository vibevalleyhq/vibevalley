# @vibevalley/bridge

Calls between the page and the program around it (the desktop's Electron main, the phone's React Native shell), written
once as a contract and carried over any link ([the client](docs/subsystems/app.md)).
The contracts themselves are in `packages/protocol/src/host.ts`; the links are each host's own.

| Where | What |
|---|---|
| `src/index.ts` | `call({ input, output })` and `push(payload)` write a contract; `serve(contract, link, handlers)` answers its calls and sends its pushes; `connect(contract, link)` gives `call.<name>(input)` and `on(name, fn)`; `Link` and the messages on it |
| `src/testing.ts` | `linkPair()`: two links joined in memory, through JSON |

- The answering side decodes each input by its call's Schema before the handler runs; one that does not decode is refused,
  and the caller gets a `BridgeError` with the reason. Outputs and pushes are encoded going out and decoded coming in.
- `handlers` must have one function for each call: a call left out does not compile.
- After `close`, nothing more is answered or heard, and the asking side rejects what was still unanswered.

```bash
vp run test    # vitest: answers, refusals, pushes, closing
```
