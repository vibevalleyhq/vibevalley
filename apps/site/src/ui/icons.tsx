/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";

export type IconName =
  | "arrow-down"
  | "board"
  | "book"
  | "branch"
  | "chat"
  | "check"
  | "checklist"
  | "clock"
  | "close"
  | "copy"
  | "edit"
  | "harvest"
  | "history"
  | "home"
  | "layout"
  | "message"
  | "search"
  | "seedling"
  | "spark"
  | "terminal"
  | "warning";

const PATHS: Record<IconName, readonly string[]> = {
  "arrow-down": ["M12 5v14", "m19 12-7 7-7-7"],
  board: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z", "M9 3v18", "M15 3v18", "M3 9h18"],
  book: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20", "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"],
  branch: ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M18 9a9 9 0 0 1-9 9"],
  chat: [
    "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z",
  ],
  check: ["M20 6 9 17l-5-5"],
  checklist: ["M9 11l3 3L22 4", "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 6v6l4 2"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  copy: ["M9 9h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  edit: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"],
  harvest: ["M12 22V8", "M5 12H2a10 10 0 0 0 20 0h-3", "M12 8c0-3 2.5-5 6-5 0 3.5-2 6-6 6", "M12 8c0-3-2.5-5-6-5 0 3.5 2 6 6 6"],
  history: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3 2"],
  home: ["M3 10.5 12 3l9 7.5", "M5 9.5V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.5", "M9 21v-6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6"],
  layout: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z", "M3 9h18", "M10 9v12"],
  message: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z", "M8 9h8", "M8 13h5"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "m21 21-4.35-4.35"],
  seedling: ["M12 22V10", "M12 14c-4.5 0-8-3-8-7.5 4.5 0 8 3 8 7.5Z", "M12 10c4.5 0 8-3 8-7.5-4.5 0-8 3-8 7.5Z"],
  spark: ["M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7L12 3Z", "M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"],
  terminal: ["m4 17 6-5-6-5", "M12 19h8"],
  warning: ["M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z", "M12 9v4", "M12 17h.01"],
};

export function Icon(props: { name: IconName; class?: JSX.ClassValue | undefined }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={["shrink-0", props.class]}
    >
      {PATHS[props.name].map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}
