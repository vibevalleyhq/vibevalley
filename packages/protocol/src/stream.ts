// Reads one of the server's SSE streams (statePath, eventsPath, livePath) with fetch rather than EventSource: a host may
// serve the page under a scheme EventSource does not take, and fetch lets the caller pass its own.

/** Calls onEvent with each `data:` payload, decoded, until signal aborts or the stream ends (then it rejects). */
export async function readStream<T>(
  url: string,
  onEvent: (event: T) => void,
  signal: AbortSignal,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<never> {
  const res = await fetcher(url, { headers: { Accept: "text/event-stream" }, signal });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`${url}: ended`);
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      buffer = buffer.slice(end + 2);
      if (data) onEvent(JSON.parse(data) as T);
    }
  }
}
