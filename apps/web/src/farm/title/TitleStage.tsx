// The title's picture, alive: the scene on a stage kept at its own 3:2 and covering the
// screen, slowly panning; on it, in the scene's own coordinates (layers.ts), clouds, chimney smoke, swaying plants,
// seeds off the dandelions, fireflies at dusk and night, and on the hill the farmer (breathing; a lantern at night)
// with the chosen pet. The motions are style.css's title-*.

import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useState } from "react";
import { useFarm } from "../store";
import {
  chimney,
  clouds,
  light,
  manager,
  managerPose,
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

const useTitleSprites = () =>
  useQuery({ queryKey: ["title-sprites"], queryFn: async () => (await (await fetch("/title/sprites.json")).json()) as TitleSprites, staleTime: Infinity });

export function TitleStage({ scene }: { scene: TitleScene }) {
  const sizes = useTitleSprites().data;
  const lit = light[scene];
  return (
    <div aria-hidden className="title-stage">
      <div className="title-bg absolute inset-0">
        <img src={titleBackground(scene)} alt="" draggable={false} className="absolute inset-0 h-full w-full [image-rendering:pixelated]" />
        {sizes && (
          <>
            {clouds.map((c, i) => {
              const s = spriteOf(sizes, c.sprite, c.scale);
              return (
                <img
                  key={`cloud-${i}`}
                  src={s.src}
                  alt=""
                  className="title-cloud absolute [image-rendering:pixelated]"
                  style={{ top: pct(c.y), width: pct(s.w), filter: lit.sky, animationDuration: `${c.duration}s`, animationDelay: `${c.delay}s` }}
                />
              );
            })}
            {puffs.map((puff, i) => {
              const s = spriteOf(sizes, puff.sprite, puff.scale);
              return (
                <img
                  key={`puff-${i}`}
                  src={s.src}
                  alt=""
                  className="title-puff absolute [image-rendering:pixelated]"
                  style={
                    {
                      "--x0": pct(chimney.x),
                      "--y0": pct(chimney.y),
                      width: pct(s.w),
                      filter: lit.smoke,
                      animationDuration: `${puffSeconds}s`,
                      animationDelay: `${-(i * puffSeconds) / puffs.length}s`,
                    } as CSSProperties
                  }
                />
              );
            })}
            {lit.seeds &&
              seeds.map((seed, i) => {
                const s = spriteOf(sizes, seed.sprite, 0.22);
                return (
                  <span
                    key={`seed-${i}`}
                    className="title-seed-path absolute"
                    style={
                      { "--x0": pct(seed.from), width: pct(s.w), animationDuration: `${seed.duration}s`, animationDelay: `${seed.delay}s` } as CSSProperties
                    }
                  >
                    <img
                      src={s.src}
                      alt=""
                      className="title-seed-spin block w-full [image-rendering:pixelated]"
                      style={{ filter: lit.ground, animationDelay: `${seed.delay}s` }}
                    />
                  </span>
                );
              })}
            {motesOf(scene).map((m, i) => (
              <span
                key={`fly-${i}`}
                className="title-firefly"
                style={{
                  left: `${m.x}%`,
                  top: `${m.y}%`,
                  width: m.size,
                  height: m.size,
                  animationDuration: `${m.duration}s, ${1.6 + (i % 5) * 0.4}s`,
                  animationDelay: `${m.delay}s`,
                }}
              />
            ))}
            <Farmer scene={scene} sizes={sizes} />
            <PetOnHill scene={scene} sizes={sizes} />
            {plants.map((p, i) => {
              const s = spriteOf(sizes, p.sprite, p.scale);
              return (
                <img
                  key={`plant-${i}`}
                  src={s.src}
                  alt=""
                  className="title-sway absolute bottom-0 [image-rendering:pixelated]"
                  style={
                    {
                      left: pct(p.x - s.w / 2),
                      width: pct(s.w),
                      filter: lit.ground,
                      "--lean": `${p.lean}deg`,
                      animationDuration: `${p.sway}s`,
                      animationDelay: `${-i * 0.7}s`,
                    } as CSSProperties
                  }
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function Farmer({ scene, sizes }: { scene: TitleScene; sizes: TitleSprites }) {
  const s = spriteOf(sizes, managerPose[scene], manager.scale);
  const ground = light[scene].ground;
  return (
    <div className="title-breathe absolute" style={{ left: pct(manager.x - s.w / 2), top: pct(manager.bottom - s.h), width: pct(s.w), height: pct(s.h) }}>
      <img
        src={s.src}
        alt=""
        className="block h-full w-full [image-rendering:pixelated]"
        style={{ filter: ground === "none" ? undefined : scene === "night" ? "brightness(0.6) saturate(0.8)" : ground }}
      />
      {scene === "night" && <span className="title-lantern" />}
    </div>
  );
}

function PetOnHill({ scene, sizes }: { scene: TitleScene; sizes: TitleSprites }) {
  const chosen = useFarm((s) => s.pet);
  const pet = chosen in petScale ? chosen : "dog";
  const frame = usePetFrame(scene === "night");
  const s = spriteOf(sizes, `${pet}-${frame}`, petScale[pet]);
  return (
    <img
      src={s.src}
      alt=""
      className={`absolute [image-rendering:pixelated] ${frame === "sleep" ? "title-breathe" : ""}`}
      style={{
        left: pct(petSpot.x - s.w / 2),
        top: pct(petSpot.bottom - s.h),
        width: pct(s.w),
        filter: scene === "night" ? "brightness(0.55) saturate(0.8)" : light[scene].ground,
      }}
    />
  );
}

/** Steps through the pet's round for as long as it is shown; asleep at night. */
function usePetFrame(asleep: boolean): PetFrame {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (asleep) return;
    const t = setTimeout(() => setStep((i) => (i + 1) % petRound.length), petRound[step]?.ms ?? 1000);
    return () => clearTimeout(t);
  }, [asleep, step]);
  return asleep ? "sleep" : (petRound[step]?.frame ?? "sit");
}
