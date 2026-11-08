import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import { createSignal } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import {
  Link,
  memoryHistory,
  NavLink,
  Outlet,
  route,
  Router,
  Routes,
  useLocation,
  useParams,
  useRouter,
  useSearchParams,
  useSearchValues,
  search,
  searchParam,
} from "#/infra/router.ts";

const variantStyles = stylex.create({
  controlsDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  controlsNav: {
    display: "flex",
    gap: "calc(var(--spacing) * 3)",
  },
  routerStoriesDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
    padding: "calc(var(--spacing) * 4)",
  },
});

const detail = route("/demo/:id");

function Detail() {
  const params = useParams(detail);
  return (
    <p data-testid="router-detail" data-key={params().id}>
      {params().id}
    </p>
  );
}

function Layout() {
  return (
    <section data-testid="router-layout" aria-label="示例页面">
      <Outlet />
    </section>
  );
}

function Controls() {
  const location = useLocation();
  const router = useRouter();
  const [, update] = useSearchParams();
  const [prevented, setPrevented] = createSignal(0);
  return (
    <div {...stylex.attrs(variantStyles.controlsDiv)}>
      <nav aria-label="示例导航" {...stylex.attrs(variantStyles.controlsNav)}>
        <NavLink href="/demo/one" end data-testid="router-one">
          One
        </NavLink>
        <NavLink href="/demo/two" end data-testid="router-two">
          Two
        </NavLink>
        <Link href="/other" data-testid="router-other">
          Other
        </Link>
        <Link
          href="/demo/blocked"
          data-testid="router-prevent"
          onClick={(event) => {
            event.preventDefault();
            setPrevented((n) => n + 1);
          }}
        >
          Prevent
        </Link>
        <Link href="/demo/download" download data-testid="router-download">
          Download
        </Link>
        <Link href="/demo/new" target="_blank" data-testid="router-new">
          New tab
        </Link>
      </nav>
      <div {...stylex.attrs(variantStyles.controlsNav)}>
        <button type="button" data-testid="router-back" onClick={() => router.history.back()}>
          Back
        </button>
        <button type="button" data-testid="router-forward" onClick={() => router.history.forward()}>
          Forward
        </button>
        <button type="button" data-testid="router-replace" onClick={() => router.navigate("/demo/replaced", { replace: true })}>
          Replace
        </button>
        <button
          type="button"
          data-testid="router-search"
          onClick={() => {
            update({ repo: "one" });
            update({ tag: ["a", "b"] }, { replace: true });
          }}
        >
          Search
        </button>
        <Link href="#router-bottom" data-testid="router-anchor">
          Anchor
        </Link>
      </div>
      <output data-testid="router-location">{location().href}</output>
      <output data-testid="router-prevented">{prevented()}</output>
    </div>
  );
}

const positive = Schema.FiniteFromString.check(Schema.isGreaterThan(0));
const typedSearch = search({ page: Schema.optional(searchParam(positive)), tags: Schema.optional(Schema.Array(Schema.String)) });
const typedRoute = route("/typed/:id", { params: Schema.Struct({ id: positive }), search: typedSearch });
function TypedDetail() {
  const params = useParams(typedRoute);
  const [filters, update] = useSearchValues(typedSearch);
  return (
    <div>
      <output data-testid="typed-values" data-id={params().id} data-page={filters().page} data-tags={filters().tags?.join(",")} />
      <button
        type="button"
        data-testid="typed-update"
        onClick={() => {
          update((value) => ({ ...value, page: (value.page ?? 0) + 1 }));
          update((value) => ({ ...value, tags: ["a", "b"] }));
        }}
      >
        Update both
      </button>
    </div>
  );
}
function TypedControls() {
  const router = useRouter();
  return (
    <div>
      <button type="button" data-testid="typed-bad-param" onClick={() => router.navigate("/typed/no")}>
        Invalid parameter
      </button>
      <button type="button" data-testid="typed-bad-search" onClick={() => router.navigate("/typed/1?page=1&page=2")}>
        Invalid search
      </button>
      <button type="button" data-testid="typed-restore" onClick={() => router.navigate(typedRoute.build({ id: 2 }))}>
        Valid link
      </button>
      <output data-testid="typed-location">{router.location().href}</output>
    </div>
  );
}

export default stories({
  title: "交互/路由",
  stories: {
    Schema: story({
      render: () => (
        <Router history={memoryHistory("/typed/1?page=1&foreign=keep#anchor")}>
          <TypedControls />
          <Routes
            routes={[
              { path: typedRoute, component: TypedDetail },
              { path: "*", component: () => <p data-testid="typed-fallback">Fallback</p> },
            ]}
            fallback={() => <p>Missing</p>}
            invalid={() => <p data-testid="typed-invalid">Invalid</p>}
          />
        </Router>
      ),
    }),
    Navigation: story({
      render: () => (
        <Router history={memoryHistory("/demo/one")}>
          <div {...stylex.attrs(variantStyles.routerStoriesDiv)}>
            <Controls />
            <Routes
              routes={[
                {
                  layout: Layout,
                  children: [
                    { path: detail, component: Detail },
                    { path: "/other", component: () => <p data-testid="router-other-page">Other page</p> },
                  ],
                },
              ]}
              fallback={() => <p>Not found</p>}
              invalid={() => <p>Invalid address</p>}
            />
            <div id="router-bottom">Anchor target</div>
          </div>
        </Router>
      ),
    }),
  },
});
