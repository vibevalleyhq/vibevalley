// 推箱子 on the phone: the rules are farm/phone/games/sokoban.ts; the warehouse is kept while the phone is away or a
// call comes in.

import { phoneWording } from "../words";
import { For, Show } from "solid-js";
import { moveWarehouse, newWarehouse, undoWarehouse, warehouseDone, warehouses } from "./sokoban";
import { lcd } from "../lcd";
import { playSound } from "../../../ui/pixel/sound";
import { kept, usePad } from "../../support";

const warehouse = kept(newWarehouse());

export function SokobanGame() {
  const [g, setG] = warehouse.use();
  const done = () => warehouseDone(g());
  const last = () => g().level === warehouses.length - 1;
  const level = () => warehouses[g().level]!;
  const width = () => level().rows[0]!.length;
  const cells = () => level().rows.join("");
  const placed = () => g().boxes.filter((p) => cells()[p] === ".").length;
  const restart = () => setG(newWarehouse(warehouse.get().level));
  const advance = () => {
    const now = warehouse.get();
    setG(newWarehouse(now.level === warehouses.length - 1 ? 0 : now.level + 1));
  };
  const undo = () => setG(undoWarehouse(warehouse.get()));

  usePad((button, down) => {
    if (!down) return;
    const now = warehouse.get();
    switch (button) {
      case "a":
        return warehouseDone(now) ? advance() : restart();
      case "b":
        return undo();
      case "left":
      case "right":
      case "up":
      case "down": {
        const next = moveWarehouse(now, button);
        if (next === now) return;
        if (warehouseDone(next)) playSound("coin");
        else if (next.pushes > now.pushes) playSound("thud");
        setG(next);
      }
    }
  });

  const tiles = () => level().rows.flatMap((row, y) => [...row].map((tile, x) => ({ tile, x, y, p: y * width() + x })));

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2">
      <div class="flex justify-between">
        <span>{phoneWording().sokoban.title(g().level + 1, warehouses.length)}</span>
        <span>{phoneWording().sokoban.moves(g().moves, g().pushes)}</span>
      </div>
      <p class="text-center">{level().name}</p>
      <svg
        role="img"
        aria-label={phoneWording().sokoban.board(placed(), g().boxes.length)}
        viewBox={`0 0 ${width() * 16} ${level().rows.length * 16}`}
        class="mx-auto block w-full max-w-[224px]"
        shape-rendering="crispEdges"
      >
        <For each={tiles()} keyed={false}>
          {(t) => (
            <g transform={`translate(${t().x * 16},${t().y * 16})`}>
              <rect width="16" height="16" fill={t().tile === "#" ? lcd.dark : lcd.light} />
              <Show when={t().tile === "#"} fallback={<rect x="1" y="1" width="14" height="14" fill={lcd.paper} />}>
                <path d="M0 7.5h16M7.5 0v7M3.5 8v8" stroke={lcd.ink} />
              </Show>
              <Show when={t().tile === "."}>
                <path d="M8 4l4 4-4 4-4-4z" fill={lcd.mid} />
              </Show>
              <Show when={g().boxes.includes(t().p)}>
                <g>
                  <rect x="2.5" y="2.5" width="11" height="11" fill={t().tile === "." ? lcd.mid : lcd.dark} stroke={lcd.ink} />
                  <path d="M4 4l8 8m0-8l-8 8" stroke={lcd.paper} />
                  <Show when={t().tile === "."}>
                    <rect x="6" y="6" width="4" height="4" fill={lcd.ink} />
                  </Show>
                </g>
              </Show>
              <Show when={g().player === t().p}>
                <g fill={lcd.ink}>
                  <path d="M5 2h6v3H3v2h10V5h-2M5 8h6v5H5zM4 13h3v2H4zm5 0h3v2H9z" />
                  <rect x="6" y="5" width="4" height="3" fill={lcd.paper} />
                </g>
              </Show>
            </g>
          )}
        </For>
      </svg>
      <p role="status" class="text-center">
        {done() ? (last() ? phoneWording().sokoban.allIn : phoneWording().sokoban.done) : phoneWording().sokoban.goal}
      </p>
      <div class="mt-auto flex justify-center gap-3">
        <button
          type="button"
          onClick={undo}
          disabled={!g().history.length}
          class="cursor-pointer px-2 py-1 disabled:cursor-default disabled:opacity-40"
          style={{ "box-shadow": `inset 0 0 0 1px ${lcd.ink}` }}
        >
          {phoneWording().sokoban.undo}
        </button>
        <button
          type="button"
          onClick={() => (done() ? advance() : restart())}
          class="cursor-pointer px-2 py-1"
          style={{ "box-shadow": `inset 0 0 0 1px ${lcd.ink}` }}
        >
          A {done() ? (last() ? phoneWording().sokoban.again : phoneWording().sokoban.next) : phoneWording().sokoban.restart}
        </button>
      </div>
      <p class="text-center" style={{ color: lcd.dark }}>
        {phoneWording().sokoban.help}
      </p>
    </div>
  );
}
