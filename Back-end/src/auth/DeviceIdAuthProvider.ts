import type { Request } from 'express';
import { z } from 'zod';
import type { UserRepository } from '../repositories/userRepository.js';
import type { AuthContext, AuthProvider } from './AuthProvider.js';

const uuidSchema = z.string().uuid();

/**
 * Extracts deviceId from `x-device-id` header or `Authorization: Device <uuid>`.
 */
export function extractDeviceId(req: Request): string | null {
  const headerValue = req.header('x-device-id');
  if (headerValue) {
    return headerValue.trim();
  }

  const authHeader = req.header('authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('device ')) {
    return authHeader.slice(7).trim();
  }

  return null;
}

export class DeviceIdAuthProvider implements AuthProvider {
  public readonly name = 'device';

  constructor(private readonly userRepo: UserRepository) {}

  async authenticate(req: Request): Promise<AuthContext | null> {
    const rawDeviceId = extractDeviceId(req);
    if (!rawDeviceId) {
      return null;
    }

    const parsed = uuidSchema.safeParse(rawDeviceId);
    if (!parsed.success) {
      return null;
    }

    const user = this.userRepo.findByExternalId('device', parsed.data);
    if (!user) {
      return null;
    }

    return {
      user,
      provider: this.name,
    };
  }
}
