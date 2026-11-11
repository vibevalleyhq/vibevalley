import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import { createMemo, createSignal, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { createQueryClient, defineQuery, QueryProvider, useQuery, type QueryDescriptor } from "#/infra/query.ts";
import { Button } from "#/ui/Button.tsx";

const styles = stylex.create({
  queriesDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    padding: "1rem",
  },
});

function Observer(props: { id: () => number; query: (id: number) => QueryDescriptor<{ id: number }>; enabled: () => boolean; name: string }) {
  const result = useQuery(() => props.query(props.id()), { enabled: () => props.enabled(), keepPrevious: true });
  const data = createMemo(() => {
    const value = result.data();
    if (value !== undefined && value.id !== props.id()) throw new Error("A previous query became the current identity");
    return value?.id;
  });
  return (
    <output
      data-testid={`query-${props.name}`}
      data-current={data()}
      data-previous={result.previous()?.value.id}
      data-status={result.status()}
      data-fetching={String(result.fetching())}
      data-error={result.error()?.message}
    >
      {data() ?? "waiting"}
    </output>
  );
}
function Queries() {
  const [id, setId] = createSignal(1);
  const [enabled, setEnabled] = createSignal(true);
  const [second, setSecond] = createSignal(true);
  const [calls, setCalls] = createSignal(0);
  const [aborts, setAborts] = createSignal(0);
  const pending: ((invalid: boolean) => void)[] = [];
  const query = defineQuery({
    schema: Schema.Struct({ id: Schema.Finite }),
    key: (id: number) => ["query-story", id],
    staleTime: Infinity,
    fetch: (id, { signal }) => {
      setCalls((n) => n + 1);
      signal.addEventListener("abort", () => setAborts((n) => n + 1), { once: true });
      return new Promise<unknown>((resolve) => pending.push((invalid) => resolve({ id: invalid ? "private-credential" : id })));
    },
  });
  return (
    <QueryProvider client={createQueryClient()}>
      <div {...stylex.attrs(styles.queriesDiv)}>
        <Observer name="one" id={id} query={query} enabled={enabled} />
        <Show when={second()}>
          <Observer name="two" id={id} query={query} enabled={enabled} />
        </Show>
        <output data-testid="query-calls">{calls()}</output>
        <output data-testid="query-aborts">{aborts()}</output>
        <Button data-testid="query-resolve" onClick={() => pending.splice(0).forEach((resolve) => resolve(false))}>
          Resolve reads
        </Button>
        <Button data-testid="query-invalid" onClick={() => pending.splice(0).forEach((resolve) => resolve(true))}>
          Invalid response
        </Button>
        <Button data-testid="query-next" onClick={() => setId((n) => n + 1)}>
          Next key
        </Button>
        <Button data-testid="query-toggle" onClick={() => setEnabled(!enabled())}>
          Toggle demand
        </Button>
        <Button data-testid="query-unmount" onClick={() => setSecond(!second())}>
          Toggle second observer
        </Button>
      </div>
    </QueryProvider>
  );
}
export default stories({ title: "交互/查询", stories: { Lifecycle: story({ render: Queries }) } });
