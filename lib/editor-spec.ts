import { readFileSync } from "fs";
import { join } from "path";

const specPath = join(process.cwd(), "editor-spec.md");

export const EDITOR_PUBLISHING_SPEC: string = readFileSync(specPath, "utf-8").trim();
