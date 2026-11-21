import { context, untracked, type Accessor, type JSX } from "nsh";

import { createMemo } from "../solid";
import { useLocation } from "./context";
import { ambiguousRoutes, compareRoutes, pathSegments, route, type RoutePath } from "./matching";

type Pattern = Pick<RoutePath, "path" | "segments" | "resolve">;
type ViewFn = () => JSX.Element;

export type RouteDefinition = {
  readonly meta?: Readonly<Record<string, string | boolean>>;
} & (
  | { readonly path: string | Pattern; readonly component: ViewFn; readonly layout?: never; readonly children?: never }
  | { readonly layout: ViewFn; readonly children: readonly RouteDefinition[]; readonly path?: never; readonly component?: never }
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

const RoutesContext = context<Accessor<Branch | undefined>>(() => undefined);
const DepthContext = context(0);

export function useMatches(): Accessor<readonly RouteDefinition[]> {
  const branch = RoutesContext();
  return () => branch()?.chain ?? [];
}

export function Routes(props: { routes: readonly RouteDefinition[]; fallback: ViewFn; invalid: ViewFn }) {
  const branches = untracked(() => branchesOf(props.routes));
  const Fallback = untracked(() => props.fallback);
  const Invalid = untracked(() => props.invalid);
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
    <RoutesContext.Provider value={branch}>
      <DepthContext.Provider value={0}>
        <If when={valid()} else={<Invalid />}>
          <If when={branch()} else={<Fallback />}>
            <Outlet />
          </If>
        </If>
      </DepthContext.Provider>
    </RoutesContext.Provider>
  );
}

export function Outlet() {
  const branch = RoutesContext();
  const depth = DepthContext();
  const node = createMemo(() => branch()?.chain[depth]);
  const rows = () => {
    const n = node();
    return n ? [n] : [];
  };
  return (
    <Each of={rows()}>
      {(definition) => {
        const d = untracked(definition);
        const Page = d.layout ?? d.component;
        return (
          <DepthContext.Provider value={depth + 1}>
            <Page />
          </DepthContext.Provider>
        );
      }}
    </Each>
  );
}
