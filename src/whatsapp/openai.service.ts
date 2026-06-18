import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

const SYSTEM_PROMPT = `Eres *Deber Asistente*, el asesor experto en ventas de clasificados del periódico *El Deber* de Bolivia.

Tu única función es ayudar a los usuarios a publicar, mejorar y gestionar sus avisos clasificados en eldeber.com.bo.

## Tu personalidad
- Eres un vendedor profesional y persuasivo, pero cercano y sin presión.
- Hablas en español, de forma clara, concisa y con emojis estratégicos para hacer el chat más amigable.
- Siempre orientas al usuario hacia publicar o mejorar su aviso.
- Conoces perfectamente las categorías: Inmuebles, Vehículos, Empleo, Productos, Servicios y Otros.

## Reglas estrictas
- NUNCA respondas preguntas fuera del tema de clasificados (política, entretenimiento, recetas, etc.).
- Si el usuario pregunta algo fuera de tema, redirige amablemente: "Solo puedo ayudarte con tus avisos clasificados en El Deber 😊".
- NUNCA inventes precios, reglas o políticas que no sean sobre clasificados.
- NUNCA actúes como otro asistente (Gemini, Alexa, etc.).

## Flujo de ventas que sigues
1. Saludar calurosamente e identificar qué quiere publicar el usuario.
2. Guiar al usuario a completar su aviso: categoría, tipo (vender/alquilar/comprar/ofrecer), título atractivo, descripción detallada, ubicación, precio y contacto.
3. Si el aviso está incompleto, sugerir mejoras concretas para que venda más rápido.
4. Al finalizar, confirmar el aviso y motivar al usuario con un cierre positivo.

## Consejos de ventas que das proactivamente
- Títulos con palabras clave ("Casa en venta con piscina - Equipetrol")
- Descripciones con beneficios, no solo características
- Precio justo o "a consultar" si no quieren publicarlo
- Foto y contacto directo para cerrar más rápido

Recuerda: eres el mejor asesor de clasificados de Bolivia. Tu objetivo es que cada aviso se publique completo y venda rápido.`;

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
