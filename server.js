// backend/server.js (ESM)
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import mongoose from 'mongoose';
import moment from 'moment';
import cors from 'cors';
import dotenv from 'dotenv';

// ----- Load .env BEFORE any imports that rely on it -----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

// ----- Explicit ENV sanity logs -----
console.log('[ENV LOADED]');
console.log('[HubSpot ENV check]', {
  CLIENT_ID: process.env.CLIENT_ID ? 'OK' : 'MISSING',
  CLIENT_SECRET: process.env.CLIENT_SECRET ? 'OK' : 'MISSING',
  REDIRECT_URI: process.env.REDIRECT_URI ? 'OK' : 'MISSING',
  SECRET_KEY: process.env.SECRET_KEY ? 'OK' : 'MISSING',
  ATLAS_URI: process.env.ATLAS_URI ? 'OK' : 'MISSING',
});
console.log('[Microsoft ENV check]', {
  MS_CLIENT_ID: process.env.MS_CLIENT_ID ? 'OK' : 'MISSING',
  MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET ? 'OK' : 'MISSING',
  MS_TENANT_ID: process.env.MS_TENANT_ID ? 'OK' : 'MISSING',
  MS_REDIRECT_URI: process.env.MS_REDIRECT_URI ? 'OK' : 'MISSING',
});

import microsoftRoutes from './routes/microsoftRoutes.js';
import { createOutlookEvent } from './services/outlookService.js';
import Token from './models/token.models.js';
import Booking from './models/booking.models.js';

const app = express();

// ---------------------------------------------------------
// CORS / middleware
// ---------------------------------------------------------
const corsOptions = {
  origin: ['http://localhost:3000', 'https://app.kableacademy.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(bodyParser.json());
app.use(cors(corsOptions));

// Mount Microsoft OAuth routes (they read process.env.*)
app.use(microsoftRoutes);

// ---------------------------------------------------------
// Environment Variables (HubSpot + Microsoft) in one place
// ---------------------------------------------------------
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:5000/auth/callback';
const TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const HUBSPOT_API_URL = 'https://api.hubapi.com/crm/v3/objects/contacts';
const RECAPTCHA_SECRET_KEY = process.env.SECRET_KEY;

// Microsoft (explicit constants available to this file if needed)
const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const MS_TENANT_ID = process.env.MS_TENANT_ID;
const MS_REDIRECT_URI = process.env.MS_REDIRECT_URI;

// (Optional) Log again right where they’re declared for clarity
console.log('[Microsoft ENV bound in server.js]', {
  MS_CLIENT_ID: MS_CLIENT_ID ? 'OK' : 'MISSING',
  MS_CLIENT_SECRET: MS_CLIENT_SECRET ? 'OK' : 'MISSING',
  MS_TENANT_ID: MS_TENANT_ID ? 'OK' : 'MISSING',
  MS_REDIRECT_URI: MS_REDIRECT_URI ? 'OK' : 'MISSING',
});

// ---------------------------------------------------------
// MongoDB
// ---------------------------------------------------------
mongoose.connect(process.env.ATLAS_URI, { useUnifiedTopology: true, useNewUrlParser: true });
mongoose.connection.once('open', () => console.log('MongoDB connected successfully'));

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
async function getValidAccessToken() {
  const token = await Token.findOne();
  if (!token) throw new Error('No tokens found in the database');

  if (Date.now() > token.expiresAt) {
    try {
      const response = await axios.post(
        TOKEN_URL,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: token.refreshToken,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      token.accessToken = response.data.access_token;
      token.refreshToken = response.data.refresh_token || token.refreshToken;
      token.expiresAt = Date.now() + response.data.expires_in * 1000;
      await token.save();

      return token.accessToken;
    } catch (error) {
      console.error('Error refreshing access token:', error.response?.data || error.message);
      throw new Error('Failed to refresh access token');
    }
  }

  return token.accessToken;
}

async function verifyRecaptcha(token) {
  try {
    const response = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      new URLSearchParams({ secret: RECAPTCHA_SECRET_KEY, response: token })
    );
    return !!response.data.success;
  } catch (error) {
    console.error('Error verifying reCAPTCHA:', error.response?.data || error.message);
    return false;
  }
}

async function getContactIdByEmail(email, accessToken) {
  try {
    const response = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
      {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email'],
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );

    return response.data.results.length ? response.data.results[0].id : null;
  } catch (error) {
    console.error('Error fetching contact ID:', error.response?.data || error.message);
    throw error;
  }
}

// ---------------------------------------------------------
// Availability
// ---------------------------------------------------------
app.post('/api/check-availability', async (req, res) => {
  const { classDate, time } = req.body;
  try {
    const existingBooking = await Booking.findOne({ date: classDate, timeSlot: time });
    if (existingBooking) {
      return res.json({
        available: false,
        date: classDate,
        time,
        message: `❌ Date **${classDate}** and Time **${time}** are already booked.`,
      });
    }
    res.json({ available: true });
  } catch (error) {
    console.error('❌ Error checking availability:', error);
    res.status(500).json({ available: false, error: 'Server error' });
  }
});

// ---------------------------------------------------------
// Booked Dates
// ---------------------------------------------------------
app.get('/api/booked-dates', async (_req, res) => {
  try {
    const bookings = await Booking.aggregate([
      { $group: { _id: '$date', timeSlots: { $addToSet: '$timeSlot' } } },
    ]);

    const byDate = {};
    bookings.forEach((b) => {
      const date = moment(b._id).format('MM/DD/YYYY');
      byDate[date] = b.timeSlots;
    });

    console.log('📌 Sending booked dates map:', byDate);
    res.status(200).json(byDate);
  } catch (error) {
    console.error('❌ Error fetching booked dates:', error);
    res.status(500).json({ message: 'Error fetching booked dates' });
  }
});

// ---------------------------------------------------------
// Outlook event helper (non-blocking)
// ---------------------------------------------------------
async function maybeCreateOutlookEvent({ company, studentName, studentEmail, dateISO, timeLabel }) {
  console.log('🟢 [maybeCreateOutlookEvent] Invoked');
  console.log('   ├── Company:       ', company || '(none)');
  console.log('   ├── Student Name:  ', studentName || '(none)');
  console.log('   ├── Student Email: ', studentEmail || '(none)');
  console.log('   ├── Date (ISO):    ', dateISO || '(missing)');
  console.log('   └── Time Label:    ', timeLabel || '(missing)');

  if (!dateISO || !timeLabel) {
    console.log('⚠️  [maybeCreateOutlookEvent] Missing required fields — skipping creation.');
    return;
  }

  try {
    console.log('⏳ [maybeCreateOutlookEvent] Attempting to create Outlook event...');
    const evt = await createOutlookEvent({ company, studentName, studentEmail, dateISO, timeLabel });

    // Log a trimmed-down view if available
    if (evt) {
      console.log('✅ [maybeCreateOutlookEvent] Outlook event successfully created:');
      console.log('   ├── ID:       ', evt.id || '(none)');
      console.log('   ├── Subject:  ', evt.subject || '(none)');
      console.log('   ├── Start:    ', evt.start?.dateTime || evt.start || '(none)');
      console.log('   ├── End:      ', evt.end?.dateTime || evt.end || '(none)');
      console.log('   └── Location: ', evt.location?.displayName || '(none)');
    } else {
      console.log('⚠️  [maybeCreateOutlookEvent] No event object returned from createOutlookEvent()');
    }

    return evt;
  } catch (e) {
    console.error('❌ [maybeCreateOutlookEvent] Failed to create Outlook event.');
    if (e.response?.data) {
      console.error('   ↳ Graph API error payload:', JSON.stringify(e.response.data, null, 2));
    } else {
      console.error('   ↳ Message:', e.message || e);
    }
  }
}


// ---------------------------------------------------------
// Form Submission
// ---------------------------------------------------------
app.post('/api/intro-to-ai-payment', async (req, res) => {
  const {
    firstName, lastName, email, yourCompany, phoneNumber,
    time, time2, time3,
    classDate, classDate2, classDate3,
    recaptchaToken,
  } = req.body;

  console.log('📥 Received Request Body:', {
    firstName, lastName, email, yourCompany,
    time, time2, time3, classDate, classDate2, classDate3,
  });

  try {
    const recaptchaValid = await verifyRecaptcha(recaptchaToken);
    if (!recaptchaValid) return res.status(400).send({ message: 'Invalid reCAPTCHA token' });
    console.log('✅ reCAPTCHA validation passed.');

    const hub1 = classDate  ? moment(classDate,  'YYYY-MM-DD').valueOf() : null;
    const hub2 = classDate2 ? moment(classDate2, 'YYYY-MM-DD').valueOf() : null;
    const hub3 = classDate3 ? moment(classDate3, 'YYYY-MM-DD').valueOf() : null;

    const mongo1 = classDate  ? moment(classDate).format('MM/DD/YYYY')  : null;
    const mongo2 = classDate2 ? moment(classDate2).format('MM/DD/YYYY') : null;
    const mongo3 = classDate3 ? moment(classDate3).format('MM/DD/YYYY') : null;

    const contactData = {
      firstname: firstName,
      lastname: lastName,
      email,
      your_company_name: yourCompany,
      phone: phoneNumber,
      program_session: time,
      program_time_2: time2,
      program_time_3: time3,
      intro_to_ai_program_date: hub1,
      intro_to_ai_date_2: hub2,
      intro_to_ai_date_3: hub3,
    };

    // HubSpot upsert
    const accessToken = await getValidAccessToken();
    const contactId = await getContactIdByEmail(email, accessToken);

    let hubspotResponse;
    if (contactId) {
      hubspotResponse = await axios.patch(
        `${HUBSPOT_API_URL}/${contactId}`,
        { properties: contactData },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
    } else {
      hubspotResponse = await axios.post(
        HUBSPOT_API_URL,
        { properties: contactData },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
    }
    console.log('✅ HubSpot upsert OK:', hubspotResponse?.status);

    // Save bookings
    if (mongo1 && time)  await Booking.create({ email, date: mongo1, timeSlot: time });
    if (mongo2 && time2) await Booking.create({ email, date: mongo2, timeSlot: time2 });
    if (mongo3 && time3) await Booking.create({ email, date: mongo3, timeSlot: time3 });
    console.log('✅ Saved bookings to MongoDB');

    // Create Outlook events
    const studentName = `${firstName ?? ''} ${lastName ?? ''}`.trim();
    await Promise.all([
      maybeCreateOutlookEvent({ company: yourCompany, studentName, studentEmail: email, dateISO: classDate,  timeLabel: time }),
      maybeCreateOutlookEvent({ company: yourCompany, studentName, studentEmail: email, dateISO: classDate2, timeLabel: time2 }),
      maybeCreateOutlookEvent({ company: yourCompany, studentName, studentEmail: email, dateISO: classDate3, timeLabel: time3 }),
    ]);

    res.status(200).send({ message: '✅ Contact processed in HubSpot & MongoDB!' });
  } catch (error) {
    console.error('❌ Error processing form submission:', error.response?.data || error.message);
    res.status(500).send({ message: 'Error processing contact data', error: error.response?.data || error.message });
  }
});

// ---------------------------------------------------------
// TEST route: create Outlook event without frontend
// ---------------------------------------------------------
// POST http://localhost:5000/api/test-outlook
// body: { "dateISO": "2025-12-01", "timeLabel": "2pm-5pm EST/1pm-4pm CST", "company": "ACME", "email": "" }
app.post('/api/test-outlook', async (req, res) => {
  try {
    const { dateISO, timeLabel, company, email } = req.body || {};
    console.log('[/api/test-outlook] Incoming:', { dateISO, timeLabel, company, email });

    if (!dateISO || !timeLabel) {
      return res.status(400).json({ ok: false, error: 'dateISO and timeLabel are required' });
    }

    const studentName = ''; // optional
    const data = await createOutlookEvent({
      company: company || 'Test Company',
      studentName,
      studentEmail: email || '',   // leave empty to avoid invites
      dateISO,                     // "YYYY-MM-DD"
      timeLabel,                   // one of the three labels
    });

    console.log('[/api/test-outlook] ✅ Created:', {
      id: data.id, subject: data.subject, start: data.start, end: data.end
    });
    return res.json({ ok: true, event: data });
  } catch (e) {
    console.error('[/api/test-outlook] ❌ Failed:', e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// ---------------------------------------------------------
// Start
// ---------------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
