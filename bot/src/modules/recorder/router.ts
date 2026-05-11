import {
  MessageFlags,
  ChannelType,
  type Interaction,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import path from "node:path";
import fs from "node:fs";
import { parseId } from "../../utils/ids.js";
import { L } from "../../utils/locale.js";
import { logger } from "../../utils/logger.js";
import { recordingManager } from "./state.js";
import { getGuildSettings } from "../../db/settings.js";
import { recordPanelRows } from "../../ui/components.js";
import { buildEmbed, errorEmbed, successEmbed } from "../../ui/embeds.js";
import { renderRecording } from "./renderer.js";
import { saveClip } from "./clipsStore.js";
import { editorPanel } from "./editorRouter.js";
import { Palette } from "../../utils/colors.js";

const log = logger.child({ mod: "rec-router" });
const STARTING = new Set<string>();

export async function recordRouter(interaction: Interaction): Promise<void> {
  if (!interaction.guild) return;

  // Handle select menu for clip duration
  if (interaction.isStringSelectMenu()) {
    const { action } = parseId(interaction.customId);
    if (action === "clip_select") {
      const minutes = parseInt(interaction.values[0] ?? "5", 10);
      return clipFromSelect(interaction, minutes);
    }
    return;
  }

  if (!interaction.isButton()) return;
  const { action, args } = parseId(interaction.customId);
  switch (action) {
    case "start":
      return startBtn(interaction);
    case "stop":
      return stopBtn(interaction);
    case "pause":
      return pauseBtn(interaction);
    case "resume":
      return resumeBtn(interaction);
    case "clip":
      return clipBtn(interaction, parseInt(args[0] ?? "5", 10));
    case "open_settings":
      await interaction.reply({
        embeds: [buildEmbed({
          title: "الإعدادات | Settings",
          description: "استخدم الأمر `/setup` لفتح لوحة الإعدادات الكاملة.\nUse `/setup` to open the full settings panel.",
          color: Palette.accent,
        })],
        flags: MessageFlags.Ephemeral,
      });
      return;
    default:
      log.warn({ action }, "unknown recorder action");
  }
}

async function startBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = interaction.member as GuildMember | null;
  const channel = await resolveTargetChannel(interaction);
  if (!channel) {
    await interaction.editReply({
      embeds: [errorEmbed("ما لقيت روم صوتي — حدد الروم من /setup أو ادخل أنت روم صوتي قبل ما تضغط.\nNo voice channel found — set one in /setup or join a voice channel first.")],
    });
    return;
  }
  const guildId = interaction.guild.id;
  if (STARTING.has(guildId)) {
    await interaction.editReply({
      embeds: [errorEmbed("جاري بدء التسجيل الآن — انتظر ثواني ثم جرّب مرة ثانية | Recording is already starting.")],
    });
    return;
  }
  STARTING.add(guildId);
  try {
    await interaction.editReply({
      embeds: [buildEmbed({ description: `جارٍ دخول <#${channel.id}> وبدء التسجيل… | Joining <#${channel.id}> and starting recording…`, color: Palette.warn })],
    });
    await recordingManager.start({
      channel,
      startedBy: member?.id ?? interaction.user.id,
    });
    await interaction.editReply({
      embeds: [successEmbed(
        `بدأت التسجيل في <#${channel.id}> | Recording started in <#${channel.id}>.`,
        L.recording
      )],
    });
    try {
      await refreshPanelMessage(interaction);
    } catch {
      /* ignore */
    }
  } catch (err) {
    log.error({ err }, "start failed");
    const msg = err instanceof Error ? err.message : L.unknownError;
    await interaction.editReply({ embeds: [errorEmbed(msg)] });
  } finally {
    STARTING.delete(guildId);
  }
}

async function stopBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Extract buffer data BEFORE stopping (stop() closes FDs and deletes session)
  const liveSession = recordingManager.get(interaction.guild.id);
  if (!liveSession) {
    await interaction.editReply({ embeds: [errorEmbed(L.notRecording)] });
    return;
  }
  const durationSec = Math.floor((Date.now() - liveSession.startedAt) / 1000);
  const users = liveSession.buffer.sliceLastSeconds(durationSec, liveSession.sessionDir);
  const events = liveSession.timeline.sliceEvents(0, durationSec * 1000);
  const chat = liveSession.timeline.sliceChat(0, durationSec * 1000);
  const sessionId = liveSession.id;
  const sessionDir = liveSession.sessionDir;

  const session = await recordingManager.stop(interaction.guild.id);
  if (!session) {
    await interaction.editReply({ embeds: [errorEmbed(L.notRecording)] });
    return;
  }
  const dur = L.formatDuration(durationSec);
  await interaction.editReply({
    embeds: [successEmbed(`تم إيقاف التسجيل — المدة: ${dur}\nRecording stopped — duration: ${dur}`)],
  });
  await finalizeAndPost(interaction, {
    sessionId,
    durationSec,
    sliceDir: sessionDir,
    title: `تسجيل | Recording — ${new Date().toLocaleString("ar-SA")}`,
    presliced: { users, events, chat },
  });
  try {
    await refreshPanelMessage(interaction);
  } catch {
    /* ignore */
  }
}

async function pauseBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const session = recordingManager.get(interaction.guild.id);
  if (!session) {
    await interaction.reply({ embeds: [errorEmbed(L.notRecording)], flags: MessageFlags.Ephemeral });
    return;
  }
  const ok = recordingManager.pause(interaction.guild.id);
  if (!ok) {
    await interaction.reply({
      embeds: [errorEmbed(L.recAlreadyPaused)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    embeds: [successEmbed(L.recPaused)],
    flags: MessageFlags.Ephemeral,
  });
  try {
    await refreshPanelMessage(interaction);
  } catch {
    /* ignore */
  }
}

async function resumeBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const session = recordingManager.get(interaction.guild.id);
  if (!session) {
    await interaction.reply({ embeds: [errorEmbed(L.notRecording)], flags: MessageFlags.Ephemeral });
    return;
  }
  const ok = recordingManager.resume(interaction.guild.id);
  if (!ok) {
    await interaction.reply({
      embeds: [errorEmbed(L.recNotPaused)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    embeds: [successEmbed(L.recResumed)],
    flags: MessageFlags.Ephemeral,
  });
  try {
    await refreshPanelMessage(interaction);
  } catch {
    /* ignore */
  }
}

async function clipBtn(interaction: ButtonInteraction, minutes: number): Promise<void> {
  if (!interaction.guild) return;
  const session = recordingManager.get(interaction.guild.id);
  if (!session) {
    await interaction.reply({
      embeds: [errorEmbed(L.recNoActiveClip)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await processClip(interaction, session, minutes);
}

async function clipFromSelect(interaction: StringSelectMenuInteraction, minutes: number): Promise<void> {
  if (!interaction.guild) return;
  const session = recordingManager.get(interaction.guild.id);
  if (!session) {
    await interaction.reply({
      embeds: [errorEmbed(L.recNoActiveClip)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await processClip(interaction, session, minutes);
}

async function processClip(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  session: ReturnType<typeof recordingManager.get> & object,
  minutes: number
): Promise<void> {
  const durationSec = Math.max(5, Math.min(minutes * 60, session.bufferMinutes * 60));
  const outDir = path.join(session.sessionDir, "clips", `${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const users = session.buffer.sliceLastSeconds(durationSec, outDir);
  const events = session.timeline.sliceEvents(
    (Date.now() - session.startedAt) - durationSec * 1000,
    Date.now() - session.startedAt
  );
  const chat = session.timeline.sliceChat(
    (Date.now() - session.startedAt) - durationSec * 1000,
    Date.now() - session.startedAt
  );
  await interaction.editReply({
    embeds: [successEmbed(L.recPreparingClip(minutes))],
  });

  await finalizeAndPost(interaction, {
    sessionId: session.id,
    durationSec,
    sliceDir: outDir,
    title: `Clip — آخر ${minutes} دقيقة | Last ${minutes} min`,
    presliced: { users, events, chat },
  });
}

async function finalizeAndPost(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  args: {
    sessionId: string;
    durationSec: number;
    sliceDir: string;
    title: string;
    presliced?: {
      users: { userId: string; username: string; avatarUrl: string; pcmFile: string; bytesWritten: number }[];
      events: import("./types.js").VoiceEvent[];
      chat: import("./types.js").ChatMsg[];
    };
  }
): Promise<void> {
  if (!interaction.guild) return;
  const settings = getGuildSettings(interaction.guild.id);

  let users: ReturnType<typeof saveClip>["users"];
  let events: import("./types.js").VoiceEvent[];
  let chat: import("./types.js").ChatMsg[];
  if (args.presliced) {
    users = args.presliced.users;
    events = args.presliced.events;
    chat = args.presliced.chat;
  } else {
    const session = recordingManager.get(interaction.guild.id);
    if (session) {
      users = session.buffer.sliceLastSeconds(args.durationSec, args.sliceDir);
      events = session.timeline.sliceEvents(0, args.durationSec * 1000);
      chat = session.timeline.sliceChat(0, args.durationSec * 1000);
    } else {
      users = [];
      events = [];
      chat = [];
    }
  }

  const outFile = path.join(args.sliceDir, "out.mp4");
  try {
    await renderRecording({
      outDir: args.sliceDir,
      outFile,
      durationSec: args.durationSec,
      users,
      events,
      chat,
      quality: settings.render_quality,
      title: args.title,
    });
  } catch (err) {
    log.error({ err }, "render error");
    await interaction.followUp({
      embeds: [errorEmbed(L.recRenderFailed)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const recChannelId = settings.record_channel_id ?? interaction.channelId;
  const channel = interaction.guild.channels.cache.get(recChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.followUp({
      embeds: [errorEmbed(L.recNoChannel)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const now = new Date();
  const dateLabel = now.toLocaleString("ar-SA", {
    dateStyle: "short",
    timeStyle: "short",
  });

  const thread = await channel.threads.create({
    name: `🎙️ ${dateLabel}`,
    type: ChannelType.PrivateThread,
    invitable: true,
    reason: "Recording thread",
  });

  const clip = saveClip({
    guildId: interaction.guildId!,
    channelId: recChannelId,
    threadId: thread.id,
    startedBy: interaction.user.id,
    startedAtSession: Date.now() - args.durationSec * 1000,
    durationSec: args.durationSec,
    sliceDir: args.sliceDir,
    users,
    events,
    chat,
  });

  try {
    const stat = fs.statSync(outFile);
    const sizeMb = stat.size / (1024 * 1024);
    const durStr = L.formatDuration(args.durationSec);
    if (sizeMb < 24) {
      await thread.send({
        content: `<@${interaction.user.id}> ${L.recPosted(args.title, durStr)}`,
        files: [outFile],
        embeds: [
          buildEmbed({
            title: args.title,
            description: `${L.recPeople(users.length)} • ${durStr}`,
            color: Palette.accent,
          }),
        ],
        components: editorPanel(clip.id),
      });
    } else {
      await thread.send({
        content: `<@${interaction.user.id}> ${L.recPosted(args.title, durStr)}\n\n${L.recFileTooLarge(parseFloat(sizeMb.toFixed(1)))}\n\`${outFile}\``,
        embeds: [
          buildEmbed({
            title: args.title,
            description: `${L.recPeople(users.length)} • ${durStr}`,
            color: Palette.warn,
          }),
        ],
        components: editorPanel(clip.id),
      });
    }
  } catch (err) {
    log.error({ err }, "post failed");
    await thread.send({
      embeds: [errorEmbed(L.recRenderFailed)],
    });
  }
}

async function resolveTargetChannel(
  interaction: ButtonInteraction
): Promise<VoiceBasedChannel | null> {
  if (!interaction.guild) return null;
  const settings = getGuildSettings(interaction.guild.id);
  if (settings.pin_channel_id) {
    const c = interaction.guild.channels.cache.get(settings.pin_channel_id);
    if (c && c.isVoiceBased()) return c;
  }
  const member = interaction.member as GuildMember | null;
  const vs = member?.voice;
  if (vs?.channel) return vs.channel;
  return null;
}

async function refreshPanelMessage(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  if (!interaction.message) return;
  const guildId = interaction.guildId!;
  const session = recordingManager.get(guildId);
  const isActive = recordingManager.isActive(guildId);
  const isPaused = session?.paused ?? false;
  try {
    await interaction.message.edit({
      components: recordPanelRows(isActive, isPaused),
    });
  } catch {
    /* ignore */
  }
}
