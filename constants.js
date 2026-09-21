'use strict';

const { PermissionFlagsBits: P } = require('discord.js');

const COLORS = {
  panel: 0x4e5058,
  info: 0x4e5058,
  alert: 0xed4245,
  warn: 0xf0b232,
  success: 0x3ba55d,
};

// Permissions considérées comme sensibles (octroi = activité suspecte).
const DANGEROUS_MASK = [
  P.Administrator,
  P.ManageGuild,
  P.ManageRoles,
  P.ManageChannels,
  P.ManageWebhooks,
  P.BanMembers,
  P.KickMembers,
].reduce((acc, flag) => acc | flag, 0n);

// Modules de protection. limit = nombre d'actions qui déclenche la quarantaine,
// window = fenêtre de temps en secondes.
const MODULES = {
  channelDelete: {
    label: 'Suppression de salons',
    desc: 'Suppressions de salons en rafale.',
    unit: 'actions',
    limit: 3,
    window: 10,
  },
  channelCreate: {
    label: 'Création de salons',
    desc: 'Créations de salons en rafale.',
    unit: 'actions',
    limit: 5,
    window: 10,
  },
  roleDelete: {
    label: 'Suppression de rôles',
    desc: 'Suppressions de rôles en rafale.',
    unit: 'actions',
    limit: 3,
    window: 10,
  },
  roleCreate: {
    label: 'Création de rôles',
    desc: 'Créations de rôles en rafale.',
    unit: 'actions',
    limit: 5,
    window: 10,
  },
  roleUpdate: {
    label: 'Modification de rôles',
    desc: 'Modifications de rôles en rafale (nom, couleur, permissions…).',
    unit: 'actions',
    limit: 5,
    window: 10,
  },
  memberBan: {
    label: 'Bannissements',
    desc: 'Bannissements en rafale.',
    unit: 'actions',
    limit: 3,
    window: 10,
  },
  memberKick: {
    label: 'Expulsions',
    desc: 'Expulsions et nettoyages de membres (prune) en rafale.',
    unit: 'actions',
    limit: 3,
    window: 10,
  },
  webhookCreate: {
    label: 'Création de webhooks',
    desc: 'Créations de webhooks en rafale.',
    unit: 'actions',
    limit: 3,
    window: 10,
  },
  emojiDelete: {
    label: 'Suppression d’emojis et stickers',
    desc: 'Suppressions d’emojis ou de stickers en rafale.',
    unit: 'actions',
    limit: 5,
    window: 10,
  },
  guildUpdate: {
    label: 'Modification du serveur',
    desc: 'Changements répétés des paramètres du serveur (nom, icône, URL personnalisée…).',
    unit: 'actions',
    limit: 3,
    window: 30,
  },
  dangerousPerms: {
    label: 'Permissions dangereuses',
    desc:
      'Octroi de permissions sensibles (Administrateur, gestion du serveur, des rôles, des salons, ' +
      'des webhooks, bannir ou expulser) à un rôle ou à un membre.',
    unit: 'actions',
    limit: 1,
    window: 60,
  },
  massMention: {
    label: 'Mentions de masse',
    desc: 'Messages contenant @everyone, @here ou au moins 10 mentions.',
    unit: 'messages',
    limit: 3,
    window: 10,
  },
  joinFlood: {
    label: 'Flood de membres',
    desc:
      'Arrivées massives de comptes. Déclenche le mode raid : les nouveaux membres sont expulsés ' +
      'automatiquement pendant la durée définie.',
    unit: 'arrivées',
    limit: 8,
    window: 10,
    duration: 5,
  },
};

const MASS_MENTION_MIN = 10;
const ID_RE = /^\d{17,20}$/;

const getOwnerId = () => process.env.OWNER_ID;
const getPrefix = () => process.env.PREFIX || '=';

module.exports = { COLORS, DANGEROUS_MASK, MODULES, MASS_MENTION_MIN, ID_RE, getOwnerId, getPrefix };
