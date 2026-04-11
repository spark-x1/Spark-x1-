const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '/')));

console.log('🚀 AmonTech1 API Starting...');
console.log(`📡 Port: ${PORT}`);

let db = null;

// ============================================
// DATABASE CONNECTION
// ============================================
async function connectDatabase() {
  try {
    console.log('📦 Connecting to TiDB Cloud...');
    console.log(`   Host: ${process.env.DB_HOST}`);
    console.log(`   User: ${process.env.DB_USER}`);
    console.log(`   Database: ${process.env.DB_NAME}`);
    
    db = await mysql.createPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 30000,
      ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: false
      }
    });
    
    await db.query('SELECT 1');
    console.log('✅ TiDB Cloud connected successfully!');
    
    // Create database if not exists
    await db.query(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME}`);
    await db.query(`USE ${process.env.DB_NAME}`);
    
    // Create users table
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(100),
        email VARCHAR(100),
        phone VARCHAR(20),
        role ENUM('user', 'admin') DEFAULT 'user',
        balance INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_username (username),
        INDEX idx_role (role)
      )
    `);
    
    // Create panel_credentials table
    await db.query(`
      CREATE TABLE IF NOT EXISTS panel_credentials (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        password VARCHAR(255) NOT NULL,
        plan VARCHAR(50),
        user_id INT,
        status ENUM('active', 'inactive') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_user_id (user_id)
      )
    `);
    
    // Create orders table
    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_number VARCHAR(50) UNIQUE,
        user_id INT,
        item_type VARCHAR(50),
        item_name VARCHAR(100),
        amount INT,
        phone VARCHAR(20),
        payment_method VARCHAR(20) DEFAULT 'mpesa',
        payment_status ENUM('pending', 'completed', 'failed') DEFAULT 'pending',
        mpesa_checkout_id VARCHAR(100),
        mpesa_receipt VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_order_number (order_number),
        INDEX idx_payment_status (payment_status)
      )
    `);
    
    // Create bot_deployments table
    await db.query(`
      CREATE TABLE IF NOT EXISTS bot_deployments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        bot_type VARCHAR(50),
        expires_at TIMESTAMP,
        status ENUM('active', 'expired') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user_id (user_id)
      )
    `);
    
    // Create admin user if not exists
    const [admins] = await db.query('SELECT * FROM users WHERE role = "admin" LIMIT 1');
    if (admins.length === 0) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await db.query(
        'INSERT INTO users (username, password, name, email, phone, role, balance) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['admin', hashedPassword, 'Super Admin', 'sparkxtechnologies254@gmail.com', '254759006509', 'admin', 10000]
      );
      console.log('✅ Admin user created: admin / admin123');
    }
    
    // Create test user if not exists
    const [testUser] = await db.query('SELECT * FROM users WHERE username = "testuser" LIMIT 1');
    if (testUser.length === 0) {
      const hashedPassword = await bcrypt.hash('test123', 10);
      await db.query(
        'INSERT INTO users (username, password, name, phone, role, balance) VALUES (?, ?, ?, ?, ?, ?)',
        ['testuser', hashedPassword, 'Test User', '254712345678', 'user', 500]
      );
      console.log('✅ Test user created: testuser / test123');
    }
    
    console.log('✅ All tables ready!');
    return true;
    
  } catch (error) {
    console.error('❌ Database error:', error.message);
    return false;
  }
}

// ============================================
// M-PESA CONFIGURATION
// ============================================
const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  passkey: process.env.MPESA_PASSKEY,
  shortcode: process.env.MPESA_SHORTCODE,
  environment: process.env.MPESA_ENVIRONMENT || 'sandbox',
  callbackURL: `${process.env.CALLBACK_URL || 'https://your-app.onrender.com'}/api/mpesa/callback`
};

async function getMpesaAccessToken() {
  try {
    const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
    const url = MPESA_CONFIG.environment === 'sandbox' 
      ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
      : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    
    const response = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` }
    });
    console.log('✅ M-PESA token obtained');
    return response.data.access_token;
  } catch (error) {
    console.error('❌ M-PESA Token Error:', error.response?.data || error.message);
    throw error;
  }
}

function getTimestamp() {
  const date = new Date();
  return date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0') +
    String(date.getHours()).padStart(2, '0') +
    String(date.getMinutes()).padStart(2, '0') +
    String(date.getSeconds()).padStart(2, '0');
}

// ============================================
// SERVE HTML PAGES
// ============================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/user.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'user.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/panel.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.html'));
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'online', database: 'connected', timestamp: new Date() });
  } catch (error) {
    res.json({ status: 'online', database: 'connecting...' });
  }
});

// ============================================
// AUTH MIDDLEWARE
// ============================================
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ============================================
// REGISTER
// ============================================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, name, phone } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      'INSERT INTO users (username, password, name, phone, balance) VALUES (?, ?, ?, ?, ?)',
      [username, hashedPassword, name || username, phone || null, 0]
    );
    
    const token = jwt.sign(
      { id: result.insertId, username, role: 'user' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        id: result.insertId,
        username,
        name: name || username,
        role: 'user',
        balance: 0
      }
    });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ============================================
// LOGIN
// ============================================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const [users] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        balance: user.balance
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================
// USER DASHBOARD
// ============================================
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const [user] = await db.query(
      'SELECT id, username, name, phone, role, balance FROM users WHERE id = ?',
      [req.user.id]
    );
    
    const [panels] = await db.query(
      'SELECT id, username, plan, status, created_at FROM panel_credentials WHERE user_id = ?',
      [req.user.id]
    );
    
    const [deployments] = await db.query(
      'SELECT id, bot_type, status, expires_at, created_at FROM bot_deployments WHERE user_id = ?',
      [req.user.id]
    );
    
    res.json({
      user: user[0],
      panels: panels,
      deployments: deployments,
      stats: {
        totalBots: deployments.length,
        activeBots: deployments.filter(d => d.status === 'active').length,
        totalPanels: panels.length
      }
    });
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ============================================
// ADD COINS TO USER (ADMIN) - FIXED
// ============================================
app.post('/api/admin/add-coins', auth, isAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;
    
    console.log(`📝 Admin adding ${amount} coins to user ID: ${userId}`);
    
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid user ID and amount required' });
    }
    
    // Check if user exists
    const [users] = await db.query('SELECT id, username, balance FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = users[0];
    const oldBalance = user.balance;
    const newBalance = oldBalance + parseInt(amount);
    
    // Update balance
    await db.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
    
    // Verify update
    const [updated] = await db.query('SELECT balance FROM users WHERE id = ?', [userId]);
    
    console.log(`✅ Added ${amount} coins to ${user.username}. Old: ${oldBalance}, New: ${updated[0].balance}`);
    
    res.json({
      success: true,
      message: `${amount} coins added to ${user.username}`,
      oldBalance: oldBalance,
      newBalance: updated[0].balance,
      userId: userId
    });
    
  } catch (error) {
    console.error('Add coins error:', error);
    res.status(500).json({ error: 'Failed to add coins: ' + error.message });
  }
});

// ============================================
// DEPLOY BOT
// ============================================
app.post('/api/deploy-bot', auth, async (req, res) => {
  try {
    const { botType, useCoins, phoneNumber } = req.body;
    const BOT_COST = 20;
    
    console.log(`🤖 Bot deployment: ${botType}, useCoins: ${useCoins}`);
    
    if (useCoins) {
      const [user] = await db.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
      
      if (user[0].balance < BOT_COST) {
        return res.status(400).json({
          error: `Insufficient coins! Need ${BOT_COST} coins, you have ${user[0].balance} coins.`
        });
      }
      
      await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [BOT_COST, req.user.id]);
      
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      
      await db.query(
        'INSERT INTO bot_deployments (user_id, bot_type, expires_at, status) VALUES (?, ?, ?, ?)',
        [req.user.id, botType, expiresAt, 'active']
      );
      
      const orderNumber = `BOT${Date.now()}`;
      await db.query(
        'INSERT INTO orders (order_number, user_id, item_type, item_name, amount, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [orderNumber, req.user.id, 'bot', botType, BOT_COST, 'coins', 'completed']
      );
      
      res.json({
        success: true,
        message: `${botType} deployed successfully for 7 days!`,
        adminWhatsApp: '254759006509'
      });
    } else {
      if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required for M-PESA payment' });
      }
      
      const orderNumber = `BOT${Date.now()}`;
      await db.query(
        'INSERT INTO orders (order_number, user_id, item_type, item_name, amount, phone, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [orderNumber, req.user.id, 'bot', botType, BOT_COST, phoneNumber, 'mpesa', 'pending']
      );
      
      const token = await getMpesaAccessToken();
      const timestamp = getTimestamp();
      const password = Buffer.from(`${MPESA_CONFIG.shortcode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');
      
      let formattedPhone = phoneNumber.replace(/\D/g, '');
      if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
      if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;
      
      const stkUrl = MPESA_CONFIG.environment === 'sandbox'
        ? 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
        : 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
      
      const response = await axios.post(stkUrl, {
        BusinessShortCode: MPESA_CONFIG.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: BOT_COST,
        PartyA: formattedPhone,
        PartyB: MPESA_CONFIG.shortcode,
        PhoneNumber: formattedPhone,
        CallBackURL: MPESA_CONFIG.callbackURL,
        AccountReference: orderNumber,
        TransactionDesc: `${botType} Bot Deployment`
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (response.data.ResponseCode === '0') {
        await db.query('UPDATE orders SET mpesa_checkout_id = ? WHERE order_number = ?', [response.data.CheckoutRequestID, orderNumber]);
        res.json({
          success: true,
          requiresPayment: true,
          message: 'M-PESA STK Push sent. Check your phone.',
          orderNumber: orderNumber
        });
      } else {
        throw new Error(response.data.ResponseDescription);
      }
    }
  } catch (error) {
    console.error('Deploy error:', error.message);
    res.status(500).json({ error: 'Deployment failed: ' + error.message });
  }
});

// ============================================
// BUY PANEL
// ============================================
app.post('/api/buy-panel', auth, async (req, res) => {
  try {
    const { plan, cost, useCoins, phoneNumber } = req.body;
    
    console.log(`📝 Panel purchase: ${plan}, cost: ${cost}, useCoins: ${useCoins}`);
    
    if (useCoins) {
      const [user] = await db.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
      
      if (user[0].balance < cost) {
        return res.status(400).json({
          error: `Insufficient coins! Need ${cost} coins, you have ${user[0].balance} coins.`
        });
      }
      
      await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [cost, req.user.id]);
      
      const orderNumber = `PANEL${Date.now()}`;
      await db.query(
        'INSERT INTO orders (order_number, user_id, item_type, item_name, amount, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [orderNumber, req.user.id, 'panel', plan, cost, 'coins', 'completed']
      );
      
      res.json({
        success: true,
        message: `Panel purchase successful! Admin will contact you on WhatsApp: 254759006509`,
        adminWhatsApp: '254759006509'
      });
    } else {
      if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required for M-PESA payment' });
      }
      
      const orderNumber = `PANEL${Date.now()}`;
      await db.query(
        'INSERT INTO orders (order_number, user_id, item_type, item_name, amount, phone, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [orderNumber, req.user.id, 'panel', plan, cost, phoneNumber, 'mpesa', 'pending']
      );
      
      const token = await getMpesaAccessToken();
      const timestamp = getTimestamp();
      const password = Buffer.from(`${MPESA_CONFIG.shortcode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');
      
      let formattedPhone = phoneNumber.replace(/\D/g, '');
      if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
      if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;
      
      const stkUrl = MPESA_CONFIG.environment === 'sandbox'
        ? 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
        : 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
      
      const response = await axios.post(stkUrl, {
        BusinessShortCode: MPESA_CONFIG.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: cost,
        PartyA: formattedPhone,
        PartyB: MPESA_CONFIG.shortcode,
        PhoneNumber: formattedPhone,
        CallBackURL: MPESA_CONFIG.callbackURL,
        AccountReference: orderNumber,
        TransactionDesc: `${plan} Panel Purchase`
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (response.data.ResponseCode === '0') {
        await db.query('UPDATE orders SET mpesa_checkout_id = ? WHERE order_number = ?', [response.data.CheckoutRequestID, orderNumber]);
        res.json({
          success: true,
          requiresPayment: true,
          message: 'M-PESA STK Push sent. Check your phone.',
          orderNumber: orderNumber
        });
      } else {
        throw new Error(response.data.ResponseDescription);
      }
    }
  } catch (error) {
    console.error('Buy panel error:', error.message);
    res.status(500).json({ error: 'Purchase failed: ' + error.message });
  }
});

// ============================================
// M-PESA CALLBACK
// ============================================
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    console.log('📞 M-PESA Callback received');
    const { Body } = req.body;
    const { stkCallback } = Body;
    
    const [orders] = await db.query('SELECT * FROM orders WHERE mpesa_checkout_id = ?', [stkCallback.CheckoutRequestID]);
    
    if (orders.length > 0) {
      const order = orders[0];
      
      if (stkCallback.ResultCode === 0) {
        // Payment successful
        let receiptNumber = '';
        if (stkCallback.CallbackMetadata && stkCallback.CallbackMetadata.Item) {
          const receiptItem = stkCallback.CallbackMetadata.Item.find(i => i.Name === 'MpesaReceiptNumber');
          if (receiptItem) receiptNumber = receiptItem.Value;
        }
        
        await db.query('UPDATE orders SET payment_status = "completed", mpesa_receipt = ? WHERE id = ?', [receiptNumber, order.id]);
        
        // If it's a bot deployment, create it
        if (order.item_type === 'bot') {
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 7);
          await db.query(
            'INSERT INTO bot_deployments (user_id, bot_type, expires_at, status) VALUES (?, ?, ?, ?)',
            [order.user_id, order.item_name, expiresAt, 'active']
          );
          console.log(`✅ Bot deployed for user ${order.user_id}`);
        }
        
        console.log(`✅ Payment completed for order ${order.order_number}`);
      } else {
        await db.query('UPDATE orders SET payment_status = "failed" WHERE id = ?', [order.id]);
        console.log(`❌ Payment failed: ${stkCallback.ResultDesc}`);
      }
    }
    
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    console.error('Callback error:', error);
    res.json({ ResultCode: 1, ResultDesc: 'Failed' });
  }
});

// ============================================
// ADMIN - GET ALL USERS
// ============================================
app.get('/api/admin/users', auth, isAdmin, async (req, res) => {
  try {
    const [users] = await db.query(
      'SELECT id, username, name, email, phone, role, balance, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ============================================
// ADMIN - GET ALL PANEL CREDENTIALS
// ============================================
app.get('/api/admin/panels', auth, isAdmin, async (req, res) => {
  try {
    const [panels] = await db.query(`
      SELECT pc.*, u.username as owner_name, u.id as owner_id
      FROM panel_credentials pc 
      LEFT JOIN users u ON pc.user_id = u.id 
      ORDER BY pc.created_at DESC
    `);
    
    const safePanels = panels.map(p => ({
      ...p,
      password_display: '••••••••'
    }));
    
    res.json({ panels: safePanels });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch panels' });
  }
});

// ============================================
// ADMIN - CREATE PANEL CREDENTIALS
// ============================================
app.post('/api/admin/create-panel', auth, isAdmin, async (req, res) => {
  try {
    const { panelUsername, panelPassword, plan, userId } = req.body;
    
    if (!panelUsername || !panelPassword) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const hashedPassword = await bcrypt.hash(panelPassword, 10);
    const [result] = await db.query(
      'INSERT INTO panel_credentials (username, password, plan, user_id, status) VALUES (?, ?, ?, ?, ?)',
      [panelUsername, hashedPassword, plan || 'Starter', userId || null, 'active']
    );
    
    res.json({
      success: true,
      message: 'Panel credentials created',
      panel: {
        id: result.insertId,
        username: panelUsername,
        password: panelPassword,
        plan: plan || 'Starter'
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to create panel: ' + error.message });
  }
});

// ============================================
// ADMIN - DELETE PANEL CREDENTIAL
// ============================================
app.delete('/api/admin/panels/:id', auth, isAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM panel_credentials WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Panel credential deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete panel' });
  }
});

// ============================================
// ADMIN - GET ALL ORDERS
// ============================================
app.get('/api/admin/orders', auth, isAdmin, async (req, res) => {
  try {
    const [orders] = await db.query(`
      SELECT o.*, u.username as user_name 
      FROM orders o 
      LEFT JOIN users u ON o.user_id = u.id 
      ORDER BY o.created_at DESC
      LIMIT 100
    `);
    res.json({ orders });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ============================================
// ADMIN - GET STATS
// ============================================
app.get('/api/admin/stats', auth, isAdmin, async (req, res) => {
  try {
    const [userCount] = await db.query('SELECT COUNT(*) as total FROM users');
    const [panelCount] = await db.query('SELECT COUNT(*) as total FROM panel_credentials');
    const [deploymentCount] = await db.query('SELECT COUNT(*) as total FROM bot_deployments');
    const [totalBalance] = await db.query('SELECT SUM(balance) as total FROM users');
    const [revenue] = await db.query('SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE payment_status = "completed"');
    
    res.json({
      totalUsers: userCount[0].total,
      totalPanels: panelCount[0].total,
      totalDeployments: deploymentCount[0].total,
      totalCoinsInCirculation: totalBalance[0].total || 0,
      totalRevenue: revenue[0].total || 0
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============================================
// 404 HANDLER
// ============================================
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

// ============================================
// START SERVER
// ============================================
connectDatabase().then((connected) => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    🚀 AMONTECH1 API RUNNING                       ║
╠══════════════════════════════════════════════════════════════════╣
║  ✅ Server: http://localhost:${PORT}                              ║
║  🗄️  Database: TiDB Cloud ${connected ? '✅' : '❌'}                ║
║  💳 M-PESA: ${process.env.MPESA_ENVIRONMENT || 'sandbox'} Mode     ║
║  👤 Admin: admin / admin123                                       ║
║  🧪 Test: testuser / test123                                      ║
╠══════════════════════════════════════════════════════════════════╣
║  📄 Pages:                                                        ║
║     - Main:  http://localhost:${PORT}/                            ║
║     - User:  http://localhost:${PORT}/user.html                   ║
║     - Admin: http://localhost:${PORT}/admin.html                  ║
║     - Panel: http://localhost:${PORT}/panel.html                  ║
╚══════════════════════════════════════════════════════════════════╝
    `);
  });
});
