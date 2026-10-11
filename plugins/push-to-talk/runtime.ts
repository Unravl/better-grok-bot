/**
 * Push to talk for voice calls.
 *
 * With push to talk on when a call starts, its realtime session uses manual turns
 * (`turn_detection.type: null`) and microphone frames reach the server only while the
 * push-to-talk key (or the call's talk button) is held. Pressing starts a turn the way server
 * VAD hearing speech does: a reply in flight is cancelled and the app receives a synthetic
 * `input_audio_buffer.speech_started`, so it stops playback and truncates what went unheard as
 * usual. Letting go commits the audio and asks for a response at once instead of waiting out
 * the VAD silence window.
 *
 * Inside the window the key comes from DOM key events. Outside it (Grok Bot in the background)
 * it comes from Better Grok Bot's `keys` service (the native key helper), which watches the key
 * only while a push-to-talk call is live and only when it is a modifier, function, lock or media
 * key the helper on this OS can watch. Keys Chromium never reports to the page (Fn on macOS) come
 * only from the helper, focused or not, and the settings recorder picks them up through it too.
 * When a modifier key is held together with another key, the hold was a shortcut (Command-Tab,
 * Option-letter): its audio is discarded instead of answered.
 *
 * Through the `media` service, music players are lowered to the "Music while Grok talks" level
 * from the moment a reply is on its way until Grok's voice has finished playing in any voice call
 * (plus a short hang time between sentences), and to the "Music while I talk" level while the
 * caller talks: the push-to-talk key is held, or server VAD hears them.
 */
import {
	type ComponentFactory,
	HELPER_CODES,
	type KeysState,
	type MediaState,
	MODIFIER_KEY_CODES,
	type Platform,
	type PluginContext,
	WATCHABLE_CODES,
} from "@better-grok-bot/sdk";

/** Built by the `realtime-session` patch inside the app's voice call session. */
interface SessionAdapter {
	socket: WebSocket;
	/** Routes a server event (wire JSON shape) through the session's own event router. */
	receive(event: Record<string, unknown>): void;
}

/** The fields push to talk reads from a realtime server event (JSON from the session socket). */
interface ServerEvent {
	type?: unknown;
	session?: unknown;
}

type ServerTurns = "pending" | "manual" | "vad";

/** `global-key` comes from the keys service; the others need Grok Bot focused. */
type PressSource = "key" | "global-key" | "pointer" | "button-key";

interface Turn {
	startedAt: number;
	/** Microphone samples sent to the server during this turn. */
	samples: number;
	/** When the last press was released; `null` while held. */
	releasedAt: number | null;
	/** Press-to-release duration, set on release. */
	heldMs: number;
	/** Fallback end of the release tail (`window.setTimeout` handle); frames end it sooner when timers are throttled. */
	tail: number | null;
	/** The modifier key was held together with another key: a shortcut, so the turn is not answered. */
	shortcut: boolean;
}

interface Call {
	session: SessionAdapter;
	/** The setting when the call started; fixed for the call so client and server agree on turns. */
	pushToTalk: boolean;
	/** Turn mode the server confirmed in `session.updated`. */
	serverTurns: ServerTurns;
	responseInFlight: boolean;
	turn: Turn | null;
	/** A `response.create` waiting for the interrupted reply to finish cancelling (`window.setTimeout` handle). */
	owedResponse: number | null;
}

interface Snapshot {
	/** A push-to-talk call is live and the server runs manual turns. */
	available: boolean;
	talking: boolean;
}

interface PointerLike {
	button: number;
	pointerId: number;
	currentTarget: EventTarget | null;
}

interface KeyLike {
	key: string;
	preventDefault(): void;
}

interface RangeEventLike {
	currentTarget: EventTarget | null;
}

const ENABLED_KEY = "enabled";
const BINDING_KEY = "key";
const DEFAULT_BINDING = "AltRight";
const GROK_LEVEL_KEY = "musicWhileGrokTalks";
const USER_LEVEL_KEY = "musicWhileUserTalks";
/** Music volume (percent of the players' own volume) while Grok speaks and while the user holds the key. */
const DEFAULT_GROK_PERCENT = 20;
const DEFAULT_USER_PERCENT = 0;
/** Grok's playback drains between sentences; the music stays down this long so it doesn't pump. */
const PLAYBACK_HANG_MS = 700;
/**
 * Once a reply is on its way (the caller's turn ended, or the server created a response), the
 * music goes down ahead of Grok's first word: lowering a player takes ~150 ms plus its own output
 * buffer. Upper bound on that wait when no audio or `response.done` follows.
 */
const REPLY_WAIT_MS = 8000;
/** A music level slider saves this long after its last change (or at once when released). */
const LEVEL_COMMIT_MS = 300;
/** The audio processor delivers ~85 ms buffers; keep sending this long after release so the last word lands. */
const RELEASE_TAIL_MS = 150;
/** Shorter holds only interrupt Grok; their audio is discarded instead of answered. */
const MIN_HOLD_MS = 200;
/** Upper bound on waiting for a cancelled reply to end before asking for the next one anyway. */
const OWED_RESPONSE_TIMEOUT_MS = 3000;

const ROW_LABEL = "Push to talk";
const KEY_ROW_LABEL = "Push-to-talk key";
const BACKGROUND_ROW_LABEL = "Background key";
const GROK_LEVEL_ROW_LABEL = "Music while Grok talks";
const USER_LEVEL_ROW_LABEL = "Music while I talk";
const INSTALL_BUTTON_LABEL = "Install key helper";

const OS_NAMES: Record<Platform, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
const MODIFIER_NAMES: Record<Platform, Record<string, string>> = {
	darwin: { Alt: "Option", Meta: "Command", Control: "Control", Shift: "Shift" },
	win32: { Alt: "Alt", Meta: "Windows", Control: "Control", Shift: "Shift" },
	linux: { Alt: "Alt", Meta: "Super", Control: "Control", Shift: "Shift" },
};
/** macOS names that differ from {@link KEY_NAMES}. */
const MAC_KEY_NAMES: Record<string, string> = {
	Enter: "Return",
	Backspace: "Delete",
	Delete: "Forward Delete",
};
const KEY_NAMES: Record<string, string> = {
	Space: "Space",
	Enter: "Enter",
	Tab: "Tab",
	Backspace: "Backspace",
	Delete: "Delete",
	CapsLock: "Caps Lock",
	ContextMenu: "Menu",
	Backquote: "`",
	Minus: "-",
	Equal: "=",
	BracketLeft: "[",
	BracketRight: "]",
	Backslash: "\\",
	IntlBackslash: "§",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Slash: "/",
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	PageUp: "Page Up",
	PageDown: "Page Down",
};
/** The players the native helper (macOS, Windows) or the agent (Linux) lowers, as the subject of the slider descriptions. */
const MUSIC_PLAYERS: Record<Platform, string> = {
	darwin: "Spotify and Music play",
	win32: "Spotify, Apple Music and iTunes play",
	linux: "Spotify plays",
};
/** `<input>` types that never take typed text. */
const NON_TEXT_INPUTS: Record<string, true> = {
	button: true,
	checkbox: true,
	color: true,
	file: true,
	image: true,
	radio: true,
	range: true,
	reset: true,
	submit: true,
};
/** Keys Chromium sends no DOM key events for; only the key helper sees them. */
const DOM_BLIND_KEYS: Record<string, true> = { Fn: true };

function isSessionAdapter(value: unknown): value is SessionAdapter {
	return (
		typeof value === "object" &&
		value !== null &&
		"socket" in value &&
		value.socket instanceof WebSocket &&
		"receive" in value &&
		typeof value.receive === "function"
	);
}

/** Display name for a `KeyboardEvent.code` on `platform`. */
export function describeKey(code: string, platform: Platform): string {
	const modifier = /^(Alt|Meta|Control|Shift)(Left|Right)$/.exec(code);
	if (modifier !== null) return `${modifier[2]} ${MODIFIER_NAMES[platform][modifier[1] ?? ""] ?? modifier[1]}`;
	const named = (platform === "darwin" ? MAC_KEY_NAMES[code] : undefined) ?? KEY_NAMES[code];
	if (named !== undefined) return named;
	const short = /^(?:Key|Digit)(\w)$/.exec(code);
	if (short !== null) return short[1] ?? code;
	const numpad = /^Numpad(\w+)$/.exec(code);
	if (numpad !== null) return `Numpad ${numpad[1]}`;
	return code;
}

/**
 * Why `code` works only while Grok Bot is focused, or `null` when it can be held in the
 * background on `platform`: the bridge carries only modifier, function, lock and media keys
 * (`WATCHABLE_CODES`), and each OS helper watches its own subset of them (`HELPER_CODES`).
 */
export function focusedOnlyReason(code: string, platform: Platform): string | null {
	if (!WATCHABLE_CODES.has(code)) {
		return "Works while Grok Bot is focused; holding it in the background needs a modifier, function or lock key";
	}
	if (!HELPER_CODES[platform].includes(code)) {
		return `Works while Grok Bot is focused; this key can't be watched in the background on ${OS_NAMES[platform]}`;
	}
	return null;
}

/** A printable key typed into a text field: it belongs to the field, not to push to talk. */
function typesText(event: KeyboardEvent): boolean {
	if (event.key.length !== 1) return false;
	const target = event.target;
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
	return target instanceof HTMLInputElement && NON_TEXT_INPUTS[target.type] !== true;
}

/** A stored music level: a whole percentage 0–100, else `fallback`. */
export function parsePercent(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : fallback;
}

export interface DuckInputs {
	/** The user holds push to talk in a live push-to-talk call, or server VAD hears them speaking. */
	userTalking: boolean;
	userPercent: number;
	/** Grok's reply is on its way or playing (including the hang time after it drains). */
	grokTalking: boolean;
	grokPercent: number;
}

/**
 * The music level to ask the `media` service for, as a fraction of the players' own volume: the
 * lowest slider among the active situations; `1` leaves the music alone.
 */
export function duckLevel(inputs: DuckInputs): number {
	let percent = 100;
	if (inputs.userTalking) percent = Math.min(percent, inputs.userPercent);
	if (inputs.grokTalking) percent = Math.min(percent, inputs.grokPercent);
	return percent / 100;
}

/** What the voice call speaker did with Grok's voice (patches `voice-playback-schedule` and `voice-playback-drop`). */
export type PlaybackEvent = "scheduled" | "drained" | "dropped";

export interface PlaybackTracker {
	/** Grok's voice is audible, or drained less than the hang time ago. */
	readonly playing: boolean;
	update(player: object, event: PlaybackEvent): void;
	/** Forgets all playback at once (the call ended). */
	reset(): void;
}

/**
 * Follows the call speaker(s): playing from the moment a buffer is queued (it starts within
 * milliseconds, and the music should already be going down) until the last one finishes plus
 * `hangMs`, so pauses between sentences don't count as the end. A drop (the caller interrupted,
 * the call tore down) ends it at once. `onChange` fires when `playing` flips.
 */
export function createPlaybackTracker(hangMs: number, onChange: () => void): PlaybackTracker {
	const audible = new Set<object>();
	let hang: number | null = null;
	let playing = false;
	const settle = (): void => {
		const next = audible.size > 0 || hang !== null;
		if (next === playing) return;
		playing = next;
		onChange();
	};
	const clearHang = (): void => {
		if (hang === null) return;
		clearTimeout(hang);
		hang = null;
	};
	return {
		get playing() {
			return playing;
		},
		update(player, event) {
			if (event === "scheduled") {
				audible.add(player);
				clearHang();
				settle();
				return;
			}
			const wasAudible = audible.delete(player);
			if (audible.size === 0) {
				clearHang();
				if (event === "drained" && wasAudible) {
					hang = window.setTimeout(() => {
						hang = null;
						settle();
					}, hangMs);
				}
			}
			settle();
		},
		reset() {
			audible.clear();
			clearHang();
			settle();
		},
	};
}

export function createPushToTalk(ctx: PluginContext) {
	const platform = ctx.manifest.platform;
	const { keys, media } = ctx.services;
	let call: Call | null = null;
	const sources = new Set<PressSource>();
	let snapshot: Snapshot = { available: false, talking: false };
	const snapshotListeners = new Set<() => void>();
	/** The settings key recorder owns the keyboard. */
	let recordingBinding = false;
	/** While the recorder is open: binds a DOM-blind key the keys service reported. */
	let recordBackgroundKey: ((code: string) => void) | null = null;
	/** Key-up of the key just recorded, swallowed so it cannot activate the focused control. */
	let swallowKeyUp: string | null = null;
	/** The key watched through the keys service, and how to stop watching it. */
	let watched: { code: string; stop: () => void } | null = null;
	/** Level last passed to `media.duck`; `1` while the music is left alone. */
	let sentDuck = 1;
	/** A reply is expected or being generated (`window.setTimeout` handle of its `REPLY_WAIT_MS` bound). */
	let replyWait: number | null = null;
	/** Server VAD (a call without push to talk) hears the caller speaking. */
	let serverHearsUser = false;

	const readEnabled = (): boolean => ctx.storage.get<unknown>(ENABLED_KEY, true) !== false;
	const readGrokPercent = (): number => parsePercent(ctx.storage.get<unknown>(GROK_LEVEL_KEY, null), DEFAULT_GROK_PERCENT);
	const readUserPercent = (): number => parsePercent(ctx.storage.get<unknown>(USER_LEVEL_KEY, null), DEFAULT_USER_PERCENT);
	const readBinding = (): string => {
		const stored = ctx.storage.get<unknown>(BINDING_KEY, DEFAULT_BINDING);
		return typeof stored === "string" && stored !== "" ? stored : DEFAULT_BINDING;
	};

	const socketIsOpen = (target: Call): boolean => target.session.socket.readyState === WebSocket.OPEN;
	const canTalk = (): boolean => call !== null && call.pushToTalk && call.serverTurns === "manual" && socketIsOpen(call);

	/** Tells the media service how far to lower the music; sends only changes (it resends after reconnects). */
	const syncDuck = (): void => {
		const level = duckLevel({
			userTalking: snapshot.talking || serverHearsUser,
			userPercent: readUserPercent(),
			grokTalking: replyWait !== null || playback.playing,
			grokPercent: readGrokPercent(),
		});
		if (level === sentDuck) return;
		sentDuck = level;
		media.duck(level);
	};
	const playback = createPlaybackTracker(PLAYBACK_HANG_MS, syncDuck);

	/** A reply is coming: lower the music now so it is down before Grok's first word plays. */
	const expectReply = (): void => {
		clearTimeout(replyWait ?? undefined);
		replyWait = window.setTimeout(() => {
			replyWait = null;
			syncDuck();
		}, REPLY_WAIT_MS);
		syncDuck();
	};

	/** No reply pending any more; playback (and its hang time) keeps the music down while audible. */
	const settleReply = (): void => {
		if (replyWait === null) return;
		clearTimeout(replyWait);
		replyWait = null;
		syncDuck();
	};

	const publish = (): void => {
		const available = canTalk();
		const talking = available && sources.size > 0 && call?.turn != null;
		const changed = available !== snapshot.available || talking !== snapshot.talking;
		if (changed) snapshot = { available, talking };
		syncDuck();
		syncWatch();
		if (!changed) return;
		for (const listener of [...snapshotListeners]) listener();
	};

	const send = (target: Call, frame: Record<string, unknown>): void => {
		if (socketIsOpen(target)) target.session.socket.send(JSON.stringify(frame));
	};

	const settleOwedResponse = (target: Call, sendIt: boolean): void => {
		if (target.owedResponse === null) return;
		clearTimeout(target.owedResponse);
		target.owedResponse = null;
		if (sendIt) send(target, { type: "response.create" });
	};

	const requestResponse = (target: Call): void => {
		if (!target.responseInFlight) {
			send(target, { type: "response.create" });
			return;
		}
		// The interrupted reply is still cancelling; the server rejects a second response meanwhile.
		settleOwedResponse(target, false);
		target.owedResponse = window.setTimeout(() => {
			target.owedResponse = null;
			send(target, { type: "response.create" });
		}, OWED_RESPONSE_TIMEOUT_MS);
	};

	const startTurn = (target: Call): void => {
		// This turn's reply also answers an earlier commit still waiting for its response.
		settleOwedResponse(target, false);
		if (target.responseInFlight) send(target, { type: "response.cancel" });
		target.turn = { startedAt: performance.now(), samples: 0, releasedAt: null, heldMs: 0, tail: null, shortcut: false };
		target.session.receive({ type: "input_audio_buffer.speech_started" });
	};

	const endTurn = (target: Call): void => {
		const turn = target.turn;
		if (turn === null) return;
		clearTimeout(turn.tail ?? undefined);
		target.turn = null;
		const answered = turn.samples > 0 && turn.heldMs >= MIN_HOLD_MS && !turn.shortcut;
		if (turn.samples > 0) {
			if (answered) {
				send(target, { type: "input_audio_buffer.commit" });
				requestResponse(target);
			} else {
				send(target, { type: "input_audio_buffer.clear" });
			}
		}
		// The release already lowered the music for the reply; a discarded turn gets none.
		if (!answered) settleReply();
		target.session.receive({ type: "input_audio_buffer.speech_stopped" });
	};

	/** Drops the current turn without sending anything (call ended or left manual turns). */
	const abandonTurn = (target: Call): void => {
		const turn = target.turn;
		if (turn === null) return;
		clearTimeout(turn.tail ?? undefined);
		target.turn = null;
		if (socketIsOpen(target)) target.session.receive({ type: "input_audio_buffer.speech_stopped" });
	};

	const press = (source: PressSource): void => {
		if (sources.has(source) || call === null || !canTalk()) return;
		sources.add(source);
		const turn = call.turn;
		if (turn === null) {
			startTurn(call);
		} else if (turn.releasedAt !== null) {
			// Pressed again before the release tail ran out: the same turn continues.
			clearTimeout(turn.tail ?? undefined);
			turn.releasedAt = null;
			turn.tail = null;
		}
		publish();
	};

	const release = (source: PressSource): void => {
		if (!sources.delete(source) || sources.size > 0) return;
		const target = call;
		const turn = target?.turn;
		if (target != null && turn != null && turn.releasedAt === null) {
			turn.releasedAt = performance.now();
			turn.heldMs = turn.releasedAt - turn.startedAt;
			turn.tail = window.setTimeout(() => {
				if (target.turn !== turn) return;
				endTurn(target);
				publish();
			}, RELEASE_TAIL_MS);
			// Go straight from the "while I talk" level to the "while Grok talks" level.
			if (turn.heldMs >= MIN_HOLD_MS && !turn.shortcut) expectReply();
		}
		publish();
	};

	const releaseAll = (): void => {
		for (const source of [...sources]) release(source);
	};

	/** Releases the presses that need Grok Bot focused: their key-up never arrives once it loses focus. */
	const releaseFocused = (): void => {
		for (const source of [...sources]) if (source !== "global-key") release(source);
	};

	/** A report from the keys service; `false` also arrives when the bridge or helper drops while the key is down. */
	const onBackgroundKey = (code: string, down: boolean): void => {
		if (watched?.code !== code) return;
		if (!down) release("global-key");
		else if (recordBackgroundKey !== null) recordBackgroundKey(code);
		// While focused, DOM key events drive push to talk (and leave typed text alone), except
		// for keys the DOM never sees.
		else if (!document.hasFocus() || DOM_BLIND_KEYS[code] === true) press("global-key");
	};

	/**
	 * Watches one key through the keys service: Fn while recording on macOS (the DOM never sees it),
	 * the binding while a push-to-talk call is live and the helper can watch it, else none.
	 */
	const syncWatch = (): void => {
		let code: string | null = null;
		if (recordingBinding) {
			if (platform === "darwin") code = "Fn";
		} else if (canTalk()) {
			const binding = readBinding();
			if (focusedOnlyReason(binding, platform) === null) code = binding;
		}
		if (code === (watched?.code ?? null)) return;
		const previous = watched;
		watched = null;
		previous?.stop();
		if (code === null) return;
		const next = code;
		watched = { code: next, stop: keys.watch(next, (down) => onBackgroundKey(next, down)) };
	};

	keys.onChord((code) => {
		const turn = call?.turn;
		if (code !== watched?.code || !MODIFIER_KEY_CODES.has(code) || turn == null || turn.releasedAt !== null || turn.shortcut) return;
		turn.shortcut = true;
		ctx.log.info(`${describeKey(code, platform)} was used in a shortcut; this turn won't be answered`);
	});

	const detach = (target: Call): void => {
		if (call !== target) return;
		abandonTurn(target);
		settleOwedResponse(target, false);
		call = null;
		sources.clear();
		playback.reset();
		settleReply();
		serverHearsUser = false;
		publish();
	};

	const noteServerTurns = (target: Call, session: unknown): void => {
		const detection =
			typeof session === "object" && session !== null && "turn_detection" in session ? session.turn_detection : undefined;
		// Manual turns echo back as `{type: null}` (or no detection at all); anything named is server VAD.
		const next: ServerTurns =
			typeof detection === "object" && detection !== null && "type" in detection && typeof detection.type === "string"
				? "vad"
				: "manual";
		if (next === target.serverTurns) return;
		target.serverTurns = next;
		if (next === "manual") {
			ctx.log.info(`push to talk is live for this call: hold ${describeKey(readBinding(), platform)} to talk`);
		} else {
			ctx.log.warn(`the server kept turn detection ${JSON.stringify(detection)}; push to talk is off for this call`);
			abandonTurn(target);
			sources.clear();
		}
		publish();
	};

	const onServerMessage = (target: Call, event: MessageEvent): void => {
		if (call !== target || typeof event.data !== "string") return;
		let message: unknown;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}
		if (typeof message !== "object" || message === null) return;
		const { type, session } = message as ServerEvent;
		switch (type) {
			case "input_audio_buffer.speech_started":
				serverHearsUser = true;
				syncDuck();
				return;
			case "input_audio_buffer.speech_stopped":
				// Server VAD ended the caller's turn; its reply follows.
				serverHearsUser = false;
				expectReply();
				return;
			case "response.created":
				target.responseInFlight = true;
				// Someone else's reply now covers the committed turn.
				settleOwedResponse(target, false);
				// The caller holds the floor; server VAD would never start a reply over them.
				if (target.turn !== null) send(target, { type: "response.cancel" });
				expectReply();
				return;
			case "response.done":
				target.responseInFlight = false;
				settleOwedResponse(target, true);
				settleReply();
				return;
			case "response.cancelled":
				target.responseInFlight = false;
				settleOwedResponse(target, true);
				// An interruption: the music comes back now, without the hang time.
				settleReply();
				playback.reset();
				return;
			case "session.updated":
				if (target.pushToTalk) noteServerTurns(target, session);
				return;
		}
	};

	/** Patch `realtime-session`: every voice call session (including reconnects) registers here. */
	const attachSession = (candidate: unknown): void => {
		if (call !== null) detach(call);
		if (!isSessionAdapter(candidate)) {
			ctx.log.error("attachSession expects { socket: WebSocket, receive(event) }; push to talk is off for this call");
			return;
		}
		const target: Call = {
			session: candidate,
			pushToTalk: readEnabled(),
			serverTurns: "pending",
			responseInFlight: false,
			turn: null,
			owedResponse: null,
		};
		call = target;
		candidate.socket.addEventListener("message", (event) => onServerMessage(target, event));
		candidate.socket.addEventListener("close", () => detach(target));
		ctx.log.info(target.pushToTalk ? "voice call with push to talk; requesting manual turns" : "voice call without push to talk");
		publish();
	};

	/** Patch `realtime-turn-detection`: replaces `{type:"server_vad"}` in `session.update`. */
	const turnDetection = (): { type: null } | undefined => (call?.pushToTalk === true ? { type: null } : undefined);

	/** Patch `realtime-mic-gate`: `true` keeps a microphone frame off the wire. */
	const holdsFrame = (frame: unknown): boolean => {
		const target = call;
		if (target === null || !target.pushToTalk || target.serverTurns === "vad") return false;
		const turn = target.turn;
		if (turn === null) return true;
		if (turn.releasedAt !== null && performance.now() - turn.releasedAt >= RELEASE_TAIL_MS) {
			// This frame is all post-release audio. Ending here beats the tail timer, which Chromium
			// throttles while Grok Bot is hidden.
			endTurn(target);
			publish();
			return true;
		}
		if (frame instanceof Float32Array) turn.samples += frame.length;
		return false;
	};

	/**
	 * Patches `voice-playback-schedule` and `voice-playback-drop`: the call speaker (`player`) queued
	 * a buffer of Grok's voice, played its last buffer to the end, or cut playback off.
	 */
	const voicePlayback = (event: unknown, player: unknown): void => {
		if (typeof player !== "object" || player === null) return;
		if (event === "scheduled" || event === "drained" || event === "dropped") playback.update(player, event);
	};

	window.addEventListener(
		"keydown",
		(event) => {
			if (recordingBinding || event.isComposing || event.code !== readBinding() || !canTalk()) return;
			if (!sources.has("key") && typesText(event)) return;
			event.preventDefault();
			event.stopPropagation();
			press("key");
		},
		true,
	);
	window.addEventListener(
		"keyup",
		(event) => {
			if (swallowKeyUp !== null && event.code === swallowKeyUp) {
				swallowKeyUp = null;
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (event.code !== readBinding() || !sources.has("key")) return;
			event.preventDefault();
			event.stopPropagation();
			release("key");
		},
		true,
	);
	window.addEventListener("blur", releaseFocused);
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) releaseFocused();
	});
	ctx.storage.subscribe(BINDING_KEY, () => {
		release("key");
		release("global-key");
		syncWatch();
	});
	for (const key of [GROK_LEVEL_KEY, USER_LEVEL_KEY]) ctx.storage.subscribe(key, syncDuck);

	const subscribeSnapshot = (listener: () => void): (() => void) => {
		snapshotListeners.add(listener);
		return () => {
			snapshotListeners.delete(listener);
		};
	};
	const getSnapshot = (): Snapshot => snapshot;
	const subscribeEnabled = (listener: () => void): (() => void) => ctx.storage.subscribe(ENABLED_KEY, listener);
	const subscribeBinding = (listener: () => void): (() => void) => ctx.storage.subscribe(BINDING_KEY, listener);
	const subscribeGrokPercent = (listener: () => void): (() => void) => ctx.storage.subscribe(GROK_LEVEL_KEY, listener);
	const subscribeUserPercent = (listener: () => void): (() => void) => ctx.storage.subscribe(USER_LEVEL_KEY, listener);
	const subscribeKeys = (listener: () => void): (() => void) => keys.subscribe(listener);
	const readKeysState = (): KeysState => keys.state;
	const readKeysDetail = (): string | undefined => keys.detail;
	const subscribeMedia = (listener: () => void): (() => void) => media.subscribe(listener);
	const readMediaState = (): MediaState => media.state;
	const readMediaDetail = (): string | undefined => media.detail;

	/** Slider row description: what the slider does, or why ducking is unavailable. */
	const duckDescription = (state: MediaState, detail: string | undefined, situation: string): string => {
		switch (state) {
			case "ready":
				return `${MUSIC_PLAYERS[platform]} at this volume ${situation}. 100% leaves the volume alone.`;
			case "needs-install":
				return "Needs the key helper: install it in the Background key row below.";
			case "unsupported":
				return `Not available on this computer${detail ? `: ${detail}` : "."}`;
			case "error":
				return `The helper isn't working${detail ? `: ${detail}` : "."}`;
		}
	};

	/** Background key row description for the keys service state and the current binding. */
	const backgroundDescription = (state: KeysState, detail: string | undefined, binding: string): string => {
		switch (state) {
			case "unsupported":
				return `Not available on this computer${detail ? ` (${detail})` : ""}; the key works while Grok Bot is focused.`;
			case "needs-install":
				return "Off. Install the key helper to hold the key while Grok Bot is in the background.";
			case "installing":
				return "Installing the key helper…";
			case "starting":
				return "Starting the key helper…";
			case "needs-permission":
				return "Allow Better Grok Bot Helper in System Settings → Privacy & Security → Input Monitoring.";
			case "error":
				return `The key helper isn't working${detail ? `: ${detail}` : "."}`;
			case "ready":
				return focusedOnlyReason(binding, platform) === null
					? `On: ${describeKey(binding, platform)} works while Grok Bot is in the background.`
					: `On, but ${describeKey(binding, platform)} can't be watched in the background; pick another key.`;
		}
	};

	/** Hold-to-talk button in the voice call controls; also shows when a turn is live. */
	const CallButton: ComponentFactory = (deps) => {
		const { React, jsx, Tooltip, IconButton, pressedStyle } = deps;
		if (Tooltip === undefined || IconButton === undefined) {
			throw new TypeError("CallButton needs the call controls' Tooltip and IconButton components");
		}
		const handlers = {
			onPointerDown: (event: PointerLike): void => {
				if (event.button !== 0) return;
				if (event.currentTarget instanceof Element) event.currentTarget.setPointerCapture(event.pointerId);
				press("pointer");
			},
			onPointerUp: (): void => release("pointer"),
			onPointerCancel: (): void => release("pointer"),
			onLostPointerCapture: (): void => release("pointer"),
			onKeyDown: (event: KeyLike): void => {
				if (event.key !== " " && event.key !== "Enter") return;
				event.preventDefault();
				press("button-key");
			},
			onKeyUp: (event: KeyLike): void => {
				if (event.key !== " " && event.key !== "Enter") return;
				event.preventDefault();
				release("button-key");
			},
			onBlur: (): void => release("button-key"),
		};
		return function PushToTalkButton() {
			const state = React.useSyncExternalStore(subscribeSnapshot, getSnapshot);
			const binding = React.useSyncExternalStore(subscribeBinding, readBinding);
			if (!state.available) return null;
			const label = `Hold ${describeKey(binding, platform)} to talk`;
			return jsx(Tooltip, {
				content: label,
				children: jsx(IconButton, {
					...handlers,
					"aria-label": label,
					"aria-pressed": state.talking,
					"data-push-to-talk": state.talking ? "talking" : "idle",
					icon: "waveform",
					shape: "circle",
					size: "lg",
					style: state.talking && pressedStyle,
					variant: "secondary",
				}),
			});
		};
	};

	/** Settings → General → System rows: the on/off switch, the key recorder, the music levels, and the background key status. */
	const SettingsRows: ComponentFactory = (deps) => {
		const { React, jsx, Row, Toggle, Button, buttonTextStyle } = deps;
		if (Row === undefined || Toggle === undefined || Button === undefined) {
			throw new TypeError("SettingsRows needs the settings Row, Toggle, and Button components");
		}
		const onToggle = (next: unknown): void => {
			if (typeof next === "boolean") ctx.storage.set(ENABLED_KEY, next);
		};
		/** A 0–100% music level slider and its value; saves on release, or shortly after the last change. */
		const levelSlider = (label: string, key: string, read: () => number, subscribe: (listener: () => void) => () => void) => {
			const commit = (percent: number): void => {
				if (percent !== read()) ctx.storage.set(key, percent);
			};
			return function MusicLevelSlider(props: Record<string, unknown>) {
				const disabled = props.disabled === true;
				const stored = React.useSyncExternalStore(subscribe, read);
				const [draft, setDraft] = React.useState<number | null>(null);
				React.useEffect(() => {
					if (draft === null) return;
					const timer = window.setTimeout(() => {
						commit(draft);
						setDraft(null);
					}, LEVEL_COMMIT_MS);
					return () => clearTimeout(timer);
				}, [draft]);
				const percent = draft ?? stored;
				const onChange = (event: RangeEventLike): void => {
					if (event.currentTarget instanceof HTMLInputElement) setDraft(parsePercent(event.currentTarget.valueAsNumber, stored));
				};
				const onRelease = (event: RangeEventLike): void => {
					if (!(event.currentTarget instanceof HTMLInputElement)) return;
					commit(parsePercent(event.currentTarget.valueAsNumber, stored));
					setDraft(null);
				};
				return jsx("div", {
					style: { display: "flex", alignItems: "center", gap: 8 },
					children: [
						jsx(
							"input",
							{
								"aria-label": label,
								"aria-valuetext": `${percent}%`,
								disabled,
								max: 100,
								min: 0,
								onBlur: onRelease,
								onChange,
								onKeyUp: onRelease,
								onPointerUp: onRelease,
								step: 5,
								style: {
									width: 140,
									margin: 0,
									accentColor: "var(--cursor-text-primary)",
									cursor: disabled ? "default" : "pointer",
									opacity: disabled ? 0.5 : 1,
								},
								type: "range",
								value: percent,
							},
							"slider",
						),
						jsx(
							"span",
							{
								style: {
									minWidth: "4ch",
									textAlign: "right",
									fontVariantNumeric: "tabular-nums",
									color: "var(--cursor-text-secondary)",
								},
								children: `${percent}%`,
							},
							"value",
						),
					],
				});
			};
		};
		const GrokLevelSlider = levelSlider(GROK_LEVEL_ROW_LABEL, GROK_LEVEL_KEY, readGrokPercent, subscribeGrokPercent);
		const UserLevelSlider = levelSlider(USER_LEVEL_ROW_LABEL, USER_LEVEL_KEY, readUserPercent, subscribeUserPercent);
		return function PushToTalkSettings() {
			const enabled = React.useSyncExternalStore(subscribeEnabled, readEnabled);
			const binding = React.useSyncExternalStore(subscribeBinding, readBinding);
			const [recording, setRecording] = React.useState(false);
			const [installError, setInstallError] = React.useState<string | null>(null);
			const keysState = React.useSyncExternalStore(subscribeKeys, readKeysState);
			const keysDetail = React.useSyncExternalStore(subscribeKeys, readKeysDetail);
			const mediaState = React.useSyncExternalStore(subscribeMedia, readMediaState);
			const mediaDetail = React.useSyncExternalStore(subscribeMedia, readMediaDetail);
			const duckSupported = mediaState === "ready";
			const focusedOnly = focusedOnlyReason(binding, platform);
			React.useEffect(() => {
				if (!recording) return;
				recordingBinding = true;
				releaseAll();
				const bind = (code: string): void => {
					ctx.storage.set(BINDING_KEY, code);
					ctx.log.info(`push-to-talk key is now ${describeKey(code, platform)} (${code})`);
					setRecording(false);
				};
				const onKey = (event: KeyboardEvent): void => {
					event.preventDefault();
					event.stopPropagation();
					if (event.repeat) return;
					if (event.code !== "" && event.code !== "Escape") {
						swallowKeyUp = event.code;
						bind(event.code);
					} else {
						setRecording(false);
					}
				};
				const cancel = (): void => setRecording(false);
				recordBackgroundKey = bind;
				syncWatch();
				window.addEventListener("keydown", onKey, true);
				window.addEventListener("blur", cancel);
				return () => {
					recordingBinding = false;
					recordBackgroundKey = null;
					syncWatch();
					window.removeEventListener("keydown", onKey, true);
					window.removeEventListener("blur", cancel);
				};
			}, [recording]);
			const installHelper = (): void => {
				setInstallError(null);
				keys.install().catch((error: unknown) => {
					ctx.log.error("could not install the key helper:", error);
					setInstallError(error instanceof Error ? error.message : String(error));
				});
			};
			return [
				jsx(
					Row,
					{
						label: ROW_LABEL,
						description: "Hold a key to talk in voice calls; Grok answers as soon as you let go. Applies from your next call.",
						variant: "card",
						children: jsx(Toggle, { isChecked: enabled, label: ROW_LABEL, onToggle, size: "md" }),
					},
					"enabled",
				),
				jsx(
					Row,
					{
						label: KEY_ROW_LABEL,
						description: recording
							? `Press the key to hold while you talk. Esc cancels.${
									platform === "darwin" && keysState !== "ready" ? " Fn needs the key helper below." : ""
								}`
							: focusedOnly !== null
								? `${focusedOnly}. Click to change.`
								: DOM_BLIND_KEYS[binding] === true && keysState !== "ready"
									? `${describeKey(binding, platform)} only works through the key helper below.`
									: "Hold it while you talk, or hold the waveform button in a call. Click to change.",
						variant: "card",
						children: jsx(Button, {
							"aria-label": `${KEY_ROW_LABEL}: ${describeKey(binding, platform)}`,
							onClick: () => setRecording((previous) => !previous),
							size: "md",
							style: buttonTextStyle,
							type: "button",
							variant: "secondary",
							children: recording ? "Press a key…" : describeKey(binding, platform),
						}),
					},
					"key",
				),
				jsx(
					Row,
					{
						label: GROK_LEVEL_ROW_LABEL,
						description: duckDescription(mediaState, mediaDetail, "while Grok is speaking in a voice call"),
						variant: "card",
						children: jsx(GrokLevelSlider, { disabled: !duckSupported }),
					},
					"grok-level",
				),
				jsx(
					Row,
					{
						label: USER_LEVEL_ROW_LABEL,
						description: duckDescription(
							mediaState,
							mediaDetail,
							"while you talk (holding the push-to-talk key, or speaking in a call without it)",
						),
						variant: "card",
						children: jsx(UserLevelSlider, { disabled: !duckSupported }),
					},
					"user-level",
				),
				jsx(
					Row,
					{
						label: BACKGROUND_ROW_LABEL,
						description:
							installError !== null && keysState === "needs-install"
								? `Couldn't install the key helper: ${installError}`
								: backgroundDescription(keysState, keysDetail, binding),
						variant: "card",
						...(keysState === "needs-install"
							? {
									children: jsx(Button, {
										onClick: installHelper,
										size: "md",
										style: buttonTextStyle,
										type: "button",
										variant: "secondary",
										children: INSTALL_BUTTON_LABEL,
									}),
								}
							: {}),
					},
					"background",
				),
			];
		};
	};

	return { turnDetection, attachSession, holdsFrame, voicePlayback, CallButton, SettingsRows };
}

globalThis.BetterGrokBot?.define("push-to-talk", createPushToTalk);
