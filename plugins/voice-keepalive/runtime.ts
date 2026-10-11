/**
 * Keeps voice calls up when the realtime line drops.
 *
 * The app already redials a dropped call (fresh credential, replayed turns, no
 * greeting or chime) but only when the `sand_voice_reconnect` gate is on.
 * Patched gate checks call `shouldReconnect`, which turns that path on while
 * the Keep-alive voice setting is on; the app's own exclusions (hang-ups,
 * close code 1008, microphone failures) still end the call.
 */
import type { ComponentFactory, PluginContext } from "@better-grok-bot/sdk";

/** Close info the app's voice-call store hands to its `onClosed` handler (fields vary by `reason`). */
interface VoiceLineClose {
	reason?: string;
	closeCode?: number | null;
	detail?: string | null;
	recoverable?: boolean;
}

const ENABLED_KEY = "enabled";
const ROW_LABEL = "Keep-alive voice";

function createVoiceKeepalive(ctx: PluginContext) {
	const readEnabled = (): boolean => ctx.storage.get<unknown>(ENABLED_KEY, true) !== false;

	/**
	 * Called with the close info from the store's `onClosed`, and with no arguments from `mayReconnect`.
	 * `undefined` leaves the decision to the app's own gate.
	 */
	const shouldReconnect = (close?: VoiceLineClose): true | undefined => {
		const enabled = readEnabled();
		if (close !== undefined) {
			ctx.log.info(
				`voice line closed: reason=${close.reason ?? "?"} code=${close.closeCode ?? "none"} detail=${JSON.stringify(close.detail ?? null)} recoverable=${close.recoverable ?? "?"} keepalive=${enabled ? "on" : "off"}`,
			);
		}
		return enabled ? true : undefined;
	};

	/** Settings → General → System: the on/off switch. */
	const SettingsRow: ComponentFactory = (deps) => {
		const { React, jsx, Row, Toggle } = deps;
		if (Row === undefined || Toggle === undefined) {
			throw new TypeError("SettingsRow needs the settings Row and Toggle components");
		}
		const subscribeEnabled = (listener: () => void): (() => void) => ctx.storage.subscribe(ENABLED_KEY, listener);
		const onToggle = (next: unknown): void => {
			if (typeof next === "boolean") ctx.storage.set(ENABLED_KEY, next);
		};
		return function KeepAliveVoiceSetting() {
			const enabled = React.useSyncExternalStore(subscribeEnabled, readEnabled);
			return jsx(Row, {
				label: ROW_LABEL,
				description:
					"Reconnect voice calls on their own when the line drops, including after about 15 minutes without speech. Saying goodbye or Hang up still ends the call.",
				variant: "card",
				children: jsx(Toggle, { isChecked: enabled, label: ROW_LABEL, onToggle, size: "md" }),
			});
		};
	};

	return { shouldReconnect, SettingsRow };
}

globalThis.BetterGrokBot?.define("voice-keepalive", createVoiceKeepalive);
