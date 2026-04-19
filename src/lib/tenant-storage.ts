/**
 * Tenant Storage — AsyncLocalStorage for per-request tenant context
 *
 * Lives in lib/ (not saas/) to avoid circular dependencies.
 * lib/config.ts checks this to decide between filesystem and DB config.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string;
  email?: string;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function getCurrentTenantId(): string | undefined {
  return tenantStorage.getStore()?.tenantId;
}

export function getCurrentTenantEmail(): string | undefined {
  return tenantStorage.getStore()?.email;
}

export function withTenant<T>(
  tenantId: string,
  callback: () => T | Promise<T>,
  email?: string,
): Promise<T> {
  return tenantStorage.run({ tenantId, email }, () => Promise.resolve(callback()));
}
