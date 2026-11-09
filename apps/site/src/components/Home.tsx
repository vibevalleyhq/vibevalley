/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { RUNTIMES, WALKERS, pixelArt, storyArt } from "../lib/assets";
import { FACTS } from "../lib/facts";
import { backgrounds, screenshotOf, titleArt } from "../lib/images";
import { COMMANDS, GITHUB } from "../lib/links";
import { FRONT } from "../lib/scene";
import Bar from "./Bar";
import Devices from "./Devices";
import Features from "./Features";
import Foot from "./Foot";
import Harvest from "./Harvest";
import Hero from "./Hero";
import How from "./How";
import Parade from "./Parade";
import Screens from "./Screens";
import Start from "./Start";

const field = ["plot-wheat", "plot-carrot", "plot-leafy", "plot-flowering", "plot-sprout", "plot-seeded"];
const ripe = (count: number, from: number) => Array.from({ length: count }, (_, index) => pixelArt((index + from) % 3 === 2 ? "plot-carrot" : "plot-wheat"));

export default function Home(props: { copy: Copy }) {
  return (
    <>
      <Bar
        copy={{ home: props.copy.home, title: props.copy.title, nav: props.copy.nav, other: props.copy.other, name: props.copy.hero.name }}
        github={GITHUB}
      />
      <main>
        <Hero
          copy={props.copy.hero}
          art={titleArt}
          backgrounds={backgrounds}
          hint={pixelArt("button-next")}
          frame={{
            branchLeft: pixelArt("fg-branch-left"),
            branchRight: pixelArt("fg-branch-right"),
            bushLeft: pixelArt("fg-bush-left"),
            bushRight: pixelArt("fg-bush-right"),
          }}
          github={GITHUB}
        />
        <Parade
          copy={props.copy.parade}
          plots={Array.from({ length: 16 }, (_, index) => {
            const plot = field[(index * 5) % field.length];
            if (plot === undefined) throw new RangeError(`Missing parade plot at index ${index}`);
            return pixelArt(plot);
          })}
          walkers={WALKERS.map((walker) => walker.frames)}
          front={Array.from({ length: 12 }, (_, index) => {
            const name = FRONT[index % FRONT.length];
            if (name === undefined) throw new RangeError(`Missing parade foreground at index ${index}`);
            const image = titleArt[name];
            if (image === undefined) throw new Error(`Missing parade foreground image ${name}`);
            return image;
          })}
        />
        <Harvest
          copy={props.copy.harvest}
          rows={[ripe(18, 0), ripe(14, 1)]}
          coins={pixelArt("coins-stack")}
          icons={{ harvest: pixelArt("icon-harvest"), check: pixelArt("mark-check") }}
        />
        <How copy={props.copy.how} icons={props.copy.how.steps.map((step) => pixelArt(step.icon))} art={storyArt()} />
        <Features
          copy={{ features: props.copy.features, runtimes: props.copy.runtimes }}
          icons={props.copy.features.items.map((feature) => pixelArt(feature.icon))}
          tallies={FACTS.map((fact) => pixelArt(fact.icon))}
          runtimes={[
            ...RUNTIMES.map((runtime) => ({ name: runtime.name, logo: pixelArt(runtime.logo) })),
            { name: props.copy.runtimes.own, logo: pixelArt("app-sprout") },
          ]}
        />
        <Devices copy={props.copy.devices} mac={screenshotOf("farm")} phones={[screenshotOf("phone-chat"), screenshotOf("phone-issues")]} />
        <Screens
          copy={props.copy.screens}
          shots={props.copy.screens.items.map((shot) => ({ ...screenshotOf(shot.image), caption: shot.caption }))}
          close={pixelArt("button-close")}
        />
        <Start
          copy={{ start: props.copy.start, safety: props.copy.safety }}
          commands={COMMANDS}
          readme={`${GITHUB}#readme`}
          icons={{ warn: pixelArt("mark-warn"), check: pixelArt("mark-check"), copy: pixelArt("button-copy") }}
        />
      </main>
      <Foot copy={props.copy} />
    </>
  );
}
