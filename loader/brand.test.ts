import { describe, expect, test } from "bun:test";
import { renameCatalog } from "./brand.ts";

describe("renameCatalog", () => {
	test("renames listed messages in plain and inflected text", () => {
		const out = renameCatalog({ yvjVU9: ["Welcome to Grok Bot"], "0+WgJu": ["Vítá vás Grok Bot"], Zs5hdg: ["Grok Bot'tan çıkın"] });
		expect(out).toEqual({
			yvjVU9: ["Welcome to Better Grok Bot"],
			"0+WgJu": ["Vítá vás Better Grok Bot"],
			Zs5hdg: ["Better Grok Bot'tan çıkın"],
		});
	});

	test("replaces the app display-name placeholder and keeps other placeholders", () => {
		expect(renameCatalog({ uiPSBV: [["SAND_PRODUCT_DISPLAY_NAME"], " ", ["0"]] })).toEqual({
			uiPSBV: ["Better Grok Bot", " ", ["0"]],
		});
	});

	test("renames inside select and plural branches", () => {
		const out = renameCatalog({
			KnfaGy: [["0", "select", { update: ["Updating Grok Bot"], other: ["Grok Bot ", ["1"]] }]],
			c82kGR: [["n", "plural", { offset: 1, one: ["Grok Bot"], other: ["#"] }]],
		});
		expect(out).toEqual({
			KnfaGy: [["0", "select", { update: ["Updating Better Grok Bot"], other: ["Better Grok Bot ", ["1"]] }]],
			c82kGR: [["n", "plural", { offset: 1, one: ["Better Grok Bot"], other: ["#"] }]],
		});
	});

	test("leaves unlisted persona and OS-name messages alone", () => {
		const out = renameCatalog({
			yvjVU9: ["Welcome to Grok Bot"],
			iXLVub: ["Grok Bot's Computer"],
			d0DUPU: ["Turn on Grok Bot Computer Use in Privacy & Security → Automation"],
		});
		expect(out?.iXLVub).toEqual(["Grok Bot's Computer"]);
		expect(out?.d0DUPU).toEqual(["Turn on Grok Bot Computer Use in Privacy & Security → Automation"]);
	});

	test("is idempotent and does not mutate its input", () => {
		const input = { jlzJCP: ["Grok Bot ", ["0"], " is ready."], yvjVU9: [["SAND_PRODUCT_DISPLAY_NAME"]] };
		const snapshot = structuredClone(input);
		const out = renameCatalog(input);
		expect(input).toEqual(snapshot);
		expect(renameCatalog(out)).toEqual(out);
		expect(JSON.stringify(out)).not.toContain("Better Better");
	});

	test("returns undefined for non-objects and catalogs without listed ids", () => {
		expect(renameCatalog(undefined)).toBeUndefined();
		expect(renameCatalog(["x"])).toBeUndefined();
		expect(renameCatalog("Grok Bot")).toBeUndefined();
		expect(renameCatalog({ iXLVub: ["Grok Bot's Computer"] })).toBeUndefined();
	});
});
