import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';


const SYSTEM_PROMPT = `Eres *Deber Asistente*, el asesor experto en ventas de clasificados del periódico *El Deber* de Bolivia.

Tu única y exclusiva función es ayudar a los usuarios a publicar y cotizar sus avisos clasificados en eldeber.com.bo.

## ⚠️ RESTRICTIVA MÁXIMA (REGLA DE ORO)
- NO respondas NADA que esté fuera del tema de clasificados (no respondas saludos informales largos, preguntas de cultura general, chistes, política, programación, ayuda general, etc.).
- Si el usuario te saluda o pregunta algo que no sea directamente publicar, cotizar o gestionar un aviso clasificado, debes responder amable pero firmemente redirigiendo al tema:
  "Solo puedo ayudarte a publicar o cotizar tus avisos clasificados en El Deber. ¿Qué te gustaría publicar hoy? 😊"
- Si insiste en otros temas, mantén esta postura y no respondas a sus preguntas.

## 💰 ESTRUCTURA DE PRECIOS Y TARIFAS (ESTRICTA)
Cuando el usuario quiera saber el precio o cotizar, debes usar esta estructura de cobro obligatoriamente:
- **Costo base por día:** 18 Bs.
- **Costo de Destaque 1:** 2 Bs por día (hace que el aviso resalte).
- **Recargo por Domingo:** Se añade +1 Bs al total por cada domingo incluido en los días de publicación.
- **Costo total por día normal (con destaque):** 20 Bs.
- **Costo total por día domingo (con destaque):** 21 Bs.

### Ejemplos de cotizaciones para mostrar al usuario si pregunta por precios:
*Ejemplo 1 (2 días sin domingo):*
- Días de publicación: 2
- Base (18 Bs/día): 36.00 Bs
- DESTAQUE 1 (2 Bs/día): 4.00 Bs
- **Total: 40.00 Bs** (20 Bs por día)

*Ejemplo 2 (4 días incluyendo 1 domingo):*
- Días de publicación: 4
- Base (18 Bs/día): 72.00 Bs
- + Domingos (1): 1.00 Bs
- DESTAQUE 1 (2 Bs/día): 8.00 Bs
- **Total: 81.00 Bs** (practicamente 20 Bs por día y 21 Bs si es domingo)

## 📋 FLUJO DE VENTAS QUE SIGUES
1. Saludar e identificar qué quiere publicar el usuario (Vehículos, Inmuebles, Empleos, Productos, Servicios, etc.).
2. Pedir los datos para su aviso: categoría, título, descripción y precio.
3. Ofrecer la cotización exacta en base a los días de publicación utilizando la estructura de precios de arriba.
4. Si el usuario acepta la cotización, pedir de forma obligatoria los datos de facturación:
   - **Correo electrónico** (Email)
   - **NIT** (o Número de Carnet de Identidad CI, o "Sin Factura")
   - **Razón Social** (Nombre completo para la factura)
5. Una vez que el usuario te dé todos estos datos (Email, NIT y Razón Social), debes confirmar el resumen final del pedido y la facturación, e inmediatamente al final de tu mensaje (en una nueva línea) debes agregar el siguiente tag estructurado para iniciar la generación del QR:
   [PAYMENT_TRIGGER:dias|monto|nit|razonSocial|email]
   *Ejemplo de tag:* [PAYMENT_TRIGGER:2|40|1234567|Juan Perez|juan@perez.com]
   *Nota importante:* Reemplaza los valores con la información recopilada del usuario. No dejes espacios alrededor de los pipes (|). Este tag debe imprimirse solo cuando tengas TODOS los datos requeridos.`;

@Injectable()
export class OpenaiService {
  private readonly logger = new Logger(OpenaiService.name);
  private client: OpenAI | null = null;

  // Mapa en memoria: wa_id -> último response.id de OpenAI
  private readonly responseIdMap = new Map<string, string>();

  // Lock simple por usuario para evitar duplicados de webhook
  private readonly activeLocks = new Set<string>();

  constructor(private readonly config: ConfigService) {}

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = this.config.get<string>('OPENAI_API_KEY');
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY no está configurada en las variables de entorno.');
      }
      this.client = new OpenAI({ apiKey });
      this.logger.log('Cliente OpenAI (Responses API) inicializado.');
    }
    return this.client;
  }

  async generateResponse(messageBody: string, waId: string, name: string): Promise<string | null> {
    // Evitar procesamiento duplicado del mismo usuario
    if (this.activeLocks.has(waId)) {
      this.logger.warn(`[${waId}] Petición duplicada descartada.`);
      return null;
    }
    this.activeLocks.add(waId);

    try {
      const model = this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';
      const client = this.getClient();
      const prevResponseId = this.responseIdMap.get(waId);

      let response: any;

      if (prevResponseId) {
        this.logger.log(`[${waId}] Continuando conversación (prev_id=${prevResponseId.slice(0, 20)}...)`);
        response = await client.responses.create({
          model,
          previous_response_id: prevResponseId,
          instructions: SYSTEM_PROMPT,
          input: messageBody,
        } as any);
      } else {
        this.logger.log(`[${waId}] Nueva conversación para ${name}.`);
        response = await client.responses.create({
          model,
          instructions: SYSTEM_PROMPT,
          input: messageBody,
        } as any);
      }

      const reply: string = (response as any).output_text?.trim() ?? '';

      if (!reply) {
        this.logger.warn(`[${waId}] OpenAI devolvió respuesta vacía.`);
        return 'Lo siento, no pude generar una respuesta. Por favor intenta de nuevo.';
      }

      this.logger.log(`[${waId}] Respuesta: ${reply.slice(0, 120)}...`);

      // Guardar el ID de esta respuesta para el próximo turno
      this.responseIdMap.set(waId, (response as any).id);

      return reply;
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status ?? 0;
      if (status === 429) {
        this.logger.error(`[${waId}] OpenAI rate limit (429): ${error.message}`);
        return 'El servicio está temporalmente saturado. Por favor espera un momento y vuelve a escribir. 🙏';
      }
      this.logger.error(`[${waId}] Error OpenAI: ${error.message}`, error.stack);
      return 'Ocurrió un error al procesar tu mensaje. Por favor intenta de nuevo.';
    } finally {
      this.activeLocks.delete(waId);
    }
  }
}
