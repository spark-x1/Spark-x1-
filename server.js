const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Create logs directory
if (!fs.existsSync('./logs')) fs.mkdirSync('./logs');

// Logger function
const log = (message, type = 'INFO') => {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${type}] ${message}\n`;
  console.log(logLine.trim());
  fs.appendFileSync('./logs/app.log', logLine);
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '/')));

log('🚀 AmonTech1 API Starting...', 'INFO');
log(`📡 Port: ${PORT}`, 'INFO');

let db = null;

// ============================================
// TIDB CLOUD DATABASE CONNECTION
// ============================================
async function connectDatabase() {
  try {
    log('📦 Connecting to TiDB Cloud...', 'INFO');
    log(`   Host: ${process.env.DB_HOST}`, 'INFO');
    log(`   User: ${process.env.DB_USER}`, 'INFO');
    log(`   Database: ${process.env.DB_NAME}`, 'INFO');
    
    db = await mysql.createPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 30000,
      enableKeepAlive: true,
      ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: false
      }
    });
    
    await db.query('SELECT 1');
    log('✅ TiDB Cloud connected successfully!', 'SUCCESS');
    
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
        status ENUM('active', 'inactive', 'pending') DEFAULT 'active',
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
        session_id VARCHAR(100),
        expires_at TIMESTAMP,
        status ENUM('active', 'expired', 'suspended') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user_id (user_id)
      )
    `);
    
    // Create transactions table
    await db.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT,
        transaction_type VARCHAR(50),
        result_code INT,
        result_desc VARCHAR(255),
        amount INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
      )
    `);
    
    // Create admin user if not exists
    const [admins] = await db.query('SELECT * FROM users WHERE role = "admin" LIMIT 1');
    if (admins.length === 0) {
      const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
      await db.query(
        'INSERT INTO users (username, password, name, email, phone, role, balance) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['admin', hashedPassword, 'Super Admin', process.env.ADMIN_EMAIL, process.env.ADMIN_PHONE, 'admin', 10000]
      );
      log('✅ Admin user created: admin / admin123', 'SUCCESS');
    }
    
    log('✅ All tables ready!', 'SUCCESS');
    return true;
    
  } catch (error) {
    log(`❌ Database error: ${error.message}`, 'ERROR');
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
  callbackURL: `${process.env.CALLBACK_URL || `https://${process.env.RENDER_EXTERNAL_URL || 'localhost:' + PORT}`}/api/mpesa/callback`
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
    if (db) {
      await db.query('SELECT 1');
      res.json({ 
        status: 'online', 
        database: 'connected',
        mpesa: MPESA_CONFIG.environment,
        timestamp: new Date().toISOString()
      });
    } else {
      res.json({ status: 'online', database: 'connecting...' });
    }
  } catch (error) {
    res.json({ status: 'online', database: 'error', error: error.message });
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
      user: { id: result.insertId, username, name: name || username, role: 'user', balance: 0 }
    });
    
  } catch (error) {
    log(`Register error: ${error.message}`, 'ERROR');
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
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================
// USER DASHBOARD
// ============================================
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const [user] = await db.query(
      'SELECT id, username, name, email, phone, role, balance FROM users WHERE id = ?',
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
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ============================================
// ADD COINS TO USER (Admin)
// ============================================
app.post('/api/admin/add-coins', auth, isAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;
    
    log(`📝 Adding ${amount} coins to user ${userId}`, 'INFO');
    
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid user ID and amount required' });
    }
    
    const [user] = await db.query('SELECT id, username, balance FROM users WHERE id = ?', [userId]);
    if (user.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    await db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
    
    const [updatedUser] = await db.query('SELECT balance FROM users WHERE id = ?', [userId]);
    
    log(`✅ Added ${amount} coins to ${user[0].username}. New balance: ${updatedUser[0].balance}`, 'SUCCESS');
    
    res.json({
      success: true,
      message: `${amount} coins added to ${user[0].username}`,
      newBalance: updatedUser[0].balance
    });
    
  } catch (error) {
    log(`Add coins error: ${error.message}`, 'ERROR');
    res.status(500).json({ error: 'Failed to add coins: ' + error.message });
  }
});

// ============================================
// DEPLOY BOT (User)
// ============================================
app.post('/api/deploy-bot', auth, async (req, res) => {
  try {
    const { botType, useCoins, phoneNumber } = req.body;
    const BOT_COST = 20;
    
    log(`🤖 Bot deployment request: ${botType}, UseCoins: ${useCoins}, Phone: ${phoneNumber}`, 'INFO');
    
    if (useCoins) {
      const [user] = await db.query('SELECT id, username, balance FROM users WHERE id = ?', [req.user.id]);
      
      if (user.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      if (user[0].balance < BOT_COST) {
        return res.status(400).json({ 
          error: `Insufficient coins! Need ${BOT_COST} coins, you have ${user[0].balance} coins.`,
          currentBalance: user[0].balance,
          needed: BOT_COST - user[0].balance
        });
      }
      
      await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [BOT_COST, req.user.id]);
      
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      
      await db.query(
        'INSERT INTO bot_deployments (user_id, bot_type, expires_at, status) VALUES (?, ?, ?, ?)',
        [req.user.id, botType, expiresAt, 'active']
      );
      
      const orderNumber = `BOT${Date.now()}${Math.floor(Math.random() * 1000)}`;
      await db.query(
        'INSERT INTO orders (order_number, user_id, item_type, item_name, amount, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [orderNumber, req.user.id, 'bot', botType, BOT_COST, 'coins', 'completed']
      );
      
      log(`✅ Bot deployed with coins by user ${user[0].username}`, 'SUCCESS');
      
      res.json({
        success: true,
        message: `${botType} deployed successfully for 7 days!`,
        expiresAt: expiresAt,
        adminWhatsApp: process.env.ADMIN_WHATSAPP || '254759006509'
      });
    } else {
      if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required for M-PESA payment' });
      }
      
      const orderNumber = `BOT${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const [order] = await db.query(
        'INSERT INTO orders (order_number, user_id, item_type, item_name, amount, phone, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [orderNumber, req.user.id, 'bot', botType, BOT_COST, phoneNumber, 'mpesa', 'pending']
      );
      
      let formattedPhone = phoneNumber.replace(/\D/g, '');
      if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
      if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;
      
      const accessToken = await getMpesaAccessToken();
      const timestamp = getTimestamp();
      const password = generatePassword(MPESA_CONFIG.shortcode, MPESA_CONFIG.passkey, timestamp);
      
      const stkRequest = {
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
        TransactionDesc: `${botType} Bot - 7 Days`
      };
      
      const response = await axios.post(MPESA_API.stkPush, stkRequest, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      
      if (response.data.ResponseCode === '0') {
        await db.query(
          'UPDATE orders SET mpesa_checkout_id = ? WHERE id = ?',
          [response.data.CheckoutRequestID, order[0].insertId]
        );
        
        res.json({
          success: true,
          requiresPayment: true,
          message: 'M-PESA STK Push sent. Check your phone to complete payment.',
          checkoutRequestId: response.data.CheckoutRequestID,
          orderNumber: orderNumber
        });
      } else {
        throw new Error(response.data.ResponseDescription);
      }
    }
    
  } catch (error) {
    log(`Deploy bot error: ${error.message}`, 'ERROR');
    res.status(500).json({ error: 'Deployment failed: ' + error.message });
  }
});

// ============================================
// BUY PANEL (User)
// ============================================
app.post('/api/buy-panel', auth, async (req, res) => {
  try {
    const { plan, cost, phoneNumber, useCoins } = req.body;
    
    log(`📝 Panel purchase request: ${plan}, Cost: ${cost}, UseCoins: ${useCoins}, Phone: ${phoneNumber}`, 'INFO');
    
    if (!plan || !cost) {
      return res.status(400).json({ error: 'Plan and cost required' });
    }
    
    if (useCoins) {
      const [user] = await db.query('SELECT id, username, balance, phone FROM users WHERE id = ?', [req.user.id]);
      
      if (user.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      if (user[0].balance < cost) {
        return res.status(400).json({ 
          error: `Insufficient coins! Need ${cost} coins, you have ${user[0].balance} coins.`,
          currentBalance: user[0].balance,
          needed: cost - user[0].balance
        });
      }
      
      await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [cost, req.user.id]);
      
      const orderNumber = `PANEL${Date.now()}${Math.floor(Math.random() * 1000)}`;
      await db.query(
        'INSERT INTO orders (order_number, user_id, item_type, item_name, amount, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [orderNumber, req.user.id, 'panel', plan, cost, 'coins', 'completed']
      );
      
      log(`✅ Panel purchased with coins by user ${user[0].username}`, 'SUCCESS');
      
      res.json({
        success: true,
        message: `Panel purchase successful! Admin will create your credentials and contact you on WhatsApp: ${process.env.ADMIN_WHATSAPP || '254759006509'}`,
        orderNumber: orderNumber,
        adminWhatsApp: process.env.ADMIN_WHATSAPP || '254759006509'
      });
    } else {
      if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required for M-PESA payment' });
      }
      
      const orderNumber = `PANEL${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const [order] = await db.query(
        'INSERT INTO orders (order_number, user_id, item_type, item_name, amount, phone, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [orderNumber, req.user.id, 'panel', plan, cost, phoneNumber, 'mpesa', 'pending']
      );
      
      let formattedPhone = phoneNumber.replace(/\D/g, '');
      if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
      if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;
      
      const accessToken = await getMpesaAccessToken();
      const timestamp = getTimestamp();
      const password = generatePassword(MPESA_CONFIG.shortcode, MPESA_CONFIG.passkey, timestamp);
      
      const stkRequest = {
        BusinessShortCode: MPESA_CONFIG.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(cost),
        PartyA: formattedPhone,
        PartyB: MPESA_CONFIG.shortcode,
        PhoneNumber: formattedPhone,
        CallBackURL: MPESA_CONFIG.callbackURL,
        AccountReference: orderNumber,
        TransactionDesc: `${plan} Panel - AmonTech1`
      };
      
      const response = await axios.post(MPESA_API.stkPush, stkRequest, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      
      if (response.data.ResponseCode === '0') {
        await db.query(
          'UPDATE orders SET mpesa_checkout_id = ? WHERE id = ?',
          [response.data.CheckoutRequestID, order[0].insertId]
        );
        
        res.json({
          success: true,
          requiresPayment: true,
          message: 'M-PESA STK Push sent. Check your phone to complete payment.',
          checkoutRequestId: response.data.CheckoutRequestID,
          orderNumber: orderNumber
        });
      } else {
        throw new Error(response.data.ResponseDescription);
      }
    }
    
  } catch (error) {
    log(`Buy panel error: ${error.message}`, 'ERROR');
    res.status(500).json({ error: 'Purchase failed: ' + error.message });
  }
});

// ============================================
// M-PESA CALLBACK (Webhook)
// ============================================
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    log('📞 M-PESA Callback received', 'INFO');
    
    const { Body } = req.body;
    const { stkCallback } = Body;
    
    const [orders] = await db.query('SELECT * FROM orders WHERE mpesa_checkout_id = ?', [stkCallback.CheckoutRequestID]);
    
    if (orders.length > 0) {
      const order = orders[0];
      
      if (stkCallback.ResultCode === 0) {
        let receiptNumber = '';
        if (stkCallback.CallbackMetadata && stkCallback.CallbackMetadata.Item) {
          const receiptItem = stkCallback.CallbackMetadata.Item.find(i => i.Name === 'MpesaReceiptNumber');
          if (receiptItem) receiptNumber = receiptItem.Value;
        }
        
        await db.query(
          'UPDATE orders SET payment_status = "completed", mpesa_receipt = ? WHERE id = ?',
          [receiptNumber, order.id]
        );
        
        if (order.item_type === 'coins') {
          await db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [order.amount, order.user_id]);
          log(`✅ Added ${order.amount} coins to user ${order.user_id}`, 'SUCCESS');
        } else if (order.item_type === 'bot') {
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 7);
          await db.query(
            'INSERT INTO bot_deployments (user_id, bot_type, expires_at, status) VALUES (?, ?, ?, ?)',
            [order.user_id, order.item_name, expiresAt, 'active']
          );
          log(`✅ Bot deployed for user ${order.user_id}`, 'SUCCESS');
        }
        
        log(`✅ Payment completed for order ${order.order_number}`, 'SUCCESS');
      } else {
        await db.query('UPDATE orders SET payment_status = "failed" WHERE id = ?', [order.id]);
        log(`❌ Payment failed: ${stkCallback.ResultDesc}`, 'ERROR');
      }
    }
    
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    log(`Callback error: ${error.message}`, 'ERROR');
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
    const [orderStats] = await db.query('SELECT COUNT(*) as total, COALESCE(SUM(amount), 0) as revenue FROM orders WHERE payment_status = "completed"');
    const [totalBalance] = await db.query('SELECT SUM(balance) as total FROM users');
    
    res.json({
      totalUsers: userCount[0].total,
      totalPanels: panelCount[0].total,
      totalDeployments: deploymentCount[0].total,
      totalOrders: orderStats[0].total,
      totalRevenue: orderStats[0].revenue,
      totalCoinsInCirculation: totalBalance[0].total || 0
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
║  💳 M-PESA: ${MPESA_CONFIG.environment.toUpperCase()} Mode        ║
║  👤 Admin: admin / admin123                                       ║
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
