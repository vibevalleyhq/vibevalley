import { BizCode } from "@vibevalley/protocol/api";

type Answer = (input: unknown) => unknown;

let answers: Readonly<Record<string, Answer>> = {};

/** What the server answers while this story is open, by the path after /api/v1/ ("issue/diff/get"). Unanswered calls fail as a server that is not there would. */
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
    if (!at) return Response.json({ bizCode: BizCode.ServiceUnavailable, message: `stories: ${path} is not answered here` }, { status: 503 });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const value = await at(body);
    return Response.json(value === undefined ? { bizCode: 0, message: "ok" } : { bizCode: 0, message: "ok", data: value });
  };
}
