import {
  ChatInputCommandInteraction,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../client.js";
import { errorEmbed, successEmbed } from "../ui/embeds.js";
import { env } from "../config/env.js";
import { sendCompanion } from "../modules/companion/client.js";

export const voiceCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("voice")
    .setDescription("تحكم بحساب الـ Companion في الروم الصوتي")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString())
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("join")
        .setDescription("ادخل روم صوتي")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("الروم (الافتراضي: روم التثبيت)")
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(false)
        )
    )
    .addSubcommand((s) => s.setName("leave").setDescription("اخرج من الروم"))
    .addSubcommand((s) =>
      s
        .setName("mute")
        .setDescription("اكتم / فك الكتم")
        .addBooleanOption((o) =>
          o.setName("value").setDescription("true = كتم / false = فك").setRequired(true)
        )
    )
    .addSubcommand((s) => s.setName("record_start").setDescription("بدء تسجيل شاشة/صوت Windows من companion بدون دخول تلقائي للروم"))
    .addSubcommand((s) => s.setName("record_stop").setDescription("إيقاف تسجيل شاشة/صوت Windows من companion"))
    .addSubcommand((s) => s.setName("record_status").setDescription("حالة تسجيل شاشة/صوت Windows من companion")),
  async execute(interaction: ChatInputCommandInteraction) {
    if (env.OWNER_ID && interaction.user.id !== env.OWNER_ID) {
      await interaction.reply({
        embeds: [errorEmbed("هذا الأمر لمالك البوت فقط.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const sub = interaction.options.getSubcommand(true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (sub === "join") {
        const ch = interaction.options.getChannel("channel", false);
        const payload: Record<string, unknown> = {};
        if (ch) {
          payload.channelId = ch.id;
          if (interaction.guildId) payload.guildId = interaction.guildId;
        }
        const r = await sendCompanion("voice.join", payload);
        await interaction.editReply({
          embeds: [r.ok ? successEmbed("تم دخول حساب الـ companion للروم.") : errorEmbed(r.error ?? "فشل")],
        });
      } else if (sub === "leave") {
        const r = await sendCompanion("voice.leave");
        await interaction.editReply({
          embeds: [r.ok ? successEmbed("تم الخروج من الروم.") : errorEmbed(r.error ?? "فشل")],
        });
      } else if (sub === "mute") {
        const v = interaction.options.getBoolean("value", true);
        const r = await sendCompanion("voice.mute", { value: v ? "true" : "false" });
        await interaction.editReply({
          embeds: [r.ok ? successEmbed(v ? "تم الكتم." : "تم فك الكتم.") : errorEmbed(r.error ?? "فشل")],
        });
      } else if (sub === "record_start") {
        const r = await sendCompanion("capture.start", { label: `discord-${interaction.guildId ?? "guild"}` });
        const data = r.data as { outFile?: string } | undefined;
        await interaction.editReply({
          embeds: [
            r.ok
              ? successEmbed(`بدأ تسجيل شاشة/صوت Windows من companion.\nالملف | File: ${data?.outFile ?? "غير معروف"}`)
              : errorEmbed(r.error ?? "فشل بدء التسجيل"),
          ],
        });
      } else if (sub === "record_stop") {
        const r = await sendCompanion("capture.stop", {}, 30_000);
        const data = r.data as { outFile?: string; durationMs?: number } | null | undefined;
        await interaction.editReply({
          embeds: [
            r.ok && data
              ? successEmbed(`تم إيقاف تسجيل companion.\nالملف | File: ${data.outFile}\nالمدة | Duration: ${Math.round((data.durationMs ?? 0) / 1000)}s`)
              : errorEmbed(r.error ?? "ما فيه تسجيل companion شغال"),
          ],
        });
      } else if (sub === "record_status") {
        const r = await sendCompanion("capture.status");
        const data = r.data as { capturing?: boolean; info?: { outFile?: string; startedAt?: number } | null } | undefined;
        const elapsed = data?.info?.startedAt ? Math.round((Date.now() - data.info.startedAt) / 1000) : 0;
        await interaction.editReply({
          embeds: [
            r.ok
              ? successEmbed(data?.capturing ? `تسجيل companion شغال.\nالملف | File: ${data.info?.outFile ?? "غير معروف"}\nالمدة | Duration: ${elapsed}s` : "تسجيل companion غير شغال.")
              : errorEmbed(r.error ?? "فشل جلب الحالة"),
          ],
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "خطأ غير متوقع";
      await interaction.editReply({ embeds: [errorEmbed(msg)] });
    }
  },
};
