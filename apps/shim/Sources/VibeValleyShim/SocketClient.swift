// Unix domain socket NDJSON client for VibeValleyShim with silent host wake-up and backoff reconnect.

import AppKit
import Darwin
import Foundation
import ShimCore

enum SocketConnectionState: Sendable {
  case connecting
  case wakingHost
  case connected
  case reconnecting(attempt: Int, reason: String)
  case closedByHost
  case failed(String)
}

final class SocketClient: @unchecked Sendable {
  private let socketPath: String
  private let hostAppPath: String?
  private let queue = DispatchQueue(label: "dev.vibevalley.shim.socket")

  private var fd: Int32 = -1
  private var generation: UInt64 = 0
  private var stopped = false
  private var hostClosedIntentional = false
  private var hasWokenHostThisCycle = false
  private var retryAttempt = 0
  private var backoffMs: Int = 100

  private let onStateChanged: @MainActor (SocketConnectionState) -> Void
  private let onMessage: @MainActor (HostToShim) -> Void

  init(
    socketPath: String,
    hostAppPath: String?,
    onStateChanged: @escaping @MainActor (SocketConnectionState) -> Void,
    onMessage: @escaping @MainActor (HostToShim) -> Void
  ) {
    self.socketPath = socketPath
    self.hostAppPath = hostAppPath
    self.onStateChanged = onStateChanged
    self.onMessage = onMessage
  }

  func start() {
    reconnect()
  }

  func reconnect() {
    queue.async { [self] in
      guard !stopped else { return }
      generation &+= 1
      let currentGen = generation
      closeActiveFdLocked()
      hostClosedIntentional = false
      hasWokenHostThisCycle = false
      retryAttempt = 0
      backoffMs = 100
      notifyState(.connecting)
      attemptConnectLocked(generation: currentGen)
    }
  }

  func markHostClosing() {
    queue.async { [self] in
      hostClosedIntentional = true
    }
  }

  func send(_ message: ShimToHost) {
    let payload: Data
    do {
      payload = try WireCodec.encodeLine(message)
    } catch {
      fputs("VibeValleyShim: failed to encode message: \(error)\n", stderr)
      return
    }
    queue.async { [self] in
      guard !stopped, fd >= 0 else { return }
      writeAll(fd: fd, data: payload)
    }
  }

  func disconnectAndSendDetach() {
    let detachData = try? WireCodec.encodeLine(ShimToHost.detach)
    queue.sync { [self] in
      stopped = true
      generation &+= 1
      if fd >= 0, let detachData {
        writeAll(fd: fd, data: detachData)
      }
      closeActiveFdLocked()
    }
  }

  private func attemptConnectLocked(generation currentGen: UInt64) {
    guard !stopped, currentGen == generation else { return }

    switch openUnixSocket(path: socketPath) {
    case .success(let newFd):
      fd = newFd
      retryAttempt = 0
      backoffMs = 100
      notifyState(.connected)
      Thread.detachNewThread { [self] in
        readLoop(fd: newFd, generation: currentGen)
      }

    case .failure(let error):
      if case .invalidPath(let reason) = error {
        notifyState(.failed(reason))
        return
      }

      if !hasWokenHostThisCycle, let hostAppPath {
        hasWokenHostThisCycle = true
        notifyState(.wakingHost)
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            Self.launchHostSilently(at: hostAppPath)
          }
        }
      } else {
        retryAttempt += 1
        notifyState(.reconnecting(attempt: retryAttempt, reason: error.localizedDescription))
      }

      scheduleRetryLocked(generation: currentGen)
    }
  }

  private func scheduleRetryLocked(generation currentGen: UInt64) {
    let delayMs = backoffMs
    backoffMs = min(backoffMs * 2, 2000)
    queue.asyncAfter(deadline: .now() + .milliseconds(delayMs)) { [self] in
      attemptConnectLocked(generation: currentGen)
    }
  }

  private func readLoop(fd readFd: Int32, generation currentGen: UInt64) {
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    var disconnectReason = "Disconnected from host"

    while true {
      let count = Darwin.read(readFd, &chunk, chunk.count)
      if count > 0 {
        buffer.append(contentsOf: chunk[..<count])
        drainLines(from: &buffer)
      } else if count == 0 {
        disconnectReason = "Host closed connection"
        break
      } else {
        if errno == EINTR { continue }
        disconnectReason = String(cString: strerror(errno))
        break
      }
    }

    let finalDisconnectReason = disconnectReason
    queue.async { [self] in
      if fd == readFd {
        closeActiveFdLocked()
      } else {
        Darwin.close(readFd)
      }
      guard !stopped, currentGen == generation else { return }
      if hostClosedIntentional {
        notifyState(.closedByHost)
        return
      }
      retryAttempt += 1
      notifyState(.reconnecting(attempt: retryAttempt, reason: finalDisconnectReason))
      scheduleRetryLocked(generation: currentGen)
    }
  }

  private func drainLines(from buffer: inout Data) {
    while let newlineIndex = buffer.firstIndex(of: 0x0A) {
      let lineData = buffer[..<newlineIndex]
      buffer.removeSubrange(...newlineIndex)
      guard !lineData.isEmpty else { continue }
      guard var line = String(data: lineData, encoding: .utf8) else {
        fputs("VibeValleyShim: skipping non-UTF8 wire frame\n", stderr)
        continue
      }
      if line.hasSuffix("\r") {
        line.removeLast()
      }
      if line.isEmpty { continue }

      do {
        let message = try WireCodec.decode(HostToShim.self, fromLine: line)
        DispatchQueue.main.async { [self] in
          MainActor.assumeIsolated {
            onMessage(message)
          }
        }
      } catch {
        fputs("VibeValleyShim: failed to decode host message: \(error)\n", stderr)
      }
    }
  }

  private func closeActiveFdLocked() {
    if fd >= 0 {
      Darwin.close(fd)
      fd = -1
    }
  }

  private func notifyState(_ state: SocketConnectionState) {
    DispatchQueue.main.async { [self] in
      MainActor.assumeIsolated {
        onStateChanged(state)
      }
    }
  }

  private func writeAll(fd writeFd: Int32, data: Data) {
    data.withUnsafeBytes { rawBuffer in
      guard let baseAddress = rawBuffer.baseAddress else { return }
      var offset = 0
      while offset < rawBuffer.count {
        let written = Darwin.write(writeFd, baseAddress.advanced(by: offset), rawBuffer.count - offset)
        if written > 0 {
          offset += written
        } else if written == -1 && errno == EINTR {
          continue
        } else {
          break
        }
      }
    }
  }

  private enum ConnectError: Error {
    case invalidPath(String)
    case syscall(Int32)

    var localizedDescription: String {
      switch self {
      case .invalidPath(let message): return message
      case .syscall(let code): return String(cString: strerror(code))
      }
    }
  }

  private func openUnixSocket(path: String) -> Result<Int32, ConnectError> {
    var addr = sockaddr_un()
    let maxPathLen = MemoryLayout.size(ofValue: addr.sun_path)
    let utf8 = Array(path.utf8)
    guard utf8.count < maxPathLen else {
      return .failure(.invalidPath("Socket path exceeds \(maxPathLen - 1) bytes: \(path)"))
    }

    let sockFd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard sockFd >= 0 else {
      return .failure(.syscall(errno))
    }

    var noSigPipe: Int32 = 1
    Darwin.setsockopt(
      sockFd,
      SOL_SOCKET,
      SO_NOSIGPIPE,
      &noSigPipe,
      socklen_t(MemoryLayout<Int32>.size)
    )

    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &addr.sun_path) { rawPath in
      rawPath.initializeMemory(as: UInt8.self, repeating: 0)
      for (index, byte) in utf8.enumerated() {
        rawPath[index] = byte
      }
    }

    let connectResult = withUnsafePointer(to: &addr) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
        Darwin.connect(sockFd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }

    if connectResult == 0 {
      return .success(sockFd)
    }

    let err = errno
    Darwin.close(sockFd)
    return .failure(.syscall(err))
  }

  @MainActor
  static func launchHostSilently(at path: String, activate: Bool = false) {
    let url = URL(fileURLWithPath: path)
    if path.hasSuffix(".app") {
      let config = NSWorkspace.OpenConfiguration()
      config.arguments = activate ? [] : ["--background"]
      config.activates = activate
      config.hides = !activate
      NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
        if let error {
          fputs("VibeValleyShim: failed to open host app \(path): \(error.localizedDescription)\n", stderr)
        }
      }
      return
    }

    let process = Process()
    process.executableURL = url
    process.arguments = activate ? [] : ["--background"]
    do {
      try process.run()
    } catch {
      fputs("VibeValleyShim: failed to launch host binary \(path): \(error.localizedDescription)\n", stderr)
    }
  }
}
