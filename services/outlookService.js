// backend/services/outlookService.js
import 'isomorphic-fetch';
import dotenv from 'dotenv';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';

// Load env for this module (expects backend/.env)
dotenv.config();

// ------------------------------------------------------
// Environment variables
// ------------------------------------------------------
const {
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MS_TENANT_ID,
  MS_OUTLOOK_USER_EMAIL, // calendar owner (your 365 email)
} = process.env;

console.log('[OutlookService] Loaded ENV:', {
  MS_CLIENT_ID: MS_CLIENT_ID ? 'OK' : 'MISSING',
  MS_CLIENT_SECRET: MS_CLIENT_SECRET ? 'OK' : 'MISSING',
  MS_TENANT_ID: MS_TENANT_ID ? 'OK' : 'MISSING',
  MS_OUTLOOK_USER_EMAIL: MS_OUTLOOK_USER_EMAIL || 'MISSING',
});

if (!MS_CLIENT_ID || !MS_CLIENT_SECRET || !MS_TENANT_ID) {
  console.warn(
    '⚠️ [OutlookService] MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT_ID are not all set. ' +
      'Outlook integration will fail until these are configured.'
  );
}

if (!MS_OUTLOOK_USER_EMAIL) {
  console.warn(
    '⚠️ [OutlookService] MS_OUTLOOK_USER_EMAIL is not set. ' +
      'Events will not be written to any calendar.'
  );
}

// ------------------------------------------------------
// MSAL Confidential Client (client credentials flow)
// ------------------------------------------------------
let cca = null;

if (MS_CLIENT_ID && MS_CLIENT_SECRET && MS_TENANT_ID) {
  const msalConfig = {
    auth: {
      clientId: MS_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${MS_TENANT_ID}`,
      clientSecret: MS_CLIENT_SECRET,
    },
  };

  cca = new ConfidentialClientApplication(msalConfig);
} else {
  console.warn(
    '⚠️ [OutlookService] MSAL client NOT initialized because credentials are missing.'
  );
}

async function getGraphClient() {
  if (!cca) {
    throw new Error(
      'MSAL client not configured (missing MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT_ID)'
    );
  }

  console.log('🔑 [OutlookService] Acquiring Graph token via client credentials...');

  const tokenResponse = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });

  if (!tokenResponse || !tokenResponse.accessToken) {
    console.error('❌ [OutlookService] Failed to acquire Graph access token:', tokenResponse);
    throw new Error('Failed to acquire Graph access token');
  }

  console.log('✅ [OutlookService] Got Graph access token');

  const client = Client.init({
    authProvider: (done) => {
      done(null, tokenResponse.accessToken);
    },
  });

  return client;
}

// ------------------------------------------------------
// Map your time labels → actual start/end times (24h)
// ------------------------------------------------------
const SLOT_MAP = {
  '9am-12pm EST/8am-11pm CST': {
    start: '09:00',
    end: '12:00',
  },
  '2pm-5pm EST/1pm-4pm CST': {
    start: '14:00',
    end: '17:00',
  },
  '10am-1pm EST/9am-12pm CST': {
    start: '10:00',
    end: '13:00',
  },
};

// ------------------------------------------------------
// Main function: create an Outlook calendar event
// ------------------------------------------------------
/**
 * Create an Outlook event for a scheduled class.
 *
 * @param {Object} params
 * @param {string} params.company      - Company name
 * @param {string} params.studentName  - Student full name
 * @param {string} params.studentEmail - Student email
 * @param {string} params.dateISO      - Date in YYYY-MM-DD
 * @param {string} params.timeLabel    - One of the UI time slot labels
 */
export async function createOutlookEvent({
  company,
  studentName,
  studentEmail,
  dateISO,
  timeLabel,
}) {
  console.log('🟢 [createOutlookEvent] called with:', {
    company,
    studentName,
    studentEmail,
    dateISO,
    timeLabel,
  });

  if (!MS_OUTLOOK_USER_EMAIL) {
    console.warn(
      '⚠️ [createOutlookEvent] MS_OUTLOOK_USER_EMAIL is not set. Skipping Outlook event creation.'
    );
    return null;
  }

  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET || !MS_TENANT_ID) {
    console.warn(
      '⚠️ [createOutlookEvent] MSAL credentials are missing. Skipping event creation.'
    );
    return null;
  }

  if (!dateISO || !timeLabel) {
    console.warn('⚠️ [createOutlookEvent] Missing dateISO or timeLabel. Skipping.');
    return null;
  }

  const slot = SLOT_MAP[timeLabel];
  if (!slot) {
    console.warn(
      '⚠️ [createOutlookEvent] Unknown timeLabel, no SLOT_MAP entry found for:',
      timeLabel
    );
    return null;
  }

  // Build start/end datetime strings in local (server) timezone
  const startDateTime = `${dateISO}T${slot.start}:00`;
  const endDateTime = `${dateISO}T${slot.end}:00`;

  console.log('⏱ [createOutlookEvent] Computed times:', {
    startDateTime,
    endDateTime,
  });

  let client;
  try {
    client = await getGraphClient();
  } catch (err) {
    console.error('❌ [createOutlookEvent] Could not get Graph client:', err.message || err);
    return null; // Don’t crash whole server
  }

  const subject = `Intro to AI Class - ${company || 'Kable Academy'}`;
  const bodyHtml = `
    <p><strong>Company:</strong> ${company || 'N/A'}</p>
    <p><strong>Student:</strong> ${studentName || 'N/A'}</p>
    <p><strong>Email:</strong> ${studentEmail || 'N/A'}</p>
    <p><strong>Date:</strong> ${dateISO}</p>
    <p><strong>Time:</strong> ${timeLabel}</p>
  `;

  const event = {
    subject,
    body: {
      contentType: 'HTML',
      content: bodyHtml,
    },
    start: {
      dateTime: startDateTime,
      timeZone: 'America/New_York',
    },
    end: {
      dateTime: endDateTime,
      timeZone: 'America/New_York',
    },
    attendees: studentEmail
      ? [
          {
            emailAddress: {
              address: studentEmail,
              name: studentName || studentEmail,
            },
            type: 'required',
          },
        ]
      : [],
  };

  try {
    console.log(
      `📤 [createOutlookEvent] Creating event on calendar of ${MS_OUTLOOK_USER_EMAIL}...`
    );

    const response = await client
      .api(`/users/${encodeURIComponent(MS_OUTLOOK_USER_EMAIL)}/events`)
      .post(event);

    console.log('✅ [createOutlookEvent] Outlook event created:', {
      id: response.id,
      subject: response.subject,
      start: response.start,
      end: response.end,
    });

    return response;
  } catch (err) {
    console.error(
      '❌ [createOutlookEvent] Error from Microsoft Graph:',
      err.response?.data || err.message || err
    );
    return null;
  }
}
