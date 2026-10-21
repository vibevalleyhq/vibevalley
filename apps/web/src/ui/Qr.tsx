import { useMemo } from "react";
import { renderSVG } from "uqr";

/** A QR code of text, black on white with its quiet zone. */
export function Qr({ text, size = 208, label }: { text: string; size?: number; label: string }) {
  const svg = useMemo(() => renderSVG(text, { border: 2 }), [text]);
  return (
    <span
      role="img"
      aria-label={label}
      className="block bg-white [&>svg]:h-full [&>svg]:w-full"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
