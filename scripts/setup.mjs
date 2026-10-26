import { randomBytes } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
try { await access('.env'); console.log('.env already exists'); }
catch {
  const example = await readFile('.env.example', 'utf8');
  await writeFile('.env', example.replace('SECRET_ENCRYPTION_KEY=', `SECRET_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`), {mode:0o600});
  console.log('Created .env with a random local encryption key');
}
