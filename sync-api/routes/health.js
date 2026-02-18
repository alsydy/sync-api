// ============================================================================
// Health & Info Routes
// ============================================================================
// Routes للصحة ومعلومات الخادم
// ============================================================================

const express = require('express');
const router = express.Router();
const { pool, checkPoolHealth } = require('../config/database');
const logger = require('../utils/logger');

/**
 * GET /
 * صفحة افتراضية بسيطة
 */
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'MalyMax Sync API is running',
    health: '/api/health',
    info: '/api/info'
  });
});

/**
 * GET /api/health
 * فحص صحة الخادم وقاعدة البيانات
 */
router.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as now, version() as version');
    const poolHealth = await checkPoolHealth();
    
    res.json({
      success: true,
      status: 'healthy',
      database: {
        connected: true,
        version: result.rows[0].version.split(' ')[0] + ' ' + result.rows[0].version.split(' ')[1],
        timestamp: result.rows[0].now
      },
      pool: poolHealth,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.errorMsg('Health check failed', { error: error.message });
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      database: {
        connected: false,
        error: error.message
      },
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/info
 * معلومات الخادم
 */
router.get('/info', async (req, res) => {
  try {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    let localIP = 'localhost';
    
    for (const interfaceName in networkInterfaces) {
      const interfaces = networkInterfaces[interfaceName];
      for (const iface of interfaces) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIP = iface.address;
          break;
        }
      }
      if (localIP !== 'localhost') break;
    }
    
    const PORT = process.env.PORT || 3001;
    const serverUrl = process.env.SERVER_URL || `http://${localIP}:${PORT}`;
    
    res.json({
      success: true,
      server: {
        name: 'MalyMax Professional Sync API',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch()
      },
      urls: {
        local: `http://localhost:${PORT}`,
        network: `http://${localIP}:${PORT}`,
        androidEmulator: `http://10.0.2.2:${PORT}`,
        serverUrl: serverUrl
      },
      database: {
        host: process.env.DB_HOST?.substring(0, 30) + '...' || 'not configured',
        name: process.env.DB_NAME || 'not configured',
        ssl: process.env.DB_SSL === 'true'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.errorMsg('Error getting server info', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'خطأ في الحصول على معلومات الخادم'
    });
  }
});

module.exports = router;

