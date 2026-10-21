// 图鉴: every drawing the farm uses, its pointers and its sounds. /catalog is the drawings,
// /catalog/<name> one of them large, /catalog/cursors and /catalog/sounds the other shelves.

import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { playSound, SOUND_GROUPS, SOUND_LABEL, type SoundName } from "../../farm/sound";
import { framesOf, groupsOf, type Picture, pictureMatches, picturesOf, remakeOf, shelfOf, shelves } from "../../rules/catalog";
import { numberText } from "../../rules/time";
import { Button } from "../../ui/Button";
import { TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { Card, Quiet, Switch } from "../kit";

type Ground = "check" | "grass" | "night";
const grounds: { value: Ground; label: string }[] = [
  { value: "check", label: "格子" },
  { value: "grass", label: "草地" },
  { value: "night", label: "夜里" },
];

const groundStyle = (g: Ground): CSSProperties =>
  g === "grass"
    ? { background: "#7a9a4a" }
    : g === "night"
      ? { background: "#22283a" }
      : { backgroundColor: "#f3e9d2", backgroundImage: "repeating-conic-gradient(#e4d6b6 0% 25%, transparent 0% 50%)", backgroundSize: "12px 12px" };

/** Whole steps, so its pixels stay square. */
const fitScale = (p: Picture, box: number) => {
  const k = box / Math.max(p.w, p.h);
  return k >= 1 ? Math.floor(k) : k;
};

const Img = ({ p, scale }: { p: Picture; scale: number }) => (
  <img
    src={`/pixel/${p.name}.png`}
    alt=""
    draggable={false}
    className="max-w-none [image-rendering:pixelated]"
    style={{ width: Math.round(p.w * scale), height: Math.round(p.h * scale) }}
  />
);

function usePictures() {
  return useQuery({ queryKey: ["pictures"], queryFn: async () => picturesOf(await (await fetch("/pixel/sprites.json")).json()), staleTime: Infinity }).data;
}

const shelfTabs = [
  { id: "sprites", label: "图", to: "/catalog" },
  { id: "cursors", label: "指针", to: "/catalog/cursors" },
  { id: "sounds", label: "音效", to: "/catalog/sounds" },
] as const;

export function CatalogPage() {
  const rest = useParams()["*"] || undefined;
  const shelf = rest === "cursors" ? "cursors" : rest === "sounds" ? "sounds" : "sprites";
  const tabs = (
    <div role="tablist" aria-label="图鉴的书架" className="flex gap-0.5 rounded-lg bg-hover p-0.5">
      {shelfTabs.map((t) => (
        <Link
          key={t.id}
          to={t.to}
          role="tab"
          aria-selected={t.id === shelf}
          className={`flex h-[26px] flex-1 items-center justify-center rounded-md text-sm ${t.id === shelf ? "bg-page font-medium shadow-[0_1px_2px_#2f1f131a]" : "text-muted hover:bg-hover"}`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
  return (
    <div className="h-full p-3">
      {shelf === "cursors" ? (
        <Cursors tabs={tabs} />
      ) : shelf === "sounds" ? (
        <Sounds tabs={tabs} />
      ) : (
        <Sprites id={rest && decodeURIComponent(rest)} tabs={tabs} />
      )}
    </div>
  );
}

/** The column every shelf has, so switching shelves never moves the picker. */
function Column({ tabs, children }: { tabs: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-page p-2">
      {tabs}
      {children}
    </div>
  );
}

function Layout({ left, children, right }: { left: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto lg:flex-row lg:overflow-hidden">
      <div className="shrink-0 lg:w-60 lg:overflow-y-auto">{left}</div>
      {right && <div className="shrink-0 xl:order-last xl:w-88 xl:overflow-y-auto">{right}</div>}
      <div className="flex min-w-0 flex-1 flex-col gap-3 lg:overflow-y-auto">{children}</div>
    </div>
  );
}

function Search({
  query,
  onChange,
  placeholder,
  ground,
  onGround,
}: {
  query: string;
  onChange: (q: string) => void;
  placeholder: string;
  ground?: Ground;
  onGround?: (g: Ground) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <TextInput aria-label="找素材" className="min-w-48 flex-1" placeholder={placeholder} value={query} onChange={(e) => onChange(e.target.value)} />
      {ground && onGround && <Segmented label="底色" value={ground} options={grounds} onChange={onGround} />}
    </div>
  );
}

function Sprites({ id, tabs }: { id?: string; tabs: ReactNode }) {
  const pictures = usePictures();
  const navigate = useNavigate();
  const [shelf, setShelf] = useState("all");
  const [query, setQuery] = useState("");
  const [ground, setGround] = useState<Ground>("check");
  if (!pictures) return null;
  const byName = new Map(pictures.map((p) => [p.name, p]));
  const has = (n: string) => byName.has(n);
  const selected = id ? byName.get(id) : undefined;
  const counts = new Map<string, number>();
  for (const p of pictures) counts.set(shelfOf(p.name), (counts.get(shelfOf(p.name)) ?? 0) + 1);
  const shown = pictures.filter((p) => (shelf === "all" || shelfOf(p.name) === shelf) && pictureMatches(p, query));
  const present = shelves.filter((s) => (counts.get(s.id) ?? 0) > 0);
  const visible = shelf === "all" ? present : present.filter((s) => s.id === shelf);
  const button = (key: string, label: string, count: number) => (
    <button
      key={key}
      type="button"
      aria-pressed={shelf === key}
      onClick={() => setShelf(key)}
      className={`flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 text-sm ${shelf === key ? "bg-selected font-semibold" : "hover:bg-hover"}`}
    >
      <span className="flex-1 text-left">{label}</span>
      <span className="text-xs font-normal text-muted">{count}</span>
    </button>
  );
  return (
    <Layout
      left={
        <Column tabs={tabs}>
          <nav aria-label="分类" className="flex flex-col gap-0.5">
            {button("all", "全部", pictures.length)}
            {present.map((s) => button(s.id, s.label, counts.get(s.id) ?? 0))}
          </nav>
          <p className="px-2 pt-1 text-xs text-muted">{pictures.length} 张，切自 design/pixel/raw。</p>
        </Column>
      }
      right={
        selected ? (
          <Detail key={selected.name} picture={selected} has={has} byName={byName} ground={ground} />
        ) : (
          <Quiet>点一张看大图：尺寸、落脚点、会动的帧，和它是从哪张原图切出来的、怎么重画。</Quiet>
        )
      }
    >
      <Search query={query} onChange={setQuery} placeholder="找：名字、类别、动物、衣服（熊、雨衣、lang-、icon-……）" ground={ground} onGround={setGround} />
      {shown.length === 0 && <Quiet>没有对得上的。</Quiet>}
      {visible.map((s) => {
        const groups = groupsOf(
          s.id,
          shown.filter((p) => shelfOf(p.name) === s.id),
        );
        if (groups.length === 0) return null;
        return (
          <Card
            key={s.id}
            title={`${s.label} · ${groups.reduce((n, g) => n + g.pictures.length, 0)}`}
            action={<span className="truncate text-xs text-muted">{s.hint}</span>}
          >
            {groups.map((g) => (
              <div key={g.key} className="flex flex-col gap-1.5">
                {g.label && <span className="text-xs font-semibold text-muted">{g.label}</span>}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1.5">
                  {g.pictures.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      title={`${p.name} · ${numberText(p.w)}×${numberText(p.h)}`}
                      aria-label={p.name}
                      aria-current={selected?.name === p.name ? "true" : undefined}
                      onClick={() => navigate(`/catalog/${encodeURIComponent(p.name)}`)}
                      className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg p-1 focus-visible:outline-2 focus-visible:outline-focus ${selected?.name === p.name ? "bg-selected" : "hover:bg-hover"}`}
                    >
                      <span className="relative flex size-20 items-center justify-center overflow-hidden rounded-md" style={groundStyle(ground)}>
                        <Img p={p} scale={fitScale(p, 72)} />
                        {framesOf(p.name, has) && (
                          <span className="absolute top-0.5 right-0.5 rounded-[3px] bg-bark-900/70 px-1 text-[10px] leading-[14px] text-paper">动</span>
                        )}
                      </span>
                      <span className="w-full truncate text-center font-mono text-[11.5px] text-muted">{p.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </Card>
        );
      })}
    </Layout>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          // No clipboard here: the text is on show to copy by hand.
        }
      }}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-hover"
    >
      <Icon name={done ? "mark-check" : "button-copy"} size={12} />
      {done ? "复制了" : "复制"}
    </button>
  );
}

function Detail({ picture, has, byName, ground }: { picture: Picture; has: (n: string) => boolean; byName: Map<string, Picture>; ground: Ground }) {
  const navigate = useNavigate();
  const [scale, setScale] = useState(() => Math.min(8, Math.max(1, Math.floor(260 / Math.max(picture.w, picture.h)))));
  const [marks, setMarks] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [fps, setFps] = useState(6);
  const [frame, setFrame] = useState(0);
  const frames = framesOf(picture.name, has);
  useEffect(() => {
    if (!frames || !playing || fps <= 0) return;
    const t = setInterval(() => setFrame((f) => f + 1), 1000 / fps);
    return () => clearInterval(t);
  }, [frames?.join(), playing, fps]);
  const shown = (frames && playing ? byName.get(frames[frame % frames.length]!) : undefined) ?? picture;
  const remake = remakeOf(picture);
  const scales = [...new Set([1, 2, 4, 8, scale])].sort((a, b) => a - b);
  const row = (label: string, value: ReactNode) => (
    <div className="flex gap-2 text-sm">
      <span className="w-16 shrink-0 text-muted">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1">{value}</span>
    </div>
  );
  const code = (text: string) => (
    <>
      <code title={text} className="min-w-0 truncate rounded bg-hover px-1.5 py-px font-mono text-[11.5px]">
        {text}
      </code>
      <Copy text={text} />
    </>
  );
  return (
    <Card title={picture.name} action={<Copy text={picture.name} />}>
      <div className="flex max-h-88 min-h-40 items-center justify-center overflow-auto rounded-md p-3" style={groundStyle(ground)}>
        <span className="relative" style={{ width: shown.w * scale, height: shown.h * scale }}>
          <Img p={shown} scale={scale} />
          {marks && (
            <>
              <span
                title="落脚点"
                className="absolute"
                style={{
                  left: shown.ax * scale - 6,
                  top: shown.ay * scale - 6,
                  width: 12,
                  height: 12,
                  background: "linear-gradient(#c84a3a,#c84a3a) center/100% 2px no-repeat, linear-gradient(#c84a3a,#c84a3a) center/2px 100% no-repeat",
                }}
              />
              {shown.hx !== undefined && shown.hy !== undefined && (
                <span
                  title="头"
                  className="absolute border-2 border-[#0ea5e9]"
                  style={{ left: shown.hx * scale - 5, top: shown.hy * scale - 5, width: 10, height: 10 }}
                />
              )}
            </>
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="放大"
          value={String(scale)}
          options={scales.map((s) => ({ value: String(s), label: `${s < 1 ? s.toFixed(2).replace(/0$/, "") : numberText(s)}×` }))}
          onChange={(v) => setScale(Number(v))}
        />
        <Switch label="落脚点和头" checked={marks} onChange={setMarks} />
      </div>
      {frames && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-hover p-2">
          <div className="flex items-center gap-2">
            <Button onClick={() => setPlaying(!playing)}>{playing ? "停" : "播放"}</Button>
            <span className="text-xs text-muted">{frames.length} 帧</span>
            <span className="flex-1" />
            <input
              type="range"
              aria-label="每秒几帧"
              min={1}
              max={12}
              step={1}
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
              className="w-24 accent-[#74a046]"
            />
            <span className="w-14 text-xs text-muted">{fps} 帧/秒</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {frames.map((name, i) => {
              const f = byName.get(name);
              return f ? (
                <button
                  key={`${name}${i}`}
                  type="button"
                  title={name}
                  aria-label={name}
                  onClick={() => navigate(`/catalog/${encodeURIComponent(name)}`)}
                  className={`flex size-11 cursor-pointer items-center justify-center overflow-hidden rounded ${playing && i === frame % frames.length ? "ring-2 ring-focus" : ""}`}
                  style={groundStyle(ground)}
                >
                  <Img p={f} scale={fitScale(f, 38)} />
                </button>
              ) : null;
            })}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {row("尺寸", `${numberText(picture.w)} × ${numberText(picture.h)} 像素`)}
        {row("落脚点", `(${numberText(picture.ax)}, ${numberText(picture.ay)})`)}
        {picture.hx !== undefined && picture.hy !== undefined && row("头", `(${numberText(picture.hx)}, ${numberText(picture.hy)})`)}
        {row("来自", picture.sheet ? code(picture.sheet) : <span className="text-xs text-muted">没记下来（不再用的旧图）</span>)}
        {remake && row("重画", code(remake.draw))}
        {remake && row("重新切", code(remake.cut))}
      </div>
    </Card>
  );
}

function Cursors({ tabs }: { tabs: ReactNode }) {
  const [ground, setGround] = useState<Ground>("check");
  const [query, setQuery] = useState("");
  const cursors = useQuery({
    queryKey: ["cursors"],
    queryFn: async () => {
      const r = await fetch("/cursors/cursors.json");
      return r.ok ? ((await r.json()) as Record<string, { hx: number; hy: number }>) : null;
    },
    staleTime: Infinity,
  });
  const q = query.trim().toLowerCase();
  const all = cursors.data ? Object.entries(cursors.data).filter(([name]) => !q || name.toLowerCase().includes(q)) : undefined;
  return (
    <Layout
      left={
        <Column tabs={tabs}>
          <p className="px-2 pt-1 text-xs text-muted">鼠标在农场里的样子：平时、指着能点的、拿着工具时。</p>
        </Column>
      }
    >
      <Search query={query} onChange={setQuery} placeholder="找：指针的名字（glove、water、harvest……）" ground={ground} onGround={setGround} />
      <Card title={`指针 · ${all?.length ?? 0}`}>
        <p className="text-sm text-muted">
          红点是点下去落在哪。平时是手套，指着能点的伸出食指；拿着工具时是那件工具，能用的带闪光，用不上的带禁止标记。切自
          design/pixel/raw/ui-cursors.png（design/pixel/process.py ui-cursors）。
        </p>
        {cursors.data === null ? (
          <Quiet>这个版本没有带上指针的图（assets/cursors）。</Quiet>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1.5">
            {(all ?? []).map(([name, hot]) => (
              <CursorTile key={name} name={name} hx={hot.hx} hy={hot.hy} ground={ground} />
            ))}
          </div>
        )}
      </Card>
    </Layout>
  );
}

function CursorTile({ name, hx, hy, ground }: { name: string; hx: number; hy: number; ground: Ground }) {
  const [natural, setNatural] = useState<{ w: number; h: number }>();
  const height = 40;
  const k = natural ? height / natural.h : undefined;
  return (
    <div className="flex flex-col items-center gap-1 p-1">
      <span className="flex h-16 w-full items-center justify-center rounded-md" style={groundStyle(ground)}>
        <span className="relative" style={{ height, width: natural && k ? natural.w * k : height }}>
          <img
            src={`/cursors/${name}@2x.png`}
            alt=""
            className="h-10 [image-rendering:pixelated]"
            onError={(e) => (e.currentTarget.src = `/cursors/${name}.png`)}
          />
          <img
            src={`/cursors/${name}.png`}
            alt=""
            className="hidden"
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          {k && <span className="absolute size-2 rounded-full border border-bark-900 bg-berry" style={{ left: hx * k - 4, top: hy * k - 4 }} />}
        </span>
      </span>
      <span className="font-mono text-xs text-muted">{name}</span>
    </div>
  );
}

function Sounds({ tabs }: { tabs: ReactNode }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (group: string, name: SoundName) => !q || [group, name, SOUND_LABEL[name] ?? ""].some((w) => w.toLowerCase().includes(q));
  return (
    <Layout
      left={
        <Column tabs={tabs}>
          <p className="px-2 pt-1 text-xs text-muted">农场里的每个声音，点一下就能听。</p>
        </Column>
      }
    >
      <Search query={query} onChange={setQuery} placeholder="找：声音的名字或分组（浇水、院子、coin……）" />
      <Card>
        <p className="text-sm text-muted">
          音效都是现合成的，没有音频文件：配方在 <code className="font-mono text-[12.5px]">apps/web/src/farm/sound.ts</code>
          。关了音效就听不到。背景音乐还没有，给 Suno 的提示词在 <code className="font-mono text-[12.5px]">design/music/suno-prompts.md</code>。
        </p>
      </Card>
      {SOUND_GROUPS.map((g) => {
        const names = g.names.filter((n) => matches(g.title, n));
        if (names.length === 0) return null;
        return (
          <Card key={g.title} title={g.title}>
            <div className="flex flex-wrap gap-2">
              {names.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-label={`播放 ${SOUND_LABEL[name] ?? name}`}
                  onClick={() => playSound(name)}
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-page pr-3 pl-1.5 hover:bg-hover active:bg-selected"
                >
                  <Icon name="button-play" size={16} />
                  <span className="text-sm font-medium">{SOUND_LABEL[name] ?? name}</span>
                  <span className="font-mono text-xs text-muted">{name}</span>
                </button>
              ))}
            </div>
          </Card>
        );
      })}
    </Layout>
  );
}
