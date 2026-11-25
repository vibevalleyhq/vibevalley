// Pure coordinate and keystroke mapping helpers matching GPUI's macOS expectations.

import Foundation

public struct ShimPoint: Equatable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

public enum CoordinateFlip {
  /// Converts AppKit bottom-left view coordinates into GPUI top-left coordinates.
  public static func appKitToTopLeft(x: Double, y: Double, viewHeight: Double) -> ShimPoint {
    ShimPoint(x: x, y: viewHeight - y)
  }
}

public struct MappedKeystroke: Equatable, Sendable {
  public var key: String
  public var keyChar: String?
  public var clearFunctionModifier: Bool

  public init(key: String, keyChar: String?, clearFunctionModifier: Bool) {
    self.key = key
    self.keyChar = keyChar
    self.clearFunctionModifier = clearFunctionModifier
  }
}

public enum KeyMapping {
  // AppKit function key scalar range (NSUpArrowFunctionKey ..= NSModeSwitchFunctionKey).
  private static let functionKeyRange: ClosedRange<UInt32> = 0xF700...0xF747

  public static func mapKey(
    charactersIgnoringModifiers: String,
    characters: String?,
    modifiers: Modifiers
  ) -> MappedKeystroke {
    let firstScalar = charactersIgnoringModifiers.unicodeScalars.first?.value
    let isArrowOrFnRange = firstScalar.map { functionKeyRange.contains($0) } ?? false

    if let named = namedKey(for: firstScalar) {
      return MappedKeystroke(
        key: named.key,
        keyChar: named.keyChar,
        clearFunctionModifier: isArrowOrFnRange
      )
    }

    let rawKey = charactersIgnoringModifiers.isEmpty ? (characters ?? "") : charactersIgnoringModifiers
    let key = rawKey.lowercased()

    let keyChar: String?
    if !modifiers.control && !modifiers.platform && !modifiers.function,
      let characters, !characters.isEmpty
    {
      keyChar = characters
    } else {
      keyChar = nil
    }

    return MappedKeystroke(
      key: key,
      keyChar: keyChar,
      clearFunctionModifier: isArrowOrFnRange
    )
  }

  private static func namedKey(for scalar: UInt32?) -> (key: String, keyChar: String?)? {
    guard let scalar else { return nil }
    switch scalar {
    case 0x20: return ("space", " ")
    case 0x09: return ("tab", "\t")
    case 0x19: return ("tab", nil) // Shift-Tab
    case 0x0D, 0x03: return ("enter", "\n")
    case 0x7F: return ("backspace", nil)
    case 0x1B: return ("escape", nil)
    case 0xF700: return ("up", nil)
    case 0xF701: return ("down", nil)
    case 0xF702: return ("left", nil)
    case 0xF703: return ("right", nil)
    case 0xF72C: return ("pageup", nil)
    case 0xF72D: return ("pagedown", nil)
    case 0xF729: return ("home", nil)
    case 0xF72B: return ("end", nil)
    case 0xF728: return ("delete", nil)
    case 0xF746: return ("insert", nil)
    case 0xF704...0xF726:
      let number = Int(scalar - 0xF704) + 1
      return ("f\(number)", nil)
    default:
      return nil
    }
  }
}
