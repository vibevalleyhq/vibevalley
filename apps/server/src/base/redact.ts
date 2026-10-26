// Secrets as they show up in free text: a token by its own shape, or the value after a
// name that says it is one. The server's log (redactOutput) and whatever memory sends outside the farm both go through
// redact.

const shapes = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // The farm's own session tokens (session/tokens.ts).
  /\bhb_[A-Za-z0-9]+_[A-Za-z0-9_-]{16,}/g,
];

// The name and what joins it stay, so what was there can still be read: api_key=[redacted], "token": "[redacted]".
const bearer = /(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const named = /(\b[a-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|certificate)[a-z0-9_]*["']?\s*[=:]\s*["']?)([^\s"',;]{6,})/gi;

const redacted = "[redacted]";

export function redact(text: string): string {
  for (const shape of shapes) text = text.replace(shape, redacted);
  text = text.replace(bearer, `$1${redacted}`);
  return text.replace(named, (m, name: string, value: string) => (value === redacted ? m : name + redacted));
}

/** Everything the process writes to stream goes through redact first: the server's log, and what a library prints. A
 * secret split across two writes gets through; console writes a line at a time. */
export function redactOutput(stream: NodeJS.WriteStream) {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = (chunk: unknown, ...rest: unknown[]) =>
    write(typeof chunk === "string" ? redact(chunk) : chunk instanceof Uint8Array ? redact(Buffer.from(chunk).toString("utf8")) : chunk, ...rest);
}
