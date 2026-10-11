import { describe, expect, test } from "bun:test";
import { isSidebarError, isSidebarResult, parseSidebarCommand, SidebarError, type SidebarCommand, type SidebarErrorCode, type SidebarResult } from "./sidebar.ts";

const commands: SidebarCommand[] = [
	{ operation: "list-folders" },
	{ operation: "list-bots" },
	{ operation: "create-folder", name: "Research" },
	{ operation: "delete-folder", folder: "folder-1" },
	{ operation: "move-bot", bot: "bot-1", folder: "folder-1" },
	{ operation: "move-bot", bot: "bot-1", folder: null },
];

const folder = { id: "folder-1", name: "Research", botIds: ["bot-1", "bot-2"] };
const bot = { id: "bot-1", name: "Assistant", folderId: "folder-1" };
const results: SidebarResult[] = [
	{ operation: "list-folders", folders: [folder] },
	{ operation: "list-bots", bots: [bot, { ...bot, id: "bot-2", folderId: null }] },
	{ operation: "create-folder", folder },
	{ operation: "delete-folder", deletedFolder: folder, unassignedBotIds: ["bot-1", "bot-2"] },
	{ operation: "move-bot", bot },
];

describe("parseSidebarCommand", () => {
	for (const command of commands) {
		test(`accepts ${command.operation} ${JSON.stringify(command)}`, () => {
			expect(parseSidebarCommand(command)).toEqual(command);
		});
	}

	test("preserves nonblank names and selectors without trimming", () => {
		for (const command of [
			{ operation: "create-folder", name: "  Research  " },
			{ operation: "delete-folder", folder: "  Research  " },
			{ operation: "move-bot", bot: "  Assistant  ", folder: "  Research  " },
		] satisfies SidebarCommand[]) {
			expect(parseSidebarCommand(command)).toEqual(command);
		}
	});

	const invalidCommands: unknown[] = [
		null, undefined, true, false, 0, 1, "list-folders", [], [commands[0]], {},
		{ operation: "rename-folder", folder: "folder-1", name: "Renamed" },
		{ operation: "execute", script: "arbitrary" },
		{ operation: null },
		{ operation: 1 },
		{ name: "Research" },
		{ operation: "create-folder" },
		{ operation: "delete-folder" },
		{ operation: "move-bot", bot: "bot-1" },
		{ operation: "move-bot", folder: "folder-1" },
		{ operation: "create-folder", name: null },
		{ operation: "create-folder", name: 1 },
		{ operation: "delete-folder", folder: null },
		{ operation: "delete-folder", folder: 1 },
		{ operation: "move-bot", bot: null, folder: null },
		{ operation: "move-bot", bot: 1, folder: null },
		{ operation: "move-bot", bot: "bot-1", folder: undefined },
		{ operation: "move-bot", bot: "bot-1", folder: 1 },
	];
	for (const blank of ["", " ", "\t\n"]) {
		invalidCommands.push(
			{ operation: "create-folder", name: blank },
			{ operation: "delete-folder", folder: blank },
			{ operation: "move-bot", bot: blank, folder: null },
			{ operation: "move-bot", bot: "bot-1", folder: blank },
		);
	}
	for (const command of commands) {
		invalidCommands.push(
			{ ...command, rendererConnectionId: "renderer-1" },
			{ ...command, unexpected: true },
		);
	}
	for (const [index, value] of invalidCommands.entries()) {
		test(`rejects invalid command ${index}: ${JSON.stringify(value)}`, () => {
			expect(() => parseSidebarCommand(value)).toThrow(SidebarError);
			try {
				parseSidebarCommand(value);
				throw new Error("Invalid command unexpectedly accepted");
			} catch (error: unknown) {
				expect(error).toBeInstanceOf(SidebarError);
				if (!(error instanceof SidebarError)) throw error;
				expect(error.code).toBe("bad-request");
				expect(error.message).toBe("Invalid sidebar command");
			}
		});
	}
});

describe("isSidebarResult", () => {
	for (const result of results) {
		test(`accepts ${result.operation} response`, () => {
			expect(isSidebarResult(result)).toBe(true);
		});
	}

	test("accepts empty collections and an unassigned moved bot", () => {
		for (const result of [
			{ operation: "list-folders", folders: [] },
			{ operation: "list-bots", bots: [] },
			{ operation: "create-folder", folder: { ...folder, botIds: [] } },
			{ operation: "delete-folder", deletedFolder: folder, unassignedBotIds: [] },
			{ operation: "move-bot", bot: { ...bot, folderId: null } },
		]) {
			expect(isSidebarResult(result)).toBe(true);
		}
	});

	const invalidResults: unknown[] = [
		null, undefined, true, 0, "list-folders", [], [results[0]], {},
		{ operation: "rename-folder", folder },
		{ operation: "list-folders", folders: null },
		{ operation: "list-folders", folders: {} },
		{ operation: "list-bots", bots: null },
		{ operation: "list-bots", bots: {} },
		{ operation: "create-folder", folder: null },
		{ operation: "move-bot", bot: null },
		{ operation: "delete-folder", deletedFolder: folder, unassignedBotIds: null },
		{ operation: "delete-folder", deletedFolder: folder, unassignedBotIds: [""] },
		{ operation: "delete-folder", deletedFolder: folder, unassignedBotIds: [1] },
	];
	for (const result of results) {
		invalidResults.push({ ...result, arbitraryExport: true });
		for (const key of Object.keys(result)) {
			const missingField: Record<string, unknown> = { ...result };
			delete missingField[key];
			invalidResults.push(missingField);
		}
	}
	for (const malformedFolder of [
		null, [], "folder-1", {},
		{ name: "Research", botIds: [] },
		{ id: "folder-1", botIds: [] },
		{ id: "folder-1", name: "Research" },
		{ ...folder, id: "" }, { ...folder, id: 1 },
		{ ...folder, name: null }, { ...folder, name: 1 },
		{ ...folder, botIds: null }, { ...folder, botIds: "bot-1" },
		{ ...folder, botIds: [""] }, { ...folder, botIds: ["bot-1", 1] },
		{ ...folder, arbitraryExport: true },
	]) {
		invalidResults.push(
			{ operation: "list-folders", folders: [folder, malformedFolder] },
			{ operation: "create-folder", folder: malformedFolder },
			{ operation: "delete-folder", deletedFolder: malformedFolder, unassignedBotIds: [] },
		);
	}
	for (const malformedBot of [
		null, [], "bot-1", {},
		{ name: "Assistant", folderId: null },
		{ id: "bot-1", folderId: null },
		{ id: "bot-1", name: "Assistant" },
		{ ...bot, id: "" }, { ...bot, id: 1 },
		{ ...bot, name: null }, { ...bot, name: 1 },
		{ ...bot, folderId: "" }, { ...bot, folderId: 1 },
		{ ...bot, folderId: undefined }, { ...bot, folderId: {} },
		{ ...bot, arbitraryExport: true },
	]) {
		invalidResults.push(
			{ operation: "list-bots", bots: [bot, malformedBot] },
			{ operation: "move-bot", bot: malformedBot },
		);
	}
	for (const [index, value] of invalidResults.entries()) {
		test(`rejects malformed response ${index}: ${JSON.stringify(value)}`, () => {
			expect(isSidebarResult(value)).toBe(false);
		});
	}
});

describe("SidebarError", () => {
	const codes: SidebarErrorCode[] = ["bad-request", "not-found", "conflict", "permission-denied", "unavailable", "internal"];
	for (const code of codes) {
		test(`retains ${code}, message, and structured data`, () => {
			const data = { folderId: "folder-1", botIds: ["bot-1"] };
			const error = new SidebarError(code, "Sidebar operation failed", data);
			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe("SidebarError");
			expect(error.code).toBe(code);
			expect(error.message).toBe("Sidebar operation failed");
			expect(error.data).toBe(data);
		});
	}

	test("allows omitted data and retains explicit null data", () => {
		expect(new SidebarError("internal", "No details").data).toBeUndefined();
		expect(new SidebarError("internal", "Null details", null).data).toBeNull();
	});
});

describe("isSidebarError", () => {
	test("preserves the finite error contract across separately bundled constructors", () => {
		class SeparatelyBundledSidebarError extends Error {
			constructor(readonly code: SidebarErrorCode, message: string, readonly data?: unknown) {
				super(message);
				this.name = "SidebarError";
			}
		}
		const data = { candidates: [{ id: "bot-1", name: "Assistant" }] };
		const error = new SeparatelyBundledSidebarError("conflict", "Use a bot ID", data);
		expect(error).not.toBeInstanceOf(SidebarError);
		expect(isSidebarError(error)).toBe(true);
		if (!isSidebarError(error)) throw new Error("Expected the cross-bundle sidebar error contract");
		expect(error.code).toBe("conflict");
		expect(error.message).toBe("Use a bot ID");
		expect(error.data).toBe(data);
	});

	test("accepts normal instances and every finite sidebar error code", () => {
		const codes: SidebarErrorCode[] = ["bad-request", "not-found", "conflict", "permission-denied", "unavailable", "internal"];
		for (const code of codes) {
			expect(isSidebarError(new SidebarError(code, "Sidebar failed"))).toBe(true);
			expect(isSidebarError({ name: "SidebarError", code, message: "Sidebar failed" })).toBe(true);
		}
	});

	test("rejects unrelated errors, malformed fields, and inherited lookup-table keys", () => {
		const invalid: unknown[] = [
			null, undefined, "SidebarError", new Error("Sidebar failed"),
			{ name: "OtherError", code: "conflict", message: "Sidebar failed" },
			{ name: "SidebarError", code: "conflict" },
			{ name: "SidebarError", code: "conflict", message: 42 },
			{ name: "SidebarError", code: "arbitrary", message: "Sidebar failed" },
			{ name: "SidebarError", code: "__proto__", message: "Sidebar failed" },
			{ name: "SidebarError", code: "constructor", message: "Sidebar failed" },
		];
		for (const value of invalid) expect(isSidebarError(value)).toBe(false);
	});
});
