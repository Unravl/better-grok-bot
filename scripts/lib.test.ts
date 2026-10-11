import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { downloadFilePath } from "./lib.ts";

const dir = path.resolve("cache", "upstream", "hash");

describe("downloadFilePath", () => {
	test("keeps the decoded file name of the URL", () => {
		expect(downloadFilePath(dir, "https://example.com/r/Grok%20Bot%201.2.0.dmg?x=1")).toBe(path.join(dir, "Grok Bot 1.2.0.dmg"));
	});

	test("an encoded traversal stays a direct child of the cache directory", () => {
		expect(downloadFilePath(dir, "https://example.com/r/%2e%2e%2f%2e%2e%2f%2e%2e%2funexpected.exe")).toBe(path.join(dir, "download.exe"));
		expect(downloadFilePath(dir, "https://example.com/r/..%5C..%5Cunexpected.exe")).toBe(path.join(dir, "download.exe"));
		expect(downloadFilePath(dir, "https://example.com/r/%2e%2e")).toBe(path.join(dir, "download"));
		expect(downloadFilePath(dir, "https://example.com/r/a%00b.deb")).toBe(path.join(dir, "download.deb"));
		expect(downloadFilePath(dir, "https://example.com/r/C%3Aevil.exe")).toBe(path.join(dir, "download.exe"));
	});

	test("an empty or undecodable last segment gets a plain name", () => {
		expect(downloadFilePath(dir, "https://example.com/")).toBe(path.join(dir, "download"));
		expect(downloadFilePath(dir, "https://example.com/r/bad%E0%A4%A.rpm")).toBe(path.join(dir, "bad%E0%A4%A.rpm"));
	});
});
