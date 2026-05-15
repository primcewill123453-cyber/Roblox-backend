import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'PRINCE-ADMIN-2025';
const MONGO_URL = process.env.MONGO_URL;
const PORT = Number(process.env.PORT) || 3000;

if (!MONGO_URL) {
  console.error('MONGO_URL env var is not set');
  process.exit(1);
}

const AccessCode = mongoose.model('AccessCode', new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, default: () => new Date() },
  usedAt: { type: Date },
  discordUsername: { type: String },
}));

const Session = mongoose.model('Session', new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  discordUsername: { type: String, required: true, index: true },
  username: { type: String, default: 'Guest' },
  displayName: { type: String },
  balance: { type: Number, default: 1000000 },
  avatarUrl: { type: String },
  banned: { type: Boolean, default: false },
  claimedAt: { type: Date, default: () => new Date() },
  lastSeenAt: { type: Date, default: () => new Date() },
}));

const Activity = mongoose.model('Activity', new mongoose.Schema({
  code: { type: String, required: true, index: true },
  discordUsername: { type: String, required: true, index: true },
  type: { type: String, required: true },
  message: { type: String, required: true },
  details: { type: mongoose.Schema.Types.Mixed },
  at: { type: Date, default: () => new Date(), index: true },
}));

const Settings = mongoose.model('Settings', new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
}));

async function log(code, discordUsername, type, message, details) {
  await Activity.create({ code, discordUsername, type, message, details });
}

function generateCodeString() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () => Array.from({ length: 4 }, () => alphabet.charAt(Math.floor(Math.random() * alphabet.length))).join('');
  return `${group()}-${group()}-${group()}-${group()}`;
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
// Accept both application/json and text/plain bodies (frontend uses text/plain
// to avoid CORS preflight requests).
app.use(express.json({ type: ['application/json', 'text/plain'] }));

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== ADMIN_SECRET) { res.status(401).json({ error: 'Unauthorized' }); return; }
  next();
}

app.get('/api/admin/codes', requireAdmin, async (_req, res) => {
  res.json(await AccessCode.find().sort({ createdAt: -1 }).lean());
});
app.post('/api/admin/codes', requireAdmin, async (_req, res) => {
  const code = generateCodeString();
  await AccessCode.create({ code });
  res.json({ code });
});
app.delete('/api/admin/codes/:code', requireAdmin, async (req, res) => {
  await AccessCode.deleteOne({ code: req.params.code });
  await Session.deleteOne({ code: req.params.code });
  res.json({ ok: true });
});
app.get('/api/admin/sessions', requireAdmin, async (_req, res) => {
  res.json(await Session.find().sort({ lastSeenAt: -1 }).lean());
});
app.post('/api/admin/sessions/:code/balance', requireAdmin, async (req, res) => {
  const balance = Number(req.body?.balance);
  if (!Number.isFinite(balance) || balance < 0) { res.status(400).json({ error: 'Invalid balance' }); return; }
  const s = await Session.findOne({ code: req.params.code });
  if (s) {
    s.balance = balance;
    await s.save();
    await log(s.code, s.discordUsername, 'admin_balance', `Admin set balance to ${balance}`, { balance });
  }
  res.json({ ok: true });
});
app.post('/api/admin/sessions/:code/ban', requireAdmin, async (req, res) => {
  const banned = !!req.body?.banned;
  const s = await Session.findOne({ code: req.params.code });
  if (s) {
    s.banned = banned;
    await s.save();
    await log(s.code, s.discordUsername, banned ? 'ban' : 'unban', banned ? 'Admin banned user' : 'Admin unbanned user');
  }
  res.json({ ok: true });
});
app.get('/api/admin/activity', requireAdmin, async (req, res) => {
  res.json(await Activity.find().sort({ at: -1 }).limit(Math.min(Number(req.query.limit) || 200, 500)).lean());
});
app.get('/api/admin/paused', requireAdmin, async (_req, res) => {
  const doc = await Settings.findOne({ key: 'paused' }).lean();
  res.json({ paused: doc?.value === true });
});
app.post('/api/admin/paused', requireAdmin, async (req, res) => {
  await Settings.updateOne({ key: 'paused' }, { $set: { value: !!req.body?.paused } }, { upsert: true });
  res.json({ ok: true });
});

app.get('/api/status', async (_req, res) => {
  const doc = await Settings.findOne({ key: 'paused' }).lean();
  res.json({ paused: doc?.value === true });
});
app.post('/api/claim', async (req, res) => {
  const { code: rawCode, discordUsername } = req.body || {};
  if (!rawCode || !discordUsername) { res.status(400).json({ ok: false, error: 'Missing code or discord username' }); return; }
  const code = String(rawCode).trim().toUpperCase();
  const found = await AccessCode.findOne({ code });
  if (!found) { res.status(400).json({ ok: false, error: 'Invalid access code.' }); return; }
  if (found.usedAt) { res.status(400).json({ ok: false, error: 'This code has already been used.' }); return; }
  found.usedAt = new Date();
  found.discordUsername = String(discordUsername);
  await found.save();
  const session = await Session.create({ code, discordUsername: String(discordUsername), username: 'Guest', balance: 1000000 });
  await log(code, discordUsername, 'claim', `Claimed code as @${discordUsername}`);
  res.json({ ok: true, session: session.toObject() });
});
app.get('/api/session/:code', async (req, res) => {
  const s = await Session.findOne({ code: req.params.code });
  if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
  s.lastSeenAt = new Date();
  await s.save();
  res.json(s.toObject());
});
app.post('/api/session/:code/profile', async (req, res) => {
  const s = await Session.findOne({ code: req.params.code });
  if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
  const { username, displayName, avatarUrl } = req.body || {};
  if (username !== undefined && username !== s.username) {
    await log(s.code, s.discordUsername, 'change_username', `Changed Roblox username from ${s.username} to ${username}`, { from: s.username, to: username });
    s.username = String(username);
  }
  if (displayName !== undefined) s.displayName = String(displayName);
  if (avatarUrl !== undefined) s.avatarUrl = String(avatarUrl);
  s.lastSeenAt = new Date();
  await s.save();
  res.json(s.toObject());
});
app.post('/api/session/:code/send', async (req, res) => {
  const recipient = String(req.body?.recipient);
  const amount = Number(req.body?.amount);
  const s = await Session.findOne({ code: req.params.code });
  if (!s) { res.status(400).json({ ok: false, error: 'Session not found.' }); return; }
  if (s.banned) { res.status(400).json({ ok: false, error: 'Your account is banned.' }); return; }
  if (!Number.isFinite(amount) || amount <= 0) { res.status(400).json({ ok: false, error: 'Invalid amount.' }); return; }
  if (amount > s.balance) { res.status(400).json({ ok: false, error: 'Not enough Robux.' }); return; }
  s.balance -= amount;
  s.lastSeenAt = new Date();
  await s.save();
  await log(s.code, s.discordUsername, 'send_robux', `Sent ${amount} R$ to @${recipient}`, { recipient, amount, newBalance: s.balance });
  res.json({ ok: true, balance: s.balance });
});
app.post('/api/session/:code/logout', async (req, res) => {
  const s = await Session.findOne({ code: req.params.code }).lean();
  if (s) await log(s.code, s.discordUsername, 'logout', 'Logged out');
  res.json({ ok: true });
});

mongoose.connect(MONGO_URL).then(() => {
  app.listen(PORT, () => { console.log(`Robux backend ready on :${PORT}`); });
}).catch((err) => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});
