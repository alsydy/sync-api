'use strict';

const express = require('express');
const router = express.Router();

const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const { syncLimiter } = require('../middleware/auth');
const clientController = require('../controllers/clientController');

// GET /api/clients
router.get('/', optionalAuthenticate, clientController.getClients);

// PUT /api/clients/sync
router.put('/sync', authenticate, syncLimiter, clientController.syncClients);

module.exports = router;
