import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DISCORD_USER_TOKEN: z.string().default(""),
  TARGET_GUILD_ID: z.string().min(5),
  TARGET_VOICE_CHANNEL_ID: z.string().min(5),

  // Bridge
  BOT_WS_URL: z.string().default("ws://localhost:8787"),
  BOT_AUTH_TOKEN: z.string().default("change-me"),
  LISTEN_PORT: z.coerce.number().int().default(8788),

  // Capture
  CAPTURE_WIDTH: z.coerce.number().int().default(1280),
  CAPTURE_HEIGHT: z.coerce.number().int().default(720),
  CAPTURE_FPS: z.coerce.number().int().default(15),
  OUTPUT_DIR: z.string().default("./out"),

  // Windows-specific
  WINDOWS_AUDIO_DEVICE: z.string().default(""), // e.g. "Stereo Mix (Realtek)" or "CABLE Output (VB-Audio Virtual Cable)"
  WINDOWS_GRAB_X: z.coerce.number().int().default(0),
  WINDOWS_GRAB_Y: z.coerce.number().int().default(0),

  // FFmpeg binary path. Leave empty to use the system PATH.
  FFMPEG_PATH: z.string().default(""),

  // Browser
  BROWSER_PROFILE_DIR: z.string().default("./companion-profile"),
  BROWSER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  HEADLESS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AUTO_JOIN_VOICE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ companion config invalid:");
  for (const i of parsed.error.issues) console.error(`  • ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}
if (parsed.data.BROWSER_ENABLED && parsed.data.DISCORD_USER_TOKEN.length < 20) {
  console.error("❌ companion config invalid:");
  console.error("  • DISCORD_USER_TOKEN: DISCORD_USER_TOKEN مفقود — راجع companion/.env أو استخدم BROWSER_ENABLED=false لتسجيل الشاشة فقط");
  process.exit(1);
}
export const cfg = parsed.data;
