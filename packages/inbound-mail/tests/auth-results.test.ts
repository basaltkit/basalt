import { describe, expect, it } from 'vitest'
import { authResultsOf, parseInbound, type HeaderField } from '../src/index.js'
import { authservIdOf, stripComments } from '../src/auth-results.js'
import { eml } from './helpers.js'

const TRUSTED = { trustedAuthservIds: ['mx.cloudflare.net'] }
const ar = (value: string): HeaderField => ({ key: 'authentication-results', value })

/**
 * Cases ported from the Mukanda app's `authOf` tests (tests/mail.test.ts):
 * the verdict only counts when a TRUSTED server wrote it, and a forward is
 * rescued only by the ARC seal of a TRUSTED sealer.
 */
describe('authResultsOf (ported from Mukanda authOf)', () => {
  it('takes the verdict of a trusted server', () => {
    expect(authResultsOf([ar('mx.cloudflare.net; spf=pass; dkim=pass header.d=kilamba.ao; dmarc=pass header.from=kilamba.ao')], TRUSTED)).toEqual({
      authservId: 'mx.cloudflare.net',
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
      dkimDomains: ['kilamba.ao'],
    })
  })

  it('reports a failing trusted verdict as it is', () => {
    expect(authResultsOf([ar('mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail header.from=kilamba.ao')], TRUSTED)).toMatchObject({
      spf: 'fail',
      dkim: 'none',
      dmarc: 'fail',
      dkimDomains: [],
    })
  })

  it('ignores a verdict the sender wrote under its own id', () => {
    expect(authResultsOf([ar('mail.kilamba.ao; dmarc=pass')], TRUSTED)).toEqual({ spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', dkimDomains: [] })
  })

  it('a domain without DMARC: dmarc=none with spf=pass', () => {
    expect(authResultsOf([ar('mx.cloudflare.net; spf=pass smtp.mailfrom=fornecedor.co.ao; dkim=none; dmarc=none')], TRUSTED)).toMatchObject({
      spf: 'pass',
      dmarc: 'none',
    })
    expect(authResultsOf([ar('mx.cloudflare.net; spf=softfail; dkim=none; dmarc=none')], TRUSTED)).toMatchObject({ spf: 'softfail' })
  })

  it('a passing DKIM for another domain is reported with that domain', () => {
    expect(authResultsOf([ar('mx.cloudflare.net; spf=pass; dkim=pass header.d=evil.example; dmarc=fail')], TRUSTED)).toMatchObject({
      dkim: 'pass',
      dmarc: 'fail',
      dkimDomains: ['evil.example'],
    })
  })

  const forward = (sealer: string): HeaderField[] => [
    ar('mx.cloudflare.net; spf=fail smtp.mailfrom=ndalu.ao; dkim=fail; arc=pass (i=1); dmarc=fail header.from=kilamba.ao'),
    { key: 'arc-seal', value: `i=1; a=rsa-sha256; t=1726300000; cv=none; d=${sealer}; s=arc-20240605; b=abc==` },
    {
      key: 'arc-authentication-results',
      value: `i=1; mx.${sealer}; dkim=pass header.i=@kilamba.ao; spf=pass smtp.mailfrom=kilamba.ao; dmarc=pass header.from=kilamba.ao`,
    },
  ]

  it('a forward: the ARC seal of a trusted sealer carries the original verdict', () => {
    expect(authResultsOf(forward('google.com'), { ...TRUSTED, trustedArcSealers: ['Google.com'] })).toEqual({
      authservId: 'mx.cloudflare.net',
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
      dkimDomains: ['kilamba.ao'],
      arcSealer: 'google.com',
    })
  })

  it('a forward sealed by an untrusted sealer keeps the failing direct verdict', () => {
    const result = authResultsOf(forward('reencaminhador.example'), { ...TRUSTED, trustedArcSealers: ['google.com'] })
    expect(result).toMatchObject({ dmarc: 'fail', spf: 'fail' })
    expect(result.arcSealer).toBeUndefined()
  })

  it('without trusted sealers ARC is never consulted', () => {
    expect(authResultsOf(forward('google.com'), TRUSTED)).toMatchObject({ dmarc: 'fail' })
  })
})

describe('authResultsOf (trust rule details)', () => {
  it('no trusted id configured: everything is unknown, whatever the headers say', () => {
    expect(authResultsOf([ar('mx.cloudflare.net; dmarc=pass')])).toEqual({ spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', dkimDomains: [] })
  })

  it('takes the TOPMOST trusted header; a forged trusted-looking one lower down is ignored', () => {
    const headers = [
      ar('mx.cloudflare.net; spf=fail; dmarc=fail'),
      { key: 'received', value: 'from attacker' },
      ar('mx.cloudflare.net; spf=pass; dmarc=pass'),
    ]
    expect(authResultsOf(headers, TRUSTED)).toMatchObject({ spf: 'fail', dmarc: 'fail' })
  })

  it('matches the authserv-id case-insensitively, with or without a version', () => {
    expect(authResultsOf([ar('MX.Cloudflare.NET 1; dmarc=pass')], TRUSTED)).toMatchObject({ authservId: 'mx.cloudflare.net', dmarc: 'pass' })
    expect(authResultsOf([ar('mx.cloudflare.net; dmarc=pass')], { trustedAuthservIds: ['MX.CLOUDFLARE.NET'] })).toMatchObject({ dmarc: 'pass' })
  })

  it('does not read a result out of a comment, and ignores unknown words', () => {
    const result = authResultsOf([ar('mx.cloudflare.net; spf=fail (sender said; dmarc=pass) smtp.mailfrom=x; dkim=weird; spf=pass')], TRUSTED)
    expect(result).toMatchObject({ spf: 'fail', dmarc: 'none', dkim: 'unknown' })
  })

  it('normalises hardfail and accepts method versions', () => {
    expect(authResultsOf([ar('mx.cloudflare.net; spf/1=hardfail; dmarc=policy')], TRUSTED)).toMatchObject({ spf: 'fail', dmarc: 'policy' })
  })

  it('an ARC-Authentication-Results with the trusted id is not taken as the direct verdict', () => {
    const headers = [{ key: 'arc-authentication-results', value: 'i=1; mx.cloudflare.net; dmarc=pass' }]
    expect(authResultsOf(headers, TRUSTED)).toMatchObject({ dmarc: 'unknown' })
  })

  it('ARC: uses the highest seal instance and its matching results', () => {
    const headers: HeaderField[] = [
      ar('mx.cloudflare.net; dmarc=fail; arc=pass'),
      { key: 'arc-seal', value: 'i=2; d=outlook.com; cv=pass; b=x' },
      { key: 'arc-authentication-results', value: 'i=2; mx.microsoft.com 1; dmarc=pass header.from=a.example; dkim=pass header.d=a.example' },
      { key: 'arc-seal', value: 'i=1; d=untrusted.example; cv=none; b=y' },
      { key: 'arc-authentication-results', value: 'i=1; mx.untrusted.example; dmarc=fail' },
      { key: 'arc-seal', value: 'i=bad; d=google.com' },
    ]
    expect(authResultsOf(headers, { ...TRUSTED, trustedArcSealers: ['outlook.com'] })).toMatchObject({
      dmarc: 'pass',
      dkimDomains: ['a.example'],
      arcSealer: 'outlook.com',
    })
    // The highest seal is not trusted: the lower one does not count either.
    expect(authResultsOf(headers, { ...TRUSTED, trustedArcSealers: ['untrusted.example'] })).toMatchObject({ dmarc: 'fail' })
  })

  it('ARC: arc=pass but no seal, or a seal without matching results, keeps the direct verdict', () => {
    expect(authResultsOf([ar('mx.cloudflare.net; dmarc=fail; arc=pass')], { ...TRUSTED, trustedArcSealers: ['google.com'] })).toMatchObject({ dmarc: 'fail' })
    const noResults: HeaderField[] = [ar('mx.cloudflare.net; dmarc=fail; arc=pass'), { key: 'arc-seal', value: 'i=1; d=google.com' }]
    expect(authResultsOf(noResults, { ...TRUSTED, trustedArcSealers: ['google.com'] })).toMatchObject({ dmarc: 'fail' })
  })

  it('ARC is skipped when DMARC already passed or arc did not pass', () => {
    const headers = (verdict: string): HeaderField[] => [
      ar(verdict),
      { key: 'arc-seal', value: 'i=1; d=google.com' },
      { key: 'arc-authentication-results', value: 'i=1; mx.google.com; dmarc=fail' },
    ]
    const options = { ...TRUSTED, trustedArcSealers: ['google.com'] }
    expect(authResultsOf(headers('mx.cloudflare.net; dmarc=pass; arc=pass'), options)).toMatchObject({ dmarc: 'pass' })
    expect(authResultsOf(headers('mx.cloudflare.net; dmarc=fail; arc=fail'), options)).toMatchObject({ dmarc: 'fail' })
    expect(authResultsOf(headers('mx.cloudflare.net; dmarc=fail; arc=fail'), options).arcSealer).toBeUndefined()
  })
})

describe('helpers', () => {
  it('stripComments handles nesting, quotes and escapes', () => {
    expect(stripComments('a (b (c) d) e')).toBe('a   e')
    expect(stripComments('a "(not a comment)" b')).toBe('a "(not a comment)" b')
    expect(stripComments('a (x \\) y) b')).toBe('a   b')
    expect(stripComments('"q\\"x" (c)')).toBe('"q\\"x"  ')
  })

  it('authservIdOf returns undefined for an empty value', () => {
    expect(authservIdOf('')).toBeUndefined()
    expect(authservIdOf('  ; spf=pass')).toBeUndefined()
  })
})

/**
 * The header block Cloudflare Email Routing prepends, in the shape it uses
 * (`mx.cloudflare.net` as authserv-id, an ARC set sealed by
 * `cloudflare-email.net`, `policy.dmarc` and `smtp.remote-ip` properties, an
 * SPF comment containing a `:`). Reconstructed from that format with neutral
 * values, not captured from a live message.
 */
describe('Cloudflare Email Routing shaped headers, through parseInbound', () => {
  const headers = [
    'ARC-Seal: i=1; a=rsa-sha256; s=2024; d=cloudflare-email.net; cv=none; b=Zm9v',
    'ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=cloudflare-email.net; h=From:To:Subject; s=2024; bh=YmFy; b=YmF6',
    'ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20230601 header.b=Q1w2; dmarc=pass header.from=gmail.com policy.dmarc=none; spf=pass (mx.cloudflare.net: domain of sender@gmail.com designates 209.85.128.41 as permitted sender) smtp.mailfrom=sender@gmail.com; arc=none smtp.remote-ip=209.85.128.41',
    'Authentication-Results: mx.cloudflare.net;',
    ' dkim=pass header.d=gmail.com header.s=20230601 header.b=Q1w2;',
    ' dmarc=pass header.from=gmail.com policy.dmarc=none;',
    ' spf=pass (mx.cloudflare.net: domain of sender@gmail.com designates 209.85.128.41 as permitted sender) smtp.mailfrom=sender@gmail.com;',
    ' arc=none smtp.remote-ip=209.85.128.41',
    'Authentication-Results: mx.cloudflare.net.evil.example; dmarc=fail',
    'From: Sender <sender@gmail.com>',
    'To: acme@in.example.com',
    'Subject: hello',
  ]

  it('reads the trusted verdicts (folded header included)', async () => {
    const parsed = await parseInbound(eml(headers), TRUSTED)
    expect(parsed.auth).toEqual({ authservId: 'mx.cloudflare.net', spf: 'pass', dkim: 'pass', dmarc: 'pass', dkimDomains: ['gmail.com'] })
  })

  it('with no trust configured, the same message is unknown', async () => {
    expect((await parseInbound(eml(headers))).auth.dmarc).toBe('unknown')
  })
})
