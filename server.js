const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

console.log('🚀 AmonTech1 API Starting...');

// ============================================
// SQLITE DATABASE (No configuration needed!)
// ============================================
const db = new sqlite3.Database('./amontech1.db');

// Create tables
db.serialize(() => {
  // Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT,
    phone TEXT,
    role TEXT DEFAULT 'user',
    balance INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Panel credentials table
  db.run(`CREATE TABLE IF NOT EXISTS panel_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    plan TEXT,
    user_id INTEGER,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Orders table
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE,
    user_id INTEGER,
    item_type TEXT,
    item_name TEXT,
    amount INTEGER,
    phone TEXT,
    payment_method TEXT DEFAULT 'coins',
    payment_status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Check if admin exists
  db.get('SELECT * FROM users WHERE role = "admin"', async (err, admin) => {
    if (!admin) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      db.run(`INSERT INTO users (username, password, name, phone, role, balance) VALUES (?, ?, ?, ?, ?, ?)`,
        ['admin', hashedPassword, 'Super Admin', '254759006509', 'admin', 10000]
      );
      console.log('✅ Admin created: admin / admin123');
    }
  });

  // Check if test user exists
  db.get('SELECT * FROM users WHERE username = "testuser"', async (err, user) => {
    if (!user) {
      const hashedPassword = await bcrypt.hash('test123', 10);
      db.run(`INSERT INTO users (username, password, name, phone, role, balance) VALUES (?, ?, ?, ?, ?, ?)`,
        ['testuser', hashedPassword, 'Test User', '254712345678', 'user', 500]
      );
      console.log('✅ Test user created: testuser / test123');
    }
  });

  console.log('✅ SQLite database ready!');
});

// ============================================
// SERVE HTML PAGES
// ============================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/user.html', (req, res) => res.sendFile(path.join(__dirname, 'user.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/panel.html', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', database: 'SQLite', timestamp: new Date() });
});

// ============================================
// AUTH MIDDLEWARE
// ============================================
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, 'secret_key_2026');
    next();
  } catch {
    res.status(403).json({ error: 'Invalid token' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

// ============================================
// REGISTER
// ============================================
app.post('/api/register', async (req, res) => {
  const { username, password, name, phone } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  db.get('SELECT id FROM users WHERE username = ?', [username], async (err, existing) => {
    if (existing) return res.status(400).json({ error: 'Username exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO users (username, password, name, phone, balance) VALUES (?, ?, ?, ?, ?)`,
      [username, hashedPassword, name || username, phone || null, 0],
      function(err) {
        if (err) return res.status(500).json({ error: 'Registration failed' });
        
        const token = jwt.sign({ id: this.lastID, username, role: 'user' }, 'secret_key_2026', { expiresIn: '7d' });
        res.json({ success: true, token, user: { id: this.lastID, username, name: name || username, role: 'user', balance: 0 } });
      }
    );
  });
});

// ============================================
// LOGIN
// ============================================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, 'secret_key_2026', { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name, role: user.role, balance: user.balance, phone: user.phone } });
  });
});

// ============================================
// USER DASHBOARD
// ============================================
app.get('/api/dashboard', auth, (req, res) => {
  db.get('SELECT id, username, name, phone, role, balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
    db.all('SELECT id, username, plan, status, created_at FROM panel_credentials WHERE user_id = ?', [req.user.id], (err, panels) => {
      res.json({ user, panels, stats: { totalBots: 0, totalPanels: panels.length } });
    });
  });
});

// ============================================
// ADD COINS (ADMIN) - WORKING
// ============================================
app.post('/api/admin/add-coins', auth, isAdmin, (req, res) => {
  const { userId, amount } = req.body;
  console.log(`Adding ${amount} coins to user ${userId}`);

  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Valid user ID and amount required' });
  }

  db.get('SELECT username, balance FROM users WHERE id = ?', [userId], (err, user) => {
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newBalance = user.balance + parseInt(amount);
    db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update' });

      res.json({ success: true, message: `${amount} coins added to ${user.username}`, newBalance: newBalance });
    });
  });
});

// ============================================
// BUY PANEL (USING COINS)
// ============================================
app.post('/api/buy-panel', auth, (req, res) => {
  const { plan, cost } = req.body;

  db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (user.balance < cost) {
      return res.status(400).json({ error: `Insufficient coins! Need ${cost} coins.` });
    }

    db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [cost, req.user.id], (err) => {
      if (err) return res.status(500).json({ error: 'Purchase failed' });

      const orderNumber = `PANEL${Date.now()}`;
      db.run(`INSERT INTO orders (order_number, user_id, item_type, item_name, amount, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderNumber, req.user.id, 'panel', plan, cost, 'coins', 'completed'], (err) => {
          res.json({ success: true, message: `Panel purchased! Admin will contact you on WhatsApp: 254759006509` });
        }
      );
    });
  });
});

// ============================================
// DEPLOY BOT (USING COINS)
// ============================================
app.post('/api/deploy-bot', auth, (req, res) => {
  const { botType } = req.body;
  const BOT_COST = 20;

  db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (user.balance < BOT_COST) {
      return res.status(400).json({ error: `Insufficient coins! Need ${BOT_COST} coins.` });
    }

    db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [BOT_COST, req.user.id], (err) => {
      if (err) return res.status(500).json({ error: 'Deployment failed' });

      const orderNumber = `BOT${Date.now()}`;
      db.run(`INSERT INTO orders (order_number, user_id, item_type, item_name, amount, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderNumber, req.user.id, 'bot', botType, BOT_COST, 'coins', 'completed'], (err) => {
          res.json({ success: true, message: `${botType} deployed successfully for 7 days!` });
        }
      );
    });
  });
});

// ============================================
// ADMIN - GET ALL USERS
// ============================================
app.get('/api/admin/users', auth, isAdmin, (req, res) => {
  db.all('SELECT id, username, name, phone, role, balance, created_at FROM users ORDER BY created_at DESC', (err, users) => {
    res.json({ users });
  });
});

// ============================================
// ADMIN - GET ALL PANELS
// ============================================
app.get('/api/admin/panels', auth, isAdmin, (req, res) => {
  db.all(`SELECT pc.*, u.username as owner_name FROM panel_credentials pc LEFT JOIN users u ON pc.user_id = u.id ORDER BY pc.created_at DESC`, (err, panels) => {
    res.json({ panels });
  });
});

// ============================================
// ADMIN - CREATE PANEL CREDENTIALS
// ============================================
app.post('/api/admin/create-panel', auth, isAdmin, (req, res) => {
  const { panelUsername, panelPassword, plan, userId } = req.body;
  if (!panelUsername || !panelPassword) return res.status(400).json({ error: 'Username and password required' });

  db.run(`INSERT INTO panel_credentials (username, password, plan, user_id, status) VALUES (?, ?, ?, ?, ?)`,
    [panelUsername, panelPassword, plan || 'Starter', userId || null, 'active'], function(err) {
      if (err) return res.status(500).json({ error: 'Failed to create panel' });
      res.json({ success: true, message: 'Panel created', panel: { username: panelUsername, password: panelPassword, plan } });
    }
  );
});

// ============================================
// ADMIN - DELETE PANEL
// ============================================
app.delete('/api/admin/panels/:id', auth, isAdmin, (req, res) => {
  db.run('DELETE FROM panel_credentials WHERE id = ?', [req.params.id], (err) => {
    res.json({ success: true });
  });
});

// ============================================
// ADMIN - GET STATS
// ============================================
app.get('/api/admin/stats', auth, isAdmin, (req, res) => {
  db.get('SELECT COUNT(*) as total FROM users', (err, userCount) => {
    db.get('SELECT COUNT(*) as total FROM panel_credentials', (err, panelCount) => {
      db.get('SELECT SUM(balance) as total FROM users', (err, totalBalance) => {
        db.get('SELECT SUM(amount) as total FROM orders WHERE payment_status = "completed"', (err, revenue) => {
          res.json({
            totalUsers: userCount?.total || 0,
            totalPanels: panelCount?.total || 0,
            totalDeployments: 0,
            totalCoinsInCirculation: totalBalance?.total || 0,
            totalRevenue: revenue?.total || 0
          });
        });
      });
    });
  });
});

// ============================================
// ADMIN - GET ORDERS
// ============================================
app.get('/api/admin/orders', auth, isAdmin, (req, res) => {
  db.all(`SELECT o.*, u.username as user_name FROM orders o LEFT JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC LIMIT 50`, (err, orders) => {
    res.json({ orders });
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    🚀 AMONTECH1 API RUNNING                       ║
╠══════════════════════════════════════════════════════════════════╣
║  ✅ Server: http://localhost:${PORT}                              ║
║  🗄️  Database: SQLite (No setup needed!)                         ║
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
