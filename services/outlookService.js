// backend/services/outlookService.js
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { ConfidentialClientApplication } from '@azure/msal-node';
import axios from 'axios';

// --- Load ../.env relative to this file (services/) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// TEMP sanity log (remove after verified)
console.log('[MS ENV in outlookService]',
  process.env.MS_CLIENT_ID ? 'clientId:OK' : 'clientId:MISSING',
  process.env.MS_TENANT_ID ? 'tenantId:OK' : 'tenantId:MISSING',
  process.env.MS_CLIENT_SECRET ? 'secret:OK' : 'secret:MISSING'
);

export const MS_SCOPES = [
  'Calendars.ReadWrite',
  'offline_access',
  'openid',
  'profile',
  'User.Read',
];

let _msalApp = null;

// Lazy-construct MSAL so env is guaranteed loaded
function getMsalApp() {
  if (_msalApp) return _msalApp;

  const missing = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID']
    .filter(k => !(process.env[k] && process.env[k].trim()));
  if (missing.length) {
    throw new Error(`Missing Microsoft env vars: ${missing.join(', ')}`);
  }

  _msalApp = new ConfidentialClientApplication({
    auth: {
      clientId: process.env.MS_CLIENT_ID.trim(),
      authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID.trim()}`,
      clientSecret: process.env.MS_CLIENT_SECRET.trim(), // MUST be the Secret **Value**
    },
    system: { loggerOptions: { piiLoggingEnabled: false } },
  });

  return _msalApp;
}

// Very simple in-memory cache for delegated account (login once)
let cachedAccount = null;

export async function getAuthUrl() {
  const msalApp = getMsalApp();
  return msalApp.getAuthCodeUrl({
    scopes: MS_SCOPES,
    redirectUri: process.env.MS_REDIRECT_URI,
  });
}

export async function handleAuthCode(code) {
  const msalApp = getMsalApp();
  const result = await msalApp.acquireTokenByCode({
    code,
    scopes: MS_SCOPES,
    redirectUri: process.env.MS_REDIRECT_URI,
  });
  cachedAccount = result.account;
  return result;
}

async function getAccessToken() {
  const msalApp = getMsalApp();
  if (!cachedAccount) {
    throw new Error('Microsoft account not connected. Visit /ms-auth/login first.');
  }
  const res = await msalApp.acquireTokenSilent({
    account: cachedAccount,
    scopes: MS_SCOPES,
  });
  return res.accessToken;
}

// Map your time labels to start/end (Eastern)
const SLOT_MAP = {
  '9am-12pm EST/8am-11pm CST': { start: '09:00', end: '12:00' },
  '2pm-5pm EST/1pm-4pm CST':  { start: '14:00', end: '17:00' },
  '10am-1pm EST/9am-12pm CST':{ start: '10:00', end: '13:00' }, // Friday special
};

export async function createOutlookEvent({ company, studentName, studentEmail, dateISO, timeLabel }) {
  if (!SLOT_MAP[timeLabel]) {
    throw new Error(`Unknown time label "${timeLabel}"`);
  }
  const { start, end } = SLOT_MAP[timeLabel];

  const subject = `Intro to AI Class – ${company || 'Company'}`;
  const bodyContent = [
    `Company: ${company || 'N/A'}`,
    studentName ? `Name: ${studentName}` : null,
    studentEmail ? `Email: ${studentEmail}` : null,
    `Date: ${dateISO}`,
    `Time: ${timeLabel}`,
  ].filter(Boolean).join('\n');

  const event = {
    subject,
    body: { contentType: 'Text', content: bodyContent },
    start: { dateTime: `${dateISO}T${start}:00`, timeZone: 'Eastern Standard Time' },
    end:   { dateTime: `${dateISO}T${end}:00`,   timeZone: 'Eastern Standard Time' },
    // If you want to invite the student:
    // attendees: studentEmail ? [{ emailAddress: { address: studentEmail }, type: 'required' }] : [],
  };

  const token = await getAccessToken();
  const resp = await axios.post(
    'https://graph.microsoft.com/v1.0/me/events',
    event,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return resp.data;
}

export { getMsalApp };
