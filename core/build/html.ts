import { stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { INJECT_DIR } from "../../sdk/index.ts";

/**
 * Inserts the BGB script tags immediately before the first `<script`: `boot.js` (boot payload + loader),
 * then one `plugins/<id>.js` per plugin runtime, tagged `data-bgb-plugin="<id>"` for `define`'s identity check.
 */
export function injectScripts(html: string, pluginIds: readonly string[]): string {
	const at = html.search(/<script/i);
	if (at === -1) throw new Error("renderer index.html has no <script> tag to inject before");
	const indent = /[ \t]*$/.exec(html.slice(0, at))?.[0] ?? "";
	const tags = [
		`<script src="./${INJECT_DIR}/boot.js"></script>`,
		...pluginIds.map((id) => `<script src="./${INJECT_DIR}/plugins/${id}.js" data-bgb-plugin="${id}"></script>`),
	];
	return html.slice(0, at) + tags.map((tag) => `${tag}\n${indent}`).join("") + html.slice(at);
}

const TOKEN = /<!--[\s\S]*?-->|<(script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>|<[A-Za-z][^>]*>/gi;
const ATTRIBUTE = /(\s)(src|href)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Rewrites every relative `src`/`href` attribute (no scheme, not starting with `/` or `#`) in the tags of
 * `html` to the absolute `file:` URL of its target inside `finalRenderer` (the build's published renderer
 * dir), so a page keeps loading its own build's files whatever `current` points at. `stagingRenderer` is
 * where the files are now; a target missing there throws `unresolved renderer reference <value> in <file>`.
 * Comments and the bodies of `<script>`/`<style>` elements are left alone.
 */
export async function pinResources(
	html: string,
	htmlFile: string,
	stagingRenderer: string,
	finalRenderer: string,
): Promise<string> {
	const base = pathToFileURL(path.join(finalRenderer, ...htmlFile.split("/")));
	const references: { value: string; url: URL }[] = [];
	const rewriteTag = (tag: string): string =>
		tag.replace(ATTRIBUTE, (whole: string, space: string, name: string, equals: string, double?: string, single?: string, bare?: string) => {
			const value = double ?? single ?? bare ?? "";
			if (value === "" || SCHEME.test(value) || value.startsWith("/") || value.startsWith("#")) return whole;
			const url = new URL(value, base);
			references.push({ value, url });
			return `${space}${name}${equals}"${url.href}"`;
		});
	const pinned = html.replace(TOKEN, (token: string, element?: string, attributes?: string) => {
		if (token.startsWith("<!--")) return token;
		if (element !== undefined && attributes !== undefined) {
			const openLength = element.length + 1 + attributes.length + 1;
			return `<${element}${rewriteTag(attributes)}>${token.slice(openLength)}`;
		}
		return rewriteTag(token);
	});
	for (const { value, url } of references) {
		const target = new URL(url.href);
		target.search = "";
		target.hash = "";
		const relative = path.relative(finalRenderer, fileURLToPath(target));
		const staged = relative.startsWith("..") || path.isAbsolute(relative) ? undefined : path.join(stagingRenderer, relative);
		const exists = staged !== undefined && (await stat(staged).catch(() => undefined))?.isFile() === true;
		if (!exists) throw new Error(`unresolved renderer reference ${value} in ${htmlFile}`);
	}
	return pinned;
}
