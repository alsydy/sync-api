// ============================================================================
// Bootstrap Routes
// ============================================================================

const express = require('express');
const router = express.Router();
const bootstrapController = require('../controllers/bootstrapController');
const { authenticate } = require('../middleware/auth');

/**
 * POST /api/bootstrap
 * Ensure defaults and return user + accounts
 */
router.post('/', authenticate, bootstrapController.bootstrap);

module.exports = router;
