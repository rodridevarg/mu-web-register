const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const openmuPool = new Pool({
  user: 'openmu',
  host: 'localhost',
  database: 'openmu',
  password: 'openmu123',
  port: 5432,
});

async function runMigration() {
  const sqlPath = path.join(__dirname, '..', '..', 'OpenMU', 'src', 'Persistence', 'EntityFramework', 'Migrations', 'economy_tables.sql');
  
  if (!fs.existsSync(sqlPath)) {
    console.error('Migration file not found:', sqlPath);
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  
  console.log('Connecting to PostgreSQL...');
  const client = await openmuPool.connect();
  
  try {
    console.log('Executing economy_tables.sql...');
    await client.query(sql);
    console.log('Migration completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await openmuPool.end();
  }
}

runMigration();
