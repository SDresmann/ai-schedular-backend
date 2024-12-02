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
  const { firstName, lastName, email, phoneNumber, program, time, classDate, postal } = req.body;

  try {
    console.log('Received form data:', req.body);

    // Format Date for HubSpot
    const formattedClassDate = moment(classDate, 'MM/DD/YYYY').utc().startOf('day').valueOf();
    const hubSpotData = {
      firstname: firstName,
      lastname: lastName,
      phone: phoneNumber,
      program,
      program_session: time,
      intro_to_ai_program_date: formattedClassDate,
      zip: postal,
    };

    console.log('Formatted data for HubSpot:', hubSpotData);

    // Get a valid access token
    const accessToken = await getValidAccessToken();

    // Search for the contact in HubSpot
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
    if (existingContact) {
      console.log(`Contact found, updating contact with ID: ${existingContact.id}`);

      // Update the contact
      const updateResponse = await axios.patch(
        `${HUBSPOT_API_URL}/${existingContact.id}`,
        { properties: hubSpotData },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log('Contact updated successfully:', updateResponse.data);
      return res.status(200).send({
        message: 'Contact updated successfully',
        data: updateResponse.data,
      });
    }

    // If no contact is found, respond with an error
    console.log('Contact not found');
    res.status(404).send({
      message: 'Contact not found. Cannot update.',
    });
  } catch (error) {
    console.error('Error during HubSpot operation:', error.response?.data || error.message);
    res.status(500).send({
      message: 'Error during HubSpot operation',
      error: error.response?.data || error.message,
    });
  }
});


// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
