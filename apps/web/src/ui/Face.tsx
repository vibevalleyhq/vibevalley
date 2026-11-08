import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Look } from "@vibevalley/protocol";

import { orchestratorLookOf } from "#/infra/agents.ts";
import { ready, useAgents, useSprites } from "#/infra/query.ts";

import { castPrefix } from "./cast";
import { RuntimeBadge } from "./RuntimeBadge";

const viewStyles = stylex.create({
  agentFaceWrap: {
    position: "relative",
    display: "inline-block",
    flexShrink: "0",
  },
  agentFaceBox: {
    position: "relative",
    display: "block",
    height: "100%",
    width: "100%",
    overflow: "hidden",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-px-leaf-wash)",
  },
  agentFaceMuted: {
    opacity: ".6",
    filter: "grayscale(100%)",
  },
  agentFaceImg: {
    position: "absolute",
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  orchestratorFaceSpan: {
    position: "relative",
    display: "inline-block",
    flexShrink: "0",
    overflow: "hidden",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "#cfe6f5",
  },
  ownerFaceSpan: {
    display: "inline-flex",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-selected)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
});

/** A helper's head: its attention drawing, cropped to the head, on a leaf green ground. */
export function AgentFace(props: { agentId: string; runtime?: string | undefined; look?: Look | undefined; size?: number; muted?: boolean | undefined }) {
  const sprites = useSprites();
  const size = () => props.size ?? 24;
  const cut = () => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const name = `${castPrefix(props.look, props.agentId, (n) => n in all)}-down`;
    const sp = all[name] ?? all["bear-farmer-down"];
    if (!sp) return undefined;
    const k = size() / (sp.h * 0.5);
    const cx = sp.w / 2;
    const cy = sp.h * 0.25 + sp.h * 0.03;
    return { name, left: size() / 2 - cx * k, top: size() / 2 - cy * k, width: sp.w * k, height: sp.h * k };
  };
  return (
    <span {...stylex.attrs(viewStyles.agentFaceWrap)} style={{ width: `${size()}px`, height: `${size()}px` }}>
      <span {...stylex.attrs(viewStyles.agentFaceBox, props.muted === true && viewStyles.agentFaceMuted)} aria-hidden="true">
        <Show when={cut()}>
          {(c) => (
            <img
              src={`/pixel/${c().name}.png`}
              alt=""
              draggable="false"
              {...stylex.attrs(viewStyles.agentFaceImg)}
              style={{ left: `${c().left}px`, top: `${c().top}px`, width: `${c().width}px`, height: `${c().height}px` }}
            />
          )}
        </Show>
      </span>
      <Show when={props.runtime}>{(runtime) => <RuntimeBadge runtime={runtime()} size={Math.max(10, Math.min(24, Math.round(size() * 0.4)))} />}</Show>
    </span>
  );
}

/** The orchestrator's head (orchestrator-<look>-face; the farmer's until looks are picked). */
/** An orchestrator's head (the default one when agent is none), in its profile's look unless look is given. */
export function OrchestratorFace(props: { size?: number; agent?: string | undefined; look?: string }) {
  const sprites = useSprites();
  const agents = useAgents();
  const size = () => props.size ?? 24;
  const cut = () => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const look = props.look ?? orchestratorLookOf(ready(agents, []), props.agent);
    const name = `manager-${look}-face` in all ? `manager-${look}-face` : "manager-face";
    const sp = all[name];
    if (!sp) return undefined;
    const k = size() / (sp.w * 0.86);
    return { name, left: (size() - sp.w * k) / 2, top: size() * 0.04, width: sp.w * k, height: sp.h * k };
  };
  return (
    <span {...stylex.attrs(viewStyles.orchestratorFaceSpan)} style={{ width: `${size()}px`, height: `${size()}px` }} aria-hidden="true">
      <Show when={cut()}>
        {(c) => (
          <img
            src={`/pixel/${c().name}.png`}
            alt=""
            draggable="false"
            {...stylex.attrs(viewStyles.agentFaceImg)}
            style={{ left: `${c().left}px`, top: `${c().top}px`, width: `${c().width}px`, height: `${c().height}px` }}
          />
        )}
      </Show>
    </span>
  );
}

/** The owner: owner badge in a wheat square. */
export function OwnerFace(props: { size?: number }) {
  return (
    <span
      // The owner is who reads the page: their mark is quiet, the helpers' faces are what is looked for.
      {...stylex.attrs(viewStyles.ownerFaceSpan)}
      style={{ width: `${props.size ?? 24}px`, height: `${props.size ?? 24}px` }}
      aria-hidden="true"
    >
      {t("web.base.owner")}
    </span>
  );
}
