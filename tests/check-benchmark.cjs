const fs=require('node:fs');const assert=require('node:assert/strict');
let success=0,failed=0;for(const line of fs.readFileSync(process.argv[2],'utf8').trim().split('\n')){
 const r=JSON.parse(line);if(r.type==='Point'&&r.metric==='pos_http_ms'){if(r.data.tags.outcome==='success')success++;else if(r.data.tags.outcome==='failure')failed++;}
}
assert.ok(success>0,'benchmark must make successful requests');assert.equal(failed,0,'benchmark must have no contract failures');console.log(JSON.stringify({status:'PASS',successfulRequests:success,contractFailures:failed}));
