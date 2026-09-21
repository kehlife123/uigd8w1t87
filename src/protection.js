'use strict';

const { AuditLogEvent } = require('discord.js');
const store = require('./store');
const tracker = require('./tracker');
const { sendLog } = require('./logger');
const { isExempt, quarantineMember } = require('./quarantine');
const { COLORS, DANGEROUS_MASK, MASS_MENTION_MIN, MODULES } = require('./constants');

// Action du journal d'audit -> module de protection
const ACTION_MODULES = {
  [AuditLogEvent.ChannelCreate]: 'channelCreate',
  [AuditLogEvent.ChannelDelete]: 'channelDelete',
  [AuditLogEvent.RoleCreate]: 'roleCreate',
  [AuditLogEvent.RoleDelete]: 'roleDelete',
  [AuditLogEvent.RoleUpdate]: 'roleUpdate',
  [AuditLogEvent.MemberBanAdd]: 'memberBan',
  [AuditLogEvent.MemberKick]: 'memberKick',
  [AuditLogEvent.MemberPrune]: 'memberKick',
  [AuditLogEvent.WebhookCreate]: 'webhookCreate',
  [AuditLogEvent.EmojiDelete]: 'emojiDelete',
  [AuditLogEvent.StickerDelete]: 'emojiDelete',
  [AuditLogEvent.GuildUpdate]: 'guildUpdate',
};

const kickedBots = new Map(); // `${guildId}:${botId}` -> timestamp
const recentJoins = new Map(); // guildId -> [{ id, t }]
const raidTimers = new Map(); // guildId -> Timeout
const raidBuffers = new Map(); // guildId -> { ids, timer }

const toBig = (value) => {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
};

/* -------------------------------------------------------------------------- */
/*  Whitelist des bots                                                        */
/* -------------------------------------------------------------------------- */

function isBotAllowed(guild, botId) {
  return botId === guild.client.user.id || Boolean(store.guild(guild.id).whitelist.bots[botId]);
}

async function kickUnauthorizedBot(guild, botId, source) {
  const key = `${guild.id}:${botId}`;
  const last = kickedBots.get(key);
  if (last && Date.now() - last < 30_000) return false;

  const member = guild.members.cache.get(botId) || (await guild.members.fetch(botId).catch(() => null));
  if (!member) return false;

  const again = kickedBots.get(key);
  if (again && Date.now() - again < 30_000) return false;
  kickedBots.set(key, Date.now());

  if (!member.kickable) {
    await sendLog(guild, {
      title: 'Bot non autorisé détecté — expulsion impossible',
      color: COLORS.alert,
      fields: [
        ['Bot', `${member.user.username} (\`${botId}\`)`],
        ['Source', source],
        ['Erreur', 'Le rôle du bot Anti-Raid doit être placé au-dessus de celui de ce bot.'],
      ],
    });
    return false;
  }

  try {
    await member.kick('Anti-Raid — bot non whitelisté');
  } catch (err) {
    await sendLog(guild, {
      title: 'Bot non autorisé détecté — expulsion impossible',
      color: COLORS.alert,
      fields: [
        ['Bot', `${member.user.username} (\`${botId}\`)`],
        ['Source', source],
        ['Erreur', err.message],
      ],
    });
    return false;
  }

  await sendLog(guild, {
    title: 'Bot non autorisé expulsé',
    color: COLORS.alert,
    fields: [
      ['Bot', `${member.user.username} (\`${botId}\`)`],
      ['Source', source],
      ['Action', 'Expulsion automatique (absent de la whitelist)'],
    ],
  });
  return true;
}

/** Première configuration d'un serveur : les bots déjà présents sont whitelistés. */
async function initGuild(guild) {
  const cfg = store.guild(guild.id);
  if (cfg.initialized) return;

  try {
    await guild.members.fetch();
  } catch (err) {
    console.error(`[init] Impossible de récupérer les membres de ${guild.name} :`, err.message);
    return; // nouvelle tentative au prochain démarrage
  }

  const now = Date.now();
  let count = 0;
  for (const member of guild.members.cache.values()) {
    if (member.user.bot && member.id !== guild.client.user.id && !cfg.whitelist.bots[member.id]) {
      cfg.whitelist.bots[member.id] = { name: member.user.username, addedAt: now, auto: true };
      count++;
    }
  }
  cfg.initialized = true;
  store.save();
  console.log(`[init] ${guild.name} : ${count} bot(s) présent(s) ajouté(s) à la whitelist.`);
}

/** Expulse les bots non whitelistés arrivés pendant que le bot était hors ligne. */
async function sweepBots(guild) {
  const cfg = store.guild(guild.id);
  if (!cfg.initialized || !cfg.whitelist.enabled) return;
  await guild.members.fetch().catch(() => null);
  for (const member of guild.members.cache.values()) {
    if (member.user.bot && !isBotAllowed(guild, member.id)) {
      await kickUnauthorizedBot(guild, member.id, 'Vérification au démarrage');
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Anti-nuke (journal d'audit)                                               */
/* -------------------------------------------------------------------------- */

async function track(guild, moduleKey, userId, weight = 1, detail = null) {
  const cfg = store.guild(guild.id);
  const mod = cfg.modules[moduleKey];
  if (!mod || !mod.enabled) return false;

  const count = tracker.hit(`${guild.id}:${moduleKey}:${userId}`, mod.window * 1000, weight);
  if (count < mod.limit) return false;

  const def = MODULES[moduleKey];
  await quarantineMember(guild, userId, {
    trigger: def.label,
    reason: detail || `${count} ${def.unit} en ${mod.window} s (seuil : ${mod.limit})`,
  });
  return true;
}

function grantsDangerousPerms(entry, guild) {
  const changes = entry.changes || [];

  if (entry.action === AuditLogEvent.RoleCreate || entry.action === AuditLogEvent.RoleUpdate) {
    const change = changes.find((c) => c.key === 'permissions');
    if (!change) return false;
    const added = toBig(change.new) & ~toBig(change.old);
    return (added & DANGEROUS_MASK) !== 0n;
  }

  if (entry.action === AuditLogEvent.MemberRoleUpdate) {
    const change = changes.find((c) => c.key === '$add');
    if (!change || !Array.isArray(change.new)) return false;
    return change.new.some((r) => {
      const role = guild.roles.cache.get(r.id);
      return role && (role.permissions.bitfield & DANGEROUS_MASK) !== 0n;
    });
  }

  return false;
}

async function handleAuditEntry(entry, guild) {
  const executorId = entry.executorId;
  if (!executorId || executorId === guild.client.user.id) return;
  const cfg = store.guild(guild.id);

  // Ajout d'un bot : whitelist obligatoire.
  if (entry.action === AuditLogEvent.BotAdd) {
    if (!cfg.whitelist.enabled) return;
    const botId = entry.targetId;
    if (!botId || isBotAllowed(guild, botId)) return;

    await kickUnauthorizedBot(guild, botId, 'Journal d’audit');
    if (cfg.punishInviter && !isExempt(guild, executorId)) {
      await quarantineMember(guild, executorId, {
        trigger: 'Whitelist des bots',
        reason: `A ajouté un bot non whitelisté (\`${botId}\`)`,
      });
    }
    return;
  }

  if (isExempt(guild, executorId) || cfg.quarantined[executorId]) return;

  // Les rôles « gérés » (créés par l'ajout d'un bot) ne sont pas comptabilisés.
  if (entry.action === AuditLogEvent.RoleCreate || entry.action === AuditLogEvent.RoleUpdate) {
    if (guild.roles.cache.get(entry.targetId)?.managed) return;
  }

  const moduleKey = ACTION_MODULES[entry.action];
  if (moduleKey) {
    let weight = 1;
    if (entry.action === AuditLogEvent.MemberPrune) weight = Math.max(1, Number(entry.extra?.removed) || 1);
    if (await track(guild, moduleKey, executorId, weight)) return;
  }

  if (grantsDangerousPerms(entry, guild)) {
    await track(
      guild,
      'dangerousPerms',
      executorId,
      1,
      'Octroi de permissions sensibles à un rôle ou à un membre.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Arrivées de membres : whitelist des bots, mode raid, flood                */
/* -------------------------------------------------------------------------- */

function bufferRaidKick(guild, userId) {
  let buffer = raidBuffers.get(guild.id);
  if (!buffer) {
    buffer = { ids: [], timer: setTimeout(() => flushRaidBuffer(guild), 5000) };
    raidBuffers.set(guild.id, buffer);
  }
  buffer.ids.push(userId);
}

async function flushRaidBuffer(guild) {
  const buffer = raidBuffers.get(guild.id);
  raidBuffers.delete(guild.id);
  if (!buffer || !buffer.ids.length) return;
  const shown = buffer.ids.slice(0, 10).map((id) => `<@${id}>`).join(' ');
  const extra = buffer.ids.length > 10 ? ` … +${buffer.ids.length - 10}` : '';
  await sendLog(guild, {
    title: 'Mode raid — membres expulsés',
    color: COLORS.warn,
    fields: [
      ['Total', String(buffer.ids.length)],
      ['Membres', `${shown}${extra}`],
    ],
  });
}

async function raidKick(member) {
  try {
    if (!member.kickable) return false;
    await member.kick('Anti-Raid — mode raid actif');
    bufferRaidKick(member.guild, member.id);
    return true;
  } catch (err) {
    console.error('[raid] Expulsion impossible :', err.message);
    return false;
  }
}

async function activateRaid(guild, { reason }) {
  const cfg = store.guild(guild.id);
  const minutes = cfg.modules.joinFlood.duration || 5;
  cfg.raid = { active: true, since: Date.now(), until: Date.now() + minutes * 60_000, reason };
  store.save();
  scheduleRaidEnd(guild);
  await sendLog(guild, {
    title: 'Mode raid activé',
    color: COLORS.alert,
    fields: [
      ['Motif', reason],
      ['Fin prévue', `<t:${Math.floor(cfg.raid.until / 1000)}:R>`],
      ['Effet', 'Les nouveaux membres sont expulsés automatiquement'],
    ],
  });
}

async function deactivateRaid(guild, { reason }) {
  const cfg = store.guild(guild.id);
  clearTimeout(raidTimers.get(guild.id));
  raidTimers.delete(guild.id);
  if (!cfg.raid.active) return;
  cfg.raid = { active: false, since: null, until: null, reason: null };
  store.save();
  await sendLog(guild, {
    title: 'Mode raid désactivé',
    color: COLORS.success,
    fields: [['Motif', reason]],
  });
}

function scheduleRaidEnd(guild) {
  clearTimeout(raidTimers.get(guild.id));
  const cfg = store.guild(guild.id);
  if (!cfg.raid.active) return;
  const delay = Math.max(0, (cfg.raid.until || 0) - Date.now());
  raidTimers.set(
    guild.id,
    setTimeout(() => {
      deactivateRaid(guild, { reason: 'Durée écoulée' }).catch((e) => console.error('[raid]', e));
    }, delay),
  );
}

/** À appeler au démarrage : reprend un mode raid en cours. */
function resumeRaid(guild) {
  const cfg = store.guild(guild.id);
  if (cfg.raid.active) scheduleRaidEnd(guild);
}

async function handleMemberAdd(member) {
  const guild = member.guild;
  const cfg = store.guild(guild.id);

  if (member.user.bot) {
    if (member.id === guild.client.user.id) return;
    if (cfg.whitelist.enabled && !isBotAllowed(guild, member.id)) {
      await kickUnauthorizedBot(guild, member.id, 'Arrivée sur le serveur');
    }
    return;
  }

  if (isExempt(guild, member.id)) return;

  if (cfg.raid.active) {
    await raidKick(member);
    return;
  }

  const mod = cfg.modules.joinFlood;
  if (!mod.enabled) return;

  const now = Date.now();
  const list = (recentJoins.get(guild.id) || []).filter((j) => now - j.t < mod.window * 1000);
  list.push({ id: member.id, t: now });
  recentJoins.set(guild.id, list);

  if (list.length >= mod.limit) {
    recentJoins.delete(guild.id);
    await activateRaid(guild, {
      reason: `Flood de membres : ${list.length} arrivées en ${mod.window} s (seuil : ${mod.limit})`,
    });
    for (const join of list) {
      if (isExempt(guild, join.id)) continue;
      const target = guild.members.cache.get(join.id) || (await guild.members.fetch(join.id).catch(() => null));
      if (target && !target.user.bot) await raidKick(target);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Mentions de masse                                                         */
/* -------------------------------------------------------------------------- */

async function handleMessage(message) {
  if (!message.guild || message.webhookId || message.system) return;
  const guild = message.guild;
  const authorId = message.author.id;
  if (authorId === guild.client.user.id) return;

  const cfg = store.guild(guild.id);
  if (!cfg.modules.massMention.enabled) return;
  if (isExempt(guild, authorId) || cfg.quarantined[authorId]) return;

  const mentions = message.mentions.users.size + message.mentions.roles.size;
  const isMass = message.mentions.everyone || mentions >= MASS_MENTION_MIN;
  if (!isMass) return;

  const flagged = await track(guild, 'massMention', authorId);
  if (flagged) message.delete().catch(() => {});
}

module.exports = {
  activateRaid,
  deactivateRaid,
  handleAuditEntry,
  handleMemberAdd,
  handleMessage,
  initGuild,
  isBotAllowed,
  kickUnauthorizedBot,
  resumeRaid,
  sweepBots,
};
