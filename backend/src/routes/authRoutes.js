import express from 'express';
import { 
  registerUser, 
  loginUser, 
  getMe, 
  setupMasterPassword, 
  changeMasterPassword, 
  recoverMasterKey, 
  updateAutoLock 
} from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import { authLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

router.post('/register', authLimiter, registerUser);
router.post('/login', authLimiter, loginUser);
router.get('/me', protect, getMe);
router.post('/master-password/setup', protect, setupMasterPassword);
router.post('/master-password/change', protect, changeMasterPassword);
router.post('/master-password/recover', protect, recoverMasterKey);
router.post('/auto-lock', protect, updateAutoLock);

export default router;
