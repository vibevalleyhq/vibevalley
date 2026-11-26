import Foundation
import Testing

@testable import ShimCore

@Suite struct WireProtocolTests {
  @Test func roundtripsAllShimToHostVariantsWithTypeTag() throws {
    let mods = Modifiers(control: true, alt: false, shift: true, platform: true, function: false)
    let cases: [ShimToHost] = [
      .attach(artifactId: "art-1", width: 1120, height: 760, scale: 2, displayId: 69733248),
      .attach(artifactId: "art-2", width: 800, height: 600, scale: 1, displayId: nil),
      .resize(width: 1280, height: 800, scale: 2),
      .mouseDown(x: 12.5, y: 44.0, button: .left, clickCount: 2, modifiers: mods),
      .mouseUp(x: 12.5, y: 44.0, button: .right, clickCount: 1, modifiers: .none),
      .mouseMove(x: 100, y: 200, pressedButton: .middle, modifiers: mods),
      .mouseMove(x: 101, y: 201, pressedButton: nil, modifiers: .none),
      .mouseExit(x: -1, y: 50, modifiers: .none),
      .scroll(
        x: 300,
        y: 400,
        deltaX: -4.5,
        deltaY: 18.25,
        precise: true,
        phase: .started,
        modifiers: mods
      ),
      .scroll(
        x: 300,
        y: 400,
        deltaX: 0,
        deltaY: -3,
        precise: false,
        phase: .ended,
        modifiers: .none
      ),
      .keyDown(key: "a", keyChar: "A", isHeld: true, modifiers: Modifiers(shift: true)),
      .keyDown(key: "enter", keyChar: "\n", isHeld: false, modifiers: .none),
      .keyUp(key: "escape", keyChar: nil, modifiers: .none),
      .modifiersChanged(modifiers: mods),
      .focus(focused: true),
      .focus(focused: false),
      .openInHost,
      .detach,
    ]

    for message in cases {
      let data = try WireCodec.encodeLine(message)
      #expect(data.last == 0x0A)
      let line = String(decoding: data.dropLast(), as: UTF8.self)
      let decoded = try WireCodec.decode(ShimToHost.self, fromLine: line)
      #expect(decoded == message)
    }
  }

  @Test func verifiesExactWireJSONShapesForShimToHost() throws {
    let data = try WireCodec.encodeLine(
      ShimToHost.mouseDown(
        x: 10,
        y: 20,
        button: .left,
        clickCount: 1,
        modifiers: Modifiers(control: false, alt: true, shift: false, platform: true, function: false)
      )
    )
    let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    #expect(json?["type"] as? String == "mouseDown")
    #expect(json?["x"] as? Double == 10)
    #expect(json?["y"] as? Double == 20)
    #expect(json?["button"] as? String == "left")
    #expect(json?["clickCount"] as? Int == 1)

    let mods = json?["modifiers"] as? [String: Bool]
    #expect(mods == ["control": false, "alt": true, "shift": false, "platform": true, "function": false])

    let unitData = try WireCodec.encodeLine(ShimToHost.openInHost)
    #expect(String(decoding: unitData, as: UTF8.self) == "{\"type\":\"openInHost\"}\n")

    let attachNull = #"{"type":"attach","artifactId":"a1","width":800,"height":600,"scale":2,"displayId":null}"#
    #expect(
      try WireCodec.decode(ShimToHost.self, fromLine: attachNull)
        == .attach(artifactId: "a1", width: 800, height: 600, scale: 2, displayId: nil)
    )

    let moveNull = #"{"type":"mouseMove","x":1,"y":2,"pressedButton":null,"modifiers":{"control":false,"alt":false,"shift":false,"platform":false,"function":false}}"#
    #expect(
      try WireCodec.decode(ShimToHost.self, fromLine: moveNull)
        == .mouseMove(x: 1, y: 2, pressedButton: nil, modifiers: .none)
    )

    let keyNull = #"{"type":"keyUp","key":"escape","keyChar":null,"modifiers":{"control":false,"alt":false,"shift":false,"platform":false,"function":false}}"#
    #expect(
      try WireCodec.decode(ShimToHost.self, fromLine: keyNull)
        == .keyUp(key: "escape", keyChar: nil, modifiers: .none)
    )
  }

  @Test func roundtripsAllHostToShimVariantsWithTypeTag() throws {
    let cases: [HostToShim] = [
      .readyLayer(contextId: 0x1234_5678, title: "Sprint Board", artifactType: "dashboard"),
      .readyWebview(html: "<!doctype html><h1>Hi</h1>", title: "Proto", artifactType: "prototype"),
      .updateWebview(html: "<!doctype html><h1>Updated</h1>", title: "Proto v2"),
      .setTitle(title: "Renamed"),
      .setAlwaysOnTop(enabled: true),
      .error(message: "Artifact not found"),
      .closing,
    ]

    for message in cases {
      let data = try WireCodec.encodeLine(message)
      #expect(data.last == 0x0A)
      let line = String(decoding: data.dropLast(), as: UTF8.self)
      let decoded = try WireCodec.decode(HostToShim.self, fromLine: line)
      #expect(decoded == message)
    }

    let closingRaw = #"{"type":"closing"}"#
    #expect(try WireCodec.decode(HostToShim.self, fromLine: closingRaw) == .closing)
  }
}

@Suite struct BundleConfigTests {
  @Test func resolvesChannelDefaults() {
    let home = "/Users/tester"
    let cases: [(String, ReleaseChannel, String)] = [
      ("release", .release, "/Users/tester/.vibevalley"),
      ("beta", .beta, "/Users/tester/.vibevalley-beta"),
      ("alpha", .alpha, "/Users/tester/.vibevalley-alpha"),
      ("dev", .dev, "/Users/tester/.vibevalley-dev"),
    ]

    for (rawChannel, expectedChannel, expectedHome) in cases {
      let cfg = BundleConfig.resolve(
        arguments: ["VibeValleyShim"],
        infoDictionary: ["VVChannel": rawChannel],
        environment: [:],
        userHomeDirectory: home
      )
      #expect(cfg.channel == expectedChannel)
      #expect(cfg.serverHome == expectedHome)
      #expect(cfg.socketPath == "\(expectedHome)/applet.sock")
      #expect(cfg.title == "VibeValley")
      #expect(cfg.alwaysOnTop == false)
    }
  }

  @Test func resolvesEnvPlistAndCliOverridesInPrecedenceOrder() {
    let plist: [String: Any] = [
      "VVArtifactId": "art-plist",
      "VVArtifactType": "dashboard",
      "VVChannel": "alpha",
      "VVHostAppPath": "/Applications/VibeValley Alpha.app",
      "VVAlwaysOnTop": true,
      "CFBundleDisplayName": "Plist Display",
      "CFBundleName": "Plist Name",
    ]

    // Environment VIBEVALLEY_HOME fills serverHome when VVServerHome is unset
    let envOnly = BundleConfig.resolve(
      arguments: ["VibeValleyShim"],
      infoDictionary: plist,
      environment: ["VIBEVALLEY_HOME": "/tmp/vv-env-home"],
      userHomeDirectory: "/Users/tester"
    )
    #expect(envOnly.artifactId == "art-plist")
    #expect(envOnly.artifactType == "dashboard")
    #expect(envOnly.channel == .alpha)
    #expect(envOnly.serverHome == "/tmp/vv-env-home")
    #expect(envOnly.socketPath == "/tmp/vv-env-home/applet.sock")
    #expect(envOnly.hostAppPath == "/Applications/VibeValley Alpha.app")
    #expect(envOnly.alwaysOnTop == true)
    #expect(envOnly.title == "Plist Display")

    // VVServerHome overrides VIBEVALLEY_HOME, and CLI flags override everything
    var plistWithHome = plist
    plistWithHome["VVServerHome"] = "~/custom-home"
    let cliOverridden = BundleConfig.resolve(
      arguments: [
        "VibeValleyShim",
        "--artifact", "art-cli",
        "--server-home", "/tmp/cli-home",
        "--socket", "/tmp/override.sock",
        "--title=CLI Title",
        "--no-always-on-top",
        "--host-app", "/tmp/VibeValley.app",
      ],
      infoDictionary: plistWithHome,
      environment: ["VIBEVALLEY_HOME": "/tmp/vv-env-home", "VIBEVALLEY_CHANNEL": "beta"],
      userHomeDirectory: "/Users/tester"
    )
    #expect(cliOverridden.artifactId == "art-cli")
    #expect(cliOverridden.channel == .beta)
    #expect(cliOverridden.serverHome == "/tmp/cli-home")
    #expect(cliOverridden.socketPath == "/tmp/override.sock")
    #expect(cliOverridden.title == "CLI Title")
    #expect(cliOverridden.alwaysOnTop == false)
    #expect(cliOverridden.hostAppPath == "/tmp/VibeValley.app")
  }

  @Test func supportsAlwaysOnTopFlagAndTitleFallbacks() {
    let withArtifactFallback = BundleConfig.resolve(
      arguments: ["VibeValleyShim", "--always-on-top", "--artifact", "art-99"],
      infoDictionary: [:],
      environment: [:],
      userHomeDirectory: "/Users/tester"
    )
    #expect(withArtifactFallback.alwaysOnTop == true)
    #expect(withArtifactFallback.title == "art-99")

    let withBundleNameFallback = BundleConfig.resolve(
      arguments: ["VibeValleyShim"],
      infoDictionary: ["CFBundleName": "Bundle Name", "VVAlwaysOnTop": "1"],
      environment: [:],
      userHomeDirectory: "/Users/tester"
    )
    #expect(withBundleNameFallback.alwaysOnTop == true)
    #expect(withBundleNameFallback.title == "Bundle Name")
  }
}

@Suite struct GeometryAndKeyMappingTests {
  @Test func flipsAppKitBottomLeftCoordinatesToGpuiTopLeft() {
    #expect(CoordinateFlip.appKitToTopLeft(x: 42, y: 760, viewHeight: 760) == ShimPoint(x: 42, y: 0))
    #expect(CoordinateFlip.appKitToTopLeft(x: 42, y: 0, viewHeight: 760) == ShimPoint(x: 42, y: 760))
    #expect(CoordinateFlip.appKitToTopLeft(x: 120.5, y: 250.25, viewHeight: 600) == ShimPoint(x: 120.5, y: 349.75))
  }

  @Test func mapsNamedAndPrintableKeysForGpui() {
    let enter = KeyMapping.mapKey(charactersIgnoringModifiers: "\r", characters: "\r", modifiers: .none)
    #expect(enter == MappedKeystroke(key: "enter", keyChar: "\n", clearFunctionModifier: false))

    let upArrow = KeyMapping.mapKey(
      charactersIgnoringModifiers: String(UnicodeScalar(0xF700)!),
      characters: nil,
      modifiers: Modifiers(function: true)
    )
    #expect(upArrow == MappedKeystroke(key: "up", keyChar: nil, clearFunctionModifier: true))

    let cmdC = KeyMapping.mapKey(
      charactersIgnoringModifiers: "c",
      characters: "c",
      modifiers: Modifiers(platform: true)
    )
    #expect(cmdC == MappedKeystroke(key: "c", keyChar: nil, clearFunctionModifier: false))

    let shiftA = KeyMapping.mapKey(
      charactersIgnoringModifiers: "A",
      characters: "A",
      modifiers: Modifiers(shift: true)
    )
    #expect(shiftA == MappedKeystroke(key: "a", keyChar: "A", clearFunctionModifier: false))
  }
}

@Suite struct AppletStorageTests {
  @Test func sanitizesIdentifiersAndBuildsAutosaveNames() {
    #expect(AppletStorage.sanitizeIdentifier("../../etc/passwd") == "etc_passwd")
    #expect(AppletStorage.sanitizeIdentifier("..__.") == "default")
    #expect(AppletStorage.sanitizeIdentifier("art_focus-01") == "art_focus-01")
    #expect(AppletStorage.windowAutosaveName(forArtifactId: "../art:1") == "VibeValleyApplet.art_1")
  }

  @Test func persistsSetRemoveAndClearAcrossReloadsAndEnforcesCaps() throws {
    let tmp = FileManager.default.temporaryDirectory
      .appendingPathComponent("vv-applet-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: tmp) }
    let file = tmp.appendingPathComponent("store.json")

    let first = AppletStorage(fileURL: file)
    #expect(first.set(key: "theme", value: "dark") == true)
    #expect(first.set(key: "note", value: "hello </script>") == true)
    #expect(first.set(key: "", value: "ignored") == false)
    #expect(first.set(key: "huge", value: String(repeating: "x", count: AppletStorage.maxBytes + 1)) == false)

    let reloaded = AppletStorage(fileURL: file)
    #expect(reloaded.snapshot() == ["theme": "dark", "note": "hello </script>"])

    let script = reloaded.bootstrapScript()
    #expect(!script.contains("</script>"))
    #expect(script.contains(#"\u003C\/script\u003E"#))
    #expect(script.contains("window.vvStore"))

    reloaded.remove(key: "theme")
    let afterRemove = AppletStorage(fileURL: file)
    #expect(afterRemove.snapshot() == ["note": "hello </script>"])

    afterRemove.clear()
    let afterClear = AppletStorage(fileURL: file)
    #expect(afterClear.snapshot().isEmpty)
  }
}
