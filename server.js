const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const bodyParser = require('body-parser');
const cors = require('cors');
const mongoose = require('mongoose');
const moment = require('moment');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

console.log('SECRET_KEY from .env:', process.env.SECRET_KEY);

// Environment Variables
const SECRET_KEY = process.env.SECRET_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const HUBSPOT_API_URL = 'https://api.hubapi.com/crm/v3/objects/contacts';

// MongoDB Connection (Optional)
mongoose.connect(process.env.ATLAS_URI, { useUnifiedTopology: true, useNewUrlParser: true });
const connection = mongoose.connection;
connection.once('open', () => {
  console.log('MongoDB connected successfully');
});

// reCAPTCHA Verification
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

    console.log('Google reCAPTCHA API Response:', response.data);

    // Check success and score
    return response.data.success && response.data.score >= 0.5; // Adjust score threshold if needed
  } catch (error) {
    console.error('Error verifying reCAPTCHA:', error.message);
    return false;
  }
}

// HubSpot API Integration: Create or Update Contact
async function createOrUpdateContact(data) {
  const apiKey = process.env.HUBSPOT_API_KEY; // Ensure your HubSpot API Key is in the .env file

  try {
    // Check if contact already exists
    const searchUrl = `${HUBSPOT_API_URL}/search`;
    const searchPayload = {
      filterGroups: [
        {
          filters: [{ propertyName: 'email', operator: 'EQ', value: data.email }],
        },
      ],
    };

    const searchResponse = await axios.post(searchUrl, searchPayload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const existingContactId = searchResponse?.data?.results[0]?.id;

    if (existingContactId) {
      // Update existing contact
      const updateUrl = `${HUBSPOT_API_URL}/${existingContactId}`;
      const updateResponse = await axios.patch(updateUrl, { properties: data }, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      console.log('Contact updated successfully:', updateResponse.data);
      return updateResponse.data;
    } else {
      // Create a new contact
      const createResponse = await axios.post(
        HUBSPOT_API_URL,
        { properties: data },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
      console.log('Contact created successfully:', createResponse.data);
      return createResponse.data;
    }
  } catch (error) {
    console.error('Error in HubSpot API:', error.response?.data || error.message);
    throw new Error('Failed to create or update contact in HubSpot');
  }
}

// POST Route: Handle Form Submission
app.post('/api/intro-to-ai-payment', async (req, res) => {
  console.log('Request Body:', req.body);

  const { recaptchaToken, firstName, lastName, email, phoneNumber, program, time, classDate, postal } = req.body;

  // Validate reCAPTCHA
  if (!recaptchaToken) {
    console.error('Missing reCAPTCHA token');
    return res.status(400).send({ message: 'Missing reCAPTCHA token' });
  }

  const captchaValid = await verifyCaptcha(recaptchaToken);
  if (!captchaValid) {
    console.error('Invalid reCAPTCHA token');
    return res.status(400).send({ message: 'Invalid reCAPTCHA token.' });
  }

  // Validate Required Fields
  if (!firstName || !lastName || !email || !phoneNumber || !program || !time || !classDate || !postal) {
    console.error('Missing required fields');
    return res.status(400).send({ message: 'Please fill out all required fields.' });
  }

  // Prepare HubSpot Data
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

  try {
    const hubSpotResponse = await createOrUpdateContact(hubSpotData);
    res.status(200).send({ message: 'Form submitted successfully!', hubSpotResponse });
  } catch (error) {
    console.error('Error handling form submission:', error.message);
    res.status(500).send({ message: 'Server error' });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
