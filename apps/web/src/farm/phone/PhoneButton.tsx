// The phone's button at the HUD's bottom left: it opens and closes the phone,
// shakes while a call rings, and counts the missed ones. The phone itself is Phone.tsx, over the button.

import type { GlyphCell } from "../kit";
import { cx, PixelCard } from "../kit";
import { playSound } from "../sound";
import { farm, useFarm } from "../store";
import { missedOf, usePhone } from "./calls";

/** The phone, drawn in cells on a 10 × 16 grid; lit while it rings. */
export const phoneCells = (lit: boolean): GlyphCell[] => [
  [1, 0, 8, 16, "#2f1f13"],
  [2, 1, 6, 14, "#67482d"],
  [3, 2, 4, 5, lit ? "#b4e07a" : "#9fb07a"],
  [3, 9, 1, 1, "#e2c995"],
  [5, 9, 1, 1, "#e2c995"],
  [3, 11, 1, 1, "#e2c995"],
  [5, 11, 1, 1, "#e2c995"],
  [3, 13, 3, 1, "#e2c995"],
  [8, 1, 1, 3, "#2f1f13"],
  ...(lit ? ([[9, 0, 1, 1, "#c84a3a"]] as GlyphCell[]) : []),
];

export function PhoneButton({ height }: { height: number }) {
  const open = useFarm((s) => s.phoneOpen);
  const phone = usePhone();
  const count = missedOf(phone).length;
  const ringing = phone.ringing !== null;
  return (
    <button
      type="button"
      title="手机"
      aria-label={ringing ? "手机：来电" : count > 0 ? `手机，${count} 个未接来电` : "手机"}
      aria-expanded={open}
      className={cx("pointer-events-auto relative cursor-pointer", ringing && "phone-shake")}
      onClick={() => {
        playSound("open");
        farm.phoneOpen(!open);
      }}
    >
      <PixelCard
        height={height}
        rows={[
          [
            { kind: "glyph", cells: phoneCells(ringing), px: 20, grid: { w: 10, h: 16 } },
            { kind: "words", text: ringing ? "来电" : "手机" },
          ],
        ]}
      />
      {count > 0 && <span className="absolute -top-1.5 -right-1.5 bg-[#c84a3a] px-1 font-pixel text-[10px] leading-[14px] text-[#f7e8c4]">{count}</span>}
    </button>
  );
}
