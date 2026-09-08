const { execFileSync } = require('node:child_process');

const PROJECT = 'geofence-gf3-disposable-test';
const CONTAINER = 'geofence-gf3-disposable-postgis';
const CONTEXT = 'desktop-linux';

function disposableUrl(port = process.env.TEST_DB_PORT ?? '55433') {
  if (
    !/^[0-9]{5}$/.test(port) ||
    Number(port) < 49152 ||
    Number(port) > 65535
  ) {
    throw new Error(
      'TEST_DB_PORT must be a canonical port from 49152 through 65535.',
    );
  }
  return `postgresql://geofence_test:geofence_test_only_not_a_secret@127.0.0.1:${port}/geofence_gf3_disposable?schema=public`;
}

function validateUrl(url) {
  // Exact bytes also reject encoded names, alternate hosts, URL parameters,
  // fragments and parser normalization before any connection or Docker call.
  if (url !== disposableUrl()) {
    throw new Error(
      'Refusing destructive tests: DATABASE_URL is not the complete disposable identity. Run npm run test:db.',
    );
  }
  return url;
}

function docker(args) {
  return execFileSync('docker', ['--context', CONTEXT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function validateContainer(container, requireHealthy = true) {
  const port = new URL(disposableUrl()).port;
  const labels = container.Config?.Labels ?? {};
  const env = container.Config?.Env ?? [];
  const bindings = container.HostConfig?.PortBindings?.['5432/tcp'];
  const mounts = container.Mounts ?? [];
  if (
    container.Name !== `/${CONTAINER}` ||
    container.Config?.Image !== 'postgis/postgis:16-3.4' ||
    labels['com.docker.compose.project'] !== PROJECT ||
    labels['com.docker.compose.service'] !== 'postgis-test' ||
    ![
      'POSTGRES_USER=geofence_test',
      'POSTGRES_PASSWORD=geofence_test_only_not_a_secret',
      'POSTGRES_DB=geofence_gf3_disposable',
    ].every((value) => env.includes(value)) ||
    bindings?.length !== 1 ||
    bindings[0].HostIp !== '127.0.0.1' ||
    bindings[0].HostPort !== port ||
    mounts.some((mount) => mount.Type !== 'tmpfs') ||
    !Object.prototype.hasOwnProperty.call(
      container.HostConfig?.Tmpfs ?? {},
      '/var/lib/postgresql/data',
    ) ||
    !env.includes('PGDATA=/var/lib/postgresql/data') ||
    (requireHealthy &&
      (!container.State?.Running ||
        container.State?.Health?.Status !== 'healthy'))
  ) {
    throw new Error(
      'Refusing destructive operation: Docker container is not the isolated tmpfs test database.',
    );
  }
}

function verifyLocalDocker() {
  const [context] = JSON.parse(docker(['context', 'inspect', CONTEXT]));
  if (!context.Endpoints?.docker?.Host?.startsWith('npipe:////./pipe/')) {
    throw new Error(
      'Disposable tests require the local desktop-linux Docker engine.',
    );
  }
}

function verifyDisposableDatabase(url) {
  validateUrl(url);
  verifyLocalDocker();
  const [container] = JSON.parse(docker(['inspect', CONTAINER]));
  validateContainer(container);
  return url;
}

module.exports = {
  PROJECT,
  CONTAINER,
  CONTEXT,
  disposableUrl,
  validateUrl,
  docker,
  validateContainer,
  verifyDisposableDatabase,
  verifyLocalDocker,
};
