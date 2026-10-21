// The farm phone: a wooden handset over the phone button, its screen showing a
// call ringing, else the app picked on the home screen; the games take the pad. Esc puts it away.

import { type PointerEvent, type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { InboxItem } from "@vibevalley/protocol";
import { playSound } from "../sound";
import { farm } from "../store";
import { missedOf, phoneCalls, usePhone } from "./calls";
import { BlocksGame } from "./games/BlocksGame";
import { BugSnakeGame } from "./games/BugSnakeGame";
import { DinoGame } from "./games/DinoGame";
import { MergeGame } from "./games/MergeGame";
import { SokobanGame } from "./games/SokobanGame";
import { lcd } from "./lcd";
import { type PadButton, pressPad, usePadListening } from "./pad";
import { HomeScreen, ListScreen, ManagerScreen, type PhoneApp, RingingScreen } from "./screens";

const games: ReadonlySet<PhoneApp> = new Set(["blocks", "dino", "sokoban", "bugs", "merge"]);

export function Phone() {
  const phone = usePhone();
  const navigate = useNavigate();
  const [app, setApp] = useState<PhoneApp>("home");
  const ringing = phone.ringing;
  const put = () => farm.phoneOpen(false);
  const open = (next: PhoneApp) => {
    playSound("tap");
    setApp(next);
  };
  const settle = (call: InboxItem, answered: boolean) => {
    phoneCalls.settle(call, answered);
    if (!answered) return;
    switch (call.target.kind) {
      case "session":
        return farm.select(call.target.id);
      case "graph":
        return farm.openTaskBoard(call.target.graph);
      case "chat":
        return void navigate(`/chat/${call.target.conversation}`);
    }
  };
  const game = ringing === null && games.has(app);
  let screen: ReactNode;
  if (ringing) {
    screen = <RingingScreen call={ringing} onAnswer={() => settle(ringing, true)} onDecline={() => settle(ringing, false)} />;
  } else {
    switch (app) {
      case "home":
        screen = (
          <HomeScreen
            missed={missedOf(phone).length}
            onOpen={open}
            onChannels={() => {
              put();
              void navigate("/chat");
            }}
            onTaskBoard={() => {
              put();
              farm.openTaskBoard();
            }}
          />
        );
        break;
      case "missed":
      case "log":
        screen = <ListScreen screen={app} onScreen={setApp} onAnswer={(c) => settle(c, true)} onCall={() => open("manager")} />;
        break;
      case "manager":
        screen = (
          <ManagerScreen
            onChat={() => {
              put();
              farm.chatOpen(true);
            }}
          />
        );
        break;
      case "blocks":
        screen = <BlocksGame big />;
        break;
      case "sokoban":
        screen = <SokobanGame />;
        break;
      case "dino":
        screen = <DinoGame big />;
        break;
      case "bugs":
        screen = <BugSnakeGame />;
        break;
      case "merge":
        screen = <MergeGame />;
        break;
    }
  }
  return (
    <Handset
      big={game}
      tall={game || ringing !== null}
      onClose={put}
      onHome={() => {
        playSound("tap");
        if (app === "home" && ringing === null) put();
        else {
          setApp("home");
          phoneCalls.silence();
        }
      }}
    >
      {screen}
    </Handset>
  );
}

const body = "#67482d";
const bark = "#2f1f13";
const outline = `inset 0 0 0 2px ${bark}`;

function Handset({ children, big, tall, onClose, onHome }: { children: ReactNode; big: boolean; tall: boolean; onClose: () => void; onHome: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    // On the capture phase, so Esc puts the phone away before the farm opens its menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);
  const listening = usePadListening();
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    <section
      aria-label="农场手机"
      className="pointer-events-auto px-[10px] pt-[10px] pb-3 font-pixel text-[12px] leading-[1.5] tabular-nums"
      style={{
        width: big ? 356 : 236,
        background: body,
        // The outline over a 4 px dark band at the bottom and right and a light one at the top and left.
        boxShadow: `${outline}, inset -4px -4px 0 0 #4a321e, inset 4px 4px 0 0 #8a6440, 3px 4px 0 0 #1e140a73`,
        color: lcd.ink,
      }}
    >
      <div className="mx-auto mb-2 h-1 w-10 bg-[#1e140b]" />
      <div className="flex flex-col p-[2px]" style={{ height: tall ? 440 : 300, background: lcd.paper, boxShadow: `${outline}, inset 3px 3px 0 0 #a8bd78` }}>
        <div className="flex items-center gap-1 px-1.5 py-0.5" style={{ borderBottom: `2px solid ${lcd.dark}` }}>
          <Signal />
          <span>农场通</span>
          <span className="ml-auto">
            {two(now.getHours())}:{two(now.getMinutes())}
          </span>
          <Battery />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
      <div className="mt-2 flex items-center justify-between px-1">
        <Cross live={listening} />
        <button
          type="button"
          aria-label="主屏"
          title="主屏"
          onClick={onHome}
          className="block h-[18px] w-10 cursor-pointer active:translate-y-px"
          style={{ background: "#46301d", boxShadow: `${outline}, inset 4px 4px 0 0 #5c4029` }}
        />
        <span className="flex gap-2">
          <AbKey button="b" label="B" live={listening} />
          <AbKey button="a" label="A" live={listening} />
        </span>
      </div>
    </section>
  );
}

function Signal() {
  return (
    <span className="flex items-end gap-px" aria-hidden>
      {[3, 5, 7, 9].map((h) => (
        <i key={h} className="block w-[2px]" style={{ height: h, background: lcd.ink }} />
      ))}
    </span>
  );
}

function Battery() {
  return (
    <span className="flex items-center" aria-hidden>
      <i className="relative block h-2 w-[14px]" style={{ background: lcd.ink }}>
        <i className="absolute top-[2px] right-[2px] block size-1" style={{ background: lcd.light }} />
      </i>
      <i className="block h-1 w-[2px]" style={{ background: lcd.ink }} />
    </span>
  );
}

/** A pad key held with the mouse or a finger; dim and dead while no game listens. */
function usePress(button: PadButton, live: boolean) {
  const [down, setDown] = useState(false);
  const set = (d: boolean) => {
    if (!live || d === down) return;
    setDown(d);
    pressPad(button, d);
  };
  return {
    down: down && live,
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        e.preventDefault();
        set(true);
      },
      onPointerUp: () => set(false),
      onPointerCancel: () => set(false),
      onPointerLeave: () => set(false),
    },
  };
}

function CrossKey({ button, label, live, at }: { button: PadButton; label: string; live: boolean; at: string }) {
  const { down, handlers } = usePress(button, live);
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={!live}
      {...handlers}
      className={`absolute size-4 ${at}`}
      style={{ background: down ? "#1e140b" : bark }}
    />
  );
}

function Cross({ live }: { live: boolean }) {
  return (
    <span className="relative block size-12" style={{ opacity: live ? 1 : 0.55 }}>
      <CrossKey button="up" label="上" live={live} at="top-0 left-4" />
      <CrossKey button="left" label="左" live={live} at="top-4 left-0" />
      <CrossKey button="right" label="右" live={live} at="top-4 right-0" />
      <CrossKey button="down" label="下" live={live} at="bottom-0 left-4" />
      <i className="absolute top-4 left-4 size-4" style={{ background: bark }} />
    </span>
  );
}

function AbKey({ button, label, live }: { button: PadButton; label: string; live: boolean }) {
  const { down, handlers } = usePress(button, live);
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={!live}
      {...handlers}
      className="grid size-6 place-items-center leading-none text-[#f7e8c4]"
      style={{
        opacity: live ? 1 : 0.55,
        transform: down ? "translateY(1px)" : undefined,
        background: "#c84a3a",
        boxShadow: down ? outline : `${outline}, inset -4px -4px 0 0 #9c3a2d`,
      }}
    >
      {label}
    </button>
  );
}
