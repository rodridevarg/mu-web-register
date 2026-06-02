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
  user: process.env.OPENMU_DB_USER || 'openmu',
  host: process.env.OPENMU_DB_HOST || 'localhost',
  database: process.env.OPENMU_DB_NAME || 'openmu',
  password: process.env.OPENMU_DB_PASSWORD || 'openmu123',
  port: Number(process.env.OPENMU_DB_PORT || 5432),
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

// API endpoints de economia
app.get('/api/economy/market', async (req, res) => {
  try {
    // Precios de referencia oficiales
    const refPrices = await openmuPool.query(
      `SELECT "ItemName", "PriceInBless" FROM data."ReferencePrice" WHERE "IsActive" = true ORDER BY "ItemName"`
    );

    // Ultimo snapshot de precios del mercado P2P (ultimas 24h) — leido directo de EconomyTransaction
    const marketSnap = await openmuPool.query(
      `SELECT "ItemName",
              ROUND(AVG("PriceZen")::numeric, 2) as "AveragePrice",
              COUNT(*) as "TransactionCount",
              MIN("PriceZen") as "MinPrice",
              MAX("PriceZen") as "MaxPrice"
       FROM data."EconomyTransaction"
       WHERE "Timestamp" > now() - interval '24 hours'
         AND "PriceZen" IS NOT NULL AND "PriceZen" > 0
       GROUP BY "ItemName"
       ORDER BY "TransactionCount" DESC`
    );

    // Ultimas 10 transacciones
    const recentTx = await openmuPool.query(
      `SELECT "Timestamp", "TransactionType", "ItemName", "Quantity", "PriceZen", "PaymentItemName", "PaymentItemQuantity"
       FROM data."EconomyTransaction"
       ORDER BY "Timestamp" DESC
       LIMIT 10`
    );

    res.json({
      referencePrices: refPrices.rows,
      marketSnapshots: marketSnap.rows,
      recentTransactions: recentTx.rows,
    });
  } catch (err) {
    console.error('Error en /api/economy/market:', err);
    res.status(500).json({ error: 'Error al cargar datos de mercado' });
  }
});

app.get('/api/economy/patrimony/top', async (req, res) => {
  try {
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 50)) : 10;
    const top = await openmuPool.query(
      `SELECT ch."Name", cp."TotalPatrimony", cp."ZenValue", cp."BlessCount", cp."SoulCount", cp."LifeCount", cp."ChaosCount", cp."SnapshotTime"
       FROM data."CharacterPatrimony" cp
       JOIN data."Character" ch ON ch."Id" = cp."CharacterId"
       INNER JOIN (
         SELECT "CharacterId", MAX("SnapshotTime") as max_time
         FROM data."CharacterPatrimony"
         GROUP BY "CharacterId"
       ) latest ON cp."CharacterId" = latest."CharacterId" AND cp."SnapshotTime" = latest.max_time
       ORDER BY cp."TotalPatrimony" DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ rankings: top.rows });
  } catch (err) {
    console.error('Error en /api/economy/patrimony/top:', err);
    res.status(500).json({ error: 'Error al cargar rankings de patrimonio' });
  }
});

app.get('/api/economy/systembank', async (req, res) => {
  try {
    const bank = await openmuPool.query(
      `SELECT "TotalZenCollected", "TotalTransactions", "LastUpdated" FROM data."SystemBank" WHERE "Id" = '00000000-0000-0000-0000-000000000001'`
    );
    res.json({ systemBank: bank.rows[0] || { TotalZenCollected: 0, TotalTransactions: 0 } });
  } catch (err) {
    console.error('Error en /api/economy/systembank:', err);
    res.status(500).json({ error: 'Error al cargar datos del banco' });
  }
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
  const filePath = path.join(__dirname, 'public', 'downloads', 'LiberMU_Client.zip');
  if (require('fs').existsSync(filePath)) {
    res.download(filePath, 'LiberMU_Client.zip');
  } else {
    res.status(404).send('Cliente no disponible temporalmente. Contacta al admin.');
  }
});

// Tienda de Joyas
app.get('/shop', (req, res) => {
  res.render('shop', { title: 'Tienda de Joyas', error: null, success: null });
});

app.post('/shop/order', async (req, res) => {
  const { game_account, contact_method, notes } = req.body;
  if (!game_account || game_account.length < 3) {
    return res.render('shop', { title: 'Tienda de Joyas', error: 'Ingresa una cuenta de juego valida.', success: null });
  }
  try {
    await run(
      `INSERT INTO orders (game_account, pack_name, pack_price, pack_contents, contact_method, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      [game_account, 'Pack Mensual Starter', '5 USD', '5x Jewel of Bless + 5x Jewel of Soul', contact_method || '', notes || '']
    );
    res.render('shop', { title: 'Tienda de Joyas', error: null, success: `Pedido registrado para la cuenta "${game_account}". Contacta al admin por Discord para coordinar el pago y la entrega.` });
  } catch (err) {
    console.error('Error en pedido:', err);
    res.render('shop', { title: 'Tienda de Joyas', error: 'Error al registrar el pedido. Intenta de nuevo.', success: null });
  }
});

// Rankings economicos
app.get('/rankings', async (req, res) => {
  res.render('rankings', { title: 'Rankings' });
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
    const orders = await all(`SELECT id, game_account, pack_name, pack_price, pack_contents, status, contact_method, notes, created_at FROM orders ORDER BY created_at DESC`);
    const stats = {
      total: users.length,
      pending: users.filter(u => u.status === 'pending').length,
      active: users.filter(u => u.status === 'active').length,
      ordersPending: orders.filter(o => o.status === 'pending').length,
      ordersDelivered: orders.filter(o => o.status === 'delivered').length,
    };
    res.render('admin', { users, orders, stats, error: null, success: null });
  } catch (err) {
    console.error(err);
    res.render('admin', { users: [], orders: [], stats: {}, error: 'Error al cargar datos.', success: null });
  }
});

app.post('/admin/deliver', requireAdmin, async (req, res) => {
  const { order_id } = req.body;
  try {
    await run(`UPDATE orders SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP WHERE id = ?`, [order_id]);
    res.redirect('/admin?success=Pedido+ marcado+ como+ entregado');
  } catch (err) {
    console.error(err);
    res.redirect('/admin?error=Error+ al+ marcar+ entrega');
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
