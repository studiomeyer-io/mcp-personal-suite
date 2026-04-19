/**
 * Shared Library — Re-exports
 */

export { logger } from './logger.js';
export {
  startDualTransport,
  type McpServerFactory,
  type DualTransportOptions,
  type TransportResult,
} from './dual-transport.js';
export {
  loadConfig,
  saveConfig,
  updateConfig,
  clearConfigCache,
  getModuleStatus,
  getConfigDir,
  getConfigPath,
  type SuiteConfig,
  type EmailConfig,
  type CalendarConfig,
  type MessagingConfig,
  type SearchConfig,
  type OAuthTokens,
  type ImapSmtpConfig,
  type TelegramConfig,
  type DiscordConfig,
  type SlackConfig,
  type WhatsAppConfig,
  type ModuleStatus,
} from './config.js';
export {
  jsonResponse,
  textResponse,
  errorResponse,
  MODULE_PREFIXES,
  type ToolResponse,
  type ToolContent,
  type ModuleRegistrar,
  type McpServerLike,
  type ModuleName,
} from './types.js';
