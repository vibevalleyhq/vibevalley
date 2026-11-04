// What a project is made from that the page checks as the owner types and the server checks again before it clones.

const githubURL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/u;

/** Only repository home URLs: never credentials, other git transports or command-line options. */
export function githubRepository(input: string): { name: string; url: string } | undefined {
  const m = githubURL.exec(input.trim());
  if (!m) return undefined;
  const name = (m[2] ?? "").replace(/\.git$/u, "");
  if (name === "" || name === "." || name === "..") return undefined;
  return { name, url: `https://github.com/${m[1] ?? ""}/${name}.git` };
}
