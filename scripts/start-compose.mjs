// Compose supplies raw database credentials. Encode URL components so passwords
// containing #, /, @ or ? reach PostgreSQL intact rather than changing the URL.
import { spawn } from 'node:child_process';

const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env;
if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
  throw new Error(
    'Compose requires POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB.',
  );
}
process.env.DATABASE_URL =
  `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}` +
  `@postgres:5432/${encodeURIComponent(POSTGRES_DB)}?schema=public`;
const child = spawn('npm', ['run', 'start:dev'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
