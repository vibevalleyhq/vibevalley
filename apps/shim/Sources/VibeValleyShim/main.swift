// Entry point for VibeValleyShim: regular NSApplication, native menu bar, and socket-driven window lifecycle.

import AppKit
import ShimCore

@MainActor
final class ShimAppDelegate: NSObject, NSApplicationDelegate {
  private let config: BundleConfig
  private let windowController: ShimWindowController
  private var socketClient: SocketClient?
  private var alwaysOnTopMenuItem: NSMenuItem?

  init(config: BundleConfig) {
    self.config = config
    self.windowController = ShimWindowController(
      title: config.title,
      alwaysOnTop: config.alwaysOnTop
    )
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMainMenu()
    windowController.showWindow()

    windowController.onAlwaysOnTopChanged = { [weak self] enabled in
      self?.alwaysOnTopMenuItem?.state = enabled ? .on : .off
    }
    windowController.onEmit = { [weak self] message in
      self?.socketClient?.send(message)
    }
    windowController.onReconnectRequested = { [weak self] in
      self?.socketClient?.reconnect()
    }

    guard let artifactId = config.artifactId, !artifactId.isEmpty else {
      windowController.setConnectionState(
        .failed("Missing artifact identifier (set VVArtifactId in Info.plist or pass --artifact).")
      )
      return
    }

    let client = SocketClient(
      socketPath: config.socketPath,
      hostAppPath: config.hostAppPath,
      onStateChanged: { [weak self] state in
        guard let self else { return }
        self.windowController.setConnectionState(state)
        if case .connected = state {
          let metrics = self.windowController.currentAttachmentMetrics()
          self.socketClient?.send(
            .attach(
              artifactId: artifactId,
              width: metrics.width,
              height: metrics.height,
              scale: metrics.scale,
              displayId: metrics.displayId
            )
          )
        }
      },
      onMessage: { [weak self] message in
        guard let self else { return }
        if case .closing = message {
          self.socketClient?.markHostClosing()
        }
        self.windowController.handleHostMessage(message)
      }
    )
    socketClient = client
    client.start()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  func applicationWillTerminate(_ notification: Notification) {
    socketClient?.disconnectAndSendDetach()
  }

  @objc private func openInHost(_ sender: Any?) {
    socketClient?.send(.openInHost)
    if let hostAppPath = config.hostAppPath {
      SocketClient.launchHostSilently(at: hostAppPath, activate: true)
    }
  }

  @objc private func toggleAlwaysOnTop(_ sender: Any?) {
    windowController.alwaysOnTop.toggle()
  }

  @objc private func reconnect(_ sender: Any?) {
    socketClient?.reconnect()
  }

  private func buildMainMenu() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    let appMenu = NSMenu(title: config.title)
    appMenu.addItem(
      NSMenuItem(title: "Open in VibeValley", action: #selector(openInHost(_:)), keyEquivalent: "")
    )
    let pinItem = NSMenuItem(
      title: "Always on Top",
      action: #selector(toggleAlwaysOnTop(_:)),
      keyEquivalent: ""
    )
    pinItem.state = windowController.alwaysOnTop ? .on : .off
    alwaysOnTopMenuItem = pinItem
    appMenu.addItem(pinItem)
    appMenu.addItem(
      NSMenuItem(title: "Reconnect", action: #selector(reconnect(_:)), keyEquivalent: "r")
    )
    appMenu.addItem(.separator())
    appMenu.addItem(
      NSMenuItem(
        title: "Quit \(config.title)",
        action: #selector(NSApplication.terminate(_:)),
        keyEquivalent: "q"
      )
    )
    appMenuItem.submenu = appMenu
    mainMenu.addItem(appMenuItem)

    let editMenuItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
    editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
    editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
    editMenu.addItem(
      NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    )
    editMenuItem.submenu = editMenu
    mainMenu.addItem(editMenuItem)

    let windowMenuItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(
      NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    )
    windowMenu.addItem(
      NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    )
    windowMenuItem.submenu = windowMenu
    mainMenu.addItem(windowMenuItem)

    NSApplication.shared.mainMenu = mainMenu
    NSApplication.shared.windowsMenu = windowMenu
  }
}

let config = BundleConfig.resolve()
let app = NSApplication.shared
// Regular policy gives the installed applet its own Dock icon, Cmd+Tab tile, and menu bar.
app.setActivationPolicy(.regular)

let delegate = MainActor.assumeIsolated { ShimAppDelegate(config: config) }
app.delegate = delegate
app.run()
