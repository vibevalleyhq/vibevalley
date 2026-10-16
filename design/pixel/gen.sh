#!/usr/bin/env bash
# Generate the pixel village's pictures with codex's built-in image tool (the pixel village, app/assets/pixel).
# Usage: ./gen.sh [name...]   (default: map plots manager char-bear)
#   map plots manager props     the village, its plots, the dog and mailbox, the props the panels open from
#   foreground                  plants right in front of the camera that frame the view (a parallax layer)
#   dog                         the dog in twelve poses (asleep, waking, stretching, wagging, barking, jumping...)
#   hd-<name>                   a picture redrawn at twice the pixel density, same layout (the denser-pixels trial)
#   ragdoll bluecat             the other pets (a seal-point Ragdoll, a blue British Shorthair) in the dog's twelve poses
#   energy buttons calendar     the energy bottles, the chat's button glyphs, the calendar's day tiles (pixel only)
#   media                       the sound buttons (play, pause, stop, speaker...), from Hugeicons' shapes (icons/ref.py
#                               lays them out as raw/media-ref.png); then hd-media at the game's density
#   glyphs                      the interface's marks and small buttons (close, add, delete, next, check, cross, warning,
#                               copy), the same way (raw/glyphs-ref.png), beside the sound buttons; then hd-glyphs
#   tools                       more buttons (refresh, folder, search, edit, open, filter, settings, more), the same way
#                               (raw/tools-ref.png), beside the glyphs; then hd-tools
#   owner                       the owner's face for the chat, in the manager's portrait style; then hd-owner
#   critters                    butterflies, birds, a leaping fish, falling leaves for the yard
#   pose-<species>[-<outfit>]   six more poses for a helper (sitting, reading, hammering, working at something),
#                               drawn from its sheet (raw/char-<species>[-<outfit>].png)
#   app-icon dmg-background splash   the desktop app's pictures, in pixel art (app-icon: app/macos AppIcon)
#   title                       the title screen's background, behind the start menu (app/assets/title): the evening
#   title-morning title-day title-night   the same scene at other hours, from raw/title.png
#   title-clouds title-smoke title-dandelion title-plants   what moves over the title (title_layers.py cuts them)
#   title[-morning|-day|-night]-nosmoke   each scene without its chimney smoke, which the page animates instead
#   title[-morning|-day|-night]-empty     and without the farmer and the dog, drawn over it as sprites:
#   title-manager title-dog title-ragdoll title-bluecat   the farmer's four poses, each pet's four frames
#   char-<species>              an animal in the farmer outfit; after the bear they take raw/char-bear.png as reference
#   char-<species>-<outfit>     the same animal in another outfit (gardener, rain, winter), from its farmer sheet
#   logos                       the runtimes' logos (logos/, from LobeHub Icons) as pixel art
#   ui-<sheet>                  a painted interface sheet (design/assets/raw/<sheet>.png) redrawn as pixel art, same grid
#                               (ui-langs-1..3: the language logos, letters kept)
#   look-<look>                 a manager look (farmer, foreman, auntie, grandpa, gardener, robot), from its painted sheet
#   island-<rim>                a project's small map on the map page: an island with an empty yard for its worktrees'
#                               plots (meadow, orchard, pond, pines, windmill, lavender); then hd-island-<rim>
#   mapbits                     the map page's icon and bits (compass, a queued job's sack, a free spot's stake, a cloud,
#                               a branch); then hd-mapbits
cd "$(dirname "$0")"

# The art pixel size in the generated image: the map is shrunk 4x, sheets 8x (process.py).
style() { sed "s/ART_PX/$1/g" prompts/_style.txt; }

# Each animal, and what it does when it works: "who|tool action".
who() {
  case "$1" in
    bear) echo 'a brown bear|digging with a pitchfork pushed into the ground' ;;
    rabbit) echo 'a white rabbit with long ears|tilting a green watering can, water pouring out' ;;
    fox) echo 'an orange little fox with a fluffy white-tipped tail|kneeling, planting with a hand trowel' ;;
    cat) echo 'a grey-and-white cat|swinging a small hoe down into the soil' ;;
    owl) echo 'a brown owl with round glasses|raking the soil with a small rake' ;;
    hedgehog) echo 'a hedgehog with brown spines|scooping soil with a small shovel' ;;
    raccoon) echo 'a raccoon with a ringed tail and a dark eye mask|holding a lantern low and pulling a weed' ;;
  esac
}

# What grows on each island's rim, around its yard (no "|" or "&": they go through sed).
rim() {
  case "$1" in
    meadow) echo 'a big old oak tree with a wide round crown at the top-left corner, two round flowering bushes at the top-right, a small haystack on the left side, a wooden bench on the right side, wildflowers (yellow, white and violet) and tufts of tall grass along the sides, a few flat stepping stones beside the path' ;;
    orchard) echo 'small apple trees full of red apples along the back (top) and one on each side, two wicker baskets of apples and a wooden ladder leaning on a tree on the left side, a wooden wheelbarrow on the right side, a few fallen apples in the grass' ;;
    pond) echo 'a small round pond with lily pads, reeds and cattails on the right side, with a tiny wooden jetty, a weeping willow at the top-left corner, mossy stones and blue wildflowers along the left side' ;;
    pines) echo 'dark green pine trees along the back (top) and the left side, mossy grey boulders, a tiny wooden tool shed with a mossy roof at the top-right corner, a woodpile and a tree stump with an axe in it on the right side, ferns' ;;
    windmill) echo 'a small wooden windmill with cream canvas sails at the top-right corner, flour sacks stacked by its door, a low dry-stone wall along the left side, red poppies and golden grass along the sides, an old cart wheel leaning on the wall' ;;
    lavender) echo 'three white wooden beehives on the left side, a strip of purple lavender bushes along the back (top), a small stone water trough and a watering can on the right side, tall sunflowers at the top-right corner' ;;
  esac
}

# Runs codex's image tool once: draw NAME PROMPT [-i REF]...
draw() {
  local name="$1" body="$2"; shift 2
  local prompt="Use your image generation tool to create exactly ONE image as described below. Save the final image in this directory as raw/${name}.png (copy it here from where the tool saved it). Do not write any code or other files. When done, reply with just the file path.

${body}"
  for attempt in 1 2; do
    codex exec -s workspace-write --skip-git-repo-check "$@" -o "logs/${name}.last.txt" -- "$prompt" < /dev/null > "logs/${name}.out.txt" 2>&1 &
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

gen() {
  local name="$1"
  case "$name" in
    map) draw map "$(style 4)

$(cat prompts/map.txt)" ;;
    props|foreground) draw "$name" "$(style 8)

$(cat "prompts/${name}.txt")

$(cat prompts/_sheet.txt)" -i raw/map.png ;;
    hd-map-nosmoke) draw hd-map-nosmoke "$(style 2)

$(cat prompts/hd-map-nosmoke.txt)" -i raw/hd-map.png ;;
    hd-map) draw hd-map "$(style 2)

$(cat prompts/_hd.txt)" -i raw/map.png ;;
    island-*) draw "$name" "$(style 6)

$(sed "s|ISLAND_RIM|$(rim "${name#island-}")|" prompts/island.txt)

$(cat prompts/_sheet.txt)" -i raw/map.png ;;
    hd-island-*) draw "$name" "$(style 3)

$(cat prompts/_hd.txt)

$(cat prompts/_sheet.txt)" -i "raw/${name#hd-}.png" ;;
    mapbits) draw mapbits "$(style 8)

$(cat prompts/mapbits.txt)

$(cat prompts/_sheet.txt)" -i raw/ui-icons.png -i raw/map.png ;;
    hd-ui-langs-*) draw "$name" "$(style 4)

$(cat prompts/_hd.txt)

$(cat prompts/_hd-letters.txt)

$(cat prompts/_sheet.txt)" -i "raw/${name#hd-}.png" ;;
    hd-*) draw "$name" "$(style 4)

$(cat prompts/_hd.txt)

$(cat prompts/_sheet.txt)" -i "raw/${name#hd-}.png" ;;
    ragdoll|bluecat) draw "$name" "$(style 8)

$(cat "prompts/${name}.txt")

$(cat prompts/_sheet.txt)" -i raw/dog.png ;;
    dog) draw dog "$(style 8)

$(cat prompts/dog.txt)

$(cat prompts/_sheet.txt)" -i raw/manager.png ;;
    media) draw media "$(style 8)

$(cat prompts/media.txt)

$(cat prompts/_sheet.txt)" -i raw/media-ref.png -i raw/ui-icons.png ;;
    glyphs) draw glyphs "$(style 8)

$(cat prompts/glyphs.txt)

$(cat prompts/_sheet.txt)" -i raw/glyphs-ref.png -i raw/media.png ;;
    tools) draw tools "$(style 8)

$(cat prompts/tools.txt)

$(cat prompts/_sheet.txt)" -i raw/tools-ref.png -i raw/glyphs.png ;;
    owner) draw owner "$(style 8)

$(cat prompts/owner.txt)

$(cat prompts/_sheet.txt)" -i raw/look-farmer.png ;;
    energy|buttons|calendar) draw "$name" "$(style 8)

$(cat "prompts/${name}.txt")

$(cat prompts/_sheet.txt)" -i raw/ui-icons.png ;;
    critters) draw critters "$(style 8)

$(cat prompts/critters.txt)

$(cat prompts/_sheet.txt)" -i raw/map.png ;;
    pose-*)
      local rest="${name#pose-}"
      draw "$name" "$(style 8)

$(cat prompts/pose.txt)

$(cat prompts/_sheet.txt)" -i "raw/char-${rest}.png" ;;
    app-icon) draw app-icon "$(style 8)

$(cat prompts/app-icon.txt)" -i raw/manager.png ;;
    dmg-background) draw dmg-background "$(style 4)

$(cat prompts/dmg-background.txt)" -i raw/map.png ;;
    splash) draw splash "$(style 4)

$(cat prompts/splash.txt)" -i raw/map.png -i raw/manager.png ;;
    title) draw title "$(style 4)

$(cat prompts/title.txt)" -i raw/map.png -i raw/manager.png ;;
    title-morning|title-day|title-night) draw "$name" "$(style 4)

$(cat "prompts/$name.txt")" -i raw/title.png ;;
    title-nosmoke|title-morning-nosmoke|title-day-nosmoke|title-night-nosmoke) draw "$name" "$(style 4)

$(cat prompts/title-nosmoke.txt)" -i "raw/${name%-nosmoke}.png" ;;
    title-empty|title-morning-empty|title-day-empty|title-night-empty) draw "$name" "$(style 4)

$(cat prompts/title-empty.txt)" -i "raw/${name%-empty}-nosmoke.png" ;;
    title-manager|title-dog|title-ragdoll|title-bluecat) draw "$name" "$(style 4)

$(cat prompts/_sheet.txt)

$(cat "prompts/$name.txt")" -i raw/title.png ;;
    title-clouds|title-smoke|title-dandelion|title-plants) draw "$name" "$(style 4)

$(cat prompts/_sheet.txt)

$(cat "prompts/$name.txt")" -i raw/title.png ;;
    plots|manager) draw "$name" "$(style 8)

$(cat "prompts/${name}.txt")

$(cat prompts/_sheet.txt)" ;;
    logos)
      draw "$name" "$(style 8)

Image 1 is a sheet of 8 software logos (AI coding agents) in a grid of 4 columns x 2 rows, one per cell. Redraw the WHOLE sheet as pixel-art icons in the style above, for a game's tool shed: exactly the same image size, the same grid, each logo in the same cell, centred, all at the same size (about 260 image pixels across). Keep every logo instantly recognisable: the same silhouette, proportions and colours as in Image 1 (gradients become two or three flat bands of colour); black logos stay near-black with a dark warm outline. Do not add text, letters, frames, badges or backgrounds that are not in the logo. Image 2 is pixel art already made for the game: match its pixel size and outline weight.

$(cat prompts/_sheet.txt)" -i raw/logos-ref.png -i raw/ui-icons.png ;;
    ui-*)
      local sheet="${name#ui-}" extra=""
      # A sheet family may add a note of its own (prompts/ui-langs.txt for ui-langs-1..3).
      [ -f "prompts/ui-${sheet%-[0-9]}.txt" ] && extra="$(cat "prompts/ui-${sheet%-[0-9]}.txt")"
      draw "$name" "$(style 8)

Image 1 is a painted sprite sheet from our game. Redraw the WHOLE sheet as pixel art in the style above: exactly the same image size, the same grid, the same items in the same cells at the same size, the same colours and the same content; only the rendering changes, to crisp chunky pixel art with dark warm outlines. Image 2 is pixel art already made for the game: match its pixel size and palette. Keep icons bold and simple so they still read when shown small.

$(cat prompts/_sheet.txt)

${extra}" -i "../assets/raw/${sheet}.png" -i raw/char-bear.png ;;
    look-*)
      local look="${name#look-}" src="../assets/raw/manager-${name#look-}.png"
      [ "$look" = farmer ] && src=../assets/raw/manager.png
      draw "$name" "$(style 8)

Image 1 is a painted sprite sheet of a farm manager from our game: a grid of 2 columns x 2 rows, (1) standing, (2) talking, (3) listening, full body, and (4) a head-and-shoulders portrait. Redraw the whole sheet as pixel art in the style above: the same 2 x 2 grid, the same character, outfit, colours and poses in the same cells; only the rendering changes. Image 2 is pixel art already made for the game: draw the full-body figures with the same pixel size, chibi proportions (big head, about 2.5 heads tall) and palette as the man in its first row. The portrait in cell 4 is bigger, filling most of its cell.

$(cat prompts/_sheet.txt)" -i "$src" -i raw/manager.png ;;
    char-*-*)
      local rest="${name#char-}"
      local species="${rest%%-*}" outfit="${rest#*-}" clothes
      case "$outfit" in
        gardener) clothes='a sage-green canvas apron with a front pocket over a white-and-blue striped shirt and short khaki trousers, a soft khaki cotton bucket hat (fabric, not straw), and tan garden gloves' ;;
        rain) clothes='a bright yellow raincoat with toggle buttons, a matching yellow rain hat, and small red rubber boots' ;;
        winter) clothes='a chunky cream knitted sweater, a red knitted scarf, a mustard beanie with a pom-pom, and brown boots' ;;
      esac
      draw "$name" "$(style 8)

Image 1 is a pixel-art character sprite sheet from our game: a grid of 4 columns x 3 rows of the same animal in different poses and directions. Redraw exactly the same sheet: the same animal, the same grid, poses, directions, pixel size, proportions, palette for fur and face, the same tool in the working pose. Change ONLY its clothes: instead of the straw hat and denim overalls it now wears ${clothes}. Every frame wears the new clothes, seen from that frame's direction.

$(cat prompts/_sheet.txt)" -i "raw/char-${species}.png" ;;
    char-*)
      local species="${name#char-}" entry="$(who "${name#char-}")"
      local refs=()
      [ "$species" != bear ] && refs=(-i raw/char-bear.png)
      local body
      body="$(sed -e "s|WHO|${entry%%|*}|" -e "s|TOOL_ACTION|${entry#*|}|" prompts/char.txt)"
      [ "$species" != bear ] && body="${body}
Image 1 is another helper from the same game: draw this one in exactly the same pixel size, proportions, outfit, palette and sheet layout."
      draw "$name" "$(style 8)

${body}

$(cat prompts/_sheet.txt)" ${refs[@]+"${refs[@]}"} ;;
  esac
}

names=("$@")
[ ${#names[@]} -eq 0 ] && names=(map plots manager char-bear)
# A few at a time: the image tool slows down and times out with many at once.
JOBS=${JOBS:-8}
for n in "${names[@]}"; do
  [ -f "raw/${n}.png" ] && [ -z "$FORCE" ] && { echo "${n}: exists"; continue; }
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do sleep 2; done
  gen "$n" &
done
wait
echo all-done
