Interface icons from Hugeicons (https://hugeicons.com, @hugeicons/core-free-icons 4.3.5, MIT, Copyright (c) 2025
Hugeicons), stroke style, as SVG: the shapes the pixel button glyphs are drawn from, so a glyph reads like the icon
people already know. `python3 ref.py [sheet]` lays a sheet's icons out as raw/<sheet>-ref.png (4 columns x 2 rows, in
the order of process.py's sheet of that name); gen.sh <sheet> redraws that as pixel art, gen.sh hd-<sheet> at the
game's density, and process.py <sheet> cuts it.

media: play, pause, stop, speaker (VolumeHigh), mute (VolumeOff), replay (Repeat), record (Record), wait (Hourglass).

glyphs: close (Cancel01), add (Add01), delete (Delete02), next (ArrowRight01), check (Tick02), cross (Cancel01, drawn
red), warn (Alert02), copy (Copy01).

tools: refresh (Refresh), folder (Folder01), search (Search01), edit (PencilEdit01), open (LinkSquare02), filter
(FilterHorizontal), settings (Settings01), more (MoreHorizontal).
