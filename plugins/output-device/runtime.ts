/**
 * Routes voice-mode audio to the speaker chosen in Settings → General → Speaker.
 *
 * Patched app code creates its voice AudioContexts through `createAudioContext`
 * and registers the voice-preview `<audio>` element through
 * `trackMediaElement`; every tracked sink follows the stored preference live.
 */
import type { ComponentFactory, PluginContext } from "@better-grok-bot/sdk";

interface OutputDevice {
	deviceId: string;
	label: string;
}

interface SelectOption {
	value: string;
	label: string;
}

/** Chromium's AudioContext output selection, missing from TypeScript's DOM lib. */
interface SinkSelectableContext extends AudioContext {
	readonly sinkId: string | { type: "none" };
	setSinkId(sinkId: string): Promise<void>;
}

type Sink = { kind: "context"; target: SinkSelectableContext } | { kind: "element"; target: HTMLMediaElement };

/** A sink following the preference, and the state of its one-at-a-time switching. */
interface TrackedSink {
	sink: Sink;
	purpose: string;
	/** The device this sink fell back from to the system default; the next preference or device-list change retries it. */
	abandoned: string | null;
	/** The running switch chain, settled once the sink plays through its latest target; `null` while idle. */
	switching: Promise<void> | null;
}

const PREFERENCE_KEY = "outputDeviceId";
const SYSTEM_DEFAULT_LABEL = "System Default";
const ROW_LABEL = "Speaker";

function isSinkSelectable(context: AudioContext): context is SinkSelectableContext {
	return "setSinkId" in context && typeof context.setSinkId === "function";
}

function describeSink(sink: Sink, purpose: string): string {
	return `${purpose} ${sink.kind === "context" ? "AudioContext" : "<audio>"}`;
}

/** The sink's current device id; `""` is the system default. */
function currentSinkId(sink: Sink): string {
	const sinkId = sink.target.sinkId;
	return typeof sinkId === "string" ? sinkId : "";
}

export function createOutputDevice(ctx: PluginContext) {
	const mediaDevices: MediaDevices | undefined = globalThis.navigator?.mediaDevices;
	/** Referentially stable until the device list actually changes (a `useSyncExternalStore` snapshot). */
	let devices: readonly OutputDevice[] = [];
	let devicesLoaded = false;
	let refreshGeneration = 0;
	const deviceListeners = new Set<() => void>();
	const sinks = new Map<Sink["target"], TrackedSink>();

	const readPreference = (): string | null => {
		const stored = ctx.storage.get<unknown>(PREFERENCE_KEY, null);
		return typeof stored === "string" && stored !== "" ? stored : null;
	};

	/** The device id sinks should use now: the preference while it is plugged in, else `null` (system default). */
	const desiredDeviceId = (): string | null => {
		const preferred = readPreference();
		if (preferred === null) return null;
		// Before the first enumeration resolves, trust the preference; a stale id falls back when applied.
		if (!devicesLoaded) return preferred;
		return devices.some((device) => device.deviceId === preferred) ? preferred : null;
	};

	/** Where the sink should play now: the desired device, unless this sink already fell back from it. */
	const targetFor = (tracked: TrackedSink): string => {
		const deviceId = desiredDeviceId() ?? "";
		return deviceId === tracked.abandoned ? "" : deviceId;
	};

	const switchSink = async (tracked: TrackedSink, deviceId: string): Promise<void> => {
		const { sink, purpose } = tracked;
		try {
			await sink.target.setSinkId(deviceId);
			ctx.log.info(`${describeSink(sink, purpose)} now plays through ${deviceId === "" ? "the system default" : `device ${deviceId}`}`);
		} catch (error) {
			if (deviceId === "") {
				ctx.log.error(`could not return ${describeSink(sink, purpose)} to the system default:`, error);
				return;
			}
			ctx.log.warn(`could not route ${describeSink(sink, purpose)} to device ${deviceId}; falling back to the system default:`, error);
			tracked.abandoned = deviceId;
		}
	};

	/**
	 * Switches the sink until it plays through its latest target. `setSinkId` calls on one sink never
	 * overlap: a choice made while a switch is in flight is picked up when that switch settles, since the
	 * settled switch has already moved the sink. A target is attempted at most once in a row, so a
	 * device (or the system default) that keeps failing ends the chain instead of looping.
	 */
	const reconcile = (tracked: TrackedSink): Promise<void> => {
		if (tracked.switching !== null) return tracked.switching;
		let settled = false;
		const chain = (async () => {
			try {
				let attempted: string | null = null;
				for (let target = targetFor(tracked); target !== attempted && currentSinkId(tracked.sink) !== target; target = targetFor(tracked)) {
					attempted = target;
					await switchSink(tracked, target);
				}
			} finally {
				settled = true;
				tracked.switching = null;
			}
		})();
		// A sink already on its target settles synchronously, leaving nothing in flight to track.
		if (!settled) tracked.switching = chain;
		return chain;
	};

	const applyTo = (tracked: TrackedSink): void => {
		tracked.abandoned = null;
		void reconcile(tracked);
	};

	const applyToAll = (): void => {
		for (const tracked of sinks.values()) applyTo(tracked);
	};

	const refreshDevices = async (): Promise<void> => {
		if (mediaDevices === undefined) return;
		const generation = ++refreshGeneration;
		let listed: MediaDeviceInfo[];
		try {
			listed = await mediaDevices.enumerateDevices();
		} catch (error) {
			ctx.log.warn("could not list audio output devices:", error);
			return;
		}
		if (generation !== refreshGeneration) return;
		const next = listed
			// `default` and `communications` alias the system default; choosing them is the same as choosing nothing.
			.filter(
				(device) =>
					device.kind === "audiooutput" &&
					device.deviceId !== "" &&
					device.deviceId !== "default" &&
					device.deviceId !== "communications",
			)
			.map((device) => ({ deviceId: device.deviceId, label: device.label }));
		const changed =
			!devicesLoaded ||
			devices.length !== next.length ||
			devices.some((device, index) => device.deviceId !== next[index]?.deviceId || device.label !== next[index]?.label);
		devicesLoaded = true;
		if (changed) {
			devices = next;
			for (const listener of [...deviceListeners]) listener();
		}
		applyToAll();
	};

	const track = (sink: Sink, purpose: string): TrackedSink => {
		const tracked: TrackedSink = { sink, purpose, abandoned: null, switching: null };
		sinks.set(sink.target, tracked);
		applyTo(tracked);
		return tracked;
	};

	mediaDevices?.addEventListener("devicechange", () => void refreshDevices());
	ctx.storage.subscribe(PREFERENCE_KEY, applyToAll);
	void refreshDevices();

	const subscribeDevices = (listener: () => void): (() => void) => {
		deviceListeners.add(listener);
		return () => deviceListeners.delete(listener);
	};
	const getDevices = (): readonly OutputDevice[] => devices;
	const subscribePreference = (listener: () => void): (() => void) => ctx.storage.subscribe(PREFERENCE_KEY, listener);

	/**
	 * Drop-in for `new AudioContext(options)`. Chromium 148 never throws for a
	 * constructor `sinkId` it cannot open (unknown or unplugged device): the
	 * context fires `error` (several times), quietly moves to the system default
	 * and suspends itself. The app never suspends its own contexts, so after an
	 * output error we pin the default and resume rendering.
	 */
	const createAudioContext = (options: AudioContextOptions = {}, purpose = "unknown"): AudioContext => {
		const deviceId = desiredDeviceId();
		let context: AudioContext;
		if (deviceId === null) {
			context = new AudioContext(options);
		} else {
			const withSink: AudioContextOptions & { sinkId: string } = { ...options, sinkId: deviceId };
			try {
				context = new AudioContext(withSink);
			} catch (error) {
				ctx.log.warn(`could not open ${purpose} AudioContext on device ${deviceId}; using the system default:`, error);
				context = new AudioContext(options);
			}
		}
		if (!isSinkSelectable(context)) {
			ctx.log.warn(`${purpose} AudioContext cannot select an output device in this Chromium; leaving it on the system default`);
			return context;
		}
		const sink: Sink = { kind: "context", target: context };
		const tracked = track(sink, purpose);
		let outputLost = false;
		context.addEventListener("error", () => {
			if (outputLost || context.state === "closed") return;
			outputLost = true;
			ctx.log.warn(`${purpose} AudioContext lost output device ${JSON.stringify(context.sinkId)}; falling back to the system default`);
			const lost = currentSinkId(sink);
			if (lost !== "") tracked.abandoned = lost;
			reconcile(tracked)
				.then(async () => {
					if (context.state === "suspended") await context.resume();
				})
				.catch((error: unknown) => ctx.log.error(`could not resume ${purpose} AudioContext after its output error:`, error));
		});
		context.addEventListener("statechange", () => {
			if (context.state === "closed") {
				sinks.delete(context);
			} else if (context.state === "running") {
				outputLost = false;
			} else if (outputLost) {
				context.resume().catch((error: unknown) => ctx.log.error(`could not resume ${purpose} AudioContext after its output error:`, error));
			}
		});
		return context;
	};

	/** Routes an app-owned `<audio>` element and keeps it following the preference for its lifetime. */
	const trackMediaElement = (element: unknown, purpose = "unknown"): void => {
		if (!(element instanceof HTMLMediaElement)) {
			ctx.log.warn(`trackMediaElement(${purpose}) expects an HTMLMediaElement; ignoring it`);
			return;
		}
		track({ kind: "element", target: element }, purpose);
	};

	const SpeakerRow: ComponentFactory = (deps) => {
		const { React, jsx, Row, Select, translate } = deps;
		if (Row === undefined || Select === undefined) throw new TypeError("SpeakerRow needs the settings Row and Select components");
		const onValueChange = (value: unknown): void => {
			if (typeof value !== "string") return;
			ctx.storage.set(PREFERENCE_KEY, value === "" ? null : value);
		};
		return function SpeakerRow() {
			const list = React.useSyncExternalStore(subscribeDevices, getDevices);
			const preferred = React.useSyncExternalStore(subscribePreference, readPreference);
			React.useEffect(() => void refreshDevices(), []);
			// The app's own "System Default" message (as on the Microphone row), so it follows the app language.
			const defaultLabel =
				typeof translate === "function" ? String(Reflect.apply(translate, undefined, [{ id: "9YHrNC" }])) : SYSTEM_DEFAULT_LABEL;
			const options = React.useMemo(
				(): SelectOption[] => [
					{ value: "", label: defaultLabel },
					...list.map((device, index) => ({ value: device.deviceId, label: device.label || `${ROW_LABEL} ${index + 1}` })),
				],
				[list, defaultLabel],
			);
			const value = preferred !== null && list.some((device) => device.deviceId === preferred) ? preferred : "";
			return jsx(Row, {
				label: ROW_LABEL,
				variant: "card",
				children: jsx(Select, {
					"aria-label": ROW_LABEL,
					onValueChange,
					options,
					placement: "bottom-end",
					size: "lg",
					value,
					variant: "ghost",
				}),
			});
		};
	};

	return { createAudioContext, trackMediaElement, SpeakerRow };
}

globalThis.BetterGrokBot?.define("output-device", createOutputDevice);
