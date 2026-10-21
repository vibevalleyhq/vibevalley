// The farm chat window's words about a message: its clock time, and whether it is long enough to fold.

export const farmClock = (at: number) => {
  const d = new Date(Math.round(at));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Long enough to fold: over 240 characters, eight lines or more, a heading or a code block. */
export const readsLong = (text: string) => text.length > 240 || (text.match(/\n/g)?.length ?? 0) >= 8 || /^(#{1,6} |```)/m.test(text);
