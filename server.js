const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const moment = require('moment');
const cors = require('cors');

require('dotenv').config();

const Token = require('./models/token.models');

const app = express();
app.use(express.json())
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

    console.log('HubSpot Search Response:', response.data); // Log full response

    if (response.data.results.length === 0) {
      console.error('No contact found for email:', email);
      return null;
    }

    return response.data.results[0].id; // Ensure this returns a valid ID
  } catch (error) {
    console.error('Error fetching contact ID:', error.response?.data || error.message);
    throw error;
  }
}


async function getUpdatedContact(contactId, accessToken) {
  console.log("🔍 Payload sent to HubSpot:", JSON.stringify({ properties: contactData }, null, 2));

  try {
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          properties: ['program_session', 'program_time_2', 'program_time_3', 'intro_to_ai_program_date'],
        },
      }
    );
    console.log('🚀 Retrieved Contact Data:', response.data.properties);
  } catch (error) {
    console.error('❌ Error Retrieving Updated Contact:', error.response?.data || error.message);
  }
}

app.get('/auth', (req, res) => {
  const authUrl = `${AUTHORIZATION_URL}?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=crm.objects.contacts.read%20crm.objects.contacts.write&response_type=code`;
  console.log('Redirecting to HubSpot Authorization URL:', authUrl);
  res.redirect(authUrl);
});
// Route: Handle OAuth Callback
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
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Save tokens to the database
    const token = await Token.findOneAndUpdate(
      {},
      {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + expires_in * 1000,
      },
      { upsert: true, new: true }
    );

    console.log('Tokens saved to database:', token);
    res.status(200).send({ message: 'Authorization successful!' });
  } catch (error) {
    console.error('Error exchanging authorization code:', error.response?.data || error.message);
    res.status(500).send({ message: 'Error exchanging authorization code' });
  }
});

// Route: Handle Form Submission
app.post('/api/intro-to-ai-payment', async (req, res) => {
  console.log('🚀 Incoming request body:', req.body);

  try {
    // Assuming verifyRecaptcha and getValidAccessToken are defined elsewhere
    const recaptchaValid = await verifyRecaptcha(req.body.recaptchaToken);
    if (!recaptchaValid) return res.status(400).send({ message: 'Invalid reCAPTCHA token' });

    const accessToken = await getValidAccessToken(); 

    // 1. Extract values from req.body 
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
      postal 
    } = req.body;

    // Get contactId - Make sure this function is working correctly
    const contactId = await getContactIdByEmail(email, accessToken);

    // 2. Create the contactProperties object 
    const contactProperties = {
      firstname: firstName || null,
      lastname: lastName || null,
      email: email || null,
      phone: phoneNumber || null,
      program_session: time || null,
      program_time_2: time2 || null,
      program_time_3: time3 || null,
      intro_to_ai_program_date: moment(classDate, 'MM/DD/YYYY').utc().startOf('day').valueOf() || null,
      intro_to_ai_date_2: moment(classDate2, 'MM/DD/YYYY').utc().startOf('day').valueOf() || null,
      intro_to_ai_date_3: moment(classDate3, 'MM/DD/YYYY').utc().startOf('day').valueOf() || null,
      zip: postal || null
    };

    // 3. Log the contactProperties 
    console.log("📩 Contact Properties to Send:", contactProperties);

    let hubspotResponse;

    if (contactId !== null) { 
      // Contact exists, update it
      console.log("🔄 Updating existing contact in HubSpot...");

      hubspotResponse = await axios.patch(
        `${HUBSPOT_API_URL}/${contactId}`,
        { properties: contactProperties },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log("✅ HubSpot Contact Updated Successfully:", hubspotResponse.data);
    } else {
      // Contact doesn't exist, create a new one
      console.log("🆕 Creating a new contact in HubSpot...");

      hubspotResponse = await axios.post(
        HUBSPOT_API_URL, 
        { properties: contactProperties },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("✅ New Contact Created in HubSpot:", hubspotResponse.data);
    }

    return res.status(200).json({
      message: contactId ? "Contact updated successfully in HubSpot!" : "New contact created successfully!",
      hubspotResponse: hubspotResponse.data, 
    });

  } catch (error) {
    console.error("❌ Error processing contact:", error.response?.data || error.message);
    return res.status(500).json({
      message: "Error processing contact data",
      error: error.response?.data || error.message, 
    });
  }
});




// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));