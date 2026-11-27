import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { promisify } from 'util';
import { logger } from './logger';
import * as repo from './repository';
import type { Role } from './repository';
import { HttpError } from './service';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export interface AuthUser {
  username: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

/** Lido a cada requisição para os testes poderem ligar e desligar. */
export const authEnabled = () => process.env.AUTH_ENABLED === 'true';

const TOKEN_TTL = process.env.JWT_EXPIRES_IN ?? '8h';

// Sem JWT_SECRET o segredo é gerado no boot: os tokens deixam de valer quando o processo reinicia.
let generatedSecret: string | undefined;
function secret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!generatedSecret) {
    generatedSecret = randomBytes(32).toString('hex');
    if (authEnabled()) logger.warn('JWT_SECRET ausente: usando segredo aleatório (tokens expiram ao reiniciar)');
  }
  return generatedSecret;
}

// ---- Senhas: scrypt com salt, formato "scrypt$<salt hex>$<hash hex>" ----

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

// ---- Tokens ----

export function signToken(user: AuthUser): string {
  return jwt.sign({ role: user.role }, secret(), {
    subject: user.username,
    expiresIn: TOKEN_TTL as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

function verifyToken(token: string): AuthUser {
  const payload = jwt.verify(token, secret(), { algorithms: ['HS256'] }) as jwt.JwtPayload;
  if (!payload.sub || (payload.role !== 'DBA' && payload.role !== 'DEV_QA')) throw new Error('token sem perfil');
  return { username: payload.sub, role: payload.role };
}

/** Login: usuário e senha corretos → token. A mesma mensagem para usuário inexistente e senha errada. */
export async function login(username: string, password: string) {
  const user = await repo.findUserByUsername(username);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new HttpError(401, 'Usuário ou senha inválidos');
  }
  const authUser: AuthUser = { username: user.username, role: user.role };
  logger.info({ username: user.username, role: user.role }, 'user logged in');
  return { token: signToken(authUser), tokenType: 'Bearer', expiresIn: TOKEN_TTL, user: authUser };
}

// ---- Middlewares ----

/** Com a auth desligada (padrão, compatível com o front atual) todo pedido vale como DBA anônimo. */
const ANONYMOUS: AuthUser = { username: 'anonymous', role: 'DBA' };

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  if (!authEnabled()) {
    req.user = ANONYMOUS;
    return next();
  }
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Autenticação necessária');
  try {
    req.user = verifyToken(token);
  } catch {
    throw new HttpError(401, 'Token inválido ou expirado');
  }
  next();
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new HttpError(403, `Ação restrita ao perfil ${roles.join(' ou ')}`);
    }
    next();
  };

// ---- Usuários iniciais ----

/** AUTH_SEED_USERS="usuario:senha:PERFIL,..." — padrão de demonstração: dba (DBA) e qa (DEV_QA). */
export function parseSeedUsers(spec = process.env.AUTH_SEED_USERS ?? 'dba:dba123:DBA,qa:qa123:DEV_QA') {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [username, password, role] = entry.split(':');
      if (!username || !password || (role !== 'DBA' && role !== 'DEV_QA')) {
        throw new Error(`AUTH_SEED_USERS inválido: "${entry}" (use usuario:senha:DBA|DEV_QA)`);
      }
      return { username, password, role: role as Role };
    });
}

/** Cria os usuários iniciais só quando a tabela está vazia. */
export async function seedUsers(): Promise<void> {
  if ((await repo.countUsers()) > 0) return;
  for (const u of parseSeedUsers()) {
    await repo.insertUser({ username: u.username, passwordHash: await hashPassword(u.password), role: u.role });
    logger.info({ username: u.username, role: u.role }, 'seed user created');
  }
}
