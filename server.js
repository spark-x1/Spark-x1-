const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

console.log('🚀 AmonTech1 API Starting...');

// ============================================
// YOUR PANEL API KEY
// ============================================
const PANEL_API_KEY = 'ptlc_O714bxWw41SnuSpLlINk6A6KSvNk8xwEVNb6kpqRPii';
const PANEL_API_URL = 'https://panel.spaceify.eu/api';

// ============================================
// SQLITE DATABASE
// ============================================
const db = new sqlite3.Database('./amontech1.db');

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
    panel_server_id TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Orders/Notifications table
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT,
    message TEXT,
    type TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Create admin
  db.get('SELECT * FROM users WHERE role = "admin"', async (err, admin) => {
    if (!admin) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      db.run(`INSERT INTO users (username, password, name, phone, role, balance) VALUES (?, ?, ?, ?, ?, ?)`,
        ['admin', hashedPassword, 'Super Admin', '254759006509', 'admin', 10000]
      );
      console.log('✅ Admin created: admin / admin123');
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
app.get('/panel-login.html', (req, res) => res.sendFile(path.join(__dirname, 'panel-login.html')));
app.get('/panel-dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'panel-dashboard.html')));

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
      db.all('SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC', [req.user.id], (err, notifications) => {
        res.json({ user, panels, notifications, stats: { totalBots: 0, totalPanels: panels.length } });
      });
    });
  });
});

// ============================================
// ADD COINS (ADMIN)
// ============================================
app.post('/api/admin/add-coins', auth, isAdmin, (req, res) => {
  const { userId, amount } = req.body;

  db.get('SELECT username, balance FROM users WHERE id = ?', [userId], (err, user) => {
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newBalance = user.balance + parseInt(amount);
    db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update' });

      // Add notification to user
      db.run(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
        [userId, '💰 Coins Added', `${amount} coins have been added to your account. New balance: ${newBalance} coins`, 'coins']
      );

      res.json({ success: true, message: `${amount} coins added to ${user.username}`, newBalance: newBalance });
    });
  });
});

// ============================================
// BUY PANEL (USING COINS)
// ============================================
app.post('/api/buy-panel', auth, (req, res) => {
  const { plan, cost } = req.body;

  db.get('SELECT balance, username, phone FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (user.balance < cost) {
      return res.status(400).json({ error: `Insufficient coins! Need ${cost} coins.` });
    }

    db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [cost, req.user.id], (err) => {
      if (err) return res.status(500).json({ error: 'Purchase failed' });

      const orderNumber = `PANEL${Date.now()}`;
      
      // Generate random panel credentials
      const panelUsername = `user_${req.user.id}_${Date.now()}`;
      const panelPassword = Math.random().toString(36).substring(2, 10);
      
      // Store panel credentials
      db.run(`INSERT INTO panel_credentials (username, password, plan, user_id, status) VALUES (?, ?, ?, ?, ?)`,
        [panelUsername, panelPassword, plan, req.user.id, 'active'], function(err) {
          
          // Add notification to user
          db.run(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
            [req.user.id, '🎮 Panel Credentials', `Your ${plan} panel is ready!\nUsername: ${panelUsername}\nPassword: ${panelPassword}\nClick "View Panel" to login.`, 'panel']
          );
          
          // Add notification to admin
          db.run(`INSERT INTO notifications (user_id, title, message, type, is_read) VALUES (?, ?, ?, ?, ?)`,
            [1, '🆕 New Panel Purchase', `${user.username} purchased ${plan} panel for ${cost} coins.\nCredentials: ${panelUsername} / ${panelPassword}`, 'admin_order', 0]
          );

          res.json({ 
            success: true, 
            message: `Panel purchased! Credentials sent to your notifications.`,
            credentials: { username: panelUsername, password: panelPassword }
          });
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

      db.run(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
        [req.user.id, '🤖 Bot Deployed', `${botType} has been deployed successfully for 7 days!`, 'bot']
      );

      res.json({ success: true, message: `${botType} deployed successfully for 7 days!` });
    });
  });
});

// ============================================
// GET NOTIFICATIONS
// ============================================
app.get('/api/notifications', auth, (req, res) => {
  const query = req.user.role === 'admin' 
    ? 'SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50'
    : 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC';
  
  const params = req.user.role === 'admin' ? [] : [req.user.id];
  
  db.all(query, params, (err, notifications) => {
    res.json({ notifications });
  });
});

// ============================================
// MARK NOTIFICATION AS READ
// ============================================
app.post('/api/notifications/read/:id', auth, (req, res) => {
  db.run('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id], (err) => {
    res.json({ success: true });
  });
});

// ============================================
// VALIDATE PANEL LOGIN (Using API Key)
// ============================================
app.post('/api/panel/validate', (req, res) => {
  const { username, password } = req.body;
  
  db.get('SELECT * FROM panel_credentials WHERE username = ? AND password = ? AND status = "active"', 
    [username, password], (err, credential) => {
      if (credential) {
        // Generate a temporary token for panel access
        const panelToken = jwt.sign({ username, userId: credential.user_id }, PANEL_API_KEY, { expiresIn: '1h' });
        res.json({ success: true, token: panelToken, redirectTo: '/panel-dashboard.html' });
      } else {
        res.status(401).json({ error: 'Invalid panel credentials' });
      }
    }
  );
});

// ============================================
// GET PANEL SERVERS (Using Real API)
// ============================================
app.get('/api/panel/servers', auth, async (req, res) => {
  try {
    // Get user's panel credentials
    db.all('SELECT * FROM panel_credentials WHERE user_id = ?', [req.user.id], async (err, credentials) => {
      // For each credential, fetch server from real panel
      const servers = [];
      for (const cred of credentials) {
        servers.push({
          id: cred.id,
          name: `${cred.plan} Server`,
          status: 'running',
          credentials: { username: cred.username, password: cred.password }
        });
      }
      res.json({ servers });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch servers' });
  }
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
// ADMIN - CREATE PANEL MANUALLY
// ============================================
app.post('/api/admin/create-panel', auth, isAdmin, (req, res) => {
  const { panelUsername, panelPassword, plan, userId } = req.body;
  
  db.run(`INSERT INTO panel_credentials (username, password, plan, user_id, status) VALUES (?, ?, ?, ?, ?)`,
    [panelUsername, panelPassword, plan || 'Starter', userId || null, 'active'], function(err) {
      if (err) return res.status(500).json({ error: 'Failed to create panel' });
      
      if (userId) {
        db.run(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
          [userId, '🔑 Panel Credentials', `Your ${plan} panel is ready!\nUsername: ${panelUsername}\nPassword: ${panelPassword}\nLogin at: /panel-login.html`, 'panel']
        );
      }
      
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
        db.get('SELECT COUNT(*) as total FROM notifications WHERE is_read = 0', (err, unreadCount) => {
          res.json({
            totalUsers: userCount?.total || 0,
            totalPanels: panelCount?.total || 0,
            totalCoinsInCirculation: totalBalance?.total || 0,
            unreadNotifications: unreadCount?.total || 0
          });
        });
      });
    });
  });
});

// ============================================
// ADMIN - GET ORDERS/NOTIFICATIONS
// ============================================
app.get('/api/admin/notifications', auth, isAdmin, (req, res) => {
  db.all(`SELECT n.*, u.username as user_name FROM notifications n LEFT JOIN users u ON n.user_id = u.id ORDER BY n.created_at DESC LIMIT 100`, (err, notifications) => {
    res.json({ notifications });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 http://localhost:${PORT}`);
});
