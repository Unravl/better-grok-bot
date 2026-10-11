import { expect, test } from "bun:test";
import * as path from "node:path";

/** Runs `confirm(question, defaultYes)` in a child whose stdin is `input` (closed afterwards). */
async function confirmWith(input: string, defaultYes: boolean): Promise<string> {
	const prompt = path.join(import.meta.dir, "prompt.ts");
	const script = `import { confirm } from ${JSON.stringify(prompt)}; console.log("=" + (await confirm("Allow?", ${defaultYes})));`;
	const proc = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
	proc.stdin.write(input);
	await proc.stdin.end();
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(code).toBe(0);
	return out;
}

test("confirm prints the question with the default's suffix and reads one answer", async () => {
	expect(await confirmWith("y\n", false)).toBe("Allow? [y/N] =true\n");
	expect(await confirmWith("YES\n", false)).toBe("Allow? [y/N] =true\n");
	expect(await confirmWith("n\n", true)).toBe("Allow? [Y/n] =false\n");
	expect(await confirmWith("maybe\n", true)).toBe("Allow? [Y/n] =false\n");
});

test("an empty answer takes the default and end of input means no", async () => {
	expect(await confirmWith("\n", true)).toBe("Allow? [Y/n] =true\n");
	expect(await confirmWith("\n", false)).toBe("Allow? [y/N] =false\n");
	expect(await confirmWith("", true)).toBe("Allow? [Y/n] =false\n");
});
