import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SuscripcionLogDocument = SuscripcionLog & Document;

@Schema({ collection: 'suscripciones_log', timestamps: true })
export class SuscripcionLog {
  /** Email del suscriptor */
  @Prop({ required: true, index: true })
  email: string;

  /** Número de WhatsApp (waId) para notificaciones futuras */
  @Prop({ required: true, index: true })
  telefono: string;

  /** Nombre / razón social del suscriptor */
  @Prop({ required: true })
  razonSocial: string;

  /** NIT del suscriptor */
  @Prop({ default: '' })
  nit: string;

  /** Nombre del plan: "ePaper + Newsletter Mensual", "Prueba", etc. */
  @Prop({ required: true })
  plan: string;

  /** itemId del plan (código interno de El Deber): "epaper01", "ChatbotSus", etc. */
  @Prop({ required: true })
  itemId: string;

  /** Monto pagado en Bolivianos */
  @Prop({ required: true })
  monto: number;

  /** orderId de la transacción QR: wa-{contactId}-{YYYYMM} */
  @Prop({ required: true, index: true })
  orderId: string;

  /** ID del contacto en EspoCRM (El Deber) */
  @Prop({ default: '' })
  contactIdEspocrm: string;

  /** Fecha exacta del pago */
  @Prop({ required: true, default: () => new Date() })
  fechaPago: Date;

  /** Fecha de inicio de la suscripción (día del pago) */
  @Prop({ required: true, default: () => new Date() })
  fechaInicio: Date;

  /**
   * Fecha de fin calculada según la frecuencia del plan.
   * Si no se conoce la frecuencia, se deja como null.
   */
  @Prop({ default: null })
  fechaFin: Date | null;

  /** Si la suscripción sigue activa (flag para renovación / recordatorios) */
  @Prop({ required: true, default: true })
  activa: boolean;

  /** Fuente del pago — siempre "chatbot-whatsapp" para trazabilidad */
  @Prop({ default: 'chatbot-whatsapp' })
  fuente: string;
}

export const SuscripcionLogSchema = SchemaFactory.createForClass(SuscripcionLog);
