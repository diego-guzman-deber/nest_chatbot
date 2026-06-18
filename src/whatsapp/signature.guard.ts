import { Injectable, CanActivate, ExecutionContext, Logger, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class SignatureGuard implements CanActivate {
  private readonly logger = new Logger(SignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const signatureHeader: string = req.headers['x-hub-signature-256'] ?? '';

    this.logger.log(`📥 Petición POST recibida en /webhook. Firma header: ${signatureHeader || 'Ninguna'}`);

    // Remover prefijo 'sha256='
    const signature = signatureHeader.startsWith('sha256=')
      ? signatureHeader.slice(7)
      : signatureHeader;

    if (!signature) {
      this.logger.warn('Petición sin X-Hub-Signature-256');
      throw new ForbiddenException('Firma requerida');
    }

    const appSecret = this.config.get<string>('APP_SECRET') ?? '';
    const rawBody: Buffer = req['rawBody'];

    if (!rawBody) {
      this.logger.warn('rawBody no disponible para verificar firma');
      throw new ForbiddenException('No se pudo verificar la firma');
    }

    // Calcular HMAC-SHA256 igual que Python:
    // hmac.new(APP_SECRET.encode('latin-1'), payload.encode('utf-8'), hashlib.sha256)
    const expected = createHmac('sha256', Buffer.from(appSecret, 'latin1'))
      .update(rawBody)
      .digest('hex');

    try {
      const expectedBuf = Buffer.from(expected, 'hex');
      const signatureBuf = Buffer.from(signature, 'hex');

      if (
        expectedBuf.length !== signatureBuf.length ||
        !timingSafeEqual(expectedBuf, signatureBuf)
      ) {
        this.logger.warn('Verificación de firma fallida');
        throw new ForbiddenException('Firma inválida');
      }
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      this.logger.warn('Error al comparar firmas');
      throw new ForbiddenException('Firma inválida');
    }

    return true;
  }
}
