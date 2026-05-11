import "dotenv/config";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const schema = z.object({
  DISCORD_TOKEN: z.string().min(20, "DISCORD_TOKEN مفقود — راجع bot/.env"),
  DISCORD_APP_ID: z.string().min(10, "DISCORD_APP_ID مفقود"),
  DEFAULT_GUILD_ID: z.string().optional().default(""),
  OWNER_ID: z.string().optional().default(""),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  DATABASE_PATH: z.string().default("./data/bot.sqlite"),
  RECORDINGS_DIR: z.string().default("./data/recordings"),
  MAX_BUFFER_MINUTES: z.coerce.number().int().min(1).max(120).default(30),
  RENDER_QUALITY: z.enum(["low", "medium", "high"]).default("medium"),
  BOT_WS_URL: z.string().optional().default(""),
  BOT_AUTH_TOKEN: z.string().optional().default(""),
  COMPANION_WS_URL: z.string().optional().default(""),
  COMPANION_AUTH_TOKEN: z.string().optional().default(""),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("\n❌ خطأ في إعدادات البيئة (bot/.env):");
  for (const issue of parsed.error.issues) {
    console.error(`  • ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error(
    "\nانسخ bot/.env.example إلى bot/.env واملأ القيم المطلوبة.\n"
  );
  process.exit(1);
}

const e = parsed.data;

const companionWsUrl = e.COMPANION_WS_URL || companionListenUrl(e.BOT_WS_URL);
const companionAuthToken = e.COMPANION_AUTH_TOKEN || e.BOT_AUTH_TOKEN;

function resolveData(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
}

function companionListenUrl(botWsUrl: string): string {
  try {
    const url = new URL(botWsUrl);
    const port = Number.parseInt(url.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65534) return "";
    url.port = String(port + 1);
    return url.toString();
  } catch {
    return "";
  }
}

export const env = {
  ...e,
  COMPANION_WS_URL: companionWsUrl,
  COMPANION_AUTH_TOKEN: companionAuthToken,
  DATABASE_PATH: resolveData(e.DATABASE_PATH),
  RECORDINGS_DIR: resolveData(e.RECORDINGS_DIR),
  REPO_ROOT: repoRoot,
} as const;

export type Env = typeof env;
