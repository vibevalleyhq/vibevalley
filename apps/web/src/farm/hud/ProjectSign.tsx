import { t } from "@vibevalley/i18n";
// The project sign by the mast: whose farm this is (every plot here is that project's); a click goes back to the
// projects' map to enter another island.

import { Show } from "solid-js";
import { useRouter } from "@/base/router";
import { playSound } from "@/ui/pixel/sound";
import { useFarm } from "@/farm/ui";

/** Where the sign's post stands, in the village's pixels: on the grass right of the mast (village.ldtk: its top at 18, 73). */
const signFoot = { x: 44, y: 104 };

export function ProjectSign() {
  const screen = useFarm((s) => s.screen);
  const project = useFarm((s) => s.project);
  const router = useRouter();
  const foot = () => screen()?.toScreen(signFoot);
  return (
    <Show when={foot()}>
      {(at) => (
        <button
          type="button"
          data-testid="project-sign"
          data-key={project()}
          aria-label={t("web.farm.sign.label", { project: project() || t("web.farm.sign.noProject") })}
          title={t("web.farm.sign.hint")}
          onClick={() => {
            playSound("open");
            router.navigate("/projects");
          }}
          class="pointer-events-auto absolute flex -translate-x-1/2 -translate-y-full cursor-pointer flex-col items-center font-pixel hover:brightness-110"
          style={{ left: `${at().x}px`, top: `${at().y}px` }}
        >
          <span class="flex max-w-40 flex-col items-center border-2 border-bark-900 bg-bark-500 px-2.5 py-1 text-cream-50 shadow-px-shade">
            <span class="text-[10px] leading-3 text-cream-200">{t("web.farm.sign.project")}</span>
            <span class="max-w-full truncate text-[13px] leading-4">{project() || t("web.farm.sign.noProject")}</span>
          </span>
          <span class="w-1.5 bg-bark-900" style={{ height: `${Math.round((screen()?.scale ?? 3) * 5)}px` }} />
        </button>
      )}
    </Show>
  );
}
