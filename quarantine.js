'use strict';

const store = require('./store');
const tracker = require('./tracker');
const { sendLog, clip } = require('./logger');
const { COLORS, DANGEROUS_MASK, getOwnerId } = require('./constants');

const inflight = new Set();
const cooldown = new Map();
const COOLDOWN_MS = 60_000;

/** Cibles intouchables : owner du bot, owner du serveur, le bot lui-même. */
function isProtected(guild, userId) {
  return userId === getOwnerId() || userId === guild.ownerId || userId === guild.client.user.id;
}

/** Cibles ignorées par la détection automatique (protégées + liste d'exemptions). */
function isExempt(guild, userId) {
  return isProtected(guild, userId) || Boolean(store.guild(guild.id).exempt[userId]);
}

/**
 * Met un membre (humain ou bot) en quarantaine :
 * retire tous ses rôles retirables et lui donne le rôle de quarantaine.
 */
async function quarantineMember(guild, userId, { reason, trigger, manual = false }) {
  const cfg = store.guild(guild.id);

  if (manual ? isProtected(guild, userId) : isExempt(guild, userId)) {
    return { ok: false, skipped: true, error: 'Cette cible est protégée.' };
  }
  if (cfg.quarantined[userId]) {
    return { ok: false, skipped: true, error: 'Ce membre est déjà en quarantaine.' };
  }

  const key = `${guild.id}:${userId}`;
  if (inflight.has(key)) return { ok: false, skipped: true, error: 'Traitement déjà en cours.' };
  if (!manual) {
    const last = cooldown.get(key);
    if (last && Date.now() - last < COOLDOWN_MS) return { ok: false, skipped: true };
  }

  inflight.add(key);
  try {
    return await run(guild, userId, { reason, trigger });
  } catch (err) {
    cooldown.set(key, Date.now());
    console.error('[quarantine] Erreur inattendue :', err);
    await sendLog(guild, {
      title: 'Quarantaine impossible',
      color: COLORS.warn,
      fields: [
        ['Cible', `<@${userId}> (\`${userId}\`)`],
        ['Motif', reason],
        ['Erreur', err.message],
      ],
    });
    return { ok: false, error: err.message };
  } finally {
    inflight.delete(key);
  }
}

async function run(guild, userId, { reason, trigger }) {
  const cfg = store.guild(guild.id);
  const key = `${guild.id}:${userId}`;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    cooldown.set(key, Date.now());
    await sendLog(guild, {
      title: 'Quarantaine impossible',
      color: COLORS.warn,
      fields: [
        ['Cible', `<@${userId}> (\`${userId}\`)`],
        ['Déclencheur', trigger],
        ['Motif', reason],
        ['Raison', 'La cible a déjà quitté le serveur ou est introuvable.'],
      ],
    });
    return { ok: false, error: 'Membre introuvable sur le serveur.' };
  }

  const me = guild.members.me || (await guild.members.fetchMe());
  const qRole = cfg.quarantineRoleId ? guild.roles.cache.get(cfg.quarantineRoleId) : null;
  const notes = [];
  if (!qRole) notes.push('Aucun rôle de quarantaine valide n’est configuré : rôles retirés uniquement.');
  else if (!qRole.editable) notes.push('Le rôle de quarantaine est au-dessus du rôle du bot : rôles retirés uniquement.');
  const canGiveRole = Boolean(qRole && qRole.editable);

  let removed = [];
  let failure = null;

  if (!member.manageable) {
    failure = 'Hiérarchie insuffisante : le rôle du bot doit être placé au-dessus de celui de la cible.';
  } else {
    const top = me.roles.highest.position;
    const kept = [];
    for (const role of member.roles.cache.values()) {
      if (role.id === guild.id) continue; // @everyone
      if (role.managed || role.position >= top) kept.push(role.id);
      else removed.push(role.id);
    }
    const next = canGiveRole ? [...kept, qRole.id] : kept;
    try {
      await member.roles.set(next, clip(`Anti-Raid — ${trigger} : ${reason}`, 400));
    } catch (err) {
      failure = `Erreur Discord : ${err.message}`;
      removed = [];
    }
  }

  if (failure) {
    cooldown.set(key, Date.now());
    let kicked = false;
    if (member.user.bot && member.kickable) {
      kicked = await member
        .kick(clip(`Anti-Raid — ${trigger}`, 400))
        .then(() => true)
        .catch(() => false);
    }
    await sendLog(guild, {
      title: 'Échec de la mise en quarantaine',
      color: COLORS.alert,
      fields: [
        ['Cible', `${member.user.username} (\`${userId}\`)`],
        ['Déclencheur', trigger],
        ['Motif', reason],
        ['Erreur', failure],
        ...(kicked ? [['Action de secours', 'Bot expulsé du serveur']] : []),
      ],
    });
    return { ok: false, error: failure, kicked };
  }

  cfg.quarantined[userId] = {
    name: member.user.username,
    bot: member.user.bot,
    roles: removed,
    roleId: canGiveRole ? qRole.id : null,
    reason,
    trigger,
    at: Date.now(),
  };
  store.save();

  // Un bot peut conserver un rôle « géré » (intégration) avec des permissions sensibles :
  // on l'expulse dans ce cas.
  let kicked = false;
  if (member.user.bot) {
    const fresh = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
    if (fresh && fresh.permissions.any(DANGEROUS_MASK) && fresh.kickable) {
      kicked = await fresh
        .kick(clip(`Anti-Raid — permissions sensibles résiduelles (${trigger})`, 400))
        .then(() => true)
        .catch(() => false);
      if (kicked) {
        delete cfg.quarantined[userId];
        store.save();
      }
    }
  }

  const removedText = removed.length ? removed.map((id) => `<@&${id}>`).join(' ') : 'Aucun';
  await sendLog(guild, {
    title: member.user.bot ? 'Bot mis en quarantaine' : 'Membre mis en quarantaine',
    color: COLORS.alert,
    fields: [
      ['Cible', `${member.user.username} (\`${userId}\`) — <@${userId}>`],
      ['Déclencheur', trigger],
      ['Motif', reason],
      ['Rôles retirés', `${removed.length} — ${removedText}`],
      ['Rôle appliqué', canGiveRole ? `<@&${qRole.id}>` : 'Aucun'],
      ...(kicked ? [['Action complémentaire', 'Bot expulsé (rôle géré avec permissions sensibles)']] : []),
      ...notes.map((n) => ['Remarque', n]),
    ],
  });

  return { ok: true, removed: removed.length, kicked };
}

/** Libère un membre : retire le rôle de quarantaine et restaure ses anciens rôles. */
async function releaseMember(guild, userId) {
  const cfg = store.guild(guild.id);
  const record = cfg.quarantined[userId];
  if (!record) return { ok: false, error: 'Ce membre n’est pas en quarantaine.' };

  const member = await guild.members.fetch(userId).catch(() => null);
  let restored = [];

  if (member) {
    const current = member.roles.cache
      .filter((r) => r.id !== guild.id && r.id !== record.roleId)
      .map((r) => r.id);
    restored = (record.roles || []).filter((id) => {
      const role = guild.roles.cache.get(id);
      return role && !role.managed && role.editable;
    });
    const next = [...new Set([...current, ...restored])];
    try {
      await member.roles.set(next, 'Anti-Raid — libération de la quarantaine');
    } catch (err) {
      return { ok: false, error: `Erreur Discord : ${err.message}` };
    }
  }

  delete cfg.quarantined[userId];
  store.save();
  tracker.reset(guild.id, userId);
  cooldown.delete(`${guild.id}:${userId}`);

  await sendLog(guild, {
    title: 'Quarantaine levée',
    color: COLORS.success,
    fields: [
      ['Cible', `${record.name || 'Inconnu'} (\`${userId}\`)${member ? ` — <@${userId}>` : ''}`],
      ['Rôles restaurés', member ? String(restored.length) : 'Membre absent du serveur'],
      ['Par', `<@${process.env.OWNER_ID}>`],
    ],
  });

  return { ok: true, present: Boolean(member), restored: restored.length };
}

module.exports = { isExempt, isProtected, quarantineMember, releaseMember };
