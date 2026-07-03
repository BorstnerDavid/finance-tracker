# Ledger — personal expense tracker

A personal finance web app built to replace the `Finance_2026` Excel workbook. Hosted on Firebase Hosting, with email/password login (Firebase Auth) and data stored per-user in Firestore. No build step — plain HTML/CSS/JS, deploys as-is.

## What it does

**From the Excel (all sheets covered):**
- **Expenses & Income** — individual entries with date, category, subcategory and note. Categories and subcategories are seeded from your workbook (Everyday, Entertainment, Investment, Gifts, Health, Home, Transportation, Travel; Paycheck/Bonus, Dividends, Dohodnina, …) and are fully editable in Settings.
- **Summary** — the Overview tab reproduces the Summary sheet: monthly Income / Expenses / Net savings / Ending balance, plus yearly totals and per-month averages (average-to-date for the current year, like your MTD column).
- **Starting balance** — set it in Settings; the running ending balance is computed from it.
- **Investment** — an Investments tab with the same monthly Starting balance / Invested / Profit-Loss tracker.

**Added beyond the Excel:**
- **Recurring monthly entries with start and end date** — e.g. rent from 2026-01, Netflix from 2026-03 until 2026-08. Each rule repeats on a chosen day of the month and appears automatically in Entries, Overview and CSV exports.
- **Per-month adjustments to recurring entries** — tap any recurring entry in Entries to change its amount/day for just that month, or skip that month entirely. All adjustments are listed (and removable) inside the rule's edit screen.
- **Excel workbook import** — Settings → Import → choose your `Finance_20xx.xlsx`. Creates one entry per subcategory per month (dated the 15th), and pulls in the starting balance and the Investment sheet. Idempotent: re-importing updates instead of duplicating, and there's a one-click undo.
- **Revolut statement import (CSV)** — export a statement from the Revolut app, review every transaction in-app (with auto-guessed Slovenian merchant categories: Mercator/Špar → groceries, Petrol → Bencin, Wolt → dostava, …), adjust categories, import. Your category picks are remembered per merchant. Duplicate-proof.
- **Live Revolut sync (optional)** — connect your Revolut account through GoCardless Bank Account Data (the free EU open-banking API) and pull transactions with one tap. Requires the Cloud Functions setup below.
- Transaction-level tracking with search and month/type filters
- Income vs expenses bar chart and category donut chart
- Year-strip: a 12-month mini chart of net savings at the top of Overview
- CSV export of any year (opens cleanly in Excel)
- Multi-year support — flip years with the ‹ › control in the header
- Mobile layout with bottom tab bar and a floating + button

## One-time setup (~10 minutes)

### 1. Create the Firebase project
1. Go to https://console.firebase.google.com → **Add project** (e.g. `david-ledger`). Google Analytics can stay off.
2. In the project, click the **Web** icon (`</>`) to register a web app. Copy the `firebaseConfig` object it shows you.
3. Paste those values into **`public/firebase-config.js`** in this folder.

### 2. Enable email login
- Console → **Build → Authentication → Get started → Sign-in method → Email/Password → Enable**.
- Leave every other provider off — the app only offers email login.

### 3. Enable Firestore
- Console → **Build → Firestore Database → Create database** → choose a region near you (e.g. `europe-west3`) → start in **production mode**.
- The security rules in `firestore.rules` will be deployed in the next step; they restrict every user to their own data:
  ```
  match /users/{uid}/{document=**} {
    allow read, write: if request.auth != null && request.auth.uid == uid;
  }
  ```

### 4. Deploy
```bash
npm install -g firebase-tools
firebase login
```
Edit `.firebaserc` and replace `YOUR_FIREBASE_PROJECT_ID` with your project id, then:
```bash
firebase deploy --only hosting,firestore
```
Your app is live at `https://<project-id>.web.app`. (The plain `firebase deploy` also tries to deploy the optional bank-sync functions — skip that until you've done the section below, or leave it out forever; everything else works without it.)

### 5. First run
Open the URL, tap **Create one** to register your email + password, then:
1. Settings → set your **starting balance** — or skip this and just import the Excel, which sets it for you.
2. Settings → Import → **Choose .xlsx** and pick `Finance_2026_David.xlsx`.
3. Recurring → add your fixed monthly items (rent, subscriptions, salary as recurring *income*).
4. Use the **+** button to log everyday entries, or import Revolut statements as you go.

## Optional: live Revolut sync (Cloud Functions)

Revolut has no public API for personal accounts, so the live connection goes through **GoCardless Bank Account Data** — the official EU open-banking aggregator (free for personal use, up to 50 connections). One-time setup:

1. **Upgrade the Firebase project to the Blaze plan** (Cloud Functions requirement; with this usage you'll stay within the free allowances, but set a budget alert to be safe).
2. Create a free account at https://bankaccountdata.gocardless.com → **Developers → User secrets → Create** → note the Secret ID and Secret Key.
3. Store them as Firebase secrets and deploy:
   ```bash
   cd functions && npm install && cd ..
   firebase functions:secrets:set GC_SECRET_ID     # paste the Secret ID
   firebase functions:secrets:set GC_SECRET_KEY    # paste the Secret Key
   firebase deploy --only functions
   ```
4. In the app: Settings → **Connect Revolut**. You'll be redirected to Revolut to authorise read-only access (90 days of history, valid 90 days), then back to the app. Tap **Sync now** whenever you want fresh data.

Sync details: transactions are keyed by Revolut's transaction id, so syncing repeatedly never duplicates, and entries you've recategorized are never overwritten. New transactions are auto-filed using the merchant categories the app has learned from your CSV imports and edits; anything unknown lands in Everyday/Other for you to refile. After 90 days the bank consent expires — just tap Connect Revolut again.

If you'd rather not run a backend at all, the **Revolut CSV import** gives you the same data with one extra tap per month (Revolut app → Statement → CSV).

## Local preview
```bash
firebase serve      # or: firebase emulators:start --only hosting
```
(Requires the real Firebase config pasted in, since Auth/Firestore run against your project.)

## Data model
```
users/{uid}/
  transactions/{id}   { type, date "YYYY-MM-DD", amount, category, subcategory, note,
                        source? "excel" | "revolut" }        // imported entries are tagged
  recurring/{id}      { type, name, amount, day, category, subcategory,
                        startMonth "YYYY-MM", endMonth "YYYY-MM" | null,
                        overrides?: { "YYYY-MM": {skip:true} | {amount, day} } }
  investments/{year}  { months: { "1": {start, invested, pl}, ... } }
  meta/settings       { startingBalance, currency, categories, merchantMap }
  meta/bank           { requisitionId, institutionName, lastSync }   // only with live sync
```
Recurring rules are expanded virtually at display time (one entry per month between start and end, inclusive, with per-month overrides applied), so editing a rule instantly updates every month and nothing is duplicated in the database. Imported entries use deterministic ids (`xl-…` for Excel, `rev-…` for Revolut), which is what makes re-imports and re-syncs duplicate-proof.

## Notes & limits
- The Excel sheets store monthly totals, not individual purchases, so the Excel import creates one entry per subcategory per month, dated the 15th. If those months are also covered by recurring rules you set up, the amounts would be counted twice — import first, then start recurring rules from the following month (or remove the imports for overlapping months).
- On desktop Safari the "month" pickers fall back to a text field — type `2026-03` format.
- Amounts are formatted Slovenian-style (1.234,56 €); change the currency symbol in Settings.
- Revolut CSV: only COMPLETED transactions are offered; internal transfers start unchecked so vault top-ups don't show up as spending.
