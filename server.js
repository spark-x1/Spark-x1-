const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '/'))); // Serve HTML files

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
        bot_type VARCHAR(50),
        plan VARCHAR(50),
        amount INT,
        phone VARCHAR(20),
        status ENUM('pending', 'completed', 'failed') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
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
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
    console.error('Please check your .env file and TiDB Cloud credentials');
    return false;
  }
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
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    } else {
      res.json({ 
        status: 'online', 
        database: 'connecting...',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.json({ 
      status: 'online', 
      database: 'error',
      error: error.message
    });
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
    
    // Check if user exists
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
    res.status(500).json({ error: 'Registration failed: ' + error.message });
  }
});

// ============================================
// LOGIN
// ============================================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const [users] = await db.query(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, username]
    );
    
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
    res.status(500).json({ error: 'Login failed: ' + error.message });
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
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to load dashboard' });
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
// ADMIN - ADD COINS TO USER
// ============================================
app.post('/api/admin/add-coins', auth, isAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;
    
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid user ID and amount required' });
    }
    
    await db.query(
      'UPDATE users SET balance = balance + ? WHERE id = ?',
      [amount, userId]
    );
    
    const [user] = await db.query('SELECT username, balance FROM users WHERE id = ?', [userId]);
    
    res.json({
      success: true,
      message: `${amount} coins added to ${user[0].username}`,
      newBalance: user[0].balance + amount
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to add coins' });
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
    
    // Don't send actual passwords, just placeholder
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
// ADMIN - GET STATS
// ============================================
app.get('/api/admin/stats', auth, isAdmin, async (req, res) => {
  try {
    const [userCount] = await db.query('SELECT COUNT(*) as total FROM users');
    const [adminCount] = await db.query('SELECT COUNT(*) as total FROM users WHERE role = "admin"');
    const [panelCount] = await db.query('SELECT COUNT(*) as total FROM panel_credentials');
    const [deploymentCount] = await db.query('SELECT COUNT(*) as total FROM bot_deployments');
    const [totalBalance] = await db.query('SELECT SUM(balance) as total FROM users');
    
    res.json({
      totalUsers: userCount[0].total,
      totalAdmins: adminCount[0].total,
      totalPanels: panelCount[0].total,
      totalDeployments: deploymentCount[0].total,
      totalRevenue: totalBalance[0].total || 0
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============================================
// DEPLOY BOT (User)
// ============================================
app.post('/api/deploy-bot', auth, async (req, res) => {
  try {
    const { botType, cost } = req.body;
    
    if (!botType || !cost) {
      return res.status(400).json({ error: 'Bot type and cost required' });
    }
    
    // Check user balance
    const [user] = await db.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
    
    if (user[0].balance < cost) {
      return res.status(400).json({ 
        error: `Insufficient balance. Need ${cost} coins, you have ${user[0].balance} coins.`
      });
    }
    
    // Deduct coins
    await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [cost, req.user.id]);
    
    // Create deployment
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days
    
    const [result] = await db.query(
      'INSERT INTO bot_deployments (user_id, bot_type, expires_at, status) VALUES (?, ?, ?, ?)',
      [req.user.id, botType, expiresAt, 'active']
    );
    
    res.json({
      success: true,
      message: `${botType} deployed successfully for 7 days!`,
      deploymentId: result.insertId,
      expiresAt: expiresAt
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Deployment failed: ' + error.message });
  }
});

// ============================================
// BUY PANEL (User)
// ============================================
app.post('/api/buy-panel', auth, async (req, res) => {
  try {
    const { plan, cost } = req.body;
    
    const [user] = await db.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
    
    if (user[0].balance < cost) {
      return res.status(400).json({ 
        error: `Insufficient balance. Need ${cost} coins.`
      });
    }
    
    // Deduct coins
    await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [cost, req.user.id]);
    
    // Create order
    const orderNumber = `PANEL${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await db.query(
      'INSERT INTO orders (order_number, user_id, plan, amount, status) VALUES (?, ?, ?, ?, ?)',
      [orderNumber, req.user.id, plan, cost, 'completed']
    );
    
    res.json({
      success: true,
      message: `Panel purchase successful! Admin will create your credentials and contact you on WhatsApp.`,
      orderNumber: orderNumber
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Purchase failed: ' + error.message });
  }
});

// ============================================
// 404 HANDLER
// ============================================
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
    available_endpoints: [
      'GET /',
      'GET /user.html',
      'GET /admin.html',
      'GET /panel.html',
      'GET /api/health',
      'POST /api/register',
      'POST /api/login',
      'GET /api/dashboard (需要认证)',
      'GET /api/admin/users (需要认证)',
      'GET /api/admin/panels (需要认证)',
      'POST /api/admin/create-panel (需要认证)',
      'POST /api/admin/add-coins (需要认证)',
      'POST /api/deploy-bot (需要认证)',
      'POST /api/buy-panel (需要认证)'
    ]
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
║  🗄️  Database: ${connected ? 'TiDB Cloud ✅' : 'Offline ⚠️'}        ║
║  👤 Admin: admin / admin123                                       ║
║  🧪 Test: testuser / test123                                      ║
╠══════════════════════════════════════════════════════════════════╣
║  📄 Pages:                                                        ║
║     - Main:     http://localhost:${PORT}/                         ║
║     - User:     http://localhost:${PORT}/user.html                ║
║     - Admin:    http://localhost:${PORT}/admin.html               ║
║     - Panel:    http://localhost:${PORT}/panel.html               ║
╚══════════════════════════════════════════════════════════════════╝
    `);
  });
});