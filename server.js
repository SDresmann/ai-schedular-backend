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
  origin: ["http://localhost:3000", "https://app.kableacademy.com"], // Allowed origins
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], // Allowed methods
  allowedHeaders: ["Content-Type", "Authorization"], // Allowed headers
  credentials: true, // If you need to send cookies or authentication headers
};


app.use(express.json()); // ✅ Ensure JSON body parsing
app.use(express.urlencoded({ extended: true })); // ✅ Ensure URL-encoded parsing
app.use(bodyParser.json());
app.use(cors(corsOptions));

app.options("*", cors(corsOptions)); 
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
    const token = await Token.findOne();
    if (!token) {
      throw new Error('No tokens found in the database');
    }

    if (Date.now() < token.expiresAt) {
      return token.accessToken;
    }

    const response = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        refresh_token: token.refreshToken,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    token.accessToken = response.data.access_token;
    token.refreshToken = response.data.refresh_token || token.refreshToken;
    token.expiresAt = Date.now() + response.data.expires_in * 1000;
    await token.save();

    return token.accessToken;
  } catch (error) {
    console.error('Error refreshing access token:', error.response?.data || error.message);
    throw new Error('Failed to refresh access token');
  }
}


async function getHubSpotAccessToken() {
  try {
    console.log("🔑 Refreshing HubSpot access token...");
    const response = await axios.post(
      'https://api.hubapi.com/oauth/v1/token',
      new URLSearchParams({
        grant_type: 'refresh_token', // Ensure correct grant type
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: token.refreshToken, // Pass the stored refresh token
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    console.log("✅ New Access Token Response:", response.data);

    // Update token in database (if needed)
    return response.data.access_token;
  } catch (error) {
    console.error("❌ Error refreshing access token:", error.response?.data || error.message);
    throw new Error('Failed to retrieve HubSpot access token');
  }
}


async function sendToHubSpot(formData) {
  try {
    const accessToken = await getHubSpotAccessToken(); // Get OAuth token

    const hubspotData = {
      properties: {
        firstname: formData.firstname,
        lastname: formData.lastname,
        email: formData.email,
        phone: formData.phone,
        zip: formData.zip,
        program_session: formData.program_session, // ✅ Ensure correct field names
        program_time_2: formData.program_time_2,
        program_time_3: formData.program_time_3,
        intro_to_ai_program_date: formData.intro_to_ai_program_date,
        intro_to_ai_date_2: formData.intro_to_ai_date_2,
        intro_to_ai_date_3: formData.intro_to_ai_date_3,
      },
    };

    console.log('📤 Sending data to HubSpot:', JSON.stringify(hubspotData, null, 2));

    const response = await axios.post(HUBSPOT_API_URL, hubspotData, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`, // 🔑 Use OAuth token
      },
    });

    console.log('✅ Successfully updated HubSpot:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ HubSpot API Error:', error.response ? error.response.data : error.message);
    throw new Error('Failed to update HubSpot contact');
  }
}

async function findHubSpotContactId(email, accessToken) {
  try {
    const searchUrl = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
    const response = await axios.post(
      searchUrl,
      {
        filterGroups: [
          {
            filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
          },
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (response.data.total > 0) {
      return response.data.results[0].id; // ✅ Return the first matching contact ID
    } else {
      return null; // No contact found
    }
  } catch (error) {
    console.error('❌ Error finding HubSpot contact:', error.response?.data || error.message);
    throw new Error('Failed to find contact in HubSpot');
  }
}

async function updateHubSpotContact(contactId, formData, accessToken) {
  try {
    const updateUrl = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`;

    const hubspotData = {
      properties: {
        firstname: formData.firstname,
        lastname: formData.lastname,
        email: formData.email,
        phone: formData.phone,
        zip: formData.zip,
        program_session: formData.program_session,
        program_time_2: formData.program_time_2,
        program_time_3: formData.program_time_3,
        intro_to_ai_program_date: formData.intro_to_ai_program_date,
        intro_to_ai_date_2: formData.intro_to_ai_date_2,
        intro_to_ai_date_3: formData.intro_to_ai_date_3,
      },
    };

    console.log('📤 Updating HubSpot Contact:', JSON.stringify(hubspotData, null, 2));

    const response = await axios.patch(updateUrl, hubspotData, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    console.log('✅ HubSpot Contact Updated:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Error updating HubSpot contact:', error.response?.data || error.message);
    throw new Error('Failed to update contact in HubSpot');
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

const validTimes = [
  "10am-1pm EST/9am-12pm CST",
  "2pm-5pm EST/1pm-4pm CST",
  "6pm-9pm EST/5pm-8pm CST",
  "4pm-7pm EST",
];

// Helper function to validate dates and ensure they start at midnight UTC
function convertDateToMidnightISO(date) {
  if (!date) return null;
  return moment(date, "YYYY/MM/DD").startOf("day").toISOString();
}

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  const response = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code, // Authorization code from query string
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const { access_token, refresh_token, expires_in } = response.data;

  // Save the tokens to your database
  const newToken = new Token({
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: Date.now() + expires_in * 1000,
  });

  await newToken.save();
  res.send('Authentication successful!');
});


app.post('/api/intro-to-ai-payment', async (req, res) => {
  try {
    const {
      firstname,
      lastname,
      email,
      phone,
      program_session,
      program_time_2,
      program_time_3,
      intro_to_ai_program_date,
      intro_to_ai_date_2,
      intro_to_ai_date_3,
      zip,
      recaptchaToken,
    } = req.body;

    console.log("📩 Received form submission:", req.body);

    // ✅ Convert Dates to Midnight ISO format
    const convertedProgramDate = convertDateToMidnightISO(intro_to_ai_program_date);
    const convertedDate2 = convertDateToMidnightISO(intro_to_ai_date_2);
    const convertedDate3 = convertDateToMidnightISO(intro_to_ai_date_3);

    console.log("✅ Converted Dates:", {
      intro_to_ai_program_date: convertedProgramDate,
      intro_to_ai_date_2: convertedDate2,
      intro_to_ai_date_3: convertedDate3
    });

    // ✅ Check Required Fields
    let missingFields = [];
    if (!firstname) missingFields.push('firstname');
    if (!lastname) missingFields.push('lastname');
    if (!email) missingFields.push('email');
    if (!phone) missingFields.push('phone');
    if (!zip) missingFields.push('zip');
    if (!program_session) missingFields.push('program_session');
    if (!program_time_2) missingFields.push('program_time_2');
    if (!program_time_3) missingFields.push('program_time_3');
    if (!convertedProgramDate) missingFields.push('intro_to_ai_program_date');
    if (!convertedDate2) missingFields.push('intro_to_ai_date_2');
    if (!convertedDate3) missingFields.push('intro_to_ai_date_3');

    if (missingFields.length > 0) {
      console.error("❌ Missing fields:", missingFields);
      return res.status(400).json({ error: 'VALIDATION_ERROR', missingFields });
    }

    // ✅ Step 1: Get HubSpot Access Token
    console.log("🔑 Getting HubSpot access token...");
    const accessToken = await getHubSpotAccessToken();

    // ✅ Step 2: Search for Contact by Email
    console.log("🔍 Searching for HubSpot Contact...");
    const contactId = await findHubSpotContactId(email, accessToken);

    // ✅ Step 3: Prepare Data for Update
    const formData = {
      firstname,
      lastname,
      email,
      phone,
      zip,
      program_session,
      program_time_2,
      program_time_3,
      intro_to_ai_program_date: convertedProgramDate,
      intro_to_ai_date_2: convertedDate2,
      intro_to_ai_date_3: convertedDate3,
    };

    console.log("📤 Preparing data to send:", formData);

    // ✅ Step 4: Update or Create Contact in HubSpot
    if (!contactId) {
      console.log("📩 Contact does not exist. Creating new contact...");
      const hubspotResponse = await sendToHubSpot(formData);
      return res.status(201).json({ message: "New contact created", hubspotResponse });
    } else {
      console.log(`🔄 Contact found (ID: ${contactId}), updating existing contact...`);
      const hubspotResponse = await updateHubSpotContact(contactId, formData, accessToken);
      return res.status(200).json({ message: "Contact updated", hubspotResponse });
    }
  } catch (error) {
    console.error("❌ Server Error:", error);
    return res.status(500).json({ error: 'SERVER_ERROR', message: error.message });
  }
});






// Route: Handle Form Submission
app.patch("/api/update-contact", async (req, res) => {
  console.log("🚀 Received PATCH Request Body:", req.body);

  try {
    // ✅ Destructure expected fields
    const {
      firstname, lastname, email, phone,
      program_session, program_time_2, program_time_3,
      intro_to_ai_program_date, intro_to_ai_date_2, intro_to_ai_date_3,
      zip, recaptchaToken
    } = req.body;

    console.log("🔍 Extracted Data Before Conversion:", {
      firstname, lastname, email, phone,
      program_session, program_time_2, program_time_3,
      intro_to_ai_program_date, intro_to_ai_date_2, intro_to_ai_date_3,
      zip, recaptchaToken
    });

    // ✅ Convert Dates to Midnight ISO format before updating
    const convertedProgramDate = convertDateToMidnightISO(intro_to_ai_program_date);
    const convertedDate2 = convertDateToMidnightISO(intro_to_ai_date_2);
    const convertedDate3 = convertDateToMidnightISO(intro_to_ai_date_3);

    console.log("✅ Converted Dates for HubSpot:", {
      intro_to_ai_program_date: convertedProgramDate,
      intro_to_ai_date_2: convertedDate2,
      intro_to_ai_date_3: convertedDate3
    });

    // ✅ Verify reCAPTCHA
    const recaptchaValid = await verifyRecaptcha(recaptchaToken);
    if (!recaptchaValid) {
      console.error("❌ Invalid reCAPTCHA token!");
      return res.status(400).json({ message: "Invalid reCAPTCHA token" });
    }
    console.log("✅ reCAPTCHA verification passed!");

    // ✅ Obtain Access Token
    const accessToken = await getValidAccessToken();
    console.log("🔑 Using Access Token:", accessToken);

    // ✅ Check if contact exists in HubSpot
    const contactId = await getContactIdByEmail(email, accessToken);
    if (!contactId) {
      console.error("❌ Contact not found in HubSpot, cannot update.");
      return res.status(404).json({ message: "Contact not found in HubSpot" });
    }

    console.log(`🔄 Updating existing HubSpot contact: ${contactId}`);

    // ✅ Prepare Update Data
    const updateData = {
      properties: {
        firstname, lastname, email, phone,
        program_session, program_time_2, program_time_3,
        intro_to_ai_program_date: convertedProgramDate,
        intro_to_ai_date_2: convertedDate2,
        intro_to_ai_date_3: convertedDate3,
        zip
      }
    };

    // ✅ HubSpot API URL (Make sure it's defined in your environment variables)
    const HUBSPOT_API_URL = process.env.HUBSPOT_API_URL || 'https://api.hubapi.com/crm/v3/objects/contacts';

    // ✅ Send PATCH Request to HubSpot
    const hubspotResponse = await axios.patch(
      `${HUBSPOT_API_URL}/${contactId}`,
      updateData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ HubSpot Contact Updated Successfully:", hubspotResponse.data);
    res.status(200).json({ message: "Contact updated successfully", data: hubspotResponse.data });

  } catch (error) {
    console.error("❌ Error updating contact:", error.response?.data || error.message);
    res.status(500).json({ message: "Error updating contact", error: error.response?.data || error.message });
  }
});






// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
