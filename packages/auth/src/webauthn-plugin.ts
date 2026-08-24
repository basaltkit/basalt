import { createToken, definePlugin } from '@basaltkit/core'
import {
  WebAuthnService,
  MemoryPasskeyStore,
  MemoryWebAuthnChallengeStore,
  type PasskeyStore,
  type WebAuthnChallengeStore,
  type WebAuthnConfig,
  type WebAuthnVerifier,
} from './webauthn.js'

export const WEBAUTHN = createToken<WebAuthnService>('auth:webauthn')

export interface WebAuthnPluginOptions {
  config: WebAuthnConfig
  /** The crypto boundary — implement over `@simplewebauthn/server`. Required. */
  verifier: WebAuthnVerifier
  /** Passkey storage. Default: in-memory (swap for a durable store). */
  credentials?: PasskeyStore
  /** Challenge storage. Default: in-memory. */
  challenges?: WebAuthnChallengeStore
}

/** Registers a {@link WebAuthnService} under the {@link WEBAUTHN} token. */
export function webauthnPlugin(options: WebAuthnPluginOptions) {
  return definePlugin({
    name: 'basalt:auth-webauthn',
    register({ container }) {
      container.singleton(
        WEBAUTHN,
        () =>
          new WebAuthnService({
            config: options.config,
            verifier: options.verifier,
            credentials: options.credentials ?? new MemoryPasskeyStore(),
            challenges: options.challenges ?? new MemoryWebAuthnChallengeStore(),
          }),
      )
    },
  })
}
