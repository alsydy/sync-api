@echo off
REM ============================================================================
REM Migration Script: إضافة جدول subscription_requests
REM ============================================================================
REM الاستخدام: قم بتعديل المسار وبيانات الاتصال حسب بيئتك
REM ============================================================================

psql -U postgres -h localhost -p 7754 -d malymax_prod -f "%~dp0migration_subscription_requests.sql"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ تم تنفيذ migration بنجاح!
    echo.
) else (
    echo.
    echo ❌ فشل تنفيذ migration. تحقق من الأخطاء أعلاه.
    echo.
)

pause

