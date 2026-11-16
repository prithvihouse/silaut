-- KEYS: cached item, its generation. ARGV: captured generation, version, data, TTL.
local generation = redis.call('GET', KEYS[2]) or '0'
if generation ~= ARGV[1] then
    return 0
end

local active = redis.call('GET', KEYS[1])
if active then
    local version = cjson.decode(active).stockVersion
    local candidate = ARGV[2]
    -- Compare decimal strings exactly, even above Lua's integer precision.
    if #version > #candidate or (#version == #candidate and version >= candidate) then
        return 2
    end
end

redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return 1
