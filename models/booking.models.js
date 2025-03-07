const mongoose = require('mongoose')

const bookingSchema = new mongoose.Schema({
    email: { type: String, required: true },
    date: { type: String, required: true},
    timeSlot: { type: String, required: true},
}, {timestamps:true})

module.exports = mongoose.model('Booking', bookingSchema)