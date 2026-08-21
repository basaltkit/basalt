import { createHash, createHmac } from 'node:crypto'
import type { MailDriver } from '../driver.js'
import { MailDeliveryError, type ResolvedMail } from '../message.js'

export interface SesDriverOptions {
  /** AWS region, e.g. `eu-west-1`. */
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** For temporary STS credentials. */
  sessionToken?: string
  /** Override the endpoint host (default `email.<region>.amazonaws.com`). */
  endpoint?: string
  /** Injectable fetch (for tests). Default: global `fetch`. */
  fetch?: typeof fetch
  /** Injectable clock (for deterministic signature tests). Default: `Date`. */
  now?: () => Date
}

/**
 * Delivers via **Amazon SES v2** (`SendEmail`) over HTTPS with a hand-rolled
 * SigV4 signature — `node:crypto` only, so the mailer stays free of the AWS SDK.
 * Use SES SMTP credentials with the `smtp` driver instead if you prefer.
 */
export class SesMailDriver implements MailDriver {
  readonly name = 'ses'
  private readonly host: string
  private readonly doFetch: typeof fetch

  constructor(private readonly options: SesDriverOptions) {
    this.host = options.endpoint ?? `email.${options.region}.amazonaws.com`
    this.doFetch = options.fetch ?? fetch
  }

  async send(message: ResolvedMail): Promise<void> {
    const path = '/v2/email/outbound-emails'
    const body = JSON.stringify({
      FromEmailAddress: message.from,
      Destination: {
        ToAddresses: message.to,
        ...(message.cc.length > 0 ? { CcAddresses: message.cc } : {}),
        ...(message.bcc.length > 0 ? { BccAddresses: message.bcc } : {}),
      },
      ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: message.subject },
          Body: {
            ...(message.text ? { Text: { Data: message.text } } : {}),
            ...(message.html ? { Html: { Data: message.html } } : {}),
          },
        },
      },
    })

    const headers = this.sign(path, body)
    const res = await this.doFetch(`https://${this.host}${path}`, { method: 'POST', headers, body })
    if (!res.ok) {
      throw new MailDeliveryError('ses', res.status, (await safeText(res)).slice(0, 500))
    }
  }

  async disconnect(): Promise<void> {
    /* stateless HTTP driver — nothing to close */
  }

  /** AWS Signature Version 4 for a POST to the SES endpoint. */
  private sign(path: string, body: string): Record<string, string> {
    const { region, accessKeyId, secretAccessKey, sessionToken } = this.options
    const service = 'ses'
    const amzDate = (this.options.now?.() ?? new Date())
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, '') // 2026-08-21T20:24:06.123Z → 20260821T202406Z
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = sha256(body)

    const canonicalHeaders =
      `content-type:application/json\n` +
      `host:${this.host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n` +
      (sessionToken ? `x-amz-security-token:${sessionToken}\n` : '')
    const signedHeaders =
      'content-type;host;x-amz-content-sha256;x-amz-date' + (sessionToken ? ';x-amz-security-token' : '')

    const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
    const scope = `${dateStamp}/${region}/${service}/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')

    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp)
    const kRegion = hmac(kDate, region)
    const kService = hmac(kRegion, service)
    const kSigning = hmac(kService, 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

    return {
      'content-type': 'application/json',
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
    }
  }
}

const sha256 = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest()

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
