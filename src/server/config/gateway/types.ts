export type GatewayConfig = Record<string, unknown>;
export type GatewayConfigSource = 'default' | 'file' | 'db';

export interface GatewayConfigWarning {
  code: string;
  message: string;
}

export interface GatewayConfigState {
  config: GatewayConfig;
  source: GatewayConfigSource;
  path: string;
  warnings: GatewayConfigWarning[];
  revision: string;
}

export class GatewayConfigValidationError extends Error {}

export class GatewayConfigConflictError extends Error {
  readonly currentRevision: string;

  constructor(message: string, currentRevision: string) {
    super(message);
    this.currentRevision = currentRevision;
  }
}

export type JsonObject = Record<string, unknown>;
export type NormalizeMode = 'load' | 'save';
