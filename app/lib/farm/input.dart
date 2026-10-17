// The keyboard is a map, not a page: a key, its modifiers and the farm's current layers become one action.

import 'package:flutter/services.dart' show LogicalKeyboardKey;

import '../game/tools.dart';

sealed class FarmKey {
  const FarmKey();
}

/// Alt is held or released: the names over the yard.
final class FarmReveal extends FarmKey {
  const FarmReveal(this.down);
  final bool down;
}

/// Esc with a tool: put it down.
final class FarmCloseTool extends FarmKey {
  const FarmCloseTool();
}

/// Esc with the hand: open the menu.
final class FarmOpenMenu extends FarmKey {
  const FarmOpenMenu();
}

final class FarmPickTool extends FarmKey {
  const FarmPickTool(this.tool);
  final Tool tool;
}

FarmKey? farmKey({
  required LogicalKeyboardKey key,
  required bool keyDown,
  required bool active,
  required bool typing,
  required bool meta,
  required bool control,
  required bool alt,
  required bool layersOpen,
  required Tool held,
}) {
  if (!active) return null;
  if (key == LogicalKeyboardKey.altLeft || key == LogicalKeyboardKey.altRight || key == LogicalKeyboardKey.alt) {
    return FarmReveal(alt);
  }
  if (!keyDown || meta || control || alt || typing) return null;
  if (key == LogicalKeyboardKey.escape) {
    if (layersOpen) return null;
    return held == Tool.hand ? const FarmOpenMenu() : const FarmCloseTool();
  }
  final tool = toolForKey(key);
  return tool == null ? null : FarmPickTool(tool);
}
