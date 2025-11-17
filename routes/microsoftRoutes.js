// routes/microsoftRoutes.js
import express from 'express';

const router = express.Router();

/**
 * This route is ONLY for debugging and letting you test
 * that your Microsoft Graph integration is loaded properly.
 *
 * It does NOT perform OAuth because we are using the
 * Client Credentials flow (no redirects, no login needed).
 */
router.get('/api/ms-health', (req, res) => {
  res.json({
    ok: true,
    route: '/api/ms-health',
    message: 'Microsoft Graph integration is active (no OAuth routes needed).',
  });
});

export default router;
