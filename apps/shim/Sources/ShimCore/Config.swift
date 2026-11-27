// Bundle Info.plist, environment, and CLI configuration resolution for VibeValleyShim.

import Foundation

public enum ReleaseChannel: String, Equatable, Sendable, CaseIterable {
  case release
  case beta
  case alpha
  case dev

  public init?(raw: String?) {
    guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
      !trimmed.isEmpty
    else { return nil }
    switch trimmed {
    case "release", "final", "stable": self = .release
    case "beta": self = .beta
    case "alpha": self = .alpha
    case "dev": self = .dev
    default: return nil
    }
  }

  public var homeDirName: String {
    switch self {
    case .release: ".vibevalley"
    case .beta: ".vibevalley-beta"
    case .alpha: ".vibevalley-alpha"
    case .dev: ".vibevalley-dev"
    }
  }
}

public struct BundleConfig: Equatable, Sendable {
  public var noteId: String?
  public var noteType: String?
  public var channel: ReleaseChannel
  public var serverHome: String
  public var socketPath: String
  public var hostAppPath: String?
  public var title: String
  public var alwaysOnTop: Bool

  public init(
    noteId: String?,
    noteType: String?,
    channel: ReleaseChannel,
    serverHome: String,
    socketPath: String,
    hostAppPath: String?,
    title: String,
    alwaysOnTop: Bool
  ) {
    self.noteId = noteId
    self.noteType = noteType
    self.channel = channel
    self.serverHome = serverHome
    self.socketPath = socketPath
    self.hostAppPath = hostAppPath
    self.title = title
    self.alwaysOnTop = alwaysOnTop
  }

  public static func resolve(
    arguments: [String] = CommandLine.arguments,
    infoDictionary: [String: Any] = Bundle.main.infoDictionary ?? [:],
    environment: [String: String] = ProcessInfo.processInfo.environment,
    userHomeDirectory: String = FileManager.default.homeDirectoryForCurrentUser.path
  ) -> BundleConfig {
    let cli = ParsedCLI(arguments: arguments)

    func plistString(_ key: String) -> String? {
      guard let raw = infoDictionary[key] as? String else { return nil }
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }

    func plistBool(_ key: String) -> Bool? {
      if let flag = infoDictionary[key] as? Bool { return flag }
      if let number = infoDictionary[key] as? NSNumber { return number.boolValue }
      if let text = plistString(key)?.lowercased() {
        switch text {
        case "true", "yes", "1": return true
        case "false", "no", "0": return false
        default: return nil
        }
      }
      return nil
    }

    func envString(_ key: String) -> String? {
      guard let raw = environment[key] else { return nil }
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }

    func expandTilde(_ path: String) -> String {
      if path == "~" { return userHomeDirectory }
      if path.hasPrefix("~/") {
        let suffix = String(path.dropFirst(2))
        return (userHomeDirectory as NSString).appendingPathComponent(suffix)
      }
      return path
    }

    let channel =
      ReleaseChannel(raw: envString("VIBEVALLEY_CHANNEL"))
      ?? ReleaseChannel(raw: plistString("VVChannel"))
      ?? .dev

    let noteId = cli.note ?? plistString("VVNoteId")
    let noteType = plistString("VVNoteType")

    let rawServerHome =
      cli.serverHome
      ?? plistString("VVServerHome")
      ?? envString("VIBEVALLEY_HOME")
      ?? (userHomeDirectory as NSString).appendingPathComponent(channel.homeDirName)
    let serverHome = expandTilde(rawServerHome)

    let socketPath =
      cli.socket.map(expandTilde)
      ?? (serverHome as NSString).appendingPathComponent("applet.sock")

    let hostAppPath = (cli.hostApp ?? plistString("VVHostAppPath")).map(expandTilde)
    let alwaysOnTop = cli.alwaysOnTop ?? plistBool("VVAlwaysOnTop") ?? false

    let title =
      cli.title
      ?? plistString("CFBundleDisplayName")
      ?? plistString("CFBundleName")
      ?? noteId
      ?? "VibeValley"

    return BundleConfig(
      noteId: noteId,
      noteType: noteType,
      channel: channel,
      serverHome: serverHome,
      socketPath: socketPath,
      hostAppPath: hostAppPath,
      title: title,
      alwaysOnTop: alwaysOnTop
    )
  }
}

private struct ParsedCLI {
  var note: String?
  var socket: String?
  var serverHome: String?
  var title: String?
  var alwaysOnTop: Bool?
  var hostApp: String?

  init(arguments: [String]) {
    var index = 1
    while index < arguments.count {
      let arg = arguments[index]
      if let eq = arg.firstIndex(of: "=") {
        let flag = String(arg[..<eq])
        let value = String(arg[arg.index(after: eq)...])
        assignValue(flag: flag, value: value)
        index += 1
        continue
      }

      switch arg {
      case "--always-on-top":
        alwaysOnTop = true
        index += 1
      case "--no-always-on-top":
        alwaysOnTop = false
        index += 1
      case "--note", "--socket", "--server-home", "--title", "--host-app":
        if index + 1 < arguments.count {
          assignValue(flag: arg, value: arguments[index + 1])
          index += 2
        } else {
          index += 1
        }
      default:
        index += 1
      }
    }
  }

  private mutating func assignValue(flag: String, value: String) {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    switch flag {
    case "--note":
      if !trimmed.isEmpty { note = trimmed }
    case "--socket":
      if !trimmed.isEmpty { socket = trimmed }
    case "--server-home":
      if !trimmed.isEmpty { serverHome = trimmed }
    case "--title":
      if !trimmed.isEmpty { title = trimmed }
    case "--host-app":
      if !trimmed.isEmpty { hostApp = trimmed }
    case "--always-on-top":
      switch trimmed.lowercased() {
      case "true", "yes", "1", "": alwaysOnTop = true
      case "false", "no", "0": alwaysOnTop = false
      default: break
      }
    default:
      break
    }
  }
}
