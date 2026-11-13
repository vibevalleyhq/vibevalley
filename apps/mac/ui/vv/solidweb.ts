// The types of @solidjs/web the reused VibeValley code names, on nsh.
import type { JSX as NshJSX } from "nsh";

export declare namespace JSX {
  type Element = NshJSX.Element;
  /** A class as Solid takes it: a string, a list, or names switched by flags. */
  type ClassValue = string | false | null | undefined | readonly ClassValue[] | Readonly<Record<string, boolean | null | undefined>>;
}
