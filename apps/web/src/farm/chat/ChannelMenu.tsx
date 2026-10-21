// The channel switcher in the farm chat window's head: the channels with what they are
// for and their unread lines, a new channel, the current one's settings, and the way to its full page (its schedules
// are there).

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { Conversation } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useCore } from "../../data/frame";
import { channelsOf, chatPath, unreadUnder } from "../../rules/chat";
import { useProjectNames } from "../../pages/issues/data";
import { PxButton, PxTextInput, SpriteIcon } from "../kit";
import { playSound } from "../sound";
import { farm } from "../store";

/** A channel's name as the farm says it: #name, the general one 田头. */
export const channelLabel = (c: Conversation | undefined) => (c?.kind === "channel" ? `#${c.name ?? ""}` : "田头");

type Mode = "list" | "create" | "settings";

export function ChannelMenu({ current }: { current: Conversation | undefined }) {
  const chat = useCore()?.chat;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("list");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);
  const channels = channelsOf(chat);
  const elsewhere = channels.filter((c) => c.id !== current?.id).reduce((n, c) => n + unreadUnder(chat, c), 0);
  const close = () => setOpen(false);
  return (
    <div ref={box} className="relative min-w-0">
      <button
        type="button"
        aria-label={`频道：${channelLabel(current)}，点开切换或开新频道`}
        aria-expanded={open}
        onClick={() => {
          if (!open) playSound("open");
          setOpen(!open);
          setMode("list");
        }}
        className="flex max-w-full cursor-pointer items-center gap-1.5 px-1 hover:bg-cream-200"
      >
        <span className="truncate text-[13px]">{channelLabel(current)}</span>
        {elsewhere > 0 && <span className="text-[12px] text-berry">{elsewhere}</span>}
        <SpriteIcon name="button-next" size={10} className="rotate-90" />
      </button>
      {open && (
        <div className="absolute top-full left-0 z-20 mt-1.5 w-72 bg-cream-50 p-2 shadow-px" role="dialog" aria-label="频道">
          {mode === "list" && (
            <>
              <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                {channels.map((c) => {
                  const unread = unreadUnder(chat, c);
                  const line = [c.description, c.project ? `项目 ${c.project}` : undefined].filter(Boolean).join(" · ");
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-current={c.id === current?.id}
                      onClick={() => {
                        close();
                        farm.showChat(c.kind === "general" ? null : c.id);
                      }}
                      className={`flex cursor-pointer items-start gap-2 px-2 py-1.5 text-left ${c.id === current?.id ? "bg-leaf-300/50" : "hover:bg-cream-200"}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{channelLabel(c)}</span>
                        {line && <span className="block truncate text-[12px] text-bark-500">{line}</span>}
                      </span>
                      {unread > 0 && <span className="bg-berry px-1.5 text-[12px] text-cream-50">{unread}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-cream-200 pt-1.5 text-[12px] text-leaf-700">
                <button type="button" onClick={() => setMode("create")} className="flex cursor-pointer items-center gap-1 hover:underline">
                  <SpriteIcon name="button-add" size={12} />
                  开新频道
                </button>
                <button type="button" onClick={() => void navigate(chatPath(current))} className="flex cursor-pointer items-center gap-1 hover:underline">
                  <SpriteIcon name="button-open" size={12} />
                  频道页和定时
                </button>
                {current?.kind === "channel" && (
                  <button type="button" onClick={() => setMode("settings")} className="flex cursor-pointer items-center gap-1 hover:underline">
                    <SpriteIcon name="button-settings" size={12} />
                    设置
                  </button>
                )}
              </div>
            </>
          )}
          {mode === "create" && <NewChannel onDone={close} onBack={() => setMode("list")} />}
          {mode === "settings" && current && <ChannelSettings channel={current} onDone={close} onBack={() => setMode("list")} />}
        </div>
      )}
    </div>
  );
}

function FormButtons({ onBack, submit, onSubmit }: { onBack: () => void; submit: string; onSubmit?: () => void }) {
  return (
    <div className="mt-2 flex items-center justify-end gap-2">
      <button type="button" onClick={onBack} className="cursor-pointer text-[12px] text-leaf-700 hover:underline">
        返回
      </button>
      <PxButton tone="primary" size="sm" disabled={!onSubmit} onClick={onSubmit}>
        {submit}
      </PxButton>
    </div>
  );
}

function NewChannel({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const projects = useProjectNames();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [project, setProject] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const made = await api.channel.create({
        body: { name: name.trim(), description: description.trim() || undefined, project: project.trim() || undefined },
      });
      playSound("open");
      farm.showChat(made);
      onDone();
    } catch (e) {
      setError(reasonOf(e));
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px]">开新频道</p>
      <p className="text-[12px] text-bark-500">一件长期的事、一个项目，单独一个地方说话、派活。在这里叫管家，活就派在这里。</p>
      <PxTextInput value={name} onChange={setName} placeholder="名字，比如 clock-in" label="频道名" autoFocus />
      <PxTextInput value={description} onChange={setDescription} placeholder="做什么的（可以不填）" label="频道说明" />
      <PxTextInput value={project} onChange={setProject} placeholder="默认项目（可以不填）" label="默认项目" suggestions={projects} />
      {error && <p className="text-[12px] text-berry">{error}</p>}
      <FormButtons onBack={onBack} submit="开" onSubmit={busy || !name.trim() ? undefined : () => void submit()} />
    </div>
  );
}

function ChannelSettings({ channel, onDone, onBack }: { channel: Conversation; onDone: () => void; onBack: () => void }) {
  const projects = useProjectNames();
  const [description, setDescription] = useState(channel.description ?? "");
  const [project, setProject] = useState(channel.project ?? "");
  const [error, setError] = useState<string>();
  const submit = async () => {
    try {
      await api.channel.update({ id: channel.id, body: { description, project } });
      onDone();
    } catch (e) {
      setError(reasonOf(e));
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px]">{channelLabel(channel)} 的设置</p>
      <PxTextInput value={description} onChange={setDescription} placeholder="做什么的" label="频道说明" />
      <PxTextInput value={project} onChange={setProject} placeholder="默认项目（空着就没有）" label="默认项目" suggestions={projects} />
      {error && <p className="text-[12px] text-berry">{error}</p>}
      <FormButtons onBack={onBack} submit="存" onSubmit={() => void submit()} />
    </div>
  );
}
