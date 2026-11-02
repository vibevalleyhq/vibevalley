export const nullText = (s: string | undefined) => {
  const text = (s ?? "").trim();
  return text === "" ? null : text;
};

export const jsonOrNull = (v: unknown, there: boolean) => (there ? JSON.stringify(v) : null);
