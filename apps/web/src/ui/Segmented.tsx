export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  block = false,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  block?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={`inline-flex flex-wrap gap-0.5 rounded-md bg-hover p-0.5 ${block ? "flex w-full" : ""}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`h-6 cursor-pointer rounded px-2.5 disabled:cursor-default disabled:opacity-40 text-sm whitespace-nowrap ${block ? "flex-1" : ""} ${o.value === value ? "bg-page font-medium shadow-[0_1px_2px_#2f1f1326]" : "text-muted hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
