import { computed, Image, pixelRatio, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator, type Look, type UserProfile } from "@vibevalley/protocol";

import { orchestratorLookOf } from "../../infra/agents";
import { useAttachmentUrl } from "../../infra/attachmentFile";
import { ready, useAgents, useSettings } from "../../infra/query";
import { orchestratorPortraitUrl, ownerPortraitUrl, ROLE_AVATARS, roleAvatarUrl, speciesPortraitUrl, useAssetsDir } from "../art";
import { tone } from "../tone";
import { castOf, hexColor, orchestratorLooks } from "./cast";
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

/** A square Papertrails portrait clipped to rounded cardstock corners. */
function Portrait(props: { size: number; src: string; class?: string; ground?: string; muted?: boolean | undefined }) {
  return (
    <View
      class={`shrink-0 overflow-hidden rounded-sm ${props.class ?? ""}`}
      style={{ width: props.size, height: props.size, backgroundColor: props.ground, opacity: props.muted === true ? 0.6 : 1 }}
    >
      <Image src={props.src} style={{ width: props.size, height: props.size, objectFit: "cover" }} />
    </View>
  );
}

/** A helper's portrait: its Papertrails role avatar if chosen, else its species portrait. */
export function AgentFace(props: {
  agentId: string;
  runtime?: string | undefined;
  look?: Look | undefined;
  size?: number;
  muted?: boolean | undefined;
  name?: string;
}) {
  const assetsDir = useAssetsDir();
  const agents = useAgents();
  const size = () => props.size ?? 24;
  const src = computed(() => {
    const dir = assetsDir();
    if (!dir) return undefined;
    const roleUrl = roleAvatarUrl(dir, props.look?.avatar);
    if (roleUrl) return roleUrl;
    const { species } = castOf(props.look, props.agentId);
    return speciesPortraitUrl(dir, species);
  });
  const name = computed(() => props.name ?? ready(agents, []).find((a) => a.id === props.agentId)?.name ?? props.agentId);
  const ground = () => (props.look?.hat ? toward(hexColor(props.look.hat), 0.6) : tone("avatar-leaf"));
  return (
    <View class="shrink-0" style={{ width: size(), height: size() }}>
      <If when={src()} else={<Initial size={size()} letter={initialOf(name())} ground={ground()} muted={props.muted} />}>
        {(url) => <Portrait size={size()} src={url()} class="bg-avatar-paper" muted={props.muted} />}
      </If>
      <If when={props.runtime}>{(runtime) => <RuntimeBadge runtime={runtime()} size={Math.max(10, Math.min(24, Math.round(size() * 0.4)))} />}</If>
    </View>
  );
}

/** An orchestrator's portrait, preferring an explicit or profile role avatar before its Papertrails manager look. */
export function OrchestratorFace(props: { size?: number; agent?: string | undefined; look?: string; avatar?: string | undefined }) {
  const assetsDir = useAssetsDir();
  const agents = useAgents();
  const size = () => props.size ?? 24;
  const src = computed(() => {
    const dir = assetsDir();
    if (!dir) return undefined;
    const candidate =
      props.avatar ?? (props.look === undefined ? ready(agents, []).find((a) => a.id === (props.agent ?? defaultOrchestrator))?.look.avatar : undefined);
    const roleUrl = roleAvatarUrl(dir, candidate);
    if (roleUrl) return roleUrl;
    const look = props.look ?? orchestratorLookOf(ready(agents, []), props.agent);
    if (size() <= 40) {
      return orchestratorPortraitUrl(dir, look, pixelRatio() >= 2 ? 2 : 1);
    }
    return orchestratorPortraitUrl(dir, look);
  });
  const letter = computed(() => {
    const agent = props.look === undefined ? ready(agents, []).find((a) => a.id === (props.agent ?? defaultOrchestrator)) : undefined;
    return initialOf(agent?.name ?? orchestratorLooks.find((l) => l.id === (props.look ?? "farmer"))?.name ?? "?");
  });
  return (
    <If when={src()} else={<Initial size={size()} letter={letter()} ground={tone("avatar-sky")} />}>
      {(url) => <Portrait size={size()} src={url()} class="bg-avatar-paper" />}
    </If>
  );
}

export const USER_AVATAR_PRESETS = ["user", ...ROLE_AVATARS] as const;

function resolvePresetAvatarUrl(dir: string | undefined, preset: string | undefined): string | undefined {
  if (!dir) return undefined;
  if (preset === "monogram") return undefined;
  if (!preset || preset === "user") return ownerPortraitUrl(dir);
  return roleAvatarUrl(dir, preset) ?? ownerPortraitUrl(dir);
}

function userMonogram(profile: UserProfile | undefined): string {
  const name = profile?.displayName?.trim();
  if (name) return initialOf(name);
  return initialOf(t("web.base.user"));
}

/** The user's avatar: uploaded attachment first, then preset Papertrails portrait, else monogram badge. */
export function UserAvatar(props: {
  size?: number | undefined;
  profile?: UserProfile | undefined;
  class?: string | undefined;
  rounded?: "sm" | "full" | undefined;
}) {
  const settings = useSettings();
  const assetsDir = useAssetsDir();
  const size = () => props.size ?? 24;
  const profile = computed(() => props.profile ?? ready(settings, undefined)?.profile);
  const attachmentUrl = useAttachmentUrl(() => profile()?.avatarAttachmentId ?? "");
  const src = computed(() => {
    const custom = attachmentUrl();
    if (custom) return custom;
    return resolvePresetAvatarUrl(assetsDir(), profile()?.avatarPreset);
  });
  const shapeClass = () => (props.rounded === "full" ? "rounded-full" : "rounded-sm");
  return (
    <If
      when={src()}
      else={
        <View class={`shrink-0 items-center justify-center bg-selected ${shapeClass()} ${props.class ?? ""}`} style={{ width: size(), height: size() }}>
          <Text class="font-semibold text-ink" style={{ fontSize: Math.max(10, Math.round(size() * 0.44)), lineHeight: size() }}>
            {userMonogram(profile())}
          </Text>
        </View>
      }
    >
      {(url) => <Portrait size={size()} src={url()} class={`bg-avatar-paper ${shapeClass()} ${props.class ?? ""}`} />}
    </If>
  );
}

/** The user: configured avatar or courtyard portrait when assets are available, else a compact badge. */
export function UserFace(props: { size?: number }) {
  return <UserAvatar size={props.size} />;
}
