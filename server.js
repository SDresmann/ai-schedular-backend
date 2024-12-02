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
  origin: 'https://app.kableacademy.com/',
  credentials: true,
  optionSuccessStatus: 200,
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
const SECRET_KEY = process.env.SECRET_KEY;

// MongoDB Connection
mongoose.connect(process.env.ATLAS_URI, { useUnifiedTopology: true, useNewUrlParser: true });
mongoose.connection.once('open', () => console.log('MongoDB connected successfully'));

// Function to Get Valid Access Token
async function getValidAccessToken() {
  const token = await Token.findOne();
  if (!token) throw new Error('No tokens found in the database');

  if (Date.now() > token.expiresAt) {
    console.log('Access token expired, refreshing...');

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

      console.log('Access token refreshed successfully:', token.accessToken);
      return token.accessToken;
    } catch (error) {
      console.error('Error refreshing access token:', error.response?.data || error.message);
      throw new Error('Failed to refresh access token');
    }
  }

  console.log('Access token is still valid:', token.accessToken);
  return token.accessToken;
}

// Route: Initiate Authorization Flow
app.get('/auth', (req, res) => {
  const SCOPES = 'contacts';
  const authorizationUri = `${AUTHORIZATION_URL}?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
    REDIRECT_URI
  )}&scope=${SCOPES}&response_type=code`;
  res.redirect(authorizationUri);
});

// Route: Handle Authorization Callback
app.get('/auth/callback', async (req, res) => {
  const authorizationCode = req.query.code;

  if (!authorizationCode) {
    return res.status(400).send('Authorization code missing.');
  }

  try {
    const response = await axios.post(
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

    const { access_token, refresh_token, expires_in } = response.data;

    // Save tokens to the database
    await Token.findOneAndUpdate(
      {},
      {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + expires_in * 1000,
      },
      { upsert: true }
    );

    res.send('Authorization successful! Tokens have been saved.');
  } catch (error) {
    console.error('Error exchanging authorization code:', error.response?.data || error.message);
    res.status(500).send('Failed to exchange authorization code for tokens.');
  }
});

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
  const { recaptchaToken, firstName, lastName, email, phoneNumber, program, time, classDate, postal } = req.body;
  res.setTimeout(0);

  try {
    const contactData = {
      firstname: firstName,
      lastname: lastName,
      email,
      phone: phoneNumber,
      program,
      program_session: time,
      intro_to_ai_program_date: moment(classDate, 'MM/DD/YYYY').utc().startOf('day').valueOf(),
      zip: postal,
    };

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
    res.status(500).send({
      message: 'Error processing contact data',
      error: error.response?.data || error.message,
    });
  }
});

// Route: Update Contact with Additional Properties
app.patch('/api/update-contact', async (req, res) => {
  const { email, updatedProperties } = req.body;

  try {
    const accessToken = await getValidAccessToken();
    const contactId = await getContactIdByEmail(email, accessToken);

    if (!contactId) {
      return res.status(404).send({ message: 'Contact not found' });
    }

    const updateResponse = await axios.patch(
      `${HUBSPOT_API_URL}/${contactId}`,
      { properties: updatedProperties },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).send({ message: 'Contact updated successfully', data: updateResponse.data });
  } catch (error) {
    res.status(500).send({ message: 'Error updating contact', error: error.response?.data || error.message });
  }
});


// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
