const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeOrder}=require('../backend/checkout');
const id='10101010-ABCD-4000-8000-000000000001';
test('normalization merges duplicates and ignores client prices',()=>{
 assert.deepEqual(normalizeOrder({orderId:id,items:[{itemId:4,quantity:1,price:1},{itemId:1,quantity:2},{itemId:1,quantity:3}]}),{
  orderId:id.toLowerCase(),items:[{itemId:1,quantity:5},{itemId:4,quantity:1}]});
});
test('legacy and multi forms have identical identity',()=>assert.deepEqual(normalizeOrder({orderId:id,itemId:1,quantity:2}),normalizeOrder({orderId:id,items:[{itemId:1,quantity:2}]})));
test('reject invalid quantities, empty carts, ambiguous bodies and integer overflow',()=>{
 for(const quantity of [0,-1,1.5,'2',null,Infinity,2147483648])assert.equal(normalizeOrder({orderId:id,itemId:1,quantity}),null);
 for(const items of [[],null,'cart',[{}],Array(101).fill({itemId:1,quantity:1}),[{itemId:1,quantity:2147483647},{itemId:1,quantity:1}]])assert.equal(normalizeOrder({orderId:id,items}),null);
 assert.equal(normalizeOrder({orderId:id,items:[{itemId:1,quantity:1}],itemId:1,quantity:1}),null);
 assert.equal(normalizeOrder({orderId:'bad',itemId:1,quantity:1}),null);
});
