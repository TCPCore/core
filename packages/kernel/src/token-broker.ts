import type { AdapterConfig, AuthType, Integration } from '@tcpcore1/shared';
import {
  CredentialCryptoError,
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
} from './crypto.js';
import type { Actor, KernelStore, StoredCredential } from './types.js';

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

export interface AuthHeaderResult {
  headers: Record<string, string>;
  /** Which mechanism produced the header — surfaced in the UI, never the value. */
  mechanism: AuthType | 'oauth2-refreshed';
  /** True when a credential had to be fetched/refreshed for this call. */
  refreshed: boolean;
}

export interface TokenBrokerOptions {
  store: KernelStore;
  /** 32-byte AES key. When absent, only `jwt` + `none` integrations can run. */
  encryptionKey?: Buffer;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-refresh timeout. */
  timeoutMs?: number;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/** Default header per auth type, matching common vendor conventions. */
const DEFAULT_HEADERS: Record<AuthType, string> = {
  bearer: 'Authorization',
  jwt: 'Authorization',
  oauth2: 'Authorization',
  api_key: 'Authorization',
  none: '',
};

/**
 * Token broker: the only component that holds plaintext credentials.
 *
 * Responsibilities:
 *  - Produce the outbound auth header for an integration.
 *  - Decrypt credentials from the store at call time (never hold them in the
 *    registry or hand them to callers).
 *  - Refresh OAuth2 tokens and persist the rotated material.
 *
 * Invariant (from the architecture doc): no secret ever appears in a response
 * body. This class returns *headers*; the caller merges them into a request and
 * the audit layer redacts anything secret-shaped.
 */
export class TokenBroker {
  private readonly store: KernelStore;
  private readonly encryptionKey?: Buffer;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly oauthCache = new Map<string, CachedToken>();

  constructor(options: TokenBrokerOptions) {
    this.store = options.store;
    this.encryptionKey = options.encryptionKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private requireKey(): Buffer {
    if (!this.encryptionKey) {
      throw new CredentialError(
        'No credential encryption key configured (TCPCORE_CREDENTIAL_KEY). ' +
          'Integrations that need a stored secret cannot be called.',
      );
    }
    return this.encryptionKey;
  }

  /** Encrypt and persist a credential. The only write path for secrets. */
  async storeCredential(input: {
    integration: Integration;
    secret: string;
    refreshToken?: string;
    expiresAt?: string | null;
    scopes?: string[] | null;
  }): Promise<StoredCredential> {
    const key = this.requireKey();

    const credential: StoredCredential = {
      integrationId: input.integration.id,
      integrationName: input.integration.name,
      authType: input.integration.authType,
      encryptedBlob: encryptSecret(input.secret, key),
      refreshTokenEnc: input.refreshToken ? encryptSecret(input.refreshToken, key) : null,
      expiresAt: input.expiresAt ?? null,
      scopes: input.scopes ?? null,
      updatedAt: new Date().toISOString(),
    };

    await this.store.saveCredential(credential);
    this.oauthCache.delete(input.integration.name);
    return credential;
  }

  async deleteCredential(integrationName: string): Promise<void> {
    await this.store.deleteCredential(integrationName);
    this.oauthCache.delete(integrationName);
  }

  /** Describe credential state for the UI without revealing material. */
  async describeCredential(integration: Integration): Promise<{
    configured: boolean;
    maskedSecret: string;
    /**
     * Stable, non-reversible fingerprint of the stored (encrypted) credential.
     * Lets an operator verify that the credential in use is the one they
     * uploaded, and compare two environments, without decrypting anything.
     */
    fingerprint: string;
    status: 'ACTIVE' | 'EXPIRED' | 'NEEDS_REAUTHORIZATION' | 'MISSING';
    expiresAt: string | null;
    scopes: string[] | null;
  }> {
    if (integration.authType === 'none') {
      return {
        configured: true,
        maskedSecret: '(no auth)',
        fingerprint: '(no auth)',
        status: 'ACTIVE',
        expiresAt: null,
        scopes: null,
      };
    }

    const stored = await this.store.getCredential(integration.name);
    if (!stored) {
      return {
        configured: false,
        maskedSecret: '(not configured)',
        fingerprint: '(not configured)',
        status: 'MISSING',
        expiresAt: null,
        scopes: null,
      };
    }

    let expired = false;
    if (stored.expiresAt) {
      expired = Date.parse(stored.expiresAt) <= Date.now();
    }

    return {
      configured: true,
      // The stored value is ciphertext and is deliberately never decrypted just
      // to build a display string. Previously this returned a hardcoded
      // `maskSecret('••••••••')`, which was identical for every credential and
      // therefore verified nothing; the fingerprint below is what actually
      // answers "is this the credential I uploaded?".
      maskedSecret: '(stored)',
      fingerprint: fingerprintSecret(stored.encryptedBlob),
      status: expired ? 'EXPIRED' : 'ACTIVE',
      expiresAt: stored.expiresAt,
      scopes: stored.scopes,
    };
  }

  /**
   * Build the outbound auth headers for a governed call.
   */
  async getAuthHeader(integration: Integration, actor: Actor): Promise<AuthHeaderResult> {
    const authHeaderName = DEFAULT_HEADERS[integration.authType];

    switch (integration.authType) {
      case 'none':
        return { headers: {}, mechanism: 'none', refreshed: false };

      case 'jwt': {
        // Identity passthrough. The adapter may declare
        // `source: agent_token`, which means "forward the caller's own token";
        // anything else would require a stored service token.
        if (actor.bearerToken) {
          return {
            headers: {
              [authHeaderName]: `Bearer ${actor.bearerToken}`,
            },
            mechanism: 'jwt',
            refreshed: false,
          };
        }

        const stored = await this.store.getCredential(integration.name);
        if (!stored) {
          throw new CredentialError(
            `Integration "${integration.name}" uses auth.type: jwt but the caller supplied no ` +
              `bearer token and no service credential is stored.`,
          );
        }
        return {
          headers: {
            [authHeaderName]: `Bearer ${decryptSecret(stored.encryptedBlob, this.requireKey())}`,
          },
          mechanism: 'jwt',
          refreshed: false,
        };
      }

      case 'bearer':
      case 'api_key': {
        const stored = await this.store.getCredential(integration.name);
        if (!stored) {
          throw new CredentialError(
            `Integration "${integration.name}" (auth.type: ${integration.authType}) has no stored ` +
              `credential. Upload one via the Integrations tab or the API.`,
          );
        }

        const secret = decryptSecret(stored.encryptedBlob, this.requireKey());
        const prefix = integration.authType === 'api_key' ? '' : 'Bearer ';
        return {
          headers: { [authHeaderName]: prefix ? `${prefix}${secret}` : secret },
          mechanism: integration.authType,
          refreshed: false,
        };
      }

      case 'oauth2':
        return this.getOAuth2Header(integration, actor);

      default: {
        const exhaustive: never = integration.authType;
        throw new CredentialError(`Unsupported auth type: ${String(exhaustive)}`);
      }
    }
  }

  private async getOAuth2Header(
    integration: Integration,
    _actor: Actor,
  ): Promise<AuthHeaderResult> {
    const cached = this.oauthCache.get(integration.name);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return {
        headers: { Authorization: `Bearer ${cached.accessToken}` },
        mechanism: 'oauth2',
        refreshed: false,
      };
    }

    const stored = await this.store.getCredential(integration.name);
    if (!stored) {
      throw new CredentialError(
        `Integration "${integration.name}" uses OAuth2 but no credential is stored.`,
      );
    }

    const key = this.requireKey();
    const accessToken = decryptSecret(stored.encryptedBlob, key);

    // Token still valid: reuse it.
    if (stored.expiresAt && Date.parse(stored.expiresAt) > Date.now() + 30_000) {
      this.oauthCache.set(integration.name, {
        accessToken,
        expiresAt: Date.parse(stored.expiresAt),
      });
      return {
        headers: { Authorization: `Bearer ${accessToken}` },
        mechanism: 'oauth2',
        refreshed: false,
      };
    }

    // No refresh token means we cannot mint a new one.
    if (!stored.refreshTokenEnc) {
      if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) {
        throw new CredentialError(
          `OAuth2 credential for "${integration.name}" has expired and no refresh token is stored. ` +
            `Re-authorize the integration.`,
        );
      }
      return {
        headers: { Authorization: `Bearer ${accessToken}` },
        mechanism: 'oauth2',
        refreshed: false,
      };
    }

    const refreshed = await this.refreshOAuth2(integration, stored, key);
    return {
      headers: { Authorization: `Bearer ${refreshed.accessToken}` },
      mechanism: 'oauth2-refreshed',
      refreshed: true,
    };
  }

  /**
   * Perform a `refresh_token` grant and persist the rotated material.
   *
   * Rotation is persisted because most providers invalidate the previous
   * refresh token; failing to write it back would break the integration on the
   * next call.
   */
  private async refreshOAuth2(
    integration: Integration,
    stored: StoredCredential,
    key: Buffer,
  ): Promise<CachedToken> {
    const adapter = integration as Integration & { authConfig?: AdapterConfig['auth'] };
    const tokenEndpoint =
      adapter.authConfig?.token_endpoint ?? (await this.tokenEndpointFor(integration));

    if (!tokenEndpoint) {
      throw new CredentialError(
        `OAuth2 refresh for "${integration.name}" needs a token_endpoint ` +
          `(declared in the adapter's auth block).`,
      );
    }

    const refreshToken = decryptSecret(stored.refreshTokenEnc!, key);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new CredentialError(
        `OAuth2 refresh request to ${tokenEndpoint} failed: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new CredentialError(
        `OAuth2 token endpoint returned HTTP ${response.status} for "${integration.name}"`,
      );
    }

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!payload.access_token) {
      throw new CredentialError('OAuth2 token response did not include access_token');
    }

    const expiresAt = payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : null;

    await this.storeCredential({
      integration,
      secret: payload.access_token,
      refreshToken: payload.refresh_token ?? refreshToken,
      expiresAt,
      scopes: stored.scopes,
    });

    const cached: CachedToken = {
      accessToken: payload.access_token,
      expiresAt: expiresAt ? Date.parse(expiresAt) : Date.now() + 3600_000,
    };
    this.oauthCache.set(integration.name, cached);
    return cached;
  }

  /**
   * Recover the adapter's declared token endpoint from the stored YAML.
   * Avoids widening the `Integration` row with a column for every auth knob.
   */
  private async tokenEndpointFor(integration: Integration): Promise<string | undefined> {
    if (!integration.configYaml) return undefined;
    try {
      const { parseAdapterYaml } = await import('./registry.js');
      return parseAdapterYaml(integration.configYaml, integration.name).auth.token_endpoint;
    } catch {
      return undefined;
    }
  }

  /** Test seam: forget cached access tokens. */
  clearCache(): void {
    this.oauthCache.clear();
  }
}

export { CredentialCryptoError };
