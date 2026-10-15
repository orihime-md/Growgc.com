import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pairRouter, { setPairingController, updatePairingStatus } from './pair.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============== CONFIG ===============
const BOT_SETTINGS_FILE = path.join(__dirname, 'bot-settings.json');
const AUTH_DIR = path.join(__dirname, 'auth', 'growbot');
const OWNER_NUMBER = process.env.OWNER_NUMBER?.replace(/\D/g, '') + '@s.whatsapp.net';
let PREFIX = '.';
const MARKED_GROUPS_FILE = path.join(__dirname, 'marked-groups.json');

// Load settings
try {
  const settings = JSON.parse(await readFile(BOT_SETTINGS_FILE, 'utf8'));
  if (typeof settings.prefix === 'string') PREFIX = settings.prefix;
} catch {
  await writeFile(BOT_SETTINGS_FILE, JSON.stringify({ prefix: '.' }, null, 2));
}

let MARKED_GROUPS = new Set();
try {
  const data = JSON.parse(await readFile(MARKED_GROUPS_FILE, 'utf8'));
  data.forEach(g => MARKED_GROUPS.add(g));
} catch {
  await writeFile(MARKED_GROUPS_FILE, '[]');
}

function saveMarked() {
  writeFile(MARKED_GROUPS_FILE, JSON.stringify([...MARKED_GROUPS], null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeJid(jid) {
  return jid?.replace(/:\d+/, '')?.split('@')[0] + '@g.us';
}

function isCommand(text, cmd) {
  return text?.toLowerCase().startsWith(PREFIX + cmd);
}

function sendText(sock, jid, text) {
  return sock.sendMessage(jid, { text });
}

// =============== GROWTH ENGINE ===============
async function getRandomMemberFromGroup(sock, jid) {
  try {
    const metadata = await sock.groupMetadata(jid);
    const members = metadata.participants
      .filter(p => !p.id.includes('bot') && !p.admin)
      .map(p => p.id);
    if (members.length === 0) return null;
    return members[Math.floor(Math.random() * members.length)];
  } catch (e) {
    console.error(`Failed to get member from ${jid}:`, e.message);
    return null;
  }
}

async function growGroup(sock, targetJid, amount) {
  const target = normalizeJid(targetJid);
  let added = 0;

  if (!MARKED_GROUPS.size) {
    return sendText(sock.user.id, `❌ No source groups marked. Use .mark in groups first.`);
  }

  sendText(sock.user.id, `🚀 Starting growth: Adding ${amount} members to ${target} from ${MARKED_GROUPS.size} marked groups.`);

  while (added < amount) {
    for (const sourceJid of MARKED_GROUPS) {
      if (added >= amount) break;

      const member = await getRandomMemberFromGroup(sock, sourceJid);
      if (!member) continue;

      try {
        await sock.groupParticipantsUpdate(target, [member], 'add');
        added++;
        console.log(`✅ Added ${member} to ${target} (${added}/${amount})`);
        await sendText(sock.user.id, `✅ Added member #${added} to ${target}`);
      } catch (e) {
        console.error(`Failed to add ${member}:`, e.message);
        if (e.message.includes('403')) {
          await sendText(sock.user.id, `🚫 Add permission denied for ${target}. Am I admin?`);
          return;
        }
      }

      await sleep(3 * 60 * 1000); // 3 mins
    }
  }

  await sendText(sock.user.id, `🎯 Growth complete: ${amount} members added to ${target}`);
}

// =============== NONGET ===============
async function nonget(sock, minMembers) {
  const groups = await sock.groupFetchAllParticipating();
  const candidates = Object.values(groups).filter(g => g.participants?.length > minMembers);

  if (!candidates.length) {
    return sendText(sock.user.id, `❌ No groups found with more than ${minMembers} members.`);
  }

  for (const group of candidates) {
    try {
      await sock.groupParticipantsUpdate(group.id, [OWNER_NUMBER], 'add');
      await sock.groupParticipantsUpdate(group.id, [OWNER_NUMBER], 'promote');
      await sendText(sock.user.id, `👑 Added and promoted owner to: ${group.subject} (${group.participants.length} members)`);
      return;
    } catch (e) {
      console.error(`Failed to add owner to ${group.id}:`, e.message);
    }
  }

  await sendText(sock.user.id, `❌ Could not add owner to any large group.`);
}

// =============== WEB SERVER ===============
const app = express();
app.use(express.json());
app.use(pairRouter);

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'growbot', status: 'running' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 Web interface running on port ${PORT}`);
});

// =============== PAIRING CONNECTION MANAGER ===============
// Each requested phone gets its own Baileys socket and auth directory.
// This does not replace or modify the main bot's auth session or commands.
const pairingSockets = new Map();
const pairingAuthRoot = path.join(__dirname, 'auth', 'pairings');

async function openPairingSocket(number, pairingId, resolveFirstCode) {
  const authDir = path.join(pairingAuthRoot, pairingId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const session = { number, pairingId, authDir, socket: null, closed: false, codeRequested: false, resolveFirstCode, reconnecting: false };
  pairingSockets.set(pairingId, session);

  const connect = async () => {
    if (session.closed) return;
    const { state: currentState, saveCreds: saveCurrentCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({
      version,
      auth: { creds: currentState.creds, keys: makeCacheableSignalKeyStore(currentState.keys, console) },
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      browser: ['GrowBot', 'Chrome', '1.0']
    });
    session.socket = sock;
    sock.ev.on('creds.update', saveCurrentCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (session.closed) return;
      if (connection === 'open') {
        updatePairingStatus('open', { message: 'Device paired successfully.' }, pairingId);
        if (typeof session.resolveFirstCode === 'function') {
          // A code should already have been returned; resolve only if opening happened first.
          session.resolveFirstCode(null);
          session.resolveFirstCode = null;
        }
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        // 515 is the normal restart after the phone accepts a pairing code.
        if (statusCode === 515 || !currentState.creds.registered) {
          if (!session.reconnecting && !session.closed) {
            session.reconnecting = true;
            updatePairingStatus('restarting', { message: 'Reconnecting to finish pairing…' }, pairingId);
            setTimeout(() => {
              session.reconnecting = false;
              connect().catch(err => updatePairingStatus('failed', { error: err.message }, pairingId));
            }, 1200);
          }
        } else {
          updatePairingStatus('failed', { error: `WhatsApp connection closed (code ${statusCode ?? 'unknown'}). Generate a new code.` }, pairingId);
          session.closed = true;
          pairingSockets.delete(pairingId);
        }
      }
    });

    // Ask for a code once the socket has had time to initialize.
    if (!currentState.creds.registered && !session.codeRequested) {
      session.codeRequested = true;
      setTimeout(async () => {
        if (session.closed || !session.socket) return;
        try {
          updatePairingStatus('connecting', {}, pairingId);
          const code = await session.socket.requestPairingCode(number);
          if (typeof session.resolveFirstCode === 'function') {
            session.resolveFirstCode(code);
            session.resolveFirstCode = null;
          }
          updatePairingStatus('code_ready', { code }, pairingId);
        } catch (err) {
          session.codeRequested = false;
          if (typeof session.resolveFirstCode === 'function') {
            session.resolveFirstCode(null);
            session.resolveFirstCode = null;
          }
          updatePairingStatus('failed', { error: err?.message || 'Unable to request a pairing code.' }, pairingId);
        }
      }, 1800);
    }
  };
  await connect();
  return session;
}

setPairingController({
  startPairing(number, pairingId) {
    return new Promise(async (resolve, reject) => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; resolve(value); } };
      try {
        const existing = pairingSockets.get(pairingId);
        if (existing) return reject(new Error('Pairing session already exists.'));
        await openPairingSocket(number, pairingId, finish);
        setTimeout(() => {
          if (!settled) { settled = true; reject(new Error('Timed out waiting for WhatsApp pairing code. Please try again.')); }
        }, Number(process.env.PAIRING_FIRST_CODE_TIMEOUT_MS || 90000));
      } catch (err) { reject(err); }
    });
  },
  async cancelPairing(pairingId) {
    const session = pairingSockets.get(pairingId);
    if (!session) return;
    session.closed = true;
    pairingSockets.delete(pairingId);
    try { session.socket?.end(undefined); } catch {}
  }
});

// =============== START BOT ===============
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, console)
    },
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: ['GrowBot', 'Chrome', '1.0']
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection } = update;
    if (connection === 'open') {
      console.log('✅ Bot connected!');
      sendText(sock.user.id, '🟢 GrowBot is online and ready.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const text = msg.message.conversation || Object.values(msg.message)[0]?.text || '';
    const sender = msg.key.participant || jid;

    if (sender !== OWNER_NUMBER) return;

    // =============== COMMANDS ===============
    if (isCommand(text, 'menu')) {
      await sendText(jid, `
🚀 *GrowBot Menu*
• ${PREFIX}menu – Show this menu
• ${PREFIX}setprefix <char> – Change prefix
• ${PREFIX}groupid – Get current group ID
• ${PREFIX}mark – Mark this group as source
• ${PREFIX}unmark – Unmark this group
• ${PREFIX}growgc <group_id> <amount> – Grow group slowly
• ${PREFIX}nonget t<amount> – Find big group, add owner as admin
      `.trim());
    }

    if (isCommand(text, 'setprefix')) {
      const newPrefix = text.split(' ')[1];
      if (!newPrefix || newPrefix.length !== 1) {
        return sendText(jid, '❌ Use exactly one character: .setprefix !');
      }
      PREFIX = newPrefix;
      await writeFile(BOT_SETTINGS_FILE, JSON.stringify({ prefix: PREFIX }, null, 2));
      await sendText(jid, `✅ Prefix changed to: ${PREFIX}`);
    }

    if (isCommand(text, 'groupid')) {
      await sendText(jid, `🆔 Group ID:\n${jid}`);
    }

    if (isCommand(text, 'mark')) {
      if (!jid.endsWith('@g.us')) return sendText(jid, '❌ Use this in a group.');
      MARKED_GROUPS.add(jid);
      saveMarked();
      await sendText(jid, `📌 Group marked as source. Total sources: ${MARKED_GROUPS.size}`);
    }

    if (isCommand(text, 'unmark')) {
      MARKED_GROUPS.delete(jid);
      saveMarked();
      await sendText(jid, `🗑️ Group unmarked. Remaining sources: ${MARKED_GROUPS.size}`);
    }

    if (isCommand(text, 'growgc')) {
      const [_, target, amountStr] = text.split(' ');
      const amount = parseInt(amountStr);
      if (!target || !amount || isNaN(amount)) {
        return sendText(jid, '❌ Usage: .growgc <group_id> <amount>');
      }
      await growGroup(sock, target, amount);
    }

    if (isCommand(text, 'nonget')) {
      const match = text.match(/t(\d+)/);
      const amount = match ? parseInt(match[1]) : 100;
      await nonget(sock, amount);
    }
  });
}

startBot();

// Keep alive
setInterval(() => console.log('🫀 Ping...'), 300000);