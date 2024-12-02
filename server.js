const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const moment = require('moment');
require('dotenv').config();

const Token = require('./models/token.models');

const app = express();
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

// Get a Valid Access Token
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

app.post('/api/intro-to-ai-payment', async (req, res) => {
  const { recaptchaToken, firstName, lastName, email, phoneNumber, program, time, classDate, postal } = req.body;

  console.log('Received form data:', req.body); // Log received data

  try {
    const captchaValid = await verifyCaptcha(recaptchaToken);
    console.log('reCAPTCHA validation:', captchaValid);

    if (!captchaValid) {
      return res.status(400).send({ message: 'Invalid reCAPTCHA token' });
    }

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
    console.log('Prepared HubSpot data:', hubSpotData);

    const accessToken = await getValidAccessToken();
    console.log('Access token retrieved:', accessToken);

    const searchResponse = await axios.post(
      `${HUBSPOT_API_URL}/search`,
      {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      }
    );

    console.log('Search response from HubSpot:', searchResponse.data);

    const existingContact = searchResponse.data.results[0];
    if (existingContact) {
      console.log('Updating existing contact:', existingContact);

      const updateResponse = await axios.patch(
        `${HUBSPOT_API_URL}/${existingContact.id}`,
        { properties: hubSpotData },
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        }
      );

      console.log('Update response from HubSpot:', updateResponse.data);
      return res.status(200).send({ message: 'Contact updated successfully', data: updateResponse.data });
    }

    console.log('Creating a new contact...');
    const createResponse = await axios.post(
      HUBSPOT_API_URL,
      { properties: hubSpotData },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      }
    );

    console.log('Create response from HubSpot:', createResponse.data);
    res.status(200).send({ message: 'Contact created successfully', data: createResponse.data });
  } catch (error) {
    console.error('Error during HubSpot operation:', error.response?.data || error.message);
    res.status(500).send({ message: 'Server error', error: error.response?.data || error.message });
  }
});

app.patch('/api/update-contact', async (req, res) => {
  const { email, updatedFields } = req.body;

  if (!email || !updatedFields) {
    return res.status(400).send({
      message: 'Email and updatedFields are required',
    });
  }

  try {
    console.log(`Updating contact for email: ${email}`);

    // Get a valid access token
    const accessToken = await getValidAccessToken();

    // Search for the contact
    console.log('Searching for contact...');
    const searchResponse = await axios.post(
      `${HUBSPOT_API_URL}/search`,
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
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const existingContact = searchResponse.data.results[0];
    if (!existingContact) {
      return res.status(404).send({
        message: 'Contact not found. Cannot update.',
      });
    }

    console.log(`Contact found, updating contact with ID: ${existingContact.id}`);

    // Update the contact
    const updateResponse = await axios.patch(
      `${HUBSPOT_API_URL}/${existingContact.id}`,
      { properties: updatedFields },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Contact updated successfully:', updateResponse.data);
    res.status(200).send({
      message: 'Contact updated successfully',
      data: updateResponse.data,
    });
  } catch (error) {
    console.error('Error during HubSpot operation:', error.response?.data || error.message);
    res.status(500).send({
      message: 'Error during HubSpot operation',
      error: error.response?.data || error.message,
    });
  }
});

// Other Routes and Middleware (e.g., Authentication, Token Refresh)
// Include getValidAccessToken function and other utility functions here

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));