import { WebSocket, WebSocketServer } from "ws";
import type { Page } from "playwright-core";
import { cfg } from "./config.js";
import { logger } from "./logger.js";
import { startCapture, stopCapture, isCapturing, currentCaptureInfo } from "./recorder.js";
import {
  setUsername,
  setGlobalName,
  setBio,
  setAvatar,
  setBanner,
  setStatus,
  setCustomStatus,
  clearCustomStatus,
  getMe,
  type PresenceStatus,
} from "./account.js";
import {
  joinVoice,
  leaveVoice,
  toggleMute,
  startCamera,
  stopCamera,
  startScreenShare,
  stopScreenShare,
} from "./voice.js";

const log = logger.child({ mod: "bridge" });

// Page is set after the browser is launched. All Playwright actions need it.
let pageRef: Page | null = null;
export function attachPage(p: Page): void {
  pageRef = p;
}
function requirePage(): Page {
  if (!pageRef) throw new Error("companion browser not ready yet");
  return pageRef;
}

// ─── Wire protocol ──────────────────────────────────────────────────────────
//
// All messages are JSON:  { id?, type, authToken, ...payload }
// Responses echo `id` for request/response correlation.
//
//   ── meta ──
//     ping                       → pong { capturing, hasPage }
//   ── capture ──
//     capture.start { label? }   → started { outFile }
//     capture.stop               → stopped { outFile, durationMs } | null
//     capture.status             → status  { capturing, info }
//   ── account ──
//     account.set_username { value }            → ok
//     account.set_global_name { value }         → ok
//     account.set_bio { value }                 → ok
//     account.set_avatar { base64, mime? }      → ok
//     account.set_banner { base64, mime? }      → ok
//     account.set_status { value }              → ok
//     account.set_custom_status { text, emoji }  → ok
//     account.clear_custom_status               → ok
//     account.me                                → user
//   ── voice ──
//     voice.join { channelId?, guildId? }       → ok
//     voice.leave                               → ok
//     voice.mute { value: bool }                → ok
//     voice.camera.start                        → ok
//     voice.camera.stop                         → ok
//     voice.share.start                         → ok
//     voice.share.stop                          → ok
//
// Every response includes { ok: true } on success or { ok: false, error } on failure.

interface MsgIn {
  id?: string;
  type: string;
  authToken?: string;
  // payload (subset of all possible fields)
  label?: string;
  value?: string;
  text?: string;
  emoji?: string;
  base64?: string;
  mime?: string;
  channelId?: string;
  guildId?: string;
}

interface MsgOut {
  id?: string;
  type: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}

async function dispatch(msg: MsgIn): Promise<Omit<MsgOut, "id">> {
  try {
    switch (msg.type) {
      // ─── meta ───
      case "ping":
        return {
          type: "pong",
          ok: true,
          data: { capturing: isCapturing(), hasPage: !!pageRef },
        };

      // ─── capture ───
      case "capture.start":
      case "start": {
        const r = startCapture(msg.label ?? "rec");
        return { type: "started", ok: true, data: r };
      }
      case "capture.stop":
      case "stop": {
        const r = await stopCapture();
        return { type: "stopped", ok: true, data: r };
      }
      case "capture.status":
        return {
          type: "status",
          ok: true,
          data: { capturing: isCapturing(), info: currentCaptureInfo() },
        };

      // ─── account ───
      case "account.set_username": {
        const r = await setUsername(requirePage(), expect(msg.value));
        return { type: "account.ok", ok: true, data: r };
      }
      case "account.set_global_name": {
        const r = await setGlobalName(requirePage(), expect(msg.value));
        return { type: "account.ok", ok: true, data: r };
      }
      case "account.set_bio": {
        const r = await setBio(requirePage(), msg.value ?? "");
        return { type: "account.ok", ok: true, data: r };
      }
      case "account.set_avatar": {
        const buf = Buffer.from(expect(msg.base64), "base64");
        const r = await setAvatar(requirePage(), buf);
        return { type: "account.ok", ok: true, data: r };
      }
      case "account.set_banner": {
        const buf = Buffer.from(expect(msg.base64), "base64");
        const r = await setBanner(requirePage(), buf);
        return { type: "account.ok", ok: true, data: r };
      }
      case "account.set_status": {
        const v = expect(msg.value) as PresenceStatus;
        const r = await setStatus(requirePage(), v);
        return { type: "account.ok", ok: true, data: r };
      }
      case "account.set_custom_status": {
        const r = await setCustomStatus(requirePage(), msg.text ?? "", msg.emoji);
        return { type: "account.ok", ok: true, data: r };
      }
      case "account.clear_custom_status": {
        const r = await clearCustomStatus(requirePage());
        return { type: "account.ok", ok: true, data: r };
      }
      case "account.me": {
        const r = await getMe(requirePage());
        return { type: "account.me", ok: true, data: r };
      }

      // ─── voice ───
      case "voice.join": {
        const result = await joinVoice(requirePage(), msg.channelId, msg.guildId);
        return { type: "voice.ok", ok: result.ok, error: result.error };
      }
      case "voice.leave": {
        const result = await leaveVoice(requirePage());
        return { type: "voice.ok", ok: result.ok, error: result.error };
      }
      case "voice.mute": {
        const mute = msg.value === "true" || msg.value === "1";
        const result = await toggleMute(requirePage(), mute);
        return { type: "voice.ok", ok: result.ok, error: result.error };
      }
      case "voice.camera.start": {
        const result = await startCamera(requirePage());
        return { type: "voice.ok", ok: result.ok, error: result.error };
      }
      case "voice.camera.stop": {
        const result = await stopCamera(requirePage());
        return { type: "voice.ok", ok: result.ok, error: result.error };
      }
      case "voice.share.start": {
        const result = await startScreenShare(requirePage());
        return { type: "voice.ok", ok: result.ok, error: result.error };
      }
      case "voice.share.stop": {
        const result = await stopScreenShare(requirePage());
        return { type: "voice.ok", ok: result.ok, error: result.error };
      }

      default:
        return { type: "error", ok: false, error: `unknown type ${msg.type}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { type: "error", ok: false, error: message };
  }
}

function expect<T>(v: T | undefined): T {
  if (v === undefined || v === null || v === "")
    throw new Error("missing required field");
  return v;
}

/**
 * Run WebSocket server (bot → companion). Optionally also open an outbound
 * client (companion → bot) for unsolicited events.
 */
export function startBridge(): void {
  const wss = new WebSocketServer({ port: cfg.LISTEN_PORT });
  log.info({ port: cfg.LISTEN_PORT }, "companion ws server listening");
  wss.on("connection", (ws) => {
    ws.on("message", async (data) => {
      let msg: MsgIn | null = null;
      try {
        msg = JSON.parse(data.toString()) as MsgIn;
      } catch {
        ws.send(JSON.stringify({ type: "error", ok: false, error: "bad json" }));
        return;
      }
      if (msg.authToken !== cfg.BOT_AUTH_TOKEN) {
        ws.send(JSON.stringify({ type: "error", ok: false, error: "bad auth" }));
        return;
      }
      const reply = await dispatch(msg);
      ws.send(JSON.stringify({ id: msg.id, ...reply }));
    });
  });

  if (cfg.BOT_WS_URL) {
    try {
      const client = new WebSocket(cfg.BOT_WS_URL);
      client.on("open", () =>
        client.send(JSON.stringify({ type: "hello", authToken: cfg.BOT_AUTH_TOKEN }))
      );
      client.on("error", (err) => log.debug({ err }, "outbound ws error"));
    } catch (err) {
      log.debug({ err }, "outbound ws init failed");
    }
  }
}
