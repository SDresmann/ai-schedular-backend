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

// Function to Verify reCAPTCHA Token
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

// Handle Form Submission (app.post)
// Resume Upload Route
app.post('/api/resume-upload', resumeUpload.single('file'), async (req, res) => {
  const { email } = req.body;
  const file = req.file;

  if (!email || !file) {
    return res.status(400).send('Email and resume file are required.');
  }

  try {
    // Get a valid access token
    const accessToken = await getValidAccessToken();
    console.log('Access token obtained:', accessToken);

    // Get contact ID from email
    const contactId = await getContactIdByEmail(email, accessToken);
    console.log(`Contact ID for email ${email}: ${contactId}`);

    // Determine the MIME type and ensure correct extension
    const mimeType = file.mimetype;
    console.log(`Detected MIME type: ${mimeType}`);

    const fileExtension =
      mimeType === 'application/pdf' ? '.pdf' :
      mimeType === 'application/msword' ? '.doc' :
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? '.docx' :
      '';
    if (!fileExtension) {
      throw new Error('Invalid file type.');
    }

    // Ensure the file has the correct extension
    const filePath = `${file.path}${fileExtension}`;
    fs.renameSync(file.path, filePath);

    // Prepare the form data for the file upload
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath), {
      filename: file.originalname,
      contentType: mimeType,
    });
    formData.append('folderPath', 'documents/resumes');
    formData.append('options', JSON.stringify({ access: 'PUBLIC_INDEXABLE' }));

    // Upload the resume file to HubSpot
    const fileUploadResponse = await axios.post(
      'https://api.hubapi.com/files/v3/files',
      formData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...formData.getHeaders(),
        },
      }
    );

    console.log('File uploaded successfully:', fileUploadResponse.data);

    const fileUrl = fileUploadResponse.data.url;

    // Update the contact with the file URL
    const updateResponse = await updateContactWithFileUrl(contactId, fileUrl, accessToken);
    console.log('Contact updated successfully:', updateResponse);

    fs.unlinkSync(filePath); // Remove the file after upload

    res.status(200).json(updateResponse);
  } catch (error) {
    console.error('Error uploading resume to HubSpot:', error.response?.data || error.message);
    res.status(500).send('Error uploading resume to HubSpot.');
  }
});


// Helper: Update Contact with File URL
async function updateContactWithFileUrl(contactId, fileUrl, accessToken) {
  try {
    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      {
        properties: {
          resume: fileUrl, // Assuming 'resume' is the custom property in HubSpot
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error('Error updating contact with file URL:', error.response?.data || error.message);
    throw error;
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
      throw new Error(`Contact not found for email: ${email}`);
    }

    return response.data.results[0].id;
  } catch (error) {
    console.error('Error fetching contact ID:', error.response?.data || error.message);
    throw error;
  }
}

// Helper: Update Contact with File URL
async function updateContactWithFileUrl(contactId, fileUrl, accessToken) {
  try {
    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      {
        properties: {
          resume: fileUrl, // Assuming 'resume' is the custom property in HubSpot
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error('Error updating contact with file URL:', error.response?.data || error.message);
    throw error;
  }
}

// Update Contact (app.patch)
app.patch('/api/update-contact', async (req, res) => {
    const { email, updatedProperties } = req.body;

    try {
        console.log('Received update request:', req.body);

        const accessToken = await getValidAccessToken();

        // Search for existing contact
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
            console.log('Updating existing contact:', existingContact);

            const updateResponse = await axios.patch(
                `${HUBSPOT_API_URL}/${existingContact.id}`,
                { properties: updatedProperties },
                {
                    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                }
            );

            console.log('Update response from HubSpot:', updateResponse.data);
            return res.status(200).send({ message: 'Contact updated successfully', data: updateResponse.data });
        } else {
            console.log('Contact not found for update');
            res.status(404).send({ message: 'Contact not found' });
        }
    } catch (error) {
        console.error('Error during contact update:', error.response?.data || error.message);
        res.status(500).send({ message: 'Server error', error: error.response?.data || error.message });
    }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
