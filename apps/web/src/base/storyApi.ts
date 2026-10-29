// Installed by the stories' page only (src/stories.tsx); the product never imports it.

type Answer = (input: unknown) => unknown;

let answers: Readonly<Record<string, Answer>> = {};

/**
 * What the server answers while this story is open, by the path after /api/v1/ ("issue/diff/get"). Unanswered calls
 * fail as a server that is not there would; a stream stays open with nothing on it.
 */
export function answer(table: Readonly<Record<string, Answer>>) {
  answers = table;
}

export function fakeFetch(real: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith("/api/v1/")) return real(input, init);
    if (new Headers(init?.headers).get("accept") === "text/event-stream") return new Response(new ReadableStream(), { status: 200 });
    const path = url.pathname.slice("/api/v1/".length);
    const at = answers[path];
    if (!at) return Response.json({ reason: `stories: ${path} is not answered here` }, { status: 503 });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const value = await at(body);
    return value === undefined ? new Response("", { status: 200 }) : Response.json(value);
  };
}
