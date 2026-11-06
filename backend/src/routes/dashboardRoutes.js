import express from 'express';
import { getDashboardMetrics, getActivities } from '../controllers/dashboardController.js';
import { protect } from '../middleware/authMiddleware.js';
import { verifyAuditChain } from '../services/auditService.js';
import { getDedupStats } from '../services/dedupService.js';
import { logIntegrityCheck } from '../middleware/terminalLogger.js';

const router = express.Router();

router.use(protect);

router.get('/activities', getActivities);
router.get('/audit/verify', async (req, res, next) => {
  try {
    const result = await verifyAuditChain();
    logIntegrityCheck('Audit Log Cryptographic Hash Chain', result.isValid ? 'PASS' : 'FAIL');
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
router.get('/dedup', async (req, res, next) => {
  try {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    const stats = await getDedupStats(userId);
    return res.status(200).json(stats);
  } catch (err) {
    next(err);
  }
});
router.get('/stats', getDashboardMetrics);
router.get('/', getDashboardMetrics);

export default router;
