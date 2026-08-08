import type { ProjectOptions } from './templates.js'

/** Kept in sync with the monorepo release line (mirror of templates.ts). */
const MACHIZE_VERSION = '^1.0.0'

/**
 * The `web/` frontend emitted when `--ui` is passed: a Vite + React app on
 * @machize/admin-shadcn (authentic shadcn/ui components) talking to the API
 * through @machize/sdk. With auth on, it ships a login/register gate and a
 * small dashboard; otherwise a live status page. The Vite dev server proxies
 * `/api` to the backend so there is no CORS to configure.
 */
export function uiFiles(options: ProjectOptions): Record<string, string> {
  return {
    'web/package.json': webPackageJson(options),
    'web/vite.config.ts': webViteConfig(),
    'web/tsconfig.json': webTsconfig(),
    'web/index.html': webIndexHtml(options),
    'web/postcss.config.js': webPostcss(),
    'web/tailwind.config.js': webTailwind(),
    'web/src/main.tsx': webMain(),
    'web/src/crypto-shim.ts': webCryptoShim(),
    'web/src/index.css': webCss(),
    'web/src/api.ts': webApi(options),
    'web/src/App.tsx': webApp(options),
  }
}

function webPackageJson(options: ProjectOptions): string {
  return `${JSON.stringify(
    {
      name: `${options.name}-web`,
      private: true,
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: {
        '@machize/admin': MACHIZE_VERSION,
        '@machize/admin-shadcn': MACHIZE_VERSION,
        '@machize/sdk': MACHIZE_VERSION,
        react: '^18.3.1',
        'react-dom': '^18.3.1',
        zod: '^3.24.0',
      },
      devDependencies: {
        '@types/react': '^18.3.0',
        '@types/react-dom': '^18.3.0',
        '@vitejs/plugin-react': '^4.3.0',
        autoprefixer: '^10.4.0',
        postcss: '^8.4.0',
        tailwindcss: '^3.4.0',
        typescript: '^5.8.0',
        vite: '^6.0.0',
      },
    },
    null,
    2,
  )}\n`
}

function webViteConfig(): string {
  return `import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @machize/admin uses randomUUID from crypto; map it to Web Crypto in the browser.
      crypto: fileURLToPath(new URL('./src/crypto-shim.ts', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    // Proxy API calls to the backend so there is no CORS in dev.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\\/api/, ''),
      },
    },
  },
})
`
}

function webTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        types: ['node'],
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`
}

function webIndexHtml(options: ProjectOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${options.name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
}

function webPostcss(): string {
  return `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`
}

function webTailwind(): string {
  return `export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}', './node_modules/@machize/admin-shadcn/dist/**/*.js'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
    },
  },
  plugins: [],
}
`
}

function webMain(): string {
  return `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './index.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`
}

function webCryptoShim(): string {
  return `export const randomUUID = (): string => globalThis.crypto.randomUUID()
`
}

function webCss(): string {
  return `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 240 20% 99%;
    --foreground: 240 10% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 3.9%;
    --primary: 243 75% 59%;
    --primary-foreground: 0 0% 100%;
    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;
    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 46.1%;
    --accent: 243 75% 96%;
    --accent-foreground: 243 60% 40%;
    --destructive: 0 72% 51%;
    --destructive-foreground: 0 0% 100%;
    --border: 240 5.9% 90%;
    --input: 240 5.9% 88%;
    --ring: 243 75% 59%;
    --radius: 0.6rem;
  }
  .dark {
    --background: 240 10% 6%;
    --foreground: 0 0% 98%;
    --card: 240 10% 9%;
    --card-foreground: 0 0% 98%;
    --primary: 243 75% 68%;
    --primary-foreground: 240 10% 6%;
    --secondary: 240 3.7% 15.9%;
    --secondary-foreground: 0 0% 98%;
    --muted: 240 3.7% 15.9%;
    --muted-foreground: 240 5% 64.9%;
    --accent: 243 40% 22%;
    --accent-foreground: 243 75% 85%;
    --destructive: 0 72% 55%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 3.7% 16%;
    --input: 240 3.7% 18%;
    --ring: 243 75% 68%;
  }
  * {
    border-color: hsl(var(--border));
  }
  body {
    margin: 0;
    background-color: hsl(var(--background));
    color: hsl(var(--foreground));
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
}
`
}

function webApi(options: ProjectOptions): string {
  const authEndpoints = options.auth
    ? `
  register: endpoint({ method: 'POST', path: '/auth/register', body: credentials, result: User }),
  login: endpoint({
    method: 'POST',
    path: '/auth/login',
    body: credentials.extend({ mfaCode: z.string().optional() }),
    result: z.object({ accessToken: z.string(), refreshToken: z.string(), user: User }),
  }),
  me: endpoint({ method: 'GET', path: '/auth/me', result: User }),
  // Password recovery
  forgotPassword: endpoint({
    method: 'POST',
    path: '/auth/password/forgot',
    body: z.object({ email: z.string().email() }),
    result: z.object({ ok: z.boolean() }),
  }),
  resetPassword: endpoint({
    method: 'POST',
    path: '/auth/password/reset',
    body: z.object({ token: z.string(), password: z.string().min(8) }),
    result: z.object({ ok: z.boolean() }),
  }),
  // TOTP / two-factor
  mfaStatus: endpoint({
    method: 'GET',
    path: '/auth/mfa/status',
    result: z.object({ enabled: z.boolean(), pending: z.boolean() }),
  }),
  mfaEnroll: endpoint({
    method: 'POST',
    path: '/auth/mfa/enroll',
    result: z.object({ secret: z.string(), otpauthUri: z.string() }),
  }),
  mfaActivate: endpoint({
    method: 'POST',
    path: '/auth/mfa/activate',
    body: z.object({ code: z.string().min(6) }),
    result: z.object({ recoveryCodes: z.array(z.string()) }),
  }),
  mfaDisable: endpoint({
    method: 'POST',
    path: '/auth/mfa/disable',
    body: z.object({ code: z.string().min(6) }),
    result: z.unknown(),
  }),`
    : ''
  const credentials = options.auth
    ? `\nconst credentials = z.object({ email: z.string().email(), password: z.string().min(8) })`
    : ''
  const user = options.auth ? `\nconst User = z.object({ id: z.string(), email: z.string() })` : ''

  return `import { createClient, endpoint, type Client as SdkClient } from '@machize/sdk'
import { z } from 'zod'
${user}${credentials}

const Index = z.object({ name: z.string(), status: z.string(), endpoints: z.array(z.string()) })
const Health = z.object({ ok: z.boolean() })

export const endpoints = {
  index: endpoint({ method: 'GET', path: '/', result: Index }),
  health: endpoint({ method: 'GET', path: '/health', result: Health }),${authEndpoints}
}

export type Api = SdkClient<typeof endpoints>

export function makeApi(getToken: () => string | undefined = () => undefined): Api {
  return createClient(endpoints, { baseUrl: '/api', getToken })
}
`
}

function webApp(options: ProjectOptions): string {
  return options.auth ? webAppWithAuth(options) : webAppStatusOnly(options)
}

function webAppStatusOnly(options: ProjectOptions): string {
  return `import { useEffect, useState } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@machize/admin-shadcn'
import { makeApi } from './api.js'

const api = makeApi()

export function App() {
  const [name, setName] = useState('${options.name}')
  const [endpoints, setEndpoints] = useState<string[]>([])
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dark, setDark] = useState(false)

  const refresh = async () => {
    setError(null)
    try {
      const [index, health] = await Promise.all([api.index(), api.health()])
      setName(index.name)
      setEndpoints(index.endpoints)
      setHealthy(health.ok)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  const toggleTheme = () => {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    setDark(next)
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>{name}</CardTitle>
          <div className="flex items-center gap-2">
            {healthy !== null && (
              <Badge variant={healthy ? 'secondary' : 'destructive'}>
                {healthy ? 'healthy' : 'down'}
              </Badge>
            )}
            <Button variant="ghost" size="sm" onClick={toggleTheme}>
              {dark ? 'Light' : 'Dark'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {error && <p className="mb-3 text-sm font-medium text-destructive">{error}</p>}
          <p className="mb-2 text-sm text-muted-foreground">Endpoints</p>
          <ul className="space-y-1">
            {endpoints.map((path) => (
              <li key={path} className="rounded-md bg-muted px-3 py-1.5 font-mono text-sm">
                {path}
              </li>
            ))}
          </ul>
          <Button className="mt-4" variant="outline" size="sm" onClick={() => void refresh()}>
            Refresh
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
`
}

function webAppWithAuth(options: ProjectOptions): string {
  return `import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@machize/admin-shadcn'
import { makeApi } from './api.js'

const STORAGE_KEY = '${options.name}.token'
const errorMessage = (err: unknown): string => String((err as Error)?.message ?? err)
const errorCode = (err: unknown): string => String((err as { code?: string })?.code ?? '')
// Password-reset emails link back here with ?token=… — that switches to the reset screen.
const resetToken = new URLSearchParams(window.location.search).get('token')

export function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY))

  const store = (next: string | null) => {
    if (next) localStorage.setItem(STORAGE_KEY, next)
    else localStorage.removeItem(STORAGE_KEY)
    setToken(next)
  }

  if (resetToken) return <ResetPassword token={resetToken} />
  if (!token) return <AuthScreen onToken={store} />
  return <Dashboard token={token} onLogout={() => store(null)} />
}

// Centered card shell reused by every auth screen.
function Shell({ subtitle, children }: { subtitle?: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>${options.name}</CardTitle>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  )
}

type Mode = 'login' | 'register' | 'forgot'

function AuthScreen({ onToken }: { onToken: (token: string) => void }) {
  const [mode, setMode] = useState<Mode>('login')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // When the account has 2FA on, login throws AUTH_MFA_REQUIRED; we keep the
  // credentials and ask for the 6-digit code, then retry.
  const [challenge, setChallenge] = useState<{ email: string; password: string } | null>(null)
  const api = makeApi()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setNotice(null)
    setBusy(true)
    const form = new FormData(event.currentTarget)
    try {
      if (challenge) {
        const res = await api.login({ body: { ...challenge, mfaCode: String(form.get('mfaCode')) } })
        onToken(res.accessToken)
        return
      }
      const email = String(form.get('email'))
      const password = String(form.get('password'))
      if (mode === 'forgot') {
        await api.forgotPassword({ body: { email } })
        setNotice('If that email exists, a reset link is on its way.')
        return
      }
      if (mode === 'register') await api.register({ body: { email, password } })
      const res = await api.login({ body: { email, password } })
      onToken(res.accessToken)
    } catch (err) {
      if (errorCode(err) === 'AUTH_MFA_REQUIRED') {
        setChallenge({
          email: String(new FormData(event.currentTarget).get('email')),
          password: String(new FormData(event.currentTarget).get('password')),
        })
      } else {
        setError(errorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  if (challenge) {
    return (
      <Shell subtitle="Two-factor authentication">
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mfaCode">Authenticator code</Label>
            <Input id="mfaCode" name="mfaCode" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required />
          </div>
          {error && <p className="text-sm font-medium text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? '…' : 'Verify'}</Button>
        </form>
        <button className="mt-4 w-full text-center text-sm text-muted-foreground hover:text-foreground" onClick={() => { setChallenge(null); setError(null) }}>
          Back to sign in
        </button>
      </Shell>
    )
  }

  const subtitle = mode === 'register' ? 'Create an account' : mode === 'forgot' ? 'Reset your password' : 'Sign in'
  return (
    <Shell subtitle={subtitle}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" placeholder="you@example.com" required />
        </div>
        {mode !== 'forgot' && (
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" placeholder="••••••••" required />
          </div>
        )}
        {error && <p className="text-sm font-medium text-destructive">{error}</p>}
        {notice && <p className="text-sm font-medium text-foreground">{notice}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? '…' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Sign in'}
        </Button>
      </form>
      <div className="mt-4 space-y-1 text-center text-sm text-muted-foreground">
        {mode === 'login' && (
          <button className="block w-full hover:text-foreground" onClick={() => { setMode('forgot'); setError(null); setNotice(null) }}>
            Forgot your password?
          </button>
        )}
        <button className="block w-full hover:text-foreground" onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError(null); setNotice(null) }}>
          {mode === 'register' ? 'Already have an account? Sign in' : mode === 'forgot' ? 'Back to sign in' : 'New here? Create an account'}
        </button>
      </div>
    </Shell>
  )
}

function ResetPassword({ token }: { token: string }) {
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const backToLogin = () => {
    window.history.replaceState({}, '', window.location.pathname)
    window.location.reload()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const password = String(new FormData(event.currentTarget).get('password'))
    try {
      await makeApi().resetPassword({ body: { token, password } })
      setDone(true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Shell subtitle="Password updated">
        <Button className="w-full" onClick={backToLogin}>Sign in</Button>
      </Shell>
    )
  }
  return (
    <Shell subtitle="Choose a new password">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
          <Input id="password" name="password" type="password" placeholder="••••••••" required minLength={8} />
        </div>
        {error && <p className="text-sm font-medium text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? '…' : 'Reset password'}</Button>
      </form>
    </Shell>
  )
}

function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const api = makeApi(() => token)
  const [email, setEmail] = useState<string | null>(null)
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [mfa, setMfa] = useState<{ enabled: boolean; pending: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      const [me, health, status] = await Promise.all([api.me(), api.health(), api.mfaStatus()])
      setEmail(me.email)
      setHealthy(health.ok)
      setMfa(status)
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <Card className="w-full max-w-lg">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>${options.name}</CardTitle>
          {healthy !== null && (
            <Badge variant={healthy ? 'secondary' : 'destructive'}>{healthy ? 'healthy' : 'down'}</Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm font-medium text-destructive">{error}</p>}
          <p className="text-sm text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{email ?? '…'}</span>
          </p>
          <MfaCard status={mfa} api={api} onChange={() => void load()} />
          <Button variant="outline" size="sm" onClick={onLogout}>Sign out</Button>
        </CardContent>
      </Card>
    </div>
  )
}

type ApiClient = ReturnType<typeof makeApi>

function MfaCard({ status, api, onChange }: { status: { enabled: boolean; pending: boolean } | null; api: ApiClient; onChange: () => void }) {
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string } | null>(null)
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const start = () => run(async () => setEnroll(await api.mfaEnroll()))
  const activate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get('code'))
    return run(async () => {
      const res = await api.mfaActivate({ body: { code } })
      setRecovery(res.recoveryCodes)
      setEnroll(null)
      onChange()
    })
  }
  const disable = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get('code'))
    return run(async () => {
      await api.mfaDisable({ body: { code } })
      onChange()
    })
  }

  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">Two-factor authentication</span>
        <Badge variant={status?.enabled ? 'secondary' : 'outline'}>{status?.enabled ? 'on' : 'off'}</Badge>
      </div>
      {error && <p className="mb-2 text-sm font-medium text-destructive">{error}</p>}

      {recovery && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Save these recovery codes — each works once:</p>
          <ul className="grid grid-cols-2 gap-1">
            {recovery.map((c) => (
              <li key={c} className="rounded bg-muted px-2 py-1 font-mono text-xs">{c}</li>
            ))}
          </ul>
          <Button size="sm" variant="outline" onClick={() => setRecovery(null)}>Done</Button>
        </div>
      )}

      {!recovery && enroll && (
        <form onSubmit={activate} className="space-y-2">
          <p className="text-sm text-muted-foreground">Add this secret to your authenticator app, then enter a code:</p>
          <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-xs">{enroll.secret}</code>
          <a className="block truncate text-xs text-primary underline" href={enroll.otpauthUri}>{enroll.otpauthUri}</a>
          <Input name="code" inputMode="numeric" placeholder="123456" required />
          <Button size="sm" type="submit" disabled={busy}>Activate</Button>
        </form>
      )}

      {!recovery && !enroll && status?.enabled && (
        <form onSubmit={disable} className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="mfa-off" className="text-xs">Enter a code to turn off</Label>
            <Input id="mfa-off" name="code" inputMode="numeric" placeholder="123456" required />
          </div>
          <Button size="sm" variant="destructive" type="submit" disabled={busy}>Disable</Button>
        </form>
      )}

      {!recovery && !enroll && !status?.enabled && (
        <Button size="sm" onClick={start} disabled={busy}>{busy ? '…' : 'Enable 2FA'}</Button>
      )}
    </div>
  )
}
`
}
