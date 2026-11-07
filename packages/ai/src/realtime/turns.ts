export interface VoiceTurn<Who extends string> {
  readonly who: Who;
  readonly key: string;
  readonly text: string;
  readonly done: boolean;
}

export function appendVoiceTurn<Who extends string>(turns: readonly VoiceTurn<Who>[], who: Who, key: string, text: string, done: boolean): VoiceTurn<Who>[] {
  if (text === "") return [...turns];
  let last: VoiceTurn<Who> | undefined;
  for (const x of turns) if (x.who === who && !x.done && (x.key === "" || key === "" || x.key === key)) last = x;
  if (!last) return [...turns, { who, key, text, done }];
  return turns.map((x) => (x === last ? { ...x, key: key || x.key, text, done } : x));
}
