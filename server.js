const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const moment = require('moment');
const cors = require('cors');

require('dotenv').config();

const Token = require('./models/token.models');

const app = express();

const corsOptions = {
  origin: ["http://localhost:3000", "https://app.kableacademy.com"], // Frontend domains
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(express.json()); // ✅ Ensure JSON body parsing
app.use(express.urlencoded({ extended: true })); // ✅ Ensure URL-encoded parsing
app.use(bodyParser.json());
app.use(cors());

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
  try {
    console.log("🔍 Checking MongoDB for stored token...");

    const token = await Token.findOne();
    if (!token) {
      console.error('❌ No tokens found in the database');
      throw new Error('No tokens found in the database');
    }

    console.log('📅 Stored Token Expiry Time:', new Date(token.expiresAt));
    console.log('⏰ Current Time:', new Date());
    console.log('⌛ Checking if token is expired:', Date.now() > token.expiresAt);

    // If the token is still valid, return it
    if (Date.now() < token.expiresAt) {
      console.log('✅ Access token is still valid:', token.accessToken);
      return token.accessToken;
    }

    // If the token is expired, refresh it
    console.log('🔄 Access token expired, refreshing...');

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

    if (!response.data.access_token) {
      console.error('❌ HubSpot did not return a new access token!');
      throw new Error('HubSpot refresh failed: No new access token');
    }

    // Update token in database
    token.accessToken = response.data.access_token;
    token.refreshToken = response.data.refresh_token || token.refreshToken; // Keep old refresh token if none is provided
    token.expiresAt = Date.now() + response.data.expires_in * 1000; // Convert seconds to milliseconds

    await token.save();
    console.log('💾 New Access Token Saved to Database');
    console.log('✅ New Access Token:', token.accessToken);

    return token.accessToken;
  } catch (error) {
    console.error('❌ Error refreshing access token:', error.response?.data || error.message);
    throw new Error('Failed to refresh access token');
  }
}
async function verifyRecaptcha(recaptchaToken) {
  const secretKey = process.env.SECRET_KEY; // Your reCAPTCHA secret key

  console.log("🔍 Verifying reCAPTCHA Token:", recaptchaToken);

  try {
    const response = await axios.post(
      "https://www.google.com/recaptcha/api/siteverify",
      new URLSearchParams({
        secret: secretKey,
        response: recaptchaToken,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    console.log("✅ reCAPTCHA API Response:", response.data);
    
    return response.data.success; // Returns true if valid, false if invalid
  } catch (error) {
    console.error("❌ Error verifying reCAPTCHA:", error.response?.data || error.message);
    return false;
  }
}

getValidAccessToken()
  .then(token => console.log("✅ Server Startup - Access Token:", token))
  .catch(error => console.error("❌ Server Startup - Token Error:", error.message));
// Helper: Verify reCAPTCHA Token
async function verifyRecaptcha(token) {
  try {
    const response = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      new URLSearchParams({
        secret: RECAPTCHA_SECRET_KEY,
        response: token,
      })
    );

    const { success } = response.data;
    console.log('reCAPTCHA response:', response.data);
    return success;
  } catch (error) {
    console.error('Error verifying reCAPTCHA:', error.response?.data || error.message);
    return false;
  }
}

// Helper: Get Contact ID by Email
async function getContactIdByEmail(email, accessToken) {
  try {
    const response = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'email',
                operator: 'EQ',
                value: email,
              },
            ],
          },
        ],
        properties: ['email'],
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.results.length === 0) {
      return null;
    }

    return response.data.results[0].id;
  } catch (error) {
    console.error('Error fetching contact ID:', error.response?.data || error.message);
    throw error;
  }
}

// Route: Handle Form Submission
app.post("/api/intro-to-ai-payment", async (req, res) => {
  console.log("🚀 Received a POST request!");

  // ✅ 1️⃣ Log Raw Request
  console.log("🔍 Raw Request Body:", req.body);

  if (!req.body || Object.keys(req.body).length === 0) {
    console.error("❌ ERROR: Request body is empty or not parsed correctly!");
    return res.status(400).json({ message: "Request body is empty or invalid" });
  }

  // ✅ 2️⃣ Log Expected Fields from Request
  const {
    firstname, lastname, email, phone,
    program_session, program_time_2, program_time_3,
    intro_to_ai_program_date, intro_to_ai_date_2, intro_to_ai_date_3,
    zip, recaptchaToken
  } = req.body;

  console.log("🔍 Parsed Fields:", {
    firstname, lastname, email, phone,
    program_session, program_time_2, program_time_3,
    intro_to_ai_program_date, intro_to_ai_date_2, intro_to_ai_date_3,
    zip, recaptchaToken
  });

  // ✅ 3️⃣ Check Required Fields
  const requiredFields = [
    "firstname", "lastname", "email", "phone",
    "program_session", "program_time_2", "program_time_3",
    "intro_to_ai_program_date", "intro_to_ai_date_2", "intro_to_ai_date_3",
    "zip", "recaptchaToken"
  ];

  const missingFields = requiredFields.filter(field => !req.body[field]);

  if (missingFields.length > 0) {
    console.error("❌ MISSING FIELDS:", missingFields);
    return res.status(400).json({ message: "Missing required fields", missingFields });
  }

  console.log("✅ All required fields received!");

  res.status(200).json({ message: "Request received!", receivedData: req.body });
});





// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
