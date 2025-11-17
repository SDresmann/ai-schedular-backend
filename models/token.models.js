// backend/models/token.models.js
import mongoose from 'mongoose';

const tokenSchema = new mongoose.Schema({
  accessToken: {
    type: String,
    required: true,
  },
  refreshToken: {
    type: String,
    required: true,
  },
  expiresAt: {
    type: Number,
    required: true, // store as timestamp (Date.now())
  },
}, { timestamps: true });

const Token = mongoose.model('Token', tokenSchema);

export default Token;
