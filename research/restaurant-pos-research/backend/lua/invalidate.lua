-- First half of KEYS are payload keys. The second half are generation keys.
local count = #KEYS / 2
local deleted = 0
for index = 1, count do
    redis.call('INCR', KEYS[index + count])
    deleted = deleted + redis.call('DEL', KEYS[index])
end
return deleted
