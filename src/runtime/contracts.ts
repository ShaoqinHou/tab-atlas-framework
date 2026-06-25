import path from 'node:path';
import { z } from 'zod';

export const RuntimeProfile = z.enum(['production', 'roleplay', 'acceptance', 'development', 'test']);
export type RuntimeProfile = z.infer<typeof RuntimeProfile>;

export const DatabaseEnvironment = z.enum(['production', 'clone', 'acceptance', 'development', 'test']);
export type DatabaseEnvironment = z.infer<typeof DatabaseEnvironment>;

export interface RuntimeConfig {
  profile: RuntimeProfile;
  port: number;
  databasePath: string;
  bootstrapDirectory: string;
  instanceName: string;
  recoverStaleLease: boolean;
  allowIdentityInitialization: boolean;
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RuntimeConfig {
  const profile = RuntimeProfile.safeParse(env.TABATLAS_RUNTIME_PROFILE);
  if (!profile.success) {
    throw new Error('TABATLAS_RUNTIME_PROFILE is required and must be one of production, roleplay, acceptance, development, or test.');
  }

  const port = parsePort(env.TABATLAS_PORT);
  const databasePath = resolveRequiredPath(env.TABATLAS_DB, cwd, 'TABATLAS_DB');
  const bootstrapDirectory = env.TABATLAS_BOOTSTRAP_DIR
    ? path.resolve(cwd, env.TABATLAS_BOOTSTRAP_DIR)
    : path.join(path.dirname(databasePath), 'bootstrap');

  return {
    profile: profile.data,
    port,
    databasePath,
    bootstrapDirectory,
    instanceName: env.TABATLAS_INSTANCE_NAME?.trim() || `tabatlas-${profile.data}-${port}`,
    recoverStaleLease: env.TABATLAS_RECOVER_STALE_LEASE === '1',
    allowIdentityInitialization: env.TABATLAS_ALLOW_IDENTITY_INIT === '1',
  };
}

export function expectedDatabaseEnvironments(profile: RuntimeProfile): DatabaseEnvironment[] {
  switch (profile) {
    case 'production':
      return ['production'];
    case 'roleplay':
      return ['clone'];
    case 'acceptance':
      return ['acceptance', 'clone', 'test'];
    case 'development':
      return ['development', 'clone', 'test'];
    case 'test':
      return ['test'];
    default:
      return assertNever(profile);
  }
}

export function assertProfileDatabaseCompatibility(profile: RuntimeProfile, environment: DatabaseEnvironment): void {
  const allowed = expectedDatabaseEnvironments(profile);
  if (!allowed.includes(environment)) {
    throw new Error(`Runtime profile ${profile} cannot open a ${environment} database. Allowed database environments: ${allowed.join(', ')}.`);
  }
}

function parsePort(value: string | undefined): number {
  if (!value?.trim()) throw new Error('TABATLAS_PORT is required.');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`TABATLAS_PORT must be an integer from 1 to 65535; received ${value}.`);
  }
  return port;
}

function resolveRequiredPath(value: string | undefined, cwd: string, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return path.resolve(cwd, value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime profile: ${String(value)}`);
}
