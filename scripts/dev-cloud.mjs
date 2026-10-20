// Runs the app and the /api functions together on http://localhost:3000 without `vercel dev`
// (which needs a Vercel login). Made for Claude Code cloud sessions; works anywhere the keys are in
// the environment. API code is loaded once: restart after editing api/.
//
//   npm run dev:cloud
//
// Node's built-in fetch ignores HTTPS_PROXY, so behind a proxy this re-runs itself on Node 22.21+
// with NODE_USE_ENV_PROXY=1 (Node 20 has no such switch).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const proxied = process.env.HTTPS_PROXY || process.env.https_proxy

if (proxied && process.env.NODE_USE_ENV_PROXY !== '1') {
  const node22 = '/opt/node22/bin/node'
  const child = spawn(existsSync(node22) ? node22 : process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
  })
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  const { createServer } = await import('vite')
  const port = Number(process.env.PORT) || 3000
  const handlers = new Map()

  const apiPlugin = {
    name: 'daybook-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost')
        const match = url.pathname.match(/^\/api\/([a-z-]+)\/?$/)
        if (!match) return next()
        const file = path.join(root, 'api', `${match[1]}.js`)
        if (!existsSync(file)) {
          res.statusCode = 404
          return res.end(JSON.stringify({ error: 'Not found' }))
        }
        try {
          if (!handlers.has(file)) handlers.set(file, (await import(pathToFileURL(file).href)).default)
          req.query = Object.fromEntries(url.searchParams)
          await handlers.get(file)(req, res)
        } catch (error) {
          console.error(`[api/${match[1]}]`, error)
          if (!res.headersSent) res.statusCode = 500
          res.end(JSON.stringify({ error: 'Server error (see the dev-cloud log).' }))
        }
      })
    },
  }

  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    server: { port, strictPort: true, host: '127.0.0.1' },
    plugins: [apiPlugin],
  })
  await server.listen()
  console.log(`Daybook (app + /api) on http://localhost:${port}`)
}
