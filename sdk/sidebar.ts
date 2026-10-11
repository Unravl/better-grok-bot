export const BGB_SIDEBAR_MCP_ID = "bgb-sidebar-folders";
export const BGB_RENDERER_META_KEY = "io.github.unravl.bgb/rendererConnectionId";

export type SidebarCommand =
	| { operation: "list-folders" }
	| { operation: "list-bots" }
	| { operation: "create-folder"; name: string }
	| { operation: "delete-folder"; folder: string }
	| { operation: "move-bot"; bot: string; folder: string | null };

export interface SidebarFolder {
	id: string;
	name: string;
	botIds: string[];
}

export interface SidebarBot {
	id: string;
	name: string;
	folderId: string | null;
}

export type SidebarResult =
	| { operation: "list-folders"; folders: SidebarFolder[] }
	| { operation: "list-bots"; bots: SidebarBot[] }
	| { operation: "create-folder"; folder: SidebarFolder }
	| { operation: "delete-folder"; deletedFolder: SidebarFolder; unassignedBotIds: string[] }
	| { operation: "move-bot"; bot: SidebarBot };

export type SidebarErrorCode = "bad-request" | "not-found" | "conflict" | "permission-denied" | "unavailable" | "internal";

export class SidebarError extends Error {
	constructor(
		readonly code: SidebarErrorCode,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "SidebarError";
	}
}

const SIDEBAR_ERROR_CODES: Record<SidebarErrorCode, true> = {
	"bad-request": true,
	"not-found": true,
	conflict: true,
	"permission-denied": true,
	unavailable: true,
	internal: true,
};

/** Plugin and loader bundles have distinct Error constructors; preserve only the finite sidebar error contract. */
export function isSidebarError(value: unknown): value is SidebarError {
	if (typeof value !== "object" || value === null || !("name" in value) || value.name !== "SidebarError" ||
		!("message" in value) || typeof value.message !== "string" || !("code" in value) || typeof value.code !== "string") return false;
	return Object.hasOwn(SIDEBAR_ERROR_CODES, value.code);
}

function hasFields(value: object, fields: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isSelector(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Accepts only the five sidebar operations and their exact fields; renderer IDs are never tool arguments. */
export function parseSidebarCommand(value: unknown): SidebarCommand {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const command = value as { operation?: unknown; name?: unknown; folder?: unknown; bot?: unknown };
		switch (command.operation) {
			case "list-folders":
			case "list-bots":
				if (hasFields(value, ["operation"])) return { operation: command.operation };
				break;
			case "create-folder":
				if (hasFields(value, ["operation", "name"]) && isSelector(command.name)) return { operation: command.operation, name: command.name };
				break;
			case "delete-folder":
				if (hasFields(value, ["operation", "folder"]) && isSelector(command.folder)) return { operation: command.operation, folder: command.folder };
				break;
			case "move-bot":
				if (hasFields(value, ["operation", "bot", "folder"]) && isSelector(command.bot) && (command.folder === null || isSelector(command.folder))) {
					return { operation: command.operation, bot: command.bot, folder: command.folder };
				}
				break;
		}
	}
	throw new SidebarError("bad-request", "Invalid sidebar command");
}

function isId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isIds(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isId);
}

function isFolder(value: unknown): value is SidebarFolder {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const folder = value as { id?: unknown; name?: unknown; botIds?: unknown };
	return hasFields(value, ["id", "name", "botIds"]) && isId(folder.id) && typeof folder.name === "string" && isIds(folder.botIds);
}

function isBot(value: unknown): value is SidebarBot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const bot = value as { id?: unknown; name?: unknown; folderId?: unknown };
	return hasFields(value, ["id", "name", "folderId"]) && isId(bot.id) && typeof bot.name === "string" && (bot.folderId === null || isId(bot.folderId));
}

/** Validates the finite response boundary without trusting a plugin's arbitrary exports. */
export function isSidebarResult(value: unknown): value is SidebarResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const result = value as { operation?: unknown; folders?: unknown; bots?: unknown; folder?: unknown; deletedFolder?: unknown; unassignedBotIds?: unknown; bot?: unknown };
	switch (result.operation) {
		case "list-folders":
			return hasFields(value, ["operation", "folders"]) && Array.isArray(result.folders) && result.folders.every(isFolder);
		case "list-bots":
			return hasFields(value, ["operation", "bots"]) && Array.isArray(result.bots) && result.bots.every(isBot);
		case "create-folder":
			return hasFields(value, ["operation", "folder"]) && isFolder(result.folder);
		case "delete-folder":
			return hasFields(value, ["operation", "deletedFolder", "unassignedBotIds"]) && isFolder(result.deletedFolder) && isIds(result.unassignedBotIds);
		case "move-bot":
			return hasFields(value, ["operation", "bot"]) && isBot(result.bot);
		default:
			return false;
	}
}
