import { expect, test } from "bun:test";
import { UsageError, parseArgs, subcommand } from "./args.ts";

test("parseArgs reads flags, both value spellings, aliases and passthrough", () => {
	const args = parseArgs(["-f", "--app=/a b", "pos", "--out", "x.zip", "--", "--remote-debugging-port=9333", "-x"], {
		flags: { "--follow": "boolean", "--app": "value", "--out": "value" },
		aliases: { "-f": "--follow" },
		max: 1,
		passthrough: true,
		usage: "u",
	});
	expect(args.has("--follow")).toBe(true);
	expect(args.value("--app")).toBe("/a b");
	expect(args.value("--out")).toBe("x.zip");
	expect(args.value("--follow")).toBeUndefined();
	expect(args.positionals).toEqual(["pos"]);
	expect(args.passthrough).toEqual(["--remote-debugging-port=9333", "-x"]);
});

test("parseArgs rejects unknown options, values on booleans, missing values, stray -- and wrong counts", () => {
	const spec = { flags: { "--yes": "boolean", "--app": "value" }, min: 1, usage: "bgb x <id>" } as const;
	for (const argv of [["id", "--nope"], ["id", "--yes=1"], ["id", "--app"], ["id", "--app", "--yes"], ["id", "--"], [], ["a", "b"]]) {
		expect(() => parseArgs(argv, spec)).toThrow(UsageError);
	}
	expect(() => parseArgs([], spec)).toThrow("usage: bgb x <id>");
});

test("subcommand falls back to the default only when none is given", () => {
	expect(subcommand([], ["list", "enable"], "u", "list")).toEqual(["list", []]);
	expect(subcommand(["enable", "x"], ["list", "enable"], "u", "list")).toEqual(["enable", ["x"]]);
	expect(() => subcommand(["frob"], ["list"], "u", "list")).toThrow('unknown subcommand "frob"');
	expect(() => subcommand([], ["get", "set"], "u")).toThrow("missing subcommand");
});
