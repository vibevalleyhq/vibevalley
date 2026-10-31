import { Schema } from "effect";
import { createEffect, createSignal, For, Show } from "solid-js";
// The title's picture, alive: the scene on a stage kept at its own 3:2 and covering the screen, slowly panning; on it,
// in the scene's own coordinates (farm/title/layers.ts), clouds, chimney smoke, swaying plants, seeds off the
// dandelions, fireflies at dusk and night, and on the hill the farmer (breathing; a lantern at night) with the chosen
// pet. The motions are style.css's title-*.

import { TitleManifest } from "@/base/manifests";
import { ready, useQuery } from "@/infra/query";
import { usePrefs } from "@/state/prefs";

import {
  chimney,
  clouds,
  light,
  orchestrator,
  orchestratorPose,
  type PetFrame,
  petRound,
  petScale,
  petSpot,
  plants,
  puffSeconds,
  puffs,
  seeds,
  spriteOf,
  type TitleSprites,
} from "./layers";
import { motesOf, type TitleScene, titleBackground } from "./scene";

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

/** The puffs leave the chimney one after another through the round. */
const timing = (i: number) => `${-(i * puffSeconds) / puffs.length}s`;

export function TitleStage(props: { scene: TitleScene }) {
  const sizesQuery = useQuery(() => ({
    queryKey: ["title-sprites"],
    queryFn: async () => Schema.decodeUnknownSync(TitleManifest)(await (await fetch("/title/sprites.json")).json()),
    staleTime: Infinity,
  }));
  const lit = () => light[props.scene];
  return (
    <div aria-hidden="true" class="title-stage">
      <div class="title-bg absolute inset-0">
        <img src={titleBackground(props.scene)} alt="" draggable="false" class="absolute inset-0 h-full w-full [image-rendering:pixelated]" />
        <Show when={ready(sizesQuery, undefined)}>
          {(sizes) => (
            <>
              <For each={clouds}>
                {(c) => {
                  const s = () => spriteOf(sizes(), c.sprite, c.scale);
                  return (
                    <span class="title-drift title-cloud" style={{ "animation-duration": `${c.duration}s`, "animation-delay": `${c.delay}s` }}>
                      <img
                        src={s().src}
                        alt=""
                        class="absolute left-0 [image-rendering:pixelated]"
                        style={{ top: pct(c.y), width: pct(s().w), filter: lit().sky }}
                      />
                    </span>
                  );
                }}
              </For>
              <For each={puffs}>
                {(puff, i) => {
                  const s = () => spriteOf(sizes(), puff.sprite, puff.scale);
                  return (
                    <span class="title-drift title-puff" style={{ "animation-duration": `${puffSeconds}s`, "animation-delay": timing(i()) }}>
                      <img
                        src={s().src}
                        alt=""
                        class="title-puff-grow absolute [image-rendering:pixelated]"
                        style={{
                          "--x0": pct(chimney.x),
                          "--y0": pct(chimney.y),
                          width: pct(s().w),
                          filter: lit().smoke,
                          "animation-duration": `${puffSeconds}s`,
                          "animation-delay": timing(i()),
                        }}
                      />
                    </span>
                  );
                }}
              </For>
              <Show when={lit().seeds}>
                <For each={seeds}>
                  {(seed) => {
                    const s = () => spriteOf(sizes(), seed.sprite, 0.22);
                    return (
                      <span class="title-drift title-seed-path" style={{ "animation-duration": `${seed.duration}s`, "animation-delay": `${seed.delay}s` }}>
                        <img
                          src={s().src}
                          alt=""
                          class="title-seed-spin absolute top-0 [image-rendering:pixelated]"
                          style={{ left: pct(seed.from), width: pct(s().w), filter: lit().ground, "animation-delay": `${seed.delay}s` }}
                        />
                      </span>
                    );
                  }}
                </For>
              </Show>
              <For each={motesOf(props.scene)}>
                {(m, i) => (
                  <span
                    class="title-firefly"
                    style={{
                      left: `${m.x}%`,
                      top: `${m.y}%`,
                      width: `${m.size}px`,
                      height: `${m.size}px`,
                      "animation-duration": `${m.duration}s, ${1.6 + (i() % 5) * 0.4}s`,
                      "animation-delay": `${m.delay}s`,
                    }}
                  />
                )}
              </For>
              <Farmer scene={props.scene} sizes={sizes()} />
              <PetOnHill scene={props.scene} sizes={sizes()} />
              <For each={plants}>
                {(p, i) => {
                  const s = () => spriteOf(sizes(), p.sprite, p.scale);
                  return (
                    <img
                      src={s().src}
                      alt=""
                      class="title-sway absolute bottom-0 [image-rendering:pixelated]"
                      style={{
                        left: pct(p.x - s().w / 2),
                        width: pct(s().w),
                        filter: lit().ground,
                        "--lean": `${p.lean}deg`,
                        "animation-duration": `${p.sway}s`,
                        "animation-delay": `${-i() * 0.7}s`,
                      }}
                    />
                  );
                }}
              </For>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

function Farmer(props: { scene: TitleScene; sizes: TitleSprites }) {
  const s = () => spriteOf(props.sizes, orchestratorPose[props.scene], orchestrator.scale);
  const ground = () => light[props.scene].ground;
  return (
    <div
      class="title-breathe absolute"
      style={{ left: pct(orchestrator.x - s().w / 2), top: pct(orchestrator.bottom - s().h), width: pct(s().w), height: pct(s().h) }}
    >
      <img
        src={s().src}
        alt=""
        class="block h-full w-full [image-rendering:pixelated]"
        style={{ filter: ground() === "none" ? undefined : props.scene === "night" ? "brightness(0.6) saturate(0.8)" : ground() }}
      />
      <Show when={props.scene === "night"}>
        <span class="title-lantern" />
      </Show>
    </div>
  );
}

function PetOnHill(props: { scene: TitleScene; sizes: TitleSprites }) {
  const chosen = usePrefs((p) => p.pet);
  const pet = () => (chosen() in petScale ? chosen() : "dog");
  const frame = createPetFrame(() => props.scene === "night");
  const s = () => spriteOf(props.sizes, `${pet()}-${frame()}`, petScale[pet()]);
  return (
    <img
      src={s().src}
      alt=""
      class={["absolute [image-rendering:pixelated]", { "title-breathe": frame() === "sleep" }]}
      style={{
        left: pct(petSpot.x - s().w / 2),
        top: pct(petSpot.bottom - s().h),
        width: pct(s().w),
        filter: props.scene === "night" ? "brightness(0.55) saturate(0.8)" : light[props.scene].ground,
      }}
    />
  );
}

/** Steps through the pet's round for as long as it is shown; asleep at night. */
function createPetFrame(asleep: () => boolean): () => PetFrame {
  const [step, setStep] = createSignal(0);
  createEffect(
    () => [asleep(), step()] as const,
    ([sleeping, at]) => {
      if (sleeping) return;
      const t = setTimeout(() => setStep((i) => (i + 1) % petRound.length), petRound[at]?.ms ?? 1000);
      return () => clearTimeout(t);
    },
  );
  return () => (asleep() ? "sleep" : (petRound[step()]?.frame ?? "sit"));
}
