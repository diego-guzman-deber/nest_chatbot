import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * WhatsappSenderService
 *
 * Responsabilidad única: enviar mensajes de texto por WhatsApp vía la API de
 * Meta. Se extrajo de WhatsappService para que otros módulos (por ejemplo,
 * RecordatoriosModule) puedan enviar mensajes sin depender de todo el flujo
 * de webhooks/pagos de WhatsappService.
 */
@Injectable()
export class WhatsappSenderService {
  private readonly logger = new Logger(WhatsappSenderService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Envía un mensaje de texto a un número de WhatsApp.
   * Retorna true si el envío tuvo éxito, false si falló (ya loggeado).
   */
  async enviarMensaje(waId: string, text: string): Promise<boolean> {
    const version = this.config.get<string>('VERSION') ?? 'v25.0';
    const phoneNumberId = this.config.get<string>('PHONE_NUMBER_ID');
    const accessToken = this.config.get<string>('ACCESS_TOKEN');

    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'text',
      text: {
        preview_url: false,
        body: text,
      },
    };

    try {
      const res = await axios.post(url, data, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      this.logger.log(`[${waId}] ✅ Mensaje enviado. Status: ${res.status}`);
      return true;
    } catch (error: any) {
      const detail = error?.response?.data ?? error?.message;
      this.logger.error(`[${waId}] ❌ Error al enviar mensaje: ${JSON.stringify(detail)}`);
      this.logger.error(`URL usada: ${url}`);
      return false;
    }
  }

  /**
   * Marca un mensaje entrante como leído y muestra el indicador de
   * "escribiendo..." en el chat del usuario. Meta lo apaga automáticamente
   * a los 25 segundos, o antes si le respondemos con un mensaje normal — por
   * eso conviene llamarlo justo al recibir el webhook, antes de procesar
   * (p. ej. antes de llamar a OpenAI), y no hace falta "apagarlo" a mano.
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/typing-indicators
   */
  async mostrarEscribiendo(messageId: string): Promise<boolean> {
    const version = this.config.get<string>('VERSION') ?? 'v25.0';
    const phoneNumberId = this.config.get<string>('PHONE_NUMBER_ID');
    const accessToken = this.config.get<string>('ACCESS_TOKEN');

    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const data = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: {
        type: 'text',
      },
    };

    try {
      await axios.post(url, data, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      return true;
    } catch (error: any) {
      const detail = error?.response?.data ?? error?.message;
      // No es crítico: si falla, el usuario simplemente no ve el "escribiendo...".
      this.logger.warn(`No se pudo activar el indicador de escribiendo para ${messageId}: ${JSON.stringify(detail)}`);
      return false;
    }
  }

  /**
   * Envía un mensaje de PLANTILLA (template) previamente aprobado por Meta.
   *
   * Es obligatorio para mensajes proactivos (que el negocio inicia sin que el
   * usuario haya escrito en las últimas 24h, p. ej. recordatorios de
   * vencimiento) — un mensaje de texto libre (`enviarMensaje`) fallará con el
   * error 131047 fuera de esa ventana de 24 horas.
   *
   * La plantilla debe existir y estar APROBADA en WhatsApp Manager / Meta
   * Business Suite antes de poder usarse acá.
   *
   * @param templateName Nombre exacto de la plantilla aprobada.
   * @param languageCode Código de idioma configurado en la plantilla (ej. "es").
   * @param parametrosBody Valores en orden para las variables {{1}}, {{2}}, ... del body.
   */
  async enviarPlantilla(
    waId: string,
    templateName: string,
    languageCode: string,
    parametrosBody: string[] = [],
  ): Promise<boolean> {
    const version = this.config.get<string>('VERSION') ?? 'v25.0';
    const phoneNumberId = this.config.get<string>('PHONE_NUMBER_ID');
    const accessToken = this.config.get<string>('ACCESS_TOKEN');

    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(parametrosBody.length > 0 && {
          components: [
            {
              type: 'body',
              parameters: parametrosBody.map((texto) => ({ type: 'text', text: texto })),
            },
          ],
        }),
      },
    };

    try {
      const res = await axios.post(url, data, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      this.logger.log(`[${waId}] ✅ Plantilla "${templateName}" enviada. Status: ${res.status}`);
      return true;
    } catch (error: any) {
      const detail = error?.response?.data ?? error?.message;
      this.logger.error(`[${waId}] ❌ Error al enviar plantilla "${templateName}": ${JSON.stringify(detail)}`);
      return false;
    }
  }
}
