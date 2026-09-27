/**
 * Helper script to generate JWT secret, anon key, and service_role key
 * for self-hosted Supabase Auth (GoTrue) in Kubernetes / k3s.
 *
 * Uses Node.js built-in crypto module (no npm dependencies required).
 *
 * Usage:
 *   node scripts/generate-k8s-keys.js [custom-jwt-secret]
 */

const crypto = require('crypto');

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signatureInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${signatureInput}.${signature}`;
}

const jwtSecret = process.argv[2] || crypto.randomBytes(32).toString('hex');
const cronSecret = crypto.randomBytes(32).toString('hex');
const internalApiSecret = crypto.randomBytes(32).toString('hex');
const dbPassword = crypto.randomBytes(16).toString('hex');

const now = Math.floor(Date.now() / 1000);
const exp = now + (10 * 365 * 24 * 60 * 60); // 10 years expiration

const anonPayload = {
  role: 'anon',
  iss: 'supabase',
  iat: now,
  exp: exp,
};

const serviceRolePayload = {
  role: 'service_role',
  iss: 'supabase',
  iat: now,
  exp: exp,
};

const anonKey = signJwt(anonPayload, jwtSecret);
const serviceRoleKey = signJwt(serviceRolePayload, jwtSecret);

console.log('\n==================================================');
console.log('  Pronto k3s Self-Hosted Credentials Generator');
console.log('==================================================\n');
console.log(`JWT_SECRET:                ${jwtSecret}`);
console.log(`POSTGRES_PASSWORD:         ${dbPassword}`);
console.log(`CRON_SECRET:               ${cronSecret}`);
console.log(`INTERNAL_API_SECRET:       ${internalApiSecret}`);
console.log(`\nNEXT_PUBLIC_SUPABASE_ANON_KEY:\n${anonKey}`);
console.log(`\nSUPABASE_SERVICE_ROLE_KEY:\n${serviceRoleKey}`);
console.log('\n==================================================\n');

// Output as env format if requested
if (process.argv.includes('--env')) {
  console.log('# Copy into k8s/01-configmap-secrets.yaml:');
  console.log(`GOTRUE_JWT_SECRET="${jwtSecret}"`);
  console.log(`POSTGRES_PASSWORD="${dbPassword}"`);
  console.log(`CRON_SECRET="${cronSecret}"`);
  console.log(`INTERNAL_API_SECRET="${internalApiSecret}"`);
  console.log(`NEXT_PUBLIC_SUPABASE_ANON_KEY="${anonKey}"`);
  console.log(`SUPABASE_SERVICE_ROLE_KEY="${serviceRoleKey}"`);
}
