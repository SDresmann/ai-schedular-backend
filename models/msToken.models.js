const mongoose = require('mongoose');

const MsTokenSchema = new mongoose.Schema({
  accessToken: String,
  refreshToken: String,
  expiresAt: Number,   // Date.now() + expiresIn*1000
  accountId: String,   // optional: oid/sub from id token
}, { timestamps: true });

module.exports = mongoose.model('MsToken', MsTokenSchema);
