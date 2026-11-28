import { Image, Text, View, type ViewRef } from "nsh";

import { roleAvatarUrl } from "../../design/art";
import { useDesignHost } from "../../design/host";
import { Icon } from "../../design/Icon";
import { useVdpNode } from "../../infra/vdpProbe";

export interface PresenceBadgePeer {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string | undefined;
  readonly status?: string | undefined;
}

export function filterRemotePresences<T extends { readonly id: string }>(peers: readonly T[], localId?: string): T[] {
  return peers.filter((p) => p.id !== localId && !p.id.startsWith("ui:"));
}

function PresenceBadgePill(props: { readonly peer: PresenceBadgePeer; readonly testIdPrefix: string }) {
  const designHost = useDesignHost();
  const assetsDir = designHost.useAssetsDir();
  const avatarSrc = () => {
    const dir = assetsDir();
    return dir !== undefined ? roleAvatarUrl(dir, props.peer.avatar) : undefined;
  };
  let pillRef: ViewRef | undefined;
  useVdpNode({
    testId: `${props.testIdPrefix}-${props.peer.id}`,
    role: "status",
    text: () => (props.peer.status !== undefined && props.peer.status !== "" ? `${props.peer.name}: ${props.peer.status}` : props.peer.name),
    getRef: () => pillRef,
  });

  return (
    <View
      ref={(el) => {
        pillRef = el;
      }}
      testID={`${props.testIdPrefix}-${props.peer.id}`}
      class="flex-row items-center gap-1 rounded-full border border-accent/40 bg-elevated px-1.5 py-0.5 shadow-float"
    >
      <If when={avatarSrc()} else={<Icon name="agents" size={11} tone="accent" />}>
        {(src) => <Image src={src()} class="size-3.5 shrink-0 rounded-full" />}
      </If>
      <Text class="text-2xs font-medium text-ink">{props.peer.name}</Text>
      <If when={props.peer.status !== undefined && props.peer.status !== "" ? props.peer.status : undefined}>
        {(status) => <Text class="text-2xs text-accent">{status()}</Text>}
      </If>
    </View>
  );
}

export function NotePresenceBadges(props: {
  readonly peers: readonly PresenceBadgePeer[];
  readonly testIdPrefix: string;
  readonly class?: string | undefined;
}) {
  return (
    <View class={`flex-row items-center gap-1 ${props.class ?? ""}`}>
      <Each of={props.peers} key={(peer) => peer.id}>
        {(peer) => <PresenceBadgePill peer={peer()} testIdPrefix={props.testIdPrefix} />}
      </Each>
    </View>
  );
}
