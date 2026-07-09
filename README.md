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
- **Projects** — track a one-off big spend (a renovation, a trip, a wedding) as its own project with an optional budget, broken into individual expenses. Each project shows total spent vs. budget; its expenses also roll up into Overview's "Expenses by category" under a Projects row, broken out per project. Each project can optionally carry a planning checklist (item + estimated cost); checking an item off logs it as a real expense for that amount, and unchecking removes it again.
- **Household (shared with another person)** — the Household tab lets you create a shared pool of data and invite one other person (or more) into it with a join code — no email lookup needed, so no extra backend required. When you're in a household:
  - Adding a transaction, recurring rule, or project shows a **Personal / Household** choice. Personal stays private to you; Household is visible and editable by every member.
  - Household data is **combined with your personal data** everywhere it matters — Overview totals, the category breakdown, the spending chart, Entries, Recurring, and CSV export all merge both pools (household-sourced rows carry a ⌂ badge and show who added them).
  - Projects can be shared the same way: a household project's expenses can be added and edited by anyone in the household, and still roll up into everyone's Overview.
  - Investments and Excel/Revolut imports stay personal-only (not shared) to keep those simple.
  - Leaving a household only removes shared entries from your view; your personal data is untouched. The household's owner can delete it outright, which removes the shared data for everyone.
  - Household projects get their own grid on Overview ("⌂ Household projects"), separate from your personal "Expenses by category" table, so the two don't blend together.
  - A project's Personal/Household scope can be changed after creation too — switching moves it (and everything logged against it) between the two pools.
  - **Splitting who paid what**: a household transaction or project expense can be split across members instead of hitting everyone's numbers at full value. New entries default to an equal split (editable per entry); each member's Overview, category breakdown, and Entries totals only count *their own* share — not the full amount — so one person's €900 doesn't show up as -€900 for every member. The Projects tab itself still shows true project totals against budget, since that's about the project's real cost, not any one person's share.
- **Drill-down details** — tap any amount in Overview's Monthly summary or Expenses by category tables to see exactly which transactions make it up. Tapping one of those opens it for editing.
- **Trigger recurring entries early** — if today is before a rule's usual day this month, its Recurring row shows a "⚡ Trigger early" button: it moves just this month's charge to today (handy for "the rent actually went out early this time"). Next month it's back to the normal day automatically — this is a one-off adjustment, not a change to the rule itself.
- **Lending reminders** — a separate Lending tab tracks money lent to or borrowed from someone (person, amount, optional due date), with overdue flags and a settled/unsettled toggle. Kept out of the main ledger entirely so IOUs don't affect your income/expense totals. Personal only (not shared with a household).
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
There's no self-service sign-up screen (by design — this is a single-user book, not a public app). Create your account once in the console: **Build → Authentication → Users → Add user**, enter your email + a password. Then open the URL and sign in with those credentials. If you want to share a Household with someone else, create an account for them the same way — then either of you can generate a join code from the Household tab.
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
                        source? "excel" | "revolut" | "project", projectId? }  // imported/project entries are tagged
  recurring/{id}      { type, name, amount, day, category, subcategory,
                        startMonth "YYYY-MM", endMonth "YYYY-MM" | null,
                        overrides?: { "YYYY-MM": {skip:true} | {amount, day} } }
  projects/{id}       { name, budget: number | null, note, archived,
                        checklist?: [{ id, name, estimate, expenseId }] }  // optional; checked = expenseId set
  investments/{year}  { months: { "1": {start, invested, pl}, ... } }
  loans/{id}          { direction: "lent" | "borrowed", person, amount, date, dueDate: string | null, note, settled }
  meta/settings       { startingBalance, currency, categories, merchantMap }
  meta/bank           { requisitionId, institutionName, lastSync }   // only with live sync

households/{id}       { name, ownerUid, members: [uid, ...], memberNames: {uid: email} }
  transactions/{id}   { …same shape as above, plus addedBy: uid, payers?: {uid: amount} }  // payers = who paid what of the total
  recurring/{id}      { …same shape as above, plus addedBy: uid }
  projects/{id}       { …same shape as above, plus addedBy: uid }
```
The household document's id doubles as its join code — creating one generates a random Firestore id, which you share with whoever you're inviting. Anyone signed in can look up a household by that exact id (needed to join), but only members can list a household in a query or read/write its transactions, recurring rules, or projects (see `firestore.rules`).
Recurring rules are expanded virtually at display time (one entry per month between start and end, inclusive, with per-month overrides applied), so editing a rule instantly updates every month and nothing is duplicated in the database. Imported entries use deterministic ids (`xl-…` for Excel, `rev-…` for Revolut), which is what makes re-imports and re-syncs duplicate-proof.

## Notes & limits
- The Excel sheets store monthly totals, not individual purchases, so the Excel import creates one entry per subcategory per month, dated the 15th. If those months are also covered by recurring rules you set up, the amounts would be counted twice — import first, then start recurring rules from the following month (or remove the imports for overlapping months).
- On desktop Safari the "month" pickers fall back to a text field — type `2026-03` format.
- Amounts are formatted Slovenian-style (1.234,56 €); change the currency symbol in Settings.
- Revolut CSV: only COMPLETED transactions are offered; internal transfers start unchecked so vault top-ups don't show up as spending.
