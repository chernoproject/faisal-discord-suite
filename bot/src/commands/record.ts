import {
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../client.js";
import { recordingManager } from "../modules/recorder/state.js";
import { recordPanelRows } from "../ui/components.js";
import { buildEmbed, errorEmbed, successEmbed } from "../ui/embeds.js";
import { getGuildSettings } from "../db/settings.js";
import { Palette } from "../utils/colors.js";
import { L } from "../utils/locale.js";

const STARTING = new Set<string>();

export const recordCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("record")
    .setDescription("إدارة التسجيل الصوتي | Manage voice recording")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName("panel").setDescription("نشر لوحة التحكم | Post control panel")
    )
    .addSubcommand((s) => s.setName("start").setDescription("بدء التسجيل | Start recording"))
    .addSubcommand((s) => s.setName("stop").setDescription("إيقاف التسجيل | Stop recording"))
    .addSubcommand((s) => s.setName("pause").setDescription("إيقاف مؤقت | Pause recording"))
    .addSubcommand((s) => s.setName("resume").setDescription("استمرار التسجيل | Resume recording"))
    .addSubcommand((s) =>
      s.setName("status").setDescription("حالة التسجيل | Recording status")
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) return;
    const sub = interaction.options.getSubcommand(true);
    const settings = getGuildSettings(interaction.guild.id);

    if (sub === "panel") {
      const isRec = recordingManager.isActive(interaction.guild.id);
      const session = recordingManager.get(interaction.guild.id);
      const qualityLabel = settings.render_quality === "high" ? "1080p" : settings.render_quality === "medium" ? "720p" : "480p";
      await interaction.reply({
        embeds: [
          buildEmbed({
            title: `🎙️ ${L.recPanel}`,
            description: [
              `**القناة | Channel:** ${settings.pin_channel_id ? `<#${settings.pin_channel_id}>` : "غير محدد | Not set"}`,
              `**المدة | Duration:** ${settings.default_duration_minutes} دقيقة | min`,
              `**البافر | Buffer:** ${settings.max_buffer_minutes} دقيقة | min`,
              `**الجودة | Quality:** ${qualityLabel}`,
              isRec && session ? `\n🔴 **${L.recording}** — ${L.formatDuration(Math.floor((Date.now() - session.startedAt) / 1000))}` : "",
            ].filter(Boolean).join("\n"),
            color: isRec ? Palette.danger : Palette.accent,
          }),
        ],
        components: recordPanelRows(isRec, session?.paused),
      });
      return;
    }

    if (sub === "status") {
      const s = recordingManager.get(interaction.guild.id);
      if (!s) {
        await interaction.reply({
          embeds: [buildEmbed({ description: L.notRecording })],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const secs = Math.floor((Date.now() - s.startedAt) / 1000);
      const effectiveSecs = recordingManager.effectiveDuration(interaction.guild.id);
      await interaction.reply({
        embeds: [
          buildEmbed({
            title: `🎙️ ${L.recStatus}`,
            description: [
              `**الروم | Channel:** <#${s.channelId}>`,
              `**المدة الإجمالية | Total:** ${L.formatDuration(secs)}`,
              `**المدة الفعلية | Effective:** ${L.formatDuration(effectiveSecs)}`,
              `**المشاركون | Participants:** ${s.buffer.listUsers().length}`,
              `**بدأ بواسطة | Started by:** <@${s.startedBy}>`,
              s.paused ? `\n⏸️ **${L.recPaused}**` : "",
            ].filter(Boolean).join("\n"),
            color: s.paused ? Palette.warn : Palette.success,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "start") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guildId = interaction.guild.id;
      if (STARTING.has(guildId)) {
        await interaction.editReply({
          embeds: [errorEmbed("جاري بدء التسجيل الآن — انتظر ثواني ثم جرّب مرة ثانية | Recording is already starting.")],
        });
        return;
      }
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const channel = member.voice.channel ??
        (settings.pin_channel_id
          ? interaction.guild.channels.cache.get(settings.pin_channel_id)
          : null);
      if (!channel || !channel.isVoiceBased()) {
        await interaction.editReply({
          embeds: [errorEmbed(L.notInVoice)],
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
          startedBy: interaction.user.id,
        });
        await interaction.editReply({
          embeds: [successEmbed(`بدأت التسجيل في <#${channel.id}> | Recording started in <#${channel.id}>.`)],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : L.unknownError;
        await interaction.editReply({ embeds: [errorEmbed(msg)] });
      } finally {
        STARTING.delete(guildId);
      }
      return;
    }

    if (sub === "stop") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const stopped = await recordingManager.stop(interaction.guild.id);
      if (!stopped) {
        await interaction.editReply({ embeds: [errorEmbed(L.notRecording)] });
        return;
      }
      const dur = L.formatDuration(Math.floor((Date.now() - stopped.startedAt) / 1000));
      await interaction.editReply({
        embeds: [
          successEmbed(
            `تم إيقاف التسجيل — المدة: ${dur}\nRecording stopped — duration: ${dur}`
          ),
        ],
      });
      return;
    }

    if (sub === "pause") {
      const session = recordingManager.get(interaction.guild.id);
      if (!session) {
        await interaction.reply({ embeds: [errorEmbed(L.notRecording)], flags: MessageFlags.Ephemeral });
        return;
      }
      const ok = recordingManager.pause(interaction.guild.id);
      await interaction.reply({
        embeds: [ok ? successEmbed(L.recPaused) : errorEmbed(L.recAlreadyPaused)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "resume") {
      const session = recordingManager.get(interaction.guild.id);
      if (!session) {
        await interaction.reply({ embeds: [errorEmbed(L.notRecording)], flags: MessageFlags.Ephemeral });
        return;
      }
      const ok = recordingManager.resume(interaction.guild.id);
      await interaction.reply({
        embeds: [ok ? successEmbed(L.recResumed) : errorEmbed(L.recNotPaused)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  },
};
