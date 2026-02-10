// ============================================================================
// WhatsApp Routes
// ============================================================================

const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');
const { optionalAuthenticate } = require('../middleware/auth');

// Settings
router.get('/settings/:userId', optionalAuthenticate, whatsappController.getWhatsappSettings);
router.put('/settings', optionalAuthenticate, whatsappController.upsertWhatsappSettings);

// Client opt-out
router.get('/client-opt-out/:userId', optionalAuthenticate, whatsappController.getClientOptOuts);
router.put('/client-opt-out', optionalAuthenticate, whatsappController.setClientOptOut);

// Private session management
router.post('/session-request', optionalAuthenticate, whatsappController.createPrivateSessionRequest);
router.post('/session-cancel', optionalAuthenticate, whatsappController.cancelPrivateSession);

module.exports = router;

