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
}
