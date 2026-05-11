import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Page } from "playwright-core";
import { cfg } from "./config.js";
import { logger } from "./logger.js";

const log = logger.child({ mod: "account" });

/**
 * Account profile + presence management for the companion self-bot account.
 *
 * NOTE: All actions go through Discord's REST endpoints using the user token
 * stored in localStorage. This is far more reliable than UI clicking and avoids
 * brittle selectors that break with every Discord redesign.
 *
 * The Page parameter is used only to extract the user's token + locale headers
 * from a real, logged-in browser session so requests look authentic.
 */

interface ApiContext {
  token: string;
  superProperties: string;
  locale: string;
}

async function getApiContext(page: Page): Promise<ApiContext> {
  const data = await page
    .evaluate(() => {
      let token = "";
      try {
        token = window.localStorage?.getItem("token") ?? "";
      } catch {
        token = "";
      }
      return {
        token: token.replace(/^"|"$/g, ""),
        locale: window.navigator.language || "en-US",
      };
    })
    .catch(() => ({ token: "", locale: "en-US" }));
  const token = data.token || cfg.DISCORD_USER_TOKEN;
  if (!token) throw new Error("no token available for Discord API requests");

  // X-Super-Properties is required to avoid most "Invalid request" responses.
  // We use a sane Chrome-on-Windows default that matches our headless context.
  const superProperties = Buffer.from(
    JSON.stringify({
      os: "Windows",
      browser: "Chrome",
      device: "",
      system_locale: data.locale,
      browser_user_agent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      browser_version: "120.0.0.0",
      os_version: "10",
      referrer: "",
      referring_domain: "",
      referrer_current: "",
      referring_domain_current: "",
      release_channel: "stable",
      client_build_number: 250000,
      client_event_source: null,
    })
  ).toString("base64");

  return { token, superProperties, locale: data.locale };
}

async function apiFetch(
  page: Page,
  method: "GET" | "PATCH" | "POST" | "PUT",
  endpoint: string,
  body?: unknown
): Promise<unknown> {
  const ctx = await getApiContext(page);
  const init: Record<string, unknown> = {
    method,
    headers: {
      authorization: ctx.token,
      "content-type": "application/json",
      "accept-language": ctx.locale,
      "x-super-properties": ctx.superProperties,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await page.request.fetch(`https://discord.com/api/v9${endpoint}`, init);
  const text = await res.text();
  if (!res.ok()) {
    throw new Error(`Discord API ${res.status()}: ${text.slice(0, 400)}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function toDataUrl(buf: Buffer, mime: string): string {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function loadImageBuffer(input: string | Buffer): { buf: Buffer; mime: string } {
  if (Buffer.isBuffer(input)) return { buf: input, mime: "image/png" };
  if (input.startsWith("data:")) {
    const m = /^data:(.+?);base64,(.+)$/i.exec(input);
    if (!m || !m[1] || !m[2]) throw new Error("invalid data URL");
    return { buf: Buffer.from(m[2], "base64"), mime: m[1] };
  }
  if (/^https?:\/\//i.test(input)) {
    throw new Error("pass a downloaded buffer or local path, not a URL");
  }
  // Treat as file path
  const abs = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".gif"
      ? "image/gif"
      : ext === ".webp"
      ? "image/webp"
      : "image/png";
  return { buf, mime };
}

export async function setUsername(page: Page, value: string): Promise<unknown> {
  log.info({ value }, "setUsername");
  // Discord requires the current password to change username; if the account
  // has 2FA this also needs an MFA code. Most bot-control accounts have
  // password-less changes disabled, so we accept an optional env override.
  const password = process.env.ACCOUNT_PASSWORD ?? "";
  return apiFetch(page, "PATCH", "/users/@me", {
    username: value,
    password: password || undefined,
  });
}

export async function setGlobalName(page: Page, value: string): Promise<unknown> {
  log.info({ value }, "setGlobalName");
  return apiFetch(page, "PATCH", "/users/@me", { global_name: value });
}

export async function setBio(page: Page, value: string): Promise<unknown> {
  log.info({ len: value.length }, "setBio");
  return apiFetch(page, "PATCH", "/users/@me/profile", { bio: value });
}

export async function setAvatar(page: Page, input: string | Buffer): Promise<unknown> {
  const { buf, mime } = loadImageBuffer(input);
  log.info({ bytes: buf.length }, "setAvatar");
  return apiFetch(page, "PATCH", "/users/@me", { avatar: toDataUrl(buf, mime) });
}

export async function setBanner(page: Page, input: string | Buffer): Promise<unknown> {
  const { buf, mime } = loadImageBuffer(input);
  log.info({ bytes: buf.length }, "setBanner");
  return apiFetch(page, "PATCH", "/users/@me", { banner: toDataUrl(buf, mime) });
}

export type PresenceStatus = "online" | "idle" | "dnd" | "invisible";

export async function setStatus(page: Page, status: PresenceStatus): Promise<unknown> {
  log.info({ status }, "setStatus");
  return apiFetch(page, "PATCH", "/users/@me/settings", { status });
}

export async function setCustomStatus(
  page: Page,
  text: string,
  emojiName?: string
): Promise<unknown> {
  log.info({ text, emojiName }, "setCustomStatus");
  const body: Record<string, unknown> = {
    custom_status: text
      ? { text, emoji_name: emojiName ?? null, expires_at: null }
      : null,
  };
  return apiFetch(page, "PATCH", "/users/@me/settings", body);
}

export async function clearCustomStatus(page: Page): Promise<unknown> {
  return setCustomStatus(page, "");
}

export async function getMe(page: Page): Promise<unknown> {
  return apiFetch(page, "GET", "/users/@me");
}

export function tempFilePath(ext = "png"): string {
  const name = `companion-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  return path.join(os.tmpdir(), name);
}
