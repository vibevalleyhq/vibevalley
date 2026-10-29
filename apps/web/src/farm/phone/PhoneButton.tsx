import { t } from "@vibevalley/i18n";
// The phone's button at the HUD's bottom left: it opens and closes the phone, shakes while a call rings, counts the missed
// ones, and says when 田头 has something new while the phone is not unfolded to it. The phone itself is Phone.tsx, over
// the button.

import { Show } from "solid-js";
import { missedOf } from "./calls";
import { phoneCells } from "./cells";
import { playSound } from "@/ui/pixel/sound";
import { farm } from "@/farm/store";
import { aria } from "@/base/util";
import { PixelCard } from "@/ui/pixel";
import { useFarm } from "@/farm/state";
import { phoneState } from "@/farm/support";
import { useCore } from "@/base/frame";
import { unreadTotal } from "@/features/channel";

export function PhoneButton(props: { height: number }) {
  const open = useFarm((s) => s.phoneOpen);
  const phone = phoneState();
  const count = () => missedOf(phone()).length;
  const ringing = () => phone().ringing !== undefined;
  const core = useCore();
  const unfolded = useFarm((s) => s.chatOpen);
  const unread = () => (unfolded() ? 0 : unreadTotal(core()?.chat));
  return (
    <button
      type="button"
      data-testid="phone-button"
      data-state={ringing() ? "ringing" : count() > 0 ? "missed" : unread() > 0 ? "unread" : "idle"}
      title={t("web.farm.phone.phone")}
      aria-label={
        ringing()
          ? t("web.farm.phone.phoneRinging")
          : count() > 0
            ? t("web.farm.phone.phoneMissed", { n: count() })
            : unread() > 0
              ? t("web.farm.phone.phoneUnread", { n: unread() })
              : t("web.farm.phone.phone")
      }
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
            { kind: "words", text: ringing() ? t("web.farm.phone.ring") : t("web.farm.phone.phone") },
          ],
        ]}
      />
      <Show when={count() > 0}>
        <span class="absolute -top-1.5 -right-1.5 bg-berry-500 px-1 font-pixel text-[10px] leading-[14px] text-cream-50">{count()}</span>
      </Show>
      <Show when={count() === 0 && unread() > 0}>
        <span class="absolute -top-1.5 -right-1.5 bg-berry px-1 font-pixel text-[10px] leading-[14px] text-cream-50">{t("web.farm.phone.new")}</span>
      </Show>
    </button>
  );
}
