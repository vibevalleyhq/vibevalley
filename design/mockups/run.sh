#!/bin/bash
# Generates the four mockup variants in parallel with codex's image generation.
cd "$(dirname "$0")"
gen() {
  local name="$1" size="$2" style="$3"
  local prompt="Use your image generation tool to create exactly ONE game UI mockup image, size ${size}. Save the final image in the v2 folder of the current directory as v2/${name}.png (copy it here if the tool saves it elsewhere). Do not write any code or other files. When done, reply with just the file path.

$(cat common.txt)

${style}"
  # The image tool sometimes hangs on network timeouts: give each attempt 10 minutes, retry once.
  for attempt in 1 2; do
    codex exec -s workspace-write --skip-git-repo-check -o "v2/${name}.log.txt" "$prompt" > "v2/${name}.out.txt" 2>&1 &
    local pid=$!
    ( sleep 600; kill "$pid" 2>/dev/null ) &
    local watchdog=$!
    wait "$pid"
    kill "$watchdog" 2>/dev/null
    if [ -f "v2/${name}.png" ]; then
      echo "${name}: done (attempt ${attempt})"
      return
    fi
    echo "${name}: attempt ${attempt} produced no image"
  done
}

# Variants to generate: all four by default, or the names given as arguments.
want() { [ -z "$WANT" ] || [[ " ${WANT} " == *" $1 "* ]]; }
WANT="$*"
want A-classic && gen A-classic 1536x1024 "Style A, 经典农场: bright, saturated flat 2D cartoon in a classic Flash-game look, thick soft outlines, blue sky with puffy clouds, lush green grass, wooden plank signboard panels for the UI, rounded glossy buttons, cheerful and busy, landscape layout." &
want B-cozy && gen B-cozy 1536x1024 "Style B, 温室花园: modern cozy pastel, soft cream, sage and peach colors, gentle hand-drawn texture, raised wooden garden beds instead of bare soil plots, rounded white UI cards with subtle shadows, calm and minimal, landscape layout." &
want C-night && gen C-night 1536x1024 "Style C, 夜间科技温室: night-time inside a large glass greenhouse, purple-pink grow lights over hydroponic trays that act as the plots, dark translucent glass UI panels with neon green and cyan accents, cozy sci-fi mood, landscape layout." &
want D-mobile && gen D-mobile 1024x1536 "Style D, 竖屏掌上: a PORTRAIT phone game screen in the same bright classic cartoon style as a farming mobile game. Top: status bar with avatar, level, coins. Middle: the farm plots in a diamond grid with the animal helpers working, farmhouse and the human manager above them. Bottom: friends bar, tool bar, and a big round microphone button in the center. Put the left-side menu buttons in a small row instead." &
wait
echo all-done
