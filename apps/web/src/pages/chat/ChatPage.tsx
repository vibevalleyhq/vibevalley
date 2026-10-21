import { type ReactNode, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { type Conversation, generalName, type ManagerState, type Session } from "@vibevalley/protocol";
import { useCore } from "../../data/frame";
import {
  channelName,
  channelOf,
  channelsOf,
  chatPath,
  conversationOf,
  jobThreadOf,
  phaseDot,
  phaseText,
  threadOwnerOf,
  threadTitle,
  unreadIn,
  unreadUnder,
} from "../../rules/chat";
import { ManagerFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { Count, Dot, HelperFace, PhaseGlyph, ThinkingDots } from "./bits";
import { Composer } from "./Composer";
import { HistoryProvider } from "./data";
import { ChannelSettingsDialog, NewChannelDialog } from "./Dialogs";
import { MessageList } from "./MessageList";
import { Jobs, Schedules } from "./Tabs";

const head = "flex h-[66px] shrink-0 items-center border-b border-line";

const iconButton =
  "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-hover disabled:cursor-default disabled:opacity-40";

/** /chat is the general; /chat/<id> a channel, or a thread shown beside its channel. */
export function ChatPage() {
  return (
    <HistoryProvider>
      <Chat />
    </HistoryProvider>
  );
}

function Chat() {
  const id = useParams()["*"] || undefined;
  const navigate = useNavigate();
  const core = useCore();
  const chat = core?.chat;
  const shown = conversationOf(chat, id);
  const channel = channelOf(chat, shown) ?? channelsOf(chat)[0];
  const thread = shown?.kind === "thread" ? shown : undefined;
  const [drawer, setDrawer] = useState(false);
  const [creating, setCreating] = useState(false);

  const sidebar = <Sidebar channel={channel} thread={thread} onNew={() => setCreating(true)} onPick={() => setDrawer(false)} />;
  return (
    <div className="relative flex h-full overflow-hidden">
      <div className="hidden w-72 shrink-0 md:flex">{sidebar}</div>
      {drawer && (
        <div className="absolute inset-0 z-30 md:hidden">
          <div className="absolute inset-0 bg-[#2f1f1340]" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 shadow-float transition-transform duration-180 ease-out starting:-translate-x-full">
            {sidebar}
          </div>
        </div>
      )}
      {/* Only once the chat is in: keyed before it, the channel's arrival would start a tab picked meanwhile over. */}
      {chat && <ChannelMain key={channel?.id ?? ""} channel={channel} onDrawer={() => setDrawer(!drawer)} />}
      {thread && (
        <div className="absolute inset-0 z-20 flex border-l border-line bg-page transition-transform duration-180 ease-out starting:translate-x-full lg:static lg:z-auto lg:w-[416px] lg:shrink-0">
          <ThreadPane key={thread.id} thread={thread} onClose={() => navigate(chatPath(channel))} />
        </div>
      )}
      <NewChannelDialog open={creating} onClose={() => setCreating(false)} onCreated={(newId) => navigate(`/chat/${newId}`)} />
    </div>
  );
}

type Tab = "chat" | "jobs" | "schedules";

const tabs: { tab: Tab; icon: string; label: string }[] = [
  { tab: "chat", icon: "icon-board", label: "聊天" },
  { tab: "jobs", icon: "icon-tasks", label: "任务" },
  { tab: "schedules", icon: "icon-clock", label: "定时" },
];

/** Keyed by the channel: its tab and search start over in another one. */
function ChannelMain({ channel, onDrawer }: { channel: Conversation | undefined; onDrawer: () => void }) {
  const [tab, setTab] = useState<Tab>("chat");
  const [search, setSearch] = useState<string>();
  const [settings, setSettings] = useState(false);
  const name = channelName(channel);
  const about = [channel?.description, channel?.project ? `默认项目 ${channel.project}` : ""].filter(Boolean).join(" · ");
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={`#${name}`}>
      <header className={`${head} gap-3 px-4`}>
        <button type="button" className={`${iconButton} md:hidden`} aria-label="频道列表" onClick={onDrawer}>
          <Icon name="icon-board" size={18} />
        </button>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-wheat text-lg font-semibold">#</span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-lg font-semibold" title={channel?.kind === "general" ? "默认的频道：你、管家和帮工都在这儿" : undefined}>
            {name}
          </h1>
          {about && <p className="truncate text-xs text-muted">{about}</p>}
        </div>
        {search !== undefined && (
          <label className="flex h-8 w-48 items-center gap-1.5 rounded-md border border-line px-2 focus-within:border-focus">
            <Icon name="button-search" size={14} />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setSearch(undefined)}
              placeholder="在这个频道里找…"
              aria-label="在这个频道里找"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
        )}
        <button
          type="button"
          className={`${iconButton} ${search !== undefined ? "bg-selected" : ""}`}
          aria-label="找消息"
          aria-pressed={search !== undefined}
          title="找消息"
          onClick={() => {
            setSearch(search === undefined ? "" : undefined);
            setTab("chat");
          }}
        >
          <Icon name="act-search" size={18} />
        </button>
        <button type="button" className={iconButton} aria-label="频道设置" title="频道设置" disabled={!channel} onClick={() => setSettings(true)}>
          <Icon name="icon-wrench" size={18} />
        </button>
      </header>
      <div role="tablist" aria-label="频道里的" className="flex shrink-0 gap-1 border-b border-line px-3">
        {tabs.map((t) => (
          <button
            key={t.tab}
            type="button"
            role="tab"
            aria-selected={tab === t.tab}
            onClick={() => setTab(t.tab)}
            className={`group -mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-2 pt-2 pb-1.5 text-sm ${tab === t.tab ? "border-ink font-semibold" : "border-transparent text-muted hover:text-ink"}`}
          >
            <Icon name={t.icon} size={16} className={tab === t.tab ? "" : "opacity-70 group-hover:opacity-100"} />
            {t.label}
          </button>
        ))}
      </div>
      {tab === "chat" && (
        <>
          <MessageList conversation={channel} filter={search} emptyText={`#${name} 里还没人说话。跟管家说一件要做的事，比如「让测试小吴跑一遍测试」。`} />
          <Composer conversation={channel} placeholder={`发送消息至 #${name}`} />
        </>
      )}
      {tab === "jobs" && channel && <Jobs channel={channel} />}
      {tab === "schedules" && channel && <Schedules channel={channel} />}
      {channel && <ChannelSettingsDialog channel={channel} open={settings} onClose={() => setSettings(false)} />}
    </section>
  );
}

function Sidebar({
  channel,
  thread,
  onNew,
  onPick,
}: {
  channel: Conversation | undefined;
  thread: Conversation | undefined;
  onNew: () => void;
  onPick: () => void;
}) {
  const core = useCore();
  const chat = core?.chat;
  const channels = channelsOf(chat);
  const sessions = core?.sessions ?? [];
  const navigate = useNavigate();
  const go = (c: Conversation) => {
    void navigate(chatPath(c));
    onPick();
  };
  return (
    <aside aria-label="频道和帮工" className="flex w-full flex-col border-r border-line bg-side">
      <div className={`${head} px-5 text-xl font-semibold`}>聊天</div>
      <div className="flex-1 overflow-y-auto p-3">
        <Section
          title="频道"
          count={Math.max(1, channels.length)}
          action={
            <button type="button" className={`${iconButton} size-6`} aria-label="创建频道" title="创建频道" onClick={onNew}>
              <Icon name="button-add" size={14} />
            </button>
          }
        >
          {/* Before the first frame the general is not there yet: it is still where you talk. */}
          {channels.length === 0 && <ChannelRow label={generalName} here unread={0} />}
          {channels.map((c) => (
            <ChannelRow key={c.id} label={channelName(c)} here={c.id === channel?.id} unread={unreadUnder(chat, c)} onClick={() => go(c)} />
          ))}
        </Section>
        <Section title="帮工" count={sessions.length}>
          {sessions.length === 0 && <p className="px-3 text-xs text-muted">还没有帮工在地里：在频道里跟管家说一件活。</p>}
          {sessions.map((h) => (
            <SessionRow key={h.id} h={h} active={!!thread && jobThreadOf(chat, h)?.id === thread.id} onShow={go} />
          ))}
        </Section>
      </div>
      <ManagerLine mood={core?.manager ?? "idle"} />
    </aside>
  );
}

function Section({ title, count, action, children }: { title: string; count: number; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="mb-4" aria-label={title}>
      <div className="flex items-center px-1 pb-1">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex flex-1 cursor-pointer items-center gap-1 text-left">
          <Icon name="button-next" size={10} className={`opacity-60 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          <span className="text-xs font-semibold text-muted">{title}</span>
          <span className="text-xs text-faint">{count}</span>
        </button>
        {action}
      </div>
      {open && <div className="flex flex-col gap-0.5">{children}</div>}
    </section>
  );
}

function ChannelRow({ label, here, unread, onClick }: { label: string; here: boolean; unread: number; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={here ? "page" : undefined}
      className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1 text-left text-sm ${here ? "bg-selected" : "hover:bg-hover"}`}
    >
      <span className="text-faint" aria-hidden>
        #
      </span>
      <span className={`min-w-0 flex-1 truncate ${here || unread > 0 ? "font-semibold" : ""}`}>{label}</span>
      {unread > 0 && <Count n={unread} />}
    </button>
  );
}

function SessionRow({ h, active, onShow }: { h: Session; active: boolean; onShow: (c: Conversation) => void }) {
  const chat = useCore()?.chat;
  const thread = jobThreadOf(chat, h);
  const unread = thread ? unreadIn(chat, thread) : 0;
  const phase = phaseText(h, Date.now());
  return (
    <button
      type="button"
      disabled={!thread}
      onClick={() => thread && onShow(thread)}
      title={phase}
      className={`flex items-center gap-2 rounded-md px-2.5 py-1 text-left text-sm enabled:cursor-pointer ${active ? "bg-selected" : "hover:bg-hover"}`}
    >
      <span className="relative shrink-0">
        <HelperFace agent={h.agent} size={24} />
        <Dot tone={phaseDot(h.phase)} className="absolute -right-0.5 -bottom-0.5" />
      </span>
      <span className="shrink-0">{h.name}</span>
      <PhaseGlyph phase={h.phase} />
      <span className="min-w-0 flex-1 truncate text-xs text-muted">{phase}</span>
      {unread > 0 && <Count n={unread} />}
    </button>
  );
}

const mood: Record<ManagerState, string> = { idle: "在歇着", listening: "在听", thinking: "在想", speaking: "在说" };

function ManagerLine({ mood: m }: { mood: ManagerState }) {
  return (
    <div className="flex items-center gap-2 border-t border-line px-4 py-3 text-sm" aria-label="管家">
      <ManagerFace size={32} />
      管家
      <Dot tone={m === "idle" ? "idle" : m === "thinking" ? "wheat" : "leaf"} size={8} className="ml-1" />
      <span className="text-xs text-muted">{mood[m]}</span>
      {m === "thinking" && <ThinkingDots />}
    </div>
  );
}

function ThreadPane({ thread, onClose }: { thread: Conversation; onClose: () => void }) {
  const core = useCore();
  const sessions = core?.sessions ?? [];
  const session = threadOwnerOf(thread, sessions);
  const status = session
    ? `@${session.id} · ${phaseText(session, Date.now())}`
    : thread.subjectKind === "issue"
      ? "现在没有帮工在干，串还留着"
      : `${thread.replies} 条回复`;
  return (
    <section aria-label="串" className="flex min-w-0 flex-1 flex-col">
      <header className={`${head} gap-2.5 px-4`}>
        <span className="flex size-8 shrink-0 items-center justify-center">
          {session ? <HelperFace agent={session.agent} size={32} /> : <Icon name="button-thread" size={16} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{threadTitle(core?.chat, thread, core?.issues ?? [], sessions)}</span>
          <span className="flex items-center gap-1 text-xs text-muted">
            {session && <PhaseGlyph phase={session.phase} />}
            <span className="truncate">{status}</span>
          </span>
        </div>
        <button type="button" className={iconButton} aria-label="关上串" title="关上串" onClick={onClose}>
          <Icon name="button-close" size={16} />
        </button>
      </header>
      <MessageList conversation={thread} emptyText="串里还没人说话。在这里说的话，它的帮工会看到。" />
      <Composer conversation={thread} placeholder={session ? `在串里说，${session.name}会看到` : "回复这个串"} />
    </section>
  );
}
