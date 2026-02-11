/**
 * ============================================================================
 * Clients Routes
 * ============================================================================
 * ترتيب المسارات مهم جداً لتجنّب تعارض /:id مع مسارات مثل /sync و /by-uuid
 * ============================================================================
 */
const express = require('express');
const router = express.Router();

const {
  getClients,
  getClientById,
  getClientByUuid,
  getClientsByPhone,
  createClient,
  updateClient,
  deleteClient,
  deleteClientByUuid,
  syncClient
} = require('../controllers/clientController');

const { authenticate, syncLimiter } = require('../middleware/auth');

// ------------------------------
// Read
// ------------------------------
router.get('/', authenticate, getClients);
router.get('/by-uuid/:clientUuid', authenticate, getClientByUuid);
router.get('/by-phone/:phone', authenticate, getClientsByPhone);

// ------------------------------
// Sync
// ------------------------------
router.put('/sync', authenticate, syncLimiter, syncClient);

// ------------------------------
// CRUD
// ------------------------------
router.post('/', authenticate, createClient);

// تحديث بالحقل الرقمي (إن كان تطبيقك يستخدمه)
router.put('/:clientId', authenticate, updateClient);

// حذف بالرقم أو بالـ UUID (بدون تعارض مسارات)
router.delete('/id/:clientId', authenticate, deleteClient);
router.delete('/by-uuid/:clientUuid', authenticate, deleteClientByUuid);

// Get by numeric id (keep last to avoid conflicts with other GET routes)
router.get('/:clientId', authenticate, getClientById);

module.exports = router;
