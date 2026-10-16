import AVFoundation
import Carbon
import Cocoa
import FlutterMacOS
import ServiceManagement
import UserNotifications

// vibevalley's desktop app, the Swift half (the Dart half is lib/desktop/desktop.dart, over the method channel
// `vibevalley/desktop`): one instance, the menu bar icon and its menu, system notifications, the global voice shortcut
// (⌥⇧Space), opening at login, and quitting only after Dart has stopped the farm it started. Closing the window
// leaves the farm in the menu bar, out of the Dock (docs/desktop.md).
@main
class AppDelegate: FlutterAppDelegate, UNUserNotificationCenterDelegate {
  private var channel: FlutterMethodChannel?
  private var statusItem: NSStatusItem?
  private var trayTitle = ""
  private var trayLines = ["正在开门…"]
  private var windowTitle = "VibeValley 农场"
  private var hotKey: EventHotKeyRef?
  /// The farm Dart started: killed on the way out if Dart could not stop it.
  private var serverPid: pid_t = 0
  private var quitting = false
  private var quitDone = false
  private var askedForNotifications = false
  /// How long Dart has to stop the farm (it gives the server 8 s, then kills it) before the app goes anyway.
  private static let quitTimeout: TimeInterval = 12

  override func applicationWillFinishLaunching(_ notification: Notification) {
    // One farm: a second start brings the first one's window up instead (LaunchServices already does this for a
    // double click; this is for `open -n` and the like).
    let mine = NSRunningApplication.current
    if let id = Bundle.main.bundleIdentifier,
      let other = NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: { $0 != mine })
    {
      other.activate()
      exit(0)
    }
    super.applicationWillFinishLaunching(notification)
  }

  override func applicationDidFinishLaunching(_ notification: Notification) {
    guard let window = mainFlutterWindow as? MainFlutterWindow,
      let controller = window.contentViewController as? FlutterViewController
    else { return super.applicationDidFinishLaunching(notification) }
    window.onHide = { NSApp.setActivationPolicy(.accessory) }
    attach(controller)
    UNUserNotificationCenter.current().delegate = self
    window.title = windowTitle
    makeTray()
    registerHotKey()
    // Opened at login: it starts in the menu bar, without a window in your way.
    if openedAtLogin() {
      window.orderOut(nil)
      NSApp.setActivationPolicy(.accessory)
    }
    super.applicationDidFinishLaunching(notification)
  }

  /// Opens the channel to Dart; MainFlutterWindow calls this as soon as its engine exists.
  func attach(_ controller: FlutterViewController) {
    if channel != nil { return }
    let channel = FlutterMethodChannel(name: "vibevalley/desktop", binaryMessenger: controller.engine.binaryMessenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return result(nil) }
      self.handle(call, result)
    }
    self.channel = channel
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return false
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }

  override func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow()
    return true
  }

  // Quitting waits for Dart to stop the farm (it saves on the way out), and goes anyway after quitTimeout.
  override func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if quitDone { return .terminateNow }
    if quitting { return .terminateLater }
    quitting = true
    if let hotKey { UnregisterEventHotKey(hotKey) }
    guard let channel else { return .terminateNow }
    channel.invokeMethod("quit", arguments: nil) { [weak self] _ in self?.finishQuit() }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.quitTimeout) { [weak self] in self?.finishQuit() }
    return .terminateLater
  }

  private func finishQuit() {
    if quitDone { return }
    quitDone = true
    if serverPid > 0, kill(serverPid, 0) == 0 { kill(serverPid, SIGKILL) }
    NSApp.reply(toApplicationShouldTerminate: true)
  }

  override func applicationWillTerminate(_ notification: Notification) {
    if serverPid > 0, kill(serverPid, 0) == 0 { kill(serverPid, SIGKILL) }
  }

  private func handle(_ call: FlutterMethodCall, _ result: @escaping FlutterResult) {
    let args = call.arguments as? [String: Any] ?? [:]
    switch call.method {
    case "setup":
      if let title = args["title"] as? String {
        windowTitle = title
        mainFlutterWindow?.title = title
        statusItem?.button?.toolTip = title
      }
      result(nil)
    case "server":
      serverPid = pid_t(args["pid"] as? Int ?? 0)
      result(nil)
    case "tray":
      trayTitle = args["title"] as? String ?? ""
      trayLines = args["lines"] as? [String] ?? []
      statusItem?.button?.title = trayTitle
      statusItem?.menu = trayMenu()
      result(nil)
    case "notify":
      notify(title: args["title"] as? String ?? "码农场物语", body: args["body"] as? String ?? "", command: args["command"])
      result(nil)
    case "fatal":
      let alert = NSAlert()
      alert.messageText = args["title"] as? String ?? "码农场物语"
      alert.informativeText = args["text"] as? String ?? ""
      alert.alertStyle = .critical
      alert.runModal()
      quitDone = true
      result(nil)
      NSApp.terminate(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  // ── Window ──

  @objc private func showWindow() {
    NSApp.setActivationPolicy(.regular)
    mainFlutterWindow?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  /// Sends the farm a command; anything but the voice shortcut brings the window up first.
  private func send(_ command: [String: Any]) {
    if command["type"] as? String != "voice" { showWindow() }
    channel?.invokeMethod("command", arguments: command)
  }

  @objc private func toggleVoice() {
    // The system asks for the microphone the first time; the call itself starts in the farm.
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
      AVCaptureDevice.requestAccess(for: .audio) { _ in }
    }
    send(["type": "voice"])
  }

  // ── Menu bar ──

  private func makeTray() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let image = NSImage(named: "TrayTemplate") {
      image.isTemplate = true
      item.button?.image = image
    }
    item.button?.imagePosition = .imageLeading
    item.button?.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
    item.button?.toolTip = windowTitle
    statusItem = item
    item.menu = trayMenu()
  }

  private func trayMenu() -> NSMenu {
    let menu = NSMenu()
    for line in trayLines {
      let item = NSMenuItem(title: line, action: nil, keyEquivalent: "")
      item.isEnabled = false
      menu.addItem(item)
    }
    menu.addItem(.separator())
    menu.addItem(withTitle: "打开农场", action: #selector(showWindow), keyEquivalent: "").target = self
    let voice = NSMenuItem(title: "和管家说话", action: #selector(toggleVoice), keyEquivalent: " ")
    voice.keyEquivalentModifierMask = [.option, .shift]
    voice.target = self
    menu.addItem(voice)
    if #available(macOS 13.0, *) {
      menu.addItem(.separator())
      let login = NSMenuItem(title: "登录时打开", action: #selector(toggleLoginItem), keyEquivalent: "")
      login.state = SMAppService.mainApp.status == .enabled ? .on : .off
      login.target = self
      menu.addItem(login)
    }
    menu.addItem(.separator())
    let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "码农场物语"
    menu.addItem(withTitle: "退出 \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
    menu.autoenablesItems = false
    return menu
  }

  @objc private func toggleLoginItem() {
    guard #available(macOS 13.0, *) else { return }
    do {
      if SMAppService.mainApp.status == .enabled {
        try SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
      }
    } catch {
      NSLog("vibevalley: opening at login could not be changed: \(error.localizedDescription)")
    }
    statusItem?.menu = trayMenu()
  }

  private func openedAtLogin() -> Bool {
    guard let event = NSAppleEventManager.shared().currentAppleEvent else { return false }
    return event.eventID == kAEOpenApplication
      && event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
  }

  // ── Voice shortcut: ⌥⇧Space anywhere, pressed once to start, again to hang up ──

  private func registerHotKey() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let me = Unmanaged.passUnretained(self).toOpaque()
    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, _, data in
        guard let data else { return noErr }
        let delegate = Unmanaged<AppDelegate>.fromOpaque(data).takeUnretainedValue()
        DispatchQueue.main.async { delegate.toggleVoice() }
        return noErr
      }, 1, &spec, me, nil)
    let id = EventHotKeyID(signature: OSType(0x6862_7279), id: 1)  // 'hbry'
    let status = RegisterEventHotKey(
      UInt32(kVK_Space), UInt32(optionKey | shiftKey), id, GetApplicationEventTarget(), 0, &hotKey)
    if status != noErr { NSLog("vibevalley: the shortcut ⌥⇧Space is taken by another app") }
  }

  // ── Notifications: Dart sends them; shown only while the farm's window is not in front ──

  private func notify(title: String, body: String, command: Any?) {
    if NSApp.isActive, mainFlutterWindow?.isKeyWindow == true { return }
    let center = UNUserNotificationCenter.current()
    let post = {
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      if let command = command as? [String: Any] { content.userInfo = ["command": command] }
      center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
    if askedForNotifications { return post() }
    askedForNotifications = true
    center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
      if granted { DispatchQueue.main.async(execute: post) }
    }
  }

  // Clicked: back to the farm, at what it was about.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let command = response.notification.request.content.userInfo["command"] as? [String: Any]
    DispatchQueue.main.async {
      if let command { self.send(command) } else { self.showWindow() }
    }
    completionHandler()
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }
}
