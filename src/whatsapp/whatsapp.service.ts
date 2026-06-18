import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { OpenaiService } from './openai.service';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly openaiService: OpenaiService,
  ) {}

  // ── Verificación del webhook (GET) ──────────────────────────────────────────

  verifyWebhook(query: Record<string, string>): string | null {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    const verifyToken = this.config.get<string>('VERIFY_TOKEN');

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Webhook verificado correctamente.');
      return challenge;
    }

    this.logger.warn('Verificación de webhook fallida.');
    return null;
  }

  // ── Procesamiento de mensajes entrantes (POST) ───────────────────────────────

  async handleIncoming(body: any): Promise<void> {
    // Ignorar status updates (delivered, read, etc.)
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages || value?.statuses) {
      return;
    }

    const message = value.messages?.[0];
    if (!message || message.type !== 'text') {
      return;
    }

    const waId: string = value.contacts?.[0]?.wa_id ?? message.from;
    const name: string = value.contacts?.[0]?.profile?.name ?? 'Usuario';
    const messageBody: string = message.text?.body ?? '';

    if (!messageBody) return;

    this.logger.log(`[${waId}] Mensaje de ${name}: ${messageBody.slice(0, 80)}`);

    // Generar respuesta con OpenAI
    const reply = await this.openaiService.generateResponse(messageBody, waId, name);
    if (!reply) return;

    // Limpiar el texto para WhatsApp
    const cleaned = this.processTextForWhatsapp(reply);

    // Enviar la respuesta al usuario
    await this.sendMessage(waId, cleaned);
  }

  // ── Limpiar texto para WhatsApp ──────────────────────────────────────────────

  private processTextForWhatsapp(text: string): string {
    // Quitar referencias 【...】 de OpenAI
    text = text.replace(/【.*?】/g, '').trim();
    // Convertir **negrita** → *negrita* (formato WhatsApp)
    text = text.replace(/\*\*(.*?)\*\*/g, '*$1*');
    return text;
  }

  // ── Envío de mensaje a la API de Meta ───────────────────────────────────────

  private async sendMessage(waId: string, text: string): Promise<void> {
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
      this.logger.log(`[${waId}] Mensaje enviado. Status: ${res.status}`);
    } catch (error: any) {
      const detail = error?.response?.data ?? error?.message;
      this.logger.error(`[${waId}] Error al enviar mensaje: ${JSON.stringify(detail)}`);
    }
  }
}
