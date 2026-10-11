// Better Grok Bot Helper (macOS): background push-to-talk keys and music ducking for the BGB agent.
// Wire contract: `sdk/helper.ts` protocol v4.
//
// Runs as its own LaunchAgent (`io.github.unravl.bettergrokbot.helper`), so macOS attributes Input
// Monitoring and Automation to this app rather than to `bgb`. It is a WebSocket client of the agent:
// `ws://127.0.0.1:<bridgePort>/helper` with `Authorization: Bearer <bridgeToken>`, both reread from
// `<BGB_DATA_DIR or ~/Library/Application Support/BetterGrokBot>/config.json` before every connection
// attempt (every 2 s while disconnected), so a moved port or new token is picked up on its own.
//
// The agent sends `watch` with `KeyboardEvent.code` strings (always a subset of `HELPER_CODES.darwin`:
// the eight modifiers, Fn and F1–F20). A listen-only CGEvent tap, enabled only while the watched set
// is non-empty, reports those keys by name. Every other key stays anonymous: pressing one while a
// watched key is held sends a single `chord` for the held code, at most once per hold, so push-to-talk
// can tell a shortcut from a hold. Character keys are never reported.
//
// While the agent asks for `duck`, the already-running music players are lowered through in-process
// Apple Events, and restored when it releases (fading back up) or the socket closes, or at once when
// the helper exits. When the socket closes, the watched set is emptied (tap disabled) and any duck is
// released before reconnecting.
//
// Everything (socket callbacks, event tap, timers, signals) runs on the main queue / main run loop,
// so that state is never shared across threads. The only exception is `Ducker`: its Apple Events run
// on one serial background queue, so a slow or hung player never delays keys.
//
// Build: native/macos-helper/build.sh

import AppKit
import CoreGraphics
import CoreServices
import Foundation

let protocolVersion = 4
let reconnectInterval: TimeInterval = 2
let pingInterval: TimeInterval = 20
let accessRetryInterval: TimeInterval = 2
let accessGiveUpAfter: TimeInterval = 120

// MARK: - Logging

let logDateFormatter: ISO8601DateFormatter = {
	let formatter = ISO8601DateFormatter()
	formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
	return formatter
}()

func log(_ message: String) {
	let line = "\(logDateFormatter.string(from: Date())) \(message)\n"
	FileHandle.standardError.write(Data(line.utf8))
}

/// Logs locally and forwards the line to the agent's log as a `log` message.
func remoteLog(_ level: String, _ message: String) {
	log(message)
	send(["type": "log", "level": level, "message": message])
}

// MARK: - Key codes

/// `HELPER_CODES.darwin` (sdk/helper.ts) → macOS virtual key code (`kVK_*`, Carbon `Events.h`).
let keyTable: [(code: String, keyCode: Int)] = [
	("AltLeft", 0x3A),
	("AltRight", 0x3D),
	("ControlLeft", 0x3B),
	("ControlRight", 0x3E),
	("ShiftLeft", 0x38),
	("ShiftRight", 0x3C),
	("MetaLeft", 0x37),
	("MetaRight", 0x36),
	("Fn", 0x3F),
	("F1", 0x7A),
	("F2", 0x78),
	("F3", 0x63),
	("F4", 0x76),
	("F5", 0x60),
	("F6", 0x61),
	("F7", 0x62),
	("F8", 0x64),
	("F9", 0x65),
	("F10", 0x6D),
	("F11", 0x67),
	("F12", 0x6F),
	("F13", 0x69),
	("F14", 0x6B),
	("F15", 0x71),
	("F16", 0x6A),
	("F17", 0x40),
	("F18", 0x4F),
	("F19", 0x50),
	("F20", 0x5A),
]
let helperCodes = keyTable.map { $0.code }
let keyCodeForCode = Dictionary(uniqueKeysWithValues: keyTable.map { ($0.code, $0.keyCode) })
let codeForKeyCode = Dictionary(uniqueKeysWithValues: keyTable.map { ($0.keyCode, $0.code) })

/// Device-dependent flag bit (or device-independent mask) that tells whether a modifier key is held.
func modifierMask(_ keyCode: Int) -> UInt64? {
	switch keyCode {
	case 0x3B: return 0x1 // Left Control
	case 0x38: return 0x2 // Left Shift
	case 0x3C: return 0x4 // Right Shift
	case 0x37: return 0x8 // Left Command
	case 0x36: return 0x10 // Right Command
	case 0x3A: return 0x20 // Left Option
	case 0x3D: return 0x40 // Right Option
	case 0x3E: return 0x2000 // Right Control
	case 0x3F: return CGEventFlags.maskSecondaryFn.rawValue // Fn
	default: return nil
	}
}

/// The live hardware state of a watched key.
func isDownNow(_ keyCode: Int) -> Bool {
	if let mask = modifierMask(keyCode) {
		return CGEventSource.flagsState(.combinedSessionState).rawValue & mask != 0
	}
	return CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(keyCode))
}

// MARK: - State

/// Watched code → currently down.
var watched: [String: Bool] = [:]
/// Held codes that already reported a `chord` during the current hold.
var chorded: Set<String> = []
var eventTap: CFMachPort?
var tapEnabled = false
var hasAccess = false

// MARK: - Music ducking

/// Music players `duck` lowers, by bundle id, with names for the log. Each is scriptable via
/// `sound volume` (0–100).
let duckPlayers: [(bundleId: String, name: String)] = [("com.spotify.client", "Spotify"), ("com.apple.Music", "Music")]
/// How long one Apple Event waits for its reply, in ticks (1/60 s). Past it the event fails with
/// -1712, so neither a hung player nor an unanswered Automation prompt can wedge the duck queue.
let appleEventTimeoutTicks = 60
/// Players round the volume they are given; a reading within this of what the helper set is untouched.
let volumeTolerance = 2
/// A restore fades from the ducked volume back to the original in this many steps, the first at
/// once and the rest this far apart (about 600 ms in all). Ducking and level changes stay instant.
let fadeSteps = 8
let fadeStepInterval = DispatchTimeInterval.milliseconds(85)

struct DuckRecord {
	let bundleId: String
	/// The running instance the events go to; once it quits, they fail with -600.
	let pid: pid_t
	let name: String
	/// The volume before the first duck; restored on unduck.
	let original: Int
	/// What the helper set last, for the "the user moved it" check.
	var lastSet: Int
}

struct AppleEventError: Error, CustomStringConvertible {
	let code: OSStatus

	var description: String {
		let meaning: String
		switch code {
		case OSStatus(errAEEventNotPermitted): meaning = " = Automation not granted; allow it in System Settings → Privacy & Security → Automation"
		case OSStatus(errAETimeout): meaning = " = the player did not answer in time"
		case OSStatus(procNotFound): meaning = " = the player is not running"
		default: meaning = ""
		}
		return "Apple Event error \(code)\(meaning)"
	}
}

/// The direct parameter of `get`/`set sound volume`: property 'pVol' (integer 0–100 in both
/// players' `sdef`) of the application itself (null container).
let soundVolumeSpecifier: NSAppleEventDescriptor = {
	let record = NSAppleEventDescriptor.record()
	record.setDescriptor(NSAppleEventDescriptor(typeCode: DescType(typeProperty)), forKeyword: AEKeyword(keyAEDesiredClass))
	record.setDescriptor(NSAppleEventDescriptor(enumCode: OSType(formPropertyID)), forKeyword: AEKeyword(keyAEKeyForm))
	record.setDescriptor(NSAppleEventDescriptor(typeCode: 0x7056_6F6C), forKeyword: AEKeyword(keyAEKeyData)) // 'pVol'
	record.setDescriptor(NSAppleEventDescriptor.null(), forKeyword: AEKeyword(keyAEContainer))
	return record.coerce(toDescriptorType: DescType(typeObjectSpecifier))!
}()

/// UTC time of day with milliseconds, like the log line timestamps, for Apple Event traces.
let traceTimeFormatter: ISO8601DateFormatter = {
	let formatter = ISO8601DateFormatter()
	formatter.formatOptions = [.withTime, .withColonSeparatorInTime, .withFractionalSeconds]
	return formatter
}()

/// Gets the player's `sound volume`, or sets it to `value`, with one in-process Apple Event:
/// core/getd or core/setd on `soundVolumeSpecifier`, the events AppleScript sends for
/// `get`/`set sound volume`. It goes to the pid of the running player, never by bundle id
/// (Spotify does not answer events addressed by bundle id). An event addressed by pid never
/// launches anything, and one to a process that has quit fails with -600 (procNotFound), so every
/// event is also an atomic "still running" check. Appends "get 50 @21:00:41.481 +1.2 ms" (the
/// result, when the event was sent, and how long its reply took; or "get error -600 …") to `trace`.
func soundVolume(_ pid: pid_t, set value: Int? = nil, trace: inout String) -> Result<Int, AppleEventError> {
	let event = NSAppleEventDescriptor(
		eventClass: AEEventClass(kAECoreSuite),
		eventID: AEEventID(value == nil ? kAEGetData : kAESetData),
		targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid),
		returnID: AEReturnID(kAutoGenerateReturnID),
		transactionID: AETransactionID(kAnyTransactionID)
	)
	event.setParam(soundVolumeSpecifier, forKeyword: AEKeyword(keyDirectObject))
	if let value { event.setParam(NSAppleEventDescriptor(int32: Int32(value)), forKeyword: AEKeyword(keyAEData)) }

	var replyDesc = AEDesc()
	let sentAt = Date()
	let started = DispatchTime.now().uptimeNanoseconds
	var status = AESendMessage(event.aeDesc, &replyDesc, AESendMode(kAEWaitReply | kAECanInteract), appleEventTimeoutTicks)
	let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
	let reply = NSAppleEventDescriptor(aeDescNoCopy: &replyDesc)
	if status == noErr, let code = reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value, code != 0 {
		status = code
	}
	var volume = value ?? 0
	if status == noErr, value == nil {
		if let result = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)) {
			volume = Int(result.int32Value)
		} else {
			status = OSStatus(errAEDescNotFound)
		}
	}
	let result = status == noErr ? String(volume) : "error \(status)"
	let entry = "\(value == nil ? "get" : "set") \(result) @\(traceTimeFormatter.string(from: sentAt)) +\(String(format: "%.1f", elapsed)) ms"
	trace += trace.isEmpty ? entry : ", \(entry)"
	return status == noErr ? .success(volume) : .failure(AppleEventError(code: status))
}

/// Applies the duck request. The main thread only records the wanted state; one serial background
/// queue converges the players to it, so duck/unduck stay ordered, and a request that arrives while
/// Apple Events are in flight is picked up when they finish (an unduck during a duck still ends
/// restored; requests superseded meanwhile are skipped). A restore fades up in steps scheduled on
/// the same queue, which stays free between them, so a duck that arrives mid-fade cuts it short and
/// goes straight to its level.
final class Ducker {
	private let queue = DispatchQueue(label: "io.github.unravl.bettergrokbot.helper.duck")
	private let lock = NSLock()
	/// Guarded by `lock`: the wanted level, nil = not ducked.
	private var target: Double?
	/// Guarded by `lock`: a drain is queued or running.
	private var draining = false
	/// Queue-only: the level the players were last converged to, nil = not ducked (or fading back).
	private var applied: Double?
	/// Queue-only: the players the helper lowered. Non-empty while `applied` is nil = a fade is running.
	private var records: [DuckRecord] = []
	/// Queue-only: steps of the running fade done so far.
	private var fadeStepsDone = 0
	/// Queue-only: the fade's next step, scheduled on `queue`.
	private var nextFadeStep: DispatchWorkItem?

	func request(_ level: Double?) {
		lock.lock()
		defer { lock.unlock() }
		target = level
		if draining { return }
		draining = true
		queue.async { self.settle() }
	}

	/// Restores at once, without a fade, for exit paths. Must not be called on the duck queue.
	func restoreNow() {
		lock.lock()
		target = nil
		lock.unlock()
		queue.sync {
			nextFadeStep?.cancel()
			nextFadeStep = nil
			for record in records {
				let (outcome, trace) = setIfUnchanged(record, record.original, exact: true)
				if outcome == .set { log("duck: \(record.name) volume \(record.lastSet) -> \(record.original) (restored at once) [\(trace)]") }
			}
			records = []
			applied = nil
		}
	}

	private func settle() {
		while true {
			lock.lock()
			let wanted = target
			if wanted == applied {
				draining = false
				lock.unlock()
				return
			}
			lock.unlock()
			if let level = wanted {
				if applied == nil && records.isEmpty {
					duck(level)
				} else {
					nextFadeStep?.cancel()
					nextFadeStep = nil
					relevel(level)
				}
			} else {
				fadeStepsDone = 0
				fadeStep()
			}
			applied = wanted
		}
	}

	private func duck(_ level: Double) {
		for player in duckPlayers {
			// NSRunningApplication only reads the list of running apps; it never launches one.
			guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: player.bundleId).first?.processIdentifier,
				pid > 0
			else { continue }
			var trace = ""
			switch soundVolume(pid, trace: &trace) {
			case let .success(original):
				let value = Int((Double(original) * level).rounded())
				let set = soundVolume(pid, set: value, trace: &trace)
				// A timed-out set may still land; recording it lets the restore either undo it or,
				// finding the original untouched, leave the player alone.
				if case let .failure(error) = set, error.code != OSStatus(errAETimeout) {
					log("duck: \(player.name): \(error) [\(trace)]")
					continue
				}
				records.append(DuckRecord(bundleId: player.bundleId, pid: pid, name: player.name, original: original, lastSet: value))
				log("duck: \(player.name) volume \(original) -> \(value) (level \(level)) [\(trace)]")
			case let .failure(error) where error.code == OSStatus(procNotFound):
				log("duck: \(player.name) quit meanwhile; skipped [\(trace)]")
			case let .failure(error):
				log("duck: \(player.name): \(error) [\(trace)]")
			}
		}
		if records.isEmpty { log("duck: no player lowered (level \(level))") }
	}

	private func relevel(_ level: Double) {
		records = records.compactMap { record in
			var record = record
			let value = Int((Double(record.original) * level).rounded())
			let (outcome, trace) = setIfUnchanged(record, value, exact: true)
			switch outcome {
			case .set:
				log("duck: \(record.name) volume \(record.lastSet) -> \(value) (level \(level), original \(record.original)) [\(trace)]")
				record.lastSet = value
				return record
			case .failed:
				return record
			case .dropped:
				return nil
			}
		}
	}

	/// One step of the restore fade: moves each player 1/(steps left) of the way from what the
	/// helper last set to its original, then schedules the next step. A duck requested meanwhile
	/// ends the fade; the drain that request queued re-levels from the recorded originals.
	private func fadeStep() {
		nextFadeStep = nil
		lock.lock()
		let ducking = target != nil
		lock.unlock()
		if ducking { return }
		let stepsLeft = fadeSteps - fadeStepsDone
		fadeStepsDone += 1
		records = records.compactMap { record in
			var record = record
			let value = stepsLeft == 1
				? record.original
				: record.lastSet + Int((Double(record.original - record.lastSet) / Double(stepsLeft)).rounded())
			if value == record.lastSet && stepsLeft > 1 { return record }
			let (outcome, trace) = setIfUnchanged(record, value, exact: stepsLeft == 1)
			switch outcome {
			case .set:
				let step = stepsLeft == 1 ? "restored" : "fading, step \(fadeStepsDone)/\(fadeSteps)"
				log("duck: \(record.name) volume \(record.lastSet) -> \(value) (\(step)) [\(trace)]")
				record.lastSet = value
				return stepsLeft == 1 ? nil : record
			case .failed:
				return stepsLeft == 1 ? nil : record
			case .dropped:
				return nil
			}
		}
		if records.isEmpty { return }
		let step = DispatchWorkItem { self.fadeStep() }
		nextFadeStep = step
		queue.asyncAfter(deadline: .now() + fadeStepInterval, execute: step)
	}

	enum SetOutcome {
		case set
		/// The user moved the volume, or the player quit: the helper stops managing it.
		case dropped
		/// The Apple Event failed; the record stays as it was.
		case failed
	}

	/// Sets `value` if the player is still (±tolerance) at what the helper last set; returns the
	/// outcome and the Apple Event trace. The `get` fails with -600 if the player quit, so that
	/// check is atomic with the set. With `exact`, a short read-back gets one more: Spotify stores
	/// a float and reads back one less than most values it is given (50 → 49), so a restore that
	/// only sent the original would lower the player by 1 on every duck cycle.
	private func setIfUnchanged(_ record: DuckRecord, _ value: Int, exact: Bool) -> (SetOutcome, String) {
		var trace = ""
		let failed = { (error: AppleEventError) -> SetOutcome in
			if error.code == OSStatus(procNotFound) {
				log("duck: \(record.name) quit meanwhile; nothing to set [\(trace)]")
				return .dropped
			}
			log("duck: \(record.name): \(error) [\(trace)]")
			return .failed
		}
		let current: Int
		switch soundVolume(record.pid, trace: &trace) {
		case let .success(volume): current = volume
		case let .failure(error): return (failed(error), trace)
		}
		if abs(current - record.lastSet) > volumeTolerance {
			log("duck: \(record.name) volume is \(current), not \(record.lastSet): the user changed it; left alone [\(trace)]")
			return (.dropped, trace)
		}
		if case let .failure(error) = soundVolume(record.pid, set: value, trace: &trace) {
			return (failed(error), trace)
		}
		if exact, value < 100, case let .success(readBack) = soundVolume(record.pid, trace: &trace), readBack < value {
			_ = soundVolume(record.pid, set: value + 1, trace: &trace)
		}
		return (.set, trace)
	}
}

let ducker = Ducker()
/// The level last handed to `ducker` (main thread), nil = not ducked.
var duckRequested: Double?

func setDuck(_ level: Double?) {
	if level == duckRequested { return }
	duckRequested = level
	log(level.map { "duck: wanted at level \($0)" } ?? "duck: released")
	ducker.request(level)
}

// MARK: - Bridge connection

struct BridgeConfig {
	let port: Int
	let token: String
}

func dataDirectory() -> URL {
	if let dir = ProcessInfo.processInfo.environment["BGB_DATA_DIR"], !dir.isEmpty {
		return URL(fileURLWithPath: dir, isDirectory: true)
	}
	return FileManager.default.homeDirectoryForCurrentUser
		.appendingPathComponent("Library/Application Support/BetterGrokBot", isDirectory: true)
}

/// Why `config.json` can't be used yet (the agent's `bgb setup` writes it).
struct ConfigProblem: Error {
	let message: String
}

func readBridgeConfig() -> Result<BridgeConfig, ConfigProblem> {
	let file = dataDirectory().appendingPathComponent("config.json")
	guard let data = try? Data(contentsOf: file) else { return .failure(ConfigProblem(message: "cannot read \(file.path)")) }
	guard let config = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
		return .failure(ConfigProblem(message: "\(file.path) is not a JSON object"))
	}
	guard let port = config["bridgePort"] as? Int, (1...65535).contains(port) else {
		return .failure(ConfigProblem(message: "\(file.path) has no valid bridgePort"))
	}
	guard let token = config["bridgeToken"] as? String, !token.isEmpty else {
		return .failure(ConfigProblem(message: "\(file.path) has no bridgeToken"))
	}
	return .success(BridgeConfig(port: port, token: token))
}

final class SocketDelegate: NSObject, URLSessionWebSocketDelegate {
	func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
		DispatchQueue.main.async { opened(webSocketTask) }
	}

	func urlSession(
		_ session: URLSession,
		webSocketTask: URLSessionWebSocketTask,
		didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
		reason: Data?
	) {
		DispatchQueue.main.async { disconnected(webSocketTask, "closed by the agent (\(closeCode.rawValue))") }
	}

	func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
		let reason = error.map { $0.localizedDescription } ?? "connection ended"
		DispatchQueue.main.async { disconnected(task, reason) }
	}
}

let socketDelegate = SocketDelegate()
let session: URLSession = {
	let configuration = URLSessionConfiguration.ephemeral
	configuration.connectionProxyDictionary = [:]
	configuration.waitsForConnectivity = false
	configuration.timeoutIntervalForRequest = 10
	return URLSession(configuration: configuration, delegate: socketDelegate, delegateQueue: .main)
}()
/// The current connection attempt or connection; callbacks of older tasks are ignored.
var socket: URLSessionWebSocketTask?
var socketOpen = false
var pingTimer: Timer?
/// The last connection problem logged, so a missing agent logs once rather than every 2 s.
var lastConnectProblem: String?

func noteConnectProblem(_ problem: String) {
	if problem == lastConnectProblem { return }
	lastConnectProblem = problem
	log("not connected: \(problem); retrying every \(Int(reconnectInterval)) s")
}

func connect() {
	let config: BridgeConfig
	switch readBridgeConfig() {
	case let .success(value): config = value
	case let .failure(problem):
		noteConnectProblem(problem.message)
		scheduleReconnect()
		return
	}
	var request = URLRequest(url: URL(string: "ws://127.0.0.1:\(config.port)/helper")!)
	request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
	request.timeoutInterval = 10
	let task = session.webSocketTask(with: request)
	socket = task
	socketOpen = false
	task.resume()
	receive(task)
}

func scheduleReconnect() {
	DispatchQueue.main.asyncAfter(deadline: .now() + reconnectInterval) { connect() }
}

func opened(_ task: URLSessionWebSocketTask) {
	guard task === socket, !socketOpen else { return }
	socketOpen = true
	lastConnectProblem = nil
	log("connected to the agent at \(task.originalRequest?.url?.absoluteString ?? "?")")
	send([
		"type": "hello",
		"protocol": protocolVersion,
		"platform": "darwin",
		"keys": hasAccess ? "granted" : "denied",
		"codes": helperCodes,
		"media": true,
	])
	pingTimer?.invalidate()
	pingTimer = Timer.scheduledTimer(withTimeInterval: pingInterval, repeats: true) { _ in
		task.sendPing { error in
			guard let error else { return }
			DispatchQueue.main.async { disconnected(task, "ping failed: \(error.localizedDescription)") }
		}
	}
}

/// The socket is gone: forget the watched set (tap off), release any duck, reconnect in 2 s.
func disconnected(_ task: URLSessionTask, _ reason: String) {
	guard task === socket else { return }
	socket = nil
	pingTimer?.invalidate()
	pingTimer = nil
	if socketOpen {
		log("disconnected from the agent: \(reason)")
	} else {
		noteConnectProblem(reason)
	}
	socketOpen = false
	task.cancel()
	if !watched.isEmpty {
		watched = [:]
		chorded = []
		updateTap()
	}
	setDuck(nil)
	scheduleReconnect()
}

func receive(_ task: URLSessionWebSocketTask) {
	task.receive { result in
		DispatchQueue.main.async {
			guard task === socket else { return }
			switch result {
			case let .failure(error):
				disconnected(task, error.localizedDescription)
				return
			case let .success(.string(text)):
				handleMessage(Data(text.utf8))
			case let .success(.data(data)):
				handleMessage(data)
			@unknown default:
				break
			}
			receive(task)
		}
	}
}

func send(_ message: [String: Any]) {
	guard let task = socket, socketOpen,
		let data = try? JSONSerialization.data(withJSONObject: message),
		let text = String(data: data, encoding: .utf8)
	else { return }
	task.send(.string(text)) { error in
		guard let error else { return }
		DispatchQueue.main.async { disconnected(task, "send failed: \(error.localizedDescription)") }
	}
}

// MARK: - Agent messages

struct AgentMessage: Decodable {
	let type: String
	let codes: [String]?
	let ducked: Bool?
	let level: Double?
}

func handleMessage(_ data: Data) {
	guard let message = try? JSONDecoder().decode(AgentMessage.self, from: data) else { return }
	switch message.type {
	case "watch":
		guard let codes = message.codes else { return }
		replaceWatch(codes)
	case "duck":
		guard let ducked = message.ducked else { return }
		var level: Double?
		if ducked {
			guard let requested = message.level, requested.isFinite else { return }
			level = min(max(requested, 0), 1)
		}
		setDuck(level)
	case "quit":
		log("quit requested; exiting")
		ducker.restoreNow()
		exit(0)
	default:
		return
	}
}

/// Replaces the watched set. Retained codes keep their down state; removed codes are forgotten
/// without events; added codes start up, except modifiers, which take the current hardware state
/// (reported as `key down` when held). Codes outside `HELPER_CODES.darwin` are ignored.
func replaceWatch(_ codes: [String]) {
	var next: [String: Bool] = [:]
	for code in codes where next[code] == nil {
		guard let keyCode = keyCodeForCode[code] else { continue }
		if let down = watched[code] {
			next[code] = down
		} else if modifierMask(keyCode) != nil {
			let down = isDownNow(keyCode)
			next[code] = down
			if down { send(["type": "key", "code": code, "down": true]) }
		} else {
			next[code] = false
		}
	}
	chorded = chorded.filter { next[$0] == true }
	watched = next
	log(next.isEmpty ? "watching no keys" : "watching \(next.keys.sorted().joined(separator: ", "))")
	updateTap()
}

// MARK: - Key events

func report(keyCode: Int, down: Bool) {
	guard let code = codeForKeyCode[keyCode], let wasDown = watched[code], wasDown != down else { return }
	watched[code] = down
	chorded.remove(code)
	send(["type": "key", "code": code, "down": down])
	log("key \(code) \(down ? "down" : "up")")
}

/// Another key went down while a watched key is held: the press is part of a shortcut. Only the
/// held code is reported, never the other key.
func reportChord(otherKeyCode: Int) {
	let other = codeForKeyCode[otherKeyCode]
	for (code, down) in watched where down && code != other && !chorded.contains(code) {
		chorded.insert(code)
		send(["type": "chord", "code": code])
		log("chord while \(code) held")
	}
}

/// After the system disabled the tap, events may have been missed; resync from the live key state.
func reconcileKeyStates() {
	for (code, wasDown) in watched {
		guard let keyCode = keyCodeForCode[code] else { continue }
		let down = isDownNow(keyCode)
		if down != wasDown {
			watched[code] = down
			chorded.remove(code)
			send(["type": "key", "code": code, "down": down])
			log("key \(code) resynced \(down ? "down" : "up")")
		}
	}
}

func handle(type: CGEventType, event: CGEvent) {
	switch type {
	case .tapDisabledByTimeout, .tapDisabledByUserInput:
		// Our own tapEnable(false) also arrives here as tapDisabledByUserInput; only an
		// unexpected disable (while something is watched) needs attention.
		guard tapEnabled, let tap = eventTap else { return }
		remoteLog("warn", "event tap disabled by system (\(type == .tapDisabledByTimeout ? "timeout" : "user input")); re-enabling")
		CGEvent.tapEnable(tap: tap, enable: true)
		reconcileKeyStates()
	case .keyDown:
		if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return }
		let keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
		reportChord(otherKeyCode: keyCode)
		report(keyCode: keyCode, down: true)
	case .keyUp:
		report(keyCode: Int(event.getIntegerValueField(.keyboardEventKeycode)), down: false)
	case .flagsChanged:
		let keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
		guard let mask = modifierMask(keyCode) else { return }
		let down = event.flags.rawValue & mask != 0
		if down { reportChord(otherKeyCode: keyCode) }
		report(keyCode: keyCode, down: down)
	default:
		return
	}
}

let tapCallback: CGEventTapCallBack = { _, type, event, _ in
	handle(type: type, event: event)
	return Unmanaged.passUnretained(event)
}

func updateTap() {
	guard let tap = eventTap else { return }
	let want = !watched.isEmpty
	if want == tapEnabled { return }
	CGEvent.tapEnable(tap: tap, enable: want)
	tapEnabled = want
	log("event tap \(want ? "enabled" : "disabled")")
}

func createTap() -> Bool {
	let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
		| (1 << CGEventType.flagsChanged.rawValue)
	guard let tap = CGEvent.tapCreate(
		tap: .cgSessionEventTap,
		place: .headInsertEventTap,
		options: .listenOnly,
		eventsOfInterest: CGEventMask(mask),
		callback: tapCallback,
		userInfo: nil
	) else { return false }
	CGEvent.tapEnable(tap: tap, enable: false)
	let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
	CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
	eventTap = tap
	return true
}

func acquireAccess(startedAt: Date) {
	// A listen-only tap is created even without Input Monitoring, but macOS then withholds every
	// keyboard event; only the preflight check says whether keys will actually arrive.
	if CGPreflightListenEventAccess() && (eventTap != nil || createTap()) {
		hasAccess = true
		log("Input Monitoring access granted; event tap ready")
		send(["type": "access", "keys": "granted"])
		updateTap()
		return
	}
	if Date().timeIntervalSince(startedAt) >= accessGiveUpAfter {
		remoteLog("warn", "no Input Monitoring access after \(Int(accessGiveUpAfter)) s; exiting so launchd restarts with fresh TCC state")
		ducker.restoreNow()
		exit(0)
	}
	DispatchQueue.main.asyncAfter(deadline: .now() + accessRetryInterval) { acquireAccess(startedAt: startedAt) }
}

// MARK: - Main

log("Better Grok Bot Helper (protocol v\(protocolVersion)) starting (pid \(getpid()))")
if !CGPreflightListenEventAccess() {
	log("Input Monitoring access not granted yet; requesting")
	_ = CGRequestListenEventAccess()
}

// Never leave the players lowered: restore on normal exit and on SIGTERM (launchd bootout) / SIGINT.
atexit { ducker.restoreNow() }
var signalSources: [DispatchSourceSignal] = []
for signalNumber in [SIGTERM, SIGINT] {
	signal(signalNumber, SIG_IGN)
	let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
	source.setEventHandler {
		log("received signal \(signalNumber); exiting")
		ducker.restoreNow()
		exit(0)
	}
	source.resume()
	signalSources.append(source)
}

connect()
acquireAccess(startedAt: Date())
RunLoop.main.run()
