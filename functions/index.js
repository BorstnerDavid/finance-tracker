// ═══════════════════════════════════════════════════════════
// Optional backend: live Revolut sync via GoCardless Bank
// Account Data (the free EU open-banking API, formerly Nordigen).
//
// Setup (see README):
//   1. Create a free account at bankaccountdata.gocardless.com
//      and generate a Secret ID + Secret Key (User secrets page).
//   2. firebase functions:secrets:set GC_SECRET_ID
//      firebase functions:secrets:set GC_SECRET_KEY
//   3. firebase deploy --only functions   (requires Blaze plan)
// ═══════════════════════════════════════════════════════════
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const GC_SECRET_ID = defineSecret('GC_SECRET_ID');
const GC_SECRET_KEY = defineSecret('GC_SECRET_KEY');
const GC = 'https://bankaccountdata.gocardless.com/api/v2';
const REGION = 'europe-west1';

// ─── GoCardless helpers ──────────────────────────────────────
async function gcToken() {
  const res = await fetch(`${GC}/token/new/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret_id: GC_SECRET_ID.value(), secret_key: GC_SECRET_KEY.value() }),
  });
  if (!res.ok) throw new HttpsError('internal', 'Bank API auth failed — check your GoCardless secrets.');
  return (await res.json()).access;
}

async function gc(token, path, opts = {}) {
  const res = await fetch(`${GC}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpsError('internal', `Bank API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function requireAuth(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  return request.auth.uid;
}

// ─── bankConnect: start the Revolut authorisation flow ───────
exports.bankConnect = onCall(
  { region: REGION, secrets: [GC_SECRET_ID, GC_SECRET_KEY] },
  async (request) => {
    const uid = requireAuth(request);
    const country = (request.data?.country || 'SI').toUpperCase().slice(0, 2);
    const redirect = String(request.data?.redirect || '').slice(0, 200);
    if (!/^https?:\/\//.test(redirect)) throw new HttpsError('invalid-argument', 'Bad redirect URL.');

    const token = await gcToken();

    // Find the Revolut institution for the user's country
    const institutions = await gc(token, `/institutions/?country=${country}`);
    const inst = institutions.find((i) => /revolut/i.test(i.name) || /^REVOLUT_/.test(i.id));
    if (!inst) throw new HttpsError('not-found', `Revolut isn't available for country ${country}.`);

    // Agreement: 90 days of history, 90 days of access
    const agreement = await gc(token, '/agreements/enduser/', {
      method: 'POST',
      body: JSON.stringify({
        institution_id: inst.id,
        max_historical_days: 90,
        access_valid_for_days: 90,
        access_scope: ['transactions', 'details'],
      }),
    });

    const requisition = await gc(token, '/requisitions/', {
      method: 'POST',
      body: JSON.stringify({
        redirect,
        institution_id: inst.id,
        agreement: agreement.id,
        reference: `${uid}-${Date.now()}`,
        user_language: 'EN',
      }),
    });

    await db.doc(`users/${uid}/meta/bank`).set({
      requisitionId: requisition.id,
      institutionId: inst.id,
      institutionName: inst.name,
      connectedAt: new Date().toISOString(),
    });

    return { link: requisition.link };
  });

// ─── bankSync: pull booked transactions into Firestore ───────
exports.bankSync = onCall(
  { region: REGION, secrets: [GC_SECRET_ID, GC_SECRET_KEY], timeoutSeconds: 120 },
  async (request) => {
    const uid = requireAuth(request);
    const bankRef = db.doc(`users/${uid}/meta/bank`);
    const bankSnap = await bankRef.get();
    if (!bankSnap.exists) throw new HttpsError('failed-precondition', 'No bank connected yet.');
    const { requisitionId } = bankSnap.data();

    const token = await gcToken();
    const req = await gc(token, `/requisitions/${requisitionId}/`);
    if (!req.accounts?.length) {
      throw new HttpsError('failed-precondition',
        'The bank link isn’t finished yet — tap Connect Revolut and complete the authorisation.');
    }

    // Merchant map learned from the user's earlier categorisations
    const settingsSnap = await db.doc(`users/${uid}/meta/settings`).get();
    const merchantMap = settingsSnap.data()?.merchantMap || {};
    const norm = (d) => String(d).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);

    let imported = 0, skipped = 0;
    for (const accountId of req.accounts) {
      const data = await gc(token, `/accounts/${accountId}/transactions/`);
      for (const t of data.transactions?.booked || []) {
        const amt = parseFloat(t.transactionAmount?.amount);
        const date = t.bookingDate || t.valueDate;
        if (!amt || !date) continue;
        const desc = (t.creditorName || t.debtorName ||
          t.remittanceInformationUnstructured ||
          (t.remittanceInformationUnstructuredArray || []).join(' ') || 'Revolut').trim();
        const type = amt < 0 ? 'expense' : 'income';
        const saved = merchantMap[norm(desc)];
        const category = saved?.type === type ? saved.category : (type === 'expense' ? 'Everyday' : 'Other');
        const subcategory = saved?.type === type ? saved.subcategory : 'Other';
        const rawId = t.transactionId || t.internalTransactionId || `${date}|${desc}|${amt}`;
        const id = 'rev-' + String(rawId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
        try {
          // create() fails if the doc exists → user recategorisations are never overwritten
          await db.doc(`users/${uid}/transactions/${id}`).create({
            type, amount: Math.abs(Math.round(amt * 100) / 100), date,
            category, subcategory, note: desc, source: 'revolut',
          });
          imported++;
        } catch (e) {
          if (e.code === 6 /* ALREADY_EXISTS */) skipped++;
          else throw e;
        }
      }
    }

    await bankRef.set({ lastSync: new Date().toISOString() }, { merge: true });
    return { imported, skipped };
  });
