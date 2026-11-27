// Per-applet persistent key-value storage and window autosave naming for VibeValleyShim.

import Foundation

public final class AppletStorage: @unchecked Sendable {
  public static let maxKeys = 512
  public static let maxBytes = 262_144

  public let fileURL: URL
  private let lock = NSLock()
  private var entries: [String: String]

  public init(fileURL: URL) {
    self.fileURL = fileURL
    self.entries = Self.loadFromDisk(at: fileURL)
  }

  public convenience init(serverHome: String, noteId: String) {
    let dir = URL(fileURLWithPath: serverHome, isDirectory: true)
      .appendingPathComponent("applet_data", isDirectory: true)
    let file = dir.appendingPathComponent("\(Self.sanitizeIdentifier(noteId)).json", isDirectory: false)
    self.init(fileURL: file)
  }

  public static func sanitizeIdentifier(_ raw: String) -> String {
    let mapped = raw.unicodeScalars.map { scalar -> Character in
      let v = scalar.value
      let isAsciiSafe =
        (v >= 0x30 && v <= 0x39)
        || (v >= 0x41 && v <= 0x5A)
        || (v >= 0x61 && v <= 0x7A)
        || v == 0x2E
        || v == 0x5F
        || v == 0x2D
      return isAsciiSafe ? Character(scalar) : "_"
    }
    var trimmed = String(mapped)
    while let first = trimmed.first, first == "." || first == "_" {
      trimmed.removeFirst()
    }
    if trimmed.count > 80 {
      trimmed = String(trimmed.prefix(80))
    }
    return trimmed.isEmpty ? "default" : trimmed
  }

  public static func windowAutosaveName(forNoteId noteId: String) -> String {
    "VibeValleyApplet.\(sanitizeIdentifier(noteId))"
  }

  public func snapshot() -> [String: String] {
    lock.lock()
    defer { lock.unlock() }
    return entries
  }

  @discardableResult
  public func set(key: String, value: String) -> Bool {
    guard !key.isEmpty else { return false }
    lock.lock()
    defer { lock.unlock() }

    if entries[key] == nil && entries.count >= Self.maxKeys {
      return false
    }
    var next = entries
    next[key] = value
    let nextBytes = next.reduce(0) { $0 + $1.key.utf8.count + $1.value.utf8.count }
    guard nextBytes <= Self.maxBytes else { return false }

    entries = next
    saveToDiskLocked()
    return true
  }

  public func remove(key: String) {
    lock.lock()
    defer { lock.unlock() }
    guard entries.removeValue(forKey: key) != nil else { return }
    saveToDiskLocked()
  }

  public func clear() {
    lock.lock()
    defer { lock.unlock() }
    guard !entries.isEmpty else { return }
    entries.removeAll()
    saveToDiskLocked()
  }

  /// Generates an `@DocumentStart` script installing `window.vvStore` and bridging
  /// opaque-origin `localStorage` calls cleanly when WebKit throws `SecurityError`.
  public func bootstrapScript() -> String {
    let snap = snapshot()
    let rawJson: String
    if let data = try? JSONSerialization.data(withJSONObject: snap, options: [.sortedKeys]),
      let str = String(data: data, encoding: .utf8)
    {
      rawJson = str
    } else {
      rawJson = "{}"
    }
    let safeJson = rawJson
      .replacingOccurrences(of: "<", with: "\\u003C")
      .replacingOccurrences(of: ">", with: "\\u003E")
      .replacingOccurrences(of: "&", with: "\\u0026")
      .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
      .replacingOccurrences(of: "\u{2029}", with: "\\u2029")

    return """
    (() => {
      const data = Object.create(null);
      const initial = \(safeJson);
      for (const k of Object.keys(initial)) { data[k] = String(initial[k]); }
      const post = (msg) => {
        try { window.webkit?.messageHandlers?.vvStore?.postMessage(msg); } catch {}
      };
      const store = {
        get length() { return Object.keys(data).length; },
        key(index) { return Object.keys(data)[Number(index)] ?? null; },
        getItem(k) { const key = String(k); return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
        setItem(k, v) {
          const key = String(k);
          const value = String(v);
          data[key] = value;
          post({ op: "set", key, value });
        },
        removeItem(k) {
          const key = String(k);
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            delete data[key];
            post({ op: "remove", key });
          }
        },
        clear() {
          for (const k of Object.keys(data)) delete data[k];
          post({ op: "clear" });
        }
      };
      try { window.vvStore = store; } catch {}
      let nativeOk = false;
      try {
        window.localStorage.setItem("__vv_probe__", "1");
        window.localStorage.removeItem("__vv_probe__");
        nativeOk = true;
      } catch {}
      if (!nativeOk) {
        try {
          Object.defineProperty(window, "localStorage", { value: store, configurable: true });
        } catch {}
      }
    })();
    """
  }

  private static func loadFromDisk(at url: URL) -> [String: String] {
    guard let data = try? Data(contentsOf: url),
      let decoded = try? JSONDecoder().decode([String: String].self, from: data)
    else { return [:] }
    return decoded
  }

  private func saveToDiskLocked() {
    let dir = fileURL.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(entries) else { return }
    try? data.write(to: fileURL, options: .atomic)
  }
}
