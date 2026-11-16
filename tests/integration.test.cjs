'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {createClient}=require('redis');
const {insertDemo}=require('../backend/seed');
const path=require('node:path');
if(process.env.PGDATABASE!=='silaut_test'||process.env.SILAUT_ALLOW_TEST_RESET!=='1')throw Error('Integration tests require PGDATABASE=silaut_test and SILAUT_ALLOW_TEST_RESET=1.');
const pool=new Pool();
const redis=createClient({url:process.env.REDIS_URL});
const port=Number(process.env.SILAUT_TEST_PORT||3311),base=`http://127.0.0.1:${port}`;
let server;
async function request(route,body,method='POST'){
 const r=await fetch(base+route,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(12000)});
 return {status:r.status,body:await r.json()};
}
async function start(mode='ttl-fenced'){
 server=spawn(process.execPath,[path.join(__dirname,'../backend/server.js')],{env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',CACHE_MODE:mode,PGUSER:process.env.SILAUT_TEST_APP_USER||process.env.PGUSER,PGPASSWORD:process.env.SILAUT_TEST_APP_PASSWORD||process.env.PGPASSWORD},stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',()=>{});server.stderr.on('data',b=>process.stderr.write(b));
 for(let i=0;i<80;i++){if(server.exitCode!==null)throw Error('API exited');try{if((await request('/healthz')).status===200)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('API startup timeout');
}
async function stop(){if(server&&server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}}
async function fixture(patties){
 await pool.query('TRUNCATE order_items,orders,recipe_ingredients,menu_items,ingredients,app_settings RESTART IDENTITY CASCADE');
 const c=await pool.connect();try{await c.query('BEGIN');await insertDemo(c);await c.query('COMMIT');}finally{c.release();}
 if(patties!==undefined)await pool.query('UPDATE ingredients SET on_hand=$1 WHERE id=1',[patties]);
 await redis.flushDb();
}
async function stock(){return(await pool.query('SELECT id,on_hand,revision::text FROM ingredients ORDER BY id')).rows;}
async function orderCount(){return Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count);}
const cart=(...items)=>({orderId:randomUUID(),items:items.map(([itemId,quantity])=>({itemId,quantity}))});
const expectedDeductions={1:1,2:1,3:1,4:25,6:200,7:2};
before(async()=>{await redis.connect();await fixture();await start();});
after(async()=>{await stop();await redis.quit();await pool.end();});
test('multi-item sale: $14.48, one ticket, exact deductions, cross-item invalidation',async()=>{
 await fixture();const before=await stock();
 const primed=await request('/menu/items/2');assert.equal(primed.body.sellableUnits,24);
 const result=await request('/orders',cart([1,1],[4,1]));assert.equal(result.status,201);assert.equal(result.body.totalCents,1448);assert.equal(result.body.items.length,2);
 const tickets=(await request('/tickets')).body.tickets;assert.equal(tickets.length,1);assert.equal(tickets[0].items.length,2);assert.equal(tickets[0].status,'new');
 for(const row of await stock()){const old=before.find(b=>b.id===row.id);assert.equal(old.on_hand-row.on_hand,expectedDeductions[row.id]||0);assert.equal(BigInt(row.revision)-BigInt(old.revision),expectedDeductions[row.id]?1n:0n);}
 const after=await request('/menu/items/2');assert.equal(after.body.sellableUnits,23);assert.ok(BigInt(after.body.stockVersion)>BigInt(primed.body.stockVersion));
});
test('combined shared ingredient shortage rejects everything',async()=>{
 await fixture(2);const before=await stock();
 assert.equal((await request('/menu/items/1')).body.sellableUnits,2);assert.equal((await request('/menu/items/2')).body.sellableUnits,1);
 const r=await request('/orders',cart([1,1],[2,1]));assert.equal(r.status,409);assert.equal(r.body.code,'INSUFFICIENT_INVENTORY');assert.equal(r.body.shortages[0].required,3);
 assert.deepEqual(await stock(),before);assert.equal(await orderCount(),0);assert.equal((await request('/tickets')).body.tickets.length,0);
});
test('last-item race has one winner; exact retry returns original receipt once',async()=>{
 await fixture(1);const before=await stock();const a=cart([1,1],[4,1]),b=cart([1,1],[4,1]);
 const results=await Promise.all([request('/orders',a),request('/orders',b)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 const win=results.findIndex(r=>r.status===201),after=await stock();assert.equal(await orderCount(),1);assert.equal((await request('/tickets')).body.tickets.length,1);
 for(const row of after)assert.equal(before.find(b=>b.id===row.id).on_hand-row.on_hand,expectedDeductions[row.id]||0);
 const retry=await request('/orders',[a,b][win]);assert.equal(retry.status,200);assert.deepEqual(retry.body,results[win].body);assert.deepEqual(await stock(),after);assert.equal(await orderCount(),1);
});
test('concurrent requests with same UUID serialize and charge once',async()=>{
 await fixture();const a=cart([1,1],[4,1]);const results=await Promise.all(Array.from({length:5},()=>request('/orders',a)));
 assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===200).length,4);assert.equal(await orderCount(),1);assert.equal((await stock()).find(i=>i.id===1).on_hand,47);
 for(const r of results)assert.deepEqual(r.body,results[0].body);
});
test('normalized duplicates replay; changed cart conflicts; server controls prices',async()=>{
 await fixture();const id=randomUUID();const r=await request('/orders',{orderId:id,items:[{itemId:4,quantity:1},{itemId:1,quantity:1,priceCents:1},{itemId:1,quantity:1}]});
 assert.equal(r.status,201);assert.equal(r.body.totalCents,2447);const unchanged=await stock();
 const replay=await request('/orders',{orderId:id,items:[{itemId:1,quantity:2},{itemId:4,quantity:1}]});assert.equal(replay.status,200);assert.deepEqual(replay.body,r.body);
 const conflict=await request('/orders',{orderId:id,items:[{itemId:1,quantity:1},{itemId:4,quantity:1}]});assert.equal(conflict.status,409);assert.equal(conflict.body.code,'ORDER_ID_CONFLICT');assert.deepEqual(await stock(),unchanged);
});
test('legacy receipt contract and equivalent array replay',async()=>{
 await fixture();const id=randomUUID();const r=await request('/orders',{orderId:id,itemId:1,quantity:2});assert.equal(r.status,201);
 for(const key of ['orderId','itemId','quantity','unitPriceCents','stockVersionAfter','sellableUnitsAfter'])assert.ok(Object.hasOwn(r.body,key));
 assert.equal(r.body.itemId,1);assert.equal(r.body.quantity,2);assert.equal(r.body.unitPriceCents,999);assert.equal(r.body.sellableUnitsAfter,46);assert.match(r.body.stockVersionAfter,/^\d+$/);
 assert.deepEqual((await request('/orders',{orderId:id,items:[{itemId:1,quantity:2}]})).body,r.body);
});
test('invalid and missing menu items have no side effects',async()=>{
 await fixture();const before=await stock();
 assert.equal((await request('/orders',{orderId:randomUUID(),items:[{itemId:1,quantity:0}]})).status,400);
 assert.equal((await request('/orders',cart([1,1],[999,1]))).status,404);
 assert.equal((await request('/orders',cart([999,1]))).status,404);assert.equal(await orderCount(),0);assert.deepEqual(await stock(),before);
});
test('original invalid-body status codes remain compatible',async()=>{
 const plain=await fetch(base+'/orders',{method:'POST',body:'not-json'});assert.equal(plain.status,400);assert.equal((await plain.json()).code,'INVALID_ORDER');
 const invalid=await fetch(base+'/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});assert.equal(invalid.status,400);assert.equal((await invalid.json()).code,'INVALID_JSON');
 const large=await fetch(base+'/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:randomUUID(),itemId:1,quantity:1,padding:'x'.repeat(9000)})});assert.equal(large.status,413);assert.equal((await large.json()).code,'BODY_TOO_LARGE');
});
test('server enforces status sequence and Ready survives API restart',async()=>{
 await fixture();const r=await request('/orders',cart([1,1],[4,1])),id=r.body.orderId;
 assert.equal((await request(`/tickets/${id}/status`,{expectedStatus:'new',status:'ready'},'PATCH')).status,400);
 assert.equal((await request(`/tickets/${id}/status`,{expectedStatus:'new',status:'preparing'},'PATCH')).status,200);
 assert.equal((await request(`/tickets/${id}/status`,{expectedStatus:'preparing',status:'ready'},'PATCH')).status,200);
 assert.equal((await request(`/tickets/${id}/status`,{expectedStatus:'new',status:'preparing'},'PATCH')).status,409);
 await stop();await start();const t=(await request('/tickets')).body.tickets;assert.equal(t.length,1);assert.equal(t[0].status,'ready');
 const retried=await request('/orders',{orderId:id,items:[{itemId:1,quantity:1},{itemId:4,quantity:1}]});assert.equal(retried.status,200);assert.deepEqual(retried.body,r.body);
});
test('rerunning migrations and demo seed preserves tickets and stock',async()=>{
 const stockBefore=await stock();const ordersBefore=(await pool.query('SELECT * FROM orders ORDER BY id')).rows;
 await require('../backend/migrate').migrate();await require('../backend/seed').seed();
 assert.deepEqual(await stock(),stockBefore);assert.deepEqual((await pool.query('SELECT * FROM orders ORDER BY id')).rows,ordersBefore);
});
test('all original cache modes remain selectable with valid single-item receipts',async()=>{
 for(const mode of ['postgres','ttl','ttl-invalidate','ttl-fenced']){
  await stop();await fixture();await start(mode);assert.equal((await request('/healthz')).body.mode,mode);
  assert.equal((await request('/menu/items/1')).status,200);
  const r=await request('/orders',{orderId:randomUUID(),itemId:1,quantity:1});assert.equal(r.status,201);assert.equal(r.body.sellableUnitsAfter,47);
 }
});
