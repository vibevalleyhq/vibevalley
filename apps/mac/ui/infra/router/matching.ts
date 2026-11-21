import { z } from "zod";

import { attemptCodec, type SearchCheck } from "./search";

type Parameter<S extends string> = S extends `:${infer Name}` ? Name : S extends "*" ? "rest" : never;
type Names<P extends string> = P extends `${infer Head}/${infer Tail}` ? Parameter<Head> | Names<Tail> : Parameter<P>;
export type Params<P extends string> = Readonly<Record<Names<P>, string>>;

type Segment = { readonly kind: "literal"; readonly value: string } | { readonly kind: "param"; readonly name: string } | { readonly kind: "rest" };

interface PathPattern<P extends string = string> {
  readonly path: P;
  readonly segments: readonly Segment[];
  readonly build: (params: Params<P>) => string;
  readonly match: (pathname: string) => Params<P> | undefined;
}

export function pathSegments(pathname: string): readonly string[] | undefined {
  try {
    return pathname.split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

function segmentsOf(path: string): readonly Segment[] {
  if (path !== "*" && !path.startsWith("/")) throw new Error(`Route must be absolute: ${path}`);
  const names = new Set<string>();
  return path.split("/").map((part, index, all): Segment => {
    if (part === "*") {
      if (index !== all.length - 1 || names.has("rest")) throw new Error(`Route splat must be last and unique: ${path}`);
      names.add("rest");
      return { kind: "rest" };
    }
    if (part.startsWith(":")) {
      const name = part.slice(1);
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(name) || names.has(name)) throw new Error(`Invalid or duplicate route parameter: ${path}`);
      names.add(name);
      return { kind: "param", name };
    }
    if (/[?:*#]/u.test(part)) throw new Error(`Unsupported route pattern: ${path}`);
    const value = decodeURIComponent(part);
    return { kind: "literal", value };
  });
}

function hasParameters<P extends string>(segments: readonly Segment[], values: Record<string, string>): values is Params<P> {
  return segments.every((part) => part.kind === "literal" || Object.hasOwn(values, part.kind === "rest" ? "rest" : part.name));
}

function patternOf<const P extends string>(path: P): PathPattern<P> {
  const segments = segmentsOf(path);
  return {
    path,
    segments,
    build: (params) => {
      const values: Readonly<Record<string, string>> = params;
      return segments
        .map((part) => {
          switch (part.kind) {
            case "literal":
              return encodeURIComponent(part.value);
            case "param": {
              const value = values[part.name];
              if (!value) throw new Error(`Missing route parameter: ${part.name}`);
              if (value === "." || value === "..") throw new Error(`Route parameter cannot be a relative segment: ${part.name}`);
              return encodeURIComponent(value);
            }
            case "rest": {
              const value = values.rest;
              if (value === undefined) throw new Error("Missing route parameter: rest");
              if (/[?#]/u.test(value) || !pathSegments(value)) throw new Error("Invalid encoded route remainder");
              return value;
            }
          }
        })
        .join("/");
    },
    match: (pathname) => {
      const input = pathSegments(pathname);
      if (!input) return undefined;
      const values: Record<string, string> = {};
      for (const [index, part] of segments.entries()) {
        const value = input[index];
        switch (part.kind) {
          case "literal":
            if (value !== part.value) return undefined;
            break;
          case "param":
            if (!value) return undefined;
            Object.defineProperty(values, part.name, { value, enumerable: true });
            break;
          case "rest":
            Object.defineProperty(values, "rest", { value: pathname.split("/").slice(index).join("/"), enumerable: true });
            break;
        }
      }
      if (segments.at(-1)?.kind !== "rest" && segments.length !== input.length) return undefined;
      return hasParameters<P>(segments, values) ? values : undefined;
    },
  };
}

export interface RoutePath<P extends string = string, T extends object = Params<P>> {
  readonly path: P;
  readonly segments: readonly Segment[];
  readonly build: (params: T) => string;
  readonly match: (pathname: string) => T | undefined;
  readonly resolve: (pathname: string, search: string) => "missing" | "invalid" | "matched";
}
export function route<const P extends string>(path: P, options?: { search?: SearchCheck }): RoutePath<P>;
export function route<const P extends string, T extends object>(path: P, options: { params: z.ZodType<T, Params<P>>; search?: SearchCheck }): RoutePath<P, T>;
export function route(path: string, options?: { params?: z.ZodType<object, Readonly<Record<string, string>>>; search?: SearchCheck }): unknown {
  const pattern = patternOf(path);
  const schema = options?.params ?? z.record(z.string(), z.string());
  // undefined: the path is not this route's; { value: undefined }: it is, with parameters that do not decode.
  const parse = (pathname: string) => {
    const input = pattern.match(pathname);
    return input === undefined ? undefined : { value: attemptCodec(() => z.safeDecode(schema, input)) };
  };
  return {
    path,
    segments: pattern.segments,
    build: (params: object) => {
      const result = attemptCodec(() => z.safeEncode(schema, params));
      if (result === undefined) throw new Error("Invalid route parameters");
      return pattern.build(result);
    },
    match: (pathname: string) => {
      const result = parse(pathname);
      return result?.value;
    },
    resolve: (pathname: string, text: string) => {
      const result = parse(pathname);
      if (result === undefined) return "missing";
      return result.value !== undefined && (options?.search?.valid(text) ?? true) ? "matched" : "invalid";
    },
  };
}

const priority = (segment: Segment | undefined) => (segment === undefined ? 1 : segment.kind === "literal" ? 3 : segment.kind === "param" ? 2 : 0);

export function compareRoutes(a: Pick<RoutePath, "segments">, b: Pick<RoutePath, "segments">): number {
  for (let index = 0; index < Math.max(a.segments.length, b.segments.length); index++) {
    const difference = priority(b.segments[index]) - priority(a.segments[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function ambiguousRoutes(a: Pick<RoutePath, "segments">, b: Pick<RoutePath, "segments">): boolean {
  if (compareRoutes(a, b) !== 0) return false;
  return a.segments.every((part, index) => {
    const other = b.segments[index];
    return part.kind !== "literal" || other?.kind !== "literal" || part.value === other.value;
  });
}
