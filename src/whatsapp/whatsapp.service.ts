import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { OpenaiService } from './openai.service';
import { PaymentService } from './payment.service';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly openaiService: OpenaiService,
    private readonly paymentService: PaymentService,
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

    // Detectar si la respuesta contiene el PAYMENT_TRIGGER
    const triggerRegex = /\[PAYMENT_TRIGGER:(.*?)\]/;
    const match = reply.match(triggerRegex);
    let cleanedReply = reply;

    if (match) {
      // Quitar el tag estructurado de la respuesta que se envía al usuario
      cleanedReply = reply.replace(triggerRegex, '').trim();
    }

    // Limpiar el texto para WhatsApp
    const cleaned = this.processTextForWhatsapp(cleanedReply);

    // Enviar la respuesta de texto al usuario
    await this.sendMessage(waId, cleaned);

    // Si se detectó el trigger de pago, iniciar el proceso de cobro
    if (match) {
      const triggerData = match[1]; // plan|monto|nit|razonSocial|email
      const [plan, montoStr, nit, razonSocial, email] = triggerData.split('|');

      // Resolver el itemId y monto exacto desde el nombre del plan (consulta MongoDB, es async)
      const planResuelto = await this.paymentService.resolverPlan(plan);
      const monto = planResuelto?.monto ?? (parseFloat(montoStr) || 0);
      const itemId = planResuelto?.itemId ?? 'DESCONOCIDO';

      // Generar el orderId de suscripción: sus-{waId}-{YYYYMM}
      const orderId = this.paymentService.generarOrderId(waId);

      this.logger.log(
        `[${waId}] 💳 Trigger de Pago QR detectado. Order: ${orderId}, Plan: ${plan} (${itemId}), Monto: ${monto} Bs, NIT: ${nit}, Razón Social: ${razonSocial}, Email: ${email}`,
      );

      this.procesarYEnviarPagoQR(waId, monto, orderId, razonSocial, nit, itemId).catch((err) => {
        this.logger.error(`[${waId}] Error en el procesamiento del pago QR: ${err.message}`, err.stack);
      });
    }
  }

  // ── Procesamiento secundario del QR en Background ───────────────────────────

  private async procesarYEnviarPagoQR(
    waId: string,
    monto: number,
    orderId: string,
    razonSocial: string,
    nit: string,
    itemId: string,
  ): Promise<void> {
    try {
      // 1. Obtener el QR en formato binario con los parámetros correctos de suscripciones
      const qrBuffer = await this.paymentService.obtenerQrBuffer(monto, orderId, razonSocial, nit, itemId);

      // 2. Subir el QR a Meta para obtener el media_id
      const mediaId = await this.uploadMedia(qrBuffer, 'qr_pago.png', 'image/png');

      // 3. Enviar el QR por WhatsApp
      const caption = 'Aquí tienes tu código QR para realizar el pago de tu suscripción. Una vez pagado, se activará automáticamente.';
      await this.sendMediaMessage(waId, mediaId, caption);

      // 4. Iniciar el monitoreo en segundo plano
      this.iniciarMonitoreoPago(orderId, waId);
    } catch (error: any) {
      this.logger.error(`[${waId}] Error generando o enviando el QR de pago: ${error.message}`);
      await this.sendMessage(
        waId,
        'Lo siento, ocurrió un inconveniente al generar tu código QR de pago. Por favor, vuelve a confirmar tus datos para reintentarlo.',
      );
    }
  }

  // ── Subir multimedia a la API de Meta ───────────────────────────────────────

  private async uploadMedia(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
    const version = this.config.get<string>('VERSION') ?? 'v25.0';
    const phoneNumberId = this.config.get<string>('PHONE_NUMBER_ID');
    const accessToken = this.config.get<string>('ACCESS_TOKEN');

    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/media`;

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    formData.append('file', blob, filename);
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', mimeType);

    const res = await axios.post(url, formData, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.data || !res.data.id) {
      throw new Error('La respuesta de subida de Meta no contiene un id de media.');
    }

    return res.data.id;
  }

  // ── Enviar Mensaje de Imagen (QR) a Meta ─────────────────────────────────────

  private async sendMediaMessage(waId: string, mediaId: string, caption: string): Promise<void> {
    const version = this.config.get<string>('VERSION') ?? 'v25.0';
    const phoneNumberId = this.config.get<string>('PHONE_NUMBER_ID');
    const accessToken = this.config.get<string>('ACCESS_TOKEN');

    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'image',
      image: {
        id: mediaId,
        caption: caption,
      },
    };

    await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    this.logger.log(`[${waId}] QR enviado con éxito a WhatsApp.`);
  }

  // ── Monitorear Estado de Pago (Polling) ─────────────────────────────────────

  private iniciarMonitoreoPago(adId: string, waId: string): void {
    let intentos = 0;
    const maxIntentos = 30; // 30 intentos cada 30 segundos = 15 minutos

    this.logger.log(`[${waId}] Iniciando monitoreo de pago para la suscripción ${adId}.`);

    const interval = setInterval(async () => {
      intentos++;

      try {
        const pagado = await this.paymentService.consultarEstadoPago(adId);

        if (pagado) {
          clearInterval(interval);
          this.logger.log(`[${waId}] ¡Pago confirmado para la suscripción ${adId}!`);
          await this.sendMessage(
            waId,
            '¡Excelente! Hemos verificado tu pago por QR de forma exitosa. Tu suscripción a El Deber ha sido activada correctamente. ¡Muchas gracias por confiar en nosotros! 🚀😊',
          );
          return;
        }
      } catch (error: any) {
        this.logger.error(`[${waId}] Error consultando el pago para suscripción ${adId}: ${error.message}`);
      }

      if (intentos >= maxIntentos) {
        clearInterval(interval);
        this.logger.warn(`[${waId}] Monitoreo de pago expirado para la suscripción ${adId}.`);
        await this.sendMessage(
          waId,
          'El tiempo límite (15 minutos) para realizar el pago de tu código QR ha expirado. Si aún deseas adquirir la suscripción, por favor solicítame una nueva cotización.',
        );
      }
    }, 30000); // Consultar cada 30 segundos
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
