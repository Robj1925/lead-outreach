#!/usr/bin/env node

/**
 * Lead Cold Outreach SMS Sender
 * 
 * Reads leads from a CSV and sends a personalized cold outreach text
 * via iMessage (using the `imsg` CLI) with a random 1–5 min delay between sends.
 *
 * DRY RUN IS THE DEFAULT. Nothing is transmitted unless you pass --send.
 *
 * Usage:
 *   node outreach.js                              # Dry run (default): preview only
 *   node outreach.js --leads ./leads.csv          # Choose the leads CSV
 *   node outreach.js --limit 3                    # Preview first 3 leads only
 *   node outreach.js --send --sender "Your Name"  # LIVE send
 *   node outreach.js --send --limit 5 --hours 9-18
 *   node outreach.js --suppress ./do-not-contact.txt
 *
 * Read README.md ("Responsible Use & Legal") before sending anything.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const https = require('https');
const http = require('http');

// ─────────────────────────────────────────────────────────────────────────────
// LOAD .env
// ─────────────────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(rawLine => {
    const line = rawLine.trim();
    // Skip blank lines and whole-line comments
    if (!line || line.startsWith('#')) return;

    const eq = line.indexOf('=');
    if (eq === -1) return;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key) return;

    let value = line.slice(eq + 1).trim();

    // Quoted values: take everything up to the matching closing quote and
    // discard the rest of the line (so `KEY="a b"  # note` yields `a b`).
    // Unquoted values: strip any trailing `#` comment.
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, 1);
      value = close === -1 ? value.slice(1) : value.slice(1, close);
    } else {
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    }

    process.env[key] = value;
  });
}
loadEnv();

const NUMVERIFY_API_KEY = process.env.NUMVERIFY_API_KEY || '';
const ABSTRACT_API_KEY  = process.env.ABSTRACT_API_KEY  || '';

// ── OFFLINE CARRIER PREFIX DATABASE ──────────────────────────────────────────
const PREFIXES_JSON = path.resolve(__dirname, 'us_mobile_prefixes.json');
let offlinePrefixes = null;
if (fs.existsSync(PREFIXES_JSON)) {
  try {
    offlinePrefixes = JSON.parse(fs.readFileSync(PREFIXES_JSON, 'utf8'));
  } catch (err) {
    console.error(`  ⚠️  Failed to load offline carrier database: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const HELP_TEXT = `
Lead Cold Outreach SMS Sender

DRY RUN IS THE DEFAULT. Nothing is transmitted unless you pass --send.

Usage:
  node outreach.js [options]

Options:
  --send                 Actually transmit messages. Without this, preview only.
  --leads <file>         Path to the leads CSV      (env LEADS_CSV, default ./leads.csv)
  --sender "Name"        Name signed on every message (env SENDER_NAME). Required for --send.
  --suppress <file>      Do-not-contact list (default: do-not-contact.txt next to the leads CSV)
  --hours 9-18           Business-hours window, 24h clock
                         (env BUSINESS_HOURS_START / BUSINESS_HOURS_END, default 9-18)
  --limit <n>            Cap how many leads are processed this run
  -h, --help             Show this help and exit

Every message ends with "Reply STOP to opt out." This cannot be disabled.
Read README.md ("Responsible Use & Legal") before sending anything.
`;

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

/**
 * Read the value of a `--flag value` or `--flag=value` argument.
 * Returns null when the flag is absent, and undefined when it is present without a value.
 */
function flagValue(name) {
  const idx = args.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return null;
  const arg = args[idx];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  const next = args[idx + 1];
  if (next === undefined || next.startsWith('--')) return undefined;
  return next;
}

function requireValue(name, value) {
  if (value === undefined) {
    console.error(`❌ ${name} requires a value (e.g. ${name} <value>).`);
    process.exit(1);
  }
  return value;
}

// ── Live send is opt-in. Dry run is the default. ─────────────────────────────
const SEND    = args.includes('--send');
const DRY_RUN = !SEND;

if (args.includes('--dry-run')) {
  console.log('ℹ️  --dry-run is now the default and is no longer needed. Pass --send to transmit.');
}

// ── --limit ──────────────────────────────────────────────────────────────────
const limitRaw = flagValue('--limit');
let LIMIT = Infinity;
if (limitRaw !== null) {
  requireValue('--limit', limitRaw);
  if (!/^\d+$/.test(limitRaw.trim()) || parseInt(limitRaw, 10) < 1) {
    console.error(`❌ --limit expects a positive whole number, got "${limitRaw}".`);
    process.exit(1);
  }
  LIMIT = parseInt(limitRaw, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

// ── Leads CSV: --leads flag > LEADS_CSV env > ./leads.csv relative to CWD ────
const leadsFlag = flagValue('--leads');
if (leadsFlag !== null) requireValue('--leads', leadsFlag);
const LEADS_CSV = path.resolve(leadsFlag || process.env.LEADS_CSV || './leads.csv');

// ── Do-not-contact list: --suppress flag > do-not-contact.txt beside the CSV ─
const suppressFlag = flagValue('--suppress');
if (suppressFlag !== null) requireValue('--suppress', suppressFlag);
const SUPPRESS_FILE = suppressFlag
  ? path.resolve(suppressFlag)
  : path.resolve(path.dirname(LEADS_CSV), 'do-not-contact.txt');
const SUPPRESS_EXPLICIT = suppressFlag !== null;

const LOG_FILE = path.resolve(__dirname, 'outreach-log.json');

// ── Sender name: --sender flag > SENDER_NAME env. Required for a live send. ──
const senderFlag = flagValue('--sender');
if (senderFlag !== null) requireValue('--sender', senderFlag);
const SENDER_NAME_RAW = (senderFlag || process.env.SENDER_NAME || '').trim();
const SENDER_NAME = SENDER_NAME_RAW || '<YOUR NAME>';

if (SEND && !SENDER_NAME_RAW) {
  console.error('\n❌ No sender name configured, so recipients would have no idea who is texting them.');
  console.error('   Carrier/CTIA rules require every commercial message to identify its sender.');
  console.error('\n   Set one and try again:');
  console.error('     node outreach.js --send --sender "Your Name"');
  console.error('   or add SENDER_NAME=Your Name to your .env file.\n');
  process.exit(1);
}

// ── Business hours: --hours 9-18 > BUSINESS_HOURS_* env > 9-18 default ───────
function parseHour(value, label) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || String(n) !== String(value).trim() || n < 0 || n > 24) {
    console.error(`❌ ${label} must be a whole number of hours between 0 and 24, got "${value}".`);
    process.exit(1);
  }
  return n;
}

const BUSINESS_HOURS = { start: 9, end: 18 }; // 9 AM – 6 PM local time
const hoursFlag = flagValue('--hours');
if (hoursFlag !== null) {
  requireValue('--hours', hoursFlag);
  const m = String(hoursFlag).trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) {
    console.error(`❌ --hours expects a range like 9-18, got "${hoursFlag}".`);
    process.exit(1);
  }
  BUSINESS_HOURS.start = parseHour(m[1], '--hours start');
  BUSINESS_HOURS.end   = parseHour(m[2], '--hours end');
} else {
  if (process.env.BUSINESS_HOURS_START) BUSINESS_HOURS.start = parseHour(process.env.BUSINESS_HOURS_START, 'BUSINESS_HOURS_START');
  if (process.env.BUSINESS_HOURS_END)   BUSINESS_HOURS.end   = parseHour(process.env.BUSINESS_HOURS_END, 'BUSINESS_HOURS_END');
}

if (BUSINESS_HOURS.start >= BUSINESS_HOURS.end) {
  console.error(`❌ Business hours start (${BUSINESS_HOURS.start}) must be before end (${BUSINESS_HOURS.end}).`);
  process.exit(1);
}

const MIN_DELAY_MS = 1  * 60 * 1000; // 1 minute
const MAX_DELAY_MS = 5 * 60 * 1000; // 5 minutes

// Appended to every outgoing message. Deliberately not configurable.
const OPT_OUT_SUFFIX = '\n\nReply STOP to opt out.';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a simple CSV string into an array of objects using the header row.
 * Handles quoted fields with commas inside them.
 */
function parseCSV(raw) {
  const lines = raw.trim().split('\n');
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (values[i] || '').trim(); });
    return obj;
  });
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/**
 * Convert common US phone formats to E.164 (+1XXXXXXXXXX).
 * Returns null if the number can't be normalized.
 */
function normalizePhone(raw) {
  if (!raw || raw.trim() === 'N/A' || raw.trim() === '') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return null;
}

/**
 * Make a simple HTTPS/HTTP GET request and return parsed JSON.
 * Follows up to 3 redirects automatically.
 */
function httpGet(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      // Follow redirects — resolve relative Location headers against original URL
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectsLeft > 0) {
        let next = res.headers.location;
        if (next.startsWith('/')) {
          const parsed = new URL(url);
          next = `${parsed.protocol}//${parsed.host}${next}`;
        }
        return httpGet(next, redirectsLeft - 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (!data.trim()) { reject(new Error(`Empty response from ${url}`)); return; }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.substring(0, 100))); }
      });
    }).on('error', reject);
  });
}

/**
 * Look up phone line type locally using the compiled NANPA carrier prefix database.
 * Returns: 'mobile' | 'landline' | 'unknown'
 */
function lookupPhoneTypeOffline(e164Phone) {
  if (!offlinePrefixes) return 'unknown';
  // Strip the leading + and 1 (if present for U.S. country code)
  const digits = e164Phone.replace(/^\+/, '').replace(/^1/, '');
  if (digits.length !== 10) return 'unknown';

  const prefix = digits.substring(0, 6);
  const isMobile = offlinePrefixes[prefix];
  if (isMobile === 1) return 'mobile';
  if (isMobile === 0) return 'landline';
  return 'unknown';
}

/**
 * Look up phone line type using Numverify (primary) then Abstract API (fallback).
 * Falls back to the local offline prefix database if API keys are exhausted, invalid, or missing.
 * Returns: 'mobile' | 'landline' | 'voip' | 'unknown'
 */
async function lookupPhoneType(e164Phone) {
  // Strip the leading + for APIs (they want digits only)
  const digits = e164Phone.replace(/^\+/, '');

  // ── PRIMARY: Numverify ────────────────────────────────────────────────
  if (NUMVERIFY_API_KEY) {
    try {
      const url = `http://apilayer.net/api/validate?access_key=${NUMVERIFY_API_KEY}&number=${digits}&country_code=US&format=1`;
      const data = await httpGet(url);

      if (data.error) {
        // error.code 104 = quota exceeded → fall through to Abstract
        if (data.error.code === 104) {
          console.log('   ⚠️  Numverify quota exceeded, falling back to Abstract API...');
        } else {
          throw new Error(`Numverify error ${data.error.code}: ${data.error.info}`);
        }
      } else {
        const t = (data.line_type || 'unknown').toLowerCase();
        return normalizeLineType(t);
      }
    } catch (err) {
      if (!err.message.includes('quota')) {
        console.log(`   ⚠️  Numverify failed (${err.message}), falling back to Abstract API...`);
      }
    }
  }

  // ── FALLBACK: Abstract API (Phone Intelligence) ───────────────────────
  if (ABSTRACT_API_KEY) {
    try {
      // Throttling: Abstract free tier has a strict rate limit of 1 request per second (RPS)
      await new Promise(resolve => setTimeout(resolve, 1200));
      const url = `https://phoneintelligence.abstractapi.com/v1?api_key=${ABSTRACT_API_KEY}&phone=${digits}`;
      const data = await httpGet(url);
      if (data.error) {
        const msg = data.error.message || JSON.stringify(data.error);
        if (data.error.code === 'unauthorized') {
          console.log(`   ⚠️  Abstract API key invalid — falling back to local offline check...`);
        } else {
          throw new Error(`Abstract API error: ${msg}`);
        }
      } else {
        // Abstract Phone Intelligence nests line type under phone_carrier
        const isVoip    = data.phone_validation?.is_voip === true;
        const lineType  = (data.phone_carrier?.line_type || '').toLowerCase();
        if (isVoip) return 'voip';
        return normalizeLineType(lineType);
      }
    } catch (err) {
      console.log(`   ⚠️  Abstract API failed (${err.message}), falling back to local offline check...`);
    }
  }

  // ── OFFLINE FALLBACK: Local Carrier Database ──────────────────────────
  if (offlinePrefixes) {
    const offlineType = lookupPhoneTypeOffline(e164Phone);
    if (offlineType !== 'unknown') {
      console.log(`   🔌 Utilized offline prefix database: classified as "${offlineType}"`);
      return offlineType;
    }
  }

  console.log('   ⚠️  No API keys configured and offline database unavailable — skipping line type check');
  return 'unknown';
}

/**
 * Normalize various API line type labels to: mobile | landline | voip | unknown
 */
function normalizeLineType(raw) {
  if (['mobile', 'cell', 'cellular', 'wireless'].some(t => raw.includes(t))) return 'mobile';
  if (['landline', 'fixed', 'fixed_line'].some(t => raw.includes(t)))          return 'landline';
  if (['voip', 'virtual', 'internet'].some(t => raw.includes(t)))              return 'voip';
  return 'unknown';
}

/**
 * Pick one of the 6 rotating body templates for a given business name.
 * Callers should use buildMessage(), which appends the mandatory opt-out line.
 */
function buildMessageBody(greetingName, templateIdx) {
  if (templateIdx === 0) {
    // Template 1: The Short & Direct Curiosity Hook
    return `Hi ${greetingName}, noticed your business has great reviews on Google but is missing a website link. Local businesses without sites usually lose ~50% of mobile search leads to competitors. I'm ${SENDER_NAME}, a professional website builder, and I'd love to build a high-speed site for your business completely free in exchange for a testimonial. Worth a 5-min look?`;
  } else if (templateIdx === 1) {
    // Template 2: The Soft "Conversational Bridge"
    return `Hi ${greetingName}, ${SENDER_NAME} here. Does your business currently have a website in the works? I noticed it’s not listed on your Google page yet, which often makes it harder for new clients to find your services. I'm building my portfolio and would love to build you a professional site for free in exchange for a review. Open to a quick idea for this?`;
  } else if (templateIdx === 2) {
    // Template 3: The Original Value Prop Template (Checkbox list)
    return `Hi ${greetingName}! My name is ${SENDER_NAME} and I'm a professional web developer and I noticed your business doesn't have a website listed on Google.

A website could help you:
✅ Show up in Google searches
✅ Let customers find your hours & contact info 24/7
✅ Look more professional and build trust

I'd love to build you one completely free in exchange for a testimonial — fast and hassle-free.

When would you be available for a quick 10-minute chat? 😊`;
  } else if (templateIdx === 3) {
    // Template 4: The "Free Build" Hook
    return `Hi ${greetingName}, ${SENDER_NAME} here! I'm offering a completely free website build in exchange for a testimonial, and I noticed your Google profile doesn't have a site link yet. Would you be open to me sending over a quick mockup?`;
  } else if (templateIdx === 4) {
    // Template 5: The "Portfolio Project" Pitch
    return `Hey ${greetingName}, I'm ${SENDER_NAME}. I'm building my portfolio and making professional websites 100% free just to earn a good review. I saw your business is missing a site on Google, which makes you a perfect fit. Interested in chatting?`;
  } else {
    // Template 6: The "Zero Cost" Value Add
    return `Hi ${greetingName}, ${SENDER_NAME} here! I'm doing free website builds this month in exchange for a testimonial. I noticed your Google page is missing a site link and I'd love to help you capture those lost local searches. Worth a 5-min look?`;
  }
}

/**
 * Build the personalized outreach message for a given business name.
 * Rotates through the 6 templates based on the index.
 *
 * The opt-out line is appended here, at the single return point, so that no
 * template can ever go out without it. There is no flag to turn it off.
 */
function buildMessage(businessName, index = 0) {
  const cleanBusinessName = businessName && businessName !== 'N/A' ? businessName : '';
  const greetingName = cleanBusinessName || 'there';

  const body = buildMessageBody(greetingName, index % 6);
  return body + OPT_OUT_SUFFIX;
}

/**
 * Return a random integer delay in ms between MIN and MAX.
 */
function randomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

function formatDelay(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Check if current local time is within business hours.
 */
function isBusinessHours() {
  const now = new Date();
  const hour = now.getHours();
  return hour >= BUSINESS_HOURS.start && hour < BUSINESS_HOURS.end;
}

function currentTimeString() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

/**
 * Render a 24-hour clock hour (0–24) as a 12-hour string, e.g. 0 → "12:00 AM",
 * 9 → "9:00 AM", 13 → "1:00 PM", 24 → "12:00 AM".
 */
function formatHour12(hour24) {
  const h = ((hour24 % 24) + 24) % 24;
  const suffix = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${suffix}`;
}

function businessHoursLabel() {
  return `${formatHour12(BUSINESS_HOURS.start)} – ${formatHour12(BUSINESS_HOURS.end)}`;
}

/**
 * Load the do-not-contact list: one phone number per line, `#` comments and
 * blank lines ignored. Numbers are normalized so any common US format matches.
 * Returns a Set of E.164 numbers (empty if the file does not exist).
 */
function loadSuppressionList(file) {
  const result = { numbers: new Set(), exists: false, unparsed: 0 };
  if (!fs.existsSync(file)) return result;
  result.exists = true;

  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Allow trailing comments: "+15551234567  # asked to stop"
    const hash = line.indexOf('#');
    if (hash !== -1) line = line.slice(0, hash).trim();
    if (!line) continue;

    const normalized = normalizePhone(line);
    if (normalized) result.numbers.add(normalized);
    else result.unparsed++;
  }
  return result;
}

/**
 * Abort early if the `imsg` CLI is not installed, rather than failing on every
 * lead while still sleeping minutes between each one.
 */
function assertImsgAvailable() {
  try {
    execFileSync('which', ['imsg'], { stdio: 'ignore' });
  } catch {
    console.error('\n❌ The `imsg` CLI was not found on your PATH, so nothing can be sent.');
    console.error('\n   Install it with Homebrew:');
    console.error('     brew install steipete/tap/imsg');
    console.error('\n   (Live sending is macOS-only. Dry runs work without imsg.)\n');
    process.exit(1);
  }
}

/**
 * Load the outreach log (array of previously sent entries).
 */
function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Append a new entry to the outreach log.
 */
function appendLog(entry) {
  const log = loadLog();
  log.push(entry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

/**
 * Send a message via imsg CLI.
 * Throws if imsg exits with a non-zero code.
 */
function sendMessage(phone, message) {
  // execFile (not a shell string): CSV-derived text is passed as an argv entry,
  // so quotes, backticks, $() and friends are never interpreted by a shell.
  execFileSync('imsg', ['send', '--to', phone, '--text', message], { stdio: 'inherit' });
}

/**
 * Sleep for `ms` milliseconds, printing a countdown every minute.
 */
async function sleep(ms) {
  return new Promise(resolve => {
    const end = Date.now() + ms;
    const tick = setInterval(() => {
      const remaining = end - Date.now();
      if (remaining <= 0) {
        clearInterval(tick);
        resolve();
      } else {
        const mins = Math.ceil(remaining / 60000);
        process.stdout.write(`\r  ⏳ Next send in ~${mins} minute${mins !== 1 ? 's' : ''}...   `);
      }
    }, 30000); // update every 30 seconds
    setTimeout(() => {
      clearInterval(tick);
      process.stdout.write('\r                                        \r');
      resolve();
    }, ms);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       Lead Cold Outreach SMS Sender         ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  if (DRY_RUN) {
    console.log('🔍 DRY RUN MODE (default) — no messages will be sent. Pass --send to transmit.\n');
  } else {
    console.log(`🚨 LIVE SEND MODE — messages will actually be transmitted as "${SENDER_NAME}".\n`);
    // Fail fast if imsg is missing, before burning minutes sleeping between leads.
    assertImsgAvailable();
  }

  // 1. Load leads CSV
  if (!fs.existsSync(LEADS_CSV)) {
    console.error(`❌ Leads CSV not found at: ${LEADS_CSV}`);
    console.error('   Pass --leads <file>, set LEADS_CSV, or create ./leads.csv.');
    console.error('   See leads.example.csv for the required columns (Name, Phone, Address).');
    process.exit(1);
  }

  const raw   = fs.readFileSync(LEADS_CSV, 'utf8');
  const leads = parseCSV(raw);
  console.log(`📋 Loaded ${leads.length} total rows from ${LEADS_CSV}`);

  // 2. Load existing log to skip already-contacted numbers
  const log             = loadLog();
  const alreadySentNums = new Set(log.map(e => e.phone));
  console.log(`📁 Log file: ${LOG_FILE}`);
  if (alreadySentNums.size > 0) {
    console.log(`⏭️  Skipping ${alreadySentNums.size} already-contacted number(s)`);
  }

  // 2b. Load the do-not-contact list
  const suppression = loadSuppressionList(SUPPRESS_FILE);
  if (suppression.exists) {
    console.log(`🚫 Do-not-contact list: ${SUPPRESS_FILE} (${suppression.numbers.size} number(s))`);
    if (suppression.unparsed > 0) {
      console.log(`   ⚠️  ${suppression.unparsed} line(s) in the list could not be read as phone numbers and were ignored.`);
    }
  } else if (SUPPRESS_EXPLICIT) {
    console.error(`❌ Do-not-contact file not found: ${SUPPRESS_FILE}`);
    process.exit(1);
  } else {
    console.log(`🚫 No do-not-contact list found at ${SUPPRESS_FILE} (optional — see do-not-contact.example.txt)`);
  }
  console.log('');

  // 3. Filter to valid, uncontacted leads + check line type
  const hasApiKeys = !!(NUMVERIFY_API_KEY || ABSTRACT_API_KEY);
  const hasOffline = !!offlinePrefixes;

  if (!hasApiKeys && !hasOffline) {
    console.log('  ⚠️  No API keys and no offline database found — phone type lookup disabled\n');
  } else if (!hasApiKeys && hasOffline) {
    console.log('  🔍 Checking phone types locally using the offline database...\n');
  } else {
    console.log('  🔍 Checking phone types (APIs with local offline fallback)...\n');
  }

  const queue = [];
  let suppressedCount = 0;
  for (const lead of leads) {
    const phone = normalizePhone(lead.Phone);
    if (!phone) {
      console.log(`  ⚠️  Skipping "${lead.Name}" — invalid phone: "${lead.Phone}"`);
      continue;
    }
    if (alreadySentNums.has(phone)) {
      console.log(`  ⏭️  Skipping "${lead.Name}" (${phone}) — already contacted`);
      continue;
    }
    if (suppression.numbers.has(phone)) {
      suppressedCount++;
      console.log(`  🚫 Skipping "${lead.Name}" (${phone}) — on the do-not-contact list`);
      continue;
    }

    // Phone type lookup
    let lineType = 'unknown';
    if (hasApiKeys || hasOffline) {
      try {
        lineType = await lookupPhoneType(phone);
      } catch (err) {
        console.log(`  ⚠️  Lookup failed for "${lead.Name}": ${err.message}`);
      }
    }

    const lineIcon = lineType === 'mobile'   ? '📱' :
                     lineType === 'voip'     ? '🌐' :
                     lineType === 'landline' ? '☎️ ' : '❓';

    if (lineType === 'landline') {
      console.log(`  ☎️  Skipping "${lead.Name}" (${phone}) — landline, cannot receive texts`);
      continue;
    }

    console.log(`  ${lineIcon} "${lead.Name}" (${phone}) — ${lineType}`);
    queue.push({ ...lead, normalizedPhone: phone, lineType });
  }

  // 4. Apply --limit
  const toSend = queue.slice(0, LIMIT);

  if (suppressedCount > 0) {
    console.log(`\n🚫 ${suppressedCount} lead(s) removed by the do-not-contact list`);
  }
  console.log(`\n✅ ${toSend.length} lead(s) queued for outreach\n`);

  if (toSend.length === 0) {
    console.log('Nothing to send. Exiting.');
    process.exit(0);
  }

  // 5. Business hours check (skip in dry-run)
  if (!DRY_RUN && !isBusinessHours()) {
    console.log(`⏰ Current time is ${currentTimeString()} — outside business hours (${businessHoursLabel()}).`);
    console.log('   Run again during business hours, or run without --send to preview.\n');
    process.exit(0);
  }
  // 6. Print dry-run preview table
  if (DRY_RUN) {
    console.log('─'.repeat(90));
    console.log(`${'#'.padEnd(4)} ${'Name'.padEnd(28)} ${'Phone'.padEnd(16)} ${'Type'.padEnd(10)} ${'Template'.padEnd(10)} Delay`);
    console.log('─'.repeat(90));
    toSend.forEach((lead, i) => {
      const delayMs  = i < toSend.length - 1 ? randomDelay() : 0;
      const delayStr = i < toSend.length - 1 ? formatDelay(delayMs) : '—';
      const typeIcon = lead.lineType === 'mobile' ? '📱 mobile' :
                       lead.lineType === 'voip'   ? '🌐 voip'   : '❓ unknown';
      const tempNum  = (i % 6) + 1;
      console.log(`${String(i + 1).padEnd(4)} ${lead.Name.substring(0, 28).padEnd(28)} ${lead.normalizedPhone.padEnd(16)} ${typeIcon.padEnd(10)} ${('T' + tempNum).padEnd(10)} ${delayStr}`);
    });
    console.log('─'.repeat(90));
    
    console.log('\n📝 Multi-Template Rotated Preview Samples:\n');
    for (let t = 0; t < Math.min(6, toSend.length); t++) {
      console.log(`[Template T${t + 1}] for "${toSend[t].Name}":`);
      console.log('┌' + '─'.repeat(76) + '┐');
      const msg = buildMessage(toSend[t].Name, t);
      // Word wrap around 74 chars, preserving the message's own line breaks so
      // the mandatory opt-out line stays visible in the preview.
      msg.split('\n').forEach(sourceLine => {
        if (sourceLine.trim() === '') {
          console.log('│ ' + ''.padEnd(74) + ' │');
          return;
        }
        let currentLine = '';
        sourceLine.trim().split(/\s+/).forEach(w => {
          if ((currentLine + w).length > 72) {
            console.log('│ ' + currentLine.trim().padEnd(74) + ' │');
            currentLine = w + ' ';
          } else {
            currentLine += w + ' ';
          }
        });
        if (currentLine.trim()) {
          console.log('│ ' + currentLine.trim().padEnd(74) + ' │');
        }
      });
      console.log('└' + '─'.repeat(76) + '┘\n');
    }
    
    if (!SENDER_NAME_RAW) {
      console.log('⚠️  No sender name set, so the previews above show the "<YOUR NAME>" placeholder.');
      console.log('   A live send requires --sender "Your Name" (or SENDER_NAME in .env).\n');
    }
    console.log(`⏰ Live sends are restricted to business hours (${businessHoursLabel()}).`);
    console.log('✅ Dry run complete. Nothing was sent. Add --send to send for real.\n');
    process.exit(0);
  }

  // 7. Send loop
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < toSend.length; i++) {
    const lead    = toSend[i];
    const message = buildMessage(lead.Name, i);
    const isLast  = i === toSend.length - 1;

    console.log(`\n[${i + 1}/${toSend.length}] 📨 Sending to: ${lead.Name} (${lead.normalizedPhone})`);

    try {
      sendMessage(lead.normalizedPhone, message);

      const logEntry = {
        name:     lead.Name,
        phone:    lead.normalizedPhone,
        address:  lead.Address || 'N/A',
        lineType: lead.lineType || 'unknown',
        sentAt:   new Date().toISOString(),
        status:   'sent',
        message,
      };
      appendLog(logEntry);
      console.log(`   ✅ Sent successfully at ${currentTimeString()}`);
      sent++;
    } catch (err) {
      const logEntry = {
        name:    lead.Name,
        phone:   lead.normalizedPhone,
        sentAt:  new Date().toISOString(),
        status:  'failed',
        error:   err.message,
      };
      appendLog(logEntry);
      console.error(`   ❌ Failed: ${err.message}`);
      failed++;
    }

    // Wait before the next send (skip after last)
    if (!isLast) {
      const delayMs = randomDelay();
      console.log(`   ⏳ Waiting ${formatDelay(delayMs)} before next send...`);
      await sleep(delayMs);

      // Re-check business hours after each delay
      if (!isBusinessHours()) {
        console.log(`\n⏰ Outside business hours now (${currentTimeString()}). Pausing until ${formatHour12(BUSINESS_HOURS.start)} tomorrow.`);
        console.log(`   ${toSend.length - i - 1} lead(s) remaining. Re-run the script in the morning.\n`);
        break;
      }
    }
  }

  // 8. Summary
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log(`║  ✅ Sent: ${String(sent).padEnd(4)} ❌ Failed: ${String(failed).padEnd(4)}                ║`);
  console.log(`║  📁 Log saved to: outreach-log.json          ║`);
  console.log('╚══════════════════════════════════════════════╝\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
