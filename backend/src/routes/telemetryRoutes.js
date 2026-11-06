import express from 'express';
import { logFrontendUiAction } from '../middleware/terminalLogger.js';

const router = express.Router();

/**
 * Endpoint for receiving UI actions performed in the browser and logging them to the backend terminal.
 */
router.post('/action', (req, res) => {
  try {
    const { action, details, user } = req.body || {};
    const effectiveUser = user || (req.user ? req.user.email : null) || 'Frontend User';
    
    logFrontendUiAction(action || 'USER_INTERACTION', details || {}, effectiveUser);
    
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(200).json({ success: false, error: err.message });
  }
});

export default router;
