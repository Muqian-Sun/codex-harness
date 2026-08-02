import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rendererOutput = fileURLToPath(new URL("../apps/desktop/dist/renderer", import.meta.url));

await rm(rendererOutput, { force: true, recursive: true });
