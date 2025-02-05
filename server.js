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
  origin: ['http://localhost:3000', 'https://app.kableacademy.com'], // Add both local and production origins
  credentials: true, // If you need to send cookies or authentication headers
  methods: ['GET', 'POST', 'PATCH', 'DELETE'], // Allowed HTTP methods
  allowedHeaders: ['Content-Type', 'Authorization'], // Headers to allow
};

app.use(cors(corsOptions));
app.use(bodyParser.json());

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
app.post('/api/intro-to-ai-payment', async (req, res) => {
  const { firstName, lastName, email, phoneNumber, time, time2, time3, classDate, classDate2, classDate3, postal, recaptchaToken } = req.body;
  console.log('Received Request Body:', req.body);

  try {
    // Verify reCAPTCHA token
    const recaptchaValid = await verifyRecaptcha(recaptchaToken);
    if (!recaptchaValid) {
      console.error('Invalid reCAPTCHA token');
      return res.status(400).send({ message: 'Invalid reCAPTCHA token' });
    }
    console.log('reCAPTCHA validation passed.');

    // Prepare contact data
    const contactData = {
      firstname: firstName,
      lastname: lastName,
      email,
      phone: phoneNumber,
      program_session: time,
      program_session_2: time2,
      program_session_3: time3,
      intro_to_ai_program_date: convertDate(classDate),
      intro_to_ai_program_date_2: convertDate(classDate2),
      intro_to_ai_program_date_3: convertDate(classDate3),
      zip: postal,
    };

    // Obtain access token and handle contact creation/updating
    const accessToken = await getValidAccessToken();
    const contactId = await getContactIdByEmail(email, accessToken);

    let hubspotResponse;
    if (contactId) {
      hubspotResponse = await axios.patch(
        `${HUBSPOT_API_URL}/${contactId}`,
        { properties: contactData },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } else {
      hubspotResponse = await axios.post(
        HUBSPOT_API_URL,
        { properties: contactData },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    res.status(200).send({ message: 'Contact successfully processed', data: hubspotResponse.data });
  } catch (error) {
    console.error('Error processing form submission:', error.response?.data || error.message);
    res.status(500).send({
      message: 'Error processing contact data',
      error: error.response?.data || error.message,
    });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
