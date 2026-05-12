import type { Page } from "playwright-core";
import { cfg } from "./config.js";
import { logger } from "./logger.js";

const log = logger.child({ mod: "voice" });

/**
 * Voice channel + screen share + camera control via Discord web UI.
 *
 * Screen share / camera cannot be triggered via REST — they must go through
 * the UI which then opens a WebRTC connection. We rely on stable test IDs
 * and aria-labels first, and fall back to text matching as last resort.
 */

const SELECTORS = {
  // Channel sidebar entry — matched against the channel id in the link href.
  channelLink: (id: string) => `a[href*="/channels/"][href$="/${id}"]`,

  // In-call control buttons live inside [aria-label="Voice Connected"] tray
  // or the channel tile when expanded. We try multiple matches.
  connected: [
    '[aria-label="Voice Connected"]',
    '[aria-label="متصل بالصوت"]',
    'button[aria-label="Disconnect"]',
    'button[aria-label="فصل"]',
  ],
  shareScreenBtn: [
    'button[aria-label="Share Your Screen"]',
    'button[aria-label="مشاركة شاشتك"]',
    'div[role="button"][aria-label="Share Your Screen"]',
  ],
  stopShareBtn: [
    'button[aria-label="Stop Streaming"]',
    'button[aria-label="إيقاف البث"]',
  ],
  cameraBtn: [
    'button[aria-label="Turn On Camera"]',
    'button[aria-label="تشغيل الكاميرا"]',
  ],
  cameraOffBtn: [
    'button[aria-label="Turn Off Camera"]',
    'button[aria-label="إيقاف الكاميرا"]',
  ],
  muteBtn: [
    'button[aria-label="Mute"]',
    'button[aria-label="كتم"]',
  ],
  unmuteBtn: [
    'button[aria-label="Unmute"]',
    'button[aria-label="إلغاء الكتم"]',
  ],
  disconnectBtn: [
    'button[aria-label="Disconnect"]',
    'button[aria-label="فصل"]',
  ],
  // The screen-share source picker that pops up
  shareConfirmBtn: [
    'button:has-text("Go Live")',
    'button:has-text("ابدأ البث")',
    'button[type="submit"]',
  ],
  shareEntireScreenTile: [
    'div[class*="screenSelectorTile"]',
    'div[class*="application"]',
  ],
};

export interface VoiceActionResult {
  ok: boolean;
  error?: string;
}

async function clickFirst(page: Page, selectors: string[], timeoutMs = 4000): Promise<VoiceActionResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if ((await loc.count()) > 0 && (await loc.isVisible())) {
          await loc.click({ timeout: 1500 });
          return { ok: true };
        }
      } catch {
        /* try next */
      }
    }
    await page.waitForTimeout(200);
  }
  const currentUrl = page.url();
  return {
    ok: false,
    error:
      `زر Discord المطلوب غير ظاهر. تأكد أن حساب الـ companion داخل الروم الصوتي وأن المتصفح مفتوح على الروم الصحيح. الصفحة الحالية: ${currentUrl}`,
  };
}

export async function joinVoice(
  page: Page,
  channelId = cfg.TARGET_VOICE_CHANNEL_ID,
  guildId = cfg.TARGET_GUILD_ID
): Promise<VoiceActionResult> {
  return withTimeout(
    joinVoiceInner(page, channelId, guildId),
    35_000,
    `انتهت مهلة محاولة دخول الروم الصوتي في Discord. افتح نافذة الـ companion وتأكد أن Discord مستجيب وأن الحساب يستطيع رؤية الروم. الصفحة الحالية: ${page.url()}`
  );
}

async function joinVoiceInner(
  page: Page,
  channelId: string,
  guildId: string
): Promise<VoiceActionResult> {
  log.info({ channelId, guildId }, "joining voice channel");
  const url = `https://discord.com/channels/${guildId}/${channelId}`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch (err) {
    log.warn({ err, url, currentUrl: page.url() }, "discord voice channel navigation timed out");
    await page.evaluate((target) => {
      window.location.assign(target);
    }, url);
    await page.waitForTimeout(2_500);
  }
  log.info({ currentUrl: page.url() }, "discord voice channel page opened");

  const joinedBeforeClick = await isVoiceConnected(page, 1500);
  if (joinedBeforeClick) return { ok: true };

  const linkResult = await clickFirst(page, [SELECTORS.channelLink(channelId)], 8000);
  if (!linkResult.ok) {
    return {
      ok: false,
      error:
        `ما لقيت الروم الصوتي في Discord. تأكد أن TARGET_GUILD_ID و TARGET_VOICE_CHANNEL_ID صحيحة وأن حساب الـ companion داخل السيرفر. الصفحة الحالية: ${page.url()}`,
    };
  }

  const joinedAfterClick = await isVoiceConnected(page, 10_000);
  if (!joinedAfterClick) {
    try {
      await page.locator(SELECTORS.channelLink(channelId)).first().dblclick({ timeout: 3000 });
    } catch (err) {
      log.debug({ err }, "channel link dblclick fallback");
    }
  }
  const joinedAfterFallback = await isVoiceConnected(page, 10_000);
  if (!joinedAfterFallback) {
    return {
      ok: false,
      error:
        "تم الضغط على الروم لكن Discord ما أكد الاتصال الصوتي. افتح نافذة الـ companion وتأكد من عدم وجود نافذة تأكيد/صلاحيات، وأن الحساب غير مقيد من دخول الروم.",
    };
  }

  log.info("voice join confirmed");
  return { ok: true };
}

async function withTimeout(
  action: Promise<VoiceActionResult>,
  timeoutMs: number,
  error: string
): Promise<VoiceActionResult> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      action,
      new Promise<VoiceActionResult>((resolve) => {
        timeout = setTimeout(() => resolve({ ok: false, error }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function leaveVoice(page: Page): Promise<VoiceActionResult> {
  const result = await clickFirst(page, SELECTORS.disconnectBtn);
  log.info({ ok: result.ok }, "leaveVoice");
  return result;
}

export async function toggleMute(page: Page, mute: boolean): Promise<VoiceActionResult> {
  const sel = mute ? SELECTORS.muteBtn : SELECTORS.unmuteBtn;
  const result = await clickFirst(page, sel);
  log.info({ ok: result.ok, mute }, "toggleMute");
  return result;
}

export async function startCamera(page: Page): Promise<VoiceActionResult> {
  const result = await clickFirst(page, SELECTORS.cameraBtn);
  log.info({ ok: result.ok }, "startCamera");
  if (!result.ok) {
    return {
      ...result,
      error:
        "ما لقيت زر تشغيل الكاميرا في Discord. ادخل حساب الـ companion للروم الصوتي أولاً بـ /voice join، وتأكد أن Windows/Discord شايف كاميرا.",
    };
  }
  return result;
}

export async function stopCamera(page: Page): Promise<VoiceActionResult> {
  const result = await clickFirst(page, SELECTORS.cameraOffBtn);
  log.info({ ok: result.ok }, "stopCamera");
  return result;
}

export async function startScreenShare(page: Page): Promise<VoiceActionResult> {
  const opened = await clickFirst(page, SELECTORS.shareScreenBtn);
  if (!opened.ok) {
    log.warn("share screen button not found");
    return {
      ...opened,
      error:
        "ما لقيت زر مشاركة الشاشة في Discord. ادخل حساب الـ companion للروم الصوتي أولاً وتأكد أن نافذة Discord ظاهرة.",
    };
  }
  // Picker shows up — pick entire screen tile then click Go Live.
  await page.waitForTimeout(800);
  await clickFirst(page, SELECTORS.shareEntireScreenTile, 2000);
  await page.waitForTimeout(300);
  const confirmed = await clickFirst(page, SELECTORS.shareConfirmBtn, 3000);
  log.info({ confirmed: confirmed.ok }, "startScreenShare");
  return confirmed;
}

export async function stopScreenShare(page: Page): Promise<VoiceActionResult> {
  const result = await clickFirst(page, SELECTORS.stopShareBtn);
  log.info({ ok: result.ok }, "stopScreenShare");
  return result;
}

async function isVoiceConnected(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of SELECTORS.connected) {
      const loc = page.locator(sel).first();
      try {
        if ((await loc.count()) > 0 && (await loc.isVisible())) return true;
      } catch {
        /* try next */
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
}
