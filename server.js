const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const bcrypt = require('bcryptjs');
const net = require('net');
const http = require('http');
const { run, get, all } = require('./database');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL pool for OpenMU game accounts
const openmuPool = new Pool({
  user: 'openmu',
  host: 'localhost',
  database: 'openmu',
  password: 'openmu123',
  port: 5432,
});

// Configuración de vistas
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Middlewares
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'mu-online-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 } // 1 hora
}));

// Variables globales para vistas
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.admin = req.session.admin || null;
  res.locals.serverStatus = await checkServerStatus();
  next();
});

// Helper: Verificar estado del servidor de juego (puerto 44406 + jugadores desde Admin Panel)
async function checkServerStatus() {
  const isOnline = await new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(44406, 'localhost');
  });

  if (!isOnline) {
    return { online: false, label: 'Offline', players: '-' };
  }

  // Intentar obtener jugadores desde el Admin Panel de OpenMU
  try {
    const openmuStatus = await new Promise((resolve, reject) => {
      const req = http.get('http://localhost:5000/api/status', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.setTimeout(2000, () => reject(new Error('Timeout')));
      req.on('error', reject);
    });

    const realPlayers = typeof openmuStatus.players === 'number' ? openmuStatus.players : 0;
    const displayPlayers = realPlayers + 7;
    return { online: true, label: 'Online', players: displayPlayers };
  } catch (err) {
    // Si falla el Admin Panel, igual mostramos Online pero sin conteo real
    return { online: true, label: 'Online', players: '???' };
  }
}

// API endpoint para estado (usado por AJAX)
app.get('/api/status', async (req, res) => {
  const status = await checkServerStatus();
  res.json(status);
});

// ================== RUTAS ==================

// Home
app.get('/', (req, res) => {
  res.render('index');
});

// Registro
app.get('/register', (req, res) => {
  res.render('register', { error: null, success: null });
});

app.post('/register', async (req, res) => {
  const { username, password, confirm_password, email } = req.body;

  // Validaciones básicas
  if (!username || !password || !email) {
    return res.render('register', { error: 'Todos los campos son obligatorios.', success: null });
  }
  if (password !== confirm_password) {
    return res.render('register', { error: 'Las contraseñas no coinciden.', success: null });
  }
  if (username.length < 3 || username.length > 10) {
    return res.render('register', { error: 'El usuario debe tener entre 3 y 10 caracteres.', success: null });
  }
  if (password.length < 3 || password.length > 20) {
    return res.render('register', { error: 'La contraseña debe tener entre 3 y 20 caracteres.', success: null });
  }

  try {
    // Verificar si ya existe en OpenMU (PostgreSQL es la fuente de verdad del juego)
    const openmuExisting = await openmuPool.query(
      `SELECT "Id" FROM data."Account" WHERE "LoginName" = $1`,
      [username]
    );
    if (openmuExisting.rows.length > 0) {
      return res.render('register', { error: 'El usuario ya existe en el juego.', success: null });
    }

    const existing = await get(`SELECT id FROM users WHERE username = ? OR email = ?`, [username, email]);
    if (existing) {
      return res.render('register', { error: 'El usuario o email ya estan registrados.', success: null });
    }

    const hash = bcrypt.hashSync(password, 10);

    // 1. Crear ItemStorage para el vault en OpenMU
    const storageResult = await openmuPool.query(
      `INSERT INTO data."ItemStorage" ("Id", "Money") VALUES (gen_random_uuid(), 0) RETURNING "Id"`
    );
    const vaultId = storageResult.rows[0].Id;

    // 2. Crear Account en OpenMU
    await openmuPool.query(
      `INSERT INTO data."Account" (
        "Id", "LoginName", "PasswordHash", "SecurityCode", "EMail",
        "LanguageIsoCode", "RegistrationDate", "State", "TimeZone",
        "VaultPassword", "IsVaultExtended", "IsTemplate", "VaultId"
      ) VALUES (
        gen_random_uuid(), $1, $2, '', $3,
        'en', NOW(), 0, 0,
        '', false, false, $4
      )`,
      [username, hash, email, vaultId]
    );

    // 3. Registrar en web SQLite (panel propio)
    await run(`INSERT INTO users (username, password, email) VALUES (?, ?, ?)`, [username, hash, email]);

    res.render('register', { error: null, success: `Cuenta "${username}" registrada exitosamente. Ya podes jugar!` });
  } catch (err) {
    console.error('Error en registro:', err);
    res.render('register', { error: 'Error al registrar la cuenta. Intenta de nuevo.', success: null });
  }
});

// Download page
app.get('/download', (req, res) => {
  res.render('download', { title: 'Descargar Cliente' });
});

// Serve client zip file
app.get('/download/client', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'downloads', 'LiberMU_Client_v2.zip');
  if (require('fs').existsSync(filePath)) {
    res.download(filePath, 'LiberMU_Client.zip');
  } else {
    res.status(404).send('Cliente no disponible temporalmente. Contacta al admin.');
  }
});

// Login de admin
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const admin = await get(`SELECT * FROM admins WHERE username = ?`, [username]);
    if (admin && bcrypt.compareSync(password, admin.password)) {
      req.session.admin = { id: admin.id, username: admin.username };
      return res.redirect('/admin');
    }
    res.render('login', { error: 'Credenciales invalidas.' });
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Error al iniciar sesion.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Panel Admin
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const users = await all(`SELECT id, username, email, created_at, status FROM users ORDER BY created_at DESC`);
    const stats = {
      total: users.length,
      pending: users.filter(u => u.status === 'pending').length,
      active: users.filter(u => u.status === 'active').length
    };
    res.render('admin', { users, stats, error: null, success: null });
  } catch (err) {
    console.error(err);
    res.render('admin', { users: [], stats: {}, error: 'Error al cargar usuarios.', success: null });
  }
});

// Middleware de admin
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  res.redirect('/login');
}

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`  MU Web Register iniciado!`);
  console.log(`  URL: http://localhost:${PORT}`);
  console.log(`  Admin: http://localhost:${PORT}/login`);
  console.log(`  (user: admin / pass: admin123)`);
  console.log(`========================================`);
});
