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
  /** Texto del mensaje (solo modo texto libre / dentro de la ventana de 24h). */
  mensaje?: string;
  /** Enlace (p. ej. de Facebook). En texto libre se agrega al final; en plantilla se usa como parámetro {{1}} si no se pasan `parametros`. */
  enlace?: string;

  /**
   * Nombre de una plantilla APROBADA en Meta. Si se envía, se usa modo
   * plantilla (única forma de escribirle a un número que NO te escribió en las
   * últimas 24h). Si se omite, se usa MENSAJE_STAND_PLANTILLA del .env; y si
   * tampoco existe, se manda texto libre.
   */
  plantilla?: string;
  /** Código de idioma de la plantilla (ej. "es"). Default: MENSAJE_STAND_PLANTILLA_LANG o "es". */
  idioma?: string;
  /** Valores para las variables {{1}}, {{2}}, ... del body de la plantilla, en orden. */
  parametros?: string[];
}

/**
 * Endpoint administrativo para enviar un mensaje suelto de WhatsApp a un
 * usuario (caso de uso: entregarle el enlace de Facebook con su video luego de
 * que pasó por el stand de El Deber).
 *
 * Requiere el query `token` igual a ADMIN_SEED_TOKEN (.env del servidor). Sin
 * esa variable configurada, el endpoint rechaza todo.
 *
 * Dos modos:
 *  - TEXTO LIBRE (sin `plantilla`): Meta solo lo permite dentro de la ventana
 *    de 24h desde el último mensaje del usuario. Fuera de esa ventana falla
 *    (error 131047).
 *  - PLANTILLA (`plantilla` o MENSAJE_STAND_PLANTILLA en .env): funciona
 *    siempre, incluso si el número nunca escribió al bot. La plantilla debe
 *    estar creada y APROBADA en WhatsApp Manager.
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
  //     /mensajes/enviar?token=XXX&telefono=63525425&plantilla=video_stand&parametros=https://facebook.com/...
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
      plantilla: query.plantilla,
      idioma: query.idioma,
      // En GET, `parametros` puede venir repetido (?parametros=a&parametros=b)
      // o como uno solo. Normalizamos a array.
      parametros:
        query.parametros === undefined
          ? undefined
          : Array.isArray(query.parametros)
            ? query.parametros
            : [query.parametros],
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

    const enlace =
      body?.enlace?.trim() || this.config.get<string>('MENSAJE_STAND_ENLACE') || '';

    const plantilla =
      body?.plantilla?.trim() || this.config.get<string>('MENSAJE_STAND_PLANTILLA') || '';

    // ── Modo PLANTILLA ────────────────────────────────────────────────────────
    // Único modo que funciona para números que NO le escribieron al bot.
    if (plantilla) {
      const idioma =
        body?.idioma?.trim() ||
        this.config.get<string>('MENSAJE_STAND_PLANTILLA_LANG') ||
        'es';

      // Si no mandan `parametros` explícitos, usamos el enlace como {{1}}.
      const parametros =
        body?.parametros && body.parametros.length > 0
          ? body.parametros
          : enlace
            ? [enlace]
            : [];

      this.logger.log(
        `Enviando plantilla "${plantilla}" (${idioma}) a ${waId}. Params: ${JSON.stringify(parametros)}`,
      );

      const enviado = await this.sender.enviarPlantilla(waId, plantilla, idioma, parametros);
      if (!enviado) {
        throw new BadRequestException(
          `No se pudo enviar la plantilla "${plantilla}". Revisá los logs: verificá que exista y esté APROBADA en WhatsApp Manager, con el idioma "${idioma}" y la cantidad de variables correcta.`,
        );
      }

      return { status: 'ok', modo: 'plantilla', to: waId, plantilla, idioma, parametros };
    }

    // ── Modo TEXTO LIBRE (solo dentro de la ventana de 24h) ────────────────────
    const texto =
      body?.mensaje?.trim() ||
      this.config.get<string>('MENSAJE_STAND_TEXTO') ||
      MENSAJE_STAND_TEXTO_DEFECTO;

    const cuerpo = enlace ? `${texto}\n\n${enlace}` : texto;

    this.logger.log(`Enviando mensaje de texto libre a ${waId} (enlace: ${enlace || 'ninguno'})`);

    // preview_url = true para que el enlace de Facebook muestre miniatura.
    const enviado = await this.sender.enviarMensaje(waId, cuerpo, Boolean(enlace));
    if (!enviado) {
      throw new BadRequestException(
        'No se pudo enviar el mensaje de texto libre. Probablemente el número no le escribió al bot en las últimas 24h: usá el modo plantilla (campo "plantilla").',
      );
    }

    return { status: 'ok', modo: 'texto', to: waId, mensaje: cuerpo };
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
