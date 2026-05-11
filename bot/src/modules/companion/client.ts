import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

const log = logger.child({ mod: "companionClient" });

interface PendingRequest {
  resolve: (data: CompanionResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CompanionResponse {
  id?: string;
  type: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}

const pending = new Map<string, PendingRequest>();
let ws: WebSocket | null = null;
let connecting = false;
let backoffMs = 1000;

export function isCompanionConfigured(): boolean {
  return !!(env.COMPANION_WS_URL && env.COMPANION_AUTH_TOKEN);
}

function connect(): void {
  if (connecting || ws || !isCompanionConfigured()) return;
  connecting = true;
  log.info({ url: env.COMPANION_WS_URL }, "connecting to companion");
  const sock = new WebSocket(env.COMPANION_WS_URL);
  sock.on("open", () => {
    connecting = false;
    backoffMs = 1000;
    ws = sock;
    log.info("companion ws connected");
  });
  sock.on("close", () => {
    log.warn("companion ws closed");
    ws = null;
    connecting = false;
    rejectAll(new Error("companion socket closed"));
    setTimeout(connect, Math.min(backoffMs, 30_000));
    backoffMs = Math.min(backoffMs * 2, 30_000);
  });
  sock.on("error", (err) => log.debug({ err }, "companion ws error"));
  sock.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as CompanionResponse;
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.id);
          p.resolve(msg);
        }
      }
    } catch (err) {
      log.warn({ err }, "bad companion msg");
    }
  });
}

function rejectAll(err: Error): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
    pending.delete(id);
  }
}

export function ensureCompanion(): void {
  if (!isCompanionConfigured()) return;
  if (!ws) connect();
}

export function isCompanionReady(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

/**
 * Send a request to the companion. Resolves with the response (which may
 * still indicate ok=false if the companion couldn't perform the action).
 */
export function sendCompanion(
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 20_000
): Promise<CompanionResponse> {
  if (!isCompanionConfigured()) {
    return Promise.reject(
      new Error(
        "Companion غير مضبوط — عبّ COMPANION_WS_URL و COMPANION_AUTH_TOKEN في bot/.env. إذا عندك إعدادات companion فقط، انسخ BOT_WS_URL/BOT_AUTH_TOKEN إلى bot/.env أو استخدم COMPANION_WS_URL=ws://localhost:8788."
      )
    );
  }
  ensureCompanion();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Companion ليست متصلة الآن. شغّل تطبيق الـ companion على ويندوز."));
  }
  const id = randomUUID();
  const msg = { id, type, authToken: env.COMPANION_AUTH_TOKEN, ...payload };
  return new Promise<CompanionResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`companion request timed out: ${type}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws!.send(JSON.stringify(msg), (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  });
}
