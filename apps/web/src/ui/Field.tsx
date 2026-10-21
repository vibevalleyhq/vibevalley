import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

const box = "w-full rounded-md border border-line bg-page px-2.5 py-1.5 text-sm outline-none placeholder:text-faint focus:border-focus";

export const TextInput = ({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) => <input className={`${box} h-8 ${className}`} {...rest} />;

export const TextArea = ({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={`${box} resize-y ${className}`} {...rest} />
);

/** A label over its control. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

/** A plain <select> in the pro look; value "" is the placeholder. */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  label,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  label: string;
  className?: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={`${box} h-8 cursor-pointer ${className}`}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
