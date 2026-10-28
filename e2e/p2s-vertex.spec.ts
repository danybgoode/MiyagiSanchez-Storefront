import { expect, test } from '@playwright/test'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { parseServiceAccount, signedAssertion, TOKEN_TIMEOUT_MS, vertexGenerateUrl, vertexTokenSource } from '../lib/prompt-to-shop/vertex'
import { buildBlockRequest } from '../lib/prompt-to-shop/planner'

// Prompt-to-shop — Gemini through Vertex with a service account. A throwaway key is minted per run, so the
// signature is really checked and no credential lives in the repo.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const SA = { type: 'service_account', project_id: 'proj-1', client_email: 'svc@proj-1.iam.gserviceaccount.com', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' }

test('a service account parses from raw or base64 JSON, and nothing partial passes', () => {
  const raw = JSON.stringify(SA)
  expect(parseServiceAccount(raw)?.project_id).toBe('proj-1')
  expect(parseServiceAccount(Buffer.from(raw).toString('base64'))?.client_email).toBe(SA.client_email)
  expect(parseServiceAccount(undefined)).toBeNull()
  expect(parseServiceAccount('')).toBeNull()
  expect(parseServiceAccount('not json')).toBeNull()
  expect(parseServiceAccount(JSON.stringify({ ...SA, type: 'authorized_user' }))).toBeNull()
  expect(parseServiceAccount(JSON.stringify({ ...SA, private_key: 'x' }))).toBeNull()
  expect(parseServiceAccount(JSON.stringify({ ...SA, project_id: '' }))).toBeNull()
  expect(parseServiceAccount(JSON.stringify({ ...SA, token_uri: undefined }))?.token_uri).toBe('https://oauth2.googleapis.com/token')
})

test('the Vertex URL targets the project and model', () => {
  expect(vertexGenerateUrl('proj-1', 'gemini-3.5-flash')).toBe('https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-3.5-flash:generateContent')
  expect(vertexGenerateUrl('proj-1', 'm', 'us-central1')).toMatch(/^https:\/\/us-central1-aiplatform\.googleapis\.com\/.*\/locations\/us-central1\//)
})

test('the assertion is a JWT signed by the service account key, for the cloud-platform scope', () => {
  const sa = parseServiceAccount(JSON.stringify(SA))!
  const jwt = signedAssertion(sa, 1_000)
  const [h, p, s] = jwt.split('.')
  expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true)
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
  expect(claims).toMatchObject({ iss: SA.client_email, aud: SA.token_uri, iat: 1_000, exp: 4_600, scope: 'https://www.googleapis.com/auth/cloud-platform' })
})

test('one token serves concurrent blocks, is reused, and is refreshed before it expires', async () => {
  const sa = parseServiceAccount(JSON.stringify(SA))!
  let now = 10_000
  let exchanges = 0
  const fetch = (async () => {
    exchanges++
    return new Response(JSON.stringify({ access_token: `tok-${exchanges}`, expires_in: 3600 }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const src = vertexTokenSource(sa, { fetch, nowS: () => now })
  expect(await Promise.all([src.get(), src.get(), src.get()])).toEqual(['tok-1', 'tok-1', 'tok-1'])
  expect(exchanges).toBe(1)
  now += 3000
  expect(await src.get()).toBe('tok-1')
  now += 400 // inside the 5-minute refresh margin
  expect(await src.get()).toBe('tok-2')
  expect(exchanges).toBe(2)
})

test('a hung token exchange gives up within its deadline, and the next call can try again', async () => {
  const sa = parseServiceAccount(JSON.stringify(SA))!
  let calls = 0
  // Honours the abort signal the way real fetch does; otherwise never answers.
  const hanging = ((_url: string, init?: RequestInit) => {
    calls++
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
  }) as unknown as typeof fetch
  const src = vertexTokenSource(sa, { fetch: hanging, nowS: () => 1 })
  const started = Date.now()
  expect(await Promise.all([src.get(), src.get()])).toEqual([null, null])
  expect(Date.now() - started).toBeLessThan(TOKEN_TIMEOUT_MS + 1_500)
  expect(calls).toBe(1)
  await new Promise((r) => setTimeout(r, 0))
  await src.get()
  expect(calls).toBe(2)
})

test('a malformed key never reaches Google and never sticks', async () => {
  const sa = { ...parseServiceAccount(JSON.stringify(SA))!, private_key: '-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----' }
  let calls = 0
  const src = vertexTokenSource(sa, { fetch: (async () => { calls++; return new Response('{}') }) as unknown as typeof fetch, nowS: () => 1 })
  expect(await src.get()).toBeNull()
  await new Promise((r) => setTimeout(r, 0))
  expect(await src.get()).toBeNull()
  expect(calls).toBe(0)
})

test('a refused or broken token exchange is null, never a token', async () => {
  const sa = parseServiceAccount(JSON.stringify(SA))!
  const answer = (status: number, body: unknown) => vertexTokenSource(sa, { fetch: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch, nowS: () => 1 })
  expect(await answer(401, { error: 'invalid_grant' }).get()).toBeNull()
  expect(await answer(200, { access_token: '' }).get()).toBeNull()
  expect(await vertexTokenSource(sa, { fetch: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch, nowS: () => 1 }).get()).toBeNull()
})

test('blocks ask for minimal thinking with headroom: thinking counts against the output cap', () => {
  // Measured live 2026-10-28: default thinking spent 980 of identity's 1024 tokens → MAX_TOKENS mid-JSON → every
  // identity fell back.
  for (const key of ['identity', 'words', 'catalog'] as const) {
    const cfg = buildBlockRequest(key, 'Vendo tamales').body.generationConfig
    expect(cfg.thinkingConfig, key).toEqual({ thinkingLevel: 'minimal' })
    expect(cfg.maxOutputTokens as number, key).toBeGreaterThanOrEqual(2048)
  }
})
