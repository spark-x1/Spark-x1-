// ============================================
// BWM XMD PRO - FULL BACKEND WITH TIDB CLOUD
// Your Actual Database: gateway01.eu-central-1.prod.aws.tidbcloud.com
// ============================================
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create logs directory
if (!fs.existsSync('./logs')) fs.mkdirSync('./logs');

// Simple logger
const log = (message, type = 'INFO') => {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${type}] ${message}\n`;
  console.log(logLine);
  fs.appendFileSync('./logs/app.log', logLine);
};

// ============================================
// TIDB CLOUD DATABASE CONNECTION
// Credentials: 4HYdV5eyM4qXEbe.root / 3njP9WzOxD2rl6JD
// ============================================
let db;

async function initDatabase() {
  try {
    // Create connection pool to TiDB Cloud
    db = await mysql.createPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT) || 4000,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'bwm_xmd_pro',
      waitForConnections: true,
      connectionLimit: 10,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: false  // For TiDB Cloud
      }
    });
    
    log(`✅ TiDB Cloud connected successfully!`, 'SUCCESS');
    log(`📍 Host: ${process.env.DB_HOST}:${process.env.DB_PORT}`, 'INFO');
    log(`👤 User: ${process.env.DB_USER}`, 'INFO');
    
    // Create database if not exists
    await db.execute(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME || 'bwm_xmd_pro'}`);
    await db.execute(`USE ${process.env.DB_NAME || 'bwm_xmd_pro'}`);
    
    log(`📦 Using database: ${process.env.DB_NAME || 'bwm_xmd_pro'}`, 'INFO');
    
    // Create all tables
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE,
        phone VARCHAR(20),
        role ENUM('user', 'admin') DEFAULT 'user',
        balance DECIMAL(10,2) DEFAULT 0,
        referral_code VARCHAR(20),
        referred_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_username (username),
        INDEX idx_email (email),
        INDEX idx_role (role)
      )
    `);
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS panel_credentials (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        password VARCHAR(255) NOT NULL,
        plan VARCHAR(50),
        user_id INT,
        panel_status ENUM('active', 'suspended', 'pending') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_user_id (user_id),
        INDEX idx_status (panel_status)
      )
    `);
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_number VARCHAR(50) UNIQUE NOT NULL,
        user_id INT,
        plan VARCHAR(50),
        amount DECIMAL(10,2),
        phone_number VARCHAR(20),
        payment_method VARCHAR(20) DEFAULT 'mpesa',
        payment_status ENUM('pending', 'completed', 'failed') DEFAULT 'pending',
        mpesa_checkout_id VARCHAR(100),
        mpesa_receipt VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_order_number (order_number),
        INDEX idx_payment_status (payment_status),
        INDEX idx_created_at (created_at)
      )
    `);
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT,
        transaction_type VARCHAR(50),
        result_code INT,
        result_desc VARCHAR(255),
        amount DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
        INDEX idx_order_id (order_id)
      )
    `);
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS bots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        bot_type ENUM('nova', 'benzo') DEFAULT 'nova',
        session_id VARCHAR(100),
        pair_code VARCHAR(20),
        status ENUM('active', 'inactive') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user_id (user_id),
        INDEX idx_status (status)
      )
    `);
    
    // Create default admin user if not exists
    const [admins] = await db.execute('SELECT * FROM users WHERE role = "admin" LIMIT 1');
    if (admins.length === 0) {
      const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
      await db.execute(
        'INSERT INTO users (username, password, name, email, phone, role, balance) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['admin', hashedPassword, 'Super Admin', process.env.ADMIN_EMAIL, process.env.ADMIN_PHONE, 'admin', 10000]
      );
      log('✅ Default admin user created (username: admin, password: admin123)', 'SUCCESS');
    }
    
    // Create test user for development
    const [testUser] = await db.execute('SELECT * FROM users WHERE username = "testuser" LIMIT 1');
    if (testUser.length === 0) {
      const hashedPassword = await bcrypt.hash('test123', 10);
      await db.execute(
        'INSERT INTO users (username, password, name, email, phone, role) VALUES (?, ?, ?, ?, ?, ?)',
        ['testuser', hashedPassword, 'Test User', 'test@example.com', '254712345678', 'user']
      );
      log('✅ Test user created (username: testuser, password: test123)', 'SUCCESS');
    }
    
    log('✅ All tables created/verified successfully', 'SUCCESS');
    
  } catch (error) {
    log(`❌ TiDB Cloud connection error: ${error.message}`, 'ERROR');
    log(`Please check your credentials and network connection`, 'ERROR');
    process.exit(1);
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

const MPESA_API = {
  auth: MPESA_CONFIG.environment === 'sandbox' 
    ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
    : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
  stkPush: MPESA_CONFIG.environment === 'sandbox'
    ? 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
    : 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
  query: MPESA_CONFIG.environment === 'sandbox'
    ? 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query'
    : 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query'
};

async function getMpesaAccessToken() {
  try {
    const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
    const response = await axios.get(MPESA_API.auth, {
      headers: { Authorization: `Basic ${auth}` }
    });
    log('✅ M-PESA access token obtained', 'SUCCESS');
    return response.data.access_token;
  } catch (error) {
    log(`❌ M-PESA Token Error: ${error.response?.data?.errorMessage || error.message}`, 'ERROR');
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

function generatePassword(shortcode, passkey, timestamp) {
  const str = shortcode + passkey + timestamp;
  return Buffer.from(str).toString('base64');
}

// ============================================
// JWT MIDDLEWARE
// ============================================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ============================================
// API ROUTES
// ============================================

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const [result] = await db.execute('SELECT NOW() as time, DATABASE() as db');
    res.json({ 
      status: 'online', 
      database: 'connected',
      timestamp: new Date(),
      db_time: result[0].time,
      db_name: result[0].db
    });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected', error: error.message });
  }
});

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, name, email, phone } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.execute(
      'INSERT INTO users (username, password, name, email, phone) VALUES (?, ?, ?, ?, ?)',
      [username, hashedPassword, name || username, email || null, phone || null]
    );
    
    const token = jwt.sign(
      { id: result.insertId, username, role: 'user' }, 
      process.env.JWT_SECRET, 
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );
    
    log(`New user registered: ${username}`, 'INFO');
    res.status(201).json({ 
      message: 'Registration successful', 
      token, 
      user: { id: result.insertId, username, name: name || username, role: 'user' } 
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [users] = await db.execute('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role }, 
      process.env.JWT_SECRET, 
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );
    
    log(`User logged in: ${user.username}`, 'INFO');
    res.json({ 
      message: 'Login successful', 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        name: user.name, 
        email: user.email, 
        role: user.role, 
        balance: user.balance,
        phone: user.phone 
      } 
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get user dashboard
app.get('/api/user/dashboard', authenticateToken, async (req, res) => {
  try {
    const [bots] = await db.execute('SELECT * FROM bots WHERE user_id = ?', [req.user.id]);
    const [panels] = await db.execute('SELECT id, username, plan, panel_status, created_at FROM panel_credentials WHERE user_id = ?', [req.user.id]);
    const [user] = await db.execute('SELECT id, username, name, email, phone, balance FROM users WHERE id = ?', [req.user.id]);
    
    res.json({ 
      user: user[0], 
      totalBots: bots.length, 
      activePanels: panels.length, 
      panels,
      bots
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// M-PESA STK Push (Initiate Payment)
app.post('/api/mpesa/stkpush', authenticateToken, async (req, res) => {
  try {
    const { amount, phoneNumber, plan } = req.body;
    
    if (!amount || !phoneNumber || !plan) {
      return res.status(400).json({ error: 'Amount, phone number and plan required' });
    }
    
    // Format phone number
    let formattedPhone = phoneNumber.replace(/\D/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
    if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;
    
    // Create order
    const orderNumber = `AMON${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const [order] = await db.execute(
      'INSERT INTO orders (order_number, user_id, plan, amount, phone_number, payment_status) VALUES (?, ?, ?, ?, ?, ?)',
      [orderNumber, req.user.id, plan, amount, formattedPhone, 'pending']
    );
    
    // Get M-PESA token and send STK Push
    const accessToken = await getMpesaAccessToken();
    const timestamp = getTimestamp();
    const password = generatePassword(MPESA_CONFIG.shortcode, MPESA_CONFIG.passkey, timestamp);
    
    const stkRequest = {
      BusinessShortCode: MPESA_CONFIG.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: MPESA_CONFIG.shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: MPESA_CONFIG.callbackURL,
      AccountReference: orderNumber,
      TransactionDesc: `Amon Panel - ${plan} Plan`
    };
    
    const response = await axios.post(MPESA_API.stkPush, stkRequest, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    if (response.data.ResponseCode === '0') {
      await db.execute(
        'UPDATE orders SET mpesa_checkout_id = ? WHERE id = ?',
        [response.data.CheckoutRequestID, order[0].insertId]
      );
      
      log(`STK Push sent for order ${orderNumber} to ${formattedPhone}`, 'INFO');
      res.json({
        success: true,
        message: 'STK Push sent. Check your phone for M-PESA prompt.',
        checkoutRequestId: response.data.CheckoutRequestID,
        orderNumber: orderNumber,
        amount: amount
      });
    } else {
      throw new Error(response.data.ResponseDescription);
    }
    
  } catch (error) {
    log(`STK Push Error: ${error.message}`, 'ERROR');
    res.status(500).json({ 
      success: false, 
      error: 'Payment initiation failed. Please try again.' 
    });
  }
});

// M-PESA Callback (Webhook)
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    log('M-PESA Callback received', 'INFO');
    
    const { Body } = req.body;
    const { stkCallback } = Body;
    
    const [orders] = await db.execute('SELECT * FROM orders WHERE mpesa_checkout_id = ?', [stkCallback.CheckoutRequestID]);
    
    if (orders.length > 0) {
      const order = orders[0];
      
      if (stkCallback.ResultCode === 0) {
        await db.execute('UPDATE orders SET payment_status = "completed" WHERE id = ?', [order.id]);
        log(`✅ Payment completed for order ${order.order_number}`, 'SUCCESS');
      } else {
        await db.execute('UPDATE orders SET payment_status = "failed" WHERE id = ?', [order.id]);
        log(`❌ Payment failed for order ${order.order_number}: ${stkCallback.ResultDesc}`, 'ERROR');
      }
    }
    
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    log(`Callback error: ${error.message}`, 'ERROR');
    res.json({ ResultCode: 1, ResultDesc: 'Failed' });
  }
});

// Admin: Create panel credentials
app.post('/api/admin/create-panel', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { panelUsername, panelPassword, plan, userId } = req.body;
    
    if (!panelUsername || !panelPassword) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const hashedPanelPass = await bcrypt.hash(panelPassword, 10);
    const [result] = await db.execute(
      'INSERT INTO panel_credentials (username, password, plan, user_id, panel_status) VALUES (?, ?, ?, ?, ?)',
      [panelUsername, hashedPanelPass, plan || 'Starter', userId || null, 'active']
    );
    
    log(`Admin created panel credentials for ${panelUsername}`, 'INFO');
    res.json({ 
      message: 'Panel credentials created successfully', 
      panel: { 
        id: result.insertId, 
        username: panelUsername, 
        plan: plan || 'Starter',
        panelUrl: 'https://amon-panel.yourdomain.com'
      } 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create panel credentials' });
  }
});

// Admin: Get all users
app.get('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [users] = await db.execute(`
      SELECT id, username, name, email, phone, role, balance, created_at 
      FROM users 
      ORDER BY created_at DESC
    `);
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Admin: Get all orders
app.get('/api/admin/orders', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [orders] = await db.execute(`
      SELECT o.*, u.username as user_name, u.name as user_fullname
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

// Admin: Get dashboard stats
app.get('/api/admin/stats', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [userCount] = await db.execute('SELECT COUNT(*) as total FROM users');
    const [adminCount] = await db.execute('SELECT COUNT(*) as total FROM users WHERE role = "admin"');
    const [orderStats] = await db.execute('SELECT COUNT(*) as total, COALESCE(SUM(amount), 0) as revenue FROM orders WHERE payment_status = "completed"');
    const [pendingOrders] = await db.execute('SELECT COUNT(*) as total FROM orders WHERE payment_status = "pending"');
    const [panelCount] = await db.execute('SELECT COUNT(*) as total FROM panel_credentials');
    const [activePanels] = await db.execute('SELECT COUNT(*) as total FROM panel_credentials WHERE panel_status = "active"');
    
    res.json({
      totalUsers: userCount[0].total,
      totalAdmins: adminCount[0].total,
      totalRevenue: orderStats[0].revenue,
      totalOrders: orderStats[0].total,
      pendingOrders: pendingOrders[0].total,
      totalPanels: panelCount[0].total,
      activePanels: activePanels[0].total
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, async () => {
  await initDatabase();
  log(`
╔════════════════════════════════════════════════════════════╗
║                    BWM XMD PRO SERVER                       ║
╠════════════════════════════════════════════════════════════╣
║ 🚀 Server: http://localhost:${PORT}                         ║
║ 📡 M-PESA: ${MPESA_CONFIG.environment.toUpperCase()} mode    ║
║ 🗄️  Database: TiDB Cloud (Europe)                          ║
║ 👤 Admin: admin / admin123                                  ║
║ 🧪 Test: testuser / test123                                 ║
╚════════════════════════════════════════════════════════════╝
  `, 'SUCCESS');
});

module.exports = app;