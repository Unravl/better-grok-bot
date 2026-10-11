import packageJson from "../package.json";

/** Replaced with `true` by `bun build --compile --define BGB_COMPILED=true`; undeclared at runtime otherwise. */
declare const BGB_COMPILED: boolean | undefined;

export const BGB_VERSION: string = packageJson.version;

const compiled = typeof BGB_COMPILED !== "undefined" && BGB_COMPILED === true;
/** True inside the compiled `bgb` binary, false when run from a checkout with `bun`. */
export { compiled as BGB_COMPILED };
