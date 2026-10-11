/**
 * Calls the app "Better Grok Bot" where the UI names the app itself: updates and
 * version prompts, restart prompts, the welcome screen, settings and the error page.
 *
 * Patched Lingui catalog loads call `renameCatalog`, which returns a renamed copy of the
 * listed messages in every locale. Deliberately left alone: everything about the
 * assistant/service ("Grok Bot's computer", "Allow Grok Bot to…", plans, accounts),
 * text naming what the OS shows under the real bundle name (Full Disk Access,
 * Automation), other installs (mobile, "Open Grok Bot on your Mac"), messages mixing
 * app and assistant, and the Dock/menu bar/About panel, which come from the bundle.
 *
 * `createSidebarBrand` renders a "Better Grok Bot" label at the top of the agents sidebar;
 * `BRAND_CSS` styles it. Core hook `bgb-brand` wires both in (see `core/hooks/brand.ts`).
 */
import type { JsxFn } from "../sdk/index.ts";

export const APP_NAME = "Better Grok Bot";
export const BRAND_LABEL_CLASS = "bgb-brand-label";
const OLD_NAME = /(?<!Better )Grok Bot/g;
const APP_NAME_PLACEHOLDER = "SAND_PRODUCT_DISPLAY_NAME";

const RENAMED_IDS: ReadonlySet<string> = new Set([
	// Updates and version.
	"ZEccfE", "uiPSBV", "Dm4agC", "iRkm85", "RdNjHU", "KnfaGy", "Z2WNfg", "c82kGR", "vj7UIZ", "jlzJCP", "SUHrgt",
	"LQb5zQ", "wS2ikm", "U+dVHJ", "zSewAP", "Yia9RU", "E2rHU1", "Zs5hdg", "W+HMod", "aEvHO2", "0V0Vsi", "ao3+bh",
	"jq1pVu", "cnxsQI", "DucvCS", "eiLp6/", "QqzfGy", "v4b/vj", "KThxfC", "iTb4WV", "QPNy0A",
	// Restarting the app.
	"OY2DWP", "jZlVjK", "/7L0mm", "cYp5zR", "bNBqoL", "X3Jhbz", "Up4sIJ",
	// The app's own UI.
	"uHzQat", "rPsbnH", "cbxuEo", "Xjpu13", "0+WgJu", "yvjVU9",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function renameText(text: string): string {
	return text.replace(OLD_NAME, APP_NAME);
}

/** A compiled message: an array of tokens (or, defensively, a bare string). */
function renameMessage(message: unknown): unknown {
	if (typeof message === "string") return renameText(message);
	if (!Array.isArray(message)) return message;
	return message.map(renameToken);
}

function renameToken(token: unknown): unknown {
	if (typeof token === "string") return renameText(token);
	if (!Array.isArray(token)) return token;
	if (token.length === 1 && token[0] === APP_NAME_PLACEHOLDER) return APP_NAME;
	const [name, format, options] = token as unknown[];
	if ((format === "plural" || format === "select" || format === "selectordinal") && isPlainObject(options)) {
		const renamed: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(options)) renamed[key] = Array.isArray(value) ? renameMessage(value) : value;
		return [name, format, renamed, ...token.slice(3)];
	}
	return token;
}

/** A renamed copy of a Lingui catalog, or `undefined` when it holds none of the renamed messages. */
export function renameCatalog(messages: unknown): Record<string, unknown> | undefined {
	if (!isPlainObject(messages)) return undefined;
	let changed = false;
	const result: Record<string, unknown> = { ...messages };
	for (const id of RENAMED_IDS) {
		if (!Object.hasOwn(messages, id)) continue;
		result[id] = renameMessage(messages[id]);
		changed = true;
	}
	return changed ? result : undefined;
}

/** The sidebar label component, rendered with the app's `jsx`. */
export function createSidebarBrand(jsx: JsxFn): () => unknown {
	return function BetterGrokBotSidebarBrand() {
		return jsx("div", { className: BRAND_LABEL_CLASS, children: APP_NAME });
	};
}

export const BRAND_CSS = `/* Agents sidebar: the Better Grok Bot label between the header buttons and the primary bot. */
.bgb-brand-label {
	flex-shrink: 0;
	padding: 0 16px 10px;
	color: var(--cursor-text-primary);
	font-size: 15px;
	font-weight: 600;
	letter-spacing: 0.01em;
	text-align: center;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	user-select: none;
}

/* The collapsed icon rail has no room for it. */
@container sand-sidebar (max-width: 130px) {
	.bgb-brand-label {
		display: none;
	}
}
`;
