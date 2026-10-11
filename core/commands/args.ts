/** A wrong command line; the CLI prints it and exits with code 2. */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export interface ArgSpec {
	/** Accepted flags (`--yes`) and options taking a value (`--app <path>` or `--app=<path>`). */
	flags?: Readonly<Record<string, "boolean" | "value">>;
	/** Short spellings, e.g. `{"-f": "--follow"}`. */
	aliases?: Readonly<Record<string, string>>;
	/** Positional argument count bounds (default 0..0). */
	min?: number;
	max?: number;
	/** Accept `--` followed by arguments passed through untouched. */
	passthrough?: boolean;
	/** Shown in usage errors, e.g. `bgb build [--force] [--app <path>] [--json]`. */
	usage: string;
}

export interface ParsedArgs {
	readonly positionals: readonly string[];
	readonly passthrough: readonly string[];
	has(flag: string): boolean;
	value(option: string): string | undefined;
}

/** Parses one command's arguments (grok-mods style: explicit allow-list, errors name the bad token). */
export function parseArgs(argv: readonly string[], spec: ArgSpec): ParsedArgs {
	const flags = spec.flags ?? {};
	const positionals: string[] = [];
	const values = new Map<string, string | true>();
	let passthrough: string[] = [];
	const fail = (message: string): never => {
		throw new UsageError(`${message}\nusage: ${spec.usage}`);
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--") {
			if (!spec.passthrough) fail(`unexpected "--"`);
			passthrough = argv.slice(index + 1);
			break;
		}
		if (!arg.startsWith("-") || arg === "-") {
			positionals.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const rawName = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
		const name = spec.aliases?.[rawName] ?? rawName;
		const kind = flags[name];
		if (kind === undefined) fail(`unknown option ${rawName}`);
		if (kind === "boolean") {
			if (rawName !== arg) fail(`${name} takes no value`);
			values.set(name, true);
			continue;
		}
		let value: string | undefined;
		if (rawName !== arg) value = arg.slice(eq + 1);
		else {
			value = argv[++index];
			if (value === undefined || (value.startsWith("--") && value.length > 2)) fail(`${name} needs a value`);
		}
		values.set(name, value ?? "");
	}
	const min = spec.min ?? 0;
	const max = spec.max ?? min;
	if (positionals.length < min) fail("missing argument");
	if (positionals.length > max) fail(`unexpected argument "${positionals[max]}"`);
	return {
		positionals,
		passthrough,
		has: (flag) => values.has(flag),
		value: (option) => {
			const value = values.get(option);
			return typeof value === "string" ? value : undefined;
		},
	};
}

/** Splits `<sub> …rest` for commands with subcommands; `fallback` applies when no subcommand is given. */
export function subcommand(
	argv: readonly string[],
	known: readonly string[],
	usage: string,
	fallback?: string,
): [string, readonly string[]] {
	const [first, ...rest] = argv;
	if (first === undefined || first.startsWith("-")) {
		if (fallback !== undefined) return [fallback, argv];
		throw new UsageError(`missing subcommand\nusage: ${usage}`);
	}
	if (!known.includes(first)) throw new UsageError(`unknown subcommand "${first}"\nusage: ${usage}`);
	return [first, rest];
}
