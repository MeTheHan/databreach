// server.js
// Sinyal — the minimal backend that actually sends push notifications.
//
// What it does:
// 1. Stores the browser's push subscription and the email address to watch.
// 2. On a schedule (cron), queries the XposedOrNot API for each email (free, no API key).
// 3. Compares results to the previous scan; if a NEW breach shows up, sends a real
//    push notification to that user's browser.
//
// Uses a plain JSON file instead of a database (db.json).
// In production, swap this for a real database (Postgres, SQLite, etc).

import express from 'express';
import cors from 'cors';
import webpush from 'web-push';
import cron from 'node-cron';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH = './db.json';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const CRON_SECRET = process.env.CRON_SECRET; // optional — protects the manual trigger endpoints below

// If CRON_SECRET is set, require it on requests to protected endpoints.
// If it's not set, the endpoints stay open (handy for local testing) —
// but you should set it once this is deployed and publicly reachable.
function requireSecret(req, res, next) {
  if (!CRON_SECRET) return next();
  if (req.headers['x-cron-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Missing or invalid x-cron-secret header' });
  }
  next();
}

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set in .env');
  console.error('Generate them with: npm run vapid');
  process.exit(1);
}

webpush.setVapidDetails(
  'mailto:support@sinyal.app', // replace with a real contact email
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// --- tiny JSON "database" ---
function readDB() {
  if (!fs.existsSync(DB_PATH)) return { users: [] };
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// --- give the frontend the public VAPID key ---
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// --- register: email + push subscription ---
// IMPORTANT: a real product needs an email verification flow here.
// This simplified example skips it; in production add
// /api/request-verification and /api/verify endpoints before allowing /api/subscribe.
app.post('/api/subscribe', (req, res) => {
  const { email, categories, subscription } = req.body;
  if (!email || !subscription) {
    return res.status(400).json({ error: 'email and subscription are required' });
  }
  const db = readDB();
  const existing = db.users.find(u => u.email === email);
  if (existing) {
    existing.subscription = subscription;
    existing.categories = categories || existing.categories;
  } else {
    db.users.push({
      email,
      categories: categories || [],
      subscription,
      knownBreachNames: [], // breach names seen on the last scan, to detect new ones
      lastChecked: null,
    });
  }
  writeDB(db);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { email } = req.body;
  const db = readDB();
  db.users = db.users.filter(u => u.email !== email);
  writeDB(db);
  res.json({ ok: true });
});

// --- XposedOrNot breach-analytics lookup ---
// Free, no API key. One call returns name + date + record count + description.
async function checkBreachesFor(email) {
  const url = `https://api.xposedornot.com/v1/breach-analytics?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'Sinyal-Breach-Monitor' },
  });

  if (!res.ok) throw new Error(`XposedOrNot error: ${res.status}`);

  const data = await res.json();
  const details = data?.ExposedBreaches?.breaches_details;
  if (!details) return []; // no match (every field comes back null)

  return details.map(b => ({
    Name: b.breach,
    Date: b.xposed_date,
    Records: b.xposed_records,
    Description: b.details,
    Domain: b.domain,
    Industry: b.industry,
  }));
}

// --- check every user, push if a new breach appears ---
async function runScanForAllUsers() {
  const db = readDB();
  for (const user of db.users) {
    try {
      const breaches = await checkBreachesFor(user.email);
      const newOnes = breaches.filter(b => !user.knownBreachNames.includes(b.Name));

      if (newOnes.length > 0) {
        const first = newOnes[0];
        await sendPush(user.subscription, {
          title: 'Sinyal — new breach detected',
          body: newOnes.length === 1
            ? `Your email was found in the "${first.Name}" breach (${first.Date}).`
            : `Your email was found in ${newOnes.length} new breaches, including "${first.Name}".`,
        });
      }

      user.knownBreachNames = breaches.map(b => b.Name);
      user.lastChecked = new Date().toISOString();
    } catch (err) {
      console.error(`Check failed for ${user.email}:`, err.message);
    }
    // XposedOrNot's rate limit is 2 requests/sec per IP — stay safely under it
    await new Promise(r => setTimeout(r, 600));
  }
  writeDB(db);
}

async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    console.error('Push send failed:', err.message);
  }
}

// Send a real push right now, on demand — lets the frontend prove the
// pipeline actually works end to end without waiting for the daily cron.
app.post('/api/send-test-push', async (req, res) => {
  const { email } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'No subscription found for this email' });

  await sendPush(user.subscription, {
    title: 'Sinyal — test push',
    body: 'This is a real push from the server. If you can see this, the pipeline works.',
  });
  res.json({ ok: true });
});

// Manual trigger (for testing) — protect or remove this endpoint in production
app.post('/api/run-scan-now', requireSecret, async (req, res) => {
  await runScanForAllUsers();
  res.json({ ok: true });
});

// Automatic scan once a day at 09:00
cron.schedule('0 9 * * *', () => {
  console.log('Scheduled scan starting:', new Date().toISOString());
  runScanForAllUsers();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sinyal backend running on port ${PORT}`));
