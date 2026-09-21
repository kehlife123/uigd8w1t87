'use strict';

const { ActivityType, Client, Events, GatewayIntentBits } = require('discord.js');
const store = require('./store');
const panel = require('./panel');
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
  await client.login(token);
}

async function stop() {
  await client.destroy();
}

module.exports = { start, stop, isReady: () => client.isReady() };
