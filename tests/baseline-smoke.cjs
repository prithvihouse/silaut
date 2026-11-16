'use strict';
const {Pool}=require('pg');const {randomUUID}=require('node:crypto');const assert=require('node:assert/strict');
const base=process.env.POS_BASE_URL||'http://api:3000';
(async()=>{const p=new Pool();try{
 const health=await fetch(base+'/healthz');assert.equal(health.status,200);
 const menu=await(await fetch(base+'/menu')).json();assert.ok(menu.length>0);
 const id=menu[0].itemId;
 const before=(await p.query('SELECT i.id,i.on_hand,r.units_per_item FROM ingredients i JOIN recipe_ingredients r ON r.ingredient_id=i.id WHERE r.menu_item_id=$1 ORDER BY i.id',[id])).rows;
 const order={orderId:randomUUID(),itemId:id,quantity:1};
 const response=await fetch(base+'/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(order)});assert.equal(response.status,201);const receipt=await response.json();
 for(const key of ['orderId','itemId','quantity','unitPriceCents','stockVersionAfter','sellableUnitsAfter'])assert.ok(Object.hasOwn(receipt,key));
 const after=(await p.query('SELECT id,on_hand FROM ingredients WHERE id=ANY($1::int[]) ORDER BY id',[before.map(i=>i.id)])).rows;
 for(let i=0;i<after.length;i++)assert.equal(before[i].on_hand-after[i].on_hand,before[i].units_per_item);
 const retry=await fetch(base+'/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(order)});assert.equal(retry.status,200);assert.deepEqual(await retry.json(),receipt);
 console.log(JSON.stringify({status:'PASS',health:200,menuItems:menu.length,checkout:201,retry:200,receipt,deductions:before.map((b,i)=>({ingredientId:b.id,deducted:b.on_hand-after[i].on_hand}))},null,2));
}finally{await p.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
