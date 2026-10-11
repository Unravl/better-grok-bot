/**
 * Renderer loader entry, bundled by `core/scripts/embed.ts` as an IIFE into `LOADER_JS` and
 * written after the boot payload into `assets/bgb/boot.js`.
 */
import { boot } from "./boot.ts";

boot();
