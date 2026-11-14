// VibeValley's infra/router.ts, same exports: history, matching and search
// are VibeValley's own (vendored); context, link and routes are ported to nsh.
export { appHistory, Router, useRouter, useLocation, useParams, useSearch, useSearchParams, useSearchValues } from "./router/context";
export { memoryHistory } from "./router/history";
export { Link, NavLink, Navigate } from "./router/link";
export { search, searchParam, type SearchCheck } from "./router/search";
export { route } from "./router/matching";
export { Routes, Outlet, useMatches, type RouteDefinition } from "./router/routes";
