const PREAMBLE =
	"$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";

/** Runs a Windows PowerShell script without a window and returns its stdout (trailing whitespace trimmed). */
export async function runPowerShell(script: string, opts: { timeoutMs?: number } = {}): Promise<string> {
	const encoded = Buffer.from(PREAMBLE + script, "utf16le").toString("base64");
	const proc = Bun.spawn(
		["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: opts.timeoutMs ?? 60_000 },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`PowerShell exited with ${code}: ${stderr.trim() || stdout.trim() || "no output"}`);
	}
	return stdout.trimEnd();
}
