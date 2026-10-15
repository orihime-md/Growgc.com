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
const BOT_SETTINGS_FILE = path.join(__dirname, 'bot-setting.json');
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
// Each web pairing has an isolated Baileys auth folder. The regular bot commands
// are attached to the paired socket after WhatsApp has opened successfully.
const pairingSockets = new Map();
const pairingAuthRoot = path.join(__dirname, 'auth', 'pairings');

async function openPairingSocket(number, pairingId, resolveFirstCode) {
  const authDir = path.join(pairingAuthRoot, pairingId);
  const { version } = await fetchLatestBaileysVersion();
  const session = {
    number,
    pairingId,
    authDir,
    socket: null,
    closed: false,
    codeRequested: false,
    resolveFirstCode,
    reconnecting: false,
    reconnectAttempts: 0,
    pairAccepted: false,
    commandsSocket: null,
    credsSave: Promise.resolve()
  };
  pairingSockets.set(pairingId, session);

  const connect = async () => {
    if (session.closed) return;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    if (session.closed) return;

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, console)
      },
      printQRInTerminal: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      browser: ['GrowBot', 'Chrome', '1.0']
    });
    session.socket = sock;

    // Serialize credential writes so a 515 restart cannot race a pending save.
    sock.ev.on('creds.update', () => {
      session.credsSave = session.credsSave
        .then(() => saveCreds())
        .catch(err => console.error(`❌ Could not persist pairing credentials (${pairingId}):`, err?.message || err));
    });

    sock.ev.on('connection.update', async update => {
      if (session.closed || session.socket !== sock) return;
      const { connection, lastDisconnect, qr, isNewLogin } = update;

      if (isNewLogin) {
        session.pairAccepted = true;
        updatePairingStatus('linking', { message: 'WhatsApp accepted the code. Finishing the connection…' }, pairingId);
      }

      // Baileys recommends waiting for its QR event before requesting a pairing code.
      // The QR itself is not shown to the user; it is only the safe readiness trigger.
      if (qr && !state.creds.registered && !session.codeRequested) {
        session.codeRequested = true;
        updatePairingStatus('connecting', { message: 'WhatsApp is ready. Requesting your pairing code…' }, pairingId);
        try {
          const code = await sock.requestPairingCode(number);
          if (session.closed || session.socket !== sock) return;
          if (!code) throw new Error('WhatsApp returned an empty pairing code.');
          if (typeof session.resolveFirstCode === 'function') {
            session.resolveFirstCode(code);
            session.resolveFirstCode = null;
          }
          updatePairingStatus('code_ready', { code }, pairingId);
          console.log(`🔑 Pairing code issued for session ${pairingId}.`);
        } catch (err) {
          const message = err?.message || 'Unable to request a pairing code.';
          console.error(`❌ Pairing code request failed (${pairingId}):`, message);
          updatePairingStatus('failed', { error: message }, pairingId);
          if (typeof session.resolveFirstCode === 'function') {
            session.resolveFirstCode(null);
            session.resolveFirstCode = null;
          }
          session.closed = true;
          pairingSockets.delete(pairingId);
          try { sock.end(undefined); } catch {}
        }
      }

      if (connection === 'open') {
        session.reconnectAttempts = 0;
        updatePairingStatus('open', { message: 'Device paired successfully.' }, pairingId);
        if (session.commandsSocket !== sock) {
          attachBotCommands(sock);
          session.commandsSocket = sock;
          try { await sendText(sock, sock.user.id, '🟢 GrowBot is online and ready.'); } catch {}
        }
        if (typeof session.resolveFirstCode === 'function') {
          session.resolveFirstCode(null);
          session.resolveFirstCode = null;
        }
      }

      if (connection === 'close') {
        // Ignore duplicate close events from the same socket.
        if (session.socket !== sock) return;
        session.socket = null;
        try { await session.credsSave; } catch {}
        if (session.closed) return;

        const statusCode = Number(lastDisconnect?.error?.output?.statusCode ?? 0);
        const loggedOut = statusCode === 401;
        const restartRequired = statusCode === 515;
        const canRetry = !loggedOut && session.reconnectAttempts < 8;

        if (canRetry) {
          session.reconnectAttempts += 1;
          session.reconnecting = true;
          updatePairingStatus('restarting', {
            message: restartRequired
              ? 'WhatsApp requested a restart after pairing. Reconnecting with saved credentials…'
              : 'Connection interrupted. Reconnecting to WhatsApp…'
          }, pairingId);
          // Do not delay a 515 restart; reconnect immediately with persisted credentials.
          try {
            await connect();
          } catch (err) {
            const message = err?.message || 'Could not reconnect to WhatsApp.';
            updatePairingStatus('failed', { error: message }, pairingId);
            session.closed = true;
            pairingSockets.delete(pairingId);
          } finally {
            session.reconnecting = false;
          }
          return;
        }

        const message = loggedOut
          ? 'WhatsApp rejected or logged out this pairing session. Generate a new code.'
          : `WhatsApp connection closed (code ${statusCode || 'unknown'}). Generate a new code.`;
        updatePairingStatus('failed', { error: message }, pairingId);
        session.closed = true;
        pairingSockets.delete(pairingId);
        if (typeof session.resolveFirstCode === 'function') {
          session.resolveFirstCode(null);
          session.resolveFirstCode = null;
        }
      }
    });
  };

  await connect();
  return session;
}

setPairingController({
  startPairing(number, pairingId) {
    return new Promise(async (resolve, reject) => {
      let settled = false;
      const finish = value => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        if (pairingSockets.has(pairingId)) return reject(new Error('Pairing session already exists.'));
        await openPairingSocket(number, pairingId, finish);
        setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('Timed out waiting for WhatsApp pairing code. Please try again.'));
          }
        }, Number(process.env.PAIRING_FIRST_CODE_TIMEOUT_MS || 90000));
      } catch (err) {
        reject(err);
      }
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

// Reuse the existing command handler for the main socket and web-paired sockets.
function attachBotCommands(sock) {
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

  attachBotCommands(sock);
}

startBot();

// Keep alive
setInterval(() => console.log('🫀 Ping...'), 300000);