// The phone's button at the HUD's bottom left: it opens and closes the phone, shakes while a call rings, counts the missed
// ones, and says when 田头 has something new while the phone is not unfolded to it. The phone itself is Phone.tsx, over
// the button.

import { Show } from "solid-js";
import { missedOf } from "./calls";
import { phoneCells } from "./cells";
import { playSound } from "../sound";
import { farm } from "../store";
import { aria } from "../../app/util";
import { PixelCard } from "../kit";
import { useFarm } from "../state";
import { phoneState } from "../support";
import { useCore } from "../../data/frame";
import { unreadTotal } from "../../rules/chat";

export function PhoneButton(props: { height: number }) {
  const open = useFarm((s) => s.phoneOpen);
  const phone = phoneState();
  const count = () => missedOf(phone()).length;
  const ringing = () => phone().ringing !== null;
  const core = useCore();
  const unfolded = useFarm((s) => s.chatOpen);
  const unread = () => (unfolded() ? 0 : unreadTotal(core()?.chat));
  return (
    <button
      type="button"
      title="手机"
      aria-label={ringing() ? "手机：来电" : count() > 0 ? `手机，${count()} 个未接来电` : unread() > 0 ? `手机，田头 ${unread()} 条新消息` : "手机"}
      aria-expanded={aria(open())}
      class={["pointer-events-auto relative cursor-pointer", { "phone-shake": ringing() }]}
      onClick={() => {
        playSound("open");
        farm.phoneOpen(!open());
      }}
    >
      <PixelCard
        height={props.height}
        rows={[
          [
            { kind: "glyph", cells: phoneCells(ringing()), px: 20, grid: { w: 10, h: 16 } },
            { kind: "words", text: ringing() ? "来电" : "手机" },
          ],
        ]}
      />
      <Show when={count() > 0}>
        <span class="absolute -top-1.5 -right-1.5 bg-[#c84a3a] px-1 font-pixel text-[10px] leading-[14px] text-[#f7e8c4]">{count()}</span>
      </Show>
      <Show when={count() === 0 && unread() > 0}>
        <span class="absolute -top-1.5 -right-1.5 bg-berry px-1 font-pixel text-[10px] leading-[14px] text-cream-50">新</span>
      </Show>
    </button>
  );
}
