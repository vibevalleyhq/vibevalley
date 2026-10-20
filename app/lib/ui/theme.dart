import 'package:flutter/material.dart';

abstract final class Palette {
  static const ink950 = Color(0xFF14110E);
  static const ink900 = Color(0xFF1C1916);
  static const ink800 = Color(0xFF2A2520);
  static const ink700 = Color(0xFF3A342D);
  static const ink500 = Color(0xFF6F675C);
  static const ink300 = Color(0xFFAAA192);
  static const ink100 = Color(0xFFF1EBE0);
  static const paper = Color(0xFFFFFAF0);
  static const hat = Color(0xFFF2B53A);
  static const ok = Color(0xFF6CD38F);
  static const bad = Color(0xFFFF6A58);

  static const cream50 = Color(0xFFF7E8C4);
  static const cream100 = Color(0xFFEEDCB2);
  static const cream200 = Color(0xFFE2C995);
  static const cream300 = Color(0xFFC8A46E);
  static const creamHover = Color(0xFFF1DCAB);
  static const creamInput = Color(0xFFFFF4D8);
  static const bark400 = Color(0xFF9B7550);
  static const bark500 = Color(0xFF7F5B3B);
  static const bark600 = Color(0xFF67482D);
  static const bark800 = Color(0xFF46301D);
  static const bark900 = Color(0xFF2F1F13);
  static const leaf300 = Color(0xFFB4CB7C);
  static const leaf500 = Color(0xFF74A046);
  static const leaf600 = Color(0xFF5A8234);
  static const leaf700 = Color(0xFF3F6427);
  static const leafHover = Color(0xFF84B052);
  static const wheat = Color(0xFFE5A93C);
  static const wheatHover = Color(0xFFEFB84E);
  static const berry = Color(0xFFC84A3A);
  static const water = Color(0xFF4F8FBD);

  static const pxInk = Color(0xFF2F1F13);
  static const pxDrop = Color(0x401E140A);
  static const rim = Color(0xFFFFF4D8);

  static const ground = Color(0xFF2B3320);
}

const pixelFont = 'FusionPixel';

const monoFont = 'Menlo';

/// Chinese in code text has no glyph in these; it is drawn in the pixel font, so that comes last.
const monoFallback = ['SF Mono', 'Consolas', 'Courier New', 'monospace', pixelFont];

/// Long text to read: the system's Chinese sans, not bundled. The pixel font is sharp only at 12 and 24, too small and too big for a page.
const readFont = 'PingFang SC';

const readFallback = ['Hiragino Sans GB', 'Noto Sans CJK SC', 'Noto Sans SC', 'Microsoft YaHei', 'sans-serif'];

/// Code inside long text: its Chinese in the reading font rather than the pixel one.
const readMonoFallback = ['SF Mono', 'Consolas', 'Courier New', 'monospace', readFont, ...readFallback];
