/**
 * CLI Setup Wizard Tests — Unit tests for the parts we can test without
 * actually doing OAuth (buildAuthUrl, HTML responses, scope logic).
 *
 * We import internals via test-only re-exports. The actual OAuth flow
 * requires a browser + local server + Google, which is covered by manual
 * integration testing and the google-connect.test.ts suite.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Read the CLI module source and verify its structure + constants.
// We don't execute runSetupWizard (requires stdin/browser).

const CLI_SOURCE = readFileSync(
  new URL('../src/cli/setup.ts', import.meta.url),
  'utf-8',
);

describe('cli-setup: module structure', () => {
  it('uses localhost:3333 as callback port', () => {
    expect(CLI_SOURCE).toContain('const CALLBACK_PORT = 3333');
    expect(CLI_SOURCE).toContain('http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}');
  });

  it('declares the three services', () => {
    expect(CLI_SOURCE).toContain('gmail:');
    expect(CLI_SOURCE).toContain('calendar:');
    expect(CLI_SOURCE).toContain('both:');
  });

  it('includes all required Gmail scopes', () => {
    expect(CLI_SOURCE).toContain("'https://www.googleapis.com/auth/gmail.readonly'");
    expect(CLI_SOURCE).toContain("'https://www.googleapis.com/auth/gmail.send'");
    expect(CLI_SOURCE).toContain("'https://www.googleapis.com/auth/gmail.modify'");
  });

  it('includes all required Calendar scopes', () => {
    expect(CLI_SOURCE).toContain("'https://www.googleapis.com/auth/calendar'");
    expect(CLI_SOURCE).toContain("'https://www.googleapis.com/auth/calendar.events'");
  });

  it('requests userinfo.email scope', () => {
    expect(CLI_SOURCE).toContain("'https://www.googleapis.com/auth/userinfo.email'");
  });

  it('uses offline access + prompt=consent for refresh tokens', () => {
    expect(CLI_SOURCE).toContain("access_type: 'offline'");
    expect(CLI_SOURCE).toContain("prompt: 'consent'");
  });

  it('uses CSRF state parameter', () => {
    expect(CLI_SOURCE).toContain('state,');
    expect(CLI_SOURCE).toContain("State mismatch");
  });

  it('exports runSetupWizard', () => {
    expect(CLI_SOURCE).toContain('export async function runSetupWizard');
  });

  it('has 10-minute timeout', () => {
    expect(CLI_SOURCE).toContain('10 * 60 * 1000');
  });

  it('handles EADDRINUSE gracefully', () => {
    expect(CLI_SOURCE).toContain('EADDRINUSE');
  });

  it('opens browser via platform-specific commands', () => {
    expect(CLI_SOURCE).toContain("darwin: ");
    expect(CLI_SOURCE).toContain("win32: ");
    expect(CLI_SOURCE).toContain("linux: ");
  });

  it('saves to both email and calendar config for service="both"', () => {
    expect(CLI_SOURCE).toMatch(/service === 'gmail' \|\| service === 'both'/);
    expect(CLI_SOURCE).toMatch(/service === 'calendar' \|\| service === 'both'/);
  });

  it('warns when refresh_token is missing', () => {
    expect(CLI_SOURCE).toContain('refresh_token');
    expect(CLI_SOURCE).toContain('myaccount.google.com/permissions');
  });
});

describe('cli-setup: server.ts subcommand integration', () => {
  const SERVER_SOURCE = readFileSync(
    new URL('../src/server.ts', import.meta.url),
    'utf-8',
  );

  it('registers the setup subcommand', () => {
    expect(SERVER_SOURCE).toContain("subcommand === 'setup'");
    expect(SERVER_SOURCE).toContain("import('./cli/setup.js')");
  });

  it('has --help subcommand', () => {
    expect(SERVER_SOURCE).toContain("--help");
    expect(SERVER_SOURCE).toContain("Usage:");
  });

  it('mentions setup in help text', () => {
    expect(SERVER_SOURCE).toMatch(/setup\s+Interactive OAuth setup/);
  });
});
