import { Canvas, colorScheme, Image, Path2D, Text, View, type StyleProp, type ViewRef, type ViewStyle } from "nsh";

import { ownerPortraitUrl, roleAvatarUrl } from "../../design/art";
import { defaultWorkerAvatar } from "../../design/domain/avatar";
import { useDesignHost } from "../../design/host";
import { Icon } from "../../design/Icon";
import { mix, tone } from "../../design/tone";
import { useVdpNode } from "../../infra/vdpProbe";

export interface PresenceBadgePeer {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string | undefined;
  readonly color?: string | undefined;
  readonly status?: string | undefined;
  readonly offset?: number | undefined;
}

export function filterRemotePresences<T extends { readonly id: string }>(peers: readonly T[], localId?: string): T[] {
  return peers.filter((p) => p.id !== localId && !p.id.startsWith("ui:"));
}

const CURSOR_ARROW_PATH = "M1.5,1.2 L1.5,15.2 L5.3,11.6 L8.0,16.6 L10.3,15.4 L7.6,10.5 L12.8,10.5 Z";
type PeerTone = "water" | "leaf" | "wheat" | "berry" | "accent";

function resolvePeerTone(raw: string | undefined): PeerTone {
  switch (raw?.trim().toLowerCase()) {
    case "water":
    case "blue":
    case "teal":
      return "water";
    case "leaf":
    case "green":
      return "leaf";
    case "wheat":
    case "amber":
    case "sun":
      return "wheat";
    case "berry":
    case "coral":
    case "peach":
    case "red":
      return "berry";
    default:
      return "accent";
  }
}

export function CollaboratorCursor(props: {
  readonly peer: PresenceBadgePeer;
  readonly testIdPrefix: string;
  readonly class?: string | undefined;
  readonly style?: StyleProp<ViewStyle> | undefined;
}) {
  const designHost = useDesignHost();
  const assetsDir = designHost.useAssetsDir();
  const peerTone = () => resolvePeerTone(props.peer.color);
  const avatarSrc = () => {
    const dir = assetsDir();
    if (dir === undefined) return undefined;
    if (props.peer.avatar === "user") return ownerPortraitUrl(dir);
    return roleAvatarUrl(dir, props.peer.avatar) ?? roleAvatarUrl(dir, defaultWorkerAvatar(props.peer.id, props.peer.name));
  };
  const statusText = () => {
    const raw = props.peer.status?.trim();
    return raw !== undefined && raw !== "" ? raw : undefined;
  };
  let rootRef: ViewRef | undefined;
  useVdpNode({
    testId: `${props.testIdPrefix}-${props.peer.id}`,
    role: "status",
    text: () => {
      const st = statusText();
      return st !== undefined ? `${props.peer.name}: ${st}` : props.peer.name;
    },
    getRef: () => rootRef,
  });

  return (
    <View
      ref={(el) => {
        rootRef = el;
      }}
      testID={`${props.testIdPrefix}-${props.peer.id}`}
      class={`items-start ${props.class ?? ""}`}
      style={props.style}
    >
      <Canvas
        class="h-4.5 w-4 shrink-0"
        draw={(cx) => {
          colorScheme();
          const fill = tone(peerTone());
          const outline = tone("page");
          const pointer = new Path2D(CURSOR_ARROW_PATH);
          cx.lineJoin = "round";
          cx.lineWidth = 1.6;
          cx.strokeStyle = outline;
          cx.stroke(pointer);
          cx.fillStyle = fill;
          cx.fill(pointer);
        }}
      />
      <View
        class="ml-2 -mt-0.5 flex-row items-center gap-1.5 rounded-full border bg-elevated py-0.5 pr-2.5 pl-1 shadow-float"
        style={{ borderColor: mix(peerTone(), 0.5) }}
      >
        <If when={avatarSrc()} else={<Icon name="agents" size={14} tone={peerTone()} />}>
          {(src) => <Image src={src()} class="size-5 shrink-0 rounded-full bg-avatar-paper" />}
        </If>
        <Text class="text-xs font-semibold text-ink">{props.peer.name}</Text>
        <If when={statusText()}>
          {(st) => (
            <Text class="text-xs font-medium" style={{ color: tone(peerTone()) }}>
              {st()}
            </Text>
          )}
        </If>
      </View>
    </View>
  );
}
