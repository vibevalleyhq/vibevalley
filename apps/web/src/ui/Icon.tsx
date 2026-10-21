// The pixel icons (apps/web/public/pixel, served at /pixel): drawn whole-pixel, never smoothed. No line icons and no characters
// standing in for icons.

export function Icon({ name, size = 16, label, className = "" }: { name: string; size?: number; label?: string; className?: string }) {
  return (
    <img
      src={`/pixel/${name}.png`}
      width={size}
      height={size}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
      className={`shrink-0 object-contain [image-rendering:pixelated] ${className}`}
    />
  );
}
