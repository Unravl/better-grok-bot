// Child process for core/state.test.ts: appends 200 entries to `notified[<name>]`, one mutateState each.
import { dataPaths } from "../paths.ts";
import { mutateState } from "../state.ts";

const [dataDir, name, countText] = process.argv.slice(2);
if (!dataDir || !name) throw new Error("usage: mutate-state-child.ts <dataDir> <name> [count]");
const paths = dataPaths(dataDir);
const count = Number(countText ?? 200);
for (let i = 0; i < count; i++) {
	await mutateState(paths, (state) => {
		(state.notified[name] ??= []).push(String(i));
	});
}
