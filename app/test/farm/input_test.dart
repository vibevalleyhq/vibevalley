import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/farm/input.dart';
import 'package:vibevalley/game/tools.dart';

FarmKey? key(
  LogicalKeyboardKey k, {
  bool down = true,
  bool active = true,
  bool typing = false,
  bool meta = false,
  bool control = false,
  bool alt = false,
  bool layers = false,
  Tool held = Tool.hand,
}) => farmKey(key: k, keyDown: down, active: active, typing: typing, meta: meta, control: control, alt: alt, layersOpen: layers, held: held);

void main() {
  test('a digit picks its tool; a key up or a modifier does nothing', () {
    expect(key(LogicalKeyboardKey.digit2), isA<FarmPickTool>().having((a) => a.tool, 'tool', Tool.water));
    expect(key(LogicalKeyboardKey.digit1), isA<FarmPickTool>().having((a) => a.tool, 'tool', Tool.hand));
    expect(key(LogicalKeyboardKey.digit9), isNull);
    expect(key(LogicalKeyboardKey.digit2, down: false), isNull);
    expect(key(LogicalKeyboardKey.digit2, meta: true), isNull);
    expect(key(LogicalKeyboardKey.digit2, control: true), isNull);
    expect(key(LogicalKeyboardKey.digit2, alt: true), isNull);
    expect(key(LogicalKeyboardKey.digit2, typing: true), isNull);
    expect(key(LogicalKeyboardKey.digit2, active: false), isNull);
  });

  test('Esc puts a tool down, opens the menu with the hand, and lets a dialog keep its own Esc', () {
    expect(key(LogicalKeyboardKey.escape, held: Tool.water), isA<FarmCloseTool>());
    expect(key(LogicalKeyboardKey.escape), isA<FarmOpenMenu>());
    expect(key(LogicalKeyboardKey.escape, layers: true), isNull);
  });

  test('Alt only reveals names, down and up', () {
    expect(key(LogicalKeyboardKey.altLeft, alt: true), isA<FarmReveal>().having((a) => a.down, 'down', true));
    expect(key(LogicalKeyboardKey.altLeft, alt: false), isA<FarmReveal>().having((a) => a.down, 'down', false));
  });
}
