import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { cfg } from "./config.js";
import { logger } from "./logger.js";

const log = logger.child({ mod: "recorder" });
const require = createRequire(import.meta.url);
const ffmpegStaticPath = require("ffmpeg-static") as string | null;

interface ActiveCapture {
  outFile: string;
  startedAt: number;
  ff: ChildProcess;
}

let active: ActiveCapture | null = null;

function resolveFfmpegPath(): string {
  if (!cfg.FFMPEG_PATH) return ffmpegStaticPath ?? "ffmpeg";
  if (fs.existsSync(cfg.FFMPEG_PATH)) return cfg.FFMPEG_PATH;
  const fallback = ffmpegStaticPath ?? "ffmpeg";
  log.warn({ configured: cfg.FFMPEG_PATH, fallback }, "configured ffmpeg path not found; using fallback");
  return fallback;
}

/**
 * Build ffmpeg args per-platform.
 *   - win32: gdigrab (screen) + dshow (audio device specified in cfg.WINDOWS_AUDIO_DEVICE)
 *   - linux: x11grab (DISPLAY) + pulse
 *   - darwin: avfoundation (best-effort, mostly untested)
 */
function buildFfmpegArgs(outFile: string): string[] {
  const v = cfg.CAPTURE_WIDTH;
  const h = cfg.CAPTURE_HEIGHT;
  const fps = String(cfg.CAPTURE_FPS);
  const commonVideo = [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
  ];
  const commonAudio = [
    "-c:a", "aac",
    "-b:a", "128k",
  ];
  const commonEnd = [
    "-movflags", "+faststart",
    outFile,
  ];

  if (process.platform === "win32") {
    const audioDevice = cfg.WINDOWS_AUDIO_DEVICE;
    const args: string[] = [
      "-y",
      "-thread_queue_size", "1024",
      "-f", "gdigrab",
      "-framerate", fps,
      "-video_size", `${v}x${h}`,
      "-offset_x", String(cfg.WINDOWS_GRAB_X),
      "-offset_y", String(cfg.WINDOWS_GRAB_Y),
      "-draw_mouse", "1",
      "-i", "desktop",
    ];
    if (audioDevice) {
      args.push(
        "-thread_queue_size", "1024",
        "-f", "dshow",
        "-i", `audio=${audioDevice}`
      );
    }
    return args.concat(commonVideo, audioDevice ? commonAudio : [], commonEnd);
  }

  if (process.platform === "darwin") {
    return [
      "-y",
      "-f", "avfoundation",
      "-framerate", fps,
      "-video_size", `${v}x${h}`,
      "-i", "1:0",
      ...commonVideo,
      ...commonAudio,
      ...commonEnd,
    ];
  }

  // linux (default)
  const display = process.env.DISPLAY ?? ":99";
  return [
    "-y",
    "-thread_queue_size", "1024",
    "-f", "x11grab",
    "-framerate", fps,
    "-video_size", `${v}x${h}`,
    "-i", display,
    "-thread_queue_size", "1024",
    "-f", "pulse",
    "-ac", "2",
    "-i", "default",
    ...commonVideo,
    ...commonAudio,
    ...commonEnd,
  ];
}

/**
 * Start an ffmpeg desktop capture using the platform-native source.
 */
export function startCapture(label: string): { outFile: string } {
  if (active) throw new Error("capture already running");
  fs.mkdirSync(cfg.OUTPUT_DIR, { recursive: true });
  const safeLabel = label.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 32);
  const outFile = path.join(
    cfg.OUTPUT_DIR,
    `${safeLabel}-${Date.now()}.mp4`
  );

  const args = buildFfmpegArgs(outFile);
  const ffPath = resolveFfmpegPath();
  log.info({ ffPath, args }, "spawning ffmpeg");
  const ff = spawn(ffPath, args);
  ff.stderr?.on("data", (d) => log.trace({ ff: d.toString() }, "ffmpeg"));
  ff.on("error", (err) => log.error({ err }, "ffmpeg spawn error"));
  ff.on("close", (code) => {
    log.info({ code, outFile }, "ffmpeg finished");
    active = null;
  });

  active = { outFile, startedAt: Date.now(), ff };
  log.info({ outFile, platform: process.platform }, "capture started");
  return { outFile };
}

export async function stopCapture(): Promise<{ outFile: string; durationMs: number } | null> {
  if (!active) return null;
  const a = active;
  try {
    a.ff.stdin?.write("q");
  } catch {
    /* ignore */
  }
  await new Promise<void>((resolve) => {
    a.ff.on("close", () => resolve());
    setTimeout(resolve, 5_000); // safety
  });
  return {
    outFile: a.outFile,
    durationMs: Date.now() - a.startedAt,
  };
}

export function isCapturing(): boolean {
  return active !== null;
}

export function currentCaptureInfo(): { outFile: string; startedAt: number } | null {
  if (!active) return null;
  return { outFile: active.outFile, startedAt: active.startedAt };
}
