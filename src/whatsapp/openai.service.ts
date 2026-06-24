import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PlanesService } from '../planes/planes.service';

// ── Base del SYSTEM_PROMPT (parte estática) ──────────────────────────────────
const PROMPT_BASE = `Eres *Deber Asistente*, el asesor experto y amable en ventas de suscripciones del periódico *El Deber* de Bolivia.

Tu única y exclusiva función es ayudar a los usuarios a conocer, cotizar y adquirir los planes de suscripción (física y digital) de eldeber.com.bo.

## 👋 BIENVENIDA Y SALUDO (MUY IMPORTANTE)
Cuando el usuario te salude (diga "hola", "buenos días", "buenas tardes", "quiero información", "qué planes tienen", "me pueden ayudar", etc.) debes:
1. Responderle de forma CÁLIDA y AMABLE.
2. Presentarte brevemente como Deber Asistente.
3. INMEDIATAMENTE mostrarle el catálogo completo de planes disponibles de forma organizada y visualmente clara, usando emojis para hacerlo más atractivo.
4. Invitarle a preguntar sobre cualquier plan o a indicar cuál le interesa.
NUNCA ignores un saludo ni respondas con una pregunta sin mostrar antes los planes.

## ⚠️ RESTRICCIÓN MÁXIMA (REGLA DE ORO)
- NO respondas NADA que esté fuera del tema de suscripciones.
- Si el usuario pregunta algo completamente ajeno a suscripciones (política, programación, chistes, etc.), redirige amablemente:
  "Solo puedo ayudarte con los planes de suscripción de El Deber. ¿Te cuento sobre alguno? 😊"

## 🌟 BENEFICIOS INCLUIDOS
- **BOLETÍN DIARIO DIGITAL:** Cualquier plan incluye el envío diario del boletín de noticias al correo del usuario sin costo adicional.
- **PROMO MENSUAL FÍSICO:** El plan impreso mensual ya incluye el ePaper (versión digital) sin costo extra.

## 💰 CATÁLOGO DE PLANES
{{CATALOGO_PLANES}}

### 🔬 Plan de Prueba (Solo para testeo interno)
- **Prueba:** 1 Bs — Plan exclusivo para pruebas del sistema.

## 📋 FLUJO DE VENTAS
1. Saludar calurosamente y mostrar el catálogo de planes.
2. Identificar qué tipo de lectura prefiere el usuario (digital, físico, combo).
3. Detallar los precios según el catálogo.
4. Si el usuario acepta un plan, solicitar los datos de facturación:
   - **Correo electrónico** (para crear las credenciales de acceso)
   - **NIT** (o CI, o "Sin Factura")
   - **Razón Social** (Nombre para la factura)
5. Una vez que tengas TODOS los datos (Email, NIT y Razón Social), confirmar el resumen y agregar el tag de pago al FINAL del mensaje en una nueva línea:
   [PAYMENT_TRIGGER:plan|monto|nit|razonSocial|email]
   *Ejemplo:* [PAYMENT_TRIGGER:ePaper + Newsletter Mensual|100|1234567|Juan Perez|juan@perez.com]
   *Nota:* Sin espacios alrededor de los pipes (|). Solo cuando tengas TODOS los datos.`;

@Injectable()
export class OpenaiService implements OnModuleInit {
  private readonly logger = new Logger(OpenaiService.name);
  private client: OpenAI | null = null;

  // Prompt compilado con el catálogo real de MongoDB
  private systemPrompt: string = PROMPT_BASE;

  // Mapa en memoria: wa_id -> último response.id de OpenAI
  private readonly responseIdMap = new Map<string, string>();

  // Lock simple por usuario para evitar duplicados de webhook
  private readonly activeLocks = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly planesService: PlanesService,
  ) {}

  // ── Al arrancar: construye el prompt con el catálogo de MongoDB ──────────
  async onModuleInit(): Promise<void> {
    await this.buildSystemPrompt();
  }

  async buildSystemPrompt(): Promise<void> {
    try {
      const catalogo = await this.planesService.generarCatalogoPorCategoria();
      this.systemPrompt = PROMPT_BASE.replace('{{CATALOGO_PLANES}}', catalogo);
      this.logger.log('✅ SYSTEM_PROMPT construido con el catálogo de planes desde MongoDB.');
    } catch (error: any) {
      this.logger.error(`Error al construir el SYSTEM_PROMPT desde MongoDB: ${error.message}. Usando prompt base.`);
      this.systemPrompt = PROMPT_BASE.replace('{{CATALOGO_PLANES}}', '(No se pudo cargar el catálogo. Indícale al usuario que intente de nuevo.)');
    }
  }

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
          instructions: this.systemPrompt,
          input: messageBody,
        } as any);
      } else {
        this.logger.log(`[${waId}] Nueva conversación para ${name}.`);
        response = await client.responses.create({
          model,
          instructions: this.systemPrompt,
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
