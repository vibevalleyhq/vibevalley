# packages/provider

`@vibevalley/provider` owns vendor protocols and explicit connections. It does not read environment keys, runtime logins, application settings or conversation history. It does not depend on AI Core, the agent, the farm protocol or an app. Root lint enforces this direction.

| Export | Owner and boundary |
| --- | --- |
| `./transcription` | An explicit Effect-scoped `TranscriptionModelV4` factory for MOSS and configured OpenAI-compatible endpoints. Uses `@ai-sdk/provider@4.0.36`; accepts the endpoint, model, key and validated format. No retry, URL download or environment fallback. |
| `./moss` | Browser-safe tagged-v1 constants, frame Schema and PCM packing. No connection factory or key. |
| `./moss/server` | Server-only authenticated WebSocket transport and key probe. A key probe is an explicit caller action. |
| `./agora/captions` | Browser-safe RTC packet decoding and out-of-order chunk assembly. No application speakers or caption history. |
| `./agora/server` | Server-only Agora SDK client, RTC tokens and protocol errors. Uses the existing Clock-aware retry policy: 408, 429 and 5xx, twice. |

The transcription adapter retains `response_format=json`, `dictation.<format>`, the six accepted formats and the 120-second request-header timeout. The response body retains its separate failure channel. A scoped FiberSet bridges Core's Promise call to the caller's Effect services, so test clocks and interruption reach the HTTP client. The factory does not add a second fetch path.

The stock OpenAI adapter's verbose transcription format is not the existing compatible endpoint contract. This narrow adapter implements the upstream model interface rather than a parallel SDK. The result retains response headers, raw body and reported usage. Missing duration, language and timestamps stay unknown.

MOSS tagged-v1 and Agora hosted orchestration are not claimed to implement the experimental SDK realtime factory. Request IDs do not imply remote job lookup or cancellation support. The application owns `ask_orchestrator`, page relays, settings-to-vendor assembly and RTC devices.

Checks: `vp run --filter @vibevalley/provider test`; the server's voice tests cover the real transcription call through Core and the Agora call lifecycle. The package participates in `packages:build`, `server:check` and `effect:check`.
