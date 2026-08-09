import { describe, expect, it } from 'vitest'
import { createApp, createToken, definePlugin } from '../src/index.js'

describe('BasaltApp lifecycle', () => {
  it('sorts plugins by dependsOn and runs register before boot', async () => {
    const order: string[] = []
    const a = definePlugin({
      name: 'a',
      dependsOn: ['b'],
      register: () => void order.push('register:a'),
      boot: () => void order.push('boot:a'),
    })
    const b = definePlugin({
      name: 'b',
      register: () => void order.push('register:b'),
      boot: () => void order.push('boot:b'),
    })

    await createApp({ plugins: [a, b] }).boot()
    expect(order).toEqual(['register:b', 'register:a', 'boot:b', 'boot:a'])
  })

  it('shutdown runs in reverse boot order', async () => {
    const order: string[] = []
    const mk = (name: string, dependsOn?: string[]) =>
      definePlugin({ name, ...(dependsOn ? { dependsOn } : {}), shutdown: () => void order.push(name) })

    const app = await createApp({ plugins: [mk('a', ['b']), mk('b')] }).boot()
    await app.shutdown()
    expect(order).toEqual(['a', 'b'])
    expect(app.phase).toBe('stopped')
  })

  it('fails on missing dependency', () => {
    const a = definePlugin({ name: 'a', dependsOn: ['inexistente'] })
    expect(() => createApp({ plugins: [a] })).toThrowError(/depends on "inexistente"/)
  })

  it('fails on dependency cycle showing the path', () => {
    const a = definePlugin({ name: 'a', dependsOn: ['b'] })
    const b = definePlugin({ name: 'b', dependsOn: ['a'] })
    expect(() => createApp({ plugins: [a, b] })).toThrowError(/a -> b -> a|b -> a -> b/)
  })

  it('validates config with schema (fail fast)', async () => {
    const plugin = definePlugin<{ driver: string }>({
      name: 'basalt:cache',
      configSchema: {
        safeParse: (input) => {
          const driver = (input as { driver?: unknown } | undefined)?.driver
          return typeof driver === 'string'
            ? { success: true, data: { driver } }
            : { success: false, error: [{ path: 'driver', message: 'required' }] }
        },
      },
    })

    await expect(createApp({ plugins: [plugin] }).boot()).rejects.toThrowError(/basalt:cache/)
    await expect(
      createApp({
        plugins: [plugin],
        config: { 'basalt:cache': { driver: 'memory' } },
      }).boot(),
    ).resolves.toBeTruthy()
  })

  it('plugins share the container and receive validated config', async () => {
    const VALUE = createToken<string>('value')
    const provider = definePlugin<{ value: string }>({
      name: 'provider',
      configSchema: { safeParse: (input) => ({ success: true, data: input as { value: string } }) },
      register: ({ container, config }) => void container.singleton(VALUE, () => config.value),
    })
    let seen = ''
    const consumer = definePlugin({
      name: 'consumer',
      dependsOn: ['provider'],
      boot: ({ container }) => void (seen = container.get(VALUE)),
    })

    await createApp({
      plugins: [provider, consumer],
      config: { provider: { value: 'ok' } },
    }).boot()
    expect(seen).toBe('ok')
  })

  it('emits lifecycle hooks', async () => {
    const events: string[] = []
    const plugin = definePlugin({
      name: 'p',
      register: ({ hooks }) => {
        hooks.on('app:booted', () => void events.push('booted'))
        hooks.on('app:shutdown', () => void events.push('shutdown'))
      },
    })
    const app = await createApp({ plugins: [plugin] }).boot()
    await app.shutdown()
    expect(events).toEqual(['booted', 'shutdown'])
  })
})
