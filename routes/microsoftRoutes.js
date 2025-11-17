// backend/routes/microsoftRoutes.js
import express from 'express';
import { getAuthUrl, handleAuthCode, MS_SCOPES } from '../services/outlookService.js';

const router = express.Router();

// Start Microsoft login
router.get('/ms-auth/login', async (_req, res) => {
  try {
    const url = await getAuthUrl();
    res.redirect(url);
  } catch (e) {
    res.status(500).send(`Login error: ${e.message}`);
  }
});

// OAuth callback
router.get('/ms-auth/callback', async (req, res) => {
  try {
    const code = req.query.code;
    const result = await handleAuthCode(code);
    res.send(`Microsoft connected for ${result.account?.username || 'your account'}. You can close this window.`);
  } catch (e) {
    res.status(500).send(`Callback error: ${e.message}`);
  }
});

// Optional diagnostics
router.get('/ms-auth/diag', async (_req, res) => {
  try {
    const url = await getAuthUrl();
    res.json({
      ok: true,
      hasClientId: !!process.env.MS_CLIENT_ID,
      hasTenantId: !!process.env.MS_TENANT_ID,
      hasSecret: !!process.env.MS_CLIENT_SECRET,
      redirectUri: process.env.MS_REDIRECT_URI,
      sampleAuthUrlStartsWithLogin: url.startsWith('https://login.microsoftonline.com/'),
      scopes: MS_SCOPES,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
