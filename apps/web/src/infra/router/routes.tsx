import type { JSX } from "@solidjs/web";
import { type Accessor, createContext, createMemo, Show, untrack, useContext } from "solid-js";

import { useLocation } from "./context";
import { ambiguousRoutes, compareRoutes, pathSegments, route, type RoutePath } from "./matching";

type Pattern = Pick<RoutePath, "path" | "segments" | "resolve">;
type View = () => JSX.Element;

export type RouteDefinition = {
  readonly meta?: Readonly<Record<string, string | boolean>>;
} & (
  | { readonly path: string | Pattern; readonly component: View; readonly layout?: never; readonly children?: never }
  | { readonly layout: View; readonly children: readonly RouteDefinition[]; readonly path?: never; readonly component?: never }
);

interface Branch {
  readonly pattern: Pattern;
  readonly chain: readonly RouteDefinition[];
}

function branchesOf(definitions: readonly RouteDefinition[], parents: readonly RouteDefinition[] = []): Branch[] {
  return definitions.flatMap((definition) => {
    const chain = [...parents, definition];
    return definition.layout
      ? branchesOf(definition.children, chain)
      : [{ pattern: typeof definition.path === "string" ? route(definition.path) : definition.path, chain }];
  });
}

const RoutesContext = createContext<Accessor<Branch | undefined>>();
const DepthContext = createContext(0);

function useBranch(): Accessor<Branch | undefined> {
  return useContext(RoutesContext);
}

export function useMatches(): Accessor<readonly RouteDefinition[]> {
  const branch = useBranch();
  return () => branch()?.chain ?? [];
}

export function Routes(props: { routes: readonly RouteDefinition[]; fallback: View; invalid: View }) {
  const branches = untrack(() => branchesOf(props.routes));
  const Fallback = untrack(() => props.fallback);
  const Invalid = untrack(() => props.invalid);
  for (const [index, branch] of branches.entries()) {
    for (const other of branches.slice(index + 1)) {
      if (ambiguousRoutes(branch.pattern, other.pattern)) throw new Error(`Ambiguous routes: ${branch.pattern.path}, ${other.pattern.path}`);
    }
  }
  branches.sort((a, b) => compareRoutes(a.pattern, b.pattern));
  const location = useLocation();
  const selected = createMemo<{ valid: boolean; branch: Branch | undefined }>(() => {
    const current = location();
    if (!pathSegments(current.pathname)) return { valid: false, branch: undefined };
    for (const candidate of branches) {
      const result = candidate.pattern.resolve(current.pathname, current.search);
      if (result !== "missing") return { valid: result === "matched", branch: result === "matched" ? candidate : undefined };
    }
    return { valid: true, branch: undefined };
  });
  const valid = () => selected().valid;
  const branch = createMemo(() => selected().branch);
  return (
    <RoutesContext value={branch}>
      <DepthContext value={0}>
        <Show when={valid()} fallback={<Invalid />}>
          <Show when={branch()} fallback={<Fallback />}>
            <Outlet />
          </Show>
        </Show>
      </DepthContext>
    </RoutesContext>
  );
}

export function Outlet() {
  const branch = useBranch();
  const depth = useContext(DepthContext);
  const node = createMemo(() => branch()?.chain[depth]);
  return (
    <Show when={node()} keyed>
      {(definition) => {
        const View = definition.layout ?? definition.component;
        return (
          <DepthContext value={depth + 1}>
            <View />
          </DepthContext>
        );
      }}
    </Show>
  );
}
