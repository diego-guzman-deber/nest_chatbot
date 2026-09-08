import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappSenderService } from '../whatsapp/whatsapp-sender.service';

/**
 * Texto y enlace por defecto para el mensaje del stand de El Deber. Se pueden
 * sobrescribir por variable de entorno (MENSAJE_STAND_TEXTO / MENSAJE_STAND_ENLACE)
 * o por cada request (campos `mensaje` / `enlace`).
 */
const MENSAJE_STAND_TEXTO_DEFECTO =
  '🎬 ¡Este es tu video! Gracias por pasarte por el stand de El Deber.';

interface EnviarMensajeBody {
  /** Teléfono destino. Acepta 8 dígitos (celular boliviano) o formato 591XXXXXXXX. */
  telefono?: string;
  /** Alias de `telefono`. */
  to?: string;
  /** Texto del mensaje. Si se omite, usa MENSAJE_STAND_TEXTO o el valor por defecto. */
  mensaje?: string;
  /** Enlace (p. ej. de Facebook) que se agrega al final del mensaje. */
  enlace?: string;
}

/**
 * Endpoint administrativo para enviar un mensaje suelto de WhatsApp a un
 * usuario (caso de uso: entregarle el enlace de Facebook con su video luego de
 * que pasó por el stand de El Deber).
 *
 * Requiere el query `token` igual a ADMIN_SEED_TOKEN (.env del servidor). Sin
 * esa variable configurada, el endpoint rechaza todo.
 *
 * OJO: usa un mensaje de texto libre, que Meta solo permite dentro de la
 * ventana de 24h desde el último mensaje del usuario. Fuera de esa ventana el
 * envío falla (error 131047) y hace falta una plantilla aprobada.
 */
@Controller('mensajes')
export class MensajesController {
  private readonly logger = new Logger(MensajesController.name);

  constructor(
    private readonly sender: WhatsappSenderService,
    private readonly config: ConfigService,
  ) {}

  // GET para poder dispararlo desde el navegador pegando el link.
  // Ej: /mensajes/enviar?token=XXX&telefono=71234567&enlace=https://facebook.com/...
  @Get('enviar')
  async enviarPorNavegador(
    @Query('token') token: string,
    @Query() query: Record<string, string>,
  ) {
    return this.enviar(token, {
      telefono: query.telefono,
      to: query.to,
      mensaje: query.mensaje,
      enlace: query.enlace,
    });
  }

  @Post('enviar')
  async enviar(@Query('token') token: string, @Body() body: EnviarMensajeBody) {
    const tokenEsperado = this.config.get<string>('ADMIN_SEED_TOKEN');
    if (!tokenEsperado || token !== tokenEsperado) {
      throw new ForbiddenException(
        'Token inválido o ADMIN_SEED_TOKEN no configurado en el servidor.',
      );
    }

    const telefonoCrudo = body?.telefono ?? body?.to;
    const waId = this.normalizarTelefonoBolivia(telefonoCrudo);
    if (!waId) {
      throw new BadRequestException(
        'Teléfono inválido. Envía 8 dígitos (celular boliviano) o el formato 591XXXXXXXX en el campo "telefono".',
      );
    }

    const texto =
      body?.mensaje?.trim() ||
      this.config.get<string>('MENSAJE_STAND_TEXTO') ||
      MENSAJE_STAND_TEXTO_DEFECTO;

    const enlace =
      body?.enlace?.trim() || this.config.get<string>('MENSAJE_STAND_ENLACE') || '';

    const cuerpo = enlace ? `${texto}\n\n${enlace}` : texto;

    this.logger.log(`Enviando mensaje de stand a ${waId} (enlace: ${enlace || 'ninguno'})`);

    // preview_url = true para que el enlace de Facebook muestre miniatura.
    const enviado = await this.sender.enviarMensaje(waId, cuerpo, Boolean(enlace));
    if (!enviado) {
      throw new BadRequestException(
        'No se pudo enviar el mensaje. Revisá los logs del servidor (posible ventana de 24h vencida o número no válido en WhatsApp).',
      );
    }

    return { status: 'ok', to: waId, mensaje: cuerpo };
  }

  /**
   * Normaliza un teléfono boliviano al waId que espera WhatsApp (591 + 8
   * dígitos). Devuelve null si no tiene pinta de celular boliviano válido.
   */
  private normalizarTelefonoBolivia(telefonoCrudo?: string | null): string | null {
    if (!telefonoCrudo) return null;
    const soloDigitos = telefonoCrudo.replace(/\D/g, '');

    if (soloDigitos.length === 8 && /^[67]/.test(soloDigitos)) {
      return `591${soloDigitos}`;
    }
    if (soloDigitos.length === 11 && soloDigitos.startsWith('591') && /^591[67]/.test(soloDigitos)) {
      return soloDigitos;
    }
    return null;
  }
}
