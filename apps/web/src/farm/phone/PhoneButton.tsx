import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { aria } from "#/base/dom.tsx";
import { farm, useFarm } from "#/farm/store.ts";
import { unreadTotal } from "#/features/channel/index.ts";
import { useCore } from "#/infra/frame.ts";
import { PixelCard } from "#/ui/pixel/index.ts";
import { playSound } from "#/ui/pixel/sound.ts";

import { missedOf, phoneState } from "./calls";
import { phoneCells } from "./lcd";

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
      class={[
        "pointer-events-auto relative cursor-pointer",
        ringing() && "[animation-name:shake] motion-reduce:[animation-name:none] [animation-duration:500ms] [animation-iteration-count:infinite]",
      ]}
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
        <span class="absolute -top-1.5 -right-1.5 bg-berry-500 px-1 font-pixel text-[length:10px] leading-2xs text-cream-50">{count()}</span>
      </Show>
      <Show when={count() === 0 && unread() > 0}>
        <span class="absolute -top-1.5 -right-1.5 bg-berry px-1 font-pixel text-[length:10px] leading-2xs text-cream-50">{t("web.farm.phone.new")}</span>
      </Show>
    </button>
  );
}
