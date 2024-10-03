const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const mongoose = require('mongoose');
const moment = require('moment');
require('dotenv').config();

// Import the Token model
const Token = require('./models/token.models');

const app = express();

// Load environment variables
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:5000/auth/callback';
const AUTHORIZATION_URL = 'https://app.hubspot.com/oauth/authorize';
const TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const SCOPES = 'automation content crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write oauth'

app.use(cors());
app.use(bodyParser.json());

// Connect to MongoDB
const uri = process.env.ATLAS_URI;
mongoose.connect(uri, { useUnifiedTopology: true, useNewUrlParser: true });
const connection = mongoose.connection;

connection.once('open', () => {
  console.log("MongoDB is connected");
});

// Step 1: Redirect to HubSpot's OAuth 2.0 server
app.get('/auth', (req, res) => {
  const authorizationUri = `${AUTHORIZATION_URL}?${querystring.stringify({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_type: 'code',
  })}`;
  res.redirect(authorizationUri);
});

// Step 2: Handle the OAuth 2.0 server response and store tokens
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    console.log('No authorization code provided');
    return res.status(400).send('No authorization code provided');
  }

  try {
    const response = await axios.post(TOKEN_URL, querystring.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const accessToken = response.data.access_token;
    const refreshToken = response.data.refresh_token;
    const expiresAt = Date.now() + response.data.expires_in * 1000;

    console.log('Access token:', accessToken);
    console.log('Refresh token:', refreshToken);

    // Attempt to save the token to MongoDB
    try {
      const newToken = new Token({ accessToken, refreshToken, expiresAt });
      await newToken.save(); // Important: use await
      console.log('Tokens saved to MongoDB successfully');
      res.send('Authentication successful. You can close this window.');
    } catch (saveError) {
      console.error('Error saving tokens to MongoDB:', saveError);
      res.status(500).send('Error saving tokens to MongoDB');
    }
  } catch (error) {
    console.error('Error during OAuth token exchange:', error.response ? error.response.data : error.message);
    res.status(500).send('Authentication failed');
  }
});

// Step 3: Middleware to refresh tokens if expired
async function getValidAccessToken() {
  let token = await Token.findOne(); // Get the stored token
  if (!token) {
    throw new Error('No tokens found in the database');
  }

  // Check if token is expired
  if (Date.now() > token.expiresAt) {
    console.log('Access token expired, refreshing...');

    // Refresh the token
    try {
      const response = await axios.post(TOKEN_URL, querystring.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: token.refreshToken,
      }), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      // Update tokens in MongoDB
      token.accessToken = response.data.access_token;
      token.refreshToken = response.data.refresh_token || token.refreshToken; // Use old refresh token if not returned
      token.expiresAt = Date.now() + response.data.expires_in * 1000;

      await token.save();
      return token.accessToken;
    } catch (error) {
      console.error('Error refreshing access token:', error.response ? error.response.data : error.message);
      throw new Error('Failed to refresh access token');
    }
  }

  return token.accessToken; // Return valid access token
}

// POST route to handle form submission and create or update a HubSpot contact
app.post('/api/intro-to-ai-payment', async (req, res) => {
    const { firstName, lastName, email, phoneNumber, program, time, classDate, postal } = req.body;
  
    if (!firstName || !lastName || !email || !phoneNumber || !program || !time || !classDate || !postal) {
      return res.status(400).send({ message: 'Please fill out all the fields.' });
    }
  
    try {
      // Fetch a valid access token
      const accessToken = await getValidAccessToken();
      console.log('Using access token:', accessToken);
  
      // Convert classDate (formatted as MM/DD/YYYY) to timestamp at midnight UTC
      const formattedClassDate = moment(classDate, 'MM/DD/YYYY').utc().startOf('day').valueOf();
  
      // HubSpot API URL for searching a contact by email
      const searchUrl = `https://api.hubapi.com/crm/v3/objects/contacts/search`;
      const searchData = {
        filterGroups: [
          {
            filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
          },
        ],
      };
  
      // Search for the contact by email
      const searchResponse = await axios.post(searchUrl, searchData, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });
  
      const contactExists = searchResponse.data.total > 0;
      
      if (contactExists) {
        // If contact exists, update the existing contact
        const existingContactId = searchResponse.data.results[0].id;
        const updateUrl = `https://api.hubapi.com/crm/v3/objects/contacts/${existingContactId}`;
        const contactUpdateData = {
          properties: {
            firstname: firstName,
            lastname: lastName,
            phone: phoneNumber,
            zip: postal,
            choose_a_program: program,
            intro_to_ai_program_date: formattedClassDate, // Date in timestamp (milliseconds) format at midnight UTC
            program_session: time,
          },
        };
  
        // Update the contact
        const updateResponse = await axios.patch(updateUrl, contactUpdateData, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        });
  
        res.status(200).send({ message: 'Contact updated successfully!', data: updateResponse.data });
      } else {
        // If contact doesn't exist, create a new contact
        const createUrl = 'https://api.hubapi.com/crm/v3/objects/contacts';
        const contactData = {
          properties: {
            firstname: firstName,
            lastname: lastName,
            email: email,
            phone: phoneNumber,
            zip: postal,
            choose_a_program: program,
            intro_to_ai_program_date: formattedClassDate, // Date in timestamp (milliseconds) format at midnight UTC
            program_session: time,
          },
        };
  
        const createResponse = await axios.post(createUrl, contactData, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        });
  
        res.status(200).send({ message: 'Contact created successfully!', data: createResponse.data });
      }
    } catch (error) {
      console.error('Error creating or updating contact:', error.response ? error.response.data : error.message);
      res.status(500).send({ message: 'Error creating or updating contact in HubSpot.' });
    }
  });
  
// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
