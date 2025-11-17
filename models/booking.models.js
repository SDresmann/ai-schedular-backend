// backend/models/booking.models.js
import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
  },
  date: {
    // stored as "MM/DD/YYYY"
    type: String,
    required: true,
  },
  timeSlot: {
    // e.g. "9am-12pm EST/8am-11pm CST"
    type: String,
    required: true,
  },
}, { timestamps: true });

const Booking = mongoose.model('Booking', bookingSchema);

export default Booking;
