export const byName = <T>(files: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(files).map(([path, file]) => [path.slice(path.lastIndexOf("/") + 1), file]));
