# ============================================================================
# Script لتشغيل خادم MalyMax Sync API
# ============================================================================

Write-Host "🔄 إيقاف أي عمليات node قائمة..." -ForegroundColor Yellow
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "🚀 بدء تشغيل الخادم..." -ForegroundColor Green
Write-Host ""

# تشغيل الخادم
node server.js

