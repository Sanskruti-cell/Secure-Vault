import express from 'express';
import { processAICommand } from '../controllers/aiController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.post('/command', processAICommand);

export default router;
