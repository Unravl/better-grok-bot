import { createInterface } from "node:readline";

/** True when stdin is a terminal, so prompts can be answered. */
export function isInteractive(): boolean {
	return process.stdin.isTTY === true;
}

/**
 * Asks `question` followed by ` [Y/n]` or ` [y/N]` and reads one line from stdin. An empty answer takes
 * the default; `y`/`yes` (any case) is yes, anything else no. End of input counts as no.
 */
export async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
	// `terminal: false` keeps the TTY in cooked mode, so Ctrl+C still delivers SIGINT to the process.
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
	try {
		const answer = await new Promise<string | null>((resolve) => {
			rl.once("close", () => resolve(null));
			rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, resolve);
		});
		if (answer === null) return false;
		const trimmed = answer.trim();
		return trimmed === "" ? defaultYes : /^y(?:es)?$/i.test(trimmed);
	} finally {
		rl.close();
	}
}
