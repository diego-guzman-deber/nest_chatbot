import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PlanesService } from '../planes/planes.service';

// ── Base del SYSTEM_PROMPT (parte estática) ──────────────────────────────────
const PROMPT_BASE = `Eres *Deber Asistente*, el asesor experto y amable en ventas de suscripciones del periódico *El Deber* de Bolivia.

Tu única y exclusiva función es ayudar a los usuarios a conocer, cotizar y adquirir los planes de suscripción (física y digital) de eldeber.com.bo.

## 👋 BIENVENIDA Y SALUDO (MUY IMPORTANTE)
Cuando el usuario te salude (diga "hola", "buenos días", "buenas tardes", "quiero información", "me pueden ayudar", etc.) o comience la conversación, debes:
1. Responderle de forma CÁLIDA y AMABLE.
2. Presentarte brevemente como Deber Asistente.
3. INMEDIATAMENTE al final de tu mensaje de bienvenida, agregar el tag [MENU_TRIGGER] en una línea nueva. El sistema detectará esta etiqueta y le presentará al usuario un menú interactivo desplegable con 5 opciones.
NUNCA muestres el catálogo de planes en este primer saludo. Espera a que el usuario interactúe con el menú.

## 📑 OPCIONES DEL MENÚ INTERACTIVO
Cuando el usuario presione o escriba una de estas opciones, debes responder del siguiente modo:
1. **Ver planes**: Muestra el catálogo de planes disponibles (usando el catálogo detallado abajo) de forma organizada, atractiva y visualmente clara, usando emojis.
2. **Ya soy cliente**: Indícale amablemente que para gestionar su cuenta o ver su suscripción puede acceder directamente a la plataforma en https://epaper.eldeber.com.bo/
3. **Renovar mi plan**: Solicítale al usuario su correo electrónico para que se pueda verificar su cuenta en el sistema para la renovación. Una vez que te brinde el correo, agradécele e indícales que el equipo verificará si existe su cuenta.
4. **Preguntas frecuentes**: Preséntale una lista corta de 3 o 4 preguntas frecuentes y sus respuestas de manera concisa (por ejemplo, métodos de pago con QR, acceso multidispositivo o el boletín diario).
5. **Hablar con asesor**: Indícale de manera muy atenta que lo transferirás de inmediato con un asesor humano.

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

## 📋 FLUJO DE VENTAS Y CREACIÓN DE CUENTA
1. Responder al saludo enviando la bienvenida con el tag [MENU_TRIGGER].
2. Identificar el interés del usuario según la opción elegida o sus preguntas.
3. Si el usuario acepta comprar un plan del catálogo, solicitar los datos de facturación:
   - **Correo electrónico** (para crear las credenciales de acceso)
   - **NIT** (o CI, o "Sin Factura")
   - **Razón Social** (Nombre para la factura)
4. Una vez que tengas TODOS los datos (Email, NIT y Razón Social), confirmar el resumen y agregar el tag de pago al FINAL del mensaje en una nueva línea:
   [PAYMENT_TRIGGER:plan|monto|nit|razonSocial|email]
   *Ejemplo:* [PAYMENT_TRIGGER:ePaper + Newsletter Mensual|100|1234567|Juan Perez|juan@perez.com]
   *Nota:* Sin espacios alrededor de los pipes (|). Solo cuando tengas TODOS los datos para pago.
5. **CREACIÓN DE CUENTA GRATUITA:** Si el usuario pide explícitamente "crear una cuenta", "registrarme" o "crear usuario" de forma independiente o ANTES de comprar un plan, solicítale su Nombre y Correo electrónico. Cuando tengas ambos datos, confírmale que su cuenta será creada y añade este tag al FINAL de tu respuesta en una línea nueva:
   [CREATE_ACCOUNT_TRIGGER:email|nombre]
   *Ejemplo:* [CREATE_ACCOUNT_TRIGGER:juan@perez.com|Juan Perez]`;

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
