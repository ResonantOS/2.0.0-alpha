// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

// Keep the DSH browser-session credential in the native host, never the
// extension or traces. The plugin authenticates this local client with its
// existing action-channel secret before supplying DSH's normal launch token.
export function createDshClient(base, actionToken) {
  const origin = new URL(base)
  if (!['http:', 'https:'].includes(origin.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('DSH_AUGMENTOR_URL must be a loopback HTTP(S) origin')
  }
  let cookie = ''
  let authenticating = null
  const headers = () => cookie ? { cookie } : {}
  const request = (route, options = {}) => fetch(`${origin.origin}${route}`, {
    ...options, redirect: 'manual',
    signal: options.signal ?? AbortSignal.timeout(10000),
  })

  async function authorize() {
    if (authenticating) return authenticating
    authenticating = (async () => {
      const probe = await request('/', { headers: headers() })
      await probe.body?.cancel()
      if (probe.status === 200) return
      if (probe.status !== 401) throw new Error(`DSH authentication probe failed (HTTP ${probe.status})`)
      cookie = ''
      const bootstrap = await request('/api/augmentor/auth', {
        method: 'POST', headers: { 'x-augmentor-token': actionToken },
      })
      if (!bootstrap.ok) {
        await bootstrap.body?.cancel()
        throw new Error(`DSH authentication failed (HTTP ${bootstrap.status}); update both the Augmentor plugin and extension, restart DSH, and check that they use the same DSH_HOME`)
      }
      const { token } = await bootstrap.json()
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) {
        throw new Error('DSH plugin did not supply a valid authentication token')
      }
      const exchange = await request(`/?token=${encodeURIComponent(token)}`)
      const sessionCookie = exchange.headers.getSetCookie()
        .find(value => /^dsh-auth-[A-Za-z0-9_-]+=/.test(value))?.split(';')[0]
      await exchange.body?.cancel()
      if (exchange.status !== 303 || !sessionCookie) throw new Error('DSH rejected the authentication token exchange')
      cookie = sessionCookie
    })().finally(() => { authenticating = null })
    return authenticating
  }

  return {
    async fetch(route, options = {}) {
      if (!route.startsWith('/api/') || route.includes('..') || route.includes('://')) throw new Error('Invalid DSH API route')
      const send = () => request(route, { ...options, headers: { ...options.headers, ...headers() } })
      const response = await send()
      if (response.status !== 401) return response
      // DSH rejects unauthenticated requests before dispatch. Only that
      // explicit rejection is retried; unknown outcomes are never replayed.
      await response.body?.cancel()
      await authorize()
      return send()
    },
    async websocketHeaders() { await authorize(); return headers() },
  }
}
