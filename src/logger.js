'use strict';

const {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} = require('discord.js');
const store = require('./store');
const { COLORS } = require('./constants');

const clip = (str, max) => {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * Envoie un log (Components V2) dans le salon configuré.
 * Retourne true si le message a bien été envoyé.
 */
async function sendLog(guild, { title, color = COLORS.info, description, fields = [] }) {
  const cfg = store.guild(guild.id);
  if (!cfg.logChannelId) return false;

  try {
    const channel =
      guild.channels.cache.get(cfg.logChannelId) ||
      (await guild.channels.fetch(cfg.logChannelId).catch(() => null));
    if (!channel || !channel.isTextBased()) return false;

    const container = new ContainerBuilder()
      .setAccentColor(color)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### ${clip(title, 200)}${description ? `\n${clip(description, 800)}` : ''}`),
      );

    if (fields.length) {
      const body = fields.map(([label, value]) => `**${label}** — ${clip(value, 600)}`).join('\n');
      container
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(clip(body, 3000)));
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# <t:${Math.floor(Date.now() / 1000)}:F>`),
    );

    await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (err) {
    console.error(`[log] Envoi impossible (${guild.name}) :`, err.message);
    return false;
  }
}

module.exports = { sendLog, clip };
