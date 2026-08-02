# 📱 Lead Cold Outreach SMS Sender

Reads businesses from a leads CSV and sends a personalized cold outreach text via iMessage using the `imsg` CLI. Sends are staggered with a random **1–5 minute delay** between each one, and the script enforces **business hours (9 AM – 6 PM)**.

---

## ⚠️ Responsible Use & Legal

**Read this before you run anything. It is your responsibility, not the tool's.**

This tool sends **unsolicited commercial SMS** to people who did not ask to hear from you. That is a regulated activity in the United States and in many other countries.

- **TCPA (Telephone Consumer Protection Act).** Unsolicited commercial texts to mobile numbers are commonly litigated under the TCPA. Statutory damages are commonly cited at **$500 per message**, rising to **up to $1,500 per message** for willful or knowing violations. These cases are frequently brought as **class actions**, where per-message damages multiply across an entire send list.
- **State texting and telemarketing statutes.** Several states (Florida, Oklahoma, Washington and others) have their own texting/telemarketing laws with their own private rights of action, consent standards, and calling-hour restrictions. Some are stricter than federal law.
- **Carrier and CTIA rules.** US carriers and the CTIA messaging principles require that commercial messages **identify the sender** and **honour opt-out keywords such as STOP**. Traffic that violates these rules gets filtered, blocked, or reported.
- **Apple's terms.** Apple's iCloud/iMessage terms prohibit bulk and unsolicited messaging. Accounts used this way can be rate-limited, restricted, or disabled. Nothing in this tool changes that.

This README does **not** tell you that this tool is legal, and it does not tell you that it is illegal. Whether a given campaign is lawful depends on your jurisdiction, your list, your consent posture, your message content, and facts this tool cannot see. **You are solely responsible for compliance. Consult a lawyer before running this at any scale.**

What the tool does to help (and what it cannot do):

- Every message ends with `Reply STOP to opt out.` This is appended at a single point in the code and **cannot be disabled by any flag**.
- A do-not-contact list is supported (`do-not-contact.txt`). **You must actually maintain it.** Add anyone who replies STOP or asks not to be contacted, before your next run.
- Sending is limited to configurable business hours, defaulting to 9 AM – 6 PM local time.
- The tool cannot obtain consent for you, cannot verify your list's provenance, and cannot make an unlawful campaign lawful.

**Data handling.** Your leads CSV and `outreach-log.json` contain **third-party personal data** (names, phone numbers, addresses, and the message text sent to each person). Do not commit them to git, do not paste them into issues or chats, and do not share them. `.gitignore` already excludes `*.csv`, `*.db`, `*.log`, `outreach-log.json`, and `do-not-contact.txt`, but that is a safety net, not a substitute for care.

---

## Requirements

- **macOS** with Messages.app signed in — required for **live sending only**
- [`imsg` CLI](https://imsg.to) installed: `brew install steipete/tap/imsg` — live sending only
- Node.js v14+ (dry runs work on macOS, Linux, and Windows)

> **macOS-only warning.** Live sending drives the local Messages.app through `imsg`, so a real send only works on a signed-in Mac. **Dry runs work anywhere** Node runs and need neither macOS nor `imsg`.
>
> Messages to Apple devices go over iMessage. Sending to a **non-iMessage number** (most Android phones) additionally requires **Text Message Forwarding** enabled between your iPhone and your Mac (iPhone → Settings → Apps → Messages → Text Message Forwarding), with both devices on the same Apple Account. Without it, those sends fail.

---

## 🚀 Quick Setup Guide

### 1. Clone the repo

```bash
git clone <your-fork-or-repo-url> lead-outreach
cd lead-outreach
```

### 2. No install step

**There is no `npm install`.** This tool has **zero npm dependencies** and uses only Node builtins. If you have Node v14+, you can run it.

### 3. Install system requirements (live sending only)

macOS with your Apple account signed in to Messages, plus the `imsg` helper:

```bash
brew install steipete/tap/imsg
```

### 4. Add your leads CSV

Create `leads.csv` in the project directory (or point at it with `--leads`). See the CSV schema below and the bundled `leads.example.csv`.

### 5. Configure API keys (optional)

If you want Numverify or Abstract carrier checks, copy the environment template and paste your credentials:

```bash
cp .env.template .env
```

*(Without API keys the tool operates in **offline-first mode** using the local prefix database.)*

### 6. Compile the offline carrier prefix database (optional)

```bash
python3 scripts/download_carrier_db.py
```

*(Downloads, parses, and writes a compressed `us_mobile_prefixes.json`, roughly 2 MB, into your project directory.)*

---

## 📄 Leads CSV format

The CSV needs a header row with these columns:

| Column | Required | Purpose |
|--------|----------|---------|
| `Name` | Yes | Business name. Used in the greeting. |
| `Phone` | Yes | Any common US format. Normalized to E.164 internally. Rows that cannot be normalized are skipped. |
| `Address` | No | Recorded in the outreach log only. |

Example (`leads.example.csv`, all numbers are fake 555-range placeholders):

```csv
Name,Phone,Address
Example Landscaping Co,(555) 010-0101,"101 Example Ave, Springfield, IL"
Sample Hair Studio,555-010-0102,"202 Sample St, Springfield, IL"
Demo Roofing LLC,+15550100103,"303 Demo Rd, Springfield, IL"
```

Try it without sending anything:

```bash
node outreach.js --leads ./leads.example.csv
```

---

## 🚫 Do-not-contact list

Copy `do-not-contact.example.txt` to `do-not-contact.txt` and add one phone number per line. `#` comments and blank lines are ignored, and any common US format is accepted.

By default the script looks for `do-not-contact.txt` **in the same directory as your leads CSV**. Override it with `--suppress <file>`.

Suppressed numbers are filtered out of the send queue and the count is printed on every run.

```bash
cp do-not-contact.example.txt do-not-contact.txt
node outreach.js --suppress ./do-not-contact.txt
```

**Add a number the moment someone replies STOP.** The tool cannot read replies for you.

---

## Usage

**Dry run is the default. Nothing is transmitted unless you pass `--send`.**

```bash
# Preview messages — the default, sends nothing
node outreach.js

# Preview from a specific CSV, capped at 5 leads
node outreach.js --leads ./leads.csv --limit 5

# LIVE send to just the first lead (good for testing)
node outreach.js --send --sender "Your Name" --limit 1

# LIVE send to all queued leads
node outreach.js --send --sender "Your Name"

# Custom business-hours window
node outreach.js --send --sender "Your Name" --hours 10-17
```

### Options

| Flag | Env var | Default | Purpose |
|------|---------|---------|---------|
| `--send` | — | off | Actually transmit. Without it, preview only. |
| `--leads <file>` | `LEADS_CSV` | `./leads.csv` | Path to the leads CSV. |
| `--sender "Name"` | `SENDER_NAME` | none | Name signed on every message. **Required for `--send`.** |
| `--suppress <file>` | — | `do-not-contact.txt` beside the CSV | Do-not-contact list. |
| `--hours 9-18` | `BUSINESS_HOURS_START` / `BUSINESS_HOURS_END` | `9-18` | Business-hours window, 24-hour clock. |
| `--limit <n>` | — | no limit | Cap how many leads are processed. |
| `-h`, `--help` | — | — | Show help and exit. |

A live send without a sender name exits with an error: recipients must be able to tell who is texting them. Dry runs fall back to a visible `<YOUR NAME>` placeholder.

---

## How It Works

1. Reads the leads CSV (`--leads`, `LEADS_CSV`, or `./leads.csv`)
2. Skips rows with no valid phone number, already-contacted numbers, and numbers on the do-not-contact list
3. Enforces business hours (9 AM – 6 PM local time by default)
4. Sends each lead a personalized message via `imsg send`, always ending with `Reply STOP to opt out.`
5. Waits a random 1–5 minute delay before the next send
6. Logs every send (success or failure) to `outreach-log.json`

---

## Files

| File | Purpose |
|------|---------|
| `outreach.js` | Main script |
| `leads.example.csv` | Example leads CSV with fake data |
| `do-not-contact.example.txt` | Template for your suppression list |
| `outreach-log.json` | Auto-generated. Tracks all sent messages. Used to skip duplicates on re-runs. **Contains personal data — do not share.** |

---

## Message Template

```
Hi [Business Name]! My name is [Your Name] and I'm a professional web developer
and I noticed your business doesn't have a website listed on Google.

A website could help you:
✅ Show up in Google searches
✅ Let customers find your hours & contact info 24/7
✅ Look more professional and build trust

I'd love to build you one — affordable, fast, and hassle-free.

When would you be available for a quick 10-minute chat? 😊

Reply STOP to opt out.
```

The script rotates through six templates. To edit the copy, update the `buildMessageBody()` function in `outreach.js`. The `Reply STOP to opt out.` line is appended in `buildMessage()` and is deliberately not editable per-template.

---

## 🔌 Free Offline Carrier Lookup

To reduce texts sent to landlines (which fail and waste outreach effort) without hitting paid API limits, this project supports an **offline phone carrier prefix database**.

### How to compile the database

```bash
python3 scripts/download_carrier_db.py
```

This downloads the official NANPA Central Office Code assignment zip, parses assigned codes, and compiles a compressed local lookup file `us_mobile_prefixes.json` (approx 2 MB) that loads into memory in milliseconds.

### How the lookup works

1. **Primary API check**: if `NUMVERIFY_API_KEY` and `ABSTRACT_API_KEY` are configured in `.env`, the script queries them.
2. **Automatic offline fallback**: if keys are missing, invalid, or their free quotas are exhausted, the script falls back to the local `us_mobile_prefixes.json` database.
3. **Offline-first mode**: with no API keys and a compiled database, all lookups run locally with zero network requests.

### ⚠️ Accuracy caveat — this is a heuristic, not a verification

The offline lookup is a **regex heuristic over carrier names** in the NANPA registry. It guesses line type from the name of the carrier a prefix block was originally assigned to. It is not authoritative and it will be wrong on real numbers:

- **Ported numbers are misclassified.** Number portability means the assigned carrier for a prefix block often is not the carrier actually serving that number. A mobile number ported from a landline block still looks like a landline here, and vice versa.
- **VoIP is folded into "landline."** The offline path has no separate VoIP class, so VoIP numbers, many of which *can* receive SMS, are classified as landline and skipped.
- **Prefix-level granularity only.** Classification is per 6-digit prefix block, not per number.
- **Registry lag.** The database is only as current as the last time you compiled it.

Treat the result as a rough filter that saves some wasted sends, not as proof that a number is or is not a mobile. The paid APIs are more accurate but also imperfect. Neither tells you whether the person on the other end wants to hear from you.

---

## Sender Protections

These reduce friction and risk **for you, the sender**. They do nothing for recipients.

- **Dry-run by default** — nothing sends unless you pass `--send`
- **`imsg` preflight check** — aborts immediately if the CLI is missing, instead of failing on every lead
- **Deduplication** — skips numbers already in `outreach-log.json`
- **Offline carrier check** — skips likely landlines (see the accuracy caveat above)
- **`--limit` flag** — cap how many you send in a session
- **Full logging** — every send is recorded with timestamp and status

## Recipient Protections

These exist to protect the **people receiving the messages**.

- **Mandatory opt-out line** — every message ends with `Reply STOP to opt out.`, appended at one point in the code with no flag to disable it
- **Do-not-contact list** — numbers in `do-not-contact.txt` are filtered out of every run, and the suppressed count is reported
- **Business hours enforcement** — no sends before 9 AM or after 6 PM local time by default, re-checked between every send
- **Mandatory sender identification** — a live send refuses to start without a sender name, so recipients always know who is texting
- **Human-scale pacing** — a random 1–5 minute gap between sends keeps volume low rather than blasting a list
