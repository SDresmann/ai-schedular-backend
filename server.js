const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const moment = require('moment');
const cors = require('cors');

require('dotenv').config();

const Token = require('./models/token.models');

const app = express();
app.use(bodyParser.json());
const allowedOrigins = ['https://app.kableacademy.com', 'http://localhost:3000'];
const corsOptions = {
  origin: (origin, callback) => {
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};


app.use(cors(corsOptions));
axios.interceptors.request.use((config) => {
  console.log(`Making request to ${config.url}`);
  return config;
});

// Environment Variables
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:5000/auth/callback';
const AUTHORIZATION_URL = 'https://app.hubspot.com/oauth/authorize';
const TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const HUBSPOT_API_URL = 'https://api.hubapi.com/crm/v3/objects/contacts';
const RECAPTCHA_SECRET_KEY = process.env.SECRET_KEY;

// MongoDB Connection
mongoose.connect(process.env.ATLAS_URI, { useUnifiedTopology: true, useNewUrlParser: true });
mongoose.connection.once('open', () => console.log('MongoDB connected successfully'));


// Function to Get Valid Access Token
async function getValidAccessToken() {
  const token = await Token.findOne();
  if (!token) throw new Error('❌ No tokens found in the database');

  if (Date.now() > token.expiresAt) {
    console.log('🔄 Access token expired, refreshing...');
    return await refreshAccessToken();
  }

  console.log('✅ Access token is still valid:', token.accessToken);
  return token.accessToken;
}

// **Function to Refresh Access Token**
async function refreshAccessToken() {
  try {
    console.log("🔄 Refreshing HubSpot Access Token...");

    const token = await Token.findOne();
    if (!token) throw new Error("❌ No token found in database");

    const response = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: token.refreshToken,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    token.accessToken = response.data.access_token;
    token.refreshToken = response.data.refresh_token || token.refreshToken;
    token.expiresAt = Date.now() + response.data.expires_in * 1000;
    await token.save();

    console.log("✅ Token refreshed successfully:", token.accessToken);
    return token.accessToken;
  } catch (error) {
    console.error("❌ Error refreshing access token:", error.response?.data || error.message);
    throw new Error("Failed to refresh access token.");
  }
}

// **Helper: Get Contact ID by Email**
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

    console.log('🔍 HubSpot Search Response:', response.data);

    if (response.data.results.length === 0) {
      console.error('❌ No contact found for email:', email);
      return null;
    }

    return response.data.results[0].id;
  } catch (error) {
    console.error('❌ Error fetching contact ID:', error.response?.data || error.message);
    throw error;
  }
}
async function verifyRecaptcha(token) {
  try {
    const response = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      new URLSearchParams({
        secret: RECAPTCHA_SECRET_KEY,  // Ensure this is set in your .env file
        response: token,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { success } = response.data;
    console.log('🛡️ reCAPTCHA verification response:', response.data);
    return success; // Returns true if valid, false otherwise
  } catch (error) {
    console.error('❌ Error verifying reCAPTCHA:', error.response?.data || error.message);
    return false; // Fail-safe return
  }
}
// **Route: Handle OAuth Callback**
app.get('/auth/callback', async (req, res) => {
  const authorizationCode = req.query.code;

  if (!authorizationCode) {
    return res.status(400).send({ message: 'Authorization code missing' });
  }

  try {
    const tokenResponse = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code: authorizationCode,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    await Token.findOneAndUpdate(
      {},
      { accessToken: access_token, refreshToken: refresh_token, expiresAt: Date.now() + expires_in * 1000 },
      { upsert: true, new: true }
    );

    console.log('✅ Tokens saved to database');
    res.status(200).send({ message: 'Authorization successful!' });
  } catch (error) {
    console.error('❌ Error exchanging authorization code:', error.response?.data || error.message);
    res.status(500).send({ message: 'Error exchanging authorization code' });
  }
});

// Route: Handle Form Submission
app.post('/api/intro-to-ai-payment', async (req, res) => {
  console.log('🚀 Incoming request body:', req.body);

  const {
    firstName,
    lastName,
    email,
    phoneNumber,
    time,
    time2,
    time3,
    classDate,
    classDate2,
    classDate3,
    postal,
    recaptchaToken,  // Make sure this is included in the request
  } = req.body;

  try {
    // ✅ Check reCAPTCHA Token
    if (!recaptchaToken) {
      console.error('❌ Missing reCAPTCHA token in request.');
      return res.status(400).json({ error: 'MISSING_RECAPTCHA', message: 'reCAPTCHA token is required' });
    }

    const recaptchaValid = await verifyRecaptcha(recaptchaToken);
    if (!recaptchaValid) {
      console.error('❌ Invalid reCAPTCHA token');
      return res.status(400).json({ error: 'INVALID_RECAPTCHA', message: 'reCAPTCHA validation failed' });
    }

    console.log('✅ reCAPTCHA validation passed.');

    // Proceed with contact update in HubSpot...
    // Add the rest of your code here

  } catch (error) {
    console.error('❌ Error processing contact:', error);
    res.status(500).json({
      message: 'Error processing contact data',
      error: error.message || 'Internal Server Error',
    });
  }
});




// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));