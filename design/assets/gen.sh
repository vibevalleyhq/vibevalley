#!/usr/bin/env bash
# The painted sheets the pixel village redraws from (design/pixel/gen.sh ui-<sheet>, look-<look>): the interface's
# icons, medals and logos, and the manager's looks. Drawn with codex's built-in image tool, the approved B mockup as
# reference. Usage: ./gen.sh [name...]   (default: everything)
cd "$(dirname "$0")"

gen() {
  local name="$1"; shift
  local refs=(-i ref-B.png)
  for r in "$@"; do refs+=(-i "$r"); done
  local body="$(cat prompts/_style.txt)

$(cat "prompts/${name}.txt")"
  body="${body}

$(cat prompts/_sheet.txt)"
  draw "$name" "$body" "${refs[@]}"
}

# Runs codex's image tool once: draw NAME PROMPT [-i REF]...
draw() {
  local name="$1" body="$2"; shift 2
  local refs=("$@")
  local prompt="Use your image generation tool to create exactly ONE image as described below. Save the final image in this directory as raw/${name}.png (copy it here from where the tool saved it). Do not write any code or other files. When done, reply with just the file path.

${body}"
  # The image tool sometimes hangs on network timeouts: give each attempt 10 minutes, retry once.
  for attempt in 1 2; do
    codex exec -s workspace-write --skip-git-repo-check "${refs[@]}" -o "logs/${name}.last.txt" -- "$prompt" < /dev/null > "logs/${name}.out.txt" 2>&1 &
    local pid=$!
    ( sleep 600; kill "$pid" 2>/dev/null ) &
    local watchdog=$!
    wait "$pid"
    kill "$watchdog" 2>/dev/null
    if [ -f "raw/${name}.png" ]; then echo "${name}: done (attempt ${attempt})"; return 0; fi
    echo "${name}: attempt ${attempt} produced no image"
  done
  return 1
}

want() { [ -z "$WANT" ] || [[ " ${WANT} " == *" $1 "* ]]; }
WANT="$*"
want manager && gen manager &
# Other looks for the manager, drawn to the same sheet as the current one (Image 2) so the farm can swap them.
for look in foreman auntie grandpa gardener robot; do
  want "manager-$look" && gen "manager-$look" raw/manager.png &
done
want icons && gen icons &
want cursors && gen cursors raw/icons.png &
want machines && gen machines raw/icons.png &
# More of the game's icons, drawn to match the first sheet (Image 2): the interface's items and what a helper is doing.
want icons-more && gen icons-more raw/icons.png &
want actions && gen actions raw/icons.png &
# The achievement wall: medal frames (one per tier) and the pictures placed in them (gen.sh medals, emblems, starter).
want medals && gen medals raw/icons.png &
want emblems && gen emblems raw/icons.png &
want starter && gen starter raw/icons.png &
# The chat apps' logos (connectors), the icons of the 项目 and 连接器 pages, and the sprout the site and app icons use.
want icons-extra && gen icons-extra raw/icons.png &
# What a code base is written in: one logo per language, three sheets of twelve (design/pixel gen.sh ui-langs-1..3 redraws them as lang-<id>).
for n in 1 2 3; do
  want "langs-$n" && gen "langs-$n" raw/icons.png &
done
wait
echo all-done
