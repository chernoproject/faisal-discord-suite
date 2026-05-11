import {
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../client.js";
import { errorEmbed, successEmbed, buildEmbed } from "../ui/embeds.js";
import { env } from "../config/env.js";
import {
  sendCompanion,
  isCompanionConfigured,
  isCompanionReady,
} from "../modules/companion/client.js";
import { Palette } from "../utils/colors.js";

const STATUS_CHOICES = [
  { name: "متاح (Online)", value: "online" },
  { name: "مشغول (Do Not Disturb)", value: "dnd" },
  { name: "غائب (Idle)", value: "idle" },
  { name: "مخفي (Invisible)", value: "invisible" },
] as const;

function ownerOnly(interaction: ChatInputCommandInteraction): boolean {
  if (!env.OWNER_ID) return true;
  return interaction.user.id === env.OWNER_ID;
}

async function fetchAttachmentAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`فشل تحميل الصورة (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

export const accountCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("account")
    .setDescription("تحكم بحساب الـ Companion (الاسم، الصورة، الستاتس) عبر تطبيق Windows")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString())
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("status")
        .setDescription("اعرض حالة الـ companion ومعلومات الحساب")
    )
    .addSubcommand((s) =>
      s
        .setName("name")
        .setDescription("غيّر اسم الحساب (Username)")
        .addStringOption((o) =>
          o.setName("value").setDescription("الاسم الجديد").setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("display-name")
        .setDescription("غيّر اسم العرض (Global Name)")
        .addStringOption((o) =>
          o.setName("value").setDescription("اسم العرض الجديد").setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("bio")
        .setDescription("غيّر الـ Bio")
        .addStringOption((o) =>
          o
            .setName("value")
            .setDescription("الـ Bio الجديد (اتركه فاضي للمسح)")
            .setRequired(false)
            .setMaxLength(190)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("avatar")
        .setDescription("غيّر الأفتار")
        .addAttachmentOption((o) =>
          o.setName("image").setDescription("الصورة الجديدة (PNG/JPG)").setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("banner")
        .setDescription("غيّر البانر")
        .addAttachmentOption((o) =>
          o.setName("image").setDescription("صورة البانر الجديدة").setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("presence")
        .setDescription("غيّر حالة التواجد (Online/DND/Idle/Invisible)")
        .addStringOption((o) => {
          const opt = o
            .setName("value")
            .setDescription("الحالة")
            .setRequired(true);
          for (const c of STATUS_CHOICES) opt.addChoices({ name: c.name, value: c.value });
          return opt;
        })
    )
    .addSubcommand((s) =>
      s
        .setName("custom-status")
        .setDescription("ضع Custom Status (اتركه فاضي للمسح)")
        .addStringOption((o) =>
          o.setName("text").setDescription("النص").setRequired(false).setMaxLength(128)
        )
        .addStringOption((o) =>
          o.setName("emoji").setDescription("اسم الإيموجي (اختياري)").setRequired(false)
        )
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!ownerOnly(interaction)) {
      await interaction.reply({
        embeds: [errorEmbed("هذا الأمر لمالك البوت فقط.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const sub = interaction.options.getSubcommand(true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      switch (sub) {
        case "status": {
          if (!isCompanionConfigured()) {
            await interaction.editReply({
              embeds: [
                errorEmbed(
                  "Companion غير مضبوط — عبّ COMPANION_WS_URL و COMPANION_AUTH_TOKEN في bot/.env.\nمثال: COMPANION_WS_URL=ws://localhost:8788\nCOMPANION_AUTH_TOKEN=نفس BOT_AUTH_TOKEN في companion/.env"
                ),
              ],
            });
            return;
          }
          const ready = isCompanionReady();
          let me: unknown = null;
          if (ready) {
            const r = await sendCompanion("account.me");
            me = r.ok ? r.data : { error: r.error };
          }
          await interaction.editReply({
            embeds: [
              buildEmbed({
                title: "حالة Companion",
                description: ready ? "✅ متصل" : "⚠️ غير متصل",
                color: ready ? Palette.success : Palette.warn,
                fields: me
                  ? [
                      {
                        name: "/me",
                        value: "```json\n" + JSON.stringify(me, null, 2).slice(0, 900) + "\n```",
                      },
                    ]
                  : [],
              }),
            ],
          });
          return;
        }
        case "name": {
          const v = interaction.options.getString("value", true);
          const r = await sendCompanion("account.set_username", { value: v });
          await replyResult(interaction, r, `تم تغيير اسم المستخدم إلى **${v}**`);
          return;
        }
        case "display-name": {
          const v = interaction.options.getString("value", true);
          const r = await sendCompanion("account.set_global_name", { value: v });
          await replyResult(interaction, r, `تم تغيير اسم العرض إلى **${v}**`);
          return;
        }
        case "bio": {
          const v = interaction.options.getString("value") ?? "";
          const r = await sendCompanion("account.set_bio", { value: v });
          await replyResult(interaction, r, v ? "تم تحديث الـ Bio." : "تم مسح الـ Bio.");
          return;
        }
        case "avatar": {
          const att = interaction.options.getAttachment("image", true);
          const base64 = await fetchAttachmentAsBase64(att.url);
          const r = await sendCompanion("account.set_avatar", { base64 });
          await replyResult(interaction, r, "تم تحديث الأفتار.");
          return;
        }
        case "banner": {
          const att = interaction.options.getAttachment("image", true);
          const base64 = await fetchAttachmentAsBase64(att.url);
          const r = await sendCompanion("account.set_banner", { base64 });
          await replyResult(interaction, r, "تم تحديث البانر.");
          return;
        }
        case "presence": {
          const v = interaction.options.getString("value", true);
          const r = await sendCompanion("account.set_status", { value: v });
          await replyResult(interaction, r, `الستاتس صار: **${v}**`);
          return;
        }
        case "custom-status": {
          const text = interaction.options.getString("text") ?? "";
          const emoji = interaction.options.getString("emoji") ?? "";
          const r = await sendCompanion("account.set_custom_status", { text, emoji });
          await replyResult(interaction, r, text ? `Custom Status: ${text}` : "تم مسح Custom Status.");
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "خطأ غير متوقع";
      await interaction.editReply({ embeds: [errorEmbed(msg)] });
    }
  },
};

async function replyResult(
  interaction: ChatInputCommandInteraction,
  r: { ok: boolean; error?: string; data?: unknown },
  okMessage: string
): Promise<void> {
  if (r.ok) {
    await interaction.editReply({ embeds: [successEmbed(okMessage)] });
  } else {
    await interaction.editReply({
      embeds: [errorEmbed(r.error ?? "فشل التنفيذ في الـ companion.")],
    });
  }
}
