// A glob's files by their names: Vite keys an aliased glob (@game/…, @shots/…) by a path of its own choosing, so the
// pages look a picture up by its file's name, which each glob holds once.

export const byName = <T>(files: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(files).map(([path, file]) => [path.slice(path.lastIndexOf('/') + 1), file]))
