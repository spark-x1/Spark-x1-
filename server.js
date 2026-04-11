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

  // API STORE - Admin adds panel APIs here
  db.run(`CREATE TABLE IF NOT EXISTS api_store (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    api_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    panel_username TEXT NOT NULL,
    panel_password TEXT NOT NULL,
    plan TEXT DEFAULT 'Starter',
    is_used INTEGER DEFAULT 0,
    assigned_to INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Panel Credentials given to users
  db.run(`CREATE TABLE IF NOT EXISTS panel_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    plan TEXT,
    api_url TEXT,
    api_key TEXT,
    user_id INTEGER,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Notifications table
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
// REGISTER & LOGIN
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
// ADMIN - API STORE MANAGEMENT
// ============================================

// Add API to store
app.post('/api/admin/api-store/add', auth, isAdmin, (req, res) => {
  const { name, api_url, api_key, panel_username, panel_password, plan } = req.body;
  
  db.run(`INSERT INTO api_store (name, api_url, api_key, panel_username, panel_password, plan, is_used) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, api_url, api_key, panel_username, panel_password, plan || 'Starter', 0],
    function(err) {
      if (err) return res.status(500).json({ error: 'Failed to add API' });
      res.json({ success: true, message: 'API added to store', id: this.lastID });
    }
  );
});

// Get all APIs in store
app.get('/api/admin/api-store/list', auth, isAdmin, (req, res) => {
  db.all('SELECT * FROM api_store ORDER BY created_at DESC', (err, apis) => {
    res.json({ apis });
  });
});

// Delete API from store
app.delete('/api/admin/api-store/:id', auth, isAdmin, (req, res) => {
  db.run('DELETE FROM api_store WHERE id = ?', [req.params.id], (err) => {
    res.json({ success: true });
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
      db.run(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
        [userId, '💰 Coins Added', `${amount} coins added to your account. New balance: ${newBalance} coins`, 'coins']
      );
      res.json({ success: true, message: `${amount} coins added to ${user.username}`, newBalance: newBalance });
    });
  });
});

// ============================================
// BUY PANEL - Gets random API from store
// ============================================
app.post('/api/buy-panel', auth, (req, res) => {
  const { plan, cost } = req.body;

  db.get('SELECT balance, username, phone FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (user.balance < cost) {
      return res.status(400).json({ error: `Insufficient coins! Need ${cost} coins.` });
    }

    // Get random unused API from store matching the plan
    db.get('SELECT * FROM api_store WHERE plan = ? AND is_used = 0 ORDER BY RANDOM() LIMIT 1', [plan], (err, api) => {
      if (!api) {
        return res.status(400).json({ error: 'No available APIs for this plan. Contact admin.' });
      }

      // Mark API as used
      db.run('UPDATE api_store SET is_used = 1, assigned_to = ? WHERE id = ?', [req.user.id, api.id], (err) => {
        
        // Deduct coins
        db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [cost, req.user.id], (err) => {
          
          // Store panel credentials for user
          db.run(`INSERT INTO panel_credentials (username, password, plan, api_url, api_key, user_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [api.panel_username, api.panel_password, plan, api.api_url, api.api_key, req.user.id, 'active'], function(err) {
              
              // Send notification to user with credentials
              db.run(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
                [req.user.id, '🎮 Panel Credentials', `Your ${plan} panel is ready!\n\n🔑 Username: ${api.panel_username}\n🔒 Password: ${api.panel_password}\n\nClick "View Panel" and login with these credentials.`, 'panel']
              );
              
              // Notify admin
              db.run(`INSERT INTO notifications (user_id, title, message, type, is_read) VALUES (?, ?, ?, ?, ?)`,
                [1, '🆕 Panel Sold', `${user.username} purchased ${plan} panel for ${cost} coins.\nAPI: ${api.name}\nCredentials: ${api.panel_username} / ${api.panel_password}`, 'admin_order', 0]
              );

              res.json({ 
                success: true, 
                message: `Panel purchased! Check notifications for credentials.`,
                credentials: { username: api.panel_username, password: api.panel_password }
              });
            }
          );
        });
      });
    });
  });
});

// ============================================
// DEPLOY BOT
// ============================================
app.post('/api/deploy-bot', auth, (req, res) => {
  const { botType } = req.body;
  const BOT_COST = 20;

  db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (user.balance < BOT_COST) {
      return res.status(400).json({ error: `Insufficient coins! Need ${BOT_COST} coins.` });
    }

    db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [BOT_COST, req.user.id], (err) => {
      db.run(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
        [req.user.id, '🤖 Bot Deployed', `${botType} deployed successfully for 7 days!`, 'bot']
      );
      res.json({ success: true, message: `${botType} deployed successfully!` });
    });
  });
});

// ============================================
// VALIDATE PANEL LOGIN - Checks credentials against stored ones
// ============================================
app.post('/api/panel/validate', (req, res) => {
  const { username, password } = req.body;
  
  db.get('SELECT * FROM panel_credentials WHERE username = ? AND password = ? AND status = "active"', 
    [username, password], (err, credential) => {
      if (credential) {
        // Return the API URL and key for this panel (hidden from user but used by dashboard)
        res.json({ 
          success: true, 
          api_url: credential.api_url,
          api_key: credential.api_key,
          panel_username: credential.username,
          redirectTo: '/panel-dashboard.html'
        });
      } else {
        res.status(401).json({ error: 'Invalid panel credentials' });
      }
    }
  );
});

// ============================================
// GET USER'S PANEL INFO (For dashboard)
// ============================================
app.get('/api/panel/info', auth, (req, res) => {
  db.all('SELECT id, username, plan, api_url, status FROM panel_credentials WHERE user_id = ?', [req.user.id], (err, panels) => {
    res.json({ panels });
  });
});

// ============================================
// NOTIFICATIONS
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

app.post('/api/notifications/read/:id', auth, (req, res) => {
  db.run('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id], (err) => {
    res.json({ success: true });
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
// ADMIN - CREATE PANEL MANUALLY (Uses API store)
// ============================================
app.post('/api/admin/create-panel', auth, isAdmin, (req, res) => {
  const { panelUsername, panelPassword, plan, userId } = req.body;
  
  // Get an API from store or create placeholder
  db.get('SELECT * FROM api_store WHERE plan = ? AND is_used = 0 LIMIT 1', [plan], (err, api) => {
    const apiUrl = api ? api.api_url : 'https://panel.spaceify.eu';
    const apiKey = api ? api.api_key : '';
    
    db.run(`INSERT INTO panel_credentials (username, password, plan, api_url, api_key, user_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [panelUsername, panelPassword, plan, apiUrl, apiKey, userId || null, 'active'], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to create panel' });
        
        if (api) {
          db.run('UPDATE api_store SET is_used = 1, assigned_to = ? WHERE id = ?', [userId, api.id]);
        }
        
        if (userId) {
          db.run(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
            [userId, '🔑 Panel Credentials', `Your ${plan} panel is ready!\nUsername: ${panelUsername}\nPassword: ${panelPassword}\nLogin at: /panel-login.html`, 'panel']
          );
        }
        
        res.json({ success: true, message: 'Panel created', panel: { username: panelUsername, password: panelPassword, plan } });
      }
    );
  });
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
        db.get('SELECT COUNT(*) as total FROM api_store WHERE is_used = 0', (err, availableApis) => {
          res.json({
            totalUsers: userCount?.total || 0,
            totalPanels: panelCount?.total || 0,
            totalCoinsInCirculation: totalBalance?.total || 0,
            availableApis: availableApis?.total || 0
          });
        });
      });
    });
  });
});

// ============================================
// ADMIN - GET ALL NOTIFICATIONS
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
