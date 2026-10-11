import type { Platform } from "../../sdk/index.ts";
import type { PlatformAdapter } from "./types.ts";

/** Placeholder adapter until slice S2 lands the real one: every method throws except `id`, `binName`, `notify`. */
export function createUnimplementedAdapter(id: Platform): PlatformAdapter {
	const missing = (method: string) => async (): Promise<never> => {
		throw new Error(`${id} platform adapter: ${method} not implemented`);
	};
	return {
		id,
		locateApp: missing("locateApp"),
		findRunningApp: missing("findRunningApp"),
		quitApp: missing("quitApp"),
		launchApp: missing("launchApp"),
		hookInstall: missing("hookInstall"),
		hookRemove: missing("hookRemove"),
		hookStatus: missing("hookStatus"),
		autostartInstall: missing("autostartInstall"),
		autostartRemove: missing("autostartRemove"),
		startAgent: missing("startAgent"),
		stopAgent: missing("stopAgent"),
		pointCurrent: missing("pointCurrent"),
		notify: async () => {},
		openPath: missing("openPath"),
		binName: () => (id === "win32" ? "bgb.exe" : "bgb"),
	};
}
