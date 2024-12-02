const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const moment = require('moment');
const cors = require('cors')
require('dotenv').config();

const Token = require('./models/token.models');

const app = express();

const corsOptions ={
    origin:'https://app.kableacademy.com/', 
    credentials:true,            //access-control-allow-credentials:true
    optionSuccessStatus:200
}
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


// Get Valid Access Token
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

// Verify reCAPTCHA
async function verifyCaptcha(token) {
  try {
    const response = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      {},
      {
        params: {
          secret: SECRET_KEY,
          response: token,
        },
      }
    );

    console.log('reCAPTCHA response:', response.data);
    return response.data.success && response.data.score >= 0.5;
  } catch (error) {
    console.error('Error validating reCAPTCHA:', error.response?.data || error.message);
    return false;
  }
}
app.get('/auth', (req, res) => {
  const authorizationUri = `${AUTHORIZATION_URL}?${querystring.stringify({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_type: 'code',
  })}`;
  res.redirect(authorizationUri);
});

// Handle Form Submission
app.post('/api/intro-to-ai-payment', async (req, res) => {
  const { recaptchaToken, firstName, lastName, email, phoneNumber, program, time, classDate, postal } = req.body;

  console.log('Received form data:', req.body);

  // Validate reCAPTCHA
  if (!recaptchaToken) {
    console.error('Missing reCAPTCHA token');
    return res.status(400).send({ message: 'Missing reCAPTCHA token' });
  }

  try {
    const captchaValid = await verifyCaptcha(recaptchaToken);
    if (!captchaValid) {
      console.error('Invalid reCAPTCHA token');
      return res.status(400).send({ message: 'Invalid reCAPTCHA token' });
    }

    console.log('reCAPTCHA validation successful');

    const formattedClassDate = moment(classDate, 'MM/DD/YYYY').utc().startOf('day').valueOf();
    const hubSpotData = {
      firstname: firstName,
      lastname: lastName,
      email,
      phone: phoneNumber,
      program,
      program_session: time,
      intro_to_ai_program_date: formattedClassDate,
      zip: postal,
    };

    console.log('Formatted data for HubSpot:', hubSpotData);

    const accessToken = await getValidAccessToken();
    console.log('Using access token for HubSpot:', accessToken);

    // Check if the contact exists in HubSpot
    const searchResponse = await axios.post(
      `${HUBSPOT_API_URL}/search`,
      {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      }
    );

    const existingContact = searchResponse.data.results[0];
    if (existingContact) {
      console.log('Contact exists, updating:', existingContact);
      const updateResponse = await axios.patch(
        `${HUBSPOT_API_URL}/${existingContact.id}`,
        { properties: hubSpotData },
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        }
      );
      console.log('Contact updated successfully:', updateResponse.data);
      return res.status(200).send({ message: 'Contact updated successfully', data: updateResponse.data });
    }

    // Create new contact
    console.log('Contact not found, creating new contact...');
    const createResponse = await axios.post(
      HUBSPOT_API_URL,
      { properties: hubSpotData },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      }
    );

    console.log('Contact created successfully:', createResponse.data);
    res.status(200).send({ message: 'Contact created successfully', data: createResponse.data });
  } catch (error) {
    console.error('Error during HubSpot integration:', error.response?.data || error.message);
    res.status(500).send({ message: 'Server error during HubSpot operation', error: error.response?.data || error.message });
  }
});


// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
