'use strict';
const {Pool}=require('pg');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
async function migrate(){
 const pool=new Pool(); const c=await pool.connect();
 try {
  await c.query('SELECT pg_advisory_lock(7319051)');
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  const dir=path.join(__dirname,'../database/migrations');
  for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.sql')).sort()){
   const sql=fs.readFileSync(path.join(dir,name),'utf8'); const hash=createHash('sha256').update(sql).digest('hex');
   const {rows:[prior]}=await c.query('SELECT sha256 FROM schema_migrations WHERE name=$1',[name]);
   if(prior){if(prior.sha256!==hash)throw Error('Applied migration changed: '+name);continue;}
   await c.query('BEGIN');
   try {await c.query(sql);await c.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);await c.query('COMMIT');}
   catch(e){await c.query('ROLLBACK');throw e;}
   console.log('Applied '+name);
  }
  console.log('Migrations current.');
 }finally{await c.query('SELECT pg_advisory_unlock(7319051)').catch(()=>{});c.release();await pool.end();}
}
if(require.main===module)migrate().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={migrate};
