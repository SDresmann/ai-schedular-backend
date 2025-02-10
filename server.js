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
// Function to Convert Date to UNIX Timestamp (Milliseconds)
function convertDateToTimestamp(date) {
  return new Date(date).getTime(); // Convert date to Unix timestamp
}

// Function to Fix Program Time to Match HubSpot Allowed Values
const fixProgramTime = (time) => {
  const validTimes = {
    "10am-1pm EST/9am-12pm CST": "10am-1pm EST",
    "2pm-5pm EST/1pm-4pm CST": "2:00PM - 500PM",
    "6pm-9pm EST/5pm-8pm CST": "6:00PM - 9PM",
    "4pm-7pm EST": "4pm-7pm EST",
  };
  return validTimes[time] || time;
};

function convertDateToISO8601(date) {
  if (!date) return null;
  const formattedDate = new Date(date).toISOString(); // Converts to YYYY-MM-DDTHH:mm:ss.sTZD
  return formattedDate;
}
const validTimes = [
  "10am-1pm EST/9am-12pm CST",
  "2pm-5pm EST/1pm-4pm CST",
  "6pm-9pm EST/5pm-8pm CST",
  "4pm-7pm EST",
];
// Route: Handle Form Submission
const express = require("express");
const bodyParser = require("body-parser");
const moment = require("moment");

const app = express();
app.use(bodyParser.json());

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

app.post("/api/intro-to-ai-payment", (req, res) => {
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

    // Validate required fields
    let missingFields = [];
    if (!firstname) missingFields.push("firstname");
    if (!lastname) missingFields.push("lastname");
    if (!email) missingFields.push("email");
    if (!phone) missingFields.push("phone");
    if (!zip) missingFields.push("zip");
    if (!recaptchaToken) missingFields.push("recaptchaToken");

    // Validate program times
    if (!validTimes.includes(program_session)) {
      missingFields.push("program_session");
    }
    if (!validTimes.includes(program_time_2)) {
      missingFields.push("program_time_2");
    }
    if (!validTimes.includes(program_time_3)) {
      missingFields.push("program_time_3");
    }

    // Validate dates
    let convertedDates = {};
    if (intro_to_ai_program_date) {
      convertedDates.intro_to_ai_program_date = convertDateToMidnightISO(
        intro_to_ai_program_date
      );
    } else {
      missingFields.push("intro_to_ai_program_date");
    }

    if (intro_to_ai_date_2) {
      convertedDates.intro_to_ai_date_2 = convertDateToMidnightISO(
        intro_to_ai_date_2
      );
    } else {
      missingFields.push("intro_to_ai_date_2");
    }

    if (intro_to_ai_date_3) {
      convertedDates.intro_to_ai_date_3 = convertDateToMidnightISO(
        intro_to_ai_date_3
      );
    } else {
      missingFields.push("intro_to_ai_date_3");
    }

    // If there are missing or invalid fields, return an error response
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Missing or invalid fields",
        missingFields,
      });
    }

    // Mock processing and returning a success response
    return res.status(200).json({
      message: "Form submitted successfully!",
      submittedData: {
        firstname,
        lastname,
        email,
        phone,
        program_session,
        program_time_2,
        program_time_3,
        ...convertedDates,
        zip,
        recaptchaToken,
      },
    });
  } catch (error) {
    console.error("❌ Error processing form submission:", error);
    return res.status(500).json({
      error: "SERVER_ERROR",
      message: "An internal error occurred while processing the request",
    });
  }
});





// Route: Handle Form Submission
app.patch("/api/update-contact", async (req, res) => {
  console.log("🚀 Received PATCH Request Body:", req.body);

  try {
    // Destructure expected fields
    const {
      firstname, lastname, email, phone,
      program_session, program_time_2, program_time_3,
      intro_to_ai_program_date, intro_to_ai_date_2, intro_to_ai_date_3,
      zip, recaptchaToken
    } = req.body;

    console.log("🔍 Extracted Data:", {
      firstname, lastname, email, phone,
      program_session, program_time_2, program_time_3,
      intro_to_ai_program_date, intro_to_ai_date_2, intro_to_ai_date_3,
      zip, recaptchaToken
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
        intro_to_ai_program_date, intro_to_ai_date_2, intro_to_ai_date_3,
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
