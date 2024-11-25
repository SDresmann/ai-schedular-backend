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
const SCOPES = 'automation content crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write oauth';
const SECRET_KEY = process.env.SECRET_KEY; // Ensure this is correctly set in your .env file

app.use(cors());
app.use(bodyParser.json());

// Connect to MongoDB
const uri = process.env.ATLAS_URI;
mongoose.connect(uri, { useUnifiedTopology: true, useNewUrlParser: true });
const connection = mongoose.connection;

connection.once('open', () => {
  console.log("MongoDB is connected");
});

// Reusable reCAPTCHA verification function
async function verifyCaptcha(token) {
  console.log('Verifying reCAPTCHA token:', token); // Debug incoming token
  try {
    const response = await axios.post(
      `https://www.google.com/recaptcha/api/siteverify`,
      {},
      {
        params: {
          secret: SECRET_KEY, // Use the secret key from environment variables
          response: token,
        },
      }
    );
    console.log('reCAPTCHA verification response:', response.data); // Log Google's response
    return response.data.success;
  } catch (error) {
    console.error('Error verifying reCAPTCHA:', error.message);
    return false;
  }
}

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
      await newToken.save();
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

// Middleware to refresh tokens if expired
async function getValidAccessToken() {
  let token = await Token.findOne();
  if (!token) {
    throw new Error('No tokens found in the database');
  }

  if (Date.now() > token.expiresAt) {
    console.log('Access token expired, refreshing...');

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

      token.accessToken = response.data.access_token;
      token.refreshToken = response.data.refresh_token || token.refreshToken;
      token.expiresAt = Date.now() + response.data.expires_in * 1000;

      await token.save();
      return token.accessToken;
    } catch (error) {
      console.error('Error refreshing access token:', error.response ? error.response.data : error.message);
      throw new Error('Failed to refresh access token');
    }
  }

  return token.accessToken;
}

// POST route to handle form submission and create or update a HubSpot contact
app.post('/api/intro-to-ai-payment', async (req, res) => {
  const { firstName, lastName, email, phoneNumber, program, time, classDate, postal, recaptchaToken } = req.body;

  // Verify reCAPTCHA token
  const captchaValid = await verifyCaptcha(recaptchaToken);
  if (!captchaValid) {
    return res.status(400).send({ message: 'Invalid reCAPTCHA token.' });
  }

  // Ensure all form fields are filled
  if (!firstName || !lastName || !email || !phoneNumber || !program || !time || !classDate || !postal) {
    return res.status(400).send({ message: 'Please fill out all the fields.' });
  }

  try {
    const accessToken = await getValidAccessToken();
    console.log('Using access token:', accessToken);

    const formattedClassDate = moment(classDate, 'MM/DD/YYYY').utc().startOf('day').valueOf();

    // HubSpot logic omitted for brevity
    res.status(200).send({ message: 'Form processed successfully!' });
  } catch (error) {
    console.error('Error processing form:', error.message);
    res.status(500).send({ message: 'Error processing form submission.' });
  }
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
