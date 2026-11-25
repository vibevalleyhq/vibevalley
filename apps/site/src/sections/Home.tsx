import { RUNTIMES, WALKERS, avatarArt, engineArt, storyArt, tileArt } from "../base/assets";
import { FACTS } from "../base/facts";
import { backgrounds, screenshotOf } from "../base/images";
import { COMMANDS, NATIVE_SOURCE } from "../base/links";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
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

const paradeTiles = ["t_crop_wheat", "t_crop_sprout", "t_paddy_water", "t_soil_bed", "t_bridge_arch", "t_grass"] as const;
const paradeFront = ["p_bamboo", "p_willow", "p_lantern_post", "p_bamboo", "p_willow"] as const;
const ripe = (count: number, from: number) => Array.from({ length: count }, (_, index) => tileArt((index + from) % 3 === 2 ? "t_crop_sprout" : "t_crop_wheat"));

function tallyArt(art: (typeof FACTS)[number]["art"]): { src: string; framed: boolean } {
  switch (art.kind) {
    case "tile":
      return { src: tileArt(art.name), framed: false };
    case "avatar":
      return { src: avatarArt(art.name), framed: true };
    case "engine":
      return { src: engineArt(art.name), framed: false };
  }
}

export default function Home(props: { copy: Copy }) {
  return (
    <>
      <Bar
        copy={{ home: props.copy.home, title: props.copy.title, nav: props.copy.nav, other: props.copy.other, name: props.copy.hero.name }}
        github={NATIVE_SOURCE}
      />
      <main>
        <Hero copy={props.copy.hero} backgrounds={backgrounds} github={NATIVE_SOURCE} />
        <Parade
          copy={props.copy.parade}
          plots={Array.from({ length: 14 }, (_, index) => {
            const tile = paradeTiles[(index * 5) % paradeTiles.length];
            if (tile === undefined) throw new RangeError(`Missing parade tile at index ${index}`);
            return tileArt(tile);
          })}
          walkers={WALKERS}
          front={Array.from({ length: 10 }, (_, index) => {
            const name = paradeFront[index % paradeFront.length];
            if (name === undefined) throw new RangeError(`Missing parade foreground at index ${index}`);
            return tileArt(name);
          })}
        />
        <Harvest copy={props.copy.harvest} rows={[ripe(16, 0), ripe(12, 1)]} lantern={tileArt("p_lantern_post")} />
        <How copy={props.copy.how} art={storyArt()} />
        <Features
          copy={{ features: props.copy.features, runtimes: props.copy.runtimes }}
          tallies={FACTS.map((fact) => tallyArt(fact.art))}
          runtimes={[...RUNTIMES, { name: props.copy.runtimes.own, logo: engineArt("vibevalley") }]}
        />
        <Devices copy={props.copy.devices} mac={screenshotOf("native-farm")} />
        <Screens copy={props.copy.screens} shots={props.copy.screens.items.map((shot) => ({ ...screenshotOf(shot.image), caption: shot.caption }))} />
        <Start copy={{ start: props.copy.start, safety: props.copy.safety }} commands={COMMANDS} readme={`${NATIVE_SOURCE}#readme`} />
      </main>
      <Foot copy={props.copy} />
    </>
  );
}
