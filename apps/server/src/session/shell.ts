// codex runs every command as `/bin/zsh -lc '<command>'`; the label shows the
// command, not the shell around it.

const shellWrap = /^(?:\S*\/)?(?:zsh|bash|sh) -l?c (.+)$/s;

/** The command inside a shell's -c, read as the one shell word the shell would see; anything else comes back as it is. */
export function shellCommand(command: string): string {
  const m = shellWrap.exec(command.trim());
  if (!m) return command;
  const word = shellWord(m[1]!);
  return word ?? command;
}

/** POSIX quoting: '…' as written, "…" with \" \\ \$ \` escaped, and bare characters with \ escaping one. */
function shellWord(s: string): string | undefined {
  let out = "";
  for (let i = 0; i < s.length;) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return undefined;
      out += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= s.length) return undefined;
        if (s[i] === '"') {
          i++;
          break;
        }
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) {
          out += s[i + 1];
          i += 2;
          continue;
        }
        out += s[i];
        i++;
      }
    } else if (c === "\\") {
      if (i + 1 >= s.length) return undefined;
      out += s[i + 1];
      i += 2;
    } else if (c === " " || c === "\t" || c === "\n") return undefined;
    else {
      out += c;
      i++;
    }
  }
  return out;
}
