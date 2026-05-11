import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import ffmpegPathModule from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { spawn } from "node:child_process";
import { createCanvas, loadImage, GlobalFonts, type Image } from "@napi-rs/canvas";
import { logger } from "../../utils/logger.js";
import { Palette } from "../../utils/colors.js";
import { SAMPLE_RATE, CHANNELS } from "./rollingBuffer.js";
import type { ChatMsg, EditOptions, VoiceEvent } from "./types.js";

const ffmpegPath = ffmpegPathModule as unknown as string | null;
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
const log = logger.child({ mod: "renderer" });

try {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
    "/usr/share/fonts/TTF/NotoSansArabic-Regular.ttf",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      GlobalFonts.registerFromPath(c, "BotUI");
      break;
    }
  }
} catch { /* ignore */ }

export interface UserAudio {
  userId: string;
  username: string;
  avatarUrl: string;
  pcmFile: string;
  bytesWritten: number;
}

export interface RenderArgs {
  outDir: string;
  outFile: string;
  durationSec: number;
  users: UserAudio[];
  events: VoiceEvent[];
  chat: ChatMsg[];
  quality: "low" | "medium" | "high";
  edit?: EditOptions;
  title?: string;
}

const QUALITY = {
  low:    { width: 854,  height: 480,  fps: 15, audioBitrate: "128k", videoBitrate: "800k"  },
  medium: { width: 1280, height: 720,  fps: 24, audioBitrate: "160k", videoBitrate: "2000k" },
  high:   { width: 1920, height: 1080, fps: 30, audioBitrate: "192k", videoBitrate: "4500k" },
} as const;

// ── macOS / Discord Design Tokens ──────────────────────────

const MAC = {
  // Menu bar
  menuBarH: 25,
  menuBarBg: "rgba(247, 247, 248, 0.74)",
  menuBarText: "#161617",
  menuBarTextDim: "#4c4c4f",
  // Desktop wallpaper
  wallA: "#f6c1d0",
  wallB: "#8577f4",
  wallC: "#4f8ff8",
  wallD: "#101628",
  // Window chrome
  titleBarH: 34,
  titleBarBg: "#2b2d31",
  dotClose: "#ff5f57",
  dotMinimize: "#febc2e",
  dotMaximize: "#28c840",
  winRadius: 13,
  winShadow: "rgba(0, 0, 0, 0.42)",
} as const;

const DC = {
  // Discord colors
  serverRailBg: "#1e1f22",
  serverRailW: 72,
  sidebarBg: "#2b2d31",
  sidebarW: 240,
  channelText: "#949ba4",
  channelActive: "#ffffff",
  channelActiveBg: "rgba(255, 255, 255, 0.06)",
  channelHover: "#dbdee1",
  mainBg: "#313338",
  headerBg: "#313338",
  headerBorder: "#3f4147",
  headerText: "#f2f3f5",
  chatBg: "#313338",
  msgAuthor: "#f2f3f5",
  msgText: "#dbdee1",
  msgTextDim: "#949ba4",
  msgTimestamp: "#949ba4",
  inputBg: "#383a40",
  inputPlaceholder: "#6d6f78",
  voiceConnected: "#23a559",
  voiceUser: "#b5bac1",
  voiceSpeaking: "#23a559",
  voiceSpeakingBg: "rgba(35, 165, 89, 0.12)",
  userCardBg: "#2b2d31",
  userCardBgAlt: "#25262b",
  statusGreen: "#23a559",
  statusRed: "#f23f43",
  blurple: "#5865f2",
  roleDot: "#5865f2",
} as const;

// ── Audio Mixing ───────────────────────────────────────────

async function mixAudio(args: RenderArgs): Promise<string> {
  const { users, edit, outDir, durationSec } = args;
  const mixedPath = path.join(outDir, "mixed.wav");
  if (users.length === 0) {
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input("anullsrc=r=48000:cl=stereo")
        .inputOptions(["-f", "lavfi", "-t", String(durationSec)])
        .audioCodec("pcm_s16le")
        .save(mixedPath)
        .on("end", () => resolve())
        .on("error", reject);
    });
    return mixedPath;
  }
  await new Promise<void>((resolve, reject) => {
    let cmd = ffmpeg();
    const filterParts: string[] = [];
    const amixLabels: string[] = [];
    users.forEach((u, idx) => {
      cmd = cmd.input(u.pcmFile).inputOptions([
        "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS),
      ]);
      const vol = edit?.perUser?.[u.userId]?.mute ? 0 : edit?.perUser?.[u.userId]?.volume ?? 1;
      filterParts.push(`[${idx}:a]volume=${vol}[a${idx}]`);
      amixLabels.push(`[a${idx}]`);
    });
    const amix = `${amixLabels.join("")}amix=inputs=${users.length}:normalize=0:duration=longest[aout]`;
    cmd
      .complexFilter([...filterParts, amix])
      .outputOptions(["-map", "[aout]"])
      .audioCodec("pcm_s16le")
      .save(mixedPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err));
  });
  return mixedPath;
}

// ── Voice Status Tracking ──────────────────────────────────

interface UserStatus {
  speaking: boolean;
  camera: boolean;
  share: boolean;
  selfMute: boolean;
  serverMute: boolean;
}

function emptyStatus(): UserStatus {
  return { speaking: false, camera: false, share: false, selfMute: false, serverMute: false };
}

function applyEvent(status: UserStatus, ev: VoiceEvent): UserStatus {
  switch (ev.kind) {
    case "speaking_start": status.speaking = true; break;
    case "speaking_stop": status.speaking = false; break;
    case "camera_on": status.camera = true; break;
    case "camera_off": status.camera = false; break;
    case "share_start": status.share = true; break;
    case "share_stop": status.share = false; break;
    case "self_mute": status.selfMute = true; break;
    case "self_unmute": status.selfMute = false; break;
    case "server_mute": status.serverMute = true; break;
    case "server_unmute": status.serverMute = false; break;
  }
  return status;
}

// ── Main Render Entry ──────────────────────────────────────

export async function renderRecording(args: RenderArgs): Promise<string> {
  const { width, height, fps, audioBitrate, videoBitrate } = QUALITY[args.quality];
  const totalSec = args.durationSec;
  const totalFrames = Math.max(1, Math.floor(totalSec * fps));

  log.info({ users: args.users.length, durationSec: totalSec, totalFrames, quality: args.quality }, "render start");

  const mixedWav = await mixAudio(args);
  if (!ffmpegPath) throw new Error("ffmpeg binary not available");

  const ff = spawn(ffmpegPath, [
    "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps),
    "-i", "pipe:0",
    "-i", mixedWav,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "veryfast", "-b:v", videoBitrate, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", audioBitrate,
    "-shortest", "-movflags", "+faststart",
    args.outFile,
  ]);

  ff.stderr.on("data", (d) => log.trace({ ff: d.toString() }, "ffmpeg"));
  const ffDone = new Promise<void>((resolve, reject) => {
    ff.on("close", (code) => { if (code === 0) resolve(); else reject(new Error(`ffmpeg exited with ${code}`)); });
    ff.on("error", reject);
  });

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const avatarImgs = new Map<string, Image | null>();
  await Promise.all(
    args.users.map(async (u) => {
      if (!u.avatarUrl) { avatarImgs.set(u.userId, null); return; }
      try { avatarImgs.set(u.userId, await loadImage(u.avatarUrl)); }
      catch { avatarImgs.set(u.userId, null); }
    })
  );

  const userStatusInit: Record<string, UserStatus> = {};
  for (const u of args.users) userStatusInit[u.userId] = emptyStatus();
  const sortedEvents = [...args.events].sort((a, b) => a.ts - b.ts);
  let eventIdx = 0;
  const liveStatus = JSON.parse(JSON.stringify(userStatusInit)) as Record<string, UserStatus>;
  const speakEnvelope = computeEnvelope(args.users, fps, totalSec);

  for (let frame = 0; frame < totalFrames; frame++) {
    const tMs = (frame / fps) * 1000;
    while (eventIdx < sortedEvents.length && sortedEvents[eventIdx]!.ts <= tMs) {
      const ev = sortedEvents[eventIdx]!;
      if (!liveStatus[ev.userId]) liveStatus[ev.userId] = emptyStatus();
      applyEvent(liveStatus[ev.userId]!, ev);
      eventIdx++;
    }

    drawFrame(ctx, width, height, {
      title: args.title ?? "Voice Recording",
      users: args.users,
      avatarImgs,
      status: liveStatus,
      envelope: speakEnvelope[frame] ?? {},
      chat: args.chat,
      tMs,
      totalMs: totalSec * 1000,
    });

    const rgba = ctx.getImageData(0, 0, width, height).data;
    if (!ff.stdin.write(Buffer.from(rgba.buffer))) {
      await new Promise<void>((r) => ff.stdin.once("drain", () => r()));
    }
  }
  ff.stdin.end();
  await ffDone;
  log.info({ out: args.outFile }, "render done");
  return args.outFile;
}

// ── Envelope Computation ───────────────────────────────────

function computeEnvelope(users: UserAudio[], fps: number, totalSec: number): Array<Record<string, number>> {
  const totalFrames = Math.max(1, Math.floor(totalSec * fps));
  const out: Array<Record<string, number>> = Array.from({ length: totalFrames }, () => ({}));
  const samplesPerFrame = Math.floor(SAMPLE_RATE / fps);
  const bytesPerFrame = samplesPerFrame * CHANNELS * 2;
  for (const u of users) {
    let fd: number;
    try { fd = fs.openSync(u.pcmFile, "r"); } catch { continue; }
    const buf = Buffer.alloc(bytesPerFrame);
    for (let f = 0; f < totalFrames; f++) {
      let n = 0;
      try { n = fs.readSync(fd, buf, 0, bytesPerFrame, f * bytesPerFrame); } catch { n = 0; }
      if (n <= 0) { out[f]![u.userId] = 0; continue; }
      let sum = 0; let count = 0;
      for (let i = 0; i < n - 1; i += 32) { sum += Math.abs(buf.readInt16LE(i)); count++; }
      out[f]![u.userId] = Math.min(1, (count > 0 ? sum / count : 0) / 8000);
    }
    fs.closeSync(fd);
  }
  return out;
}

// ── Drawing Primitives ─────────────────────────────────────

type Ctx = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawCircle(ctx: Ctx, cx: number, cy: number, r: number, fill: string): void {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ── Main Frame ─────────────────────────────────────────────

interface FrameArgs {
  title: string;
  users: UserAudio[];
  avatarImgs: Map<string, Image | null>;
  status: Record<string, UserStatus>;
  envelope: Record<string, number>;
  chat: ChatMsg[];
  tMs: number;
  totalMs: number;
}

function drawFrame(ctx: Ctx, W: number, H: number, args: FrameArgs): void {
  const s = W / 1920;

  const wallGrad = ctx.createLinearGradient(0, 0, W, H);
  wallGrad.addColorStop(0, MAC.wallA);
  wallGrad.addColorStop(0.34, MAC.wallB);
  wallGrad.addColorStop(0.68, MAC.wallC);
  wallGrad.addColorStop(1, MAC.wallD);
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = 0.38;
  const radGrad1 = ctx.createRadialGradient(W * 0.22, H * 0.08, 0, W * 0.22, H * 0.08, H * 0.72);
  radGrad1.addColorStop(0, "#ffe7ef");
  radGrad1.addColorStop(1, "transparent");
  ctx.fillStyle = radGrad1;
  ctx.fillRect(0, 0, W, H);
  const radGrad2 = ctx.createRadialGradient(W * 0.78, H * 0.72, 0, W * 0.78, H * 0.72, H * 0.58);
  radGrad2.addColorStop(0, "#82d4ff");
  radGrad2.addColorStop(1, "transparent");
  ctx.fillStyle = radGrad2;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  const mbH = Math.round(MAC.menuBarH * s);
  ctx.save();
  ctx.fillStyle = MAC.menuBarBg;
  ctx.fillRect(0, 0, W, mbH);
  ctx.strokeStyle = "rgba(255,255,255,0.26)";
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0, mbH); ctx.lineTo(W, mbH); ctx.stroke();
  ctx.restore();

  // Apple logo (left)
  ctx.save();
  ctx.fillStyle = MAC.menuBarText;
  ctx.font = `${Math.round(14 * s)}px BotUI`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("●", Math.round(14 * s), mbH / 2);
  ctx.font = `bold ${Math.round(12.5 * s)}px BotUI`;
  ctx.fillText("Discord", Math.round(36 * s), mbH / 2);
  ctx.font = `${Math.round(12 * s)}px BotUI`;
  ctx.fillStyle = MAC.menuBarText;
  const menuItems = ["File", "Edit", "View", "Window", "Help"];
  let mx = Math.round(90 * s);
  for (const item of menuItems) {
    ctx.fillText(item, mx, mbH / 2);
    mx += Math.round(ctx.measureText(item).width + 18 * s);
  }
  ctx.restore();

  ctx.save();
  ctx.fillStyle = MAC.menuBarText;
  ctx.font = `${Math.round(12 * s)}px BotUI`;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  ctx.fillText(timeStr, W - Math.round(14 * s), mbH / 2);
  ctx.fillStyle = MAC.menuBarTextDim;
  ctx.fillText("▰ 􀙇 􀙇", W - Math.round(80 * s), mbH / 2);
  ctx.restore();

  // ── 3. Discord Window ──────────────────────────────────
  const winMargin = Math.round(20 * s);
  const winX = winMargin;
  const winY = mbH + Math.round(8 * s);
  const winW = W - winMargin * 2;
  const winH = H - winY - winMargin;
  const winR = Math.round(MAC.winRadius * s);

  // Window shadow
  ctx.save();
  ctx.shadowColor = MAC.winShadow;
  ctx.shadowBlur = Math.round(40 * s);
  ctx.shadowOffsetY = Math.round(10 * s);
  ctx.fillStyle = DC.mainBg;
  roundRect(ctx, winX, winY, winW, winH, winR);
  ctx.fill();
  ctx.restore();

  // Window body
  ctx.save();
  roundRect(ctx, winX, winY, winW, winH, winR);
  ctx.clip();

  // ── 3a. Title Bar ──────────────────────────────────────
  const tbH = Math.round(MAC.titleBarH * s);
  ctx.fillStyle = MAC.titleBarBg;
  ctx.fillRect(winX, winY, winW, tbH);
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(winX, winY + tbH); ctx.lineTo(winX + winW, winY + tbH); ctx.stroke();

  // Traffic lights
  const dotR = Math.round(6 * s);
  const dotY = winY + tbH / 2;
  const dotStart = winX + Math.round(16 * s);
  const dotGap = Math.round(20 * s);
  drawCircle(ctx, dotStart, dotY, dotR, MAC.dotClose);
  drawCircle(ctx, dotStart + dotGap, dotY, dotR, MAC.dotMinimize);
  drawCircle(ctx, dotStart + dotGap * 2, dotY, dotR, MAC.dotMaximize);

  ctx.fillStyle = "#b5bac1";
  ctx.font = `${Math.round(12.5 * s)}px BotUI`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("Discord", winX + winW / 2, dotY);

  const railW = Math.round(DC.serverRailW * s);
  const railX = winX;
  const railY = winY + tbH;
  const railH = winH - tbH;
  ctx.fillStyle = DC.serverRailBg;
  ctx.fillRect(railX, railY, railW, railH);

  const serverIconX = railX + railW / 2;
  let serverIconY = railY + Math.round(34 * s);
  drawCircle(ctx, serverIconX, serverIconY, Math.round(22 * s), DC.blurple);
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(18 * s)}px BotUI`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("✦", serverIconX, serverIconY);
  serverIconY += Math.round(54 * s);
  for (let i = 0; i < 4; i++) {
    drawCircle(ctx, serverIconX, serverIconY, Math.round(20 * s), "#313338");
    ctx.fillStyle = "#dbdee1";
    ctx.font = `bold ${Math.round(13 * s)}px BotUI`;
    ctx.fillText(String(i + 1), serverIconX, serverIconY);
    serverIconY += Math.round(48 * s);
  }

  const sbW = Math.round(DC.sidebarW * s);
  const sbX = winX + railW;
  const sbY = winY + tbH;
  const sbH = winH - tbH;

  ctx.fillStyle = DC.sidebarBg;
  ctx.fillRect(sbX, sbY, sbW, sbH);
  ctx.strokeStyle = "rgba(0,0,0,0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(sbX + sbW, sbY); ctx.lineTo(sbX + sbW, sbY + sbH); ctx.stroke();

  // Server name header
  ctx.fillStyle = DC.headerText;
  ctx.font = `bold ${Math.round(14 * s)}px BotUI`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Faisal Server", sbX + Math.round(16 * s), sbY + Math.round(22 * s));

  // Channels
  const chY = sbY + Math.round(50 * s);
  ctx.fillStyle = DC.channelText;
  ctx.font = `bold ${Math.round(10.5 * s)}px BotUI`;
  ctx.fillText("TEXT CHANNELS", sbX + Math.round(16 * s), chY);

  ctx.font = `${Math.round(13 * s)}px BotUI`;
  ctx.fillStyle = DC.channelText;
  ctx.fillText("# general", sbX + Math.round(16 * s), chY + Math.round(24 * s));
  ctx.fillText("# chat", sbX + Math.round(16 * s), chY + Math.round(48 * s));

  const vcHeaderY = chY + Math.round(80 * s);
  ctx.fillStyle = DC.channelText;
  ctx.font = `bold ${Math.round(10.5 * s)}px BotUI`;
  ctx.fillText("VOICE CHANNELS", sbX + Math.round(16 * s), vcHeaderY);

  // Active voice channel (highlighted)
  const vcY = vcHeaderY + Math.round(20 * s);
  ctx.save();
  ctx.fillStyle = DC.channelActiveBg;
  roundRect(ctx, sbX + Math.round(8 * s), vcY - Math.round(4 * s), sbW - Math.round(16 * s), Math.round(28 * s), Math.round(4 * s));
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = DC.channelActive;
  ctx.font = `600 ${Math.round(13 * s)}px BotUI`;
  ctx.fillText("🔊 Voice", sbX + Math.round(16 * s), vcY + Math.round(10 * s));

  // Connected users in sidebar (under voice channel)
  let sideUserY = vcY + Math.round(32 * s);
  for (const u of args.users.slice(0, 6)) {
    const isSpeaking = (args.envelope[u.userId] ?? 0) > 0.05;
    ctx.fillStyle = isSpeaking ? DC.voiceSpeaking : DC.voiceUser;
    ctx.font = `${Math.round(12 * s)}px BotUI`;
    const prefix = isSpeaking ? "🟢" : "⚪";
    ctx.fillText(`  ${prefix} ${u.username}`, sbX + Math.round(20 * s), sideUserY);
    sideUserY += Math.round(22 * s);
  }

  // Voice connected bar at bottom
  const voiceBarH = Math.round(52 * s);
  const voiceBarY = sbY + sbH - voiceBarH;
  ctx.fillStyle = "#232428";
  ctx.fillRect(sbX, voiceBarY, sbW, voiceBarH);
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath(); ctx.moveTo(sbX, voiceBarY); ctx.lineTo(sbX + sbW, voiceBarY); ctx.stroke();

  ctx.fillStyle = DC.voiceConnected;
  ctx.font = `bold ${Math.round(12 * s)}px BotUI`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Voice Connected", sbX + Math.round(12 * s), voiceBarY + Math.round(16 * s));
  ctx.fillStyle = DC.channelText;
  ctx.font = `${Math.round(10.5 * s)}px BotUI`;
  ctx.fillText("Voice / ✦ Server", sbX + Math.round(12 * s), voiceBarY + Math.round(34 * s));

  // Timer
  ctx.fillStyle = DC.channelText;
  ctx.font = `${Math.round(11 * s)}px BotUI`;
  ctx.textAlign = "right";
  ctx.fillText(formatTime(args.tMs), sbX + sbW - Math.round(12 * s), voiceBarY + Math.round(16 * s));

  // ── 3c. Main Content Area ──────────────────────────────
  const mainX = sbX + sbW;
  const mainY = sbY;
  const mainW = winW - railW - sbW;
  const mainH = sbH;

  ctx.fillStyle = DC.mainBg;
  ctx.fillRect(mainX, mainY, mainW, mainH);

  // Header
  const hdrH = Math.round(48 * s);
  ctx.fillStyle = DC.headerBg;
  ctx.fillRect(mainX, mainY, mainW, hdrH);
  ctx.strokeStyle = DC.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mainX, mainY + hdrH); ctx.lineTo(mainX + mainW, mainY + hdrH); ctx.stroke();

  ctx.fillStyle = DC.headerText;
  ctx.font = `bold ${Math.round(14 * s)}px BotUI`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("🔊 Voice", mainX + Math.round(16 * s), mainY + hdrH / 2);

  // Participant count
  ctx.fillStyle = DC.channelText;
  ctx.font = `${Math.round(12 * s)}px BotUI`;
  ctx.textAlign = "right";
  ctx.fillText(`${args.users.length} participants`, mainX + mainW - Math.round(16 * s), mainY + hdrH / 2);
  ctx.textAlign = "left";

  const chatPanelW = Math.round(mainW * 0.31);
  const gridW = mainW - chatPanelW;
  const contentY = mainY + hdrH;
  const contentH = mainH - hdrH;

  // ── Voice Grid ─────────────────────────────────────────
  drawVoiceGrid(ctx, mainX, contentY, gridW, contentH, s, args);

  // ── Chat Divider ───────────────────────────────────────
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mainX + gridW, contentY + Math.round(8 * s));
  ctx.lineTo(mainX + gridW, contentY + contentH - Math.round(8 * s));
  ctx.stroke();

  // ── Chat Panel ─────────────────────────────────────────
  drawDiscordChat(ctx, mainX + gridW, contentY, chatPanelW, contentH, s, args);

  ctx.restore(); // unclip window
}

// ── Discord Voice Grid ─────────────────────────────────────

function drawVoiceGrid(
  ctx: Ctx, x: number, y: number, w: number, h: number, s: number, args: FrameArgs
): void {
  const users = args.users;
  const n = Math.max(1, users.length);
  const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const pad = Math.round(18 * s);
  const cardW = (w - pad * (cols + 1)) / cols;
  const cardH = (h - pad * (rows + 1)) / rows;
  const cardR = Math.round(14 * s);

  users.forEach((u, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const cx = x + pad + c * (cardW + pad);
    const cy = y + pad + r * (cardH + pad);
    const isSpeaking = (args.envelope[u.userId] ?? 0) > 0.05;
    const level = args.envelope[u.userId] ?? 0;
    const st = args.status[u.userId] ?? emptyStatus();

    ctx.save();
    const tile = ctx.createLinearGradient(cx, cy, cx, cy + cardH);
    tile.addColorStop(0, isSpeaking ? "#26352c" : DC.userCardBg);
    tile.addColorStop(1, DC.userCardBgAlt);
    ctx.fillStyle = tile;
    roundRect(ctx, cx, cy, cardW, cardH, cardR);
    ctx.fill();
    ctx.strokeStyle = isSpeaking ? "rgba(35,165,89,0.9)" : "rgba(255,255,255,0.055)";
    ctx.lineWidth = isSpeaking ? Math.round(3 * s) : 1;
    ctx.stroke();
    ctx.restore();

    if (isSpeaking) {
      ctx.save();
      ctx.lineWidth = Math.round(2 * s);
      ctx.strokeStyle = DC.voiceSpeaking;
      ctx.shadowColor = DC.voiceSpeaking;
      ctx.shadowBlur = Math.round(10 * s) + level * Math.round(18 * s);
      roundRect(ctx, cx, cy, cardW, cardH, cardR);
      ctx.stroke();
      ctx.restore();
    }

    const avSize = Math.min(cardW * 0.42, cardH * 0.48);
    const ax = cx + (cardW - avSize) / 2;
    const ay = cy + cardH * 0.12;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.34)";
    ctx.shadowBlur = Math.round(10 * s);
    ctx.fillStyle = "#313338";
    ctx.beginPath();
    ctx.arc(ax + avSize / 2, ay + avSize / 2, avSize / 2 + Math.round(3 * s), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(ax + avSize / 2, ay + avSize / 2, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    const img = args.avatarImgs.get(u.userId) ?? null;
    if (img) {
      ctx.drawImage(img, ax, ay, avSize, avSize);
    } else {
      ctx.fillStyle = "#5865f2";
      ctx.fillRect(ax, ay, avSize, avSize);
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.round(avSize * 0.4)}px BotUI`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(u.username.charAt(0).toUpperCase(), ax + avSize / 2, ay + avSize / 2);
    }
    ctx.restore();

    if (isSpeaking) {
      ctx.save();
      ctx.lineWidth = Math.round(3 * s);
      ctx.strokeStyle = DC.voiceSpeaking;
      ctx.shadowColor = DC.voiceSpeaking;
      ctx.shadowBlur = Math.round(6 * s);
      ctx.beginPath();
      ctx.arc(ax + avSize / 2, ay + avSize / 2, avSize / 2 + Math.round(2 * s), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = isSpeaking ? "#ffffff" : DC.voiceUser;
    const nameSize = Math.max(12, Math.round(cardH * 0.095));
    ctx.font = `600 ${nameSize}px BotUI`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(u.username, cx + cardW / 2, cy + cardH * 0.73, cardW - Math.round(18 * s));
    ctx.restore();

    const iconSize = Math.round(18 * s);
    const icons: { label: string; color: string }[] = [];
    if (st.selfMute || st.serverMute) icons.push({ label: "M", color: DC.statusRed });
    if (st.camera) icons.push({ label: "V", color: DC.blurple });
    if (st.share) icons.push({ label: "S", color: Palette.shareOn });

    if (icons.length > 0) {
      const totalW = icons.length * iconSize + (icons.length - 1) * Math.round(6 * s);
      let ix = cx + (cardW - totalW) / 2;
      const iy = cy + cardH * 0.88;
      for (const ic of icons) {
        ctx.save();
        ctx.fillStyle = ic.color;
        roundRect(ctx, ix, iy - iconSize / 2, iconSize, iconSize, iconSize / 2);
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.fillStyle = "#ffffff";
        ctx.font = `bold ${Math.round(iconSize * 0.56)}px BotUI`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(ic.label, ix + iconSize / 2, iy);
        ctx.restore();
        ix += iconSize + Math.round(6 * s);
      }
    }
  });
}

// ── Discord Chat Panel ─────────────────────────────────────

function drawDiscordChat(
  ctx: Ctx, x: number, y: number, w: number, h: number, s: number, args: FrameArgs
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.fillStyle = DC.chatBg;
  ctx.fillRect(x, y, w, h);

  // Chat header
  const chatHdrH = Math.round(36 * s);
  ctx.fillStyle = DC.headerBg;
  ctx.fillRect(x, y, w, chatHdrH);
  ctx.strokeStyle = DC.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + chatHdrH); ctx.lineTo(x + w, y + chatHdrH); ctx.stroke();

  ctx.fillStyle = DC.headerText;
  ctx.font = `bold ${Math.round(13 * s)}px BotUI`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("# chat", x + Math.round(14 * s), y + chatHdrH / 2);

  // Messages
  const visible = args.chat.filter((m) => m.ts <= args.tMs);
  const last = visible.slice(-12);
  const msgPad = Math.round(12 * s);
  let cy = y + chatHdrH + Math.round(8 * s);

  for (const m of last) {
    const age = args.tMs - m.ts;
    const fade = Math.min(1, Math.max(0.4, 1 - age / 60_000));
    ctx.globalAlpha = fade;

    // Avatar circle
    const avR = Math.round(8 * s);
    const avX = x + msgPad + avR;
    const avY = cy + avR + Math.round(2 * s);
    drawCircle(ctx, avX, avY, avR, DC.blurple);
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.round(avR)}px BotUI`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(m.username.charAt(0).toUpperCase(), avX, avY);

    // Username + timestamp
    const textX = x + msgPad + avR * 2 + Math.round(8 * s);
    ctx.fillStyle = DC.msgAuthor;
    ctx.font = `600 ${Math.round(12 * s)}px BotUI`;
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(m.username, textX, cy);

    // Timestamp
    const nameW = ctx.measureText(m.username).width;
    ctx.fillStyle = DC.msgTimestamp;
    ctx.font = `${Math.round(9.5 * s)}px BotUI`;
    const ts = new Date(m.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    ctx.fillText(ts, textX + nameW + Math.round(8 * s), cy + Math.round(2 * s));

    // Message text
    cy += Math.round(18 * s);
    ctx.fillStyle = DC.msgText;
    ctx.font = `${Math.round(12 * s)}px BotUI`;
    const text = m.content.length > 50 ? m.content.slice(0, 47) + "…" : m.content;
    ctx.fillText(text, textX, cy, w - textX + x - msgPad);

    cy += Math.round(22 * s);
    if (cy > y + h - Math.round(50 * s)) break;
  }
  ctx.globalAlpha = 1;

  // Message input box at bottom
  const inputH = Math.round(40 * s);
  const inputY = y + h - inputH - Math.round(8 * s);
  const inputX = x + Math.round(12 * s);
  const inputW = w - Math.round(24 * s);
  const inputR = Math.round(8 * s);

  ctx.fillStyle = DC.inputBg;
  roundRect(ctx, inputX, inputY, inputW, inputH, inputR);
  ctx.fill();

  ctx.fillStyle = DC.inputPlaceholder;
  ctx.font = `${Math.round(12 * s)}px BotUI`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Message #chat", inputX + Math.round(14 * s), inputY + inputH / 2);

  ctx.restore();
}

function formatTime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${m.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}
