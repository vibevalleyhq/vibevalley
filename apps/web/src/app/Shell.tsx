// The workbench's frame: a dark rail of places on the left (the assistant's face
// back to the farm at the top, 设置 and the seeds back to the farm at the bottom), and over every page but the chat a
// head with the place's name and whether the farm is open.

import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type Place, placeOf, places } from "./places";
import { useCore, useFrames } from "../data/frame";
import { useFarm } from "../farm/state";
import { AgentFace, AssistantFace } from "../ui/Face";
import { Icon } from "../ui/Icon";
import { A } from "./A";
import { useRouter } from "./router";
import { titleBar } from "./TitleBar";

/** The head's height, the rail's top slot's too. */
const head = 66;

const linkWords = { connecting: "连接中", open: "已连上", lost: "断了，重连中" } as const;

/** A place's picture at 26 px: the agents' is a helper's face. */
export function PlaceIcon(props: { place: Place }) {
  return (
    <Show when={props.place.id === "agents"} fallback={<Icon name={props.place.icon} size={26} />}>
      <AgentFace agentId="backend" size={26} />
    </Show>
  );
}

function Slot(props: { to: string; label: string; current?: boolean; fill?: string; children: JSX.Element }) {
  return (
    <A
      href={props.to}
      title={props.label}
      aria-label={props.label}
      aria-current={props.current ? "page" : undefined}
      class="flex h-11 w-11 items-center justify-center overflow-hidden rounded-[10px] hover:bg-[#fffaf022] focus-visible:outline-2 focus-visible:outline-focus"
      style={props.current ? { background: props.fill ?? "#fffaf033" } : undefined}
    >
      {props.children}
    </A>
  );
}

function Rail(props: { here?: Place }) {
  const frames = useFrames();
  const look = useFarm((s) => s.assistantLook);
  const settings = places.find((p) => p.id === "settings")!;
  return (
    <nav aria-label="工作台" class="flex w-16 shrink-0 flex-col items-center overflow-y-auto bg-[#46301d] pb-3">
      {/* Room for the desktop window's buttons over the rail's top. */}
      <div class="shrink-0" style={{ height: `${titleBar.top}px` }} />
      <div class="flex shrink-0 items-center justify-center" style={{ height: `${head}px` }}>
        <Slot to="/" label="回农场" current fill="#e5a93c">
          <AssistantFace size={38} look={look()} />
        </Slot>
      </div>
      <div class="flex flex-col gap-2">
        <For each={places.filter((p) => p.id !== "settings")}>
          {(p) => (
            <Slot to={p.path} label={`${p.label} · ${p.hint}`} current={p === props.here}>
              <PlaceIcon place={p} />
            </Slot>
          )}
        </For>
      </div>
      <div class="mt-auto flex flex-col items-center gap-2 pt-2">
        <Slot to={settings.path} label={`${settings.label} · ${settings.hint}`} current={props.here === settings}>
          <PlaceIcon place={settings} />
        </Slot>
        <Slot to="/" label="回农场">
          <Icon name="icon-seeds" size={26} />
        </Slot>
        <span role="status" title={linkWords[frames.link]} class="flex h-4 items-center">
          <span
            class={["block h-2 w-2 rounded-full", frames.link === "open" ? "bg-leaf" : frames.link === "lost" ? "bg-berry" : "bg-faint"]}
            aria-hidden="true"
          />
          <span class="sr-only">{linkWords[frames.link]}</span>
        </span>
      </div>
    </nav>
  );
}

/** The head over a page: its place, and the farm's state, which goes back to the farm. */
function Desk(props: { place?: Place }) {
  const core = useCore();
  const live = () => core()?.call === "live";
  const working = () => core()?.sessions.filter((s) => s.phase._tag === "working").length ?? 0;
  const status = () => (live() ? `开工中 · ${working()} 个在干活` : "没开工");
  return (
    <div class="flex shrink-0 items-center gap-3 border-b border-line px-5" style={{ height: `${head}px` }}>
      <Show when={props.place} fallback={<span class="flex-1" />}>
        {(place) => (
          <>
            <PlaceIcon place={place()} />
            <div class="flex min-w-0 flex-1 items-baseline gap-3">
              <h1 class="truncate text-lg font-semibold">{place().label}</h1>
              <span class="hidden truncate text-xs text-muted sm:inline">{place().hint}</span>
            </div>
          </>
        )}
      </Show>
      <A href="/" aria-label={status()} class="flex h-7 items-center gap-1.5 rounded-md border border-line bg-page px-2.5 text-xs hover:bg-hover">
        <span class={["h-2 w-2 rounded-full", live() ? "bg-leaf" : "bg-faint"]} aria-hidden="true" />
        {status()}
      </A>
    </div>
  );
}

export function Shell(props: { children: JSX.Element }) {
  const router = useRouter();
  const here = () => placeOf(router.path().split("?")[0]!);
  return (
    <div class="flex h-full">
      <Rail here={here()} />
      <main class="flex min-w-0 flex-1 flex-col">
        <Show when={here()?.id !== "chat"}>
          <Desk place={here()} />
        </Show>
        <div class="min-h-0 flex-1">{props.children}</div>
      </main>
    </div>
  );
}
