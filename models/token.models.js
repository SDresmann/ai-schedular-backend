const mongoose = require('mongoose');

const tokenSchema = new mongoose.Schema({
  accessToken: { type: String, required: true },
  refreshToken: { type: String, required: true },
  expiresAt: { type: Number, required: true },
});

const Token = mongoose.model('Token', tokenSchema);
module.exports = Token;
