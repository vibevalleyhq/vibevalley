// Renders a QR code matrix provided by `DesignHost.renderQr` onto a Canvas.
import { Canvas, effect, signal } from "nsh";

import { useDesignHost, type QrMatrix } from "./host";

/** A QR code of text, black on white with its quiet zone. */
export function Qr(props: { text: string; size?: number; label: string }) {
  const designHost = useDesignHost();
  const size = () => props.size ?? 208;
  const matrix = signal<QrMatrix | undefined>(undefined);
  let request = 0;

  effect(() => {
    const text = props.text;
    const seq = ++request;
    void designHost
      .renderQr(text, 2)
      .then((data) => {
        if (seq !== request) return;
        matrix.set(data);
      })
      .catch(() => {
        if (seq === request) matrix.set(undefined);
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
