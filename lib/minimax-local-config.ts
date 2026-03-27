import fs from "node:fs";
import path from "node:path";

/** 与仓库根目录下 minimax.local.json 对应（已加入 .gitignore，仅本地使用） */
export type MinimaxLocalConfig = {
  apiKey?: string;
  anthropicBase?: string;
  model?: string;
  anthropicVersion?: string;
};

const CONFIG_FILENAME = "minimax.local.json";

export function readMinimaxLocalConfig(): MinimaxLocalConfig {
  const fp = path.join(process.cwd(), CONFIG_FILENAME);
  if (!fs.existsSync(fp)) return {};
  try {
    const raw = fs.readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      apiKey:
        typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : undefined,
      anthropicBase:
        typeof parsed.anthropicBase === "string"
          ? parsed.anthropicBase.trim()
          : undefined,
      model:
        typeof parsed.model === "string" ? parsed.model.trim() : undefined,
      anthropicVersion:
        typeof parsed.anthropicVersion === "string"
          ? parsed.anthropicVersion.trim()
          : undefined,
    };
  } catch {
    return {};
  }
}
