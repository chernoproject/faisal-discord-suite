import { cfg } from "./config.js";
import { logger } from "./logger.js";
import { launchDiscord } from "./browser.js";
import { startBridge, attachPage } from "./bridge.js";
import { joinVoice } from "./voice.js";

async function main(): Promise<void> {
  logger.info(
    {
      platform: process.platform,
      guild: cfg.TARGET_GUILD_ID,
      channel: cfg.TARGET_VOICE_CHANNEL_ID,
      headless: cfg.HEADLESS,
    },
    "companion starting"
  );

  // Start WS bridge first so the bot can connect even while the browser is loading.
  startBridge();

  if (!cfg.BROWSER_ENABLED) {
    logger.info("companion ready — screen capture only");
    return;
  }

  const { page } = await launchDiscord();
  attachPage(page);
  logger.info("companion ready — discord web loaded");

  if (cfg.AUTO_JOIN_VOICE) {
    try {
      await joinVoice(page);
    } catch (err) {
      logger.warn({ err }, "auto-join failed (you can trigger voice.join via the bot)");
    }
  }

  page.on("close", () => {
    logger.warn("discord page closed — exiting");
    process.exit(0);
  });
}

void main().catch((err) => {
  logger.error({ err }, "companion fatal");
  process.exit(1);
});
