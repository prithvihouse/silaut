'use strict';

const sharp = require('sharp');
const {createHash} = require('node:crypto');
const {failure, transaction} = require('./db');

const MAX_LOGO_BYTES = 256 * 1024;
const LOGO_REQUEST_LIMIT = 352 * 1024;
const LOGO_DIGEST = /^[0-9a-f]{64}$/;
const FORMATS = new Set(['png', 'jpeg', 'webp']);

function receiptIdentity(profile) {
  return {name: profile.name, locationLabel: profile.locationLabel, address: profile.address, logoUrl: profile.logoUrl};
}

async function readProfile(client) {
  const {rows: [profile]} = await client.query(`
    SELECT name,location_label AS "locationLabel",address,cutoff_minutes AS "cutoffMinutes",
      CASE WHEN logo_digest IS NOT NULL THEN '/api/logos/' || logo_digest END AS "logoUrl"
    FROM restaurant_profile WHERE singleton
  `);
  return profile;
}

function validateText(value, length) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= length ? trimmed : null;
}

async function normalizeLogo(encoded) {
  if (typeof encoded !== 'string' || !/^[a-z\d+/]+={0,2}$/i.test(encoded)
    || encoded.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_LOGO_BYTES || bytes.toString('base64') !== encoded) return null;
  try {
    const image = sharp(bytes, {limitInputPixels: 1024 * 1024, failOn: 'warning'});
    const {format, width, height, pages} = await image.metadata();
    if (!FORMATS.has(format) || width > 1024 || height > 1024 || (pages ?? 1) !== 1) return null;
    return await image.rotate().resize(192, 192, {fit: 'inside', withoutEnlargement: true}).png().toBuffer();
  } catch {
    return null;
  }
}

async function saveProfile(pool, body) {
  const {name, locationLabel, address, cutoffMinutes, logo} = body ?? {};
  const noAddress = address === '' || address == null;
  const fields = [validateText(name, 100), validateText(locationLabel, 100),
    noAddress ? null : validateText(address, 240), cutoffMinutes];
  if (!fields[0] || !fields[1] || (!noAddress && !fields[2])
    || !Number.isInteger(cutoffMinutes) || cutoffMinutes < 0 || cutoffMinutes > 1439) return failure(400, 'INVALID_PROFILE');

  let png;
  if (logo !== undefined && logo !== null) {
    png = await normalizeLogo(logo);
    if (!png) return failure(400, 'INVALID_LOGO');
  }
  return transaction(pool, async client => {
    const digest = png ? createHash('sha256').update(png).digest('hex') : null;
    if (digest) {
      await client.query('INSERT INTO restaurant_logos (digest,png) VALUES ($1,$2) ON CONFLICT DO NOTHING', [digest, png]);
    }
    await client.query(`
      UPDATE restaurant_profile SET name=$1,location_label=$2,address=$3,cutoff_minutes=$4,
        logo_digest=CASE WHEN $5 THEN $6 ELSE logo_digest END WHERE singleton
    `, [...fields, logo !== undefined, digest]);
    return {status: 200, body: await readProfile(client)};
  });
}

function profileRoutes(app, pool, route) {
  app.get(['/profile', '/settings/profile'], route(async (_req, res) => res.json(await readProfile(pool))));
  app.put('/settings/profile', route(async (req, res) => {
    const result = await saveProfile(pool, req.body);
    res.status(result.status).json(result.body);
  }));
  app.get('/logos/:digest', route(async (req, res) => {
    if (!LOGO_DIGEST.test(req.params.digest)) return res.status(404).json({code: 'LOGO_NOT_FOUND'});
    const {rows: [logo]} = await pool.query('SELECT png FROM restaurant_logos WHERE digest=$1', [req.params.digest]);
    return logo ? res.type('image/png').send(logo.png) : res.status(404).json({code: 'LOGO_NOT_FOUND'});
  }));
}

module.exports = {LOGO_REQUEST_LIMIT, readProfile, receiptIdentity, profileRoutes};
