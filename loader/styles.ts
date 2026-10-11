import type { BootPayload } from "../sdk/index.ts";

export interface StyleManager {
	/** Boot styles (plugins, then enabled themes) as `<style data-bgb-style="<kind>:<id>">`. */
	inject(styles: BootPayload["styles"]): void;
	/** Replaces every `<style data-bgb-style="theme:*">` with these. */
	replaceThemes(styles: readonly { id: string; css: string }[]): void;
}

const STYLE_SELECTOR = "style[data-bgb-style]";
const THEME_SELECTOR = 'style[data-bgb-style^="theme:"]';

export function createStyleManager(doc: Document): StyleManager {
	const container = (): HTMLElement => doc.head ?? doc.documentElement;

	const element = (kind: "plugin" | "theme", id: string, css: string): HTMLStyleElement => {
		const style = doc.createElement("style");
		style.dataset.bgbStyle = `${kind}:${id}`;
		style.textContent = css;
		return style;
	};

	return Object.freeze({
		inject(styles: BootPayload["styles"]): void {
			const append = (): void => {
				container().append(...styles.map((style) => element(style.kind, style.id, style.css)));
			};
			if (doc.readyState !== "loading") {
				append();
				return;
			}
			if (doc.head === null) doc.addEventListener("DOMContentLoaded", append, { once: true });
			else append();
			// boot.js runs ahead of the app's stylesheets; move ours after them so equal-specificity rules win.
			doc.addEventListener("DOMContentLoaded", () => container().append(...doc.querySelectorAll(STYLE_SELECTOR)), { once: true });
		},

		replaceThemes(styles: readonly { id: string; css: string }[]): void {
			for (const old of doc.querySelectorAll(THEME_SELECTOR)) old.remove();
			container().append(...styles.map((style) => element("theme", style.id, style.css)));
		},
	});
}
