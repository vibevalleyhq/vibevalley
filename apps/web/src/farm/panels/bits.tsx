// Small pieces the farm's panels share: tags, tints, an empty note, a said line and its clock, and a harvest's
// line counts, file rows and patch.

import { useState, type CSSProperties, type ReactNode } from "react";
import type { ChangedFile } from "@vibevalley/protocol";
import { changeKind, patchLines, patchMarkOf } from "../../rules/issueState";
import { SpriteIcon } from "../kit";

/** A colour at `alpha` of its strength over cream. */
export const tint = (hex: string, alpha: number) => `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, #f7e8c4)`;

export function FarmTag({ text, fill = "#e2c995", ink = "#46301d", icon, goes }: { text: string; fill?: string; ink?: string; icon?: string; goes?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] whitespace-nowrap" style={{ background: fill, color: ink }}>
      {icon && <SpriteIcon name={icon} size={12} />}
      {text}
      {goes && <SpriteIcon name="button-next" size={10} />}
    </span>
  );
}

export function Tinted({
  children,
  color = "#eedcb2",
  className = "",
  style,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`px-3 py-2 ${className}`} style={{ background: color, ...style }}>
      {children}
    </div>
  );
}

export function FarmEmpty({ text }: { text: string }) {
  return <div className="bg-cream-100 px-4 py-8 text-center text-[13px] text-bark-600">{text}</div>;
}

/** What the server answered, under the button that asked. */
export function Said({ answer }: { answer?: { ok: boolean; text: string } }) {
  if (!answer) return null;
  return <p className={`mt-2 text-[12px] ${answer.ok ? "text-leaf-700" : "text-berry"}`}>{answer.text}</p>;
}

/** Hours and minutes of a time. */
export function clockOf(at: number) {
  const d = new Date(Math.round(at));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function PlusMinus({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-[12.5px] whitespace-nowrap">
      <span className="text-leaf-700">+{added}</span>
      <span className="text-berry"> −{removed}</span>
    </span>
  );
}

const fileLook: Record<string, { fill: string; ink: string }> = {
  A: { fill: "#d0dca9", ink: "#3f6427" },
  M: { fill: "#f0dba9", ink: "#46301d" },
  D: { fill: "#edcba9", ink: "#c84a3a" },
};

const patchInk = { added: "#3f6427", removed: "#c84a3a", hunk: "#4f8fbd", plain: "#46301d" } as const;
const patchFill = { added: "#b4cb7c59", removed: "#c84a3a1a", hunk: undefined, plain: undefined } as const;

export function Patch({ text }: { text: string }) {
  return (
    <div className="mx-2 mb-2 max-h-80 overflow-auto bg-cream-50 py-1">
      {patchLines(text).map((line, i) => {
        const mark = patchMarkOf(line);
        return (
          <div key={i} className="px-2 font-mono text-[12.5px] leading-[1.4] whitespace-pre" style={{ background: patchFill[mark], color: patchInk[mark] }}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

export function FileRow({ file, conflict }: { file: ChangedFile; conflict: boolean }) {
  const [open, setOpen] = useState(false);
  const kind = changeKind(file.status);
  const look = fileLook[file.status] ?? { fill: "#e2c995", ink: "#46301d" };
  const patch = file.patch;
  return (
    <div className="bg-cream-100">
      <button
        type="button"
        aria-label={file.path}
        aria-expanded={patch ? open : undefined}
        disabled={!patch}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left enabled:cursor-pointer enabled:hover:bg-cream-200"
      >
        <span title={kind.label} className="flex h-5 w-5 shrink-0 items-center justify-center text-[12px]" style={{ background: look.fill, color: look.ink }}>
          {kind.mark}
        </span>
        <span title={file.path} className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${conflict ? "text-berry" : "text-bark-800"}`}>
          {file.path}
        </span>
        {conflict && <FarmTag text="冲突" fill={tint("#c84a3a", 0.15)} ink="#c84a3a" />}
        {file.added < 0 ? (
          <span className="font-mono text-[12.5px] text-bark-500">二进制</span>
        ) : (
          <PlusMinus added={Math.round(file.added)} removed={Math.round(file.removed)} />
        )}
      </button>
      {open && patch && <Patch text={patch} />}
    </div>
  );
}
