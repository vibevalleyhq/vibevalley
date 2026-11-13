// ApprovalCard: one permission request of an agent, shown before the agent
// may go on: which tool, what it touches, a preview of exactly what it will
// run or change, and two answers (Approve, Deny) with ⌘↩ and ⌘⌫.
//
// Designed from the public description of affectUI's Approval Card (Pro)
// in docs/design/components.md section 5; no Pro source was read or copied.
// Built from VibeValley's own parts (ToolCallCard's tile and code section,
// DecisionInbox's buttons) and the shared tokens.
import { announce, createMotion, effect, keymap, reduceMotion, signal, Text, View } from "nsh";

import { durations } from "../motion";
import { cardShadow, radius, tok, type as ty } from "../tokens";
import { PrimaryButton, SecondaryButton } from "./DecisionInbox";
import type { AgentEvent, PermissionDecision } from "./shapes";
import { CodeSection, IconTile, toolGlyph } from "./ToolCallCard";

export type ApprovalRequest = {
  requestId: string;
  tool: string;
  /** The agent's own line: "Run: cargo test". */
  summary: string;
  input: unknown;
  atMs: number;
  /** Who asks: the session's name. */
  who?: string | null;
};

export type ApprovalCardProps = {
  request: ApprovalRequest | null;
  onDecide: (request: ApprovalRequest, decision: PermissionDecision) => void;
  /** Binds ⌘↩ and ⌘⌫ while true (the focused or only card). Default true. */
  shortcuts?: boolean;
};

/** The oldest unanswered permission request of an event stream. */
export function pendingApproval(events: AgentEvent[], who?: string): ApprovalRequest | null {
  const open = new Map<string, ApprovalRequest>();
  for (const e of events) {
    const k = e.kind;
    if (k.type === "permission_requested") {
      open.set(k.request_id, { requestId: k.request_id, tool: k.tool, summary: k.summary, input: k.input, atMs: e.at_ms, who });
    } else if (k.type === "permission_resolved") open.delete(k.request_id);
  }
  return open.values().next().value ?? null;
}

/** Where the request points: a working directory, a path, a URL. */
export function targetOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  for (const key of ["cwd", "file_path", "path", "url"]) if (typeof o[key] === "string") return o[key] as string;
  if (o.changes && typeof o.changes === "object") {
    const paths = Array.isArray(o.changes)
      ? o.changes.map((c) => (c && typeof c === "object" ? String((c as Record<string, unknown>).path ?? "") : "")).filter(Boolean)
      : Object.keys(o.changes);
    if (paths.length) return paths.join(", ");
  }
  return null;
}

/** What the preview shows: a command as itself, anything else as JSON. */
function previewOf(input: unknown): unknown {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
    if (typeof o.new_string === "string") return o.new_string;
    if (typeof o.content === "string") return o.content;
  }
  return input;
}

function Key(props: { label: string }) {
  const p = () => tok();
  return (
    <Text
      accessibilityElementsHidden
      style={{
        ...ty.label,
        fontSize: 11,
        color: p().muted,
        paddingHorizontal: 5,
        borderRadius: 4,
        backgroundColor: p().tile,
        borderWidth: 1,
        borderColor: p().border,
        fontVariant: ["tabular-nums"],
      }}
    >
      {props.label}
    </Text>
  );
}

export function ApprovalCard(props: ApprovalCardProps) {
  const p = () => tok();
  const decided = signal<{ id: string; text: string; ok: boolean } | null>(null);
  const current = () => (decided()?.id === props.request?.requestId ? decided() : null);
  const decide = (decision: PermissionDecision) => {
    const r = props.request;
    if (!r || current()) return;
    const ok = decision !== null && typeof decision === "string";
    const text = ok ? "Approved" : "Denied";
    decided.set({ id: r.requestId, text, ok });
    announce(`${text}: ${r.summary}`);
    props.onDecide(r, decision);
  };
  effect(() => {
    if (props.shortcuts === false || !props.request) return;
    keymap.bind({
      "mod+enter": () => decide("AllowOnce"),
      "mod+backspace": () => decide({ Deny: { message: null } }),
    });
  });
  const swap = createMotion();
  effect(() => {
    if (current() && !reduceMotion()) void swap.play({ duration: durations.statusSwap, keyframes: { opacity: [0, 1], translateY: [3, 0] } });
  });
  const approve = keymap.label("mod+enter");
  const deny = keymap.label("mod+backspace");
  return (
    <If
      when={props.request}
      else={
        <Text testID="approval-empty" style={{ ...ty.body, fontSize: 13, color: p().muted, paddingVertical: 12 }}>
          Permission requests from your agents will appear here.
        </Text>
      }
    >
      {(r) => (
        <View
          testID="approval-card"
          accessibilityLabel={`${r().who ?? r().tool} asks: ${r().summary}`}
          style={{ borderRadius: radius.card, backgroundColor: p().surface, boxShadow: cardShadow(p()), padding: 14, gap: 12 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 26 }}>
            <IconTile glyph={toolGlyph(r().tool)} />
            <Text style={{ ...ty.mono, color: p().ink, numberOfLines: 1, flexShrink: 0, maxWidth: 180 }}>{r().tool}</Text>
            <Text style={{ ...ty.body, color: p().text, flex: 1, minWidth: 0, numberOfLines: 1 }}>
              {r().who ? `${r().who} asks to go on` : "asks to go on"}
            </Text>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: current() ? (current()!.ok ? p().ok : p().danger) : p().alert }} />
          </View>
          <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: "500", color: p().ink, writingDirection: "auto" }}>{r().summary}</Text>
          {targetOf(r().input) ? (
            <Text style={{ ...ty.label, color: p().muted, numberOfLines: 2, writingDirection: "auto" }}>{targetOf(r().input)}</Text>
          ) : null}
          <CodeSection label="Preview" value={previewOf(r().input)} testID="approval-preview" />
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, minHeight: 30 }}>
            {current() ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, ...swap.style }}>
                <Text style={{ fontSize: 13, color: current()!.ok ? p().ok : p().danger }}>{current()!.ok ? "✓" : "✕"}</Text>
                <Text style={{ fontSize: 13, lineHeight: 20, fontWeight: "500", color: current()!.ok ? p().ok : p().danger }}>{current()!.text}</Text>
              </View>
            ) : (
              <>
                <PrimaryButton label="Approve" onPress={() => decide("AllowOnce")} testID="approve" />
                <SecondaryButton label="Deny" onPress={() => decide({ Deny: { message: null } })} testID="deny" />
                <View style={{ flexDirection: "row", gap: 6, alignItems: "center", marginLeft: "auto" }}>
                  <Key label={approve} />
                  <Text style={{ ...ty.label, color: p().faint }}>approve</Text>
                  <Key label={deny} />
                  <Text style={{ ...ty.label, color: p().faint }}>deny</Text>
                </View>
              </>
            )}
          </View>
        </View>
      )}
    </If>
  );
}
