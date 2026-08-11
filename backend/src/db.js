const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/seedance',
})

async function query(text, params) {
  return pool.query(text, params)
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS batch_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INT REFERENCES users(id),
      name VARCHAR(255) NOT NULL,
      script TEXT,
      style VARCHAR(50),
      ratio VARCHAR(10),
      seed INTEGER,
      shots JSONB DEFAULT '[]',
      media_items JSONB DEFAULT '[]',
      params JSONB DEFAULT '{}',
      subject_defs TEXT,
      subtitle_input TEXT,
      tasks JSONB DEFAULT '{}',
      merged_video_url TEXT,
      init_result JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      sso_user_id INT UNIQUE NOT NULL,
      username VARCHAR(50),
      name VARCHAR(100),
      email VARCHAR(200),
      avatar TEXT,
      quota INT DEFAULT 10,
      used INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await query(`
    ALTER TABLE batch_tasks ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id)
  `).catch(() => {})

  await query(`
    CREATE TABLE IF NOT EXISTS user_asset_groups (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id),
      group_id VARCHAR(100) NOT NULL,
      group_type VARCHAR(20) NOT NULL,
      name VARCHAR(200),
      shared BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_asset_groups_user_group
    ON user_asset_groups (user_id, group_id) WHERE user_id IS NOT NULL
  `).catch(() => {})

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_asset_groups_shared_group
    ON user_asset_groups (group_id) WHERE shared = TRUE
  `).catch(() => {})
}

module.exports = { query, initDB, pool }
