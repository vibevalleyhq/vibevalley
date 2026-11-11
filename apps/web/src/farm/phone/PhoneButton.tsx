import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { aria } from "#/base/dom.tsx";
import { phoneAnimations } from "#/farm/interaction.stylex.ts";
import { farm, useFarm } from "#/farm/store.ts";
import { unreadTotal } from "#/features/channel/index.ts";
import { useCore } from "#/infra/frame.ts";
import { PixelCard } from "#/ui/pixel/index.ts";
import { playSound } from "#/ui/pixel/sound.ts";
import { styleProps } from "#/ui/positioner.ts";

import { missedOf, phoneState } from "./calls";
import { phoneCells } from "./lcd";

const viewStyles = stylex.create({
  trigger: { pointerEvents: "auto", position: "relative", cursor: "pointer" },
  phoneButtonSpan: {
    position: "absolute",
    top: "-0.375rem",
    right: "-0.375rem",
    backgroundColor: "var(--color-berry-500)",
    paddingInline: "0.25rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "10px",
    lineHeight: "14px",
    color: "var(--color-cream-50)",
  },
  phoneButtonSpan2: {
    position: "absolute",
    top: "-0.375rem",
    right: "-0.375rem",
    backgroundColor: "var(--color-berry)",
    paddingInline: "0.25rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "10px",
    lineHeight: "14px",
    color: "var(--color-cream-50)",
  },
});

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
      {...styleProps([viewStyles.trigger, ringing() && phoneAnimations.shake])}
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
        <span {...stylex.attrs(viewStyles.phoneButtonSpan)}>{count()}</span>
      </Show>
      <Show when={count() === 0 && unread() > 0}>
        <span {...stylex.attrs(viewStyles.phoneButtonSpan2)}>{t("web.farm.phone.new")}</span>
      </Show>
    </button>
  );
}
