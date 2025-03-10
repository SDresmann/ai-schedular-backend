const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const moment = require('moment');
const cors = require('cors');

require('dotenv').config();

const Token = require('./models/token.models');
const Booking = require('./models/booking.models');

const app = express();

const corsOptions = {
  origin: ['http://localhost:3000', 'https://app.kableacademy.com'], // Add both local and production origins
  credentials: true, // If you need to send cookies or authentication headers
  methods: ['GET', 'POST', 'PATCH', 'DELETE'], // Allowed HTTP methods
  allowedHeaders: ['Content-Type', 'Authorization'], // Headers to allow
};

app.use(bodyParser.json());
app.use(cors(corsOptions));

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

    if (response.data.results.length === 0) {
      return null;
    }

    return response.data.results[0].id;
  } catch (error) {
    console.error('Error fetching contact ID:', error.response?.data || error.message);
    throw error;
  }
}

async function getFullyBookedDates() {
  try {
    const accessToken = await getValidAccessToken();
    const results = [];
    let hasMore = true;
    let after;

    // Paginate through contacts – adjust the limit as needed.
    while (hasMore) {
      const response = await axios.post(
        `${HUBSPOT_API_URL}/search`,
        {
          limit: 100,
          after: after,
          properties: ['intro_to_ai_program_date', 'intro_to_ai_date_2'],
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const data = response.data;
      results.push(...data.results);
      if (data.paging && data.paging.next && data.paging.next.after) {
        after = data.paging.next.after;
      } else {
        hasMore = false;
      }
    }

    // Use sets to track booked dates for each time slot.
    const firstSlotDates = new Set();
    const secondSlotDates = new Set();

    results.forEach(contact => {
      const props = contact.properties;
      if (props.intro_to_ai_program_date) {
        // Convert timestamp (assumed as milliseconds) to MM/DD/YYYY format.
        const dateStr = moment(Number(props.intro_to_ai_program_date)).format('MM/DD/YYYY');
        firstSlotDates.add(dateStr);
      }
      if (props.intro_to_ai_date_2) {
        const dateStr = moment(Number(props.intro_to_ai_date_2)).format('MM/DD/YYYY');
        secondSlotDates.add(dateStr);
      }
    });

    // A date is fully booked if it's booked in both time slots.
    const fullyBooked = [...firstSlotDates].filter(date => secondSlotDates.has(date));
    console.log('Fully booked dates:', fullyBooked);
    return fullyBooked;
  } catch (error) {
    console.error('Error fetching fully booked dates:', error.response?.data || error.message);
    return [];
  }
}
// ✅ Check if the selected class date & time are available
app.post("/api/check-availability", async (req, res) => {
  const { classDate, time } = req.body;

  try {
      const existingBooking = await Booking.findOne({ date: classDate, timeSlot: time });

      if (existingBooking) {
          return res.json({ 
              available: false, 
              date: classDate, 
              time: time,
              message: `❌ Date **${classDate}** and Time **${time}** are already booked.`
          });
      }

      res.json({ available: true });
  } catch (error) {
      console.error("❌ Error checking availability:", error);
      res.status(500).json({ available: false, error: "Server error" });
  }
});


app.get('/api/booked-dates', async (req, res) => {
  try {
      // Fetch all bookings and group by date
      const bookings = await Booking.aggregate([
          {
              $group: {
                  _id: "$date", // Group by date
                  bookedTimes: { $addToSet: "$timeSlot" } // Collect all booked time slots for each date
              }
          }
      ]);

      // Format response to easily look up booked times
      const bookedDatesMap = {};
      bookings.forEach(booking => {
          bookedDatesMap[booking._id] = booking.bookedTimes;
      });

      res.status(200).json(bookedDatesMap);
  } catch (error) {
      console.error("Error fetching booked dates:", error);
      res.status(500).json({ message: "Error fetching booked dates", error: error.message });
  }
});

// Route: Handle Form Submission
app.post('/api/intro-to-ai-payment', async (req, res) => {
  const { firstName, lastName, email, company, phoneNumber, time, time2, classDate, classDate2, recaptchaToken } = req.body;
  console.log('Received Request Body:', req.body);

  try {
    // Verify reCAPTCHA token
    const recaptchaValid = await verifyRecaptcha(recaptchaToken);
    if (!recaptchaValid) {
      console.error('Invalid reCAPTCHA token');
      return res.status(400).send({ message: 'Invalid reCAPTCHA token' });
    }
    console.log('reCAPTCHA validation passed.');

    // Prepare contact data
    const contactData = {
      firstname: firstName,
      lastname: lastName,
      email,
      company,
      phone: phoneNumber,
      program_session: time,
      program_time_2: time2,
      intro_to_ai_program_date: moment(classDate, 'MM/DD/YYYY').utc().startOf('day').valueOf(),
      intro_to_ai_date_2: moment(classDate2, 'MM/DD/YYYY').utc().startOf('day').valueOf(),
    };

    // Obtain access token and handle contact creation/updating
    const accessToken = await getValidAccessToken();
    const contactId = await getContactIdByEmail(email, accessToken);

    let hubspotResponse;
    if (contactId) {
      hubspotResponse = await axios.patch(
        `${HUBSPOT_API_URL}/${contactId}`,
        { properties: contactData },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } else {
      hubspotResponse = await axios.post(
        HUBSPOT_API_URL,
        { properties: contactData },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
    }
    await Booking.create({ email, date: classDate, timeSlot: time });
    await Booking.create({ email, date: classDate2, timeSlot: time2 });
    res.status(200).send({ message: 'Contact successfully processed', data: hubspotResponse.data });
  } catch (error) {
    console.error('Error processing form submission:', error.response?.data || error.message);
    res.status(500).send({
      message: 'Error processing contact data',
      error: error.response?.data || error.message,
    });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));