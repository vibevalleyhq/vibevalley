import type { InlineStyleReview } from "./style-migration-ownership";

export const inlineStyleReviews: readonly InlineStyleReview[] = [
  {
    path: "apps/site/src/components/Harvest.tsx",
    expression: 'style={{\n                "animation-delay": `${i * -1.6}s`,\n              }}',
    reason: "Per-coin CSS floating phase; preserves the three negative offsets.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression: 'style={{\n                          "animation-delay": `${seed.delay}s`,\n                        }}',
    reason: "Seed-spin phase is synchronized to its parent seed trajectory.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression:
      'style={{\n                          left: `${f.x}%`,\n                          top: `${f.y}%`,\n                          width: `${f.size}px`,\n                          height: `${f.size}px`,\n                          "animation-duration": `${f.duration}s,${1.6 + (i % 5) * 0.4}s`,\n                          "animation-delay": `${f.delay}s`,\n                        }}',
    reason: "Firefly layout and two independent animation periods/phases from scene asset data; CSS owns the loops, not Motion.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression:
      'style={{\n                        "--x0": pct(CHIMNEY.x), "--y0": pct(CHIMNEY.y),\n                        width: pct(s.w),\n                        "animation-duration": `${PUFF_SECONDS}s`,\n                        "animation-delay": `${-(i * PUFF_SECONDS) / PUFFS.length}s`,\n                      }}',
    reason: "Chimney sprite geometry and per-puff CSS animation phase from CHIMNEY/PUFFS; native custom properties feed existing puff keyframes.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression:
      'style={{\n                        "--x0": pct(seed.from),\n                        width: pct(s.w),\n                        "animation-duration": `${seed.duration}s`,\n                        "animation-delay": `${seed.delay}s`,\n                      }}',
    reason: "Seed emitter geometry and shared x/y CSS animation phase from SEEDS; --x0 is the emitter coordinate.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression: 'style={{\n                        "animation-delay": `${i * stagger}ms`,\n                      }}',
    reason: "Locale-dependent title character entrance stagger; retains exact animation scheduling.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression:
      'style={{\n                      "--lean": `${p.lean}deg`,\n                      left: pct(p.x - s.w / 2),\n                      width: pct(s.w),\n                      "animation-duration": `${p.sway}s`,\n                      "animation-delay": `${-i * 0.7}s`,\n                    }}',
    reason: "Foreground plant sprite geometry, sway amplitude custom property and independent CSS animation phases from PLANTS.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression:
      'style={{\n                      top: pct(c.y),\n                      width: pct(s.w),\n                      "animation-duration": `${c.duration}s`,\n                      "animation-delay": `${c.delay}s`,\n                    }}',
    reason: "Cloud sprite geometry and data-driven CSS animation duration/phase from CLOUDS.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression:
      "style={{\n                    left: pct(MANAGER.x - farmers[s].w / 2),\n                    top: pct(MANAGER.bottom - farmers[s].h),\n                    width: pct(farmers[s].w),\n                    height: pct(farmers[s].h),\n                  }}",
    reason: "Per-hour manager sprite bounds from MANAGER and managerOf asset dimensions; the scene state owns placement.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression: 'style={{\n                "animation-delay": `${after + 180}ms`,\n              }}',
    reason: "Lead entrance delay derived from locale-dependent title duration.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression: 'style={{\n                "animation-delay": `${after + 270}ms`,\n              }}',
    reason: "Call-to-action entrance delay derived from locale-dependent title duration.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression: 'style={{\n                "animation-delay": `${after + 90}ms`,\n              }}',
    reason: "Morning verse entrance delay derived from locale-dependent title duration.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression: 'style={{\n                "animation-delay": `${after}ms`,\n              }}',
    reason: "Tagline entrance delay derived from locale-dependent title duration.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression:
      "style={{\n            transform: `translate(${reducedMotion() ? 0 : -x() * props.point}px, ${reducedMotion() ? 0 : -y() * props.point * 0.6}px)`,\n          }}",
    reason: "Motion spring values drive pointer parallax transform; reduced-motion gate remains unchanged.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression: 'style={{\n          "transform-origin": props.origin,\n        }}',
    reason: "Motion scroll camera scale pivot supplied by the Layer scene contract; transform remains Motion-owned.",
  },
  {
    path: "apps/site/src/components/Hero.tsx",
    expression: "style={{\n        left: pct(PET.x),\n        bottom: pct(1 - PET.bottom),\n        width: pct(f().w),\n      }}",
    reason: "Dog sprite bounds from current animation frame and PET anchor; Motion independently owns jump transform.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n                    left: `${-props.art.side.ax}px`,\n                    top: `${-props.art.side.ay}px`,\n                  }}",
    reason: "Walking sprite anchor offsets from side sprite metadata; Motion owns helper transforms.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n                  transform: `translate(${position()}px, ${FIELD.path}px)`,\n                }}",
    reason: "Motion-derived helper position() translated along FIELD.path.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n                left: `${GIT.join * 100}%`,\n                top: `${main - 42}px`,\n              }}",
    reason: "Merge label geometry anchored to GIT.join and SVG main lane; Presence owns entrance motion.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n              left: `${props.place.plot + 24}px`,\n              top: `${FIELD.stand - 34}px`,\n            }}",
    reason: "Completion stamp placement relative to FIELD.stand; Presence owns scale and opacity.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n              left: `${props.place.plot}px`,\n            }}",
    reason: "Coin effect position at the plot; Presence owns vertical motion and opacity.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression:
      'style={{\n              top: `${c.y}px`,\n              width: `${c.w}px`,\n              "animation-duration": `${c.d}s`,\n              "animation-delay": `${c.delay}s`,\n            }}',
    reason: "Sky cloud geometry and individual CSS traversal duration/phase.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n              width: `${FIELD.w}px`,\n              height: `${FIELD.h}px`,\n              scale: k(),\n            }}",
    reason: "Fixed FIELD coordinate system dimensions and responsive camera scale k() measured against the stage.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n            top: `${main - 22}px`,\n          }}",
    reason: "Branch label geometry anchored to the SVG main lane.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n            width: `${Math.round(props.art.w * 0.55)}px`,\n            height: `${Math.round(props.art.h * 0.55)}px`,\n          }}",
    reason: "Bubble sprite display dimensions rounded from asset metadata at 55 percent scale.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: 'style={{\n          left: `${props.place.plot}px`,\n          top: `${FIELD.stand}px`,\n          "transform-origin": "50% 100%",\n        }}',
    reason: "Plot geometry at FIELD.stand plus bottom-center scale pivot used by createEntrance Motion.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n          top: `${74}px`,\n        }}",
    reason: "Ground horizon placement in the FIELD scene coordinate system.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n          top: `${FIELD.path - 9}px`,\n          height: `${14}px`,\n        }}",
    reason: "Path strip geometry relative to FIELD.path, shared with the walking helper.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n        height: `${100 + PLACES.length * 80}svh`,\n      }}",
    reason: "Scroll narrative track geometry from PLACES length; Motion uses this height for scene progress.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: 'style={{\n        left: `${props.x}px`,\n        top: `${props.y}px`,\n        "transform-origin": "50% 100%",\n      }}',
    reason: "Speech bubble coordinate and scale pivot passed to the Presence/Motion render ref.",
  },
  {
    path: "apps/site/src/components/How.tsx",
    expression: "style={{\n        transform: `translateX(${-value() * props.pace}px)`,\n      }}",
    reason: "MotionValue camera read through readMotion() drives the parallax transform.",
  },
  {
    path: "apps/site/src/components/Parade.tsx",
    expression: 'style={{\n                  "animation-delay": `${j * 0.15}s`,\n                }}',
    reason: "Sprite-sheet frame CSS timing synchronized to the four-frame walk cycle.",
  },
  {
    path: "apps/site/src/components/Parade.tsx",
    expression: 'style={{\n              "animation-duration": `${26 + (i % 3) * 7}s`,\n              "animation-delay": `${-i * 5.3}s`,\n            }}',
    reason: "Per-walker CSS traversal duration and negative phase offset.",
  },
  {
    path: "apps/web/src/app/Shell.tsx",
    expression: 'style={titleBar.left > 0 ? { "min-width": `${titleBar.left + 8}px` } : undefined}',
    reason: "Desktop host chrome left inset controls minimum navigation rail width.",
  },
  {
    path: "apps/web/src/app/Shell.tsx",
    expression: "style={{ height: `${head}px` }}",
    reason: "Shell shared head geometry keeps rail face slot aligned with desk header.",
  },
  {
    path: "apps/web/src/app/Shell.tsx",
    expression: "style={{ height: `${titleBar.top}px` }}",
    reason: "Desktop host chrome top inset reserves window control clearance.",
  },
  {
    path: "apps/web/src/farm/canvas/VillageCanvas.tsx",
    expression: 'style={{ "background-image": `url(${spriteUrl("map")})` }}',
    reason: "Runtime atlas URL from spriteUrl(map); asset resolver owns the map image.",
  },
  {
    path: "apps/web/src/farm/canvas/VillageCanvas.tsx",
    expression: "style={{ background }}",
    reason: "Scene-owned background imported from canvas/screen.ts, shared with the Pixi stage rather than a CSS utility.",
  },
  {
    path: "apps/web/src/farm/canvas/VillageCanvas.tsx",
    expression: "style={{ width: `${fill() * 100}%` }}",
    reason: "Loading progress fraction drives bar geometry continuously.",
  },
  {
    path: "apps/web/src/farm/chat/ChatWindow.tsx",
    expression: 'style={{ "animation-delay": `${i * 0.2}s` }}',
    reason: "Per-dot animation phase offset (index * 0.2 seconds); typing animation owns the timing.",
  },
  {
    path: "apps/web/src/farm/chat/Messages.tsx",
    expression: "style={{ background: tag()[1], color: tag()[2] }}",
    reason: "Runtime outcomeTag tuple provides paired report fill/ink from message outcome data.",
  },
  {
    path: "apps/web/src/farm/hud/Friends.tsx",
    expression: 'style={{ background: i < lit() ? "#7ea64f" : "#46301d" }}',
    reason: "Stamina segment illumination chooses pixel-art ink from live stamina.",
  },
  {
    path: "apps/web/src/farm/hud/Friends.tsx",
    expression: 'style={{ background: picked() ? "#74a046" : "#c8a46e" }}',
    reason: "Selected agent portrait surround selects the existing pixel palette.",
  },
  {
    path: "apps/web/src/farm/hud/Friends.tsx",
    expression: "style={{ background: status[a()].dot }}",
    reason: "Aggregate friend status chooses its pixel-art dot palette.",
  },
  {
    path: "apps/web/src/farm/hud/Friends.tsx",
    expression: "style={{ background: status[props.st].dot }}",
    reason: "Agent status palette owns the status dot.",
  },
  {
    path: "apps/web/src/farm/hud/Friends.tsx",
    expression: 'style={{ left: `${i() * 12}px`, "z-index": 3 - i() }}',
    reason: "Portrait index owns overlap position and stacking order.",
  },
  {
    path: "apps/web/src/farm/hud/Friends.tsx",
    expression: "style={{ width: `${sorted().length === 0 ? 0 : 22 + (Math.min(3, sorted().length) - 1) * 12}px` }}",
    reason: "Overlapping portrait strip width is computed from live friend count.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={box().w < 680 ? undefined : { left: `${box().x}px`, top: `${box().y}px`, width: `${box().w}px`, height: `${box().h}px` }}",
    reason: "HUD box uses scene-owned viewport framing, with the existing 680px compact boundary.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression:
      'style={{\n                  width: props.compact ? "44px" : "52px",\n                  height: `${bottom}px`,\n                  background: held() === tool.id ? CardColors.held : CardColors.slot,\n                  "border-color": CardColors.ink,\n                }}',
    reason: "Live held-tool palette and compact slot dimensions share PixelCard/HUD drawing geometry.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression:
      "style={{\n        right: `${edge}px`,\n        left: props.compact ? `${edge}px` : undefined,\n        top: `${edge + (props.compact ? top + gap + titleBar.top : 0)}px`,\n        gap: `${gap}px`,\n      }}",
    reason: "HUD right cluster geometry depends on compact layout and native titlebar inset.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ background: CardColors.barTrack }}",
    reason: "PixelCard CardColors.barTrack supplies shared drawn-card track.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ background: CardColors.barTrack }}",
    reason: "PixelCard CardColors.barTrack supplies shared drawn-card track.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ bottom: `${edge}px`, gap: `${gap}px` }}",
    reason: "Toolbar geometry shares edge and gap constants with HUD framing.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ color: CardColors.good }}",
    reason: "PixelCard CardColors.good supplies shared drawn-card ink.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ color: CardColors.muted }}",
    reason: "PixelCard CardColors.muted supplies shared drawn-card ink.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ color: CardColors.muted }}",
    reason: "PixelCard CardColors.muted supplies shared drawn-card ink.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ color: levelInk[quotaLevel(left())] }}",
    reason: "Quota level lookup selects pixel-art readout ink from remaining quota.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: 'style={{ color: lowest() === undefined ? "#2f1f13" : levelInk[quotaLevel(lowest())] }}',
    reason: "Lowest quota window selects the shared quota-level pixel-art ink.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: 'style={{ color: quota().level === "unknown" ? "#9b7550" : quota().level === "empty" ? "#c84a3a" : "#46301d" }}',
    reason: "Quota state selects existing unknown/empty/normal pixel-art ink.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: 'style={{ color: u().available ? "#2f1f13" : "#c84a3a" }}',
    reason: "Runtime quota balance availability selects existing pixel-art warning ink.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ height: `${Math.round((screen()?.scale ?? 3) * 5)}px` }}",
    reason: "Signpost height tracks the integer scene scale.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: 'style={{ height: `${top}px`, background: CardColors.paper, "border-color": CardColors.ink }}',
    reason: "Readout height shares HUD geometry and PixelCard CardColors.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ left: `${at().x}px`, top: `${at().y}px` }}",
    reason: "Repository sign follows canvas screen projection.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ left: `${edge}px`, bottom: `${edge + (props.compact ? bottom + gap : 0)}px`, gap: `${gap}px` }}",
    reason: "HUD lower cluster geometry depends on compact toolbar layout.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ left: `${edge}px`, top: `${edge + titleBar.top}px`, gap: `${gap}px` }}",
    reason: "HUD geometry shares edge/gap dimensions and native titlebar inset.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ width: `${Math.max(0, Math.min(100, left()))}%`, background: levelInk[quotaLevel(left())] }}",
    reason: "Live quota fraction supplies fill geometry and quota-level pixel palette.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: "style={{ width: `${need() === 0 ? 0 : Math.min(100, (lv().xp / need()) * 100)}%`, background: CardColors.barFill }}",
    reason: "Live XP ratio supplies fill geometry; PixelCard owns the bar palette.",
  },
  {
    path: "apps/web/src/farm/hud/Hud.tsx",
    expression: 'style={{ width: `${top + 2}px`, height: `${top}px`, background: CardColors.paper, "border-color": CardColors.ink }}',
    reason: "Portrait frame dimensions share HUD geometry; fill/border come from PixelCard CardColors.",
  },
  {
    path: "apps/web/src/farm/hud/HudCard.tsx",
    expression:
      'style={{\n          height: props.height !== undefined ? `${props.height}px` : undefined,\n          background: CardColors.paper,\n          "border-color": CardColors.ink,\n          color: CardColors.ink,\n          "box-shadow": "2px 2px 0 0 #3a2a1899",\n        }}',
    reason:
      "PixelCard-facing HUD card: caller-driven card height and shared CardColors drawing palette; native object retains the original pixel frame/shadow composition.",
  },
  {
    path: "apps/web/src/farm/hud/Overlay.tsx",
    expression: 'style={{ "animation-delay": `${props.pin.hop}s` }}',
    reason: "Pin hop phase drives independently staggered animation delay.",
  },
  {
    path: "apps/web/src/farm/hud/Overlay.tsx",
    expression: "style={{ left: `${props.pin.x}px`, top: `${props.pin.y}px`, transform: `translate(-50%, ${-props.pin.ay * 100}%)` }}",
    reason: "Projected pin x/y and atlas anchor ay own screen position and transform.",
  },
  {
    path: "apps/web/src/farm/hud/Overlay.tsx",
    expression: 'style={{ visibility: "hidden" }}',
    reason: "Initial hidden state is handed off to the scene onFrame callback, which imperatively writes visibility and transform.",
  },
  {
    path: "apps/web/src/farm/issue/IssueView.tsx",
    expression: 'style={{ background: tint(tones[ask().tone] ?? "#c8a46e", 0.3) }}',
    reason: "Runtime ask tone is converted by tint into the existing pixel-art translucent fill.",
  },
  {
    path: "apps/web/src/farm/issue/IssueView.tsx",
    expression: 'style={{ color: s().stage.state === "stuck" ? tones.berry : "#5a3d26" }}',
    reason: "Live issue stage selects pixel-art danger/normal ink from the issue tone palette.",
  },
  {
    path: "apps/web/src/farm/map/RepoMap.tsx",
    expression: "style={style()}",
    reason: "Placed derives position from sprite anchor and foot coordinates times integer scale.",
  },
  {
    path: "apps/web/src/farm/map/RepoMap.tsx",
    expression: "style={style()}",
    reason: "Placed derives position from sprite anchor and foot coordinates times integer scale.",
  },
  {
    path: "apps/web/src/farm/map/RepoMap.tsx",
    expression:
      "style={{\n                    left: `${Math.round(((from * span() + t() * speed) % span()) - cloud().w * 4)}px`,\n                    top: `${Math.round(y * (box?.clientHeight ?? 600))}px`,\n                  }}",
    reason: "Cloud animation computes per-tick x and viewport-relative y using atlas width.",
  },
  {
    path: "apps/web/src/farm/map/RepoMap.tsx",
    expression: "style={{ gap: `${gap}px` }}",
    reason: "Map gap is shared with island cell sizing/layout calculations.",
  },
  {
    path: "apps/web/src/farm/map/RepoMap.tsx",
    expression: "style={{ left: `${(foot().x + 6) * s()}px`, top: `${(foot().y - 20) * s()}px` }}",
    reason: "Queued-sack badge follows atlas foot position times scale.",
  },
  {
    path: "apps/web/src/farm/map/RepoMap.tsx",
    expression: "style={{ left: `${foot().x * s()}px`, top: `${(foot().y - 3) * s()}px` }}",
    reason: "Helper badge follows atlas foot position times scale.",
  },
  {
    path: "apps/web/src/farm/map/RepoMap.tsx",
    expression: "style={{ width: `${cell().w * scale()}px` }}",
    reason: "Atlas cell width times integer scene scale owns island column geometry.",
  },
  {
    path: "apps/web/src/farm/map/RepoMap.tsx",
    expression: "style={{ width: `${pic().w * s()}px`, height: `${props.cellHeight * s()}px` }}",
    reason: "Atlas sprite width and cell-height geometry scale together.",
  },
  {
    path: "apps/web/src/farm/panels/Achievements.tsx",
    expression: 'style={{ background: done() ? tint("#b4cb7c", 0.7) : "#e2c995", color: done() ? "#2f1f13" : "#67482d" }}',
    reason: "Achievement completion state selects paired translucent pixel-art fill/ink.",
  },
  {
    path: "apps/web/src/farm/panels/Achievements.tsx",
    expression: 'style={{ background: i() < standing().tier ? pip[i() + 1] : "#c8a46e" }}',
    reason: "Pip index and current tier select the tier palette.",
  },
  {
    path: "apps/web/src/farm/panels/Achievements.tsx",
    expression: 'style={{ background: ok() ? tint("#b4cb7c", 0.35) : "#eedcb2" }}',
    reason: "Starter completion state selects the existing tinted pixel-art fill.",
  },
  {
    path: "apps/web/src/farm/panels/Achievements.tsx",
    expression:
      'style={{ background: standing().tier === 3 ? tint("#e5a93c", 0.2) : "#eedcb2", border: standing().tier === 3 ? "2px solid #e5a93cb3" : undefined }}',
    reason: "Achievement tier selects existing gold frame and translucent pixel-art fill.",
  },
  {
    path: "apps/web/src/farm/panels/Achievements.tsx",
    expression: "style={{ height: `${props.height ?? 8}px` }}",
    reason: "Caller-supplied meter height preserves pixel-art geometry.",
  },
  {
    path: "apps/web/src/farm/panels/Achievements.tsx",
    expression: "style={{ left: `${place().left}px`, top: `${place().top}px`, width: `${place().e}px`, height: `${place().e}px` }}",
    reason: "Computed emblem fit/placement owns image position and dimensions inside the medal frame.",
  },
  {
    path: "apps/web/src/farm/panels/Achievements.tsx",
    expression: "style={{ width: `${props.max <= 0 ? 0 : Math.min(1, Math.max(0, props.value / props.max)) * 100}%` }}",
    reason: "Live achievement fraction drives meter fill geometry.",
  },
  {
    path: "apps/web/src/farm/panels/Achievements.tsx",
    expression: "style={{ width: `${props.size}px`, height: `${props.size}px` }}",
    reason: "Caller-supplied medal size drives outer drawing bounds.",
  },
  {
    path: "apps/web/src/farm/panels/Panels.tsx",
    expression: 'style={{ background: props.chosen ? tint("#b4cb7c", 0.6) : undefined }}',
    reason: "Chosen tile selects the existing tint-generated pixel-art fill.",
  },
  {
    path: "apps/web/src/farm/panels/rows.tsx",
    expression: "style={{ background: look().fill, color: look().ink }}",
    reason: "File-kind presentation data supplies paired look().fill/look().ink.",
  },
  {
    path: "apps/web/src/farm/panels/rows.tsx",
    expression: "style={{ background: patchFill[patchMarkOf(line())], color: patchInk[patchMarkOf(line())] }}",
    reason: "Diff-line classification selects paired patchFill/patchInk pixel-art palette entries.",
  },
  {
    path: "apps/web/src/farm/panels/rows.tsx",
    expression: 'style={{ background: props.fill ?? "#e2c995", color: props.ink ?? "#46301d" }}',
    reason: "FarmTag accepts caller-provided fill/ink palette data with existing drawn-card defaults.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression:
      'style={{\n        transform: key.down() ? "translateY(1px)" : undefined,\n        background: "#c84a3a",\n        "box-shadow": key.down() ? outline : `${outline}, inset -4px -4px 0 0 #9c3a2d`,\n      }}',
    reason: "Held pad-key state drives one-pixel transform and pixel-art inset/shadow, owned by createPress.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression:
      'style={{\n        width: `${width()}px`,\n        background: body,\n        // The outline over a 4 px dark band at the bottom and right and a light one at the top and left.\n        "box-shadow": `${outline}, inset -4px -4px 0 0 #4a321e, inset 4px 4px 0 0 #8a6440, 3px 4px 0 0 #1e140a73`,\n        color: lcd.ink,\n      }}',
    reason: "Handset width comes from responsive phone geometry; body/outline/LCD palette supplies original pixel frame composition.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: 'style={{ "border-bottom": `2px solid ${lcd.dark}` }}',
    reason: "LCD dark palette supplies the handheld status-row dividing stroke.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: "style={{ background: bark }}",
    reason: "Handset bark palette draws the D-pad center.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: 'style={{ background: body, "box-shadow": `${outline}, inset -3px -3px 0 0 #4a321e, 3px 4px 0 0 #1e140a73` }}',
    reason: "Handset body/outline constants supply the existing drawn chat-tab frame.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: "style={{ background: lcd.dark }}",
    reason: "Shared LCD palette supplies the hinge separator ink.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: "style={{ background: lcd.ink }}",
    reason: "Shared LCD palette draws battery ink.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: "style={{ background: lcd.ink }}",
    reason: "Shared LCD palette draws battery terminal.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: "style={{ background: lcd.light }}",
    reason: "Shared LCD palette draws battery charge surface.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: "style={{ height: `${h}px`, background: lcd.ink }}",
    reason: "Signal-bar sample height and shared LCD palette draw the signal glyph.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: 'style={{ height: `${screen()}px`, background: lcd.paper, "box-shadow": `${outline}, inset 3px 3px 0 0 #a8bd78` }}',
    reason: "Responsive screen height and shared LCD palette own screen geometry and drawn frame.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: "style={{ width: `${appsWidth()}px` }}",
    reason: "Unfolded app pane width comes from responsive phone geometry.",
  },
  {
    path: "apps/web/src/farm/phone/Phone.tsx",
    expression: "style={{ width: `${chatWidth()}px` }}",
    reason: "Chat pane width comes from responsive phone geometry.",
  },
  {
    path: "apps/web/src/farm/phone/games/BlocksGame.tsx",
    expression: 'style={{ "box-shadow": `0 0 0 2px ${lcd.ink}` }}',
    reason: "Shared canvas/DOM LCD palette supplies the game-frame ink.",
  },
  {
    path: "apps/web/src/farm/phone/games/BlocksGame.tsx",
    expression: "style={{ background: lcd.light }}",
    reason: "Shared LCD palette supplies the next-piece preview surface.",
  },
  {
    path: "apps/web/src/farm/phone/games/BlocksGame.tsx",
    expression: "style={{ color: lcd.dark }}",
    reason: "Shared LCD palette supplies game help ink.",
  },
  {
    path: "apps/web/src/farm/phone/games/BugSnakeGame.tsx",
    expression: 'style={{ "box-shadow": `0 0 0 2px ${lcd.ink}` }}',
    reason: "Shared canvas/DOM LCD palette supplies the game-frame ink.",
  },
  {
    path: "apps/web/src/farm/phone/games/BugSnakeGame.tsx",
    expression: "style={{ color: lcd.dark }}",
    reason: "Shared LCD palette supplies game help ink.",
  },
  {
    path: "apps/web/src/farm/phone/games/BugSnakeGame.tsx",
    expression: "style={{ width: `${width * zoom}px`, height: `${height * zoom}px` }}",
    reason: "Canvas logical dimensions times integer zoom own CSS pixel size.",
  },
  {
    path: "apps/web/src/farm/phone/games/DinoGame.tsx",
    expression: 'style={{ "box-shadow": `0 0 0 2px ${lcd.ink}` }}',
    reason: "Shared canvas/DOM LCD palette supplies the game-frame ink.",
  },
  {
    path: "apps/web/src/farm/phone/games/DinoGame.tsx",
    expression: "style={{ background: lcd.paper }}",
    reason: "Shared LCD palette supplies the overlay surface.",
  },
  {
    path: "apps/web/src/farm/phone/games/DinoGame.tsx",
    expression: "style={{ color: lcd.dark }}",
    reason: "Shared LCD palette supplies game help ink.",
  },
  {
    path: "apps/web/src/farm/phone/games/DinoGame.tsx",
    expression: "style={{ width: `${dinoWidth * zoom()}px`, height: `${dinoHeight * zoom()}px` }}",
    reason: "Canvas logical dimensions times responsive integer zoom own CSS pixel size.",
  },
  {
    path: "apps/web/src/farm/phone/games/MergeGame.tsx",
    expression:
      'style={{\n                background: stage() !== 0 ? lcd.paper : lcd.light,\n                "box-shadow": g()?.grown.includes(i) === true ? `inset 0 0 0 2px ${lcd.ink}` : undefined,\n              }}',
    reason: "Live tile stage and grown-cell state select LCD surface and highlight stroke.",
  },
  {
    path: "apps/web/src/farm/phone/games/MergeGame.tsx",
    expression:
      'style={{\n          width: `${side}px`,\n          height: `${side}px`,\n          padding: `${gap}px`,\n          gap: `${gap}px`,\n          "grid-template-columns": `repeat(${mergeSize}, ${tile}px)`,\n          background: lcd.dark,\n        }}',
    reason: "Game board geometry derives from mergeSize, tile, gap and side; LCD palette supplies board surface.",
  },
  {
    path: "apps/web/src/farm/phone/games/MergeGame.tsx",
    expression: "style={{ color: lcd.dark }}",
    reason: "Shared LCD palette supplies game help ink.",
  },
  {
    path: "apps/web/src/farm/phone/games/MergeGame.tsx",
    expression: "style={{ opacity: props.faint === true ? 0.25 : 1 }}",
    reason: "SVG sprite presentation accepts caller-owned faintness as drawing opacity.",
  },
  {
    path: "apps/web/src/farm/phone/games/SokobanGame.tsx",
    expression: 'style={{ "box-shadow": `inset 0 0 0 1px ${lcd.ink}` }}',
    reason: "Shared canvas/DOM LCD palette supplies the undo-control pixel stroke.",
  },
  {
    path: "apps/web/src/farm/phone/games/SokobanGame.tsx",
    expression: 'style={{ "box-shadow": `inset 0 0 0 1px ${lcd.ink}` }}',
    reason: "Shared canvas/DOM LCD palette supplies the restart/next-control pixel stroke.",
  },
  {
    path: "apps/web/src/farm/phone/games/SokobanGame.tsx",
    expression: "style={{ color: lcd.dark }}",
    reason: "Shared LCD palette supplies game help ink.",
  },
  {
    path: "apps/web/src/farm/phone/screens.stories.tsx",
    expression: "style={{ background: lcd.paper, color: lcd.ink }}",
    reason: "Story host uses the same exported LCD drawing palette as the real handset and canvas games.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: 'style={props.answer ? undefined : { transform: "rotate(135deg)" }}',
    reason: "Decline state rotates the drawn receiver glyph; the glyph owns its transform.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: "style={props.screen === s ? { background: lcd.dark, color: lcd.pale } : undefined}",
    reason: "Selected phone screen chooses paired LCD surface/ink without overriding unselected hover.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: "style={rule}",
    reason: "Call-list rule object owns its shared LCD dividing stroke.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: 'style={{ "border-bottom": `2px solid ${lcd.dark}` }}',
    reason: "Shared LCD palette supplies the call-tab dividing stroke.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: 'style={{ "box-shadow": `inset 0 0 0 2px ${lcd.ink}` }}',
    reason: "Shared LCD palette supplies the Sokoban icon pixel stroke.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: 'style={{ background: answerGreen, color: cream, "box-shadow": `inset 0 0 0 2px ${bark}` }}',
    reason: "Handset answer palette supplies the orchestrator-call key frame and paired surface/ink.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: "style={{ background: declineRed, color: cream }}",
    reason: "App badge uses paired handset decline/cream palette data.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: "style={{ background: lcd.dark, color: lcd.pale }}",
    reason: "Shared LCD palette supplies paired call-label surface and ink.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: "style={{ background: lcd.pale }}",
    reason: "Shared LCD palette supplies the caller portrait surface.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: 'style={{ background: props.answer ? answerGreen : declineRed, "box-shadow": `inset 0 0 0 2px ${bark}, inset -3px -3px 0 0 #00000040` }}',
    reason: "Answer/decline state selects the existing handset palette and pixel-art key frame.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: "style={{ color: declineRed }}",
    reason: "Handset decline palette supplies missed-call label ink.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: "style={{ color: e().answered ? lcd.dark : declineRed }}",
    reason: "Call answer result selects LCD/decline palette ink.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: "style={{ color: lcd.dark }}",
    reason: "Shared LCD palette supplies the empty-log ink.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: "style={{ color: lcd.dark }}",
    reason: "Shared LCD palette supplies missed-call summary ink.",
  },
  {
    path: "apps/web/src/farm/phone/screens.tsx",
    expression: 'style={{ color: props.phase === "idle" && props.problem ? failedInk : undefined }}',
    reason: "Call phase and problem state choose the existing failedInk palette value.",
  },
  {
    path: "apps/web/src/tree/TreePage.tsx",
    expression: "style={sky() || narrow() ? undefined : { width: `${Math.min(520, area().w - 24)}px` }}",
    reason: "Tree sky/ground controls width follows viewport area and the existing 520px cap.",
  },
  {
    path: "apps/web/src/tree/TreePanel.tsx",
    expression: "style={props.narrow ? undefined : { width: `${panelWidth}px` }}",
    reason: "Memory panel width follows the shared panel geometry and narrow-layout boundary.",
  },
  {
    path: "apps/web/src/tree/TreePanel.tsx",
    expression: "style={{ left: `${left()}px`, top: `${top()}px` }}",
    reason: "Memory hover tip follows collision-adjusted screen coordinates.",
  },
  {
    path: "apps/web/src/ui/Button.stories.tsx",
    expression: 'style={{ "margin-left": "12px" }}',
    reason: "Story deliberately exercises native Button style forwarding alongside dynamic StyleX variables.",
  },
  {
    path: "apps/web/src/ui/Face.tsx",
    expression: "style={{ left: `${c().left}px`, top: `${c().top}px`, width: `${c().width}px`, height: `${c().height}px` }}",
    reason: "Atlas crop geometry derived from loaded sprite dimensions; left/top/width/height are drawing coordinates.",
  },
  {
    path: "apps/web/src/ui/Face.tsx",
    expression: "style={{ width: `${props.size ?? 24}px`, height: `${props.size ?? 24}px` }}",
    reason: "Owner face drawing size follows the face API rather than theme layout.",
  },
  {
    path: "apps/web/src/ui/Face.tsx",
    expression: "style={{ width: `${size()}px`, height: `${size()}px` }}",
    reason: "Sprite crop viewport is sized by the caller drawing size.",
  },
  {
    path: "apps/web/src/ui/Field.stories.tsx",
    expression: 'style={{ height: "48px" }}',
    reason: "Story deliberately combines dynamic StyleX width with native input height.",
  },
  {
    path: "apps/web/src/ui/Field.stories.tsx",
    expression: 'style={{ height: "80px" }}',
    reason: "Story deliberately combines dynamic StyleX width with native textarea height.",
  },
  {
    path: "apps/web/src/ui/PoseSprite.tsx",
    expression: "style={{ height: `${props.height}px` }}",
    reason: "Loading placeholder retains requested sprite drawing height before sprite metadata arrives.",
  },
  {
    path: "apps/web/src/ui/RuntimeBadge.tsx",
    expression: "style={{ width: `${props.size}px`, height: `${props.size}px` }}",
    reason: "Runtime badge drawing size is computed by its enclosing sprite.",
  },
  {
    path: "apps/web/src/ui/Splitter.stories.tsx",
    expression: "style={{ width: `${width()}px` }}",
    reason: "Splitter story width is the pointer-driven pane geometry being demonstrated.",
  },
  {
    path: "apps/web/src/ui/layout.tsx",
    expression: "style={{ height: `${titleBar.top}px` }}",
    reason: "Desktop host title-bar geometry defines the native draggable strip height.",
  },
  {
    path: "apps/web/src/ui/pixel/PixelCard.tsx",
    expression:
      'style={{\n              "font-size": `${p().size ?? 12}px`,\n              "line-height": `${(p().size ?? 12) + 2}px`,\n              color: p().color ?? props.ink,\n              "max-width": props.maxWidth !== undefined ? `${props.maxWidth}px` : undefined,\n              ...(props.maxLines !== undefined ? { display: "-webkit-box", "-webkit-box-orient": "vertical", "-webkit-line-clamp": props.maxLines } : {}),\n            }}',
    reason: "PixelCard Piece is a drawing data model; word color/type metrics/clipping and bounds derive from each piece and the sign dimensions.",
  },
  {
    path: "apps/web/src/ui/pixel/PixelCard.tsx",
    expression:
      'style={{\n          background: props.paper ?? CardColors.paper,\n          "border-color": CardColors.ink,\n          padding: `${props.padY ?? 3}px ${props.padX ?? 6}px`,\n          "min-width": props.width !== undefined ? `${props.width}px` : undefined,\n          "min-height": props.height !== undefined ? `${props.height}px` : undefined,\n        }}',
    reason: "PixelCard sign drawing surface, ink, pixel padding and bounds follow its art/layout API and CardColors palette.",
  },
  {
    path: "apps/web/src/ui/pixel/PixelCard.tsx",
    expression: "style={{ height: `${p().px}px`, width: `${(p().px * p().sprite.w) / p().sprite.h}px` }}",
    reason: "PixelCard icon drawing preserves atlas aspect ratio at requested pixel height.",
  },
  {
    path: "apps/web/src/ui/pixel/PixelCard.tsx",
    expression: "style={{ left: `${cut().left}px`, top: `${cut().top}px`, width: `${cut().width}px`, height: `${cut().height}px` }}",
    reason: "Loaded atlas crop geometry positions the image inside its viewport.",
  },
  {
    path: "apps/web/src/ui/pixel/PixelCard.tsx",
    expression: 'style={{ left: `${i * (px() - 10)}px`, "z-index": n() - i }}',
    reason: "PixelCard face-strip placement and drawing order derive from the face index.",
  },
  {
    path: "apps/web/src/ui/pixel/PixelCard.tsx",
    expression: "style={{ width: `${Math.round(p().w * steps())}px`, background: p().color ?? CardColors.barFill }}",
    reason: "PixelCard fill uses quantized twentieth-step drawing width and Piece art color.",
  },
  {
    path: "apps/web/src/ui/pixel/PixelCard.tsx",
    expression: "style={{ width: `${n() === 0 ? 0 : px() + (n() - 1) * (px() - 10)}px`, height: `${px()}px` }}",
    reason: "PixelCard overlapping face-strip dimensions derive from face count and sprite pixel size.",
  },
  {
    path: "apps/web/src/ui/pixel/PixelCard.tsx",
    expression: "style={{ width: `${p().w}px`, height: `${p().h}px`, background: p().track ?? CardColors.barTrack }}",
    reason: "PixelCard bar drawing dimensions and track color come from Piece data and CardColors art palette.",
  },
  {
    path: "apps/web/src/ui/pixel/PixelCard.tsx",
    expression: "style={{ width: `${props.size}px`, height: `${props.size}px` }}",
    reason: "Atlas face viewport dimensions come from drawing size.",
  },
  {
    path: "apps/web/src/ui/pixel/RuntimeIcon.tsx",
    expression: "style={{ width: `${props.size}px`, height: `${props.size}px` }}",
    reason: "Runtime machine drawing viewport follows requested sprite size.",
  },
  {
    path: "apps/web/src/ui/pixel/ToastViewport.tsx",
    expression: "style={{ top: `${props.top ?? 12}px` }}",
    reason: "Toast viewport top offset is caller-owned host overlay geometry.",
  },
  {
    path: "apps/web/src/ui/pixel/base.stories.tsx",
    expression: 'style={{ "margin-top": "8px" }}',
    reason: "Story exercises native PxWindow margin alongside dynamic StyleX width.",
  },
  {
    path: "apps/web/src/ui/pixel/button.stories.tsx",
    expression: 'style={{ "margin-top": "8px" }}',
    reason: "Story exercises native PxButton margin alongside dynamic StyleX width and marginLeft.",
  },
  {
    path: "apps/web/src/ui/pixel/glyphs.tsx",
    expression: "style={{ left: `${(size() - e()) / 2}px`, top: `${size() * disc.centerY - e() / 2}px`, width: `${e()}px`, height: `${e()}px` }}",
    reason: "Medal emblem placement follows atlas artwork disc proportions.",
  },
  {
    path: "apps/web/src/ui/pixel/glyphs.tsx",
    expression: "style={{ width: `${size()}px`, height: `${size()}px` }}",
    reason: "Earned medal viewport follows requested drawing size.",
  },
  {
    path: "apps/web/src/ui/pixel/icons.stories.tsx",
    expression: 'style={{ "margin-top": "8px" }}',
    reason: "Story exercises native SpriteIcon margin alongside dynamic StyleX marginLeft and size.",
  },
  {
    path: "apps/web/src/ui/pixel/icons.tsx",
    expression: 'style={{ "margin-top": `${props.top ?? 2}px` }}',
    reason: "Marked places a sprite at caller-provided first-line offset.",
  },
  {
    path: "apps/web/src/ui/pixel/icons.tsx",
    expression: "style={{ width: `${size()}px`, height: `${size()}px` }}",
    reason: "Working phase without an action reserves the requested glyph drawing dimensions.",
  },
  {
    path: "packages/base-ui/src/context-menu.tsx",
    expression: 'style={{ position: "fixed", left: `${a.at().x}px`, top: `${a.at().y}px`, width: "0", height: "0" }}',
    reason: "Unstyled Base UI context-menu zero-sized anchor tracks pointer/keyboard opening coordinates.",
  },
  {
    path: "packages/base-ui/src/internal/floating.tsx",
    expression:
      'style={{\n          ...(typeof props.style === "object" ? props.style : {}),\n          position: "fixed",\n          left: `${at().x}px`,\n          top: `${at().y}px`,\n          // Base UI\'s: a list can be at least as wide as what opened it (min-width: var(--anchor-width)).\n          "--anchor-width": `${at().anchorWidth}px`,\n          // Not seen until placed: no flash in the corner.\n          visibility: at().placed ? undefined : "hidden",\n        }}',
    reason: "Unstyled Base UI floating positioning owns fixed coordinates, anchor width and pre-placement visibility, merging incoming object styles.",
  },
  {
    path: "packages/base-ui/src/range.tsx",
    expression:
      'style={{\n          ...(typeof props.style === "object" ? props.style : {}),\n          [props.orientation === "vertical" ? "height" : "width"]: `${c.share() * 100}%`,\n        }}',
    reason: "Unstyled Base UI range indicator owns value-proportional width/height and forwards incoming object styles.",
  },
  {
    path: "packages/base-ui/src/slider.tsx",
    expression:
      'style={{\n        ...(typeof props.style === "object" ? props.style : {}),\n        ...(c.orientation() === "vertical"\n          ? { position: "absolute", bottom: 0, height: `${c.share() * 100}%` }\n          : { position: "absolute", left: 0, width: `${c.share() * 100}%` }),\n      }}',
    reason: "Unstyled Base UI slider fill owns value/orientation-derived geometry and merges incoming object styles.",
  },
  {
    path: "packages/base-ui/src/slider.tsx",
    expression:
      'style={{\n        ...(typeof props.style === "object" ? props.style : {}),\n        position: "absolute",\n        ...(c.orientation() === "vertical" ? { bottom: `${c.share() * 100}%`, translate: "0 50%" } : { left: `${c.share() * 100}%`, translate: "-50% 0" }),\n      }}',
    reason: "Unstyled Base UI slider thumb owns value/orientation-derived position/centering and merges incoming object styles.",
  },
  {
    path: "packages/base-ui/src/slider.tsx",
    expression: 'style={{ "touch-action": "none", ...(typeof props.style === "object" ? props.style : {}) }}',
    reason: "Unstyled Base UI slider control owns touch gesture arbitration, while forwarding caller styles.",
  },
  {
    path: "packages/base-ui/test/context.test.tsx",
    expression: 'style={{ "margin-top": "40px", display: "inline-block" }}',
    reason: "Base UI preview-card test fixture provides trigger geometry for placement behavior.",
  },
  {
    path: "packages/base-ui/test/context.test.tsx",
    expression: 'style={{ width: "200px", height: "80px" }}',
    reason: "Base UI preview-card test fixture provides popup geometry for placement behavior.",
  },
  {
    path: "packages/base-ui/test/context.test.tsx",
    expression: 'style={{ width: "300px", height: "200px" }}',
    reason: "Base UI behavior-test fixture provides a hit target rectangle without styling the package.",
  },
  {
    path: "packages/base-ui/test/dialog.test.tsx",
    expression: 'style={{ padding: "40px" }}',
    reason: "Base UI alert-dialog test fixture provides backdrop/popup hit area geometry.",
  },
  {
    path: "packages/base-ui/test/range.test.tsx",
    expression: 'style={{ position: "relative", height: "4px" }}',
    reason: "Base UI slider test fixture supplies track positioning geometry.",
  },
  {
    path: "packages/base-ui/test/range.test.tsx",
    expression: 'style={{ position: "relative", width: "200px", height: "20px" }}',
    reason: "Base UI slider test fixture supplies a measurable control rectangle.",
  },
  {
    path: "packages/base-ui/test/range.test.tsx",
    expression: 'style={{ width: "10px", height: "10px" }}',
    reason: "Base UI slider test fixture supplies thumb hit-target dimensions.",
  },
  {
    path: "packages/base-ui/test/range.test.tsx",
    expression: 'style={{ width: "200px" }}',
    reason: "Base UI range test fixture gives the unstyled track a measurable width.",
  },
  {
    path: "apps/web/src/features/artifact/BlocksView.tsx",
    expression: "style={{ height: `${barHeight(r().type)}px`, background: authorColor(r().updatedBy, props.agent) }}",
    reason:
      "Collaborative BlockEditor row renderer: authorColor(updatedBy, agent) supplies data-driven author paint and barHeight(type) supplies its activity-bar geometry. Inline styles do not own textarea height; the editor resizes that imperatively from scrollHeight.",
  },
  {
    path: "apps/web/src/features/artifact/BlocksView.tsx",
    expression: "style={{ width: `${20 * r().depth}px` }}",
    reason:
      "Collaborative BlockEditor row renderer: depth from the editor model determines the 20px indentation spacer; retaining native geometry avoids changing editor row DOM identity and focus.",
  },
  {
    path: "apps/web/src/features/catalog/CatalogDetail.tsx",
    expression: "style={{ width: `${Math.round(props.p.w * props.scale)}px`, height: `${Math.round(props.p.h * props.scale)}px` }}",
    reason:
      "Pixel asset renderer: Picture manifest art dimensions are multiplied by requested scale and rounded to physical CSS pixels for crisp sprite geometry.",
  },
  {
    path: "apps/web/src/features/catalog/CatalogDetail.tsx",
    expression: "style={{ width: `${shown().w * scale()}px`, height: `${shown().h * scale()}px` }}",
    reason: "Pixel asset preview geometry: currently shown animation frame dimensions and scale control its overlay containing block.",
  },
  {
    path: "apps/web/src/features/catalog/CatalogDetail.tsx",
    expression: "style={{\n                left: `${shown().ax * scale() - 6}px`,\n                top: `${shown().ay * scale() - 6}px`,\n              }}",
    reason:
      "Pixel asset anchor overlay: manifest ax/ay times current scale determines native coordinates. Fixed 12px crosshair appearance now lives in StyleX.",
  },
  {
    path: "apps/web/src/features/catalog/CatalogDetail.tsx",
    expression: "style={{ left: `${head().x * scale() - 5}px`, top: `${head().y * scale() - 5}px` }}",
    reason: "Pixel asset head overlay: decoded head x/y times current scale determines native coordinates. Fixed 10px dimensions now live in StyleX.",
  },
  {
    path: "apps/web/src/features/catalog/CatalogDetail.tsx",
    expression: "style={{ height: `${height}px`, width: `${widthPx()}px` }}",
    reason: "Cursor asset preview: widthPx derives image naturalWidth/naturalHeight and fixed preview height; native geometry preserves aspect ratio.",
  },
  {
    path: "apps/web/src/features/catalog/CatalogDetail.tsx",
    expression: "style={{ left: `${props.hx * ratio() - 4}px`, top: `${props.hy * ratio() - 4}px` }}",
    reason: "Cursor asset hotspot overlay: hx/hy from the cursor manifest are projected through its measured natural-image ratio.",
  },
  {
    path: "apps/web/src/features/channel/ChatPage.tsx",
    expression: 'style={{ "--pane-w": `${threadWidth()}px` }}',
    reason:
      "Resizable chat thread pane: --pane-w is the shared geometry contract with the Splitter and persisted threadWidth signal; CSS consumes the variable responsively.",
  },
  {
    path: "apps/web/src/features/channel/EmojiPicker.tsx",
    expression: 'style={{ left: `${at.left}px`, top: `${at.top}px`, width: `${width}px`, "max-height": `${height}px` }}',
    reason:
      "EmojiPicker positioner owns coordinates: placeBy(anchor) measures getBoundingClientRect, chooses above/below and clamps to viewport. Native left/top/width/max-height are external popup geometry, not a utility class producer.",
  },
  {
    path: "apps/web/src/features/channel/MessageParts.tsx",
    expression: 'style={long() && !open() ? { "max-height": `${foldPx}px` } : undefined}',
    reason:
      "Measured rich-text folding boundary: ResizeObserver compares scrollHeight against foldPx; native max-height is applied only when long and closed, preserving the measured folding state machine.",
  },
  {
    path: "apps/web/src/features/issue/CloseDialog.tsx",
    expression: "style={tok.color ? { color: tok.color } : undefined}",
    reason:
      "External syntax highlighter paint: ui/code highlightTokens returns tok.color; source token colors remain native so no palette or tokenization behavior is changed.",
  },
  {
    path: "apps/web/src/features/pkm/OutlineEditor.tsx",
    expression: 'style={{ "padding-left": `${props.block.depth * indentPx}px` }}',
    reason:
      "Outline editor geometry: model block depth multiplied by shared indentPx determines row indentation, aligned with its drag/drop target coordinates.",
  },
  {
    path: "apps/web/src/features/pkm/OutlineEditor.tsx",
    expression: 'style={{ left: `${(props.block.depth + (at() === "inside" ? 2 : 1)) * indentPx}px` }}',
    reason: "Outline editor drag/drop geometry: native left tracks model depth plus before/inside/after drop position, using the same indentPx as hit testing.",
  },
  {
    path: "apps/web/src/features/pkm/OutlineEditor.tsx",
    expression: "style={{ left: `${i * indentPx + 9}px` }}",
    reason: "Outline editor geometry: each ancestor guide is positioned from its model depth and shared indentPx, rather than enumerating depth classes.",
  },
  {
    path: "apps/web/src/features/repo/RepoPanels.tsx",
    expression: "style={{ width: `${Math.min(1, Math.max(0, props.share)) * 100}%`, background: props.color }}",
    reason: "Repository language chart renderer: normalized share determines width and language metadata supplies paint; both are data-derived chart output.",
  },
  {
    path: "apps/web/src/features/repo/RepoPanels.tsx",
    expression: 'style={{ "flex-grow": Math.max(1, Math.round(s.share * 10000)), background: s.color }}',
    reason:
      "Repository language chart renderer: normalized language share determines flex weight and language metadata supplies paint; minimum weight and rounding are preserved.",
  },
  {
    path: "apps/web/src/features/repo/RepoPanels.tsx",
    expression: "style={{ width: `${20 + calendar().weeks.length * (tile + tileGap)}px` }}",
    reason: "Commit calendar chart geometry: calendar().weeks.length and the shared tile/tileGap sizes set the month-header containing width.",
  },
  {
    path: "apps/web/src/features/repo/RepoPanels.tsx",
    expression: "style={{ left: `${20 + tileGap + m.week * (tile + tileGap)}px` }}",
    reason: "Commit calendar chart geometry: month.week and shared tile/tileGap sizes determine the aligned month label coordinate.",
  },
  {
    path: "apps/web/src/features/runtime/RuntimeCards.tsx",
    expression: "style={{ width: `${props.width}px`, height: `${props.height}px` }}",
    reason: "Stamina meter host geometry: caller-supplied width/height size the Base UI Meter.Root; quota-fill and cell appearance stay in typed StyleX.",
  },
  {
    path: "apps/web/src/features/session/Trajectory.tsx",
    expression: 'style={{ background: sub() && fill().startsWith("#") ? `${fill()}8c` : fill(), color: inkOn(fill()) }}',
    reason:
      "Session trajectory data renderer: tagFill(step) selects run/tool palette data, subagent alpha and inkOn(fill) preserve contrast without altering event classification.",
  },
  {
    path: "apps/web/src/features/session/Trajectory.tsx",
    expression: "style={{ height: `${lane * 3 + gap * 2}px` }}",
    reason: "Session waterfall geometry: total chart height is computed from its shared lane and gap constants; row positions use the same constants.",
  },
  {
    path: "apps/web/src/features/session/Trajectory.tsx",
    expression: "style={{ top: `${i * (lane + gap)}px`, height: `${lane}px` }}",
    reason: "Session waterfall geometry: lane index, lane height and gap determine native row coordinates, matching measured bar placement.",
  },
  {
    path: "apps/web/src/features/session/Trajectory.tsx",
    expression: 'style={{ left: `${b().left}px`, width: `${b().width - 1}px`, top: `${b().top}px`, height: `${lane}px`, "--timeline-color": b().color }}',
    reason:
      "Session waterfall geometry: bars() projects event timestamps through measured chart width to left/width/top/height. --timeline-color carries its event palette; StyleX owns the rest/hover background rule so hover still overrides the event color.",
  },
  {
    path: "apps/web/src/features/session/WorkLog.tsx",
    expression: 'style={{ "flex-grow": Math.max(1, Math.round((Math.max(s().ms, least()) / least()) * 10)), "--timeline-color": spanColor(s().step) }}',
    reason:
      "Session duration chart geometry: rounded duration/minimum-duration ratio determines native flex weight. --timeline-color carries spanColor(step) data; StyleX owns rest/hover background styling.",
  },
  {
    path: "apps/web/src/features/session/WorkLog.tsx",
    expression: 'style={clamp() ? { "max-height": `${props.lines * 22}px` } : undefined}',
    reason:
      "Measured work-log folding boundary: clamp() reflects scrollHeight measurement and open state; max-height is lines * 22 without changing the fold threshold.",
  },
  {
    path: "apps/web/src/features/setting/SettingsPage.tsx",
    expression: 'style={{ "--pane-w": `${navWidth()}px` }}',
    reason: "Resizable settings navigation: --pane-w is the shared geometry contract with Splitter and persisted navWidth; min/max behavior remains unchanged.",
  },
  {
    path: "apps/web/src/features/voice/DictationButton.tsx",
    expression: "style={{ height: `${Math.max(3, level() * 20)}px` }}",
    reason: "Live audio visualization: requestAnimationFrame samples dictation.level(); per-sample height keeps the existing 3px floor and 20px scale.",
  },
  {
    path: "apps/web/src/features/voice/MossPlayground.tsx",
    expression: "style={{ width: `${props.value}%` }}",
    reason: "Live audio/quality visualization: the parent-provided percentage directly determines meter fill width; it is data geometry, not utility dispatch.",
  },
];
