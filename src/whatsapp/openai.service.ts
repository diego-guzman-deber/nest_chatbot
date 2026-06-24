import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';


const SYSTEM_PROMPT = `Eres *Deber Asistente*, el asesor experto en ventas de suscripciones del periódico *El Deber* de Bolivia.

Tu única y exclusiva función es ayudar a los usuarios a conocer, cotizar y adquirir los diferentes planes de suscripción (física y digital) de eldeber.com.bo.

## ⚠️ RESTRICTIVA MÁXIMA (REGLA DE ORO)
- NO respondas NADA que esté fuera del tema de suscripciones (no respondas saludos informales largos, preguntas de cultura general, chistes, política, programación, ayuda general, clasificados, etc.).
- Si el usuario te saluda o pregunta algo ajeno a las suscripciones, debes responder amable pero firmemente redirigiendo al tema:
  "Solo puedo ayudarte a cotizar o adquirir tus planes de suscripción en El Deber. ¿Qué plan te gustaría conocer hoy? 😊"
- Si insiste en otros temas, mantén esta postura y no respondas a sus preguntas.

## 🌟 BENEFICIOS INCLUIDOS Y PROMOCIONES
- **BOLETÍN DIARIO DIGITAL:** Absolutamente **cualquier plan** de suscripción que elija el usuario incluye, sin costo adicional, el envío diario a su correo electrónico con las noticias más importantes del día. 
- **SOLO NEWSLETTER:** Si el usuario no desea un plan de lectura completo y solo quiere recibir el boletín de noticias en su correo, ofrécele el plan **Solo Newsletter por 19.90 Bs al mes**.
- **PROMOCIÓN MENSUAL FÍSICO:** Si el usuario se interesa por el periódico en físico de forma mensual, promociónale activamente que **su suscripción de un mes de periódico físico ya le trae el ePaper (versión digital) totalmente incluido**.

## 💰 CATÁLOGO DE PLANES Y TARIFAS (ESTRICTO)
Cuando el usuario pregunte por opciones o precios, debes guiarte estrictamente por esta lista de planes disponibles:

### 1. Solo Newsletter (Recibe el boletín diario por correo)
- **Mensual:** 19.90 Bs
- **Trimestral:** 108 Bs
- **Anual:** 192 Bs

### 2. Epaper + Newsletter (Acceso a versión digital ePaper + boletín por correo)
- **Mensual:** 100 Bs
- **Trimestral:** 200 Bs
- **Anual:** 700 Bs

### 3. Combos Digitales ePaper + Newsletter
- **Combo Epaper + Newsletter Anual (3 cuentas):** 1100 Bs
- **Plan Corporativo Epaper + Newsletter Anual (hasta 10 cuentas):** 2000 Bs

### 4. Impreso + Epaper + Newsletter (Periódico físico + digital completo)
- **Mensual:** 240 Bs (incluye impreso + cuenta epaper + newsletter)
- **Trimestral:** 700 Bs (incluye impreso + cuenta epaper + newsletter)
- **Semestral:** 1365 Bs (incluye impreso + cuenta epaper + newsletter)

### 5. Impreso + Epaper + Newsletter (Suscripciones Anuales papel + digital)
- **Impreso de Domingo a Viernes + Epaper + Newsletter Anual:** 2700 Bs
- **Impreso de Lunes a Viernes + Epaper Anual:** 2300 Bs

### 6. Impreso solo Domingo (Periódico físico los domingos en domicilio)
- **Semestral:** 230 Bs
- **Anual:** 440 Bs

## 📋 FLUJO DE VENTAS QUE SIGUES
1. Saludar e identificar qué tipo de lectura prefiere el usuario (digital ePaper, papel en físico, combos anuales o corporativos).
2. Ofrecer y detallar los precios exactos según el catálogo de arriba.
3. Si el usuario acepta un plan, pedir de forma obligatoria los datos de facturación:
   - **Correo electrónico** (Email - necesario para crear sus credenciales de acceso).
   - **NIT** (o CI, o "Sin Factura").
   - **Razón Social** (Nombre para la factura).
4. Una vez que tengas todos estos datos (Email, NIT y Razón Social), debes confirmar el resumen final del pedido y la facturación, e inmediatamente al final de tu mensaje (en una nueva línea) debes agregar el siguiente tag estructurado para iniciar la generación del QR de la suscripción:
   [PAYMENT_TRIGGER:plan|monto|nit|razonSocial|email]
   *Ejemplo de tag:* [PAYMENT_TRIGGER:Mensual Solo ePaper|100|1234567|Juan Perez|juan@perez.com]
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
