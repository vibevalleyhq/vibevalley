// NDJSON wire protocol shared between VibeValleyShim and VibeValley's macOS AppletHost
// (apps/mac/src/applet/mod.rs). Keep every tag, case name, and field name byte-for-byte aligned.

import Foundation

public struct Modifiers: Codable, Equatable, Sendable {
  public var control: Bool
  public var alt: Bool
  public var shift: Bool
  public var platform: Bool
  public var function: Bool

  public static let none = Modifiers()

  public init(
    control: Bool = false,
    alt: Bool = false,
    shift: Bool = false,
    platform: Bool = false,
    function: Bool = false
  ) {
    self.control = control
    self.alt = alt
    self.shift = shift
    self.platform = platform
    self.function = function
  }
}

public enum MouseButtonKind: String, Codable, Equatable, Sendable {
  case left
  case right
  case middle
}

public enum ScrollPhaseKind: String, Codable, Equatable, Sendable {
  case started
  case moved
  case ended
}

public enum ShimToHost: Equatable, Sendable {
  case attach(artifactId: String, width: Double, height: Double, scale: Double, displayId: UInt32?)
  case resize(width: Double, height: Double, scale: Double)
  case mouseDown(x: Double, y: Double, button: MouseButtonKind, clickCount: Int, modifiers: Modifiers)
  case mouseUp(x: Double, y: Double, button: MouseButtonKind, clickCount: Int, modifiers: Modifiers)
  case mouseMove(x: Double, y: Double, pressedButton: MouseButtonKind?, modifiers: Modifiers)
  case mouseExit(x: Double, y: Double, modifiers: Modifiers)
  case scroll(
    x: Double,
    y: Double,
    deltaX: Double,
    deltaY: Double,
    precise: Bool,
    phase: ScrollPhaseKind,
    modifiers: Modifiers
  )
  case keyDown(key: String, keyChar: String?, isHeld: Bool, modifiers: Modifiers)
  case keyUp(key: String, keyChar: String?, modifiers: Modifiers)
  case modifiersChanged(modifiers: Modifiers)
  case focus(focused: Bool)
  case openInHost
  case detach
}

public enum HostToShim: Equatable, Sendable {
  case readyLayer(contextId: UInt32, title: String, artifactType: String)
  case readyWebview(html: String, title: String, artifactType: String)
  case updateWebview(html: String, title: String)
  case setTitle(title: String)
  case setAlwaysOnTop(enabled: Bool)
  case error(message: String)
  case closing
}

extension ShimToHost: Codable {
  private enum Kind: String, Codable {
    case attach
    case resize
    case mouseDown
    case mouseUp
    case mouseMove
    case mouseExit
    case scroll
    case keyDown
    case keyUp
    case modifiersChanged
    case focus
    case openInHost
    case detach
  }

  private enum CodingKeys: String, CodingKey {
    case type
    case artifactId
    case width
    case height
    case scale
    case displayId
    case x
    case y
    case button
    case clickCount
    case modifiers
    case pressedButton
    case deltaX
    case deltaY
    case precise
    case phase
    case key
    case keyChar
    case isHeld
    case focused
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try container.decode(Kind.self, forKey: .type)
    switch kind {
    case .attach:
      self = .attach(
        artifactId: try container.decode(String.self, forKey: .artifactId),
        width: try container.decode(Double.self, forKey: .width),
        height: try container.decode(Double.self, forKey: .height),
        scale: try container.decode(Double.self, forKey: .scale),
        displayId: try container.decodeIfPresent(UInt32.self, forKey: .displayId)
      )
    case .resize:
      self = .resize(
        width: try container.decode(Double.self, forKey: .width),
        height: try container.decode(Double.self, forKey: .height),
        scale: try container.decode(Double.self, forKey: .scale)
      )
    case .mouseDown:
      self = .mouseDown(
        x: try container.decode(Double.self, forKey: .x),
        y: try container.decode(Double.self, forKey: .y),
        button: try container.decode(MouseButtonKind.self, forKey: .button),
        clickCount: try container.decode(Int.self, forKey: .clickCount),
        modifiers: try container.decode(Modifiers.self, forKey: .modifiers)
      )
    case .mouseUp:
      self = .mouseUp(
        x: try container.decode(Double.self, forKey: .x),
        y: try container.decode(Double.self, forKey: .y),
        button: try container.decode(MouseButtonKind.self, forKey: .button),
        clickCount: try container.decode(Int.self, forKey: .clickCount),
        modifiers: try container.decode(Modifiers.self, forKey: .modifiers)
      )
    case .mouseMove:
      self = .mouseMove(
        x: try container.decode(Double.self, forKey: .x),
        y: try container.decode(Double.self, forKey: .y),
        pressedButton: try container.decodeIfPresent(MouseButtonKind.self, forKey: .pressedButton),
        modifiers: try container.decode(Modifiers.self, forKey: .modifiers)
      )
    case .mouseExit:
      self = .mouseExit(
        x: try container.decode(Double.self, forKey: .x),
        y: try container.decode(Double.self, forKey: .y),
        modifiers: try container.decode(Modifiers.self, forKey: .modifiers)
      )
    case .scroll:
      self = .scroll(
        x: try container.decode(Double.self, forKey: .x),
        y: try container.decode(Double.self, forKey: .y),
        deltaX: try container.decode(Double.self, forKey: .deltaX),
        deltaY: try container.decode(Double.self, forKey: .deltaY),
        precise: try container.decode(Bool.self, forKey: .precise),
        phase: try container.decode(ScrollPhaseKind.self, forKey: .phase),
        modifiers: try container.decode(Modifiers.self, forKey: .modifiers)
      )
    case .keyDown:
      self = .keyDown(
        key: try container.decode(String.self, forKey: .key),
        keyChar: try container.decodeIfPresent(String.self, forKey: .keyChar),
        isHeld: try container.decode(Bool.self, forKey: .isHeld),
        modifiers: try container.decode(Modifiers.self, forKey: .modifiers)
      )
    case .keyUp:
      self = .keyUp(
        key: try container.decode(String.self, forKey: .key),
        keyChar: try container.decodeIfPresent(String.self, forKey: .keyChar),
        modifiers: try container.decode(Modifiers.self, forKey: .modifiers)
      )
    case .modifiersChanged:
      self = .modifiersChanged(
        modifiers: try container.decode(Modifiers.self, forKey: .modifiers)
      )
    case .focus:
      self = .focus(
        focused: try container.decode(Bool.self, forKey: .focused)
      )
    case .openInHost:
      self = .openInHost
    case .detach:
      self = .detach
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .attach(let artifactId, let width, let height, let scale, let displayId):
      try container.encode(Kind.attach, forKey: .type)
      try container.encode(artifactId, forKey: .artifactId)
      try container.encode(width, forKey: .width)
      try container.encode(height, forKey: .height)
      try container.encode(scale, forKey: .scale)
      try container.encodeIfPresent(displayId, forKey: .displayId)
    case .resize(let width, let height, let scale):
      try container.encode(Kind.resize, forKey: .type)
      try container.encode(width, forKey: .width)
      try container.encode(height, forKey: .height)
      try container.encode(scale, forKey: .scale)
    case .mouseDown(let x, let y, let button, let clickCount, let modifiers):
      try container.encode(Kind.mouseDown, forKey: .type)
      try container.encode(x, forKey: .x)
      try container.encode(y, forKey: .y)
      try container.encode(button, forKey: .button)
      try container.encode(clickCount, forKey: .clickCount)
      try container.encode(modifiers, forKey: .modifiers)
    case .mouseUp(let x, let y, let button, let clickCount, let modifiers):
      try container.encode(Kind.mouseUp, forKey: .type)
      try container.encode(x, forKey: .x)
      try container.encode(y, forKey: .y)
      try container.encode(button, forKey: .button)
      try container.encode(clickCount, forKey: .clickCount)
      try container.encode(modifiers, forKey: .modifiers)
    case .mouseMove(let x, let y, let pressedButton, let modifiers):
      try container.encode(Kind.mouseMove, forKey: .type)
      try container.encode(x, forKey: .x)
      try container.encode(y, forKey: .y)
      try container.encodeIfPresent(pressedButton, forKey: .pressedButton)
      try container.encode(modifiers, forKey: .modifiers)
    case .mouseExit(let x, let y, let modifiers):
      try container.encode(Kind.mouseExit, forKey: .type)
      try container.encode(x, forKey: .x)
      try container.encode(y, forKey: .y)
      try container.encode(modifiers, forKey: .modifiers)
    case .scroll(let x, let y, let deltaX, let deltaY, let precise, let phase, let modifiers):
      try container.encode(Kind.scroll, forKey: .type)
      try container.encode(x, forKey: .x)
      try container.encode(y, forKey: .y)
      try container.encode(deltaX, forKey: .deltaX)
      try container.encode(deltaY, forKey: .deltaY)
      try container.encode(precise, forKey: .precise)
      try container.encode(phase, forKey: .phase)
      try container.encode(modifiers, forKey: .modifiers)
    case .keyDown(let key, let keyChar, let isHeld, let modifiers):
      try container.encode(Kind.keyDown, forKey: .type)
      try container.encode(key, forKey: .key)
      try container.encodeIfPresent(keyChar, forKey: .keyChar)
      try container.encode(isHeld, forKey: .isHeld)
      try container.encode(modifiers, forKey: .modifiers)
    case .keyUp(let key, let keyChar, let modifiers):
      try container.encode(Kind.keyUp, forKey: .type)
      try container.encode(key, forKey: .key)
      try container.encodeIfPresent(keyChar, forKey: .keyChar)
      try container.encode(modifiers, forKey: .modifiers)
    case .modifiersChanged(let modifiers):
      try container.encode(Kind.modifiersChanged, forKey: .type)
      try container.encode(modifiers, forKey: .modifiers)
    case .focus(let focused):
      try container.encode(Kind.focus, forKey: .type)
      try container.encode(focused, forKey: .focused)
    case .openInHost:
      try container.encode(Kind.openInHost, forKey: .type)
    case .detach:
      try container.encode(Kind.detach, forKey: .type)
    }
  }
}

extension HostToShim: Codable {
  private enum Kind: String, Codable {
    case readyLayer
    case readyWebview
    case updateWebview
    case setTitle
    case setAlwaysOnTop
    case error
    case closing
  }

  private enum CodingKeys: String, CodingKey {
    case type
    case contextId
    case title
    case artifactType
    case html
    case enabled
    case message
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try container.decode(Kind.self, forKey: .type)
    switch kind {
    case .readyLayer:
      self = .readyLayer(
        contextId: try container.decode(UInt32.self, forKey: .contextId),
        title: try container.decode(String.self, forKey: .title),
        artifactType: try container.decode(String.self, forKey: .artifactType)
      )
    case .readyWebview:
      self = .readyWebview(
        html: try container.decode(String.self, forKey: .html),
        title: try container.decode(String.self, forKey: .title),
        artifactType: try container.decode(String.self, forKey: .artifactType)
      )
    case .updateWebview:
      self = .updateWebview(
        html: try container.decode(String.self, forKey: .html),
        title: try container.decode(String.self, forKey: .title)
      )
    case .setTitle:
      self = .setTitle(
        title: try container.decode(String.self, forKey: .title)
      )
    case .setAlwaysOnTop:
      self = .setAlwaysOnTop(
        enabled: try container.decode(Bool.self, forKey: .enabled)
      )
    case .error:
      self = .error(
        message: try container.decode(String.self, forKey: .message)
      )
    case .closing:
      self = .closing
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .readyLayer(let contextId, let title, let artifactType):
      try container.encode(Kind.readyLayer, forKey: .type)
      try container.encode(contextId, forKey: .contextId)
      try container.encode(title, forKey: .title)
      try container.encode(artifactType, forKey: .artifactType)
    case .readyWebview(let html, let title, let artifactType):
      try container.encode(Kind.readyWebview, forKey: .type)
      try container.encode(html, forKey: .html)
      try container.encode(title, forKey: .title)
      try container.encode(artifactType, forKey: .artifactType)
    case .updateWebview(let html, let title):
      try container.encode(Kind.updateWebview, forKey: .type)
      try container.encode(html, forKey: .html)
      try container.encode(title, forKey: .title)
    case .setTitle(let title):
      try container.encode(Kind.setTitle, forKey: .type)
      try container.encode(title, forKey: .title)
    case .setAlwaysOnTop(let enabled):
      try container.encode(Kind.setAlwaysOnTop, forKey: .type)
      try container.encode(enabled, forKey: .enabled)
    case .error(let message):
      try container.encode(Kind.error, forKey: .type)
      try container.encode(message, forKey: .message)
    case .closing:
      try container.encode(Kind.closing, forKey: .type)
    }
  }
}

public enum WireCodec {
  public static func encodeLine<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    var data = try encoder.encode(value)
    data.append(0x0A)
    return data
  }

  public static func decode<T: Decodable>(_ type: T.Type, fromLine line: String) throws -> T {
    guard let data = line.data(using: .utf8) else {
      throw DecodingError.dataCorrupted(
        DecodingError.Context(codingPath: [], debugDescription: "Invalid UTF-8 line")
      )
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
}
