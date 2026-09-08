import { execFileSync } from 'node:child_process';
import {
  disposableUrl,
  validateContainer,
  verifyDisposableDatabase,
} from '../../scripts/disposable-db-identity';

jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));

describe('destructive database identity guard', () => {
  const originalPort = process.env.TEST_DB_PORT;
  beforeEach(() => {
    delete process.env.TEST_DB_PORT;
    jest.clearAllMocks();
  });
  afterAll(() => {
    if (originalPort === undefined) delete process.env.TEST_DB_PORT;
    else process.env.TEST_DB_PORT = originalPort;
  });

  it.each([
    undefined,
    '',
    'not a URL',
    'postgresql://prod:secret@prod.example.com/geofence_gf3_disposable',
    disposableUrl().replace('127.0.0.1', '127.0.0.1.example.com'),
    disposableUrl().replace('127.0.0.1', 'localhost'),
    disposableUrl().replace('55433', '5432'),
    disposableUrl().replace(
      'geofence_gf3_disposable?',
      'production_geofence_gf3_disposable?',
    ),
    disposableUrl().replace(
      'geofence_gf3_disposable?',
      'GEOFENCE_GF3_DISPOSABLE?',
    ),
    disposableUrl().replace(
      'geofence_gf3_disposable?',
      '%67eofence_gf3_disposable?',
    ),
    disposableUrl() + '&host=prod.example.com',
    disposableUrl() + '&port=5432',
    disposableUrl() + '&schema=other',
    disposableUrl() + '#fragment',
    disposableUrl().replace('geofence_test:', 'other:'),
  ])('refuses unsafe URL before Docker or database access: %s', (url) => {
    expect(() => verifyDisposableDatabase(url)).toThrow(/Refusing/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each(['5432', '55433/other', '55433?host=prod', '055433', '65536', ''])(
    'refuses unsafe port override %s',
    (port) => {
      process.env.TEST_DB_PORT = port;
      expect(() => disposableUrl()).toThrow(/TEST_DB_PORT/);
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  const fixture = () => ({
    Name: '/geofence-gf3-disposable-postgis',
    Config: {
      Image: 'postgis/postgis:16-3.4',
      Labels: {
        'com.docker.compose.project': 'geofence-gf3-disposable-test',
        'com.docker.compose.service': 'postgis-test',
      },
      Env: [
        'POSTGRES_USER=geofence_test',
        'POSTGRES_PASSWORD=geofence_test_only_not_a_secret',
        'POSTGRES_DB=geofence_gf3_disposable',
        'PGDATA=/var/lib/postgresql/data',
      ],
    },
    HostConfig: {
      Tmpfs: { '/var/lib/postgresql/data': '' },
      PortBindings: {
        '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55433' }],
      },
    },
    Mounts: [{ Type: 'tmpfs', Destination: '/var/lib/postgresql/data' }],
    State: { Running: true, Health: { Status: 'healthy' } },
  });

  it('accepts only the full local Docker identity', () => {
    jest
      .mocked(execFileSync)
      .mockReturnValueOnce(
        JSON.stringify([
          {
            Endpoints: {
              docker: { Host: 'npipe:////./pipe/dockerDesktopLinuxEngine' },
            },
          },
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([fixture()]));
    expect(verifyDisposableDatabase(disposableUrl())).toBe(disposableUrl());
  });

  it('rejects persistent storage even with the correct name', () => {
    const container = fixture();
    container.Mounts[0].Type = 'volume';
    expect(() => validateContainer(container)).toThrow(/Refusing/);
  });

  it('rejects overridden Compose identity or port', () => {
    const container = fixture();
    container.Config.Env[0] = 'POSTGRES_USER=production';
    expect(() => validateContainer(container)).toThrow(/Refusing/);
    const wrongPort = fixture();
    wrongPort.HostConfig.PortBindings['5432/tcp'][0].HostPort = '5432';
    expect(() => validateContainer(wrongPort)).toThrow(/Refusing/);
  });

  it('rejects a remote Docker context before inspecting a container', () => {
    jest
      .mocked(execFileSync)
      .mockReturnValueOnce(
        JSON.stringify([
          { Endpoints: { docker: { Host: 'tcp://prod:2375' } } },
        ]),
      );
    expect(() => verifyDisposableDatabase(disposableUrl())).toThrow(/local/);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
