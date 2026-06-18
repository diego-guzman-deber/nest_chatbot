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
    // Log completo del payload para debug
    this.logger.debug(`Payload recibido: ${JSON.stringify(body).slice(0, 500)}`);

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) {
      this.logger.warn('Payload sin value, ignorando.');
      return;
    }

    // Ignorar status updates (delivered, read, sent, failed, etc.)
    // ⚠️ FIX: antes era `value?.statuses` que es truthy si el campo existe
    if (value.statuses && value.statuses.length > 0 && !value.messages) {
      this.logger.debug(`Status update recibido: ${value.statuses[0]?.status ?? 'desconocido'}`);
      return;
    }

    // Verificar que hay mensajes
    if (!value.messages || value.messages.length === 0) {
      this.logger.warn(`Sin mensajes en el payload. Campos disponibles: ${Object.keys(value).join(', ')}`);
      return;
    }

    const message = value.messages[0];

    // Solo procesar mensajes de texto
    if (!message || message.type !== 'text') {
      this.logger.log(`Tipo de mensaje ignorado: ${message?.type ?? 'desconocido'}`);
      return;
    }

    const waId: string = value.contacts?.[0]?.wa_id ?? message.from;
    const name: string = value.contacts?.[0]?.profile?.name ?? 'Usuario';
    const messageBody: string = message.text?.body ?? '';

    if (!messageBody) {
      this.logger.warn(`[${waId}] Mensaje de texto vacío, ignorando.`);
      return;
    }

    this.logger.log(`[${waId}] Mensaje de ${name}: ${messageBody.slice(0, 80)}`);

    // Generar respuesta con OpenAI
    const reply = await this.openaiService.generateResponse(messageBody, waId, name);
    if (!reply) {
      this.logger.warn(`[${waId}] OpenAI no devolvió respuesta.`);
      return;
    }

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

    // Log de configuración para verificar que las env vars están cargadas
    this.logger.log(`Usando PHONE_NUMBER_ID: ${phoneNumberId ?? '⚠️ NO DEFINIDO'}`);
    this.logger.log(`ACCESS_TOKEN presente: ${accessToken ? '✅ Sí' : '⚠️ NO'}`);

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
    } catch (error: any) {
      const detail = error?.response?.data ?? error?.message;
      this.logger.error(`[${waId}] ❌ Error al enviar mensaje: ${JSON.stringify(detail)}`);
      this.logger.error(`URL usada: ${url}`);
    }
  }
}
