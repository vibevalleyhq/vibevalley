import CPty
import Darwin
import Foundation

private func withCStrings<R>(_ strings: [String], _ body: ([UnsafeMutablePointer<CChar>?]) -> R) -> R {
  let ptrs = strings.map { strdup($0) }
  defer {
    for ptr in ptrs {
      if let ptr { free(ptr) }
    }
  }
  return body(ptrs + [nil])
}

private final class Session: @unchecked Sendable {
  let id: String
  let pid: Int32
  var masterFd: Int32
  let readSource: DispatchSourceRead
  let procSource: DispatchSourceProcess
  var finished = false
  var readCancelled = false
  var procCancelled = false

  init(
    id: String,
    pid: Int32,
    masterFd: Int32,
    readSource: DispatchSourceRead,
    procSource: DispatchSourceProcess
  ) {
    self.id = id
    self.pid = pid
    self.masterFd = masterFd
    self.readSource = readSource
    self.procSource = procSource
  }
}

public final class PtyManager: @unchecked Sendable {
  private let queue = DispatchQueue(label: "dev.vibevalley.pty")
  private let emit: @Sendable (PtyEvent) -> Void
  private var sessions: [String: Session] = [:]
  private var closed = false

  public init(emit: @escaping @Sendable (PtyEvent) -> Void) {
    self.emit = emit
  }

  public func handle(_ req: PtyRequest) {
    queue.async { [weak self] in
      self?.handleOnQueue(req)
    }
  }

  public func closeAll() {
    queue.sync {
      guard !closed else { return }
      closed = true
      let active = Array(sessions.values)
      sessions.removeAll()
      for session in active {
        _ = Darwin.kill(-session.pid, SIGHUP)
        _ = Darwin.kill(session.pid, SIGHUP)
        cancelSources(session)
        _ = Darwin.kill(-session.pid, SIGKILL)
        _ = Darwin.kill(session.pid, SIGKILL)
        var code: Int32 = 0
        _ = vv_pty_wait_nonblock(session.pid, &code)
      }
    }
  }

  private func handleOnQueue(_ req: PtyRequest) {
    guard !closed else { return }
    switch req.op {
    case "spawn":
      spawnSession(req)
    case "write":
      writeSession(req)
    case "resize":
      resizeSession(req)
    case "kill":
      killSession(req)
    case "inspect":
      inspectSession(req)
    default:
      emit(PtyEvent(event: "error", id: req.id, reqId: req.reqId, message: "unknown op: \(req.op)"))
    }
  }

  private func resolveShell(_ requested: String?) -> String {
    if let requested, !requested.isEmpty, FileManager.default.isExecutableFile(atPath: requested) {
      return requested
    }
    if let envShell = ProcessInfo.processInfo.environment["SHELL"],
      !envShell.isEmpty,
      FileManager.default.isExecutableFile(atPath: envShell)
    {
      return envShell
    }
    if FileManager.default.isExecutableFile(atPath: "/bin/zsh") {
      return "/bin/zsh"
    }
    return "/bin/sh"
  }

  private func spawnSession(_ req: PtyRequest) {
    if let existing = sessions.removeValue(forKey: req.id) {
      terminateSession(existing)
    }

    let shell = resolveShell(req.shell)
    let args = [shell] + (req.args ?? ["-l"])
    var mergedEnv = ProcessInfo.processInfo.environment
    mergedEnv["TERM"] = mergedEnv["TERM"] ?? "xterm-256color"
    mergedEnv["COLORTERM"] = "truecolor"
    if mergedEnv["LANG"] == nil {
      mergedEnv["LANG"] = "en_US.UTF-8"
    }
    if let extra = req.env {
      for (k, v) in extra {
        mergedEnv[k] = v
      }
    }
    let envPairs = mergedEnv.map { "\($0.key)=\($0.value)" }

    let cols = UInt16(clamping: max(2, req.cols ?? 80))
    let rows = UInt16(clamping: max(1, req.rows ?? 24))
    let cwd = req.cwd ?? FileManager.default.homeDirectoryForCurrentUser.path

    var masterFd: Int32 = -1
    let pid: Int32 = withCStrings(args) { cArgs in
      withCStrings(envPairs) { cEnv in
        shell.withCString { cShell in
          cwd.withCString { cCwd in
            cArgs.withUnsafeBufferPointer { argsBuf in
              cEnv.withUnsafeBufferPointer { envBuf in
                vv_pty_spawn(cShell, argsBuf.baseAddress, envBuf.baseAddress, cCwd, cols, rows, &masterFd)
              }
            }
          }
        }
      }
    }

    if pid < 0 || masterFd < 0 {
      let reason = String(cString: strerror(errno))
      emit(PtyEvent(event: "error", id: req.id, reqId: req.reqId, message: "forkpty failed: \(reason)"))
      return
    }

    let id = req.id
    let readSource = DispatchSource.makeReadSource(fileDescriptor: masterFd, queue: queue)
    let procSource = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
    let session = Session(id: id, pid: pid, masterFd: masterFd, readSource: readSource, procSource: procSource)
    sessions[id] = session

    let fdToClose = masterFd
    readSource.setCancelHandler {
      Darwin.close(fdToClose)
    }
    readSource.setEventHandler { [weak self, weak session] in
      guard let self, let session else { return }
      let reachedEnd = self.drainMaster(session)
      if reachedEnd {
        self.finishSession(session)
      }
    }

    procSource.setEventHandler { [weak self, weak session] in
      guard let self, let session, !session.finished else { return }
      if self.drainMaster(session) {
        self.finishSession(session)
        return
      }
      self.queue.asyncAfter(deadline: .now() + .milliseconds(15)) { [weak self, weak session] in
        guard let self, let session, !session.finished else { return }
        _ = self.drainMaster(session)
        self.finishSession(session)
      }
    }

    emit(PtyEvent(event: "spawned", id: id, reqId: req.reqId, pid: Int(pid)))
    readSource.resume()
    procSource.resume()
  }

  private func drainMaster(_ session: Session) -> Bool {
    guard session.masterFd >= 0, !session.finished else { return true }
    var buf = [UInt8](repeating: 0, count: 16384)
    while true {
      let n = buf.withUnsafeMutableBytes { raw -> Int in
        guard let base = raw.baseAddress else { return -1 }
        return Darwin.read(session.masterFd, base, raw.count)
      }
      if n > 0 {
        let data = Data(bytes: buf, count: n).base64EncodedString()
        emit(PtyEvent(event: "data", id: session.id, data: data))
        continue
      }
      if n == 0 {
        return true
      }
      if errno == EINTR {
        continue
      }
      if errno == EAGAIN || errno == EWOULDBLOCK {
        return false
      }
      return true
    }
  }

  private func cancelSources(_ session: Session) {
    session.masterFd = -1
    if !session.readCancelled {
      session.readCancelled = true
      session.readSource.cancel()
    }
    if !session.procCancelled {
      session.procCancelled = true
      session.procSource.cancel()
    }
  }

  private func finishSession(_ session: Session) {
    guard !session.finished else { return }
    session.finished = true
    sessions.removeValue(forKey: session.id)
    cancelSources(session)

    var exitCode: Int32 = 0
    var status = vv_pty_wait_nonblock(session.pid, &exitCode)
    if status == 0 {
      usleep(5_000)
      status = vv_pty_wait_nonblock(session.pid, &exitCode)
    }
    emit(PtyEvent(event: "exit", id: session.id, code: Int(exitCode)))
  }

  private func terminateSession(_ session: Session) {
    _ = Darwin.kill(-session.pid, SIGHUP)
    _ = Darwin.kill(session.pid, SIGHUP)
    let pid = session.pid
    queue.asyncAfter(deadline: .now() + .milliseconds(400)) { [weak self, weak session] in
      var code: Int32 = 0
      if vv_pty_wait_nonblock(pid, &code) == 0 {
        _ = Darwin.kill(-pid, SIGKILL)
        _ = Darwin.kill(pid, SIGKILL)
      }
      if let self, let session, !session.finished {
        self.finishSession(session)
      }
    }
  }

  private func writeSession(_ req: PtyRequest) {
    guard let session = sessions[req.id], session.masterFd >= 0, !session.finished else { return }
    guard let encoded = req.data, let bytes = Data(base64Encoded: encoded), !bytes.isEmpty else { return }
    bytes.withUnsafeBytes { raw in
      guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
      var offset = 0
      var retries = 0
      while offset < bytes.count {
        let written = Darwin.write(session.masterFd, base.advanced(by: offset), bytes.count - offset)
        if written > 0 {
          offset += written
          retries = 0
          continue
        }
        if written < 0 && errno == EINTR {
          continue
        }
        if written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) && retries < 200 {
          retries += 1
          usleep(1_000)
          continue
        }
        break
      }
    }
  }

  private func resizeSession(_ req: PtyRequest) {
    guard let session = sessions[req.id], session.masterFd >= 0, !session.finished else { return }
    let cols = UInt16(clamping: max(2, req.cols ?? 80))
    let rows = UInt16(clamping: max(1, req.rows ?? 24))
    _ = vv_pty_resize(session.masterFd, cols, rows)
  }

  private func killSession(_ req: PtyRequest) {
    guard let session = sessions[req.id], !session.finished else { return }
    terminateSession(session)
  }

  private func inspectSession(_ req: PtyRequest) {
    guard let session = sessions[req.id], session.masterFd >= 0, !session.finished else {
      emit(PtyEvent(event: "inspected", id: req.id, reqId: req.reqId, cwd: "", command: ""))
      return
    }
    var cwdBuf = [CChar](repeating: 0, count: Int(PATH_MAX))
    var cmdBuf = [CChar](repeating: 0, count: 1024)
    vv_pty_inspect(session.masterFd, session.pid, &cwdBuf, cwdBuf.count, &cmdBuf, cmdBuf.count)
    let cwd = String(decoding: cwdBuf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    let command = String(decoding: cmdBuf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    emit(PtyEvent(event: "inspected", id: req.id, reqId: req.reqId, cwd: cwd, command: command))
  }
}
