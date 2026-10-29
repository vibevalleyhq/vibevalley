import type { JSX } from "@solidjs/web";

/** A control's kind matches its argument's type: a new kind also goes into ControlOf below. */
export type Control =
  | { readonly kind: "text"; readonly long?: boolean }
  | { readonly kind: "boolean" }
  | { readonly kind: "number"; readonly min?: number; readonly max?: number; readonly step?: number }
  | { readonly kind: "choice"; readonly options: readonly string[] };

/** A story's arguments: plain values, so they fit in the panel and the address. */
export type Args = Record<string, string | number | boolean>;

type ControlOf<V> = V extends boolean ? { kind: "boolean" } : V extends number ? Control & { kind: "number" } : Control & { kind: "text" | "choice" };

type Loose = Record<string, unknown>;

/** `args: { open: false }` is read as open: boolean, not as the type false, so the story can set it to true. */
type Widen<A> = { [K in keyof A]: A[K] extends boolean ? boolean : A[K] extends string ? string : A[K] extends number ? number : A[K] };

/** One side of a state grid: an argument and the values it takes along that side, or the interaction states (rest,
 * hover, focus, pressed), forced without the pointer (pseudo.ts). */
export type Axis<A> = readonly [name: keyof A & string, values: readonly (string | number | boolean)[]] | "pseudo";

export interface Story<A extends Loose = Args> {
  /** Called once each time the story opens; `args` is a store, read it inside JSX to follow the panel. `set` lets the
   * component write back (a toggle that was clicked), so the panel and the component agree. A method, so a story of
   * its own arguments fits where any story goes. */
  render(args: Widen<A>, set: (patch: Partial<Widen<A>>) => void): JSX.Element;
  readonly args?: A;
  readonly controls?: { readonly [K in keyof A]?: ControlOf<A[K]> };
  /** One line under the story's name: what to look at, or why it is drawn this way. */
  readonly note?: string;
  /** Laid out as a page fills its space (a pane, a dialog), instead of centred at its own size. */
  readonly fill?: boolean;
  /** A cell for each row and column, the rest of the arguments from the panel. */
  readonly grid?: { readonly rows?: Axis<A>; readonly cols?: Axis<A> };
}

export interface Stories {
  /** Where the stories sit in the tree, as a path: "组件/工作台/Button". */
  readonly title: string;
  readonly stories: Readonly<Record<string, Story>>;
  /** The themes the parts follow; a skin with colours of its own (the pixel farm) is drawn in its one. Both by default. */
  readonly themes?: readonly ("light" | "dark")[];
  /** Classes for the frames' ground and type, for parts that are only ever drawn on one (the farm's paper). */
  readonly frame?: string;
}

export const story = <A extends Loose>(s: Story<A>): Story<A> => s;

/** Each `*.stories.tsx` default-exports one of these. */
export const stories = (s: Stories): Stories => s;
