/**
 * "Instructions" editor in the bot info pane (Overview tab) for bots you own or manage.
 *
 * Reads the bot's `description` from the row the app passes in and saves it with the same call the app's own
 * description editor uses: `client.roster.updateAgent(id, { name, description })` (optimistic, rolled back on
 * failure). No new storage: the text lives on the bot itself.
 */
import type { ComponentFactory, PluginContext } from "@better-grok-bot/sdk";

/** The bot row fields the editor reads (the app's row has more). */
export interface BotRow {
	id: string;
	name: string;
	description: string;
	isGroup?: boolean;
	viewerIsOwner?: boolean;
	viewerCanManage?: boolean;
}

interface Roster {
	updateAgent(id: string, profile: { name: string; description: string }): Promise<unknown>;
}

/** `value` as a bot row, or null. */
export function botRow(value: unknown): BotRow | null {
	if (typeof value !== "object" || value === null) return null;
	const { id, name, description } = value as Record<string, unknown>;
	if (typeof id !== "string" || id.length === 0 || typeof name !== "string") return null;
	const row = value as BotRow;
	return { ...row, description: typeof description === "string" ? description : "" };
}

/** Same rule as the app's editor: owners and managers can edit; group chats have no instructions. */
export function canEdit(row: BotRow): boolean {
	if (row.isGroup === true) return false;
	return row.viewerIsOwner !== false || row.viewerCanManage === true;
}

/** Text to save, or null when nothing changed. */
export function pendingSave(saved: string, draft: string): string | null {
	const next = draft.trim();
	return next === saved.trim() ? null : next;
}

function roster(client: unknown): Roster | undefined {
	if (typeof client !== "object" || client === null) return undefined;
	const value = (client as { roster?: { updateAgent?: unknown } }).roster;
	return typeof value?.updateAgent === "function" ? (value as Roster) : undefined;
}

function createBotInstructions(ctx: PluginContext) {
	const subscribeClient = (onChange: () => void): (() => void) => ctx.app.onClient(onChange);
	const readClient = (): unknown => ctx.app.client;

	const Editor: ComponentFactory = ({ React, jsx }) =>
		function BotInstructionsEditor(props: Record<string, unknown>) {
			const row = botRow(props.agent);
			const client = React.useSyncExternalStore(subscribeClient, readClient);
			const saved = row?.description ?? "";
			const [draft, setDraft] = React.useState<string | null>(null);
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState(false);
			const rowId = row?.id;
			// A different bot: drop any unsaved edit.
			React.useEffect(() => {
				setDraft(null);
				setFailed(false);
			}, [rowId]);

			if (row === null || !canEdit(row)) return null;
			const store = roster(client);
			const text = draft ?? saved;
			const next = draft === null ? null : pendingSave(saved, draft);

			const save = (): void => {
				if (next === null || store === undefined || saving) {
					if (next === null) setDraft(null);
					return;
				}
				setSaving(true);
				setFailed(false);
				store.updateAgent(row.id, { name: row.name, description: next }).then(
					() => {
						setSaving(false);
						setDraft(null);
					},
					(error: unknown) => {
						ctx.log.warn("could not save the bot's instructions", error);
						setSaving(false);
						setFailed(true);
					},
				);
			};
			const cancel = (): void => {
				setDraft(null);
				setFailed(false);
			};

			const children: unknown[] = [
				jsx(
					"div",
					{
						className: "bgb-bot-instructions__header",
						children: [
							jsx("span", { className: "bgb-bot-instructions__title", id: `bgb-bot-instructions-${row.id}`, children: "Instructions" }, "t"),
							jsx("span", { className: "bgb-bot-instructions__hint", children: "How this Bot should work" }, "h"),
						],
					},
					"header",
				),
				jsx(
					"textarea",
					{
						className: "bgb-bot-instructions__field",
						"aria-labelledby": `bgb-bot-instructions-${row.id}`,
						placeholder: "Add instructions for this Bot",
						rows: 4,
						spellCheck: true,
						value: text,
						disabled: saving || store === undefined,
						onChange: (event: { currentTarget: { value: string } }) => {
							setDraft(event.currentTarget.value);
							setFailed(false);
						},
						onKeyDown: (event: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault(): void; stopPropagation(): void }) => {
							event.stopPropagation();
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								save();
							} else if (event.key === "Escape" && draft !== null) {
								event.preventDefault();
								cancel();
							}
						},
					},
					"field",
				),
			];
			if (draft !== null || failed) {
				children.push(
					jsx(
						"div",
						{
							className: "bgb-bot-instructions__footer",
							children: [
								jsx(
									"span",
									{
										className: "bgb-bot-instructions__status",
										"data-error": failed || undefined,
										role: failed ? "alert" : undefined,
										children: failed ? "Couldn't save. Try again." : saving ? "Saving…" : next === null ? "" : "Unsaved changes",
									},
									"s",
								),
								jsx("button", { type: "button", className: "bgb-bot-instructions__button", disabled: saving, onClick: cancel, children: "Cancel" }, "c"),
								jsx(
									"button",
									{
										type: "button",
										className: "bgb-bot-instructions__button bgb-bot-instructions__button--primary",
										disabled: saving || next === null,
										onClick: save,
										children: "Save",
									},
									"v",
								),
							],
						},
						"footer",
					),
				);
			}
			return jsx("section", { className: "bgb-bot-instructions", children });
		};

	return { Editor };
}

globalThis.BetterGrokBot?.define("bot-instructions", createBotInstructions);
