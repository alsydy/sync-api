// ============================================================================
// Test Script for MalyMax Sync API
// ============================================================================

const http = require('http');

const BASE_URL = 'http://localhost:3001';

function makeRequest(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

async function runTests() {
  console.log('🧪 بدء اختبار الخادم...\n');

  // Test 1: Health Check
  console.log('1️⃣  اختبار Health Check...');
  try {
    const result = await makeRequest('/api/health');
    if (result.status === 200 && result.data.success) {
      console.log('   ✅ Health Check نجح');
      console.log(`   📊 Database: ${result.data.database?.connected ? 'متصل' : 'غير متصل'}`);
    } else {
      console.log('   ❌ Health Check فشل:', result.data);
    }
  } catch (error) {
    console.log('   ❌ خطأ في الاتصال:', error.message);
    console.log('   💡 تأكد من أن الخادم يعمل على المنفذ 3001');
    return;
  }

  // Test 2: Create User
  console.log('\n2️⃣  اختبار إنشاء مستخدم...');
  try {
    const userData = {
      userUuid: 'test-user-' + Date.now(),
      fullName: 'مستخدم تجريبي',
      phoneNumber: '07701234567',
      jobTitle: 'مطور',
      passwordHash: 'test_hash',
      passwordSalt: 'test_salt',
      accountNumber: Math.floor(Math.random() * 1000000)
    };
    
    const result = await makeRequest('/api/users', 'POST', userData);
    if (result.status === 201 && result.data.success) {
      console.log('   ✅ تم إنشاء المستخدم بنجاح');
      console.log(`   📝 User ID: ${result.data.data.id}`);
      return result.data.data;
    } else {
      console.log('   ⚠️  لم يتم إنشاء المستخدم:', result.data);
    }
  } catch (error) {
    console.log('   ❌ خطأ:', error.message);
  }

  // Test 3: Get Users
  console.log('\n3️⃣  اختبار جلب المستخدمين...');
  try {
    const result = await makeRequest('/api/users/1');
    if (result.status === 200 || result.status === 404) {
      console.log(`   ✅ الطلب نجح (Status: ${result.status})`);
    } else {
      console.log('   ❌ فشل:', result.data);
    }
  } catch (error) {
    console.log('   ❌ خطأ:', error.message);
  }

  // Test 4: Create Client
  console.log('\n4️⃣  اختبار إنشاء عميل...');
  try {
    const clientData = {
      clientUuid: 'test-client-' + Date.now(),
      ownerUserId: 1,
      clientName: 'عميل تجريبي',
      phoneNumber: '07701234568',
      syncVersion: 1
    };
    
    const result = await makeRequest('/api/clients', 'POST', clientData);
    if (result.status === 201 && result.data.success) {
      console.log('   ✅ تم إنشاء العميل بنجاح');
    } else {
      console.log('   ⚠️  لم يتم إنشاء العميل:', result.data);
    }
  } catch (error) {
    console.log('   ❌ خطأ:', error.message);
  }

  // Test 5: Get Clients
  console.log('\n5️⃣  اختبار جلب العملاء...');
  try {
    const result = await makeRequest('/api/clients?ownerUserId=1');
    if (result.status === 200) {
      console.log('   ✅ تم جلب العملاء بنجاح');
      console.log(`   📊 عدد العملاء: ${result.data.count || 0}`);
    } else {
      console.log('   ❌ فشل:', result.data);
    }
  } catch (error) {
    console.log('   ❌ خطأ:', error.message);
  }

  // Test 6: Sync Endpoint
  console.log('\n6️⃣  اختبار endpoint المزامنة...');
  try {
    const syncData = {
      userUuid: 'test-sync-' + Date.now(),
      fullName: 'مزامنة تجريبية',
      phoneNumber: '07701234569',
      jobTitle: 'مطور',
      passwordHash: 'test_hash',
      passwordSalt: 'test_salt',
      accountNumber: Math.floor(Math.random() * 1000000),
      syncVersion: 1
    };
    
    const result = await makeRequest('/api/users/sync', 'PUT', syncData);
    if (result.status === 200 && result.data.success) {
      console.log('   ✅ المزامنة نجحت');
      console.log(`   📝 Action: ${result.data.action}`);
    } else {
      console.log('   ⚠️  المزامنة:', result.data);
    }
  } catch (error) {
    console.log('   ❌ خطأ:', error.message);
  }

  console.log('\n✅ اكتملت جميع الاختبارات!');
}

// تشغيل الاختبارات
runTests().catch(console.error);

