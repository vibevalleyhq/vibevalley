import { Image, pixelRatio, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator, type Look } from "@vibevalley/protocol";

import { orchestratorLooks } from "../../features/orchestrator/looks";
import { orchestratorLookOf } from "../../infra/agents";
import { ready, useAgents, useSprites } from "../../infra/query";
import { useSpriteUrl } from "../pixel/atlas";
import { tone } from "../tone";
import { castPrefix, hexColor } from "./cast";
import { initialOf, RuntimeBadge } from "./RuntimeBadge";

/** `hex` moved `part` of the way to white. */
const toward = (hex: string, part: number) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) =>
    Math.round(v + (255 - v) * part)
      .toString(16)
      .padStart(2, "0");
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
};

function Initial(props: { size: number; letter: string; ground: string; muted?: boolean | undefined }) {
  return (
    <View
      class="items-center justify-center overflow-hidden rounded-full"
      style={{ width: props.size, height: props.size, backgroundColor: props.ground, opacity: props.muted === true ? 0.6 : 1 }}
    >
      <Text class="font-semibold text-bark-900" style={{ fontSize: Math.max(8, Math.round(props.size * 0.46)), lineHeight: props.size }}>
        {props.letter}
      </Text>
    </View>
  );
}

interface Cut {
  readonly src: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The part of a sprite a face shows, in a clipping square. */
function Crop(props: { size: number; cut: Cut; class?: string; ground?: string; muted?: boolean | undefined }) {
  return (
    <View
      class={`shrink-0 overflow-hidden rounded-sm ${props.class ?? ""}`}
      style={{ width: props.size, height: props.size, backgroundColor: props.ground, opacity: props.muted === true ? 0.6 : 1 }}
    >
      <Image src={props.cut.src} style={{ position: "absolute", left: props.cut.left, top: props.cut.top, width: props.cut.width, height: props.cut.height }} />
    </View>
  );
}

/** A helper's head: its role portrait if chosen, else its farm sprite cropped to the head on a leaf green ground. */
export function AgentFace(props: {
  agentId: string;
  runtime?: string | undefined;
  look?: Look | undefined;
  size?: number;
  muted?: boolean | undefined;
  name?: string;
}) {
  const sprites = useSprites();
  const agents = useAgents();
  const url = useSpriteUrl();
  const size = () => props.size ?? 24;
  const avatarSprite = () => {
    const all = ready(sprites, undefined);
    const avatar = props.look?.avatar;
    return all && avatar && avatar in all ? avatar : undefined;
  };
  const cut = (): Cut | undefined => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const avatar = avatarSprite();
    if (avatar) {
      const src = url(avatar);
      return src ? { src, left: 0, top: 0, width: size(), height: size() } : undefined;
    }
    const name = `${castPrefix(props.look, props.agentId, (n) => n in all)}-down`;
    const found = Object.hasOwn(all, name) ? name : "bear-farmer-down";
    const sp = Object.hasOwn(all, found) ? all[found] : undefined;
    const src = url(found);
    if (!sp || !src) return undefined;
    const k = size() / (sp.h * 0.5);
    const cx = sp.w / 2;
    const cy = sp.h * 0.25 + sp.h * 0.03;
    return { src, left: size() / 2 - cx * k, top: size() / 2 - cy * k, width: sp.w * k, height: sp.h * k };
  };
  const name = () => props.name ?? ready(agents, []).find((a) => a.id === props.agentId)?.name ?? props.agentId;
  // The hat's colour lightened toward paper, opaque so the letter reads in both themes; the leaf wash without a hat.
  const ground = () => (props.look?.hat ? toward(hexColor(props.look.hat), 0.6) : tone("avatar-leaf"));
  return (
    <View class="shrink-0" style={{ width: size(), height: size() }}>
      <If when={cut()} else={<Initial size={size()} letter={initialOf(name())} ground={ground()} muted={props.muted} />}>
        {(c) => <Crop size={size()} cut={c()} class={avatarSprite() ? "bg-side" : "bg-px-leaf-wash"} muted={props.muted} />}
      </If>
      <If when={props.runtime}>{(runtime) => <RuntimeBadge runtime={runtime()} size={Math.max(10, Math.min(24, Math.round(size() * 0.4)))} />}</If>
    </View>
  );
}

/** An orchestrator's head (the default one when agent is none), preferring an explicit or profile role portrait before manager-<look>. */
export function OrchestratorFace(props: { size?: number; agent?: string | undefined; look?: string; avatar?: string | undefined }) {
  const sprites = useSprites();
  const agents = useAgents();
  const url = useSpriteUrl();
  const size = () => props.size ?? 24;
  const avatarSprite = () => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const candidate =
      props.avatar ?? (props.look === undefined ? ready(agents, []).find((a) => a.id === (props.agent ?? defaultOrchestrator))?.look.avatar : undefined);
    return candidate && candidate in all ? candidate : undefined;
  };
  const cut = (): Cut | undefined => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const avatar = avatarSprite();
    if (avatar) {
      const src = url(avatar);
      return src ? { src, left: 0, top: 0, width: size(), height: size() } : undefined;
    }
    const look = props.look ?? orchestratorLookOf(ready(agents, []), props.agent);
    const name = `manager-${look}-face` in all ? `manager-${look}-face` : "manager-face";
    const sp = Object.hasOwn(all, name) ? all[name] : undefined;
    if (!sp) return undefined;
    const dpr = pixelRatio();
    if (sp.railSize === size() && (dpr === 1 || dpr === 2)) {
      const src = url(`rail/${name}-${dpr}x`);
      return src ? { src, left: 0, top: 0, width: size(), height: size() } : undefined;
    }
    const src = url(name);
    if (!src) return undefined;
    const k = size() / (sp.w * 0.86);
    return { src, left: (size() - sp.w * k) / 2, top: size() * 0.04, width: sp.w * k, height: sp.h * k };
  };
  const letter = () => {
    const agent = props.look === undefined ? ready(agents, []).find((a) => a.id === (props.agent ?? defaultOrchestrator)) : undefined;
    return initialOf(agent?.name ?? orchestratorLooks.find((l) => l.id === (props.look ?? "farmer"))?.name ?? "?");
  };
  return (
    <If when={cut()} else={<Initial size={size()} letter={letter()} ground={tone("avatar-sky")} />}>
      {(c) => (avatarSprite() ? <Crop size={size()} cut={c()} class="bg-side" /> : <Crop size={size()} cut={c()} ground={tone("avatar-sky")} />)}
    </If>
  );
}

/** The user: user badge in a wheat square. */
export function UserFace(props: { size?: number }) {
  return (
    <View class="shrink-0 items-center justify-center rounded-sm bg-selected" style={{ width: props.size ?? 24, height: props.size ?? 24 }}>
      <Text class="text-xs font-semibold text-muted">{t("web.base.user")}</Text>
    </View>
  );
}
