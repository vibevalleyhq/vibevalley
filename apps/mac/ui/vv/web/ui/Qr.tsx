// Ported from VibeValley apps/web/src/ui/Qr.tsx: the same encoder (uqr), its
// modules drawn on a Canvas instead of parsed from its SVG.
import { Canvas } from "nsh";
import { encode } from "uqr";

/** A QR code of text, black on white with its quiet zone. */
export function Qr(props: { text: string; size?: number; label: string }) {
  const size = () => props.size ?? 208;
  const code = () => encode(props.text, { border: 2 });
  return (
    <Canvas
      role="image"
      accessible
      accessibilityLabel={props.label}
      style={{ width: size(), height: size(), backgroundColor: "#ffffff" }}
      draw={(cx) => {
        const { data, size: n } = code();
        const cell = size() / n;
        cx.fillStyle = "#000000";
        for (let y = 0; y < n; y++) {
          const row = data[y];
          if (!row) continue;
          for (let x = 0; x < n; x++) if (row[x]) cx.fillRect(x * cell, y * cell, cell + 0.02, cell + 0.02);
        }
      }}
    />
  );
}
