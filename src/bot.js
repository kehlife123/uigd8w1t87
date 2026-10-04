'use strict';

const { ActivityType, Client, Events, GatewayIntentBits } = require('discord.js');
const store = require('./store');
const panel = require('./panel');
const backup = require('./backup');
const protection = require('./protection');
const { getOwnerId, getPrefix } = require('./constants');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privilégié : arrivées de membres / bots
    GatewayIntentBits.GuildModeration, // journal d'audit en temps réel
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privilégié : commande =panel
  ],
  allowedMentions: { parse: [] },
  presence: { status: 'online', activities: [{ name: 'le serveur', type: ActivityType.Watching }] },
});

async function setupGuild(guild, { sweep = false } = {}) {
  try {
    await protection.initGuild(guild);
    protection.resumeRaid(guild);
    if (sweep) await protection.sweepBots(guild);
  } catch (err) {
    console.error(`[setup] ${guild.name} :`, err);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Connecté en tant que ${c.user.tag} — ${c.guilds.cache.size} serveur(s)`);
  for (const guild of c.guilds.cache.values()) await setupGuild(guild, { sweep: true });
});

client.on(Events.GuildCreate, (guild) => setupGuild(guild));

client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  try {
    await protection.handleAuditEntry(entry, guild);
  } catch (err) {
    console.error('[audit] Erreur :', err);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await protection.handleMemberAdd(member);
  } catch (err) {
    console.error('[member-add] Erreur :', err);
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) return;

    const isCommand = message.content.trim().toLowerCase() === `${getPrefix()}panel`;
    if (isCommand && !message.author.bot && message.author.id === getOwnerId()) {
      await message.channel.send(panel.build(message.guild, 'home'));
      await message.delete().catch(() => {});
      return;
    }

    // =import + fichier joint : importe une sauvegarde exportée (owner uniquement)
    const isImport = message.content.trim().toLowerCase() === `${getPrefix()}import`;
    if (isImport && !message.author.bot && message.author.id === getOwnerId()) {
      const file = message.attachments.first();
      if (!file) {
        await message.reply({ content: 'Joins le fichier .json.gz exporté au message.', allowedMentions: { parse: [] } });
        return;
      }
      try {
        const res = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`téléchargement impossible (${res.status})`);
        const entry = await backup.importBuffer(message.guild.id, Buffer.from(await res.arrayBuffer()));
        await message.reply({
          content: `Sauvegarde importée (${new Date(entry.createdAt).toISOString().slice(0, 10)}). Ouvre le panel > Sauvegarde pour la restaurer.`,
          allowedMentions: { parse: [] },
        });
        await message.delete().catch(() => {});
      } catch (err) {
        await message.reply({ content: `Import impossible : ${err.message}`, allowedMentions: { parse: [] } });
      }
      return;
    }

    await protection.handleMessage(message);
  } catch (err) {
    console.error('[message] Erreur :', err);
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  panel.handleInteraction(interaction).catch((err) => console.error('[interaction] Erreur :', err));
});

client.on(Events.Error, (err) => console.error('[client] Erreur :', err));

async function start() {
  const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
  if (!token) throw new Error('La variable DISCORD_TOKEN est manquante.');
  if (!getOwnerId() || !/^\d{17,20}$/.test(getOwnerId())) {
    throw new Error('La variable OWNER_ID est manquante ou invalide (ID Discord de l’owner).');
  }
  store.load();
  backup.init();
  await client.login(token);
}

async function stop() {
  await client.destroy();
}

module.exports = { start, stop, isReady: () => client.isReady() };
