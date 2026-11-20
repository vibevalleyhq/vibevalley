// Renders a QR code matrix computed in Rust (`host.qr`) onto a Canvas.
import { Canvas, effect, signal } from "nsh";

import { transport } from "../infra/transport";

interface QrMatrix {
  readonly size: number;
  readonly rows: readonly string[];
}

function isQrMatrix(data: unknown): data is QrMatrix {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as { size?: unknown; rows?: unknown };
  return typeof candidate.size === "number" && candidate.size > 0 && Array.isArray(candidate.rows);
}

/** A QR code of text, black on white with its quiet zone. */
export function Qr(props: { text: string; size?: number; label: string }) {
  const size = () => props.size ?? 208;
  const matrix = signal<QrMatrix | null>(null);
  let request = 0;

  effect(() => {
    const text = props.text;
    const seq = ++request;
    void transport()
      .call("host.qr", { text, border: 2 })
      .then((envelope) => {
        if (seq !== request) return;
        matrix.set(envelope.bizCode === 0 && isQrMatrix(envelope.data) ? envelope.data : null);
      })
      .catch(() => {
        if (seq === request) matrix.set(null);
      });
  });

  return (
    <Canvas
      role="image"
      accessible
      accessibilityLabel={props.label}
      style={{ width: size(), height: size(), backgroundColor: "#ffffff" }}
      draw={(cx) => {
        const code = matrix();
        if (!code) return;
        const cell = size() / code.size;
        cx.fillStyle = "#000000";
        for (let y = 0; y < code.size; y++) {
          const row = code.rows[y];
          if (!row) continue;
          for (let x = 0; x < code.size; x++) if (row.charCodeAt(x) === 49) cx.fillRect(x * cell, y * cell, cell + 0.02, cell + 0.02);
        }
      }}
    />
  );
}
