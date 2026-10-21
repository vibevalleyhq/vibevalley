// The workbench's frame: a dark rail of places on the left (the manager's face
// back to the farm at the top, 设置 and the seeds back to the farm at the bottom), and over every page but the chat a
// head with the place's name and whether the farm is open.

import type { ReactNode } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useCore, useFrames } from "../data/frame";
import { useFarm } from "../farm/store";
import { AgentFace, ManagerFace } from "../ui/Face";
import { Icon } from "../ui/Icon";
import { type Place, placeOf, places } from "./places";

/** The head's height, the rail's top slot's too. */
const head = 66;

const linkWords = { connecting: "连接中", open: "已连上", lost: "断了，重连中" } as const;

/** A place's picture at 26 px: the agents' is a helper's face. */
export function PlaceIcon({ place }: { place: Place }) {
  return place.id === "agents" ? <AgentFace agentId="backend" size={26} /> : <Icon name={place.icon} size={26} />;
}

function Slot({ to, label, current, fill = "#fffaf033", children }: { to: string; label: string; current?: boolean; fill?: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      title={label}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-[10px] hover:bg-[#fffaf022] focus-visible:outline-2 focus-visible:outline-focus"
      style={current ? { background: fill } : undefined}
    >
      {children}
    </Link>
  );
}

function Rail({ here }: { here?: Place }) {
  const { link } = useFrames();
  const look = useFarm((s) => s.managerLook);
  const settings = places.find((p) => p.id === "settings")!;
  return (
    <nav aria-label="工作台" className="flex w-16 shrink-0 flex-col items-center overflow-y-auto bg-[#46301d] pb-3">
      <div className="flex shrink-0 items-center justify-center" style={{ height: head }}>
        <Slot to="/" label="回农场" current fill="#e5a93c">
          <ManagerFace size={38} look={look} />
        </Slot>
      </div>
      <div className="flex flex-col gap-2">
        {places
          .filter((p) => p.id !== "settings")
          .map((p) => (
            <Slot key={p.id} to={p.path} label={`${p.label} · ${p.hint}`} current={p === here}>
              <PlaceIcon place={p} />
            </Slot>
          ))}
      </div>
      <div className="mt-auto flex flex-col items-center gap-2 pt-2">
        <Slot to={settings.path} label={`${settings.label} · ${settings.hint}`} current={here === settings}>
          <PlaceIcon place={settings} />
        </Slot>
        <Slot to="/" label="回农场">
          <Icon name="icon-seeds" size={26} />
        </Slot>
        <span role="status" title={linkWords[link]} className="flex h-4 items-center">
          <span className={`block h-2 w-2 rounded-full ${link === "open" ? "bg-leaf" : link === "lost" ? "bg-berry" : "bg-faint"}`} aria-hidden />
          <span className="sr-only">{linkWords[link]}</span>
        </span>
      </div>
    </nav>
  );
}

/** The head over a page: its place, and the farm's state, which goes back to the farm. */
function Desk({ place }: { place?: Place }) {
  const core = useCore();
  const live = core?.call === "live";
  const working = core?.sessions.filter((s) => s.phase._tag === "working").length ?? 0;
  const status = live ? `开工中 · ${working} 个在干活` : "没开工";
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line px-5" style={{ height: head }}>
      {place ? (
        <>
          <PlaceIcon place={place} />
          <div className="flex min-w-0 flex-1 items-baseline gap-3">
            <h1 className="truncate text-lg font-semibold">{place.label}</h1>
            <span className="hidden truncate text-xs text-muted sm:inline">{place.hint}</span>
          </div>
        </>
      ) : (
        <span className="flex-1" />
      )}
      <Link to="/" aria-label={status} className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-page px-2.5 text-xs hover:bg-hover">
        <span className={`h-2 w-2 rounded-full ${live ? "bg-leaf" : "bg-faint"}`} aria-hidden />
        {status}
      </Link>
    </div>
  );
}

export function Shell() {
  const { pathname } = useLocation();
  const here = placeOf(pathname);
  return (
    <div className="flex h-full">
      <Rail here={here} />
      <main className="flex min-w-0 flex-1 flex-col">
        {here?.id !== "chat" && <Desk place={here} />}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
