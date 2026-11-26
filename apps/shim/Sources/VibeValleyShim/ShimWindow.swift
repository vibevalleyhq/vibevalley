// Native NSWindow hosting CALayerHost (for GPUI-rendered artifacts), sandboxed WKWebView (for prototype
// artifacts), or a connecting/reconnecting/error status view.

import AppKit
import QuartzCore
import ShimCore
import WebKit

@MainActor
final class ShimWindowController: NSObject, NSWindowDelegate {
  let window: NSWindow

  private enum ContentMode {
    case status
    case layer(ShimLayerView)
    case webview(ShimWebViewContainer)
  }

  private let statusView: ShimStatusView
  private let artifactId: String?
  private let storage: AppletStorage?
  private var mode: ContentMode = .status
  private var isAttached = false
  private var currentTitle: String

  var alwaysOnTop: Bool {
    didSet {
      window.level = alwaysOnTop ? .floating : .normal
      if case .webview(let container) = mode {
        container.setPinned(alwaysOnTop)
      }
      onAlwaysOnTopChanged?(alwaysOnTop)
    }
  }

  var onEmit: ((ShimToHost) -> Void)?
  var onReconnectRequested: (() -> Void)?
  var onAlwaysOnTopChanged: ((Bool) -> Void)?
  var onOpenInHostRequested: (() -> Void)?

  init(title: String, artifactId: String?, serverHome: String, alwaysOnTop: Bool) {
    self.alwaysOnTop = alwaysOnTop
    self.currentTitle = title
    let cleanArtifact = artifactId?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.artifactId = (cleanArtifact?.isEmpty == false) ? cleanArtifact : nil
    self.storage = self.artifactId.map { AppletStorage(serverHome: serverHome, artifactId: $0) }
    self.window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    self.statusView = ShimStatusView()
    super.init()

    window.title = title
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.titlebarSeparatorStyle = .none
    window.toolbarStyle = .unifiedCompact
    window.minSize = NSSize(width: 360, height: 240)
    window.level = alwaysOnTop ? .floating : .normal
    window.acceptsMouseMovedEvents = true
    window.isReleasedWhenClosed = false
    if let id = self.artifactId {
      let autosaveName = AppletStorage.windowAutosaveName(forArtifactId: id)
      window.setFrameAutosaveName(autosaveName)
      if !window.setFrameUsingName(autosaveName) {
        window.center()
      }
    } else {
      window.center()
    }
    window.delegate = self

    statusView.onReconnect = { [weak self] in
      self?.onReconnectRequested?()
    }
    window.contentView = statusView
  }

  func resetWindowSize() {
    window.setContentSize(NSSize(width: 1120, height: 760))
    window.center()
    emitResizeIfAttached()
  }

  func showWindow() {
    window.makeKeyAndOrderFront(nil)
  }

  func currentAttachmentMetrics() -> (width: Double, height: Double, scale: Double, displayId: UInt32?) {
    let size = window.contentView?.bounds.size ?? window.contentLayoutRect.size
    let width = max(Double(size.width), 1)
    let height = max(Double(size.height), 1)
    let scale = Double(window.backingScaleFactor)
    let displayId = window.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32
    return (width, height, scale, displayId)
  }

  func setConnectionState(_ state: SocketConnectionState) {
    switch state {
    case .connecting:
      isAttached = false
      showStatus(
        title: "Connecting to VibeValley...",
        detail: "Waiting for host socket",
        spinning: true,
        showReconnect: false
      )
    case .wakingHost:
      isAttached = false
      showStatus(
        title: "Starting VibeValley...",
        detail: "Waking host in background",
        spinning: true,
        showReconnect: false
      )
    case .connected:
      isAttached = true
      if case .status = mode {
        showStatus(
          title: "Loading artifact...",
          detail: "Attached to VibeValley host",
          spinning: true,
          showReconnect: false
        )
      }
    case .reconnecting(let attempt, let reason):
      isAttached = false
      showStatus(
        title: "Reconnecting to VibeValley... (\(attempt))",
        detail: reason,
        spinning: true,
        showReconnect: true
      )
    case .closedByHost:
      isAttached = false
      showStatus(
        title: "Disconnected from VibeValley",
        detail: "The host closed this applet session.",
        spinning: false,
        showReconnect: true
      )
    case .failed(let message):
      isAttached = false
      showStatus(
        title: "Unable to connect",
        detail: message,
        spinning: false,
        showReconnect: true
      )
    }
  }

  func handleHostMessage(_ message: HostToShim) {
    switch message {
    case .readyLayer(let contextId, let title, _):
      if !title.isEmpty { updateTitle(title) }
      showLayer(contextId: contextId)
    case .readyWebview(let html, let title, _):
      if !title.isEmpty { updateTitle(title) }
      showWebview(html: html)
    case .updateWebview(let html, let title):
      if !title.isEmpty { updateTitle(title) }
      showWebview(html: html)
    case .setTitle(let title):
      updateTitle(title)
    case .setAlwaysOnTop(let enabled):
      alwaysOnTop = enabled
    case .error(let message):
      showStatus(
        title: "Artifact Error",
        detail: message,
        spinning: false,
        showReconnect: true
      )
    case .closing:
      isAttached = false
      showStatus(
        title: "Disconnected from VibeValley",
        detail: "The host closed this applet session.",
        spinning: false,
        showReconnect: true
      )
    }
  }

  private func updateTitle(_ title: String) {
    currentTitle = title
    window.title = title
    if case .webview(let container) = mode {
      container.setTitle(title)
    }
  }

  private func showStatus(title: String, detail: String, spinning: Bool, showReconnect: Bool) {
    statusView.configure(title: title, detail: detail, spinning: spinning, showReconnect: showReconnect)
    if case .status = mode { return }
    mode = .status
    statusView.frame = window.contentView?.bounds ?? window.contentLayoutRect
    window.contentView = statusView
  }

  private func showLayer(contextId: UInt32) {
    if case .layer(let layerView) = mode {
      layerView.setContextId(contextId)
      return
    }
    let frame = window.contentView?.bounds ?? window.contentLayoutRect
    let layerView = ShimLayerView(frame: frame, contextId: contextId) { [weak self] event in
      self?.onEmit?(event)
    }
    mode = .layer(layerView)
    window.contentView = layerView
    window.makeFirstResponder(layerView)
  }

  private func showWebview(html: String) {
    if case .webview(let container) = mode {
      container.setTitle(currentTitle)
      container.setPinned(alwaysOnTop)
      container.loadHTML(html)
      return
    }
    let frame = window.contentView?.bounds ?? window.contentLayoutRect
    let container = ShimWebViewContainer(
      frame: frame,
      title: currentTitle,
      alwaysOnTop: alwaysOnTop,
      storage: storage,
      onTogglePin: { [weak self] in self?.alwaysOnTop.toggle() },
      onOpenInHost: { [weak self] in self?.onOpenInHostRequested?() }
    )
    container.loadHTML(html)
    mode = .webview(container)
    window.contentView = container
    window.makeFirstResponder(container.webView)
  }

  func windowDidResize(_ notification: Notification) {
    emitResizeIfAttached()
  }

  func windowDidChangeBackingProperties(_ notification: Notification) {
    emitResizeIfAttached()
  }

  func windowDidBecomeKey(_ notification: Notification) {
    guard isAttached else { return }
    onEmit?(.focus(focused: true))
  }

  func windowDidResignKey(_ notification: Notification) {
    guard isAttached else { return }
    onEmit?(.focus(focused: false))
  }

  private func emitResizeIfAttached() {
    guard isAttached else { return }
    let metrics = currentAttachmentMetrics()
    onEmit?(.resize(width: metrics.width, height: metrics.height, scale: metrics.scale))
  }
}

@MainActor
private final class ShimLayerView: NSView {
  private static let immersiveHeaderHeight: Double = 38
  private static let rightControlsWidth: Double = 220

  private let hostLayer: CALayer?
  private let emit: (ShimToHost) -> Void
  private var trackingArea: NSTrackingArea?

  init(frame frameRect: NSRect, contextId: UInt32, emit: @escaping (ShimToHost) -> Void) {
    self.emit = emit
    if let cls = NSClassFromString("CALayerHost") as? CALayer.Type {
      self.hostLayer = cls.init()
    } else {
      self.hostLayer = nil
      fputs("VibeValleyShim: CALayerHost class unavailable\n", stderr)
    }
    super.init(frame: frameRect)
    wantsLayer = true
    autoresizingMask = [.width, .height]

    if let hostLayer {
      hostLayer.setValue(NSNumber(value: false), forKey: "resizesHostedContext")
      hostLayer.contentsGravity = .topLeft
      layer?.addSublayer(hostLayer)
      setContextId(contextId)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override var acceptsFirstResponder: Bool { true }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  func setContextId(_ contextId: UInt32) {
    hostLayer?.setValue(NSNumber(value: contextId), forKey: "contextId")
    layoutHostedLayer()
  }

  override func layout() {
    super.layout()
    layoutHostedLayer()
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    layoutHostedLayer()
  }

  private func layoutHostedLayer() {
    guard let hostLayer else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    // AppKit views are bottom-left rooted; anchor at top-left so resizing never jumps from the bottom edge.
    hostLayer.anchorPoint = CGPoint(x: 0, y: 1)
    hostLayer.position = CGPoint(x: 0, y: bounds.height)
    hostLayer.bounds = CGRect(origin: .zero, size: bounds.size)
    hostLayer.contentsScale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2.0
    CATransaction.commit()
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let trackingArea {
      removeTrackingArea(trackingArea)
    }
    let area = NSTrackingArea(
      rect: .zero,
      options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    trackingArea = area
  }

  override func mouseDown(with event: NSEvent) {
    let pt = gpuiPoint(for: event)
    let dragLimitX = max(0, Double(bounds.width) - Self.rightControlsWidth)
    if pt.y <= Self.immersiveHeaderHeight && pt.x < dragLimitX {
      if event.clickCount == 2 {
        window?.performZoom(nil)
      } else {
        window?.performDrag(with: event)
      }
      return
    }
    window?.makeFirstResponder(self)
    emitMouseDown(event)
  }

  override func rightMouseDown(with event: NSEvent) {
    window?.makeFirstResponder(self)
    emitMouseDown(event)
  }

  override func otherMouseDown(with event: NSEvent) {
    window?.makeFirstResponder(self)
    emitMouseDown(event)
  }

  override func mouseUp(with event: NSEvent) {
    emitMouseUp(event)
  }

  override func rightMouseUp(with event: NSEvent) {
    emitMouseUp(event)
  }

  override func otherMouseUp(with event: NSEvent) {
    emitMouseUp(event)
  }

  override func mouseMoved(with event: NSEvent) {
    let pt = gpuiPoint(for: event)
    emit(.mouseMove(x: pt.x, y: pt.y, pressedButton: nil, modifiers: modifiers(from: event)))
  }

  override func mouseDragged(with event: NSEvent) {
    emitMouseDrag(event)
  }

  override func rightMouseDragged(with event: NSEvent) {
    emitMouseDrag(event)
  }

  override func otherMouseDragged(with event: NSEvent) {
    emitMouseDrag(event)
  }

  override func mouseExited(with event: NSEvent) {
    let pt = gpuiPoint(for: event)
    emit(.mouseExit(x: pt.x, y: pt.y, modifiers: modifiers(from: event)))
  }

  override func scrollWheel(with event: NSEvent) {
    let pt = gpuiPoint(for: event)
    let phase: ScrollPhaseKind
    switch event.phase {
    case .mayBegin, .began:
      phase = .started
    case .ended, .cancelled:
      phase = .ended
    default:
      phase = .moved
    }
    emit(
      .scroll(
        x: pt.x,
        y: pt.y,
        deltaX: Double(event.scrollingDeltaX),
        deltaY: Double(event.scrollingDeltaY),
        precise: event.hasPreciseScrollingDeltas,
        phase: phase,
        modifiers: modifiers(from: event)
      )
    )
  }

  override func keyDown(with event: NSEvent) {
    let rawModifiers = modifiers(from: event)
    let mapped = KeyMapping.mapKey(
      charactersIgnoringModifiers: event.charactersIgnoringModifiers ?? "",
      characters: event.characters,
      modifiers: rawModifiers
    )
    let adjustedModifiers = modifiers(from: event, clearFunction: mapped.clearFunctionModifier)
    emit(
      .keyDown(
        key: mapped.key,
        keyChar: mapped.keyChar,
        isHeld: event.isARepeat,
        modifiers: adjustedModifiers
      )
    )
  }

  override func keyUp(with event: NSEvent) {
    let rawModifiers = modifiers(from: event)
    let mapped = KeyMapping.mapKey(
      charactersIgnoringModifiers: event.charactersIgnoringModifiers ?? "",
      characters: event.characters,
      modifiers: rawModifiers
    )
    let adjustedModifiers = modifiers(from: event, clearFunction: mapped.clearFunctionModifier)
    emit(
      .keyUp(
        key: mapped.key,
        keyChar: mapped.keyChar,
        modifiers: adjustedModifiers
      )
    )
  }

  override func flagsChanged(with event: NSEvent) {
    emit(.modifiersChanged(modifiers: modifiers(from: event)))
  }

  // Edit menu shortcuts (Cmd+X/C/V/A) are intercepted by NSMenu before keyDown; forward them to GPUI.
  @objc func cut(_ sender: Any?) { sendCommandShortcut("x") }
  @objc func copy(_ sender: Any?) { sendCommandShortcut("c") }
  @objc func paste(_ sender: Any?) { sendCommandShortcut("v") }
  @objc override func selectAll(_ sender: Any?) { sendCommandShortcut("a") }

  private func sendCommandShortcut(_ key: String) {
    let mods = Modifiers(platform: true)
    emit(.keyDown(key: key, keyChar: nil, isHeld: false, modifiers: mods))
    emit(.keyUp(key: key, keyChar: nil, modifiers: mods))
  }

  private func emitMouseDown(_ event: NSEvent) {
    guard let button = mouseButton(from: event) else { return }
    let pt = gpuiPoint(for: event)
    emit(
      .mouseDown(
        x: pt.x,
        y: pt.y,
        button: button,
        clickCount: event.clickCount,
        modifiers: modifiers(from: event)
      )
    )
  }

  private func emitMouseUp(_ event: NSEvent) {
    guard let button = mouseButton(from: event) else { return }
    let pt = gpuiPoint(for: event)
    emit(
      .mouseUp(
        x: pt.x,
        y: pt.y,
        button: button,
        clickCount: event.clickCount,
        modifiers: modifiers(from: event)
      )
    )
  }

  private func emitMouseDrag(_ event: NSEvent) {
    guard let button = mouseButton(from: event) else { return }
    let pt = gpuiPoint(for: event)
    emit(
      .mouseMove(
        x: pt.x,
        y: pt.y,
        pressedButton: button,
        modifiers: modifiers(from: event)
      )
    )
  }

  private func gpuiPoint(for event: NSEvent) -> ShimPoint {
    let local = convert(event.locationInWindow, from: nil)
    return CoordinateFlip.appKitToTopLeft(
      x: Double(local.x),
      y: Double(local.y),
      viewHeight: Double(bounds.height)
    )
  }

  private func mouseButton(from event: NSEvent) -> MouseButtonKind? {
    switch event.buttonNumber {
    case 0: .left
    case 1: .right
    case 2: .middle
    default: nil
    }
  }

  private func modifiers(from event: NSEvent, clearFunction: Bool = false) -> Modifiers {
    let flags = event.modifierFlags
    return Modifiers(
      control: flags.contains(.control),
      alt: flags.contains(.option),
      shift: flags.contains(.shift),
      platform: flags.contains(.command),
      function: clearFunction ? false : flags.contains(.function)
    )
  }
}

@MainActor
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: (any WKScriptMessageHandler)?

  init(target: any WKScriptMessageHandler) {
    self.target = target
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(userContentController, didReceive: message)
  }
}

@MainActor
private final class ShimDragStripView: NSView {
  private let titleLabel = NSTextField(labelWithString: "")
  private let pinButton = NSButton()
  private let openHostButton = NSButton()

  var onTogglePin: (() -> Void)?
  var onOpenInHost: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    titleLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
    titleLabel.textColor = .secondaryLabelColor
    titleLabel.alignment = .center
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    configureActionButton(
      pinButton,
      symbolName: "pin",
      accessibility: "Always on Top",
      tooltip: "Always on Top (⇧⌘P)",
      action: #selector(handleTogglePin)
    )
    configureActionButton(
      openHostButton,
      symbolName: "arrow.up.forward.app",
      accessibility: "Open in VibeValley",
      tooltip: "Open in VibeValley (⌘E)",
      action: #selector(handleOpenInHost)
    )

    addSubview(titleLabel)
    addSubview(pinButton)
    addSubview(openHostButton)
    NSLayoutConstraint.activate([
      openHostButton.centerYAnchor.constraint(equalTo: centerYAnchor),
      openHostButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
      openHostButton.widthAnchor.constraint(equalToConstant: 22),
      openHostButton.heightAnchor.constraint(equalToConstant: 22),

      pinButton.centerYAnchor.constraint(equalTo: centerYAnchor),
      pinButton.trailingAnchor.constraint(equalTo: openHostButton.leadingAnchor, constant: -4),
      pinButton.widthAnchor.constraint(equalToConstant: 22),
      pinButton.heightAnchor.constraint(equalToConstant: 22),

      titleLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
      titleLabel.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 80),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: pinButton.leadingAnchor, constant: -8),
      titleLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
    ])
    setPinned(false)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override var mouseDownCanMoveWindow: Bool { true }

  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 {
      window?.performZoom(nil)
    } else {
      super.mouseDown(with: event)
    }
  }

  func setTitle(_ title: String) {
    titleLabel.stringValue = title
  }

  func setPinned(_ pinned: Bool) {
    pinButton.image = NSImage(
      systemSymbolName: pinned ? "pin.fill" : "pin",
      accessibilityDescription: "Always on Top"
    )
    pinButton.contentTintColor = pinned ? .controlAccentColor : .tertiaryLabelColor
  }

  private func configureActionButton(
    _ button: NSButton,
    symbolName: String,
    accessibility: String,
    tooltip: String,
    action: Selector
  ) {
    button.isBordered = false
    button.bezelStyle = .regularSquare
    button.imagePosition = .imageOnly
    button.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: accessibility)
    button.contentTintColor = .tertiaryLabelColor
    button.toolTip = tooltip
    button.target = self
    button.action = action
    button.translatesAutoresizingMaskIntoConstraints = false
  }

  @objc private func handleTogglePin() {
    onTogglePin?()
  }

  @objc private func handleOpenInHost() {
    onOpenInHost?()
  }
}

@MainActor
private final class ShimWebViewContainer: NSView, WKScriptMessageHandler {
  private static let headerHeight: CGFloat = 32
  private static let storeChannel = "vvStore"
  private let dragStrip = ShimDragStripView(frame: .zero)
  private let storage: AppletStorage?
  let webView: WKWebView

  init(
    frame frameRect: NSRect,
    title: String,
    alwaysOnTop: Bool,
    storage: AppletStorage?,
    onTogglePin: (() -> Void)?,
    onOpenInHost: (() -> Void)?
  ) {
    self.storage = storage
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = WKWebsiteDataStore.nonPersistent()
    let userController = WKUserContentController()
    configuration.userContentController = userController
    self.webView = WKWebView(frame: .zero, configuration: configuration)
    super.init(frame: frameRect)
    autoresizingMask = [.width, .height]
    userController.add(WeakScriptMessageHandler(target: self), name: Self.storeChannel)

    dragStrip.setTitle(title)
    dragStrip.setPinned(alwaysOnTop)
    dragStrip.onTogglePin = onTogglePin
    dragStrip.onOpenInHost = onOpenInHost

    addSubview(dragStrip)
    addSubview(webView)
    layoutChildren()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override func layout() {
    super.layout()
    layoutChildren()
  }

  private func layoutChildren() {
    let h = bounds.height
    let headerH = min(Self.headerHeight, h)
    dragStrip.frame = NSRect(x: 0, y: h - headerH, width: bounds.width, height: headerH)
    webView.frame = NSRect(x: 0, y: 0, width: bounds.width, height: max(0, h - headerH))
  }

  func setTitle(_ title: String) {
    dragStrip.setTitle(title)
  }

  func setPinned(_ pinned: Bool) {
    dragStrip.setPinned(pinned)
  }

  func loadHTML(_ html: String) {
    let ucc = webView.configuration.userContentController
    ucc.removeAllUserScripts()
    if let storage {
      ucc.addUserScript(
        WKUserScript(
          source: storage.bootstrapScript(),
          injectionTime: .atDocumentStart,
          forMainFrameOnly: true
        )
      )
    }
    webView.loadHTMLString(html, baseURL: nil)
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == Self.storeChannel,
      let storage,
      let body = message.body as? [String: Any],
      let op = body["op"] as? String
    else { return }
    switch op {
    case "set":
      if let key = body["key"] as? String, let value = body["value"] as? String {
        storage.set(key: key, value: value)
      }
    case "remove":
      if let key = body["key"] as? String {
        storage.remove(key: key)
      }
    case "clear":
      storage.clear()
    default:
      break
    }
  }
}

@MainActor
private final class ShimStatusView: NSView {
  private let spinner = NSProgressIndicator()
  private let titleLabel = NSTextField(labelWithString: "")
  private let detailLabel = NSTextField(labelWithString: "")
  private let reconnectButton = NSButton(title: "Reconnect", target: nil, action: nil)

  var onReconnect: (() -> Void)?

  override var mouseDownCanMoveWindow: Bool { true }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    autoresizingMask = [.width, .height]

    spinner.style = .spinning
    spinner.controlSize = .regular
    spinner.isDisplayedWhenStopped = false

    titleLabel.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
    titleLabel.alignment = .center

    detailLabel.font = NSFont.systemFont(ofSize: 12)
    detailLabel.textColor = .secondaryLabelColor
    detailLabel.alignment = .center
    detailLabel.maximumNumberOfLines = 4
    detailLabel.lineBreakMode = .byWordWrapping
    detailLabel.preferredMaxLayoutWidth = 420

    reconnectButton.bezelStyle = .rounded
    reconnectButton.target = self
    reconnectButton.action = #selector(handleReconnect)

    let stack = NSStackView(views: [spinner, titleLabel, detailLabel, reconnectButton])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.translatesAutoresizingMaskIntoConstraints = false

    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor),
      stack.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -48),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  func configure(title: String, detail: String, spinning: Bool, showReconnect: Bool) {
    titleLabel.stringValue = title
    detailLabel.stringValue = detail
    detailLabel.isHidden = detail.isEmpty
    if spinning {
      spinner.startAnimation(nil)
      spinner.isHidden = false
    } else {
      spinner.stopAnimation(nil)
      spinner.isHidden = true
    }
    reconnectButton.isHidden = !showReconnect
  }

  @objc private func handleReconnect() {
    onReconnect?()
  }
}
