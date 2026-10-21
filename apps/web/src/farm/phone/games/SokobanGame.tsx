// 推箱子 on the phone: the rules are sokoban.ts; the warehouse is kept while the
// phone is away or a call comes in.

import { playSound } from "../../sound";
import { lcd } from "../lcd";
import { kept, usePad } from "../pad";
import { moveWarehouse, newWarehouse, undoWarehouse, warehouseDone, warehouses } from "./sokoban";

const warehouse = kept(newWarehouse());

export function SokobanGame() {
  const [g, setG] = warehouse.use();
  const done = warehouseDone(g);
  const last = g.level === warehouses.length - 1;
  const level = warehouses[g.level]!;
  const width = level.rows[0]!.length;
  const cells = level.rows.join("");
  const placed = g.boxes.filter((p) => cells[p] === ".").length;
  const restart = () => setG(newWarehouse(g.level));
  const advance = () => setG(newWarehouse(last ? 0 : g.level + 1));
  const undo = () => setG(undoWarehouse(g));

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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2">
      <div className="flex justify-between">
        <span>
          推箱子 {g.level + 1}/{warehouses.length}
        </span>
        <span>
          {g.moves} 步 · {g.pushes} 推
        </span>
      </div>
      <p className="text-center">{level.name}</p>
      <svg
        role="img"
        aria-label={`仓库棋盘，${placed}/${g.boxes.length} 箱已归位`}
        viewBox={`0 0 ${width * 16} ${level.rows.length * 16}`}
        className="mx-auto block w-full max-w-[224px]"
        shapeRendering="crispEdges"
      >
        {level.rows.flatMap((row, y) =>
          [...row].map((tile, x) => {
            const p = y * width + x;
            return (
              <g key={p} transform={`translate(${x * 16},${y * 16})`}>
                <rect width="16" height="16" fill={tile === "#" ? lcd.dark : lcd.light} />
                {tile === "#" ? <path d="M0 7.5h16M7.5 0v7M3.5 8v8" stroke={lcd.ink} /> : <rect x="1" y="1" width="14" height="14" fill={lcd.paper} />}
                {tile === "." && <path d="M8 4l4 4-4 4-4-4z" fill={lcd.mid} />}
                {g.boxes.includes(p) && (
                  <g>
                    <rect x="2.5" y="2.5" width="11" height="11" fill={tile === "." ? lcd.mid : lcd.dark} stroke={lcd.ink} />
                    <path d="M4 4l8 8m0-8l-8 8" stroke={lcd.paper} />
                    {tile === "." && <rect x="6" y="6" width="4" height="4" fill={lcd.ink} />}
                  </g>
                )}
                {g.player === p && (
                  <g fill={lcd.ink}>
                    <path d="M5 2h6v3H3v2h10V5h-2M5 8h6v5H5zM4 13h3v2H4zm5 0h3v2H9z" />
                    <rect x="6" y="5" width="4" height="3" fill={lcd.paper} />
                  </g>
                )}
              </g>
            );
          }),
        )}
      </svg>
      <p role="status" className="text-center">
        {done ? (last ? "收成全部入仓！" : "这一仓收拾好了！") : "把木箱推到 ◆ 上"}
      </p>
      <div className="mt-auto flex justify-center gap-3">
        <button
          type="button"
          onClick={undo}
          disabled={!g.history.length}
          className="cursor-pointer px-2 py-1 disabled:cursor-default disabled:opacity-40"
          style={{ boxShadow: `inset 0 0 0 1px ${lcd.ink}` }}
        >
          B 撤销
        </button>
        <button type="button" onClick={done ? advance : restart} className="cursor-pointer px-2 py-1" style={{ boxShadow: `inset 0 0 0 1px ${lcd.ink}` }}>
          A {done ? (last ? "再玩一轮" : "下一关") : "重开"}
        </button>
      </div>
      <p className="text-center" style={{ color: lcd.dark }}>
        方向键走动 · 箱子只能推
      </p>
    </div>
  );
}
