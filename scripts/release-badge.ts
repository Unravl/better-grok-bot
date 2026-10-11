/**
 * The README's "release vX.Y.Z" badge as a self-hosted SVG in shields.io's flat style. It lives in the
 * repo (docs/assets/badges/release.svg, rewritten by bump-version) because shields' GitHub-backed
 * badges time out behind GitHub's image proxy and render as broken images.
 */

/** Verdana 11 px advance widths, as shields.io measures them; other characters count as 6.6 px. */
const WIDTHS: Record<string, number> = { ".": 3.52, "-": 4.66, "+": 9.17, v: 6.5 };
for (const digit of "0123456789") WIDTHS[digit] = 7;

const LABEL_WIDTH = 49; // "release" (39 px) plus padding, as shields renders it

export function releaseBadgeSvg(version: string): string {
	const message = `v${version}`;
	const textWidth = Math.round([...message].reduce((sum, char) => sum + (WIDTHS[char] ?? 6.6), 0));
	const messageWidth = textWidth + 10;
	const width = LABEL_WIDTH + messageWidth;
	const x = (LABEL_WIDTH + messageWidth / 2 - 1) * 10; // shields nudges the message 1 px left
	const text = (y: number, extra: string) => `<text x="${x}" y="${y}"${extra} textLength="${textWidth * 10}">${message}</text>`;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="release: ${message}"><title>release: ${message}</title>` +
		`<filter id="blur"><feGaussianBlur stdDeviation="16"/></filter><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
		`<clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${LABEL_WIDTH}" height="20" fill="#555"/><rect x="${LABEL_WIDTH}" width="${messageWidth}" height="20" fill="#007ec6"/><rect width="${width}" height="20" fill="url(#s)"/></g>` +
		`<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">` +
		`<g transform="scale(.1)"><g aria-hidden="true" fill="#010101"><text x="255" y="150" fill-opacity=".8" filter="url(#blur)" textLength="390">release</text><text x="255" y="150" fill-opacity=".3" textLength="390">release</text></g><text x="255" y="140" textLength="390">release</text></g>` +
		`<g transform="scale(.1)"><g aria-hidden="true" fill="#010101">${text(150, ' fill-opacity=".8" filter="url(#blur)"')}${text(150, ' fill-opacity=".3"')}</g>${text(140, "")}</g></g></svg>\n`
	);
}
