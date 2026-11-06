import express from 'express';
import {
  createShare,
  getSharedLinks,
  getPublicShareInfo,
  downloadPublicShare,
  deleteShare
} from '../controllers/shareController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// ============================================================================
// Public Recipient Routes (No authentication required)
// ============================================================================
router.get('/public/:token', getPublicShareInfo);
router.get('/public/:token/download', downloadPublicShare);
router.get('/:token/download', downloadPublicShare);
router.get('/:token', (req, res, next) => {
  // If request has Authorization header and token looks like query, or if it's token parameter
  getPublicShareInfo(req, res, next);
});

// ============================================================================
// Protected Creator Routes (Requires JWT Session Authentication)
// ============================================================================
router.post('/', protect, createShare);
router.get('/', protect, getSharedLinks);
router.delete('/:id', protect, deleteShare);

export default router;

