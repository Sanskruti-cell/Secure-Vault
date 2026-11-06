import express from 'express';
import { getNodes, getNodeById, toggleNodeStatus, restoreNode } from '../controllers/nodeController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/', getNodes);
router.get('/:id', getNodeById);
router.post('/:id/toggle-status', toggleNodeStatus);
router.post('/:id/restore', restoreNode);

export default router;
