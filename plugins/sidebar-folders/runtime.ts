/**
 * Sidebar folders, built on the app's sidebar sections.
 *
 * Storage: the app's sections store (`client.sidebarSections`) reads and writes through the computer
 * (`getHostSidebarSections` / `setHostSidebarSections`). When the computer answers null, the app treats sections
 * as unsupported and hides them. `readSections` / `writeSections` wrap those calls: the computer's answer wins
 * when it has one (and is mirrored here), otherwise the copy Better Grok Bot keeps in `ctx.storage`
 * (`localStorage`, key `bgb:sidebar-folders:sections`) answers, so folders always work and survive restarts.
 *
 * Ordering: each section's `agentIds` array is the order; `orderSectionAgents` applies it for display and
 * `dropAgent` rewrites it on a drop. `New folder` is also offered when right-clicking empty sidebar space.
 */
import { SidebarError, parseSidebarCommand, type PluginContext, type SidebarBot, type SidebarCommand, type SidebarFolder, type SidebarResult } from "@better-grok-bot/sdk";

/** The app's id for the synthetic "everything not in a section" list. */
export const UNSECTIONED_ID = "__agents__";

export interface Section {
	id: string;
	name: string;
	agentIds: readonly string[];
}

interface SectionsStore {
	sections: { get(): readonly Section[] | null };
	edit(update: (sections: readonly Section[]) => readonly Section[]): void;
	readonly intent?: readonly Section[] | null;
	readonly ops?: Promise<void>;
	readonly phase?: { kind?: unknown };
	readonly generation?: number;
}

interface DragTarget {
	kind?: unknown;
	id?: unknown;
}

/** `agents` sorted by their position in `agentIds`; bots missing from it keep their order, after the rest. */
export function orderByIds<T extends { id: string }>(agents: readonly T[], agentIds: readonly string[]): T[] {
	const rank = new Map(agentIds.map((id, index) => [id, index]));
	return agents
		.map((agent, index) => ({ agent, index, rank: rank.get(agent.id) ?? Number.POSITIVE_INFINITY }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.agent);
}

/**
 * Moves `agentId` into section `sectionId`, before `beforeId` (a bot of that section), or right after `afterId`
 * when there is no `beforeId`, or to the end. Removes it from every other section. Returns null when the section
 * does not exist.
 */
export function placeAgent(
	sections: readonly Section[],
	agentId: string,
	sectionId: string,
	beforeId: string | null,
	afterId: string | null,
): Section[] | null {
	if (!sections.some((section) => section.id === sectionId)) return null;
	return sections.map((section) => {
		const rest = section.agentIds.filter((id) => id !== agentId);
		if (section.id !== sectionId) return rest.length === section.agentIds.length ? section : { ...section, agentIds: rest };
		let at = beforeId === null ? -1 : rest.indexOf(beforeId);
		if (at < 0 && afterId !== null) {
			const after = rest.indexOf(afterId);
			if (after >= 0) at = after + 1;
		}
		if (at < 0) at = rest.length;
		return { ...section, agentIds: [...rest.slice(0, at), agentId, ...rest.slice(at)] };
	});
}

/** `ctx.storage` key of the folders Better Grok Bot keeps. */
export const STORAGE_KEY = "sections";

/** `value` as a clean sections list (the shape the computer stores), or null when it is not one. */
export function parseSections(value: unknown): Section[] | null {
	if (!Array.isArray(value)) return null;
	const sections: Section[] = [];
	const ids = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const { id, name, agentIds } = entry as { id?: unknown; name?: unknown; agentIds?: unknown };
		if (typeof id !== "string" || id.length === 0 || ids.has(id) || typeof name !== "string" || !Array.isArray(agentIds)) continue;
		ids.add(id);
		sections.push({ id, name, agentIds: agentIds.filter((agentId): agentId is string => typeof agentId === "string" && agentId.length > 0) });
	}
	return sections;
}

/**
 * Outcome of a read: the computer's list when it has one (`mirror` true: keep a copy), else the local copy,
 * else an empty list (sections become available, with no folders yet).
 */
export function resolveRead(host: unknown, local: unknown): { sections: Section[]; source: "host" | "local" } {
	const fromHost = parseSections(host);
	if (fromHost !== null) return { sections: fromHost, source: "host" };
	return { sections: parseSections(local) ?? [], source: "local" };
}

export interface Row {
	id: string;
	top: number;
	bottom: number;
}

/** Neighbours of pointer `y` among `rows` (top to bottom, the dragged bot excluded). */
export function slotAt(rows: readonly Row[], y: number): { beforeId: string | null; afterId: string | null; lineY: number | null } {
	let afterId: string | null = null;
	let lineY: number | null = null;
	for (const row of rows) {
		if (y < (row.top + row.bottom) / 2) return { beforeId: row.id, afterId, lineY: row.top };
		afterId = row.id;
		lineY = row.bottom;
	}
	return { beforeId: null, afterId, lineY };
}

function sectionsStore(client: unknown): SectionsStore | undefined {
	if (typeof client !== "object" || client === null) return undefined;
	const store = (client as { sidebarSections?: unknown }).sidebarSections;
	if (typeof store !== "object" || store === null) return undefined;
	const { sections, edit } = store as { sections?: { get?: unknown }; edit?: unknown };
	if (typeof edit !== "function" || typeof sections?.get !== "function") return undefined;
	return store as SectionsStore;
}

function sectionRows(sectionId: string, draggedId: string): { rows: Row[]; box: DOMRect | null } {
	const selector = `div[data-section-id="${CSS.escape(sectionId)}"]`;
	const container = document.querySelector(selector);
	if (container === null) return { rows: [], box: null };
	const seen = new Set<string>();
	const rows: Row[] = [];
	for (const button of container.querySelectorAll<HTMLElement>("button[data-agent-id]")) {
		const id = button.dataset.agentId;
		if (id === undefined || id === draggedId || seen.has(id)) continue;
		seen.add(id);
		const rect = button.getBoundingClientRect();
		if (rect.height === 0) continue;
		rows.push({ id, top: rect.top, bottom: rect.bottom });
	}
	rows.sort((a, b) => a.top - b.top);
	return { rows, box: container.getBoundingClientRect() };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

interface SectionCommands {
	create(agentIds: readonly string[]): string | null;
}

function sectionCommands(client: unknown): SectionCommands | undefined {
	if (typeof client !== "object" || client === null) return undefined;
	const store = (client as { sidebarSections?: { commands?: { create?: unknown } } }).sidebarSections;
	const commands = store?.commands;
	if (typeof commands?.create !== "function") return undefined;
	return commands as SectionCommands;
}

function readySections(value: unknown): readonly Section[] {
	if (!Array.isArray(value)) throw new SidebarError("unavailable", "Sidebar folders have not loaded");
	const ids = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) throw new SidebarError("unavailable", "Sidebar folder state is invalid");
		const section = entry as Partial<Section>;
		if (
			typeof section.id !== "string" || section.id.length === 0 || ids.has(section.id) || typeof section.name !== "string" ||
			!Array.isArray(section.agentIds) || !section.agentIds.every((id) => typeof id === "string" && id.length > 0)
		) throw new SidebarError("unavailable", "Sidebar folder state is invalid");
		ids.add(section.id);
	}
	return value as Section[];
}

function visibleBots(client: unknown): { id: string; name: string }[] {
	const parts = client as { roster?: { snapshots?: { get?: unknown } } };
	const snapshots = parts.roster?.snapshots;
	if (typeof snapshots?.get !== "function") throw new SidebarError("unavailable", "Sidebar bot roster is unavailable");
	const value: unknown = Reflect.apply(snapshots.get, snapshots, []);
	if (typeof value !== "object" || value === null) throw new SidebarError("unavailable", "Sidebar bot roster has not loaded");
	const snapshot = value as { loadState?: unknown; isShowingRestoredRoster?: unknown; agents?: { rows?: unknown } };
	if (snapshot.loadState !== "ready" || snapshot.isShowingRestoredRoster === true || !Array.isArray(snapshot.agents?.rows)) {
		throw new SidebarError("unavailable", "Sidebar bot roster is not ready");
	}
	const bots: { id: string; name: string }[] = [];
	const ids = new Set<string>();
	for (const value of snapshot.agents.rows) {
		if (typeof value !== "object" || value === null) throw new SidebarError("unavailable", "Sidebar bot roster is invalid");
		const row = value as { id?: unknown; name?: unknown; isGroup?: unknown; isHiddenFromSidebar?: unknown };
		if (row.isGroup === true || row.isHiddenFromSidebar === true) continue;
		if (typeof row.id !== "string" || row.id.length === 0 || ids.has(row.id)) throw new SidebarError("unavailable", "Sidebar bot roster is invalid");
		ids.add(row.id);
		bots.push({ id: row.id, name: typeof row.name === "string" ? row.name.trim() || row.id : row.id });
	}
	return bots;
}

function resolveSelector<T extends { id: string; name: string }>(selector: string, entries: readonly T[], kind: "bot" | "folder"): T {
	const trimmed = selector.trim().normalize("NFC");
	const byId = entries.find((entry) => entry.id === selector) ?? entries.find((entry) => entry.id === trimmed);
	if (byId !== undefined) return byId;
	const name = trimmed.toLowerCase();
	const candidates = entries.filter((entry) => entry.name.trim().normalize("NFC").toLowerCase() === name);
	if (candidates.length > 1) throw new SidebarError("conflict", `Ambiguous ${kind} name; use an ID`, { candidates: candidates.map(({ id, name }) => ({ id, name })) });
	const found = candidates[0];
	if (found === undefined) throw new SidebarError("not-found", `Sidebar ${kind} not found`, { selector });
	return found;
}

function folderFor(selector: string, sections: readonly Section[]): Section {
	const folder = resolveSelector(selector, [...sections.filter((section) => section.id !== UNSECTIONED_ID), { id: UNSECTIONED_ID, name: "Unassigned", agentIds: [] }], "folder");
	if (folder.id === UNSECTIONED_ID) throw new SidebarError("bad-request", "Unassigned is not a folder; use a null move destination");
	return folder;
}

interface PersistenceWait {
	payload: readonly Section[] | undefined;
	active: boolean;
	stored: readonly Section[] | undefined;
	failed: boolean;
	error: unknown;
	resolve(sections: readonly Section[]): void;
	reject(error: SidebarError): void;
}

export type SidebarFoldersRuntime = {
	readSections(request: unknown): Promise<Section[]> | undefined;
	writeSections(request: unknown, next: unknown): Promise<Section[]> | undefined;
	orderSectionAgents(section: unknown, agents: unknown): unknown;
	dragOver(active: unknown, over: unknown): void;
	dropAgent(agentId: unknown, sectionId: unknown): true | undefined;
	executeSidebar(command: SidebarCommand): Promise<SidebarResult>;
};

/** The sidebar `<aside>` holding `target`, when `target` is empty sidebar space (not a row, button or field). */
export function emptySidebarSpace(target: EventTarget | null): Element | null {
	if (!(target instanceof Element)) return null;
	if (target.closest("button, a, input, textarea, select, [role='menu'], [role='menuitem'], [data-section-id], [contenteditable='true']") !== null)
		return null;
	const aside = target.closest("aside");
	if (aside === null || aside.querySelector("button[data-agent-id]") === null) return null;
	return aside;
}

export function createSidebarFolders(ctx: PluginContext): SidebarFoldersRuntime {
	/** Whether the computer stores sections (its last read answered a list). Until then, writes fall back locally. */
	let hostStores = false;
	let pendingPersistence: PersistenceWait | undefined;
	let commands: Promise<unknown> = Promise.resolve();

	const saveLocal = (sections: readonly Section[], requirePersistence = false): void => {
		try {
			ctx.storage.set(STORAGE_KEY, sections, requirePersistence ? { requirePersistence: true } : undefined);
		} catch (error) {
			ctx.log.warn("could not save folders", error);
			if (requirePersistence) throw error;
		}
	};

	/** Wraps the store's computer read; resolves to a list so the app always treats sections as supported. */
	const readSections = (request: unknown): Promise<Section[]> | undefined => {
		if (!isThenable(request)) return undefined;
		const local = (): unknown => ctx.storage.get<unknown>(STORAGE_KEY, null);
		return Promise.resolve(request).then(
			(host: unknown) => {
				const { sections, source } = resolveRead(host, local());
				hostStores = source === "host";
				if (hostStores) saveLocal(sections);
				return sections;
			},
			(error: unknown) => {
				const saved = parseSections(local());
				if (saved === null || hostStores) throw error;
				return saved;
			},
		);
	};

	/** Wraps the store's computer write; keeps a local copy and answers with it when the computer does not store sections. */
	const writeSections = (request: unknown, next: unknown): Promise<Section[]> | undefined => {
		const sections = parseSections(next);
		if (!isThenable(request) || sections === null) return undefined;
		const pending = pendingPersistence;
		const ownWrite = pending?.active === true && next === pending.payload ? pending : undefined;
		const needsLocalConfirmation = ownWrite !== undefined && hostStores;
		let localFailed = false;
		let localError: unknown;
		try {
			saveLocal(sections, ownWrite !== undefined && !hostStores);
		} catch (error) {
			localFailed = true;
			localError = error;
		}
		const completion = Promise.resolve(request).then(
			(host: unknown) => {
				const stored = parseSections(host);
				hostStores = stored !== null;
				if (stored === null) {
					if (localFailed) throw localError;
					if (needsLocalConfirmation) saveLocal(sections, true);
					return sections;
				}
				saveLocal(stored);
				return stored;
			},
			(error: unknown) => {
				if (hostStores || needsLocalConfirmation) throw error;
				if (localFailed) throw localError;
				return sections;
			},
		);
		if (ownWrite !== undefined) {
			void completion.then(
				(stored) => {
					ownWrite.stored = stored;
					ownWrite.failed = false;
				},
				(error: unknown) => {
					// Retry attempts belong to the native operation; its captured queue completion settles the command.
					ownWrite.failed = true;
					ownWrite.error = error;
				},
			);
		}
		return completion;
	};

	const persistEdit = async (
		client: unknown,
		store: SectionsStore,
		update: (sections: readonly Section[]) => readonly Section[],
		beforeEdit?: () => void,
	): Promise<readonly Section[]> => {
		if (store.phase?.kind !== "confirmed" || !isThenable(store.ops) ||
			(store.intent !== null && !Array.isArray(store.intent)) || typeof store.generation !== "number") {
			throw new SidebarError("unavailable", "Sidebar folders are not ready to confirm persistence");
		}
		const generation = store.generation;
		let pending: PersistenceWait | undefined;
		let unsubscribeClient: (() => void) | undefined;
		const timer = setTimeout(() => pending?.reject(new SidebarError("unavailable", "Folder persistence confirmation timed out; check sidebar state before retrying", { outcome: "unknown" })), 15_000);
		const confirmed = new Promise<readonly Section[]>((resolve, reject) => {
			pending = { payload: undefined, active: false, stored: undefined, failed: false, error: undefined, resolve, reject };
			pendingPersistence = pending;
			const wait = pending;
			unsubscribeClient = ctx.app.onClient((latest) => {
				if (latest !== client) wait.reject(new SidebarError("unavailable", "The sidebar client changed; check sidebar state before retrying", { outcome: "unknown" }));
			});
			try {
				beforeEdit?.();
				const previousOperation = store.ops;
				if (!isThenable(previousOperation)) throw new SidebarError("unavailable", "Native folder persistence queue is unavailable");
				// The native writer runs behind this exact predecessor. Older identical UI payloads cannot confirm our edit.
				void previousOperation.then(
					() => { wait.active = true; },
					(error: unknown) => wait.reject(new SidebarError("unavailable", `Native folder persistence queue failed: ${String(error)}`, { outcome: "unknown" })),
				);
				let updated = false;
				store.edit((sections) => {
					if (ctx.app.client !== client || store.generation !== generation) throw new SidebarError("unavailable", "The sidebar client changed before the edit");
					const next = update(readySections(sections));
					updated = true;
					return next;
				});
				const operation = store.ops;
				const payload = store.intent;
				if (!updated || !Array.isArray(payload) || !isThenable(operation) || operation === previousOperation) {
					throw new SidebarError("unavailable", "Sidebar folders are not ready to edit");
				}
				wait.payload = payload;
				void operation.then(
					() => {
						wait.active = false;
						if (ctx.app.client !== client || store.generation !== generation) {
							wait.reject(new SidebarError("unavailable", "The sidebar client changed; check sidebar state before retrying", { outcome: "unknown" }));
						} else if (!wait.failed && wait.stored !== undefined) {
							wait.resolve(wait.stored);
						} else {
							const detail = wait.failed ? (wait.error instanceof Error ? wait.error.message : String(wait.error)) : "No owned write was observed";
							wait.reject(new SidebarError("unavailable", `Folder persistence failed; check sidebar state before retrying: ${detail}`, { outcome: "unknown" }));
						}
					},
					(error: unknown) => {
						wait.active = false;
						wait.reject(new SidebarError("unavailable", `Native folder persistence queue failed: ${String(error)}`, { outcome: "unknown" }));
					},
				);
			} catch (error) {
				reject(error);
			}
		});
		try {
			// Native ops settles only after its complete write/retry body has applied or rolled back the host result.
			const stored = await confirmed;
			if (ctx.app.client !== client || store.generation !== generation) throw new SidebarError("unavailable", "The sidebar client changed; check sidebar state before retrying", { outcome: "unknown" });
			readySections(store.sections.get());
			return stored;
		} finally {
			if (pendingPersistence === pending) pendingPersistence = undefined;
			clearTimeout(timer);
			unsubscribeClient?.();
		}
	};

	const execute = async (command: SidebarCommand): Promise<SidebarResult> => {
		const client = ctx.app.client;
		const store = sectionsStore(client);
		if (store === undefined) throw new SidebarError("unavailable", "Sidebar folders client is unavailable");
		const sections = readySections(store.sections.get());
		let bots = visibleBots(client);
		let visible: Set<string> | undefined;
		const toFolder = (section: Section): SidebarFolder => {
			const visibleIds = visible ??= new Set(bots.map((bot) => bot.id));
			return { id: section.id, name: section.name, botIds: [...new Set(section.agentIds.filter((id) => visibleIds.has(id)))] };
		};
		const toBot = (bot: { id: string; name: string }, current: readonly Section[]): SidebarBot => ({
			...bot,
			folderId: current.find((section) => section.id !== UNSECTIONED_ID && section.agentIds.includes(bot.id))?.id ?? null,
		});
		switch (command.operation) {
			case "list-folders":
				return { operation: command.operation, folders: sections.filter((section) => section.id !== UNSECTIONED_ID).map(toFolder) };
			case "list-bots":
				return { operation: command.operation, bots: bots.map((bot) => toBot(bot, sections)) };
			case "create-folder": {
				const name = command.name.trim().normalize("NFC");
				const duplicate = [...sections, { id: UNSECTIONED_ID, name: "Unassigned", agentIds: [] }].find((section) => section.name.trim().normalize("NFC").toLowerCase() === name.toLowerCase());
				if (duplicate !== undefined) throw new SidebarError("conflict", "A folder with that name already exists", { candidates: [{ id: duplicate.id, name: duplicate.name }] });
				const native = sectionCommands(client);
				if (native === undefined) throw new SidebarError("unavailable", "Native folder creation is unavailable");
				let createdId: string | null = null;
				const stored = await persistEdit(client, store, (current) => {
					if (!current.some((section) => section.id === createdId)) throw new SidebarError("unavailable", "The created folder is no longer available");
					if (current.some((section) => section.id !== createdId && section.name.trim().normalize("NFC").toLowerCase() === name.toLowerCase())) {
						throw new SidebarError("conflict", "A folder with that name already exists");
					}
					return current.map((section) => section.id === createdId ? { ...section, name } : section);
				}, () => {
					createdId = native.create([]);
					if (createdId === null || createdId === UNSECTIONED_ID) throw new SidebarError("unavailable", "Native folder creation is not ready");
				});
				const current = readySections(store.sections.get());
				const folder = current.find((section) => section.id === createdId);
				if (folder === undefined || folder.name !== name || !stored.some((section) => section.id === createdId && section.name === name)) {
					throw new SidebarError("conflict", "The created folder changed before confirmation", { createdFolderId: createdId });
				}
				bots = visibleBots(client);
				return { operation: command.operation, folder: toFolder(folder) };
			}
			case "delete-folder": {
				const folder = folderFor(command.folder, sections);
				let deleted = folder;
				const stored = await persistEdit(client, store, (current) => {
					const found = current.find((section) => section.id === folder.id);
					if (found === undefined) throw new SidebarError("not-found", "Sidebar folder no longer exists", { id: folder.id });
					deleted = found;
					return current.filter((section) => section.id !== folder.id);
				});
				const current = readySections(store.sections.get());
				if (current.some((section) => section.id === folder.id) || stored.some((section) => section.id === folder.id)) {
					throw new SidebarError("conflict", "The folder deletion was not preserved");
				}
				bots = visibleBots(client);
				const visibleIds = visible = new Set(bots.map((bot) => bot.id));
				const assigned = new Set(current.filter((section) => section.id !== UNSECTIONED_ID).flatMap((section) => [...section.agentIds]));
				return { operation: command.operation, deletedFolder: toFolder(deleted), unassignedBotIds: [...new Set(deleted.agentIds.filter((id) => visibleIds.has(id) && !assigned.has(id)))] };
			}
			case "move-bot": {
				const bot = resolveSelector(command.bot, bots, "bot");
				const destination = command.folder === null ? null : folderFor(command.folder, sections);
				const stored = await persistEdit(client, store, (current) => {
					if (!visibleBots(client).some((currentBot) => currentBot.id === bot.id)) throw new SidebarError("not-found", "Sidebar bot no longer exists", { id: bot.id });
					if (destination === null) return current.map((section) => section.agentIds.includes(bot.id) ? { ...section, agentIds: section.agentIds.filter((id) => id !== bot.id) } : section);
					if (destination !== null && current.some((section) => section.id === destination.id && section.agentIds.includes(bot.id))) {
						return current.map((section) => {
							let kept = false;
							const agentIds = section.agentIds.filter((id) => {
								if (id !== bot.id) return true;
								if (section.id !== destination.id || kept) return false;
								kept = true;
								return true;
							});
							return agentIds.length === section.agentIds.length ? section : { ...section, agentIds };
						});
					}
					const next = placeAgent(current, bot.id, destination.id, null, null);
					if (next === null) throw new SidebarError("not-found", "Sidebar folder no longer exists", { id: destination.id });
					return next;
				});
				const current = readySections(store.sections.get());
				const folderId = destination?.id ?? null;
				const memberships = current.filter((section) => section.id !== UNSECTIONED_ID && section.agentIds.includes(bot.id));
				const persisted = stored.filter((section) => section.id !== UNSECTIONED_ID && section.agentIds.includes(bot.id));
				if (memberships.length !== (folderId === null ? 0 : 1) || persisted.length !== memberships.length || memberships[0]?.id !== persisted[0]?.id || (memberships[0]?.id ?? null) !== folderId) {
					throw new SidebarError("conflict", "The bot move changed before confirmation");
				}
				const latestBot = visibleBots(client).find((currentBot) => currentBot.id === bot.id);
				if (latestBot === undefined) throw new SidebarError("not-found", "Sidebar bot no longer exists after the move", { id: bot.id });
				return { operation: command.operation, bot: toBot(latestBot, current) };
			}
		}
	};

	const executeSidebar = (command: SidebarCommand): Promise<SidebarResult> => {
		const result = commands.then(() => execute(parseSidebarCommand(command))).catch((error: unknown) => {
			if (error instanceof SidebarError) throw error;
			throw new SidebarError("internal", `Sidebar command failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		commands = result.catch(() => {});
		return result;
	};

	/* Right-click on empty sidebar space: a small "New folder" menu. */
	let menu: HTMLDivElement | null = null;
	const closeMenu = (): void => {
		if (menu === null) return;
		menu.remove();
		menu = null;
		window.removeEventListener("pointerdown", onOutside, true);
		window.removeEventListener("keydown", onMenuKey, true);
		window.removeEventListener("blur", closeMenu);
		window.removeEventListener("resize", closeMenu);
	};
	const onOutside = (event: PointerEvent): void => {
		if (menu !== null && event.target instanceof Node && menu.contains(event.target)) return;
		closeMenu();
	};
	const onMenuKey = (event: KeyboardEvent): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			closeMenu();
		}
	};
	const createFolder = (): void => {
		closeMenu();
		const commands = sectionCommands(ctx.app.client);
		if (commands === undefined) {
			ctx.log.warn("folders are not available yet");
			return;
		}
		try {
			if (commands.create([]) === null) ctx.log.warn("folders are not loaded yet; try again in a moment");
		} catch (error) {
			ctx.log.warn("could not create a folder", error);
		}
	};
	const openMenu = (x: number, y: number): void => {
		closeMenu();
		const element = document.createElement("div");
		element.className = "bgb-sidebar-folders__menu";
		element.setAttribute("role", "menu");
		element.setAttribute("aria-label", "Sidebar");
		const item = document.createElement("button");
		item.type = "button";
		item.className = "bgb-sidebar-folders__menu-item";
		item.setAttribute("role", "menuitem");
		item.textContent = "New folder";
		item.addEventListener("click", createFolder);
		element.append(item);
		document.body.append(element);
		const { width, height } = element.getBoundingClientRect();
		element.style.left = `${Math.round(Math.max(4, Math.min(x, window.innerWidth - width - 4)))}px`;
		element.style.top = `${Math.round(Math.max(4, Math.min(y, window.innerHeight - height - 4)))}px`;
		menu = element;
		window.addEventListener("pointerdown", onOutside, true);
		window.addEventListener("keydown", onMenuKey, true);
		window.addEventListener("blur", closeMenu);
		window.addEventListener("resize", closeMenu);
		item.focus();
	};
	// Bubble phase: rows, folder headers and other app menus handle (and prevent) their own right-clicks first.
	globalThis.window?.addEventListener("contextmenu", (event) => {
		if (event.defaultPrevented) return;
		if (emptySidebarSpace(event.target) === null) return;
		event.preventDefault();
		openMenu(event.clientX, event.clientY);
	});

	/** The bot being dragged and the folder it is over; null when no in-folder drop is possible. */
	let drag: { agentId: string; sectionId: string } | null = null;
	let pointerY: number | null = null;
	let line: HTMLDivElement | null = null;

	const hideLine = (): void => {
		line?.remove();
		line = null;
	};

	const drawLine = (): void => {
		if (drag === null || pointerY === null) return hideLine();
		const { rows, box } = sectionRows(drag.sectionId, drag.agentId);
		const { lineY } = slotAt(rows, pointerY);
		if (box === null || lineY === null) return hideLine();
		if (line === null) {
			line = document.createElement("div");
			line.className = "bgb-sidebar-folders__drop-line";
			line.setAttribute("aria-hidden", "true");
			document.body.append(line);
		}
		line.style.top = `${Math.round(lineY)}px`;
		line.style.left = `${Math.round(box.left)}px`;
		line.style.width = `${Math.round(box.width)}px`;
	};

	const stop = (): void => {
		drag = null;
		pointerY = null;
		hideLine();
		window.removeEventListener("pointermove", onPointerMove, true);
		window.removeEventListener("pointerup", onPointerEnd, true);
		window.removeEventListener("pointercancel", onPointerEnd, true);
		window.removeEventListener("keydown", onKeyDown, true);
	};
	const onPointerMove = (event: PointerEvent): void => {
		pointerY = event.clientY;
		drawLine();
	};
	// The drop handler runs on the same pointerup; clear afterwards so it still sees the last position.
	const onPointerEnd = (): void => void setTimeout(stop, 0);
	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key === "Escape") stop();
	};

	/** Display order of a section's bots: the saved `agentIds` order. */
	const orderSectionAgents = (section: unknown, agents: unknown): unknown => {
		if (!Array.isArray(agents) || typeof section !== "object" || section === null) return undefined;
		const { id, agentIds } = section as { id?: unknown; agentIds?: unknown };
		if (id === UNSECTIONED_ID || !Array.isArray(agentIds)) return undefined;
		if (!agents.every((agent) => typeof agent === "object" && agent !== null && typeof agent.id === "string")) return undefined;
		return orderByIds(agents as { id: string }[], agentIds.filter((value): value is string => typeof value === "string"));
	};

	const dragOver = (active: unknown, over: unknown): void => {
		const a = active as DragTarget | null | undefined;
		const o = over as DragTarget | null | undefined;
		const inFolder =
			a?.kind === "agent" && typeof a.id === "string" && o?.kind === "section-body" && typeof o.id === "string" && o.id !== UNSECTIONED_ID;
		if (!inFolder) {
			drag = null;
			hideLine();
			return;
		}
		const wasIdle = drag === null && line === null && pointerY === null;
		drag = { agentId: a.id as string, sectionId: o.id as string };
		if (wasIdle) {
			window.addEventListener("pointermove", onPointerMove, true);
			window.addEventListener("pointerup", onPointerEnd, true);
			window.addEventListener("pointercancel", onPointerEnd, true);
			window.addEventListener("keydown", onKeyDown, true);
		}
		drawLine();
	};

	/** Drop of bot `agentId` on section `sectionId`; true when handled, undefined to let the app append it. */
	const dropAgent = (agentId: unknown, sectionId: unknown): true | undefined => {
		const y = pointerY;
		stop();
		if (typeof agentId !== "string" || typeof sectionId !== "string" || sectionId === UNSECTIONED_ID || y === null) return undefined;
		const store = sectionsStore(ctx.app.client);
		const current = store?.sections.get();
		if (store === undefined || current == null) return undefined;
		const { beforeId, afterId } = slotAt(sectionRows(sectionId, agentId).rows, y);
		if (placeAgent(current, agentId, sectionId, beforeId, afterId) === null) return undefined;
		try {
			store.edit((sections) => placeAgent(sections, agentId, sectionId, beforeId, afterId) ?? sections);
		} catch (error) {
			ctx.log.warn("could not reorder the section", error);
			return undefined;
		}
		return true;
	};

	return { readSections, writeSections, orderSectionAgents, dragOver, dropAgent, executeSidebar };
}

globalThis.BetterGrokBot?.define("sidebar-folders", createSidebarFolders);
