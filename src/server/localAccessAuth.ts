import { timingSafeEqual } from 'node:crypto'

export const LOCAL_ACCESS_TOKEN_ENV = 'CC_HAHA_LOCAL_ACCESS_TOKEN'
export const PET_ACCESS_TOKEN_ENV = 'CC_HAHA_PET_ACCESS_TOKEN'

function configuredAccessToken(envName: string): string | null {
  const token = process.env[envName]?.trim()
  return token || null
}

function configuredLocalAccessToken(): string | null {
  return configuredAccessToken(LOCAL_ACCESS_TOKEN_ENV)
}

function configuredPetAccessToken(): string | null {
  return configuredAccessToken(PET_ACCESS_TOKEN_ENV)
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization')
  if (!authorization) return null
  const [scheme, token] = authorization.split(' ')
  return scheme === 'Bearer' && token ? token : null
}

export function hasConfiguredLocalAccessToken(): boolean {
  return configuredLocalAccessToken() !== null
}

export function hasConfiguredPetAccessToken(): boolean {
  return configuredPetAccessToken() !== null
}

export function isLocalAccessAuthorized(
  request: Request,
  tokenOverride?: string | null,
): boolean {
  const expected = configuredLocalAccessToken()
  if (!expected) return false

  const candidate = tokenOverride ?? bearerToken(request)
  return candidate ? tokensEqual(candidate, expected) : false
}

export function isPetAccessAuthorized(
  request: Request,
  tokenOverride?: string | null,
): boolean {
  const expected = configuredPetAccessToken()
  if (!expected) return false

  const candidate = tokenOverride ?? bearerToken(request)
  return candidate ? tokensEqual(candidate, expected) : false
}
