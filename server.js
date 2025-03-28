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
    const bookings = await Booking.aggregate([
      {
        $group: {
          _id: "$date",
          timeSlots: { $addToSet: "$timeSlot" } // Get all booked times per date
        }
      }
    ]);

    const fullyBookedDates = {};

    bookings.forEach((booking) => {
      const date = moment(booking._id).format("MM/DD/YYYY"); // ✅ Convert date format
      const bookedTimes = booking.timeSlots;

      const isFriday = moment(date, "MM/DD/YYYY").isoWeekday() === 5;
      let requiredSlots = isFriday ? 3 : 2; // ✅ Fridays have 3 slots, other days have 2

      fullyBookedDates[date] = bookedTimes;

      // ✅ Mark a date as fully booked if all slots are taken
      if (bookedTimes.length >= requiredSlots) {
        fullyBookedDates[date] = bookedTimes;
      }
    });

    console.log("📌 Sending cleaned booked dates:", fullyBookedDates);
    res.status(200).json(fullyBookedDates); // ✅ Send formatted dates
  } catch (error) {
    console.error("❌ Error fetching booked dates:", error);
    res.status(500).json({ message: "Error fetching booked dates" });
  }
});





// Route: Handle Form Submission
app.post('/api/intro-to-ai-payment', async (req, res) => {
  console.log('📥 Received Request Body:', req.body); // ✅ Log incoming data

  const { firstName, lastName, email, yourCompany, phoneNumber, time, time2, time3, classDate, classDate2, classDate3, recaptchaToken } = req.body;

  try {
    // ✅ Verify reCAPTCHA
    const recaptchaValid = await verifyRecaptcha(recaptchaToken);
    if (!recaptchaValid) {
      console.error('❌ Invalid reCAPTCHA token');
      return res.status(400).send({ message: 'Invalid reCAPTCHA token' });
    }
    console.log('✅ reCAPTCHA validation passed.');

    // ✅ Convert Dates for HubSpot
    const formattedHubSpotDate1 = moment(classDate, 'YYYY-MM-DD').valueOf();
    const formattedHubSpotDate2 = moment(classDate2, 'YYYY-MM-DD').valueOf();
    const formattedHubSpotDate3 = moment(classDate3, 'YYYY-MM-DD').valueOf();

    console.log('📌 HubSpot Formatted Dates:', formattedHubSpotDate1, formattedHubSpotDate2, formattedHubSpotDate3);

    // ✅ Convert Dates for MongoDB (Ensure MM/DD/YYYY format)
    const formattedMongoDate1 = moment(classDate).format('MM/DD/YYYY');
    const formattedMongoDate2 = moment(classDate2).format('MM/DD/YYYY');
    const formattedMongoDate3 = moment(classDate3).format('MM/DD/YYYY');

    console.log('📌 MongoDB Formatted Dates:', formattedMongoDate1, formattedMongoDate2, formattedMongoDate3);

    // ✅ Prepare Contact Data for HubSpot
    const contactData = {
      firstname: firstName,
      lastname: lastName,
      email,
      your_company_name: yourCompany,
      phone: phoneNumber,
      program_session: time,
      program_time_2: time2,
      program_time_3: time3,
      intro_to_ai_program_date: formattedHubSpotDate1 || null,
      intro_to_ai_date_2: formattedHubSpotDate2 || null,
      intro_to_ai_date_3: formattedHubSpotDate3 || null,
    };

    // ✅ Get Access Token & Update or Create Contact
    const accessToken = await getValidAccessToken();
    const contactId = await getContactIdByEmail(email, accessToken);

    let hubspotResponse;
    if (contactId) {
      hubspotResponse = await axios.patch(
        `${HUBSPOT_API_URL}/${contactId}`,
        { properties: contactData },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
    } else {
      hubspotResponse = await axios.post(
        HUBSPOT_API_URL,
        { properties: contactData },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
    }

    // ✅ Save to MongoDB Only If Dates Exist
    if (formattedMongoDate1 && time) {
      await Booking.create({ email, date: formattedMongoDate1, timeSlot: time });
    }
    if (formattedMongoDate2 && time2) {
      await Booking.create({ email, date: formattedMongoDate2, timeSlot: time2 });
    }
    if (formattedMongoDate3 && time3) {
      await Booking.create({ email, date: formattedMongoDate3, timeSlot: time3 });
    }

    res.status(200).send({ message: '✅ Contact successfully processed in HubSpot and MongoDB!', data: hubspotResponse.data });
  } catch (error) {
    console.error('❌ Error processing form submission:', error.response?.data || error.message);
    res.status(500).send({ message: 'Error processing contact data', error: error.response?.data || error.message });
  }
});


// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));