'use strict';
const {Pool}=require('pg');
const demo=require('../database/seeds/demo.json');
async function insertDemo(c){
 for(const i of demo.ingredients) await c.query('INSERT INTO ingredients(id,name,on_hand,unit,low_stock_threshold) VALUES($1,$2,$3,$4,$5)',[i.id,i.name,i.stock,i.unit,i.low]);
 await c.query(`INSERT INTO inventory_movements (ingredient_id,delta,unit,balance_after,kind,reason)
   SELECT id,on_hand,unit,on_hand,'opening','Regression fixture opening balance' FROM ingredients
   WHERE id=ANY($1::int[])`,[demo.ingredients.map(ingredient=>ingredient.id)]);
 for(const i of demo.items){
  await c.query('INSERT INTO menu_items(id,name,price_cents,category,description) VALUES($1,$2,$3,$4,$5)',[i.id,i.name,i.price,i.category,i.description]);
  for(const [id,units] of Object.entries(i.recipe))await c.query('INSERT INTO recipe_ingredients VALUES($1,$2,$3)',[i.id,Number(id),units]);
 }
 await c.query("INSERT INTO app_settings(key,value) VALUES('demo_seed','1')");
}
async function seed(){const pool=new Pool();const c=await pool.connect();try{
 await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(7319052)');
 const {rows:[r]}=await c.query('SELECT EXISTS(SELECT 1 FROM menu_items) OR EXISTS(SELECT 1 FROM ingredients) OR EXISTS(SELECT 1 FROM orders) AS populated');
 if(r.populated)console.log('Database populated; existing stock and tickets preserved.');
 else {await insertDemo(c);console.log('Seeded six Silaut demo items.');}
 await c.query('COMMIT');
}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}}
if(require.main===module)seed().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={insertDemo,seed};
